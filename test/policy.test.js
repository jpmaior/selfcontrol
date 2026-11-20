// Unit tests for policy.js: the one place that decides whether a rule is open.
//   nix develop --command node --test
//
// The calendar caps are local-time, so the zone is pinned (see calendar.test.js).

process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import { canLockIn, canUsePass, creditInUse, evaluate, lockInAmount, lockInPreview } from "../extension/common/policy.js";
import {
  BUCKET_MS,
  bucketExpiresAt,
  commit,
  createUsage,
  creditAvailableAt,
  startPass,
} from "../extension/common/accountant.js";
import { DEFAULT_WEEK, changeWeekStart, startOfNextDay, startOfNextWeek } from "../extension/common/calendar.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

test("canLockIn: while open, not while blocked", () => {
  assert.equal(canLockIn(rule(), spent(3 * MIN), T0 + 3 * MIN), true);
  assert.equal(canLockIn(rule(), spent(20 * MIN), T0 + 20 * MIN), false);
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
  assert.equal(canUsePass(withPasses(), spent(20 * MIN), now), true, "rolling spent is the whole point");
  assert.equal(canUsePass(withPasses(), spent(3 * MIN), now), true, "usable before it is spent, too");

  assert.equal(canUsePass(rule(), spent(20 * MIN), now), false, "no passes configured");
  assert.equal(canUsePass(withPasses({}, { perWeek: 0 }), spent(20 * MIN), now), false);

  const used = spent(20 * MIN);
  used.passUses = [T0, T0 + MIN];
  assert.equal(canUsePass(withPasses(), used, now), false, "allowance spent this week");

  const { u, now: later } = midPass(withPasses());
  assert.equal(canUsePass(withPasses(), u, later), false, "one already active");

  for (const countsTowardCaps of [true, false]) {
    const daily = withPasses({ dailyBudgetSec: 5 * 60 }, { countsTowardCaps });
    assert.equal(canUsePass(daily, spent(5 * MIN), T0 + 5 * MIN), false, `daily spent, counts=${countsTowardCaps}`);
    const weekly = withPasses({ weeklyBudgetSec: 5 * 60 }, { countsTowardCaps });
    assert.equal(canUsePass(weekly, spent(5 * MIN), T0 + 5 * MIN), false, `weekly spent, counts=${countsTowardCaps}`);
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

// --- what the next change is: the alarm says what it is for ---------------

test("nextChange: names what nextChangeAtMs is for", () => {
  const counting = evaluate(rule(), spent(3 * MIN), T0 + 3 * MIN, { counting: true });
  assert.equal(counting.nextChange, "rolling", "counting: the cap that runs out");

  assert.equal(evaluate(rule(), spent(3 * MIN), T0 + 3 * MIN).nextChange, null, "idle: nothing");

  const blocked = evaluate(rule(), spent(20 * MIN), T0 + 20 * MIN);
  assert.equal(blocked.nextChange, "unlock");

  const daily = evaluate(rule({ dailyBudgetSec: 5 * 60 }), spent(3 * MIN), T0 + 3 * MIN, { counting: true });
  assert.equal(daily.nextChange, "daily");
});

test("nextChange: a pass used while nothing plays wakes for the pass's end, not a cap", () => {
  // The daily cap has less left than the pass, so it is the binding one, but
  // nothing is counting: the alarm is the pass's end.
  const r = withPasses({ dailyBudgetSec: 23 * 60 }, { countsTowardCaps: true });
  const { u, now } = midPass(r, 0);
  const e = evaluate(r, u, now);
  assert.equal(e.binding, "daily");
  assert.equal(e.nextChangeAtMs, T0 + 50 * MIN);
  assert.equal(e.nextChange, "pass");

  const playing = evaluate(r, u, now, { counting: true });
  assert.equal(playing.nextChangeAtMs, now + 3 * MIN);
  assert.equal(playing.nextChange, "daily", "counting, the daily cap runs out first");
});

test("nextChange: a pass that ends before any cap runs out is the pass", () => {
  const r = withPasses();
  const { u, now } = midPass(r);
  assert.equal(evaluate(r, u, now, { counting: true }).nextChange, "pass");
  assert.equal(evaluate(r, u, now).nextChange, "pass");
});

test("nextChange: a rule blocked outright has none", () => {
  assert.equal(evaluate(rule({ budgetSec: 0 }), createUsage(), T0).nextChange, null);
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
  assert.equal(canLockIn(r, u, now), true, "lock-in stays available during a pass");
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
  assert.equal(canLockIn(rule(), heldUsage(), now), false);
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
  assert.equal(canUsePass(outright(), u, T0), false, "passes are configured, but ignored");
  assert.equal(canLockIn(outright(), u, T0), false);
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

// --- crediting use up to the instant the rule runs out (DESIGN.md §7) -------
//
// An interval is credited when it closes, and that can be late: Android freezes
// Firefox in the background and its alarms with it, and a suspended laptop
// misses them too. A rule alarm due when the budget ran out fired 50 s late on
// the emulator, and the whole interval was credited: 2:20 of a 1:30 budget, and
// the unlock moved later to match (#35). A spent rule never counts, so what
// came after the instant it ran out is not credited.

test("creditInUse: a late close credits only up to the instant the budget ran out", () => {
  const r = rule();
  const u = spent(18 * MIN);
  const late = T0 + 25 * MIN; // ran out at T0+20, closed five minutes later
  const { creditedMs, ranOutAtMs } = creditInUse(r, u, T0 + 18 * MIN, late);
  assert.equal(creditedMs, 2 * MIN);
  assert.equal(ranOutAtMs, T0 + 20 * MIN);

  const e = evaluate(r, u, late);
  assert.equal(e.caps.rolling.usedMs, 20 * MIN, "the budget, not the late time");
  assert.equal(e.exhausted, true);
  const onTime = spent(20 * MIN);
  assert.equal(e.unlockAtMs, evaluate(r, onTime, T0 + 20 * MIN).unlockAtMs, "the unlock an on-time alarm promised");
  assert.equal(u.blockedUntil, e.unlockAtMs, "and the hold recorded at that instant");
});

test("creditInUse: closed on time or before running out, the whole interval counts", () => {
  const r = rule();
  const onTime = spent(18 * MIN);
  assert.deepEqual(creditInUse(r, onTime, T0 + 18 * MIN, T0 + 20 * MIN), { creditedMs: 2 * MIN, ranOutAtMs: null });
  assert.equal(onTime.blockedUntil, null, "status() records the hold, as it always has");

  const early = spent(3 * MIN);
  assert.deepEqual(creditInUse(r, early, T0 + 3 * MIN, T0 + 10 * MIN), { creditedMs: 7 * MIN, ranOutAtMs: null });
});

test("creditInUse: the sleep clamp still applies first", () => {
  const u = createUsage();
  const { creditedMs, ranOutAtMs } = creditInUse(rule(), u, T0, T0 + 3 * HOUR, { maxChunkMs: 7.5 * MIN });
  assert.equal(creditedMs, 7.5 * MIN);
  assert.equal(ranOutAtMs, null);
  assert.equal(evaluate(rule(), u, T0 + 3 * HOUR).caps.rolling.usedMs, 7.5 * MIN);

  // Of what the clamp lets through, only what comes before running out counts.
  const nearly = commit(createUsage(), T0 + 2 * HOUR, T0 + 2 * HOUR + 18 * MIN);
  const at = T0 + 3 * HOUR;
  const r = rule({ windowSec: 2 * 60 * 60 });
  const result = creditInUse(r, nearly, T0, at, { maxChunkMs: 7.5 * MIN });
  assert.deepEqual(result, { creditedMs: 2 * MIN, ranOutAtMs: at - 7.5 * MIN + 2 * MIN });
});

test("creditInUse: time the rolling window gives back on the way counts until it runs out", () => {
  // Three minutes left at T0, and a minute from an hour ago ages out at T0+1:
  // an alarm set for T0+3 would have found a minute more and moved to T0+4.
  const r = rule({ minUnlockCreditSec: 0 });
  const u = commit(createUsage(), T0 - HOUR, T0 - HOUR + MIN);
  commit(u, T0 - 16 * MIN, T0);
  assert.equal(evaluate(r, u, T0).remainingMs, 3 * MIN);
  const { creditedMs, ranOutAtMs } = creditInUse(r, u, T0, T0 + 10 * MIN);
  assert.equal(ranOutAtMs, T0 + 4 * MIN);
  assert.equal(creditedMs, 4 * MIN);
});

test("creditInUse: nothing after running out counts, even once the rule is open again", () => {
  // The drip-feed: one minute ages out at T0+3, after the rule ran out at T0+1.
  // An on-time alarm would have put the block page up at T0+1, and the block page
  // is not the site, so the minute from T0+3 on was never going to count.
  const r = rule({ minUnlockCreditSec: 0 });
  const u = commit(createUsage(), T0 - 58 * MIN, T0 - 57 * MIN);
  commit(u, T0 - 18 * MIN, T0);
  assert.equal(evaluate(r, u, T0).remainingMs, MIN);
  const { creditedMs, ranOutAtMs } = creditInUse(r, u, T0, T0 + 5 * MIN);
  assert.equal(ranOutAtMs, T0 + MIN);
  assert.equal(creditedMs, MIN);
  assert.equal(evaluate(r, u, T0 + 5 * MIN).exhausted, false, "open again by the time it closed");
});

test("creditInUse: a daily or weekly cap running out ends the credit the same way", () => {
  const daily = rule({ dailyBudgetSec: 10 * 60 });
  const u = spent(9 * MIN);
  assert.deepEqual(creditInUse(daily, u, T0 + 9 * MIN, T0 + 15 * MIN), { creditedMs: MIN, ranOutAtMs: T0 + 10 * MIN });
  assert.equal(evaluate(daily, u, T0 + 15 * MIN).reason, "daily");
  assert.equal(u.blockedUntil, null, "the rolling cap is not what ran out, so there is no hold");

  const weekly = rule({ weeklyBudgetSec: 4 * 60 });
  const w = spent(3 * MIN);
  assert.deepEqual(creditInUse(weekly, w, T0 + 3 * MIN, T0 + 9 * MIN), { creditedMs: MIN, ranOutAtMs: T0 + 4 * MIN });
});

test("creditInUse: a pass ending mid-interval ends the credit at the pass end", () => {
  const r = withPasses();
  const { u, now } = midPass(r, 25); // the pass runs T0+20..T0+50
  const late = T0 + 55 * MIN;
  const { creditedMs, ranOutAtMs } = creditInUse(r, u, now, late);
  assert.equal(ranOutAtMs, T0 + 50 * MIN, "the rolling cap is full of pass minutes");
  assert.equal(creditedMs, 5 * MIN);
  const e = evaluate(r, u, late);
  assert.equal(e.caps.rolling.usedMs, 50 * MIN, "20 before the pass, its 30, nothing after");
  assert.equal(u.blockedUntil, e.unlockAtMs, "the hold that follows the pass");
});

test("creditInUse: says so when it stops at its step limit, rather than stopping silently", () => {
  // The limit only guards against a bug in evaluate() that would never reach
  // the end. Stopping there credits what it had and finds no instant the rule
  // ran out, so the caller must be told, or it would charge the rule as if it
  // never had (#56). The window giving time back takes three steps here.
  const r = rule({ minUnlockCreditSec: 0 });
  const u = commit(createUsage(), T0 - HOUR, T0 - HOUR + MIN);
  commit(u, T0 - 16 * MIN, T0);
  assert.deepEqual(creditInUse(r, u, T0, T0 + 10 * MIN, { maxSteps: 1 }), {
    creditedMs: 3 * MIN,
    ranOutAtMs: null,
    stoppedAtLimit: true,
  });

  const whole = commit(createUsage(), T0 - HOUR, T0 - HOUR + MIN);
  commit(whole, T0 - 16 * MIN, T0);
  assert.deepEqual(
    creditInUse(r, whole, T0, T0 + 10 * MIN, { maxSteps: 3 }),
    { creditedMs: 4 * MIN, ranOutAtMs: T0 + 4 * MIN },
    "enough steps to finish reports nothing",
  );
});

test("creditInUse: a rule spent from the start was changed under the interval, which counts whole", () => {
  // An interval only opens on a rule that is not spent, and closes at the
  // instant it runs out, so finding it spent at the start means its limits
  // changed while it was open: a settings change, whose instant is the close.
  const u = spent(20 * MIN);
  assert.deepEqual(creditInUse(rule({ budgetSec: 10 * 60 }), u, T0 + 20 * MIN, T0 + 21 * MIN), {
    creditedMs: MIN,
    ranOutAtMs: null,
  });
  assert.deepEqual(creditInUse(outright(), createUsage(), T0, T0 + 2 * MIN), { creditedMs: 2 * MIN, ranOutAtMs: null });
});

// --- the week's start day (DESIGN.md §14) ---------------------------------

const SUNDAY_WEEK = { startDay: 0, carry: null };
const SATURDAY_WEEK = { startDay: 6, carry: null };

test("evaluate: with a Sunday start, a weekly cap spent on Saturday unlocks at Sunday midnight", () => {
  // T0 is Saturday 10:00.
  const r = rule({ weeklyBudgetSec: 5 * 60 });
  const now = T0 + 5 * MIN;
  const e = evaluate(r, spent(5 * MIN), now, { week: SUNDAY_WEEK });
  assert.equal(e.exhausted, true);
  assert.equal(e.reason, "weekly");
  assert.equal(e.unlockAtMs, new Date(2026, 8, 20).getTime());
  assert.equal(new Date(e.unlockAtMs).getDay(), 0, "a Sunday");

  const sunday = evaluate(r, spent(5 * MIN), new Date(2026, 8, 20, 9).getTime(), { week: SUNDAY_WEEK });
  assert.equal(sunday.caps.weekly.usedMs, 0, "Saturday is last week's");
  assert.equal(sunday.caps.weekly.exhausted, false);
});

test("evaluate: with a Saturday start, Friday's use is last week's on Saturday", () => {
  const r = rule({ weeklyBudgetSec: 5 * 60 });
  const friday = T0 - DAY;
  const usage = spent(5 * MIN, friday);
  const onFriday = evaluate(r, usage, friday + 5 * MIN, { week: SATURDAY_WEEK });
  assert.equal(onFriday.reason, "weekly");
  assert.equal(onFriday.unlockAtMs, new Date(2026, 8, 19).getTime(), "Saturday midnight");
  assert.equal(evaluate(r, usage, T0, { week: SATURDAY_WEEK }).caps.weekly.usedMs, 0);
  assert.equal(evaluate(r, usage, T0).caps.weekly.usedMs, 5 * MIN, "the Monday week still has it");
});

test("canUsePass: the allowance is per week of the chosen start day", () => {
  const r = withPasses({}, { perWeek: 1 });
  const u = spent(20 * MIN);
  u.passUses = [T0 - DAY]; // Friday
  assert.equal(canUsePass(r, u, T0 + 20 * MIN), false, "same Monday week");
  assert.equal(canUsePass(r, u, T0 + 20 * MIN, { week: SATURDAY_WEEK }), true, "a new Saturday week");
  assert.equal(evaluate(r, u, T0 + 20 * MIN, { week: SATURDAY_WEEK }).pass.leftThisWeek, 1);
});

test("a change of start day mid-week gives back no weekly budget and no passes", () => {
  // Spent on Monday the 14th, the weekly cap and the one pass. On Thursday the
  // 17th the week is changed to start on Wednesday: the Wednesday week that
  // contains Thursday began on the 16th, after Monday's use, and would hand
  // all of it back.
  const r = rule({ weeklyBudgetSec: 30 * 60, passes: { perWeek: 1, durationSec: 30 * 60, countsTowardCaps: true } });
  const monday = new Date(2026, 8, 14, 10).getTime();
  const u = spent(30 * MIN, monday);
  u.passUses = [monday];
  const thursday = new Date(2026, 8, 17, 15).getTime();

  assert.equal(evaluate(r, u, thursday, { week: { startDay: 3, carry: null } }).exhausted, false, "the loophole");

  const week = changeWeekStart(DEFAULT_WEEK, 3, thursday);
  const e = evaluate(r, u, thursday, { week });
  assert.equal(e.exhausted, true);
  assert.equal(e.reason, "weekly");
  assert.equal(e.unlockAtMs, new Date(2026, 8, 23).getTime(), "the Wednesday after next, not Monday");
  assert.equal(e.pass.leftThisWeek, 0);

  // Past the Monday the old week would have ended on, still the same week.
  const tuesday = new Date(2026, 8, 22, 12).getTime();
  assert.equal(evaluate(r, u, tuesday, { week }).exhausted, true);
  assert.equal(canUsePass(r, u, tuesday, { week }), false);

  // From that Wednesday, weeks start on Wednesday.
  const wednesday = new Date(2026, 8, 23, 0).getTime();
  const fresh = evaluate(r, u, wednesday, { week });
  assert.equal(fresh.exhausted, false);
  assert.equal(fresh.pass.leftThisWeek, 1);
});

test("creditInUse: runs out on the chosen week's cap", () => {
  // Saturday with a Saturday start: last Friday's use does not count, so a
  // five-minute weekly cap lets five minutes through on Saturday.
  const r = rule({ weeklyBudgetSec: 5 * 60 });
  const u = spent(5 * MIN, T0 - DAY);
  const result = creditInUse(r, u, T0, T0 + 10 * MIN, { week: SATURDAY_WEEK });
  assert.equal(result.creditedMs, 5 * MIN);
  assert.equal(result.ranOutAtMs, T0 + 5 * MIN);
});
