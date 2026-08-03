/**
 * GRADIENT SPREAD MODES + THE DEAD WAVELENGTH FLOOR — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/gradient_spread_test.js
 *
 * Two user rulings, 2026-08-02.
 *
 * ── 1. SPREAD MODES ───────────────────────────────────────────────────────────
 * A tiled ramp needed a say in what happens OUTSIDE its one wavelength-long
 * segment. Three modes, which are the three NATIVE tile modes every backend
 * already has — nothing is emulated:
 *
 *   mirror — reflects there-and-back. TODAY'S BEHAVIOUR AND THE DEFAULT, so an
 *            absent `spread` must stay byte-identical (Skia Mirror / SVG reflect).
 *   loop   — restarts the ramp each segment (Skia Repeat / SVG repeat). The user's
 *            own test of it: with looping "I should see purple on the right of it".
 *   pad    — no tiling; "basically just keeps the last color" (Skia Clamp / SVG pad).
 *
 * THE PERIOD IS PER MODE, and that is the whole of what spread changes about the
 * phase math. One ramp SEGMENT spans 2·w·half. Mirror only repeats after a
 * there-AND-back pair, so its period is 4·w·half — which is why phase has always
 * been a fraction of 4·w·half. Loop repeats after ONE segment: 2·w·half. Pad never
 * repeats, but a phase row still needs a cycle unit and one ramp is the only
 * meaningful one, so it shares loop's. Phase is taken as a fraction of THAT MODE'S
 * OWN period, which is what preserves the phase-1-is-identity law in every mode
 * rather than only under mirror.
 *
 * ── 2. NO WAVELENGTH FLOOR ────────────────────────────────────────────────────
 * The old 0.05 minimum (GRADIENT_MIN_WAVELENGTH) was "an arbitrary limitation" —
 * removed. Wavelength scrubs and drags to 0. AT EXACTLY 0 the ramp has no extent
 * and the honest picture is its LIMIT: as w → 0 the tiles get infinitely fine, so
 * every pixel averages the whole ramp and the fill converges to ONE SOLID COLOUR,
 * the ramp's segment-weighted mean (core/properties.rampAverageColor). Mirror
 * tiling does not change that mean — a reflected copy has the same average as the
 * copy it reflects — so the limit is the SAME in every spread mode, and all three
 * backends can paint it as a plain solid.
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────────
 *   1. LEGACY IS BYTE-IDENTICAL: a doc with no `spread` and wavelength 0.5 renders
 *      exactly the pixels it did before this feature (absent-is-mirror).
 *   2. The mode → Skia TileMode mapping, and that the three modes render DIFFERENT
 *      pictures (a mode that silently did nothing would pass a formula check).
 *   3. LOOP SHOWS THE FIRST COLOUR AGAIN — the user's "purple on the right"
 *      measured as pixels: loop's segment boundary jumps back to stop 0, mirror's
 *      does not.
 *   4. PHASE IDENTITY PER MODE: phase=1 is identity in ALL THREE modes, and the
 *      half-cycle shift differs per mode exactly as the period does.
 *   5. WAVELENGTH 0 = the average colour, verified as PIXELS against an
 *      independently-computed mean, and AGREEING ACROSS ALL THREE BACKENDS
 *      (Skia pixels, the SVG def's stop colours, the PDF shading's function).
 *   6. rampAverageColor is exact on known ramps (the pure-helper doctest half).
 *   7. parsePaint accepts wavelength 0 and still rejects a NEGATIVE one loudly.
 */
