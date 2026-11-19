# Development

How to build, run and inspect the extension. The reasoning behind the code is in
[DESIGN.md](./DESIGN.md); the browser checks to run against it are in
[SCENARIOS.md](./SCENARIOS.md).

## The dev shells

```bash
nix develop                  # web-ext and node, pinned via flake.lock
node --test                  # the pure modules and store.js, milliseconds, no browser
web-ext lint                 # AMO validation: must stay at 0 errors, 0 warnings
web-ext run                  # Firefox with the extension, live-reloading
web-ext build                # unsigned zip, for inspecting what would ship
nix develop .#browser        # Linux: adds Firefox on a virtual display (below)
nix develop .#android        # x86_64 Linux: adds adb and a headless emulator (below)
```

Nothing is installed globally: the tools come from the flake, so every machine runs the same
versions. Flakes only see **git-tracked** files, so a new file needs `git add` before
`nix develop` notices it.

No bundler, no framework, no build step. Plain ES modules, loaded as they are.

## The console handles

The event page's console (`about:debugging` → SelfControl → **Inspect**, or `eval --bg` below)
exposes the diagnostic surface the extension was built with. They stay in release builds, since
only the extension's own console can reach them (RELEASE.md).

| Handle | Does |
|---|---|
| `dumpUsage(ruleId?)` | used, budget, remaining and unlock time per rule, live |
| `dumpStats()` | write counters since the event page started (`localWrites`, …) |
| `dumpRaw()` | everything in `storage.local` and `storage.session`, and its size |
| `dumpPlatform()` | what this Firefox offers: window focus events, `tab.audible`, filters, … |
| `setLimits(ruleId, patch)` | change a rule through the same validation and save path as the options page |
| `resetUsage()` | delete every rule's usage and the open intervals; reload afterwards |
| `resetRules()` | delete the settings; the defaults come back on the next reload |

`setLimits` is how a test gets a budget it can exhaust in seconds rather than an hour:

```js
await setLimits("youtube", { budgetSec: 30, windowSec: 120, minUnlockCreditSec: 30 })
```

## The event page lifecycle

Most of the bugs worth finding happen when the event page is unloaded and restarted, so a test
has to make that happen, and two things get in the way.

⚠️ **An attached devtools console pins the event page alive.** Firefox says so: "background
event page was not terminated on idle because a devtools toolbox is attached". With the console
open, the suspend/restart cycle never happens and lifecycle bugs stay invisible.

**Terminate and Reload are different buttons** in `about:debugging`:

| Button | Effect | `storage.session` |
|---|---|---|
| **Terminate Background Script** | unloads the event page only, as idleness does | survives |
| **Reload** | restarts the whole extension | cleared |

*Terminate* is the one that reproduces what happens to a user. Both tools below have a
`terminate` and a `reload` command that do the same.

## Desktop Firefox with no desktop

`nix develop .#browser` (Linux) adds Firefox, Xvfb, a null audio sink and xdotool. Then
`node tools/browser.mjs` drives a real Firefox on a virtual display with the extension installed
temporarily: `shot` takes a screenshot, `popup` opens the real popup, `eval --bg 'dumpUsage()'`
reaches the console handles, `terminate` is *Terminate Background Script* and `log` is the event
page's console. Run it with no arguments for the full list; its header comment explains the
choices.

It attaches no devtools, so the event page suspends as it would for a user. The profile lives in
`.browser/`. On a fresh profile YouTube opens behind an EU consent dialog that pauses playback;
reject it once and the profile remembers.

`eval` waits at most 30 s for a promise. To watch a page over minutes (a countdown, a usage
line), leave a recorder in it and read it back later:
`eval 'window.rec = []; setInterval(() => rec.push([Date.now(), document.body.innerText.slice(0, 80)]), 1000)'`,
then `eval 'rec'`. In a tab, not the event page, which takes it along when it suspends.

## Firefox for Android

### On a phone

```bash
nix develop .#android
adb devices             # the phone, with USB debugging on in Android's developer options
web-ext run -t firefox-android --adb-device <ID> --firefox-apk org.mozilla.firefox
```

Firefox has to allow it too: ⋮ → Settings → Advanced → **Remote debugging via USB**. Until that
is on, `web-ext` prints "Waiting for org.mozilla.firefox Remote Debugging Server..." and never
says why. The console is then `about:debugging` on the desktop, connected over USB. The popup
opens from the ⋮ menu rather than a toolbar.

### On the emulator

`nix develop .#android` on x86_64 Linux also provides a headless emulator: `emu-create`,
`emu-start`, `emu-stop`, plus `screenshot`, `ui-list` and `tap-text` to see and drive its screen.

**Once per AVD.** The Google APIs image has no Play Store, so Firefox comes from Mozilla's
release archive. The AVD keeps Firefox and its settings across `emu-stop`, so none of this
repeats:

```bash
nix develop .#android
emu-create
emu-start
v=$(curl -fsS https://product-details.mozilla.org/1.0/mobile_versions.json \
  | sed -n 's/^ *"version": "\(.*\)".*/\1/p')   # current release, e.g. 159.0.1
curl -fLO "https://archive.mozilla.org/pub/fenix/releases/$v/android/fenix-$v-android-x86_64/fenix-$v.multi.android-x86_64.apk"
adb install "fenix-$v.multi.android-x86_64.apk"
```

Then open Firefox on the emulator, go through its welcome screens, and turn on Remote debugging
via USB as above. If `archive.mozilla.org` times out, add `-4` to both `curl` calls: on the
maintainer's machine its IPv6 route hangs.

**Each session:**

