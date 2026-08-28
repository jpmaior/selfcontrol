// Background event page.
//
// Step 3 (PLAN.md): the observers from Step 2 now drive a ledger. Time is
// accrued by committing intervals between transitions — never by ticking a
// counter (DESIGN.md §5).
//
// Still in memory only: these numbers do not survive the event page being
// unloaded. Step 4 adds storage.local and storage.session. Keep the devtools
// console attached while testing Checkpoint 3, since that is what pins the
// event page alive.

import { log } from "./log.js";
import { DEFAULT_RULES } from "./rules.js";
import { start } from "./observers.js";
import { CHECKPOINT_MS, checkpointRule, clock, describe, startCounting, status, stopCounting } from "./store.js";

const CHECKPOINT_ALARM = "checkpoint";

log(`event page started — v${browser.runtime.getManifest().version}`);

// Not awaited: an MV3 event page is restarted *by* an event, so its listeners
// must exist by the end of synchronous module evaluation. start() attaches all
// of its listeners before its first await.
start({
  rules: DEFAULT_RULES,
  onChange(rule, counting, why) {
    const now = Date.now();

    if (counting) {
      startCounting(rule, now);
      log("▶ COUNTING", `${rule.id} (${rule.mode})`, `— ${why}`);
    } else {
      const credited = stopCounting(rule, now);
      log("■ stopped  ", `${rule.id} (${rule.mode})`, `— ${why}`, `+${clock(credited)}`);
    }

    log("   ", describe(rule, now));
  },
}).catch((error) => log("observer startup failed:", error));

// Folds any open interval into the ledger periodically, so a long session is
// never one enormous unrecorded stretch. In Step 4 this is also the flush point.
browser.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: CHECKPOINT_MS / 60_000 });

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CHECKPOINT_ALARM) return;
  const now = Date.now();
  for (const rule of DEFAULT_RULES) {
    const credited = checkpointRule(rule, now);
    if (credited > 0) log(`checkpoint: ${rule.id} +${clock(credited)}`);
  }
});

browser.runtime.onSuspend.addListener(() => {
  log("event page suspending (normal — MV3 unloads us when idle)");
});

// Console handles for Checkpoint 3. Open the extension's devtools and run
// `dumpUsage()` or `dumpUsage("youtube")`.
globalThis.dumpUsage = (ruleId) => {
  const now = Date.now();
  const rules = ruleId ? DEFAULT_RULES.filter((r) => r.id === ruleId) : DEFAULT_RULES;
  const table = rules.map((rule) => {
    const s = status(rule, now);
    return {
      rule: s.id,
      mode: s.mode,
      counting: s.counting,
      used: clock(s.usedMs),
      budget: clock(s.budgetMs),
      remaining: clock(s.remainingMs),
    };
  });
  console.table(table);
  return table;
};

log("ready — run dumpUsage() in this console");
