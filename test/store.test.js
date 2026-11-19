// Lifecycle tests for store.js against a stubbed `globalThis.browser`.
//   nix develop --command node --test
//
// store.js only touches browser APIs inside function bodies, so a Map-backed
// storage stub installed BEFORE the import is all it takes — no refactor.
// The stub resolves reads on the microtask queue but delays writes by a full
// macrotask, so a read issued around the write queue overtakes a queued write
// — the ordering bug is real here, not theoretical: the load() regression
// test below fails without the `await settled()` guard.

import test from "node:test";
import assert from "node:assert/strict";

// store.js logs through console; keep the TAP output readable.
console.log = () => {};
console.warn = () => {};

function makeStorageArea() {
  const data = new Map();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    data,
    async get(keys) {
      const out = {};
      // null is "everything", as in Firefox.
      for (const key of keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys]) {
        if (data.has(key)) out[key] = structuredClone(data.get(key));
      }
      return out;
    },
    async set(items) {
      await tick();
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      await tick();
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
  };
}

const local = makeStorageArea();
const session = makeStorageArea();
globalThis.browser = { storage: { local, session } };

const {
  CHECKPOINT_MS,
  MAX_CHUNK_MS,
  checkpointRule,
  flush,
  forgetRemoved,
  hasOpenInterval,
  load,
  lockInRule,
  reconcile,
  settled,
  startCounting,
  status,
  stopCounting,
  sweep,
  usePassOnRule,
} = await import("../extension/background/store.js");

const MIN = 60_000;
const T0 = 1_000_000 * MIN;

/** Distinct ids per test — the module under test keeps state across loads. */
const rule = (id) => ({ id, label: id, mode: "focus", budgetSec: 20 * 60, windowSec: 60 * 60, minUnlockCreditSec: 0 });

test("load() waits for queued writes instead of reading around them", async () => {
  const r = rule("chain");
  await load([r]);

  // Settle an interval; the flush is only ENQUEUED, not yet in storage.
  startCounting(r, T0);
  stopCounting(r, T0 + 5 * MIN);
  flush();

  // A settings save reloads immediately. Reading around the queue here would
  // rebuild the ledger from pre-flush storage and drop the 5 minutes.
  await load([r]);
  assert.equal(status(r, T0 + 5 * MIN).usedMs, 5 * MIN);
});

test("reconcile: a still-counting rule keeps its open interval untouched", async () => {
  const r = rule("live");
  await session.set({ "open:live": T0 });
  await load([r]);

  assert.equal(reconcile(r, T0 + 10 * MIN, true), 0);
  assert.ok(hasOpenInterval(r.id), "the interval survives as a legitimate resume");
});

test("reconcile: a dead interval is credited up to now", async () => {
  const r = rule("dead");
  await session.set({ "open:dead": T0 });
  await load([r]);

  // The stop is what woke the event page, so `now` is within startup latency
  // of when playback actually stopped. A 5-minute checkpoint opened this
  // interval; 2 more minutes were watched before the pause landed on an
  // unloaded page. Crediting only up to the checkpoint lost those 2 minutes —
  // a 7-minute video showed as exactly 5:00 (DESIGN.md §5, 2026-09-05).
  assert.equal(reconcile(r, T0 + 2 * MIN, false), 2 * MIN);
  assert.ok(!hasOpenInterval(r.id));
  assert.equal(status(r, T0 + 2 * MIN).usedMs, 2 * MIN);

  await settled();
  assert.ok(!session.data.has("open:dead"), "the session key is cleaned up");
});

test("reconcile: a dead interval is still clamped to 1.5 checkpoints", async () => {
  const r = rule("slept-then-paused");
  await session.set({ "open:slept-then-paused": T0 });
  await load([r]);

  // Play, unload, suspend the laptop for half an hour, resume, pause. The
  // clamp is what makes crediting up to `now` safe.
  assert.equal(reconcile(r, T0 + 30 * MIN, false), MAX_CHUNK_MS);
  assert.equal(status(r, T0 + 30 * MIN).usedMs, MAX_CHUNK_MS);
});

