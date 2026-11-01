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

function makeHomey() {
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
  return {
    cards,
    tokens,
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
  };
}

const KEYFRAMES = [
  { time: '00:00', temp: 0.9, dim: 0.3 },
  { time: '12:00', temp: 0.1, dim: 1 },
];

async function startApp({ devices, groups, locks }) {
  currentApi = makeApi(devices);
  const homey = makeHomey();
  homey.settings.set('config', { enabled: true, groups });
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
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const api = require(path.join(ROOT, 'api.js'));
  ['triggers', 'conditions', 'actions'].forEach((kind) => {
    (manifest.flow[kind] || []).forEach((card) => {
      assert.ok(appSrc.includes(`'${card.id}'`), `Flow-kortet ${card.id} brukes ikke i app.js`);
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
