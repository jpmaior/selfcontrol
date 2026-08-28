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
};
