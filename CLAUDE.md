# CLAUDE.md

Firefox MV3 extension imposing activity-aware time limits on websites. Firefox only — Chrome
support is an explicit non-goal, so use `browser.*` with promises throughout.

Read [DESIGN.md](./docs/DESIGN.md) before changing behaviour; it records *why* each decision was made,
including several that were validated or corrected by testing.

## Commands

```bash
nix develop                  # required — web-ext and node are pinned here, not global
node --test                  # the pure modules and store.js, milliseconds, no browser
web-ext lint                 # must stay at 0 errors, 0 warnings
web-ext run                  # Firefox with live reload
web-ext build                # unsigned zip, for inspecting what would ship
nix develop .#browser        # Linux: adds Firefox on a virtual display, for tools/browser.mjs
nix develop .#android        # x86_64 Linux: adb + a headless emulator, for tools/android.mjs
```

Nix flakes only see **git-tracked** files. A new file needs `git add` before `nix develop` sees
it. [DEVELOPMENT.md](./docs/DEVELOPMENT.md) has the rest: the console handles, both browser
tools, the emulator.

## Layout

```
extension/background/   the event page: wiring, observers, accounting, storage, enforcement
extension/common/       shared with the pages: the pure decision modules, settings, formatting
extension/popup|options|blocked/
test/                   node --test
tools/                  browser.mjs and android.mjs (Firefox to drive), make-updates-json.mjs
docs/                   see Docs below
```

The module-by-module map is DESIGN.md §10.

## Docs

Each fact has one home. Anywhere else gets at most a one-line summary and a link, never the
details: copies drift. Prose does not carry numbers that change on their own (test counts,
line numbers); name the function instead.

| File | Holds | Update it |
|---|---|---|
| [DESIGN.md](./docs/DESIGN.md) | why the code is the way it is | in the same PR as the behaviour change, in its section |
| [SCENARIOS.md](./docs/SCENARIOS.md) | the browser checks | in the same PR as the browser behaviour change |
| [DEVELOPMENT.md](./docs/DEVELOPMENT.md) | building, running, inspecting | when a shell, tool or setup step changes |
| [RELEASE.md](./docs/RELEASE.md) | signing and publishing | when the process changes; the `/release` skill follows it |
| [README.md](./README.md) | what users need | when what they see or install changes |
| GitHub issues | open work, bugs and ideas | when something is found, decided or finished |

Open work is not kept in the repo: check `gh issue list` before starting on something. Each
issue gets one type label (`bug`, `enhancement`, or `dev` for what does not ship) and, when
they apply, `idea` (not decided yet), `upstream` (waiting on Firefox) and `android`. When a
bug is fixed, its reasoning goes into DESIGN.md, its story into the PR description, and the PR
closes its issue (`Closes #N`).

DESIGN.md's section numbers are cited from code comments and merged PRs, so a section is never
renumbered: a dropped one keeps a short stub.

## Invariants — breaking these causes subtle, hard-to-see bugs

**The pure modules stay pure.** `accountant`, `rules`, `calendar`, `policy`, `transfer`, and
any module added later to make decisions, take no `browser.*` and no `Date.now()` — time is
always an argument. This is what makes the whole test suite run in milliseconds with no
browser. Do not import browser APIs into them; put that in `store.js`, `settings.js`,
`platform.js` or the page scripts.

**Never tick.** Time is accrued by committing intervals between state transitions, never by a
timer incrementing a counter. A playing video should cost zero writes and zero wake-ups.

**The event page is unloaded constantly.** Anything in a module-level variable disappears. All
persistent state goes to `storage.local`, ephemeral state to `storage.session`, and long timers
through `browser.alarms` — `setTimeout` does not survive.

**Listeners must be registered during synchronous module evaluation.** An MV3 event page is
restarted *by* an event, so a listener added after an `await` may miss the event that woke it.
That is why `index.js` starts the observers with an empty rule set and swaps the real one in via
`setRules()` afterwards.

