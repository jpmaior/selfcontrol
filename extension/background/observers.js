// Tab and window observation.
//
// Sole job: answer "is rule R being consumed right now?" and report every
// change in that answer. No timing, no storage, no enforcement — those arrive
// in Steps 3, 4 and 5.
//
// IMPORTANT: every piece of state in this module is derived, never authoritative.
// MV3 kills the event page constantly (DESIGN.md §2), so all of it must be
// rebuildable from `tabs.query()` alone — that is what prime() does, and it runs
// on every single event page start, not just on install.

import { log, warn } from "./log.js";
import { hostnameOf, ruleForUrl } from "../common/rules.js";

// Firefox for Android has only ever one window, and its `windows` API is
// reduced. Feature-detect rather than assume: reading WINDOW_ID_NONE off an
// absent namespace at module scope would throw and take the whole background
// down before a single listener was registered.
const windowsApi = globalThis.browser?.windows ?? null;
const canTrackWindowFocus = Boolean(windowsApi?.onFocusChanged && windowsApi?.getLastFocused);
const NO_WINDOW = windowsApi?.WINDOW_ID_NONE ?? -1;

export const platform = { canTrackWindowFocus };

/** tabId -> ruleId, for tabs currently producing sound under an `audible` rule. */
const audibleTabs = new Map();

/** The rule owning the foreground right now (any mode), or null. */
let focusedRuleId = null;

/** ruleId -> boolean, the last state we reported. Used to emit only changes. */
const reported = new Map();

let rules = [];
let onCountingChange = () => {};
let traceEnabled = false;

/**
 * Guards against out-of-order async focus resolution: two focus events in quick
 * succession each await a query, and the slower one must not overwrite the
 * newer answer.
 */
let focusGeneration = 0;

export async function start({ rules: ruleset, onChange, trace = false }) {
  rules = ruleset;
  onCountingChange = onChange;
  traceEnabled = trace;

  browser.tabs.onUpdated.addListener(handleTabUpdated, {
    // Filtering at the source keeps us from waking for every title/favicon change.
    properties: ["audible", "mutedInfo", "url", "status"],
  });
  browser.tabs.onRemoved.addListener(handleTabRemoved);
  browser.tabs.onActivated.addListener(() => resolveFocus("tab activated"));

  if (canTrackWindowFocus) {
    windowsApi.onFocusChanged.addListener(handleWindowFocusChanged);
  } else {
    // Android. Without this event we cannot tell that the browser itself went
    // to the background, so a `focus` rule keeps counting while the user is in
    // another app. The sleep clamp in store.js bounds the damage.
    log("no window focus events on this platform — focus rules count while the app is backgrounded");
  }

  await prime();
}

/**
 * Swap in an edited rule set (options page saved) without restarting anything.
 *
 * `reported` is cleared so the new set is evaluated from scratch: a rule whose
 * domains or mode changed may now be counting when it was not, or vice versa,
 * and diffing against stale state would miss it. Rules that vanished simply
 * stop being iterated; the caller settles their ledgers.
 */
export async function setRules(next) {
  rules = next;
  reported.clear();
  await prime();
}

/** Rebuild all derived state from scratch. Runs on every event page start. */
async function prime() {
  audibleTabs.clear();

  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (!tab.audible) continue;
    const rule = ruleForUrl(rules, tab.url);
    if (rule?.mode === "audible") audibleTabs.set(tab.id, rule.id);
  }

  log(`primed from ${tabs.length} open tabs`);
  await resolveFocus("startup prime");
}

// --- event handlers ------------------------------------------------------

function handleTabUpdated(tabId, changeInfo, tab) {
  const rule = ruleForUrl(rules, tab.url);

  // Raw trace of what Firefox actually reports. This is the whole point of
  // Checkpoint 2: watching `audible` respond to real playback, muting and
  // YouTube's muted hover-previews before any logic depends on it.
  if (rule || audibleTabs.has(tabId)) {
    trace(
      `tab ${tabId} ${hostnameOf(tab.url) ?? "?"}`,
      `[${Object.keys(changeInfo).join(",") || "-"}]`,
      `audible=${tab.audible === true}`,
      `muted=${tab.mutedInfo?.muted === true}`,
      `active=${tab.active === true}`,
    );
  }

  if (rule?.mode === "audible" && tab.audible) {
    audibleTabs.set(tabId, rule.id);
  } else {
    audibleTabs.delete(tabId);
  }

  // A URL change in the active tab can move the foreground between rules.
  if (tab.active) resolveFocus("active tab updated");
  else recompute("tab updated");
}

function handleTabRemoved(tabId) {
  const wasTracked = audibleTabs.delete(tabId);
  if (wasTracked) trace(`tab ${tabId} closed while counting`);
  // Closing a tab promotes a different one to active.
  resolveFocus("tab removed");
}

function handleWindowFocusChanged(windowId) {
  if (windowId === NO_WINDOW) {
    // Firefox itself lost focus — the user alt-tabbed to another application.
    // This is what stops `focus` rules from counting while you are in an editor.
    trace("all Firefox windows lost focus");
    setFocusedRule(null, "browser lost focus", ++focusGeneration);
    return;
  }
  resolveFocus("window focus changed");
}

// --- focus resolution ----------------------------------------------------

async function resolveFocus(why) {
  const generation = ++focusGeneration;
  let nextRuleId = null;

  try {
    let tab;
    if (canTrackWindowFocus) {
      const window = await windowsApi.getLastFocused();
      // `focused` false means Firefox lost focus to another application.
      if (window?.focused) [tab] = await browser.tabs.query({ active: true, windowId: window.id });
    } else {
      // Single-window platform: the active tab is the foreground, full stop.
      [tab] = await browser.tabs.query({ active: true });
    }
    nextRuleId = tab ? (ruleForUrl(rules, tab.url)?.id ?? null) : null;
  } catch (error) {
    warn("could not resolve focus:", error);
    return;
  }

  setFocusedRule(nextRuleId, why, generation);
}

function setFocusedRule(ruleId, why, generation) {
  // A newer resolution already landed; discard this stale answer.
  if (generation !== focusGeneration) return;
  focusedRuleId = ruleId;
  recompute(why);
}

// --- derivation ----------------------------------------------------------

/**
 * The observers' current view of a rule, as last reported.
 *
 * Step 4 reconciles against this on startup: the ledger may hold an interval
 * left open when the event page was killed, and only the observers can say
 * whether that interval is still live or is a leftover to be settled.
 */
export function isCountingNow(ruleId) {
  return reported.get(ruleId) ?? false;
}

/** Is this rule being consumed right now, per its mode? */
function isCounting(rule) {
  switch (rule.mode) {
    case "audible":
      // Per rule, not per tab: three YouTube tabs playing is still one clock.
      for (const ruleId of audibleTabs.values()) if (ruleId === rule.id) return true;
      return false;
    case "focus":
      // focusedRuleId is whichever rule owns the foreground regardless of mode,
      // so a focused YouTube tab correctly does NOT start Instagram's clock —
      // and does not start YouTube's either, since YouTube counts on audio.
      return focusedRuleId === rule.id;
    default:
      return false;
  }
}

/** Diff current reality against what we last reported, and emit the changes. */
function recompute(why) {
  for (const rule of rules) {
    const now = isCounting(rule);
    if ((reported.get(rule.id) ?? false) === now) continue;
    reported.set(rule.id, now);
    onCountingChange(rule, now, why);
  }
}

// --- tracing -------------------------------------------------------------

function trace(...args) {
  if (traceEnabled) log(...args);
}
