// Unit tests for rule matching, domain parsing and validation.
//   nix develop --command node --test
//
// rules.js is pure, so the options page's whole validation story is testable
// without a browser.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RULES,
  blankRule,
  effectiveMode,
  hasPath,
  hostMatches,
  makeRuleId,
  parseDomain,
  parsePatterns,
  returnUrlFrom,
  ruleForUrl,
  strip,
  validateRule,
  withDefaults,
} from "../extension/common/rules.js";

const MIN = 60;

function rule(overrides = {}) {
  return {
    id: "test",
    label: "Test",
    match: ["example.com"],
    mode: "focus",
    budgetSec: 5 * MIN,
    windowSec: 60 * MIN,
    onExceed: "block",
    minUnlockCreditSec: 0,
    ...overrides,
  };
}

// --- matching ------------------------------------------------------------

test("hostMatches: suffix match, not substring", () => {
  assert.ok(hostMatches("youtube.com", "youtube.com"));
  assert.ok(hostMatches("m.youtube.com", "youtube.com"));
  assert.ok(hostMatches("music.youtube.com", "youtube.com"));

  assert.ok(!hostMatches("notyoutube.com", "youtube.com"), "no substring matching");
  assert.ok(!hostMatches("youtube.com.evil.example", "youtube.com"), "no prefix matching");
});

test("ruleForUrl: ignores non-web schemes and undefined urls", () => {
  for (const url of [undefined, "", "about:debugging", "moz-extension://abc/x.html", "file:///tmp"]) {
    assert.equal(ruleForUrl(DEFAULT_RULES, url), null, `${url} should not match`);
  }
});

test("ruleForUrl: returns the first matching rule", () => {
  const rules = [rule({ id: "first" }), rule({ id: "second" })];
  assert.equal(ruleForUrl(rules, "https://example.com/x").id, "first");
});

test("ruleForUrl: a fully-qualified trailing dot is not a bypass", () => {
  assert.equal(ruleForUrl(DEFAULT_RULES, "https://youtube.com./watch").id, "youtube");
  assert.equal(ruleForUrl(DEFAULT_RULES, "https://www.youtube.com./watch").id, "youtube");
});

// --- part of a site (#21) --------------------------------------------------

const YOUTUBE = rule({ id: "youtube", label: "YouTube", match: ["youtube.com"] });
const SHORTS = rule({ id: "shorts", label: "Shorts", match: ["youtube.com/shorts"] });

test("ruleForUrl: a path pattern covers that path and everything under it, on any subdomain", () => {
  const rules = [YOUTUBE, SHORTS];
  for (const url of [
    "https://www.youtube.com/shorts/abc",
    "https://m.youtube.com/shorts/abc",
    "https://youtube.com/shorts",
    "https://youtube.com/shorts/",
  ]) {
    assert.equal(ruleForUrl(rules, url)?.id, "shorts", url);
  }
  for (const url of ["https://www.youtube.com/watch?v=abc", "https://youtube.com/", "https://youtube.com"]) {
    assert.equal(ruleForUrl(rules, url)?.id, "youtube", url);
  }
});

test("ruleForUrl: a path matches whole segments, from the start", () => {
  assert.equal(ruleForUrl([YOUTUBE, SHORTS], "https://youtube.com/shortsfoo").id, "youtube");
  assert.equal(ruleForUrl([SHORTS], "https://youtube.com/shortsfoo"), null);
  assert.equal(ruleForUrl([SHORTS], "https://youtube.com/feed/shorts"), null);
});

test("ruleForUrl: the query string and fragment are not part of the path", () => {
  const rules = [YOUTUBE, SHORTS];
  assert.equal(ruleForUrl(rules, "https://youtube.com/watch?next=/shorts/abc").id, "youtube");
  assert.equal(ruleForUrl(rules, "https://youtube.com/#/shorts/abc").id, "youtube");
  assert.equal(ruleForUrl(rules, "https://youtube.com/shorts/abc?feature=share#t=3").id, "shorts");
});

test("ruleForUrl: a path is not escaped by its case or a doubled slash", () => {
  // Sites commonly serve /Shorts and //shorts as /shorts; each would otherwise
  // be a one-character way around the rule, like the trailing dot above.
  const rules = [YOUTUBE, SHORTS];
  assert.equal(ruleForUrl(rules, "https://youtube.com/Shorts/AbC").id, "shorts");
  assert.equal(ruleForUrl(rules, "https://youtube.com//shorts/abc").id, "shorts");
  assert.equal(ruleForUrl(rules, "https://youtube.com./shorts/abc").id, "shorts");
});

