/**
 * PLUGIN-ASSET DOCTESTS — the gap tests/doctest_test.js cannot reach.
 *
 * That suite sweeps importable modules; a *.plugin.js asset is not a module —
 * it is a function BODY compiled inside the core/plugin_assets.js jail, and its
 * doctested pure helpers are locals of that closure. So its ~180 checked-in
 * `@example` records ran nowhere, and one had already drifted into a lie
 * (histogram's labelledBinIndices claimed [0,4,8]; the code returns [0,3,6,8]).
 *
 * HOW THE HELPERS ESCAPE (the load-bearing trick): every library source ends by
 * returning its plugin object with a single LINE-START `return`. This suite
 * asserts that convention (loudly — a second line-start return is a hard fail),
 * rewrites that one line to `const __PLUGIN__ =`, appends a return of every
 * top-level declaration, and evaluates the result through the REAL jail
 * (evaluatePluginSource) — so each example calls the very closure the renderer
 * would, with the jail's own SAFE built-ins semantics.
 *
 * THE CHECKABILITY RULE (doctest_test.js's, in miniature — every record lands in
 * exactly one printed bucket, so the number can't lie):
 *   EXECUTED  expr parses, expected starts with a JS literal, all names resolve.
 *   PROSE     comment-only @example (no expression stated).
 *   NOTATION  expected is display notation, not a literal (e.g. `Set([...])`).
 *   FREE      the expression references a name outside the plugin's top-level
 *             declarations + node globals (printed, never silent).
 *   SYNTAX    the expression is not parseable JS — MUST STAY EMPTY (hard fail).
 * A MIN_EXECUTED floor keeps the suite from going quietly decorative.
 *
 * Run: node tests/plugin_asset_doctest_test.js  [--verbose]
 */
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePluginSource } from "../core/plugin_assets.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const verbose = process.argv.includes("--verbose");

/** Where plugin-asset sources live in-repo (built-in library + checked-in project assets). */
const PLUGIN_DIRS = ["assets/builtin/library", "projects/Imitations/assets"];
const MIN_EXECUTED = 100; // floor: raise as coverage grows; lowering needs a stated reason

const files = PLUGIN_DIRS.flatMap((d) => {
  const dir = resolve(appRoot, d);
  return readdirSync(dir).filter((f) => f.endsWith(".plugin.js")).map((f) => resolve(dir, f));
});
assert.ok(files.length >= 10, `expected the known plugin-asset corpus, found ${files.length} files`);

/**
 * Pure function. Rewrites a plugin-asset source so its top-level declarations
 * become inspectable: the single line-start `return` (the plugin object) turns
 * into `const __PLUGIN__ = …` and a generated return exposes every top-level
 * `function`/`const`/`let` name plus __PLUGIN__.
 *
 * @param {string} src Plugin-asset function-body source.
 * @returns {{src: string, names: string[]}}
 *
 * @example
 * // exposeHelpers('const two = 2;\nreturn {type: "x"};').names  // ["two"]
 * @example
 * // exposeHelpers('function f() {}\nreturn {};').src.includes("const __PLUGIN__ =")  // true
 */
function exposeHelpers(src) {
  const returns = src.match(/^return\b/gm) ?? [];
  assert.equal(returns.length, 1, "plugin-asset convention: exactly ONE line-start `return` (the plugin object)");
  const names = [...src.matchAll(/^(?:function\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const rewritten = src.replace(/^return\b/m, "const __PLUGIN__ =") +
    `\nreturn { __PLUGIN__: __PLUGIN__${names.map((n) => `, ${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join("")} };`;
  return { src: rewritten, names };
}

/**
 * Pure function. Extracts @example records from a source's comment lines.
 * Recognized shapes (doctest_test.js's three, minus the bare-result form the
 * plugin corpus does not use):
 *   `@example EXPR // EXPECTED`
 *   `@example EXPR`  followed by a `// EXPECTED` comment line
 *   `@example // prose` (comment-only) → {prose: true}
 *
 * @param {string} src
 * @returns {Array<{expr?: string, expected?: string, prose?: boolean, line: number}>}
 *
 * @example
 * // extractExamples("// @example f(1) // 2")[0]  // {expr: "f(1)", expected: "2", line: 1}
 * @example
 * // extractExamples("// @example // just words")[0].prose  // true
 */
function extractExamples(src) {
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:\*|\/\/)\s*@example\s+(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest.startsWith("//")) { out.push({ prose: true, line: i + 1 }); continue; }
    const split = splitExprComment(rest);
    if (split) { out.push({ expr: split.expr, expected: split.expected, line: i + 1 }); continue; }
    const next = (lines[i + 1] ?? "").match(/^\s*(?:\*|\/\/)\s*\/\/\s*(.+)$/);
    if (next) out.push({ expr: rest, expected: next[1].trim(), line: i + 1 });
    else out.push({ prose: true, line: i + 1 }); // expression with no stated result = prose
  }
  return out;
}

/**
 * Pure function. Splits "EXPR // EXPECTED" at the first `//` that is OUTSIDE
 * any string/template literal (a regex cannot tell those apart; a char walk can).
 *
 * @param {string} s
 * @returns {{expr: string, expected: string}|null}
 *
 * @example
 * // splitExprComment('f("a//b") // 3')  // {expr: 'f("a//b")', expected: "3"}
 * @example
 * // splitExprComment("f(1)")  // null
 */
function splitExprComment(s) {
  let quote = null;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && s[i + 1] === "/") return { expr: s.slice(0, i).trim(), expected: s.slice(i + 2).trim() };
  }
  return null;
}

