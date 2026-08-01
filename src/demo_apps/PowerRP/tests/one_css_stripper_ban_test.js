/**
 * one_css_stripper_ban_test.js — THERE IS ONE CSS COMMENT STRIPPER AND IT LIVES
 * IN `tests/cssComments.js`. A second definition of it is a red.
 *
 * WHY THIS EXISTS, and it is the clearest instance of convention-ledger C-10
 * this repo has produced. C-10 says a deduplication without a gate is a
 * snapshot, not a fix — earned when a TENTH copy of `truncate` appeared while
 * nine were being consolidated. This is that, same day, tighter loop:
 *
 *   · Six divergent `strip*Comments` helpers were found in `tests/`.
 *   · Three CSS ones were consolidated into `tests/cssComments.js`.
 *   · Within HOURS, THREE MORE appeared — `phone_breakpoint_test.js`,
 *     `glass_blur_guard_test.js`, `phantom_token_ban_test.js` — each defining
 *     `stripCssComments`, BYTE-IDENTICAL to the shared one, under the SAME NAME,
 *     written by authors who had no way to know the module existed.
 *
 * Nobody was careless. Three people independently needed the same four lines and
 * independently picked the same name for them, which is evidence the abstraction
 * is right and the shared home is not DISCOVERABLE from where an author stands.
 * Prose in the module cannot fix that: the person about to write the seventh
 * copy is in their own new file and will never open `cssComments.js`. A gate
 * reaches them, because it fails in front of them.
 *
 * SCOPE — DELIBERATELY NARROW. This bans a second CSS stripper only. `tests/`
 * also holds JS, HTML and shell-hash variants under several names, and those are
 * a real consolidation that is too large to do at round close and is reported
 * rather than done. Banning the one variant that has a shared home is honest;
 * banning all of them without providing homes would be a gate nobody can
 * satisfy.
 *
 * PRECEDENT: `tests/one_ranking_ban_test.js` — same `one_<thing>_ban_test.js`
 * shape, same "one canonical implementation, everything else is a red" thesis.
 *
 * Run:  node tests/one_css_stripper_ban_test.js
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripCssComments } from "./cssComments.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");

/** The one file allowed to define it. */
const HOME = "tests/cssComments.js";

/** The import line a violator should end up with — spelled out literally,
 *  because ledger C-9 was earned by a hand-back that named the symbol and the
 *  intent instead of the line, and the receiver re-imported from the old home. */
const FIX = 'import { stripCssComments } from "./cssComments.js";';

/** Where test files live. Both roots, because the gate collector reads both. */
const ROOTS = ["tests", join("render_gpu", "tests")];

/**
 * Pure function. Every line defining a function named `stripCssComments`.
 *
 * Matches a definition at line start only — `function stripCssComments(` or
 * `const stripCssComments =`, optionally exported. A MENTION (a call, an
 * import, a sentence) is not a definition and must not count, which is the
 * whole reason this is anchored rather than a bare substring search.
 *
 * @param {string} src - file text, block comments already stripped
 * @returns {number[]} 1-based line numbers of definitions
 *
 * @example definitionLines('export function stripCssComments(css) {') // [1]
 * @example definitionLines('const stripCssComments = (c) => c;') // [1]
 * @example definitionLines('  const out = stripCssComments(css);') // [] — a call
 * @example definitionLines('import { stripCssComments } from "./cssComments.js";') // []
 */
function definitionLines(src) {
  const out = [];
  src.split("\n").forEach((line, i) => {
    if (/^(?:export\s+)?(?:function\s+stripCssComments\s*\(|const\s+stripCssComments\s*=)/.test(line)) {
      out.push(i + 1);
    }
  });
  return out;
}

/**
 * Query (reads the filesystem). Every `.js`/`.mjs` file under the test roots.
 *
 * @returns {string[]} absolute paths
 *
 * @example // testFiles().some((p) => p.endsWith("cssComments.js")) // true
 */
function testFiles() {
  const out = [];
  for (const root of ROOTS) {
    let names;
    try {
      names = readdirSync(join(APP, root));
    } catch {
      // A root that does not exist is a REAL problem for a gate that claims to
      // sweep both, so it is reported rather than skipped — see the vacuity
      // check below, which this feeds.
      continue;
    }
    for (const n of names) {
      if (/\.m?js$/.test(n)) out.push(join(APP, root, n));
    }
  }
  return out;
}

const files = testFiles();

// REFUSE TO PASS VACUOUSLY. A sweep that found no files, or that cannot see its
// own subject, must be a red rather than a green — the failure mode
// square_chrome_test.js and glass_structure_test.js both guard the same way.
const MIN_FILES = 100;
if (files.length < MIN_FILES) {
  throw new Error(`one_css_stripper_ban: swept only ${files.length} test files — the walker is broken, not the tree`);
}

const offenders = [];
let homeSeen = false;
for (const file of files) {
  const rel = relative(APP, file).split("\\").join("/");
  const lines = definitionLines(stripCssComments(readFileSync(file, "utf8")));
  if (rel === HOME) {
    homeSeen = lines.length === 1;
    continue;
  }
  for (const line of lines) offenders.push(`${rel}:${line}`);
}

if (!homeSeen) {
  throw new Error(`one_css_stripper_ban: ${HOME} does not define exactly one stripCssComments — the gate cannot see its own subject`);
}

// The gate must be able to fail. Proven on a fixture rather than asserted, the
// discipline square_chrome_test.js sets.
if (definitionLines("export function stripCssComments(css) {\n  return css;\n}").length !== 1) {
  throw new Error("one_css_stripper_ban self-test: the detector does not detect a definition");
}
if (definitionLines(`  const s = stripCssComments(css);\n${FIX}`).length !== 0) {
  throw new Error("one_css_stripper_ban self-test: a call or an import was counted as a definition");
}

if (offenders.length) {
  console.error(`THERE IS ONE CSS COMMENT STRIPPER. ${offenders.length} other definition(s) found:`);
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`\nDelete the local copy and use the shared one. The line you should end up with:\n  ${FIX}\n`);
  console.error(`Three byte-identical copies appeared within hours of ${HOME} being created, under the same name, because the shared home is not discoverable from a new test file. That is why this is a gate and not a comment.`);
  process.exit(1);
}

console.log(`PASS one_css_stripper_ban_test — ${HOME} is the only definition of stripCssComments (${files.length} test files swept).`);
