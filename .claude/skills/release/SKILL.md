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
`updates.json`. Tell the user to watch it under the repo's Actions tab (`gh` is not in the
dev shell).

Once it succeeds, finish the release notes per RELEASE.md § Release notes:

- Draft a short changelist from `git log <previous-tag>..vX.Y.Z --oneline` — a few
  plain-language bullets. Many small fixes collapse to just "Bug fixes."
- The bullets go **above** the auto-generated `**Full Changelog**` compare link, which must
  stay at the bottom.
- **Show the user the exact text before it goes anywhere** — the notes are published,
  user-facing copy, and only the user approves them. Once approved, give them the release URL
  to paste it into (`https://github.com/jpmaior/selfcontrol/releases/tag/vX.Y.Z`), or use
  `gh release edit` if available — remembering `--notes` replaces the whole body, so
  re-include the link.

Existing installs pick the release up within about a day; a manual check is
**about:addons → gear → Check for Updates**.
