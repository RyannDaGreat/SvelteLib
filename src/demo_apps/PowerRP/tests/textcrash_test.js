/**
 * THE DOUBLE-CLICK-TO-EDIT-TEXT CRASH — bare-node guards (workstream TEXTCRASH).
 * Run: node src/demo_apps/PowerRP/tests/textcrash_test.js
 *
 * THE BUG, verbatim from the user (prod bundle index-CbJtNAXT, 2026-08-06):
 * "Tried to edit text by double clicking it. Uncaught TypeError: Cannot read
 * properties of undefined (reading '0')" — thrown from a CanvasKit Paragraph
 * builder, inside an Array.map, with nothing in the stack naming text, a run, or
 * a paint. Double-clicking a text item routes web/TextEditController.svelte →
 * text_layout.getTextLayout → buildParagraph → its `pieces.map` → textStyle, and
 * textStyle read the run colour's representative solid as, literally:
 *
 *     st.color.stops[0].color
 *
 * WHY THAT WAS WRONG, AND WHY THE TRIAGE OF IT WAS WRONG TOO. A run colour reaches
 * this function RAW: `ir.js text()` runs parsePaint over the op-level `color` but
 * passes `rich` THROUGH UNTOUCHED, so `rich.runs[i].color` is model state, never a
 * parsed paint. Top-level `stops` is the LEGACY INLINE gradient shape. What the
 * PaintField writes TODAY is the multi-sub-state record — {type, solid, linear:
 * {stops}, radial: {stops}} — whose stops live under linear/radial and never at the
 * top level. So:
 *
 *   THE MODERN, CURRENT-SCHEMA GRADIENT RUN WAS THE CRASHING CASE, AND THE LEGACY
 *   ONE WAS THE ONLY SHAPE THAT WORKED — the exact inverse of how this was filed
 *   (it was triaged as a legacy run needing a load-time migration). There is
 *   nothing to migrate: the document was valid and the READER was wrong. That is
 *   why the fix is at the layout boundary and NOT in the repair pipeline — a
 *   normalization there would have "repaired" correct current-schema documents.
 *
 * A `{type:"solid"}` object and an OFF paint fell down the same hole, so this was
 * never gradient-specific. It also was NOT the 2026-08-03 crossfade fix (ledger BK,
 * opPaintSlots/render_gpu/ir.js): that one taught the op-level ROUTER to see rich
 * runs so a crossfade never reaches a leaf, and it is untouched here and still
 * asserted below. This is the LEAF's own read, which knew one shape out of six.
 *
 * WHAT THIS PINS
 *   (A) Every paint shape a run colour can really hold resolves to a solid.
 *   (B) A genuinely malformed paint throws a NAMED sentence — not `undefined[0]`,
 *       and not a silent black default (which would render the wrong colour with
 *       nothing to look at).
 *   (C) THE BITE CHECK: the old expression is re-created here and asserted to
 *       CRASH on the modern shape, so this file fails the moment the guard is
 *       reverted. Without it the test would pass against the bug.
 *   (D) The wiring — text_layout.js actually routes through the funnel and no
 *       longer contains the raw `.stops[0]` read.
 *   (E) An OFF run fill paints nothing instead of reaching the shader builder.
 *   (F) The 2026-08-03 opPaintSlots router still sees rich runs (no regression).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { paintSolidColor, isPaintOff, isGradientPaint, parsePaint, opPaintSlots, opHasCrossfadePaint } from "../render_gpu/ir.js";
import { styleNeedsGlyphPass, isGradientOnlyPaint } from "../render_gpu/skia/text_layout.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok — ${name}`);
}

const SRC = readFileSync(new URL("../render_gpu/skia/text_layout.js", import.meta.url), "utf8");

// The REAL shapes a run colour takes, named as the code that writes them names them.
// `modernLinear`/`modernRadial` are what web/PaintField.svelte paintSubstates() stores.
const MODERN_LINEAR = {
  type: "linearGradient",
  solid: "#ff0000",
  linear: { stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], angle: 0 },
  radial: { stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], center: { x: 0.5, y: 0.5 }, r: 0.5 },
};
const MODERN_RADIAL = {
  type: "radialGradient",
  solid: "#abcdef",
  linear: { stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], angle: 0 },
  radial: { stops: [{ offset: 0, color: "#0f0" }, { offset: 1, color: "#00f" }], center: { x: 0.5, y: 0.5 }, r: 0.5 },
};
const LEGACY_INLINE = {
  type: "linearGradient",
  stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }],
  from: { x: 0, y: 0 }, to: { x: 1, y: 0 },
};

/** The layout's run-colour reduction, mirrored from text_layout.textStyle. Kept in
 * step with the source by the (D) wiring assertions below — textStyle itself is
 * module-private (it needs a live CanvasKit), so the REDUCTION is what is pinned. */
