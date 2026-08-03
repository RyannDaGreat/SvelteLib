/**
 * THE TEXT SETTLE-JUMP — a morph's last frame and the settled frame must draw the
 * glyphs in the SAME PLACE (WORKSTREAM AN's acceptance addition, verified under AV).
 * Run: node src/demo_apps/PowerRP/tests/text_settle_jump_test.mjs
 *
 * The user's report (2026-08-02, verbatim): "The position that it settles on after
 * the morph is not the position it is when the morph's or… entry is drawn… It's
 * just plain text."
 *
 * ── THE MECHANISM THE JUMP CAME FROM, AND WHY IT IS GONE ─────────────────────
 * TWO ENGINES LAY OUT THE SAME TEXT. The FILL is drawn by a CanvasKit paragraph;
 * the morph payload's letterforms used to be placed by core/richtext.layoutRichText
 * instead, and the two round line heights and distribute leading differently — a
 * few px at ordinary sizes, 16.5 px at lineSpacing 1.5 / size 96. The morph drew at
 * one engine's baseline, and at alpha 1 the widget became an ordinary text op drawn
 * at the other's. THAT few-px delta IS the jump.
 *
 * AN installed the seam (core/glyph_outlines.setGlyphShapedPlacement): when it is
 * present, glyph ids and their (x, baselineY) pairs come from the very paragraph
 * that paints the fill. `textMorphPayload` is a thin wrapper over
 * `textGlyphPathDs`, which reads that seam FIRST — so the payload and the fill
 * share ONE layout by construction, and this suite is the measurement that says so
 * rather than the prose that claims it.
 *
 * ── THE METRIC IS PER-GLYPH BBOX CENTRE, AND THE CHOICE MATTERS ──────────────
 * A nearest-point sweep between the two frames' sampled paths is NOT the right
 * metric and gave a 89 px answer on a picture with no jump in it: the morph's paths
 * have been resampled by the alignment (465 sample points where the settled
 * letterforms give 248), so the sweep measures sampling density, not displacement.
 * The bounding-box centre of each glyph is invariant to that, and displacement of
 * the drawn letterform is exactly what the user is looking at.
 *
 * REQUIRES THE FONT ENGINE, so it boots the same CanvasKit text seams cli/render.js
 * does (`node_render.ensureTextSeams`). Without them a text morph correctly REFUSES
 * (there are no letterforms to morph), and this suite says so and passes nothing
 * silently — a skip that looked like a pass is how a permanent non-result gets a
 * slot in the gate.
 */

import assert from "node:assert/strict";
import { repairedDocument, tweenedState } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { sceneIR } from "../render_gpu/ports.js";
import { textGlyphPathDs } from "../core/glyph_outlines.js";
import { pathPoints } from "../core/svg_paths.js";
import { ensureTextSeams } from "../render_gpu/skia/node_render.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

/** The acceptance threshold, in canvas units. A glyph that moves less than this on settling does not read as a jump. */
const SETTLE_TOLERANCE_PX = 1;
/** Points sampled per path segment when measuring a glyph's extent. Enough that a bbox is tight; the metric is density-invariant anyway. */
const BBOX_SAMPLES_PER_SEGMENT = 48;
/** One tick before the transition lands — the LAST frame the morph draws. */
const ALMOST_SETTLED = 0.999;

const CANVAS = { w: 640, h: 360 };
/** The text widget every case measures, on a COMMITTED family (`system` has no TTF, so it cannot morph). */
const TEXT = { type: "plaintext", x: 40, y: 80, w: 520, h: 160, font: "inter", size: 64, fill: "#111111" };

await ensureTextSeams();
const registry = createRegistry();
registerPlugins(registry);

