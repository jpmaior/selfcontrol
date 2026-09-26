// Unit tests for the pure rolling-window arithmetic.
//   nix develop --command node --test
//
// No browser, no mocking: accountant.js takes the clock as an argument, so
// every case here is plain data in, plain data out.

// Folding is keyed by local day, so the zone is pinned (see calendar.test.js).
process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import {
  BUCKET_MS,
  HISTORY_DAYS,
  bucketOf,
  bucketExpiresAt,
  commit,
  createUsage,
  creditAvailableAt,
  fold,
  normalizeUsage,
  prune,
  remainingMs,
  unlockAt,
  usedByDay,
  usedInPeriod,
  usedMs,
} from "../extension/background/accountant.js";
import { addDays, dayKey, startOfDay } from "../extension/common/calendar.js";

/** Bucket 1000 starts here; using a round bucket keeps the arithmetic readable. */
const T0 = 1000 * BUCKET_MS;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Window params, as the low-level pure functions take them. */
const RULE = { budgetMs: 20 * MIN, windowMs: HOUR };

/** The same limits as an authored rule, in seconds, as unlockAt takes them. */
const SEC_RULE = { budgetSec: 20 * 60, windowSec: 60 * 60, minUnlockCreditSec: 5 * 60 };

test("commit: interval inside a single bucket", () => {
  const u = commit(createUsage(), T0 + 10_000, T0 + 40_000);
  assert.deepEqual(u.b, { 1000: 30_000 });
});

test("commit: interval spanning several buckets splits proportionally", () => {
  // 30s into bucket 1000, through all of 1001, 15s into 1002.
  const u = commit(createUsage(), T0 + 30_000, T0 + 2 * BUCKET_MS + 15_000);
  assert.deepEqual(u.b, { 1000: 30_000, 1001: 60_000, 1002: 15_000 });
  assert.equal(total(u), 105_000);
});

test("commit: an interval ending exactly on a boundary makes no empty bucket", () => {
  const u = commit(createUsage(), T0, T0 + BUCKET_MS);
  assert.deepEqual(u.b, { 1000: 60_000 });
});

test("commit: exactly one full bucket, offset from the boundary", () => {
  const u = commit(createUsage(), T0 + 30_000, T0 + 90_000);
  assert.deepEqual(u.b, { 1000: 30_000, 1001: 30_000 });
});

test("commit: accumulates into existing buckets", () => {
  const u = createUsage();
  commit(u, T0, T0 + 10_000);
  commit(u, T0 + 20_000, T0 + 25_000);
  assert.deepEqual(u.b, { 1000: 15_000 });
});

test("commit: zero-length and backwards intervals are no-ops", () => {
  const u = createUsage();
  commit(u, T0, T0);
  commit(u, T0 + 5000, T0);
  commit(u, NaN, T0);
  assert.deepEqual(u.b, {});
});

test("commit: the sleep clamp credits recent time, not the whole suspend", () => {
  // Machine suspended for three hours with an interval left open.
  const u = commit(createUsage(), T0, T0 + 3 * HOUR, { maxChunkMs: 7.5 * MIN });

  assert.equal(total(u), 7.5 * MIN, "only the clamp window is credited");

  // ...and it lands next to the wake-up, not back at the stale start.
  const wake = T0 + 3 * HOUR;
  const earliest = Math.min(...Object.keys(u.b).map(Number));
  assert.ok(
    earliest >= bucketOf(wake - 7.5 * MIN),
    "clamped time is credited near the end of the interval",
  );
  assert.equal(u.b[1000], undefined, "nothing is credited at the stale start");
});

test("usedMs: only buckets inside the window count", () => {
  const u = createUsage();
  commit(u, T0, T0 + 5 * MIN); // 5 min at T0
  const now = T0 + HOUR + 30 * MIN; // 90 min later — long gone

  assert.equal(usedMs(u, T0 + 10 * MIN, HOUR), 5 * MIN, "inside the window");
  assert.equal(usedMs(u, now, HOUR), 0, "outside the window");
});

test("usedMs: the boundary bucket is counted whole (deliberately strict)", () => {
  const u = commit(createUsage(), T0, T0 + BUCKET_MS); // all of bucket 1000

  // now is exactly one window after the *end* of bucket 1000, so the bucket is
  // on the edge: still included, counted in full.
  const now = T0 + BUCKET_MS + HOUR - 1;
  assert.equal(usedMs(u, now, HOUR), BUCKET_MS);

  // One millisecond later it drops out entirely.
  assert.equal(usedMs(u, now + 1, HOUR), 0);
});

