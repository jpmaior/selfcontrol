{
  description = "SelfControl — activity-aware time limits for websites (Firefox extension)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs:
        let
          default = pkgs.mkShell {
            packages = [
              pkgs.web-ext # run / lint / build / sign the extension
              pkgs.nodejs_22 # `node --test` for the pure logic modules
            ];

            shellHook = ''
              # web-ext needs a Firefox binary; prefer the one already on the system.
              if [ -z "''${WEB_EXT_FIREFOX:-}" ] && command -v firefox >/dev/null; then
                export WEB_EXT_FIREFOX="$(command -v firefox)"
              fi
              # To stderr: the release workflow reads the manifest version by
              # capturing `nix develop --command` stdout, and the shellHook runs
              # even then — hints on stdout would contaminate the capture.
              echo "selfcontrol: web-ext $(web-ext --version), node $(node --version)" >&2
              echo "  web-ext run   # desktop dev: Firefox with the extension, live reload" >&2
            '';
          };

          # Only evaluated by `nix develop .#android` (x86_64 Linux, see below).
          android =
            let
              # The SDK is unfree and needs its licence accepted, so it comes from
              # its own nixpkgs instance rather than `pkgs`.
              androidPkgs = import nixpkgs {
                inherit (pkgs.stdenv.hostPlatform) system;
                config = { allowUnfree = true; android_sdk.accept_license = true; };
              };
              # Bumping flake.lock re-downloads all of this (the system image is
              # the bulk of it). On the maintainer's machine the lock is kept on
              # the same nixpkgs revision as another Android project, so every
              # component below is shared with it rather than fetched twice.
              sdk = (androidPkgs.androidenv.composeAndroidPackages {
                platformVersions = [ "36" ]; # only to select the system image
                buildToolsVersions = [ ]; # we install Firefox, never build an APK
                includeCmake = false;
                includeEmulator = true;
                includeSystemImages = true;
                systemImageTypes = [ "google_apis" ];
                abiVersions = [ "x86_64" ];
                includeNDK = false;
                includeSources = false;
              }).androidsdk;
              sdkRoot = "${sdk}/libexec/android-sdk";

              # ---- Emulator helpers: headless VM, no window, software GPU ----
              avdName = "selfcontrol_api36";
              systemImage = "system-images;android-36;google_apis;x86_64";

              emu-create = pkgs.writeShellScriptBin "emu-create" ''
                set -euo pipefail
                avd="''${1:-${avdName}}"
                echo no | avdmanager create avd -n "$avd" -k "${systemImage}" -d pixel_6 --force \
                  2>&1 | grep -v devices.xml || true
                cfg="$HOME/.android/avd/$avd.avd/config.ini"
                # Every pixel is rendered in software (no GPU on the maintainer's
                # machine). At pixel_6's 1080x2400 with swiftshader_indirect the
                # graphics stack wedged or crashed on YouTube, the tab tray and the
                # options page; 720x1600 (still 360dp wide) with swangle held up.
                sed -i -E \
                  -e '/^disk.dataPartition.path=/d' \
                  -e 's/^hw.ramSize=.*/hw.ramSize=6144/' \
                  -e 's/^hw.keyboard=.*/hw.keyboard=yes/' \
                  -e 's/^disk.dataPartition.size=.*/disk.dataPartition.size=6G/' \
                  -e 's/^hw.gpu.enabled=.*/hw.gpu.enabled=yes/' \
                  -e 's/^hw.gpu.mode=.*/hw.gpu.mode=swangle_indirect/' \
                  -e 's/^hw.lcd.width=.*/hw.lcd.width=720/' \
                  -e 's/^hw.lcd.height=.*/hw.lcd.height=1600/' \
                  -e 's/^hw.lcd.density=.*/hw.lcd.density=320/' \
                  -e 's/^showDeviceFrame=.*/showDeviceFrame=no/' \
                  "$cfg"
                echo "created AVD $avd ($cfg)"
              '';

              emu-start = pkgs.writeShellScriptBin "emu-start" ''
                set -euo pipefail
                avd="''${1:-${avdName}}"
                if adb devices | grep -q '^emulator-'; then
                  echo "emulator already running"
                else
                  log="/tmp/emulator-$avd.log"
                  setsid nohup emulator -avd "$avd" -no-window -no-audio -no-boot-anim \
                    -gpu swangle_indirect -accel on >"$log" 2>&1 </dev/null &
                  echo "starting $avd (log: $log)"
                fi
                timeout 600 adb wait-for-device
                SECONDS=0
                until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
                  [ "$SECONDS" -gt 600 ] && { echo "boot timed out" >&2; exit 1; }
                  sleep 3
                done
                echo "booted: $(adb devices | grep '^emulator-')"
              '';

              emu-stop = pkgs.writeShellScriptBin "emu-stop" ''
                adb emu kill
              '';

              # Next to tools/browser.mjs's desktop screenshots, in the ignored .browser/.
              screenshot = pkgs.writeShellScriptBin "screenshot" ''
                set -euo pipefail
                dir="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.browser/android-shots"
                mkdir -p "$dir"
                out="$dir/''${1:-screen-$(date +%H%M%S)}.png"
                adb exec-out screencap -p >"$out"
                echo "$out"
              '';

              # Prints one line per on-screen node that has a text or content-desc:
              #   <center-x> <center-y>  text="..." desc="..."
              ui-list = pkgs.writeShellScriptBin "ui-list" ''
                set -euo pipefail
                # uiautomator fails ("could not get idle state") while the UI animates.
                for attempt in 1 2 3 4 5; do
                  adb shell rm -f /sdcard/ui.xml
                  adb shell uiautomator dump /sdcard/ui.xml 2>&1 | grep -q 'dumped to' && break
                  [ "$attempt" = 5 ] && { echo "ui-list: uiautomator dump failed" >&2; exit 1; }
                  sleep 1
                done
                { adb exec-out cat /sdcard/ui.xml; echo; } | sed 's/<node /\n<node /g' | while IFS= read -r n; do
                  t=$(printf '%s' "$n" | sed -nE 's/.* text="([^"]*)".*/\1/p')
                  d=$(printf '%s' "$n" | sed -nE 's/.* content-desc="([^"]*)".*/\1/p')
                  [ -z "$t$d" ] && continue
                  read -r x1 y1 x2 y2 <<<"$(printf '%s' "$n" | sed -nE 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\1 \2 \3 \4/p')"
                  # skip off-screen / hidden nodes (e.g. a closed drawer)
                  [ "$x2" -le "$x1" ] || [ "$y2" -le "$y1" ] && continue
                  printf '%4d %4d  text="%s" desc="%s"\n' $(((x1 + x2) / 2)) $(((y1 + y2) / 2)) "$t" "$d"
                done
              '';

              # Taps the first visible node whose text or content-desc equals the
              # argument, waiting up to $TAP_TIMEOUT seconds (default 30) for it.
              tap-text = pkgs.writeShellScriptBin "tap-text" ''
                set -euo pipefail
                q="$1"
                SECONDS=0
                while :; do
                  line=$(ui-list | grep -F -e "text=\"$q\"" -e "desc=\"$q\"" | head -1 || true)
                  [ -n "$line" ] && break
                  [ "$SECONDS" -ge "''${TAP_TIMEOUT:-30}" ] && { echo "tap-text: nothing on screen labelled \"$q\" (see ui-list)" >&2; exit 1; }
                  sleep 1
                done
                read -r x y _ <<<"$line"
                adb shell input tap "$x" "$y"
                echo "tapped \"$q\" at $x,$y"
              '';
            in
            pkgs.mkShell {
              inputsFrom = [ default ];
              packages = [ sdk emu-create emu-start emu-stop screenshot ui-list tap-text ];

              ANDROID_HOME = sdkRoot;
              ANDROID_SDK_ROOT = sdkRoot;

              shellHook = ''
                export PATH="${sdkRoot}/emulator:${sdkRoot}/platform-tools:$PATH"
                echo "  adb devices   # a phone with USB debugging, or: emu-create (once), emu-start" >&2
                echo "  web-ext run -t firefox-android --adb-device <ID> --firefox-apk org.mozilla.firefox" >&2
              '';
            };
        in
        { inherit default; }
        # `nix develop .#browser`: Firefox on a virtual display, driven by
        # tools/browser.mjs, for machines with no desktop (and for agents).
        # Separate from the default shell so a desktop checkout neither
        # downloads a second Firefox nor shadows the system one.
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          browser = pkgs.mkShell {
            inputsFrom = [ default ];
            packages = [
              pkgs.firefox
              pkgs.xvfb # the display itself; outlives any one command
              pkgs.xdotool # real clicks, e.g. on the toolbar button
              pkgs.imagemagick # `import`: screenshots; `display`: a window outside Firefox to focus
              # A null sink. With no audio device Firefox fails the media
              # element, so `tab.audible` never turns true and an audible rule
              # never counts.
              pkgs.pulseaudio
            ];
            # Fontconfig's defaults live in /etc/fonts, which a bare host may not
            # have: then `sans-serif` resolves to whatever comes first (a serif)
            # and the block page's emoji render as boxes.
            FONTCONFIG_FILE = pkgs.writeText "fonts.conf" ''
              <?xml version="1.0"?>
              <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
              <fontconfig>
                <include>${pkgs.fontconfig.out}/etc/fonts/conf.d</include>
                <dir>${pkgs.dejavu_fonts}/share/fonts</dir>
                <dir>${pkgs.noto-fonts-color-emoji}/share/fonts</dir>
                <cachedir prefix="xdg">fontconfig</cachedir>
              </fontconfig>
            '';
          };
        }
        # `nix develop .#android`: adb for Firefox for Android on a phone over
        # USB, plus a headless emulator for when there is no phone at hand.
        # x86_64 Linux only: the emulator's system image is x86_64.
        // nixpkgs.lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
          inherit android;
        });
    };
}
