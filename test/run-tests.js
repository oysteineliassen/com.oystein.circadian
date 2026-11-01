'use strict';

// Tests for the app logic, with Homey, homey-api and suncalc replaced by
// small fakes. Run with: node test/run-tests.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEBUG = !!process.env.DEBUG;

// --- fakes for the modules the app requires ---

class FakeApp {
  log(...args) { if (DEBUG) console.log('    log:', ...args); }
  error(...args) { console.log('    error:', ...args); }
}

let currentApi = null;
const fakes = {
  homey: { App: FakeApp },
  'homey-api': { HomeyAPI: { createAppAPI: async () => currentApi } },
  suncalc: { getTimes: () => ({}) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (fakes[request]) return `fake:${request}`;
  return origResolve.call(this, request, ...rest);
};
Object.keys(fakes).forEach((name) => {
  require.cache[`fake:${name}`] = { id: name, filename: name, loaded: true, exports: fakes[name] };
});

const CircadianApp = require(path.join(ROOT, 'app.js'));
const lib = require(path.join(ROOT, 'lib/circadian.js'));

// The app's code: app.js and the methods it gets from lib/
function allAppSource() {
  return ['app.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => path.join('lib', f))]
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
}

const LOCALES = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8')),
  no: JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/no.json'), 'utf8')),
};
const lookup = (lang, key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), LOCALES[lang]);

function makeHomey(lang = 'no') {
  const cards = {};
  const card = (id) => cards[id] || (cards[id] = {
    id,
    run: null,
    autocomplete: {},
    triggered: [],
    registerRunListener(fn) { this.run = fn; return this; },
    registerArgumentAutocompleteListener(name, fn) { this.autocomplete[name] = fn; return this; },
    async trigger(tokens) { this.triggered.push(tokens); },
  });
  const tokens = {};
  const store = {};
  const logs = {};
  return {
    cards,
    tokens,
    logs,
    __: (key) => lookup(lang, key) || key,
    notices: [],
    notifications: { async createNotification({ excerpt }) { this.parent.notices.push(excerpt); } },
    i18n: { getLanguage: () => lang },
    insights: {
      async getLog(id) {
        if (!logs[id]) throw new Error('Not Found');
        return logs[id];
      },
      async createLog(id, opts) {
        logs[id] = { name: id, opts, entries: [], async createEntry(v) { this.entries.push(v); } };
        return logs[id];
      },
      async getLogs() { return Object.values(logs); },
      async deleteLog(log) { delete logs[log.name]; },
    },
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    flow: {
      getActionCard: card,
      getConditionCard: card,
      getTriggerCard: card,
      async createToken(id, opts) {
        if (tokens[id]) throw new Error(`token ${id} already exists`);
        const t = Object.assign({ id }, opts, { async setValue(v) { t.value = v; } });
        tokens[id] = t;
        return t;
      },
      async unregisterToken(t) { delete tokens[t.id]; },
    },
    clock: { getTimezone: () => 'Europe/Oslo' },
    geolocation: { getLatitude: () => null, getLongitude: () => null },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: () => 0,
    clearInterval: () => {},
  };
}

/**
 * A fake light. `cached` is what the app's cached device object says, `real`
 * is what Homey would answer for a fresh ($cache: false) fetch. They differ
 * when we want to imitate a lost event.
 */
function makeDevice(id, state) {
  const d = {
    id,
    name: `Lys ${id}`,
    class: 'light',
    capabilities: Object.keys(state),
    cached: Object.assign({}, state),
    real: Object.assign({}, state),
    writes: [],
    listeners: {},
    get capabilitiesObj() { return toCapsObj(this.cached); },
    async setCapabilityValue(cap, value, opts) {
      this.writes.push({ cap, value, opts });
      this.real[cap] = value;
    },
    makeCapabilityInstance(cap, cb) {
      this.listeners[cap] = cb;
      return { destroy() {} };
    },
    /** Imitate Homey reporting a change (the light, a switch, a person). */
    report(cap, value) {
      this.cached[cap] = value;
      this.real[cap] = value;
      if (this.listeners[cap]) this.listeners[cap](value);
    },
  };
  return d;
}

function toCapsObj(state) {
  const o = {};
  Object.keys(state).forEach((k) => { o[k] = { value: state[k] }; });
  return o;
}

const missingLookups = []; // ids the app asked for that Homey doesn't have

