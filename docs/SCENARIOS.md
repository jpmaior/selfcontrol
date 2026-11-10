# Browser scenarios

The checks for what `node --test` cannot reach: the observers, the enforcer, the event page's
lifecycle and the three pages. Each one says what to do and what must be observed, and an agent
runs them in a real Firefox with the tools in [DEVELOPMENT.md](./DEVELOPMENT.md): nothing here is
a task for a person.

**When to run them.** Before changing behaviour in one of those areas, run its scenarios against
the current code; a new scenario should fail there if it can. Run them again after the change.
Before a release, run the desktop ones; the Android ones too when the release touches anything
Android sees. Report what was run and what was seen.

**Keeping the list honest.** A PR that changes browser behaviour adds or updates its scenario
here, in the same PR. Anything a pure function decides (validation, parsing, the arithmetic)
belongs in `test/` instead. The *why* stays in DESIGN.md; a scenario only points at it.

## Setup

- **Desktop:** `nix develop .#browser`, then `node tools/browser.mjs start`.
  **Android:** `nix develop .#android`, then `node tools/android.mjs start`. Most scenarios apply
  to both; the sections say where one does not.
- **Short limits.** Real budgets take an hour, so shrink them first with `setLimits()` through
  `eval --bg` (desktop) or `eval` (Android), e.g.
  `setLimits("youtube", { budgetSec: 30, windowSec: 120, minUnlockCreditSec: 30 })`, and start
  from `resetUsage()` followed by `reload`.
- **Something that plays.** YouTube works on desktop once its consent dialog has been rejected.
  For long or hands-off runs, and on the emulator, where YouTube's video does not play reliably
  under software rendering, a local page looping an audio tone is steadier: serve it from the
  host on `127.0.0.1` (on Android, `adb reverse` the port) and add `127.0.0.1` to the rule's
  domains with `setLimits`. `localhost` is refused, because a domain needs a dot.
- **Nothing attached** for anything about the lifecycle. An open console keeps the event page
  alive (DEVELOPMENT.md), so read it with `log` afterwards. Log lines are quoted below as the
  event page prints them.

## Counting while playing *(desktop; Android has no `tab.audible`)*

1. **Play and pause.** Play a video → `▶ COUNTING youtube (audible)`. Pause → `■ stopped`, with
   the time credited.
2. **Background playback.** Play, then switch to another tab → it keeps counting.
3. **Hover previews never count.** On the YouTube home page, sweep the pointer over thumbnails
   so the muted previews autoplay → nothing counts (DESIGN §3).
4. **One clock for two tabs.** Play two videos at once → one `▶ COUNTING`, `■ stopped` only once
   both have stopped, and `dumpUsage()` grows one second per second.
5. **Muting stops the clock.** Mute the playing tab → `■ stopped`. This is the accepted loophole
   (DESIGN §3); if it ever counts, that section and the README are wrong.

## Counting while focused *(desktop)*

1. **The active tab.** Focus a page matching a focus rule → `▶ COUNTING`. Switch tabs →
   `■ stopped`. Switch back → counting again.
2. **Leaving Firefox.** With the matching tab active, give focus to a window outside Firefox →
   `■ stopped` (DESIGN §4).
3. **An unfocused window.** Two Firefox windows, the matching tab active in the one without
   focus → not counting.

## Persistence and the lifecycle

1. **Terminated mid-playback.** Play ~30 s, then `terminate` while still playing → the next start
   logs `1 interval(s) still open`, and `dumpUsage()` keeps climbing from where it was.
2. **Stopped while unloaded.** Play, `terminate`, then pause before anything else wakes the
   page → the pause wakes it and it logs `reconciled youtube: credited …`, up to the pause
   (DESIGN §5).
3. **Hands-off past a checkpoint.** With a 30-minute budget, play 7 minutes and touch nothing →
   the page suspends, the checkpoint alarm wakes it with `checkpoint: youtube +5:00`, and the
   pause adds the rest. `dumpUsage()` shows the time from start to pause, about 7:02.
4. **The sleep clamp.** Play, let the page suspend, then freeze Firefox's process group
   (`SIGSTOP`, then `SIGCONT` 11 minutes later, standing in for a laptop suspend) → the stretch
   is credited at most `+7:30` (DESIGN §5).
5. **Reload.** Accrue a minute, pause, `reload` → `dumpUsage()` still has it; open intervals are
   gone, because Reload clears `storage.session`.
6. **Firefox restarted** (`stop`, `start`) → usage survives, open intervals do not.
7. **Writes stay rare.** Play ~6 minutes untouched → `log` shows one `flushed` line per
   checkpoint and per transition, not one per second (DESIGN §6). `dumpStats()` only counts
   since the event page last started.
