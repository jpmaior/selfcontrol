// Unit tests for policy.js: the one place that decides whether a rule is open.
//   nix develop --command node --test
//
// The calendar caps are local-time, so the zone is pinned (see calendar.test.js).

process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import { evaluate } from "../extension/common/policy.js";
import {
  BUCKET_MS,
  bucketExpiresAt,
  commit,
  createUsage,
} from "../extension/background/accountant.js";
import { startOfNextDay, startOfNextWeek } from "../extension/common/calendar.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 10:00 local on Saturday 2026-09-19; Lisbon is UTC+1, so bucket-aligned. */
const T0 = new Date(2026, 8, 19, 10, 0).getTime();
assert.equal(T0 % BUCKET_MS, 0);

/** The same numbers accountant.test.js uses for unlockAt. */
function rule(overrides = {}) {
  return {
    id: "r",
    label: "R",
    match: ["r.com"],
    mode: "audible",
    onExceed: "block",
    budgetSec: 20 * 60,
    windowSec: 60 * 60,
    minUnlockCreditSec: 5 * 60,
    dailyBudgetSec: null,
    weeklyBudgetSec: null,
    ...overrides,
  };
}

const spent = (ms, from = T0) => commit(createUsage(), from, from + ms);

// --- rolling only: exactly what status() did before -----------------------

test("evaluate: an unspent rule is open, with the rolling remainder", () => {
  const e = evaluate(rule(), spent(3 * MIN), T0 + 3 * MIN);
  assert.equal(e.exhausted, false);
  assert.equal(e.reason, null);
  assert.equal(e.remainingMs, 17 * MIN);
  assert.equal(e.unlockAtMs, T0 + 3 * MIN, "usable now");
  assert.equal(e.caps.rolling.usedMs, 3 * MIN);
  assert.equal(e.caps.rolling.budgetMs, 20 * MIN);
  assert.equal(e.caps.daily, null);
  assert.equal(e.caps.weekly, null);
});

test("evaluate: the rolling cap alone behaves exactly like unlockAt", () => {
  const now = T0 + 20 * MIN;
  const e = evaluate(rule(), spent(20 * MIN), now);
  assert.equal(e.exhausted, true);
  assert.equal(e.reason, "rolling");
  assert.equal(e.remainingMs, 0);
  assert.equal(e.unlockAtMs, bucketExpiresAt(T0 / BUCKET_MS + 4, HOUR), "5 min of credit back");
});

test("evaluate: minUnlockCreditSec 0 is still the drip-feed, not an instant unblock", () => {
  const now = T0 + 20 * MIN;
  const e = evaluate(rule({ minUnlockCreditSec: 0 }), spent(20 * MIN), now);
  assert.equal(e.exhausted, true);
  assert.equal(e.unlockAtMs, bucketExpiresAt(T0 / BUCKET_MS, HOUR));
});

// --- daily and weekly ---------------------------------------------------

test("evaluate: a daily cap smaller than the rolling budget binds first", () => {
  const r = rule({ dailyBudgetSec: 5 * 60 });
  const open = evaluate(r, spent(3 * MIN), T0 + 3 * MIN);
  assert.equal(open.exhausted, false);
  assert.equal(open.remainingMs, 2 * MIN, "the smaller remainder wins");
  assert.equal(open.binding, "daily");
  assert.equal(open.caps.daily.usedMs, 3 * MIN);
  assert.equal(open.caps.daily.budgetMs, 5 * MIN);

  const now = T0 + 5 * MIN;
  const closed = evaluate(r, spent(5 * MIN), now);
  assert.equal(closed.exhausted, true);
  assert.equal(closed.reason, "daily");
  assert.equal(closed.remainingMs, 0);
  assert.equal(closed.unlockAtMs, startOfNextDay(now), "back at local midnight");
  assert.equal(closed.caps.rolling.exhausted, false, "the rolling meter is far from full");
});

test("evaluate: a weekly cap unlocks at the start of next Monday", () => {
  const r = rule({ weeklyBudgetSec: 5 * 60 });
  const now = T0 + 5 * MIN;
  const e = evaluate(r, spent(5 * MIN), now);
  assert.equal(e.exhausted, true);
  assert.equal(e.reason, "weekly");
  assert.equal(e.unlockAtMs, startOfNextWeek(now));
  assert.equal(new Date(e.unlockAtMs).getDay(), 1, "a Monday");
  assert.equal(e.caps.weekly.remainingMs, 0);
});

test("evaluate: weekly binds before daily when it is the smaller remainder", () => {
  const r = rule({ dailyBudgetSec: 120, weeklyBudgetSec: 60 });
  const now = T0 + MIN;
  const e = evaluate(r, spent(MIN), now);
  assert.equal(e.reason, "weekly");
  assert.equal(e.unlockAtMs, startOfNextWeek(now));
});

test("evaluate: a daily cap counts yesterday's late buckets as yesterday", () => {
  const lateLastNight = new Date(2026, 8, 18, 23, 58).getTime();
  const usage = commit(createUsage(), lateLastNight, lateLastNight + 4 * MIN);
  const now = lateLastNight + 4 * MIN; // 00:02, still all inside the rolling window
  const e = evaluate(rule({ dailyBudgetSec: 3 * 60 }), usage, now);
  assert.equal(e.caps.daily.usedMs, 2 * MIN, "only the two minutes after midnight");
  assert.equal(e.caps.rolling.usedMs, 4 * MIN, "the rolling window sees all four");
  assert.equal(e.exhausted, false);
});