test("checkpoint clamps a sleep gap to 1.5 checkpoints", async () => {
  const r = rule("sleeper");
  await session.remove("open:sleeper");
  await load([r]);

  // The laptop slept for three hours mid-interval; the clamp turns that into
  // minutes, not hours (DESIGN.md §5).
  startCounting(r, T0);
  assert.equal(checkpointRule(r, T0 + 3 * 60 * MIN), 7.5 * MIN, "three hours asleep count as 7.5 minutes");
  assert.ok(hasOpenInterval(r.id), "a checkpoint folds in without closing the interval");
  assert.equal(status(r, T0 + 3 * 60 * MIN).usedMs, MAX_CHUNK_MS);
});

test("a settle that folds writes the day history with the ledger", async () => {
  const r = rule("folder");
  await load([r]);

  // Three minutes long ago, then a moment now: the old buckets have left the
  // window, so settling now folds them into their day.
  startCounting(r, T0);
  stopCounting(r, T0 + 3 * MIN);
  startCounting(r, T0 + 2 * 60 * MIN);
  stopCounting(r, T0 + 2 * 60 * MIN + MIN);
  flush();
  await settled();

  const stored = local.data.get("usage:folder");
  const folded = Object.values(stored.d).reduce((a, day) => a + day.used, 0);
  assert.equal(folded, 3 * MIN, "the expired minutes are in d");
  assert.equal(Object.keys(stored.b).length, 1, "only the live bucket is left in b");

  const s = status(r, T0 + 2 * 60 * MIN + MIN);
  assert.equal(s.usedMs, MIN, "the rolling window only sees the live minute");
  assert.equal(s.today.usedMs + s.week.usedMs >= MIN, true, "calendar totals are reported");
});

test("load() normalises a ledger stored by an older build", async () => {
  await local.set({ "usage:legacy": { b: { 5: 5 } } });
  const r = rule("legacy");
  await load([r]);
  startCounting(r, T0);
  stopCounting(r, T0 + MIN);
  flush();
  await settled();
  const stored = local.data.get("usage:legacy");
  assert.deepEqual(Object.keys(stored).sort(), ["b", "blockedUntil", "d", "p", "pass", "passUses"]);
});

test("status reports today's and this week's totals from the projection", async () => {
  const r = rule("calendar");
  await load([r]);
  startCounting(r, T0);
  const s = status(r, T0 + 2 * MIN);
  assert.equal(s.today.usedMs, 2 * MIN, "the open interval counts toward today");
  assert.equal(s.today.passMs, 0);
  assert.equal(s.week.usedMs, 2 * MIN);
});

test("lockInRule: checkpoints the open interval first, then spends the rest", async () => {
  const r = rule("locker");
  await load([r]);

  startCounting(r, T0);
  const now = T0 + 3 * MIN;
  const locked = lockInRule(r, now);

  assert.equal(locked, 17 * MIN, "what was left of the 20 minutes");
  assert.ok(!hasOpenInterval(r.id), "closed: the rule is spent, and a spent rule never counts");
  const s = status(r, now);
  assert.equal(s.usedMs, 20 * MIN, "3 counted + 17 locked, not 3 + 3 + 17");
  assert.equal(s.exhausted, true);

  // The sweep lands and the observers report the tab gone from the site.
  assert.equal(reconcile(r, now + 700, false), 0, "the sweep landing costs nothing");
  assert.equal(status(r, now + 700).usedMs, 20 * MIN);

  flush();
  await settled();
  const stored = local.data.get("usage:locker");
  const total = Object.values(stored.b).reduce((a, ms) => a + ms, 0);
  assert.equal(total, 20 * MIN, "the flushed ledger holds both");
});

