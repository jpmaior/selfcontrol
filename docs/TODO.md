# TODO

Open work first; findings that were fixed stay below for the record. Android findings from the
first on-device test are tracked separately in [TODO-ANDROID.md](./TODO-ANDROID.md) and are
still open.

## Roadmap: the v0.2 features (planned 2026-09-19)

Eight features from the 2026-09-05 brainstorm, in dependency order. Each step is one branch and
one PR (CLAUDE.md § Workflow), lands with its DESIGN.md section, and **starts with its tests**
(CLAUDE.md § Testing): the pure cases go into `node --test` and fail before the code exists;
the browser-only parts get their hand checkpoint written into the PR before the code.

Read the shared decisions first. They fix the data shapes every step builds on, so a later
step never has to migrate what an earlier one stored.

### Shared decisions

**The rule shape grows by four fields, all optional, all filled by `withDefaults`.** Ids and
the three rolling-window fields are untouched, so existing usage keys stay valid.

```js
{
  id, label, match, mode, onExceed,
  budgetSec, windowSec, minUnlockCreditSec,  // the rolling cap, exactly as today

  dailyBudgetSec: null,    // calendar day, local time. null = no daily cap
  weeklyBudgetSec: null,   // calendar week starting Monday, local time. null = none
  schedule: [],            // blocked spans: [{ day: 0..6 (Mon = 0), fromMin: 540, toMin: 1080 }]
  passes: { perWeek: 0, durationSec: 60 * 60, countsTowardCaps: true }  // perWeek 0 = disabled
}
```

**Daily and weekly caps are calendar-aligned, not rolling.** "Forty minutes a day" means a day
that ends at local midnight and comes back all at once, which is what the words mean to the
person who typed them, and it makes the unlock instant trivial (start of the next period).
A rolling 24-hour or 7-day window was considered and rejected: it would need a week of minute
buckets (up to ~200KB rewritten on every flush) and would give the block page an unlock time
nobody can predict. The week starts on Monday; not configurable in this round.

**The usage ledger grows too, still under the one `usage:<ruleId>` key.** One key means a
flush costs exactly what it costs today.

```js
{
  b: { "29384756": 60000 },              // live minute buckets, as today
  p: { "29384790": 60000 },              // live minute buckets accrued under a pass (Step 5)
  d: { "2026-09-19": { used: 0, pass: 0 } },  // folded whole days, newest ~90 kept (Step 1)
  pass: null,                            // { from, to } of the active or last pass (Step 5)
  passUses: []                           // start instants of passes used, current week only
}
```

`normalizeUsage()` in the accountant fills the missing members of a ledger stored by an
older build, the way `withDefaults` does for rules. `isUsageShape` in `store.js` becomes a
call to it.

**Expired buckets are folded, not dropped.** `prune()` becomes `fold()`: a bucket that leaves
the rolling window is added to its local day in `d` before it is deleted. Pruning already
touches those buckets on every settle, so history and the calendar caps cost no extra writes.
Every bucket belongs to exactly one local day, because time-zone offsets are whole minutes and
buckets are whole minutes. A day key is `YYYY-MM-DD` in local time, which sorts lexically,
so "days older than N" is a string comparison.

**Usage in a calendar period = folded days in the period + live buckets in the period.** No
double counting is possible because folding deletes the bucket it folds. A live bucket from
yesterday that has not yet aged out of the rolling window belongs to yesterday by its day
key, not to today.

**One pure module decides whether a rule is open: `policy.js`.** Today `store.status()`
computes exhaustion from the rolling cap alone. From Step 2 it delegates to
`policy.evaluate(rule, usage, nowMs)`, which combines every constraint:

```js
{
  exhausted, reason,                // reason: "rolling" | "daily" | "weekly" | "schedule" | null
  remainingMs,                      // the smallest remaining across the active caps
  unlockAtMs,                       // max over the exhausted constraints: all must release
  nextChangeAtMs,                   // earliest instant the answer could flip; drives the alarm
  caps: { rolling: {...}, daily: {...} | null, weekly: {...} | null },
  schedule: { blocked, untilMs, nextStartMs },
  pass: { active, endsAtMs, leftThisWeek }
}
```

