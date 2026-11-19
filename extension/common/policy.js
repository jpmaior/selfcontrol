// Whether a rule is open right now, and when that answer next changes.
//
// PURE: no `browser.*`, no `Date.now()`. One function, `evaluate`, combines
// every constraint a rule can carry (DESIGN.md §14):
//
//   rolling   the budget over the rolling window (DESIGN.md §5, §8)
//   daily     a calendar-day cap, local time, back at midnight
//   weekly    a calendar-week cap, local time, back on Monday
//   pass      a single-use unlock that suspends the rolling cap (DESIGN.md §17)
//
// A budget of zero overrides all of them: the rule blocks outright, with no
// unlock instant at all (DESIGN.md §22).
//
// Exhausted = any constraint says so. The unlock instant is the MAX over the
// exhausted constraints, because the site is usable only once all of them
// allow it. The remaining time is the MIN over the caps, because the first one
// to run out is the one that will block. `reason` names the constraint that
// releases last; `binding` names the cap with the least left.

import {
  commit,
  lockIn,
  passActive,
  passesLeft,
  remainingMs as rollingRemaining,
  unlockAt,
  unlockCreditMs,
  usedInPeriod,
  usedMs,
  windowOf,
} from "../background/accountant.js";
import { startOfDay, startOfNextDay, startOfNextWeek, startOfWeek } from "./calendar.js";
import { blocksOutright } from "./rules.js";

/** Tie-break order when several constraints release at the same instant: the
 * longer period is the more useful thing to tell the user. */
const RELEASE_ORDER = ["weekly", "daily", "rolling"];

/** Tie-break order for "which cap has the least left". */
const CAP_ORDER = ["rolling", "daily", "weekly"];

const NAME = {
  rolling: "already blocked",
  daily: "done for today",
  weekly: "done for the week",
  always: "always blocked",
};

/**
 * A rule with a budget of zero (DESIGN.md §22): spent from the start, and with
 * no time to give back there is no instant to count down to (`unlockAtMs`) and
 * nothing to wake up for (`nextChangeAtMs`); only raising the budget lifts it.
 * The caps report nothing and a pass in the ledger is ignored, since nothing
 * but the zero applies.
 */
function outright() {
  return {
    exhausted: true,
    reason: "always",
    binding: null,
    remainingMs: 0,
    unlockAtMs: null,
    nextChangeAtMs: null,
    nextChange: null,
    caps: { rolling: null, daily: null, weekly: null },
    pass: { active: false, endsAtMs: null, leftThisWeek: 0 },
  };
}

function rollingCap(rule, usage, nowMs) {
  const limits = windowOf(rule);
  const used = usedMs(usage, nowMs, limits.windowMs);
  const remaining = rollingRemaining(usage, nowMs, limits);
  // Spent, or still cooling down from a block that already landed. The first
  // bucket to age out frees a little credit, and without the hold that little
  // reopened the rule: the drip-feed minUnlockCreditSec exists to stop
  // (DESIGN.md §8). The hold only says a block is in progress; the release is
  // still "enough credit is back", so a rule loosened mid-block lets go early.
  const held = usage.blockedUntil > nowMs && remaining < unlockCreditMs(rule);
  const exhausted = remaining <= 0 || held;
  return {
    usedMs: used,
    budgetMs: limits.budgetMs,
    remainingMs: remaining,
    exhausted,
    // The max(minUnlockCreditSec, 1) clamp lives in unlockCreditMs (DESIGN.md §8).
    unlockAtMs: exhausted ? unlockAt(usage, nowMs, rule) : nowMs,
  };
}

/** A calendar cap comes back whole at the period boundary, so there is no
 * drip-feed to tame and no credit threshold to apply. */
function calendarCap(budgetSec, usage, nowMs, startMs, nextStartMs, includePass) {
  if (!(budgetSec > 0)) return null;
  const budgetMs = budgetSec * 1000;
  const used = usedInPeriod(usage, startMs, { includePass });
  const remaining = Math.max(0, budgetMs - used);
  const exhausted = remaining <= 0;
  return {
    usedMs: used,
    budgetMs,
    remainingMs: remaining,
    exhausted,
    unlockAtMs: exhausted ? nextStartMs : nowMs,
  };
}

/**
 * Combine every constraint on `rule` into one answer.
 *
 * `counting` matters only for `nextChangeAtMs`: an open rule that is counting
 * will flip when its smallest remainder runs out; an idle one will not flip
 * on its own, so there is nothing to wake up for.
 */