test("evaluate: both rolling and daily exhausted unlocks at the later instant", () => {
  // Rolling would return within the hour; midnight is later.
  const r = rule({ dailyBudgetSec: 20 * 60 });
  const now = T0 + 20 * MIN;
  const e = evaluate(r, spent(20 * MIN), now);
  assert.equal(e.exhausted, true);
  assert.equal(e.caps.rolling.exhausted, true);
  assert.equal(e.caps.daily.exhausted, true);
  assert.equal(e.unlockAtMs, startOfNextDay(now));
  assert.equal(e.reason, "daily", "the reason names the constraint that releases last");

  // Now the other way round: 23:50, strict credit, so the rolling window
  // releases after midnight does.
  const late = new Date(2026, 8, 19, 23, 30).getTime();
  const strict = rule({ dailyBudgetSec: 20 * 60, minUnlockCreditSec: 20 * 60 });
  const e2 = evaluate(strict, spent(20 * MIN, late), late + 20 * MIN);
  assert.ok(e2.caps.rolling.unlockAtMs > startOfNextDay(late));
  assert.equal(e2.unlockAtMs, e2.caps.rolling.unlockAtMs);
  assert.equal(e2.reason, "rolling");
});

test("evaluate: a cap set to null is ignored", () => {
  const e = evaluate(rule({ dailyBudgetSec: null, weeklyBudgetSec: null }), spent(19 * MIN), T0 + 19 * MIN);
  assert.equal(e.caps.daily, null);
  assert.equal(e.caps.weekly, null);
  assert.equal(e.remainingMs, MIN);
  assert.equal(e.binding, "rolling");
});

// --- the alarm target ---------------------------------------------------

test("nextChangeAtMs: counting and open gives now + remaining", () => {
  const now = T0 + 3 * MIN;
  const e = evaluate(rule({ dailyBudgetSec: 5 * 60 }), spent(3 * MIN), now, { counting: true });
  assert.equal(e.nextChangeAtMs, now + 2 * MIN);
});

test("nextChangeAtMs: idle and open gives null", () => {
  const e = evaluate(rule(), spent(3 * MIN), T0 + 3 * MIN, { counting: false });
  assert.equal(e.nextChangeAtMs, null);
});

test("nextChangeAtMs: exhausted gives the unlock instant, counting or not", () => {
  const now = T0 + 5 * MIN;
  const r = rule({ dailyBudgetSec: 5 * 60 });
  assert.equal(evaluate(r, spent(5 * MIN), now, { counting: true }).nextChangeAtMs, startOfNextDay(now));
  assert.equal(evaluate(r, spent(5 * MIN), now).nextChangeAtMs, startOfNextDay(now));
});

test("evaluate: schedule and pass sections exist and are inert without configuration", () => {
  const e = evaluate(rule(), createUsage(), T0);
  assert.deepEqual(e.schedule, { blocked: false, untilMs: null, nextStartMs: null });
  assert.equal(e.pass.active, false);
});

// --- schedules ----------------------------------------------------------

const MON10 = new Date(2026, 8, 14, 10, 0).getTime(); // Monday 10:00
const WORK = [0, 1, 2, 3, 4].map((day) => ({ day, fromMin: 9 * 60, toMin: 18 * 60 }));

test("evaluate: a scheduled block wins over an unspent rolling cap", () => {
  const e = evaluate(rule({ schedule: WORK }), createUsage(), MON10);
  assert.equal(e.exhausted, true);
  assert.equal(e.reason, "schedule");
  assert.equal(e.unlockAtMs, new Date(2026, 8, 14, 18, 0).getTime());
  assert.equal(e.schedule.blocked, true);
  assert.equal(e.schedule.untilMs, e.unlockAtMs);
  assert.equal(e.caps.rolling.exhausted, false);
});

test("nextChangeAtMs: idle and open, the next span start; blocked, the span end", () => {
  const before = new Date(2026, 8, 14, 8, 0).getTime();
  const idle = evaluate(rule({ schedule: WORK }), createUsage(), before);
  assert.equal(idle.exhausted, false);
  assert.equal(idle.nextChangeAtMs, new Date(2026, 8, 14, 9, 0).getTime());
  assert.equal(idle.schedule.nextStartMs, idle.nextChangeAtMs);

  const blocked = evaluate(rule({ schedule: WORK }), createUsage(), MON10);
  assert.equal(blocked.nextChangeAtMs, new Date(2026, 8, 14, 18, 0).getTime());
});

test("nextChangeAtMs: counting before a span starts is the sooner of cap and span", () => {
  const before = new Date(2026, 8, 14, 8, 50).getTime();
  const e = evaluate(rule({ schedule: WORK }), spent(15 * MIN, before - 15 * MIN), before, { counting: true });
  assert.equal(e.nextChangeAtMs, before + 5 * MIN, "5 min of budget left, span in 10");
  const e2 = evaluate(rule({ schedule: WORK }), createUsage(), before, { counting: true });
  assert.equal(e2.nextChangeAtMs, new Date(2026, 8, 14, 9, 0).getTime(), "20 min left, span in 10");
});

test("evaluate: schedule and a cap both exhausted gives the later unlock", () => {
  // Blocked by schedule until 18:00, and the daily cap until midnight.
  const r = rule({ schedule: WORK, dailyBudgetSec: 5 * 60 });
  const e = evaluate(r, spent(5 * MIN, MON10 - 5 * MIN), MON10);
  assert.equal(e.reason, "daily");
  assert.equal(e.unlockAtMs, startOfNextDay(MON10));

  // Rolling exhausted, returning within the hour; the schedule holds longer.
  const e2 = evaluate(rule({ schedule: WORK }), spent(20 * MIN, MON10 - 20 * MIN), MON10);
  assert.equal(e2.reason, "schedule");
  assert.equal(e2.unlockAtMs, new Date(2026, 8, 14, 18, 0).getTime());
});
