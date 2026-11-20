// Reading and writing the rule set and the day the week starts.
//
// `settings` is a COLD key: written only when rules or the week are edited,
// never by the counters (DESIGN.md §6). That separation is why a hot usage
// update can never rewrite the configuration.
//
//   settings → { version, rules: [...], week: { startDay, carry } }
//
// `week` is global, one start day for every rule (DESIGN.md §14). An install
// that never chose one has no `week` and reads as Monday.

import { withDefaults } from "./rules.js";
import { changeWeekStart, isWeekStartDay, normalizeWeek } from "./calendar.js";

export const SETTINGS_KEY = "settings";

/** A rule's hot key: its ledger, written on every flush (store.js). */
export const usageKey = (ruleId) => `usage:${ruleId}`;
/**
 * 1: the rolling cap only. 2: dailyBudgetSec and weeklyBudgetSec (and every
 * later additive field). `withDefaults` is the migration in both directions,
 * so the number is informational; nothing branches on it.
 */
export const SETTINGS_VERSION = 2;

/**
 * The current rule set, as stored. A first run has none: no `settings` key
 * reads as an empty set, the same as one whose every rule was deleted, and
 * nothing is written until the first save (DESIGN.md §24). Loading never
 * rewrites what is stored, so an install keeps its rules and their ids.
 */
export async function loadRules() {
  return (await loadSettings()).rules;
}

const readStored = async () => (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];

const rulesOf = (stored) => (Array.isArray(stored?.rules) ? stored.rules.map(withDefaults) : []);

/** The rules and the week, as stored; Monday for an install that never chose. */
export async function loadSettings() {
  const stored = await readStored();
  return { rules: rulesOf(stored), week: normalizeWeek(stored?.week) };
}

/** Save the rule set, keeping the week as it is. */
export async function saveRules(rules) {
  await saveSettings({ rules });
}

/**
 * Save `rules`, a new `weekStart` day (0 Sunday … 6 Saturday), or both in one
 * write, as an import does. What is left out is kept as stored. A new start
 * day goes through changeWeekStart() at `nowMs`, so the week in progress is
 * carried and no weekly budget or pass comes back (DESIGN.md §14). A start
 * day that is not a day is refused before anything is written.
 */
export async function saveSettings({ rules, weekStart } = {}, nowMs = Date.now()) {
  if (weekStart !== undefined && !isWeekStartDay(weekStart)) {
    throw new Error(`The week must start on a day from 0 (Sunday) to 6 (Saturday), not ${JSON.stringify(weekStart)}.`);
  }
  const stored = await readStored();
  const current = normalizeWeek(stored?.week);
  const week = weekStart === undefined ? current : changeWeekStart(current, weekStart, nowMs);
  const next = { version: SETTINGS_VERSION, rules: rules ?? (Array.isArray(stored?.rules) ? stored.rules : []) };
  // Only an install that has chosen, or had one carried over, stores a week:
  // the rest read as Monday either way.
  if (stored?.week !== undefined || week !== current) next.week = week;
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
}

/**
 * Call `onChange(rules, previous, week, previousWeek)` whenever the settings
 * are edited anywhere: the rule set, the week, or both. `previous` is the set
 * the edit replaced, empty on first run: the only record of it when the edit
 * is what woke the event page (DESIGN.md §6). `previousWeek` likewise.
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
    onChange(next.rules.map(withDefaults), previous, normalizeWeek(next.week), normalizeWeek(old?.week));
  });
}
