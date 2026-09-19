---
name: release
description: Cut a signed release - verify preconditions, bump the manifest version, tag, push, and finish the GitHub release notes. Use when the user asks to release, ship, or publish a new version.
---

# Cutting a release

The authoritative process lives in [docs/RELEASE.md](../../../docs/RELEASE.md) — read it first.
This skill is the executable checklist; if the two disagree, RELEASE.md wins and this file
needs updating.

The version may be given as an argument (`/release 0.2.0`). If not, ask for it — never invent
a version number.

## 1. Verify preconditions — all of them, before touching anything

Abort and report if any fails:

- On `main`, working tree clean, and in sync with `origin/main` (`git fetch` first). The
  workflow refuses to run from a branch.
- `nix develop --command node --test` passes.
- `nix develop --command web-ext lint` shows 0 errors, 0 warnings.
- The target tag `vX.Y.Z` does not already exist, locally or on origin.
- The target version is greater than the current `version` in `extension/manifest.json`.
- Nothing meant for this release is still open: run `gh pr list --base main` and, if any PR
  is listed, show it to the user and ask whether it belongs in the release before going on.
  Features land through PRs (RELEASE.md § Each release); the release bump is the only direct
  commit to `main`.

⚠️ **AMO permanently burns a version number on a successful sign, even if a later workflow
step fails.** A stranded version can never be reused — the only way forward is another bump.
That is why every check runs before the push, and why a failed release is never re-tagged
with the same number.

## 2. Bump, commit, tag

1. Set `version` in `extension/manifest.json` to the new version.
2. Commit exactly: `Release X.Y.Z`
3. Tag `vX.Y.Z` — it must match the manifest version character for character; the workflow
   checks and refuses otherwise.

## 3. Confirm, then push

Show the user the version, the commit, and the tag, and **get explicit confirmation before
pushing** — the push triggers signing, which is the irreversible step. Then:

```bash
git push origin main --tags
```

## 4. After the workflow

The `release` workflow signs the .xpi, attaches it to a GitHub Release, and publishes
`updates.json`. Watch it with `gh run watch` — `gh` is installed and authenticated on the dev
machine, system-wide rather than in the nix shell, so call it from a plain shell.

Once it succeeds, finish the release notes per RELEASE.md § Release notes:

- List the PRs merged since the previous tag:
  ```bash
  gh pr list --state merged --base main \
    --search "merged:>=$(git log -1 --format=%cs <previous-tag>)" --json number,title,url
  ```
  Cross-check against `git log <previous-tag>..vX.Y.Z --oneline` so nothing is missed.
- **Every relevant PR gets one plain-language bullet ending in its number, `(#N)`.** Relevant
  means it changed what ships or what the user sees; docs-, CI- or tooling-only PRs may be
  omitted, and the release bump commit needs no bullet. Start from the PR title and rewrite it
  for the user if it reads like a commit message.
- The bullets go **above** the `**Full Changelog**` compare link, which must stay at the
  bottom.
- **Show the user the exact text before it goes anywhere** — the notes are published,
  user-facing copy, and only the user approves them. Once approved, publish with
  `gh release edit vX.Y.Z --notes "..."` — `--notes` replaces the whole body, so the text must
  include the link — then read it back with `gh release view vX.Y.Z --json body -q .body`
  and confirm it matches.

Existing installs pick the release up within about a day; a manual check is
**about:addons → gear → Check for Updates**.
