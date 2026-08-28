// Lets you run a bare `web-ext run` / `web-ext lint` from the repo root
// without repeating --source-dir every time.
export default {
  sourceDir: "./extension",

  run: {
    // Land straight on the page where the extension's console lives.
    startUrl: ["about:debugging#/runtime/this-firefox"],
    // Keep the dev profile between runs so storage.local survives restarts
    // (needed for Checkpoint 4).
    keepProfileChanges: true,
    profileCreateIfMissing: true,
    firefoxProfile: "./.web-ext-profile",
  },

  build: {
    overwriteDest: true,
  },

  lint: {
    // `update_url` is forbidden for AMO-LISTED add-ons and required for
    // self-hosted ones. The linter assumes listed unless told otherwise, so
    // without this the manifest fails with MANIFEST_UPDATE_URL.
    selfHosted: true,
  },

  sign: {
    // Self-distribution: Mozilla signs it and hands back an .xpi, but it never
    // appears in AMO search and needs no listing metadata. Review is automated.
    // Credentials come from WEB_EXT_API_KEY / WEB_EXT_API_SECRET — never put
    // them in this file, it is committed.
    channel: "unlisted",
  },
};
