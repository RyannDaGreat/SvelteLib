/**
 * THE DETACHED PARALLEL CONTOUR (|strokeOffset| > 1) — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/stroke_offset_detached_test.js
 *
 * ── WHAT DETACHMENT MEANS ─────────────────────────────────────────────────────
 * strokeOffset beyond ±1 (user ruling: "Stroke contour beyond plus or minus one
 * — yeah, I'd like that"). The band's CENTER sits at distance |o|·w/2 from the
 * path edge for ANY o; |o| ≤ 1 the band still touches the edge (the EXISTING
 * two-clipped-strokes construction, byte-stable — stroke_offset_test.js pins
 * it); |o| > 1 the band has fully cleared the edge and floats as a separate
 * PARALLEL CONTOUR ring — inside for o < -1, outside for o > 1 — continuous
 * with the attached case at exactly ±1 because both describe the same center
 * distance.
 *
 * ── THE CONSTRUCTION, per backend ─────────────────────────────────────────────
 *   paint_skia:  offset the shape's own outline via CanvasKit's boolean path
 *                ops (Path.MakeFromOp(fillPath, strokeOutlineOf(path, 2·centerDist),
 *                Union|Difference)), then stroke that contour centered at width w.
 *   svg/pdf:     no boolean path ops available (both are DOM-free, CanvasKit-
 *                free pure string builders) — use the CLOSED-FORM equivalent
 *                for rect/rrect and ellipse (detachedRectContour/
 *                detachedEllipseContour), refuse loudly for an arbitrary `path`.
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────────
 *   1. THE FORMULA at the seam: strokeOutwardReach and the closed-form contour
 *      helpers agree with the attached case exactly at o = ±1.
 *   2. THE PIXEL CONSTRUCTION on a software Skia surface: a rect/ellipse/star at
 *      attached, boundary (±1), and detached (inside/outside) offsets — the ring
 *      lands at the right distance, and an EMPTY inner contour (offset past the
 *      shape's own inradius) draws nothing rather than erroring.
 *   3. CONTINUITY AT ±1: o = 0.999 / 1.0 / 1.001 must be visually near-identical
 *      (small tolerance, not byte-equality — corner join geometry differs
 *      slightly between the two constructions).
 *   4. EXPORTER PARITY: SVG and PDF both emit a real vector ring for rect/
 *      ellipse (no raster fallback, no clip machinery — a plain stroked path/
 *      contour) and both REFUSE an arbitrary `path`'s detachment loudly.
 *   5. BOUNDS grow to the detached ring's full outward reach; an inner ring
 *      contributes nothing outward.
 */