function makeApi(devices) {
  const byId = {};
  devices.forEach((d) => { byId[d.id] = d; });
  return {
    devices: {
      connect: async () => {},
      getDevices: async () => byId,
      async getDevice({ id, $cache }) {
        const d = byId[id];
        if (!d) {
          missingLookups.push(id);
          throw new Error(`Not Found: Device with ID ${id}`);
        }
        if ($cache !== false) return d;
        return Object.assign({}, d, { capabilitiesObj: toCapsObj(d.real) });
      },
    },
    zones: { getZones: async () => ({}) },
    insights: {
      // Only the room "g1" has logs, and no light sensor
      async getLogEntries({ id, resolution }) {
        // An old "dim" log at 10:00 and the new "plan-dim" at 10:05
        const m = /^homey:app:com\.oystein\.circadian:(g1)-(temp|dim|plan-dim|actual-dim|actual-temp)$/.exec(id);
        if (!m) throw new Error('Not Found');
        const at = ['plan-dim', 'actual-dim', 'actual-temp'].includes(m[2]) ? '2026-11-01T10:05:00.000Z' : '2026-11-01T10:00:00.000Z';
        const v = { temp: 20, dim: 80, 'plan-dim': 70, 'actual-dim': 60, 'actual-temp': 90 }[m[2]];
        return { values: [{ t: at, v }, { t: '2026-11-01T10:10:00.000Z', v: null }], resolution };
      },
    },
  };
}

const KEYFRAMES = [
  { time: '00:00', temp: 0.9, dim: 0.3 },
  { time: '12:00', temp: 0.1, dim: 1 },
];

async function startApp({ devices, groups, locks, lang, config }) {
  currentApi = makeApi(devices);
  const homey = makeHomey(lang);
  homey.notifications.parent = homey;
  if (config !== null) homey.settings.set('config', Object.assign({ enabled: true, groups }, config || {}));
  if (locks) homey.settings.set('locks', locks);
  const app = new CircadianApp();
  app.homey = homey;
  await app.onInit();
  return { app, homey };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- tests ---

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('helg: fredag kl. 12 til søndag kl. 12', () => {
  assert.strictEqual(lib.isWeekendPlan(5, 719), false);
  assert.strictEqual(lib.isWeekendPlan(5, 720), true);
  assert.strictEqual(lib.isWeekendPlan(6, 0), true);
  assert.strictEqual(lib.isWeekendPlan(6, 1439), true);
  assert.strictEqual(lib.isWeekendPlan(0, 719), true);
  assert.strictEqual(lib.isWeekendPlan(0, 720), false);
  assert.strictEqual(lib.isWeekendPlan(1, 600), false);
});

test('ukedag regnes i Homeys tidssone', () => {
  const d = new Date('2026-10-30T23:30:00Z'); // fredag 23:30 UTC = lørdag 00:30 i Oslo
  assert.strictEqual(lib.zonedWeekday(d, 'UTC'), 5);
  assert.strictEqual(lib.zonedWeekday(d, 'Europe/Oslo'), 6);
});

test('helgetider erstatter sol og faste tider', () => {
  const g = {
    mode: 'sun', useSunTimes: true, wakeTime: '06:30', sleepTime: '22:00', transitionMinutes: 60,
    warmValue: 1, coolValue: 0, weekendEnabled: true, weekendWakeTime: '09:00', weekendSleepTime: '23:30',
  };
  const sun = { sunriseMinutes: 7 * 60, sunsetMinutes: 17 * 60 };
  const at = (h, m) => h * 60 + m;
  assert.strictEqual(lib.groupValues(g, at(8, 0), sun, false).temp, 0); // dag etter soloppgang
  assert.strictEqual(lib.groupValues(g, at(8, 0), sun, true).temp, 1); // helg: fortsatt natt
  assert.strictEqual(lib.groupValues(g, at(22, 0), sun, true).temp, 0); // helg: fortsatt dag
  assert.strictEqual(lib.groupValues(Object.assign({}, g, { weekendEnabled: false }), at(8, 0), sun, true).temp, 0);
});

test('helgepunkter, og hverdagspunkter når helgen er tom', () => {
  const g = {
    mode: 'keyframes', keyframes: KEYFRAMES, weekendEnabled: true,
    weekendKeyframes: [{ time: '00:00', temp: 0.5, dim: 0.5 }],
  };
  assert.strictEqual(lib.groupValues(g, 0, {}, true).temp, 0.5);
  assert.strictEqual(lib.groupValues(g, 0, {}, false).temp, 0.9);
  g.weekendKeyframes = [];
  assert.strictEqual(lib.groupValues(g, 0, {}, true).temp, 0.9);
});

test('slår ikke på lys som Homey sier er av når appens tilstand er utdatert', async () => {
  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  d.real.onoff = false; // av-hendelsen gikk tapt
  await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  assert.deepStrictEqual(d.writes, []);
});

test('skriver med myk overgang i vanlig oppdatering', async () => {
  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, fadeSeconds: 3, deviceIds: ['a'] }] });
  const temp = d.writes.find((w) => w.cap === 'light_temperature');
  assert.ok(temp, 'skulle skrevet fargetemperatur');
  assert.deepStrictEqual(temp.opts, { duration: 3000 });
});

