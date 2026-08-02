/**
 * MATERIAL / SHADER INK gate (bare node) — the TEXT and EQUATION halves of the
 * fill-material work (workstream N1: "give text a fill material… also for
 * equations?").
 *
 * WHAT THIS PINS, and each one is a thing that failed or would have failed
 * silently rather than loudly:
 *
 *  (1) A MATERIAL PAINT IS NOT A GRADIENT. `isGradientPaint` is deliberately the
 *      broad "object ⇒ needs a shader" test, so it answers TRUE for a material.
 *      Before the split, a material ink therefore reached skShaderForPaint, which
 *      reads `paint.stops.map` — a TypeError mid-paint. isGradientOnlyPaint is the
 *      qualifier; this pins BOTH directions, because a split that lost the
 *      gradient case would break gradient text just as thoroughly.
 *
 *  (2) THE INK RESOLVES. A text op carries its paint on `color` (not `fill`), and
 *      a rich op per-RUN. Those slots were invisible to ports.js
 *      resolveMaterialFillPaints, so a material ink reached the painter with no
 *      resolvedParams — the same class of failure a material camera background had
 *      before resolvedBackgroundFill. Painters throw on absence by contract, so
 *      this is the seam that keeps them from ever having to.
 *
 *  (3) ABSENT-IS-LEGACY, which is the whole back-compat story. A solid ink must be
 *      untouched at every seam: no `fill` key on the op, no resolution, no glyph
 *      pass. If any of these starts firing for a plain colour, every document ever
 *      written re-renders.
 *
 *  (4) A SHADER INK REACHES THE EXPORTERS AS A RASTER. The material case routes
 *      itself (the ink rides `fill`, which opHasMaterialFill reads). The GRADIENT
 *      case does NOT, and that gap was invisible: the vector branch would emit each
 *      glyph at its own fill, which for a shader ink is the neutral WHITE the mask
 *      raster was typeset at — a white equation on a white page. This pins the gate
 *      that sends both to raster.
 *
 * Bare node, no CanvasKit: every assertion here is about the PURE predicate and op
 * layer, which is where all four defects actually lived. The pixels are proven
 * separately by cli/render.js rendering material text on the software surface.
 *
 * Run: node src/demo_apps/PowerRP/tests/material_ink_test.js
 */

import assert from "node:assert/strict";
import { latexVector, text, isMaterialPaint, isGradientPaint, opHasMaterialFill } from "../render_gpu/ir.js";
import { isGradientOnlyPaint, styleNeedsGlyphPass } from "../render_gpu/skia/text_layout.js";
import { resolveMaterialFillPaints } from "../render_gpu/ports.js";
import { isShaderInk } from "../plugins/latex.js";
import { latexPlugin } from "../plugins/latex.js";
import { plaintextPlugin } from "../plugins/plaintext.js";

const MATERIAL = { type: "material", material: { id: "metal", params: {} } };
const GRADIENT = { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } };
const SOLID = "#123456";

// ── (1) a material is not a gradient, and a gradient is still a gradient ──────

assert.equal(isGradientPaint(MATERIAL), true,
  "precondition: isGradientPaint is the BROAD object test and DOES answer true for a material — if this ever flips, isGradientOnlyPaint's reason for existing is gone and the split should be revisited, not silently kept");
assert.equal(isGradientOnlyPaint(MATERIAL), false,
  "a material must NOT be treated as a gradient: skShaderForPaint would read paint.stops.map on a paint with no stops (a TypeError mid-paint)");
assert.equal(isGradientOnlyPaint(GRADIENT), true, "a real gradient must still take the gradient path");
assert.equal(isGradientOnlyPaint(SOLID), false, "a solid is neither");

// Both shader kinds need the glyph pass (the Paragraph cannot carry any shader);
// a plain solid must keep the byte-identical drawParagraph-only fast path.
assert.equal(styleNeedsGlyphPass({ color: MATERIAL }), true, "a material ink needs the glyph pass");
assert.equal(styleNeedsGlyphPass({ color: GRADIENT }), true, "a gradient ink needs the glyph pass");
assert.equal(styleNeedsGlyphPass({ color: SOLID }), false,
  "a SOLID run must NOT take the glyph pass — that is the fast path every existing document renders through");
assert.equal(styleNeedsGlyphPass({}), false, "an absent colour is the fast path too");

// ── (2) the text ink slots resolve ───────────────────────────────────────────

const resolvedText = resolveMaterialFillPaints([{ op: "text", color: MATERIAL }], null, null)[0];
assert.ok(resolvedText.color.resolvedParams,
  "a text op's `color` is a PAINT SLOT: unresolved, it reaches the painter with no resolvedParams and throws by contract");

