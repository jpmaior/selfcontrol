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
  createUsage,
  fold,
  lockIn,
  normalizeUsage,
  passActive,
  passesLeft,
  startPass,
  usedInPeriod,
  windowOf,
} from "../common/accountant.js";
import { startOfDay, startOfWeek } from "../common/calendar.js";
import { canUsePass, creditInUse, evaluate, holdAfter, lockInAmount, lockInPreview } from "../common/policy.js";
import { log, warn } from "./log.js";
import { clock } from "../common/format.js";
import { usageKey } from "../common/settings.js";

/**
 * How often an open interval is folded into the ledger and flushed
 * (DESIGN.md §5). Also bounds the sleep clamp: a suspended machine can never
 * credit more than one and a half checkpoints in a single commit.
 */
export const CHECKPOINT_MS = 5 * 60_000;
export const MAX_CHUNK_MS = 1.5 * CHECKPOINT_MS;

const openKey = (ruleId) => `open:${ruleId}`;

/** ruleId -> usage ledger */
const ledgers = new Map();

/** ruleId -> epoch ms the current open interval began */
const openSince = new Map();

/** Rules whose ledger has changed since the last flush. */
const dirty = new Set();

/** Observable counters, so a test can verify writes are actually rare (DESIGN.md §6). */
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

/**
 * Rebuild the ledger from storage. Runs on EVERY event page start, not just on
 * install — that is the whole point.
 */
