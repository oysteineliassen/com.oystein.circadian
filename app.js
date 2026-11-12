'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const SunCalc = require('suncalc');
const {
  UPDATE_INTERVAL_MS, LUX_DIM_TOLERANCE, DEFAULT_GROUP, DEFAULT_CONFIG, LOCALES, fill, makeId,
} = require('./lib/shared');
const {
  freeDays, fromDeviceTemp, groupValues, isWeekendAt, luxFactor, zonedDate, zonedMinutesOfDay, pausedAt,
} = require('./lib/circadian');

class CircadianApp extends Homey.App {

  async onInit() {
    this.log('Circadian Lighting starting...');

    const savedConfig = await this.homey.settings.get('config');
    this.config = this._migrateConfig(savedConfig);
    if (!savedConfig || savedConfig.holidays === undefined) {
      // Existing setups had Norwegian holidays from before this was a setting;
      // new ones get them when the Homey is set to Norwegian
      let lang = null;
      try { lang = this.homey.i18n.getLanguage(); } catch (err) { /* unknown */ }
      const existing = !!(savedConfig && Array.isArray(savedConfig.groups) && savedConfig.groups.length);
      this.config.holidays = existing || lang === 'no' ? 'NO' : 'none';
    }
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
    this._reportedAt = {}; // deviceId -> when Homey last reported a change of the light
    this._failures = {}; // deviceId -> failed updates in a row
    this._luxListeningSince = {}; // sensorId -> when the app started listening to it
    this._notified = (await this.homey.settings.get('notified')) || {}; // problem key -> when the user was told
    this._waking = {}; // deviceId -> groupId while a sunrise wake-up brightens the light
    this._wakeDone = {}; // groupId -> date key of the last wake-up started
    this._insightLogs = {}; // log id -> Insights log
    this._luxInstances = {}; // sensorId -> DeviceCapability for measure_luminance
    this._luxReadings = {}; // sensorId -> [{ t, v }] over LUX_WINDOW_MS
    this._luxNames = {}; // sensorId -> name
    this._testing = null; // { groupId, timer, before: { deviceId -> state } } while a test colour shows
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
    await this._syncLuxListeners();

    this._registerFlowCards();

    this._tick = this._tick.bind(this);
    this._interval = this.homey.setInterval(this._tick, UPDATE_INTERVAL_MS);

    await this._tick();

    this.log('Circadian Lighting ready.');
  }

  /** A text from locales/<the Homey's language>.json; {name} is replaced by vars.name. */
  _t(key, vars) {
    let text = null;
    try {
      text = this.homey.__(key);
    } catch (err) { /* fall back to the key */ }
    if (typeof text !== 'string' || !text) text = key;
    return fill(text, vars);
  }

  /** A text in every language the app has, for titles Homey shows in the user's language. */
  _titles(key, vars) {
    const out = {};
    Object.entries(LOCALES).forEach(([lang, strings]) => {
      const text = key.split('.').reduce((o, k) => (o ? o[k] : undefined), strings);
      out[lang] = fill(typeof text === 'string' ? text : key, vars);
    });
    return out;
  }