Exhausted = any constraint says so. `unlockAtMs` is the *max* of the exhausted constraints'
release instants, because the site is usable only when all of them allow it. `remainingMs`
is the *min* of the caps' remaining, and `reason` names the one that binds, so the popup can
say "12:00 left (today)". The clamp for `minUnlockCreditSec` stays in `unlockAt()` and applies
to the rolling cap only; a calendar cap returns whole at the period boundary, so the drip-feed
problem of DESIGN.md §8 does not exist for it.

**One alarm per rule, at `nextChangeAtMs`.** `syncExhaustionAlarm` is renamed
`syncRuleAlarm` and keeps its "only rewrite if it moved" guard. The target is the earliest of:
`now + remainingMs` while counting; the end of an active pass; the next scheduled block start;
the unlock instant while exhausted (so the badge can flip without a user event). The alarm is
therefore set for scheduled rules even while nothing is counting, which is new: a rule with a
schedule but no open tab still gets one alarm days away, and that is fine. The handler stays
what it is: checkpoint, flush, `enforceRule`, re-sync.

**Two new messages from the popup: `lockIn` and `usePass`, both `{ type, ruleId }`.** They
act on usage, which is hot state owned by the background, so they go through messaging like
`status` does rather than through storage. The options page still never messages the
background. Both reply `{ ok: true }` or `{ ok: false, error }`, and the listener keeps the
existing "only return a promise for a message you answer" shape.

**`SETTINGS_VERSION` goes to 2 in Step 2**, the first step that stores a new field. Later
steps are additive and keep version 2. `withDefaults` is the migration.

**Export, import, lock-in and passes are all loosening paths in some sense.** A cooling-off
period (a rule loosening takes effect only after a delay the user chose; tightening is
immediate) would close them; it is deliberately not in this round. Passes are the one
"unlock now" the design allows, and they are allowed because they are rationed per week.

---

### Step 1: Calendar days and usage history

The foundation: `fold()` replaces `prune()`, the `d` map appears, and the options page shows
what it holds. No behaviour change for enforcement.

**Tests first** (`test/calendar.test.js`, `test/accountant.test.js`):

- `calendar.js`: `startOfDay`, `startOfNextDay`, `dayKey`, `startOfWeek` (Monday),
  `startOfNextWeek`, `weekday` (Mon = 0), `minuteOfDay`. Set `process.env.TZ` at the top of
  the test file (Node re-reads it), and cover: a plain day; a Sunday resolving to the previous
  Monday; the DST spring-forward and fall-back days in `Europe/Lisbon` (23- and 25-hour days,
  `startOfNextDay - startOfDay` is not 24h); `dayKey` of a bucket start one minute before and
  after local midnight.
- `fold(usage, nowMs, windowMs)`: a bucket outside the window lands in `d[dayKey]` and is
  gone from `b`; two buckets from the same day accumulate; a bucket inside the window stays;
  folding twice is idempotent; days older than the retention are dropped; `p` buckets fold
  into `.pass` (write the test now so Step 5 cannot forget it).
- `usedInPeriod(usage, periodStartMs, { includePass })`: folded + live, no double count;
  a live bucket from before `periodStartMs` is excluded; the pass component is excluded when
  asked.
- `normalizeUsage`: a `{ b }` ledger from today gains `p`, `d`, `pass`, `passUses`; a
  malformed value becomes a fresh ledger.
- `store.test.js`: after a settle that folds, the flushed `usage:<id>` value carries `d`.

**Build:**

- `extension/common/calendar.js`, pure. Local-time arithmetic through `Date` getters only.
- `accountant.js`: `fold`, `usedInPeriod`, `normalizeUsage`, `HISTORY_DAYS = 90`. Keep
  `prune` as a thin alias for one step if anything else imports it; delete it in Step 2.
- `store.js`: `settle` calls `fold`; `load` runs `normalizeUsage`; `status()` gains
  `today: { usedMs, passMs }` and `week: {...}` so the popup can show them in Step 2.
- Options page: a "History" block per rule card, collapsed by default: a 30-day bar strip
  from `d` (used and pass stacked, pass lighter), 7- and 30-day totals, exact values in the
  bar's `title`. Plain CSS bars, no library. The options page reads `usage:*` directly from
  storage; it never messages the background. Read-only, so a rule with no history shows
  "nothing yet". (Consult the `dataviz` skill before drawing the bars.)

