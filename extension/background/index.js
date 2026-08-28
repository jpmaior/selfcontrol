// Background event page.
//
// Step 2 (PLAN.md): observe tabs and windows and log when each rule starts and
// stops being consumed. Nothing is counted, stored or blocked yet — this step
// exists purely so Checkpoint 2 can validate by hand that `tab.audible` is a
// trustworthy proxy for "a video is playing" (DESIGN.md §3) before five steps
// of machinery are built on top of it.

import { log } from "./log.js";
import { DEFAULT_RULES } from "./rules.js";
import { start } from "./observers.js";

log(`event page started — v${browser.runtime.getManifest().version}`);

// Deliberately not awaited. An MV3 event page is restarted *by* an event, and
// the listener has to already exist for that event to be deliverable — so
// listener registration must happen during synchronous module evaluation.
// start() attaches all of its listeners before its first await; the promise it
// returns only covers rebuilding derived state from the open tabs.
start({
  rules: DEFAULT_RULES,
  trace: true, // Step 2 only: raw per-tab event trace for the checkpoint.
  onChange(rule, counting, why) {
    log(
      counting ? "▶ COUNTING" : "■ stopped  ",
      `${rule.id} (${rule.mode})`,
      `— ${why}`,
    );
  },
}).catch((error) => log("observer startup failed:", error));

browser.runtime.onSuspend.addListener(() => {
  log("event page suspending (normal — MV3 unloads us when idle)");
});

log("observers attached — rules:", DEFAULT_RULES.map((r) => `${r.id}:${r.mode}`).join(", "));
