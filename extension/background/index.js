// Background event page.
//
// Wiring and lifecycle. The observers say when a rule is being consumed, the
// store accrues and persists it, the enforcer acts when it runs out, and the
// message channel serves the block page and the popup.

import { log } from "./log.js";
import { isCountingNow, modeOf, onTabUpdated, platform, setRules, start } from "./observers.js";
import { WEEKDAYS, clock, countdown, wallClock } from "../common/format.js";
import { loadRules, loadSettings, onRulesChanged, saveRules, saveSettings, usageKey } from "../common/settings.js";
import { blocksOutright, ruleFrom, validateRule } from "../common/rules.js";
import { clearRemovedAlarms, enforceRule, guardTab, ruleIdFromAlarm, syncRuleAlarm } from "./enforcer.js";
import { lastTabClosesWindow } from "../common/platform.js";
import { needsTabAfterUpdate, windowsAnUpdateCloses } from "../common/tabs.js";
import {
  CHECKPOINT_MS,
  anyCounting,
  checkpointRule,
  decide,
  describe,
  flush,
  forgetRemoved,
  hasOpenInterval,
  load,
  loadNew,
  lockInRule,
  reconcile,
  setWeek,
  settled,
  stats,
  status,
  stopCounting,
  sweep,
  usePassOnRule,
} from "./store.js";

const CHECKPOINT_ALARM = "checkpoint";

/** Replaced wholesale when the options page saves; never mutated in place. */
let rules = [];

log(`event page started — v${browser.runtime.getManifest().version}`);

// --- one queue -----------------------------------------------------------

/**
 * Every handler that changes state runs through here, one at a time and in
 * the order its event arrived, and only once the event page is ready
 * (DESIGN.md §7, "One queue"). The alarms, the observers' reports, the
 * messages, the settings change and the navigation guard all reach the same
 * ledgers, alarms and tabs, often on the same wake-up; side by side, each
 * could act on what another was halfway through changing.
 *
 * Returns the task's own promise. The queue itself carries on past a task
 * that fails, and the event page holds nothing that an unload would lose: a
 * task cut short leaves its writes queued in the store, as before.
 */
let tail = Promise.resolve();
function inOrder(task) {
  const run = tail.then(async () => {
    await ready;
    return task();
  });
  tail = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Not awaited, and deliberately started with an empty rule set: an MV3 event
// page is restarted *by* an event, so its listeners must exist by the end of
// synchronous module evaluation, which is sooner than storage can answer. The
// real rules arrive via setRules() in `ready`, which re-primes.
const primed = start({
  rules,
  onChange(rule, inUse, why) {
    return inOrder(() => onCountingChange(rule, inUse, why));
  },
});

/**
 * The rules loaded, their ledgers too, the observers primed with them and
 * every rule settled: what every handler waits for. Kicked off synchronously
 * so the promise exists before any listener can fire.
 */
const ready = (async () => {
  let week;
  ({ rules, week } = await loadSettings());
  setWeek(week);
  await load(rules);
  // Before any handler can write a ledger or sync an alarm, so nothing either
  // removes is live.
  await sweep(rules);
  const alarms = await clearRemovedAlarms(rules);
  if (alarms.length > 0) log(`cleared the alarm of deleted rule(s): ${alarms.join(", ")}`);
  await primed;
  await setRules(rules);
  await settleAndArm("startup");
})();

ready
  .then(async () => {
    const info = await browser.runtime.getPlatformInfo();
    log(
      `ready on ${info.os} — ${rules.length} rule(s),`,
      `window focus events: ${platform.canTrackWindowFocus ? "yes" : "NO (Android)"}.`,
      "dumpUsage(), dumpStats(), dumpPlatform(), dumpRaw(), addRule(), setLimits(), setWeekStart()",
    );
  })
  .catch((error) => log("startup failed:", error));

/** The current rule with this id: a report or a message may name one a save has replaced. */
const ruleById = (id) => rules.find((r) => r.id === id);

/** The observers say whether a rule is in use; reconcile it, and sweep if it is spent. */
async function onCountingChange(reported, inUse, why) {
  const rule = ruleById(reported.id);
  if (!rule) return;
  const now = Date.now();

  // In use counts only while the rule is not spent (DESIGN.md §7): going back
  // into a blocked site opens nothing, so the moment before the guard
  // redirects the tab cannot move the unlock time.
  const credited = reconcile(rule, now, inUse);
  flush();
  const name = `${rule.id} (${modeOf(rule)})`;
  if (hasOpenInterval(rule.id)) log("▶ COUNTING", name, `— ${why}`);
  else if (inUse) log("▷ spent, not counting", name, `— ${why}`, `+${clock(credited)}`);
  else log("■ stopped  ", name, `— ${why}`, `+${clock(credited)}`);

  // In use while spent: the tab was opened before the block landed, or came
  // back to the site. Sweep it.
  if (inUse) await enforceRule(rules, rule, now);

  log("   ", describe(rule, now));
  await Promise.all([syncCheckpointAlarm(), syncRuleAlarm(rule, now)]);
}

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
  flush();

  await syncCheckpointAlarm();
  for (const rule of rules) {
    // A rule may have run out while we were unloaded, or have just been given
    // a smaller budget than it has already spent.
    await enforceRule(rules, rule, now);
    await syncRuleAlarm(rule, now);
  }
  log(`state re-armed (${why})`);
}

