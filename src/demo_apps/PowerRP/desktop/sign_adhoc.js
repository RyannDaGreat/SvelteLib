/**
 * electron-builder afterPack hook, two jobs in the load-bearing order:
 *
 * 1. BUNDLE COMPLETENESS ASSERTIONS — the v0.2.0 lesson: the CI-vendored repo
 *    was missing the gitignored root package-lock.json, so every shipped
 *    app's FIRST RUN died in `npm ci` — a breakage invisible on the dev
 *    machine (whose disk had the file) and invisible to CI (which never ran
 *    the app). The packaging itself now refuses to produce a bundle whose
 *    vendored repo lacks the files first-run setup depends on. Extend
 *    REQUIRED_REPO_FILES when setup grows a new dependency.
 * 2. AD-HOC SIGN + STRICT VERIFY — before the dmg is built from the .app
 *    (a post-build sign step signed only the dir copy and shipped a
 *    broken-seal app inside the dmg: the "will damage your computer" dialog).
 */
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

/** Everything the shipped first-run setup reads from the vendored repo. */
const REQUIRED_REPO_FILES = [
  "package.json",
  "package-lock.json", // npm ci dies without it (v0.2.0's boot failure)
  "src/demo_apps/PowerRP/run_server.sh",
  "src/demo_apps/PowerRP/server/start_server.sh",
  "src/demo_apps/PowerRP/server/server.py",
  "src/demo_apps/PowerRP/projects/Imitations/doc.json", // the seeded demo
];

exports.default = async function verifyAndSign(context) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const repo = path.join(app, "Contents/Resources/repo");
  // A dev build (repo-path.txt only, no vendored repo) legitimately skips the
  // completeness check; a SHIPPED build must pass every line of it.
  if (existsSync(repo)) {
    const missing = REQUIRED_REPO_FILES.filter((f) => !existsSync(path.join(repo, f)));
    if (missing.length)
      throw new Error(`vendored repo is INCOMPLETE — first run would fail on a user machine. Missing: ${missing.join(", ")}`);
    console.log(`afterPack: vendored repo complete (${REQUIRED_REPO_FILES.length} required files present)`);
  }
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`afterPack: ad-hoc signed + verified ${app}`);
};
