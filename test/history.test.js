// Unit tests for the history view's shaping: the per-day usage folded into
// weeks of seven local days, as the options page draws them (DESIGN.md §13).
//   nix develop --command node --test

// Days are local, so the zone is pinned (see calendar.test.js), and Lisbon has
// the DST days a week of seven local days has to survive.
process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import { historyWeeks } from "../extension/common/history.js";
import { HISTORY_DAYS } from "../extension/common/accountant.js";
import { addDays, dayKey } from "../extension/common/calendar.js";

const MIN = 60_000;
const SUNDAY = 0;
const MONDAY = 1;

const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

// Friday, 20 November 2026, mid-afternoon.
const NOW = local(2026, 11, 20, 15, 30);

const keysOf = (week) => week.days.map((day) => day.key);
const inRange = (weeks) => weeks.flatMap((week) => week.days).filter((day) => day.inRange);

test("no usage at all: no weeks, so the page can say there is nothing yet", () => {
  assert.deepEqual(historyWeeks({}, NOW), []);
  assert.deepEqual(historyWeeks({ "2026-11-20": { used: 0, pass: 0 } }, NOW), []);
});

test("usage older than the days kept is not shown", () => {
  const old = dayKey(addDays(NOW, -HISTORY_DAYS));
  assert.deepEqual(historyWeeks({ [old]: { used: 5 * MIN, pass: 0 } }, NOW), []);
});

test("a new rule used only today: this week alone, its days to come out of range", () => {
  const weeks = historyWeeks({ "2026-11-20": { used: 12 * MIN, pass: 0 } }, NOW, { startDay: MONDAY });
  assert.equal(weeks.length, 1);
  const [week] = weeks;
  assert.equal(week.startMs, local(2026, 11, 16));
  assert.deepEqual(keysOf(week), [
    "2026-11-16",
    "2026-11-17",
    "2026-11-18",
    "2026-11-19",
    "2026-11-20",
    "2026-11-21",
    "2026-11-22",
  ]);
  // Monday to Thursday are kept days with nothing in them: a zero, not a gap.
  for (const day of week.days.slice(0, 4)) {
    assert.equal(day.inRange, true);
    assert.equal(day.used, 0);
    assert.equal(day.pass, 0);
  }
  assert.equal(week.days[4].used, 12 * MIN);
  assert.equal(week.days[4].at, local(2026, 11, 20));
  // The weekend has not happened yet.
  assert.deepEqual(
    week.days.slice(5).map((day) => [day.inRange, day.used, day.pass]),
    [
      [false, 0, 0],
      [false, 0, 0],
    ],
  );
  assert.equal(week.used, 12 * MIN);
  assert.equal(week.pass, 0);
});

test("the week starts on the chosen day", () => {
  const byDay = { "2026-11-15": { used: MIN, pass: 0 }, "2026-11-20": { used: MIN, pass: 0 } };
  const weeks = historyWeeks(byDay, NOW, { startDay: SUNDAY });
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].startMs, local(2026, 11, 15));
  assert.equal(keysOf(weeks[0])[0], "2026-11-15");
  assert.equal(keysOf(weeks[0])[6], "2026-11-21");
  assert.equal(weeks[0].used, 2 * MIN);

  // The same days from a Monday: Sunday the 15th closes the week before.
  const fromMonday = historyWeeks(byDay, NOW, { startDay: MONDAY });
  assert.equal(fromMonday.length, 2);
  assert.equal(fromMonday[0].startMs, local(2026, 11, 9));
  assert.equal(fromMonday[0].used, MIN);
  assert.equal(fromMonday[1].used, MIN);
});

test("the weeks start at the first week with any use, not ninety days back", () => {
  const byDay = { "2026-11-04": { used: 3 * MIN, pass: 0 } };
  const weeks = historyWeeks(byDay, NOW, { startDay: MONDAY });
  assert.deepEqual(
    weeks.map((week) => dayKey(week.startMs)),
    ["2026-11-02", "2026-11-09", "2026-11-16"],
  );
  // A week with nothing in it between two that have use is still a row.
  assert.equal(weeks[1].used, 0);
  assert.ok(weeks[1].days.every((day) => day.inRange && day.used === 0));
});

