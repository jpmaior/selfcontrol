// Local-time calendar arithmetic. PURE: no `browser.*`, no `Date.now()`.
//
// Everything here goes through `Date` getters and setters rather than adding
// multiples of 24 hours, because a local day is not always 24 hours long: the
// DST change days are 23 and 25 hours, and "tomorrow at midnight" has to mean
// the wall-clock midnight, not now + 86400000. test/calendar.test.js pins the
// Lisbon DST days for exactly that reason.
//
// The week starts on Monday (weekday 0). Not configurable in this round.

export const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, "0");

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfNextDay(ms) {
  const d = new Date(ms);
  // setHours(24) rolls to the next calendar day at 00:00 local, DST included.
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** The same wall-clock time `n` calendar days away (negative walks back). */
export function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/**
 * `YYYY-MM-DD` in local time. Sorts lexically, so "older than day X" is a
 * plain string comparison, which is what the history retention relies on.
 */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(ms) {
  return (new Date(ms).getDay() + 6) % 7;
}

export function startOfWeek(ms) {
  return addDays(startOfDay(ms), -weekday(ms));
}

export function startOfNextWeek(ms) {
  return addDays(startOfWeek(ms), 7);
}

/** Minutes since local midnight, by the wall clock. */
export function minuteOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * The instant `minute` minutes into the local day that starts at `dayStartMs`.
 * Minute 1440 is the next midnight, on a 25-hour day as much as on a 24-hour
 * one: wall-clock minutes, not elapsed ones.
 */
export function atMinute(dayStartMs, minute) {
  const d = new Date(dayStartMs);
  d.setHours(0, minute, 0, 0);
  return d.getTime();
}