**Check by hand:**

1. Play for ~2 minutes, stop, wait for the window to age past those buckets (or set a 3-minute
   window with `setLimits`), trigger a checkpoint, then `dumpRaw()`: the buckets are gone from
   `b` and `d[today].used` holds their sum.
2. Terminate the background script and reopen the popup: the numbers survive.
3. Options page shows today's bar with the right height and the 7-day total.
4. `dumpStats()` before and after: `localWrites` did not grow faster than before.

**Docs:** DESIGN.md §13 "Calendar days and history": why fold rather than prune, why the day
key is local, why `d` lives inside `usage:<id>`.

---

### Step 2: Daily and weekly caps on top of the rolling window

**Tests first** (`test/policy.test.js`, `test/rules.test.js`):

- `evaluate`: only the rolling cap set behaves exactly as `status()` does today (pin this
  with the same numbers `accountant.test.js` uses for `unlockAt`).
- Daily cap binds before the rolling cap: `reason: "daily"`, `unlockAtMs` is local midnight,
  `remainingMs` is the daily remainder. Same for weekly with the start of next Monday.
- Both rolling and daily exhausted: `unlockAtMs` is the later one.
- A cap set to `null` is ignored; a daily cap smaller than the rolling budget just binds first.
- `nextChangeAtMs`: counting and not exhausted gives `now + remainingMs`; idle and not
  exhausted gives `null`; exhausted gives `unlockAtMs`.
- `validateRule`: `null` accepted; zero or negative rejected; daily above 24h rejected;
  weekly above 7 days rejected; non-integers rejected.
- `withDefaults` fills the two fields with `null`.

**Build:**

- `extension/common/policy.js`, pure, importing `accountant.js` and `calendar.js`. Owns
  `evaluate` and the reason vocabulary. The `max(minUnlockCreditSec, 1)` clamp stays in
  `accountant.unlockAt`.
- `store.status()` returns `evaluate(...)` spread over the identity fields it returns today,
  so the popup and the block page keep working, plus `today`/`week` from Step 1.
- `enforcer.js`: `syncExhaustionAlarm` becomes `syncRuleAlarm(rule, nowMs)` targeting
  `nextChangeAtMs`; clears when it is `null`. Update the three call sites in `index.js`.
- `rules.js`: fields, defaults, validation. `SETTINGS_VERSION = 2`.
- Options page: two more inputs on the card ("Per day", "Per week", in minutes, blank = none)
  and the matching lines in `strip()`, which is a whitelist and silently drops any field it
  does not list.
- Popup: a second line under the meter, "today 32:00 / 1:00:00 · week 3:10 / 5:00", shown
  only for rules that have those caps; the state text names the binding cap when blocked.
- Block page: headline by reason ("done for now" / "done for today" / "done for the week")
  and a detail line that names the cap. The countdown already takes a timestamp.

**Check by hand:**

1. `setLimits("youtube", { dailyBudgetSec: 120 })`, play 2 minutes: block page says "done for
   today", countdown ends at local midnight, the rolling meter in the popup is far from full.
2. Remove the daily cap from the options page: the block lifts at once (settings change path).
3. Set weekly to 60s and daily to 120s, play 1 minute: reason is "weekly", unlock is next
   Monday 00:00.
4. `dumpRaw()`: settings carry `version: 2`.

**Docs:** DESIGN.md §14 "Several caps on one rule": calendar not rolling, max of unlocks,
min of remaining, one alarm per rule.

---

### Step 3: Schedules — dropped (2026-09-19)

Built as PR #3, tried, and not wanted: closed without merging. The later steps were rebuilt
without it, so nothing below depends on it any more; the references to schedules that
remain in this file are the original plan, kept for the record. If it ever comes back,
`calendar.js` still has `atMinute()` and `minuteOfDay()`, which were its footing.

A rule carries blocked spans in local time. During a span the rule is exhausted with
`reason: "schedule"` and unlocks when the span ends. A pass does not override a schedule.

**Tests first** (`test/schedule.test.js`, `test/policy.test.js`, `test/rules.test.js`):

