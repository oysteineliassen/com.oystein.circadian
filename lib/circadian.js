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
 * Whether the weekend plan applies: from Friday 12:00 to Sunday 12:00. That
 * covers Friday and Saturday evening plus Saturday and Sunday morning, while
 * Sunday evening (before a work day) stays on the weekday plan. Switching at
 * noon, when both plans are normally at their daytime values, avoids a jump.
 */
function isWeekendPlan(weekday, nowMinutes) {
  if (weekday === 6) return true;
  if (weekday === 5) return nowMinutes >= 720;
  if (weekday === 0) return nowMinutes < 720;
  return false;
}

/**
 * The { temp, dim } a group's schedule calls for (dim is null when the group
 * doesn't control brightness). sun: { sunriseMinutes, sunsetMinutes }, either
 * may be null. weekend: whether the weekend plan applies (see isWeekendPlan);
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

module.exports = {
  calculateCircadianValue,
  groupValues,
  isWeekendPlan,
  zonedWeekday,
  calculateKeyframeValues,
  interpolateCircular,
  toMinutesFromTimeString,
  zonedMinutesOfDay,
};
