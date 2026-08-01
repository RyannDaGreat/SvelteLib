/**
 * NO BACKTICK MAY LIVE INSIDE SHADER SOURCE — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/shader_parse_test.js
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * Shader source in this codebase lives in TEMPLATE LITERALS (`export const
 * X_SKSL = ...`), and this codebase explains itself heavily in prose, and its
 * prose convention marks identifiers with BACKTICKS. Those three facts collide:
 * a backtick inside a template literal CLOSES IT, so a perfectly-written comment
 * inside SkSL turns the rest of the file into JavaScript.
 *
 * MEASURED, in sky_shader.js during R6-9: two comment lines quoting pw, cellPx
 * and sizePx produced `SyntaxError: Unexpected identifier 'pw'` — an error that
 * names a symbol and gives no hint that the cause is a quote mark. It took down
 * every bare-node suite that transitively reaches paint_skia.js, for the whole
 * fleet, and two agents reported it as somebody else's outage before it was
 * traced.
 *
 * WHY A GATE AND NOT A NOTE. It is INVISIBLE TO REVIEW — the comment reads
 * correctly and the shader is correct — and it lands on whoever imports the
 * module next, not on the author. Same family as ledger C-14 (a comment-blind
 * gate failing in both directions), seen from the parser's side.
 *
 * ── WHY THE CHECK IS NOT `node --check`, WHICH WAS TRIED FIRST ────────────────
 *
 * Because the defect is INTERMITTENT and the parser only catches half of it.
 * Stray backticks in even numbers RE-BALANCE the literal into a valid tagged
 * template, so the file parses and the exported SkSL is silently TRUNCATED at
 * the first stray backtick. Measured on the real module: injecting one
 * backtick-quoted identifier into a comment inside SKY_SKSL leaves
 * `node --check` completely happy while SKY_SKSL loses everything below line 70.
 * A parse gate would have called that green.
 *
 * ── THE RULE, WHICH IS EXACT ──────────────────────────────────────────────────
 *
 *   for every `export const NAME = ` + backtick in render_gpu/skia/, the NEXT
 *   backtick must be immediately followed by a semicolon.
 *
 * That is true exactly when the literal ends where its author meant it to. A
 * stray backtick anywhere inside makes the literal end early, in the middle of
 * prose or code, and the character after it is never `;`. It needs no parser, no
 * subprocess and no knowledge of what the shader does, and it catches the even
 * and odd cases alike. `node --check` runs too, as the cheap general backstop
 * for every OTHER way a shader module can fail to parse.
 *
 * The SELF-TEST at the end proves the gate can fail: it mutates the real
 * sky_shader.js in a temp copy, exactly the way R6-9 did by accident, and
 * requires the rule to reject it. A gate that cannot fail is not a gate.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKIA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skia");

/** Matches the head of an exported template literal: `export const NAME = ` + backtick. */
const LITERAL_HEAD = /export const (\w+)\s*=\s*`/g;

/**
 * Pure function. Every exported template literal in `source` that does NOT close
 * where its author meant it to — i.e. whose closing backtick is not immediately
 * followed by a semicolon, which is what a stray backtick inside the literal does.
 *
 * @param {string} source - the full text of a .js module
 * @returns {{name: string, line: number, after: string}[]} one entry per violation
 *
 * @example unterminatedLiterals("export const S = `\\nhalf4 main() {}\\n`;\\n") // []
 * @example unterminatedLiterals("export const S = `\\n// `pw` here\\n`;\\n")
 * // [{name: "S", line: 1, after: "pw"}]   (the literal ended at the prose backtick)
 */
export function unterminatedLiterals(source) {
  const out = [];
  LITERAL_HEAD.lastIndex = 0;
  let m;
  while ((m = LITERAL_HEAD.exec(source)) !== null) {
    const end = source.indexOf("`", m.index + m[0].length);
    if (end === -1 || source[end + 1] !== ";") {
      out.push({
        name: m[1],
        line: source.slice(0, m.index).split("\n").length,
        after: end === -1 ? "<never closed>" : source.slice(end + 1, end + 3),
      });
    }
    LITERAL_HEAD.lastIndex = end === -1 ? source.length : end + 1;
  }
  return out;
}

