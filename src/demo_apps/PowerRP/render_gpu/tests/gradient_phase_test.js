/**
 * THE GRADIENT PHASE OPTION — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/gradient_phase_test.js
 *
 * User ruling: "the gradients have a wavelength option, but they don't have a
 * phase option. All gradients should have a phase option." Today only the LINEAR
 * gradient carries a wavelength (radialGradient has no wavelength field at all —
 * confirmed by grep across render_gpu/, core/, web/ — so "every gradient kind that
 * has wavelength" is exactly ONE kind), so phase is added beside it there.
 *
 * ── THE SEMANTICS ─────────────────────────────────────────────────────────────
 * phase shifts where the ramp's cycle starts, in WAVELENGTH UNITS. It folds in at
 * the SAME seam wavelength already uses (render_gpu/ir.js linearGradientRender),
 * so all three backends (Skia shader, SVG <linearGradient>, PDF axial shading)
 * agree by construction — there is exactly one place phase could disagree between
 * them, and this suite is what proves it doesn't.
 *
 * A mirror-tiled ramp (wavelength ≠ 1) reflects there-and-back, so its rendered
 * PERIOD along the axis is 4·wavelength·half (two ramp segments — "there" and the
 * reflected "back"). phase is a fraction of THAT period: phase=1 shifts the center
 * by one whole period, which reproduces the IDENTICAL picture (proven below by
 * literal pixel comparison, not just the endpoint formula) — "phase 1.0 = shifted
 * one full wavelength = identical" (user ruling). phase=0 is the default and is
 * ABSENT from a fresh paint (the house default-fill pattern), so it renders
 * byte-identically to every gradient authored before this feature existed.
 *
 * PHASE WRAPS EVERY WHOLE CYCLE AT ANY WAVELENGTH (user ruling: "zero degrees
 * should mean nothing and 360 should mean full phase... they should loop back
 * around every 360 degrees, but it doesn't do that on every object").
 * linearGradientRender takes `phase mod 1` before applying the shift, on both the
 * mirror path (wavelength ≠ 1) and the CLAMP path (the default wavelength = 1,
 * which has no mirror period of its own — an unwrapped phase there never
 * returned to identity, the gap this suite now closes). A negative phase wraps
 * the same way (−0.25 ≡ 0.75).
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────────
 *   1. phase ABSENT / phase=0 renders BYTE-IDENTICAL pixels to a paint that omits
 *      the field entirely (the standing "byte-identical at default" regression
 *      rule, proven by reading pixels, not trusted from the formula).
 *   2. phase SHIFTS the pattern by the expected fraction — read directly off a
 *      single-axis ramp's pixel colors.
 *   3. phase=1 reproduces phase=0's pixels EXACTLY under mirror tiling (the
 *      identity claim in the ruling), and phase=0.5 (a half-period shift) does
 *      NOT — it is provably the most different a shift can make the picture,
 *      which is why the period (not the single-segment length) had to be the
 *      phase unit.
 *   4. PDF/SVG PARITY for a nonzero phase: the vector shading's Coords / the SVG
 *      <linearGradient> endpoints must be the SAME centered, shifted axis
 *      linearGradientRender computes for Skia — the existing parity-gate pattern
 *      (render_gpu/tests/stroke_offset_test.js).
 *   5. parsePaint validates phase loudly (a non-finite/non-number phase throws).
 *   6. phase=1/2/−1 are IDENTITY at wavelength=1 too (the clamp path), and a
 *      negative phase wraps to the same picture as its positive equivalent
 *      (−0.25 ≡ 0.75) at both wavelength=1 and wavelength=0.5.
 */
import assert from "assert";
import { createRequire } from "module";
import path from "path";
import { rect, linearGradientRender, parsePaint } from "../ir.js";
import { paintIR } from "../skia/paint_skia.js";
import { gradientDefSVG, fmt } from "../svg_backend.js";
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