test('setter verdier med en gang når et lys slås på', async () => {
  const d = makeDevice('a', { onoff: false, dim: 0.5, light_temperature: 0.5 });
  await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  assert.deepStrictEqual(d.writes, [], 'av-lys skal ikke røres');
  const t0 = Date.now();
  d.report('onoff', true);
  await wait(300);
  const temp = d.writes.find((w) => w.cap === 'light_temperature');
  assert.ok(temp, 'skulle skrevet fargetemperatur ved påslag');
  assert.strictEqual(temp.opts, undefined, 'ingen fading ved påslag');
  assert.ok(Date.now() - t0 < 1000, 'skal ikke vente på 3 s-sjekken');
});

test('rører ikke et låst lys når det slås på', async () => {
  const d = makeDevice('a', { onoff: false, dim: 0.5, light_temperature: 0.5 });
  await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }], locks: { a: true } });
  d.report('onoff', true);
  await wait(300);
  assert.deepStrictEqual(d.writes, []);
});

test('manuell justering låser lyset og kjører triggeren', async () => {
  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const { app, homey } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  app._lastAppliedAt.a = 0; // utenfor tidsvinduet for appens eget ekko
  // Langt fra det appen selv skrev, ellers tolkes det (riktig) som ekkoet av
  // appens egen skriving. Det appen skriver, avhenger av klokkeslettet.
  const written = app._lastWritten.a && app._lastWritten.a.dim;
  d.report('dim', written != null && written > 0.5 ? 0.15 : 0.95);
  assert.strictEqual(app.locks.a, true);
  assert.deepStrictEqual(homey.cards['light-locked'].triggered, [{ light: 'Lys a' }]);
  assert.strictEqual(await homey.cards['is-locked'].run({ device: { id: 'a' } }), true);
  assert.strictEqual(await homey.cards['is-locked'].run({ device: { id: 'b' } }), false);
});

test('Flow-kort skrur gruppe av og på', async () => {
  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const { app, homey } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  await homey.cards['set-group-enabled'].run({ group: { id: 'g1' }, state: 'off' });
  assert.strictEqual(app.config.groups[0].enabled, false);
  assert.strictEqual(homey.settings.get('config').groups[0].enabled, false);
  const groups = await homey.cards['set-group-enabled'].autocomplete.group('stu');
  assert.deepStrictEqual(groups, [{ id: 'g1', name: 'Stue' }]);
});

test('tokens per gruppe, også ved nytt navn og sletting', async () => {
  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const { app, homey } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  await app._updateTokens();
  assert.deepStrictEqual(Object.keys(homey.tokens).sort(), ['g1-dim', 'g1-temp']);
  assert.strictEqual(homey.tokens['g1-temp'].title, 'Stue: varme (%)');
  app.config.groups[0].name = 'Kjøkken';
  await app._updateTokens();
  assert.strictEqual(homey.tokens['g1-temp'].title, 'Kjøkken: varme (%)');
  app.config.groups = [];
  await app._updateTokens();
  assert.deepStrictEqual(homey.tokens, {});
});

test('status viser lys, lås og siste handling', async () => {
  const d = makeDevice('a', { onoff: false, dim: 0.5, light_temperature: 0.5 });
  const { app } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  const st = await app.getStatus();
  assert.strictEqual(st.groups[0].name, 'Stue');
  const light = st.groups[0].lights[0];
  assert.strictEqual(light.name, 'Lys a');
  assert.strictEqual(light.on, false);
  assert.strictEqual(light.status.check, 'off');
});

