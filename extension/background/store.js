// The ledger: open intervals plus committed usage, one per rule, and the only
// module that touches persistent storage.
//
// Two stores, for two very different kinds of state (DESIGN.md §6):
//
//   storage.local    usage:<ruleId>   committed buckets. Survives restarts.
//   storage.session  open:<ruleId>    the currently open interval. RAM only,
//                                     survives the event page being unloaded,
//                                     cleared when the browser exits.
//
// Keys are split per rule so a counter update never rewrites the settings, and
// writes are batched: nothing is written during playback except at checkpoints.

import {
  commit,
  createUsage,
  prune,
  remainingMs,
  unlockAt,
  usedMs,
  windowOf,
} from "./accountant.js";
import { log, warn } from "./log.js";
import { clock } from "../common/format.js";

/**
 * How often an open interval is folded into the ledger and flushed
 * (DESIGN.md §5). Also bounds the sleep clamp: a suspended machine can never
 * credit more than one and a half checkpoints in a single commit.
 */
export const CHECKPOINT_MS = 5 * 60_000;
export const MAX_CHUNK_MS = 1.5 * CHECKPOINT_MS;

const usageKey = (ruleId) => `usage:${ruleId}`;
const openKey = (ruleId) => `open:${ruleId}`;
const LAST_FLUSH_KEY = "meta:lastFlush";

/** ruleId -> usage ledger */
const ledgers = new Map();

/** ruleId -> epoch ms the current open interval began */
const openSince = new Map();

/** Rules whose ledger has changed since the last flush. */
const dirty = new Set();

/** Last instant we can prove we were alive and flushing. */
let lastFlushMs = 0;

/** Observable counters, so Checkpoint 4 can verify writes are actually rare. */
export const stats = { localWrites: 0, sessionWrites: 0, keysWritten: 0 };

// --- write serialisation -------------------------------------------------

// Storage writes are queued rather than awaited by callers. That keeps the
// mutating API synchronous (transitions must not race the ledger) while
// guaranteeing writes land in the order they were issued.
let writeChain = Promise.resolve();

function enqueue(task) {
  writeChain = writeChain.then(task).catch((error) => warn("storage write failed:", error));
  return writeChain;
}

/** Await all queued writes. Used by onSuspend and by tests. */
export function settled() {
  return writeChain;
}

// --- loading -------------------------------------------------------------

function isUsageShape(value) {
  return Boolean(value) && typeof value === "object" && typeof value.b === "object";
}

/**
 * Rebuild the ledger from storage. Runs on EVERY event page start, not just on
 * install — that is the whole point.
 */
export async function load(rules) {
  // A settings save enqueues stopCounting/flush writes just before reloading;
  // reading around the queue would rebuild the ledger from pre-flush data and
  // the next flush would overwrite the interval that was settling.
  await settled();

  const local = await browser.storage.local.get([
    ...rules.map((rule) => usageKey(rule.id)),
    LAST_FLUSH_KEY,
  ]);
  lastFlushMs = local[LAST_FLUSH_KEY] ?? 0;

  for (const rule of rules) {
    const stored = local[usageKey(rule.id)];
    ledgers.set(rule.id, isUsageShape(stored) ? stored : createUsage());
  }

  const session = await browser.storage.session.get(rules.map((rule) => openKey(rule.id)));
  let resumed = 0;
  for (const rule of rules) {
    const since = session[openKey(rule.id)];
    if (Number.isFinite(since)) {
      openSince.set(rule.id, since);
      resumed++;
    }
  }

  log(`ledger loaded — ${rules.length} rules, ${resumed} interval(s) still open`);
}

/**
 * Settle an interval that was left open when the event page died.
 *
 * If the observers confirm the rule is still being consumed, the interval is a
 * legitimate resume and is kept untouched. Otherwise playback stopped while we
 * were unloaded and we have no idea when — so we credit only up to the last
 * instant we can prove we were alive and flushing, rather than guessing.
 *
 * Returns the milliseconds credited, or 0 if there was nothing to settle.
 */