// ── 5. VALIDATION: parsePaint is loud about a bad phase ──────────────────────
test("parsePaint throws loudly on a non-finite/non-number phase", () => {
  const bad = (phase) => () => parsePaint({ type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], angle: 0, phase } });
  assert.throws(bad(NaN), /finite/);
  assert.throws(bad("shift"), /finite/);
  assert.throws(bad(Infinity), /finite/);
});

test("an absent phase parses to the default (0), exactly like an absent wavelength parses to 1", () => {
  const p = parsePaint({ type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], angle: 0 } });
  assert.equal(p.phase, 0, "parsePaint fills the quiet default (0), the house default-fill pattern");
  assert.equal(p.wavelength, 1);
  assert.equal(linearGradientRender(p).mirror, false);
});

// ── 1 & 2: linearGradientRender's OWN formula, at the endpoint level ─────────
test("phase=0 (or absent) is IDENTITY — same endpoints as before the feature", () => {
  const base = { from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } };
  const withGrad = { ...base, center: { x: 0.5, y: 0.5 }, wavelength: 0.5 };
  const noPhase = linearGradientRender(withGrad);
  const zeroPhase = linearGradientRender({ ...withGrad, phase: 0 });
  assert.deepStrictEqual(noPhase, zeroPhase);
});

test("phase shifts the center by phase·(4·wavelength·half) — the mirror period", () => {
  const base = { from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, center: { x: 0.5, y: 0.5 }, wavelength: 0.5 };
  const p0 = linearGradientRender(base);
  const p03 = linearGradientRender({ ...base, phase: 0.25 }); // fractional, exact in binary float: no wrap, exercises the plain shift formula
  const period = 4 * 0.5 * 0.5; // 4·w·half, half = (to-from)/2 = 0.5
  assert.equal(p03.from.x - p0.from.x, 0.25 * period);
  assert.equal(p03.to.x - p0.to.x, 0.25 * period);
  assert.equal(p03.mirror, true);
});

test("phase=1/2/-1 WRAP to phase=0's endpoints exactly — one whole cycle is identity at any wavelength", () => {
  const base = { from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, center: { x: 0.5, y: 0.5 }, wavelength: 0.5 };
  const p0 = linearGradientRender(base);
  for (const phase of [1, 2, -1]) {
    const shifted = linearGradientRender({ ...base, phase });
    assert.deepStrictEqual(shifted, p0, `phase=${phase} must wrap to identical endpoints as phase=0`);
  }
});

test("a negative phase wraps like its positive equivalent (-0.25 ≡ 0.75)", () => {
  const base = { from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, center: { x: 0.5, y: 0.5 }, wavelength: 0.5 };
  const neg = linearGradientRender({ ...base, phase: -0.25 });
  const pos = linearGradientRender({ ...base, phase: 0.75 });
  assert.deepStrictEqual(neg, pos);
});

// ── 3. THE DECISIVE MEASUREMENT: PIXELS, not just the endpoint formula ───────
const W = 200, H = 40;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };

/** Command. Paints one op on a fresh software surface; returns RGBA bytes. */
function renderPixels(cmd) {
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("gradient_phase_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), [cmd], VIEW, { background: "#ffffff", media: {}, fontCollection });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: W, height: H,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  img.delete();
  surface.dispose();
  return Buffer.from(px);
}

// A wide rect, horizontal ramp black->white, tiled 4x (wavelength 0.25) so the
// pattern has visible structure to shift.
const BOX = { x: 0, y: 0, w: W, h: H };
const gradFill = (extra = {}) => ({
  type: "linearGradient",
  linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], angle: 0, wavelength: 0.25, ...extra },
});
const makeRect = (extra) => rect({ ...BOX, fill: gradFill(extra) });

test("phase=0 (explicit) renders BYTE-IDENTICAL pixels to an omitted phase", () => {
  const withZero = renderPixels(makeRect({ phase: 0 }));
  const omitted = renderPixels(makeRect({}));
  assert.deepStrictEqual(withZero, omitted);
});