/**
 * Near-pure function (evaluates caller-supplied literal text). Parses the
 * LEADING JS literal of an expected-result string, tolerating a trailing
 * annotation after it (the doctest_test.js rule). Returns {ok, value} — never
 * throws; unparseable = display notation, not a failure.
 *
 * @param {string} s
 * @returns {{ok: boolean, value?: any}}
 *
 * @example
 * // parseExpected("[1, 2] the edges").value  // [1, 2]
 * @example
 * // parseExpected("Set([1])").ok  // false
 */
function parseExpected(s) {
  const attempts = [s];
  const open = s[0], close = { "{": "}", "[": "]", "(": ")" }[open];
  if (close) { // balanced-prefix cut for bracketed literals with prose after
    let depth = 0, quote = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) { attempts.unshift(s.slice(0, i + 1)); break; }
    }
  } else {
    const tok = s.match(/^(-?\d[\d._eE+-]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|true|false|null|undefined|NaN|-?Infinity)/);
    if (tok && tok[0] !== s) attempts.unshift(tok[0]);
  }
  for (const a of attempts) {
    try { return { ok: true, value: Function(`"use strict"; return (${a});`)() }; }
    catch { /* try the next candidate; exhausting all = display notation, reported below */ }
  }
  return { ok: false };
}

/**
 * Pure function. Structural equality with FLOAT TOLERANCE — a doctest that
 * documents 30.8 is not lying about 30.799999999999997, and +0 equals -0
 * (JSON.stringify prints both as 0, so a strict mismatch there is unreportable
 * noise, not information). Relative epsilon on numbers; recursion elsewhere.
 *
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 *
 * @example
 * // closeEnough({y: 30.8}, {y: 30.799999999999997})  // true
 * @example
 * // closeEnough([1, 2], [1, 3])  // false
 */
function closeEnough(a, b) {
  if (typeof a === "number" && typeof b === "number")
    return a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => closeEnough(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => closeEnough(a[k], b[k]));
  }
  return Object.is(a, b);
}

// ── self-check: the checker's own fixtures, before the sweep (doctest_test.js
// convention — the guard against a parser that quietly recognises nothing) ────
{
  const fx = exposeHelpers('const two = 2;\nfunction addTwo(x) { return x + two; }\nreturn {type: "t"};');
  assert.deepEqual(fx.names, ["two", "addTwo"]);
  const scope = evaluatePluginSource(fx.src, "selfcheck.plugin.js");
  assert.equal(scope.addTwo(3), 5);
  assert.equal(scope.__PLUGIN__.type, "t");
  assert.deepEqual(extractExamples("// @example addTwo(1) // 3")[0], { expr: "addTwo(1)", expected: "3", line: 1 });
  assert.equal(extractExamples(" * @example // words only")[0].prose, true);
  assert.deepEqual(parseExpected('{a: 1} — note').value, { a: 1 });
  assert.equal(parseExpected("Set([1])").ok, false);
  assert.deepEqual(splitExprComment('f("//x") // 1'), { expr: 'f("//x")', expected: "1" });
  assert.ok(closeEnough({ y: 30.8 }, { y: 30.799999999999997 }) && closeEnough(0, -0) && !closeEnough([1, 2], [1, 3]));
}

// ── the sweep ────────────────────────────────────────────────────────────────
const counts = { executed: 0, prose: 0, notation: 0, free: 0, syntax: 0 };
const failures = [];
const skipsShown = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const name = basename(file);
  const { src: exposed, names } = exposeHelpers(src);
  const scope = evaluatePluginSource(exposed, name); // an unevaluable source is a HARD throw here
  for (const ex of extractExamples(src)) {
    const where = `${name}:${ex.line}`;
    if (ex.prose) { counts.prose++; if (verbose) skipsShown.push(`PROSE    ${where}`); continue; }
    let fn;
    try { fn = Function(...names, `"use strict"; return (${ex.expr});`); }
    catch (e) { counts.syntax++; failures.push(`SYNTAX   ${where}  ${ex.expr}  (${e.message})`); continue; }
    const expected = parseExpected(ex.expected);
    if (!expected.ok) { counts.notation++; if (verbose) skipsShown.push(`NOTATION ${where}  // ${ex.expected}`); continue; }
    let actual;
    try { actual = fn(...names.map((n) => scope[n])); }
    catch (e) {
      if (e instanceof ReferenceError) { counts.free++; skipsShown.push(`FREE     ${where}  ${ex.expr}  (${e.message})`); continue; }
      failures.push(`THREW    ${where}  ${ex.expr}  → ${e.message}`); continue;
    }
    if (closeEnough(actual, expected.value)) counts.executed++;
    else failures.push(`MISMATCH ${where}  ${ex.expr}\n  documented: ${JSON.stringify(expected.value)}\n  actual:     ${JSON.stringify(actual)}`);
  }
}

for (const s of skipsShown) console.log(`  ${s}`);
console.log(`plugin_asset_doctest: ${counts.executed} executed pass · ${counts.prose} prose · ${counts.notation} notation · ${counts.free} free-name · ${counts.syntax} syntax — across ${files.length} plugin assets`);
if (failures.length) { console.error(failures.map((f) => `FAIL ${f}`).join("\n")); process.exit(1); }
assert.equal(counts.syntax, 0, "the SYNTAX bucket must stay empty");
assert.ok(counts.executed >= MIN_EXECUTED, `coverage floor: ${counts.executed} executed < ${MIN_EXECUTED} — a drop here means the parser or the corpus regressed`);
console.log("plugin_asset_doctest_test: all checks passed");
