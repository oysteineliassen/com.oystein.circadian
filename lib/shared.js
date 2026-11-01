'use strict';

// Constants and small helpers shared by app.js and the files in lib/.

const LOCALES = { en: require('../locales/en.json'), no: require('../locales/no.json') };

const UPDATE_INTERVAL_MS = 2 * 60 * 1000; // recompute every 2 minutes
const LOCK_GRACE_MS = 8000; // ignore device updates for this long after we write a value ourselves
const SETTLE_MS = 3000; // wait this long and re-check "off" right before writing, to catch a just-missed off event
const TURN_ON_DELAY_MS = 1000; // after a light switches on, give a flow time to pause it before we set values
const MAX_FADE_SECONDS = 5; // longer fades make lights report in-between values after LOCK_GRACE_MS
const WAKE_STEP_MS = 20000; // during a sunrise wake-up, step the lights this often
const LUX_WINDOW_MS = 10 * 60 * 1000; // average a light sensor over this long, so a passing cloud does nothing
const LUX_DIM_TOLERANCE = 0.05; // with daylight control, only change brightness by more than this
const TEST_COLOR_MS = 30000; // how long "show test colour" lasts
const SENSOR_QUIET_MS = 24 * 3600 * 1000; // a light sensor silent this long is ignored, and the user told

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_GROUP = {
  name: 'New room',
  deviceIds: [],
  enabled: true,
  mode: 'sun', // 'sun' | 'keyframes'
  // 'sun' mode settings
  useSunTimes: true,
  wakeTime: '06:30',
  sleepTime: '22:00',
  transitionMinutes: 60,
  warmValue: 1,
  coolValue: 0,
  adjustBrightness: false,
  nightDim: 0.4,
  dayDim: 1,
  // 'keyframes' mode settings
  keyframes: [], // [{ time: 'HH:mm', temp: 0..1, dim: 0..1 }]
  skipOffLights: true,
  fadeSeconds: 2, // let lights glide to new values during the regular updates
  // Weekend plan: from 12:00 the day before a weekend day or holiday, to 12:00 on it (see isWeekendAt)
  weekendEnabled: false,
  weekendWakeTime: '08:30',
  weekendSleepTime: '23:30',
  weekendKeyframes: [], // empty = use the weekday keyframes
  // Sunrise wake-up: lights that are off come on very dim and warm and
  // brighten to the plan's values at the wake time
  wakeUpEnabled: false,
  wakeUpTime: '06:30',
  wakeUpWeekendTime: '', // weekends and holidays; empty = no wake-up then
  wakeUpMinutes: 20,
  // Daylight: dim the lights when a light sensor in the room measures
  // daylight (see luxFactor)
  luxEnabled: false,
  luxSensorId: null,
  luxDark: 50,
  luxBright: 500,
  luxMinFactor: 0.3,
};

const DEFAULT_CONFIG = {
  enabled: true,
  groups: [],
  calibration: {}, // deviceId -> { warmK, coolK }, the light's colour temperature range
  notifyProblems: true, // messages in Homey's timeline when something needs attention
  holidays: 'none', // public holidays that count as days off: 'NO' (Norway) or 'none'
};

function fill(text, vars) {
  return Object.entries(vars || {}).reduce((t, [k, v]) => t.split(`{${k}}`).join(String(v)), text);
}

function makeId() {
  return 'g-' + Math.random().toString(36).slice(2, 10);
}

module.exports = {
  UPDATE_INTERVAL_MS,
  LOCK_GRACE_MS,
  SETTLE_MS,
  TURN_ON_DELAY_MS,
  MAX_FADE_SECONDS,
  WAKE_STEP_MS,
  LUX_WINDOW_MS,
  LUX_DIM_TOLERANCE,
  TEST_COLOR_MS,
  SENSOR_QUIET_MS,
  DEFAULT_GROUP,
  DEFAULT_CONFIG,
  LOCALES,
  sleep,
  fill,
  makeId,
};