- `normalizeSpans`: sorts, merges overlapping and touching spans on the same day, drops
  empty ones.
- `blockedAt(spans, nowMs)`: inside a span; at `fromMin` exactly (blocked); at `toMin` exactly
  (open); a span ending at 1440; a different weekday; the same minute on a Sunday vs Monday.
- `blockEndsAt(spans, nowMs)`: end of the current span; two adjacent spans merge into one
  end; a span ending at 1440 ends at local midnight and, if the next day starts with a span at
  0, continues through it.
- `nextBlockStartsAt(spans, nowMs)`: later today; tomorrow; next week (only one span, already
  passed this week); `null` for an empty schedule.
- Grid helpers used by the UI, pure so they are testable: `spansToGrid(spans, slotMin)` and
  `gridToSpans(grid, slotMin)` round-trip; a span that is not slot-aligned is widened to the
  enclosing slots (state the rule, test it).
- `evaluate`: schedule block wins over an unspent rolling cap; `nextChangeAtMs` is the next
  span start when idle and open; is the span end when blocked; both schedule and a cap
  exhausted gives the later unlock.
- `validateRule`: day out of range, `fromMin >= toMin`, `toMin > 1440`, non-integers.

**Build:**

- `extension/common/schedule.js`, pure. Spans are stored per day without wrapping; an
  overnight block is two spans (22:00–24:00 and 00:00–07:00), which is what the grid produces
  naturally and what `blockEndsAt` joins back together.
- `policy.evaluate` consults it. `syncRuleAlarm` picks up the next span start via
  `nextChangeAtMs`, which means a scheduled rule now always has an alarm.
- `enforceRule` needs no change: exhausted is exhausted.
- Options page: the schedule editor. A 7-row (Mon–Sun) by 48-column (30-minute) grid of cells
  under each rule, collapsed behind a "Schedule" disclosure with a one-line summary
  ("Blocked Mon–Fri 09:00–18:00", or "No schedule"). Painting: `pointerdown` on a cell picks
  the paint value from that cell's opposite state, `pointerenter` while the button is held
  applies it, `pointerup` anywhere ends the stroke; `setPointerCapture` so a stroke that
  leaves the grid still ends. Cells are `<button aria-pressed>` so keyboard and screen reader
  users can toggle one at a time. Presets: "Work hours", "Evenings", "Clear". On a narrow
  viewport the grid scrolls horizontally rather than shrinking below a usable cell size. The
  summary text comes from a pure `describeSpans(spans)` in `schedule.js`, tested with the
  merge cases ("Mon–Fri" when five identical days, "Mon, Wed" otherwise).
- Block page: "YouTube is off until 18:00" with the countdown, and no quip about running out
  of time, because the user did not.

**Check by hand:**

1. Paint today's current half hour, save: every open YouTube tab is swept immediately.
2. Paint the *next* half hour and save; open YouTube; wait for the boundary with the console
   closed: the tab is blocked within a few seconds of the boundary (the alarm woke the page).
3. Block page countdown reaches zero at the span end and offers the site again.
4. Drag across a row, release outside the grid, reload the options page: the spans saved are
   what was painted.
5. Paint 22:00–24:00 on Monday and 00:00–01:00 on Tuesday; at 23:00 Monday the block page
   says "until 01:00", not "until 00:00".

**Docs:** DESIGN.md §15 "Schedules": spans per day, local time, the alarm now exists for idle
rules, passes do not override.

---

### Step 4: Lock in early

A per-rule button in the popup that spends the rest of the current budget on purpose.
Irreversible by design.

**Tests first** (`test/accountant.test.js`, `test/policy.test.js`):

- `lockIn(usage, nowMs, ms)`: adds `ms` to the *current* bucket only, never spread over past
  buckets (spreading would let it expire sooner). `unlockAt` afterwards equals
  `bucketExpiresAt(bucketOf(now), windowMs)` for a rule with `minUnlockCreditSec` equal to the
  budget, and earlier for a smaller one.
- `lockInAmount(rule, usage, nowMs)`: the min across the caps' remaining; zero when already
  exhausted; zero inside a schedule block; ends an active pass (`pass.to = now`) and then
  spends whatever the rolling cap has left, which may be nothing.
