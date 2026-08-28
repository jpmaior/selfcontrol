// Background event page.
//
// Step 4 (PLAN.md): the ledger now survives. Committed usage lives in
// storage.local, the currently open interval in storage.session, and startup
// reconciles the two against what the observers actually see (DESIGN.md §6).
//
// Still no enforcement — nothing blocks or closes anything yet. That is Step 5.

import { log } from "./log.js";
import { DEFAULT_RULES } from "./rules.js";
import { isCountingNow, start } from "./observers.js";
import {
  CHECKPOINT_MS,
  anyCounting,
  checkpointRule,
  clock,
  describe,
  flush,
  load,
  reconcile,
  settled,
  startCounting,
  stats,
  status,
  stopCounting,
} from "./store.js";

const CHECKPOINT_ALARM = "checkpoint";

log(`event page started — v${browser.runtime.getManifest().version}`);

// Kicked off synchronously so the promise exists before any listener can fire.
const loaded = load(DEFAULT_RULES);

// Not awaited: an MV3 event page is restarted *by* an event, so its listeners
// must exist by the end of synchronous module evaluation. start() attaches all
// of its listeners before its first await; the promise covers only the rebuild
// of derived state from the open tabs.
const primed = start({
  rules: DEFAULT_RULES,
  async onChange(rule, counting, why) {
    // A transition can arrive before the ledger has finished loading. Ordering
    // is preserved: handlers resume from this await in the order they hit it.
    await loaded;
    const now = Date.now();

    if (counting) {
      startCounting(rule, now);
      log("▶ COUNTING", `${rule.id} (${rule.mode})`, `— ${why}`);
    } else {
      const credited = stopCounting(rule, now);
      flush(now); // a transition is a natural, and infrequent, write point
      log("■ stopped  ", `${rule.id} (${rule.mode})`, `— ${why}`, `+${clock(credited)}`);
    }

    log("   ", describe(rule, now));
    syncCheckpointAlarm();
  },
});

// Settle intervals left open when the event page was last killed. This can only
// run once both the ledger is loaded and the observers know the current truth.
Promise.all([loaded, primed])
  .then(() => {
    const now = Date.now();
    for (const rule of DEFAULT_RULES) {
      const credited = reconcile(rule, now, isCountingNow(rule.id));
      if (credited > 0) {
        log(`reconciled ${rule.id}: credited ${clock(credited)} left open by a previous run`);
      }
    }
    flush(now);
    syncCheckpointAlarm();
    log("ready — dumpUsage(), dumpStats(), dumpRaw()");
  })
  .catch((error) => log("startup failed:", error));

// --- checkpoints ---------------------------------------------------------

// The alarm exists only while something is actually being counted. A periodic
// alarm firing all day would wake the event page for nothing.
//
// Note the existence check: alarms.create() REPLACES an alarm of the same name
// and restarts its period. Since the event page can be unloaded and restarted
// mid-playback — and this runs on every start — recreating it unconditionally
// would let a busy session postpone its own checkpoint indefinitely.
async function syncCheckpointAlarm() {
  const existing = await browser.alarms.get(CHECKPOINT_ALARM);
  if (anyCounting()) {
    if (!existing) {
      browser.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: CHECKPOINT_MS / 60_000 });
    }
  } else if (existing) {
    browser.alarms.clear(CHECKPOINT_ALARM);
  }
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CHECKPOINT_ALARM) return;
  await loaded;

  const now = Date.now();
  for (const rule of DEFAULT_RULES) {
    const credited = checkpointRule(rule, now);
    if (credited > 0) log(`checkpoint: ${rule.id} +${clock(credited)}`);
  }
  const written = flush(now);
  if (written > 0) log(`flushed ${written} ledger(s) — ${stats.localWrites} local writes so far`);
  syncCheckpointAlarm();
});

// Best-effort: Firefox does fire this for event pages, but the checkpoint alarm
// is the real guarantee. Worst case a crash loses one checkpoint interval.
browser.runtime.onSuspend.addListener(() => {
  log("event page suspending — flushing");
  flush(Date.now());
  return settled();
});

// --- console handles for Checkpoint 4 ------------------------------------

globalThis.dumpUsage = (ruleId) => {
  const now = Date.now();
  const rules = ruleId ? DEFAULT_RULES.filter((r) => r.id === ruleId) : DEFAULT_RULES;
  const table = rules.map((rule) => {
    const s = status(rule, now);
    return {
      rule: s.id,
      mode: s.mode,
      counting: s.counting,
      used: clock(s.usedMs),
      budget: clock(s.budgetMs),
      remaining: clock(s.remainingMs),
    };
  });
  console.table(table);
  return table;
};

/** Write counters — the point of Checkpoint 4 is that these stay small. */
globalThis.dumpStats = () => {
  console.table({ ...stats, countingNow: anyCounting() });
  return { ...stats };
};

/** What is actually sitting in storage right now. */
globalThis.dumpRaw = async () => {
  const local = await browser.storage.local.get(null);
  const session = await browser.storage.session.get(null);
  console.log("storage.local  ", local);
  console.log("storage.session", session);
  const bytes = new TextEncoder().encode(JSON.stringify(local)).length;
  console.log(`storage.local is ${bytes} bytes of JSON`);
  return { local, session, bytes };
};