export function evaluate(rule, usage, nowMs, { counting = false } = {}) {
  if (blocksOutright(rule)) return outright();

  const includePass = rule.passes?.countsTowardCaps ?? true;

  const caps = {
    rolling: rollingCap(rule, usage, nowMs),
    daily: calendarCap(
      rule.dailyBudgetSec,
      usage,
      nowMs,
      startOfDay(nowMs),
      startOfNextDay(nowMs),
      includePass,
    ),
    weekly: calendarCap(
      rule.weeklyBudgetSec,
      usage,
      nowMs,
      startOfWeek(nowMs),
      startOfNextWeek(nowMs),
      includePass,
    ),
  };

  const active = passActive(usage, nowMs);
  const pass = {
    active,
    endsAtMs: active ? usage.pass.to : null,
    leftThisWeek: passesLeft(rule, usage, nowMs),
  };

  // --- exhausted: any constraint, released when the last of them releases.
  // A pass suspends the rolling cap and nothing else.
  const releases = {};
  for (const name of CAP_ORDER) {
    if (name === "rolling" && active) continue;
    if (caps[name]?.exhausted) releases[name] = caps[name].unlockAtMs;
  }

  let reason = null;
  for (const name of RELEASE_ORDER) {
    if (!(name in releases)) continue;
    if (reason === null || releases[name] > releases[reason]) reason = name;
  }
  const exhausted = reason !== null;
  const unlockAtMs = exhausted ? releases[reason] : nowMs;

  // --- remaining: whatever will bind first. During a pass that is one of the
  // calendar caps or the pass itself, never the suspended rolling cap; and
  // when pass time does not count toward the caps, they are not draining
  // either, so only the pass itself can run out.
  const left = {};
  for (const name of CAP_ORDER) {
    if (active && (name === "rolling" || !includePass)) continue;
    if (caps[name]) left[name] = caps[name].remainingMs;
  }
  if (active) left.pass = pass.endsAtMs - nowMs;
  let binding = null;
  for (const name of [...CAP_ORDER, "pass"]) {
    if (!(name in left)) continue;
    if (binding === null || left[name] < left[binding]) binding = name;
  }
  const remainingMs = exhausted ? 0 : left[binding];

  // --- the earliest instant the answer could flip; null means never on its own.
  // `nextChange` says what happens then: "unlock", "pass" (the pass ends), or
  // the cap that runs out. Not `binding`: while nothing counts, a pass's end is
  // the alarm even when a cap has less left, and that cap is the binding one.
  let nextChangeAtMs = null;
  let nextChange = null;
  if (exhausted) {
    nextChangeAtMs = unlockAtMs;
    nextChange = "unlock";
  } else {
    if (counting) {
      nextChangeAtMs = nowMs + remainingMs;
      nextChange = binding;
    }
    if (active && (nextChangeAtMs === null || pass.endsAtMs <= nextChangeAtMs)) {
      nextChangeAtMs = pass.endsAtMs;
      nextChange = "pass";
    }
  }

  return { exhausted, reason, binding, remainingMs, unlockAtMs, nextChangeAtMs, nextChange, caps, pass };
}

// --- the hold (DESIGN.md §8) ----------------------------------------------

/**
 * What the ledger's `blockedUntil` should be after `decision`: the rolling
 * cap's unlock instant while it is spent, null once it is not, and `undefined`
 * to leave it alone: during a pass, whose unlock instant moves every minute it
 * is used, and for a rule that blocks outright, which has no rolling cap
 * (DESIGN.md §22).
 */
export function holdAfter(decision) {
  const rolling = decision.caps.rolling;
  if (decision.pass.active || !rolling) return undefined;
  return rolling.exhausted ? rolling.unlockAtMs : null;
}

// --- crediting use (DESIGN.md §7) -------------------------------------------