test('alle Flow-kort og API-ruter i app.json finnes i koden', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const appSrc = allAppSource();
  const api = require(path.join(ROOT, 'api.js'));
  ['triggers', 'conditions', 'actions'].forEach((kind) => {
    (manifest.flow[kind] || []).forEach((card) => {
      assert.ok(appSrc.includes(`'${card.id}'`), `Flow-kortet ${card.id} brukes ikke i app.js eller lib/`);
    });
  });
  Object.keys(manifest.api).forEach((name) => {
    assert.strictEqual(typeof api[name], 'function', `API-ruten ${name} mangler i api.js`);
  });
});

test('innstillingssiden laster samme regnekode som appen', () => {
  const html = fs.readFileSync(path.join(ROOT, 'settings/index.html'), 'utf8');
  assert.ok(html.includes('<script type="text/javascript" src="circadian.js"></script>'), 'index.html laster ikke circadian.js');
  const vm = require('vm');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'settings/circadian.js'), 'utf8'), { window, Intl, Math, Date });
  assert.ok(window.Circadian, 'circadian.js setter ikke window.Circadian i nettleseren');
  assert.deepStrictEqual(Object.keys(window.Circadian).sort(), Object.keys(lib).sort());
  const g = { mode: 'keyframes', keyframes: KEYFRAMES };
  // Objects from the other context have another prototype, so compare values
  assert.strictEqual(JSON.stringify(window.Circadian.groupValues(g, 300, {}, false)), JSON.stringify(lib.groupValues(g, 300, {}, false)));
});

test('status gir tidssone og soltider til klokka', async () => {
  const d = makeDevice('a', { onoff: false, dim: 0.5, light_temperature: 0.5 });
  const { app } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  const st = await app.getStatus();
  assert.strictEqual(st.timeZone, 'Europe/Oslo');
  assert.deepStrictEqual(Object.keys(st.sun).sort(), ['sunriseMinutes', 'sunsetMinutes']);
});

test('lys som er slettet i Homey hoppes over og vises som manglende', async () => {
  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  missingLookups.length = 0;
  const { app } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a', 'gone'] }] });
  assert.ok(d.writes.length > 0, 'lyset som finnes skal fortsatt styres');
  const before = missingLookups.length;
  await app._tick();
  assert.strictEqual(missingLookups.length, before, 'skal ikke prøve det manglende lyset hver runde');
  const st = await app.getStatus();
  const gone = st.groups[0].lights.find((l) => l.id === 'gone');
  assert.strictEqual(gone.missing, true);
  assert.strictEqual(st.groups[0].lights.find((l) => l.id === 'a').missing, false);
});

test('røde dager følger helgeplanen, fra kl. 12 dagen før', () => {
  assert.deepStrictEqual(lib.easterSunday(2026), { year: 2026, month: 4, day: 5 });
  assert.deepStrictEqual(lib.easterSunday(2027), { year: 2027, month: 3, day: 28 });
  const holidays2026 = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 31; d++) {
      if (new Date(Date.UTC(2026, m - 1, d)).getUTCMonth() !== m - 1) continue;
      if (lib.isNorwegianHoliday({ year: 2026, month: m, day: d })) holidays2026.push(`${d}.${m}`);
    }
  }
  assert.deepStrictEqual(holidays2026, ['1.1', '2.4', '3.4', '5.4', '6.4', '1.5', '14.5', '17.5', '24.5', '25.5', '24.12', '25.12', '26.12', '31.12']);
  // Onsdag 13. mai 2026, kvelden før Kristi himmelfart: helgeplan fra kl. 12
  const wed = lib.freeDays(new Date('2026-05-13T08:00:00Z'), 'Europe/Oslo');
  assert.deepStrictEqual(wed, { today: false, tomorrow: true });
  assert.strictEqual(lib.isWeekendAt(wed, 600), false);
  assert.strictEqual(lib.isWeekendAt(wed, 800), true);
  // Søndag 17. mai 2026 kveld: mandag er arbeidsdag
  const sun17 = lib.freeDays(new Date('2026-05-17T18:00:00Z'), 'Europe/Oslo');
  assert.strictEqual(lib.isWeekendAt(sun17, 1200), false);
});

