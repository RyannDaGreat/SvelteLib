/**
 * A DECORATED BOX's BORDER honors strokeOffset — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/crop_border_offset_test.js
 *
 * ── THE BUG THIS PINS ─────────────────────────────────────────────────────────
 * render_gpu/decorate.js's decorateStrokedBox wraps a box-like widget's content
 * (image/video/latex/svg/iconify/…) in a `cropSubtree` op so the SHARED
 * stroked-box render (rounded-corner clip + border ring) draws the widget's
 * "stroke"/"strokeWidth" row as a BORDER around the box. strokeOffset (the
 * -1..1 inner/outer alignment knob, stroke_offset_test.js) was declared on the
 * SAME bundle (strokedBorder) these widgets use and gets STAMPED onto the
 * cropSubtree op by ports.js's applyStrokeOffset seam — but three separate
 * gaps left it inert on this path specifically (plain shape ops — rect/
 * ellipse/path — were never affected):
 *   1. cropSubtree()'s OWN ir.js builder never normalized/spread strokeOffset
 *      onto the op it returns (only normalizeStrokeTrim ran) — so even a
 *      DIRECT cropSubtree({..., strokeOffset}) call silently dropped it.
 *   2. paint_skia's handleCropSubtree drew the border with a plain centered
 *      strokePaint()+drawRRect, never checking opStrokeIsOffset/calling the
 *      two-clipped-strokes construction (drawOffsetOpStroke) the plain shape
 *      ops already had.
 *   3. Same story in BOTH vector exporters: pdf_backend's emitCrop and
 *      svg_backend's emitCropSVG each drew one plain-width border stroke,
 *      never routing through their own offsetStrokePdfOps/offsetStrokeSVG.
 * Net effect (measured against a real SVG widget in this session): strokeOffset
 * -1/0/1 on an svg/image/video/latex/iconify widget's BORDER rendered pixel-
 * IDENTICAL regardless of the slider — "strokeOffset seems to change nothing"
 * on exactly the widgets that go through decorateStrokedBox.
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────────
 *   1. cropSubtree() itself carries a non-identity strokeOffset (and drops the
 *      identity, matching rect/ellipse/path).
 *   2. THE DECISIVE MEASUREMENT: pixels just inside/outside a cropSubtree's
 *      border, at offset -1/0/1 — and that it now matches a PLAIN rect's
 *      border pixel-for-pixel (same geometry, same offsets).
 *   3. BOTH vector exporters express the offset on a cropSubtree's border the
 *      same way they already did for a plain rect (byte-identical legacy at
 *      offset 0; the two-clipped-strokes construction at ±1).
 */
