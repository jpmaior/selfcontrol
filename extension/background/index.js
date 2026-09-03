// Background event page.
//
// Wiring and lifecycle. The observers say when a rule is being consumed, the
// store accrues and persists it, the enforcer acts when it runs out, and the
// message channel serves the block page and the popup.

import { log } from "./log.js";
import { isCountingNow, platform, setRules, start } from "./observers.js";
import { clock } from "../common/format.js";
import { loadRules, onRulesChanged, saveRules } from "../common/settings.js";
import { validateRule } from "../common/rules.js";
import { enforceRule, guardTab, ruleIdFromAlarm, syncExhaustionAlarm } from "./enforcer.js";
import {
  CHECKPOINT_MS,
  anyCounting,
  checkpointRule,
  describe,
  flush,
  forget,
  load,
  reconcile,
  settled,
  startCounting,
  stats,
  status,
  stopCounting,
} from "./store.js";

const CHECKPOINT_ALARM = "checkpoint";

/** Replaced wholesale when the options page saves; never mutated in place. */
let rules = [];

log(`event page started — v${browser.runtime.getManifest().version}`);

// Kicked off synchronously so the promise exists before any listener can fire.
const loaded = (async () => {
  rules = await loadRules();
  await load(rules);
})();

// Not awaited, and deliberately started with an empty rule set: an MV3 event
// page is restarted *by* an event, so its listeners must exist by the end of
// synchronous module evaluation, which is sooner than storage can answer. The
// real rules arrive via setRules() below, which re-primes.
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
    await setRules(rules);
    await settleAndArm("startup");
    const info = await browser.runtime.getPlatformInfo();
    log(
      `ready on ${info.os} — ${rules.length} rule(s),`,
      `window focus events: ${platform.canTrackWindowFocus ? "yes" : "NO (Android)"}.`,
      "dumpUsage(), dumpStats(), dumpPlatform(), dumpRaw(), setLimits()",
    );
  })
  .catch((error) => log("startup failed:", error));

/**
 * Settle any interval left open by a previous run, then bring alarms and
 * enforcement back in step with reality. Shared by startup and by a settings
 * change, since both leave the same question open: what is true right now?
 */
async function settleAndArm(why) {
  const now = Date.now();

  for (const rule of rules) {
    const credited = reconcile(rule, now, isCountingNow(rule.id));
    if (credited > 0) {
      log(`reconciled ${rule.id}: credited ${clock(credited)} left open by a previous run`);
    }
  }
  flush(now);

  await syncCheckpointAlarm();
  for (const rule of rules) {
    // A rule may have run out while we were unloaded, or have just been given
    // a smaller budget than it has already spent.
    await enforceRule(rule, now);
    await syncExhaustionAlarm(rule, now);
  }
  log(`state re-armed (${why})`);
}

// --- settings ------------------------------------------------------------

// The options page writes storage; we react. No message protocol needed, and
// it works the same whether the edit came from the options page or the console.
onRulesChanged(async (next) => {
  await loaded;
  const now = Date.now();

  // Close out the old set before swapping, or an open interval would be
  // credited against a rule that no longer exists.
  for (const rule of rules) stopCounting(rule, now);
  flush(now);

  for (const old of rules) {
    if (!next.some((r) => r.id === old.id)) {
      forget(old.id);
      log(`rule removed: ${old.id} — usage discarded`);
    }
  }

  rules = next;
  await load(rules);
  await setRules(rules);
  await settleAndArm("settings changed");
  log(`rules updated — now ${rules.length}: ${rules.map((r) => r.id).join(", ")}`);
});

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

  // Measures the open question in DESIGN.md §5: does Firefox honour sub-minute
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

// Serves the block page and the popup. Deliberately NOT an async listener: a
// listener that returns a promise claims the response channel for every
// message, so only the branch we actually answer returns one.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== "status") return undefined;
  return (async () => {
    await loaded;
    const now = Date.now();
    return rules.map((rule) => status(rule, now));
  })();
});

browser.runtime.onSuspend.addListener(() => {
  log("event page suspending — flushing");
  flush(Date.now());
  return settled();
});

// --- console handles -----------------------------------------------------

/**
 * Quick budget tweaks without opening the options page. Writes the same
 * `settings` key, so it travels the same onRulesChanged path an edit does —
 * and passes the same validation, or a console typo like `budgetSec: 0` would
 * persist a rule the options page refuses to save.
 */
globalThis.setLimits = async (ruleId, patch) => {
  await loaded;
  if (!rules.some((r) => r.id === ruleId)) return `no such rule: ${ruleId}`;
  const next = rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r));
  const errors = validateRule(next.find((r) => r.id === ruleId), next);
  if (errors.length > 0) return errors;
  await saveRules(next);
  return `${ruleId} updated`;
};

globalThis.resetRules = async () => {
  await browser.storage.local.remove("settings");
  return "settings cleared — reload the extension to re-seed the defaults";
};

globalThis.resetUsage = async () => {
  await browser.storage.local.remove(rules.map((r) => `usage:${r.id}`));
  await browser.storage.session.clear();
  return "usage cleared — reload the extension";
};

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

/**
 * What this build of Firefox actually gives us. Android reduces or omits parts
 * of the API surface, and MDN's compatibility tables are easier to trust once
 * you have checked the device in front of you.
 */
globalThis.dumpPlatform = async () => {
  const info = await browser.runtime.getPlatformInfo();
  const report = {
    os: info.os,
    arch: info.arch,
    windowFocusEvents: platform.canTrackWindowFocus,
    "storage.session": Boolean(browser.storage?.session),
    alarms: Boolean(browser.alarms),
    idle: Boolean(browser.idle),
    notifications: Boolean(browser.notifications),
    "tabs.onUpdated filters": Boolean(browser.tabs?.onUpdated),
    sidebarAction: Boolean(browser.sidebarAction),
    commands: Boolean(browser.commands),
  };
  console.table(report);
  return report;
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
