# SelfControl — Implementation Plan

Nine small steps, each ending in a **checkpoint you run by hand**. Nothing is built on an
assumption that has not been verified by an earlier checkpoint.

Read [DESIGN.md](./DESIGN.md) first — this file is the sequencing, not the reasoning.

**Ground rule:** one step at a time. Each step ends with a working, loadable extension and
something concrete you can see. If a checkpoint fails, we fix it before moving on.

### Layout we are building toward

```
flake.nix              # dev shell: web-ext, node
web-ext-config.mjs     # so bare `web-ext run` works
DESIGN.md  PLAN.md
extension/
  manifest.json
  background/
    index.js           # wiring + lifecycle
    observers.js       # tab/window events -> "is rule R counting?"
    accountant.js      # PURE: buckets, rolling sums, credit math
    store.js           # storage.local flush + storage.session open intervals
    enforcer.js        # block / close / re-open guard
    rules.js           # rule defaults + hostname matching
  popup/    options/    blocked/
  icons/
test/
  accountant.test.js   # node --test, no browser needed
```

---

## Step 0 — Dev environment

**Build:** `flake.nix` (done), `.gitignore`, `web-ext-config.mjs`.

Both tools are pinned via `flake.lock`: `web-ext 10.6.0`, `node v22.23.2`. The shell hook points
`WEB_EXT_FIREFOX` at your system Firefox 154 so `web-ext` doesn't go hunting.

Note: flakes only see **git-tracked** files, so anything new has to be `git add`-ed before
`nix develop` will notice it.

### ✅ Checkpoint 0 — *verified working*

```bash
cd ~/git/selfcontrol
nix develop
web-ext --version    # 10.6.0
node --version       # v22.23.2
```

You should see the `selfcontrol:` banner from the shell hook. Stay in this shell for every
later step.

---

## Step 1 — A loadable skeleton

The smallest thing Firefox will accept, so we prove the toolchain end to end before any logic
exists.

**Build:** `extension/manifest.json` (MV3, event page, stable `gecko.id`), an SVG icon, and a
two-file background (`index.js` + `log.js`) — deliberately two files, so the checkpoint also
proves **ES module imports work** in a Firefox event page, which every later step assumes.

`web-ext lint` is already clean (0 errors, 0 warnings). Getting there surfaced two manifest
floors now recorded in DESIGN.md §2: `data_collection_permissions` is mandatory for new
extensions and requires Firefox **140** desktop / **142** Android.

### ✅ Checkpoint 1

```bash
nix develop
web-ext run
```

A fresh Firefox window opens with the extension already loaded.

1. It lands on `about:debugging#/runtime/this-firefox` — **SelfControl** is listed.
2. Click **Inspect** next to it → a Console window opens showing:
   ```
   [selfcontrol] event page started — v0.1.0
   [selfcontrol] ES module import resolved, so the multi-file background will work
   [selfcontrol] onInstalled: install
   ```
   That second line is the one that matters — it means `import` resolved.
3. **Seeing the idle unload takes a deliberate step.** An attached devtools toolbox pins the
   event page alive, and Firefox says so outright:
   *"background event page was not terminated on idle because a devtools toolbox is attached."*
   To watch it happen, click **Terminate Background Script** on the extension's row in
   `about:debugging`, then wake it again (reload the extension, or — from Step 2 on — just
   switch a tab). The suspend/restart cycle is the single fact DESIGN.md §5 is designed
   around; trigger it once by hand before Step 3.
4. Edit the text of a `log()` call in `background/index.js`, save → web-ext reloads
   automatically and the new text appears on the next start.

**This proves:** valid manifest, MV3 event page runs on FF 154, ES modules resolve, live-reload
works, and the idle-unload behaviour is real.

---

## Step 2 — Observers, logging only ⚠️ *the load-bearing checkpoint*

No counting, no storage, no blocking. The background subscribes to tab and window events, and
logs the derived answer: *is any rule counting right now, and why?* Rules are hard-coded.

**Build:** `background/rules.js` (hostname suffix matching), `background/observers.js` emitting
`onCountingChange(ruleId, isCounting)`, wired to `console.log` in `index.js`.

This step exists to **validate the central assumption of the whole design** — that `tab.audible`
is a good proxy for "a video is playing" — before anything is built on top of it. If it fails
here, we swap in the capture-phase content script (DESIGN.md §3) at a cost of one step, not six.

### ✅ Checkpoint 2

With the background console open (`about:debugging` → Inspect):

**Audible mode:**
1. Open a YouTube video, press play → `youtube: counting ON`.
2. Pause it → `counting OFF`.
3. Play, then switch to another tab and leave it playing → **stays ON** (background playback).
4. Play, then mute the tab with the tab's speaker icon → observe what happens and tell me. This
   is the one behaviour I want to see rather than predict.
5. **The important one:** sit on the YouTube *home page* and sweep the mouse over thumbnails so
   the muted previews autoplay → should stay **OFF**. If it flickers ON, we have a problem worth
   knowing about now.
6. Open two videos playing at once → exactly one `ON`, and it goes `OFF` only when both stop.

**Focus mode:**
7. Open Instagram → `instagram: counting ON` only when it is the active tab.
8. Switch to another tab → `OFF`. Switch back → `ON`.
9. Alt-tab to a different application entirely (leave Instagram as the active Firefox tab) →
   must go `OFF`. This is `WINDOW_ID_NONE` doing its job.
10. Two Firefox windows, Instagram active in the unfocused one → `OFF`.

Report anything that surprises you. Steps 4 and 5 are the ones I care most about.

---

## Step 3 — The accountant