test("ruleForUrl: the most specific rule wins, whatever the order", () => {
  const music = rule({ id: "music", match: ["music.youtube.com"] });
  for (const rules of [
    [YOUTUBE, music],
    [music, YOUTUBE],
  ]) {
    assert.equal(ruleForUrl(rules, "https://music.youtube.com/watch?v=1").id, "music");
    assert.equal(ruleForUrl(rules, "https://www.youtube.com/watch?v=1").id, "youtube");
  }
  for (const rules of [
    [YOUTUBE, SHORTS],
    [SHORTS, YOUTUBE],
  ]) {
    assert.equal(ruleForUrl(rules, "https://youtube.com/shorts/abc").id, "shorts");
  }
});

test("ruleForUrl: a longer path beats a longer host, and a deeper path a shallower one", () => {
  const mobile = rule({ id: "mobile", match: ["m.youtube.com"] });
  assert.equal(ruleForUrl([mobile, SHORTS], "https://m.youtube.com/shorts/abc").id, "shorts");
  assert.equal(ruleForUrl([mobile, SHORTS], "https://m.youtube.com/watch?v=1").id, "mobile");

  const a = rule({ id: "a", match: ["example.com/a"] });
  const ab = rule({ id: "ab", match: ["example.com/a/b"] });
  for (const rules of [
    [a, ab],
    [ab, a],
  ]) {
    assert.equal(ruleForUrl(rules, "https://example.com/a/b/c").id, "ab");
    assert.equal(ruleForUrl(rules, "https://example.com/a/c").id, "a");
  }
});

test("ruleForUrl: a path typed with characters a URL encodes still matches", () => {
  const cafe = rule({ id: "cafe", match: [parseDomain("example.com/Café", { path: true })] });
  assert.equal(ruleForUrl([cafe], "https://example.com/caf%C3%A9/menu")?.id, "cafe");
});

// --- domain parsing ------------------------------------------------------

test("parseDomain: accepts what a person would actually paste", () => {
  const cases = [
    ["youtube.com", "youtube.com"],
    ["  YouTube.COM  ", "youtube.com"],
    ["https://www.youtube.com/feed/subscriptions", "youtube.com"],
    ["http://m.youtube.com", "m.youtube.com"],
    ["*.youtube.com", "youtube.com"],
    ["youtube.com:443", "youtube.com"],
    ["user@youtube.com", "youtube.com"],
    ["news.bbc.co.uk", "news.bbc.co.uk"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseDomain(input), expected, `${input}`);
  }
});

test("parseDomain: rejects things that are not domains", () => {
  for (const input of ["", "   ", "localhost", "not a domain", "http://", "..", null, undefined]) {
    assert.equal(parseDomain(input), null, `${input} should be rejected`);
  }
});

test("parseDomain: stripping www keeps the pattern broad", () => {
  // Storing "www.youtube.com" would fail to match a bare youtube.com, which is
  // the opposite of what someone typing it expects.
  assert.equal(parseDomain("www.youtube.com"), "youtube.com");
  assert.ok(hostMatches("www.youtube.com", parseDomain("www.youtube.com")));
  assert.ok(hostMatches("youtube.com", parseDomain("www.youtube.com")));
});

test("parseDomain: keeps the path when asked, without the query or fragment", () => {
  const cases = [
    ["youtube.com/shorts", "youtube.com/shorts"],
    ["https://www.youtube.com/shorts/abc?feature=share#t=3", "youtube.com/shorts/abc"],
    ["YouTube.com/Shorts/", "youtube.com/shorts"],
    ["m.youtube.com:443/shorts", "m.youtube.com/shorts"],
    ["youtube.com//shorts", "youtube.com/shorts"],
    ["youtube.com/", "youtube.com"],
    ["youtube.com?x=1", "youtube.com"],
    ["youtube.com", "youtube.com"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseDomain(input, { path: true }), expected, input);
  }
});

test("parseDomain: drops the path unless asked", () => {
  assert.equal(parseDomain("youtube.com/shorts"), "youtube.com");
  assert.equal(parseDomain("https://www.youtube.com/shorts/abc?feature=share"), "youtube.com");
  assert.equal(parseDomain("youtube.com?x=1"), "youtube.com");
});

test("parseDomain: a path still needs a site in front of it", () => {
  for (const input of ["/shorts", "localhost/shorts", "https:///shorts", "youtube/shorts"]) {
    assert.equal(parseDomain(input, { path: true }), null, input);
  }
});

