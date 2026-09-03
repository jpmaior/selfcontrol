# SelfControl — Design

A Firefox extension that imposes strict, **activity-aware** time limits on websites.

The distinguishing idea: the clock only runs while you are *actually consuming* the site.
YouTube time counts while a video is playing (including in a background tab) and stops when
you pause. Instagram time counts only while its tab is the focused tab in the focused window.
Sitting on a paused video costs nothing.

---

## 1. Core abstraction

Everything is one concept with a swappable predicate:

> A **rule** watches a set of domains. Its **counting mode** decides, at any instant, whether
> the clock is running. It has a **budget** over a **rolling window**. When the budget is
> spent, an **enforcement action** fires.

```js
{
  id: "youtube",
  label: "YouTube",
  match: ["youtube.com"],       // hostname suffix match (covers m./www./music.)
  mode: "audible",              // clock runs while a matching tab produces sound
  budgetSec: 300,               // 5 minutes ...
  windowSec: 3600,              // ... per rolling hour
  onExceed: "block",            // "block" -> redirect to block page, "close" -> close tab
  minUnlockCreditSec: 300       // once blocked, stay blocked until 5 min of credit exist
}
```

```js
{
  id: "instagram",
  label: "Instagram",
  match: ["instagram.com"],
  mode: "focus",                // clock runs only while it is the focused tab
  budgetSec: 300,
  windowSec: 3600,
  onExceed: "close",
  minUnlockCreditSec: 300
}
```

YouTube and Instagram are the **same code path** with two different mode predicates. This is
the most important decision in the design: there is no YouTube feature and no Instagram
feature, only modes.

### Counting modes

| Mode | Clock runs while... | Implemented via |
|---|---|---|
| `audible` | any matching tab is producing sound | `tabs.onUpdated` filtered on `audible` |
| `focus` | a matching tab is the active tab of the focused window | `windows.onFocusChanged`, `tabs.onActivated`, `tabs.onUpdated` |
| `open` *(future)* | any matching tab exists at all | `tabs.onCreated` / `onRemoved` |

Counting state is **per rule, not per tab**. Three YouTube tabs playing simultaneously burn
one second per second, not three.

---

## 2. Platform decisions

### Manifest V3, event page

Firefox MV3 uses **event pages** (`"background": { "scripts": [...] }`), not Chrome's service
workers. The usual arguments against MV3 do not apply here: we never need blocking
`webRequest`, and Firefox has kept event pages as ordinary DOM pages that are merely unloaded
when idle.

The one constraint MV3 imposes is decisive for the architecture:

> **The background script is killed and restarted constantly.** Any design that increments a
> counter in a module-level variable on a `setInterval` is dead on arrival.

Section 5 is built around this — and the MV3-safe design also turns out to be the one that
minimises disk writes, so the constraint costs nothing.

Chrome compatibility is explicitly a non-goal.

Background scripts are loaded as **ES modules** (`"type": "module"`), verified working at
Checkpoint 1, so the background can be split across files without a bundler.

> ⚠️ **Development trap, found at Checkpoint 1.** An attached devtools toolbox *pins the event
> page alive* — Firefox reports "background event page was not terminated on idle because a
> devtools toolbox is attached". With the console open, the suspend/restart cycle never happens,
> so MV3 lifecycle bugs stay invisible during development and only appear in normal use. Force
> it with **Terminate Background Script** in `about:debugging`. Note the difference from
> **Reload**: *Terminate* unloads only the event page and leaves `storage.session` intact
> (the real-world failure mode); *Reload* restarts the whole extension and clears it.

### Manifest floors (discovered via `web-ext lint`, Step 1)