  async onUninit() {
    if (this._interval) this.homey.clearInterval(this._interval);
    Object.values(this._capInstances || {}).forEach((list) => list.forEach((inst) => {
      try { inst.destroy(); } catch (err) { /* ignore */ }
    }));
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
      const group = Object.assign({}, DEFAULT_GROUP, saved, { name: this._t('app.defaultGroupName'), id: makeId() });
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
    await this._syncLuxListeners();
    await this._tick();
    await this._updateTokens();
    await this._pruneInsights();
    this._pruneProblems();
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
        const target = this._groupTarget(g, now, sun);
        return {
          id: g.id,
          name: g.name,
          enabled: g.enabled !== false,
          weekend: !!(now.weekend && g.weekendEnabled),
          temp: v.temp,
          dim: v.dim,
          lux: target.lux != null ? Math.round(target.lux) : null,
          luxFactor: target.luxFactor != null ? target.luxFactor : null,
          luxSensor: g.luxSensorId ? this._luxNames[g.luxSensorId] || null : null,
          waking: (g.deviceIds || []).some((id) => this._waking[id] === g.id),
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
              reportedAt: this._reportedAt[id] || null,
            };
          }),
        };
      }),
    };
  }

  async resumeDevice(deviceId) {
    delete this.locks[deviceId];
    this._persistLocks();
    this._applyNowTo([deviceId]);
    return true;
  }

  async resumeAll() {
    const ids = Object.keys(this.locks);
    this.locks = {};
    this._persistLocks();
    this._applyNowTo(ids);
    return true;
  }

  /**
   * Give these lights their room's values right away, without the settle
   * wait (they were just unlocked, nothing to catch) and without making the
   * caller wait: the settings page and Flow answer at once, and the lights
   * follow within a second or two.
   */
  _applyNowTo(ids) {
    if (!this.config || this.config.enabled === false) return;
    const now = this._now();
    const sun = this._sunMinutes();
    ids.forEach((id) => {
      if (this._missing[id] || this._waking[id] || this._isTesting(id)) return;
      const group = this._groupsFor(id)[0];
      if (!group || pausedAt(group, now.minutes)) return;
      const target = this._groupTarget(group, now, sun);
      this._applyToDevice(id, target.temp, target.dim, group.skipOffLights !== false, {
        quick: true, dimTolerance: target.dimTolerance,
      }).catch((err) => this.log(`Could not update ${id} after unlocking:`, err.message));
    });
  }

  /** Whether the light's room is in one of its pauses right now. */
  _isPausedNow(deviceId) {
    const group = this._groupsFor(deviceId)[0];
    return !!(group && pausedAt(group, this._now().minutes));
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
    const free = freeDays(date, this.timeZone, this.config.holidays);
    return { minutes, free, date: zonedDate(date, this.timeZone), weekend: isWeekendAt(free, minutes) };
  }

  /** The { temp, dim } to give a group's lights right now, daylight included (dim may be null). */
  _groupValuesNow(group) {
    return this._groupTarget(group, this._now(), this._sunMinutes());
  }

  /**
   * What the group's lights should get: the plan's values, with brightness
   * lowered for daylight when the group has a light sensor. Then dim is set
   * even if the plan leaves it alone (full brightness, lowered), and only
   * changes of more than LUX_DIM_TOLERANCE are written.
   */
  _groupTarget(group, now, sun) {
    const v = groupValues(group, now.minutes, sun, now.weekend);
    if (!group.luxEnabled || !group.luxSensorId) return Object.assign({ dimTolerance: 0 }, v);
    const lux = this._luxNow(group.luxSensorId);
    if (lux == null) return Object.assign({ dimTolerance: 0 }, v);
    const factor = luxFactor(lux, group);
    return {
      temp: v.temp,
      dim: (v.dim == null ? 1 : v.dim) * factor,
      dimTolerance: LUX_DIM_TOLERANCE,
      lux,
      luxFactor: factor,
    };
  }

  async _tick() {
    if (this._simulationRunning) return; // don't fight the simulation loop
    if (!this.config || !this.config.enabled) return;
    if (!Array.isArray(this.config.groups) || this.config.groups.length === 0) return;

    const sun = this._sunMinutes();
    const now = this._now();

    this._checkWakeUps(now, sun);
    this._checkSensors();

    for (const group of this.config.groups) {
      if (!group || group.enabled === false) continue;
      if (!Array.isArray(group.deviceIds) || group.deviceIds.length === 0) continue;
      if (pausedAt(group, now.minutes)) continue; // a pause set for this time of day

      const { temp: tempValue, dim: dimValue, dimTolerance } = this._groupTarget(group, now, sun);

      // Run devices in this group in parallel rather than one after another,
      // so the settle delay in _applyValuesToDevice (see there) doesn't add
      // up across many lights.
      await Promise.all(group.deviceIds.map((deviceId) => {
        if (this.locks[deviceId]) return null; // manually adjusted, waiting to be resumed
        if (this._missing[deviceId]) return null; // deleted or re-paired in Homey
        if (this._waking[deviceId]) return null; // a sunrise wake-up is brightening it
        if (this._isTesting(deviceId)) return null; // showing a test colour
        return this._applyToDevice(deviceId, tempValue, dimValue, group.skipOffLights !== false, {
          fadeMs: this._fadeMs(group),
          dimTolerance,
        });
      }));
    }

    this._updateTokens(now, sun);
    this._logInsights(now, sun);
  }

}

// The app's methods live in lib/ by topic; each file adds its methods to the app.
['flow', 'simulation', 'lights', 'writing', 'daylight', 'testcolor', 'wakeup', 'insights', 'notifications'].forEach((name) => {
  Object.assign(CircadianApp.prototype, require(`./lib/${name}`));
});

module.exports = CircadianApp;
