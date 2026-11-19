// Rule definitions, URL matching, and validation.
//
// PURE — no `browser.*`. Shared by the background and the options page so that
// both agree on what a valid rule is; storage lives in settings.js.
//
// A rule is the single abstraction in this extension (DESIGN.md §1): a set of
// sites, a counting mode that decides when the clock runs, a budget over a
// rolling window, and what to do when the budget is spent. A site is a domain,
// optionally narrowed to a path ("youtube.com/shorts").

export const MODES = [
  { value: "audible", label: "While media is playing", hint: "counts while playing" },
  { value: "focus", label: "While the tab is focused", hint: "counts while focused" },
];

/**
 * The mode a rule actually counts in. Firefox for Android has no `tab.audible`
 * (a stub returning undefined, bug 2032751; DESIGN.md §12), so there an
 * `audible` rule would never count: it counts as `focus` instead. The stored
 * mode is left alone, so the same rule still counts while playing on desktop
 * after an export and import.
 */
export function effectiveMode(rule, { audible = true } = {}) {
  return rule.mode === "audible" && !audible ? "focus" : rule.mode;
}

export const ON_EXCEED = [
  { value: "block", label: "Show the block page" },
  { value: "close", label: "Close the tab" },
];

/** perWeek 0 disables passes; the other two only matter once it is not. */
export const DEFAULT_PASSES = { perWeek: 0, durationSec: 60 * 60, countsTowardCaps: true };

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
    dailyBudgetSec: null, // calendar day, local time; null = no daily cap
    weeklyBudgetSec: null, // calendar week from Monday, local time; null = none
    passes: { ...DEFAULT_PASSES },
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
    dailyBudgetSec: null,
    weeklyBudgetSec: null,
    passes: { ...DEFAULT_PASSES },
  },
];

/**
 * Whether a rule has no time at all: a budget of zero blocks its sites the
 * moment they are opened, and keeps them blocked until the budget is raised
 * (DESIGN.md §22). Its window, caps, cool-down, passes and counting mode are
 * ignored. Exactly zero: a blank budget field is not a choice to block a site,
 * and validateRule refuses it.
 */
export function blocksOutright(rule) {
  return rule.budgetSec === 0;
}

/** The longest a calendar cap can be: the period itself. */
export const MAX_DAILY_SEC = 24 * 60 * 60;
export const MAX_WEEKLY_SEC = 7 * MAX_DAILY_SEC;

/**
 * The rolling window's range (DESIGN.md §5). Usage is counted in one-minute
 * buckets and a budget is at least a minute, so a shorter window means
 * nothing; a longer one is what the daily and weekly caps are for (§14).
 */
export const MIN_WINDOW_SEC = 2 * 60;
export const MAX_WINDOW_SEC = MAX_DAILY_SEC;

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
 * The page a block replaced, read back from the block page's own query
 * string, or null. Only http(s) URLs that hostnameOf accepts come through:
 * the parameter is attacker-shaped input (anyone can type a block page URL),
 * and a `javascript:` or `data:` link rendered into the page would be a
 * script injection. The query and fragment are kept, so a video resumes
 * where it was.
 */
export function returnUrlFrom(params) {
  const raw = params?.get?.("url");
  if (!raw) return null;
  return hostnameOf(raw) ? new URL(raw).href : null;
}

/**
 * Hostname suffix match. "youtube.com" matches youtube.com, www.youtube.com,
 * m.youtube.com and music.youtube.com — but deliberately NOT notyoutube.com,
 * which a naive `includes()` would let through.
 */