// --- settings ------------------------------------------------------------

// The options page writes storage; we react. No message protocol needed, and
// it works the same whether the edit came from the options page or the console.
onRulesChanged((next, previous, week, previousWeek) =>
  inOrder(() => onSettingsChanged(next, previous, week, previousWeek)),
);

async function onSettingsChanged(next, previous, week, previousWeek) {
  const now = Date.now();

  // The old set is the one the save replaced, not `rules`: when the save is
  // what woke the event page, `ready` has already read the new set, and
  // nothing would look removed (DESIGN.md §6). `rules` still counts, for a
  // rule it holds that the stored old set does not.
  const before = [...previous, ...rules];

  // Close out the old set before swapping, with the old limits and the old
  // week, or an open interval would be credited against a rule that no longer
  // exists. The first close of a rule wins; the rest find nothing open.
  setWeek(previousWeek);
  for (const rule of before) stopCounting(rule, now);
  flush();
  setWeek(week);
  if (week.startDay !== previousWeek.startDay) log(`weeks now start on ${WEEKDAYS[week.startDay]}`);

  for (const id of forgetRemoved(before, next)) log(`rule removed: ${id} — usage discarded`);
  for (const id of await clearRemovedAlarms(next)) log(`rule removed: ${id} — alarm cleared`);

  // Only the rules this save adds are read from storage. A kept rule's ledger
  // in memory is the truth, and the queue keeps every other handler out until
  // this one is done, so nothing can change it between here and the settle.
  rules = next;
  await loadNew(rules);
  await setRules(rules);
  await settleAndArm("settings changed");
  log(`rules updated — now ${rules.length}: ${rules.map((r) => r.id).join(", ")}`);
}

// --- enforcement hooks ---------------------------------------------------

// Same guard on both events: onCreated covers "open it in a new tab", onUpdated
// covers navigating an existing one. Together they are what makes a spent rule
// stay spent (DESIGN.md §7).
browser.tabs.onCreated.addListener((tab) => inOrder(() => guardTab(rules, tab, Date.now())));

onTabUpdated((tabId, changeInfo, tab) => inOrder(() => guardTab(rules, tab, Date.now())), ["url"]);

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

browser.alarms.onAlarm.addListener((alarm) => inOrder(() => onAlarm(alarm)));

async function onAlarm(alarm) {
  const now = Date.now();

  if (alarm.name === CHECKPOINT_ALARM) {
    // A checkpoint that fires late, after Firefox was frozen or the machine
    // slept, can find a rule ran out on the way: it closes the interval there,
    // and sweeps as the rule's own alarm, due at the same thaw, would.
    const ranOut = [];
    for (const rule of rules) {
      const wasCounting = hasOpenInterval(rule.id);
      const credited = checkpointRule(rule, now);
      if (wasCounting && !hasOpenInterval(rule.id)) {
        log(`■ ${rule.id} spent — stopped counting at the checkpoint +${clock(credited)}`);
        ranOut.push(rule);
      } else if (credited > 0) log(`checkpoint: ${rule.id} +${clock(credited)}`);
    }
    const written = flush();
    if (written > 0) log(`flushed ${written} ledger(s) — ${stats.localWrites} local writes total`);
    await syncCheckpointAlarm();
    for (const rule of ranOut) await enforceRule(rules, rule, now);
    for (const rule of rules) await syncRuleAlarm(rule, now);
    return;
  }

  const ruleId = ruleIdFromAlarm(alarm.name);
  if (!ruleId) return;
  const rule = ruleById(ruleId);
  if (!rule) return;

  // Firefox does not clamp sub-minute alarm delays the way Chrome does; this is
  // how a run checks that, against what DESIGN.md §5 records.
  const lateness = now - alarm.scheduledTime;
  log(`alarm for ${ruleId} fired ${lateness >= 0 ? "+" : ""}${lateness}ms vs scheduled`);

  // A rule that has just run out stops counting at this instant, so the sweep
  // landing is not counted; one that has just unlocked under a tab still on
  // the site starts again (DESIGN.md §7).
  const wasCounting = hasOpenInterval(ruleId);
  const credited = reconcile(rule, now, isCountingNow(ruleId));
  const counting = hasOpenInterval(ruleId);
  if (wasCounting && !counting) log(`■ ${ruleId} spent — stopped counting +${clock(credited)}`);
  if (!wasCounting && counting) log(`▶ COUNTING ${ruleId} — in use as it unlocked`);
  flush();
  await syncCheckpointAlarm();

  // The alarm fires at every instant the answer could flip: a cap running out
  // or an unlock. Enforce if spent; either way, re-sync so the next flip has
  // its alarm.
  const acted = await enforceRule(rules, rule, now);
  if (acted === 0) log(describe(rule, now));
  await syncRuleAlarm(rule, now);
}

