# Releasing

Self-distribution: Mozilla signs the add-on and hands back an `.xpi` you host yourself. It never
appears in AMO search, needs no listing metadata, and review is automated. This exists because
release Firefox refuses to permanently install an unsigned extension.

Installed copies update themselves:

```
extension/manifest.json
  update_url ─────────► https://jpmaior.github.io/selfcontrol/updates.json   (GitHub Pages)
                          update_link ─────────► GitHub Release asset (.xpi)
```

Firefox fetches `updates.json` roughly daily and offers anything newer than what is installed.

> **`update_url` is read from the copy already installed.** Changing it later means keeping the
> old URL serving a valid `updates.json` until every install has moved to a version carrying the
> new one. Worth knowing before the first signed release goes out.

---

## One-time setup

### 1. AMO credentials

1. Create an account on [addons.mozilla.org](https://addons.mozilla.org) and **enable 2FA** —
   mandatory for developer accounts.
2. Generate an API key at
   [addons.mozilla.org/developers/addon/api/key/](https://addons.mozilla.org/en-US/developers/addon/api/key/).
3. Add both halves to the repo: **Settings → Secrets and variables → Actions**
   - `AMO_JWT_ISSUER` — the key, looks like `user:12345:67`
   - `AMO_JWT_SECRET` — the secret

   Never put these in `web-ext-config.mjs`; it is committed.

### 2. GitHub Pages

**Settings → Pages → Source: GitHub Actions.** Not "Deploy from a branch" — the workflow
publishes directly, and the deploy step fails otherwise.

**Settings → Environments → `github-pages` → Deployment branches and tags.** By default this
environment only accepts deployments from the default branch, so a `v*` tag is rejected with:

> Tag "v0.1.0" is not allowed to deploy to github-pages due to environment protection rules.

Choose **Selected branches and tags**, then add a rule with ref type **Tag** and pattern `v*`.
Everything before the deploy will have already succeeded when this bites, including signing.

Nothing else to configure: `jpmaior.github.io` already has a valid certificate, which is all
`update_url` requires.

---

## Each release

```bash
# 1. Bump the version. AMO permanently rejects a version it has already seen,
#    including from a submission that failed review.
$EDITOR extension/manifest.json

git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main --tags
```

The `release` workflow then:

1. checks the tag matches the manifest version — otherwise `updates.json` would advertise a
   version nobody can download;
2. runs the tests and `web-ext lint`;
3. signs with AMO (`--channel=unlisted`, set in `web-ext-config.mjs`);
4. attaches the signed `.xpi` to a GitHub Release;
5. regenerates `updates.json` pointing at that asset, with a `sha256` of the exact bytes;
6. publishes it to Pages.

Existing installs pick it up on their next check. Force one with **about:addons → gear → Check
for Updates**.

### Release notes

The workflow creates the release with `--generate-notes`, which yields only the
**Full Changelog** compare link. Once it finishes, edit the release and add a short changelist
above that line — a few plain-language bullets of what changed. A pile of small fixes does not
need itemising; "Bug fixes." is enough. Keep the auto-generated **Full Changelog** link at the
bottom, as in v0.1.0. Note that `gh release edit --notes` replaces the whole body, so re-include
the link when editing from the CLI:

```markdown
- Rules can now be deleted without the defaults coming back
- Bug fixes.

**Full Changelog**: https://github.com/jpmaior/selfcontrol/compare/v0.1.0...v0.2.0
```

### Doing it by hand

```bash
nix develop
web-ext sign                      # signed .xpi lands in web-ext-artifacts/
node tools/make-updates-json.mjs \
  web-ext-artifacts/selfcontrol-0.2.0.xpi \
  https://github.com/jpmaior/selfcontrol/releases/download/v0.2.0/selfcontrol-0.2.0.xpi
```

## The first install

Auto-updates only work from a copy that already carries `update_url`, so the first one is manual:
`about:addons` → gear → **Install Add-on From File**, and pick the signed `.xpi`. Or just open
the file with Firefox.

---

## Notes

**`web-ext lint` must run with `selfHosted: true`** (set in `web-ext-config.mjs`). `update_url`
is *forbidden* for AMO-listed add-ons and *required* for self-hosted ones, and the linter assumes
listed unless told otherwise — without it the manifest fails with `MANIFEST_UPDATE_URL`.

**No source-code upload is required.** AMO demands source when an add-on is minified, bundled or
transpiled. This one is plain ES modules with no build step, so reviewers read exactly what
ships.

**Data collection is declared as `none`**, which matches reality — nothing leaves the browser —
so no privacy policy is needed.

**The name would be a problem if this were ever listed publicly.** "SelfControl" is an
established macOS app in the same category, and AMO policy prohibits names likely to be confused
with existing products. Irrelevant while self-distributing.

**The debug console handles stay in.** `dumpUsage()`, `dumpStats()`, `dumpPlatform()`,
`dumpRaw()`, `setLimits()`, `resetRules()` and `resetUsage()` are reachable only from the
extension's own background console, and they are the diagnostic surface this was built with.

**`web-ext build`** produces an *unsigned* zip — useful for inspecting what would be uploaded,
not installable on release Firefox.
