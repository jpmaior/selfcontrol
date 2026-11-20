// Unit tests for export and import of the rule set.
//   nix develop --command node --test

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeImport,
  importSummary,
  parseImport,
  serializeRules,
} from "../extension/common/transfer.js";
import { DEFAULT_PASSES, defaultUnlockCreditSec, strip, withDefaults } from "../extension/common/rules.js";

const NOW = Date.UTC(2026, 8, 19, 10, 0);

/** Two complete rules, one of each mode and action. */
const RULES = [
  {
    id: "youtube",
    label: "YouTube",
    match: ["youtube.com"],
    mode: "audible",
    budgetSec: 5 * 60,
    windowSec: 60 * 60,
    onExceed: "block",
    minUnlockCreditSec: 5 * 60,
    dailyBudgetSec: null,
    weeklyBudgetSec: null,
    passes: { ...DEFAULT_PASSES },
  },
  {
    id: "instagram",
    label: "Instagram",
    match: ["instagram.com"],
    mode: "focus",
    budgetSec: 5 * 60,
    windowSec: 60 * 60,
    onExceed: "close",
    minUnlockCreditSec: 5 * 60,
    dailyBudgetSec: null,
    weeklyBudgetSec: null,
    passes: { ...DEFAULT_PASSES },
  },
];

test("serializeRules: a tagged, versioned envelope of strip-clean rules", () => {
  const messy = RULES.map((r) => ({ ...r, formJunk: true, label: ` ${r.label} ` }));
  const out = serializeRules(messy, NOW);
  assert.equal(out.format, "selfcontrol-rules");
  assert.equal(out.version, 2);
  assert.equal(out.exportedAt, "2026-09-19T10:00:00.000Z");
  assert.deepEqual(out.rules, RULES.map(strip));
  assert.equal("formJunk" in out.rules[0], false);
});

test("parseImport: a valid file round-trips", () => {
  const text = JSON.stringify(serializeRules(RULES, NOW));
  const result = parseImport(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rules, RULES.map(withDefaults));
});

test("parseImport: a version-1 file imports with the new fields defaulted", () => {
  const old = {
    format: "selfcontrol-rules",
    version: 1,
    rules: [
      {
        id: "youtube",
        label: "YouTube",
        match: ["youtube.com"],
        mode: "audible",
        budgetSec: 300,
        windowSec: 3600,
        onExceed: "block",
        minUnlockCreditSec: 300,
      },
    ],
  };
  const result = parseImport(JSON.stringify(old));
  assert.equal(result.ok, true);
  assert.equal(result.rules[0].dailyBudgetSec, null);
  assert.equal(result.rules[0].passes.perWeek, 0);
  assert.equal(result.rules[0].id, "youtube", "ids are kept as-is");
});

test("parseImport: a rule for part of a site imports beside the whole site", () => {
  const shorts = { ...RULES[0], id: "shorts", label: "Shorts", match: ["youtube.com/shorts"] };
  const music = { ...RULES[0], id: "music", label: "Music", match: ["music.youtube.com"] };
  const result = parseImport(JSON.stringify(serializeRules([...RULES, shorts, music], NOW)));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(
    result.rules.map((r) => r.match),
    [["youtube.com"], ["instagram.com"], ["youtube.com/shorts"], ["music.youtube.com"]],
  );
});

test("parseImport: refuses what is not a rules file", () => {
  const cases = [
    ["not json", "{"],
    ["unknown format", JSON.stringify({ format: "something-else", version: 2, rules: [] })],
    ["missing format", JSON.stringify({ version: 2, rules: [] })],
    ["rules not an array", JSON.stringify({ format: "selfcontrol-rules", version: 2, rules: {} })],
    ["a bare array", JSON.stringify([])],
    ["null", "null"],
  ];
  for (const [what, text] of cases) {
    const result = parseImport(text);
    assert.equal(result.ok, false, what);
    assert.equal(typeof result.error, "string", what);
  }
});

test("parseImport: one invalid rule refuses the whole file and names it", () => {
  const file = serializeRules(RULES, NOW);
  file.rules[1] = { ...file.rules[1], budgetSec: -60 };
  const result = parseImport(JSON.stringify(file));
  assert.equal(result.ok, false);
  assert.match(result.error, /Instagram/, "names the rule");
  assert.match(result.error, /2/, "and its position");
  assert.match(result.error, /zero or more/i, "and what is wrong");
});

test("parseImport: a rule that blocks outright imports, whatever its ignored limits hold", () => {
  const file = serializeRules(RULES, NOW);
  file.rules[1] = { ...file.rules[1], budgetSec: 0, windowSec: 0, minUnlockCreditSec: 600 };
  const result = parseImport(JSON.stringify(file));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.rules[1].budgetSec, 0);
});

test("parseImport: values of the wrong type are refused, naming the rule and the field", () => {
  const withRule = (overrides) => {
    const file = serializeRules(RULES, NOW);
    file.rules[1] = { ...file.rules[1], ...overrides };
    return JSON.stringify(file);
  };
  const cases = [
    [withRule({ windowSec: "3600" }), /window/i],
    // JSON has no Infinity, but 1e999 parses to it.
    [withRule({ windowSec: 3599 }).replace('"windowSec":3599', '"windowSec":1e999'), /window/i],
    [withRule({ minUnlockCreditSec: "abc" }), /unlock credit/i],
    [withRule({ minUnlockCreditSec: null }), /unlock credit/i],
    [withRule({ budgetSec: 90.5 }), /budget/i],
    [withRule({ id: 7 }), /id must be text/i],
    [withRule({ passes: { perWeek: 1, durationSec: "600", countsTowardCaps: true } }), /pass length/i],
  ];
  for (const [text, message] of cases) {
    const result = parseImport(text);
    assert.equal(result.ok, false, text);
    assert.match(result.error, /Rule 2 \(Instagram\)/, result.error);
    assert.match(result.error, message, result.error);
  }
});