// --- messaging -----------------------------------------------------------

// Serves the block page and the popup. Deliberately NOT an async listener: a
// listener that returns a promise claims the response channel for every
// message, so only a message we actually answer returns one.
//
// Usage is hot state owned by the background, so the popup's actions on it
// (lock in, a pass) go through here rather than through storage.
// The options page still never messages the background.
const handlers = {
  // Every rule, always: the block page reads a rule missing from this reply as
  // deleted, and unlocks (DESIGN.md §19).
  async status() {
    const now = Date.now();
    return rules.map((rule) => status(rule, now));
  },

  async lockIn({ ruleId }) {
    const rule = ruleById(ruleId);
    if (!rule) return { ok: false, error: `no such rule: ${ruleId}` };
    // The popup offers no lock-in on a spent rule, but one armed before it ran
    // out, or before its budget went to zero (DESIGN.md §22), can still be
    // confirmed. Refused when the rule is spent, which is what withholds the
    // offer (policy.canLockIn), rather than spending nothing and saying it worked.
    const now = Date.now();
    if (decide(rule, now).exhausted) {
      const error = blocksOutright(rule) ? `${rule.label} has no budget to lock in.` : `${rule.label} is already blocked.`;
      return { ok: false, error };
    }
    const ms = lockInRule(rule, now);
    flush();
    const snapshot = decide(rule, now);
    log(
      `🔒 locked in ${rule.id}: spent ${clock(ms)} on purpose,`,
      `blocked until ${wallClock(snapshot.unlockAtMs, now)} (${snapshot.reason})`,
    );
    await enforceRule(rules, rule, now);
    // lockInRule closed the interval: the rule is spent now.
    await Promise.all([syncCheckpointAlarm(), syncRuleAlarm(rule, now)]);
    return { ok: true, ms };
  },

  async usePass({ ruleId }) {
    const rule = ruleById(ruleId);
    if (!rule) return { ok: false, error: `no such rule: ${ruleId}` };
    const now = Date.now();
    if (!usePassOnRule(rule, now)) {
      flush();
      return { ok: false, error: "That pass is not available right now." };
    }
    // A tab still on the site, one the sweep never reached, counts from now (§7).
    const wasCounting = hasOpenInterval(ruleId);
    reconcile(rule, now, isCountingNow(ruleId));
    if (!wasCounting && hasOpenInterval(ruleId)) log(`▶ COUNTING ${ruleId} — in use as the pass began`);
    flush();
    const snapshot = decide(rule, now);
    log(
      `🎟 pass used on ${rule.id}: open until ${wallClock(snapshot.pass.endsAtMs, now)},`,
      `${snapshot.pass.leftThisWeek} left this week`,
    );
    // The pass ending is just nextChangeAtMs firing; the alarm handler then
    // finds the rolling cap spent, stops counting and sweeps.
    await Promise.all([syncCheckpointAlarm(), syncRuleAlarm(rule, now)]);
    return { ok: true, endsAtMs: snapshot.pass.endsAtMs };
  },
};

browser.runtime.onMessage.addListener((message) => {
  const handler = handlers[message?.type];
  if (!handler) return undefined;
  return inOrder(() => handler(message));
});

