// Reading and writing the rule set.
//
// `settings` is a COLD key: written only when rules are edited, never by the
// counters (DESIGN.md §6). That separation is why a hot usage update can never
// rewrite the configuration.

import { DEFAULT_RULES, withDefaults } from "./rules.js";

export const SETTINGS_KEY = "settings";
/**
 * 1: the rolling cap only. 2: dailyBudgetSec and weeklyBudgetSec (and every
 * later additive field). `withDefaults` is the migration in both directions,
 * so the number is informational; nothing branches on it.
 */
export const SETTINGS_VERSION = 2;

/**
 * The current rule set, seeding storage with the defaults on first run so that
 * what the user sees in the options page is always what is actually stored.
 */
export async function loadRules() {
  const stored = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];

  // An empty array is a legitimate configuration — the user deleted every rule.
  // Only a MISSING settings key means first run; checking length here would
  // resurrect the defaults on the next event page start.
  if (Array.isArray(stored?.rules)) return stored.rules.map(withDefaults);

  const seeded = DEFAULT_RULES.map(withDefaults);
  await saveRules(seeded);
  return seeded;
}

export async function saveRules(rules) {
  await browser.storage.local.set({
    [SETTINGS_KEY]: { version: SETTINGS_VERSION, rules },
  });
}

/**
 * Call `onChange(rules, previous)` whenever the rule set is edited anywhere.
 * `previous` is the set the edit replaced, empty on first run: the only
 * record of it when the edit is what woke the event page (DESIGN.md §6).
 *
 * This is how the options page reaches the background without a message
 * protocol. It filters hard on the settings key: the background writes
 * `usage:*` constantly, and reacting to those would be a reload storm.
 */
export function onRulesChanged(onChange) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const { newValue: next, oldValue: old } = changes[SETTINGS_KEY] ?? {};
    if (!Array.isArray(next?.rules)) return;
    const previous = Array.isArray(old?.rules) ? old.rules.map(withDefaults) : [];
    onChange(next.rules.map(withDefaults), previous);
  });
}