import assert from "assert";
import { createRequire } from "module";
import path from "path";
import { cropSubtree, rect, opStrokeIsOffset } from "../ir.js";
import { paintIR } from "../skia/paint_skia.js";
import { vectorCommandToSVG, emitCropSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

const fontCollection = (() => {
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(CanvasKit.TypefaceFontProvider.Make());
  return fc;
})();

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// ── 1. THE OP BOUNDARY ────────────────────────────────────────────────────────
test("cropSubtree carries a non-identity strokeOffset, and drops the identity", () => {
  const off = cropSubtree({ x: 0, y: 0, w: 10, h: 10, stroke: "#000", strokeWidth: 2, strokeOffset: -1, content: [] });
  assert.equal(off.strokeOffset, -1);
  const centered = cropSubtree({ x: 0, y: 0, w: 10, h: 10, stroke: "#000", strokeWidth: 2, strokeOffset: 0, content: [] });
  assert.ok(!("strokeOffset" in centered), "offset 0 must be dropped, like every other stroked op");
  const absent = cropSubtree({ x: 0, y: 0, w: 10, h: 10, stroke: "#000", strokeWidth: 2, content: [] });
  assert.ok(!("strokeOffset" in absent));
});

// ── 2. THE DECISIVE MEASUREMENT — pixels, cropSubtree border vs plain rect ────
const W = 400, H = 260;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const STROKE_W = 24;
const GUARD = 2;
const PROBE = 8;
const BOX = { x: 100, y: 60, w: 200, h: 140 };

function renderPixels(cmds) {
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("crop_border_offset_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cmds, VIEW, { background: "#ffffff", media: {}, fontCollection });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return px;
}
const isInk = (px, x, y) => { const i = (y * W + x) * 4; return px[i + 2] > 128 && px[i] < 128; };
function sideCounts(px, edgeX, rows) {
  let insideInk = 0, outsideInk = 0;
  for (const y of rows) {
    for (let d = GUARD; d < GUARD + PROBE; d++) {
      if (isInk(px, edgeX + d, y)) insideInk++;
      if (isInk(px, edgeX - d, y)) outsideInk++;
    }
  }
  return { insideInk, outsideInk };
}
const ROWS = [110, 130, 150];
const EDGE_X = BOX.x;

for (const o of [-1, 0, 0.5, 1]) {
  test(`cropSubtree border @ offset ${o} matches a plain rect's stroke on the same box`, () => {
    const rectCmd = rect({ ...BOX, cornerRadius: 0, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, ...(o === 0 ? {} : { strokeOffset: o }) });
    const cropCmd = cropSubtree({ ...BOX, cornerRadius: 0, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, content: [], ...(o === 0 ? {} : { strokeOffset: o }) });
    const rectPx = renderPixels([rectCmd]);
    const cropPx = renderPixels([cropCmd]);
    const rectCounts = sideCounts(rectPx, EDGE_X, ROWS);
    const cropCounts = sideCounts(cropPx, EDGE_X, ROWS);
    assert.deepStrictEqual(cropCounts, rectCounts, `offset ${o}: cropSubtree border=${JSON.stringify(cropCounts)} vs rect=${JSON.stringify(rectCounts)}`);
    // And a non-centered offset must actually MOVE the ink (the regression this
    // whole suite exists to catch: before the fix, every offset looked like offset 0).
    if (o !== 0) assert.notDeepStrictEqual(cropCounts, sideCounts(renderPixels([rect({ ...BOX, cornerRadius: 0, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W })]), EDGE_X, ROWS));
  });
}

test("cropSubtree @ offset 0 renders byte-identically to one built with no offset at all", () => {
  const a = renderPixels([cropSubtree({ ...BOX, cornerRadius: 0, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: 0, content: [] })]);
  const b = renderPixels([cropSubtree({ ...BOX, cornerRadius: 0, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, content: [] })]);
  assert.deepStrictEqual(Buffer.from(a), Buffer.from(b));
});

// ── 3. THE VECTOR EXPORTERS ────────────────────────────────────────────────────
function svgCtx() { let n = 0; const defs = []; return { nextId: (p) => `${p}${++n}`, addDef: (d) => defs.push(d), defs }; }
const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

test("SVG: a cropSubtree border at offset 0 is a plain stroke, no clip machinery", async () => {
  const ctx = svgCtx();
  const cmd = cropSubtree({ ...BOX, fill: null, stroke: "#00f", strokeWidth: STROKE_W, content: [] });
  const out = await emitCropSVG(cmd, WORLD, { view: {}, worldRect: {}, depth: 0, background: null }, ctx);
  assert.ok(out.includes(`stroke-width="${STROKE_W}"`));
  assert.equal(ctx.defs.length, 1, "only the content clip def — no offset-stroke clip at the identity");
});

test("SVG: a cropSubtree border at a fully INNER offset doubles the width and clips to the interior", async () => {
  const ctx = svgCtx();
  const cmd = cropSubtree({ ...BOX, fill: null, stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: -1, content: [] });
  const out = await emitCropSVG(cmd, WORLD, { view: {}, worldRect: {}, depth: 0, background: null }, ctx);
  assert.ok(out.includes(`stroke-width="${2 * STROKE_W}"`));
  assert.equal(ctx.defs.length, 2, "the content clip PLUS one offset-stroke clip");
  assert.ok(ctx.defs.some((d) => d.includes("<clipPath") && !d.includes("evenodd")));
});

test("PDF: a cropSubtree border at offset 0 emits its plain width and no clip", async () => {
  const cmd = cropSubtree({ ...BOX, fill: null, stroke: "#00f", strokeWidth: STROKE_W, content: [] });
  const bytes = await irToPDF([cmd], { width: W, height: H, view: VIEW, background: "#ffffff" });
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.includes(`${STROKE_W} w`));
});

test("PDF: a cropSubtree border at a fully OUTER offset doubles the width and clips with the even-odd sandwich", async () => {
  const cmd = cropSubtree({ ...BOX, fill: null, stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: 1, content: [] });
  const bytes = await irToPDF([cmd], { width: W, height: H, view: VIEW, background: "#ffffff" });
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.includes(`${2 * STROKE_W} w`));
  assert.ok(text.includes("W* n"));
});

test("opStrokeIsOffset gates the SAME way for a cropSubtree op as for a plain rect", () => {
  assert.equal(opStrokeIsOffset({ op: "cropSubtree" }), false);
  assert.equal(opStrokeIsOffset({ op: "cropSubtree", strokeOffset: 0 }), false);
  assert.equal(opStrokeIsOffset({ op: "cropSubtree", strokeOffset: -1 }), true);
});

console.log(`\ncrop_border_offset_test: ${passed} passed`);
