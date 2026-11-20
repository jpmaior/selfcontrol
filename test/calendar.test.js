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
  DEFAULT_WEEK,
  addDays,
  atMinute,
  changeWeekStart,
  dayKey,
  isWeekStartDay,
  minuteOfDay,
  startOfDay,
  startOfNextDay,
  startOfNextWeek,
  startOfWeek,
  normalizeWeek,
  weekOf,
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
});

test("atMinute: a wall-clock minute on a given day, including 1440 as the next midnight", () => {
  const day = local(2026, 9, 19);
  assert.equal(atMinute(day, 9 * 60 + 30), local(2026, 9, 19, 9, 30));
  assert.equal(atMinute(day, 1440), local(2026, 9, 20));
  // On the 25-hour day, minute 1440 is still the next midnight, not 23:00.
  assert.equal(atMinute(local(2026, 10, 25), 1440), local(2026, 10, 26));
});

// --- the day the week starts (DESIGN.md §14) -------------------------------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

test("startOfWeek: each start day, from a Thursday afternoon", () => {
  // 2026-09-17 is a Thursday. The week that contains it starts on the latest
  // start day at or before it, at local midnight.
  const thursday = local(2026, 9, 17, 15, 30);
  const expected = {
    0: local(2026, 9, 13), // Sunday
    1: local(2026, 9, 14), // Monday
    2: local(2026, 9, 15), // Tuesday
    3: local(2026, 9, 16), // Wednesday
    4: local(2026, 9, 17), // Thursday: today itself
    5: local(2026, 9, 11), // Friday, last week
    6: local(2026, 9, 12), // Saturday, last week
  };
  for (let day = 0; day < 7; day++) {
    assert.equal(startOfWeek(thursday, day), expected[day], DAY_NAMES[day]);
    assert.equal(startOfNextWeek(thursday, day), addDays(expected[day], 7), `${DAY_NAMES[day]}, next`);
    assert.equal(new Date(startOfWeek(thursday, day)).getDay(), day, `${DAY_NAMES[day]} starts on that weekday`);
  }
});

test("startOfWeek: a start day at midnight is its own week start, a minute before is the last one", () => {
  for (let day = 0; day < 7; day++) {
    const start = startOfWeek(local(2026, 9, 17, 12), day);
    assert.equal(startOfWeek(start, day), start, DAY_NAMES[day]);
    assert.equal(startOfWeek(start - 60_000, day), addDays(start, -7), `${DAY_NAMES[day]}, a minute before`);
  }
});

test("startOfWeek: Monday is still the default", () => {
  const t = local(2026, 9, 17, 15, 30);
  assert.equal(startOfWeek(t), startOfWeek(t, 1));
  assert.equal(startOfNextWeek(t), startOfNextWeek(t, 1));
});

test("weekday: days since the week's start day", () => {
  const saturday = local(2026, 9, 19, 12);
  assert.equal(weekday(saturday, 0), 6, "Saturday is the last day of a Sunday week");
  assert.equal(weekday(saturday, 6), 0, "and the first of a Saturday week");
  assert.equal(weekday(saturday, 1), 5);
});

test("startOfWeek: a Sunday week across the spring-forward Sunday is 167 hours long", () => {
  // Lisbon moves the clocks forward on Sunday 2026-03-29.
  const t = local(2026, 3, 31, 9);
  assert.equal(startOfWeek(t, 0), local(2026, 3, 29));
  assert.equal(startOfNextWeek(t, 0) - startOfWeek(t, 0), 7 * 24 * HOUR - HOUR);
  assert.equal(startOfWeek(local(2026, 3, 28, 23, 59), 0), local(2026, 3, 22));
});

// --- the stored setting and the week in progress ----------------------------

test("normalizeWeek: Monday and no carry by default, and for anything malformed", () => {
  assert.deepEqual(DEFAULT_WEEK, { startDay: 1, carry: null });
  for (const bad of [undefined, null, 7, -1, 1.5, "0", { startDay: 9 }, { startDay: "6" }, []]) {
    assert.deepEqual(normalizeWeek(bad), DEFAULT_WEEK, JSON.stringify(bad));
  }
  assert.deepEqual(normalizeWeek({ startDay: 0 }), { startDay: 0, carry: null });
  const carry = { from: local(2026, 9, 14), until: local(2026, 9, 27) };
  assert.deepEqual(normalizeWeek({ startDay: 0, carry }), { startDay: 0, carry });
  for (const bad of [{ from: 5 }, { from: 10, until: 5 }, { from: "a", until: "b" }, 3]) {
    assert.deepEqual(normalizeWeek({ startDay: 6, carry: bad }), { startDay: 6, carry: null }, JSON.stringify(bad));
  }
});

test("isWeekStartDay: a whole number from 0 (Sunday) to 6 (Saturday)", () => {
  for (let day = 0; day < 7; day++) assert.equal(isWeekStartDay(day), true);
  for (const bad of [7, -1, 1.5, "1", null, undefined, NaN]) assert.equal(isWeekStartDay(bad), false, String(bad));
});

test("weekOf: without a carry, the week the start day gives", () => {
  const t = local(2026, 9, 17, 15, 30);
  assert.deepEqual(weekOf(t, { startDay: 0, carry: null }), { startMs: local(2026, 9, 13), endMs: local(2026, 9, 20) });
  assert.deepEqual(weekOf(t), { startMs: local(2026, 9, 14), endMs: local(2026, 9, 21) }, "Monday by default");
});

