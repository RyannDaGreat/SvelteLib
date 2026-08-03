/**
 * GLYPH STROKE gate (bare node) — the outline-around-the-letterforms half of
 * workstream N2 (user, 2026-08-02: "what if I want to be to have an outline around
 * the text itself? It's impossible for me to do that right now").
 *
 * WHAT THIS PINS, and why each one is worth a test rather than a reading:
 *
 *  (1) ABSENT-IS-LEGACY, which is the whole back-compat story and the only one of
 *      these that protects EVERY document ever written. A text or equation op with
 *      no outline keys must carry NO outline fields at all — not `glyphStroke:
 *      null`, not `glyphStrokeWidth: 0`, absent — because a key that appears
 *      unconditionally changes the op's JSON, and op JSON is what the render
 *      caches, the tests compare and the exporters branch on. This is pinned in
 *      both directions (asking for one must produce both keys) so a future
 *      "tidy-up" that always spreads them fails here rather than in a diff nobody
 *      reads.
 *
 *  (2) THE WIDTH IS THE GATE, not the paint. A named colour with width 0 draws
 *      nothing, exactly as `cmd.stroke && cmd.strokeWidth > 0` decides for every
 *      shape. Without this an author who set a colour and left the width alone
 *      would get an op carrying an outline the painter then declines to draw —
 *      harmless but dishonest, and it would defeat (1).
 *
 *  (3) THE OUTLINE RESOLVES. `glyphStroke` is a FOURTH material paint slot, after
 *      fill/stroke/color. Painters throw on an unresolved material by contract, so
 *      if ports.js does not know the slot the failure is a mid-paint exception on
 *      a real deck. Same class of bug the text ink had before N1 taught ports.js
 *      about `color`.
 *
 *  (4) THE EQUATION'S WIDTH CHANGES UNITS, and this is the subtle one. An author
 *      states canvas units; the painter strokes under the viewBox→box CTM, so the
 *      op must carry viewBox units. Get it wrong and the SAME "2" draws a hairline
 *      on a small equation and a slab on a large one — a width row that silently
 *      means something different per box size. The conversion is exercised at both
 *      aspect branches because they are different formulas.
 *
 *  (5) A GLYPH OUTLINE WIDENS THE INK, so the cull/capture margin must grow. A
 *      text widget's localBounds is its laid-out ink rect, and the outline sits
 *      OUTSIDE that rect — so heavy outlined type near the viewport edge would be
 *      culled, or clipped out of an exported PNG, exactly the defect the box-stroke
 *      term in that function was added to fix.
 *
 *  (6) THE LETTERFORMS ARE SHARED WITH THE MORPH. The outline is stroked on the
 *      paths core/glyph_outlines.textGlyphPathDs produces, and so is the morph
 *      payload. One derivation means an outline cannot drift off the type; this
 *      pins that they really are one call, not two that agree today.
 *
 * BARE NODE by design: all six are pure-function facts about the IR and the
 * geometry, so none of them needs a GPU, a browser or a surface. The PIXEL proof
 * that an outline actually appears lives in the CLI render the commit message
 * records; what cannot be checked by rendering once is that the op stays
 * byte-identical when the feature is unused, which is (1).
 */

import assert from "node:assert/strict";
import { text, latexVector } from "../render_gpu/ir.js";
import { effectsCullMargin } from "../render_gpu/effects.js";
import { resolveMaterialFillPaints } from "../render_gpu/ports.js";
import { latexBoxToViewBoxScale } from "../plugins/latex.js";
import { plaintextPlugin } from "../plugins/plaintext.js";

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

const VIEW_BOX = { minX: 0, minY: 0, w: 1000, h: 500 };
const latexArgs = (extra) => latexVector({
  ref: "r", x: 0, y: 0, w: 100, h: 50, glyphs: [{ d: "M0 0L10 0L10 10Z", fill: "#000" }],
  viewBox: VIEW_BOX, ...extra,
});

// ── (1) + (2) absent-is-legacy, and the WIDTH is the gate ────────────────────

check("a text op with no outline carries NEITHER key — byte-identical legacy", () => {
  const op = text({ text: "hi", x: 0, y: 0, size: 36, color: "#000" });
  assert.ok(!("glyphStroke" in op), "glyphStroke must be ABSENT, not null");
  assert.ok(!("glyphStrokeWidth" in op), "glyphStrokeWidth must be ABSENT, not 0");
});

check("an equation op with no outline carries NEITHER key", () => {
  const op = latexArgs({});
  assert.ok(!("glyphStroke" in op), "glyphStroke must be ABSENT");
  assert.ok(!("glyphStrokeWidth" in op), "glyphStrokeWidth must be ABSENT");
});

check("asking for an outline produces BOTH keys, on both widgets", () => {
  const t = text({ text: "hi", x: 0, y: 0, size: 36, color: "#000", glyphStroke: "#f00", glyphStrokeWidth: 3 });
  assert.equal(t.glyphStrokeWidth, 3);
  assert.ok(t.glyphStroke, "a text outline paint must survive onto the op");
  const l = latexArgs({ glyphStroke: "#f00", glyphStrokeWidth: 3 });
  assert.equal(l.glyphStrokeWidth, 3);
  assert.ok(l.glyphStroke, "an equation outline paint must survive onto the op");
});

