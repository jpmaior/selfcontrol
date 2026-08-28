// The ledger: open intervals plus committed usage, one per rule.
//
// Step 3 keeps everything in memory. That is deliberately temporary — the
// numbers here vanish whenever MV3 unloads the event page, which is exactly the
// hole Step 4 fills with storage.local (committed usage) and storage.session
// (open intervals). Nothing outside this module touches the ledgers, so adding
// persistence stays confined to this file.

import {
  commit,
  createUsage,
  prune,
  remainingMs,
  unlockAt,
  usedMs,
  windowOf,
} from "./accountant.js";

/**
 * How often an open interval is folded into the ledger (DESIGN.md §5). Also
 * bounds the sleep clamp: a suspended machine can never credit more than one
 * and a half checkpoints in a single commit.
 */
export const CHECKPOINT_MS = 5 * 60_000;
export const MAX_CHUNK_MS = 1.5 * CHECKPOINT_MS;

/** ruleId -> usage ledger */
const ledgers = new Map();

/** ruleId -> epoch ms the current open interval began */
const openSince = new Map();

function ledgerFor(ruleId) {
  let usage = ledgers.get(ruleId);
  if (!usage) {
    usage = createUsage();
    ledgers.set(ruleId, usage);
  }
  return usage;
}

export function isCounting(ruleId) {
  return openSince.has(ruleId);
}

/** Open an interval. Idempotent — a rule already counting stays as it was. */
export function startCounting(rule, nowMs) {
  if (openSince.has(rule.id)) return;
  openSince.set(rule.id, nowMs);
}

/** Close the open interval and fold it in. Returns the milliseconds credited. */
export function stopCounting(rule, nowMs) {
  const since = openSince.get(rule.id);
  if (since === undefined) return 0;
  openSince.delete(rule.id);
  return settle(rule, since, nowMs);
}

/**
 * Fold an open interval in *without* closing it, so a long session is never
 * one enormous unrecorded interval. Returns the milliseconds credited.
 */
export function checkpointRule(rule, nowMs) {
  const since = openSince.get(rule.id);
  if (since === undefined) return 0;
  openSince.set(rule.id, nowMs);
  return settle(rule, since, nowMs);
}

function settle(rule, fromMs, toMs) {
  const usage = ledgerFor(rule.id);
  commit(usage, fromMs, toMs, { maxChunkMs: MAX_CHUNK_MS });
  prune(usage, toMs, rule.windowSec * 1000);
  return Math.min(Math.max(0, toMs - fromMs), MAX_CHUNK_MS);
}

/**
 * A read-only projection of the ledger that includes the currently open
 * interval, so live readings are honest between checkpoints. Never written back.
 */
function projected(rule, nowMs) {
  const usage = ledgerFor(rule.id);
  const since = openSince.get(rule.id);
  if (since === undefined) return usage;
  return commit({ b: { ...usage.b } }, since, nowMs, { maxChunkMs: MAX_CHUNK_MS });
}

/** Everything a popup, block page or enforcer needs to know about one rule. */
export function status(rule, nowMs) {
  const usage = projected(rule, nowMs);
  const limits = windowOf(rule);
  const remaining = remainingMs(usage, nowMs, limits);

  return {
    id: rule.id,
    label: rule.label,
    mode: rule.mode,
    counting: openSince.has(rule.id),
    usedMs: usedMs(usage, nowMs, limits.windowMs),
    budgetMs: limits.budgetMs,
    remainingMs: remaining,
    exhausted: remaining <= 0,
    unlockAtMs: remaining > 0 ? nowMs : unlockAt(usage, nowMs, rule),
  };
}

export function describe(rule, nowMs) {
  const s = status(rule, nowMs);
  const state = s.counting ? "counting" : "idle";
  return `${s.id}: ${clock(s.usedMs)} / ${clock(s.budgetMs)} used (${state})`;
}

/** mm:ss, or h:mm:ss past an hour. */
export function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Raw ledger access, for the console and for Step 4's flush. */
export function rawLedger(ruleId) {
  return ledgers.get(ruleId) ?? null;
}
