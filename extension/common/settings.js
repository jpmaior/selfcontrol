// Reading and writing the rule set.
//
// `settings` is a COLD key: written only when rules are edited, never by the
// counters (DESIGN.md §6). That separation is why a hot usage update can never
// rewrite the configuration.

import { DEFAULT_RULES, withDefaults } from "./rules.js";

export const SETTINGS_KEY = "settings";
export const SETTINGS_VERSION = 1;

/** Superseded by the options page; removed on sight so it cannot confuse things. */
const LEGACY_LIMITS_KEY = "debug:limits";

/**
 * The current rule set, seeding storage with the defaults on first run so that
 * what the user sees in the options page is always what is actually stored.
 */
export async function loadRules() {
  const stored = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];

  // An empty array is a legitimate configuration — the user deleted every rule.
  // Only a MISSING settings key means first run; checking length here would
  // resurrect the defaults on the next event page start.
  if (Array.isArray(stored?.rules)) {
    await browser.storage.local.remove(LEGACY_LIMITS_KEY);
    return stored.rules.map(withDefaults);
  }

  const seeded = DEFAULT_RULES.map(withDefaults);
  await saveRules(seeded);
  await browser.storage.local.remove(LEGACY_LIMITS_KEY);
  return seeded;
}

export async function saveRules(rules) {
  await browser.storage.local.set({
    [SETTINGS_KEY]: { version: SETTINGS_VERSION, rules },
  });
}

/**
 * Call `onChange(rules)` whenever the rule set is edited anywhere.
 *
 * This is how the options page reaches the background without a message
 * protocol. It filters hard on the settings key: the background writes
 * `usage:*` constantly, and reacting to those would be a reload storm.
 */
export function onRulesChanged(onChange) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[SETTINGS_KEY]?.newValue;
    if (!Array.isArray(next?.rules)) return;
    onChange(next.rules.map(withDefaults));
  });
}
