# TODO — Android

Findings from the first on-device test (2026-09-01, Firefox for Android). DESIGN.md §12 called
Android "prepared, not verified"; this is what verification found. Symptom as reported: opening
the popup shows **"Background script not responding."** — which is `popup.js`'s own catch text,
meaning `runtime.sendMessage` rejected because no listener existed in the background.

## The bug

- [ ] **The `tabs.onUpdated` filter argument throws on Android and takes the background down
  before the message listener registers.** Firefox for Android supports the event but not the
  filter parameter (MDN compat data: `version_added: false` for `firefox_android`), and Gecko's
  schema validation *throws* — `Incorrect argument types for tabs.onUpdated` — rather than
  ignoring the extra argument. We pass filters in two places, with different blast radii:

  - `extension/background/observers.js:50` — inside async `start()`, so the throw only rejects
    the `primed` promise. `Promise.all([loaded, primed])` logs "startup failed"; observers are
    dead (the `onRemoved`/`onActivated` registrations after the throw never run) but module
    evaluation continues.
  - `extension/background/index.js:144` — at module top level. This throw **aborts evaluation of
    `index.js`**, so everything below it never runs — including the `runtime.onMessage` listener
    at `index.js:210` that serves the popup and the block page. The popup's `sendMessage` then
    rejects with "receiving end does not exist" on every 1-second refresh, forever. That is the
    reported symptom.

  **Fix:** at both call sites, try the filtered registration and fall back to unfiltered — and
  keep it synchronous, because the register-during-synchronous-evaluation invariant (CLAUDE.md)
  still applies:

  ```js
  try {
    browser.tabs.onUpdated.addListener(handler, { properties: [...] });
  } catch {
    // Firefox for Android rejects the filter argument outright.
    browser.tabs.onUpdated.addListener(handler);
  }
  ```

  Both handlers already cope with arbitrary `changeInfo` (`handleTabUpdated` reads the tab, the
  `index.js` guard delegates to `guardTab`, which filters by rule), so the only cost on Android
  is extra event-page wake-ups for title/favicon changes. Desktop keeps the filter and is
  unaffected.

## Related

- [ ] **`dumpPlatform()` lies about filter support.** Its `"tabs.onUpdated filters"` line is
  `Boolean(browser.tabs?.onUpdated)` — it tests that the *event* exists, so it would report
  `true` on the very device where the filter just crashed us. Report reality: whether the
  filtered registration succeeded (the try/catch above can record it on `platform`) —
  `extension/background/index.js:286`.

- [ ] **Update DESIGN.md §12** from "prepared, not verified" to record what the device test
  found: the `windows` feature-detect held up, the `onUpdated` filter was the landmine, and the
  filter limitation is permanent Android behaviour, not a version floor issue.

## Verification on device

After the fix, re-check on the phone (the fast path is `web-ext run -t firefox-android
--adb-device <ID> --firefox-apk org.mozilla.firefox`, DESIGN.md §12; or enable *Remote debugging
via USB* in Firefox's settings and inspect from desktop `about:debugging`):

1. Background console shows the normal startup sequence ending in `ready on android — … window
   focus events: NO (Android)` — and no `Incorrect argument types` error. (Before the fix the
   console shows exactly that error; seeing it once confirms this diagnosis.)
2. Popup opens and renders the rules with live meters instead of the error note.
3. `audible` rule: play a video on a limited site → background logs `▶ COUNTING`; pause →
   `■ stopped`. This exercises the unfiltered `onUpdated` path end to end.
4. `dumpPlatform()` now reports `tabs.onUpdated filters: false` on the device, `true` on desktop.
5. Known and accepted (DESIGN.md §12, unchanged by this bug): no `windows.onFocusChanged` on
   Android, so a `focus` rule keeps counting while the browser is backgrounded; the sleep clamp
   bounds the damage.

Not yet checked on device because the background never came up: alarms firing under Android's
process lifecycle, enforcement redirect to the block page, `storage.session` surviving the
event-page unload. The compat tables say all three are supported (`runtime.onSuspend`,
`storage.session`, `alarms` are listed for Android), but they are exactly the kind of thing §12
wanted verified on hardware — walk PLAN.md's checkpoints once the popup is alive.