test('fargeområde per lampe gir samme farge på ulike merker', async () => {
  const ikea = { warmK: 2200, coolK: 4000 };
  assert.strictEqual(lib.toDeviceTemp(1, ikea), 1);
  assert.strictEqual(lib.toDeviceTemp(0, ikea), 0); // kaldere enn 4000 K går ikke
  assert.strictEqual(Math.round(lib.planToKelvin(0.8)), 3060);
  assert.ok(Math.abs(lib.toDeviceTemp(0.8, ikea) - (4000 - 3060) / 1800) < 0.001);
  assert.strictEqual(lib.toDeviceTemp(0.4, null), 0.4);
  assert.ok(Math.abs(lib.fromDeviceTemp(lib.toDeviceTemp(0.8, ikea), ikea) - 0.8) < 0.001);

  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const kf = [{ time: '00:00', temp: 0.8, dim: 0.5 }];
  const { app } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: kf, fadeSeconds: 0, deviceIds: ['a'] }] });
  assert.strictEqual(d.writes.find((w) => w.cap === 'light_temperature').value, 0.8, 'uten fargeområde: planens verdi');
  app.config.calibration = { a: ikea };
  d.writes.length = 0;
  await app._tick();
  const w = d.writes.find((x) => x.cap === 'light_temperature');
  assert.ok(w && Math.abs(w.value - lib.toDeviceTemp(0.8, ikea)) < 0.001, 'med fargeområde: omregnet verdi');
  const st = await app.getStatus();
  assert.ok(Math.abs(st.groups[0].lights[0].temp - 0.8) < 0.01, 'status viser planens skala');
});

