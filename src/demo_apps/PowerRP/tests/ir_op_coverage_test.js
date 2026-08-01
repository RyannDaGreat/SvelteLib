/**
 * THE IR OP CONTRACT, MECHANICALLY CHECKED — the gate that makes ir.js's
 * `DRAW_OPS` comment true instead of merely confident.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `render_gpu/ir.js` exports `DRAW_OPS` under the comment "Every op a backend must
 * understand". It was a hand-written array, nothing read it, and it had drifted:
 * `mermaidVector`, `paperCurl` and `videoV2` were built by ir.js and absent from the
 * list. Its ONLY consumer in tracked source was a single-membership assertion
 * (`assert.ok(DRAW_OPS.includes("latexVector"))`) — a check that cannot fail for any
 * op but one. A list that reads as a contract and enforces nothing is this codebase's
 * worst recurring defect (manifest R6-24.7, and the convention ledger's
 * "highest-risk pattern"), so the list needed either a derivation or a gate.
 *
 * A DERIVATION IS NOT AVAILABLE AT MODULE SCOPE, and that is measured, not assumed:
 * ir.js's builders validate their arguments — 28 of its 61 exported functions throw
 * when called with `{}` — so deriving the op set by invoking them would require a
 * canonical-argument table, which is the same hand-maintained mirror relocated into
 * a place nobody would think to check. A TEST, however, may read the file. So the
 * derivation lives here, where `node:fs` is available and staleness is impossible.
 *
 * ── WHAT IS DERIVED, AND FROM WHAT ───────────────────────────────────────────
 * The produced-op set comes from ir.js's OWN SOURCE TEXT: every `op: "…"` literal it
 * writes into a command. That is the ground truth by construction — a builder that
 * stamps an op it did not declare is not expressible. The backends' handled sets come
 * from their own `case "…":` labels, for the same reason.
 *
 * Nothing in this file enumerates an op by hand. Add a builder to ir.js and this
 * suite names the list you forgot to update; delete one and it says so too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DRAW_OPS } from "../render_gpu/ir.js";
import { VECTOR_OPS } from "../render_gpu/pdf_backend.js";
import { SVG_VECTOR_OPS } from "../render_gpu/svg_backend.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(appRoot, rel), "utf8");

/**
 * The two ops flattenIR CONSUMES rather than paints. A backend never receives one,
 * so they are the exact complement of DRAW_OPS within ir.js's `op:` vocabulary.
 */
const STRUCTURAL_OPS = new Set(["pushTransform", "popTransform"]);

/**
 * Pure function. Every `op: "…"` literal a module's source stamps into a command.
 * The op vocabulary a file can PRODUCE, read off the file itself.
 *
 * @param {string} src - JavaScript source text
 * @returns {Set<string>}
 *
 * @example opLiteralsIn('return { op: "rect", x };') // Set { "rect" }
 * @example opLiteralsIn('a({op:"text"}); b({ op: "image" })') // Set { "text", "image" }
 * @example opLiteralsIn("nothing here") // Set {}
 */
