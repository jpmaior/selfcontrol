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
  domains, its `match` list, with `setLimits`, e.g. `{ match: ["youtube.com", "127.0.0.1"] }`.
  `localhost` is refused, because a domain needs a dot.
- **Nothing attached** for anything about the lifecycle. An open console keeps the event page
  alive (DEVELOPMENT.md), so read it with `log` afterwards. Log lines are quoted below as the
  event page prints them.

## Counting while playing *(desktop; Android has no `tab.audible`)*

1. **Play and pause.** Play a video → `▶ COUNTING youtube (audible)`. Pause → `■ stopped`, with
   the time credited.
2. **Background playback.** Play, then switch to another tab → it keeps counting.
3. **Hover previews never count.** On a YouTube search results page, sweep the pointer over
   thumbnails so the muted previews autoplay → nothing counts (DESIGN §3). Signed out, the home
   page shows no thumbnails at all.
4. **One clock for two tabs.** Play two videos at once → one `▶ COUNTING`, `■ stopped` only once
   both have stopped, and `dumpUsage()` grows one second per second.
5. **Muting stops the clock.** Mute the playing tab → `■ stopped`. This is the accepted loophole
   (DESIGN §3); if it ever counts, that section and the README are wrong.
6. **A failed focus query still reports.** On a local tone page in the active tab, make the focus
   query fail from the event page, `eval --bg 'browser.windows.getLastFocused = () =>
   Promise.reject(new Error("x"))'`, then start the tone → `could not resolve focus`, and
   `▶ COUNTING … — active tab updated` at the same second, not at the next tab event (DESIGN §4).
   `terminate` afterwards, so the page starts again without the stub.

## Counting while focused *(desktop)*

1. **The active tab.** Focus a page matching a focus rule → `▶ COUNTING`. Switch tabs →
   `■ stopped`. Switch back → counting again.
2. **Leaving Firefox.** With the matching tab active, give focus to a window outside Firefox
   (`focus away`) → `■ stopped` (DESIGN §4). `focus` gives it back → counting again.
3. **An unfocused window.** Two Firefox windows, the matching tab active in the one without
   focus (`open about:blank --new-window`; `focus 1` and `focus 2` switch) → not counting.

## Persistence and the lifecycle

1. **Terminated mid-playback.** Play ~30 s, then `terminate` while still playing → the next start
   logs `1 interval(s) still open`, and `dumpUsage()` keeps climbing from where it was.
2. **Stopped while unloaded.** Play, `terminate`, then pause before anything else wakes the
   page → the pause wakes it and it logs `reconciled youtube: credited …`, up to the pause
   (DESIGN §5).
3. **Hands-off past a checkpoint.** With a 30-minute budget, play 7 minutes and touch nothing →
   the page suspends, the checkpoint alarm wakes it with `checkpoint: youtube +5:00`, and the
   pause adds the rest. `dumpUsage()` shows the time from start to pause and about 3 s more,
   about 7:04: Firefox clears `audible` some 3 s after a pause, and until then it counts.
4. **The sleep clamp.** Play, let the page suspend, then freeze Firefox's process group
   (`SIGSTOP`, then `SIGCONT` 11 minutes later, standing in for a laptop suspend) → the stretch
   is credited at most `+7:30` (DESIGN §5).
5. **Reload.** Accrue a minute, pause, `reload` → `dumpUsage()` still has it; open intervals are
   gone, because Reload clears `storage.session`.
6. **Firefox restarted** (`stop`, `start`) → usage survives, open intervals do not.
7. **Writes stay rare.** Play ~6 minutes untouched → `log` shows one `flushed` line per
   checkpoint, not one per second (DESIGN §6). Transitions write too, without logging it.
   `dumpStats()` counts every write, but only since the event page last started.
