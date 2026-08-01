/**
 * NO SUITE MAY DEPEND ON A GITIGNORED PATH — the portability rule, as a grep.
 * Run: node src/demo_apps/PowerRP/tests/gitignored_fixture_test.js
 * Inventory (every gitignored path literal the scanner sees, allowed or not):
 *     node src/demo_apps/PowerRP/tests/gitignored_fixture_test.js --inventory
 *
 * WHY THIS EXISTS. Three suites — histogram_plugin_test, plugin_asset_doctest_test
 * and relative_ref_cli_test — read out of `projects/Imitations/assets/`. `projects/`
 * is gitignored, on purpose (the app's .gitignore says why: a project is a folder of
 * USER DATA, not source), and `git ls-files projects/` returns `.gitkeep` and nothing
 * else. So the canonical gate could not pass on a fresh clone. It did not pass here
 * either: that project is gone from this working copy, and all three suites died
 * with a bare ENOENT stack — which reads exactly like a regression, and which at
 * least four agents independently spent time proving was not theirs.
 *
 * That is CLAUDE.md's WOM defect ("code that only works on the developer's machine
 * due to undocumented dependencies"), and the reason it survived so long is that
 * NOTHING SAID IT OUT LOUD. The dependency was a string in a list.
 *
 * WHAT COUNTS AS A VIOLATION: a path-shaped string literal in a test source that
 * resolves — against the app root or against the file's own directory — to a path
 * git ignores. Two categories are allowed, and each entry states its reason:
 *
 *   WRITE_ROOTS      where a suite puts its OWN output. Screenshots and logs are
 *                    artifacts; they are gitignored BECAUSE they are artifacts, and
 *                    CLAUDE.md requires exactly that. Writing there is the rule
 *                    being followed, not broken. (tests/probe_artifact_path_test.js
 *                    is the guard for WHICH artifact path is correct; this one only
 *                    needs to know that artifacts are not fixtures.)
 *   OPTIONAL_FIXTURES  declared user-data dependencies, imported from
 *                    tests/fixture_precondition.js so there is ONE list rather than
 *                    a copy here. A suite that grows such a dependency must go and
 *                    write down WHY, and must skip loudly when it is absent.
 *
 * WHAT IT DOES NOT PROVE, said plainly because a narrow honest guard beats a broad
 * dishonest one (probe_artifact_path_test.js's own disclaimer, same reasoning) —
 * and MEASURED, not guessed: run against HEAD before the fix, this gate flagged
 * two of the three offending suites, not three.
 *
 *   (1) A PATH SPLIT ACROSS ARGUMENTS IS INVISIBLE. relative_ref_cli_test.js wrote
 *       `svgDoc("Imitations", "icons/database.svg")` — a project name and an asset
 *       path, joined nowhere in the source. Neither literal is a gitignored path by
 *       itself. Catching that means statically evaluating path arithmetic through
 *       variables and calls, and a guard that pretended to do so would be worse
 *       than this one. (That suite now builds its own fixture, so the shape is
 *       gone from the tree; it is recorded here because the gate must not be
 *       believed to cover it.)
 *   (2) It does not distinguish a READ from a WRITE inside an artifact directory,
 *       so a suite that read back a leftover artifact from a previous run passes.
 *
 * PRECEDENT: tests/square_chrome_test.js — one forbidden shape, named exemptions, a
 * self-check section proving the gate can fail, and a non-vacuity floor.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { OPTIONAL_FIXTURES, isDeclaredOptional } from "./fixture_precondition.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const REPO = resolve(APP, "../../..");
const inventory = process.argv.includes("--inventory");

/** The two test directories the gate itself collects from — run_all.mjs's pair. */
const TEST_DIRS = ["tests", "render_gpu/tests"];