test("parsePatterns: reads the whole field, without duplicates or junk", () => {
  assert.deepEqual(parsePatterns("youtube.com, vimeo.com"), ["youtube.com", "vimeo.com"]);
  assert.deepEqual(parsePatterns(""), []);
  const typed = "https://youtube.com/shorts/abc youtube.com/feed, nope";
  assert.deepEqual(parsePatterns(typed), ["youtube.com"], "two paths on one site become one site");
  assert.deepEqual(parsePatterns(typed, { path: true }), ["youtube.com/shorts/abc", "youtube.com/feed"]);
});

test("hasPath: tells part of a site from the whole of it", () => {
  assert.equal(hasPath("youtube.com/shorts"), true);
  assert.equal(hasPath("youtube.com"), false);
  assert.equal(hasPath("news.bbc.co.uk"), false);
});

// --- ids -----------------------------------------------------------------

test("makeRuleId: slugifies and de-duplicates", () => {
  assert.equal(makeRuleId("YouTube"), "youtube");
  assert.equal(makeRuleId("Hacker News!"), "hacker-news");
  assert.equal(makeRuleId("  spaced  out  "), "spaced-out");
  assert.equal(makeRuleId("YouTube", ["youtube"]), "youtube-2");
  assert.equal(makeRuleId("YouTube", ["youtube", "youtube-2"]), "youtube-3");
  assert.equal(makeRuleId(""), "rule", "never produces an empty id");
  assert.equal(makeRuleId("!!!"), "rule");
});

// --- validation ----------------------------------------------------------

test("validateRule: a well-formed rule has no errors", () => {
  assert.deepEqual(validateRule(rule()), []);
});

test("validateRule: catches the empties", () => {
  assert.ok(validateRule(rule({ label: "  " })).some((e) => /name/i.test(e)));
  assert.ok(validateRule(rule({ match: [] })).some((e) => /domain/i.test(e)));
});

test("validateRule: a budget at or above the window can never trigger", () => {
  // Not a typo check but a logic one — you cannot spend more time than the
  // window contains, so such a rule would silently never block.
  assert.ok(validateRule(rule({ budgetSec: 60 * MIN, windowSec: 60 * MIN })).length > 0);
  assert.ok(validateRule(rule({ budgetSec: 90 * MIN, windowSec: 60 * MIN })).length > 0);
  assert.deepEqual(validateRule(rule({ budgetSec: 59 * MIN, windowSec: 60 * MIN })), []);
});

test("validateRule: unlock credit must fit inside the budget", () => {
  assert.deepEqual(validateRule(rule({ minUnlockCreditSec: 0 })), [], "0 is the drip-feed");
  assert.deepEqual(validateRule(rule({ minUnlockCreditSec: 5 * MIN })), [], "equal to budget is strict mode");
  assert.ok(validateRule(rule({ minUnlockCreditSec: 6 * MIN })).length > 0);
  assert.ok(validateRule(rule({ minUnlockCreditSec: -1 })).length > 0);
});

test("validateRule: rejects unknown mode or action", () => {
  assert.ok(validateRule(rule({ mode: "telepathy" })).length > 0);
  assert.ok(validateRule(rule({ onExceed: "explode" })).length > 0);
});

test("validateRule: flags a domain already claimed by an earlier rule", () => {
  // ruleForUrl returns the first match, so the second rule would be dead code.
  const first = rule({ id: "a", label: "First", match: ["example.com"] });
  const second = rule({ id: "b", label: "Second", match: ["example.com"] });
  const all = [first, second];

  assert.deepEqual(validateRule(first, all), [], "the earlier rule is fine");
  assert.ok(
    validateRule(second, all).some((e) => /already claimed by First/.test(e)),
    "the shadowed rule is flagged",
  );
});

test("validateRule: a subdomain or a path beside the whole site is not a conflict", () => {
  // The most specific pattern wins (ruleForUrl), so "music.youtube.com" and
  // "youtube.com/shorts" each take their part of the site from "youtube.com",
  // in either order. This used to be refused as shadowing.
  const site = rule({ id: "a", label: "YouTube", match: ["youtube.com"] });
  for (const narrow of [
    rule({ id: "b", label: "Music", match: ["music.youtube.com"] }),
    rule({ id: "b", label: "Shorts", match: ["youtube.com/shorts"] }),
  ]) {
    for (const all of [
      [site, narrow],
      [narrow, site],
    ]) {
      assert.deepEqual(validateRule(site, all), [], `${narrow.label}: the whole site`);
      assert.deepEqual(validateRule(narrow, all), [], `${narrow.label}: the part`);
    }
  }
});