test("lockInRule: nothing to spend on an exhausted rule", async () => {
  const r = rule("spent");
  await load([r]);
  // Checkpointed every 5 minutes, or the sleep clamp would cut the interval.
  startCounting(r, T0);
  for (let m = 5; m <= 20; m += 5) checkpointRule(r, T0 + m * MIN);
  stopCounting(r, T0 + 20 * MIN);
  assert.equal(status(r, T0 + 20 * MIN).exhausted, true);
  assert.equal(lockInRule(r, T0 + 20 * MIN), 0);
});

test("lockIn: a spent rule offers none, also one that ran out counting before its alarm", async () => {
  // The lockIn handler refuses what status() does not offer, so a confirm armed
  // before the rule ran out is refused rather than spending nothing (#56).
  const r = rule("lock-spent");
  await load([r]);
  startCounting(r, T0);
  for (let m = 5; m <= 15; m += 5) checkpointRule(r, T0 + m * MIN);
  assert.notEqual(status(r, T0 + 19 * MIN).lockIn, null, "a minute left: offered");
  assert.equal(status(r, T0 + 20 * MIN + 500).lockIn, null, "ran out, the alarm not in yet");
  stopCounting(r, T0 + 20 * MIN + 500);
  assert.equal(status(r, T0 + 21 * MIN).lockIn, null, "spent and settled");
});

test("usePassOnRule: checkpoints first, so the interval before the click stays in b", async () => {
  const r = { ...rule("passer"), passes: { perWeek: 1, durationSec: 10 * 60, countsTowardCaps: true } };
  await load([r]);

  startCounting(r, T0);
  const clicked = T0 + 3 * MIN;
  assert.equal(usePassOnRule(r, clicked), true);

  const s = status(r, clicked + 2 * MIN);
  assert.equal(s.pass.active, true);
  assert.equal(s.pass.endsAtMs, clicked + 10 * MIN);
  assert.equal(s.usedMs, 5 * MIN, "3 before the pass + 2 under it, in the rolling window");

  stopCounting(r, clicked + 2 * MIN);
  flush();
  await settled();
  const stored = local.data.get("usage:passer");
  const sum = (map) => Object.values(map).reduce((a, ms) => a + ms, 0);
  assert.equal(sum(stored.b), 3 * MIN, "before the click");
  assert.equal(sum(stored.p), 2 * MIN, "under the pass");
  assert.deepEqual(stored.passUses, [clicked]);
});

test("usePassOnRule: refused when the allowance is gone", async () => {
  const r = { ...rule("nopass"), passes: { perWeek: 0, durationSec: 600, countsTowardCaps: true } };
  await load([r]);
  assert.equal(usePassOnRule(r, T0), false);
});

test("flush persists ledgers through the queue", async () => {
  const r = rule("flushed");
  await load([r]);

  startCounting(r, T0);
  stopCounting(r, T0 + 3 * MIN);
  flush();
  await settled();

  const stored = local.data.get("usage:flushed");
  const total = Object.values(stored.b).reduce((a, ms) => a + ms, 0);
  assert.equal(total, 3 * MIN);
});

// --- the hold (DESIGN.md §8) ----------------------------------------------
//
// A block must outlast the first bucket that ages out, and the event page
// that saw the block land is not the one that will be asked an hour later.

/** 20 of 20 minutes spent from T0, flushed; unlock credit five minutes. */
async function spentRule(id, extra = {}) {
  const r = { ...rule(id), minUnlockCreditSec: 5 * 60, ...extra };
  await load([r]);
  startCounting(r, T0);
  // Checkpointed as a real session is: one 20-minute commit would hit the
  // sleep clamp and credit only MAX_CHUNK_MS.
  for (let at = T0 + CHECKPOINT_MS; at < T0 + 20 * MIN; at += CHECKPOINT_MS) checkpointRule(r, at);
  stopCounting(r, T0 + 20 * MIN);
  flush();
  return r;
}

/** The first bucket ages out at T0+61; five minutes are back at T0+65. */
const RELEASE = T0 + 65 * MIN;

