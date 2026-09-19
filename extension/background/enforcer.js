// Enforcement: deciding when a rule is spent, acting on it, and keeping it
// enforced against re-opening (DESIGN.md §7).
//
// The scheduling trick is worth understanding. Each rule has exactly one alarm,
// at the earliest instant its answer could flip (policy.evaluate's
// `nextChangeAtMs`): `now + remaining` while counting, the unlock instant
// while blocked, nothing while idle and open. The counting estimate
// is ALWAYS early or exact and never late, because a rolling window only ever
// hands budget back. So when the alarm fires we recompute; if the rule is not
// actually spent yet, we simply reschedule. No forward simulation is needed.

import { log } from "./log.js";
import { ruleForUrl } from "../common/rules.js";
import { status } from "./store.js";
import { clock } from "../common/format.js";

const RULE_PREFIX = "rule:";

export const ruleAlarmFor = (ruleId) => `${RULE_PREFIX}${ruleId}`;

export function ruleIdFromAlarm(name) {
  return name.startsWith(RULE_PREFIX) ? name.slice(RULE_PREFIX.length) : null;
}

export function blockedUrlFor(rule, snapshot) {
  const params = new URLSearchParams({
    rule: rule.id,
    label: rule.label,
    until: String(snapshot.unlockAtMs),
    reason: snapshot.reason ?? "",
  });
  return browser.runtime.getURL(`blocked/blocked.html?${params}`);
}

/**
 * Apply a rule's enforcement action to one tab. Returns what was done, or null
 * if the tab was left alone.
 */
async function act(rule, tab, snapshot) {
  try {
    if (rule.onExceed === "close") {
      // Removing a window's only tab closes the window — and closing the last
      // window closes Firefox (closeWindowWithLastTab). Open a fresh tab first
      // so the window survives; tabs.update to about:newtab is not an option,
      // Firefox rejects privileged about: URLs from extensions as illegal.
      const siblings = await browser.tabs.query({ windowId: tab.windowId });
      if (siblings.length <= 1) {
        await browser.tabs.create({ windowId: tab.windowId, active: false });
      }
      await browser.tabs.remove(tab.id);
      return "closed";
    }
    await browser.tabs.update(tab.id, { url: blockedUrlFor(rule, snapshot) });
    return "blocked";
  } catch (error) {
    // The tab can vanish between query and action; that is not an error worth
    // shouting about.
    log(`could not enforce on tab ${tab.id}:`, error.message);
    return null;
  }
}

/**
 * A rule has just run out: sweep every open tab that matches it.
 * Returns the number of tabs acted on.
 */
export async function enforceRule(rule, nowMs) {
  const snapshot = status(rule, nowMs);
  if (!snapshot.exhausted) return 0;

  const tabs = await browser.tabs.query({});
  const matching = tabs.filter((tab) => ruleForUrl([rule], tab.url));

  let acted = 0;
  for (const tab of matching) {
    if (await act(rule, tab, snapshot)) acted++;
  }

  if (acted > 0) {
    log(
      `⛔ ${rule.id} spent — ${rule.onExceed === "close" ? "closed" : "blocked"} ${acted} tab(s);`,
      `unlocks in ${clock(snapshot.unlockAtMs - nowMs)}`,
    );
  }
  return acted;
}

/**
 * A single tab appeared or navigated: block it if its rule is already spent.
 *
 * This is what makes "reopen it and it closes again immediately" work, and it
 * is the same code path as enforceRule — no separate mechanism.
 */
export async function guardTab(rules, tab, nowMs) {
  const rule = ruleForUrl(rules, tab?.url);
  if (!rule) return false;

  const snapshot = status(rule, nowMs);
  if (!snapshot.exhausted) return false;

  const done = await act(rule, tab, snapshot);
  if (done) log(`⛔ ${done} re-opened ${rule.id} (tab ${tab.id})`);
  return Boolean(done);
}

/**
 * Keep the rule's one alarm in step with reality. Called whenever a rule
 * starts or stops counting, after every checkpoint, and after the alarm
 * itself fires. A rule whose answer cannot flip on its own gets no alarm.
 */
export async function syncRuleAlarm(rule, nowMs) {
  const name = ruleAlarmFor(rule.id);
  const snapshot = status(rule, nowMs);
  const when = snapshot.nextChangeAtMs;

  if (when === null) {
    await browser.alarms.clear(name);
    return null;
  }

  const existing = await browser.alarms.get(name);

  // Only rewrite the alarm if the target moved meaningfully — rescheduling on
  // every event would be churn, and alarms.create() replaces by name.
  if (existing && Math.abs(existing.scheduledTime - when) < 1000) return existing.scheduledTime;

  await browser.alarms.create(name, { when });
  const why = snapshot.exhausted ? `unlocks (${snapshot.reason})` : `${snapshot.binding} cap runs out`;
  log(`${rule.id}: alarm in ${clock(when - nowMs)} — ${why}`);
  return when;
}