test("validateRule: flags a path another rule already claims", () => {
  const first = rule({ id: "a", label: "First", match: ["youtube.com/shorts"] });
  const second = rule({ id: "b", label: "Second", match: ["vimeo.com", "youtube.com/shorts"] });
  const all = [first, second];

  assert.deepEqual(validateRule(first, all), [], "the earlier rule is fine");
  assert.ok(
    validateRule(second, all).some((e) => /"youtube.com\/shorts" is already claimed by First/.test(e)),
    "the later one is flagged",
  );
});

test("validateRule: a pattern must be written the way the form writes it", () => {
  // Matching relies on lower case, no scheme, no www. and no trailing slash.
  // An import file or setLimits() could otherwise store a pattern that matches
  // nothing, or one that two rules claim under different spellings.
  for (const bad of ["YouTube.com", "https://youtube.com", "www.youtube.com", "youtube.com/", "youtube.com/Shorts", "", 42, null]) {
    assert.ok(validateRule(rule({ match: [bad] })).length > 0, `${bad} should be refused`);
  }
  assert.deepEqual(validateRule(rule({ match: ["youtube.com/shorts", "127.0.0.1", "news.bbc.co.uk"] })), []);
});

test("validateRule: flags duplicate ids", () => {
  const all = [rule({ id: "dup" }), rule({ id: "dup" })];
  assert.ok(validateRule(all[1], all).some((e) => /duplicate/i.test(e)));
});

test("validateRule: two unsaved rules are not duplicates of each other", () => {
  // Ids are minted at save time, so before that they are all empty. Treating
  // that as a collision would make it impossible to add two rules at once.
  const all = [rule({ id: "", match: ["a.com"] }), rule({ id: "", match: ["b.com"] })];
  assert.deepEqual(validateRule(all[0], all), []);
  assert.deepEqual(validateRule(all[1], all), []);
});

test("blankRule: has no id, so saving cannot orphan an existing rule's usage", () => {
  assert.equal(blankRule().id, "");
});

// --- forward compatibility ----------------------------------------------

test("withDefaults: an old stored rule missing fields still loads", () => {
  const filled = withDefaults({ id: "x", label: "X", match: ["x.com"], budgetSec: 60 });
  assert.equal(filled.mode, "focus");
  assert.equal(filled.onExceed, "block");
  assert.equal(filled.windowSec, 60 * MIN);
  assert.equal(filled.minUnlockCreditSec, 0);
});

test("withDefaults: never overrides what was stored", () => {
  const stored = { id: "x", label: "X", match: ["x.com"], mode: "audible", onExceed: "close" };
  const filled = withDefaults(stored);
  assert.equal(filled.mode, "audible");
  assert.equal(filled.onExceed, "close");
});

test("the shipped defaults are valid", () => {
  for (const r of DEFAULT_RULES) {
    assert.deepEqual(validateRule(r, DEFAULT_RULES), [], `${r.id} should validate`);
  }
});

// --- daily and weekly caps ------------------------------------------------

test("validateRule: calendar caps accept null and positive whole seconds", () => {
  assert.deepEqual(validateRule(rule({ dailyBudgetSec: null, weeklyBudgetSec: null })), []);
  assert.deepEqual(validateRule(rule({ dailyBudgetSec: 40 * MIN, weeklyBudgetSec: 5 * 60 * MIN })), []);
  assert.deepEqual(validateRule(rule({ dailyBudgetSec: 24 * 60 * MIN })), [], "a full day is allowed");
  assert.deepEqual(validateRule(rule({ weeklyBudgetSec: 7 * 24 * 60 * MIN })), [], "a full week is allowed");
});

test("validateRule: calendar caps reject zero, negatives, fractions and oversize", () => {
  for (const bad of [0, -60, 1.5, "60", NaN]) {
    assert.ok(validateRule(rule({ dailyBudgetSec: bad })).length > 0, `daily ${bad}`);
    assert.ok(validateRule(rule({ weeklyBudgetSec: bad })).length > 0, `weekly ${bad}`);
  }
  assert.ok(validateRule(rule({ dailyBudgetSec: 24 * 60 * MIN + 1 })).length > 0, "over a day");
  assert.ok(validateRule(rule({ weeklyBudgetSec: 7 * 24 * 60 * MIN + 1 })).length > 0, "over a week");
});

