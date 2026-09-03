// Rule definitions, URL matching, and validation.
//
// PURE — no `browser.*`. Shared by the background and the options page so that
// both agree on what a valid rule is; storage lives in settings.js.
//
// A rule is the single abstraction in this extension (DESIGN.md §1): a set of
// domains, a counting mode that decides when the clock runs, a budget over a
// rolling window, and what to do when the budget is spent.

export const MODES = [
  { value: "audible", label: "While media is playing", hint: "counts while playing" },
  { value: "focus", label: "While the tab is focused", hint: "counts while focused" },
];

export const ON_EXCEED = [
  { value: "block", label: "Show the block page" },
  { value: "close", label: "Close the tab" },
];

export const DEFAULT_RULES = [
  {
    id: "youtube",
    label: "YouTube",
    match: ["youtube.com"],
    mode: "audible", // clock runs while a matching tab produces sound
    budgetSec: 5 * 60,
    windowSec: 60 * 60,
    onExceed: "block",
    minUnlockCreditSec: 5 * 60,
  },
  {
    id: "instagram",
    label: "Instagram",
    match: ["instagram.com"],
    mode: "focus", // clock runs only while it is the focused tab
    budgetSec: 5 * 60,
    windowSec: 60 * 60,
    onExceed: "close",
    minUnlockCreditSec: 5 * 60,
  },
];

// --- matching ------------------------------------------------------------

/**
 * Extract a hostname from a tab URL, or null if this is not a web page we can
 * reason about (about:, moz-extension:, file:, undefined during tab setup).
 */
export function hostnameOf(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    // "youtube.com." (fully-qualified, trailing dot) is the same site but would
    // match no pattern — a one-character bypass of every rule.
    return parsed.hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * Hostname suffix match. "youtube.com" matches youtube.com, www.youtube.com,
 * m.youtube.com and music.youtube.com — but deliberately NOT notyoutube.com,
 * which a naive `includes()` would let through.
 */
export function hostMatches(hostname, pattern) {
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

/** The first rule matching this URL, or null. */
export function ruleForUrl(rules, url) {
  const hostname = hostnameOf(url);
  if (!hostname) return null;
  return rules.find((rule) => rule.match.some((p) => hostMatches(hostname, p))) ?? null;
}

// --- authoring -----------------------------------------------------------

/**
 * Coerce whatever the user typed into a bare hostname, or null if it cannot be
 * one. Accepts a pasted URL, a `*.` wildcard, a trailing path, a port.
 *
 * `www.` is stripped deliberately: as a pattern it would be narrower than the
 * user expects, failing to match the bare domain.
 */
export function parseDomain(raw) {
  let value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  value = value.split("/")[0]; // path
  value = value.split("@").pop(); // userinfo
  value = value.split(":")[0]; // port
  if (value.startsWith("*.")) value = value.slice(2);
  if (value.startsWith("www.")) value = value.slice(4);

  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ? value : null;
}

/** A stable id derived from the label, unique against `taken`. */
export function makeRuleId(label, taken = []) {
  const base =
    String(label ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "rule";

  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * A new, unsaved rule. Its id is deliberately empty: ids are minted at save
 * time from the settled label, and an id is the key a rule's usage data hangs
 * off, so it must never be regenerated for an existing rule.
 */
export function blankRule() {
  return {
    id: "",
    label: "",
    match: [],
    mode: "focus",
    budgetSec: 5 * 60,
    windowSec: 60 * 60,
    onExceed: "block",
    minUnlockCreditSec: 5 * 60,
  };
}

/** Fill in anything a stored rule is missing, so old data stays loadable. */
export function withDefaults(rule) {
  return {
    onExceed: "block",
    minUnlockCreditSec: 0,
    windowSec: 60 * 60,
    mode: "focus",
    match: [],
    ...rule,
  };
}

/**
 * Validate one rule. Returns a list of human-readable problems; empty means the
 * rule is safe to persist.
 */
export function validateRule(rule, allRules = []) {
  const errors = [];

  if (!String(rule.label ?? "").trim()) errors.push("Needs a name.");
  if (!Array.isArray(rule.match) || rule.match.length === 0) {
    errors.push("Needs at least one domain.");
  }
  if (!MODES.some((m) => m.value === rule.mode)) errors.push("Unknown counting mode.");
  if (!ON_EXCEED.some((a) => a.value === rule.onExceed)) errors.push("Unknown action.");

  if (!(rule.budgetSec > 0)) {
    errors.push("Budget must be more than zero.");
  }
  if (!(rule.windowSec > 0)) {
    errors.push("Window must be more than zero.");
  } else if (rule.budgetSec >= rule.windowSec) {
    // Not a typo-check but a logic one: you can never spend more time than the
    // window contains, so such a rule can never block.
    errors.push("Budget must be smaller than the window, or the rule can never trigger.");
  }

  if (rule.minUnlockCreditSec < 0) {
    errors.push("Unlock credit cannot be negative.");
  } else if (rule.minUnlockCreditSec > rule.budgetSec) {
    errors.push("Unlock credit cannot exceed the budget.");
  }

  // Unsaved rules have no id yet, so two of them are not "duplicates".
  if (rule.id) {
    const duplicate = allRules.find((other) => other !== rule && other.id === rule.id);
    if (duplicate) errors.push("Duplicate rule id.");
  }

  // A domain claimed by an earlier rule would never reach this one, since
  // ruleForUrl returns the first match. Match the way ruleForUrl matches —
  // suffix, not equality — or "music.youtube.com" after a "youtube.com" rule
  // would validate cleanly and be dead code.
  for (const domain of rule.match ?? []) {
    const shadowing = allRules.find(
      (other) =>
        other !== rule &&
        other.match?.some((pattern) => hostMatches(domain, pattern)) &&
        allRules.indexOf(other) < allRules.indexOf(rule),
    );
    if (shadowing) errors.push(`"${domain}" is already claimed by ${shadowing.label || shadowing.id}.`);
  }

  return errors;
}
