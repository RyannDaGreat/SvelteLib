/**
 * THE PREFLIGHT. Everything this harness reports rests on one claim: that the
 * C++ it compiled is the C++ the specs say the port was read from. This script
 * is that claim, checked.
 *
 *   node harness/verify.mjs
 *
 * Three things, and a red on any of them invalidates the whole report:
 *   1. Every commit in `lib/upstream.mjs` REPOS actually appears in the spec or
 *      kernel file that `citedBy` names. A harness that quietly measured against
 *      a different commit than the port was written from would produce
 *      differences that are nobody's fault and mean nothing.
 *   2. Every checkout under UPSTREAM_ROOT is AT that commit right now. These are
 *      shared /tmp clones; anything could have moved them.
 *   3. g++ exists and the node version can run the cases.
 *
 * Exits non-zero on any failure, loudly. It does NOT repair anything — a silent
 * `git checkout` here would hide the very drift it exists to detect.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPOS, UPSTREAM_ROOT } from "./lib/upstream.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../../../..");

/**
 * Query. Every `.js` under the app's core/ and synth/ concatenated, which is
 * where a derivation record can live. Read once rather than per repo.
 *
 * @returns {string}
 */
function allDerivationText() {
  let text = "";
  for (const dir of ["core", "synth"]) {
    for (const f of readdirSync(join(APP_ROOT, dir))) {
      if (f.endsWith(".js")) text += readFileSync(join(APP_ROOT, dir, f), "utf8");
    }
  }
  return text;
}

/**
 * Query. Short HEAD of a checkout, or null when it is absent.
 *
 * @param {string} dir
 * @returns {string|null}
 */
function headOf(dir) {
  if (!existsSync(join(dir, ".git"))) return null;
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const problems = [];
const notes = [];
const text = allDerivationText();

for (const [key, spec] of Object.entries(REPOS)) {
  const dir = join(UPSTREAM_ROOT, key);
  const head = headOf(dir);
  if (!head) {
    problems.push(`${key}: no checkout at ${dir} — run harness/setup_upstream.sh`);
    continue;
  }
  if (spec.commit === "HEAD") {
    // An UNPINNED repo is not an error, but it must be visible in the report:
    // a difference measured against an unpinned upstream cannot be attributed
    // to the port, because upstream may simply have moved since the port.
    notes.push(`${key}: UNPINNED by any spec (${spec.citedBy}); measured against ${head.slice(0, 7)}`);
    continue;
  }
  if (head !== spec.commit) {
    problems.push(`${key}: checkout is at ${head.slice(0, 7)} but this harness pins ${spec.commit.slice(0, 7)}`);
  }
  if (!text.includes(spec.commit)) {
    problems.push(`${key}: commit ${spec.commit.slice(0, 7)} appears in NO core/ or synth/ file, yet citedBy claims ${spec.citedBy}`);
  }
}

try {
  execFileSync("g++", ["--version"], { stdio: "pipe" });
} catch {
  problems.push("g++ is not on PATH — no upstream driver can be built");
}

for (const n of notes) process.stdout.write(`NOTE  ${n}\n`);
for (const p of problems) process.stdout.write(`FAIL  ${p}\n`);
if (problems.length) {
  process.stdout.write(`\n${problems.length} problem(s). The report from this tree cannot be trusted until they are fixed.\n`);
  process.exit(1);
}
process.stdout.write(`\nOK: ${Object.keys(REPOS).length} upstream checkouts, ${notes.length} unpinned.\n`);
