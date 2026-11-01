'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const SunCalc = require('suncalc');
const {
  freeDays, fromDeviceTemp, groupValues, isWeekendAt, toDeviceTemp, toMinutesFromTimeString,
  zonedDate, zonedMinutesOfDay,
} = require('./lib/circadian');

const UPDATE_INTERVAL_MS = 2 * 60 * 1000; // recompute every 2 minutes
const LOCK_GRACE_MS = 8000; // ignore device updates for this long after we write a value ourselves
const SETTLE_MS = 3000; // wait this long and re-check "off" right before writing, to catch a just-missed off event
const TURN_ON_DELAY_MS = 1000; // after a light switches on, give a flow time to pause it before we set values
const MAX_FADE_SECONDS = 5; // longer fades make lights report in-between values after LOCK_GRACE_MS
const WAKE_STEP_MS = 20000; // during a sunrise wake-up, step the lights this often

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_GROUP = {
  name: 'Ny gruppe',
  deviceIds: [],
  enabled: true,
  mode: 'sun', // 'sun' | 'keyframes'
  // 'sun' mode settings
  useSunTimes: true,
  wakeTime: '06:30',
  sleepTime: '22:00',
  transitionMinutes: 60,
  warmValue: 1,
  coolValue: 0,
  adjustBrightness: false,
  nightDim: 0.4,
  dayDim: 1,
  // 'keyframes' mode settings
  keyframes: [], // [{ time: 'HH:mm', temp: 0..1, dim: 0..1 }]
  skipOffLights: true,
  fadeSeconds: 2, // let lights glide to new values during the regular updates
  // Weekend plan: from 12:00 the day before a weekend day or holiday, to 12:00 on it (see isWeekendAt)
  weekendEnabled: false,
  weekendWakeTime: '08:30',
  weekendSleepTime: '23:30',
  weekendKeyframes: [], // empty = use the weekday keyframes
  // Sunrise wake-up: lights that are off come on very dim and warm and
  // brighten to the plan's values at the wake time
  wakeUpEnabled: false,
  wakeUpTime: '06:30',
  wakeUpWeekendTime: '', // weekends and holidays; empty = no wake-up then
  wakeUpMinutes: 20,
};

const DEFAULT_CONFIG = {
  enabled: true,
  groups: [],
  calibration: {}, // deviceId -> { warmK, coolK }, the light's colour temperature range
};

function makeId() {
  return 'g-' + Math.random().toString(36).slice(2, 10);
}

class CircadianApp extends Homey.App {