check("a colour with ZERO width is no outline — the width is the gate", () => {
  const op = text({ text: "hi", x: 0, y: 0, size: 36, color: "#000", glyphStroke: "#f00", glyphStrokeWidth: 0 });
  assert.ok(!("glyphStroke" in op), "a zero-width outline must not reach the op at all");
});

// ── (3) the outline is a FOURTH material paint slot ──────────────────────────

check("a MATERIAL outline is resolved by ports.js (painters throw on absence)", () => {
  const op = text({
    text: "hi", x: 0, y: 0, size: 36, color: "#000",
    glyphStroke: { type: "material", material: { id: "comic" } }, glyphStrokeWidth: 4,
  });
  const [out] = resolveMaterialFillPaints([op], null, null);
  assert.ok(out.glyphStroke.resolvedParams, "a material outline must arrive at the painter RESOLVED");
});

check("a SOLID outline is left untouched by resolution (absent-is-legacy at that seam too)", () => {
  const op = text({ text: "hi", x: 0, y: 0, size: 36, color: "#000", glyphStroke: "#f00", glyphStrokeWidth: 4 });
  const [out] = resolveMaterialFillPaints([op], null, null);
  assert.equal(out, op, "a solid outline must not even re-allocate the op");
});

// ── (4) the equation's width changes UNITS ───────────────────────────────────

check("box→viewBox width conversion, preserveAspect (fitBox's uniform scale)", () => {
  // 1000x500 viewBox fit into 100x50: 10 viewBox units per box unit.
  assert.equal(latexBoxToViewBoxScale(VIEW_BOX, 100, 50, true), 10);
  // A TALLER box is still limited by width — fitBox takes the MIN.
  assert.equal(latexBoxToViewBoxScale(VIEW_BOX, 100, 200, true), 10);
});

check("box→viewBox width conversion, stretched (the geometric mean of the two axes)", () => {
  // 10 across and 5 down; the mean preserves stroke AREA under the anisotropic map.
  assert.equal(latexBoxToViewBoxScale(VIEW_BOX, 100, 100, false), Math.sqrt(50));
});

check("a stated canvas width really lands as viewBox units on the op", () => {
  // The whole point: 2 canvas units on a 10x-scaled equation is 20 viewBox units,
  // so the outline reads the same weight whatever size the box is.
  const scale = latexBoxToViewBoxScale(VIEW_BOX, 100, 50, true);
  const op = latexArgs({ glyphStroke: "#f00", glyphStrokeWidth: 2 * scale });
  assert.equal(op.glyphStrokeWidth, 20);
});

// ── (5) the outline widens the ink ───────────────────────────────────────────

check("a glyph outline extends the cull/capture margin by its HALF-width", () => {
  assert.equal(effectsCullMargin({ glyphStroke: "#000", glyphStrokeWidth: 10 }), 5);
});

check("no outline, no margin — every existing widget's reach is unchanged", () => {
  assert.equal(effectsCullMargin({}), 0);
  assert.equal(effectsCullMargin({ glyphStrokeWidth: 10 }), 0, "a width with no paint draws nothing");
  assert.equal(effectsCullMargin({ glyphStroke: "#000" }), 0, "a paint with no width draws nothing");
});

check("the outline margin does not SHRINK a bigger effect halo", () => {
  // Math.max over the terms: a wide bloom still wins over a thin outline.
  assert.equal(effectsCullMargin({ bloom: { radius: 5, strength: 1 }, glyphStroke: "#000", glyphStrokeWidth: 2 }), 15);
});

// ── (6) the letterforms are the morph's letterforms ──────────────────────────

check("plaintext emits the outline it was given, and omits one it was not", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const bare = plaintextPlugin.emit({ text: "hi", w: 100, h: 40 }, null, world);
  assert.ok(!("glyphStroke" in bare[0]), "an un-outlined box must emit the legacy op");
  const lined = plaintextPlugin.emit(
    { text: "hi", w: 100, h: 40, glyphStroke: "#f00", glyphStrokeWidth: 5 }, null, world);
  assert.equal(lined[0].glyphStrokeWidth, 5, "the outline must reach the op the painter reads");
});

check("the outline and the morph read ONE letterform derivation, not two", async () => {
  // Structural, not numeric: textMorphPayload is a wrapper over textGlyphPathDs, so
  // the stroke geometry and the morph geometry cannot diverge. Pinning the wiring
  // is what makes that true tomorrow as well as today — a re-implementation of
  // either that stopped sharing would leave the outline drifting off the type at
  // some font/size the tests do not enumerate.
  const mod = await import("../core/glyph_outlines.js");
  assert.equal(typeof mod.textGlyphPathDs, "function", "the shared layout seam must be exported");
  assert.ok(
    mod.textMorphPayload.toString().includes("textGlyphPathDs"),
    "textMorphPayload must DELEGATE to textGlyphPathDs rather than lay text out a second way",
  );
});

console.log(`glyph_stroke_test: ${checks} checks passed`);
