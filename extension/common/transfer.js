// Export and import of the rule set. PURE: no `browser.*`, no `Date.now()`.
//
// A file is an envelope around strip-clean rules:
//
//   { format: "selfcontrol-rules", version: 2, exportedAt: "...", rules: [...] }
//
// Import is all-or-nothing: one bad rule refuses the whole file, because a
// half-applied rule set is worse than none. Ids are kept as they are in the
// file, since an id is the key a rule's usage hangs off (DESIGN.md §20).

import { SETTINGS_VERSION } from "./settings.js";
import { strip, validateRule, withDefaults } from "./rules.js";

export const FORMAT = "selfcontrol-rules";

export function serializeRules(rules, nowMs) {
  return {
    format: FORMAT,
    version: SETTINGS_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    rules: rules.map(strip),
  };
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * `{ ok: true, rules }` with defaults filled and every rule validated against
 * the others, or `{ ok: false, error }` naming the first problem.
 */
export function parseImport(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not JSON." };
  }
  if (!isObject(file) || file.format !== FORMAT) {
    return { ok: false, error: "That file is not a SelfControl rules export." };
  }
  if (!Array.isArray(file.rules)) {
    return { ok: false, error: "The file has no list of rules." };
  }
  if (!file.rules.every(isObject)) {
    return { ok: false, error: "The file has an entry that is not a rule." };
  }

  const rules = file.rules.map((rule) => withDefaults(strip(withDefaults(rule))));

  const name = (rule) => rule.label || rule.id || "unnamed";

  // Ids first, on their own: validateRule would also flag a duplicate, but
  // against the earlier rule, which is the wrong one to point at.
  const seen = new Set();
  for (const [index, rule] of rules.entries()) {
    if (!rule.id) return { ok: false, error: `Rule ${index + 1} (${name(rule)}) has no id.` };
    if (seen.has(rule.id)) {
      return { ok: false, error: `Rule ${index + 1} (${name(rule)}) repeats the id "${rule.id}".` };
    }
    seen.add(rule.id);
  }

  for (const [index, rule] of rules.entries()) {
    const errors = validateRule(rule, rules);
    if (errors.length > 0) {
      return { ok: false, error: `Rule ${index + 1} (${name(rule)}): ${errors.join(" ")}` };
    }
  }

  return { ok: true, rules };
}

/** What replacing `current` with `incoming` does to each rule's history. */
export function importSummary(current, incoming) {
  const currentIds = new Set(current.map((r) => r.id));
  const incomingIds = new Set(incoming.map((r) => r.id));
  return {
    added: incoming.map((r) => r.id).filter((id) => !currentIds.has(id)),
    kept: incoming.map((r) => r.id).filter((id) => currentIds.has(id)),
    removed: current.map((r) => r.id).filter((id) => !incomingIds.has(id)),
  };
}
