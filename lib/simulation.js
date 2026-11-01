'use strict';

// The 24-hour simulation on the settings page. Methods of the app (see app.js), so `this` is the app.

const {
  freeDays, groupValues, isWeekendAt,
} = require('./circadian');

module.exports = {
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
    if (!group) throw new Error(this._t('app.groupNotFound'));
    if (!Array.isArray(group.deviceIds) || group.deviceIds.length === 0) {
      throw new Error('Gruppen har ingen lys valgt');
    }
    if (this._simulationRunning) throw new Error(this._t('app.simulationRunning'));

    const steps = 60; // one write per simulated 24 minutes
    const durationSeconds = 60;
    const stepMs = Math.round((durationSeconds * 1000) / steps);
    const minutesPerStep = 1440 / steps;

    const sun = this._sunMinutes();
    const free = freeDays(new Date(), this.timeZone, this.config.holidays);

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
            this._simStatus.stoppedReason = this._simStatus.stoppedReason || this._t('app.stoppedByUser');
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
            this._simStatus.stoppedReason = this._simStatus.stoppedReason || this._t('app.stoppedByUser');
            break;
          }

          await new Promise((resolve) => this.homey.setTimeout(resolve, stepMs));
        }
      } catch (err) {
        this.log('[simulate] Error during simulation:', err.message);
        this._simStatus.stoppedReason = this._t('app.errorPrefix') + err.message;
      } finally {
        this._simulationRunning = false;
        this._simStatus.running = false;
        this.log('[simulate] Done, resuming real-time schedule.');
        this._tick().catch((err) => this.log('Tick after simulation failed:', err.message));
      }
    })();

    return { started: true, durationSeconds, steps };
  },


  getSimulationStatus() {
    return this._simStatus || { running: false };
  },


  async stopSimulation() {
    this._simulationRunning = false;
    if (this._simStatus) this._simStatus.stoppedReason = this._t('app.stoppedByUser');
    return { stopped: true };
  },
};