Firefox now requires every new extension to declare what data it collects. We collect none:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "selfcontrol@jpmaior",
    "strict_min_version": "154.0",
    "data_collection_permissions": { "required": ["none"] }
  },
  "gecko_android": { "strict_min_version": "154.0" }
}
```

`data_collection_permissions` is the key that forces a floor at all — it landed in Firefox 140
desktop / 142 Android, so anything below that fails lint. We pin **154** on both instead, matching
the development browser: this is a personal tool with no obligation to support older Firefox, and
a high floor means every API in DESIGN.md is simply available with no capability checks.

Declaring `gecko_android` is also what keeps `web-ext lint` at zero warnings. It has no effect on
desktop behaviour and only matters if the add-on is ever listed on AMO.

### Permissions

```json
"permissions": ["storage", "tabs", "alarms"]
```

- **`storage`** — usage counters and settings.
- **`tabs`** — required to read `tab.url` for arbitrary tabs and to observe `tab.audible`,
  `tabs.onActivated`, `tabs.onRemoved`. `tabs.update()` (redirect) and `tabs.remove()` (close)
  need nothing beyond this.
- **`alarms`** — wake-ups that survive the event page being unloaded.

**No host permissions. No `<all_urls>`. No content scripts.** This matters more in Firefox MV3
than it first appears: host permissions declared in an MV3 manifest are *not granted at install
time*. The user must grant them from the add-on's permissions panel, and until they do the
extension silently does nothing. Avoiding them means the extension simply works after install,
and the install prompt reads "Access browser tabs" rather than "Access your data for all
websites."

Deferred until needed:

| Permission | Buys us |
|---|---|
| `idle` | stop the clock when the user walks away (matters for `focus` mode) |
| `notifications` | "5 minutes of YouTube left" |
| `declarativeNetRequest` | network-level blocking with no flash of content |

---

## 3. Detecting playback (`audible` mode)

### Chosen approach: `tab.audible`

Every tab carries an `audible` boolean, and we subscribe once with a property filter:

```js
browser.tabs.onUpdated.addListener(handler, { properties: ["audible", "url"] });
```

Why this over a content script:

- No injection, **no host permissions** (see above).
- Works in background tabs, in Picture-in-Picture, and inside cross-origin iframes.
- Works for *any* site — Netflix, Twitch, Spotify — with no per-site code.
- **It ignores YouTube's muted hover-preview autoplay for free.** Drifting the cursor across
  the home page starts muted preview clips; a naive `<video>` detector would silently burn the
  budget. Muted playback produces no sound, so `audible` never sees it.

### ✅ Validated at Checkpoint 2

Confirmed by hand on Firefox 154 before anything was built on top of it:

| Scenario | Result |
|---|---|
| Video plays / pauses | counting starts and stops reliably |
| Playing in a background tab | keeps counting |
| **YouTube home page, muted hover-previews** | **never counts** — the failure mode this design was chosen to avoid |
| Two videos at once | one clock, stops only when both stop |
| `focus` mode incl. alt-tab away from Firefox | behaves as designed |

**Accepted loophole:** muting — either the `<video>` element or the tab's own speaker icon —
stops the clock, so muted playback with captions is unlimited. Deliberately not closed: a silent
video is punishment enough, and closing it would mean giving up the hover-preview immunity that
makes `audible` worth using in the first place.

### Fallback if `tab.audible` proves inadequate: content script

Inject on matched domains and catch media events at the **document level in the capture
phase**:

```js
document.addEventListener("play",  onPlay,  true);  // capture = true
document.addEventListener("pause", onPause, true);
document.addEventListener("ended", onPause, true);
```

`play`/`pause` do not bubble, so a normal `document` listener never sees them — but
capture-phase listeners do, because capture descends to the target. That single `true` catches
every `<video>` on the page including ones YouTube's SPA creates minutes later, with no
`MutationObserver` and no polling.

Costs: host permissions and their MV3 grant problem, hand-written noise filtering for hover
previews, and no coverage of cross-origin iframes.

---

## 4. Detecting focus (`focus` mode)

Three events fully determine the foreground:

- **`windows.onFocusChanged`** — fires with `windows.WINDOW_ID_NONE` when Firefox loses focus
  entirely. This is the event that makes the feature honest: alt-tab to an editor and the clock
  stops.
- **`tabs.onActivated`** — the user switched tabs.
- **`tabs.onUpdated`** (url) — the active tab navigated elsewhere.

From these we maintain one derived value — *which rule, if any, currently owns the foreground*
— and start/stop its clock on change.

`idle` (deferred) closes the remaining hole: `idle.setDetectionInterval(60)` plus
`idle.onStateChanged` stops the clock when the user leaves Instagram focused and walks away.
Without it, lunch costs the Instagram budget.

---

## 5. Counting time without ticking

**Do not tick.** No timer increments a counter every second. Record *state transitions and
timestamps*, and do arithmetic:

```js
function startCounting(rule) {
  if (open[rule.id]) return;
  open[rule.id] = { since: Date.now() };
  scheduleExhaustionAlarm(rule);
}