test("prune: drops expired buckets and keeps live ones", () => {
  const u = createUsage();
  commit(u, T0, T0 + MIN); // bucket 1000
  commit(u, T0 + 30 * MIN, T0 + 31 * MIN); // bucket 1030
  commit(u, T0 + 59 * MIN, T0 + 60 * MIN); // bucket 1059

  prune(u, T0 + 61 * MIN, HOUR);

  assert.equal(u.b[1000], undefined, "expired bucket removed");
  assert.equal(u.b[1030], MIN, "live bucket kept");
  assert.equal(u.b[1059], MIN, "live bucket kept");
});

test("prune: does not change what usedMs reports", () => {
  const u = createUsage();
  commit(u, T0, T0 + MIN);
  commit(u, T0 + 45 * MIN, T0 + 50 * MIN);
  const now = T0 + 70 * MIN;

  const before = usedMs(u, now, HOUR);
  prune(u, now, HOUR);
  assert.equal(usedMs(u, now, HOUR), before);
});

test("remainingMs: never goes negative", () => {
  const u = commit(createUsage(), T0, T0 + 90 * MIN); // way over a 20 min budget
  assert.equal(remainingMs(u, T0 + 90 * MIN, RULE), 0);
});

test("creditAvailableAt: returns now when credit already exists", () => {
  const u = commit(createUsage(), T0, T0 + 5 * MIN);
  const now = T0 + 5 * MIN;
  assert.equal(creditAvailableAt(u, now, RULE, 5 * MIN), now);
});

test("creditAvailableAt: waits for the oldest bucket to expire", () => {
  // Burn the full 20 min budget across buckets 1000..1019.
  const u = commit(createUsage(), T0, T0 + 20 * MIN);
  const now = T0 + 20 * MIN;

  assert.equal(remainingMs(u, now, RULE), 0, "budget is spent");

  // One minute of credit arrives when bucket 1000 leaves the window.
  assert.equal(creditAvailableAt(u, now, RULE, MIN), bucketExpiresAt(1000, HOUR));

  // Five minutes of credit needs buckets 1000..1004 gone.
  assert.equal(creditAvailableAt(u, now, RULE, 5 * MIN), bucketExpiresAt(1004, HOUR));
});

test("creditAvailableAt: asking for zero credit is trivially satisfied now", () => {
  // Degenerate but mathematically correct, and exactly why unlockAt exists:
  // a rule must never pass minUnlockCreditSec: 0 straight through, or it would
  // unblock the instant it blocked.
  const u = commit(createUsage(), T0, T0 + 20 * MIN);
  const now = T0 + 20 * MIN;
  assert.equal(creditAvailableAt(u, now, RULE, 0), now);
});

test("unlockAt: minUnlockCreditSec 0 gives the drip-feed, not an instant unblock", () => {
  // The behaviour DESIGN.md §8 deliberately keeps available.
  const u = commit(createUsage(), T0, T0 + 20 * MIN);
  const now = T0 + 20 * MIN;

  const drip = unlockAt(u, now, { ...SEC_RULE, minUnlockCreditSec: 0 });

  assert.ok(drip > now, "still blocked right now — this is the bug the test caught");
  assert.equal(drip, bucketExpiresAt(1000, HOUR), "unlocks when the first bucket expires");
});

test("unlockAt: a 5 min credit unlocks strictly later than the drip", () => {
  const u = commit(createUsage(), T0, T0 + 20 * MIN);
  const now = T0 + 20 * MIN;

  const drip = unlockAt(u, now, { ...SEC_RULE, minUnlockCreditSec: 0 });
  const chunked = unlockAt(u, now, { ...SEC_RULE, minUnlockCreditSec: 5 * 60 });
  const strict = unlockAt(u, now, { ...SEC_RULE, minUnlockCreditSec: 20 * 60 });

  assert.ok(drip < chunked, "chunked waits longer than the drip");
  assert.ok(chunked < strict, "strict waits for the whole budget back");
  assert.equal(strict, bucketExpiresAt(1019, HOUR));
});

test("unlockAt: an unspent rule is usable now", () => {
  assert.equal(unlockAt(createUsage(), T0, SEC_RULE), T0);
});

test("creditAvailableAt: asking for more than the budget clamps to the budget", () => {
  const u = commit(createUsage(), T0, T0 + 20 * MIN);
  const now = T0 + 20 * MIN;

  // Draining every bucket frees the full budget, so this must resolve rather
  // than fall through to null.
  const at = creditAvailableAt(u, now, RULE, 999 * MIN);
  assert.equal(at, bucketExpiresAt(1019, HOUR));
});