export async function load(rules) {
  // A settings save enqueues stopCounting/flush writes just before reloading;
  // reading around the queue would rebuild the ledger from pre-flush data and
  // the next flush would overwrite the interval that was settling.
  await settled();

  const local = await browser.storage.local.get(rules.map((rule) => usageKey(rule.id)));
  for (const rule of rules) {
    // normalizeUsage fills in what an older build did not store, the way
    // withDefaults does for rules; a malformed value starts fresh.
    ledgers.set(rule.id, normalizeUsage(local[usageKey(rule.id)]));
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
 * Make the open interval agree with what is true now: open while the observers
 * say the rule is in use (`inUse`) and it is not spent, closed otherwise. The
 * one place that decides whether a rule counts (DESIGN.md §7), called whenever
 * either half of that can change.
 *
 * A spent rule never counts: an interval open when the rule runs out closes at
 * that instant, and one opens again only once the rule is not spent (its
 * unlock, a pass, a looser rule). Otherwise the moment a tab spends on a blocked
 * site before the guard redirects it is credited, and moves the unlock time the
 * block page had promised.
 *
 * Closing credits right up to `now`, which is also how an interval left open
 * when the event page died is settled at startup. The stop that left it is what
 * woke us, so `now` is within startup latency of the truth. An earlier version
 * credited only up to the last flush, reasoning that the stop time was unknown.
 * It is not: a browser exit clears storage.session (so there is no interval
 * left to settle), and every other stop — pause, ending, tab closed, a quiet
 * stretch dropping `audible` — is itself the waking event. The cautious version
 * discarded up to a whole checkpoint per stop, and a video with silent gaps
 * stops many times; a 7-minute video showed as exactly 5:00 (2026-09-05).
 * settle() applies the sleep clamp, so a suspended machine still cannot credit
 * more than MAX_CHUNK_MS here, and credits only up to the instant the rule ran
 * out, for a close that comes late (a frozen Firefox on Android, a sleeping
 * laptop): what came after it is time a spent rule does not count (#35).
 *
 * Returns the milliseconds credited, or 0 if nothing was closed.
 */
export function reconcile(rule, nowMs, inUse) {
  // status() projects the open interval, so this asks whether the rule is spent
  // with everything up to now counted.
  if (inUse && !status(rule, nowMs).exhausted) {
    // Open again, but the open interval ran out on the way and came back while
    // nobody was looking, a late alarm's drip-feed or midnight: settle it up to
    // where it ran out, and count again from now.
    if (openSince.has(rule.id) && projection(rule, nowMs).ranOutAtMs !== null) {
      return checkpointRule(rule, nowMs);
    }
    startCounting(rule, nowMs);
    return 0;
  }
  return stopCounting(rule, nowMs);
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

/** The open interval, from `sinceMs`, in memory and in storage.session. */
function setOpen(ruleId, sinceMs) {
  openSince.set(ruleId, sinceMs);
  stats.sessionWrites++;
  enqueue(() => browser.storage.session.set({ [openKey(ruleId)]: sinceMs }));
}

function clearOpen(ruleId) {
  openSince.delete(ruleId);
  stats.sessionWrites++;
  enqueue(() => browser.storage.session.remove(openKey(ruleId)));
}

/** Open an interval. Idempotent — a rule already counting keeps its start time. */
export function startCounting(rule, nowMs) {
  if (!openSince.has(rule.id)) setOpen(rule.id, nowMs);
}

/** Close the open interval and fold it in. Returns the milliseconds credited. */
export function stopCounting(rule, nowMs) {
  const since = openSince.get(rule.id);
  if (since === undefined) return 0;
  clearOpen(rule.id);
  return settle(rule, since, nowMs).creditedMs;
}

/**
 * Fold an open interval in *without* closing it, so a long session is never one
 * enormous unrecorded stretch. Returns the milliseconds credited.
 *
 * Unless the rule ran out on the way, which only a late checkpoint can find
 * (both alarms were due while Firefox was frozen, and this one fired first):
 * then it is closed if the rule is still spent, as the rule's alarm would have
 * closed it (DESIGN.md §7). Left open past that instant, the rule's alarm would
 * credit the moments from here to its own firing, and those few milliseconds,
 * in a newer bucket, would move the unlock.
 */
export function checkpointRule(rule, nowMs) {
  const since = openSince.get(rule.id);
  if (since === undefined) return 0;

  const { creditedMs, ranOutAtMs } = settle(rule, since, nowMs);
  if (ranOutAtMs !== null && evaluate(rule, ledgerFor(rule.id), nowMs).exhausted) clearOpen(rule.id);
  else setOpen(rule.id, nowMs);
  return creditedMs;
}

/**
 * Spend the rest of the rule's budget on purpose (DESIGN.md §16). The open
 * interval is closed first, so it is credited exactly once, and not reopened:
 * the rule is spent from here, and a spent rule never counts (§7), so the sweep
 * that follows costs nothing. Returns the milliseconds locked in.
 */
export function lockInRule(rule, nowMs) {
  stopCounting(rule, nowMs);
  const usage = ledgerFor(rule.id);
  const amount = lockInAmount(rule, usage, nowMs);
  const active = passActive(usage, nowMs);
  if (amount <= 0 && !active) return 0;

  lockIn(usage, nowMs, amount); // ends the pass too, if one is active
  fold(usage, nowMs, rule.windowSec * 1000);
  dirty.add(rule.id);
  return amount;
}

/**
 * Use one of this week's passes (DESIGN.md §17). The open interval is
 * checkpointed first so the time before the click stays ordinary usage and
 * only what follows accrues under the pass. Returns false when refused.
 */
export function usePassOnRule(rule, nowMs) {
  checkpointRule(rule, nowMs);
  const usage = ledgerFor(rule.id);
  if (!canUsePass(rule, usage, nowMs)) return false;
  startPass(usage, rule, nowMs);
  dirty.add(rule.id);
  return true;
}

/** Credit an interval of use to the ledger: `{ creditedMs, ranOutAtMs }`. */
function settle(rule, fromMs, toMs) {
  const usage = ledgerFor(rule.id);
  const result = creditInUse(rule, usage, fromMs, toMs, { maxChunkMs: MAX_CHUNK_MS });
  // Only a bug in policy.evaluate() gets here, and the rule is then charged as
  // if it never ran out, with no hold. Here and not in projection(), which the
  // popup reads every second: the settle that follows says it once.
  if (result.stoppedAtLimit) {
    warn(`${rule.id}: gave up crediting at the step limit, +${clock(result.creditedMs)} of ${clock(toMs - fromMs)}`);
  }
  fold(usage, toMs, rule.windowSec * 1000);
  dirty.add(rule.id);
  return result;
}

// --- flushing ------------------------------------------------------------

/**
 * Write every changed ledger to storage.local. Called at checkpoints, at
 * transitions, and on suspend — never on a timer, and never during playback.
 * Returns the number of rule keys written.
 */
export function flush() {
  if (dirty.size === 0) return 0;

  const payload = {};
  for (const ruleId of dirty) payload[usageKey(ruleId)] = ledgerFor(ruleId);
  const count = dirty.size;
  dirty.clear();

  stats.localWrites++;
  stats.keysWritten += count;
  enqueue(() => browser.storage.local.set(payload));

  return count;
}

/** Forget a rule entirely: its ledger, its open interval and both their keys. */
function forget(ruleId) {
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

/**
 * Forget every rule in `before` that `next` leaves out, and return their ids.
 * `before` is the set the save replaced, as storage reported it, and may also
 * name the set the event page last held: when the save is what woke the page,
 * that is already the new one, and comparing with it alone finds nothing
 * removed (#54). A rule in `next` is never forgotten, whichever set names it.
 */
export function forgetRemoved(before, next) {
  const keep = new Set(next.map((rule) => rule.id));
  const removed = [...new Set(before.map((rule) => rule.id))].filter((id) => !keep.has(id));
  for (const id of removed) forget(id);
  return removed;
}

/**
 * Forget any usage or open interval that belongs to no rule in `rules`, and
 * return those ids. Run once per start, before anything can write a ledger,
 * with the rules just loaded: a deletion whose settings event was missed, or
 * one from a build that missed it (#54), would otherwise hand its history to
 * the next rule minted with the same id (DESIGN.md §6).
 */
export async function sweep(rules) {
  await settled();
  const ids = new Set(rules.map((rule) => rule.id));
  const [local, session] = await Promise.all([
    browser.storage.local.get(null),
    browser.storage.session.get(null),
  ]);
  const orphans = new Set();
  for (const [area, prefix] of [
    [local, usageKey("")],
    [session, openKey("")],
  ]) {
    for (const key of Object.keys(area)) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!ids.has(id)) orphans.add(id);
    }
  }
  for (const id of orphans) forget(id);
  if (orphans.size > 0) log(`swept usage of deleted rule(s): ${[...orphans].join(", ")}`);
  return [...orphans];
}

// --- reading -------------------------------------------------------------

/**
 * A read-only projection of the ledger that includes the currently open
 * interval, credited as settle() would credit it, so live readings are honest
 * between checkpoints. Never written back. `ranOutAtMs` is where the open
 * interval ran out, if it did.
 */
function projection(rule, nowMs) {
  const usage = ledgerFor(rule.id);
  const since = openSince.get(rule.id);
  if (since === undefined) return { usage, ranOutAtMs: null };
  const copy = { ...usage, b: { ...usage.b }, p: { ...usage.p } };
  const { ranOutAtMs } = creditInUse(rule, copy, since, nowMs, { maxChunkMs: MAX_CHUNK_MS });
  return { usage: copy, ranOutAtMs };
}

/**
 * Keep the ledger's `blockedUntil` in step with the rolling cap (DESIGN.md §8):
 * set when a block is seen, moved when its unlock instant moves (a settings
 * change), cleared once the rule reopens. It lives here because every decision
 * passes through status() — the alarm at the instant the budget runs out, the
 * re-open guard, the popup — so a block cannot be acted on without being
 * recorded. Flushed at once: it
 * changes once per block and once per unlock, and losing it to a killed event
 * page would bring the drip-feed back.
 *
 * Only from the ledger itself, never from a projection: while an interval is
 * open, the settle that closes it records the hold, at the instant the rule
 * ran out (policy.creditInUse). A projected hold written first made that
 * settle find the rule held at the interval's start and credit all of it,
 * late time included, whenever less than the unlock credit was left (#53).
 *
 * Left alone during a pass, which suspends the rolling cap: its unlock instant
 * moves every minute the pass is used, and the alarm at the pass end
 * records the hold that follows it.
 */
function syncHold(rule, decision, nowMs) {
  // A rule that blocks outright has no rolling cap to hold, and a hold already
  // recorded is kept, so setting the budget to zero and back mid-block does not
  // lift it (DESIGN.md §22).
  const next = holdAfter(decision);
  if (next === undefined) return;
  const usage = ledgerFor(rule.id);
  if (usage.blockedUntil === next) return;
  usage.blockedUntil = next;
  dirty.add(rule.id);
  flush();
}

/** Used and pass time since a local period start, for the popup. */
function period(usage, startMs) {
  const all = usedInPeriod(usage, startMs);
  const used = usedInPeriod(usage, startMs, { includePass: false });
  return { usedMs: used, passMs: all - used };
}

/**
 * Everything a popup, block page or enforcer needs to know about one rule.
 * The decision itself is policy.evaluate(); this adds identity, the rolling
 * meter's numbers and the calendar totals.
 */
export function status(rule, nowMs) {
  const { usage } = projection(rule, nowMs);
  const counting = openSince.has(rule.id);
  const decision = evaluate(rule, usage, nowMs, { counting });
  if (!counting) syncHold(rule, decision, nowMs);

  return {
    id: rule.id,
    label: rule.label,
    mode: rule.mode,
    counting,
    // A rule that blocks outright has no rolling cap, and no time to show.
    usedMs: decision.caps.rolling?.usedMs ?? 0,
    budgetMs: decision.caps.rolling?.budgetMs ?? 0,
    windowMs: windowOf(rule).windowMs,
    lockIn: lockInPreview(rule, usage, nowMs),
    passOffer: canUsePass(rule, usage, nowMs)
      ? { left: passesLeft(rule, usage, nowMs), durationMs: rule.passes.durationSec * 1000 }
      : null,
    ...decision,
    today: period(usage, startOfDay(nowMs)),
    week: period(usage, startOfWeek(nowMs)),
  };
}

export function describe(rule, nowMs) {
  const s = status(rule, nowMs);
  return `${s.id}: ${clock(s.usedMs)} / ${clock(s.budgetMs)} used (${s.counting ? "counting" : "idle"})`;
}