**Observer state is derived, never authoritative.** `prime()` must be able to rebuild all of it
from `tabs.query()` alone, and it runs on every event page start.

**`alarms.create()` replaces by name and restarts the period.** Recreating an alarm on every
event page start would postpone it indefinitely. Check for an existing alarm first.

**Hot and cold storage keys are separate.** `usage:<ruleId>` is written often; `settings` is not.
Never merge them, or a counter update would rewrite the configuration.

**A rule's `id` keys its usage data.** Never regenerate an id for an existing rule — it silently
orphans its history. Ids are minted once, at save time, only for rules that have none.

**Do not add host permissions or content scripts casually.** In Firefox MV3 host permissions are
*not* granted at install time; the user must grant them manually, and until they do the extension
silently does nothing. The whole design avoids them.

**Do not change `update_url` in the manifest casually.** It is read from the copy already
installed, so the old URL has to keep serving until every install has moved (RELEASE.md).

## Testing

**Every test is automated: nothing is left for the user to check by hand.** Behaviour is
tested either by `node --test` or by you, in a real browser you drive yourself. Never hand the
user a list of steps to verify.

**Tests come before the code.** For any behaviour that `node --test` can reach — the pure
modules and `store.js` — write the test cases for the new or changed behaviour first, run
`node --test` and see them fail for the right reason, and only then implement until they pass.
Do not write the implementation and back-fill tests afterwards; a test written after the code
tends to describe what the code does rather than what it must do. If a change makes an existing
test fail, that is a design question to raise, not a test to edit into silence.

Browser behaviour (observers, enforcement, alarms, the pages) is tested in Firefox, and you run
those tests: the scenarios in [SCENARIOS.md](./docs/SCENARIOS.md), on desktop through
`tools/browser.mjs` and on Firefox for Android through `tools/android.mjs`. Several design
decisions came from what such runs revealed, so they are not optional. The tests-first rule
applies here too: before writing the code, write or pick the scenario, run it against the
current code and see it fail where it can, then make it pass. Report what you ran and what you
saw. If something cannot be tested this way, say so plainly rather than claiming it works or
asking the user to check it.

⚠️ **An attached devtools console pins the event page alive**, so the suspend/restart cycle never
happens while you are watching. Neither tool attaches by default; `terminate` is *Terminate
Background Script* (keeps `storage.session`) and `reload` is *Reload* (clears it).

## Workflow

Feature work goes on a branch and lands on `main` through a pull request. The release notes
are built from the merged PRs, so a PR's title and description are user-facing copy: say what
changed for the user, in plain language, with no list of things to test. A PR where nothing
ships (tools, tests, docs, CI) gets the `dev` label, and the release notes leave it out.
`gh` is installed and authenticated on this machine (system-wide, not in the nix shell) for PRs,
watching runs and editing releases.

Every issue and PR you write ends with a line naming the model that wrote it:
`🤖 Generated by <model name> with [Claude Code](https://claude.com/claude-code)`, for example
`Claude Opus 5.5`. Use the name of the model actually running, not the one in this example. The
line does not reach the release notes, which are written by hand (RELEASE.md).

The repo merges by squash only, and merged branches are deleted:
`gh pr merge --squash --delete-branch`. Prefer PRs that branch off `main`. A PR stacked on
another keeps the lower PR's original commit after that one is squashed, and GitHub does not
retarget it: `git rebase --onto origin/main <lower PR's commit> <branch>`, re-run `node --test`
and `web-ext lint`, `git push --force-with-lease`, `gh pr edit <n> --base main`, then merge.

## Releasing

Run the `/release` skill; [RELEASE.md](./docs/RELEASE.md) is the process it follows. The
`extension/manifest.json` bump is the one commit that goes to `main` directly.

⚠️ **AMO permanently claims a version number on a successful sign**, even when a later step of
the workflow fails, so every check runs before the tag is pushed.

## Style

Comments explain *why*, not *what* — particularly where a choice looks arbitrary but is defending
against something specific. Match the existing density; several modules carry a header comment
explaining their role and the constraint that shaped them.