test("a nonzero phase visibly shifts the pattern (pixel columns differ from phase=0)", () => {
  const p0 = renderPixels(makeRect({}));
  const p25 = renderPixels(makeRect({ phase: 0.25 }));
  let diffCols = 0;
  const midRow = Math.floor(H / 2);
  for (let x = 0; x < W; x++) {
    const i0 = (midRow * W + x) * 4, i1 = i0;
    if (Math.abs(p0[i0] - p25[i1]) > 4) diffCols++;
  }
  assert.ok(diffCols > W * 0.5, `expected most columns to differ under a 0.25 phase shift, only ${diffCols}/${W} did`);
});

test("phase=1 reproduces phase=0's pixels EXACTLY (one whole mirror period — the ruling's identity claim)", () => {
  const p0 = renderPixels(makeRect({}));
  const p1 = renderPixels(makeRect({ phase: 1 }));
  assert.deepStrictEqual(p0, p1);
});

test("phase=0.5 (a half-period shift) is the MAXIMALLY different pattern — not identical", () => {
  const p0 = renderPixels(makeRect({}));
  const pHalf = renderPixels(makeRect({ phase: 0.5 }));
  assert.notDeepStrictEqual(p0, pHalf, "a half-mirror-period shift must NOT reproduce the same picture");
});

test("phase wraps: phase=2 (two whole periods) also reproduces phase=0's pixels", () => {
  const p0 = renderPixels(makeRect({}));
  const p2 = renderPixels(makeRect({ phase: 2 }));
  assert.deepStrictEqual(p0, p2);
});

test("a negative phase renders identically to its wrapped positive equivalent (-0.25 ≡ 0.75)", () => {
  const neg = renderPixels(makeRect({ phase: -0.25 }));
  const pos = renderPixels(makeRect({ phase: 0.75 }));
  assert.deepStrictEqual(neg, pos);
});

// ── wavelength=1: the CLAMP path, no mirror period of its own ────────────────
// This is the gap the wrap closes: before it, phase never returned to identity
// at the default wavelength because the clamp axis has no tiling to fall back
// on. wavelength stays 1 here (unlike gradFill's 0.25) so this exercises the
// OTHER branch of linearGradientRender's mirror/clamp fork.
const clampFill = (extra = {}) => ({
  type: "linearGradient",
  linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], angle: 0, wavelength: 1, ...extra },
});
const makeClampRect = (extra) => rect({ ...BOX, fill: clampFill(extra) });

test("wavelength=1 (the non-tiled clamp axis): phase=1/2/-1 are IDENTITY, matching phase=0's pixels", () => {
  const p0 = renderPixels(makeClampRect({}));
  for (const phase of [1, 2, -1]) {
    const shifted = renderPixels(makeClampRect({ phase }));
    assert.deepStrictEqual(shifted, p0, `wavelength=1, phase=${phase} must render identically to phase=0`);
  }
});

test("wavelength=1: a fractional phase still visibly shifts the clamp axis (not a no-op)", () => {
  const p0 = renderPixels(makeClampRect({}));
  const p25 = renderPixels(makeClampRect({ phase: 0.25 }));
  assert.notDeepStrictEqual(p0, p25, "a fractional phase must still translate the clamp ramp");
});

// ── 4. PDF/SVG PARITY for a nonzero phase (the strokeoffset-style gate) ──────
// wavelength=1 keeps this a TRUE vector PDF shading (opHasMirrorLinearFill is only
// true for wavelength !== 1) so the PDF Coords are directly greppable, exactly
// like stroke_offset_test.js's centered-stroke check.
const PARITY_BOX = { x: 10, y: 5, w: 100, h: 20 };
const parityFill = parsePaint({
  type: "linearGradient",
  linear: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], angle: 0, center: { x: 0.5, y: 0.5 }, wavelength: 1, phase: 0.3 },
});

