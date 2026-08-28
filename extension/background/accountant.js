// Rolling-window arithmetic. PURE: no `browser.*`, no `Date.now()` — the clock
// is always an argument. That is what lets test/accountant.test.js pin down the
// fiddly cases with `node --test` and no browser involved.
//
// See DESIGN.md §5. Usage is a sparse map of fixed 60-second buckets:
//
//   { b: { "29384756": 60000, "29384757": 23400 } }
//        ^ bucket index          ^ milliseconds accrued in that bucket
//
// Milliseconds rather than seconds so that many short intervals cannot
// accumulate rounding drift; the JSON size difference is a few hundred bytes.

export const BUCKET_MS = 60_000;

export function bucketOf(ms) {
  return Math.floor(ms / BUCKET_MS);
}

/** The instant bucket `b` falls out of a `windowMs`-wide window. */
export function bucketExpiresAt(bucket, windowMs) {
  return (bucket + 1) * BUCKET_MS + windowMs;
}

export function createUsage() {
  return { b: {} };
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

/** Drop buckets that have fallen out of the window. Mutates and returns `usage`. */
export function prune(usage, nowMs, windowMs) {
  const oldest = bucketOf(nowMs - windowMs);
  for (const key of Object.keys(usage.b)) {
    if (Number(key) < oldest) delete usage.b[key];
  }
  return usage;
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
