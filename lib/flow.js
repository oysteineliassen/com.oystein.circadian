'use strict';

// Flow cards and the tokens they offer. Methods of the app (see app.js), so `this` is the app.

const {
  groupValues,
} = require('./circadian');

module.exports = {
  _registerFlowCards() {
    try {
      this.homey.flow.getActionCard('resume-circadian')
        .registerRunListener(async () => {
          await this.resumeAll();
          return true;
        });
    } catch (err) {
      this.log('Could not register "resume-circadian" flow card:', err.message);
    }

    try {
      this.homey.flow.getActionCard('resume-circadian-device')
        .registerRunListener(async (args) => {
          if (args && args.device && args.device.id) {
            await this.resumeDevice(args.device.id);
          }
          return true;
        });
      this.homey.flow.getActionCard('resume-circadian-device')
        .registerArgumentAutocompleteListener('device', async (query) => {
          const devices = await this.getControllableDevices();
          return devices
            .filter((d) => d.name.toLowerCase().includes((query || '').toLowerCase()))
            .map((d) => ({ id: d.id, name: d.name }));
        });
    } catch (err) {
      this.log('Could not register "resume-circadian-device" flow card:', err.message);
    }

    try {
      const card = this.homey.flow.getActionCard('turn-on-group');
      card.registerRunListener(async (args) => {
        if (args && args.group && args.group.id) await this.turnOnGroup(args.group.id);
        return true;
      });
      card.registerArgumentAutocompleteListener('group', async (query) => {
        const q = (query || '').toLowerCase();
        return (this.config.groups || [])
          .filter((g) => (g.name || '').toLowerCase().includes(q))
          .map((g) => ({ id: g.id, name: g.name || this._t('app.unnamed') }));
      });
    } catch (err) {
      this.log('Could not register "turn-on-group" flow card:', err.message);
    }

    try {
      const card = this.homey.flow.getActionCard('pause-until-off');
      card.registerRunListener(async (args) => {
        if (args && args.target && args.target.id) await this.pauseUntilOff(args.target.id);
        return true;
      });
      card.registerArgumentAutocompleteListener('target', async (query) => {
        const q = (query || '').toLowerCase();
        const groups = (this.config.groups || []).map((g) => ({
          id: 'group:' + g.id, name: this._t('app.groupPrefix') + (g.name || this._t('app.unnamed')),
        }));
        const lights = (await this.getControllableDevices()).map((d) => ({ id: d.id, name: d.name }));
        return groups.concat(lights).filter((x) => x.name.toLowerCase().includes(q));
      });
    } catch (err) {
      this.log('Could not register "pause-until-off" flow card:', err.message);
    }

    const groupAutocomplete = async (query) => {
      const q = (query || '').toLowerCase();
      return (this.config.groups || [])
        .filter((g) => g && (g.name || '').toLowerCase().includes(q))
        .map((g) => ({ id: g.id, name: g.name || this._t('app.unnamed') }));
    };

    try {
      const card = this.homey.flow.getActionCard('set-group-enabled');
      card.registerRunListener(async (args) => {
        if (args && args.group && args.group.id) {
          await this.setGroupEnabled(args.group.id, args.state === 'on');
        }
        return true;
      });
      card.registerArgumentAutocompleteListener('group', groupAutocomplete);
    } catch (err) {
      this.log('Could not register "set-group-enabled" flow card:', err.message);
    }

    try {
      const card = this.homey.flow.getConditionCard('is-locked');
      card.registerRunListener(async (args) => !!(args && args.device && this.locks[args.device.id]));
      card.registerArgumentAutocompleteListener('device', async (query) => {
        const q = (query || '').toLowerCase();
        return (await this.getControllableDevices())
          .filter((d) => d.name.toLowerCase().includes(q))
          .map((d) => ({ id: d.id, name: d.name }));
      });
    } catch (err) {
      this.log('Could not register "is-locked" flow card:', err.message);
    }

    try {
      const card = this.homey.flow.getActionCard('start-wake-up');
      card.registerRunListener(async (args) => {
        if (args && args.group && args.group.id) await this.startWakeUpNow(args.group.id, args.minutes);
        return true;
      });
      card.registerArgumentAutocompleteListener('group', groupAutocomplete);
    } catch (err) {
      this.log('Could not register "start-wake-up" flow card:', err.message);
    }

    ['wake-up-started', 'wake-up-finished'].forEach((id) => {
      try {
        const card = this.homey.flow.getTriggerCard(id);
        card.registerRunListener(async (args, state) => !!(args && args.group && state && args.group.id === state.groupId));
        card.registerArgumentAutocompleteListener('group', groupAutocomplete);
      } catch (err) {
        this.log(`Could not register "${id}" flow card:`, err.message);
      }
    });
  },


  /** Flow action: switch circadian control for one group on or off. */
  async setGroupEnabled(groupId, enabled) {
    const group = (this.config.groups || []).find((g) => g && g.id === groupId);
    if (!group) throw new Error(this._t('app.groupNotFound'));
    group.enabled = !!enabled;
    try {
      this.homey.settings.set('config', this.config);
    } catch (err) {
      this.log('Could not save config:', err.message);
    }
    this.log(`Group "${group.name}" ${enabled ? 'enabled' : 'disabled'} from a flow.`);
    if (enabled) await this._tick();
    return true;
  },


  /**
   * Global Flow tokens with each group's current values, as percentages
   * (warmth 0 = coldest, 100 = warmest). Runs one at a time, since ticks
   * and saves can overlap and a token can only be created once.
   */
  _updateTokens(now, sun) {
    this._tokenQueue = (this._tokenQueue || Promise.resolve())
      .then(() => this._doUpdateTokens(now || this._now(), sun || this._sunMinutes()))
      .catch((err) => this.log('Could not update flow tokens:', err.message));
    return this._tokenQueue;
  },


  async _doUpdateTokens(now, sun) {
    const wanted = {};
    (this.config.groups || []).forEach((g) => {
      if (!g || !g.id) return;
      const v = groupValues(g, now.minutes, sun, now.weekend);
      const name = g.name || this._t('app.unnamed');
      if (v.temp != null) wanted[`${g.id}-temp`] = { title: this._t('app.tokenWarmth', { name }), value: Math.round(v.temp * 100) };
      if (v.dim != null) wanted[`${g.id}-dim`] = { title: this._t('app.tokenBrightness', { name }), value: Math.round(v.dim * 100) };
    });

    // Remove tokens for deleted groups, and renamed ones (a token's title is fixed)
    for (const [id, t] of Object.entries(this._tokens)) {
      if (wanted[id] && wanted[id].title === t.title) continue;
      delete this._tokens[id];
      await this.homey.flow.unregisterToken(t.token)
        .catch((err) => this.log(`Could not remove flow token ${id}:`, err.message));
    }

    for (const [id, w] of Object.entries(wanted)) {
      if (!this._tokens[id]) {
        const token = await this.homey.flow.createToken(id, { type: 'number', title: w.title, value: w.value });
        this._tokens[id] = { token, title: w.title, value: w.value };
      } else if (this._tokens[id].value !== w.value) {
        await this._tokens[id].token.setValue(w.value);
        this._tokens[id].value = w.value;
      }
    }
  },


  _triggerLocked(deviceId, name) {
    try {
      this.homey.flow.getTriggerCard('light-locked')
        .trigger({ light: name })
        .catch((err) => this.log('Could not run "light-locked" trigger:', err.message));
    } catch (err) {
      this.log('Could not run "light-locked" trigger:', err.message);
    }
  },


  _triggerWakeUp(cardId, group) {
    try {
      this.homey.flow.getTriggerCard(cardId)
        .trigger({ room: group.name || '' }, { groupId: group.id })
        .catch((err) => this.log(`Could not run "${cardId}" trigger:`, err.message));
    } catch (err) {
      this.log(`Could not run "${cardId}" trigger:`, err.message);
    }
  },
};