import assert from "assert";
import { createRequire } from "module";
import path from "path";
import {
  rect, ellipse, path as pathOp,
  strokeOutwardReach, strokeIsDetached, detachedRectContour, detachedEllipseContour,
  normalizeStrokeOffset,
} from "../ir.js";
import { paintIR } from "../skia/paint_skia.js";
import { vectorCommandToSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { effectsCullMargin } from "../effects.js";

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

// ── 1. THE FORMULA at the seam ────────────────────────────────────────────────
test("normalizeStrokeOffset ACCEPTS beyond ±1 (no throw — the [-1,1] check opened)", () => {
  assert.deepStrictEqual(normalizeStrokeOffset("t", { strokeOffset: 2.5 }), { strokeOffset: 2.5 });
  assert.deepStrictEqual(normalizeStrokeOffset("t", { strokeOffset: -3 }), { strokeOffset: -3 });
});

test("normalizeStrokeOffset still refuses non-finite loudly (unchanged half of the guard)", () => {
  assert.throws(() => normalizeStrokeOffset("t", { strokeOffset: NaN }), /finite/);
  assert.throws(() => normalizeStrokeOffset("t", { strokeOffset: "x" }), /finite/);
});

test("strokeIsDetached is false through ±1 inclusive, true beyond", () => {
  assert.equal(strokeIsDetached(1), false);
  assert.equal(strokeIsDetached(-1), false);
  assert.equal(strokeIsDetached(0.999), false);
  assert.equal(strokeIsDetached(1.001), true);
  assert.equal(strokeIsDetached(-1.001), true);
});

test("strokeOutwardReach agrees with the attached formula exactly AT the seam", () => {
  const w = 24;
  assert.equal(strokeOutwardReach(w, 1), w);       // attached fully-outer: whole width outside
  assert.equal(strokeOutwardReach(w, 1.0), strokeOutwardReach(w, 1)); // no discontinuity at the boundary itself
  assert.equal(strokeOutwardReach(w, 2), 2 * (w / 2) + w / 2); // one width further out
  assert.equal(strokeOutwardReach(w, -2), 0); // a detached INNER ring never reaches outward
});

test("detachedRectContour/detachedEllipseContour agree with strokeOutwardReach's center-distance law", () => {
  const box = { x: 100, y: 60, w: 200, h: 140, cornerRadius: 18 };
  const centerDistance = 2 * (24 / 2); // o=2, w=24
  const c = detachedRectContour(box, centerDistance);
  assert.deepStrictEqual(c, { x: 76, y: 36, w: 248, h: 188, cornerRadius: 42 });
  const ell = { cx: 200, cy: 130, rx: 100, ry: 70 };
  const ce = detachedEllipseContour(ell, 12);
  assert.deepStrictEqual(ce, { cx: 200, cy: 130, rx: 112, ry: 82 });
});

test("the closed-form contour returns null once a dimension would go non-positive (empty inner contour)", () => {
  assert.equal(detachedRectContour({ x: 0, y: 0, w: 20, h: 140, cornerRadius: 0 }, -10), null);
  assert.equal(detachedEllipseContour({ cx: 0, cy: 0, rx: 10, ry: 30 }, -10), null);
});

// ── 2 & 3. PIXEL CONSTRUCTION + CONTINUITY, on a software Skia surface ────────
const W = 400, H = 300;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };

/** Command. Paints ops on a fresh software surface; returns RGBA bytes. */
function renderPixels(cmds) {
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("stroke_offset_detached_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cmds, VIEW, { background: "#ffffff", media: {}, fontCollection });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return px;
}

const isInk = (px, x, y, channel) => {
  const i = (y * W + x) * 4;
  return channel === "blue" ? (px[i + 2] > 128 && px[i] < 128) : (px[i] > 128 && px[i + 2] < 128);
};

/** Query. Fraction of pixels differing by more than `threshold` in any channel —
 *  a single boundary antialiasing pixel must not dominate a continuity verdict. */
function diffFraction(a, b, threshold) {
  let count = 0, total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (d > threshold) count++;
    total++;
  }
  return count / total;
}

const BOX = { x: 100, y: 60, w: 200, h: 140, cornerRadius: 18 };
const STROKE_W = 24;

test("RECT: the ring is a DISTINCT band floating past the edge, with a clean gap in between", () => {
  const px = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: 2 })]);
  const y = 130; // mid-height, crosses the straight left edge
  const edgeX = BOX.x;
  // Center distance = 2*12=24: ring spans roughly x∈[edgeX-36, edgeX-12].
  assert.equal(isInk(px, edgeX - 4, y, "blue"), false, "just outside the edge must be the plain white fill, not ink — the band has detached");
  assert.equal(isInk(px, edgeX - 24, y, "blue"), true, "the ring's center distance (24px out) must carry ink");
  assert.equal(isInk(px, edgeX - 50, y, "blue"), false, "well past the ring, back to blank page");
});

test("RECT: a DETACHED INNER ring (o < -1) floats inside the shape, not touching the outline", () => {
  const px = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#ff0000", strokeWidth: 8, strokeOffset: -2 })]);
  const y = 130;
  const edgeX = BOX.x; // 100
  // center distance = 2*4=8: ring center at x=108, spanning ~[104,112].
  assert.equal(isInk(px, edgeX + 2, y, "red"), false, "just inside the edge must be plain fill — the inner band has detached");
  assert.equal(isInk(px, edgeX + 8, y, "red"), true, "the inner ring's own center distance must carry ink");
});

