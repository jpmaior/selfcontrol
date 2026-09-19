// Rolling-window arithmetic. PURE: no `browser.*`, no `Date.now()` — the clock
// is always an argument. That is what lets test/accountant.test.js pin down the
// fiddly cases with `node --test` and no browser involved.
//
// See DESIGN.md §5 and §13. Usage is a sparse map of fixed 60-second buckets
// plus the calendar days those buckets fold into once they leave the window:
//
//   {
//     b: { "29384756": 60000, "29384757": 23400 },  // live buckets
//     p: { "29384790": 60000 },                     // live buckets under a pass
//     d: { "2026-09-19": { used: 0, pass: 0 } },    // folded whole days, local
//     pass: null,                                   // { from, to } of a pass
//     passUses: []                                  // pass start instants, this week
//   }
//        ^ bucket index          ^ milliseconds accrued in that bucket
//
// Milliseconds rather than seconds so that many short intervals cannot
// accumulate rounding drift; the JSON size difference is a few hundred bytes.

import { addDays, dayKey } from "../common/calendar.js";

export const BUCKET_MS = 60_000;

/** Folded days kept in `d`; older ones are dropped by fold(). */
export const HISTORY_DAYS = 90;

export function bucketOf(ms) {
  return Math.floor(ms / BUCKET_MS);
}

/** The instant bucket `b` falls out of a `windowMs`-wide window. */
export function bucketExpiresAt(bucket, windowMs) {
  return (bucket + 1) * BUCKET_MS + windowMs;
}

export function createUsage() {
  return { b: {}, p: {}, d: {}, pass: null, passUses: [] };
}

const isMap = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Fill in whatever a ledger stored by an older build is missing, the way
 * `withDefaults` does for rules. Anything that is not the right shape is
 * reset on its own; a value that is not a ledger at all becomes a fresh one.
 */
export function normalizeUsage(value) {
  if (!isMap(value) || !isMap(value.b)) return createUsage();
  const pass = isMap(value.pass) && Number.isFinite(value.pass.from) && Number.isFinite(value.pass.to)
    ? value.pass
    : null;
  return {
    b: value.b,
    p: isMap(value.p) ? value.p : {},
    d: isMap(value.d) ? value.d : {},
    pass,
    passUses: Array.isArray(value.passUses) ? value.passUses : [],
  };
}

/**
 * Credit the interval [fromMs, toMs) to the buckets it spans.
 *
 * `maxChunkMs` is the sleep clamp. A suspended laptop produces an enormous
 * interval, and counting it would silently eat the whole budget. We clamp by
 * moving the *start* forward rather than truncating the end, because the one
 * thing we know is that the machine was awake around `toMs`.
 *
 * Mutates and returns `usage`.
 */
export function commit(usage, fromMs, toMs, { maxChunkMs = Infinity } = {}) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return usage;
  if (toMs <= fromMs) return usage; // zero-length, or a clock that went backwards

  const start = Math.max(fromMs, toMs - maxChunkMs);

  // `toMs - 1` so an interval ending exactly on a boundary does not create a
  // trailing zero-width bucket.
  for (let bucket = bucketOf(start); bucket <= bucketOf(toMs - 1); bucket++) {
    const lo = Math.max(start, bucket * BUCKET_MS);
    const hi = Math.min(toMs, (bucket + 1) * BUCKET_MS);
    if (hi > lo) usage.b[bucket] = (usage.b[bucket] ?? 0) + (hi - lo);
  }

  return usage;
}

/**
 * Fold buckets that have fallen out of the window into their local day, then
 * delete them. Mutates and returns `usage`.
 *
 * This replaces plain pruning (DESIGN.md §13): the buckets are being touched
 * anyway, so history and the calendar caps cost no extra writes. A bucket
 * belongs to exactly one local day because both buckets and time-zone offsets
 * are whole minutes, and deleting a bucket as it is folded is what makes
 * "folded days + live buckets" free of double counting.
 */
export function fold(usage, nowMs, windowMs) {
  const oldest = bucketOf(nowMs - windowMs);
  foldMap(usage, "b", "used", oldest);
  foldMap(usage, "p", "pass", oldest);

  const cutoff = dayKey(addDays(nowMs, -(HISTORY_DAYS - 1)));
  for (const key of Object.keys(usage.d)) {
    if (key < cutoff) delete usage.d[key];
  }
  return usage;
}

function foldMap(usage, map, field, oldestBucket) {
  for (const key of Object.keys(usage[map])) {
    const bucket = Number(key);
    if (bucket >= oldestBucket) continue;
    const day = dayKey(bucket * BUCKET_MS);
    const entry = (usage.d[day] ??= { used: 0, pass: 0 });
    entry[field] += usage[map][key];
    delete usage[map][key];
  }
}