test("creditAvailableAt: an empty ledger is immediately available", () => {
  assert.equal(creditAvailableAt(createUsage(), T0, RULE, 5 * MIN), T0);
});

test("a realistic session: watch, pause, watch, then wait it out", () => {
  const u = createUsage();
  let t = T0;

  commit(u, t, (t += 12 * MIN)); // 12 min of video
  t += 40 * MIN; // paused / away — costs nothing
  commit(u, t, (t += 8 * MIN)); // 8 more, budget now exactly spent

  assert.equal(usedMs(u, t, HOUR), 20 * MIN);
  assert.equal(remainingMs(u, t, RULE), 0);

  // The first 12 minutes expire before the last 8, so credit returns gradually.
  const at = creditAvailableAt(u, t, RULE, 5 * MIN);
  assert.ok(at > t, "not yet");
  assert.ok(at <= t + HOUR, "and within the window");
});

// --- folding into calendar days ------------------------------------------

/** 10:00 local on a Saturday; Lisbon is UTC+1 then, so this is bucket-aligned. */
const DAY0 = new Date(2026, 8, 19, 10, 0).getTime();
const KEY0 = "2026-09-19";

test("fold: a bucket outside the window lands in its day and leaves b", () => {
  const u = commit(createUsage(), DAY0, DAY0 + 3 * MIN);
  fold(u, DAY0 + HOUR + 10 * MIN, HOUR);

  assert.deepEqual(u.b, {}, "expired buckets are gone");
  assert.deepEqual(u.d, { [KEY0]: { used: 3 * MIN, pass: 0 } });
});

test("fold: two buckets from the same day accumulate", () => {
  const u = createUsage();
  commit(u, DAY0, DAY0 + MIN);
  commit(u, DAY0 + 30 * MIN, DAY0 + 32 * MIN);
  fold(u, DAY0 + 2 * HOUR, HOUR);
  assert.equal(u.d[KEY0].used, 3 * MIN);
});

test("fold: a bucket inside the window stays live and is not counted twice", () => {
  const u = createUsage();
  commit(u, DAY0, DAY0 + MIN); // will expire
  commit(u, DAY0 + 50 * MIN, DAY0 + 51 * MIN); // still live
  const now = DAY0 + 70 * MIN;
  fold(u, now, HOUR);

  assert.deepEqual(Object.keys(u.b).map(Number), [bucketOf(DAY0 + 50 * MIN)]);
  assert.equal(u.d[KEY0].used, MIN);
  assert.equal(usedMs(u, now, HOUR), MIN, "the rolling window still sees the live bucket");
});

test("fold: folding twice is idempotent", () => {
  const u = commit(createUsage(), DAY0, DAY0 + 5 * MIN);
  fold(u, DAY0 + 2 * HOUR, HOUR);
  const once = structuredClone(u);
  fold(u, DAY0 + 2 * HOUR, HOUR);
  assert.deepEqual(u, once);
});

test("fold: buckets either side of local midnight land on different days", () => {
  const beforeMidnight = new Date(2026, 8, 19, 23, 59).getTime();
  const u = commit(createUsage(), beforeMidnight, beforeMidnight + 2 * MIN);
  fold(u, beforeMidnight + 2 * HOUR, HOUR);
  assert.deepEqual(u.d, {
    "2026-09-19": { used: MIN, pass: 0 },
    "2026-09-20": { used: MIN, pass: 0 },
  });
});

test("fold: days older than the retention are dropped, the rest kept", () => {
  const u = createUsage();
  const old = addDays(DAY0, -(HISTORY_DAYS + 5));
  const edge = addDays(DAY0, -(HISTORY_DAYS - 1));
  u.d[dayKey(old)] = { used: MIN, pass: 0 };
  u.d[dayKey(edge)] = { used: MIN, pass: 0 };
  u.d[KEY0] = { used: MIN, pass: 0 };

  fold(u, DAY0, HOUR);

  assert.equal(u.d[dayKey(old)], undefined, "too old");
  assert.ok(u.d[dayKey(edge)], "the oldest retained day survives");
  assert.ok(u.d[KEY0]);
});

test("fold: pass buckets fold into the day's pass component", () => {
  // Written before passes exist (Step 5) so that step cannot forget it.
  const u = createUsage();
  u.p[bucketOf(DAY0)] = 4 * MIN;
  commit(u, DAY0 + MIN, DAY0 + 2 * MIN);
  fold(u, DAY0 + 2 * HOUR, HOUR);

  assert.deepEqual(u.p, {});
  assert.deepEqual(u.d[KEY0], { used: MIN, pass: 4 * MIN });
});

