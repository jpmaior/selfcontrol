// Tests for settings.js against a stubbed `globalThis.browser`: what the rule
// set is on a first run, and that loading never rewrites what is stored.
//   nix develop --command node --test
//
// settings.js only touches browser APIs inside function bodies, so a stub
// installed before the import is enough, as in store.test.js.

import test from "node:test";
import assert from "node:assert/strict";

const data = new Map();
let writes = 0;
globalThis.browser = {
  storage: {
    local: {
      async get(key) {
        return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
      },
      async set(items) {
        writes++;
        for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
      },
    },
  },
};

const { SETTINGS_KEY, loadRules } = await import("../extension/common/settings.js");

function reset(settings) {
  data.clear();
  writes = 0;
  if (settings !== undefined) data.set(SETTINGS_KEY, settings);
}

test("loadRules: a first run has no rules, and writes nothing", async () => {
  reset();
  assert.deepEqual(await loadRules(), []);
  assert.equal(data.has(SETTINGS_KEY), false, "nothing is seeded");
  assert.equal(writes, 0);
});

test("loadRules: a saved empty rule set stays empty", async () => {
  reset({ version: 2, rules: [] });
  assert.deepEqual(await loadRules(), []);
  assert.equal(writes, 0);
});

test("loadRules: an existing install keeps its rules and their ids, whatever they are called", async () => {
  // What the old first run seeded, as a user went on to edit it: the ids an
  // install's usage hangs off must come back exactly as stored (DESIGN.md §24).
  const rules = [
    { id: "youtube", label: "YouTube", match: ["youtube.com"], mode: "audible", budgetSec: 0, windowSec: 3600 },
    { id: "instagram", label: "Reels", match: ["instagram.com"], mode: "focus", budgetSec: 60, windowSec: 120 },
  ];
  reset({ version: 2, rules });
  const loaded = await loadRules();
  assert.deepEqual(
    loaded.map((r) => [r.id, r.label, r.match, r.budgetSec]),
    rules.map((r) => [r.id, r.label, r.match, r.budgetSec]),
  );
  assert.equal(writes, 0, "loading never rewrites the settings");
  assert.deepEqual(data.get(SETTINGS_KEY).rules, rules);
});