test("SVG and Skia/ir.js agree on the phase-shifted axis endpoints", () => {
  const { from, to, mirror } = linearGradientRender(parityFill);
  assert.equal(mirror, false, "wavelength=1 stays a true (non-tiled) axis even with phase set");
  const svgDef = gradientDefSVG(parityFill, "lg1", 1);
  assert.ok(svgDef.includes(`x1="${fmt(from.x)}"`), `SVG x1 must be the SAME shifted endpoint (${fmt(from.x)})`);
  assert.ok(svgDef.includes(`x2="${fmt(to.x)}"`), `SVG x2 must be the SAME shifted endpoint (${fmt(to.x)})`);
});

// A WRAPPED phase (>1) parity check: both exporters read the SAME
// linearGradientRender seam the wrap lives in, so this is free — proving it,
// not assuming it.
const wrappedParityFill = parsePaint({
  type: "linearGradient",
  linear: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], angle: 0, center: { x: 0.5, y: 0.5 }, wavelength: 1, phase: 1.3 },
});

test("SVG and Skia/ir.js agree on a WRAPPED phase's axis endpoints (phase=1.3 wraps to 0.3's axis)", () => {
  const wrapped = linearGradientRender(wrappedParityFill);
  const unwrapped = linearGradientRender(parityFill); // phase: 0.3 — the equivalent post-wrap value
  assert.deepStrictEqual(wrapped, unwrapped, "phase=1.3 must resolve to the SAME endpoints as phase=0.3");
  const svgDef = gradientDefSVG(wrappedParityFill, "lg1", 1);
  assert.ok(svgDef.includes(`x1="${fmt(wrapped.from.x)}"`), `SVG x1 must reflect the wrapped endpoint (${fmt(wrapped.from.x)})`);
  assert.ok(svgDef.includes(`x2="${fmt(wrapped.to.x)}"`), `SVG x2 must reflect the wrapped endpoint (${fmt(wrapped.to.x)})`);
});

await (async () => {
  const cmd = rect({ ...PARITY_BOX, fill: parityFill });
  const bytes = await irToPDF([cmd], { width: 120, height: 30, view: VIEW, background: "#ffffff" });
  const stream = Buffer.from(bytes).toString("latin1");
  const { from, to } = linearGradientRender(parityFill);

  test("PDF's axial shading Coords use the SAME phase-shifted endpoints as SVG/Skia", () => {
    // pdf-lib serializes the /Coords array on the Shading dict; the exact numbers
    // (objectBoundingBox 0..1 space, same as SVG/ir.js) must appear verbatim.
    assert.ok(stream.includes(`${from.x}`), `PDF stream missing shifted from.x=${from.x}`);
    assert.ok(stream.includes(`${to.x}`), `PDF stream missing shifted to.x=${to.x}`);
    assert.ok(stream.includes("ShadingType 2"), "still a true axial (vector) shading, not the raster fallback");
  });
})();

await (async () => {
  // Same parity gate, at a WRAPPED phase (1.3) — both exporters read the ONE
  // linearGradientRender seam the wrap lives in, so this is free; proving it.
  const cmd = rect({ ...PARITY_BOX, fill: wrappedParityFill });
  const bytes = await irToPDF([cmd], { width: 120, height: 30, view: VIEW, background: "#ffffff" });
  const stream = Buffer.from(bytes).toString("latin1");
  const { from, to } = linearGradientRender(wrappedParityFill);

  test("PDF's axial shading Coords use the SAME wrapped-phase endpoints as SVG/Skia (phase=1.3)", () => {
    assert.ok(stream.includes(`${from.x}`), `PDF stream missing wrapped from.x=${from.x}`);
    assert.ok(stream.includes(`${to.x}`), `PDF stream missing wrapped to.x=${to.x}`);
    assert.ok(stream.includes("ShadingType 2"), "still a true axial (vector) shading, not the raster fallback");
  });
})();

console.log(`\ngradient_phase_test: ${passed} passed`);
