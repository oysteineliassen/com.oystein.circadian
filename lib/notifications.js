'use strict';

// Messages in Homey's timeline when something needs the user's attention: a
// light that no longer exists, a light sensor that has gone quiet, or a light
// that keeps failing to update. Each problem is told once, and again only
// after it has been solved and comes back (remembered across restarts).
// Methods of the app (see app.js), so `this` is the app.

const { SENSOR_QUIET_MS } = require('./shared');

const FAILURES_BEFORE_NOTICE = 3; // failed updates in a row before telling the user

module.exports = {
  _notifyProblem(key, text) {
    if (!this.config || this.config.notifyProblems === false) return;
    if (this._notified[key]) return;
    this._notified[key] = Date.now();
    this._persistNotified();
    this.log('Notifying:', text);
    Promise.resolve()
      .then(() => this.homey.notifications.createNotification({ excerpt: text }))
      .catch((err) => this.log('Could not create notification:', err.message));
  },

  _clearProblem(key) {
    if (!this._notified[key]) return;
    delete this._notified[key];
    this._persistNotified();
  },

  _persistNotified() {
    try {
      this.homey.settings.set('notified', this._notified);
    } catch (err) {
      this.log('Could not persist notifications:', err.message);
    }
  },

  /** The name of the (first) room a light is in, for messages. */
  _roomOf(deviceId) {
    const group = (this.config.groups || []).find((g) => g && (g.deviceIds || []).includes(deviceId));
    return (group && group.name) || this._t('app.unnamed');
  },

  /** Called with every update result of a light; tells the user when it keeps failing. */
  _noteUpdateResult(deviceId, ok) {
    const key = `failing:${deviceId}`;
    if (ok) {
      delete this._failures[deviceId];
      this._clearProblem(key);
      return;
    }
    this._failures[deviceId] = (this._failures[deviceId] || 0) + 1;
    if (this._failures[deviceId] === FAILURES_BEFORE_NOTICE) {
      this._notifyProblem(key, this._t('app.notifyFailing', {
        light: this._deviceNames[deviceId] || deviceId, room: this._roomOf(deviceId), n: FAILURES_BEFORE_NOTICE,
      }));
    }
  },

  /** Tell the user about light sensors that have measured nothing for SENSOR_QUIET_MS. */
  _checkSensors() {
    (this.config.groups || []).forEach((g) => {
      if (!g || !g.luxEnabled || !g.luxSensorId) return;
      const id = g.luxSensorId;
      const readings = this._luxReadings[id];
      const last = readings && readings.length ? readings[readings.length - 1].t : this._luxListeningSince[id];
      if (last == null) return;
      if (Date.now() - last > SENSOR_QUIET_MS) {
        this._notifyProblem(`sensor:${id}`, this._t('app.notifySensor', { sensor: this._luxNames[id] || id, room: g.name || this._t('app.unnamed') }));
      } else {
        this._clearProblem(`sensor:${id}`);
      }
    });
  },

  /** Forget problems with lights and sensors no room uses any more. */
  _pruneProblems() {
    const lights = this._managedDeviceIds();
    const sensors = new Set((this.config.groups || []).filter((g) => g && g.luxEnabled && g.luxSensorId).map((g) => g.luxSensorId));
    Object.keys(this._notified).forEach((key) => {
      const [kind, id] = key.split(/:(.*)/s);
      if ((kind === 'sensor' && !sensors.has(id)) || (kind !== 'sensor' && !lights.has(id))) this._clearProblem(key);
    });
  },
};