- `canLockIn(rule, usage, nowMs)`: a reason string or `null`.
- `store.test.js`: the message-level flow through a `lockInRule(rule, nowMs)` in `store.js`:
  checkpoints the open interval first (so the interval is not credited twice), commits the
  lock-in, marks dirty. The flushed ledger holds both.

**Build:**

- `accountant.lockIn`, `policy.lockInAmount`, `policy.canLockIn`.
- `store.lockInRule(rule, nowMs)`: `checkpointRule`, then `lockIn`, then `fold`, `dirty`.
- `index.js`: `lockIn` message handler: await `loaded`, look up the rule, `lockInRule`,
  `flush`, `enforceRule`, `syncRuleAlarm`, reply. Log it, since this is a user action.
- Popup: a "Lock in" button per rule, hidden when `canLockIn` says no. Two-step, inline: the
  first click turns the button into "Blocks YouTube until 14:32. Confirm" for five seconds,
  the second click sends the message. No `window.confirm`; popups and dialogs do not mix.

**Check by hand:**

1. With a video playing, lock in: the tab is blocked at once, the popup shows the rule spent,
   and the block page countdown matches "until" from the confirm step.
2. Lock in while idle with 3 minutes left: `dumpRaw()` shows 180000 more ms in the current
   bucket and nothing else changed.
3. Terminate the background script, reopen the popup, the rule is still spent.

**Docs:** DESIGN.md §16 "Lock in": into the current bucket, why it also ends a pass.

---

### Step 5: Passes (single-use unlocks)

For the video that is longer than the rolling window allows. A pass suspends the rolling cap
for `durationSec` from the moment it is used. Time under a pass **always** accrues to the
rolling window, into the `p` map, so the pass is one long session followed by the usual
cool-down and can never leave a rule looser than it was. `countsTowardCaps` decides whether
that time also counts against the daily and weekly caps. A pass never overrides a schedule or
an exhausted daily/weekly cap, and cannot be used while one of those is blocking. The weekly
allowance is `perWeek`, counted over the same Monday-start week as the weekly cap.

**Tests first** (`test/accountant.test.js`, `test/policy.test.js`, `test/rules.test.js`,
`test/store.test.js`):

- `commit` with a pass: an interval entirely inside `[pass.from, pass.to)` lands in `p`; one
  straddling `pass.to` splits at the boundary; one straddling `pass.from` splits too; no pass
  means `b` only. `usedMs`, `remainingMs`, `creditAvailableAt` count `b` and `p` together.
- `fold` moves `p` into `d[day].pass` (already written in Step 1; it starts passing now).
- `usedInPeriod` with `includePass: false` ignores `p` and `.pass`.
- `passesLeft(rule, usage, nowMs)`: `perWeek` minus uses since Monday; last week's uses do
  not count; `perWeek: 0` gives 0.
- `canUsePass`: no allowance; pass already active; schedule block; daily or weekly exhausted
  (with `countsTowardCaps` either way, since the cap is already spent); otherwise `null`.
  The rolling cap being exhausted is *not* a refusal: that is the case the pass exists for.
- `startPass(usage, rule, nowMs)`: sets `pass`, appends to `passUses`.
- `evaluate` during a pass: `exhausted` is false while only the rolling cap is spent;
  `reason: "daily"` when `countsTowardCaps` and the daily cap fills mid-pass; `pass.active`
  and `pass.endsAtMs` set; `nextChangeAtMs` is `pass.to` (or the daily exhaustion instant if
  sooner, which is `now + dailyRemaining` while counting).
- `evaluate` just after `pass.to`: rolling cap is exhausted by the pass buckets, `unlockAtMs`
  comes from `creditAvailableAt` over `b` and `p`.
- `validateRule`: `perWeek` a non-negative integer; `durationSec > 0` when `perWeek > 0`;
  `countsTowardCaps` boolean.
- `store.test.js`: `usePassOnRule` checkpoints first, then starts the pass, so the interval
  before the click stays in `b`.

**Build:**

- `accountant.commit` takes `{ pass }` in its options and splits; `startPass`, `passesLeft`
  helpers; `fold` prunes `passUses` to the current week.
