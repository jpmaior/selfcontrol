// Unit tests for local-time calendar arithmetic.
//   nix develop --command node --test
//
// calendar.js is pure and works in local time through `Date` getters, so the
// zone is pinned here. Node re-reads TZ when process.env.TZ is assigned, and
// `node --test` runs each file in its own process, so this cannot leak.
// Europe/Lisbon is chosen because it has DST: the spring-forward day is 23
// hours long and the fall-back day 25, which is exactly what the day
// arithmetic must survive.

process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY_MS,
  addDays,
  atMinute,
  dayKey,
  minuteOfDay,
  startOfDay,
  startOfNextDay,
  startOfNextWeek,
  startOfWeek,
  weekday,
} from "../extension/common/calendar.js";

const HOUR = 3_600_000;

/** Local wall-clock time, as the extension experiences it. */
const local = (y, m, d, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s).getTime();

test("a plain day: start, next start, key, weekday, minute", () => {
  const t = local(2026, 9, 19, 12, 34, 56); // a Saturday
  assert.equal(startOfDay(t), local(2026, 9, 19));
  assert.equal(startOfNextDay(t), local(2026, 9, 20));
  assert.equal(startOfNextDay(t) - startOfDay(t), 24 * HOUR);
  assert.equal(dayKey(t), "2026-09-19");
  assert.equal(weekday(t), 5, "Saturday is 5 when Monday is 0");
  assert.equal(minuteOfDay(t), 12 * 60 + 34);
});

test("startOfDay is idempotent and the key pads single digits", () => {
  const t = local(2026, 1, 5, 23, 59);
  assert.equal(startOfDay(startOfDay(t)), startOfDay(t));
  assert.equal(dayKey(t), "2026-01-05");
});

test("weekday: Monday is 0, Sunday is 6", () => {
  assert.equal(weekday(local(2026, 9, 14)), 0, "2026-09-14 is a Monday");
  assert.equal(weekday(local(2026, 9, 20)), 6, "2026-09-20 is a Sunday");
});

test("a Sunday resolves to the previous Monday; the next week starts the day after", () => {
  const sunday = local(2026, 9, 20, 18, 0);
  assert.equal(startOfWeek(sunday), local(2026, 9, 14));
  assert.equal(startOfNextWeek(sunday), local(2026, 9, 21));

  const monday = local(2026, 9, 14, 0, 0);
  assert.equal(startOfWeek(monday), monday, "a Monday at midnight is its own week start");
  assert.equal(startOfNextWeek(monday), local(2026, 9, 21));
});

test("DST spring-forward: 2026-03-29 in Lisbon is a 23-hour day", () => {
  const t = local(2026, 3, 29, 12, 0);
  assert.equal(startOfNextDay(t) - startOfDay(t), 23 * HOUR);
  assert.equal(dayKey(t), "2026-03-29");
  // The week containing it still starts on the Monday six days earlier.
  assert.equal(startOfWeek(t), local(2026, 3, 23));
  assert.equal(dayKey(startOfWeek(t)), "2026-03-23");
});

test("DST fall-back: 2026-10-25 in Lisbon is a 25-hour day", () => {
  const t = local(2026, 10, 25, 12, 0);
  assert.equal(startOfNextDay(t) - startOfDay(t), 25 * HOUR);
  assert.equal(dayKey(t), "2026-10-25");
  // Walking a week across the change lands on a midnight, not 23:00 or 01:00.
  assert.equal(startOfNextWeek(local(2026, 10, 21)), local(2026, 10, 26));
  assert.equal(minuteOfDay(startOfNextWeek(local(2026, 10, 21))), 0);
});

test("dayKey: a bucket start one minute either side of local midnight", () => {
  assert.equal(dayKey(local(2026, 9, 19, 23, 59)), "2026-09-19");
  assert.equal(dayKey(local(2026, 9, 20, 0, 1)), "2026-09-20");
  assert.equal(dayKey(local(2026, 9, 20, 0, 0)), "2026-09-20", "midnight belongs to the new day");
});

test("addDays walks by calendar days, not by 24-hour blocks", () => {
  const before = local(2026, 3, 28, 9, 0);
  assert.equal(addDays(before, 1), local(2026, 3, 29, 9, 0), "same wall clock across DST");
  assert.equal(addDays(before, 1) - before, 23 * HOUR);
  assert.equal(addDays(before, -7), local(2026, 3, 21, 9, 0));
  assert.equal(DAY_MS, 24 * HOUR);
});

test("atMinute: a wall-clock minute on a given day, including 1440 as the next midnight", () => {
  const day = local(2026, 9, 19);
  assert.equal(atMinute(day, 9 * 60 + 30), local(2026, 9, 19, 9, 30));
  assert.equal(atMinute(day, 1440), local(2026, 9, 20));
  // On the 25-hour day, minute 1440 is still the next midnight, not 23:00.
  assert.equal(atMinute(local(2026, 10, 25), 1440), local(2026, 10, 26));
});