const TRANSPARENT_INK = [0, 0, 0, 0];
function runInk(color) {
  if (isPaintOff(color)) return TRANSPARENT_INK;
  if (!isGradientPaint(color)) return color ?? "#000000";
  return paintSolidColor(color);
}

/** THE BUG, re-created verbatim — the expression text_layout.js carried until the
 * TEXTCRASH fix. Present so (C) can prove the guard bites. */
function runInkBeforeTheFix(color) {
  const shader = isGradientPaint(color);
  return !shader ? (color ?? "#000000")
    : color.type === "material" ? paintSolidColor(color)
    : color.stops[0].color;
}

console.log("\nTEXTCRASH — the double-click-to-edit-text crash\n");

test("(A) EVERY real run-colour shape resolves to a solid", () => {
  assert.equal(runInk(MODERN_LINEAR), "#ff0000", "the multi-sub-state linear the PaintField writes TODAY");
  assert.equal(runInk(MODERN_RADIAL), "#abcdef", "...and its radial twin");
  assert.equal(runInk(LEGACY_INLINE), "#f00", "the legacy inline shape still works — the fix took nothing away");
  assert.equal(runInk({ type: "solid", solid: "#123456" }), "#123456", "a solid PAINT OBJECT is not a string but is still a solid");
  assert.equal(runInk({ type: "material", material: { id: "comic" } }), "#888888", "the documented material→neutral-gray reduction");
  assert.equal(runInk({ type: "crossfade", from: "#f00", to: "#00f", t: 0.5 }), "#00f", "a crossfade reduces to the nearer side");
  assert.equal(runInk("#ff8800"), "#ff8800", "a bare CSS string");
  assert.deepEqual(runInk([1, 0, 0, 1]), [1, 0, 0, 1], "an rgba array");
  assert.equal(runInk(undefined), "#000000", "an absent colour keeps the documented black default");
  assert.deepEqual(runInk({ type: "none" }), TRANSPARENT_INK, "OFF is invisible ink, NOT an error");
});

test("(B) a MALFORMED paint throws a NAMED sentence, never undefined[0] and never a silent default", () => {
  for (const bad of [{}, { type: "linearGradient" }, { type: "radialGradient", radial: {} }]) {
    assert.throws(
      () => runInk(bad),
      (e) => {
        assert.ok(e instanceof Error, "an Error, not a TypeError from a property read");
        assert.doesNotMatch(e.message, /Cannot read properties of undefined/, "the raw TypeError must not survive");
        assert.match(e.message, /cannot resolve a solid color|paint/i, "the message names the PAINT as the problem");
        return true;
      },
      `a malformed paint must be refused loudly: ${JSON.stringify(bad)}`,
    );
  }
  // And the refusal is LOUD rather than a quiet substitution — the silent-wrongness rule.
  assert.notEqual(runInk(MODERN_LINEAR), "#000000", "a real gradient must never reduce to the black default");
});

test("(C) BITE CHECK — the pre-fix expression really does crash on the modern shape", () => {
  // If this ever stops throwing, the reduction under test is no longer guarding
  // anything and (A) has become vacuous.
  let crash = null;
  try { runInkBeforeTheFix(MODERN_LINEAR); } catch (e) { crash = e; }
  assert.ok(crash instanceof TypeError, "the pre-fix expression must still crash on the modern shape");
  assert.match(crash.message, /Cannot read properties of undefined \(reading '0'\)/,
    "the user's exact reported message — this IS the reported crash, reproduced");
  assert.throws(() => runInkBeforeTheFix(MODERN_RADIAL), TypeError, "the radial half crashed too");
  assert.throws(() => runInkBeforeTheFix({ type: "solid", solid: "#123456" }), TypeError, "a solid paint OBJECT crashed too — never gradient-specific");
  assert.throws(() => runInkBeforeTheFix({ type: "none" }), TypeError, "and an OFF paint crashed too");
  // The one shape the old code did handle — which is why this survived so long.
  assert.equal(runInkBeforeTheFix(LEGACY_INLINE), "#f00", "the LEGACY shape was the only one that ever worked");
});