- `policy.js`: `canUsePass`, pass handling in `evaluate`.
- `store.js`: `settle` passes the ledger's `pass` to `commit`; `usePassOnRule(rule, nowMs)`.
- `index.js`: `usePass` handler mirroring `lockIn`; the alarm handler needs no special case,
  since a pass ending is just `nextChangeAtMs` firing and `enforceRule` finding the rolling
  cap spent.
- `rules.js`: `passes` field, defaults, validation.
- Options page: "Passes per week", "Pass length (min)", and a checkbox "Pass time counts
  toward the daily and weekly caps". `strip()` again.
- Popup: "Use a pass (2 left)" button, two-step like lock-in, hidden when `canUsePass`
  refuses; while a pass is active the state reads "pass, 42:10 left" and the meter is hidden
  or dimmed. Lock-in stays available during a pass and ends it.
- Block page: when the rule is blocked by the rolling cap and passes are left this week, one
  line: "You have 2 passes left this week, in the toolbar popup." The button itself stays in
  the popup, so the block page never has an unlock control on it.

**Check by hand:**

1. Rolling cap 2 minutes, one pass of 5 minutes. Play past 2 minutes: blocked. Use the pass
   from the popup: the block page (still open) unlocks on its next refresh, the site loads,
   the popup shows "pass, 4:5x left".
2. Keep playing past the pass end with the console closed: the tab is blocked within seconds
   of `pass.to` and `dumpRaw()` shows ~5 minutes in `p`, split across buckets.
3. `dumpRaw()`: `passUses` has one entry; the popup shows "0 left"; the button is gone.
4. `countsTowardCaps: true` with a daily cap of 3 minutes: the block lands mid-pass at 3
   minutes with reason "daily". Repeat with `false`: the daily cap does not move during the
   pass, but the rolling window still shows the pass time.
5. Wait for the buckets to fold (short window): options history shows the pass time as the
   lighter segment.

**Docs:** DESIGN.md §17 "Passes": rationed, always counted in the rolling window, `p` map so
the caps can exclude it, popup-only control.

---

### Step 6: Toolbar badge

A state indicator, not a countdown: set only on transitions, so nothing ticks.

**Tests first:** `badgeFor(statuses)` in `extension/common/badge.js`, pure: returns
`{ text, color }` for: nothing (empty text); any rule counting (`●`); any rule exhausted and
none counting (`!`); counting and another rule exhausted (`●`, counting wins, because it is
the thing happening right now); a pass active counts as counting.

**Build:**

- `badge.js`: the pure decision plus `applyBadge(badge)`, which calls
  `browser.action.setBadgeText`, `setBadgeBackgroundColor` and `setBadgeTextColor` inside a
  try/catch and feature-detects `browser.action?.setBadgeText`, since Android may not draw
  badges at all.
- `index.js`: `syncBadge()` after `settleAndArm`, in `onChange`, and at the end of every alarm
  handler. It reads `status()` for every rule; no new state.

**Check by hand:**

1. Dot appears when a video starts, disappears when it pauses.
2. Mark appears when a rule blocks, and clears at the unlock instant with the console closed
   (the unlock alarm from Step 2 woke the page).
3. Terminate the background script mid-playback: the badge is right again after the next tab
   event, because `prime` re-derives everything.

**Docs:** one paragraph in DESIGN.md §7 or a short §18.

---

### Step 7: Return link after unlock

The block page knows the URL it replaced; show it as a link once the rule unlocks.

**Tests first:** `returnUrlFrom(params)` in a small pure helper (put it in `rules.js` next
to `hostnameOf`): accepts `http(s)` only; rejects `javascript:`, `data:`, `moz-extension:`
and anything `hostnameOf` refuses; returns `null` for a missing or empty parameter; keeps the
query string and fragment of the original.

**Build:**

- `enforcer.blockedUrlFor(rule, snapshot, originalUrl)` adds `url=` to the query. Only the
  `block` action reaches a page, so `close` is unaffected. The URL is `tab.url` at the moment
  of the sweep or guard.
- Block page: while blocked, a muted line "You were on youtube.com/watch?v=…" (hostname and
  a truncated path, no link). Once unlocked, a real link "Back to the video". Navigating to
  it goes through `guardTab` like any navigation, so if the rule re-blocks it re-blocks. The
  link is not a bypass, and there is no auto-redirect on unlock, on purpose.

