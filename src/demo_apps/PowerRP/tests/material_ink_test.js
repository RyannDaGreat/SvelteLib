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
 *  (5) THE EQUATION PAINTER ACTUALLY PAINTS. Sections 1-4 are the predicate layer,
 *      and TWO REAL BUGS lived past it — `union.addPath` not existing (addPath is
 *      a PathBuilder method, not a Path one) and latexVector being routed into the
 *      SHAPE material path (its ink rides `fill`, but it is not a shape op). Both
 *      made every material equation fail, and no predicate assertion could see it.
 *      So this section RENDERS, on the bare-node software surface.
 *
 *      IT CHECKS PIXELS, NOT BYTE LENGTH, and that distinction is the lesson. A
 *      failed paint is CONTAINED as a red error box rather than thrown, and that
 *      box compresses LARGER than a correct render — so the obvious
 *      `png.length > blank.length` assertion passes on exactly the failure it
 *      exists to catch. Measured: both bugs sailed straight through it. The check
 *      is therefore on the error box's own red signature.
 *
 * Bare node throughout. Sections 1-4 need no CanvasKit; section 5 renders through
 * node_render's software surface (MathJax needs a DOM, but the PAINTER does not —
 * hand-built glyph `d` strings drive the real union-clip + shader path).
 *
 * Run: node src/demo_apps/PowerRP/tests/material_ink_test.js
 */

import assert from "node:assert/strict";
import { latexVector, text, isMaterialPaint, isGradientPaint, opHasMaterialFill, parsePaint } from "../render_gpu/ir.js";
import { isGradientOnlyPaint, styleNeedsGlyphPass } from "../render_gpu/skia/text_layout.js";
import { resolveMaterialFillPaints } from "../render_gpu/ports.js";
import { isShaderInk, inkColor } from "../plugins/latex.js";
import { readPng, imageDistance } from "./imageDistinctness.js";
import { latexPlugin } from "../plugins/latex.js";
import { plaintextPlugin } from "../plugins/plaintext.js";

const MATERIAL = { type: "material", material: { id: "metal", params: {} } };
const GRADIENT = { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } };
const SOLID = "#123456";
// The SAME colour in the other storage form: the PaintField's multi-sub-state
// wrapper, which remembers every mode at once so switching type never forgets.
// This is what an author's Fill row actually writes, and the shape that broke.
const WRAPPED_SOLID = { type: "solid", solid: SOLID };
const RADIAL = { type: "radialGradient", radial: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } };
// A fallback distinct from SOLID, so a test that silently returned the fallback
// instead of the ink's own colour cannot pass by coincidence.
const LEGACY_FALLBACK = "#abcdef";
const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

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

// ── (3b) THE USER'S MATRIX: every shape the Fill row can PRODUCE must paint ───
//
// User, 2026-08-02: "Why does solid result in unknown item failed to paint, but
// linear is fine, radial is fine, off is fine, and even arbitrary materials are
// fine on LaTeX?" — everything but the simplest case. The cause was that
// `isShaderInk` asked `typeof ink === "object"` rather than what kind of paint it
// is, and the PaintField stores a solid as the multi-sub-state WRAPPER
// {type:"solid", solid:"#rrggbb"}. That wrapper is an object, so it was routed to
// the shader path, where parsePaint correctly resolved it to a COLOUR and
// skShaderForPaint then refused it by name ("expected a gradient Paint (solid
// paints use setColor, not a shader)") — surfacing as the containment error box.
// Every other cell of the matrix was excluded for its own reason, which is exactly
// why only the simplest one broke.
//
// The matrix is written out cell by cell rather than as one predicate assertion
// because the bug was in the DISPATCH, and a dispatch is only correct if each
// input reaches a branch that can actually consume it.
for (const [label, ink] of [["legacy bare-string solid", SOLID], ["the PaintField's WRAPPED solid", WRAPPED_SOLID]]) {
  assert.equal(isShaderInk(ink), false,
    `${label} is a plain COLOUR, not a shader ink. Routing it to the mask path hands a solid to skShaderForPaint, which refuses it and paints the error box — the WORKSTREAM AB bug.`);
  assert.equal(inkColor(ink, LEGACY_FALLBACK), SOLID,
    `${label} must resolve to the same colour string: it is baked into the typeset SVG's \`color\` AND interpolated into the raster CACHE KEY, so an object here keys every equation under "[object Object]" and typesets at the browser default.`);
}
assert.equal(inkColor(SOLID, LEGACY_FALLBACK), inkColor(WRAPPED_SOLID, LEGACY_FALLBACK),
  "the two storage forms of a solid are the SAME picture — a document written before the Fill row was paint-capable must render byte-identically to one authored today");