The rolling-window arithmetic, as a **pure module**: no `browser.*`, no `Date.now()` — the clock
is always an argument. That makes the fiddly parts unit-testable without a browser.

**Build:** `background/accountant.js` — `commit(usage, from, to)` splitting an interval across
60s buckets, `prune`, `usedInWindow(usage, now, windowSec)`, `creditAvailableAt(usage, now,
rule)`. Plus `test/accountant.test.js`. Wired into Step 2's transitions, **in memory only** — no
persistence yet.

Cases the tests must pin down: an interval inside one bucket; an interval spanning several; the
window boundary; pruning; the sleep clamp (`1.5 × checkpoint`); and the "when does the next
second of credit arrive" calculation that the block page will depend on.

### ✅ Checkpoint 3

```bash
node --test          # all green, no browser involved
```

Then, in the browser, with a temporary `dumpUsage()` exposed on the background console:

1. Play a video for ~90 seconds, pause. `dumpUsage("youtube")` → ~90s, spread across 2–3 buckets.
2. Play another 30s → ~120s total.
3. Confirm nothing accrues while paused, even after several minutes.

Expect a second or two of drift from the event-page lifecycle. Anything larger is a bug.

---

## Step 4 — Persistence

Make it survive the event page being killed, and keep the write count honest.

**Build:** `background/store.js` — `storage.local` under `usage:<ruleId>`, `storage.session` for
open intervals, a checkpoint alarm every 5 min, flush on transition and on `runtime.onSuspend`.

### ✅ Checkpoint 4

Two different buttons in `about:debugging` mean two different things, and the distinction is the
whole point of this step:

| Button | Effect | `storage.session` |
|---|---|---|
| **Terminate Background Script** | unloads the event page only | **survives** |
| **Reload** | restarts the whole extension | cleared |

1. Accrue ~1 minute, pause, then **Reload** the extension → `dumpUsage` still reports that
   minute (that is `storage.local` doing its job).
2. **Kill the event page mid-playback:** start a video, then click **Terminate Background
   Script** while it is still playing. The open interval must be recovered from
   `storage.session` and keep counting. This is the exact MV3 failure mode we are defending
   against, and *Terminate* — not *Reload* — is the button that reproduces it.
3. Quit Firefox entirely, relaunch `web-ext run` with a persistent profile → usage survives
   (`storage.local`), open intervals do not (`storage.session`, by design).
4. Watch continuously for ~6 minutes and confirm exactly one checkpoint write lands, not 360.

---

## Step 5 — Enforcement

The part with teeth.

**Build:** `background/enforcer.js` — exhaustion alarm, block-vs-close, the `tabs.onCreated`
re-open guard, `blocked/blocked.html` with a live countdown and a funny message,
`minUnlockCreditSec`.

Test with an absurd config: `budgetSec: 30`, `windowSec: 120`, so a full cycle takes two minutes
instead of an hour.

### ✅ Checkpoint 5

1. YouTube, 30s budget: play a video → at ~30s it redirects to the block page.
2. The block page shows a countdown to unlock that actually ticks down.
3. Navigate back to YouTube → blocked again, immediately.
4. Open YouTube in a **new tab** → blocked immediately (the `onCreated` guard).
5. Wait out the countdown → YouTube loads normally again.
6. Switch Instagram to `onExceed: "close"`, burn its budget → the tab closes. Reopen it → closes
   again immediately.
7. **`minUnlockCreditSec: 0`** → confirm you get the drip-feed (brief unlock, immediate re-block)
   — the behaviour you explicitly want available.
8. **Resolve the open question:** log the gap between the scheduled exhaustion alarm and when it
   actually fires. If Firefox clamps sub-minute alarms like Chrome does, we will see it here and
   note it in DESIGN.md §5.

---

## Step 6 — Popup

**Build:** `popup/` — per rule: used / budget, whether it is counting right now, time until
unlock if blocked. Read-only. Sized so it will survive the Android port later (DESIGN.md §11).

### ✅ Checkpoint 6

Toolbar button shows live numbers; open it while a video plays and watch the counter move; the
blocked state reads clearly.

---

## Step 7 — Options page

**Build:** `options/` — add/edit/delete rules, replacing the hard-coded list. Written to
`settings` in `storage.local`, with the defaults from Step 2 as the initial seed.

### ✅ Checkpoint 7

Add a rule for a throwaway site with a 20s budget, confirm it takes effect without reloading the
extension; edit a budget and see it apply; delete it and confirm its usage data is cleaned up.

---

## Step 8 — Polish

Pick from: `idle` integration for `focus` mode, notifications at N minutes remaining, a rotating
set of block-page messages, real icons, `web-ext lint` clean for AMO submission.

### ✅ Checkpoint 8

`web-ext lint` reports no errors; `web-ext build` produces an installable `.xpi`.

---

## Later — Firefox for Android

Add `browser_specific_settings.gecko_android`, make popup and options responsive, uncomment
`android-tools` in `flake.nix`, and iterate with `web-ext run -t firefox-android`. The background
logic ports unchanged.

---

## Status

- [x] Step 0 — dev environment *(Checkpoint 0 verified)*
- [x] Step 1 — loadable skeleton *(lint clean; Checkpoint 1 awaiting your run)*
- [x] Step 2 — observers *(Checkpoint 2 verified — `tab.audible` holds up, see DESIGN.md §3)*
- [ ] Step 3 — accountant
- [ ] Step 4 — persistence
- [ ] Step 5 — enforcement
- [ ] Step 6 — popup
- [ ] Step 7 — options
- [ ] Step 8 — polish
- [ ] Later — Android