**Check by hand:**

1. Get blocked on a specific video: the block page names it; on unlock the link opens that
   exact URL and the popup starts counting again.
2. Put `url=javascript:alert(1)` in the block page URL by hand: no link is rendered.

---

### Step 8: Export and import

Backup, and the only practical way to carry a rule set to Android.

**Tests first** (`test/transfer.test.js`):

- `serializeRules(rules)` yields `{ format: "selfcontrol-rules", version: 2, exportedAt,
  rules }` with `strip`-clean rules only (no stray form fields).
- `parseImport(text)`: valid file round-trips; a version-1 file (no new fields) imports with
  defaults filled; unknown `format` refused; not JSON refused; `rules` not an array refused;
  a rule failing `validateRule` is reported with its index and label and the whole import is
  refused, since a half-applied rule set is worse than none; ids are kept as-is; duplicate
  ids in the file refused.
- `importSummary(current, incoming)`: which ids are new, which are kept (usage preserved),
  which current ids will be removed (usage discarded).

**Build:**

- `extension/common/transfer.js`, pure.
- Options page: "Export" builds a `Blob` and clicks a temporary `<a download="selfcontrol-rules-YYYY-MM-DD.json">`.
  "Import" is a hidden `<input type="file">`; on choosing a file the page shows the summary
  from `importSummary` ("3 rules replace your 2. youtube keeps its history; instagram's is
  discarded.") with a confirm button, and only then replaces the drafts and saves through the
  ordinary `save()` path. Import goes through the same validation as the form.
- Move `strip()` into `rules.js` so export and the form share it.

**Check by hand:**

1. Export, delete a rule, import the file: the rule is back and its history is gone (expected;
   the summary said so).
2. Export, edit the file's `youtube` budget, import: the popup shows the new budget and the
   old usage.
3. Feed it a file with `"budgetSec": 0`: refused with the rule named, nothing changed.

---

### Order and what is not in this round

Steps 1 → 2 → 3 are strictly sequential (each builds on the previous data). Step 4 needs 2.
Step 5 needs 1, 2 and 4. Steps 6, 7 and 8 are independent of each other and only need 2.

Not in this round, and why: cooling-off period (would need a pending rule set and an alarm
to apply it; worth doing after import exists, since import is the widest loosening path),
tapering budgets, idle detection, notifications, notes on a rule, `declarativeNetRequest`.

## Fixed: hands-off playback under-counted (2026-09-05)

**Symptom:** watching a video without touching the computer registered less time than was
spent. A 7-minute video showed as exactly 5:00 in the popup. Interacting with the computer
while the video played made the problem go away.

**Cause:** a stop (pause, ending, tab closed, or a quiet stretch dropping `audible`) that landed
on an unloaded event page was settled by `store.reconcile()`, which credited the leftover
interval only up to the last flush. The last flush was the 5-minute checkpoint, which had also
restarted the interval, so the 2 minutes after it were credited as zero. The reasoning was that
the stop time was unknown; it is not, because the stop is the event that wakes the page. Videos
with silent gaps stopped many times and compounded the loss.

**Fix:** `reconcile` settles up to `now`. The existing sleep clamp (`MAX_CHUNK_MS`, 7.5 min)
bounds a suspended machine. `meta:lastFlush` had no other reader and was removed along with its
write in `flush()`; installs that already hold the key keep a harmless orphan in
`storage.local`. Tests, PLAN.md Checkpoint 4 item 3 and DESIGN.md §5 updated.

**Still to check by hand** (the pure tests cover the arithmetic, not Firefox):

1. Start a video, close the console, let it run past one checkpoint, wait ~2 more minutes and
   pause. Reopen the console. Expect `reconciled youtube: credited 2:00 …` (roughly) and
   `dumpUsage()` matching the clock.
2. Play, unload the page, suspend the laptop for >10 min, resume, pause. The `reconciled` line
   must credit no more than 7:30.

**Known and accepted:** the observers still *drop* the waking event itself because they run with
an empty rule set until `setRules()` lands. That is harmless — reconcile covers stops and
`prime()` re-derives starts — but it is why `reported` cannot be trusted across a restart.
