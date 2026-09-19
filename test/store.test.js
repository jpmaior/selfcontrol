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
      for (const key of Array.isArray(keys) ? keys : [keys]) {
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
  hasOpenInterval,
  load,
  lockInRule,
  reconcile,
  settled,
  startCounting,
  status,
  stopCounting,
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
  flush(T0 + 5 * MIN);

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
  // a 7-minute video showed as exactly 5:00 (TODO.md, 2026-09-05).
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
  assert.equal(checkpointRule(r, T0 + 3 * 60 * MIN), MAX_CHUNK_MS);
  assert.equal(MAX_CHUNK_MS, 1.5 * CHECKPOINT_MS);
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
  flush(T0 + 2 * 60 * MIN + MIN);
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
  flush(T0 + MIN);
  await settled();
  const stored = local.data.get("usage:legacy");
  assert.deepEqual(Object.keys(stored).sort(), ["b", "d", "p", "pass", "passUses"]);
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
  assert.ok(hasOpenInterval(r.id), "the interval stays open; the observers close it");
  const s = status(r, now);
  assert.equal(s.usedMs, 20 * MIN, "3 counted + 17 locked, not 3 + 3 + 17");
  assert.equal(s.exhausted, true);

  flush(now);
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

test("flush persists ledgers through the queue", async () => {
  const r = rule("flushed");
  await load([r]);

  startCounting(r, T0);
  stopCounting(r, T0 + 3 * MIN);
  flush(T0 + 3 * MIN);
  await settled();

  const stored = local.data.get("usage:flushed");
  const total = Object.values(stored.b).reduce((a, ms) => a + ms, 0);
  assert.equal(total, 3 * MIN);
});