8. **Size.** `dumpRaw()` → a few kilobytes per rule at most, history included (DESIGN §6, §13).

## Enforcement

With `budgetSec: 30, windowSec: 120, minUnlockCreditSec: 30` on the rule under test.

1. **Blocked at the budget.** Play → at ~30 s the tab goes to the block page, with a quip and a
   countdown that ticks; the log says `⛔ youtube spent — blocked 1 tab(s); unlocks in …`.
2. **No way back in.** Navigate back → blocked again, also within a second or two of the block
   (DESIGN §7). Open the site in a new tab → blocked at once, `⛔ 1 re-opened youtube`.
   Neither counts. Check it on a focus rule, since on desktop an audible one is redirected
   before it makes a sound: going back in a minute or more after the block logs
   `▷ spent, not counting` rather than `▶ COUNTING`, and the unlock time, on the block page and
   in `dumpUsage()`, stays where it was (DESIGN §7).
3. **Close instead of block.** A rule with `onExceed: "close"` (the default Instagram rule) →
   the tab closes at the budget, and reopening it closes it again at once. No tab opens in its
   place unless it was the last one, in its window on desktop or in Firefox on Android: then
   one fresh tab replaces it (DESIGN §12).
4. **Unlocked on time, not before.** Spend the budget across two buckets (say 12 s and 18 s) →
   when the first ages out the rule stays blocked and the countdown keeps going; it unlocks at
   the promised instant with the full 30 s back, and `dumpRaw()` shows `blockedUntil: null`
   again (DESIGN §8, "The hold").
5. **The drip-feed, on request.** `minUnlockCreditSec: 0` → unlocks as soon as the first bucket
   ages out, and re-blocks soon after.
6. **An alarm wakes the page.** With nothing attached and the page suspended, the block still
   lands on time: `alarm for youtube fired +Nms vs scheduled`, then one `⛔ youtube spent` line,
   not one per path that woke with it (DESIGN §7). Note N: Android gave +3 ms awake and +147 ms
   from suspended; desktop has not been measured (DESIGN §5).
7. **The block page unlocks itself.** Leave it open → when the countdown ends it says
   `YouTube is available again` with no reload.
8. **The return link.** Get blocked on a specific URL → the block page says `You were on …`;
   once unlocked, `Back to …` opens that exact URL, and the clock runs again (DESIGN §19).

## Popup

1. **Live while counting.** Open it while a video plays, even after the page has suspended →
   both rules with used / budget and a meter; the counting rule's numbers move every second.
2. **Paused.** Pause → the row reads `counts while playing` and the numbers hold.
3. **Blocked.** Spend a budget → the row turns orange, reads `blocked` (or `done for today`,
   `done for the week`) and counts down `unlocks in …` in step with the block page.
4. **Width.** On desktop nothing overflows or scrolls sideways, including while a `… Confirm`
   step is armed and with a long rule label. On Android it opens as a full-screen sheet.

## Options page

1. **Edits apply live.** Change a budget and Save → the log says `rules updated` and
   `state re-armed`, the popup shows the new budget, and nothing was reloaded.
2. **A new rule works.** Add a focus rule with a 1-minute budget for some site and Save →
   sitting on that site blocks it.
3. **Deleting discards usage.** With item 2's block page still open in another tab, delete the
   rule and Save → `rule removed: <id> — usage discarded`, and `dumpRaw()` has no `usage:<id>`
   left. Back on the block page, it says `<label> is available again` at once rather than counting
   down to the old time, with no usage line, and `Back to …` opens the site (DESIGN §19).
4. **Renaming keeps it.** Rename a rule and Save → its used time is unchanged.
5. **The form shows what was understood.** Paste `https://www.reddit.com/r/all` into Domains and
   leave the field → it reads `reddit.com`, with a note that only the site is kept and how to
   limit `reddit.com/r/all` alone. Tick *Match paths* → `reddit.com/r/all`, the note goes, the
   label reads `Domains and paths` and a short explanation of matching appears; untick →
   `reddit.com` again.
   A budget equal to the window is refused with the reason shown, and so is a pattern another
   rule already has, naming that rule.
6. **History.** Once buckets have folded (a short window helps) → the rule's history shows
   today's bar and the 7- and 30-day totals; pass time is the lighter segment.

## Caps, lock in and passes

1. **Daily cap.** `dailyBudgetSec: 120`, play 2 minutes → `YouTube is done for today`, the
   countdown ends at local midnight, and the popup's rolling meter is far from full.
2. **Removing it lifts the block.** Clear the daily cap in the options page → the block lifts at
   once.
3. **Weekly cap.** Weekly 60 s and daily 120 s, play 1 minute → `done for the week`, unlocking
   next Monday at 00:00.
