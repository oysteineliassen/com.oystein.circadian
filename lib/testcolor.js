'use strict';

// "Show test colour" on the settings page. Methods of the app (see app.js), so `this` is the app.

const {
  TEST_COLOR_MS,
} = require('./shared');
const {
  REF_COOL_K, REF_WARM_K, toDeviceTemp,
} = require('./circadian');

module.exports = {
  /**
   * Show the same colour (kelvin) on every light in a group for
   * TEST_COLOR_MS, so lights of different brands can be compared and their
   * colour range adjusted. Afterwards every light gets back what it had.
   */
  async showTestColor(groupId, kelvin) {
    const group = (this.config.groups || []).find((g) => g && g.id === groupId);
    if (!group) throw new Error(this._t('app.groupNotFound'));
    if (this._testing) await this._endTestColor();
    const k = Math.max(1500, Math.min(10000, Number(kelvin) || 3000));
    const plan = Math.max(0, Math.min(1, (REF_COOL_K - k) / (REF_COOL_K - REF_WARM_K)));
    const ids = (group.deviceIds || []).filter((id) => !this._missing[id] && this._capState[id]);
    const before = {};
    ids.forEach((id) => { before[id] = Object.assign({}, this._capState[id]); });
    this._testing = { groupId, before, timer: null };
    this.log(`Showing ${k} K on "${group.name}" for ${TEST_COLOR_MS / 1000} s.`);

    const lights = await Promise.all(ids.map(async (id) => {
      const cal = this._calibration(id);
      const inRange = !cal || (k >= cal.warmK && k <= cal.coolK);
      try {
        const device = await this.homeyApi.devices.getDevice({ id });
        const caps = device.capabilitiesObj || {};
        this._lastAppliedAt[id] = Date.now();
        if (caps.dim) await device.setCapabilityValue('dim', 0.8);
        if (caps.light_temperature) {
          if (caps.light_mode && caps.light_mode.value !== 'temperature') {
            await device.setCapabilityValue('light_mode', 'temperature').catch(() => {});
          }
          await device.setCapabilityValue('light_temperature', toDeviceTemp(plan, cal));
        }
        if (caps.onoff) await device.setCapabilityValue('onoff', true);
        this._lastAppliedAt[id] = Date.now();
      } catch (err) {
        this.log(`Test colour failed for ${id}:`, err.message);
      }
      return { id, name: this._deviceNames[id] || id, calibrated: !!cal, inRange };
    }));
    this._testing.timer = this.homey.setTimeout(() => {
      this._endTestColor().catch((err) => this.log('Could not end test colour:', err.message));
    }, TEST_COLOR_MS);
    return { kelvin: k, seconds: TEST_COLOR_MS / 1000, lights };
  },


  async _endTestColor() {
    const testing = this._testing;
    if (!testing) return { stopped: false };
    this._testing = null;
    if (testing.timer) this.homey.clearTimeout(testing.timer);
    await Promise.all(Object.entries(testing.before).map(async ([id, st]) => {
      try {
        const device = await this.homeyApi.devices.getDevice({ id });
        const caps = device.capabilitiesObj || {};
        this._lastAppliedAt[id] = Date.now();
        if (caps.dim && st.dim != null) await device.setCapabilityValue('dim', st.dim);
        if (caps.light_temperature && st.light_temperature != null) await device.setCapabilityValue('light_temperature', st.light_temperature);
        if (caps.onoff && st.onoff === false) await device.setCapabilityValue('onoff', false);
        this._lastAppliedAt[id] = Date.now();
      } catch (err) {
        this.log(`Could not restore ${id} after test colour:`, err.message);
      }
    }));
    this.log('Test colour ended, lights restored.');
    this._tick().catch((err) => this.log('Tick after test colour failed:', err.message));
    return { stopped: true };
  },


  async stopTestColor() {
    return this._endTestColor();
  },


  _isTesting(deviceId) {
    return !!(this._testing && this._testing.before[deviceId]);
  },
};