8. **Size.** `dumpRaw()` → a few kilobytes per rule at most, history included (DESIGN §6, §13).
9. **An update keeps the window** *(desktop)*. A real update, set up as in DEVELOPMENT.md (it
   needs Firefox Developer Edition), with a block page as the only tab of the only window and
   the event page terminated → the old version logs `updating to v…; opened a tab in 1 window(s)
   it would close`, the new version starts, and Firefox stays open on a new tab. The same with
   only the options page in a second window. With another tab beside the block page, nothing
   opens: `updating to v…` alone. From a version without it, the window closes, and Firefox
   with it (DESIGN §12).

## Enforcement

With `budgetSec: 30, windowSec: 120, minUnlockCreditSec: 30` on the rule under test.

1. **Blocked at the budget.** Play → at ~30 s the tab goes to the block page, with a quip and a
   countdown that ticks; the log says `⛔ youtube spent — blocked 1 tab(s); unlocks in …`.
2. **No way back in.** Navigate back → blocked again, also within a second or two of the block
   (DESIGN §7). Open the site in a new tab → blocked at once,
   `⛔ blocked re-opened youtube (tab N)`.
   Neither counts. Check it on a focus rule, since on desktop an audible one is redirected
   before it makes a sound: going back in a minute or more after the block never logs
   `▶ COUNTING`, and the unlock time, on the block page and in `dumpUsage()`, stays where it was
   (DESIGN §7). With the event page awake, the observers sometimes see the site before the guard
   redirects it and log `▷ spent, not counting`; when going back is what wakes a suspended page
   (`terminate` first), the guard redirects before the observers start, and only `⛔` appears.
3. **Close instead of block.** A rule with `onExceed: "close"` (the default Instagram rule) →
   the tab closes at the budget, and reopening it closes it again at once,
   `⛔ closed re-opened instagram (tab N)`. No tab opens in its place unless it was the last one,
   in its window on desktop or in Firefox on Android: then one fresh tab replaces it
   (DESIGN §12).
4. **Unlocked on time, not before.** Spend the budget across two buckets (say 12 s and 18 s) →
   when the first ages out the rule stays blocked and the countdown keeps going; it unlocks at
   the promised instant with the full 30 s back, and `dumpRaw()` shows `blockedUntil: null`
   again (DESIGN §8, "The hold").
5. **The drip-feed, on request.** `minUnlockCreditSec: 0` → unlocks as soon as the first bucket
   ages out, and re-blocks soon after.