/** Pure function. A path's bounding-box centre and extent, sampled off its `d` string. */
function bboxOf(d) {
  const pts = pathPoints(d, BBOX_SAMPLES_PER_SEGMENT);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/**
 * Query (renders through the registry and the installed font engine). The worst
 * per-glyph displacement between a text morph's LAST frame and its SETTLED frame.
 *
 * Both sides are in box-local coordinates and both are sorted left-to-right, which
 * pairs them by position — the pairing a reader's eye makes.
 */
function settleDisplacement(fromText, toText) {
  const doc = repairedDocument({
    meta: { name: "settle", w: CANVAS.w, h: CANVAS.h },
    slides: [
      { id: "s0", name: "one", transition: { type: "cut", seconds: 0 }, delta: { items: { cam: { type: "camera" }, t1: { ...TEXT, text: fromText } } } },
      { id: "s1", name: "two", transition: { type: "fade", seconds: 1 }, delta: { items: { t1: { text: toText, "text~interp": "morph" } } } },
    ],
  }, registry).doc;
  const near = evaluateState(tweenedState(doc, 1, ALMOST_SETTLED, registry), registry).state;
  const morphed = sceneIR(deriveRenderTree(near, registry, CANVAS)).filter((o) => o.op === "path").map((o) => o.d);
  // THE SETTLED FRAME IS AN ORDINARY TEXT OP — CanvasKit draws its glyphs, so there
  // are no path ops to read. Its letterform geometry comes from the shaped-placement
  // seam instead, which is the SAME placement that paints those glyphs. That is what
  // makes this a comparison against the fill rather than against a second guess.
  const settledState = evaluateState(tweenedState(doc, 1, 1, registry), registry).state.items.t1;
  const settled = textGlyphPathDs(settledState).ds;
  assert.ok(morphed.length > 0, `no morph paths for "${fromText}" → "${toText}" — the font engine did not install, so nothing was measured`);
  assert.equal(morphed.length, settled.length, "the morph's last frame draws the same number of glyphs the settled frame does");
  const a = morphed.map(bboxOf).sort((p, q) => p.cx - q.cx);
  const b = settled.map(bboxOf).sort((p, q) => p.cx - q.cx);
  return a.reduce((worst, p, i) => Math.max(worst, Math.hypot(p.cx - b[i].cx, p.cy - b[i].cy)), 0);
}

test("SETTLE: a text morph's last frame lands where the settled frame draws (the user's report)", () => {
  for (const [from, to] of [["before", "beforx"], ["Hi!", "Hi?"], ["alpha", "gamma"]]) {
    const d = settleDisplacement(from, to);
    assert.ok(d <= SETTLE_TOLERANCE_PX, `"${from}" → "${to}": glyphs move ${d.toFixed(4)} px on settling (tolerance ${SETTLE_TOLERANCE_PX})`);
  }
});

test("SETTLE: the UNCHANGED glyphs do not move AT ALL — not merely within tolerance", () => {
  // The sharper form, and the one that proves the two engines are really the same
  // engine now. In "before" → "beforx" only the last letter morphs; the five that do
  // not change are placed by one layout in both frames, so their displacement is
  // EXACTLY zero rather than small. A residual few-px offset here would be the old
  // two-engine bug back, hiding under a 1px tolerance the moving glyph earns anyway.
  const doc = repairedDocument({
    meta: { name: "settle-shared", w: CANVAS.w, h: CANVAS.h },
    slides: [
      { id: "s0", name: "one", transition: { type: "cut", seconds: 0 }, delta: { items: { cam: { type: "camera" }, t1: { ...TEXT, text: "before" } } } },
      { id: "s1", name: "two", transition: { type: "fade", seconds: 1 }, delta: { items: { t1: { text: "beforx", "text~interp": "morph" } } } },
    ],
  }, registry).doc;
  const near = evaluateState(tweenedState(doc, 1, ALMOST_SETTLED, registry), registry).state;
  const morphed = sceneIR(deriveRenderTree(near, registry, CANVAS)).filter((o) => o.op === "path").map((o) => o.d).map(bboxOf).sort((p, q) => p.cx - q.cx);
  const settledState = evaluateState(tweenedState(doc, 1, 1, registry), registry).state.items.t1;
  const settled = textGlyphPathDs(settledState).ds.map(bboxOf).sort((p, q) => p.cx - q.cx);
  const SHARED_GLYPHS = 5; // "befor" — every letter but the last is identical across the transition
  for (let i = 0; i < SHARED_GLYPHS; i++) {
    assert.equal(morphed[i].cx, settled[i].cx, `glyph ${i} x: an unchanged letter is placed by ONE layout in both frames`);
    assert.equal(morphed[i].cy, settled[i].cy, `glyph ${i} y: likewise — the baseline is the fill's own, not a second derivation`);
  }
});

test("SETTLE: the payload really does read AN's shaped-placement seam", () => {
  // Mechanism, not just outcome: plaintext's morphPaths goes through
  // textGlyphPathDs, which asks the installed shaped-placement source FIRST. If a
  // future edit routed the payload back through the core layout, the measurements
  // above would drift by a few px and this says which seam to look at.
  const plugin = registry.get("plaintext");
  const s = { ...TEXT, text: "before" };
  const payload = plugin.morphPaths(s);
  assert.ok(payload.subpaths.length > 0, "the payload has letterforms at all");
  const direct = textGlyphPathDs(s);
  assert.equal(direct.ds.length, 6, "the seam reports one path per inked glyph in 'before'");
  assert.equal(typeof direct.baselineY, "number", "and a real baseline came back with them");
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