test("hold: status records it when the block lands, and flushes it", async () => {
  const r = await spentRule("held-set");
  const s = status(r, T0 + 20 * MIN);
  assert.equal(s.exhausted, true);
  assert.equal(s.unlockAtMs, RELEASE);

  await settled();
  assert.equal(local.data.get("usage:held-set").blockedUntil, RELEASE);
});

test("hold: survives a reload and keeps the rule blocked past the first bucket", async () => {
  const r = await spentRule("held-reload");
  status(r, T0 + 20 * MIN);
  await settled();

  await load([r]); // a later event page, from storage alone
  const s = status(r, T0 + 61 * MIN + 30_000);
  assert.equal(s.exhausted, true, "one minute back is not five");
  assert.equal(s.unlockAtMs, RELEASE);
});

test("hold: cleared once the rule reopens", async () => {
  const r = await spentRule("held-clear");
  status(r, T0 + 20 * MIN);
  assert.equal(status(r, RELEASE).exhausted, false);

  await settled();
  assert.equal(local.data.get("usage:held-clear").blockedUntil, null);
});

// --- a spent rule never counts (DESIGN.md §7) -----------------------------
//
// reconcile() is how the background tells the store what the observers see.
// Going back into a blocked site reported it in use for the moment before the
// guard redirected the tab, and that moment, credited to a newer bucket than
// any spent one, moved the unlock time the block page had promised (#24).

test("spent: in use opens no interval, so going back in leaves the unlock alone", async () => {
  const r = await spentRule("reentry");
  assert.equal(status(r, T0 + 20 * MIN).unlockAtMs, RELEASE);

  // Back into the site ten minutes later; the block page loads 500 ms after.
  const back = T0 + 30 * MIN;
  assert.equal(reconcile(r, back, true), 0);
  assert.ok(!hasOpenInterval(r.id), "a spent rule does not count");
  assert.equal(reconcile(r, back + 500, false), 0, "nothing to credit when it leaves");

  const s = status(r, back + 500);
  assert.equal(s.usedMs, 20 * MIN);
  assert.equal(s.unlockAtMs, RELEASE, "the promised unlock stands");
  await settled();
  assert.equal(local.data.get("usage:reentry").blockedUntil, RELEASE);
});

test("spent: an interval open when the rule runs out closes at that instant", async () => {
  const r = { ...rule("runs-out"), minUnlockCreditSec: 5 * 60 };
  await load([r]);
  startCounting(r, T0);
  for (let at = T0 + CHECKPOINT_MS; at < T0 + 20 * MIN; at += CHECKPOINT_MS) checkpointRule(r, at);

  // The rule's alarm, at the instant the budget runs out, with the tab still on the site.
  const out = T0 + 20 * MIN;
  assert.equal(reconcile(r, out, true), 5 * MIN, "credited up to that instant");
  assert.ok(!hasOpenInterval(r.id), "and closed, though the tab is still in use");

  // The sweep lands and the observers report the tab gone from the site.
  assert.equal(reconcile(r, out + 700, false), 0, "the sweep landing costs nothing");
  const s = status(r, out + 700);
  assert.equal(s.usedMs, 20 * MIN);
  assert.equal(s.unlockAtMs, RELEASE);
});

test("spent: a tab still in use when the rule unlocks counts from that instant", async () => {
  const r = await spentRule("unlocked-in-use");
  status(r, T0 + 20 * MIN); // the block lands, and records its hold

  // The sweep never reached this tab, so the observers report it in use throughout.
  assert.equal(reconcile(r, RELEASE - 1, true), 0);
  assert.ok(!hasOpenInterval(r.id), "still spent a moment before the unlock");

  assert.equal(reconcile(r, RELEASE, true), 0);
  assert.ok(hasOpenInterval(r.id), "counting again at the unlock instant");
  assert.equal(reconcile(r, RELEASE + MIN, false), MIN, "and the minute after it is credited");
});