6. **An alarm wakes the page.** With nothing attached and the page suspended, the block still
   lands on time: `alarm for youtube fired +Nms vs scheduled`, then one `⛔ youtube spent` line,
   not one per path that woke with it (DESIGN §7), and one `youtube: alarm in … — unlocks
   (rolling)`, also with two tabs on the site (DESIGN §14). N stays within what DESIGN §5
   records for the platform. Stop Firefox's processes (`SIGSTOP`) across the instant the budget
   runs out and continue them a minute later → the alarm fires about a minute late, the tab is
   blocked at once, and `dumpUsage()` shows the budget used, not the budget plus the stop
   (DESIGN §7). The same with less left than the cool-down when the site counts again: on a
   focus rule, spend a third of the budget, `focus away` and back, then stop across the instant
   → still the budget, and the unlock an alarm on time would have set (DESIGN §8, "Only from the
   ledger").
7. **The block page unlocks itself.** Leave it open → when the countdown ends it says
   `YouTube is available again` with no reload, and within a second its usage line gives what
   is used now, not the figure from before the time came back (DESIGN §19).
8. **And blocks again.** With an unlocked block page open, spend its rule again with Lock in (in
   the popup, or a `lockIn` message sent from the page) → on its next refresh the page is blocked
   again: `You were on …` instead of `Back to …`, and a countdown to the unlock time
   `dumpUsage()` gives, which it unlocks at as before. The same when a pass ends with its page
   open, and when an outright block's budget, raised to unlock it, is set back to 0:
   `<label> is blocked`, with `Go back` again if there is a page behind (DESIGN §19).
9. **The return link.** Get blocked on a specific URL → the block page says `You were on …`;
   once unlocked, `Back to …` opens that exact URL, and the clock runs again (DESIGN §19).
10. **Go back.** A budget-0 `127.0.0.1/shorts` rule, and a local page at `/` that links to a
    Short both in-page (`history.pushState`) and with a full load. Move to a Short in-page → the
    block page offers `Go back` above `You were on …/shorts/…`; pressing it lands on `/`, with no
    new `⛔` in the log. The same from a full load. Press the browser's Back from the block page
    instead → blocked again, and `Go back` still reaches `/`. Open a Short in a new tab → no
    `Go back`; type another URL from that block page and come Back to it → still none. With the
    pages behind the block blocked too, each press is blocked again one page further back, until
    it reaches one that is not. A spent budget's block page, with a page behind it → no `Go back`;
    set that rule's budget to 0 with the page open → `Go back` appears; raise it again → the page
    unlocks and `Go back` goes, leaving `Back to …` (DESIGN §19).

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
2. **A new rule works.** Add a focus rule with a 1-minute budget for some site → its cool-down
   follows the budget down to 1 minute, and Save works without touching it (DESIGN §8). Sitting
   on that site blocks it. Once the cool-down is edited by hand it stays as typed, and a saved
   rule's cool-down does not follow its budget.
3. **Deleting discards usage.** With item 2's block page still open in another tab, delete the
   rule and Save → `rule removed: <id> — usage discarded`, and `dumpRaw()` has no `usage:<id>`
   left. Back on the block page, it says `<label> is available again` at once rather than counting
   down to the old time, with no usage line, and `Back to …` opens the site (DESIGN §19).
   **Asleep too:** lock in a rule from the popup, `terminate`, then delete it and Save → the same
   log line, no `usage:<id>` or `open:<id>` left, and a rule added again with the same label starts
   at `0:00`, not blocked (DESIGN §6). After an update from a build that left one behind, the first
   start logs `swept usage of deleted rule(s): <id>`.
   **Import keeps the rest:** import a file sharing some ids with the saved rules, with the event
   page terminated → those rules' `usage:<id>` is unchanged, and only the rules the file leaves out
   log `rule removed`.
   **The alarm goes too:** in each of these, `browser.alarms.getAll()` keeps no `rule:<id>` for
   a deleted rule. Awake, the save logs `rule removed: <id> — alarm cleared`; asleep, the start the
   save causes logs `cleared the alarm of deleted rule(s): <id>`. So does a start that finds one
   left behind: `browser.alarms.create("rule:ghost", { when: Date.now() + 3600e3 })`, `terminate`,
   wake it → `cleared the alarm of deleted rule(s): ghost` (DESIGN §6).
4. **Renaming keeps it.** Rename a rule and Save → its used time is unchanged.
5. **The form shows what was understood.** Paste `https://www.reddit.com/r/all` into Domains and
   leave the field → it reads `reddit.com`, with a note that only the site is kept and how to
   limit `reddit.com/r/all` alone, under the *Match paths* checkbox. Tick it →
   `reddit.com/r/all`, the note gives way to a short explanation of matching, the label reads
   `Domains and paths`, and the checkbox does not move; untick → `reddit.com` again.
   A budget equal to the window is refused with the reason shown, and so are a window under 2
   or over 1440 minutes and a pattern another rule already has, naming that rule.
6. **History.** Once buckets have folded (a short window helps) → the rule's history shows
   today's bar and the 7- and 30-day totals; pass time is a blue segment on top of the used
   time, and the legend adds `On a pass`.
7. **Seconds the form cannot show.** `setLimits` one rule to a 90 s budget, a 20 s cool-down
   and a 90 s pass, and another to a 20 s budget with a 20 s cool-down; open the options page,
   change only each rule's name, and Save → `dumpRaw()` has every value as it was, not rounded
   to 120 s or 0, and the second rule is not `blocked outright` (DESIGN §23). `setLimits` with a
   value of the wrong type, such as `{ windowSec: "3600" }` or `{ minUnlockCreditSec: null }`,
   returns the reason and saves nothing.
8. **A saved rule the checks now refuse.** Write a rule with a 48-hour window straight into
   `settings` with `browser.storage.local.set`, as an older version could save, and open the
   options page → the list says `Needs fixing` on it, its form says the window must be between
   2 minutes and 24 hours, and the save bar says it needs fixing before the next save; Revert
   keeps saying so. `dumpUsage()` shows the rule still applied, and `settings` is unchanged until
   the window is fixed and saved (DESIGN §23).

## Caps, lock in and passes

1. **Daily cap.** `dailyBudgetSec: 120`, play 2 minutes → `YouTube is done for today`, the
   countdown ends at local midnight, and the popup's rolling meter is far from full.
2. **Removing it lifts the block.** Clear the daily cap in the options page → the block lifts at
   once.
3. **Weekly cap.** Weekly 60 s and daily 120 s, play 1 minute → `done for the week`, unlocking
   next Monday at 00:00. The countdown, on the block page and in the popup, is in days from a
   day on: `3d 18:35:52`, not `90:35:52`.
4. **Lock in while playing.** Popup → Lock in → `Blocks YouTube until HH:MM. Confirm`; confirm →
   the tab is blocked at once and the block page counts down to that time.
5. **Lock in while idle.** With 3 minutes left → `dumpRaw()` shows 180000 more ms in the current
   bucket and nothing else changed; after `terminate`, the popup still shows it spent.
6. **A pass.** Rolling cap 2 minutes, one 5-minute pass a week. Play past 2 minutes → blocked.
   Popup → `Use a pass (1 left)` → confirm → the open block page unlocks on its next refresh,
   and the popup reads `pass, 4:5x left`. Used while nothing plays, even with a daily cap that
   has less left than the pass, the log says `alarm in 5:00 — pass ends` (DESIGN §14).
7. **The pass ends.** Keep playing with nothing attached → blocked within seconds of the end;
   `dumpRaw()` shows ~5 minutes in `p` and one entry in `passUses`; the popup offers no pass.
8. **Pass time and the caps.** `countsTowardCaps: true` with a 3-minute daily cap → the block
   lands mid-pass at 3 minutes, `done for today`. With `false` the daily total does not move
   during the pass, but the rolling window still counts it (DESIGN §17).
9. **A confirm that comes too late.** In the popup (`open popup` gives it a tab), arm Lock in,
   then spend the rule with a `lockIn` message from the page before confirming → the confirm
   reads `<label> is already blocked.` for ten seconds, through the refreshes, and the log has one
   `🔒 locked in`, no `spent 0:00`. The same with Use a pass, using the pass by message first →
   `That pass is not available right now.` With `browser.runtime.sendMessage` made to reject for
   the action → `Could not lock in.`, and no unhandled rejection (DESIGN §16).

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
   counting toward its own rule. On Android, where only the tab in front counts, the Short
   counts from when it is brought to the front. From that Short, moving to `/watch` in-page is
   blocked at once.
5. **A subdomain.** A `music.youtube.com` focus rule saved after the `youtube.com` rule →
   focusing `music.youtube.com` counts toward it, not toward YouTube. On a profile that has not
   answered YouTube's consent dialog, `music.youtube.com` redirects to `consent.youtube.com`,
   which the `youtube.com` rule owns (#38). Locally instead: `site.test` and `music.site.test`
   rules, the desktop pref `network.dns.localDomains` set to `site.test,music.site.test` (with
   `chrome`, cleared afterwards) so both resolve to this machine, and the local page opened at
   `http://music.site.test:<port>/`.
6. **A deleted part hands its pages back.** Both rules spent, the part's block page open; delete
   the part's rule and Save → that page says `<part> is available again`, and its
   `Back to …/shorts/…` is blocked at once under the site's name: `⛔ blocked re-opened <site>`.

## Blocking outright

A budget of 0 blocks a site the moment it is opened, until the budget is raised (DESIGN §22).
Serve a page on `127.0.0.1` and give the rule under test that domain with `setLimits`.

1. **Blocked on sight.** With the site open in a tab, `setLimits(id, { budgetSec: 0 })` → that
   tab goes to the block page at once, `⛔ <id> spent — blocked 1 tab(s); no budget, stays
   blocked`. The page reads `<label> is blocked`, with no meter and no countdown, and says it
   stays blocked until its budget is raised; it stays that way past a minute, and
   `browser.alarms.getAll()` has no `rule:<id>`. Opening the site again is blocked at once,
   `⛔ blocked re-opened <id>`, and nothing ever logs `▶ COUNTING` for it.
2. **Close instead.** The same with `onExceed: "close"` → the tab closes at once, and again when
   reopened.
3. **The popup.** The row reads `always blocked` and `no time allowed`, with a full meter, and
   offers neither Lock in nor a pass, even with passes configured on the rule.
4. **The options page.** Type 0 into Budget → a notice says the site is blocked (or its tabs
   closed, following *When it runs out*) the moment it is opened, and stays that way until the
   budget is raised; Count time, the window, the daily and weekly caps, the cool-down and every
   pass field are greyed out and cannot be edited, still showing their values; the label above
   the action reads `When it is opened`, and the rule list says `blocked outright`. Save works
   even when a greyed field holds a value Save would otherwise refuse. Type 5 back → everything
   is editable again with the values it had. A blank Budget is refused, not read as 0.
5. **Raising the budget lifts it.** With the block page open, raise the budget → the page says
   `<label> is available again` on its next refresh, and its usage line gives the time used of
   the new budget instead of `no time allowed`; `Back to …` opens the site, and it counts.

## Export and import

1. **Round trip.** Export, delete a rule, import the file → the summary says the rule comes back
   without its history; after confirming, it does.
2. **Edited file.** Change a budget in an exported file and import it → the popup shows the new
   budget and the old usage. A file with `"budgetSec": -60`, `"windowSec": "3600"`,
   `"windowSec": 1e999` or a numeric `id` is refused, naming the rule and what is wrong, and
   nothing changes.
3. **No cool-down in the file.** Remove `minUnlockCreditSec` from a rule in an exported file and
   import it → the rule's cool-down is 5 minutes, or its budget when that is less, not 0
   (DESIGN §8).

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
   is closed; if it stops, that section needs updating. Keep media with a real media session
   playing in Firefox throughout (a 60 s clip; a 2 s loop is not enough): with nothing playing,
   Android freezes Firefox a minute or two after it goes to the background (DESIGN §12).
5. **The lifecycle holds.** An alarm wakes a suspended page and blocks the tab, also with
   Firefox in the background while media with a real session plays, as in 4: on time, `fired
   +Nms` within DESIGN §5's range. After `terminate` the next start finds `1 interval(s) still
   open` and the accounting is exact.
   **Frozen, then back.** The same with nothing playing, the budget running out after logcat's
   `am_freeze … org.mozilla.firefox`, and Firefox brought back a minute later → the alarm fires
   about that late, the tab is blocked at once, and the rule is charged its budget, not the time
   it was frozen, with the unlock an alarm on time would have set (DESIGN §7, "Running out
   late"). A freeze has been seen to drop web-ext's connection and its `adb reverse`, though
   not on every run: if `status` says web-ext is gone, re-run `start` and the `adb reverse`.
6. **Phone-sized pages.** At 360 dp the block page fits with its return link, and the options
   page stacks with Save pinned to the bottom and draws the history chart.
7. **Closing leaves no blank tab, unless it was the only tab.** With another tab open, a
   `close` rule's tab closes at the budget and again on reopening, and no blank tab appears:
   the tab count drops by one each time. With the site as the only tab, closing it leaves
   exactly one blank tab, and Firefox is usable from it, also when the site was opened by
   typing it into that tab's address bar and when it is reopened while spent (DESIGN §12).
8. **An update leaves Firefox usable.** With a block page as the only tab, `reload`, which
   unloads the add-on as an update does → the new version logs `opened a tab: the update closed
   the last one`, and Firefox shows a blank tab, the tab counter at 1, from which a site opens.
   The same after tapping the address bar first, so that its hidden tab is listed. With another
   tab open, nothing opens and Firefox shows that tab. On Firefox's home screen with no tab, the
   home screen stays and one blank tab joins the tray (DESIGN §12).
