'use strict';

// Sunrise wake-up. Methods of the app (see app.js), so `this` is the app.

const {
  WAKE_STEP_MS, DEFAULT_GROUP,
} = require('./shared');
const {
  groupValues, isWeekendAt, toDeviceTemp, toMinutesFromTimeString, pausedAt,
} = require('./circadian');

module.exports = {
  /** Start the wake-up of any group whose wake-up window has begun. */
  _checkWakeUps(now, sun) {
    const dateKey = `${now.date.year}-${now.date.month}-${now.date.day}`;
    (this.config.groups || []).forEach((group) => {
      if (!group || group.enabled === false || !group.wakeUpEnabled) return;
      if (pausedAt(group, now.minutes)) return; // no wake-up starts during a pause
      const time = now.free.today ? group.wakeUpWeekendTime : group.wakeUpTime;
      if (!time) return;
      if (this._wakeDone[group.id] === dateKey) return;
      const end = toMinutesFromTimeString(time);
      const length = Math.max(5, Math.min(60, Number(group.wakeUpMinutes) || DEFAULT_GROUP.wakeUpMinutes));
      if (now.minutes < end - length || now.minutes >= end) return;
      this._wakeDone[group.id] = dateKey;
      this._startWakeUp(group, now, end, length, sun).catch((err) => this.log('Wake-up failed:', err.message));
    });
  },


  /**
   * Bring the group's lights that are off up from very dim and warm to the
   * plan's values at the wake time, a step every WAKE_STEP_MS. Lights that
   * are already on are in use and left alone; switching a light off, or a
   * lock, stops its wake-up.
   */
  async _startWakeUp(group, now, endMinutes, lengthMinutes, sun) {
    const ids = (group.deviceIds || []).filter((id) => !this.locks[id] && !this._missing[id]
      && this._capState[id] && this._isOffState(this._capState[id]));
    // Minutes until the wake time, also when it is just past midnight
    const leftAtStart = (((endMinutes - now.minutes) % 1440) + 1440) % 1440;
    endMinutes = ((endMinutes % 1440) + 1440) % 1440;
    this._triggerWakeUp('wake-up-started', group);
    if (ids.length === 0) {
      // Nothing to brighten (all lights already on), but flows waiting for
      // the wake-up to finish still run at the wake time
      this.homey.setTimeout(() => this._triggerWakeUp('wake-up-finished', group), leftAtStart * 60000);
      return;
    }
    const target = groupValues(group, endMinutes, sun, isWeekendAt(now.free, endMinutes));
    const targetDim = target.dim != null ? target.dim : 1;
    const startedAt = Date.now();
    ids.forEach((id) => { this._waking[id] = group.id; });
    this.log(`Sunrise wake-up for "${group.name}": ${ids.length} light(s) until ${Math.floor(endMinutes / 60)}:${String(endMinutes % 60).padStart(2, '0')}.`);

    let first = true;
    let interval = null;
    let finished = false;
    const finish = () => {
      if (interval) this.homey.clearInterval(interval);
      ids.forEach((id) => { if (this._waking[id] === group.id) delete this._waking[id]; });
      if (!finished) this._triggerWakeUp('wake-up-finished', group);
      finished = true;
    };
    // Progress from the time the wake-up started (it may start late, e.g.
    // after a restart), so the ramp never depends on re-reading the clock
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
  },


  /** Flow action: start a group's sunrise wake-up now, ending in `minutes`. */
  async startWakeUpNow(groupId, minutes) {
    const group = (this.config.groups || []).find((g) => g && g.id === groupId);
    if (!group) throw new Error(this._t('app.groupNotFound'));
    const length = Math.max(1, Math.min(60, Math.round(Number(minutes) || Number(group.wakeUpMinutes) || DEFAULT_GROUP.wakeUpMinutes)));
    const now = this._now();
    await this._startWakeUp(group, now, now.minutes + length, length, this._sunMinutes());
    return true;
  },


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
      this._noteStatus(deviceId, 'ok', this._t('app.statusWaking'), { temp, dim });
    } catch (err) {
      if (this._markIfMissing(deviceId, err)) return;
      this.log(`Wake-up step failed for ${deviceId}:`, err.message);
    }
  },
};