// A non-solid takes its own path and only ever wants the neutral fallback. OFF is
// the case that proves this is not cosmetic: at the time of the fix an OFF ink was
// ALSO passed to the typesetter raw (it is not a shader, so it fell to the same
// branch), keying under "[object Object]" — a second latent cache collision the
// one unwrap closes.
for (const [label, ink] of [["a gradient", GRADIENT], ["a material", MATERIAL], ["OFF", { type: "none" }], ["an absent ink", undefined]])
  assert.equal(typeof inkColor(ink, LEGACY_FALLBACK), "string",
    `${label} must still yield a COLOUR STRING for the raster tint — latex_raster interpolates this into its cache key, which no object can survive`);

// The dispatch, end to end: what each ink is HANDED TO must be able to take it.
// A gradient is the only kind skShaderForPaint accepts; a material has its own
// builder; everything else is a colour and never reaches a shader at all.
for (const [label, ink] of Object.entries({
  "legacy bare solid": SOLID, "wrapped solid": WRAPPED_SOLID, "linear": GRADIENT,
  "radial": RADIAL, "off": { type: "none" }, "material": MATERIAL,
})) {
  if (!isShaderInk(ink)) continue;               // colour: raster-tint path, asserted above
  if (isMaterialPaint(ink)) continue;            // materialShaderForGlyphs
  assert.ok(isGradientOnlyPaint(parsePaint(ink)),
    `${label} reaches skShaderForPaint, which draws ONLY gradients — anything else throws there and becomes the "failed to paint" box`);
}

// PLAINTEXT carries the same wrapper through the same machinery (one session, one
// PaintField), so its `color` slot gets the same sweep. It parses rather than
// unwraps — a text op's colour goes straight to parsePaint, which knows the
// wrapper natively — so the assertion is that every cell PARSES, none throws.
for (const [label, ink] of Object.entries({
  "legacy bare solid": SOLID, "wrapped solid": WRAPPED_SOLID, "linear": GRADIENT,
  "radial": RADIAL, "off": { type: "none" }, "material": MATERIAL,
})) {
  const op = plaintextPlugin.emit({ text: "hi", w: 200, h: 60, fill: ink }, IDENTITY_WORLD).find((o) => o.op === "text");
  assert.ok(op, `plaintext must emit a text op for a ${label} fill`);
  assert.doesNotThrow(() => parsePaint(op.color),
    `a ${label} fill on plaintext must PARSE — this is the same PaintField shape that broke the equation, checked on the widget that shares its machinery`);
}
assert.deepEqual(parsePaint(plaintextPlugin.emit({ text: "hi", w: 200, h: 60, fill: WRAPPED_SOLID }, IDENTITY_WORLD).find((o) => o.op === "text").color),
  parsePaint(plaintextPlugin.emit({ text: "hi", w: 200, h: 60, fill: SOLID }, IDENTITY_WORLD).find((o) => o.op === "text").color),
  "plaintext's two solid forms must resolve to the identical colour, for the same back-compat reason the equation's do");

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

// ── (5) THE EQUATION PAINTER ACTUALLY PAINTS ─────────────────────────────────
//
// Everything above is the predicate layer, and TWO REAL BUGS lived past it — both
// of which made every material equation throw, and neither of which any predicate
// assertion could have caught:
//   · `union.addPath` does not exist (addPath is a PathBuilder method, not a Path
//     one), so the union threw "not a function".
//   · latexVector was being routed into the SHAPE material path, because its ink
//     rides `fill` and opHasMaterialFill reads exactly that — but it is not a
//     shape op, so shapeOpLocalBBox refused it by name.
// So this section RENDERS. MathJax needs a DOM, but the PAINTER does not: a
// hand-built latexVector with real glyph `d` strings drives the union-clip +
// shader path exactly as the app does, on the bare-node software surface.
//
// The first glyph carries a COUNTER (a hole). That is not decoration: it is what
// makes the winding claim checkable, since a boolean Union would dissolve it.

const { renderToPng } = await import("../render_gpu/skia/node_render.js");

