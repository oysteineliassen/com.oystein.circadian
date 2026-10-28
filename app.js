'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const SunCalc = require('suncalc');
const { calculateCircadianValue, calculateKeyframeValues, zonedMinutesOfDay } = require('./lib/circadian');

const UPDATE_INTERVAL_MS = 2 * 60 * 1000; // recompute every 2 minutes
const LOCK_GRACE_MS = 8000; // ignore device updates for this long after we write a value ourselves
const SETTLE_MS = 3000; // wait this long and re-check "off" right before writing, to catch a just-missed off event

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
};

const DEFAULT_CONFIG = {
  enabled: true,
  groups: [],
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
    return this.config;
  }

  async applyNow() {
    await this._tick();
    return { appliedAt: new Date().toISOString() };
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

    let sunriseMinutes = null;
    let sunsetMinutes = null;
    try {
      const lat = this.homey.geolocation.getLatitude();
      const lng = this.homey.geolocation.getLongitude();
      if (lat != null && lng != null) {
        const times = SunCalc.getTimes(new Date(), lat, lng);
        sunriseMinutes = zonedMinutesOfDay(times.sunrise, this.timeZone);
        sunsetMinutes = zonedMinutesOfDay(times.sunset, this.timeZone);
      }
    } catch (err) {
      this.log('Simulation: sun times unavailable:', err.message);
    }

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

          let tempValue;
          let dimValue = null;

          if (group.mode === 'keyframes' && Array.isArray(group.keyframes) && group.keyframes.length > 0) {
            const result = calculateKeyframeValues(simMinutes, group.keyframes);
            tempValue = result.temp;
            dimValue = result.dim;
          } else {
            tempValue = calculateCircadianValue(simMinutes, {
              sunriseMinutes,
              sunsetMinutes,
              wakeTime: group.wakeTime,
              sleepTime: group.sleepTime,
              transitionMinutes: group.transitionMinutes,
              useSunTimes: group.useSunTimes,
              warmValue: group.warmValue,
              coolValue: group.coolValue,
            });
            if (group.adjustBrightness) {
              dimValue = calculateCircadianValue(simMinutes, {
                sunriseMinutes,
                sunsetMinutes,
                wakeTime: group.wakeTime,
                sleepTime: group.sleepTime,
                transitionMinutes: group.transitionMinutes,
                useSunTimes: group.useSunTimes,
                warmValue: group.nightDim,
                coolValue: group.dayDim,
              });
            }
          }

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
        this.log(`Could not listen to capability changes for ${deviceId}:`, err.message);
      }
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

    // Manual-lock detection: only colour/brightness adjustments count, not
    // simply switching the light on or off.
    if (cap === 'onoff') return;
    if (this._simulationRunning) return;
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
    }
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

  /** The { temp, dim } a group's schedule calls for at nowMinutes (dim may be null). */
  _groupValues(group, nowMinutes, sun) {
    if (group.mode === 'keyframes' && Array.isArray(group.keyframes) && group.keyframes.length > 0) {
      return calculateKeyframeValues(nowMinutes, group.keyframes);
    }
    const common = {
      sunriseMinutes: sun.sunriseMinutes,
      sunsetMinutes: sun.sunsetMinutes,
      wakeTime: group.wakeTime,
      sleepTime: group.sleepTime,
      transitionMinutes: group.transitionMinutes,
      useSunTimes: group.useSunTimes,
    };
    const temp = calculateCircadianValue(nowMinutes, Object.assign({}, common, {
      warmValue: group.warmValue, coolValue: group.coolValue,
    }));
    const dim = group.adjustBrightness
      ? calculateCircadianValue(nowMinutes, Object.assign({}, common, {
        warmValue: group.nightDim, coolValue: group.dayDim,
      }))
      : null;
    return { temp, dim };
  }

  async _tick() {
    if (this._simulationRunning) return; // don't fight the simulation loop
    if (!this.config || !this.config.enabled) return;
    if (!Array.isArray(this.config.groups) || this.config.groups.length === 0) return;

    const sun = this._sunMinutes();
    const nowMinutes = zonedMinutesOfDay(new Date(), this.timeZone);

    for (const group of this.config.groups) {
      if (!group || group.enabled === false) continue;
      if (!Array.isArray(group.deviceIds) || group.deviceIds.length === 0) continue;

      const { temp: tempValue, dim: dimValue } = this._groupValues(group, nowMinutes, sun);

      // Run devices in this group in parallel rather than one after another,
      // so the settle delay in _applyValuesToDevice (see there) doesn't add
      // up across many lights.
      await Promise.all(group.deviceIds.map((deviceId) => {
        if (this.locks[deviceId]) return null; // manually adjusted, waiting to be resumed
        return this._applyToDevice(deviceId, tempValue, dimValue, group.skipOffLights !== false);
      }));
    }
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

    const { temp, dim } = this._groupValues(group, zonedMinutesOfDay(new Date(), this.timeZone), this._sunMinutes());
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
          written.light_temperature = temp;
          await device.setCapabilityValue('light_temperature', temp)
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

  async _applyToDevice(deviceId, value, dimValue, skipOffLights) {
    try {
      const device = await this.homeyApi.devices.getDevice({ id: deviceId });
      if (!device) return;
      await this._applyValuesToDevice(deviceId, device, value, dimValue, skipOffLights);
    } catch (err) {
      this.log(`Failed to update device ${deviceId}:`, err.message);
    }
  }

  /**
   * Writes the given values to an already-resolved device object. Kept
   * separate from _applyToDevice so the simulation loop can reuse cached
   * device objects instead of re-fetching one from Homey on every step.
   */
  async _applyValuesToDevice(deviceId, device, value, dimValue, skipOffLights) {
    try {
      if (!device || !device.capabilitiesObj) return;

      const name = device.name || deviceId;

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
        return; // leave lights that are switched off alone
      }

      // A light switched off right as we're about to write could still
      // slip through; wait briefly and re-check the live state. Skipped
      // during the fast 24h simulation, which needs to run in ~1 minute.
      if (skipOffLights && !this._simulationRunning) {
        await sleep(SETTLE_MS);
        if (this._isOffState(liveState())) {
          this.log(`Skipping "${name}" — went off during settle check.`);
          return;
        }
        if (this.locks[deviceId]) return; // adjusted manually during the wait
      }

      const cur = liveState();
      const needTemp = value != null && device.capabilitiesObj.light_temperature
        && (cur.light_temperature == null || Math.abs(cur.light_temperature - value) > 0.005);
      const needDim = dimValue != null && device.capabilitiesObj.dim
        && (cur.dim == null || Math.abs(cur.dim - dimValue) > 0.005);

      if (!needTemp && !needDim) return; // already at the right values

      this.log(`Applying to "${name}": temp=${needTemp ? value : '-'}, dim=${needDim ? dimValue : '-'} `
        + `(live: onoff=${cur.onoff}, dim=${cur.dim})`);

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
        await device.setCapabilityValue('light_temperature', value);
        this._lastAppliedAt[deviceId] = Date.now();
      }

      if (needDim && !offDuringWrite()) {
        written.dim = dimValue;
        await device.setCapabilityValue('dim', dimValue)
          .catch((err) => this.log(`Could not set dim on ${deviceId}:`, err.message));
        this._lastAppliedAt[deviceId] = Date.now();
      }

      // Many lights treat "set brightness/colour" as "switch on". If an off
      // came in while we were writing, our write may have switched the light
      // back on — so switch it off again to honour whoever turned it off.
      if (skipOffLights && !this._simulationRunning) {
        await sleep(1500); // give the off-event a moment to arrive
        if (offDuringWrite() && device.capabilitiesObj.onoff) {
          this.log(`"${name}" was switched off while we were writing — switching it off again.`);
          await device.setCapabilityValue('onoff', false)
            .catch((err) => this.log(`Could not switch off ${deviceId}:`, err.message));
        }
      }
    } catch (err) {
      this.log(`Failed to update device ${deviceId}:`, err.message);
    }
  }

}

module.exports = CircadianApp;