  async onInit() {
    this.log('Circadian Lighting starting...');

    const savedConfig = await this.homey.settings.get('config');
    this.config = this._migrateConfig(savedConfig);
    await this.homey.settings.set('config', this.config);

    this.locks = (await this.homey.settings.get('locks')) || {};
    this._lastAppliedAt = {};
    this._lastWritten = {}; // deviceId -> { dim, light_temperature } last values we sent
    this._capState = {}; // deviceId -> live { onoff, dim, light_temperature }
    this._capInstances = {}; // deviceId -> [DeviceCapability]
    this._deviceNames = {};
    this._offAt = {}; // deviceId -> time we last saw the light go off
    this._turningOn = {}; // deviceId -> true while values are being set after a switch-on
    this._missing = {}; // deviceId -> true for lights in a group that Homey no longer has
    this._waking = {}; // deviceId -> groupId while a sunrise wake-up brightens the light
    this._wakeDone = {}; // groupId -> date key of the last wake-up started
    this._insightLogs = {}; // log id -> Insights log
    this._status = {}; // deviceId -> { at, action, text } last thing the app did with the light
    this._tokens = {}; // token id -> { token, title }
    this._simulationRunning = false;

    // The app's own process may run in a different system time zone (often
    // UTC) than the one the user configured on their Homey. Everything that
    // compares "now" against a clock time the user entered (a keyframe, a
    // wake/sleep time) must use THIS zone, not the process's local one.
    try {
      this.timeZone = this.homey.clock.getTimezone();
      this.log('Using Homey time zone:', this.timeZone);
    } catch (err) {
      this.timeZone = undefined;
      this.log('Could not read Homey time zone, falling back to system time zone:', err.message);
    }

    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });

    try {
      await this.homeyApi.devices.connect();
    } catch (err) {
      this.log('Could not connect to device events:', err.message);
    }
    await this._syncCapabilityListeners();

    this._registerFlowCards();

    this._tick = this._tick.bind(this);
    this._interval = this.homey.setInterval(this._tick, UPDATE_INTERVAL_MS);

    await this._tick();

    this.log('Circadian Lighting ready.');
  }

  async onUninit() {
    if (this._interval) this.homey.clearInterval(this._interval);
    Object.values(this._capInstances || {}).forEach((list) => list.forEach((inst) => {
      try { inst.destroy(); } catch (err) { /* ignore */ }
    }));
  }

  _registerFlowCards() {
    try {
      this.homey.flow.getActionCard('resume-circadian')
        .registerRunListener(async () => {
          await this.resumeAll();
          return true;
        });
    } catch (err) {
      this.log('Could not register "resume-circadian" flow card:', err.message);
    }

    try {
      this.homey.flow.getActionCard('resume-circadian-device')
        .registerRunListener(async (args) => {
          if (args && args.device && args.device.id) {
            await this.resumeDevice(args.device.id);
          }
          return true;
        });
      this.homey.flow.getActionCard('resume-circadian-device')
        .registerArgumentAutocompleteListener('device', async (query) => {
          const devices = await this.getControllableDevices();
          return devices
            .filter((d) => d.name.toLowerCase().includes((query || '').toLowerCase()))
            .map((d) => ({ id: d.id, name: d.name }));
        });
    } catch (err) {
      this.log('Could not register "resume-circadian-device" flow card:', err.message);
    }

    try {
      const card = this.homey.flow.getActionCard('turn-on-group');
      card.registerRunListener(async (args) => {
        if (args && args.group && args.group.id) await this.turnOnGroup(args.group.id);
        return true;
      });
      card.registerArgumentAutocompleteListener('group', async (query) => {
        const q = (query || '').toLowerCase();
        return (this.config.groups || [])
          .filter((g) => (g.name || '').toLowerCase().includes(q))
          .map((g) => ({ id: g.id, name: g.name || 'Uten navn' }));
      });
    } catch (err) {
      this.log('Could not register "turn-on-group" flow card:', err.message);
    }

    try {
      const card = this.homey.flow.getActionCard('pause-until-off');
      card.registerRunListener(async (args) => {
        if (args && args.target && args.target.id) await this.pauseUntilOff(args.target.id);
        return true;
      });
      card.registerArgumentAutocompleteListener('target', async (query) => {
        const q = (query || '').toLowerCase();
        const groups = (this.config.groups || []).map((g) => ({
          id: 'group:' + g.id, name: 'Gruppe: ' + (g.name || 'Uten navn'),
        }));
        const lights = (await this.getControllableDevices()).map((d) => ({ id: d.id, name: d.name }));
        return groups.concat(lights).filter((x) => x.name.toLowerCase().includes(q));
      });
    } catch (err) {
      this.log('Could not register "pause-until-off" flow card:', err.message);
    }

    const groupAutocomplete = async (query) => {
      const q = (query || '').toLowerCase();
      return (this.config.groups || [])
        .filter((g) => g && (g.name || '').toLowerCase().includes(q))
        .map((g) => ({ id: g.id, name: g.name || 'Uten navn' }));
    };

    try {
      const card = this.homey.flow.getActionCard('set-group-enabled');
      card.registerRunListener(async (args) => {
        if (args && args.group && args.group.id) {
          await this.setGroupEnabled(args.group.id, args.state === 'on');
        }
        return true;
      });
      card.registerArgumentAutocompleteListener('group', groupAutocomplete);
    } catch (err) {
      this.log('Could not register "set-group-enabled" flow card:', err.message);
    }

    try {
      const card = this.homey.flow.getConditionCard('is-locked');
      card.registerRunListener(async (args) => !!(args && args.device && this.locks[args.device.id]));
      card.registerArgumentAutocompleteListener('device', async (query) => {
        const q = (query || '').toLowerCase();
        return (await this.getControllableDevices())
          .filter((d) => d.name.toLowerCase().includes(q))
          .map((d) => ({ id: d.id, name: d.name }));
      });
    } catch (err) {
      this.log('Could not register "is-locked" flow card:', err.message);
    }
  }

  _migrateConfig(saved) {
    if (!saved) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    if (Array.isArray(saved.groups)) {
      const cfg = Object.assign({}, DEFAULT_CONFIG, saved);
      cfg.groups = cfg.groups.map((g) => (g && !g.id ? Object.assign({}, g, { id: makeId() }) : g));
      return cfg;
    }

    // Old flat single-group shape from an earlier version -> wrap into one group
    if (Array.isArray(saved.deviceIds)) {
      const group = Object.assign({}, DEFAULT_GROUP, saved, { name: 'Standard', id: makeId() });
      delete group.groups;
      this.log('Migrated old single-group settings into a "Standard" group.');
      return { enabled: saved.enabled !== false, groups: [group] };
    }

    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  // --- called from api.js (settings page) ---

  async getConfig() {
    return this.config;
  }

  async saveConfig(newConfig) {
    this.config = Object.assign({}, DEFAULT_CONFIG, newConfig || {});
    await this.homey.settings.set('config', this.config);
    await this._syncCapabilityListeners();
    await this._tick();
    await this._updateTokens();
    await this._pruneInsights();
    return this.config;
  }

  async applyNow() {
    await this._tick();
    return { appliedAt: new Date().toISOString() };
  }

  /** For the status list on the settings page. */
  async getStatus() {
    const now = this._now();
    const sun = this._sunMinutes();
    return {
      enabled: this.config.enabled !== false,
      weekend: now.weekend,
      // The settings page draws the schedule itself (settings/circadian.js),
      // on the Homey's clock and with today's sun times from here.
      timeZone: this.timeZone || null,
      sun,
      groups: (this.config.groups || []).filter(Boolean).map((g) => {
        const v = groupValues(g, now.minutes, sun, now.weekend);
        return {
          id: g.id,
          name: g.name,
          enabled: g.enabled !== false,
          weekend: !!(now.weekend && g.weekendEnabled),
          temp: v.temp,
          dim: v.dim,
          lights: (g.deviceIds || []).map((id) => {
            const st = this._capState[id];
            const lock = this.locks[id];
            return {
              id,
              name: this._deviceNames[id] || id,
              on: st && (st.onoff != null || st.dim != null) ? !this._isOffState(st) : null,
              dim: st && st.dim != null ? st.dim : null,
              temp: st && st.light_temperature != null ? fromDeviceTemp(st.light_temperature, this._calibration(id)) : null,
              waking: !!this._waking[id],
              lock: lock === 'untilOff' ? 'untilOff' : (lock ? 'manual' : null),
              missing: !!this._missing[id],
              status: this._status[id] || null,
            };
          }),
        };
      }),
    };
  }

  /** Flow action: switch circadian control for one group on or off. */
  async setGroupEnabled(groupId, enabled) {
    const group = (this.config.groups || []).find((g) => g && g.id === groupId);
    if (!group) throw new Error('Fant ikke gruppen');
    group.enabled = !!enabled;
    try {
      this.homey.settings.set('config', this.config);
    } catch (err) {
      this.log('Could not save config:', err.message);
    }
    this.log(`Group "${group.name}" ${enabled ? 'enabled' : 'disabled'} from a flow.`);
    if (enabled) await this._tick();
    return true;
  }

  /**
   * Global Flow tokens with each group's current values, as percentages
   * (warmth 0 = coldest, 100 = warmest). Runs one at a time, since ticks
   * and saves can overlap and a token can only be created once.
   */
  _updateTokens(now, sun) {
    this._tokenQueue = (this._tokenQueue || Promise.resolve())
      .then(() => this._doUpdateTokens(now || this._now(), sun || this._sunMinutes()))
      .catch((err) => this.log('Could not update flow tokens:', err.message));
    return this._tokenQueue;
  }

  async _doUpdateTokens(now, sun) {
    const wanted = {};
    (this.config.groups || []).forEach((g) => {
      if (!g || !g.id) return;
      const v = groupValues(g, now.minutes, sun, now.weekend);
      const name = g.name || 'Uten navn';
      if (v.temp != null) wanted[`${g.id}-temp`] = { title: `${name}: varme (%)`, value: Math.round(v.temp * 100) };
      if (v.dim != null) wanted[`${g.id}-dim`] = { title: `${name}: lysstyrke (%)`, value: Math.round(v.dim * 100) };
    });

    // Remove tokens for deleted groups, and renamed ones (a token's title is fixed)
    for (const [id, t] of Object.entries(this._tokens)) {
      if (wanted[id] && wanted[id].title === t.title) continue;
      delete this._tokens[id];
      await this.homey.flow.unregisterToken(t.token)
        .catch((err) => this.log(`Could not remove flow token ${id}:`, err.message));
    }

    for (const [id, w] of Object.entries(wanted)) {
      if (!this._tokens[id]) {
        const token = await this.homey.flow.createToken(id, { type: 'number', title: w.title, value: w.value });
        this._tokens[id] = { token, title: w.title, value: w.value };
      } else if (this._tokens[id].value !== w.value) {
        await this._tokens[id].token.setValue(w.value);
        this._tokens[id].value = w.value;
      }
    }
  }

  async resumeDevice(deviceId) {
    delete this.locks[deviceId];
    await this.homey.settings.set('locks', this.locks);
    await this._tick();
    return true;
  }

  async resumeAll() {
    this.locks = {};
    await this.homey.settings.set('locks', this.locks);
    await this._tick();
    return true;
  }

  /**
   * Runs a group's schedule through a full simulated 24 hours in ~durationSeconds
   * real seconds, writing each step's values directly to the group's devices
   * (bypassing locks, since this is an explicit test). Runs in the background;
   * returns immediately so the settings page doesn't have to hold a long request
   * open. Only one simulation can run at a time.
   *
   * Device objects are resolved ONCE up front and reused for every step —
   * re-fetching them on every step (the earlier version) is what made a
   * "1 minute" simulation actually take several minutes in practice.
   */
  async simulateGroup(groupId) {
    const group = (this.config.groups || []).find((g) => g.id === groupId);
    if (!group) throw new Error('Fant ikke gruppen');
    if (!Array.isArray(group.deviceIds) || group.deviceIds.length === 0) {
      throw new Error('Gruppen har ingen lys valgt');
    }
    if (this._simulationRunning) throw new Error('En simulering kjører allerede');

    const steps = 60; // one write per simulated 24 minutes
    const durationSeconds = 60;
    const stepMs = Math.round((durationSeconds * 1000) / steps);
    const minutesPerStep = 1440 / steps;

    const sun = this._sunMinutes();
    const free = freeDays(new Date(), this.timeZone);

    // Resolve devices once. After homeyApi.devices.connect() (called in onInit)
    // these objects are kept live-updated over the websocket, so reading
    // device.capabilitiesObj.onoff.value later still reflects the real,
    // current on/off state without needing to re-fetch every step.
    const deviceEntries = [];
    for (const deviceId of group.deviceIds) {
      try {
        const device = await this.homeyApi.devices.getDevice({ id: deviceId });
        if (device) deviceEntries.push({ id: deviceId, device });
      } catch (err) {
        this.log(`[simulate] Could not load device ${deviceId}:`, err.message);
      }
    }

    this._simulationRunning = true;
    this._simStatus = {
      running: true,
      groupId,
      stepIndex: 0,
      totalSteps: steps,
      simTime: null,
      startedAt: Date.now(),
      stoppedReason: null,
    };
    this.log(`[simulate] Starting 24h simulation for group "${group.name}" (${deviceEntries.length} lys) over ${durationSeconds}s...`);

    (async () => {
      try {
        for (let i = 0; i <= steps; i++) {
          if (!this._simulationRunning) {
            this._simStatus.stoppedReason = this._simStatus.stoppedReason || 'Stoppet av bruker';
            break;
          }

          // simMinutes is already "minutes since midnight" on the same clock
          // the keyframes/wake/sleep times were entered on — no Date object
          // or time-zone conversion needed here, which avoids re-introducing
          // the exact kind of zone mismatch this simulator is meant to catch.
          const simMinutes = Math.round(i * minutesPerStep) % 1440;

          // Simulate today: the weekend plan kicks in where it would today
          const { temp: tempValue, dim: dimValue } = groupValues(
            group, simMinutes, sun, isWeekendAt(free, simMinutes),
          );

          const hh = String(Math.floor(simMinutes / 60)).padStart(2, '0');
          const mm = String(simMinutes % 60).padStart(2, '0');
          this.log(`[simulate] ${hh}:${mm} -> temp ${tempValue != null ? tempValue.toFixed(2) : '-'}, dim ${dimValue != null ? dimValue.toFixed(2) : '-'}`);

          this._simStatus.stepIndex = i;
          this._simStatus.simTime = hh + ':' + mm;

          await Promise.all(deviceEntries.map(({ id, device }) => this._applyValuesToDevice(
            id, device, tempValue, dimValue, group.skipOffLights !== false,
          )));

          if (!this._simulationRunning) {
            this._simStatus.stoppedReason = this._simStatus.stoppedReason || 'Stoppet av bruker';
            break;
          }

          await new Promise((resolve) => this.homey.setTimeout(resolve, stepMs));
        }
      } catch (err) {
        this.log('[simulate] Error during simulation:', err.message);
        this._simStatus.stoppedReason = 'Feil: ' + err.message;
      } finally {
        this._simulationRunning = false;
        this._simStatus.running = false;
        this.log('[simulate] Done, resuming real-time schedule.');
        this._tick().catch((err) => this.log('Tick after simulation failed:', err.message));
      }
    })();

    return { started: true, durationSeconds, steps };
  }

  getSimulationStatus() {
    return this._simStatus || { running: false };
  }

  async stopSimulation() {
    this._simulationRunning = false;
    if (this._simStatus) this._simStatus.stoppedReason = 'Stoppet av bruker';
    return { stopped: true };
  }

  /**
   * Lights the app can control. Includes both lights with adjustable color
   * temperature and plain dimmable-only lights (no light_temperature) — the
   * latter can be added to a group to follow its dim curve without ever
   * receiving a color-temperature write, which they wouldn't support anyway.
   */
  async getControllableDevices() {
    const devices = await this.homeyApi.devices.getDevices();
    let zones = {};
    try {
      zones = await this.homeyApi.zones.getZones();
    } catch (err) {
      this.log('Could not fetch zone names:', err.message);
    }
    return Object.values(devices)
      .filter((d) => d.class === 'light'
        && Array.isArray(d.capabilities)
        && (d.capabilities.includes('light_temperature') || d.capabilities.includes('dim')))
      .map((d) => ({
        id: d.id,
        name: d.name,
        zone: (zones[d.zone] && zones[d.zone].name) || '',
        locked: !!this.locks[d.id],
        lockType: this.locks[d.id] === 'untilOff' ? 'untilOff' : (this.locks[d.id] ? 'manual' : null),
        hasTemp: d.capabilities.includes('light_temperature'),
        hasDim: d.capabilities.includes('dim'),
      }));
  }

  // --- live capability tracking + manual-change detection ---
  //
  // Homey does NOT report capability value changes (onoff, dim, ...) through
  // the manager-level 'device.update' event — that only covers things like a
  // device's name or zone. Capability values must be followed per device via
  // makeCapabilityInstance(). We keep our own live copy of each managed
  // light's onoff/dim/light_temperature here, updated the moment Homey
  // reports a change, and use it both to skip lights that are off and to
  // detect manual adjustments.

  _managedDeviceIds() {
    const ids = new Set();
    (this.config.groups || []).forEach((g) => (g.deviceIds || []).forEach((id) => ids.add(id)));
    return ids;
  }

  async _syncCapabilityListeners() {
    const wanted = this._managedDeviceIds();

    // Drop listeners for lights no longer in any group
    for (const deviceId of Object.keys(this._capInstances)) {
      if (wanted.has(deviceId)) continue;
      (this._capInstances[deviceId] || []).forEach((inst) => {
        try { inst.destroy(); } catch (err) { /* ignore */ }
      });
      delete this._capInstances[deviceId];
      delete this._capState[deviceId];
      delete this._deviceNames[deviceId];
    }

    // Add listeners for newly managed lights
    for (const deviceId of wanted) {
      if (this._capInstances[deviceId]) continue;
      try {
        const device = await this.homeyApi.devices.getDevice({ id: deviceId });
        if (!device) continue;
        delete this._missing[deviceId];
        this._deviceNames[deviceId] = device.name || deviceId;

        const state = {};
        const instances = [];
        ['onoff', 'dim', 'light_temperature'].forEach((cap) => {
          if (!Array.isArray(device.capabilities) || !device.capabilities.includes(cap)) return;
          const capObj = device.capabilitiesObj && device.capabilitiesObj[cap];
          state[cap] = capObj ? capObj.value : null;
          instances.push(device.makeCapabilityInstance(cap, (value) => {
            // Never let an error in our handler crash the whole app
            try {
              this._onCapabilityChange(deviceId, cap, value);
            } catch (err) {
              this.error(`Error handling ${cap} change for ${deviceId}:`, err);
            }
          }));
        });
        this._capState[deviceId] = state;
        this._capInstances[deviceId] = instances;
        this.log(`Listening to "${this._deviceNames[deviceId]}" (onoff=${state.onoff}, dim=${state.dim}).`);
      } catch (err) {
        if (this._markIfMissing(deviceId, err)) continue;
        this.log(`Could not listen to capability changes for ${deviceId}:`, err.message);
      }
    }
  }

  /**
   * A light that was deleted or re-paired in Homey (a new pairing gets a new
   * id) stays in its group until removed on the settings page. Remember it,
   * so the app stops trying to update it every tick and the page can offer
   * to remove it. Checked again whenever the settings are saved.
   */
  _markIfMissing(deviceId, err) {
    if (!/not found/i.test(err && err.message)) return false;
    if (!this._missing[deviceId]) this.log(`Light ${deviceId} no longer exists in Homey — skipping it.`);
    this._missing[deviceId] = true;
    this._noteStatus(deviceId, 'missing', 'Finnes ikke lenger i Homey');
    return true;
  }

  /** Drop and recreate one light's listeners, e.g. after they missed an event. */
  async _resetCapabilityListeners(deviceId) {
    (this._capInstances[deviceId] || []).forEach((inst) => {
      try { inst.destroy(); } catch (err) { /* ignore */ }
    });
    delete this._capInstances[deviceId];
    // An uncached fetch replaces the cached device object, so the new
    // listeners attach to a fresh one with up-to-date values.
    const fresh = await this.homeyApi.devices.getDevice({ id: deviceId, $cache: false });
    await this._syncCapabilityListeners();
    const state = this._capState[deviceId];
    const caps = (fresh && fresh.capabilitiesObj) || {};
    if (state) {
      ['onoff', 'dim', 'light_temperature'].forEach((cap) => {
        if (caps[cap]) state[cap] = caps[cap].value;
      });
    }
  }

  _persistLocks() {
    try {
      this.homey.settings.set('locks', this.locks);
    } catch (err) {
      this.log('Could not persist locks:', err.message);
    }
  }

  /**
   * Flow action: leave a light (or every light in a group) alone until it is
   * next switched off — e.g. a motion-triggered night light that should stay
   * at the dim level the motion flow set, and be allowed to switch off.
   */
  async pauseUntilOff(target) {
    let ids = [];
    if (String(target).startsWith('group:')) {
      const group = (this.config.groups || []).find((g) => g.id === String(target).slice(6));
      if (!group) throw new Error('Fant ikke gruppen');
      ids = group.deviceIds || [];
    } else {
      ids = [target];
    }
    ids.forEach((id) => {
      if (this.locks[id] !== true) this.locks[id] = 'untilOff'; // never weaken a manual lock
    });
    this._persistLocks();
    this.log(`Paused until switched off: ${ids.map((id) => this._deviceNames[id] || id).join(', ')}`);
    return true;
  }

  _isOffState(state) {
    if (!state) return false;
    return state.onoff === false || (state.dim != null && state.dim <= 0.01);
  }

  _onCapabilityChange(deviceId, cap, value) {
    const name = this._deviceNames[deviceId] || deviceId;
    const state = this._capState[deviceId] || (this._capState[deviceId] = {});
    const prev = state[cap];
    const wasOff = this._isOffState(state);
    state[cap] = value;
    const isOff = this._isOffState(state);

    if (cap === 'onoff' || wasOff !== isOff) {
      this.log(`"${name}" ${cap} -> ${value} (${isOff ? 'off' : 'on'}).`);
    }

    if (!wasOff && isOff) {
      this._offAt[deviceId] = Date.now();
      // A "pause until switched off" ends the moment the light goes off
      if (this.locks[deviceId] === 'untilOff') {
        delete this.locks[deviceId];
        this._persistLocks();
        this.log(`"${name}" switched off — pause ended, circadian control resumes next time it's on.`);
      }
    }

    if (wasOff && !isOff) this._onSwitchedOn(deviceId);

    // Manual-lock detection: only colour/brightness adjustments count, not
    // simply switching the light on or off.
    if (cap === 'onoff') return;
    if (this._simulationRunning) return;
    if (this._waking[deviceId]) return; // the wake-up fades it; switching off still stops it
    if (prev == null || value == null) return;
    if (Math.abs(prev - value) <= 0.005) return;
    if (cap === 'dim' && (prev <= 0.01 || value <= 0.01)) return; // turning off/on, not dimming
    if (wasOff || isOff) return;

    // Ignore the echo of our own write (by time, and by matching the value we sent)
    const lastApplied = this._lastAppliedAt[deviceId];
    if (lastApplied && (Date.now() - lastApplied) < LOCK_GRACE_MS) return;
    const written = this._lastWritten[deviceId] && this._lastWritten[deviceId][cap];
    if (written != null && Math.abs(written - value) <= 0.03) return;

    if (!this.locks[deviceId]) {
      this.locks[deviceId] = true;
      this._persistLocks();
      this.log(`"${name}" was adjusted manually (${cap} ${prev} -> ${value}) — locked out of automatic control.`);
      this._noteStatus(deviceId, 'locked', 'Låst etter manuell justering');
      this._triggerLocked(deviceId, name);
    }
  }

  _triggerLocked(deviceId, name) {
    try {
      this.homey.flow.getTriggerCard('light-locked')
        .trigger({ light: name })
        .catch((err) => this.log('Could not run "light-locked" trigger:', err.message));
    } catch (err) {
      this.log('Could not run "light-locked" trigger:', err.message);
    }
  }

  /** A light's colour temperature range, if set on the settings page. */
  _calibration(deviceId) {
    return ((this.config && this.config.calibration) || {})[deviceId] || null;
  }

  /** The enabled groups a light belongs to (the first one decides its values). */
  _groupsFor(deviceId) {
    return (this.config.groups || []).filter((g) => g && g.enabled !== false
      && Array.isArray(g.deviceIds) && g.deviceIds.includes(deviceId));
  }

  /**
   * A light was just switched on: give it the values the schedule has right
   * now, instead of leaving it at yesterday's colour until the next tick.
   * Waits TURN_ON_DELAY_MS first, so a flow that switches a light on and
   * then pauses it (e.g. a night light) gets to do so before we write.
   */
  _onSwitchedOn(deviceId) {
    if (this._simulationRunning || !this.config || this.config.enabled === false) return;
    if (this.locks[deviceId] || this._turningOn[deviceId] || this._waking[deviceId]) return;
    // Switched on by our own write (e.g. the "turn on group" flow card)
    const lastApplied = this._lastAppliedAt[deviceId];
    if (lastApplied && (Date.now() - lastApplied) < LOCK_GRACE_MS) return;
    const group = this._groupsFor(deviceId)[0];
    if (!group) return;

    this._turningOn[deviceId] = true;
    this.homey.setTimeout(() => {
      Promise.resolve().then(async () => {
        if (this.locks[deviceId]) return;
        const { temp, dim } = this._groupValuesNow(group);
        await this._applyToDevice(deviceId, temp, dim, group.skipOffLights !== false, { quick: true });
      }).catch((err) => this.log(`Could not set values on switch-on for ${deviceId}:`, err.message))
        .then(() => { delete this._turningOn[deviceId]; });
    }, TURN_ON_DELAY_MS);
  }

  // --- core loop ---

  _sunMinutes() {
    try {
      const lat = this.homey.geolocation.getLatitude();
      const lng = this.homey.geolocation.getLongitude();
      if (lat != null && lng != null) {
        const times = SunCalc.getTimes(new Date(), lat, lng);
        return {
          sunriseMinutes: zonedMinutesOfDay(times.sunrise, this.timeZone),
          sunsetMinutes: zonedMinutesOfDay(times.sunset, this.timeZone),
        };
      }
    } catch (err) {
      this.log('Sun times unavailable, falling back to fixed wake/sleep times:', err.message);
    }
    return { sunriseMinutes: null, sunsetMinutes: null };
  }

  /** "Now" on the Homey's clock: minutes since midnight, and whether the weekend plan applies. */
  _now() {
    const date = new Date();
    const minutes = zonedMinutesOfDay(date, this.timeZone);
    const free = freeDays(date, this.timeZone);
    return { minutes, free, date: zonedDate(date, this.timeZone), weekend: isWeekendAt(free, minutes) };
  }

  /** The { temp, dim } a group's schedule calls for right now (dim may be null). */
  _groupValuesNow(group) {
    const now = this._now();
    return groupValues(group, now.minutes, this._sunMinutes(), now.weekend);
  }

  async _tick() {
    if (this._simulationRunning) return; // don't fight the simulation loop
    if (!this.config || !this.config.enabled) return;
    if (!Array.isArray(this.config.groups) || this.config.groups.length === 0) return;

    const sun = this._sunMinutes();
    const now = this._now();

    this._checkWakeUps(now, sun);

    for (const group of this.config.groups) {
      if (!group || group.enabled === false) continue;
      if (!Array.isArray(group.deviceIds) || group.deviceIds.length === 0) continue;

      const { temp: tempValue, dim: dimValue } = groupValues(group, now.minutes, sun, now.weekend);

      // Run devices in this group in parallel rather than one after another,
      // so the settle delay in _applyValuesToDevice (see there) doesn't add
      // up across many lights.
      await Promise.all(group.deviceIds.map((deviceId) => {
        if (this.locks[deviceId]) return null; // manually adjusted, waiting to be resumed
        if (this._missing[deviceId]) return null; // deleted or re-paired in Homey
        if (this._waking[deviceId]) return null; // a sunrise wake-up is brightening it
        return this._applyToDevice(deviceId, tempValue, dimValue, group.skipOffLights !== false, {
          fadeMs: this._fadeMs(group),
        });
      }));
    }

    this._updateTokens(now, sun);
    this._logInsights(now, sun);
  }

  // --- sunrise wake-up ---

  /** Start the wake-up of any group whose wake-up window has begun. */
  _checkWakeUps(now, sun) {
    const dateKey = `${now.date.year}-${now.date.month}-${now.date.day}`;
    (this.config.groups || []).forEach((group) => {
      if (!group || group.enabled === false || !group.wakeUpEnabled) return;
      const time = now.free.today ? group.wakeUpWeekendTime : group.wakeUpTime;
      if (!time) return;
      if (this._wakeDone[group.id] === dateKey) return;
      const end = toMinutesFromTimeString(time);
      const length = Math.max(5, Math.min(60, Number(group.wakeUpMinutes) || DEFAULT_GROUP.wakeUpMinutes));
      if (now.minutes < end - length || now.minutes >= end) return;
      this._wakeDone[group.id] = dateKey;
      this._startWakeUp(group, now, end, length, sun).catch((err) => this.log('Wake-up failed:', err.message));
    });
  }

  /**
   * Bring the group's lights that are off up from very dim and warm to the
   * plan's values at the wake time, a step every WAKE_STEP_MS. Lights that
   * are already on are in use and left alone; switching a light off, or a
   * lock, stops its wake-up.
   */
  async _startWakeUp(group, now, endMinutes, lengthMinutes, sun) {
    const ids = (group.deviceIds || []).filter((id) => !this.locks[id] && !this._missing[id]
      && this._capState[id] && this._isOffState(this._capState[id]));
    if (ids.length === 0) return;
    const target = groupValues(group, endMinutes, sun, isWeekendAt(now.free, endMinutes));
    const targetDim = target.dim != null ? target.dim : 1;
    const startedAt = Date.now();
    ids.forEach((id) => { this._waking[id] = group.id; });
    this.log(`Sunrise wake-up for "${group.name}": ${ids.length} light(s) until ${Math.floor(endMinutes / 60)}:${String(endMinutes % 60).padStart(2, '0')}.`);

    let first = true;
    let interval = null;
    const finish = () => {
      if (interval) this.homey.clearInterval(interval);
      ids.forEach((id) => { if (this._waking[id] === group.id) delete this._waking[id]; });
    };
    // Progress from the time the wake-up started (it may start late, e.g.
    // after a restart), so the ramp never depends on re-reading the clock
    const leftAtStart = endMinutes - now.minutes;
    const step = async () => {
      const left = leftAtStart - (Date.now() - startedAt) / 60000;
      const p = Math.max(0, Math.min(1, 1 - left / lengthMinutes));
      // Brightness is perceived roughly logarithmically: start slow
      const dim = 0.01 + (targetDim - 0.01) * p * p;
      const temp = target.temp != null ? 1 + (target.temp - 1) * p : null;
      const active = ids.filter((id) => this._waking[id] === group.id
        && !this.locks[id] && (this._offAt[id] || 0) < startedAt);
      ids.filter((id) => !active.includes(id) && this._waking[id] === group.id).forEach((id) => { delete this._waking[id]; });
      await Promise.all(active.map((id) => this._wakeStep(id, temp, dim, first)));
      first = false;
      if (p >= 1 || active.length === 0) finish();
    };
    interval = this.homey.setInterval(() => step().catch((err) => this.log('Wake-up step failed:', err.message)), WAKE_STEP_MS);
    await step();
  }

  async _wakeStep(deviceId, temp, dim, switchOn) {
    try {
      const device = await this.homeyApi.devices.getDevice({ id: deviceId });
      if (!device || !device.capabilitiesObj) return;
      const caps = device.capabilitiesObj;
      const opts = switchOn ? undefined : { duration: WAKE_STEP_MS - 2000 };
      this._lastAppliedAt[deviceId] = Date.now();
      const written = this._lastWritten[deviceId] || (this._lastWritten[deviceId] = {});
      if (caps.dim) {
        written.dim = dim;
        await device.setCapabilityValue('dim', dim, opts);
      }
      if (temp != null && caps.light_temperature) {
        if (switchOn && caps.light_mode && caps.light_mode.value !== 'temperature') {
          await device.setCapabilityValue('light_mode', 'temperature').catch(() => {});
        }
        const v = toDeviceTemp(temp, this._calibration(deviceId));
        written.light_temperature = v;
        await device.setCapabilityValue('light_temperature', v, opts);
      }
      if (switchOn && caps.onoff) await device.setCapabilityValue('onoff', true);
      this._lastAppliedAt[deviceId] = Date.now();
      this._noteStatus(deviceId, 'ok', 'Soloppgangsvekking', { temp, dim });
    } catch (err) {
      if (this._markIfMissing(deviceId, err)) return;
      this.log(`Wake-up step failed for ${deviceId}:`, err.message);
    }
  }

  // --- Homey Insights ---

  /** Log each enabled group's values, as percentages, for Homey's Insights graphs. */
  async _logInsights(now, sun) {
    try {
      for (const g of this.config.groups || []) {
        if (!g || !g.id || g.enabled === false) continue;
        const v = groupValues(g, now.minutes, sun, now.weekend);
        const name = g.name || 'Uten navn';
        if (v.temp != null) await (await this._insightLog(`${g.id}-temp`, `${name}: varme`)).createEntry(Math.round(v.temp * 100));
        if (v.dim != null) await (await this._insightLog(`${g.id}-dim`, `${name}: lysstyrke`)).createEntry(Math.round(v.dim * 100));
      }
    } catch (err) {
      this.log('Could not log to Insights:', err.message);
    }
  }

  async _insightLog(id, title) {
    if (this._insightLogs[id]) return this._insightLogs[id];
    let log;
    try {
      log = await this.homey.insights.getLog(id);
    } catch (err) {
      log = await this.homey.insights.createLog(id, {
        title: { en: title, no: title }, type: 'number', units: '%', decimals: 0,
      });
    }
    this._insightLogs[id] = log;
    return log;
  }

  /** Remove the Insights logs of deleted groups. */
  async _pruneInsights() {
    try {
      const wanted = new Set();
      (this.config.groups || []).forEach((g) => { if (g && g.id) { wanted.add(`${g.id}-temp`); wanted.add(`${g.id}-dim`); } });
      const logs = await this.homey.insights.getLogs();
      for (const log of logs || []) {
        const id = log.name || log.id;
        if (wanted.has(id)) continue;
        delete this._insightLogs[id];
        await this.homey.insights.deleteLog(log);
      }
    } catch (err) {
      this.log('Could not tidy Insights logs:', err.message);
    }
  }

  _fadeMs(group) {
    const s = Number(group.fadeSeconds != null ? group.fadeSeconds : DEFAULT_GROUP.fadeSeconds);
    if (!Number.isFinite(s) || s <= 0) return 0;
    return Math.round(Math.min(s, MAX_FADE_SECONDS) * 1000);
  }

  /**
   * Flow action: switch on every light in a group — including ones that are
   * off — at the values the schedule calls for right now, and unlock them so
   * the circadian rhythm keeps controlling them from here on.
   */
  async turnOnGroup(groupId) {
    const group = (this.config.groups || []).find((g) => g.id === groupId);
    if (!group) throw new Error('Fant ikke gruppen');
    const deviceIds = group.deviceIds || [];

    deviceIds.forEach((id) => { delete this.locks[id]; });
    try {
      this.homey.settings.set('locks', this.locks);
    } catch (err) {
      this.log('Could not persist locks:', err.message);
    }

    const { temp, dim } = this._groupValuesNow(group);
    this.log(`Turning on group "${group.name}" at temp=${temp}, dim=${dim}.`);

    await Promise.all(deviceIds.map(async (deviceId) => {
      try {
        const device = await this.homeyApi.devices.getDevice({ id: deviceId });
        if (!device || !device.capabilitiesObj) return;
        const caps = device.capabilitiesObj;

        // Mark as our own write first so the echoes never trigger a lock
        this._lastAppliedAt[deviceId] = Date.now();
        const written = this._lastWritten[deviceId] || (this._lastWritten[deviceId] = {});

        // Brightness first: many lights switch on straight to that level,
        // avoiding a flash of the old brightness before it's corrected.
        if (dim != null && caps.dim) {
          written.dim = dim;
          await device.setCapabilityValue('dim', dim)
            .catch((err) => this.log(`Could not set dim on ${deviceId}:`, err.message));
        }
        if (temp != null && caps.light_temperature) {
          if (caps.light_mode && caps.light_mode.value !== 'temperature') {
            await device.setCapabilityValue('light_mode', 'temperature')
              .catch((err) => this.log(`Could not set light_mode on ${deviceId}:`, err.message));
          }
          const deviceTemp = toDeviceTemp(temp, this._calibration(deviceId));
          written.light_temperature = deviceTemp;
          await device.setCapabilityValue('light_temperature', deviceTemp)
            .catch((err) => this.log(`Could not set light_temperature on ${deviceId}:`, err.message));
        }
        if (caps.onoff) {
          await device.setCapabilityValue('onoff', true)
            .catch((err) => this.log(`Could not switch on ${deviceId}:`, err.message));
        }
        this._lastAppliedAt[deviceId] = Date.now();
      } catch (err) {
        this.log(`Failed to switch on ${deviceId}:`, err.message);
      }
    }));
    return true;
  }

  async _applyToDevice(deviceId, value, dimValue, skipOffLights, opts) {
    try {
      const device = await this.homeyApi.devices.getDevice({ id: deviceId });
      if (!device) return;
      await this._applyValuesToDevice(deviceId, device, value, dimValue, skipOffLights, opts);
    } catch (err) {
      if (this._markIfMissing(deviceId, err)) return;
      this.log(`Failed to update device ${deviceId}:`, err.message);
      this._noteStatus(deviceId, 'error', 'Feil: ' + err.message);
    }
  }

  /**
   * Remember the last thing the app did with a light, for the status list on
   * the settings page. `applied` is set only when values were actually sent.
   */
  _noteStatus(deviceId, check, text, applied) {
    const entry = this._status[deviceId] || (this._status[deviceId] = {});
    entry.checkedAt = Date.now();
    entry.check = check;
    entry.text = text;
    if (applied) entry.applied = Object.assign({ at: Date.now() }, applied);
  }

  /**
   * Writes the given values to an already-resolved device object. Kept
   * separate from _applyToDevice so the simulation loop can reuse cached
   * device objects instead of re-fetching one from Homey on every step.
   *
   * opts.fadeMs: let the light glide to the new values over this long.
   * opts.quick: the light was just switched on; skip the settle wait so the
   * right values arrive straight away (it's on, so there's nothing to catch).
   */
  async _applyValuesToDevice(deviceId, device, value, dimValue, skipOffLights, opts = {}) {
    try {
      if (!device || !device.capabilitiesObj) return;

      const name = device.name || deviceId;
      // From here on, colour temperature is in the light's own units
      value = toDeviceTemp(value, this._calibration(deviceId));

      // Prefer the live state kept by our capability listeners; fall back to
      // the device object only for lights we aren't listening to (yet).
      const liveState = () => {
        const s = this._capState[deviceId];
        if (s) return s;
        const c = device.capabilitiesObj;
        return {
          onoff: c.onoff ? c.onoff.value : undefined,
          dim: c.dim ? c.dim.value : undefined,
          light_temperature: c.light_temperature ? c.light_temperature.value : undefined,
        };
      };

      if (skipOffLights && this._isOffState(liveState())) {
        this.log(`Skipping "${name}" — it is off.`);
        this._noteStatus(deviceId, 'off', 'Av, ikke rørt');
        return; // leave lights that are switched off alone
      }

      // A light switched off right as we're about to write could still
      // slip through; wait briefly and re-check the live state. Skipped
      // during the fast 24h simulation, which needs to run in ~1 minute.
      if (skipOffLights && !this._simulationRunning) {
        if (!opts.quick) await sleep(SETTLE_MS);
        if (this._isOffState(liveState())) {
          this.log(`Skipping "${name}" — went off during settle check.`);
          this._noteStatus(deviceId, 'off', 'Av, ikke rørt');
          return;
        }
        if (this.locks[deviceId]) return; // adjusted manually during the wait

        // Our live state comes from capability listeners, and getDevice()
        // returns the same cached object while the socket is connected. If an
        // off event was lost (e.g. the socket dropped), both still say "on"
        // and our write would switch the light back on. Ask Homey directly.
        let fresh;
        try {
          fresh = await this.homeyApi.devices.getDevice({ id: deviceId, $cache: false, $updateCache: false });
        } catch (err) {
          this.log(`Skipping "${name}" — could not read fresh state:`, err.message);
          this._noteStatus(deviceId, 'error', 'Fikk ikke lest tilstanden fra Homey');
          return;
        }
        const fc = (fresh && fresh.capabilitiesObj) || {};
        const freshState = {
          onoff: fc.onoff ? fc.onoff.value : undefined,
          dim: fc.dim ? fc.dim.value : undefined,
        };
        if (this._isOffState(freshState)) {
          this.log(`Skipping "${name}" — Homey reports it off, but our live state said on. Re-listening.`);
          this._noteStatus(deviceId, 'stale', 'Av (appen trodde den var på, rettet opp)');
          if (this._capState[deviceId]) Object.assign(this._capState[deviceId], freshState);
          this._resetCapabilityListeners(deviceId)
            .catch((err) => this.log(`Could not re-listen to "${name}":`, err.message));
          return;
        }
      }

      const cur = liveState();
      const needTemp = value != null && device.capabilitiesObj.light_temperature
        && (cur.light_temperature == null || Math.abs(cur.light_temperature - value) > 0.005);
      const needDim = dimValue != null && device.capabilitiesObj.dim
        && (cur.dim == null || Math.abs(cur.dim - dimValue) > 0.005);

      if (!needTemp && !needDim) {
        this._noteStatus(deviceId, 'ok', 'Følger døgnrytmen');
        return; // already at the right values
      }

      const fadeMs = opts.fadeMs > 0 ? opts.fadeMs : 0;
      const capOpts = fadeMs ? { duration: fadeMs } : undefined;

      this.log(`Applying to "${name}": temp=${needTemp ? value : '-'}, dim=${needDim ? dimValue : '-'} `
        + `(live: onoff=${cur.onoff}, dim=${cur.dim}${fadeMs ? `, fade ${fadeMs} ms` : ''})`);

      // Mark the write BEFORE sending, so the echo coming back through the
      // capability listener is never mistaken for a manual adjustment.
      const writeStart = Date.now();
      this._lastAppliedAt[deviceId] = writeStart;
      // Something else (a flow, a switch) turned the light off after our
      // checks but while we were writing? Then stop, and don't leave it on.
      const offDuringWrite = () => (this._offAt[deviceId] || 0) >= writeStart;
      const written = this._lastWritten[deviceId] || (this._lastWritten[deviceId] = {});

      if (needTemp && device.capabilitiesObj.light_mode
        && device.capabilitiesObj.light_mode.value !== 'temperature') {
        await device.setCapabilityValue('light_mode', 'temperature')
          .catch((err) => this.log(`Could not set light_mode on ${deviceId}:`, err.message));
      }

      // Plain dimmable lights (no light_temperature capability) never get
      // this write — they still follow the group's dim curve below.
      if (needTemp && !offDuringWrite()) {
        written.light_temperature = value;
        await device.setCapabilityValue('light_temperature', value, capOpts);
        this._lastAppliedAt[deviceId] = Date.now();
      }

      if (needDim && !offDuringWrite()) {
        written.dim = dimValue;
        await device.setCapabilityValue('dim', dimValue, capOpts)
          .catch((err) => this.log(`Could not set dim on ${deviceId}:`, err.message));
        this._lastAppliedAt[deviceId] = Date.now();
      }

      if (!this._simulationRunning) {
        this._noteStatus(deviceId, 'ok', opts.quick ? 'Satt ved påslag' : 'Følger døgnrytmen', {
          temp: needTemp ? value : null,
          dim: needDim ? dimValue : null,
        });
      }

      // Many lights treat "set brightness/colour" as "switch on". If an off
      // came in while we were writing, our write may have switched the light
      // back on — so switch it off again to honour whoever turned it off.
      if (skipOffLights && !this._simulationRunning) {
        await sleep(1500 + fadeMs); // give the off-event a moment to arrive
        if (offDuringWrite() && device.capabilitiesObj.onoff) {
          this.log(`"${name}" was switched off while we were writing — switching it off again.`);
          this._noteStatus(deviceId, 'off', 'Slått av mens appen skrev, slått av igjen');
          await device.setCapabilityValue('onoff', false)
            .catch((err) => this.log(`Could not switch off ${deviceId}:`, err.message));
        }
      }
    } catch (err) {
      this.log(`Failed to update device ${deviceId}:`, err.message);
      this._noteStatus(deviceId, 'error', 'Feil: ' + err.message);
    }
  }

}

module.exports = CircadianApp;
