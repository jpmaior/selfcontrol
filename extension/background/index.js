// Background event page.
//
// Wiring and lifecycle. The observers say when a rule is being consumed, the
// store accrues and persists it, the enforcer acts when it runs out, and the
// message channel serves the block page and the popup.

import { log } from "./log.js";
import { DEFAULT_RULES } from "./rules.js";
import { isCountingNow, start } from "./observers.js";
import { clock } from "../common/format.js";
import {
  enforceRule,
  guardTab,
  ruleIdFromAlarm,
  syncExhaustionAlarm,
} from "./enforcer.js";
import {
  CHECKPOINT_MS,
  anyCounting,
  checkpointRule,
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
const LIMITS_KEY = "debug:limits";

let rules = DEFAULT_RULES;

log(`event page started — v${browser.runtime.getManifest().version}`);

// Kicked off synchronously so the promise exists before any listener can fire.
const loaded = (async () => {
  await applyStoredLimits();
  await load(rules);
})();

// Not awaited: an MV3 event page is restarted *by* an event, so its listeners
// must exist by the end of synchronous module evaluation. start() attaches all
// of its listeners before its first await.
const primed = start({
  rules,
  async onChange(rule, counting, why) {
    await loaded;
    const now = Date.now();

    if (counting) {
      startCounting(rule, now);
      log("▶ COUNTING", `${rule.id} (${rule.mode})`, `— ${why}`);
      // A rule can start counting while already spent (the tab was opened
      // before the block landed), so check before scheduling.
      await enforceRule(rule, now);
    } else {
      const credited = stopCounting(rule, now);
      flush(now);
      log("■ stopped  ", `${rule.id} (${rule.mode})`, `— ${why}`, `+${clock(credited)}`);
    }

    log("   ", describe(rule, now));
    await Promise.all([syncCheckpointAlarm(), syncExhaustionAlarm(rule, now)]);
  },
});

Promise.all([loaded, primed])
  .then(async () => {
    const now = Date.now();
    for (const rule of rules) {
      const credited = reconcile(rule, now, isCountingNow(rule.id));
      if (credited > 0) {
        log(`reconciled ${rule.id}: credited ${clock(credited)} left open by a previous run`);
      }
    }
    flush(now);

    await syncCheckpointAlarm();
    // A rule may have run out while we were unloaded; sweep before waiting.
    for (const rule of rules) {
      await enforceRule(rule, now);
      await syncExhaustionAlarm(rule, now);
    }
    log("ready — dumpUsage(), dumpStats(), dumpRaw(), setLimits()");
  })
  .catch((error) => log("startup failed:", error));

// --- enforcement hooks ---------------------------------------------------

// Same guard on both events: onCreated covers "open it in a new tab", onUpdated
// covers navigating an existing one. Together they are what makes a spent rule
// stay spent (DESIGN.md §7).
browser.tabs.onCreated.addListener(async (tab) => {
  await loaded;
  await guardTab(rules, tab, Date.now());
});

browser.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
    await loaded;
    await guardTab(rules, tab, Date.now());
  },
  { properties: ["url"] },
);

// --- alarms --------------------------------------------------------------

