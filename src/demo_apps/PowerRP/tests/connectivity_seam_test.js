/**
 * connectivity_seam_test.js — THE ONE CONNECTIVITY SEAM, enforced by grep.
 *
 * `web/connectivity.js` is the single module allowed to read `navigator.onLine`.
 * The reason is written out in that file's docblock and is worth restating,
 * because it is exactly the kind of subtlety a well-meaning call site gets
 * wrong: `navigator.onLine === false` is trustworthy, but `=== true` is nearly
 * meaningless — a captive portal, a dead uplink or a dropped VPN all report
 * `true` while every request fails. A call site that writes
 * `if (navigator.onLine) …` therefore ships a CONFIDENT LIE, and it does so in a
 * code path that looks obviously correct on review.
 *
 * So the rule is structural rather than advisory: the property is read ONCE, in
 * a module whose whole job is to qualify it, and this test fails the bare-node
 * gate if a second reader appears.
 *
 * PRECEDENT: the native `title=` guard test — same shape (a grep over the source
 * tree for one forbidden token, with a single documented exemption), same reason
 * (a rule that a reviewer cannot be expected to remember must be mechanical).
 *
 * Run:  node tests/connectivity_seam_test.js
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isOnline,
  offlineMessage,
  offlineRequirement,
  onConnectivityChange,
  __setOnlineForTest,
} from "../web/connectivity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");

/** The ONE file permitted to read the property — the seam itself. */
const SEAM = "web/connectivity.js";

/** THIS FILE is exempt too, and for a reason worth stating rather than
 *  hand-waving: a guard test cannot express the token it forbids without
 *  containing it — the pattern, the failure message and the PASS line all
 *  necessarily spell it out. Exempting the guard is not a hole in the guard;
 *  the guard has no call sites to protect. (Same exemption shape as the native
 *  `title=` guard test, for the same unavoidable reason.) */
const GUARD = "tests/connectivity_seam_test.js";

/** Directories excluded from the sweep: build outputs and vendored code are not
 *  ours to hold to this rule, and `dist` in particular contains the minified
 *  bundle where the seam's OWN read reappears. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__pycache__"]);

/** Source extensions the rule applies to. */
const EXTS = [".js", ".mjs", ".svelte", ".html"];

/**
 * Query. Every source file under `dir`, recursively, skipping SKIP_DIRS.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 *
 * @example // sourceFiles(APP).length // ~400 — every .js/.mjs/.svelte/.html in the app
 */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (EXTS.some((e) => name.endsWith(e))) out.push(path);
  }
  return out;
}

const failures = [];

// ── 1. THE GREP GUARD ────────────────────────────────────────────────────────
// A raw read of navigator.onLine outside the seam. The pattern tolerates
// whitespace around the dot because that is still a read.
const RAW_READ = /navigator\s*\.\s*onLine/;
let scanned = 0;
for (const path of sourceFiles(APP)) {
  const rel = relative(APP, path);
  if (rel === SEAM || rel === GUARD) continue;
  scanned++;
  const text = readFileSync(path, "utf8");
  text.split("\n").forEach((line, i) => {
    if (!RAW_READ.test(line)) return;
    // A PROSE mention is fine and in fact desirable — the manifest and several
    // docblocks explain the rule. Only CODE is a violation, so a line that is
    // entirely a comment does not count.
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("<!--")) return;
    failures.push(
      `${rel}:${i + 1} reads navigator.onLine directly.\n` +
        `    Import from web/connectivity.js instead — isOnline() / reportFailure().\n` +
        `    ${trimmed}`,
    );
  });
}
if (scanned < 50) failures.push(`the sweep only scanned ${scanned} files — it is not looking where it should`);

// ── 2. THE SEAM'S OWN CONTRACT ───────────────────────────────────────────────
// A grep guard that pointed at a broken module would be worse than none, so the
// behaviour it redirects everyone to is pinned here too.

const seen = [];
const stop = onConnectivityChange((up) => seen.push(up));

__setOnlineForTest(false);
if (isOnline() !== false) failures.push("isOnline() did not report the forced offline state");
if (seen.length !== 1 || seen[0] !== false) failures.push(`offline transition notified ${JSON.stringify(seen)}, want [false]`);

// A REPEAT of the same value must not notify: subscribers re-render on it.
__setOnlineForTest(false);
if (seen.length !== 1) failures.push(`a no-op transition notified anyway: ${JSON.stringify(seen)}`);

__setOnlineForTest(true);
if (isOnline() !== true) failures.push("isOnline() did not report the restored online state");
if (seen.length !== 2 || seen[1] !== true) failures.push(`online transition notified ${JSON.stringify(seen)}, want [false, true]`);

// Unsubscribe must be exact.
stop();
__setOnlineForTest(false);
if (seen.length !== 2) failures.push(`unsubscribed listener still fired: ${JSON.stringify(seen)}`);
__setOnlineForTest(true);

// ── 3. THE ONE VOICE ─────────────────────────────────────────────────────────
// Every offline notice in the app comes from these two helpers, so the app
// cannot grow two phrasings for one condition.
const msg = offlineMessage("Icon search");
if (msg !== "Offline — icon search needs the internet") failures.push(`offlineMessage("Icon search") === ${JSON.stringify(msg)}`);
const gh = offlineMessage("Saving to GitHub");
if (gh !== "Offline — saving to GitHub needs the internet") failures.push(`offlineMessage("Saving to GitHub") === ${JSON.stringify(gh)}`);
if (offlineRequirement() !== "an internet connection") failures.push(`offlineRequirement() === ${JSON.stringify(offlineRequirement())}`);
let threw = false;
try {
  offlineMessage("");
} catch {
  threw = true; // expected: an unnamed capability is a bug, not a blank sentence
}
if (!threw) failures.push("offlineMessage('') should throw rather than emit a headless sentence");

if (failures.length) {
  console.error(`\nFAIL connectivity_seam_test (${failures.length}):\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`PASS connectivity_seam_test — navigator.onLine read in ${SEAM} only (${scanned} files swept), seam contract + one-voice messages hold.`);
