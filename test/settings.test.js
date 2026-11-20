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

// --- the week's start day (DESIGN.md §14) ---------------------------------

const { loadSettings, saveRules, saveSettings } = await import("../extension/common/settings.js");
const { DEFAULT_WEEK, changeWeekStart } = await import("../extension/common/calendar.js");

const RULE = { id: "youtube", label: "YouTube", match: ["youtube.com"], mode: "audible", budgetSec: 300, windowSec: 3600 };
const THURSDAY = new Date(2026, 8, 17, 15, 30).getTime();

test("loadSettings: Monday on a first run and on an install that never chose", async () => {
  reset();
  assert.deepEqual((await loadSettings()).week, DEFAULT_WEEK);
  reset({ version: 2, rules: [RULE] });
  const settings = await loadSettings();
  assert.deepEqual(settings.week, DEFAULT_WEEK);
  assert.equal(settings.rules[0].id, "youtube");
  assert.equal(writes, 0, "nothing written");
});

test("loadSettings: a stored week comes back; a malformed one reads as Monday and is left as it is", async () => {
  const week = { startDay: 0, carry: { from: 1, until: 2 } };
  reset({ version: 2, rules: [], week });
  assert.deepEqual((await loadSettings()).week, week);

  reset({ version: 2, rules: [], week: { startDay: 9 } });
  assert.deepEqual((await loadSettings()).week, DEFAULT_WEEK);
  assert.deepEqual(data.get(SETTINGS_KEY).week, { startDay: 9 }, "not rewritten");
  assert.equal(writes, 0);
});

test("saveRules: keeps the week as it is", async () => {
  const week = { startDay: 6, carry: null };
  reset({ version: 2, rules: [], week });
  await saveRules([RULE]);
  assert.deepEqual(data.get(SETTINGS_KEY).week, week);
  assert.deepEqual(data.get(SETTINGS_KEY).rules, [RULE]);
});

test("saveSettings: a new start day keeps the rules and carries the week in progress", async () => {
  reset({ version: 2, rules: [RULE] });
  await saveSettings({ weekStart: 0 }, THURSDAY);
  const stored = data.get(SETTINGS_KEY);
  assert.deepEqual(stored.rules, [RULE]);
  assert.deepEqual(stored.week, changeWeekStart(DEFAULT_WEEK, 0, THURSDAY));
  assert.equal(writes, 1);
});

test("saveSettings: rules and a start day in one write, as an import makes them", async () => {
  reset({ version: 2, rules: [] });
  await saveSettings({ rules: [RULE], weekStart: 6 }, THURSDAY);
  const stored = data.get(SETTINGS_KEY);
  assert.deepEqual(stored.rules, [RULE]);
  assert.equal(stored.week.startDay, 6);
  assert.equal(writes, 1);
});

test("saveSettings: a start day that is not a day is refused, and nothing is written", async () => {
  reset({ version: 2, rules: [RULE] });
  for (const bad of [7, -1, "0", 1.5]) {
    await assert.rejects(saveSettings({ weekStart: bad }, THURSDAY), /week/i, JSON.stringify(bad));
  }
  assert.equal(writes, 0);
});
