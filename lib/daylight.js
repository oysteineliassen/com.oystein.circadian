'use strict';

// Light sensors, for brightness that follows the daylight. Methods of the app (see app.js), so `this` is the app.

const {
  LUX_WINDOW_MS, SENSOR_QUIET_MS,
} = require('./shared');

module.exports = {
  async _syncLuxListeners() {
    const wanted = new Set((this.config.groups || [])
      .filter((g) => g && g.luxEnabled && g.luxSensorId).map((g) => g.luxSensorId));
    for (const id of Object.keys(this._luxInstances)) {
      if (wanted.has(id)) continue;
      try { this._luxInstances[id].destroy(); } catch (err) { /* ignore */ }
      delete this._luxInstances[id];
      delete this._luxReadings[id];
    }
    for (const id of wanted) {
      if (this._luxInstances[id]) continue;
      try {
        const device = await this.homeyApi.devices.getDevice({ id });
        const cap = device.capabilitiesObj && device.capabilitiesObj.measure_luminance;
        this._luxNames[id] = device.name || id;
        this._luxListeningSince[id] = Date.now();
        this._luxReadings[id] = cap && cap.value != null ? [{ t: Date.now(), v: cap.value }] : [];
        this._luxInstances[id] = device.makeCapabilityInstance('measure_luminance', (value) => {
          if (value == null) return;
          const readings = this._luxReadings[id] || (this._luxReadings[id] = []);
          readings.push({ t: Date.now(), v: value });
          const cutoff = Date.now() - LUX_WINDOW_MS;
          while (readings.length > 1 && readings[0].t < cutoff) readings.shift();
        });
      } catch (err) {
        this.log(`Could not listen to light sensor ${id}:`, err.message);
      }
    }
  },


  /**
   * The sensor's average over the last LUX_WINDOW_MS, or its last reading if
   * it has been quiet. Nothing (the plan's own brightness) once it has said
   * nothing for SENSOR_QUIET_MS: it may have run out of battery.
   */
  _luxNow(sensorId) {
    const readings = this._luxReadings[sensorId];
    if (!readings || readings.length === 0) return null;
    if (Date.now() - readings[readings.length - 1].t > SENSOR_QUIET_MS) return null;
    const cutoff = Date.now() - LUX_WINDOW_MS;
    const recent = readings.filter((r) => r.t >= cutoff);
    const use = recent.length > 0 ? recent : [readings[readings.length - 1]];
    return use.reduce((sum, r) => sum + r.v, 0) / use.length;
  },


  /** Lights with a light sensor, for the settings page. */
  async getLightSensors() {
    const devices = await this.homeyApi.devices.getDevices();
    return Object.values(devices)
      .filter((d) => Array.isArray(d.capabilities) && d.capabilities.includes('measure_luminance'))
      .map((d) => ({
        id: d.id,
        name: d.name,
        lux: d.capabilitiesObj && d.capabilitiesObj.measure_luminance ? d.capabilitiesObj.measure_luminance.value : null,
      }));
  },
};