const GLYPH_W = 400, GLYPH_H = 200;
const GLYPHS = [
  { d: "M10 10 L90 10 L90 90 L10 90 Z M30 30 L30 70 L70 70 L70 30 Z", fill: "#ffffff" }, // with counter
  { d: "M110 10 L190 10 L190 90 L110 90 Z", fill: "#ffffff" },
];
const inkOp = (fill) => resolveMaterialFillPaints(
  [latexVector({ ref: "r", x: 20, y: 20, w: 360, h: 160, glyphs: GLYPHS, viewBox: { minX: 0, minY: 0, w: 200, h: 100 }, ...(fill ? { fill } : {}) })],
  null, null)[0];
const render = async (fill) => renderToPng([inkOp(fill)], { zoom: 1, dpr: 1, panX: 0, panY: 0 }, { width: GLYPH_W, height: GLYPH_H });

// The "nothing painted" reference: the SAME op shaded pure white on white, so it
// isolates the ink and not the geometry (a no-op render would differ in size for
// reasons that have nothing to do with whether the shader ran).
const WHITE_ON_WHITE = { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#ffffff" }] } };
const blank = await render(WHITE_ON_WHITE);
const matPng = await render(MATERIAL);
const gradPng = await render(GRADIENT);

// A FAILED PAINT IS CONTAINED, NOT THROWN, which is why "it did not throw" proves
// nothing and why byte length is not a usable witness either: the paint-containment
// error box is a big red rectangle that compresses LARGER than a correct render, so
// a size comparison passes on exactly the failure it is meant to catch. Measured:
// both painter bugs sailed through a `matPng.length > blank.length` assertion.
//
// So the check is on PIXELS, and specifically on the error box's own signature. The
// containment affordance fills its rect with ERROR_BG (#f6c9c4) and frames it in
// ERROR_BORDER (#c0392b) — strongly red-dominant. A correctly-painted METAL
// equation is brass (red ≈ green, both well above blue), and a correct GRADIENT
// here is pink→cyan. Neither produces the error box's red-vs-green gap, so
// "is this the error box" is answerable directly and is the assertion that fails
// when the ink is dropped.
const mat = readPng(matPng);
const grad = readPng(gradPng);

/** Query. Mean [r, g, b] over every pixel of a decoded PNG — enough to tell the
 *  containment error box (strongly red-dominant) from any correct ink. */
function meanRgb(png) {
  let r = 0, g = 0, b = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) { r += png.data[4 * i]; g += png.data[4 * i + 1]; b += png.data[4 * i + 2]; }
  return [r / n, g / n, b / n];
}

/** How far the mean red may exceed the mean green before the picture is judged to
 *  be the paint-containment ERROR BOX rather than an equation. The box is
 *  #f6c9c4 on #c0392b — red leads green by ~45 and ~60 code values respectively,
 *  over most of the frame. A correct brass render has red ≈ green (measured gap
 *  under 15), so this sits between the two with room on both sides. */
const ERROR_BOX_RED_LEAD = 30;

for (const [label, png] of [["material", mat], ["gradient", grad]]) {
  const [r, g] = meanRgb(png);
  assert.ok(r - g < ERROR_BOX_RED_LEAD,
    `a ${label} equation rendered the paint-containment ERROR BOX (mean red ${r.toFixed(1)} leads green ${g.toFixed(1)}) — the ink was refused or threw. This is the assertion both painter bugs failed: union.addPath not existing, and latexVector being routed into the shape-material path.`);
}

// And it must actually be INK, not an untouched white frame.
assert.ok(imageDistance(mat, readPng(blank)).fraction > 0.05,
  "a MATERIAL equation must differ from the white-on-white reference over a real share of the frame — an identical picture means the shader never ran");
assert.ok(imageDistance(grad, readPng(blank)).fraction > 0.05, "a GRADIENT equation must too");
assert.ok(imageDistance(mat, grad).fraction > 0.05,
  "a material equation and a gradient equation must not render the same picture");

// Determinism: the same op twice is the same bytes. This is the Δt = 0 law applied
// to the ink — an animated material reads the clock inside its own packer, through
// the particleTime seam, so a frozen clock must give a frozen picture.
assert.deepEqual(await render(MATERIAL), matPng,
  "a material equation must render BYTE-IDENTICALLY twice — a second clock or any host input in the ink path would break frame-range sharding and export reproducibility");

console.log("material_ink_test: OK");