/**
 * Query (spawns node). Whether `file` is syntactically valid JS, and the error if
 * not. Uses the SAME parser that will load it, so nothing here can drift from the
 * check that matters.
 *
 * @param {string} file - absolute path to a .js file
 * @returns {{ok: boolean, error: string}}
 *
 * @example parseCheck("/path/to/sky_shader.js") // {ok: true, error: ""}
 * @example // a file with an odd number of stray backticks =>
 * // {ok: false, error: "SyntaxError: Unexpected identifier 'pw' …"}
 */
function parseCheck(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true, error: "" };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message).trim() };
  }
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

console.log("shader source integrity:");

const files = fs.readdirSync(SKIA_DIR).filter((f) => f.endsWith(".js")).sort();
assert.ok(files.length > 0, `no .js files found in ${SKIA_DIR} — this gate is looking at the wrong directory`);

test(`every exported template literal in render_gpu/skia/ closes where it should (${files.length} modules)`, () => {
  const broken = [];
  let literals = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(SKIA_DIR, f), "utf8");
    literals += (src.match(LITERAL_HEAD) ?? []).length;
    for (const v of unterminatedLiterals(src))
      broken.push(`${f}:${v.line} ${v.name} ends early, at text "${v.after}…"`);
  }
  assert.ok(literals > 0, "no exported template literals found at all — the pattern has drifted from the source");
  assert.equal(broken.length, 0,
    `${broken.length} shader literal(s) end before their author meant them to. A BACKTICK inside the literal is the cause — write identifiers BARE inside SkSL comments, the way the surrounding SkSL comments already do.\n\n${broken.join("\n")}`);
});

test(`all ${files.length} modules in render_gpu/skia/ parse`, () => {
  const broken = [];
  for (const f of files) {
    const r = parseCheck(path.join(SKIA_DIR, f));
    if (!r.ok) broken.push(`${f}:\n${r.error}`);
  }
  assert.equal(broken.length, 0, `${broken.length} shader module(s) do not parse.\n\n${broken.join("\n\n")}`);
});

// ── THE SELF-TEST: the gate must reject the real defect ──────────────────────
// The fixture is a REAL shader module with ONE comment line re-quoted, not a
// hand-written miniature: a miniature was tried first and it PARSED, because with
// few tokens around them the stray backticks re-balance into a tagged template.
// Deriving the fixture from the file the defect actually happened in cannot drift
// away from it.
const SELF_TEST_SOURCE = "sky_shader.js";
const SELF_TEST_LINE = "// clumps, 5.5 the finer dust that bites lanes out of it.";
const SELF_TEST_MUTATION = "// clumps, `MW_DUST_FREQ` the finer dust that bites lanes out of it.";

test("the gate rejects the exact defect it exists for, on the real module", () => {
  const src = fs.readFileSync(path.join(SKIA_DIR, SELF_TEST_SOURCE), "utf8");
  assert.ok(src.includes(SELF_TEST_LINE),
    `${SELF_TEST_SOURCE} no longer contains the line this self-test mutates — repoint SELF_TEST_LINE at any comment INSIDE that file's SkSL template literal`);
  const mutated = src.replace(SELF_TEST_LINE, SELF_TEST_MUTATION);
  const found = unterminatedLiterals(mutated);
  assert.equal(found.length, 1, "one backtick-quoted identifier inside the SkSL must be caught — if it is not, this gate cannot catch the defect it was written for");
  assert.equal(found[0].name, "SKY_SKSL");

  // …and demonstrate WHY the parse check alone is not enough: the same mutation is
  // valid JavaScript. This is the measurement quoted in the header, re-run here so
  // it cannot become a stale claim.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "powerrp-shader-parse-"));
  const bad = path.join(dir, SELF_TEST_SOURCE);
  fs.writeFileSync(bad, mutated);
  try {
    assert.ok(parseCheck(bad).ok,
      "the mutated module now FAILS to parse — good news, but it means the literal-termination rule is no longer the only thing standing between us and this defect; update the header's claim rather than deleting the rule");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nPASS: shader source integrity (${passed} checks over ${files.length} modules)`);