test("spent: a pass under a tab still in use counts from the click to the pass end", async () => {
  const passes = { perWeek: 1, durationSec: 10 * 60, countsTowardCaps: true };
  const r = await spentRule("pass-in-use", { passes });

  const click = T0 + 30 * MIN;
  assert.equal(reconcile(r, click, true), 0);
  assert.ok(!hasOpenInterval(r.id), "spent, so not counting before the pass");

  assert.equal(usePassOnRule(r, click), true);
  reconcile(r, click, true);
  assert.ok(hasOpenInterval(r.id), "the pass opened the rule, and it is in use");

  // The pass ends; its alarm finds the rolling cap spent again.
  const end = click + 10 * MIN;
  checkpointRule(r, click + 5 * MIN);
  assert.equal(reconcile(r, end, true), 5 * MIN, "credited up to the pass end");
  assert.ok(!hasOpenInterval(r.id), "and closed there");

  flush();
  await settled();
  const stored = local.data.get("usage:pass-in-use");
  assert.equal(Object.values(stored.p).reduce((a, ms) => a + ms, 0), 10 * MIN, "all of it pass time");
});

test("spent: a settings change opens or closes the interval with the new limits", async () => {
  const r = await spentRule("edited");
  const now = T0 + 30 * MIN;

  // Loosened while the tab is in use: it counts at once.
  const looser = { ...r, budgetSec: 40 * 60 };
  assert.equal(reconcile(looser, now, true), 0);
  assert.ok(hasOpenInterval(r.id), "no longer spent, so counting");

  // Tightened back a minute later: closed at that instant.
  assert.equal(reconcile(r, now + MIN, true), MIN);
  assert.ok(!hasOpenInterval(r.id), "spent again, so not counting");
});

// --- a zero budget blocks outright ------------------------------------------

test("outright: in use never opens an interval", async () => {
  const r = { ...rule("outright"), budgetSec: 0 };
  await load([r]);
  assert.equal(reconcile(r, T0, true), 0);
  assert.ok(!hasOpenInterval(r.id), "a rule with no budget never counts");

  const s = status(r, T0 + MIN);
  assert.equal(s.exhausted, true);
  assert.equal(s.reason, "always");
  assert.equal(s.unlockAtMs, null);
  assert.equal(s.nextChangeAtMs, null);
  assert.equal(s.usedMs, 0);
  assert.equal(s.budgetMs, 0);
  assert.equal(s.lockIn, null);
  assert.equal(s.passOffer, null);
});

test("outright: an interval open when the budget goes to zero closes at that instant", async () => {
  const r = rule("to-zero");
  await load([r]);
  startCounting(r, T0);
  assert.equal(reconcile({ ...r, budgetSec: 0 }, T0 + 2 * MIN, true), 2 * MIN, "credited up to the save");
  assert.ok(!hasOpenInterval(r.id), "and closed, though the tab is still on the site");
});

test("outright: no pass, whatever the rule's passes say", async () => {
  const r = { ...rule("outright-pass"), budgetSec: 0, passes: { perWeek: 3, durationSec: 600, countsTowardCaps: true } };
  await load([r]);
  assert.equal(usePassOnRule(r, T0), false);
  assert.equal(lockInRule(r, T0), 0, "and nothing to lock in");
});

test("outright: the hold is left alone, so a detour through zero does not lift it", async () => {
  const r = await spentRule("outright-hold");
  status(r, T0 + 20 * MIN); // the block lands, and records its hold
  await settled();

  // Set to zero, then back, before the cool-down is over.
  status({ ...r, budgetSec: 0 }, T0 + 30 * MIN);
  await settled();
  assert.equal(local.data.get("usage:outright-hold").blockedUntil, RELEASE, "untouched while blocking outright");

  const s = status(r, T0 + 61 * MIN + 30_000);
  assert.equal(s.exhausted, true, "one minute back is still not five");
  assert.equal(s.unlockAtMs, RELEASE);
});

// --- a late close credits up to the running out (DESIGN.md §7, #35) ---------
//
// Android freezes Firefox in the background, alarms included, and a laptop
// sleeps through them: the alarm at the instant the budget runs out can fire
// minutes late, with the tab still on the site. What came after that instant
// is time a spent rule would not have counted.

