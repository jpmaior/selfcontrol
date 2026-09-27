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
              # pkgs.android-tools  # uncomment for Firefox for Android (adb)
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
              pkgs.imagemagick # `import`: screenshots of the whole window
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
        });
    };
}
