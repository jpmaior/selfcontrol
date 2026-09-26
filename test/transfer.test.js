// Unit tests for export and import of the rule set.
//   nix develop --command node --test

import test from "node:test";
import assert from "node:assert/strict";

import { importSummary, parseImport, serializeRules } from "../extension/common/transfer.js";
import { DEFAULT_RULES, strip, withDefaults } from "../extension/common/rules.js";

const NOW = Date.UTC(2026, 8, 19, 10, 0);

test("serializeRules: a tagged, versioned envelope of strip-clean rules", () => {
  const messy = DEFAULT_RULES.map((r) => ({ ...r, formJunk: true, label: ` ${r.label} ` }));
  const out = serializeRules(messy, NOW);
  assert.equal(out.format, "selfcontrol-rules");
  assert.equal(out.version, 2);
  assert.equal(out.exportedAt, "2026-09-19T10:00:00.000Z");
  assert.deepEqual(out.rules, DEFAULT_RULES.map(strip));
  assert.equal("formJunk" in out.rules[0], false);
});

test("parseImport: a valid file round-trips", () => {
  const text = JSON.stringify(serializeRules(DEFAULT_RULES, NOW));
  const result = parseImport(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rules, DEFAULT_RULES.map(withDefaults));
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
  const file = serializeRules(DEFAULT_RULES, NOW);
  file.rules[1] = { ...file.rules[1], budgetSec: 0 };
  const result = parseImport(JSON.stringify(file));
  assert.equal(result.ok, false);
  assert.match(result.error, /Instagram/, "names the rule");
  assert.match(result.error, /2/, "and its position");
  assert.match(result.error, /zero/i, "and what is wrong");
});

test("parseImport: a rule that is not an object is refused", () => {
  const file = { format: "selfcontrol-rules", version: 2, rules: [DEFAULT_RULES[0], 42] };
  assert.equal(parseImport(JSON.stringify(file)).ok, false);
});

test("parseImport: duplicate ids are refused", () => {
  const file = serializeRules([DEFAULT_RULES[0], { ...DEFAULT_RULES[1], id: "youtube", match: ["x.com"] }], NOW);
  const result = parseImport(JSON.stringify(file));
  assert.equal(result.ok, false);
  assert.match(result.error, /youtube/);
});

test("parseImport: a rule without an id is refused, since ids key the usage", () => {
  const file = serializeRules([{ ...DEFAULT_RULES[0], id: "" }], NOW);
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