```bash
nix develop .#android
node tools/android.mjs start            # emu-start if needed (~2½ min cold), then web-ext run
node tools/android.mjs eval 'dumpUsage()'
node tools/android.mjs log              # the event page's console since it started
```

`start` leaves `web-ext` running in the background: it installs the working tree as a temporary
add-on and reloads it on every change under `extension/`. Firefox for Android sends extension
console output nowhere a shell can read, so the tool talks to Firefox's remote debugging port,
which `web-ext` forwards over adb. `status`, `wake`, `terminate` and `chrome` attach nothing, so
the page still suspends; `log` and `eval` attach only briefly, and `follow` keeps it alive while
it streams. `eval … --page options.html` reaches an open extension page. Run it with no
arguments for the full list; its header comment explains what attaches and what does not.

`log` shows only what the event page logged since it last started: once it suspends, Firefox
keeps nothing of what it said. Read it before then, `follow` while it happens (which keeps the
page alive), or read the outcome with `eval 'dumpUsage()'`.

`emu-start` boots this project's AVD, `selfcontrol_api36`, also while another project's emulator
runs: on the next free port, `emulator-5556` beside one on 5554, and it prints the serial.
`emu-stop` stops only that AVD. `tools/android.mjs` keeps to the device `start` used; `adb` and
`screenshot`, `ui-list` and `tap-text` need `export ANDROID_SERIAL=emulator-5556` first.

The options page is ⋮ → Extensions → SelfControl → Settings; under software rendering it can
stay blank for a few seconds before it draws. `node tools/android.mjs stop` stops `web-ext`
(the add-on stays loaded until Firefox restarts), then `emu-stop`.

### A real update

`web-ext run` cannot stand in for an update: it restarts Firefox before it installs, and what it
installs is temporary. A temporary install over a permanent one replaces it, and the permanent
one is gone with the next restart. To update the way a user does, from an older signed release
to the one `updates.json` offers, install that release permanently through the parent process:

```bash
A="node tools/android.mjs"
AM='const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");'
gh release download v0.3.2 -p '*.xpi' -D /tmp/old && adb push /tmp/old/*.xpi /data/local/tmp/old.xpi
$A stop      # or web-ext reinstalls the working tree on the next change
$A chrome "(async () => { $AM (await AddonManager.getAddonByID('selfcontrol@jpmaior')).uninstall() })()"
$A chrome "(async () => { $AM
  const i = await AddonManager.getInstallForFile(await IOUtils.getFile('/data/local/tmp/old.xpi'));
  return (await i.install()).version })()"
$A chrome "(async () => { $AM
  const a = await AddonManager.getAddonByID('selfcontrol@jpmaior');
  const i = await new Promise((r) => a.findUpdates({ onUpdateAvailable: (_, i) => r(i),
    onUpdateFinished: (_, error) => r(error) }, AddonManager.UPDATE_WHEN_USER_REQUESTED));
  return i.install ? (await i.install()).version : 'no update, error ' + i })()"
```

With another emulator running, `export ANDROID_SERIAL` first (above). A fetch of
`updates.json` that fails reads as no update with a non-zero error, and a slow one can outlast
`chrome`'s wait: check the version and try again. Uninstalling the temporary add-on clears its
storage. `start` goes back to the working tree.

### Watching the emulator in T3 Code

T3 Code's Device panel shows the headless emulator live and lets you (or an agent) tap and type
in it, which beats `screenshot` and `tap-text` for anything interactive. It looks for its tools
outside any dev shell, on the machine running the T3 server, and each step below fixes one error
it reports otherwise:

```bash
# An Android SDK outside the dev shell. On the maintainer's machine that is
# ~/dev-envs/android#android-sdk in the user profile: same nixpkgs revision, same store paths.
nix profile add ~/dev-envs/android#android-sdk

# "Android SDK was not found": T3 insists on cmdline-tools/latest/bin/avdmanager, and the Nix
# SDK names that directory by version. Mirror the SDK at ~/Android/Sdk, where T3 looks on its own.
S=~/.nix-profile/libexec/android-sdk
mkdir -p ~/Android/Sdk/cmdline-tools
for e in "$S"/*; do [ "${e##*/}" = cmdline-tools ] || ln -sfn "$e" ~/Android/Sdk/"${e##*/}"; done
ln -sfn "$S"/cmdline-tools/* ~/Android/Sdk/cmdline-tools/latest

# "requires Node.js" and "needs working ffmpeg with the libx264 encoder". Taking both from
# flake.lock's nixpkgs revision means they are already in the store, not downloaded.
rev=$(sed -n 's/.*"rev": "\([0-9a-f]*\)".*/\1/p' flake.lock | head -1)
nix profile add "github:NixOS/nixpkgs/$rev#nodejs_22" "github:NixOS/nixpkgs/$rev#ffmpeg-headless"
```

None of this needs a T3 restart, which matters because a restart ends every running agent
thread. T3 re-checks `~/Android/Sdk` on each call, and `~/.nix-profile/bin` is already on its
`PATH`. One trap: an `ANDROID_HOME` in the T3 server's environment overrides `~/Android/Sdk`, so
it must point there rather than at the Nix SDK, or T3 rejects the SDK again after its next
restart. `~/.profile` exports `ANDROID_HOME=~/Android/Sdk` for that reason.

Once `emu-start` has booted it, the emulator appears in the Device panel under the serial
`emu-start` printed, `emulator-5554` when it is the only one; open it there. T3 also lists the
AVDs that are not running, but booting through `emu-start` is the path that has been checked.
After a nixpkgs bump that changes the cmdline-tools version, `latest` dangles: re-run the
`ln … latest` line.
