// Background event page.
//
// Step 1 (PLAN.md): prove the toolchain end to end — the manifest loads, the
// MV3 event page runs, ES module imports resolve, and web-ext live-reloads on
// save. No rules, no counting, no storage yet.

import { log } from "./log.js";

const { version } = browser.runtime.getManifest();

log(`event page started — v${version}`);
log("ES module import resolved, so the multi-file background will work");

browser.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  log("onInstalled:", reason, previousVersion ? `(from ${previousVersion})` : "");
});

// Expect to see this a lot. MV3 unloads an idle event page aggressively, and
// every design decision in DESIGN.md §5 exists because of it. Watching it fire
// here is the cheapest way to get a feel for the lifecycle before it matters.
browser.runtime.onSuspend.addListener(() => {
  log("event page suspending (normal — MV3 unloads us when idle)");
});
