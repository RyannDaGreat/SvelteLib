/**
 * electron-builder afterPack hook: AD-HOC sign the packed .app and STRICTLY
 * verify the seal — BEFORE the dmg is built from it (a post-build sign step
 * signed only the dir copy and shipped a broken-seal app inside the dmg,
 * which macOS greets with the "will damage your computer" malware dialog).
 * Ad-hoc keeps the seal VALID on machines without a Developer ID; real
 * signing/notarization replaces this hook via CI secrets later.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function signAdhoc(context) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`afterPack: ad-hoc signed + verified ${app}`);
};