4. **Lock in while playing.** Popup → Lock in → `Blocks YouTube until HH:MM. Confirm`; confirm →
   the tab is blocked at once and the block page counts down to that time.
5. **Lock in while idle.** With 3 minutes left → `dumpRaw()` shows 180000 more ms in the current
   bucket and nothing else changed; after `terminate`, the popup still shows it spent.
6. **A pass.** Rolling cap 2 minutes, one 5-minute pass a week. Play past 2 minutes → blocked.
   Popup → `Use a pass (1 left)` → confirm → the open block page unlocks on its next refresh,
   and the popup reads `pass, 4:5x left`.
7. **The pass ends.** Keep playing with nothing attached → blocked within seconds of the end;
   `dumpRaw()` shows ~5 minutes in `p` and one entry in `passUses`; the popup offers no pass.
8. **Pass time and the caps.** `countsTowardCaps: true` with a 3-minute daily cap → the block
   lands mid-pass at 3 minutes, `done for today`. With `false` the daily total does not move
   during the pass, but the rolling window still counts it (DESIGN §17).

## Part of a site

Two rules that count the same way, one for the site (`127.0.0.1`, or `youtube.com`) and one for
part of it (`127.0.0.1/shorts`, or `youtube.com/shorts`), with short budgets (DESIGN §21). The
local page needs links that move between `/watch` and `/shorts/<n>` with `history.pushState`,
as YouTube does. On Android both rules count while focused.

1. **In-page handover.** Playing on `/watch` → `▶ COUNTING` for the site. Move to a Short without
   loading a page → `■ stopped` for the site and `▶ COUNTING` for the part, at that moment; back
   to `/watch` → the reverse. On YouTube itself: open the menu and choose Shorts.
2. **The move wakes the page.** `terminate`, then move to a Short → the page starts, credits the
   site up to then (`reconciled …`), and the part counts.
3. **A spent part blocks only itself.** Run the part out → its tab goes to the block page under
   the part's name, `You were on …/shorts/…`. `/watch` still plays, and moving from it to a Short
   in-page is blocked at once: `⛔ blocked re-opened <part>`.
4. **A spent site leaves the part alone.** A Short playing in one tab, `/watch` in another; run
   the site out → `⛔ <site> spent — blocked 1 tab(s)`, the `/watch` one, and the Short keeps
   counting toward its own rule. From that Short, moving to `/watch` in-page is blocked at once.
5. **A subdomain.** A `music.youtube.com` focus rule saved after the `youtube.com` rule →
   focusing `music.youtube.com` counts toward it, not toward YouTube.
6. **A deleted part hands its pages back.** Both rules spent, the part's block page open; delete
   the part's rule and Save → that page says `<part> is available again`, and its
   `Back to …/shorts/…` is blocked at once under the site's name: `⛔ blocked re-opened <site>`.

## Export and import

1. **Round trip.** Export, delete a rule, import the file → the summary says the rule comes back
   without its history; after confirming, it does.
2. **Edited file.** Change a budget in an exported file and import it → the popup shows the new
   budget and the old usage. A file with `"budgetSec": 0` is refused, naming the rule, and
   nothing changes.

## Firefox for Android only

1. **A clean start.** `log` shows `ready on android — … window focus events: NO (Android)` and
   no `Incorrect argument types for tabs.onUpdated` (DESIGN §12).
2. **What the platform offers.** `dumpPlatform()` → `tabs.onUpdated filters: false` and
   `tab.audible: false`; both `true` on desktop.
3. **While playing counts while focused.** The default YouTube rule logs
   `▶ COUNTING youtube (focus)` on the active tab and blocks on time; the options page hides
   "Count time" and the popup says `counts while focused`. On desktop the choice is still there
   and the popup says `counts while playing`.
4. **The known gap.** A focus rule keeps counting with Firefox in the background (on the
   emulator, ~85 of a 90 s budget while Settings was in front). Expected until DESIGN §12's gap
   is closed; if it stops, that section needs updating.
5. **The lifecycle holds.** An alarm wakes a suspended page and blocks the tab, also with
   Firefox in the background; after `terminate` the next start finds `1 interval(s) still open`
   and the accounting is exact.
6. **Phone-sized pages.** At 360 dp the block page fits with its return link, and the options
   page stacks with Save pinned to the bottom and draws the history chart.
7. **Closing leaves no blank tab, unless it was the only tab.** With another tab open, a
   `close` rule's tab closes at the budget and again on reopening, and no blank tab appears:
   the tab count drops by one each time. With the site as the only tab, closing it leaves
   exactly one blank tab, and Firefox is usable from it, also when the site was opened by
   typing it into that tab's address bar and when it is reopened while spent (DESIGN §12).
