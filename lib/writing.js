'use strict';

// Writing values to the lights. Methods of the app (see app.js), so `this` is the app.

const {
  SETTLE_MS, MAX_FADE_SECONDS, DEFAULT_GROUP, sleep,
} = require('./shared');
const {
  toDeviceTemp,
} = require('./circadian');

module.exports = {
  _fadeMs(group) {
    const s = Number(group.fadeSeconds != null ? group.fadeSeconds : DEFAULT_GROUP.fadeSeconds);
    if (!Number.isFinite(s) || s <= 0) return 0;
    return Math.round(Math.min(s, MAX_FADE_SECONDS) * 1000);
  },


  /**
   * Flow action: switch on every light in a group — including ones that are
   * off — at the values the schedule calls for right now, and unlock them so
   * the circadian rhythm keeps controlling them from here on.
   */
  async turnOnGroup(groupId) {
    const group = (this.config.groups || []).find((g) => g.id === groupId);
    if (!group) throw new Error(this._t('app.groupNotFound'));
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
  },


  async _applyToDevice(deviceId, value, dimValue, skipOffLights, opts) {
    try {
      const device = await this.homeyApi.devices.getDevice({ id: deviceId });
      if (!device) return;
      await this._applyValuesToDevice(deviceId, device, value, dimValue, skipOffLights, opts);
    } catch (err) {
      if (this._markIfMissing(deviceId, err)) return;
      this.log(`Failed to update device ${deviceId}:`, err.message);
      this._noteStatus(deviceId, 'error', this._t('app.errorPrefix') + err.message);
    }
  },


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
    if (check !== 'missing') this._noteUpdateResult(deviceId, check !== 'error');
  },


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
        this._noteStatus(deviceId, 'off', this._t('app.statusOff'));
        return; // leave lights that are switched off alone
      }

      // A light switched off right as we're about to write could still
      // slip through; wait briefly and re-check the live state. Skipped
      // during the fast 24h simulation, which needs to run in ~1 minute.
      if (skipOffLights && !this._simulationRunning) {
        if (!opts.quick) await sleep(SETTLE_MS);
        if (this._isOffState(liveState())) {
          this.log(`Skipping "${name}" — went off during settle check.`);
          this._noteStatus(deviceId, 'off', this._t('app.statusOff'));
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
          this._noteStatus(deviceId, 'error', this._t('app.statusReadFailed'));
          return;
        }
        const fc = (fresh && fresh.capabilitiesObj) || {};
        const freshState = {
          onoff: fc.onoff ? fc.onoff.value : undefined,
          dim: fc.dim ? fc.dim.value : undefined,
        };
        if (this._isOffState(freshState)) {
          this.log(`Skipping "${name}" — Homey reports it off, but our live state said on. Re-listening.`);
          this._noteStatus(deviceId, 'stale', this._t('app.statusStale'));
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
        && (cur.dim == null || Math.abs(cur.dim - dimValue) > Math.max(0.005, opts.dimTolerance || 0));

      if (!needTemp && !needDim) {
        this._noteStatus(deviceId, 'ok', this._t('app.statusFollowing'));
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
        this._noteStatus(deviceId, 'ok', opts.quick ? this._t('app.statusSetOnSwitchOn') : this._t('app.statusFollowing'), {
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
          this._noteStatus(deviceId, 'off', this._t('app.statusOffAgain'));
          await device.setCapabilityValue('onoff', false)
            .catch((err) => this.log(`Could not switch off ${deviceId}:`, err.message));
        }
      }
    } catch (err) {
      this.log(`Failed to update device ${deviceId}:`, err.message);
      this._noteStatus(deviceId, 'error', this._t('app.errorPrefix') + err.message);
    }
  },
};
