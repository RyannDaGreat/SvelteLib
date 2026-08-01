/**
 * THE FIXTURE PRECONDITION — for suites whose fixture is USER DATA, not source.
 *
 * WHAT WENT WRONG WITHOUT IT. `projects/*` is gitignored (see the app's
 * .gitignore, which states the reason: a project is a folder of user data, not
 * source). Three suites nonetheless read straight out of
 * `projects/Imitations/assets/`, a directory NO clone has ever contained — no
 * commit in this repository's history ever added a file under `projects/` except
 * `.gitkeep`. So the canonical gate could not pass on a fresh clone, and it did
 * not pass on the author's own machine either: the Imitations project is gone
 * from this working copy, and the three suites die with ENOENT before running a
 * single assertion. At least four agents independently spent time working out
 * that those reds were pre-existing rather than theirs.
 *
 * That is a dump-portability violation (CLAUDE.md's WOM rule: "code that only
 * works on the developer's machine due to undocumented dependencies"), and it is
 * the expensive kind, because the failure is indistinguishable from a regression.
 *
 * WHY A SKIP AND NOT A SILENT PASS OR A FAIL. Exactly `backend_precondition.js`'s
 * argument, which is exactly `github_live_probe.js`'s before it: a silent skip is
 * indistinguishable from a pass, which is how a suite stops being believed; a
 * failure would make an absent dependency look like a defect. So the suite exits
 * 0 and PRINTS why, in the house SKIP voice — `SKIP — <reason>` — which
 * `run_all.mjs` recognises and COUNTS in its own column, so a skipped suite is
 * never quietly folded into the pass total.
 *
 * WHY THE REGISTRY IS HERE AND NOT IN EACH SUITE. `gitignored_fixture_test.js`
 * fails when any test file names a gitignored path that is NOT declared below.
 * One list, two consumers: the skip helper and the gate. A suite that grows a new
 * dependency on user data therefore cannot do it quietly — it must come here and
 * write down the reason, which is the whole point.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The PowerRP app root — the base every path below is relative to. */
export const APP_ROOT = resolve(HERE, "..");

/**
 * THE DECLARED OPTIONAL FIXTURES: app-relative path → why it is not in the repo.
 *
 * Every entry is a path under a gitignored directory. Adding one is a decision
 * that must be justified here, in prose, because `gitignored_fixture_test.js`
 * reads this object and refuses any undeclared gitignored path in any test.
 *
 * ENTRIES MAY BE FILES OR DIRECTORIES; a path is covered if it equals an entry
 * or is inside one.
 */
export const OPTIONAL_FIXTURES = {
  "projects/Imitations/assets":
    "The 'Imitations' project is USER DATA under the gitignored projects/ tree. Its plugin " +
    "assets (histogram.plugin.js and its siblings) were never committed — `git log -S` finds " +
    "the SUITES that read them but no commit that ever added one, and the directory is absent " +
    "from this working copy too. The coverage is real where the project exists; it cannot be " +
    "a precondition of the gate. Re-author these assets under assets/builtin/library/ (which " +
    "IS committed) to make that coverage portable.",
};

/**
 * Pure function. Is `relPath` covered by a declared optional fixture — equal to
 * a registry entry, or inside one?
 *
 * Compared on `/`-delimited segments so a sibling directory with a shared name
 * prefix is not swallowed: `projects/ImitationsOld` is NOT inside
 * `projects/Imitations`.
 *
 * @param {string} relPath App-relative path, `/`-separated
 * @param {Record<string, string>} registry OPTIONAL_FIXTURES, or a test double
 * @returns {boolean}
 *
 * @example isDeclaredOptional("projects/Imitations/assets/histogram.plugin.js", OPTIONAL_FIXTURES)
 * // true — inside the declared directory
 * @example isDeclaredOptional("projects/Imitations/assets", OPTIONAL_FIXTURES)
 * // true — equal to the entry itself
 * @example isDeclaredOptional("projects/Alpha/doc.json", OPTIONAL_FIXTURES)
 * // false — a different project, undeclared
 */
export function isDeclaredOptional(relPath, registry) {
  return Object.keys(registry).some((entry) => relPath === entry || relPath.startsWith(`${entry}/`));
}

/**
 * Query (touches the filesystem). Does the declared optional fixture at
 * app-relative `relPath` exist in this working copy?
 *
 * Throws on an UNDECLARED path rather than answering, so a caller cannot use
 * this helper to depend on user data without registering it above.
 *
 * @param {string} relPath App-relative path, `/`-separated
 * @returns {boolean}
 *
 * @example optionalFixturePresent("projects/Imitations/assets")
 * // false — on any clone, and on the author's machine too
 */
export function optionalFixturePresent(relPath) {
  if (!isDeclaredOptional(relPath, OPTIONAL_FIXTURES))
    throw new Error(
      `fixture_precondition: ${relPath} is not a declared optional fixture. ` +
        "Add it to OPTIONAL_FIXTURES with the reason it is not in the repo, or point the suite at a committed path.");
  return existsSync(resolve(APP_ROOT, relPath));
}

/**
 * Command. Exit 0 with a printed reason unless the declared optional fixture at
 * `relPath` is present. Returns normally when it is, so the suite proceeds
 * unchanged on a machine that has it.
 *
 * The two printed lines are `github_live_probe.js`'s contract verbatim — one
 * `SKIP — <reason>` line that `run_all.mjs` parses, then the human explanation.
 *
 * @param {string} suiteName Suite basename, for the printed line
 * @param {string} relPath App-relative path of the declared optional fixture
 * @returns {void} Returns if present; otherwise exits the process with code 0
 *
 * @example requireFixtureOrSkip("histogram_plugin_test", "projects/Imitations/assets")
 * // present -> returns, suite runs
 * // absent  -> prints "SKIP — histogram_plugin_test needs …" and exits 0
 */
export function requireFixtureOrSkip(suiteName, relPath) {
  if (optionalFixturePresent(relPath)) return;
  console.log(`SKIP — ${suiteName} needs ${relPath}, which is USER DATA under a gitignored path and is absent here. Not a failure.`);
  console.log(`SKIPPED: ${OPTIONAL_FIXTURES[declaringEntry(relPath)]}`);
  process.exit(0);
}

/**
 * Pure function. The registry KEY that covers `relPath` — the entry whose reason
 * explains this absence.
 *
 * @param {string} relPath App-relative path, `/`-separated
 * @returns {string|undefined}
 *
 * @example declaringEntry("projects/Imitations/assets/histogram.plugin.js")
 * // "projects/Imitations/assets"
 */
export function declaringEntry(relPath) {
  return Object.keys(OPTIONAL_FIXTURES).find((entry) => relPath === entry || relPath.startsWith(`${entry}/`));
}