export function hostMatches(hostname, pattern) {
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

/**
 * A URL path in the form patterns store it: lower case, no doubled or trailing
 * slashes, "" for the root, and letters, digits and -._~ never percent-encoded.
 * Sites commonly serve /Shorts, //shorts and /%73horts as /shorts, so each
 * would otherwise be a one-character way around a path rule. Any other
 * encoding is left as the URL parser leaves it, on both sides.
 */
function normalizePath(pathname) {
  return pathname
    .replace(/%([0-9a-f]{2})/gi, (escape, hex) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      return /[a-z0-9._~-]/i.test(char) ? char : escape;
    })
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/** Whole segments from the start: "/shorts" covers /shorts/abc, not /shortsfoo. */
function pathMatches(path, prefix) {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** "youtube.com/shorts" -> ["youtube.com", "/shorts"]; no path is "". */
function splitPattern(pattern) {
  const slash = pattern.indexOf("/");
  return slash === -1 ? [pattern, ""] : [pattern.slice(0, slash), pattern.slice(slash)];
}

/** Whether a pattern covers only part of a site. */
export function hasPath(pattern) {
  return splitPattern(pattern)[1] !== "";
}

/**
 * The rule that owns this URL, or null: the most specific matching pattern
 * wins, by the longest path first and then the longest host (DESIGN.md §21).
 * Among patterns that all match one URL, longer means more segments, so string
 * length is enough. Rule order only breaks a tie between identical patterns,
 * which validateRule refuses.
 */
export function ruleForUrl(rules, url) {
  const hostname = hostnameOf(url);
  if (!hostname) return null;
  const path = normalizePath(new URL(url).pathname);

  let best = null;
  let bestPath = -1;
  let bestHost = -1;
  for (const rule of rules) {
    for (const pattern of rule.match) {
      const [host, prefix] = splitPattern(pattern);
      if (!hostMatches(hostname, host) || !pathMatches(path, prefix)) continue;
      if (prefix.length > bestPath || (prefix.length === bestPath && host.length > bestHost)) {
        best = rule;
        bestPath = prefix.length;
        bestHost = host.length;
      }
    }
  }
  return best;
}

// --- authoring -----------------------------------------------------------

/**
 * Coerce whatever the user typed into a pattern, or null if it cannot be one.
 * Accepts a pasted URL, a `*.` wildcard, a port, a query. The path is dropped
 * unless `path` is set, which is the rule form's "Match paths" toggle: a URL
 * pasted from the address bar usually means the whole site. A trailing `*` or
 * `/*` is dropped too, since a path already covers everything under it.
 *
 * `www.` is stripped deliberately: as a pattern it would be narrower than the
 * user expects, failing to match the bare domain.
 */
export function parseDomain(raw, { path = false } = {}) {
  let value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  const cut = value.search(/[/?#]/);
  let host = cut === -1 ? value : value.slice(0, cut);
  const rest = cut === -1 ? "" : value.slice(cut);
  host = host.split("@").pop(); // userinfo
  host = host.split(":")[0]; // port
  if (host.startsWith("*.")) host = host.slice(2);
  if (host.startsWith("www.")) host = host.slice(4);

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;

  const typedPath = path ? rest.split(/[?#]/)[0].replace(/\/?\*+$/, "") : "";
  if (typedPath.includes("*")) return null; // no wildcards inside a path (§21)

  // Through the URL parser, so the pattern is spelled exactly as a tab's URL
  // will be when ruleForUrl compares them (127.1 is 127.0.0.1). It also refuses
  // hosts the check above lets through, such as 10.0.0.256, and a throw here
  // would escape validateRule and break Save for every rule.
  let url;
  try {
    url = new URL(`http://${host}${typedPath}`);
  } catch {
    return null;
  }
  return path ? url.hostname + normalizePath(url.pathname) : url.hostname;
}

/**
 * The first path in the domain field that is cut away while "Match paths" is
 * off, or null. The form says so, since "youtube.com/shorts" quietly becoming
 * "youtube.com" would limit the whole site.
 */
export function droppedPath(text) {
  for (const part of String(text ?? "").split(/[,\s]+/)) {
    const pattern = parseDomain(part, { path: true });
    if (pattern && hasPath(pattern)) return pattern;
  }
  return null;
}

/** Every pattern in the rule form's domain field, in order, each once. */
export function parsePatterns(text, { path = false } = {}) {
  const patterns = String(text ?? "")
    .split(/[,\s]+/)
    .map((part) => parseDomain(part, { path }))
    .filter(Boolean);
  return [...new Set(patterns)];
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

/** The cool-down a new rule starts with, while its budget allows it (DESIGN.md §8). */
const DEFAULT_UNLOCK_CREDIT_SEC = 5 * 60;

/**
 * The unlock credit a new rule gets for a budget: five minutes, or the whole
 * budget when that is less, since the credit can never exceed the budget. The
 * options form keeps a new rule's credit on this as the budget is typed, until
 * the credit is edited itself (DESIGN.md §8).
 */
export function defaultUnlockCreditSec(budgetSec) {
  return Math.min(DEFAULT_UNLOCK_CREDIT_SEC, Math.max(0, budgetSec));
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
    minUnlockCreditSec: defaultUnlockCreditSec(5 * 60),
    dailyBudgetSec: null,
    weeklyBudgetSec: null,
    passes: { ...DEFAULT_PASSES },
  };
}

// The form shows whole minutes; a rule holds seconds.
const minutesToSec = (text) => Math.max(0, Math.round(Number(text) || 0) * 60);
/** Blank is null: no cap, or for the budget no budget at all, which Save refuses. */
const minutesToSecOrNull = (text) => (String(text).trim() === "" ? null : Math.round(Number(text)) * 60);

/**
 * What one edit in the rule form changes in its draft: the fields that edit
 * writes, and nothing else. `field` is the input's `data-field`, `value` its
 * text, or a checkbox's state.
 *
 * Only the edited field, on purpose. The form shows whole minutes, and a rule
 * from setLimits() or an import can hold seconds it cannot show; reading every
 * field back on any edit turned a 90 s budget into 120 s, and a 20 s one into
 * 0, which blocks the site outright, when only the name was being fixed.
 */
export function formEdit(draft, field, value) {
  const passes = (change) => ({ passes: { ...draft.passes, ...change } });
  switch (field) {
    case "label":
    case "mode":
    case "onExceed":
      return { [field]: value };
    case "match":
      return { matchText: value, match: parsePatterns(value, { path: Boolean(draft.matchPaths) }) };
    case "matchPaths": {
      // From what was typed, not the field: once normalised on leaving, its
      // text no longer has the paths that were dropped.
      const text = draft.matchText ?? draft.match.join(", ");
      return { matchPaths: value, match: parsePatterns(text, { path: value }) };
    }
    case "budgetMin": {
      // A blank budget is no budget, refused on Save, not 0: an emptied field
      // is not a choice to block the site outright.
      const budgetSec = minutesToSecOrNull(value);
      // A new rule's cool-down follows its budget until it is edited itself,
      // so a budget under five minutes is not refused for a default nobody
      // chose (DESIGN.md §8). A saved rule's cool-down was chosen, or saved as
      // it was.
      const follows = !draft.id && !draft.creditEdited && budgetSec !== null;
      return follows ? { budgetSec, minUnlockCreditSec: defaultUnlockCreditSec(budgetSec) } : { budgetSec };
    }
    case "windowMin":
      return { windowSec: minutesToSec(value) };
    case "unlockMin":
      return { minUnlockCreditSec: minutesToSec(value), creditEdited: true };
    case "dailyMin":
      return { dailyBudgetSec: minutesToSecOrNull(value) };
    case "weeklyMin":
      return { weeklyBudgetSec: minutesToSecOrNull(value) };
    case "passesPerWeek":
      return passes({ perWeek: Math.max(0, Math.round(Number(value) || 0)) });
    case "passMin":
      return passes({ durationSec: minutesToSec(value) });
    case "passCounts":
      return passes({ countsTowardCaps: value });
    default:
      return {};
  }
}

/**
 * Fill in anything a stored rule is missing, so old data stays loadable. This
 * is the whole settings migration: a rule from a version-1 file gains the
 * calendar caps as "none" and its id, and therefore its usage, is untouched.
 *
 * A missing unlock credit is the one a new rule gets, not 0: 0 is the
 * drip-feed (DESIGN.md §8), a choice nobody made by leaving the field out.
 * Only a missing one; a null is a value, and validateRule refuses it.
 */
export function withDefaults(rule) {
  const filled = {
    onExceed: "block",
    windowSec: 60 * 60,
    mode: "focus",
    match: [],
    dailyBudgetSec: null,
    weeklyBudgetSec: null,
    ...rule,
    passes: { ...DEFAULT_PASSES, ...(isObject(rule.passes) ? rule.passes : {}) },
  };
  if (filled.minUnlockCreditSec === undefined) {
    // A rule with no usable budget is refused for that, and a credit worked
    // out from it would only add a second error about the same problem.
    filled.minUnlockCreditSec = Number.isInteger(filled.budgetSec) ? defaultUnlockCreditSec(filled.budgetSec) : 0;
  }
  return filled;
}

/** A plain object: not null, and not an array. */
export const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Only the fields a rule is made of, in their canonical shape. A whitelist on
 * purpose: the options page's drafts carry form state, and anything not listed
 * here is silently dropped rather than persisted. Shared with export.
 */
export function strip(draft) {
  return {
    id: draft.id,
    label: String(draft.label ?? "").trim(),
    match: draft.match,
    mode: draft.mode,
    budgetSec: draft.budgetSec,
    windowSec: draft.windowSec,
    onExceed: draft.onExceed,
    minUnlockCreditSec: draft.minUnlockCreditSec,
    dailyBudgetSec: draft.dailyBudgetSec ?? null,
    weeklyBudgetSec: draft.weeklyBudgetSec ?? null,
    passes: {
      perWeek: draft.passes?.perWeek ?? 0,
      durationSec: draft.passes?.durationSec ?? DEFAULT_PASSES.durationSec,
      countsTowardCaps: draft.passes?.countsTowardCaps ?? true,
    },
  };
}

/**
 * The types every rule must have, whatever its budget. The form only ever
 * writes whole seconds, so a value of the wrong type comes from a file or the
 * console, and the background would read it as soon as the budget is above
 * zero: a credit that is not a number gives a spent rule no unlock instant, a
 * numeric id never matches its alarm. Appends to `errors`.
 */
function validateTypes(rule, errors) {
  if (typeof rule.id !== "string") errors.push("The id must be text.");
  if (!Number.isInteger(rule.windowSec)) errors.push("Window must be a whole number of seconds.");
  if (!Number.isInteger(rule.minUnlockCreditSec)) errors.push("Unlock credit must be a whole number of seconds.");
  for (const [value, what] of [
    [rule.dailyBudgetSec, "Daily cap"],
    [rule.weeklyBudgetSec, "Weekly cap"],
  ]) {
    if (value !== null && value !== undefined && !Number.isInteger(value)) {
      errors.push(`${what} must be a whole number of seconds, or empty for none.`);
    }
  }

  if (rule.passes === undefined) return;
  const passes = rule.passes;
  if (!isObject(passes)) {
    errors.push("Passes must be an object.");
    return;
  }
  if (!Number.isInteger(passes.perWeek)) errors.push("Passes per week must be a whole number, zero or more.");
  if (!Number.isInteger(passes.durationSec)) errors.push("Pass length must be a whole number of seconds.");
  if (typeof passes.countsTowardCaps !== "boolean") {
    errors.push("Whether pass time counts toward the caps must be yes or no.");
  }
}

/** null means "no cap"; anything else must be more than zero and fit the period. */
function validateCap(value, maxSec, what, errors) {
  if (!Number.isInteger(value)) return; // none, or already refused by its type
  if (value <= 0) {
    errors.push(`${what} must be more than zero, or empty for none.`);
  } else if (value > maxSec) {
    errors.push(`${what} cannot be longer than the period itself.`);
  }
}

/**
 * The ranges of the window, the cool-down, the calendar caps and the passes:
 * everything a budget of zero ignores. Their types are validateTypes'.
 * Appends to `errors`.
 */
function validateLimits(rule, errors) {
  if (Number.isInteger(rule.windowSec)) {
    if (rule.windowSec < MIN_WINDOW_SEC || rule.windowSec > MAX_WINDOW_SEC) {
      errors.push("Window must be between 2 minutes and 24 hours.");
    } else if (rule.budgetSec >= rule.windowSec) {
      // Not a typo-check but a logic one: you can never spend more time than
      // the window contains, so such a rule can never block.
      errors.push("Budget must be smaller than the window, or the rule can never trigger.");
    }
  }

  if (Number.isInteger(rule.minUnlockCreditSec)) {
    if (rule.minUnlockCreditSec < 0) {
      errors.push("Unlock credit cannot be negative.");
    } else if (rule.minUnlockCreditSec > rule.budgetSec) {
      errors.push("Unlock credit cannot exceed the budget.");
    }
  }

  validateCap(rule.dailyBudgetSec, MAX_DAILY_SEC, "Daily cap", errors);
  validateCap(rule.weeklyBudgetSec, MAX_WEEKLY_SEC, "Weekly cap", errors);

  const passes = rule.passes;
  if (!isObject(passes) || !Number.isInteger(passes.perWeek)) return;
  if (passes.perWeek < 0) errors.push("Passes per week must be a whole number, zero or more.");
  if (passes.perWeek > 0 && Number.isInteger(passes.durationSec) && passes.durationSec <= 0) {
    errors.push("Pass length must be more than zero.");
  }
}

/**
 * Validate one rule. Returns a list of human-readable problems; empty means the
 * rule is safe to persist.
 */
export function validateRule(rule, allRules = []) {
  const errors = [];

  if (rule.label !== undefined && rule.label !== null && typeof rule.label !== "string") {
    errors.push("The name must be text.");
  } else if (!String(rule.label ?? "").trim()) {
    errors.push("Needs a name.");
  }
  if (!Array.isArray(rule.match) || rule.match.length === 0) {
    errors.push("Needs at least one domain.");
  }
  if (!MODES.some((m) => m.value === rule.mode)) errors.push("Unknown counting mode.");
  if (!ON_EXCEED.some((a) => a.value === rule.onExceed)) errors.push("Unknown action.");

  if (typeof rule.budgetSec !== "number" || !(rule.budgetSec >= 0)) {
    errors.push("Budget must be zero or more.");
  } else if (!Number.isInteger(rule.budgetSec)) {
    errors.push("Budget must be a whole number of seconds.");
  }

  // A rule that blocks outright ignores the rest of its limits, so their
  // ranges are not checked: the form greys them out with whatever they held,
  // and a value the user cannot edit must never be what refuses the save.
  // Raising the budget brings them back, checked as usual (DESIGN.md §22).
  // Their types are checked regardless, since only a file or the console can
  // get them wrong.
  validateTypes(rule, errors);
  if (!blocksOutright(rule)) validateLimits(rule, errors);

  // Unsaved rules have no id yet, so two of them are not "duplicates".
  if (rule.id) {
    const duplicate = allRules.find((other) => other !== rule && other.id === rule.id);
    if (duplicate) errors.push("Duplicate rule id.");
  }

  // Matching assumes the form's spelling (lower case, no scheme, no www., no
  // trailing slash). An import file or setLimits() could otherwise store a
  // pattern that matches nothing, or one two rules claim under two spellings.
  const patterns = Array.isArray(rule.match) ? rule.match : [];
  for (const pattern of patterns) {
    const written = typeof pattern === "string" ? parseDomain(pattern, { path: true }) : null;
    if (written !== null && written === pattern) continue;
    errors.push(written ? `Write "${pattern}" as "${written}".` : `"${pattern}" is not a domain.`);
  }

  // The most specific pattern wins (ruleForUrl), so "music.youtube.com" or
  // "youtube.com/shorts" beside "youtube.com" is a carve-out, not a conflict.
  // Only the same pattern in two rules is: one of them would never count. The
  // later rule is the one flagged, as the one being added.
  for (const pattern of patterns) {
    const claimed = allRules.find(
      (other) =>
        other !== rule && other.match?.includes(pattern) && allRules.indexOf(other) < allRules.indexOf(rule),
    );
    if (claimed) errors.push(`"${pattern}" is already claimed by ${claimed.label || claimed.id}.`);
  }

  return errors;
}
