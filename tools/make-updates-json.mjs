#!/usr/bin/env node
// Generates the Firefox update manifest for self-distribution.
//
//   node tools/make-updates-json.mjs <signed.xpi> <download-url> [out]
//
// Everything except the download URL is derived from extension/manifest.json,
// so the id, version and minimum Firefox can never drift out of step with what
// was actually signed.
//
// Firefox fetches this file (from `update_url` in the manifest) roughly daily
// and offers anything newer than the installed version.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [, , xpiPath, downloadUrl, outPath = "public/updates.json"] = process.argv;

if (!xpiPath || !downloadUrl) {
  console.error("usage: make-updates-json.mjs <signed.xpi> <download-url> [out]");
  process.exit(1);
}

if (!downloadUrl.startsWith("https://")) {
  // Firefox will not follow a plain-HTTP update link.
  console.error(`update_link must be https, got: ${downloadUrl}`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const gecko = manifest.browser_specific_settings?.gecko;

if (!gecko?.id) {
  console.error("extension/manifest.json has no browser_specific_settings.gecko.id");
  process.exit(1);
}

const xpi = await readFile(xpiPath);
const hash = `sha256:${createHash("sha256").update(xpi).digest("hex")}`;

// Only the current version is listed. Firefox picks the highest compatible
// entry, so a full history buys nothing and would only go stale.
const updates = {
  addons: {
    [gecko.id]: {
      updates: [
        {
          version: manifest.version,
          update_link: downloadUrl,
          update_hash: hash,
          browser_specific_settings: {
            gecko: { strict_min_version: gecko.strict_min_version },
          },
        },
      ],
    },
  },
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(updates, null, 2)}\n`);

console.log(`wrote ${outPath}`);
console.log(`  addon   ${gecko.id} ${manifest.version}`);
console.log(`  link    ${downloadUrl}`);
console.log(`  hash    ${hash}`);
console.log(`  size    ${xpi.length} bytes`);
