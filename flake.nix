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
      devShells = forAllSystems (pkgs: {
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
      });
    };
}