test("ninety days of use: every kept day once, in order, in weeks of seven", () => {
  const byDay = {};
  for (let i = 0; i < HISTORY_DAYS + 10; i++) {
    byDay[dayKey(addDays(NOW, -i))] = { used: (i % 7) * MIN, pass: i % 5 === 0 ? MIN : 0 };
  }
  const weeks = historyWeeks(byDay, NOW, { startDay: MONDAY });

  assert.ok(weeks.every((week) => week.days.length === 7));
  const kept = inRange(weeks);
  assert.equal(kept.length, HISTORY_DAYS);
  assert.equal(kept[0].key, dayKey(addDays(NOW, -(HISTORY_DAYS - 1))));
  assert.equal(kept.at(-1).key, "2026-11-20");
  // Oldest first, one day apart, no day twice.
  const all = weeks.flatMap((week) => week.days.map((day) => day.key));
  assert.deepEqual([...all].sort(), all);
  assert.equal(new Set(all).size, all.length);

  // Days before the kept range sit in the first row, out of range and empty,
  // even though the ledger passed in has them.
  const first = weeks[0];
  const before = first.days.filter((day) => !day.inRange);
  assert.ok(before.length > 0);
  assert.ok(before.every((day) => day.used === 0 && day.pass === 0));

  for (const week of weeks) {
    assert.equal(week.used, week.days.reduce((total, day) => total + day.used, 0));
    assert.equal(week.pass, week.days.reduce((total, day) => total + day.pass, 0));
  }
});

test("a day reaches the daily cap by what the cap counts", () => {
  const byDay = {
    "2026-11-16": { used: 30 * MIN, pass: 0 }, // exactly the cap
    "2026-11-17": { used: 20 * MIN, pass: 15 * MIN }, // over it only with the pass
    "2026-11-18": { used: 29 * MIN, pass: 0 },
  };
  const day = (weeks, i) => weeks[0].days[i].reached;

  const counting = historyWeeks(byDay, NOW, { dailyBudgetMs: 30 * MIN, passCounts: true });
  assert.deepEqual([0, 1, 2].map((i) => day(counting, i)), [true, true, false]);

  const notCounting = historyWeeks(byDay, NOW, { dailyBudgetMs: 30 * MIN, passCounts: false });
  assert.deepEqual([0, 1, 2].map((i) => day(notCounting, i)), [true, false, false]);

  const noCap = historyWeeks(byDay, NOW, { dailyBudgetMs: null });
  assert.deepEqual([0, 1, 2].map((i) => day(noCap, i)), [false, false, false]);
});

test("a week reaches the weekly cap by what the cap counts", () => {
  const byDay = {
    "2026-11-10": { used: 40 * MIN, pass: 0 },
    "2026-11-17": { used: 30 * MIN, pass: 20 * MIN },
  };
  const counting = historyWeeks(byDay, NOW, { weeklyBudgetMs: 40 * MIN, passCounts: true });
  assert.deepEqual(counting.map((week) => week.reached), [true, true]);
  const notCounting = historyWeeks(byDay, NOW, { weeklyBudgetMs: 40 * MIN, passCounts: false });
  assert.deepEqual(notCounting.map((week) => week.reached), [true, false]);
  const noCap = historyWeeks(byDay, NOW);
  assert.deepEqual(noCap.map((week) => week.reached), [false, false]);
});

test("weeks across the DST changes are seven local days from midnight", () => {
  // Lisbon springs forward on Sunday 29 March 2026 and falls back on Sunday
  // 25 October: those weeks are 167 and 169 hours long.
  const spring = local(2026, 4, 2, 12);
  const springWeeks = historyWeeks({ "2026-03-24": { used: MIN, pass: 0 } }, spring, { startDay: MONDAY });
  assert.deepEqual(
    springWeeks.map((week) => week.startMs),
    [local(2026, 3, 23), local(2026, 3, 30)],
  );
  assert.deepEqual(keysOf(springWeeks[0]).slice(-2), ["2026-03-28", "2026-03-29"]);
  assert.ok(springWeeks[0].days.every((day) => day.at === local(...day.key.split("-").map(Number))));

  const autumn = local(2026, 10, 27, 12);
  const autumnWeeks = historyWeeks({ "2026-10-25": { used: MIN, pass: 0 } }, autumn, { startDay: MONDAY });
  assert.deepEqual(
    autumnWeeks.map((week) => week.startMs),
    [local(2026, 10, 19), local(2026, 10, 26)],
  );
  assert.equal(autumnWeeks[0].days[6].key, "2026-10-25");
  assert.equal(autumnWeeks[0].days[6].used, MIN);
});