test("prune is fold: the old name still works for one step", () => {
  assert.equal(prune, fold);
});

// --- calendar periods ----------------------------------------------------

test("usedInPeriod: folded days plus live buckets, never double counted", () => {
  const u = createUsage();
  commit(u, DAY0, DAY0 + 3 * MIN); // will fold
  commit(u, DAY0 + 2 * HOUR, DAY0 + 2 * HOUR + 2 * MIN); // stays live
  const now = DAY0 + 2 * HOUR + 30 * MIN;
  fold(u, now, HOUR);

  assert.equal(u.d[KEY0].used, 3 * MIN, "folded part");
  assert.equal(usedInPeriod(u, startOfDay(now)), 5 * MIN);
});

test("usedInPeriod: a live bucket from before the period start is excluded", () => {
  const lateLastNight = new Date(2026, 8, 19, 23, 58).getTime();
  const u = commit(createUsage(), lateLastNight, lateLastNight + 4 * MIN); // 2 min each side
  const today = new Date(2026, 8, 20, 0, 30).getTime();

  assert.equal(usedInPeriod(u, startOfDay(today)), 2 * MIN);
  assert.equal(usedInPeriod(u, startOfDay(lateLastNight)), 4 * MIN, "yesterday's period sees both");
});

test("usedInPeriod: the pass component can be excluded", () => {
  const u = createUsage();
  u.d[KEY0] = { used: 10 * MIN, pass: 7 * MIN };
  u.p[bucketOf(DAY0 + 5 * HOUR)] = 2 * MIN;
  commit(u, DAY0 + 5 * HOUR, DAY0 + 5 * HOUR + MIN);
  const start = startOfDay(DAY0);

  assert.equal(usedInPeriod(u, start), 20 * MIN, "everything by default");
  assert.equal(usedInPeriod(u, start, { includePass: true }), 20 * MIN);
  assert.equal(usedInPeriod(u, start, { includePass: false }), 11 * MIN);
});

test("usedInPeriod: days before the period do not count", () => {
  const u = createUsage();
  u.d["2026-09-18"] = { used: 30 * MIN, pass: 0 };
  u.d[KEY0] = { used: MIN, pass: 0 };
  assert.equal(usedInPeriod(u, startOfDay(DAY0)), MIN);
  assert.equal(usedInPeriod(u, addDays(startOfDay(DAY0), -1)), 31 * MIN);
});

// --- ledger shape --------------------------------------------------------

test("normalizeUsage: a ledger from an older build gains the new members", () => {
  const u = normalizeUsage({ b: { 1000: 5000 } });
  assert.deepEqual(u, { b: { 1000: 5000 }, p: {}, d: {}, pass: null, passUses: [] });
});

test("normalizeUsage: keeps what a current ledger already holds", () => {
  const stored = {
    b: { 1: 1 },
    p: { 2: 2 },
    d: { "2026-09-19": { used: 3, pass: 4 } },
    pass: { from: 5, to: 6 },
    passUses: [5],
  };
  assert.deepEqual(normalizeUsage(structuredClone(stored)), stored);
});

test("normalizeUsage: a malformed value becomes a fresh ledger", () => {
  for (const bad of [undefined, null, 42, "b", [], { b: "nope" }, { b: null }]) {
    assert.deepEqual(normalizeUsage(bad), createUsage(), `${JSON.stringify(bad)}`);
  }
  assert.deepEqual(createUsage(), { b: {}, p: {}, d: {}, pass: null, passUses: [] });
});

test("normalizeUsage: a malformed member is reset without touching the others", () => {
  const u = normalizeUsage({ b: { 1: 1 }, p: 7, d: [], pass: "x", passUses: {} });
  assert.deepEqual(u, { b: { 1: 1 }, p: {}, d: {}, pass: null, passUses: [] });
});

function total(usage) {
  return Object.values(usage.b).reduce((sum, ms) => sum + ms, 0);
}

test("usedByDay: folded days and live buckets, per local day", () => {
  const u = createUsage();
  u.d["2026-09-18"] = { used: 10 * MIN, pass: MIN };
  commit(u, DAY0, DAY0 + 2 * MIN);
  u.p[bucketOf(DAY0 + 5 * MIN)] = MIN;
  assert.deepEqual(usedByDay(u), {
    "2026-09-18": { used: 10 * MIN, pass: MIN },
    [KEY0]: { used: 2 * MIN, pass: MIN },
  });
});
