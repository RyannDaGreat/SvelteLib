/**
 * PROBE-ARTIFACT-PATH guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/probe_artifact_path_test.js
 * Inventory (every .claude_vlm_checks resolution the scanner sees):
 *     node src/demo_apps/PowerRP/tests/probe_artifact_path_test.js --inventory
 *
 * WHY THIS EXISTS. Screenshot output has ONE home: POWERRP/.claude_vlm_checks/,
 * which is the directory the repo's .gitignore actually covers. Sixteen probes had
 * drifted out of it — fifteen walked FIVE or SIX levels up, landing in the RPPT
 * dump root OUTSIDE the git repo (and one of those went a level past even that),
 * and one resolved its path from process.cwd(), so the same command wrote to a
 * different place depending on where it was run from. Nothing failed: the shots
 * simply appeared somewhere nobody looked, ungitignored, and a VLM check was then
 * done against whichever stale copy the reader happened to open.
 *
 * WHAT IT PROVES, on the SOURCE (nothing here executes a probe):
 *   (1) every file that names .claude_vlm_checks locates ITSELF — import.meta.url
 *       in JS, __file__ in Python — so its output does not depend on the shell's
 *       working directory;
 *   (2) no such file derives a path from process.cwd() / os.getcwd();
 *   (3) a resolution that walks up with literal ".." segments does not walk past
 *       the PowerRP directory: the count of ".." on the line may not exceed the
 *       file's own depth below it.
 *
 * WHAT IT DOES NOT PROVE. (3) reads the ".." literals on the line that names the
 * directory. A resolution whose base is a variable computed on ANOTHER line
 * (`resolve(powerrp, ".claude_vlm_checks")` — the majority idiom, and the right
 * one) is checked by (1) and (2) only. That is deliberate: statically evaluating
 * arbitrary path arithmetic would be a worse guard than a narrow honest one.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Paths resolve from THIS FILE, never process.cwd() — the rule this file guards.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SWEPT_DIRS = ["tests", "render_gpu", "cli", "web", "examples", "core", "plugins", "server"];
// Vite build output: a checked-in copy of third-party bundles, not source we own.
const SKIP_PREFIXES = ["web/dist/"];

const ARTIFACT_DIR = ".claude_vlm_checks";
// The one canonical location, so a failure message can name it.
const CANONICAL = `POWERRP/${ARTIFACT_DIR}/`;
// A line that RESOLVES a path, as opposed to merely mentioning the directory in
// prose (a header note, a console.log telling the reader where to look).
const RESOLVES_RE = /(?:\bresolve\(|\bjoin\(|os\.path\.join\()/;
// Self-location, per language.
const SELF_LOCATING_RE = /import\.meta\.url|__file__/;
const CWD_RE = /process\.cwd\(\)|os\.getcwd\(\)/;

/**
 * Query. Every source file under the swept directories, as repo-relative paths.
 * Python is included: two probes here are .py, and they carry the same rule.
 *
 * @example // sweptFiles().includes("tests/glass_probe.js") → true
 * @example // sweptFiles().some((f) => f.startsWith("web/dist/")) → false
 */
function sweptFiles() {
  const out = [];
  const walk = (rel) => {
    if (!fs.existsSync(path.join(ROOT, rel))) return;
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (SKIP_PREFIXES.some((p) => child.startsWith(p))) continue;
      if (e.isDirectory()) walk(child);
      else if (/\.(js|mjs|py)$/.test(e.name)) out.push(child);
    }
  };
  for (const d of SWEPT_DIRS) walk(d);
  return out.sort();
}

/**
 * Pure function. How many directory levels a path expression walks UP, counting
 * the two spellings this codebase uses: a `".."` argument and a `"../"` prefix
 * inside one string. A path with no upward walk counts 0.
 *
 * @param {string} line - one line of source
 * @returns {number}
 *
 * @example upwardLevels('resolve(HERE, "..", ".claude_vlm_checks")') // 1
 * @example upwardLevels('resolve(HERE, "../../.claude_vlm_checks")') // 2
 * @example upwardLevels('resolve(powerrp, ".claude_vlm_checks")') // 0
 * @example upwardLevels('join(HERE, "..", "..", "..", "x")') // 3
 */