import assert from "assert";
import { createRequire } from "module";
import path from "path";
import { rect, linearGradientRender, collapsedGradientColor, parsePaint, pdfTileSpan } from "../ir.js";
import { paintIR } from "../skia/paint_skia.js";
import { skTileMode } from "../skia/gradient.js";
import { gradientDefSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { rampAverageColor, spreadPeriodHalves, GRADIENT_SPREAD_MODES } from "../../core/properties.js";

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
/** Command. Runs one check; awaits `fn` so a PDF-export test can be async. */
async function test(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

// ── 6. THE PURE HELPER: exact means on known ramps ───────────────────────────

await test("rampAverageColor is EXACT on a known ramp (black→white averages mid grey)", () => {
  assert.deepStrictEqual(
    rampAverageColor([{ offset: 0, color: [0, 0, 0, 1] }, { offset: 1, color: [1, 1, 1, 1] }]),
    [0.5, 0.5, 0.5, 1],
  );
});

await test("rampAverageColor: red→blue averages purple — the colour a w=0 fill must show", () => {
  assert.deepStrictEqual(
    rampAverageColor([{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 1, 1] }]),
    [0.5, 0, 0.5, 1],
  );
});

await test("rampAverageColor weights each segment by its SPAN, not by stop count", () => {
  // Half the domain is held at red, half ramps red→black: 1·0.5 + 0.5·0.5 = 0.75.
  assert.deepStrictEqual(
    rampAverageColor([
      { offset: 0, color: [1, 0, 0, 1] },
      { offset: 0.5, color: [1, 0, 0, 1] },
      { offset: 1, color: [0, 0, 0, 1] },
    ]),
    [0.75, 0, 0, 1],
  );
});

await test("rampAverageColor counts the END PADDINGS (a ramp inset from 0/1 holds its end colours)", () => {
  // Stops only span 0.25..0.75; the paddings are flat white, so the mean is white.
  assert.deepStrictEqual(
    rampAverageColor([{ offset: 0.25, color: [1, 1, 1, 1] }, { offset: 0.75, color: [1, 1, 1, 1] }]),
    [1, 1, 1, 1],
  );
  // An asymmetric inset: black 0..0.5 flat, then black→white over 0.5..1.
  // 0·0.5 + 0.5·0.5 = 0.25.
  assert.deepStrictEqual(
    rampAverageColor([{ offset: 0.5, color: [0, 0, 0, 1] }, { offset: 1, color: [1, 1, 1, 1] }]),
    [0.25, 0.25, 0.25, 1],
  );
});

await test("rampAverageColor is loud on an empty ramp (no silent black)", () => {
  assert.throws(() => rampAverageColor([]), /at least one stop/);
});

// ── THE PERIOD, per mode ─────────────────────────────────────────────────────

await test("spreadPeriodHalves: mirror is 4 (there and back), loop and pad are 2 (one ramp)", () => {
  assert.equal(spreadPeriodHalves("mirror"), 4);
  assert.equal(spreadPeriodHalves("loop"), 2);
  assert.equal(spreadPeriodHalves("pad"), 2);
  assert.equal(spreadPeriodHalves(undefined), 4, "absent → mirror, the legacy default");
});

// ── 2. THE SKIA TILEMODE MAPPING ─────────────────────────────────────────────

await test("every spread mode maps to its NATIVE CanvasKit TileMode", () => {
  assert.strictEqual(skTileMode(CanvasKit, "mirror"), CanvasKit.TileMode.Mirror);
  assert.strictEqual(skTileMode(CanvasKit, "loop"), CanvasKit.TileMode.Repeat);
  assert.strictEqual(skTileMode(CanvasKit, "pad"), CanvasKit.TileMode.Clamp);
});

await test("skTileMode is loud on an unknown mode (never a silent Clamp)", () => {
  assert.throws(() => skTileMode(CanvasKit, "wrap"), /unknown gradient spread/);
});

await test("every declared spread mode has a TileMode — the list and the mapping cannot drift", () => {
  for (const mode of GRADIENT_SPREAD_MODES) assert.ok(skTileMode(CanvasKit, mode) != null, mode);
});

// ── linearGradientRender: the tile each mode resolves to ─────────────────────

const axisOf = (extra) => linearGradientRender({
  from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, center: { x: 0.5, y: 0.5 }, ...extra,
});

await test("a tiled ramp reports its own spread; a WHOLE-AXIS ramp reports pad in every mode", () => {
  assert.equal(axisOf({ wavelength: 0.5 }).tile, "mirror", "absent spread is mirror");
  assert.equal(axisOf({ wavelength: 0.5, spread: "loop" }).tile, "loop");
  assert.equal(axisOf({ wavelength: 0.5, spread: "pad" }).tile, "pad");
  // w=1 fills the axis, so there is nothing outside to tile: every mode is pad,
  // which is what keeps a legacy whole-axis paint's Clamp shader byte-identical.
  for (const spread of GRADIENT_SPREAD_MODES)
    assert.equal(axisOf({ wavelength: 1, spread }).tile, "pad", spread);
});

// ── 4. PHASE IDENTITY, PER MODE ──────────────────────────────────────────────

await test("phase=1 is IDENTITY in every spread mode (each measured against its OWN period)", () => {
  for (const spread of GRADIENT_SPREAD_MODES) {
    const base = { wavelength: 0.5, spread };
    const p0 = axisOf(base), p1 = axisOf({ ...base, phase: 1 });
    assert.deepStrictEqual(p1.from, p0.from, `${spread}: phase 1 must land on phase 0`);
    assert.deepStrictEqual(p1.to, p0.to, spread);
  }
});

await test("the HALF-cycle shift differs per mode exactly as the period does", () => {
  // half = 0.5, w = 0.5. Mirror's period is 4·w·half = 1; loop/pad's is 2·w·half = 0.5.
  // A half-cycle shift is therefore 0.5 mirrored and 0.25 looped/padded.
  const shiftOf = (spread) => axisOf({ wavelength: 0.5, spread, phase: 0.5 }).from.x - axisOf({ wavelength: 0.5, spread }).from.x;
  assert.equal(shiftOf("mirror"), 0.5, "mirror's cycle is TWO ramps, so half of it is one whole ramp");
  assert.equal(shiftOf("loop"), 0.25, "loop's cycle is ONE ramp, so half of it is half a ramp");
  assert.equal(shiftOf("pad"), 0.25);
});

// ── THE DECISIVE MEASUREMENT: PIXELS ─────────────────────────────────────────
const W = 200, H = 40;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };

/** Command. Paints one op on a fresh software surface; returns RGBA bytes. */
function renderPixels(cmd) {
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("gradient_spread_test: MakeSurface returned null");
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

const BOX = { x: 0, y: 0, w: W, h: H };
/** A red→blue ramp: the two ends are far apart in colour, so a wrap is unmistakable. */
const RED_BLUE = [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }];
const gradFill = (extra = {}) => ({
  type: "linearGradient",
  linear: { stops: RED_BLUE, angle: 0, wavelength: 0.25, ...extra },
});
const makeRect = (extra) => rect({ ...BOX, fill: gradFill(extra) });

/** The page + camera the PDF export tests render through. */
const PDF_VIEW = { width: W, height: H, view: { zoom: 1, panX: 0, panY: 0 } };

/** The RGBA of one pixel on the middle row. */
function pixelAt(px, x) {
  const i = (Math.floor(H / 2) * W + x) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
}

// ── 1. THE LEGACY GATE ───────────────────────────────────────────────────────

await test("LEGACY: a doc with NO spread renders BYTE-IDENTICAL pixels to an explicit mirror", () => {
  assert.deepStrictEqual(renderPixels(makeRect({})), renderPixels(makeRect({ spread: "mirror" })));
});

await test("LEGACY: the default whole-axis gradient (no spread, no wavelength) is byte-identical too", () => {
  const legacy = rect({ ...BOX, fill: { type: "linearGradient", linear: { stops: RED_BLUE, angle: 0 } } });
  const explicit = rect({ ...BOX, fill: { type: "linearGradient", linear: { stops: RED_BLUE, angle: 0, wavelength: 1, spread: "mirror" } } });
  assert.deepStrictEqual(renderPixels(legacy), renderPixels(explicit));
});

// ── 2/3. THE MODES DRAW DIFFERENT, CORRECT PICTURES ──────────────────────────

await test("the three spread modes render THREE DIFFERENT pictures (none is a silent no-op)", () => {
  const [m, l, p] = ["mirror", "loop", "pad"].map((spread) => renderPixels(makeRect({ spread })));
  assert.notDeepStrictEqual(m, l, "loop must differ from mirror");
  assert.notDeepStrictEqual(m, p, "pad must differ from mirror");
  assert.notDeepStrictEqual(l, p, "pad must differ from loop");
});

