'use strict';

// Homey Insights logs, and the history graph that reads them back. Methods of
// the app (see app.js), so `this` is the app.

const { fromDeviceTemp } = require('./circadian');

// Log ids, after the group id. The plan's values are what the app asks for
// (daylight included), whether or not the lights are on. The actual ones are
// what the room's lights really show: the average brightness of those that
// are on (0 when all are off), and their average warmth on the plan's scale
// (nothing logged when none of them is on).
const LOGS = ['plan-temp', 'plan-dim', 'actual-temp', 'actual-dim', 'lux'];

// Logs from before the plan and the actual brightness were told apart. The
// history graph still shows them until they are removed at the next save.
const LEGACY = { 'plan-temp': 'temp', 'plan-dim': 'dim' };

module.exports = {
  /** Log each enabled group's values, as percentages, plus its measured daylight. */
  async _logInsights(now, sun) {
    try {
      for (const g of this.config.groups || []) {
        if (!g || !g.id || g.enabled === false) continue;
        const v = this._groupTarget(g, now, sun);
        const name = g.name || this._t('app.unnamed');
        const entry = async (key, titleKey, value, units) => {
          const log = await this._insightLog(`${g.id}-${key}`, this._titles(titleKey, { name }), units);
          await log.createEntry(value);
        };
        if (v.temp != null) await entry('plan-temp', 'app.insightPlanWarmth', Math.round(v.temp * 100));
        if (v.dim != null) await entry('plan-dim', 'app.insightPlanBrightness', Math.round(v.dim * 100));
        const actual = this._actualBrightness(g);
        if (actual != null) await entry('actual-dim', 'app.insightActualBrightness', Math.round(actual * 100));
        const warmth = this._actualWarmth(g);
        if (warmth != null) await entry('actual-temp', 'app.insightActualWarmth', Math.round(warmth * 100));
        if (v.lux != null) await entry('lux', 'app.insightDaylight', Math.round(v.lux), 'lx');
      }
    } catch (err) {
      this.log('Could not log to Insights:', err.message);
    }
  },

  /**
   * The average brightness of the group's lights that are on (a light without
   * brightness counts as full), 0 when all are off. Null when the app knows
   * none of the lights' state yet.
   */
  _actualBrightness(group) {
    const states = (group.deviceIds || [])
      .filter((id) => !this._missing[id] && this._capState[id])
      .map((id) => this._capState[id]);
    if (states.length === 0) return null;
    const on = states.filter((st) => !this._isOffState(st));
    if (on.length === 0) return 0;
    return on.reduce((sum, st) => sum + (st.dim != null ? st.dim : 1), 0) / on.length;
  },

  /**
   * The average warmth of the group's lights that are on and have colour
   * temperature, on the plan's scale (their colour range taken into account),
   * so it compares with the plan. Null when none of them is on.
   */
  _actualWarmth(group) {
    const values = (group.deviceIds || [])
      .filter((id) => !this._missing[id] && this._capState[id])
      .filter((id) => !this._isOffState(this._capState[id]) && this._capState[id].light_temperature != null)
      .map((id) => fromDeviceTemp(this._capState[id].light_temperature, this._calibration(id)));
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  },

  async _insightLog(id, title, units = '%') {
    if (this._insightLogs[id]) return this._insightLogs[id];
    let log;
    try {
      log = await this.homey.insights.getLog(id);
    } catch (err) {
      log = await this.homey.insights.createLog(id, {
        title, type: 'number', units, decimals: 0,
      });
    }
    this._insightLogs[id] = log;
    return log;
  },

  /**
   * A group's logged values for the settings page's history graph:
   * { temp, dim, actual, actualTemp, lux }, each [[time ms, value], ...], over
   * the last day or week. temp and dim are the plan's; actual and actualTemp
   * are the lights' own brightness and warmth.
   */
  async getHistory(groupId, range) {
    const resolution = range === 'week' ? 'last7Days' : 'last24Hours';
    const appId = (this.homey.manifest && this.homey.manifest.id) || 'com.oystein.circadian';
    const read = async (key) => {
      try {
        const res = await this.homeyApi.insights.getLogEntries({ id: `homey:app:${appId}:${groupId}-${key}`, resolution });
        return ((res && res.values) || [])
          .filter((e) => e && e.v != null)
          .map((e) => [new Date(e.t).getTime(), e.v]);
      } catch (err) {
        return []; // no log yet (new room, no light sensor, or no legacy log)
      }
    };
    const withLegacy = async (key) => {
      const [current, old] = await Promise.all([read(key), LEGACY[key] ? read(LEGACY[key]) : []]);
      return old.concat(current).sort((a, b) => a[0] - b[0]);
    };
    const [temp, dim, actual, actualTemp, lux] = await Promise.all([
      withLegacy('plan-temp'), withLegacy('plan-dim'), read('actual-dim'), read('actual-temp'), read('lux'),
    ]);
    return { range: range === 'week' ? 'week' : 'day', temp, dim, actual, actualTemp, lux };
  },

  /** Remove the Insights logs of deleted groups, and logs of an older kind. */
  async _pruneInsights() {
    try {
      const wanted = new Set();
      (this.config.groups || []).forEach((g) => {
        if (g && g.id) LOGS.forEach((k) => wanted.add(`${g.id}-${k}`));
      });
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
  },
};