export function upwardLevels(line) {
  return (line.match(/"\.\."|'\.\.'/g) ?? []).length + (line.match(/\.\.\//g) ?? []).length;
}

/**
 * Pure function. How many directory levels below the PowerRP root a repo-relative
 * file sits — i.e. the most levels a path expression in it may legitimately walk
 * up before it leaves the project directory.
 *
 * @param {string} rel - repo-relative path, e.g. "render_gpu/tests/x.js"
 * @returns {number}
 *
 * @example depthBelowRoot("tests/glass_probe.js") // 1
 * @example depthBelowRoot("render_gpu/tests/skia_paint_test.js") // 2
 * @example depthBelowRoot("cli/render.js") // 1
 */
export function depthBelowRoot(rel) {
  return rel.split("/").length - 1;
}

/**
 * Pure function. A source line with its trailing line comment removed, so a rule
 * ABOUT code is never tripped by prose about the rule. The very note this guard
 * asks authors to write ("never process.cwd()") contains the string it forbids.
 *
 * Approximate by design: it cuts at the first `//`, `#` or `*`, which is right for
 * every line in this codebase that names a path, and a false CUT can only make the
 * scan see less of a line, never invent a violation.
 *
 * @param {string} line - one line of source
 * @returns {string} the code part, trimmed
 *
 * @example codeOf('const x = resolve(HERE, "..");  // never process.cwd()') // 'const x = resolve(HERE, "..");'
 * @example codeOf('// Paths resolve from THIS FILE, never process.cwd()') // ''
 * @example codeOf(' * a header note about process.cwd()') // ''
 * @example codeOf('VLM_DIR = os.path.join(APP_DIR, ".x")  # self-locating') // 'VLM_DIR = os.path.join(APP_DIR, ".x")'
 */
export function codeOf(line) {
  return line.split(/\/\/|#|\*/)[0].trim();
}

/** Query. One row per file that RESOLVES an artifact path, with the lines it does it on. */
function inventory() {
  return sweptFiles().flatMap((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    if (!src.includes(ARTIFACT_DIR)) return [];
    const code = src.split("\n").map((text, i) => ({ n: i + 1, text: codeOf(text) }));
    const lines = code.filter((l) => l.text.includes(ARTIFACT_DIR) && RESOLVES_RE.test(l.text));
    if (lines.length === 0) return []; // mentions it in prose only
    return [{
      file: f,
      depth: depthBelowRoot(f),
      selfLocating: SELF_LOCATING_RE.test(src),
      // Per-line and comment-stripped: the note this guard asks for names the very
      // call it forbids, so scanning the whole file text would fail on its own rule.
      cwd: code.some((l) => CWD_RE.test(l.text)),
      lines,
    }];
  });
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const rows = inventory();

if (process.argv.includes("--inventory")) {
  for (const r of rows) {
    console.log(`${r.file}  (depth ${r.depth}, selfLocating=${r.selfLocating}, cwd=${r.cwd})`);
    for (const l of r.lines) console.log(`    ${l.n}: up ${upwardLevels(l.text)} — ${l.text}`);
  }
  console.log(`\n${rows.length} files resolve an artifact path`);
  process.exit(0);
}

test("the scanner still finds artifact-path resolutions (the guard is not vacuous)", () => {
  assert.ok(rows.length >= 30, `only ${rows.length} files resolve an artifact path — the scan patterns went stale, which would make every assertion below pass for the wrong reason`);
  assert.ok(rows.some((r) => r.depth === 2), "no render_gpu/tests file was found — that is the deeper half of the sweep, where the up-count differs");
});

test("every file writing artifacts locates itself, not the shell's cwd", () => {
  for (const r of rows)
    assert.ok(
      r.selfLocating,
      `${r.file} resolves ${ARTIFACT_DIR} but never derives a base from import.meta.url / __file__, so where it writes depends on where it was run from. Resolve from this file instead.`,
    );
});

test("no file writing artifacts derives a path from the working directory", () => {
  for (const r of rows)
    assert.ok(
      !r.cwd,
      `${r.file} resolves ${ARTIFACT_DIR} and also reads the working directory (process.cwd()/os.getcwd()). A cwd-relative path silently doubles its prefix when the suite is run from anywhere but the repo root — measured, and recorded in tests/pdf_p1_vlm_check.js.`,
    );
});

test(`every artifact path stays inside the project (${CANONICAL})`, () => {
  const escapes = [];
  for (const r of rows)
    for (const l of r.lines) {
      const up = upwardLevels(l.text);
      if (up > r.depth) escapes.push(`${r.file}:${l.n} walks up ${up} from a file ${r.depth} level(s) below the project root`);
    }
  assert.deepEqual(
    escapes, [],
    `these resolutions leave the PowerRP directory:\n  ${escapes.join("\n  ")}\n` +
    `Artifacts belong in ${CANONICAL} — the one location the repo's .gitignore covers. Walking further up lands in the surrounding dump, outside the repository entirely, which is where fifteen probes were quietly writing.`,
  );
});

console.log(`\n${passed} probe-artifact-path tests passed (${rows.length} files resolve an artifact path)`);