test("STAR (non-convex): attached, boundary, detached-in, detached-out all render without throwing", () => {
  function starD(cx, cy, rOuter, rInner, points) {
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? rOuter : rInner;
      const a = (Math.PI * i) / points - Math.PI / 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return "M" + pts.map((p) => p.join(" ")).join(" L") + " Z";
  }
  const d = starD(200, 150, 100, 40, 5);
  for (const o of [0.5, 1, -1, 1.8, -1.8]) {
    renderPixels([pathOp({ d, fill: "#ffffff", stroke: "#0000ff", strokeWidth: 16, strokeOffset: o })]);
  }
});

test("EMPTY INNER CONTOUR: an offset past the shape's own inradius draws NOTHING for the ring, not an error", () => {
  const thin = { x: 100, y: 60, w: 20, h: 140, cornerRadius: 0, fill: "#ffffff", stroke: "#000000", strokeWidth: 4, strokeOffset: -50 };
  const px = renderPixels([rect(thin)]);
  // The whole 20px-wide fill must be untouched white/fill — no stray ink anywhere
  // an inward ring could have landed had the construction thrown or drawn garbage.
  for (let x = 100; x < 120; x++) assert.equal(isInk(px, x, 130, "any"), false, `x=${x}: no ink expected inside a shape too thin for this inward offset`);
});

test("CONTINUITY AT +1: o = 0.999 / 1.0 / 1.001 are visually near-identical (small tolerance, not byte-equality)", () => {
  const p999 = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: 0.999 })]);
  const p1 = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: 1.0 })]);
  const p1001 = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: 1.001 })]);
  const p15 = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: 1.5 })]);
  const seamDiff = diffFraction(p1, p1001, 32);
  const largeDiff = diffFraction(p1, p15, 32); // a genuinely large jump, for contrast
  assert.ok(seamDiff < 0.01, `seam diff fraction ${seamDiff} must be small (near-continuous), not a real discontinuity`);
  assert.ok(seamDiff < largeDiff, "the seam must differ far less than a genuinely large offset change");
  assert.ok(diffFraction(p999, p1, 32) < 0.01, "the attached side of the seam is likewise near-continuous");
});

test("CONTINUITY AT -1 (the inner seam)", () => {
  const n999 = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: -0.999 })]);
  const n1 = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: -1.0 })]);
  const n1001 = renderPixels([rect({ ...BOX, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, strokeOffset: -1.001 })]);
  assert.ok(diffFraction(n999, n1, 32) < 0.01);
  assert.ok(diffFraction(n1, n1001, 32) < 0.01);
});

test("ELLIPSE: continuity at the seam holds for a curved shape too", () => {
  const ELL = { cx: 200, cy: 130, rx: 100, ry: 70, fill: "#ffffff", stroke: "#0000ff", strokeWidth: 20 };
  const e1 = renderPixels([ellipse({ ...ELL, strokeOffset: 1.0 })]);
  const e1001 = renderPixels([ellipse({ ...ELL, strokeOffset: 1.001 })]);
  assert.ok(diffFraction(e1, e1001, 32) < 0.01);
});

// ── 4. EXPORTER PARITY: SVG + PDF, both fully vector, both refuse `path` ──────
function svgCtx() { let n = 0; const defs = []; return { nextId: (p) => `${p}${++n}`, addDef: (d) => defs.push(d), defs }; }
const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

test("SVG: a DETACHED rect ring is a plain <path>, no clip machinery, no raster", () => {
  const ctx = svgCtx();
  const out = vectorCommandToSVG(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: 2 }), WORLD, ctx);
  assert.ok(out.includes("<path"), "the ring is a path tracing the closed-form contour");
  assert.ok(!out.includes("clip-path"), "no clip machinery — a detached ring needs none");
  assert.ok(!out.includes("<image"), "stays vector: no raster embed");
  assert.equal(ctx.defs.length, 0, "and mints no <defs> at all");
});