/** 15 of 20 minutes credited by checkpoints, the interval open since T0+15. */
async function runningOut(id, extra = {}) {
  const r = { ...rule(id), minUnlockCreditSec: 5 * 60, ...extra };
  await load([r]);
  startCounting(r, T0);
  for (let at = T0 + CHECKPOINT_MS; at < T0 + 20 * MIN; at += CHECKPOINT_MS) checkpointRule(r, at);
  return r;
}

test("late: an alarm that fires late credits only up to the instant the budget ran out", async () => {
  const r = await runningOut("late-alarm");

  // Due at T0+20, fired 50 s late with the tab still on the site.
  const late = T0 + 20 * MIN + 50_000;
  assert.equal(status(r, late).usedMs, 20 * MIN, "the live reading stops at the budget too");
  assert.equal(reconcile(r, late, true), 5 * MIN, "credited up to T0+20");
  assert.ok(!hasOpenInterval(r.id), "and closed");

  const s = status(r, late);
  assert.equal(s.usedMs, 20 * MIN, "charged the budget, not the late time");
  assert.equal(s.unlockAtMs, RELEASE, "the unlock an alarm on time would have set");
  flush();
  await settled();
  assert.equal(local.data.get("usage:late-alarm").blockedUntil, RELEASE);
});

test("late: a checkpoint that fires late closes the interval where the rule ran out", async () => {
  const r = await runningOut("late-checkpoint");

  // Both alarms were due while Firefox was frozen; the checkpoint fires first.
  const late = T0 + 20 * MIN + 50_000;
  assert.equal(checkpointRule(r, late), 5 * MIN, "credited up to T0+20");
  assert.ok(!hasOpenInterval(r.id), "closed: the rule is spent, and a spent rule never counts");

  // Then the rule's own alarm, with the tab still on the site.
  assert.equal(reconcile(r, late + 5, true), 0, "nothing left to credit");
  const s = status(r, late + 5);
  assert.equal(s.usedMs, 20 * MIN);
  assert.equal(s.unlockAtMs, RELEASE, "a few milliseconds in a newer bucket would have moved it");
});

test("late: a rule that ran out and came back unseen counts again from now", async () => {
  // The drip-feed: one minute from an hour ago ages out at T0+3.
  const r = rule("late-back");
  await load([r]);
  startCounting(r, T0 - 58 * MIN);
  stopCounting(r, T0 - 57 * MIN);
  startCounting(r, T0 - 18 * MIN);
  for (let at = T0 - 13 * MIN; at <= T0 - 3 * MIN; at += CHECKPOINT_MS) checkpointRule(r, at);

  // A minute left at T0, so it ran out at T0+1 and was open again from T0+3.
  // An alarm on time would have put the block page up at T0+1; this one fires at T0+4.
  const late = T0 + 4 * MIN;
  assert.equal(reconcile(r, late, true), 4 * MIN, "T0-3 to T0+1, and nothing after");
  assert.ok(hasOpenInterval(r.id), "open again and still in use, so counting");
  assert.equal(stopCounting(r, late + 30_000), 30_000, "from now, not from before it ran out");
});

// --- ... with less left than the unlock credit (#53) -------------------------
//
// The late tests above start with exactly the credit left, on the boundary of
// the hold (`remaining < credit`). With less, as on the shipped defaults (five
// minutes of budget, five of credit) after any earlier use, a reading taken
// before the settle, by reconcile() itself or by the popup, the guard or the
// alarm's sync, projected the open interval, saw the rule spent and wrote that
// block's hold onto the ledger. The settle then found the rule held at the
// interval's start, took it for a rule whose limits changed under it, and
// credited the whole interval, late time included.

/**
 * The shipped defaults, strict: five minutes of budget, five of credit. Two
 * watched from T0, a pause, then playing again from T0+3: it runs out at T0+6.
 */