// An update closes the add-on's own pages as it unloads this version, and a
// window holding nothing else goes with them: with the last window, Firefox
// quits before the new version starts (DESIGN.md §12). Listening postpones the
// update until runtime.reload(), so each such window gets a tab first. Reload
// whatever happens, or the update waits for the next Firefox restart.
//
// Desktop only, told apart by browser.windows because a listener cannot wait
// for getPlatformInfo(). Firefox for Android has no window to lose, and the
// new version repairs its last tab (onInstalled, below); listening there would
// only postpone its updates through a path no run has checked.
if (browser.windows) {
  browser.runtime.onUpdateAvailable.addListener(async ({ version }) => {
    try {
      const windows = windowsAnUpdateCloses(await browser.tabs.query({}), browser.runtime.getURL(""));
      for (const windowId of windows) await browser.tabs.create({ windowId, active: false });
      const kept = windows.length > 0 ? `; opened a tab in ${windows.length} window(s) it would close` : "";
      log(`updating to v${version}${kept}`);
    } catch (error) {
      log(`updating to v${version}; could not keep its windows open:`, error.message);
    }
    browser.runtime.reload();
  });
}

// When a block page was the last tab, Firefox for Android is left frozen on it
// with no tab after an update (DESIGN.md §12); the new version opens a tab.
browser.runtime.onInstalled.addListener(async (details) => {
  const perWindow = await lastTabClosesWindow();
  if (!needsTabAfterUpdate(details, await browser.tabs.query({}), { perWindow })) return;
  await browser.tabs.create({ active: false });
  log("opened a tab: the update closed the last one");
});

browser.runtime.onSuspend.addListener(() => {
  log("event page suspending — flushing");
  flush();
  return settled();
});

// --- console handles -----------------------------------------------------

/**
 * Quick budget tweaks without opening the options page. Writes the same
 * `settings` key, so it travels the same onRulesChanged path an edit does —
 * and passes the same validation, or a console typo like `windowSec: 0` would
 * persist a rule the options page refuses to save.
 */
globalThis.setLimits = async (ruleId, patch) => {
  await ready;
  if (!rules.some((r) => r.id === ruleId)) return `no such rule: ${ruleId}`;
  const next = rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r));
  const errors = validateRule(next.find((r) => r.id === ruleId), next);
  if (errors.length > 0) return errors;
  await saveRules(next);
  return `${ruleId} updated`;
};

/**
 * A new rule from some of its fields, the rest as the options form starts a
 * new one: how a test sets up the rules it needs, since a first run has none
 * (DESIGN.md §24). Validated and saved like setLimits(). Read from storage,
 * not from `rules`, which only catches up once the save's change event has
 * run: two calls in a row would otherwise each save one rule over the other.
 */
globalThis.addRule = async (fields) => {
  await ready;
  const current = await loadRules();
  const rule = ruleFrom(fields, current.map((r) => r.id));
  if (current.some((r) => r.id === rule.id)) return `${rule.id} already exists; setLimits() changes it`;
  const next = [...current, rule];
  const errors = validateRule(rule, next);
  if (errors.length > 0) return errors;
  await saveRules(next);
  return `${rule.id} added`;
};

/**
 * Delete every rule, as deleting each one in the options page would: through
 * the same save, so their usage and alarms go too, with no reload. What is
 * left is what a first run starts with.
 */
globalThis.resetRules = async () => {
  await ready;
  await saveRules([]);
  return "every rule deleted, with its usage";
};

/**
 * The day the week starts, 0 (Sunday) to 6 (Saturday), as the options page
 * sets it: through the same save, so the week in progress is carried
 * (DESIGN.md §14).
 */
globalThis.setWeekStart = async (day) => {
  await ready;
  try {
    await saveSettings({ weekStart: day });
  } catch (error) {
    return error.message;
  }
  const { week } = await loadSettings();
  const carried = week.carry ? `; this week runs until ${new Date(week.carry.until).toString()}` : "";
  return `weeks start on ${WEEKDAYS[week.startDay]}${carried}`;
};

globalThis.resetUsage = async () => {
  await ready; // the rule ids, or nothing would be removed
  await browser.storage.local.remove(rules.map((r) => usageKey(r.id)));
  await browser.storage.session.clear();
  return "usage cleared — reload the extension";
};

// Async because it may be the call that wakes the event page: read before the
// ledger has loaded, every rule would show 0:00.
globalThis.dumpUsage = async (ruleId) => {
  await ready;
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
      unlocksIn: !s.exhausted ? "-" : s.unlockAtMs === null ? "never (no budget)" : countdown(s.unlockAtMs - now),
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
    // Whether the filtered registration was accepted, not whether the event exists.
    "tabs.onUpdated filters": platform.tabsUpdatedFilter,
    // False on Android: audible rules count as focus there (DESIGN.md §12).
    "tab.audible": platform.audible,
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