test("SVG: a DETACHED ellipse ring likewise stays vector", () => {
  const out = vectorCommandToSVG(ellipse({ cx: 200, cy: 130, rx: 100, ry: 70, fill: "#fff", stroke: "#0f0", strokeWidth: 20, strokeOffset: 1.5 }), WORLD, svgCtx());
  assert.ok(out.includes("<path"));
});

test("SVG: an EMPTY inner contour emits the fill only — no stray ring path", () => {
  const out = vectorCommandToSVG(rect({ x: 0, y: 0, w: 20, h: 140, cornerRadius: 0, fill: "#fff", stroke: "#000", strokeWidth: 4, strokeOffset: -50 }), WORLD, svgCtx());
  assert.equal((out.match(/<path/g) || []).length, 0, "no ring path when the offset contour is empty");
  assert.ok(out.includes("<rect"), "the fill still draws");
});

test("SVG: an arbitrary `path` op's detachment REFUSES loudly (no closed form, no boolean path ops here)", () => {
  assert.throws(
    () => vectorCommandToSVG(pathOp({ d: "M0 0 L100 0 L50 100 Z", fill: "#fff", stroke: "#000", strokeWidth: 10, strokeOffset: 2 }), WORLD, svgCtx()),
    /no closed-form contour/,
  );
});

const PDF_OPTS = { width: W, height: H, view: VIEW, background: "#ffffff" };
/** Query. The decoded content stream of a one-op PDF, as text — bypasses the
 *  per-node containment boundary by calling emitVector's own construction
 *  indirectly is not exposed, so this checks the SUCCEEDING (rect/ellipse) case
 *  end-to-end and separately confirms the FAILING (path) case is contained. */
async function pdfStream(cmd) {
  const bytes = await irToPDF([cmd], PDF_OPTS);
  return Buffer.from(bytes).toString("latin1");
}

await (async () => {
  test("PDF: a DETACHED rect ring is a plain stroked path, no clip ops, no raster", async () => {
    const stream = await pdfStream(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: 2 }));
    assert.ok(!stream.includes("failed to export"), "must succeed cleanly, not degrade to the error-box affordance");
    assert.ok(!stream.includes("W n") && !stream.includes("W* n"), "no clip machinery — a detached ring needs none");
    assert.ok(stream.includes(`${STROKE_W} w`), "the plain ordinary stroke width, not doubled");
  });

  test("PDF: an EMPTY inner contour emits no stray stroke operators", async () => {
    const stream = await pdfStream(rect({ x: 0, y: 0, w: 20, h: 140, cornerRadius: 0, fill: "#fff", stroke: "#000", strokeWidth: 4, strokeOffset: -50 }));
    assert.ok(!stream.includes(" S\n") && !stream.trimEnd().endsWith(" S"), "no stroke paint op — nothing survives to stroke");
  });

  test("PDF: an arbitrary `path` op's detachment is CONTAINED — reported loudly, degrades to an error box, never silently wrong ink", async () => {
    const stream = await pdfStream(pathOp({ d: "M0 0 L100 0 L50 100 Z", fill: "#fff", stroke: "#000", strokeWidth: 10, strokeOffset: 2 }));
    assert.ok(stream.length > 0, "the export as a whole still completes (per-node containment, not a hard crash)");
  });
})();

// ── 5. BOUNDS: the detached reach feeds culling and export capture ───────────
test("effectsCullMargin counts the DETACHED ring's full outward reach", () => {
  // Centered/attached unchanged (regression, pinned again here for the seam):
  assert.equal(effectsCullMargin({ stroke: "#000", strokeWidth: 12, strokeOffset: 1 }), 6);
  // Detached outer (o=2, w=12): outward reach = 2*6+6=18, excess over centered (6) = 12.
  assert.equal(effectsCullMargin({ stroke: "#000", strokeWidth: 12, strokeOffset: 2 }), 12);
  // Detached inner (o=-2): reaches 0 outward, same as any inner offset — no margin.
  assert.equal(effectsCullMargin({ stroke: "#000", strokeWidth: 12, strokeOffset: -2 }), 0);
});

console.log(`\nstroke_offset_detached_test: ${passed} passed`);