/** The old name, kept for one step so nothing that imports it breaks. */
export const prune = fold;

/**
 * Milliseconds used since `periodStartMs`, a local day or week start: folded
 * days on or after it plus live buckets that start on or after it. A live
 * bucket from before the period belongs to its own day, not to this one.
 */
export function usedInPeriod(usage, periodStartMs, { includePass = true } = {}) {
  const startKey = dayKey(periodStartMs);
  let total = 0;
  for (const [key, day] of Object.entries(usage.d)) {
    if (key < startKey) continue;
    total += day.used + (includePass ? day.pass : 0);
  }
  const firstBucket = bucketOf(periodStartMs);
  for (const [key, ms] of Object.entries(usage.b)) {
    if (Number(key) >= firstBucket) total += ms;
  }
  if (includePass) {
    for (const [key, ms] of Object.entries(usage.p)) {
      if (Number(key) >= firstBucket) total += ms;
    }
  }
  return total;
}

/**
 * Every day with any usage, folded or live, as `{ "YYYY-MM-DD": { used, pass } }`.
 * For the history view; the caps use usedInPeriod().
 */
export function usedByDay(usage) {
  const days = {};
  for (const [key, day] of Object.entries(usage.d)) days[key] = { ...day };
  for (const [map, field] of [["b", "used"], ["p", "pass"]]) {
    for (const [key, ms] of Object.entries(usage[map])) {
      const day = dayKey(Number(key) * BUCKET_MS);
      (days[day] ??= { used: 0, pass: 0 })[field] += ms;
    }
  }
  return days;
}

/**
 * Milliseconds used within the rolling window.
 *
 * The boundary bucket is counted whole rather than prorated: we know how much
 * was used inside a bucket but not *when* within it, so prorating would be a
 * guess. Counting it whole over-counts by at most one bucket, which errs toward
 * blocking slightly early — the right direction for this tool.
 */
export function usedMs(usage, nowMs, windowMs) {
  const oldest = bucketOf(nowMs - windowMs);
  let total = 0;
  for (const [key, ms] of Object.entries(usage.b)) {
    if (Number(key) >= oldest) total += ms;
  }
  return total;
}

/** Milliseconds of budget still available, never negative. */
export function remainingMs(usage, nowMs, { budgetMs, windowMs }) {
  return Math.max(0, budgetMs - usedMs(usage, nowMs, windowMs));
}

/**
 * When will at least `neededMs` of budget be free again?
 *
 * Returns `nowMs` if it already is. Otherwise walks the buckets in expiry order
 * — a rolling window only ever gives time back — and returns the instant the
 * requirement is met.
 *
 * This one function drives both the block page countdown and
 * `minUnlockCreditSec` (DESIGN.md §8).
 */
export function creditAvailableAt(usage, nowMs, { budgetMs, windowMs }, neededMs) {
  const needed = Math.min(neededMs, budgetMs);
  let used = usedMs(usage, nowMs, windowMs);
  if (budgetMs - used >= needed) return nowMs;

  const oldest = bucketOf(nowMs - windowMs);
  const live = Object.keys(usage.b)
    .map(Number)
    .filter((bucket) => bucket >= oldest)
    .sort((a, b) => a - b);

  for (const bucket of live) {
    used -= usage.b[bucket];
    if (budgetMs - used >= needed) return bucketExpiresAt(bucket, windowMs);
  }

  // Unreachable while needed <= budgetMs, since draining every bucket frees the
  // full budget. Returning null rather than guessing keeps that assumption loud.
  return null;
}

/** Convenience for rules, which are authored in seconds. */
export function windowOf(rule) {
  return { budgetMs: rule.budgetSec * 1000, windowMs: rule.windowSec * 1000 };
}

/**
 * The instant a blocked rule becomes usable again.
 *
 * Note the `max(..., 1)`. `minUnlockCreditSec: 0` means "unlock as soon as any
 * time at all is available" — the drip-feed of DESIGN.md §8 — which is one
 * millisecond of credit, NOT zero. Asking `creditAvailableAt` for zero credit is
 * trivially satisfied right now, so passing 0 straight through would mean the
 * rule never blocks at all.
 */
export function unlockAt(usage, nowMs, rule) {
  const needed = Math.max((rule.minUnlockCreditSec ?? 0) * 1000, 1);
  return creditAvailableAt(usage, nowMs, windowOf(rule), needed);
}