function opLiteralsIn(src) {
  return new Set([...src.matchAll(/\bop:\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
}

/**
 * Pure function. Every `case "…":` label in a module's source — the op names a
 * backend's dispatch switch names at all. A superset of what it truly handles (a
 * label could belong to some other switch), which is the SAFE direction: an op that
 * appears nowhere as a case label is certainly unhandled, and that is the failure
 * this detects.
 *
 * @param {string} src - JavaScript source text
 * @returns {Set<string>}
 *
 * @example caseLabelsIn('switch (x) { case "rect": break; case "text": break; }') // Set { "rect", "text" }
 * @example caseLabelsIn("if (a) return 1;") // Set {}
 */
function caseLabelsIn(src) {
  return new Set([...src.matchAll(/\bcase\s+"([A-Za-z0-9_]+)"\s*:/g)].map((m) => m[1]));
}

/** Pure function. Sorted members of `set` that are absent from `other`.
 * @example missingFrom(new Set(["b", "a"]), new Set(["a"])) // ["b"]
 * @example missingFrom(new Set(["a"]), new Set(["a", "b"])) // []
 */
function missingFrom(set, other) {
  return [...set].filter((v) => !other.has(v)).sort();
}

test("DRAW_OPS is exactly the op set ir.js builds — derived from ir.js's own source", () => {
  const produced = opLiteralsIn(read("render_gpu/ir.js"));
  const drawable = new Set([...produced].filter((op) => !STRUCTURAL_OPS.has(op)));
  const declared = new Set(DRAW_OPS);

  assert.deepEqual(missingFrom(drawable, declared), [],
    "ir.js BUILDS these ops but DRAW_OPS omits them — a backend author reading the list would not know they exist");
  assert.deepEqual(missingFrom(declared, drawable), [],
    "DRAW_OPS names these ops but no builder in ir.js stamps them — a list entry for an op that cannot occur");
  assert.equal(DRAW_OPS.length, new Set(DRAW_OPS).size, "DRAW_OPS has a duplicate entry");
  for (const op of STRUCTURAL_OPS)
    assert.ok(produced.has(op) && !declared.has(op),
      `${op} is a transform-stack op flattenIR consumes; it must exist in ir.js and stay OUT of DRAW_OPS`);
});

test("the Skia painter names every DRAW_OP in its dispatch — the total backend", () => {
  // paint_skia.js is the one backend with no raster fallback: an op it does not case
  // on reaches `default: throw new Error('paintIR(skia): unknown op …')` at runtime.
  const handled = caseLabelsIn(read("render_gpu/skia/paint_skia.js"));
  assert.deepEqual(missingFrom(new Set(DRAW_OPS), handled), [],
    "these ops appear in NO `case` label in paint_skia.js, so painting one throws 'unknown op'");
});

test("the two vector backends declare the SAME vector vocabulary, and it is a subset of DRAW_OPS", () => {
  // Both docblocks claim "identical vocabulary today — the same IR" and instruct the
  // reader to keep them in lockstep (pdf_backend.js VECTOR_OPS, svg_backend.js
  // SVG_VECTOR_OPS). Two hand-maintained sets that must agree is exactly the shape
  // that rots in silence, so the claim is now an assertion rather than a comment.
  assert.deepEqual([...VECTOR_OPS].sort(), [...SVG_VECTOR_OPS].sort(),
    "pdf_backend.VECTOR_OPS and svg_backend.SVG_VECTOR_OPS have drifted apart; their docblocks promise they are identical");
  assert.deepEqual(missingFrom(VECTOR_OPS, new Set(DRAW_OPS)), [],
    "a vector backend claims to represent an op the IR cannot build");
});

test("every DRAW_OP a vector backend does NOT claim is reachable through its raster fallback", () => {
  // The vector backends are NOT total switches: `!VECTOR_OPS.has(cmd.op)` routes to
  // the general raster fallback instead of throwing. That is the design (both
  // headers describe it), so the contract for a non-vector op is "the fallback
  // exists", not "the switch handles it". Assert the routing conditions are still
  // written that way — if either backend ever dropped the guard, a new op would hit
  // its `default: throw` and crash an export instead of rasterizing.
  for (const [rel, token] of [["render_gpu/pdf_backend.js", "VECTOR_OPS"], ["render_gpu/svg_backend.js", "SVG_VECTOR_OPS"]]) {
    const src = read(rel);
    assert.ok(src.includes(`!${token}.has(cmd.op)`),
      `${rel} no longer routes an unclaimed op to its raster fallback — a new IR op would throw on export`);
    assert.match(src, /default:\s*\n?\s*throw new Error/,
      `${rel} must keep a LOUD default; a silent one would drop geometry`);
  }
});