/**
 * ARTIFACT DIRECTORY NAMES — where a suite may legitimately WRITE. Every one is
 * gitignored because it holds artifacts, which is CLAUDE.md's instruction, not a
 * violation of it. A path under one of these is not a fixture and is never a
 * portability dependency: an absent artifact directory is created, never missed.
 *
 * MATCHED AS A PATH SEGMENT, ANYWHERE, not as a prefix of an app-relative path.
 * A probe writes `resolve(HERE, "../.claude_vlm_checks")` and a sweep names
 * `.claude_vlm_checks/foo` off the app root; both mean the same artifact tree,
 * and this gate has no business deciding which spelling is correct — WHICH
 * artifact path a probe should use is tests/probe_artifact_path_test.js's job,
 * and it already fails on the wrong one.
 */
const ARTIFACT_DIRS = {
  ".claude_vlm_checks": "VLM check frames — CLAUDE.md: 'disposable and should be in .gitignore'",
  ".claude_logs": "CLAUDE.md: 'Any .log files must be created in .claude_logs/*.log'",
  ".claude_shots": "screenshot scratch; the repo .gitignore names it a stray probe-artifact dir",
  ".frenzy": "CLAUDE.md: 'ALL frenzy outputs go in .frenzy/ for easy cleanup'",
};

/**
 * Gitignored trees a sweep names in order to SKIP them. The literal is an
 * EXCLUSION, so the suite depends on the tree's absence, not its presence — the
 * opposite of the defect this gate is about. Matched as a segment SEQUENCE.
 */
const SWEEP_EXCLUSIONS = {
  "web/dist": "Vite build output; three sweeps list it as a SKIP_PREFIX so they do not scan bundled third-party code",
  "node_modules": "installed dependencies; excluded from every source sweep",
};

/**
 * Pure function. Blanks JS comments, PRESERVING LINE COUNT and column count, so a
 * path merely NAMED in prose is not read as a dependency.
 *
 * The line-count guarantee is the load-bearing part. A stripper written as
 * `replace(/^\s*\/\/.*$/gm, "")` eats the blank line above a comment, because
 * `\s` matches `\n` — after which every reported line number is wrong, which
 * costs a reader more than the finding saves.
 *
 * @param {string} src JavaScript source
 * @returns {string} the same text, comment bodies blanked
 *
 * @example stripJsComments('const a = "x"; // "projects/P/f"').includes("projects")
 * // false — the commented path is gone
 * @example stripJsComments("a\n/* p *\/\nb").split("\n").length
 * // 3 — line numbers survive
 */
export function stripJsComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks.split("\n").map((line) => {
    const at = line.indexOf("//");
    return at < 0 ? line : line.slice(0, at) + " ".repeat(line.length - at);
  }).join("\n");
}

/**
 * Pure function. The same, for `#`-comment languages (Python, shell).
 *
 * @param {string} src
 * @returns {string}
 *
 * @example stripHashComments('x = 1  # projects/P/f').includes("projects")
 * // false
 * @example stripHashComments("a\n# p\nb").split("\n").length
 * // 3
 */
export function stripHashComments(src) {
  return src.split("\n").map((line) => {
    const at = line.indexOf("#");
    return at < 0 ? line : line.slice(0, at) + " ".repeat(line.length - at);
  }).join("\n");
}

/**
 * Pure function. Path-shaped string literals on one line of comment-free source.
 *
 * "Path-shaped" is deliberately narrow: it must contain a `/`, start with a word
 * character or a dot, and contain nothing but the characters a checked-in path
 * uses. That excludes URLs (`https://…`), the app's own route prefixes
 * (`/asset/<Project>/<file>` is a URL the backend serves, not a disk path), glob
 * patterns, template placeholders and percent-encodings — every one of which
 * would otherwise resolve to a nonsense path and be reported.
 *
 * @param {string} line one line of source, comments already blanked
 * @returns {string[]} the literals, in order
 *
 * @example pathLiterals('readFileSync(resolve(here, "../projects/P/f.js"))')
 * // ["../projects/P/f.js"]
 * @example pathLiterals('await fetch("https://api.github.com/x")')
 * // [] — a URL is not a disk path
 * @example pathLiterals('const url = "/asset/Imitations/icons/database.svg";')
 * // [] — a backend route, not a disk path
 */