async function belowCredit(id) {
  const r = { ...rule(id), budgetSec: 5 * 60, minUnlockCreditSec: 5 * 60 };
  await load([r]);
  startCounting(r, T0);
  stopCounting(r, T0 + 2 * MIN);
  startCounting(r, T0 + 3 * MIN);
  return r;
}

const RAN_OUT = T0 + 6 * MIN;
/** The last spent bucket, T0+5, ages out at T0+66: all five minutes are back. */
const RELEASE_BELOW = T0 + 66 * MIN;

test("late, below the credit: an alarm that fires late charges the budget, not the late time", async () => {
  const r = await belowCredit("below-alarm");

  // Due at T0+6, fired 50 s late with the tab still on the site.
  const late = RAN_OUT + 50_000;
  assert.equal(reconcile(r, late, true), 3 * MIN, "credited from T0+3 up to T0+6");
  assert.ok(!hasOpenInterval(r.id), "and closed");

  const s = status(r, late);
  assert.equal(s.usedMs, 5 * MIN, "charged the budget, not the late time");
  assert.equal(s.unlockAtMs, RELEASE_BELOW, "the unlock an alarm on time would have set");
  flush();
  await settled();
  assert.equal(local.data.get("usage:below-alarm").blockedUntil, RELEASE_BELOW);
});

test("late, below the credit: a reading before a late checkpoint does not change what it credits", async () => {
  const r = await belowCredit("below-checkpoint");

  // The thaw delivers a navigation, a popup poll or another rule's sync first.
  const late = RAN_OUT + 50_000;
  assert.equal(status(r, late).exhausted, true, "the reading sees the block");
  assert.equal(checkpointRule(r, late), 3 * MIN, "credited up to T0+6");
  assert.ok(!hasOpenInterval(r.id), "closed: the rule is spent");
  assert.equal(status(r, late).unlockAtMs, RELEASE_BELOW);
});

test("late, below the credit: a reading before a late stop does not change what it credits", async () => {
  const r = await belowCredit("below-stop");

  // Paused while Firefox was frozen: the report and a reading arrive at the thaw.
  const late = RAN_OUT + 50_000;
  assert.equal(status(r, late).usedMs, 5 * MIN, "the live reading stops at the budget");
  assert.equal(reconcile(r, late, false), 3 * MIN, "credited up to T0+6");
  const s = status(r, late);
  assert.equal(s.usedMs, 5 * MIN);
  assert.equal(s.unlockAtMs, RELEASE_BELOW);
});

test("on time, below the credit: the block is charged exactly the budget and records its hold", async () => {
  const r = await belowCredit("below-on-time");

  // The alarm fires a few milliseconds after the instant, as alarms do (DESIGN.md §5).
  const onTime = RAN_OUT + 3;
  assert.equal(reconcile(r, onTime, true), 3 * MIN, "nothing for the alarm's own lateness");
  assert.ok(!hasOpenInterval(r.id));
  flush();
  await settled();
  assert.equal(local.data.get("usage:below-on-time").blockedUntil, RELEASE_BELOW, "the hold is recorded");

  // Still held after the first bucket ages out at T0+61, from storage alone.
  await load([r]);
  const s = status(r, T0 + 62 * MIN);
  assert.equal(s.exhausted, true, "one minute back is not five");
  assert.equal(s.unlockAtMs, RELEASE_BELOW);
});

// --- a deleted rule's usage goes with it (DESIGN.md §6) ----------------------
//
// Last in the file: sweep() removes every key with no rule, and these tests
// share one storage stub.

/** A stored ledger with five minutes in one bucket, and an interval left open. */
function storedUsage(id) {
  local.data.set(`usage:${id}`, { b: { [T0]: 5 * MIN }, p: {}, d: {}, blockedUntil: T0 + 65 * MIN });
  session.data.set(`open:${id}`, T0 + 10 * MIN);
}