/**
 * Credit `[fromMs, toMs)` of use to `usage`, but only up to the instant the
 * rule runs out: a spent rule never counts. Mutates `usage`, and returns the
 * milliseconds credited and the instant it ran out (null if it did not).
 *
 * An interval is normally closed at that instant by the rule's alarm, so this
 * only bites when the close comes late: Android freezes Firefox in the
 * background, and its alarms with it, and a laptop sleeps through them. The
 * late time used to be credited, and moved the unlock later with it (#35).
 *
 * The sleep clamp (`maxChunkMs`, see accountant.commit) applies first; of what
 * it lets through, the part before the rule runs out counts. Running out is
 * decided by evaluate() itself, stepping from one `nextChangeAtMs` to the next,
 * so every cap, the hold and a pass's end are taken as the alarms would take
 * them, and a rolling window that gives time back on the way is followed.
 * The hold is recorded at that instant, as status() would have recorded it.
 * What comes after it does not count even if the rule is open again by
 * `toMs`: on time, the block page would have been up by then.
 *
 * A rule spent at `fromMs` itself is credited whole. An interval only opens on
 * a rule that is not spent and is closed when it runs out, so a rule spent at
 * its start had its limits changed under it, by a settings change whose own
 * instant is the close: the time was allowed when it was used.
 */
export function creditInUse(rule, usage, fromMs, toMs, { maxChunkMs = Infinity } = {}) {
  if (!(toMs > fromMs)) return { creditedMs: 0, ranOutAtMs: null };
  const startMs = Math.max(fromMs, toMs - maxChunkMs);

  if (evaluate(rule, usage, startMs).exhausted) {
    commit(usage, startMs, toMs, { pass: usage.pass });
    return { creditedMs: toMs - startMs, ranOutAtMs: null };
  }

  // Each step ends where evaluate() says the answer could change, which is
  // strictly later while the rule is open, so this always ends; the bound only
  // keeps a bug there from hanging the event page.
  let at = startMs;
  for (let step = 0; at < toMs && step < 10_000; step++) {
    const decision = evaluate(rule, usage, at, { counting: true });
    if (decision.exhausted) {
      const hold = holdAfter(decision);
      if (hold !== undefined) usage.blockedUntil = hold;
      return { creditedMs: at - startMs, ranOutAtMs: at };
    }
    const until = Math.min(decision.nextChangeAtMs ?? toMs, toMs);
    commit(usage, at, until, { pass: usage.pass });
    at = until;
  }
  return { creditedMs: at - startMs, ranOutAtMs: null };
}

// --- passes (DESIGN.md §17) -------------------------------------------------

/**
 * Why a pass cannot be used right now, or null when it can. The rolling cap
 * being spent is deliberately NOT a refusal: that is what a pass is for. A
 * spent calendar cap is, whether or not pass time counts toward the caps,
 * because the cap is already spent.
 */
export function canUsePass(rule, usage, nowMs) {
  // Its passes are kept for when the budget is raised, but ignored until then.
  if (blocksOutright(rule)) return NAME.always;
  if (!(rule.passes?.perWeek > 0)) return "no passes on this rule";
  if (passActive(usage, nowMs)) return "a pass is already active";
  if (passesLeft(rule, usage, nowMs) <= 0) return "no passes left this week";
  const e = evaluate(rule, usage, nowMs);
  if (e.caps.weekly?.exhausted) return NAME.weekly;
  if (e.caps.daily?.exhausted) return NAME.daily;
  return null;
}

// --- lock in (DESIGN.md §16) ---------------------------------------------

/** Why lock-in is not offered right now, or null when it is. */
export function canLockIn(rule, usage, nowMs) {
  const e = evaluate(rule, usage, nowMs);
  return e.exhausted ? NAME[e.reason] ?? "blocked" : null;
}

/**
 * How much a lock-in would spend: the smallest remainder across the caps,
 * taken over every cap regardless of a pass (a pass suspends the rolling
 * cap, but lockIn ends the pass first). Zero when already blocked.
 */
export function lockInAmount(rule, usage, nowMs) {
  const e = evaluate(rule, usage, nowMs);
  if (e.exhausted) return 0;
  let least = Infinity;
  for (const cap of Object.values(e.caps)) {
    if (cap && cap.remainingMs < least) least = cap.remainingMs;
  }
  return Number.isFinite(least) ? least : 0;
}

/**
 * What the popup's confirm step shows: how much would be spent and until
 * when the rule would then be blocked. Null when lock-in is not available.
 */
export function lockInPreview(rule, usage, nowMs) {
  if (canLockIn(rule, usage, nowMs) !== null) return null;
  const ms = lockInAmount(rule, usage, nowMs);
  const after = evaluate(rule, lockIn(structuredClone(usage), nowMs, ms), nowMs);
  return { ms, unlockAtMs: after.unlockAtMs, reason: after.reason };
}
