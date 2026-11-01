'use strict';

// Following the lights: their live state, manual changes (locks), switching on, and lights that no longer exist. Methods of the app (see app.js), so `this` is the app.

const {
  LOCK_GRACE_MS, TURN_ON_DELAY_MS,
} = require('./shared');

module.exports = {
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
  },


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
  },


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
        this._clearProblem(`missing:${deviceId}`);
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
  },


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
    this._noteStatus(deviceId, 'missing', this._t('app.statusMissing'));
    this._notifyProblem(`missing:${deviceId}`, this._t('app.notifyMissing', { room: this._roomOf(deviceId) }));
    return true;
  },


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
  },


  _persistLocks() {
    try {
      this.homey.settings.set('locks', this.locks);
    } catch (err) {
      this.log('Could not persist locks:', err.message);
    }
  },


  /**
   * Flow action: leave a light (or every light in a group) alone until it is
   * next switched off — e.g. a motion-triggered night light that should stay
   * at the dim level the motion flow set, and be allowed to switch off.
   */
  async pauseUntilOff(target) {
    let ids = [];
    if (String(target).startsWith('group:')) {
      const group = (this.config.groups || []).find((g) => g.id === String(target).slice(6));
      if (!group) throw new Error(this._t('app.groupNotFound'));
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
  },


  _isOffState(state) {
    if (!state) return false;
    return state.onoff === false || (state.dim != null && state.dim <= 0.01);
  },


  _onCapabilityChange(deviceId, cap, value) {
    const name = this._deviceNames[deviceId] || deviceId;
    const state = this._capState[deviceId] || (this._capState[deviceId] = {});
    const prev = state[cap];
    const wasOff = this._isOffState(state);
    state[cap] = value;
    // Shown on the settings page: if it doesn't change after using a remote,
    // Homey never heard about it (e.g. the light's own app lost touch)
    this._reportedAt[deviceId] = Date.now();
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
    if (this._isTesting(deviceId)) return;
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
      this._noteStatus(deviceId, 'locked', this._t('app.statusLocked'));
      this._triggerLocked(deviceId, name);
    }
  },


  /** A light's colour temperature range, if set on the settings page. */
  _calibration(deviceId) {
    return ((this.config && this.config.calibration) || {})[deviceId] || null;
  },


  /** The enabled groups a light belongs to (the first one decides its values). */
  _groupsFor(deviceId) {
    return (this.config.groups || []).filter((g) => g && g.enabled !== false
      && Array.isArray(g.deviceIds) && g.deviceIds.includes(deviceId));
  },


  /**
   * A light was just switched on: give it the values the schedule has right
   * now, instead of leaving it at yesterday's colour until the next tick.
   * Waits TURN_ON_DELAY_MS first, so a flow that switches a light on and
   * then pauses it (e.g. a night light) gets to do so before we write.
   */
  _onSwitchedOn(deviceId) {
    if (this._simulationRunning || !this.config || this.config.enabled === false) return;
    if (this.locks[deviceId] || this._turningOn[deviceId] || this._waking[deviceId] || this._isTesting(deviceId)) return;
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
  },
};
