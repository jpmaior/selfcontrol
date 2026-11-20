// Local-time calendar arithmetic. PURE: no `browser.*`, no `Date.now()`.
//
// Everything here goes through `Date` getters and setters rather than adding
// multiples of 24 hours, because a local day is not always 24 hours long: the
// DST change days are 23 and 25 hours, and "tomorrow at midnight" has to mean
// the wall-clock midnight, not now + 86400000. test/calendar.test.js pins the
// Lisbon DST days for exactly that reason.
//
// A week starts on the day the user chose, Monday unless they chose another
// (DESIGN.md §14). Days are numbered as `Date.getDay()` numbers them, 0 for
// Sunday to 6 for Saturday, and the start day is always an argument.

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

/** Monday, as `Date.getDay()` numbers it: the start day unless one is chosen. */
export const MONDAY = 1;

/**
 * The stored week setting (`settings.week`): the start day, and the week in
 * progress when it was last changed, if that week is longer than seven days
 * (`carry`, see changeWeekStart()).
 */
export const DEFAULT_WEEK = Object.freeze({ startDay: MONDAY, carry: null });

/** Days since the week's start day: 0 on the start day itself … 6. */
export function weekday(ms, startDay = MONDAY) {
  return (new Date(ms).getDay() - startDay + 7) % 7;
}

export function startOfWeek(ms, startDay = MONDAY) {
  return addDays(startOfDay(ms), -weekday(ms, startDay));
}

export function startOfNextWeek(ms, startDay = MONDAY) {
  return addDays(startOfWeek(ms, startDay), 7);
}

/** A whole number from 0 (Sunday) to 6 (Saturday). */
export function isWeekStartDay(value) {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}

const isCarry = (carry) =>
  typeof carry === "object" &&
  carry !== null &&
  Number.isFinite(carry.from) &&
  Number.isFinite(carry.until) &&
  carry.from < carry.until;

/**
 * The week setting as stored, or Monday with no carry for anything that is not
 * one: a missing value (every install before the setting existed) or one
 * written by hand. Read-only, like withDefaults for rules.
 */
export function normalizeWeek(value) {
  if (typeof value !== "object" || value === null || !isWeekStartDay(value.startDay)) return DEFAULT_WEEK;
  return { startDay: value.startDay, carry: isCarry(value.carry) ? value.carry : null };
}

/**
 * The week that contains `ms`: `{ startMs, endMs }`. The weekly cap counts
 * from `startMs` and comes back at `endMs`; the pass allowance is per this
 * week too. A carried week, while it lasts, is the week.
 */
export function weekOf(ms, week = DEFAULT_WEEK) {
  const { startDay, carry } = week;
  if (carry && carry.from <= ms && ms < carry.until) return { startMs: carry.from, endMs: carry.until };
  return { startMs: startOfWeek(ms, startDay), endMs: startOfNextWeek(ms, startDay) };
}

/**
 * The week setting after the start day is changed to `startDay` at `nowMs`.
 *
 * A change must never hand back a weekly budget or a pass (DESIGN.md §14).
 * The week in progress keeps its start, so nothing used in it is forgotten,
 * and it runs on until the new start day comes round at least seven days
 * after it began, and after now: never a shorter week than the one it was.
 * From there the weeks start on the new day. So the week in progress can run
 * up to thirteen days, once; that is the price of a change, and changing back
 * within the same seven days costs nothing.
 *
 * The carry is kept only while it differs from the week the new day gives.
 */
export function changeWeekStart(week, startDay, nowMs) {
  if (startDay === week.startDay) return week;
  const { startMs } = weekOf(nowMs, week);
  const sevenDays = addDays(startMs, 7);
  let until = startOfWeek(sevenDays, startDay);
  if (until < sevenDays) until = addDays(until, 7);
  until = Math.max(until, startOfNextWeek(nowMs, startDay));
  const natural = weekOf(nowMs, { startDay, carry: null });
  if (natural.startMs === startMs && natural.endMs === until) return { startDay, carry: null };
  return { startDay, carry: { from: startMs, until } };
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
