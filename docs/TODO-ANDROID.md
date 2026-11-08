# TODO — Android

Findings from the first on-device test (2026-09-01, Firefox for Android). DESIGN.md §12 called
Android "prepared, not verified"; this is what verification found. Symptom as reported: opening
the popup shows **"Background script not responding."** — which is `popup.js`'s own catch text,
meaning `runtime.sendMessage` rejected because no listener existed in the background.

Re-checked on the emulator on 2026-11-08 (Firefox for Android 159, Android 16): the diagnosis
held exactly, the fix below works, and the checks that were blocked behind it have now run. See
[Results on the emulator](#results-on-the-emulator-2026-11-08), including a finding that was
fixed the same day.

## The bug

- [x] **The `tabs.onUpdated` filter argument throws on Android and takes the background down
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

  *Done as `onTabUpdated(handler, properties)` in `observers.js`, used by both call sites. The
  unfiltered fallback also drops events carrying none of the filtered properties, so Android's
  handlers see the same events desktop's do.*

## Related

- [x] **`dumpPlatform()` lies about filter support.** Its `"tabs.onUpdated filters"` line is
  `Boolean(browser.tabs?.onUpdated)` — it tests that the *event* exists, so it would report
  `true` on the very device where the filter just crashed us. Report reality: whether the
  filtered registration succeeded (the try/catch above can record it on `platform`) —
  `extension/background/index.js:286`.

- [x] **Update DESIGN.md §12** from "prepared, not verified" to record what the device test
  found: the `windows` feature-detect held up, the `onUpdated` filter was the landmine, and the
  filter limitation is permanent Android behaviour, not a version floor issue.

- [x] **`audible` mode cannot work on Firefox for Android.** `tab.audible` is a stub there:
  `mobile/shared/components/extensions/ext-android.js` has `get audible() { // TODO bug
  2032751 … return undefined; }`. On the emulator, with a tab audibly playing (Android's media
  session `PLAYING`), every tab reported `audible: undefined`, `tabs.query({ audible: true })`
  returned nothing and `tabs.onUpdated` fired nothing on play or pause. MDN's compat data lists
  it as supported since 54; it is wrong. So the default YouTube rule never counts on Android.
  Options, roughly in order of cost: treat `audible` as `focus` on Android (wrong for background
  playback, which is the case `audible` exists for); a content script reading `media` element
  events on the rule's domains (the host-permission grant problem, DESIGN.md §2); wait for bug
  2032751. `mutedInfo` looks stubbed too (always `{ muted: false }`).

  *Decided 2026-11-08: on Android an `audible` rule counts as `focus` (`effectiveMode()`), the
  options page hides "Count time" and titles that card "1. Domains", and the popup says "counts
  while focused". The stored mode is kept for desktop. DESIGN.md §12. Checked on the emulator:
  the default YouTube rule logged `▶ COUNTING youtube (focus)` on the active tab and blocked on
  time; desktop still shows the dropdown and "counts while playing".*

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

## Results on the emulator (2026-11-08)

Firefox for Android 159.0.1 on the `nix develop .#android` emulator, the add-on loaded with
`web-ext run`. The `audible` checks used a looping `<audio>` tone page served from the host
(`adb reverse`), the rest a `focus` rule pointed at it with `setLimits()`; YouTube's video does
not play reliably under software rendering. The console was read over the remote debugging
port, and detached for the lifecycle checks so the event page could suspend.

1. ✅ Before the fix: `startup failed: Error: Incorrect argument types for tabs.onUpdated.` plus
   the same error thrown at `index.js:147`, and the popup said "Background script not
   responding." After: `ready on android — 2 rule(s), window focus events: NO (Android)`.
2. ✅ The popup renders both rules as a full-screen sheet; blocked rules turn orange with
   `unlocks in …` in step with the block page.
3. ❌ `audible`: never counts, see the finding above. Not caused by this bug. Now counts as
   `focus` on Android.
4. ✅ `dumpPlatform()`: `tabs.onUpdated filters: false` on Android, `true` on desktop. Its
   `idle: false` and `notifications: false` answer nothing: the manifest requests neither
   permission, and desktop reports the same.
5. ✅ (as expected) A `focus` rule keeps counting with Firefox in the background: about 85 of a
   90 s budget were spent while Settings was in front.

And the checks that were blocked behind the bug:

- ✅ `focus` counting starts on the active matching tab and stops on switching tabs.
- ✅ Enforcement: the tab goes to the block page, which renders at phone width with the return
  link; re-opening the site in a new tab is blocked at once (`⛔ blocked re-opened`).
- ✅ Alarms: sub-minute delays are honoured (`fired +3ms` awake). An alarm **woke a suspended
  event page** (`+147ms`) and blocked the tab, also with Firefox in the background.
- ✅ `storage.session` survived the suspension: `1 interval(s) still open`, accounting exact.
- ✅ Options page: stacks at 360dp with Save pinned; saving applies live; validation refuses
  an unlock credit above the budget; the history chart draws.
- ⚠️ The visible block page polls every 5 s, so it keeps the event page awake while on screen
  (by design, per `blocked.js`).
- ⚠️ When an alarm wakes the event page, the startup settle and the alarm handler both enforce:
  the `spent — blocked` and `alarm in` lines log twice. Harmless.
- ❌ Not Android-specific: a blocked rule unlocked as soon as *any* credit returned, ignoring
  `minUnlockCreditSec`. Seen here as "available again" at `0:22 of 0:30`. Fixed in its own
  pull request, which records it in TODO.md.
