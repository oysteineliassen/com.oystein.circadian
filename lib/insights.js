'use strict';

// Homey Insights logs, and the history graph that reads them back. Methods of the app (see app.js), so `this` is the app.


module.exports = {
  /**
   * Log what each enabled group's lights are given (daylight included), as
   * percentages, plus the daylight it measured, for Homey's Insights and the
   * history graph on the settings page.
   */
  async _logInsights(now, sun) {
    try {
      for (const g of this.config.groups || []) {
        if (!g || !g.id || g.enabled === false) continue;
        const v = this._groupTarget(g, now, sun);
        const name = g.name || this._t('app.unnamed');
        if (v.temp != null) await (await this._insightLog(`${g.id}-temp`, this._titles('app.insightWarmth', { name }))).createEntry(Math.round(v.temp * 100));
        if (v.dim != null) await (await this._insightLog(`${g.id}-dim`, this._titles('app.insightBrightness', { name }))).createEntry(Math.round(v.dim * 100));
        if (v.lux != null) await (await this._insightLog(`${g.id}-lux`, this._titles('app.insightDaylight', { name }), 'lx')).createEntry(Math.round(v.lux));
      }
    } catch (err) {
      this.log('Could not log to Insights:', err.message);
    }
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
   * { temp, dim, lux }, each [[time ms, value], ...], over the last day or week.
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
        return []; // no log yet (new room, or no light sensor)
      }
    };
    const [temp, dim, lux] = await Promise.all(['temp', 'dim', 'lux'].map(read));
    return { range: range === 'week' ? 'week' : 'day', temp, dim, lux };
  },


  /** Remove the Insights logs of deleted groups. */
  async _pruneInsights() {
    try {
      const wanted = new Set();
      (this.config.groups || []).forEach((g) => {
        if (g && g.id) ['temp', 'dim', 'lux'].forEach((k) => wanted.add(`${g.id}-${k}`));
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