export function pathLiterals(line) {
  const out = [];
  for (const m of line.matchAll(/["'`]([^"'`\n]{2,160})["'`]/g)) {
    const lit = m[1];
    if (!lit.includes("/")) continue;
    if (/:\/\/|\*|\$\{|%|\\/.test(lit)) continue;
    if (/^\/(asset|api|render)\//.test(lit)) continue;
    if (!/^[.\w][\w./ @+-]*$/.test(lit)) continue;
    out.push(lit);
  }
  return out;
}

/**
 * Pure function. Does `rel` contain any of `names` as a run of whole path
 * SEGMENTS?
 *
 * Whole segments, so a sibling with a shared character prefix is not swallowed:
 * `.claude_logsX/a` does not contain `.claude_logs`. Anywhere in the path, so the
 * two spellings of the same artifact tree (`.claude_vlm_checks/x` off the app
 * root and `../.claude_vlm_checks/x` off a test file) both match.
 *
 * @param {string} rel a `/`-separated path
 * @param {Record<string, string>} names keys are segment runs, e.g. "web/dist"
 * @returns {boolean}
 *
 * @example hasSegmentRun(".claude_vlm_checks/glass/a.png", ARTIFACT_DIRS)
 * // true
 * @example hasSegmentRun("../.claude_vlm_checks/glass", ARTIFACT_DIRS)
 * // true — the same tree, spelled from a test file's own directory
 * @example hasSegmentRun(".claude_vlm_checksX/a.png", ARTIFACT_DIRS)
 * // false — a same-prefix sibling is a different directory
 * @example hasSegmentRun("projects/Imitations/assets", ARTIFACT_DIRS)
 * // false
 */
export function hasSegmentRun(rel, names) {
  const segs = rel.split("/");
  return Object.keys(names).some((n) => {
    const want = n.split("/");
    return segs.some((_, i) => want.every((w, k) => segs[i + k] === w));
  });
}

/** Query. Every test source the gate sweeps, as absolute paths. */
function testSources() {
  const out = [];
  for (const d of TEST_DIRS) {
    const dir = resolve(APP, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if ([".js", ".mjs", ".py", ".sh"].includes(extname(f))) out.push(resolve(dir, f));
    }
  }
  return out.sort();
}

/**
 * Query (shells out to git). Which of `repoRelPaths` git ignores. ONE batch call
 * — `check-ignore` per literal is ~1200 processes and turns a 1-second gate into
 * a minute. `--no-index` so a path that does not exist on disk is still judged by
 * the ignore rules, which is exactly the case that matters here.
 *
 * @param {string[]} repoRelPaths
 * @returns {Set<string>}
 */
function ignoredAmong(repoRelPaths) {
  if (!repoRelPaths.length) return new Set();
  const opts = { cwd: REPO, input: repoRelPaths.join("\n"), encoding: "utf8" };
  // git check-ignore exits 1 when NOTHING matches — a normal answer, not a
  // failure, and the only exit code that may be swallowed. Any other status is
  // a real git problem and is re-thrown.
  try {
    return new Set(execFileSync("git", ["check-ignore", "--no-index", "--stdin"], opts).split("\n").filter(Boolean));
  } catch (e) {
    if (e.status === 1) return new Set();
    throw e;
  }
}

/**
 * Query (reads the filesystem, resolves paths). Every gitignored path literal in
 * the swept sources, as {where, lit, rel} — `rel` app-relative.
 *
 * A literal is tried against BOTH bases a test can mean: the app root (how a
 * sweep names a directory) and the file's own directory (how `resolve(HERE, …)`
 * reads). A hit under either base counts, because either could be the real one.
 *
 * @param {string[]} sources absolute paths
 * @returns {Array<{where: string, lit: string, rel: string}>}
 */
function gitignoredLiterals(sources) {
  const seen = [];
  for (const abs of sources) {
    const strip = [".js", ".mjs"].includes(extname(abs)) ? stripJsComments : stripHashComments;
    strip(readFileSync(abs, "utf8")).split("\n").forEach((line, i) => {
      for (const lit of pathLiterals(line)) {
        for (const base of [APP, dirname(abs)]) {
          const p = resolve(base, lit);
          if (!p.startsWith(`${REPO}/`)) continue;
          seen.push({ where: `${relative(APP, abs)}:${i + 1}`, lit, rel: relative(APP, p), repoRel: relative(REPO, p) });
        }
      }
    });
  }
  const ignored = ignoredAmong([...new Set(seen.map((s) => s.repoRel))]);
  return seen.filter((s) => ignored.has(s.repoRel));
}

// ── the sweep ────────────────────────────────────────────────────────────────
/**
 * Pure function. Why a gitignored literal is allowed, or "VIOLATION".
 *
 * @param {string} rel app-relative resolved path
 * @returns {"ARTIFACT"|"EXCLUDE"|"DECLARED"|"VIOLATION"}
 *
 * @example verdict(".claude_vlm_checks/glass/a.png")
 * // "ARTIFACT"
 * @example verdict("projects/Imitations/assets/histogram.plugin.js")
 * // "DECLARED"
 * @example verdict("projects/SomeoneElsesDeck/assets/logo.svg")
 * // "VIOLATION"
 */
export function verdict(rel) {
  if (hasSegmentRun(rel, ARTIFACT_DIRS)) return "ARTIFACT";
  if (hasSegmentRun(rel, SWEEP_EXCLUSIONS)) return "EXCLUDE";
  if (isDeclaredOptional(rel, OPTIONAL_FIXTURES)) return "DECLARED";
  return "VIOLATION";
}

const sources = testSources();
const hits = gitignoredLiterals(sources);
/** A site may resolve under either base; it is a violation only when NO reading
 *  of it is legitimate. Crying wolf on a path that has a valid interpretation is
 *  how a gate gets muted. */
const bySite = new Map();
for (const h of hits) {
  const key = `${h.where}|${h.lit}`;
  if (!bySite.has(key)) bySite.set(key, []);
  bySite.get(key).push(h);
}
const sites = [...bySite.values()];
const violations = sites.filter((g) => g.every((h) => verdict(h.rel) === "VIOLATION")).map((g) => g[0]);

if (inventory) {
  for (const g of sites) {
    const why = g.map((h) => verdict(h.rel)).find((v) => v !== "VIOLATION") ?? "VIOLATION";
    console.log(`${why.padEnd(9)} ${g[0].where}  "${g[0].lit}"`);
  }
  console.log(`\n${hits.length} gitignored path literals across ${sources.length} test sources`);
  process.exit(0);
}

if (violations.length) {
  console.error(`\nFAIL gitignored_fixture_test (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  · ${v.where} depends on "${v.lit}", which git IGNORES (${v.rel}).\n` +
      "    A gate may not read user data: it will ENOENT on every fresh clone, and the\n" +
      "    stack reads like a regression. Commit a minimal fixture under tests/fixtures/,\n" +
      "    or declare it in tests/fixture_precondition.js OPTIONAL_FIXTURES and skip loudly.");
  }
  process.exit(1);
}

// ── THE GATE MUST BE ABLE TO FAIL ────────────────────────────────────────────
// Four gates were found this round that could not fail, each proving only the
// case its author was picturing. So this one is exercised on a fixture of every
// shape it claims to handle — including the two shapes the real defect took.
{
  // THE FIXTURE PATHS ARE ASSEMBLED, NOT WRITTEN. A gate that sweeps test sources
  // for gitignored path literals also sweeps ITSELF, so a literal fixture here
  // would make the gate fail on its own self-check — which it did, on the first
  // run. Joining segments keeps each literal path-free (`pathLiterals` needs a
  // `/`) while the assembled value is the exact shape under test.
  const ghostDir = ["projects", "Ghost", "assets"].join("/");
  const ghostFile = `${ghostDir}/x.plugin.js`;

  // (a) the shape the defect ACTUALLY had: a literal in a list, read later.
  assert.deepEqual(pathLiterals(`const PLUGIN_DIRS = ["assets/builtin/library", "${ghostDir}"];`),
    ["assets/builtin/library", ghostDir],
    "SELF-CHECK: a path literal inside an array is not seen — that is the shape the real defect took");
  // (b) the shape it took in the other suite: a relative walk inside a read call.
  assert.deepEqual(pathLiterals(`readFileSync(resolve(here, "../${ghostFile}"))`), [`../${ghostFile}`],
    "SELF-CHECK: a ../ walk inside a read call is not seen");
  // (c) comments must not count, in EITHER language.
  assert.ok(!stripJsComments(`x; // "${ghostDir}"`).includes("Ghost"), "SELF-CHECK: JS comments count as dependencies");
  assert.ok(!stripHashComments(`x  # "${ghostDir}"`).includes("Ghost"), "SELF-CHECK: hash comments count as dependencies");
  assert.equal(stripJsComments("a\n/* p */\nb").split("\n").length, 3,
    "SELF-CHECK: the stripper eats lines — every reported line number would be wrong");
  // (d) the allow-lists must allow, and must not over-allow.
  assert.equal(verdict(".claude_vlm_checks/x/a.png"), "ARTIFACT", "SELF-CHECK: an artifact path is flagged — the gate would block correct code");
  assert.equal(verdict("../.claude_vlm_checks/x"), "ARTIFACT", "SELF-CHECK: the ../ spelling of the artifact tree is flagged");
  assert.equal(verdict(".claude_vlm_checksX/a.png"), "VIOLATION", "SELF-CHECK: a same-prefix sibling is waved through as an artifact dir");
  assert.equal(verdict("web/dist/assets/x.js"), "EXCLUDE", "SELF-CHECK: the build-output sweep exclusion is flagged");
  // (e) the non-path shapes that would otherwise flood the report.
  assert.deepEqual(pathLiterals('fetch("https://api.github.com/x")'), [], "SELF-CHECK: a URL is treated as a disk path");
  assert.deepEqual(pathLiterals('const u = "/asset/P/icons/database.svg";'), [], "SELF-CHECK: a backend route is treated as a disk path");
  // (f) end to end: an undeclared gitignored path must come out a VIOLATION, and
  //     a declared one must not.
  assert.equal(verdict(ghostDir), "VIOLATION", "SELF-CHECK: an undeclared project path is not a violation — the gate is vacuous");
  assert.equal(verdict(Object.keys(OPTIONAL_FIXTURES)[0]), "DECLARED", "SELF-CHECK: a DECLARED optional fixture is reported as a violation");
}

// ── NON-VACUITY ──────────────────────────────────────────────────────────────
// A sweep that read nothing passes trivially. Pin that it saw the real corpus and
// that the allow-lists are earning their place rather than sitting unused.
assert.ok(sources.length >= 300, `only ${sources.length} test sources swept — the collector is looking in the wrong place`);
assert.ok(sites.length >= 10, `only ${sites.length} gitignored literal sites seen — the resolver or git check-ignore is not working`);
assert.ok(sites.some((g) => g.some((h) => verdict(h.rel) === "DECLARED")),
  "no DECLARED fixture site was found — fixture_precondition.js's registry is unreachable from any test, so this gate's exemption path is untested");

console.log(`PASS gitignored_fixture_test — ${sources.length} test sources swept, ${sites.length} gitignored path-literal sites, all of them artifacts, sweep exclusions, or declared in fixture_precondition.js.`);
