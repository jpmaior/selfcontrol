// Rule definitions and URL matching.
//
// A rule is the single abstraction in this extension (DESIGN.md §1): a set of
// domains, a counting mode that decides when the clock runs, a budget over a
// rolling window, and what to do when the budget is spent.
//
// Step 2 only uses `match` and `mode`. The budget fields are here so the shape
// is settled early; nothing reads them yet.

/** @typedef {"audible" | "focus"} CountingMode */

export const DEFAULT_RULES = [
  {
    id: "youtube",
    label: "YouTube",
    match: ["youtube.com"],
    mode: "audible", // clock runs while a matching tab produces sound
    budgetSec: 20 * 60,
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

/**
 * Extract a hostname from a tab URL, or null if this is not a web page we can
 * reason about (about:, moz-extension:, file:, undefined during tab setup).
 */
export function hostnameOf(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname;
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
