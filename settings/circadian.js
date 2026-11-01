/*
 * The circadian maths, shared by the app (through lib/circadian.js) and the
 * settings page (loaded with <script src="circadian.js">, as window.Circadian),
 * so the clock on the settings page always shows exactly what the app does.
 * It lives in settings/ because that is the folder Homey serves to the page.
 */
(function (root) {
'use strict';

function toMinutesFromTimeString(str) {
  const [h, m] = String(str).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Converts a real point in time into "minutes since midnight" as it would
 * read on a clock in the given IANA time zone (e.g. "Europe/Oslo"). Falls
 * back to the JS runtime's own local time zone if none is given — but
 * callers should always pass the Homey's configured time zone, since the
 * runtime's own zone (inside the app's container) is not guaranteed to
 * match the zone the user set on their Homey.
 */
function zonedMinutesOfDay(date, timeZone) {
  if (!timeZone) {
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  }
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') * 60 + get('minute') + get('second') / 60;
}

/**
 * Day of the week (0 = Sunday ... 6 = Saturday) as it reads on a clock in
 * the given IANA time zone. Same fallback as zonedMinutesOfDay.
 */
function zonedWeekday(date, timeZone) {
  if (!timeZone) return date.getDay();
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/**
 * Calendar date { year, month (1-12), day } as it reads on a clock in the
 * given IANA time zone. Same fallback as zonedMinutesOfDay.
 */
function zonedDate(date, timeZone) {
  if (!timeZone) return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function addDays(d, n) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Easter Sunday of a year (Gregorian; the anonymous / Meeus algorithm). */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

/**
 * Norwegian public holidays ("røde dager"), plus Christmas Eve and New
 * Year's Eve, which most people have off too.
 */
function isNorwegianHoliday(d) {
  const md = d.month * 100 + d.day;
  if ([101, 501, 517, 1224, 1225, 1226, 1231].includes(md)) return true;
  const easter = easterSunday(d.year);
  return [-3, -2, 0, 1, 39, 49, 50].some((offset) => {
    const h = addDays(easter, offset);
    return h.month === d.month && h.day === d.day;
  });
}

/** A day off: Saturday, Sunday or a holiday. */
function isFreeDay(d) {
  const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return weekday === 0 || weekday === 6 || isNorwegianHoliday(d);
}

/** Whether today and tomorrow (on the Homey's clock) are days off. */
function freeDays(date, timeZone) {
  const today = zonedDate(date, timeZone);
  return { today: isFreeDay(today), tomorrow: isFreeDay(addDays(today, 1)) };
}

/**
 * Whether the weekend plan applies: in the morning when today is a day off,
 * and from 12:00 when tomorrow is. So it runs from Friday 12:00 to Sunday
 * 12:00, and the same around holidays, while the evening before a work day
 * stays on the weekday plan. Switching at noon, when both plans are normally
 * at their daytime values, avoids a jump.
 */
function isWeekendAt(free, nowMinutes) {
  return nowMinutes < 720 ? !!free.today : !!free.tomorrow;
}

/** The weekend rule from the day of the week alone (no holidays). */
function isWeekendPlan(weekday, nowMinutes) {
  const off = (w) => w === 0 || w === 6;
  return isWeekendAt({ today: off(weekday), tomorrow: off((weekday + 1) % 7) }, nowMinutes);
}

/*
 * Colour temperature. The plan works on one scale for every light: 0 =
 * 6500 K (coldest) .. 1 = 2200 K (warmest). Lights use the same 0..1
 * capability, but over their own range, so the same value gives different
 * colours on different brands. A light calibrated with its range
 * { warmK, coolK } gets the value that gives the plan's colour in kelvin,
 * as close as its range allows. Uncalibrated lights get the plan's value.
 */
const REF_WARM_K = 2200;
const REF_COOL_K = 6500;

function validCalibration(cal) {
  return !!cal && cal.warmK > 0 && cal.coolK > cal.warmK;
}

function planToKelvin(t) {
  return REF_COOL_K - t * (REF_COOL_K - REF_WARM_K);
}

/** Plan value (0..1) -> the light_temperature to send to this light. */
function toDeviceTemp(t, cal) {
  if (t == null || !validCalibration(cal)) return t;
  return clamp((cal.coolK - planToKelvin(t)) / (cal.coolK - cal.warmK), 0, 1);
}

/** A light's own light_temperature -> the plan's scale (for showing it). */
function fromDeviceTemp(v, cal) {
  if (v == null || !validCalibration(cal)) return v;
  const k = cal.coolK - v * (cal.coolK - cal.warmK);
  return clamp((REF_COOL_K - k) / (REF_COOL_K - REF_WARM_K), 0, 1);
}

/**
 * How much of the plan's brightness to use for the daylight a light sensor
 * measures: all of it when darker than luxDark, luxMinFactor of it when
 * brighter than luxBright, and in between along a logarithmic scale, since
 * the eye sees light that way (50 -> 500 lux feels like 500 -> 5000).
 */
function luxFactor(lux, group) {
  if (lux == null) return 1;
  const dark = Math.max(1, Number(group.luxDark) || 50);
  const bright = Math.max(dark + 1, Number(group.luxBright) || 500);
  const min = clamp(group.luxMinFactor != null ? Number(group.luxMinFactor) : 0.3, 0, 1);
  if (lux <= dark) return 1;
  if (lux >= bright) return min;
  const p = (Math.log(lux) - Math.log(dark)) / (Math.log(bright) - Math.log(dark));
  return 1 + (min - 1) * p;
}

/**
 * The { temp, dim } a group's schedule calls for (dim is null when the group
 * doesn't control brightness). sun: { sunriseMinutes, sunsetMinutes }, either
 * may be null. weekend: whether the weekend plan applies (see isWeekendAt);
 * ignored unless the group has its weekend plan switched on.
 */
function groupValues(group, nowMinutes, sun, weekend) {
  const useWeekend = !!(weekend && group.weekendEnabled);

  if (group.mode === 'keyframes') {
    const kfs = useWeekend && Array.isArray(group.weekendKeyframes) && group.weekendKeyframes.length > 0
      ? group.weekendKeyframes
      : group.keyframes;
    if (Array.isArray(kfs) && kfs.length > 0) return calculateKeyframeValues(nowMinutes, kfs);
  }

  // On weekends the group's own weekend times replace the sun / fixed times
  const common = useWeekend
    ? {
      sunriseMinutes: null,
      sunsetMinutes: null,
      wakeTime: group.weekendWakeTime || group.wakeTime,
      sleepTime: group.weekendSleepTime || group.sleepTime,
      useSunTimes: false,
    }
    : {
      sunriseMinutes: sun.sunriseMinutes,
      sunsetMinutes: sun.sunsetMinutes,
      wakeTime: group.wakeTime,
      sleepTime: group.sleepTime,
      useSunTimes: group.useSunTimes,
    };
  common.transitionMinutes = group.transitionMinutes;

  const temp = calculateCircadianValue(nowMinutes, Object.assign({}, common, {
    warmValue: group.warmValue, coolValue: group.coolValue,
  }));
  const dim = group.adjustBrightness
    ? calculateCircadianValue(nowMinutes, Object.assign({}, common, {
      warmValue: group.nightDim, coolValue: group.dayDim,
    }))
    : null;
  return { temp, dim };
}

/**
 * Returns a light_temperature capability value between 0 (coldest/cool white)
 * and 1 (warmest), for a given "now" expressed as minutes since midnight
 * (00:00 = 0, 23:59 = 1439), on the same clock the keyframes/wake/sleep
 * times are entered on.
 *
 * The value ramps smoothly around a "morning anchor" (sunrise or wakeTime)
 * and an "evening anchor" (sunset or sleepTime), each ramp lasting
 * `transitionMinutes` total (half before, half after the anchor).
 */
function calculateCircadianValue(nowMinutes, opts) {
  const {
    sunriseMinutes,
    sunsetMinutes,
    wakeTime,
    sleepTime,
    transitionMinutes = 60,
    useSunTimes = true,
    warmValue = 1,
    coolValue = 0,
  } = opts;

  const morningMin = (useSunTimes && sunriseMinutes != null) ? sunriseMinutes : toMinutesFromTimeString(wakeTime);
  const eveningMin = (useSunTimes && sunsetMinutes != null) ? sunsetMinutes : toMinutesFromTimeString(sleepTime);

  const t = Math.max(1, transitionMinutes);

  // Night: before the morning ramp starts, or after the evening ramp ends
  if (nowMinutes <= morningMin - t / 2 || nowMinutes >= eveningMin + t / 2) {
    return warmValue;
  }

  // Ramping from warm -> cool around sunrise/wake
  if (nowMinutes < morningMin + t / 2) {
    const progress = (nowMinutes - (morningMin - t / 2)) / t;
    return warmValue + (coolValue - warmValue) * clamp(progress, 0, 1);
  }

  // Ramping from cool -> warm around sunset/sleep
  if (nowMinutes > eveningMin - t / 2) {
    const progress = (nowMinutes - (eveningMin - t / 2)) / t;
    return coolValue + (warmValue - coolValue) * clamp(progress, 0, 1);
  }

  // Daytime: fully cool
  return coolValue;
}

/**
 * Interpolates a value across a circular (24h, wrapping) set of {minutes, value}
 * points. Points do not need to be sorted. With fewer than 2 points, returns
 * the single point's value (or null if there are none).
 */
function interpolateCircular(nowMinutes, points) {
  if (!points || points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.minutes - b.minutes);
  if (sorted.length === 1) return sorted[0].value;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const extended = [
    { minutes: last.minutes - 1440, value: last.value },
    ...sorted,
    { minutes: first.minutes + 1440, value: first.value },
  ];

  for (let i = 0; i < extended.length - 1; i++) {
    const a = extended[i];
    const b = extended[i + 1];
    if (nowMinutes >= a.minutes && nowMinutes <= b.minutes) {
      const span = b.minutes - a.minutes;
      const progress = span === 0 ? 0 : (nowMinutes - a.minutes) / span;
      return a.value + (b.value - a.value) * progress;
    }
  }
  return sorted[0].value;
}

/**
 * keyframes: [{ time: 'HH:mm', temp: 0..1, dim: 0..1 }, ...]
 * nowMinutes: minutes since midnight (0..1439) on the same clock the
 * keyframe times were entered on.
 * Returns { temp, dim } interpolated for that moment.
 */
function calculateKeyframeValues(nowMinutes, keyframes) {
  const tempPoints = keyframes.map((k) => ({ minutes: toMinutesFromTimeString(k.time), value: k.temp }));
  const dimPoints = keyframes.map((k) => ({ minutes: toMinutesFromTimeString(k.time), value: k.dim }));
  return {
    temp: interpolateCircular(nowMinutes, tempPoints),
    dim: interpolateCircular(nowMinutes, dimPoints),
  };
}

const api = {
  REF_COOL_K,
  REF_WARM_K,
  calculateCircadianValue,
  fromDeviceTemp,
  luxFactor,
  planToKelvin,
  toDeviceTemp,
  easterSunday,
  freeDays,
  isFreeDay,
  isNorwegianHoliday,
  isWeekendAt,
  zonedDate,
  groupValues,
  isWeekendPlan,
  zonedWeekday,
  calculateKeyframeValues,
  interpolateCircular,
  toMinutesFromTimeString,
  zonedMinutesOfDay,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Circadian = api;
}(typeof window !== 'undefined' ? window : globalThis));
