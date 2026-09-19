// Whether a rule is open right now, and when that answer next changes.
//
// PURE: no `browser.*`, no `Date.now()`. One function, `evaluate`, combines
// every constraint a rule can carry (DESIGN.md §14):
//
//   rolling   the budget over the rolling window (DESIGN.md §5, §8)
//   daily     a calendar-day cap, local time, back at midnight
//   weekly    a calendar-week cap, local time, back on Monday
//
// Exhausted = any constraint says so. The unlock instant is the MAX over the
// exhausted constraints, because the site is usable only once all of them
// allow it. The remaining time is the MIN over the caps, because the first one
// to run out is the one that will block. `reason` names the constraint that
// releases last; `binding` names the cap with the least left.

import {
  remainingMs as rollingRemaining,
  unlockAt,
  usedInPeriod,
  usedMs,
  windowOf,
} from "../background/accountant.js";
import { startOfDay, startOfNextDay, startOfNextWeek, startOfWeek } from "./calendar.js";

/** Tie-break order when several constraints release at the same instant: the
 * longer period is the more useful thing to tell the user. */
const RELEASE_ORDER = ["weekly", "daily", "rolling"];

/** Tie-break order for "which cap has the least left". */
const CAP_ORDER = ["rolling", "daily", "weekly"];

function rollingCap(rule, usage, nowMs) {
  const limits = windowOf(rule);
  const used = usedMs(usage, nowMs, limits.windowMs);
  const remaining = rollingRemaining(usage, nowMs, limits);
  const exhausted = remaining <= 0;
  return {
    usedMs: used,
    budgetMs: limits.budgetMs,
    remainingMs: remaining,
    exhausted,
    // The max(minUnlockCreditSec, 1) clamp lives in unlockAt (DESIGN.md §8).
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

  const pass = { active: false, endsAtMs: null, leftThisWeek: 0 };

  // --- exhausted: any constraint, released when the last of them releases
  const releases = {};
  for (const name of CAP_ORDER) if (caps[name]?.exhausted) releases[name] = caps[name].unlockAtMs;

  let reason = null;
  for (const name of RELEASE_ORDER) {
    if (!(name in releases)) continue;
    if (reason === null || releases[name] > releases[reason]) reason = name;
  }
  const exhausted = reason !== null;
  const unlockAtMs = exhausted ? releases[reason] : nowMs;

  // --- remaining: the cap with the least left is the one that will bind
  let binding = null;
  for (const name of CAP_ORDER) {
    if (!caps[name]) continue;
    if (binding === null || caps[name].remainingMs < caps[binding].remainingMs) binding = name;
  }
  const remainingMs = exhausted ? 0 : caps[binding].remainingMs;

  // --- the earliest instant the answer could flip; null means never on its own
  let nextChangeAtMs = null;
  if (exhausted) {
    nextChangeAtMs = unlockAtMs;
  } else {
    const candidates = [];
    if (counting) candidates.push(nowMs + remainingMs);
    if (pass.active) candidates.push(pass.endsAtMs);
    if (candidates.length > 0) nextChangeAtMs = Math.min(...candidates);
  }

  return { exhausted, reason, binding, remainingMs, unlockAtMs, nextChangeAtMs, caps, pass };
}
