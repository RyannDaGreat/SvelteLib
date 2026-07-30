/**
 * Command. Bakes the PowerRP app dir's ABSOLUTE path into dist-resources/
 * repo-path.txt for the v1 packaged build (main.js reads it from Resources).
 * This is the deliberate v1 non-shippable seam: the .app built here launches
 * THIS machine's dump in place. The v2 CI build replaces this file with a repo
 * vendored inside Resources. Run by `npm run package` before electron-builder.
 */
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const appDir = path.resolve(__dirname, "..");
mkdirSync(path.join(__dirname, "dist-resources"), { recursive: true });
writeFileSync(path.join(__dirname, "dist-resources", "repo-path.txt"), appDir + "\n");
console.log(`baked repo path: ${appDir}`);