test("parseImport: a rule without an unlock credit gets the new-rule default, not the drip-feed", () => {
  const file = serializeRules(
    [
      { ...RULES[0], budgetSec: 30 * 60 },
      { ...RULES[1], budgetSec: 2 * 60 },
    ],
    NOW,
  );
  for (const rule of file.rules) delete rule.minUnlockCreditSec;
  const result = parseImport(JSON.stringify(file));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.rules[0].minUnlockCreditSec, defaultUnlockCreditSec(30 * 60));
  assert.equal(result.rules[1].minUnlockCreditSec, defaultUnlockCreditSec(2 * 60));
});

test("parseImport: a rolling window over 24 hours is refused", () => {
  const file = serializeRules(RULES, NOW);
  file.rules[0] = { ...file.rules[0], windowSec: 48 * 60 * 60 };
  const result = parseImport(JSON.stringify(file));
  assert.equal(result.ok, false);
  assert.match(result.error, /2 minutes and 24 hours/);
});

test("parseImport: a rule that is not an object is refused", () => {
  const file = { format: "selfcontrol-rules", version: 2, rules: [RULES[0], 42] };
  assert.equal(parseImport(JSON.stringify(file)).ok, false);
});

test("parseImport: duplicate ids are refused", () => {
  const file = serializeRules([RULES[0], { ...RULES[1], id: "youtube", match: ["x.com"] }], NOW);
  const result = parseImport(JSON.stringify(file));
  assert.equal(result.ok, false);
  assert.match(result.error, /youtube/);
});

test("parseImport: a rule without an id is refused, since ids key the usage", () => {
  const file = serializeRules([{ ...RULES[0], id: "" }], NOW);
  assert.equal(parseImport(JSON.stringify(file)).ok, false);
});

test("parseImport: an empty rule set is a legitimate file", () => {
  const result = parseImport(JSON.stringify(serializeRules([], NOW)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.rules, []);
});

test("importSummary: which ids are new, kept, and about to lose their history", () => {
  const current = [{ id: "youtube" }, { id: "instagram" }];
  const incoming = [{ id: "youtube" }, { id: "reddit" }];
  assert.deepEqual(importSummary(current, incoming), {
    added: ["reddit"],
    kept: ["youtube"],
    removed: ["instagram"],
  });
  assert.deepEqual(importSummary([], []), { added: [], kept: [], removed: [] });
});

test("describeImport: the confirm step says what happens to each rule's history", () => {
  const current = [{ id: "youtube" }, { id: "instagram" }];
  assert.equal(
    describeImport(current, [{ id: "youtube" }, { id: "reddit" }]),
    "2 rules replace your 2 rules. youtube keeps its history; instagram: history discarded. reddit: new.",
  );
});

test("describeImport: several kept rules keep their history, not its", () => {
  const current = [{ id: "youtube" }, { id: "instagram" }];
  assert.equal(
    describeImport(current, current),
    "2 rules replace your 2 rules. youtube, instagram keep their history.",
  );
});

test("describeImport: one incoming rule replaces, in the singular", () => {
  assert.equal(
    describeImport([{ id: "youtube" }], [{ id: "youtube" }]),
    "1 rule replaces your 1 rule. youtube keeps its history.",
  );
  assert.equal(describeImport([], [{ id: "reddit" }]), "1 rule replaces your 0 rules. reddit: new.");
});

// --- the week's start day (DESIGN.md §14, §20) -----------------------------

test("serializeRules: carries the day the week starts, Monday unless given", () => {
  assert.equal(serializeRules(RULES, NOW).weekStart, 1);
  assert.equal(serializeRules(RULES, NOW, 0).weekStart, 0);
});

test("parseImport: the week's start day comes through", () => {
  const result = parseImport(JSON.stringify(serializeRules(RULES, NOW, 6)));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.weekStart, 6);
});

test("parseImport: a file without a week start leaves the current one alone", () => {
  const file = serializeRules(RULES, NOW);
  delete file.weekStart;
  const result = parseImport(JSON.stringify(file));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.weekStart, null, "null: keep what is set");
});

test("parseImport: a week start that is not a day refuses the file", () => {
  for (const bad of [7, -1, 1.5, "1", "sunday", null]) {
    const file = { ...serializeRules(RULES, NOW), weekStart: bad };
    const result = parseImport(JSON.stringify(file));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.match(result.error, /week/i, JSON.stringify(bad));
  }
});

test("describeImport: says when the week will start on another day", () => {
  const rules = [{ id: "youtube" }];
  assert.equal(
    describeImport(rules, rules, { weekStart: 0, currentWeekStart: 1 }),
    "1 rule replaces your 1 rule. youtube keeps its history. Weeks will start on Sunday.",
  );
  assert.equal(
    describeImport(rules, rules, { weekStart: 1, currentWeekStart: 1 }),
    "1 rule replaces your 1 rule. youtube keeps its history.",
    "the same day is not news",
  );
  assert.equal(
    describeImport(rules, rules, { weekStart: null, currentWeekStart: 1 }),
    "1 rule replaces your 1 rule. youtube keeps its history.",
    "a file without one changes nothing",
  );
});