function stopCounting(rule) {
  const o = open[rule.id];
  if (!o) return;
  commit(rule, o.since, Date.now());
  delete open[rule.id];
  flush(rule);
}
```

While a video plays for twenty uninterrupted minutes this performs **zero writes and zero
wake-ups**. All work happens at `play` and `pause`.

### The rolling window is a sparse bucket map

Time is sliced into fixed 60-second buckets keyed by `Math.floor(epochMs / 60000)`. `commit()`
splits an interval across the buckets it spans:

```js
usage = { b: { "29384756": 60000, "29384757": 60000, "29384758": 23400 } }
//              ^ bucket index      ^ milliseconds accrued in that bucket
```

Values are **milliseconds**, not seconds, so that many short intervals cannot accumulate
rounding drift in the core ledger. The JSON is a few hundred bytes larger per rule, which is
nothing.

- **Usage in window** = sum of buckets whose start is `>= now - windowSec`. The boundary bucket
  is counted *whole* rather than prorated — we know how much was used inside a bucket but not
  *when* within it, so prorating would be a guess. Counting it whole over-counts by at most one
  bucket, erring toward blocking slightly early, which is the right direction here.
- **Pruning** = delete keys below that threshold, done on every commit, so it never grows.
- A 20-minute budget can never produce more than ~20 non-zero buckets: **under 1KB per rule**,
  naturally self-limiting.

Live readings (popup, block page) are taken from a **non-destructive projection** that folds the
currently open interval into a copy of the ledger. That keeps displayed numbers honest between
checkpoints without writing anything.

This representation also yields, for free, the thing the block page needs: the moment the
*oldest* bucket falls out of the window is exactly when the next second of quota returns. So
the block page can say "unlocks in 7 minutes" rather than just "no".

### Waking up at the right moment

The event page is asleep while a video plays. Enforcement needs exactly one wake-up, and
`browser.alarms` survives the background page being unloaded — **`setTimeout` does not**, which
is the classic MV3 bug.

Schedule one alarm at `now + (budget − used)`. That estimate is **always early or exact, never
late**, because a rolling window only ever regenerates quota in the user's favour. When it
fires, recompute; if not actually exhausted, reschedule. Correct without simulating the window
forward.

> **Status after Checkpoint 5:** enforcement lands correctly in practice — blocking, the re-open
> guard and unlocking all verified by hand. What has *not* been measured is whether Firefox
> clamps sub-minute alarm delays the way Chrome does (30s minimum). Every exhaustion alarm logs
> `fired +Nms vs scheduled`, so the answer is one glance at the console away if it ever matters.
> It would show up as a block landing up to a minute late, and only for the final alarm before
> exhaustion.

### Crash and sleep resilience

A dangling open interval is lost if Firefox crashes, so a **checkpoint alarm** fires every 5
minutes while counting and does `commit(since, now); since = now; flush()`. Cost: ~12 writes per
hour of continuous watching instead of 240.

The same checkpoint handles **laptop sleep**, which would otherwise silently eat the whole
budget. Each committed chunk is clamped to `1.5 × checkpointInterval`: a three-hour suspend
counts as 7.5 minutes, not 180.

The checkpoint interval is the single tuning knob, trading write volume against crash loss and
sleep over-count. Default: 5 minutes.

---

## 6. Storage

`storage.local` for everything. **Never `storage.sync` for counters** — it has hard rate limits
(~120 writes/minute, ~1800/hour) and an 8KB-per-item cap, and would be throttled immediately.
Sync is for settings only, and only if cross-device settings sync is ever wanted.

### Hot and cold keys are split

`storage.local.set()` rewrites the whole key it touches. One monolithic `state` object would
mean every counter update also rewrites the settings.

```
settings          → { version, rules: [...] }        // cold: written when a rule is edited
usage:youtube     → { b: {...} }                     // hot: flushed on transitions + checkpoints
usage:instagram   → { b: {...} }
```

The unlock instant is deliberately *not* stored: it is derived on demand by
`accountant.unlockAt()` from the buckets, so it can never go stale as the window rolls.

### Ephemeral state lives in `storage.session`

`storage.session` is memory-backed, never touches disk, and clears on browser restart — exactly
right for "which rules are counting and since when". The event page can be killed, restart, read
`storage.session`, and resume mid-interval without a single disk write.

```
open:youtube      → { since: 1755975000000 }         // RAM only
```

### Flush points

Transitions (play/pause, focus change), checkpoint alarms, and `runtime.onSuspend` (best-effort
— Firefox event pages do fire it, but the checkpoint alarm is the real guarantee).

### Budget

Ten rules total under 10KB. Roughly 15–20 writes during an hour of heavy use. Disk *space* was
never the concern; write amplification was, and the transition model eliminates it.

---

## 7. Enforcement

React to `tabs.onCreated` and `tabs.onUpdated`: if a tab's URL matches a rule that is
currently over budget, act immediately. `tabs.onActivated` needs no guard — the moment a rule
runs out, every matching tab is swept, so a spent rule has no tab left to activate.

- **`onExceed: "block"`** → `tabs.update(tabId, { url: runtime.getURL("blocked.html?...") })`.
  The default. The message lands, the countdown is visible, and Back does not rescue you because
  the re-navigation is re-blocked.
- **`onExceed: "close"`** → `tabs.remove(tabId)`.

The "reopen it and it closes again immediately" requirement is the *same guard* running on
`tabs.onCreated`, so it costs nothing extra.

Known weakness: a brief flash of real content before the redirect lands. The upgrade path is
`declarativeNetRequest` dynamic rules, which redirect at the network layer with nothing
rendered — deferred, because the rules must be added and removed as quota changes.

---

## 8. `minUnlockCreditSec` — taming the drip-feed

A naive rolling window behaves badly. Spend the whole budget in one sitting and get blocked. An
hour after starting, the first minute of usage falls out of the window, so you get **exactly one
minute of YouTube, then blocked, then one more minute, forever.** Technically correct,
behaviourally useless.

`minUnlockCreditSec` fixes it: once blocked, stay blocked until at least that much budget has
regenerated.

| Value | Behaviour |
|---|---|
| `0` | pure rolling window — the drip-feed, available on purpose |
| `300` | **default** — unlock in usable 5-minute chunks |
| `= budgetSec` | strict — stay blocked until the full budget is back |

One knob spans every variant, so it is built in from the start rather than discovered later.

> ⚠️ **Subtlety, caught by a unit test in Step 3.** "When will 0 ms of credit be available?" is
> trivially satisfied *right now*, so passing `minUnlockCreditSec: 0` straight into
> `creditAvailableAt` would mean the rule **never blocks at all** — the exact opposite of the
> drip-feed. The threshold is therefore `max(minUnlockCreditSec, 1ms)`, and that clamp lives in
> `accountant.unlockAt()`, the one function that owns rule semantics. `creditAvailableAt` stays
> mathematically honest.

---

## 9. Non-goals and honest limits

- **Chrome support.** Explicitly out of scope. `browser.*` with promises throughout.
- **Unbypassability.** Disabling the add-on is always two clicks away. This is a speed bump
  against yourself, not a lock.
- **Private windows.** Firefox disables extensions in private browsing by default and an
  extension cannot grant itself that access. Out of scope by decision; flip "Run in Private
  Windows" manually if wanted.
- **Build tooling.** No bundler, no framework, no transpiler. Plain ES modules and `web-ext`.

---

## 10. Architecture map

```
background/ (event page — the only stateful component)
  ├─ index.js       wiring, lifecycle, alarms, messaging
  ├─ observers.js   tabs/windows events  →  "is rule R counting right now?"
  ├─ accountant.js  pure: bucket commit / prune / rolling sum / time-until-credit
  ├─ enforcer.js    over-budget → block or close; guards new navigations
  └─ store.js       ledgers, debounced flush, storage.session for open intervals