await test("LOOP SHOWS THE FIRST COLOUR AGAIN — the user's 'purple on the right' (red returns after blue)", () => {
  // wavelength 0.25 centered at 0.5 puts one ramp segment on [0.375, 0.625] of the
  // box. Just LEFT of the 0.625 boundary the ramp has reached its last stop (blue);
  // just RIGHT of it, LOOP restarts at the first stop (red) while MIRROR reflects
  // back into blue. Sampling either side of that seam is the whole distinction.
  const justBefore = Math.floor(W * 0.625) - 3, justAfter = Math.floor(W * 0.625) + 3;
  const loop = renderPixels(makeRect({ spread: "loop" }));
  const mirror = renderPixels(makeRect({ spread: "mirror" }));

  const [lr, , lb] = pixelAt(loop, justAfter);
  assert.ok(lr > 200 && lb < 60, `loop must jump BACK to the first stop (red) after the segment — got rgb(${pixelAt(loop, justAfter)})`);
  const [mr, , mb] = pixelAt(mirror, justAfter);
  assert.ok(mb > 200 && mr < 60, `mirror must REFLECT (stay blue) after the segment — got rgb(${pixelAt(mirror, justAfter)})`);
  // Both agree just INSIDE the segment: it is the same ramp there.
  assert.deepStrictEqual(pixelAt(loop, justBefore), pixelAt(mirror, justBefore));
});

await test("PAD holds the END COLOURS out to the edges — 'basically just keeps the last color'", () => {
  const pad = renderPixels(makeRect({ spread: "pad" }));
  // Far left of the segment is the first stop (red); far right is the last (blue),
  // both held flat all the way to the box edge.
  const [lr, , lb] = pixelAt(pad, 2);
  assert.ok(lr > 200 && lb < 60, `pad must hold the FIRST stop left of the ramp — got rgb(${pixelAt(pad, 2)})`);
  const [rr, , rb] = pixelAt(pad, W - 3);
  assert.ok(rb > 200 && rr < 60, `pad must hold the LAST stop right of the ramp — got rgb(${pixelAt(pad, W - 3)})`);
  // FLAT, not still ramping: two far-apart columns in the padding must match.
  assert.deepStrictEqual(pixelAt(pad, 2), pixelAt(pad, 12), "the pad region must be a constant colour");
});

await test("phase=1 reproduces phase=0's PIXELS in every spread mode (the identity claim, measured)", () => {
  for (const spread of GRADIENT_SPREAD_MODES) {
    assert.deepStrictEqual(
      renderPixels(makeRect({ spread, phase: 1 })),
      renderPixels(makeRect({ spread })),
      `${spread}: one whole cycle must be identity`,
    );
  }
});

// ── 5. WAVELENGTH 0 = THE AVERAGE COLOUR, ACROSS ALL THREE BACKENDS ──────────

/** The expected mean of the red→blue ramp, as 0..255 bytes: pure purple. */
const EXPECTED_AVG = [128, 0, 128];

await test("collapsedGradientColor is the ramp's mean (red→blue → purple)", () => {
  const parsed = parsePaint(gradFill({ wavelength: 0 }));
  assert.deepStrictEqual(collapsedGradientColor(parsed), [0.5, 0, 0.5, 1]);
});

await test("SKIA: wavelength 0 paints a FLAT solid of the ramp's average colour", () => {
  const px = renderPixels(makeRect({ wavelength: 0 }));
  for (const x of [2, 50, 100, 150, W - 3]) {
    const [r, g, b] = pixelAt(px, x);
    // sRGB byte rounding of 0.5 lands on 127/128 depending on the blend path.
    assert.ok(Math.abs(r - EXPECTED_AVG[0]) <= 2, `x=${x}: red ${r} should be ~${EXPECTED_AVG[0]}`);
    assert.equal(g, 0, `x=${x}: green must be 0`);
    assert.ok(Math.abs(b - EXPECTED_AVG[2]) <= 2, `x=${x}: blue ${b} should be ~${EXPECTED_AVG[2]}`);
  }
  // FLAT: every column identical, which is what "collapsed to a solid" means.
  assert.deepStrictEqual(pixelAt(px, 5), pixelAt(px, W - 5));
});

await test("SKIA: the wavelength-0 solid is the SAME in every spread mode (the mean is tiling-invariant)", () => {
  const [m, l, p] = GRADIENT_SPREAD_MODES.map((spread) => renderPixels(makeRect({ wavelength: 0, spread })));
  assert.deepStrictEqual(m, l);
  assert.deepStrictEqual(m, p);
});

