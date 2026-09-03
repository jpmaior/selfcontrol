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
  hostMatches,
  makeRuleId,
  parseDomain,
  ruleForUrl,
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

test("validateRule: flags a subdomain shadowed by an earlier rule's suffix match", () => {
  // ruleForUrl matches by suffix, so "youtube.com" claims music.youtube.com too.
  const first = rule({ id: "a", label: "First", match: ["youtube.com"] });
  const second = rule({ id: "b", label: "Second", match: ["music.youtube.com"] });
  const all = [first, second];

  assert.deepEqual(validateRule(first, all), [], "the earlier rule is fine");
  assert.ok(
    validateRule(second, all).some((e) => /already claimed by First/.test(e)),
    "the shadowed subdomain rule is flagged",
  );
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