test('soloppgangsvekking slår på lys som er av og lar dem være i fred underveis', async () => {
  const off = makeDevice('a', { onoff: false, dim: 0.5, light_temperature: 0.5 });
  const on = makeDevice('b', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const group = {
    id: 'g1', name: 'Soverom', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a', 'b'],
    wakeUpEnabled: true, wakeUpTime: '06:50', wakeUpWeekendTime: '', wakeUpMinutes: 20,
  };
  const { app } = await startApp({ devices: [off, on], groups: [group] });
  off.writes.length = 0;
  on.writes.length = 0;
  const now = { minutes: 400, free: { today: false, tomorrow: false }, date: { year: 2026, month: 11, day: 2 } };
  app._checkWakeUps(now, {});
  await wait(50);
  assert.ok(off.writes.some((w) => w.cap === 'onoff' && w.value === true), 'lyset som var av skal slås på');
  assert.ok(off.writes.find((w) => w.cap === 'dim').value <= 0.35, 'starter svakt');
  assert.deepStrictEqual(on.writes, [], 'lys som allerede er på, røres ikke');
  assert.strictEqual(app._waking.a, 'g1');
  // Samme dag: starter ikke på nytt. Helg uten helgetid: ingen vekking.
  const before = off.writes.length;
  app._checkWakeUps(now, {});
  app._checkWakeUps(Object.assign({}, now, { free: { today: true }, date: { year: 2026, month: 11, day: 7 } }), {});
  await wait(50);
  assert.strictEqual(off.writes.length, before);
  // Vanlig oppdatering hopper over lyset mens det vekkes
  off.writes.length = 0;
  await app._tick();
  assert.deepStrictEqual(off.writes, []);
});

test('verdiene logges til Insights, og slettede rom ryddes bort', async () => {
  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const { app, homey } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  await wait(20);
  assert.deepStrictEqual(Object.keys(homey.logs).sort(), ['g1-actual-dim', 'g1-actual-temp', 'g1-plan-dim', 'g1-plan-temp']);
  assert.ok(homey.logs['g1-plan-temp'].entries.length > 0);
  assert.strictEqual(homey.logs['g1-plan-temp'].opts.units, '%');
  assert.deepStrictEqual(homey.logs['g1-plan-dim'].opts.title, { en: 'Stue: brightness (plan)', no: 'Stue: lysstyrke (plan)' });
  // Faktisk lysstyrke: snittet av lysene som er på, 0 når alle er av
  const actual = homey.logs['g1-actual-dim'].entries;
  assert.ok(actual[actual.length - 1] > 0, 'lyset er på');
  // Faktisk varme på planens skala: en IKEA-lampe (2200–4000 K) på 0,5
  // er 3100 K, som er 0,79 på planens skala
  app.config.calibration = { a: { warmK: 2200, coolK: 4000 } };
  d.report('light_temperature', 0.5);
  await app._logInsights(app._now(), {});
  const warmth = homey.logs['g1-actual-temp'].entries;
  assert.strictEqual(warmth[warmth.length - 1], 79);
  d.report('onoff', false);
  await app._logInsights(app._now(), {});
  assert.strictEqual(actual[actual.length - 1], 0, 'alle lys av gir 0, uansett hva planen sier');
  const warmthCount = warmth.length;
  await app._logInsights(app._now(), {});
  assert.strictEqual(warmth.length, warmthCount, 'ingen faktisk varme når alle lys er av');
  // Logger av den gamle typen fjernes ved lagring
  homey.logs['g1-dim'] = { name: 'g1-dim' };
  await app._pruneInsights();
  assert.ok(!homey.logs['g1-dim'] && homey.logs['g1-plan-dim']);
  app.config.groups = [];
  await app._pruneInsights();
  assert.deepStrictEqual(homey.logs, {});
});

test('dagslys demper lysstyrken, og bare ved merkbar forskjell', async () => {
  assert.strictEqual(lib.luxFactor(20, {}), 1);
  assert.strictEqual(lib.luxFactor(5000, {}), 0.3);
  assert.ok(Math.abs(lib.luxFactor(Math.sqrt(50 * 500), {}) - 0.65) < 0.001, 'midt på log-skalaen');

  const light = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const sensor = makeDevice('s', { measure_luminance: 5000 });
  const kf = [{ time: '00:00', temp: 0.5, dim: 1 }];
  const group = { id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: kf, fadeSeconds: 0, deviceIds: ['a'], luxEnabled: true, luxSensorId: 's' };
  const { app } = await startApp({ devices: [light, sensor], groups: [group] });
  assert.strictEqual(light.writes.find((w) => w.cap === 'dim').value, 0.3, 'mye dagslys: 30 % av planen');
  const st = await app.getStatus();
  assert.strictEqual(st.groups[0].lux, 5000);
  assert.deepStrictEqual((await app.getLightSensors()).map((x) => x.id), ['s']);

  // Litt mindre lys: under 5 prosentpoeng forskjell, ingen ny skriving
  light.report('dim', 0.3); // lampen melder tilbake det appen satte
  light.writes.length = 0;
  sensor.report('measure_luminance', 450);
  app._luxReadings.s = [{ t: Date.now(), v: 450 }];
  await app._tick();
  assert.deepStrictEqual(light.writes.filter((w) => w.cap === 'dim'), [], `faktor ${lib.luxFactor(450, group)} er for nær`);
  // Mørkt: full lysstyrke
  app._luxReadings.s = [{ t: Date.now(), v: 20 }];
  await app._tick();
  assert.strictEqual(light.writes.find((w) => w.cap === 'dim').value, 1);
});

test('testfarge viser samme kelvin på alle lys og setter dem tilbake etterpå', async () => {
  const hue = makeDevice('a', { onoff: true, dim: 0.4, light_temperature: 0.9 });
  const ikea = makeDevice('b', { onoff: false, dim: 0.6, light_temperature: 0.2 });
  const { app } = await startApp({ devices: [hue, ikea], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a', 'b'] }] });
  app.config.calibration = { b: { warmK: 2200, coolK: 4000 } };
  hue.writes.length = 0;
  ikea.writes.length = 0;
  const res = await app.showTestColor('g1', 3100);
  const plan = (6500 - 3100) / 4300;
  assert.ok(Math.abs(hue.writes.find((w) => w.cap === 'light_temperature').value - plan) < 0.001);
  assert.ok(Math.abs(ikea.writes.find((w) => w.cap === 'light_temperature').value - (4000 - 3100) / 1800) < 0.001, 'IKEA-lampen får omregnet verdi');
  assert.ok(ikea.writes.some((w) => w.cap === 'onoff' && w.value === true), 'lys som er av, slås på');
  assert.deepStrictEqual(res.lights.map((l) => l.inRange), [true, true]);
  // Ingen vanlig oppdatering eller lås mens testen vises
  app._lastAppliedAt.a = 0;
  hue.report('dim', 0.2);
  assert.ok(!app.locks.a, 'testen skal ikke låse lyset');
  await wait(100); // falsk Homey: 30 s blir 20 ms
  assert.ok(ikea.writes.some((w) => w.cap === 'onoff' && w.value === false), 'lyset som var av, slås av igjen');
  assert.ok(hue.writes.some((w) => w.cap === 'light_temperature' && w.value === 0.9), 'får tilbake fargen det hadde');
  assert.strictEqual(app._testing, null);
});

test('Flow: start vekking nå, og triggere for startet og ferdig', async () => {
  const d = makeDevice('a', { onoff: false, dim: 0.5, light_temperature: 0.5 });
  const { app, homey } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Soverom', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  d.writes.length = 0;
  await homey.cards['start-wake-up'].run({ group: { id: 'g1' }, minutes: 15 });
  assert.ok(d.writes.some((w) => w.cap === 'onoff' && w.value === true));
  assert.deepStrictEqual(homey.cards['wake-up-started'].triggered, [{ room: 'Soverom' }]);
  assert.strictEqual(await homey.cards['wake-up-started'].run({ group: { id: 'g1' } }, { groupId: 'g1' }), true);
  assert.strictEqual(await homey.cards['wake-up-started'].run({ group: { id: 'g2' } }, { groupId: 'g1' }), false);
  // Ingen lys av: ferdig-triggeren kjører likevel ved vekketid
  const on = makeDevice('b', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const second = await startApp({ devices: [on], groups: [{ id: 'g2', name: 'Kjøkken', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['b'] }] });
  await second.app.startWakeUpNow('g2', 1);
  await wait(60);
  assert.deepStrictEqual(second.homey.cards['wake-up-finished'].triggered, [{ room: 'Kjøkken' }]);
});

test('historikk hentes fra appens Insights-logger', async () => {
  const d = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const { app } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }] });
  const h = await app.getHistory('g1', 'day');
  const t0 = Date.parse('2026-11-01T10:00:00.000Z');
  const t1 = Date.parse('2026-11-01T10:05:00.000Z');
  assert.deepStrictEqual(h, { range: 'day', temp: [[t0, 20]], dim: [[t0, 80], [t1, 70]], actual: [[t1, 60]], actualTemp: [[t1, 90]], lux: [] });
  assert.deepStrictEqual(await app.getHistory('ukjent', 'week'), { range: 'week', temp: [], dim: [], actual: [], actualTemp: [], lux: [] });
});