test("(D) WIRING — text_layout.js routes through the funnel and the raw read is gone", () => {
  // Comment lines are stripped first: the docblock at the fix site QUOTES the old
  // expression to explain it, and that prose must not read as the bug's return.
  const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /st\.color\.stops\[0\]/, "the raw `st.color.stops[0]` read must not come back as CODE");
  assert.match(SRC, /solidInkForRun/, "the named-error helper is wired in");
  assert.match(SRC, /paintSolidColor\(paint\)/, "...and it delegates to ir.js's ONE resolver rather than re-deriving");
  assert.match(SRC, /isPaintOff/, "the OFF paint is handled explicitly, not by accident");
});

test("(E) an OFF run fill paints NOTHING instead of reaching the shader builder", () => {
  const off = { type: "none" };
  // The trap: {type:"none"} is an object, so isGradientPaint accepts it and
  // styleNeedsGlyphPass stays true (an OFF-filled run may still carry an OUTLINE,
  // drawn by the same pass) — but parsePaint resolves it to null, which
  // skShaderForPaint refuses outright.
  assert.equal(isGradientPaint(off), true, "an OFF paint IS an object, so the broad test accepts it");
  assert.equal(styleNeedsGlyphPass({ color: off }), true, "the glyph pass still runs — an OFF fill can carry an outline");
  assert.equal(parsePaint(off), null, "...and this null is what would reach skShaderForPaint");
  assert.match(SRC, /if \(!runFillNeedsShader\(fill\)\) return;/, "so drawGlyphShaderFill returns early on it");
  assert.equal(isGradientOnlyPaint(off), true, "documenting the shape: OFF is not a material, so it is not filtered out that way");
});

test("(E2) THE TWO HALVES AGREE — transparent-glyph and shader-pass ask ONE predicate", () => {
  // The invariant: textStyle draws glyphs TRANSPARENT iff the glyph pass will
  // repaint them. A disagreement renders the run INVISIBLE with no error at all.
  // Both call runFillNeedsShader; this asserts the answers it must give, and the
  // source wiring below asserts both callers really use it.
  //
  // Found the hard way: guarding only the OFF tag left `{type:"solid"}` reaching
  // skShaderForPaint (which refuses an rgba array), and routing the glyph pass on
  // the PARSED paint while textStyle still routed on the RAW one made that same
  // run render blank instead. Neither is caught by "does it throw".
  const needsShader = {
    "modern linear": MODERN_LINEAR,
    "modern radial": MODERN_RADIAL,
    "legacy inline": LEGACY_INLINE,
    material: { type: "material", material: { id: "comic" } },
  };
  const noShader = {
    "solid object": { type: "solid", solid: "#123456" },
    OFF: { type: "none" },
    "bare string": "#f00",
    "rgba array": [1, 0, 0, 1],
  };
  for (const [n, c] of Object.entries(needsShader)) {
    assert.equal(isGradientPaint(parsePaint(c)) || c.type === "material", true,
      `${n}: the PARSED paint is a shader paint, so the glyph pass must repaint it`);
  }
  for (const [n, c] of Object.entries(noShader)) {
    const parsed = parsePaint(c);
    assert.equal(isGradientPaint(parsed), false,
      `${n}: parses to null or an rgba array — skShaderForPaint would REFUSE it, so no shader pass`);
  }
  assert.match(SRC, /const shader = runFillNeedsShader\(st\.color\)/, "textStyle asks the shared predicate");
  assert.match(SRC, /if \(!runFillNeedsShader\(fill\)\) return;/, "...and so does the glyph pass — one question, one answer");
});

test("(F) NO REGRESSION on the 2026-08-03 crossfade router (opPaintSlots still sees rich runs)", () => {
  const xf = { type: "crossfade", from: "#f00", to: "#00f", t: 0.5 };
  const op = { op: "text", rich: { runs: [{ text: "a", color: xf }] } };
  assert.deepEqual(opPaintSlots(op), [xf], "a rich run's colour is still a paint slot the router can see");
  assert.equal(opHasCrossfadePaint(op), true, "so a crossfading rich run is still split by the op-level router");
  // The two fixes are ORTHOGONAL: the router keeps a crossfade away from this leaf,
  // and the leaf now also understands one if it ever arrives.
  assert.equal(runInk(xf), "#00f", "and the leaf itself no longer dies on one either");
});

console.log(`\n${passed} textcrash tests passed.`);