test("withDefaults: fills the calendar caps with null", () => {
  const filled = withDefaults({ id: "x", label: "X", match: ["x.com"], budgetSec: 60 });
  assert.equal(filled.dailyBudgetSec, null);
  assert.equal(filled.weeklyBudgetSec, null);
  assert.equal(withDefaults({ dailyBudgetSec: 60 }).dailyBudgetSec, 60, "keeps a stored value");
});

test("strip: keeps only the fields a rule is made of", () => {
  const stripped = strip({ ...rule({ dailyBudgetSec: 60 }), label: " Test ", junk: 1 });
  assert.equal(stripped.junk, undefined);
  assert.equal(stripped.label, "Test");
  assert.equal(stripped.dailyBudgetSec, 60);
  assert.equal(stripped.weeklyBudgetSec, null);
});

// --- passes ----------------------------------------------------------------

test("withDefaults: passes default to disabled, an hour long, counting toward the caps", () => {
  assert.deepEqual(withDefaults({ id: "x" }).passes, { perWeek: 0, durationSec: 60 * 60, countsTowardCaps: true });
  const stored = { id: "x", passes: { perWeek: 2, durationSec: 600, countsTowardCaps: false } };
  assert.deepEqual(withDefaults(stored).passes, stored.passes);
  assert.deepEqual(
    withDefaults({ id: "x", passes: { perWeek: 1 } }).passes,
    { perWeek: 1, durationSec: 60 * 60, countsTowardCaps: true },
    "a partial passes object is filled in",
  );
});

test("validateRule: passes need a whole non-negative count, a positive length, a boolean", () => {
  const ok = (passes) => validateRule(rule({ passes }));
  assert.deepEqual(ok({ perWeek: 0, durationSec: 60, countsTowardCaps: true }), []);
  assert.deepEqual(ok({ perWeek: 3, durationSec: 60, countsTowardCaps: false }), []);
  assert.deepEqual(ok({ perWeek: 0, durationSec: 0, countsTowardCaps: true }), [], "length is irrelevant when disabled");

  assert.ok(ok({ perWeek: -1, durationSec: 60, countsTowardCaps: true }).length > 0);
  assert.ok(ok({ perWeek: 1.5, durationSec: 60, countsTowardCaps: true }).length > 0);
  assert.ok(ok({ perWeek: 1, durationSec: 0, countsTowardCaps: true }).length > 0);
  assert.ok(ok({ perWeek: 1, durationSec: -5, countsTowardCaps: true }).length > 0);
  assert.ok(ok({ perWeek: 1, durationSec: 60, countsTowardCaps: "yes" }).length > 0);
  assert.ok(ok("two").length > 0);
});

test("strip: keeps passes in their canonical shape", () => {
  const stripped = strip(rule({ passes: { perWeek: 2, durationSec: 600, countsTowardCaps: false, junk: 1 } }));
  assert.deepEqual(stripped.passes, { perWeek: 2, durationSec: 600, countsTowardCaps: false });
});

// --- the block page's return link -------------------------------------------

test("returnUrlFrom: accepts http(s) and keeps the query and fragment", () => {
  const url = "https://www.youtube.com/watch?v=abc&t=42#comments";
  assert.equal(returnUrlFrom(new URLSearchParams({ url })), url);
  assert.equal(returnUrlFrom(new URLSearchParams({ url: "http://example.com/a?b=1" })), "http://example.com/a?b=1");
});

test("returnUrlFrom: refuses anything that is not a web page", () => {
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "moz-extension://abc/blocked/blocked.html",
    "file:///etc/passwd",
    "about:blank",
    "not a url",
    "",
  ]) {
    assert.equal(returnUrlFrom(new URLSearchParams({ url: bad })), null, bad);
  }
});

test("returnUrlFrom: null for a missing parameter", () => {
  assert.equal(returnUrlFrom(new URLSearchParams()), null);
  assert.equal(returnUrlFrom(new URLSearchParams({ rule: "youtube" })), null);
});

test("effectiveMode: an audible rule counts as focus where tab.audible is not reported", () => {
  // Firefox for Android (DESIGN.md §12). The stored mode is untouched; only
  // what the rule counts on changes, so the same rule still counts while
  // playing once it is imported on desktop.
  assert.equal(effectiveMode({ mode: "audible" }, { audible: false }), "focus");
  assert.equal(effectiveMode({ mode: "focus" }, { audible: false }), "focus");
  assert.equal(effectiveMode({ mode: "audible" }, { audible: true }), "audible");
  assert.equal(effectiveMode({ mode: "focus" }, { audible: true }), "focus");
  assert.equal(effectiveMode({ mode: "audible" }), "audible", "desktop unless told otherwise");
});