await test("SVG: wavelength 0 emits stops of that SAME average colour", () => {
  const def = gradientDefSVG(parsePaint(gradFill({ wavelength: 0 })), "lg0", 1);
  assert.ok(def.includes(`rgb(${EXPECTED_AVG.join(",")})`), `SVG must emit the average colour — got ${def}`);
  // BOTH stops are that colour, so the def is a flat solid whatever axis it gets.
  assert.equal(def.split(`rgb(${EXPECTED_AVG.join(",")})`).length - 1, 2, "both stops carry the average");
});

await test("SVG: every spread mode emits its NATIVE spreadMethod (true vector, no raster route)", () => {
  const defOf = (spread) => gradientDefSVG(parsePaint(gradFill({ spread })), "lg", 1);
  assert.ok(defOf("mirror").includes('spreadMethod="reflect"'), defOf("mirror"));
  assert.ok(defOf("loop").includes('spreadMethod="repeat"'), defOf("loop"));
  // pad IS SVG's own default, so it is omitted — which is what keeps a legacy
  // whole-axis def byte-identical.
  assert.ok(!defOf("pad").includes("spreadMethod"), defOf("pad"));
});

await test("PDF: the tile count covers the axis plus a margin each side", () => {
  // The margin absorbs the phase shift and the diagonal chord; past it Extend
  // clamps, where nothing of the shape remains to paint.
  assert.equal(pdfTileSpan(1), 2);
  assert.equal(pdfTileSpan(0.5), 3);
  assert.equal(pdfTileSpan(0.25), 5);
});

await test("PDF: EVERY spread mode exports as TRUE VECTOR — no raster fallback in any of them", async () => {
  // This is the claim that replaced the old opHasMirrorLinearFill raster route: a
  // PDF axial shading has no tile mode, but its Function's Domain need not be
  // [0,1], so mirror/loop become a stitching function replicating the ramp per
  // tile. The proof is the absence of an embedded IMAGE and the presence of a real
  // shading in all three modes.
  for (const spread of GRADIENT_SPREAD_MODES) {
    const bytes = await irToPDF([makeRect({ spread })], PDF_VIEW);
    const pdf = Buffer.from(bytes).toString("latin1");
    assert.ok(pdf.includes("/ShadingType 2"), `${spread}: must export a real axial shading`);
    assert.ok(!pdf.includes("/Subtype /Image"), `${spread}: must NOT rasterize`);
    // The two TILED modes need the stitched, extended-domain function; pad does not.
    assert.equal(pdf.includes("/FunctionType 3"), spread !== "pad", `${spread}: stitching function presence`);
  }
});

await test("PDF: wavelength 0 exports a shading whose function is the ONE average colour", async () => {
  const pdf = Buffer.from(await irToPDF([makeRect({ wavelength: 0 })], PDF_VIEW)).toString("latin1");
  assert.ok(pdf.includes("/ShadingType 2"), "still a vector shading, not a raster patch");
  assert.ok(!pdf.includes("/Subtype /Image"), "a collapsed ramp must not rasterize");
  // C0 and C1 are both the mean (0.5 0 0.5), so the shading paints a flat solid.
  assert.ok(/\/C0 \[ 0\.5 0 0\.5 \]/.test(pdf) && /\/C1 \[ 0\.5 0 0\.5 \]/.test(pdf),
    `both function endpoints must be the ramp's average colour — got ${pdf.match(/\/C[01] \[[^\]]*\]/g)}`);
});

// ── 7. VALIDATION: 0 is accepted, NEGATIVE is refused ────────────────────────

await test("parsePaint ACCEPTS wavelength 0 (the collapse), and the render flags it", () => {
  const p = parsePaint(gradFill({ wavelength: 0 }));
  assert.equal(p.wavelength, 0);
  assert.equal(linearGradientRender(p).collapsed, true);
});

await test("parsePaint still REFUSES a negative wavelength loudly (no inside-out ramp)", () => {
  assert.throws(() => parsePaint(gradFill({ wavelength: -0.5 })), /non-negative/);
});

await test("parsePaint refuses an unknown spread loudly, and defaults an absent one to mirror", () => {
  assert.throws(() => parsePaint(gradFill({ spread: "reflectish" })), /must be one of/);
  assert.equal(parsePaint(gradFill({})).spread, "mirror");
});

console.log(`\ngradient_spread_test: ${passed} passed`);
