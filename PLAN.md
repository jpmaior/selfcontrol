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

`web-ext lint` is already clean (0 errors, 0 warnings). Getting there surfaced a mandatory
manifest key now recorded in DESIGN.md §2: `data_collection_permissions` is required for new
extensions and forces a version floor. We pin **154** on both desktop and Android, matching the
development browser.

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
nix develop --command node --test    # 21 tests, no browser involved
```

Then in the browser, with the extension's devtools console open:

1. Play a YouTube video ~90 seconds, pause. Run `dumpUsage()` → `youtube` shows ~1:30 used.
2. Play another 30s, pause → ~2:00.
3. Leave it paused several minutes and re-run `dumpUsage()` → **unchanged**. Nothing accrues
   while paused; that is the whole point of the design.
4. While a video is *playing*, run `dumpUsage()` twice a few seconds apart → the number moves
   even though no interval has closed. That is the live projection (DESIGN.md §5) at work.
5. Focus Instagram for ~30s, switch away → `instagram` shows ~0:30.

⚠️ **Keep the devtools console attached throughout.** Step 3 holds the ledger in memory only, so
it resets whenever the event page unloads — and an attached console is what prevents that. Making
these numbers survive is precisely what Step 4 does.

A second or two of drift is expected. Anything larger is a bug.

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

1. Accrue ~1 minute, pause, then **Reload** the extension → `dumpUsage()` still reports that
   minute (that is `storage.local` doing its job).
2. **Kill the event page mid-playback:** start a video, let it run ~30s, then click **Terminate
   Background Script** while it is *still playing*. Reopen the console — the startup log should
   say `1 interval(s) still open`, and the count keeps climbing from where it was rather than
   restarting at zero. This is the exact MV3 failure mode we are defending against, and
   *Terminate* — not *Reload* — is the button that reproduces it.
3. **The leftover case:** start a video, Terminate the background script, then pause the video
   *before* reopening the console. On the next start you should see a `reconciled youtube:`
   line. It deliberately credits only up to the last proven flush rather than guessing, so
   expect it to under-count slightly — that is the honest choice, not a bug.
4. Quit Firefox entirely, relaunch `web-ext run` → usage survives (`storage.local`), open
   intervals do not (`storage.session`, by design).
5. **Write volume.** Watch continuously for ~6 minutes, then `dumpStats()`. `localWrites`
   should be in the low single digits — one per checkpoint plus one per transition, not one
   per second. This is the claim in DESIGN.md §6 that the whole no-tick design exists to make
   true.
6. `dumpRaw()` prints what is actually in both stores plus the JSON byte count. Expect
   well under 1KB per rule.

---

## Step 5 — Enforcement

The part with teeth.

**Build:** `background/enforcer.js` — exhaustion alarm, block-vs-close, the `tabs.onCreated`
re-open guard, `blocked/blocked.html` with a live countdown and a funny message,
`minUnlockCreditSec`.

Real budgets take an hour to test, so `setLimits()` is exposed on the console and persists an
override. Shrink everything first:

```js
await setLimits("youtube",   { budgetSec: 30, windowSec: 120, minUnlockCreditSec: 30 })
await setLimits("instagram", { budgetSec: 20, windowSec: 120, minUnlockCreditSec: 20 })
await resetUsage()     // then Reload the extension
```

`resetLimits()` puts the real numbers back.

### ✅ Checkpoint 5

1. Play a YouTube video → at ~30s the tab redirects to the block page, with a quip and a
   countdown that actually ticks.
2. Navigate back to YouTube → blocked again immediately (the `onUpdated` guard).
3. Open YouTube in a **new tab** → blocked immediately (the `onCreated` guard).
4. Wait out the countdown → the page flips to its unlocked state on its own, and YouTube loads
   normally again.
5. Instagram is `onExceed: "close"` — focus it for 20s → the tab closes. Reopen it → closes
   again immediately.
6. **The drip-feed.** `await setLimits("youtube", { minUnlockCreditSec: 0 })`, then burn the
   budget → you should unlock after a single bucket expires and get re-blocked almost at once.
   Compare against `minUnlockCreditSec: 30`, which should wait noticeably longer. This is the
   behaviour you asked to keep available, and the unit tests already pin its ordering.
7. **Resolve the open question.** Every exhaustion alarm logs
   `fired +Nms vs scheduled`. If Firefox honours sub-minute delays, N is small. If it clamps
   like Chrome, expect the last alarm before a block to run up to a minute late. Report the
   numbers and I will record the answer in DESIGN.md §5.

If the block page fails to load with a security error, we need
`web_accessible_resources` in the manifest — `tabs.update()` to an own-extension page should not
require it, but that is worth finding out here rather than assuming.

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
- [x] Step 3 — accountant *(21 unit tests pass; Checkpoint 3 awaiting your run)*
- [x] Step 4 — persistence *(built; Checkpoint 4 awaiting your run)*
- [x] Step 5 — enforcement *(Checkpoint 5 verified)*
- [ ] Step 6 — popup
- [ ] Step 7 — options
- [ ] Step 8 — polish
- [ ] Later — Android