common/ (shared by the background and the UI pages)
  ├─ rules.js       pure: rule shape, hostname matching, domain parsing, validation
  ├─ settings.js    the `settings` key: load, save, and watch for edits
  └─ format.js      duration formatting

options/   edit rules
popup/     "YouTube: 2:30 / 5:00 — unlocks in 8 min"
blocked/   message + live countdown
```

**Two pure modules carry the tricky logic**, with no `browser.*` and no `Date.now()` — time is
always an argument. That is what lets `node --test` cover the rolling-window arithmetic and the
whole options-page validation story without a browser.

**The options page never messages the background.** It writes `settings`; the background listens
via `storage.onChanged`, filtered hard to that one key, and re-arms itself. Edits apply without a
reload, and a console tweak takes the same path a UI edit does.

---

## 11. Roadmap beyond v1

1. `idle` integration for `focus` mode.
2. Notifications at N minutes remaining.
3. `declarativeNetRequest` for flash-free blocking.
4. **Firefox for Android** — *prepared, not verified.* See §12.

---

## 12. Firefox for Android

**Status: prepared, not verified.** The code no longer assumes a desktop browser, but none of
this has been run on a device. Treat everything below as intent, not as tested behaviour.

### What is already in place

- `browser_specific_settings.gecko_android` declares Android support with a 154 floor. Without
  that key AMO will not offer the add-on to Android at all.
- **No API is assumed to exist.** `browser.windows` is feature-detected at module load in
  `observers.js`, because reading `WINDOW_ID_NONE` off an absent namespace would throw before a
  single listener was registered and take the whole background down. `platform.canTrackWindowFocus`
  records the answer, and `dumpPlatform()` prints the full capability report from a real device.
- **Every page is responsive.** The block page was sized for a phone from the start; the popup's
  minimum width is `min(20rem, 100vw)` so the viewport wins on a narrow screen; the options page
  uses an auto-fitting grid that collapses to one column.
- The permissions we use — `storage`, `tabs`, `alarms` — are core APIs, and no host permissions
  or content scripts are involved, which removes the largest class of Android differences.

### The known gap: `focus` mode

Android has one window, and there is no `windows.onFocusChanged` to say the *browser itself* went
to the background. On desktop that event is exactly what stops a `focus` rule counting when you
alt-tab to an editor (§4). Without it, a `focus` rule keeps accruing while you are in another app.

The damage is bounded rather than unbounded: the sleep clamp caps any single commit at
`1.5 × CHECKPOINT_MS`, so a phone left overnight credits minutes, not hours. But the rule is
wrong, and on a phone — where app switching is constant — it is wrong often.

`audible` mode has no such problem, and is arguably *more* correct on Android: media that keeps
playing while you switch apps genuinely is still being consumed.

Options if this matters, in rough order of preference:

1. **`browser.idle`**, if Android provides it — `dumpPlatform()` answers that. Backgrounding the
   app is not idleness, so this is a partial fix at best.
2. **A content script** using the Page Visibility API, which does fire when the app is
   backgrounded. Costs host permissions and their MV3 grant problem (§2) — the thing this design
   has deliberately avoided throughout.
3. **Use `audible` rules on Android and keep `focus` rules for desktop.** The rule set is per
   device already, since `settings` lives in `storage.local`.

### What testing it would involve

```bash
# add pkgs.android-tools to flake.nix for adb
adb devices
web-ext run -t firefox-android --adb-device <ID> --firefox-apk org.mozilla.firefox
```

Then `dumpPlatform()` from the remote console (`about:debugging` on desktop, connected over USB)
answers the open questions in one shot: whether `windows` focus events exist, whether `idle` and
`notifications` are available, and whether `storage.session` behaves. Enforcement, the ledger and
the alarms should port unchanged; the popup opens from the ⋮ menu rather than a toolbar.