test("forgetRemoved: a rule the new set leaves out loses its usage, even one the ledger never loaded", async () => {
  // The save woke the event page, which read the new set: the deleted rule was
  // never loaded, and is known only from the old set.
  const kept = rule("removed-kept");
  const gone = rule("removed-gone");
  storedUsage(kept.id);
  storedUsage(gone.id);
  await load([kept]);

  assert.deepEqual(forgetRemoved([kept, gone], [kept]), [gone.id]);
  await settled();
  assert.ok(!local.data.has("usage:removed-gone"), "its usage is discarded");
  assert.ok(!session.data.has("open:removed-gone"), "and its open interval");
  assert.ok(local.data.has("usage:removed-kept"), "a kept rule's usage is untouched");
  assert.ok(session.data.has("open:removed-kept"), "and its open interval");
});

test("forgetRemoved: a rule in the new set is never forgotten, whichever old set names it", async () => {
  const r = rule("removed-never");
  storedUsage(r.id);
  await load([r]);

  // The old set as stored and as the page last held it, overlapping.
  assert.deepEqual(forgetRemoved([r, r], [r]), []);
  await settled();
  assert.ok(local.data.has("usage:removed-never"));
  assert.ok(session.data.has("open:removed-never"));
});

test("forgetRemoved: a new rule given a deleted rule's id starts from nothing", async () => {
  const old = rule("removed-reminted");
  storedUsage(old.id);
  await load([]);

  forgetRemoved([old], []);
  // Saved again with a rule of the same label, so the same id.
  const again = rule("removed-reminted");
  await load([again]);
  const s = status(again, T0 + 20 * MIN);
  assert.equal(s.usedMs, 0, "no history inherited");
  assert.equal(s.exhausted, false, "and no hold");
  assert.equal(hasOpenInterval(again.id), false, "and no open interval");
});

test("sweep: removes usage and open intervals that belong to no rule, and nothing else", async () => {
  // Every earlier test's ledger is an orphan here.
  await settled();
  local.data.clear();
  session.data.clear();
  const kept = rule("swept-kept");
  storedUsage(kept.id);
  storedUsage("swept-orphan");
  // A rule whose id is a prefix of the orphan's must not protect it, nor be swept by it.
  storedUsage("swept");
  const rules = [kept, rule("swept")];
  local.data.set("settings", { version: 2, rules });
  await load(rules);

  assert.deepEqual(await sweep(rules), ["swept-orphan"]);
  await settled();
  assert.ok(!local.data.has("usage:swept-orphan"));
  assert.ok(!session.data.has("open:swept-orphan"));
  for (const id of ["swept-kept", "swept"]) {
    assert.ok(local.data.has(`usage:${id}`), `${id} keeps its usage`);
    assert.ok(session.data.has(`open:${id}`), `${id} keeps its open interval`);
  }
  assert.ok(local.data.has("settings"), "keys that are not usage are left alone");
});

test("sweep: an orphan's id minted again starts from nothing", async () => {
  storedUsage("swept-reminted");
  await sweep([]);

  const again = rule("swept-reminted");
  await load([again]);
  const s = status(again, T0 + 20 * MIN);
  assert.equal(s.usedMs, 0, "no history inherited");
  assert.equal(s.exhausted, false, "and no hold");
  assert.equal(hasOpenInterval(again.id), false, "and no open interval");
});

test("sweep: with no rule at all, every rule's usage goes", async () => {
  storedUsage("swept-last");
  await sweep([]);
  await settled();
  assert.deepEqual(
    [...local.data.keys(), ...session.data.keys()].filter((key) => /^(usage|open):/.test(key)),
    [],
  );
});

test("sweep: nothing to remove writes nothing", async () => {
  const r = rule("swept-clean");
  storedUsage(r.id);
  await load([r]);
  let removes = 0;
  const { remove } = local;
  local.remove = async (keys) => {
    removes++;
    return remove(keys);
  };
  try {
    assert.deepEqual(await sweep([r]), []);
    await settled();
  } finally {
    local.remove = remove;
  }
  assert.equal(removes, 0);
});
