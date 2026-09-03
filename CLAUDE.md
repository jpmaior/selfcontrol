# CLAUDE.md

Firefox MV3 extension imposing activity-aware time limits on websites. Firefox only — Chrome
support is an explicit non-goal, so use `browser.*` with promises throughout.

Read [DESIGN.md](./docs/DESIGN.md) before changing behaviour; it records *why* each decision was made,
including several that were validated or corrected by testing.

## Commands

```bash
nix develop                  # required — web-ext and node are pinned here, not global
node --test                  # 40 tests over the pure modules
web-ext lint                 # must stay at 0 errors, 0 warnings
web-ext run                  # Firefox with live reload
web-ext build                # unsigned zip, for inspecting what would ship
```

Nix flakes only see **git-tracked** files. A new file needs `git add` before `nix develop` sees
it.

## Layout

```
extension/background/   event page: index (wiring), observers, accountant, store, enforcer
extension/common/       shared with the UI: rules, settings, format
extension/popup|options|blocked/
test/                   node --test
docs/                   DESIGN.md, PLAN.md, RELEASE.md, TODO.md (open findings)
```

## Invariants — breaking these causes subtle, hard-to-see bugs

**`accountant.js` and `rules.js` are pure.** No `browser.*`, no `Date.now()` — time is always an
argument. This is what makes 40 tests run in milliseconds with no browser. Do not import browser
APIs into them; put that in `store.js` or `settings.js`.

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

## Testing

`node --test` covers the pure modules only. Browser behaviour is verified **by hand** against the
checkpoints in [PLAN.md](./docs/PLAN.md) — that is deliberate, and several design decisions came from
what those checkpoints revealed. When changing observer or enforcement behaviour, say what the
user should check rather than claiming it works.

⚠️ **An attached devtools console pins the event page alive**, so the suspend/restart cycle never
happens while you are watching. Force it with **Terminate Background Script** in `about:debugging`
(*Terminate* keeps `storage.session`; *Reload* clears it).

## Releasing

Tag `vX.Y.Z` after bumping `extension/manifest.json`. See [RELEASE.md](./docs/RELEASE.md),
or run the `/release` skill, which walks the checklist with the guardrails.

**AMO permanently claims a version number on a successful sign.** A failure in a later workflow
step strands that tag — the version cannot be reused.

**`update_url` is read from the copy already installed.** Changing it means keeping the old URL
serving until every install has moved to a version carrying the new one.

**`web-ext lint` needs `selfHosted: true`** (already in `web-ext-config.mjs`). `update_url` is
forbidden for AMO-listed add-ons and required for self-hosted ones.

## Style

Comments explain *why*, not *what* — particularly where a choice looks arbitrary but is defending
against something specific. Match the existing density; several modules carry a header comment
explaining their role and the constraint that shaped them.