const resolvedRuns = resolveMaterialFillPaints(
  [{ op: "text", rich: { runs: [{ text: "a", color: MATERIAL }, { text: "b", color: SOLID }], paras: [{}] } }], null, null)[0];
assert.ok(resolvedRuns.rich.runs[0].color.resolvedParams, "a RICH run's per-run material ink resolves too");
assert.equal(resolvedRuns.rich.runs[1].color, SOLID, "a solid run beside a material one is untouched");

// ── (3) absent-is-legacy, at every seam ──────────────────────────────────────

const plainOp = { op: "text", color: SOLID };
assert.equal(resolveMaterialFillPaints([plainOp], null, null)[0], plainOp,
  "a solid-ink op must pass through IDENTICALLY (same object) — resolution is zero-cost on the common path");

const vectorArgs = { ref: "r", x: 0, y: 0, w: 4, h: 2, glyphs: [{ d: "M0 0L1 1", fill: "#000" }], viewBox: { minX: 0, minY: 0, w: 1, h: 1 } };
assert.equal("fill" in latexVector(vectorArgs), false,
  "a latexVector with a plain ink must carry NO `fill` key at all — an added key is a changed op, and every backend's `if (cmd.fill)` would start firing");
assert.deepEqual(latexVector({ ...vectorArgs, fill: MATERIAL }).fill, MATERIAL,
  "a shader ink rides the op's `fill` slot (which is what routes it to the exporters' raster fallback)");

for (const [label, ink] of [["solid string", "#000000"], ["absent", undefined], ["OFF", { type: "none" }]])
  assert.equal(isShaderInk(ink), false, `${label} ink is NOT a shader ink — it must keep the legacy raster-tint path`);
for (const [label, ink] of [["material", MATERIAL], ["gradient", GRADIENT]])
  assert.equal(isShaderInk(ink), true, `${label} ink IS a shader ink`);

// The latex ink row is PAINT-capable — that flag alone is what mounts a
// PaintField (with its Mat tab) instead of a plain ColorField.
const inkRow = latexPlugin.inspector.find((r) => r.key === "ink");
assert.ok(inkRow, "the latex plugin must still declare an `ink` row");
assert.equal(inkRow.paint, true,
  "`paint: true` IS the material-capability declaration: without it the row is a plain ColorField and materials are unreachable from the UI");
assert.equal(inkRow.kind, "color", "a paint row is still a color-kind row");

// The same is true of plaintext's fill, which is where text materials are chosen.
const fillRow = plaintextPlugin.inspector.find((r) => r.key === "fill");
assert.ok(fillRow, "the plaintext plugin must still declare a `fill` row");
assert.equal(fillRow.paint, true, "plaintext's ink row must be paint-capable for the same reason");

// ── (4) a shader ink reaches the exporters as a raster ───────────────────────

assert.equal(opHasMaterialFill(latexVector({ ...vectorArgs, fill: MATERIAL })), true,
  "a MATERIAL equation routes to the exporters' raster fallback for free — the ink rides `fill`, which is exactly what opHasMaterialFill reads");
assert.equal(opHasMaterialFill(latexVector({ ...vectorArgs, fill: GRADIENT })), false,
  "a GRADIENT equation is NOT caught by the material gate — this is the gap reportLatexShaderInkRaster exists to close, and pinning it here is what keeps that reason legible");
assert.equal(opHasMaterialFill(latexVector(vectorArgs)), false, "a plain equation stays fully vector");

// The gate both backends actually apply, stated as the predicate they share.
const needsRaster = (cmd) => cmd.op === "latexVector" && !!cmd.fill;
assert.equal(needsRaster(latexVector({ ...vectorArgs, fill: GRADIENT })), true,
  "a gradient equation MUST rasterize: the vector branch would emit its glyphs at the neutral WHITE mask colour — invisible on a white page, and silently so");
assert.equal(needsRaster(latexVector({ ...vectorArgs, fill: MATERIAL })), true, "a material equation rasterizes too");
assert.equal(needsRaster(latexVector(vectorArgs)), false, "a solid-ink equation stays vector, which is the whole point of latexVector");

// A text op with a material ink is still a valid op (the builder parses the paint
// through parsePaint rather than rejecting it as an unknown colour).
assert.equal(isMaterialPaint(text({ text: "x", x: 0, y: 0, size: 12, color: MATERIAL }).color), true,
  "the text op builder must carry a material ink through parsePaint intact");

console.log("material_ink_test: OK");