test('språkfilene har de samme tekstene, og alle som brukes finnes', () => {
  const flat = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, prefix + k + '.') : [prefix + k]));
  assert.deepStrictEqual(flat(LOCALES.no).sort(), flat(LOCALES.en).sort(), 'en.json og no.json har ulike nøkler');
  const html = fs.readFileSync(path.join(ROOT, 'settings/index.html'), 'utf8');
  const appSrc = allAppSource();
  const used = [...html.matchAll(/tr\('(settings\.[A-Za-z0-9]+)'/g), ...appSrc.matchAll(/_t(?:itles)?\('(app\.[A-Za-z0-9]+)'/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((k) => !lookup('en', k));
  assert.deepStrictEqual(missing, [], 'nøkler som brukes, men mangler i språkfilene');
  assert.ok(!/[æøå]/i.test(JSON.stringify(LOCALES.en)), 'norske bokstaver i en.json');
});

test('engelsk Homey gir engelske tekster, og røde dager kan slås av', async () => {
  const d = makeDevice('a', { onoff: false, dim: 0.5, light_temperature: 0.5 });
  const { app, homey } = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Living room', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }], lang: 'en', config: { holidays: 'none' } });
  assert.strictEqual(app.config.holidays, 'none');
  await app._updateTokens();
  assert.strictEqual(homey.tokens['g1-temp'].title, 'Living room: warmth (%)');
  const st = await app.getStatus();
  assert.strictEqual(st.groups[0].lights[0].status.text, 'Off, left alone');
  // 17. mai er ikke fridag uten norske helligdager
  assert.strictEqual(lib.isFreeDay({ year: 2026, month: 5, day: 14 }, 'none'), false);
  assert.strictEqual(lib.isFreeDay({ year: 2026, month: 5, day: 14 }, 'NO'), true);
});

test('eksisterende oppsett beholder norske røde dager, nye på norsk får dem', async () => {
  const d = makeDevice('a', { onoff: false, dim: 0.5, light_temperature: 0.5 });
  // Et oppsett fra før innstillingen fantes (har rom, men ingen "holidays")
  const old = await startApp({ devices: [d], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a'] }], lang: 'en', config: { holidays: undefined } });
  assert.strictEqual(old.app.config.holidays, 'NO');
  const fresh = await startApp({ devices: [d], groups: [], lang: 'no', config: null });
  assert.strictEqual(fresh.app.config.holidays, 'NO');
  const freshEn = await startApp({ devices: [d], groups: [], lang: 'en', config: null });
  assert.strictEqual(freshEn.app.config.holidays, 'none');
});

test('varsel i Homey: lys som mangler, sensor som er stille, lys som ikke lar seg oppdatere', async () => {
  const ok = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const broken = makeDevice('b', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  broken.setCapabilityValue = async () => { throw new Error('Timeout'); };
  const sensor = makeDevice('s', { measure_luminance: 300 });
  const { app, homey } = await startApp({
    devices: [ok, broken, sensor],
    groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, deviceIds: ['a', 'b', 'gone'], luxEnabled: true, luxSensorId: 's' }],
  });
  assert.strictEqual(homey.notices.filter((n) => n.includes('finnes ikke lenger')).length, 1, 'lyset som mangler varsles én gang');
  await app._tick();
  await app._tick();
  assert.strictEqual(homey.notices.filter((n) => n.includes('finnes ikke lenger')).length, 1, 'og ikke igjen');
  assert.strictEqual(homey.notices.filter((n) => n.includes('Lys b i Stue har ikke latt seg oppdatere 3 ganger')).length, 1, 'feilende lys etter 3 forsøk');
  // Etter en omstart huskes det som er varslet
  assert.ok(homey.settings.get('notified')['missing:gone']);

  // Sensoren har vært stille i over et døgn
  app._luxReadings.s = [{ t: Date.now() - 25 * 3600 * 1000, v: 300 }];
  assert.strictEqual(app._luxNow('s'), null, 'gammel måling brukes ikke');
  app._checkSensors();
  await wait(10); // the message is sent in the background
  assert.ok(homey.notices.some((n) => n.startsWith('Lyssensoren Lys s har ikke målt noe')));
  // Den måler igjen: problemet er løst og kan varsles på nytt senere
  sensor.report('measure_luminance', 120);
  app._checkSensors();
  assert.ok(!app._notified['sensor:s']);

  // Varsler kan skrus av
  app.config.notifyProblems = false;
  const before = homey.notices.length;
  app._notifyProblem('test', 'x');
  assert.strictEqual(homey.notices.length, before);
});

test('lås opp svarer med en gang, og bare lampen som låses opp får nye verdier', async () => {
  const locked = makeDevice('a', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const other = makeDevice('b', { onoff: true, dim: 0.5, light_temperature: 0.5 });
  const { app } = await startApp({ devices: [locked, other], groups: [{ id: 'g1', name: 'Stue', mode: 'keyframes', keyframes: KEYFRAMES, fadeSeconds: 0, deviceIds: ['a', 'b'] }], locks: { a: true } });
  assert.deepStrictEqual(locked.writes, [], 'låst lampe røres ikke');
  other.writes.length = 0;
  const t0 = Date.now();
  await app.resumeDevice('a');
  assert.ok(Date.now() - t0 < 100, 'svaret venter ikke på lampene');
  await wait(400);
  assert.ok(locked.writes.some((w) => w.cap === 'light_temperature'), 'lampen får verdier uten 3 s venting');
  assert.deepStrictEqual(other.writes, [], 'de andre lampene røres ikke');
  assert.ok(!app.locks.a);
  // Tidspunktet for siste melding fra Homey vises i status
  locked.report('dim', 0.3);
  const st = await app.getStatus();
  assert.ok(Date.now() - st.groups[0].lights[0].reportedAt < 1000);
});

test('syntaks i innstillingssiden', () => {
  const html = fs.readFileSync(path.join(ROOT, 'settings/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, 'fant ikke skriptet i settings/index.html');
  const tmp = path.join(require('os').tmpdir(), `circadian-settings-${process.pid}.js`);
  fs.writeFileSync(tmp, scripts.join('\n'));
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmp);
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FEIL ${t.name}\n     ${err.stack.split('\n').slice(0, 3).join('\n     ')}`);
    }
  }
  console.log(`\n${tests.length - failed} av ${tests.length} tester gikk gjennom.`);
  process.exit(failed ? 1 : 0);
})();
