# SelfControl

A Firefox add-on that puts strict, **activity-aware** time limits on websites.

The distinguishing idea: the clock only runs while you are *actually consuming* the site. A
paused YouTube tab costs nothing. Sitting on Instagram in a background tab costs nothing. Ten
open tabs you are not looking at cost nothing.

When the budget runs out, the site is blocked or the tab is closed — and it stays that way if
you reopen it.

---

## Two ways to count

| Mode | The clock runs while… | Good for |
|---|---|---|
| **While playing** | any matching tab is producing sound, including in the background | YouTube, Twitch, Netflix |
| **While focused** | a matching tab is the focused tab of the focused window | Instagram, Reddit, news |

`while playing` uses the tab's own audio state, so it needs no page access and ignores YouTube's
muted hover-previews for free. `while focused` stops the moment you switch tabs *or* switch away
from Firefox entirely.

Budgets run over a **rolling window** — 5 minutes per hour means the last 60 minutes, always, not
a counter that resets on the hour. Time comes back gradually as it ages out.

## Install

Signed by Mozilla, distributed from this repo rather than the add-ons store.

1. Download the latest `.xpi` from [Releases](https://github.com/jpmaior/selfcontrol/releases/latest).
2. Open it with Firefox, or use *about:addons → gear → Install Add-on From File*.

Updates after that are automatic. Requires Firefox 154+.

## Configure

Toolbar button → **Edit rules**, or *about:addons → SelfControl → Preferences*.

Each rule takes a name, some domains, a counting mode, a budget, a window, and what to do when
the budget is spent. Edits apply immediately — no restart.

The one setting worth explaining is **"stay blocked until this much is free again"**. On a
rolling window, a spent budget starts returning one minute at a time, which would let you back in
for a minute, then block you, then let you back in. Setting this to 5 minutes means you come back
in usable chunks instead. Set it to `0` if you actually want the drip.

## How it works

Time is never *ticked*. The extension records the timestamps at which you start and stop
consuming a site and does arithmetic — which means a twenty-minute video costs **zero disk writes
and zero wake-ups** while it plays. Usage lives in a sparse map of one-minute buckets, so a
rolling window is a sum over the recent ones and pruning is deleting the rest.

That design falls out of Manifest V3: Firefox unloads the background page whenever it is idle, so
anything holding a counter in memory would lose it constantly.

[DESIGN.md](./docs/DESIGN.md) has the full reasoning, including the parts that turned out to be wrong
and why.

## Permissions

`storage`, `tabs`, `alarms`. **No host permissions, no content scripts** — the extension never
sees page content, and the install prompt says "Access browser tabs" rather than "Access your
data for all websites". Nothing leaves the browser.

## Development

```bash
nix develop        # web-ext + node, pinned via flake.lock
web-ext run        # launches Firefox with the extension, live-reloading
node --test        # 40 tests over the pure modules, no browser needed
web-ext lint       # AMO validation
```

The rolling-window arithmetic (`accountant.js`) and the rule validation (`rules.js`) are pure —
no `browser.*`, no `Date.now()`, the clock is always an argument — which is what makes them
testable without a browser. Everything else is verified by hand against the checkpoints in
[PLAN.md](./docs/PLAN.md).

No bundler, no framework, no build step. Plain ES modules.

## Known limitations

- **Muting is a loophole.** Muting a tab stops the clock, so muted playback with captions is
  unlimited. Deliberate: closing it would mean giving up the hover-preview immunity.
- **Android is prepared, not verified.** The code is safe on Android but has never run there, and
  `while focused` rules would keep counting while the browser is backgrounded. See
  [DESIGN.md §12](./docs/DESIGN.md).
- **It is a speed bump, not a lock.** Disabling the add-on is always two clicks away, and it does
  not run in private windows unless you allow it.

## Documentation

| | |
|---|---|
| [DESIGN.md](./docs/DESIGN.md) | Architecture and the reasoning behind every decision |
| [PLAN.md](./docs/PLAN.md) | How it was built, step by step, with the manual checkpoints |
| [RELEASE.md](./docs/RELEASE.md) | Signing and publishing a new version |
| [CLAUDE.md](./CLAUDE.md) | Conventions and invariants for AI-assisted work |