test("weekOf: a carry is the week while it lasts, and only then", () => {
  const week = { startDay: 0, carry: { from: local(2026, 9, 14), until: local(2026, 9, 27) } };
  const carried = { startMs: local(2026, 9, 14), endMs: local(2026, 9, 27) };
  assert.deepEqual(weekOf(local(2026, 9, 14), week), carried, "from its first instant");
  assert.deepEqual(weekOf(local(2026, 9, 22, 12), week), carried, "past the old Monday boundary");
  assert.deepEqual(weekOf(local(2026, 9, 26, 23, 59), week), carried, "to its last minute");
  assert.deepEqual(weekOf(local(2026, 9, 27), week), { startMs: local(2026, 9, 27), endMs: local(2026, 10, 4) }, "then Sundays");
  assert.deepEqual(weekOf(local(2026, 9, 10), week), { startMs: local(2026, 9, 6), endMs: local(2026, 9, 13) }, "before it");
});

// The rule for a change (DESIGN.md §14): the week in progress keeps its start,
// and runs on until the new start day comes round at least seven days after it
// began. Changing the setting never hands back a fresh weekly budget or passes.

test("changeWeekStart: Monday to Wednesday on a Thursday carries the week to the Wednesday after next", () => {
  const thursday = local(2026, 9, 17, 15, 30);
  const week = changeWeekStart(DEFAULT_WEEK, 3, thursday);
  assert.equal(week.startDay, 3);
  assert.deepEqual(week.carry, { from: local(2026, 9, 14), until: local(2026, 9, 23) });
  assert.deepEqual(weekOf(thursday, week), { startMs: local(2026, 9, 14), endMs: local(2026, 9, 23) });
});

test("changeWeekStart: Monday to Sunday or Saturday on a Thursday", () => {
  const thursday = local(2026, 9, 17, 15, 30);
  assert.deepEqual(changeWeekStart(DEFAULT_WEEK, 0, thursday).carry, { from: local(2026, 9, 14), until: local(2026, 9, 27) });
  assert.deepEqual(changeWeekStart(DEFAULT_WEEK, 6, thursday).carry, { from: local(2026, 9, 14), until: local(2026, 9, 26) });
});

test("changeWeekStart: the same day changes nothing", () => {
  const thursday = local(2026, 9, 17, 15, 30);
  assert.deepEqual(changeWeekStart(DEFAULT_WEEK, 1, thursday), DEFAULT_WEEK);
});

test("changeWeekStart: changing back within the week leaves no carry behind", () => {
  const thursday = local(2026, 9, 17, 15, 30);
  const there = changeWeekStart(DEFAULT_WEEK, 0, thursday);
  const back = changeWeekStart(there, 1, thursday + HOUR);
  assert.deepEqual(back, DEFAULT_WEEK);
});

test("changeWeekStart: changing back after the old boundary keeps the carried week going", () => {
  // Monday to Sunday on Thursday the 17th carries the week to Sunday the 27th.
  // Back to Monday on Tuesday the 22nd must not reset it to Monday the 21st.
  const there = changeWeekStart(DEFAULT_WEEK, 0, local(2026, 9, 17, 15, 30));
  const back = changeWeekStart(there, 1, local(2026, 9, 22, 10));
  assert.deepEqual(back.carry, { from: local(2026, 9, 14), until: local(2026, 9, 28) });
});

test("changeWeekStart: a week never starts later, never ends sooner than seven days in, never before now", () => {
  // Every pair of days, at midnight and mid-afternoon on each of three weeks
  // that take in the spring-forward Sunday, and a second change a day and a
  // half later.
  const instants = [];
  for (let d = 0; d < 21; d++) instants.push(local(2026, 3, 16 + d), local(2026, 3, 16 + d, 15, 30));
  for (const now of instants) {
    for (let a = 0; a < 7; a++) {
      const before = { startDay: a, carry: null };
      for (let b = 0; b < 7; b++) {
        const after = changeWeekStart(before, b, now);
        check(before, after, now, `${DAY_NAMES[a]} to ${DAY_NAMES[b]} at ${new Date(now).toString()}`);
        const later = now + 36 * HOUR;
        for (let c = 0; c < 7; c++) {
          const again = changeWeekStart(after, c, later);
          check(after, again, later, `then to ${DAY_NAMES[c]} at ${new Date(later).toString()}`);
        }
      }
    }
  }

  function check(before, after, now, what) {
    const was = weekOf(now, before);
    const is = weekOf(now, after);
    assert.equal(is.startMs, was.startMs, `${what}: the week in progress keeps its start`);
    assert.ok(is.endMs > now, `${what}: it has not ended`);
    assert.ok(is.endMs >= addDays(is.startMs, 7), `${what}: at least seven days long`);
    // Once it ends, the weeks follow the new start day.
    const next = weekOf(is.endMs, after);
    assert.equal(next.startMs, is.endMs, `${what}: the next week starts where it ends`);
    assert.equal(new Date(next.startMs).getDay(), after.startDay, `${what}: on the new day`);
    assert.equal(next.endMs, addDays(next.startMs, 7), `${what}: a normal week`);
  }
});
