# TODO

Validated findings from two code reviews (2026-08-31). Every item here was verified against the
code; claims that did not hold up were dropped. Keep the scope: fixes only, no new features.

## Bugs

- [ ] **Deleting every rule resurrects the defaults.** `settings.js` treats `rules: []` as
  "never configured" (`length > 0` guard) and re-seeds YouTube/Instagram on the next event-page
  start. An empty array is a legitimate configuration; only a *missing* `settings` key is first
  run. Drop the length check — `extension/common/settings.js:22`.

- [ ] **`load()` bypasses the write chain and loses in-flight usage.** On a settings save,
  `stopCounting()`/`flush()` enqueue their writes, but `load()` issues its `storage.local.get`
  synchronously — deterministically *before* the queued set lands. The in-memory ledger is
  rebuilt from pre-flush data and the just-settled interval (up to 5 min) is overwritten on the
  next flush, whenever a rule was counting at save time. Fix: `await settled()` at the top of
  `load()` — also closes the analogous `storage.session` race on the `open:` keys —
  `extension/background/store.js:80`.

- [ ] **Delete a rule and re-add one with the same name in one save → it inherits the old
  usage.** `taken` is built from surviving drafts only, so the freed id is re-minted; the
  background sees the id present in `next` and never forgets `usage:<id>`. Violates the
  "an id keys its usage" invariant. Fix: options page carries the ids it started with and passes
  them to `makeRuleId` as also-taken — `extension/options/options.js:129`,
  `extension/background/index.js:120`.

- [ ] **Tab-level mute probably does not stop the clock, contrary to DESIGN.md §3.** Per MDN,
  `tab.audible` stays true while the tab is muted via the speaker icon; `isCounting` never
  consults `mutedInfo` even though it sits in the event filter. **Hand-check on Firefox first**
  (Checkpoint 2 only tested element-level muted hover-previews). Then either honour it with
  `&& !tab.mutedInfo?.muted` — in *both* `handleTabUpdated` and `prime()` — or correct
  DESIGN.md §3 — `extension/background/observers.js:52,90,116`.

- [ ] **`onExceed: "close"` on the only tab closes the window — and the last window closes
  Firefox** (default `closeWindowWithLastTab`). The shipped Instagram default uses `close`, so
  this is reachable. Navigate the last tab in a window to `about:newtab` instead of removing it —
  `extension/background/enforcer.js:38`.

## Duplication the code's own structure argues against

- [ ] **`blocked.js` reimplements `clock()`** — with ceil semantics, i.e. exactly
  `format.countdown()`, so the "cannot drift" promise in `format.js`'s header has already been
  broken. `blocked.html` loads it as a module; import from `../common/format.js` —
  `extension/blocked/blocked.js:38`.

- [ ] **`popup.js` redefines `MODE_HINT`** while `MODES[].hint` in `rules.js` carries the same
  strings, unused. Import `MODES` and index it (or drop the `hint` field) — a new mode currently
  needs two edits or the popup shows blank — `extension/popup/popup.js:18`.

## Smaller things

- [ ] **Subdomain shadowing is not caught by validation.** `validateRule` compares domains by
  exact string, so `music.youtube.com` after a `youtube.com` rule passes validation but is dead
  code. Use `hostMatches` in the shadowing check — `extension/common/rules.js:188`.

- [ ] **The block page polls the background every 5s forever**, pinning the event page alive —
  at odds with the zero-wake-ups design. Gate the poll on `document.visibilityState` and refresh
  on `visibilitychange` — `extension/blocked/blocked.js:98`.

- [ ] **Trailing-dot hostname bypass.** `https://youtube.com./` yields hostname
  `"youtube.com."`, which matches nothing. Strip a trailing `.` in `hostnameOf` —
  `extension/common/rules.js:66`.

- [ ] **Async `onMessage` listener claims the response channel for every message.** Harmless
  with a single listener; make it a sync listener returning a promise only on the `status`
  branch — `extension/background/index.js:210`.

- [ ] **`setLimits()` skips validation.** `budgetSec: 0` yields `exhausted: true` with
  `unlockAtMs === now`: the block page instantly shows "available again" while `guardTab` keeps
  re-blocking. Run patches through `validateRule` (note: the reviewed claim that `unlockAt` can
  return `null` here is *wrong* — the `min(needed, budgetMs)` clamp makes that unreachable) —
  `extension/background/index.js:229`.

## Testing

- [ ] **Cover `store.js`'s lifecycle logic with a `globalThis.browser` stub** (~40 lines, no
  refactor needed — browser APIs are only touched inside function bodies; install the stub
  before import for `observers.js`'s module-scope `browser?.windows` read). Priority:
  `reconcile()`'s still-counting vs settle-to-lastFlush decision and the checkpoint/sleep-clamp
  interaction. Would have caught the `load()` write-chain bug.

## Doc drift

- [ ] DESIGN.md §6 (storage sketch) shows `usage:<id> → { b: {...}, blockedUntil }`; there is no
  `blockedUntil` — the unlock instant is derived by `unlockAt()`, which is the better design.
  Update the doc.

- [ ] DESIGN.md §7 says enforcement reacts to `tabs.onActivated`; only `onCreated` and
  `onUpdated` are guarded, and the exhaustion sweep makes the activation guard redundant. Update
  the doc.