export function reconcile(rule, nowMs, stillCounting) {
  const since = openSince.get(rule.id);
  if (since === undefined) return 0;
  if (stillCounting) return 0;

  openSince.delete(rule.id);
  enqueue(() => browser.storage.session.remove(openKey(rule.id)));

  const until = Math.min(Math.max(since, lastFlushMs), nowMs);
  return settle(rule, since, until);
}

// --- counting ------------------------------------------------------------

function ledgerFor(ruleId) {
  let usage = ledgers.get(ruleId);
  if (!usage) {
    usage = createUsage();
    ledgers.set(ruleId, usage);
  }
  return usage;
}

export function hasOpenInterval(ruleId) {
  return openSince.has(ruleId);
}

export function anyCounting() {
  return openSince.size > 0;
}

/** Open an interval. Idempotent — a rule already counting keeps its start time. */
export function startCounting(rule, nowMs) {
  if (openSince.has(rule.id)) return;
  openSince.set(rule.id, nowMs);
  stats.sessionWrites++;
  enqueue(() => browser.storage.session.set({ [openKey(rule.id)]: nowMs }));
}

/** Close the open interval and fold it in. Returns the milliseconds credited. */
export function stopCounting(rule, nowMs) {
  const since = openSince.get(rule.id);
  if (since === undefined) return 0;

  openSince.delete(rule.id);
  stats.sessionWrites++;
  enqueue(() => browser.storage.session.remove(openKey(rule.id)));

  return settle(rule, since, nowMs);
}

/**
 * Fold an open interval in *without* closing it, so a long session is never one
 * enormous unrecorded stretch. Returns the milliseconds credited.
 */
export function checkpointRule(rule, nowMs) {
  const since = openSince.get(rule.id);
  if (since === undefined) return 0;

  openSince.set(rule.id, nowMs);
  stats.sessionWrites++;
  enqueue(() => browser.storage.session.set({ [openKey(rule.id)]: nowMs }));

  return settle(rule, since, nowMs);
}

function settle(rule, fromMs, toMs) {
  const usage = ledgerFor(rule.id);
  commit(usage, fromMs, toMs, { maxChunkMs: MAX_CHUNK_MS });
  prune(usage, toMs, rule.windowSec * 1000);
  dirty.add(rule.id);
  return Math.min(Math.max(0, toMs - fromMs), MAX_CHUNK_MS);
}

// --- flushing ------------------------------------------------------------

/**
 * Write every changed ledger to storage.local. Called at checkpoints, at
 * transitions, and on suspend — never on a timer, and never during playback.
 * Returns the number of rule keys written.
 */
export function flush(nowMs) {
  if (dirty.size === 0) return 0;

  const payload = { [LAST_FLUSH_KEY]: nowMs };
  for (const ruleId of dirty) payload[usageKey(ruleId)] = ledgerFor(ruleId);
  const count = dirty.size;
  dirty.clear();
  lastFlushMs = nowMs;

  stats.localWrites++;
  stats.keysWritten += count;
  enqueue(() => browser.storage.local.set(payload));

  return count;
}

/** Forget a rule entirely — used when a rule is deleted in Step 7. */
export function forget(ruleId) {
  ledgers.delete(ruleId);
  openSince.delete(ruleId);
  dirty.delete(ruleId);
  enqueue(() =>
    Promise.all([
      browser.storage.local.remove(usageKey(ruleId)),
      browser.storage.session.remove(openKey(ruleId)),
    ]),
  );
}

// --- reading -------------------------------------------------------------

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
    windowMs: limits.windowMs,
    remainingMs: remaining,
    exhausted: remaining <= 0,
    unlockAtMs: remaining > 0 ? nowMs : unlockAt(usage, nowMs, rule),
  };
}

export function describe(rule, nowMs) {
  const s = status(rule, nowMs);
  return `${s.id}: ${clock(s.usedMs)} / ${clock(s.budgetMs)} used (${s.counting ? "counting" : "idle"})`;
}

/** Raw ledger access, for the console. */
export function rawLedger(ruleId) {
  return ledgers.get(ruleId) ?? null;
}