// alarms.create() REPLACES an alarm of the same name and restarts its period.
// The event page can be unloaded and restarted mid-playback, and this runs on
// every start, so recreating it unconditionally would let a busy session
// postpone its own checkpoint indefinitely.
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
  await loaded;
  const now = Date.now();

  if (alarm.name === CHECKPOINT_ALARM) {
    for (const rule of rules) {
      const credited = checkpointRule(rule, now);
      if (credited > 0) log(`checkpoint: ${rule.id} +${clock(credited)}`);
    }
    const written = flush(now);
    if (written > 0) log(`flushed ${written} ledger(s) — ${stats.localWrites} local writes total`);
    await syncCheckpointAlarm();
    for (const rule of rules) await syncExhaustionAlarm(rule, now);
    return;
  }

  const ruleId = ruleIdFromAlarm(alarm.name);
  if (!ruleId) return;
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return;

  // Resolves the open question in DESIGN.md §5: does Firefox honour sub-minute
  // alarm delays, or clamp them the way Chrome does?
  const lateness = now - alarm.scheduledTime;
  log(`exhaustion alarm for ${ruleId} fired ${lateness >= 0 ? "+" : ""}${lateness}ms vs scheduled`);

  checkpointRule(rule, now);
  flush(now);

  const acted = await enforceRule(rule, now);
  if (acted === 0) {
    // Not actually spent — the window handed budget back. Reschedule; this is
    // the "always early, never late" property doing its job.
    log(`${ruleId}: not spent after all, rescheduling`);
  }
  await syncExhaustionAlarm(rule, now);
});

// --- messaging -----------------------------------------------------------

// Serves the block page, and the popup in Step 6.
browser.runtime.onMessage.addListener(async (message) => {
  await loaded;
  if (message?.type !== "status") return undefined;
  const now = Date.now();
  return rules.map((rule) => status(rule, now));
});

browser.runtime.onSuspend.addListener(() => {
  log("event page suspending — flushing");
  flush(Date.now());
  return settled();
});

// --- limit overrides -----------------------------------------------------

// Real budgets take an hour to test. setLimits() rewrites them in place and
// persists the override, so Checkpoint 5 takes two minutes instead. Step 7
// replaces this with a proper options page.
async function applyStoredLimits() {
  const stored = (await browser.storage.local.get(LIMITS_KEY))[LIMITS_KEY];
  if (!stored) return;
  for (const rule of rules) {
    Object.assign(rule, stored[rule.id] ?? {});
  }
  log("limit overrides applied:", stored);
}

globalThis.setLimits = async (ruleId, patch) => {
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return `no such rule: ${ruleId}`;

  Object.assign(rule, patch);
  const stored = (await browser.storage.local.get(LIMITS_KEY))[LIMITS_KEY] ?? {};
  stored[ruleId] = { ...(stored[ruleId] ?? {}), ...patch };
  await browser.storage.local.set({ [LIMITS_KEY]: stored });

  const now = Date.now();
  await enforceRule(rule, now);
  await syncExhaustionAlarm(rule, now);
  log(`limits for ${ruleId}:`, patch);
  return status(rule, now);
};

globalThis.resetLimits = async () => {
  await browser.storage.local.remove(LIMITS_KEY);
  return "cleared — reload the extension to restore defaults";
};

globalThis.resetUsage = async () => {
  await browser.storage.local.remove(rules.map((r) => `usage:${r.id}`));
  await browser.storage.session.clear();
  return "usage cleared — reload the extension";
};

// --- console handles -----------------------------------------------------

globalThis.dumpUsage = (ruleId) => {
  const now = Date.now();
  const chosen = ruleId ? rules.filter((r) => r.id === ruleId) : rules;
  const table = chosen.map((rule) => {
    const s = status(rule, now);
    return {
      rule: s.id,
      mode: s.mode,
      counting: s.counting,
      used: clock(s.usedMs),
      budget: clock(s.budgetMs),
      remaining: clock(s.remainingMs),
      unlocksIn: s.exhausted ? clock(s.unlockAtMs - now) : "-",
    };
  });
  console.table(table);
  return table;
};

globalThis.dumpStats = () => {
  console.table({ ...stats, countingNow: anyCounting() });
  return { ...stats };
};

globalThis.dumpRaw = async () => {
  const local = await browser.storage.local.get(null);
  const session = await browser.storage.session.get(null);
  console.log("storage.local  ", local);
  console.log("storage.session", session);
  const bytes = new TextEncoder().encode(JSON.stringify(local)).length;
  console.log(`storage.local is ${bytes} bytes of JSON`);
  return { local, session, bytes };
};
