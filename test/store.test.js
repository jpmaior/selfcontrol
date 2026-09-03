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

test("reconcile: a dead interval settles only up to the last proven flush", async () => {
  const r = rule("dead");
  await session.set({ "open:dead": T0 });
  await local.set({ "meta:lastFlush": T0 + 2 * MIN });
  await load([r]);

  // Playback stopped at an unknown moment while we were unloaded; credit only
  // what we can prove, not the whole stretch to now.
  assert.equal(reconcile(r, T0 + 30 * MIN, false), 2 * MIN);
  assert.ok(!hasOpenInterval(r.id));
  assert.equal(status(r, T0 + 30 * MIN).usedMs, 2 * MIN);

  await settled();
  assert.ok(!session.data.has("open:dead"), "the session key is cleaned up");
});

test("reconcile: a last flush before the interval opened credits nothing", async () => {
  const r = rule("stale");
  await session.set({ "open:stale": T0 });
  await local.set({ "meta:lastFlush": T0 - 10 * MIN });
  await load([r]);

  assert.equal(reconcile(r, T0 + 30 * MIN, false), 0);
});

test("checkpoint clamps a sleep gap to 1.5 checkpoints", async () => {
  const r = rule("sleeper");
  await local.set({ "meta:lastFlush": 0 });
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

test("flush persists ledgers and the last-flush marker through the queue", async () => {
  const r = rule("flushed");
  await load([r]);

  startCounting(r, T0);
  stopCounting(r, T0 + 3 * MIN);
  flush(T0 + 3 * MIN);
  await settled();

  assert.equal(local.data.get("meta:lastFlush"), T0 + 3 * MIN);
  const stored = local.data.get("usage:flushed");
  const total = Object.values(stored.b).reduce((a, ms) => a + ms, 0);
  assert.equal(total, 3 * MIN);
});
