// Unit tests for policy.js: the one place that decides whether a rule is open.
//   nix develop --command node --test
//
// The calendar caps are local-time, so the zone is pinned (see calendar.test.js).

process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import { canLockIn, canUsePass, evaluate, lockInAmount, lockInPreview } from "../extension/common/policy.js";
import {
  BUCKET_MS,
  bucketExpiresAt,
  commit,
  createUsage,
  creditAvailableAt,
  startPass,
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

test("evaluate: the pass section exists and is inert without configuration", () => {
  const e = evaluate(rule(), createUsage(), T0);
  assert.equal(e.pass.active, false);
});

// --- lock in ---------------------------------------------------------------

test("lockInAmount: the smallest remainder across the caps", () => {
  const now = T0 + 3 * MIN;
  assert.equal(lockInAmount(rule(), spent(3 * MIN), now), 17 * MIN, "rolling only");
  assert.equal(lockInAmount(rule({ dailyBudgetSec: 5 * 60 }), spent(3 * MIN), now), 2 * MIN, "daily binds");
  assert.equal(lockInAmount(rule({ weeklyBudgetSec: 4 * 60 }), spent(3 * MIN), now), MIN, "weekly binds");
});

test("lockInAmount: zero when already blocked", () => {
  assert.equal(lockInAmount(rule(), spent(20 * MIN), T0 + 20 * MIN), 0);
  assert.equal(lockInAmount(rule({ dailyBudgetSec: 60 }), spent(MIN), T0 + MIN), 0);
});

test("canLockIn: a reason while blocked, null while open", () => {
  assert.equal(canLockIn(rule(), spent(3 * MIN), T0 + 3 * MIN), null);
  assert.equal(typeof canLockIn(rule(), spent(20 * MIN), T0 + 20 * MIN), "string");
});

test("lockInPreview: what the popup's confirm step shows", () => {
  const now = T0 + 3 * MIN;
  const r = rule({ minUnlockCreditSec: 20 * 60 });
  const preview = lockInPreview(r, spent(3 * MIN), now);
  assert.equal(preview.ms, 17 * MIN);
  assert.equal(preview.unlockAtMs, bucketExpiresAt(T0 / BUCKET_MS + 3, HOUR), "the current bucket's expiry");

  const daily = lockInPreview(rule({ dailyBudgetSec: 5 * 60 }), spent(3 * MIN), now);
  assert.equal(daily.ms, 2 * MIN);
  assert.equal(daily.unlockAtMs, startOfNextDay(now), "locking in a daily cap holds until midnight");
  assert.equal(daily.reason, "daily");

  assert.equal(lockInPreview(rule(), spent(20 * MIN), T0 + 20 * MIN), null, "nothing to lock in");
});

// --- passes ----------------------------------------------------------------

const withPasses = (overrides = {}, passes = {}) =>
  rule({ passes: { perWeek: 2, durationSec: 30 * 60, countsTowardCaps: true, ...passes }, ...overrides });

/** Twenty minutes spent from T0, then a pass started at T0+20. */
function midPass(r, minutesIn = 5) {
  const u = spent(20 * MIN);
  startPass(u, r, T0 + 20 * MIN);
  const now = T0 + 20 * MIN + minutesIn * MIN;
  commit(u, T0 + 20 * MIN, now, { pass: u.pass });
  return { u, now };
}

test("canUsePass: refusals, and the rolling cap is not one of them", () => {
  const now = T0 + 20 * MIN;
  assert.equal(canUsePass(withPasses(), spent(20 * MIN), now), null, "rolling spent is the whole point");
  assert.equal(canUsePass(withPasses(), spent(3 * MIN), now), null, "usable before it is spent, too");

  assert.equal(typeof canUsePass(rule(), spent(20 * MIN), now), "string", "no passes configured");
  assert.equal(typeof canUsePass(withPasses({}, { perWeek: 0 }), spent(20 * MIN), now), "string");

  const used = spent(20 * MIN);
  used.passUses = [T0, T0 + MIN];
  assert.equal(typeof canUsePass(withPasses(), used, now), "string", "allowance spent this week");

  const { u, now: later } = midPass(withPasses());
  assert.equal(typeof canUsePass(withPasses(), u, later), "string", "one already active");

  for (const countsTowardCaps of [true, false]) {
    const daily = withPasses({ dailyBudgetSec: 5 * 60 }, { countsTowardCaps });
    assert.equal(typeof canUsePass(daily, spent(5 * MIN), T0 + 5 * MIN), "string", `daily spent, counts=${countsTowardCaps}`);
    const weekly = withPasses({ weeklyBudgetSec: 5 * 60 }, { countsTowardCaps });
    assert.equal(typeof canUsePass(weekly, spent(5 * MIN), T0 + 5 * MIN), "string", `weekly spent, counts=${countsTowardCaps}`);
  }
});

test("evaluate during a pass: open while only the rolling cap is spent", () => {
  const r = withPasses();
  const { u, now } = midPass(r);
  const e = evaluate(r, u, now, { counting: true });
  assert.equal(e.exhausted, false);
  assert.equal(e.reason, null);
  assert.equal(e.caps.rolling.exhausted, true, "the rolling cap is spent underneath");
  assert.equal(e.pass.active, true);
  assert.equal(e.pass.endsAtMs, T0 + 50 * MIN);
  assert.equal(e.pass.leftThisWeek, 1);
  assert.equal(e.nextChangeAtMs, T0 + 50 * MIN, "the pass end");
});

test("evaluate during a pass: the daily cap can fill mid-pass when the pass counts", () => {
  const r = withPasses({ dailyBudgetSec: 23 * 60 }, { countsTowardCaps: true });
  const { u, now } = midPass(r, 2);
  const open = evaluate(r, u, now, { counting: true });
  assert.equal(open.exhausted, false);
  assert.equal(open.caps.daily.usedMs, 22 * MIN, "pass minutes count");
  assert.equal(open.nextChangeAtMs, now + MIN, "the daily cap runs out before the pass ends");

  const { u: u2, now: now2 } = midPass(r, 3);
  const closed = evaluate(r, u2, now2, { counting: true });
  assert.equal(closed.exhausted, true);
  assert.equal(closed.reason, "daily");
  assert.equal(closed.unlockAtMs, startOfNextDay(now2));
});

test("evaluate during a pass: with countsTowardCaps false the daily cap does not move", () => {
  const r = withPasses({ dailyBudgetSec: 23 * 60 }, { countsTowardCaps: false });
  const { u, now } = midPass(r, 5);
  const e = evaluate(r, u, now, { counting: true });
  assert.equal(e.exhausted, false);
  assert.equal(e.caps.daily.usedMs, 20 * MIN, "only the pre-pass minutes");
  assert.equal(e.caps.rolling.usedMs, 25 * MIN, "the rolling window sees the pass time");
  assert.equal(e.nextChangeAtMs, T0 + 50 * MIN, "the pass end, not a cap");
});

test("evaluate just after the pass: the rolling cap is spent by the pass buckets", () => {
  const r = withPasses();
  const u = spent(20 * MIN);
  startPass(u, r, T0 + 20 * MIN);
  commit(u, T0 + 20 * MIN, T0 + 50 * MIN, { pass: u.pass });
  const now = T0 + 50 * MIN;

  const e = evaluate(r, u, now);
  assert.equal(e.pass.active, false);
  assert.equal(e.exhausted, true);
  assert.equal(e.reason, "rolling");
  // 5 min of credit needs the first five buckets from T0 gone, exactly as
  // creditAvailableAt over b and p says.
  assert.equal(e.unlockAtMs, creditAvailableAt(u, now, { budgetMs: 20 * MIN, windowMs: HOUR }, 5 * MIN));
  assert.ok(e.unlockAtMs > now);
});

test("lockInPreview during a pass: ends it and spends what the rolling cap has left", () => {
  const r = withPasses({ minUnlockCreditSec: 20 * 60 });
  const { u, now } = midPass(r);
  assert.equal(canLockIn(r, u, now), null, "lock-in stays available during a pass");
  const preview = lockInPreview(r, u, now);
  assert.equal(preview.ms, 0, "the rolling cap is already full");
  assert.equal(preview.reason, "rolling");
  assert.ok(preview.unlockAtMs > now, "blocked once the pass is ended");
});

// --- the hold: once blocked, stay blocked (DESIGN.md §8) ------------------
//
// rule() spends 20 minutes from T0. usedMs keeps a bucket until it expires, so
// the first one ages out at T0+61 and frees one minute; the fifth, at T0+65,
// brings back the five minutes minUnlockCreditSec asks for. Without a hold,
// the first freed minute reopened the rule: the drip-feed §8 exists to stop.

const HELD_UNTIL = T0 + 65 * MIN;

/** What the store leaves in the ledger once the block has landed. */
function heldUsage() {
  const u = spent(20 * MIN);
  u.blockedUntil = HELD_UNTIL;
  return u;
}

test("hold: the unlock instant at the block is the one the hold records", () => {
  const e = evaluate(rule(), spent(20 * MIN), T0 + 20 * MIN);
  assert.equal(e.unlockAtMs, HELD_UNTIL);
});

test("hold: a blocked rule stays blocked when its first bucket ages out", () => {
  const now = T0 + 61 * MIN + 30_000;
  const e = evaluate(rule(), heldUsage(), now);
  assert.equal(e.caps.rolling.remainingMs, MIN, "one minute is back");
  assert.equal(e.exhausted, true, "the rule asks for five");
  assert.equal(e.reason, "rolling");
  assert.equal(e.remainingMs, 0);
  assert.equal(e.unlockAtMs, HELD_UNTIL, "the instant the block page promised");
  assert.equal(e.nextChangeAtMs, HELD_UNTIL);
});

test("hold: released once the unlock credit is back", () => {
  const e = evaluate(rule(), heldUsage(), HELD_UNTIL);
  assert.equal(e.exhausted, false);
  assert.equal(e.remainingMs, 5 * MIN);
});

test("hold: short of the unlock credit but never blocked is still open", () => {
  // 17 of 20 minutes used: 3 left, less than the 5 minUnlockCreditSec names,
  // and no block ever landed. Only a block that landed holds.
  const e = evaluate(rule(), spent(17 * MIN), T0 + 17 * MIN);
  assert.equal(e.exhausted, false);
  assert.equal(e.remainingMs, 3 * MIN);
});

test("hold: one that has run out does nothing", () => {
  const u = spent(17 * MIN);
  u.blockedUntil = T0 + 17 * MIN;
  assert.equal(evaluate(rule(), u, T0 + 17 * MIN).exhausted, false);
});

test("hold: yields as soon as the rule's own unlock credit is back", () => {
  // The rule was loosened after the block landed: one minute is now enough.
  const e = evaluate(rule({ minUnlockCreditSec: 60 }), heldUsage(), T0 + 61 * MIN);
  assert.equal(e.exhausted, false);
  assert.equal(e.remainingMs, MIN);
});

test("hold: minUnlockCreditSec 0 is still the drip-feed", () => {
  const e = evaluate(rule({ minUnlockCreditSec: 0 }), heldUsage(), T0 + 61 * MIN);
  assert.equal(e.exhausted, false);
  assert.equal(e.remainingMs, MIN);
});

test("hold: a pass suspends it like the rest of the rolling cap", () => {
  const r = withPasses();
  const u = heldUsage();
  startPass(u, r, T0 + 61 * MIN);
  const e = evaluate(r, u, T0 + 62 * MIN, { counting: true });
  assert.equal(e.exhausted, false);
  assert.equal(e.pass.active, true);
  assert.equal(e.caps.rolling.exhausted, true, "still held underneath");
});

test("hold: lock-in is refused while held, like any block", () => {
  const now = T0 + 61 * MIN;
  assert.equal(lockInAmount(rule(), heldUsage(), now), 0);
  assert.equal(typeof canLockIn(rule(), heldUsage(), now), "string");
});

// --- a zero budget blocks outright -----------------------------------------
//
// Spent from the start, never counting, never unlocking on its own: the rule
// has no time to give back, so there is no instant to count down to and no
// alarm to set. Everything else the rule carries is ignored.

const outright = (overrides = {}) => withPasses({ budgetSec: 0, ...overrides });

test("evaluate: a zero budget is spent from the start and never unlocks", () => {
  for (const counting of [false, true]) {
    const e = evaluate(outright(), createUsage(), T0, { counting });
    assert.equal(e.exhausted, true, `counting=${counting}`);
    assert.equal(e.reason, "always");
    assert.equal(e.remainingMs, 0);
    assert.equal(e.unlockAtMs, null, "no instant to count down to");
    assert.equal(e.nextChangeAtMs, null, "and nothing to wake up for");
    assert.equal(e.binding, null);
  }
});

test("evaluate: a zero budget ignores the caps, and they report nothing", () => {
  // The daily cap would otherwise be the binding one and unlock at midnight.
  const e = evaluate(outright({ dailyBudgetSec: 5 * 60, weeklyBudgetSec: 60 * 60 }), spent(3 * MIN), T0 + 3 * MIN);
  assert.equal(e.reason, "always");
  assert.equal(e.unlockAtMs, null);
  assert.deepEqual(e.caps, { rolling: null, daily: null, weekly: null });
});

test("evaluate: a zero budget ignores a pass that is still running", () => {
  // Used before the budget was set to zero: the rule still blocks, and the pass
  // has nothing to wake up for at its end.
  const r = withPasses();
  const { u, now } = midPass(r);
  const e = evaluate({ ...r, budgetSec: 0 }, u, now, { counting: true });
  assert.equal(e.exhausted, true);
  assert.equal(e.reason, "always");
  assert.equal(e.nextChangeAtMs, null);
  assert.deepEqual(e.pass, { active: false, endsAtMs: null, leftThisWeek: 0 });
});

test("a zero budget offers no pass and no lock-in", () => {
  const u = createUsage();
  assert.equal(typeof canUsePass(outright(), u, T0), "string", "passes are configured, but ignored");
  assert.equal(typeof canLockIn(outright(), u, T0), "string");
  assert.equal(lockInAmount(outright(), u, T0), 0);
  assert.equal(lockInPreview(outright(), u, T0), null);
});

test("evaluate: raising a zero budget back counts the ledger as it stands", () => {
  // Nothing accrued while it blocked outright, so what was used before is
  // what counts once it has a budget again.
  const u = spent(3 * MIN);
  assert.equal(evaluate(outright(), u, T0 + 3 * MIN).exhausted, true);
  const e = evaluate(rule(), u, T0 + 3 * MIN);
  assert.equal(e.exhausted, false);
  assert.equal(e.remainingMs, 17 * MIN);
});
