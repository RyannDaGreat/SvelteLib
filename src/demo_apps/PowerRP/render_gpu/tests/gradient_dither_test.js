/**
 * PAINT-LEVEL GRADIENT DITHER — bare node, real Skia, real pixels, plus the two
 * vector exporters. Run: node render_gpu/tests/gradient_dither_test.js
 *
 * THE FEATURE: a gradient paint carries `ditherMode` ("off" | "bayer" |
 * "blueNoise") and `ditherEmphasis`, and the raster backends add a sub-LSB
 * ordered/blue-noise wobble as Skia quantizes that paint into the destination
 * surface, so the ramp's 8-bit banding dissolves into fine grain. It REPLACES a
 * whole-frame camera post-effect that was uprooted (user ruling, 2026-08-07).
 *
 * WHY THIS SUITE IS SHAPED THE WAY IT IS. The camera dither it replaces shipped
 * green and was, in the user's words, "a total failure" — it did nothing in the
 * viewport for months. It had tests; they asserted about the SHADER and the
 * PLUMBING, and the thing that was broken was neither (an MSAA on-screen surface
 * cannot allocate the RGBA16F intermediate that design required, so the pass
 * caught its own exception and painted undithered). The lesson is that a dither
 * test must assert on RENDERED PIXELS and on the properties dither claims —
 * not on whether the machinery was invoked. So every raster claim below reads
 * back real pixels, and each one is written so that a plausible wrong
 * implementation fails it:
 *
 *   - "it changes pixels"      fails if the wrapper is never applied.
 *   - "off is byte-identical"  fails if the wrapper is applied unconditionally.
 *   - "the MEAN is unmoved"    fails if the wobble is not zero-mean (a dither that
 *                              brightens the picture is a bug, not a dither).
 *   - "adjacent DEVICE pixels
 *      differ at dpr 2"        fails if the threshold is sampled in LOCAL space —
 *                              the single mistake this design could most easily
 *                              make, and one no "did it run" test can see.
 *   - "vector bytes unchanged" fails if a backend silently starts rasterizing.
 */

import assert from "node:assert/strict";
import path from "path";
import { createRequire } from "module";
import { paintIR } from "../skia/paint_skia.js";
import { rect, parsePaint, paintDepth, opHasDitheredGradient, opHasReducedDepthGradient, undithered } from "../ir.js";
import { irToSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { DITHER_MODES } from "../../core/properties.js";
import { paintDepthActive, packDitherUniforms, KNOWN_MODES } from "../skia/dither_shader.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
// No text in any scene here, so an empty FontCollection satisfies paintIR.
const fontCollection = CanvasKit.FontCollection.Make();

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

// ── the fixture ──────────────────────────────────────────────────────────────
// The repo's banding torture test (tests/dither_vlm_check.js): a NEAR-BLACK
// vertical ramp spanning ~10-18 eight-bit levels over hundreds of pixels, which
// quantizes into wide hard bands. A shallow ramp is REQUIRED — over a full-range
// gradient the bands are one pixel wide and a dither has almost nothing to fix,
// so a healthy implementation would measure indistinguishable from a broken one.
const W = 64, H = 400;
const TOP = "#000000", BOTTOM = "#0a0a12";

/** Query→build. The torture ramp with `dither` merged onto the PAINT. */
const ramp = (dither = {}) => parsePaint({
  type: "linearGradient",
  linear: { stops: [{ offset: 0, color: TOP }, { offset: 1, color: BOTTOM }], from: { x: 0, y: 0 }, to: { x: 0, y: 1 } },
  ...dither,
});

/** Query→build. The same ramp as a RADIAL gradient (rings, not bands). */
const radialRamp = (dither = {}) => parsePaint({
  type: "radialGradient",
  radial: { stops: [{ offset: 0, color: BOTTOM }, { offset: 1, color: TOP }], center: { x: 0.5, y: 0.5 }, r: 0.7 },
  ...dither,
});

/**
 * Command (allocates + frees a surface). Renders one full-bleed rect of `fill`
 * and returns the UNPREMULTIPLIED RGBA device pixels. `dpr` scales the device
 * surface while leaving the world rect alone, which is how the device-grid claim
 * below gets a case where local and device coordinates disagree.
 */
function pixels(fill, dpr = 1) {
  const sw = W * dpr, sh = H * dpr;
  const surface = CanvasKit.MakeSurface(sw, sh);
  if (!surface) throw new Error("gradient_dither_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), [rect({ x: 0, y: 0, w: W, h: H, fill })],
    { zoom: 1, panX: 0, panY: 0, dpr }, { fontCollection, background: "#000000" });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: sw, height: sh,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  img.delete();
  surface.dispose();
  return { px, sw, sh };
}

/** Pure function. How many bytes of two equal-length buffers differ, and by how much. */
function diff(a, b) {
  assert.equal(a.length, b.length, "compared renders must be the same size");
  let n = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) { n++; if (d > max) max = d; }
  }
  return { n, max, frac: n / a.length };
}

/** Pure function. Mean of one RGB channel over every pixel (alpha skipped). */
function channelMean(px, channel) {
  let sum = 0, n = 0;
  for (let i = channel; i < px.length; i += 4) { sum += px[i]; n++; }
  return sum / n;
}

// ── 1. the parse contract: absent is off, and off is byte-identical ──────────

test("an UNDITHERED gradient parses to exactly the keys it always did", () => {
  // The absent-is-legacy discipline, at the object level. If a dither key were
  // always present, pdf_backend's shading cache (keyed on JSON.stringify) would
  // change for every gradient in the repo.
  assert.deepEqual(Object.keys(ramp()).sort(),
    ["center", "from", "phase", "spread", "stops", "to", "type", "wavelength"]);
  assert.equal(paintDepth(ramp()), null);
});

test("both NO-OP dither configurations parse to the undithered object exactly", () => {
  // "off at emphasis 9" and "bayer at emphasis 0" draw the identical picture, so
  // they must be indistinguishable downstream — not merely render the same.
  assert.deepEqual(ramp({ ditherMode: "off", ditherEmphasis: 9 }), ramp());
  assert.deepEqual(ramp({ ditherMode: "bayer", ditherEmphasis: 0 }), ramp());
});

test("an ACTIVE dither lands on the parsed paint, with the default emphasis filled", () => {
  assert.deepEqual(paintDepth(ramp({ ditherMode: "bayer" })), { mode: "bayer", emphasis: 1, bits: 8 });
  assert.deepEqual(paintDepth(ramp({ ditherMode: "blueNoise", ditherEmphasis: 3 })), { mode: "blueNoise", emphasis: 3, bits: 8 });
  // RADIAL TOO — unlike `spread`, which is deliberately linear-only because radial
  // has no wavelength/phase for it to modify. A radial ramp bands (in rings), so
  // the feature dither modifies is fully present here.
  assert.deepEqual(paintDepth(radialRamp({ ditherMode: "bayer", ditherEmphasis: 2 })), { mode: "bayer", emphasis: 2, bits: 8 });
});

test("parsePaint is LOUD on a bad dither, never quietly undithered", () => {
  assert.throws(() => ramp({ ditherMode: "halftone" }), /dither mode must be one of/);
  assert.throws(() => ramp({ ditherEmphasis: -1 }), /dither emphasis must be a non-negative finite number/);
  assert.throws(() => ramp({ ditherEmphasis: Infinity }), /dither emphasis must be a non-negative finite number/);
  assert.throws(() => ramp({ ditherEmphasis: "2" }), /dither emphasis must be a non-negative finite number/);
});

test("the shader's mode list and the property registry cannot drift", () => {
  // dither_shader.js asserts this at IMPORT time too; restated here so the reason
  // is visible in a suite rather than only as a module side effect.
  assert.deepEqual([...KNOWN_MODES].sort(), [...DITHER_MODES].sort());
  assert.equal(paintDepthActive({ mode: "off", emphasis: 4, bits: 8 }), false);
  assert.equal(paintDepthActive({ mode: "bayer", emphasis: 0, bits: 8 }), false);
  assert.equal(paintDepthActive({ mode: "bayer", emphasis: 1, bits: 8 }), true);
  assert.equal(paintDepthActive({ mode: "off", emphasis: 0, bits: 2 }), true, "a depth reduction with NO noise still needs the shader");
  assert.equal(paintDepthActive(null), false);
});

// ── 2. the raster claims, on real pixels ─────────────────────────────────────

const OFF = pixels(ramp()).px;

test("rendering is DETERMINISTIC — the same paint twice is byte-identical", () => {
  // The property-state law. A dither that read a clock or Math.random would pass
  // every other test in this file and fail this one.
  assert.equal(diff(OFF, pixels(ramp()).px).n, 0);
  const a = pixels(ramp({ ditherMode: "blueNoise", ditherEmphasis: 4 })).px;
  const b = pixels(ramp({ ditherMode: "blueNoise", ditherEmphasis: 4 })).px;
  assert.equal(diff(a, b).n, 0, "a dithered render must also be reproducible byte-for-byte");
});

test("a NO-OP dither renders BYTE-IDENTICALLY to no dither at all", () => {
  // The back-compat guarantee that lets every pre-feature document render
  // unchanged. It fails the moment the wrapper is applied unconditionally.
  assert.equal(diff(OFF, pixels(ramp({ ditherMode: "off", ditherEmphasis: 9 })).px).n, 0);
  assert.equal(diff(OFF, pixels(ramp({ ditherMode: "bayer", ditherEmphasis: 0 })).px).n, 0);
});

test("an ACTIVE dither MOVES REAL PIXELS, in both modes, and harder at more emphasis", () => {
  const bayer1 = diff(OFF, pixels(ramp({ ditherMode: "bayer", ditherEmphasis: 1 })).px);
  const blue1 = diff(OFF, pixels(ramp({ ditherMode: "blueNoise", ditherEmphasis: 1 })).px);
  const bayer16 = diff(OFF, pixels(ramp({ ditherMode: "bayer", ditherEmphasis: 16 })).px);

  // MEASURED ANCHORS (this fixture, software Skia): emphasis 1 moves ~18-19% of
  // bytes by exactly one code value — the definition of a one-LSB dither — and
  // emphasis 16 moves ~68% by up to 8. The bounds are loose around those numbers;
  // what they pin is the SHAPE (a real effect, one LSB at unit emphasis, and
  // monotonic in emphasis), which is what a broken implementation loses.
  assert.ok(bayer1.frac > 0.10 && bayer1.frac < 0.30, `bayer e=1 moved ${(100 * bayer1.frac).toFixed(1)}% of bytes, expected ~18%`);
  assert.equal(bayer1.max, 1, "at emphasis 1 the wobble must be exactly ONE 8-bit level — that is what 'full strength' means");
  assert.ok(blue1.frac > 0.10 && blue1.frac < 0.30, `blueNoise e=1 moved ${(100 * blue1.frac).toFixed(1)}% of bytes, expected ~19%`);
  assert.equal(blue1.max, 1);
  assert.ok(bayer16.frac > bayer1.frac, "more emphasis must move more pixels");
  assert.ok(bayer16.max > 1, `emphasis 16 must push further than one level, got max ${bayer16.max}`);
});

// A MID-GRAY ramp, used only by the zero-mean claim below — see why there.
const midRamp = (dither = {}) => parsePaint({
  type: "linearGradient",
  linear: { stops: [{ offset: 0, color: "#6e6e78" }, { offset: 1, color: "#787888" }], from: { x: 0, y: 0 }, to: { x: 0, y: 1 } },
  ...dither,
});

test("the dither is ZERO-MEAN — it breaks the bands without shifting the picture", () => {
  // The claim that makes dither honest rather than a brightness knob: the wobble
  // is centered on 0, so the average colour is unchanged. A shader that forgot to
  // subtract 0.5 from the threshold would still scatter pixels convincingly and
  // still pass every test above — and would lift the picture by half a code value
  // per unit emphasis, i.e. EIGHT levels at the emphasis 16 used here.
  //
  // MEASURED ON A MID-GRAY RAMP, NOT THE NEAR-BLACK TORTURE FIXTURE, and the
  // reason is a real property of dithering rather than a convenience. Near the
  // gamut floor the negative half of the wobble is CLAMPED at 0 while the positive
  // half survives, so the mean necessarily lifts — and it does, measurably and
  // exactly as clamping predicts: on the near-black ramp the shift is 0.000 at
  // emphasis 1, 0.031 at 4 and 0.534 at 16 (it grows only once the wobble is wide
  // enough to reach past the floor), and it is larger in R/G, which sit at exactly
  // 0 at the top of that ramp, than in B, which has headroom. That is the SURFACE
  // clamping, not the shader mis-centering, and asserting zero-mean there would be
  // asserting something false. Away from both boundaries the shift is <= 0.02 code
  // values at every emphasis, which is what this test pins.
  const midOff = pixels(midRamp()).px;
  for (const mode of ["bayer", "blueNoise"]) {
    const d = pixels(midRamp({ ditherMode: mode, ditherEmphasis: 16 })).px;
    for (const [name, ch] of [["R", 0], ["G", 1], ["B", 2]]) {
      const delta = channelMean(d, ch) - channelMean(midOff, ch);
      assert.ok(Math.abs(delta) < 0.1,
        `${mode} e=16 shifted the mean ${name} by ${delta.toFixed(3)} code values away from any gamut clamp; a zero-mean dither must not move it (bound 0.1; an un-centered threshold would move it by ~8)`);
    }
  }
});

test("the threshold is sampled on the DEVICE grid, not the shape's local grid", () => {
  // THE ASSERTION THIS DESIGN MOST NEEDS. A runtime-effect paint shader is invoked
  // in LOCAL space, so the dither must be mapped through the canvas CTM to reach
  // device pixels. If that mapping is missing, then at dpr 2 each 2x2 block of
  // device pixels shares one local coordinate and therefore ONE threshold — the
  // grain doubles in size and de-bands half as well, silently.
  //
  // The ramp is VERTICAL, so two horizontally-adjacent pixels have the identical
  // base colour: any difference between them IS the dither. Counting how often
  // the pair (2k, 2k+1) differs discriminates exactly:
  //   device-mapped → adjacent device px are adjacent bayer cells → differ often
  //   local-mapped  → adjacent device px are the SAME cell → differ ~never
  const { px, sw, sh } = pixels(ramp({ ditherMode: "bayer", ditherEmphasis: 16 }), 2);
  let pairs = 0, differ = 0;
  for (let y = 0; y < sh; y++)
    for (let x = 0; x + 1 < sw; x += 2) {
      const a = px[(y * sw + x) * 4 + 2];       // blue channel: the ramp's widest span
      const b = px[(y * sw + x + 1) * 4 + 2];
      pairs++;
      if (a !== b) differ++;
    }
  const rate = differ / pairs;
  assert.ok(rate > 0.15,
    `only ${(100 * rate).toFixed(1)}% of horizontally-adjacent DEVICE pixel pairs differ at dpr 2 — the dither threshold is being sampled in LOCAL space (each 2x2 device block sharing one value), not on the device grid`);
});

test("a RADIAL gradient dithers too", () => {
  const off = pixels(radialRamp()).px;
  const on = pixels(radialRamp({ ditherMode: "blueNoise", ditherEmphasis: 8 })).px;
  assert.ok(diff(off, on).frac > 0.10, "a radial ramp bands in rings and must dither like a linear one");
  assert.equal(diff(off, pixels(radialRamp({ ditherMode: "off" })).px).n, 0);
});

test("dither survives the WHOLE paint pipeline — a gradient STROKE dithers as well as a fill", () => {
  // applyPaint threads the CTM for fills and strokes through the same seam; this
  // catches a strokePaint call site that was missed while fills were updated.
  const strokeOnly = (dither) => {
    const surface = CanvasKit.MakeSurface(W, H);
    paintIR(CanvasKit, surface.getCanvas(), [rect({ x: 8, y: 8, w: W - 16, h: H - 16, fill: null, stroke: ramp(dither), strokeWidth: 12 })],
      { zoom: 1, panX: 0, panY: 0, dpr: 1 }, { fontCollection, background: "#000000" });
    surface.flush();
    const img = surface.makeImageSnapshot();
    const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
    img.delete(); surface.dispose();
    return px;
  };
  const off = strokeOnly({});
  assert.equal(diff(off, strokeOnly({})).n, 0);
  assert.ok(diff(off, strokeOnly({ ditherMode: "bayer", ditherEmphasis: 16 })).n > 0,
    "a dithered gradient STROKE must differ from an undithered one");
});

// ── 3. the vector exporters: a MEASURED, NAMED capability gap ────────────────

test("opHasDitheredGradient enumerates the gap on both fill and stroke", () => {
  assert.equal(opHasDitheredGradient({ fill: ramp({ ditherMode: "bayer" }) }), true);
  assert.equal(opHasDitheredGradient({ stroke: ramp({ ditherMode: "blueNoise" }) }), true);
  assert.equal(opHasDitheredGradient({ fill: ramp() }), false);
  assert.equal(opHasDitheredGradient({ fill: [1, 1, 1, 1] }), false);
  assert.equal(opHasDitheredGradient({}), false);
});

test("undithered() strips the leaves and leaves an undithered paint untouched BY IDENTITY", () => {
  const plain = ramp();
  assert.equal(undithered(plain), plain, "no copy at all in the common case");
  const stripped = undithered(ramp({ ditherMode: "bayer", ditherEmphasis: 2 }));
  assert.deepEqual(stripped, plain);
});

test("SVG exports a dithered gradient as a TRUE VECTOR shading, byte-identical to its undithered twin", async () => {
  // THE DOCUMENTED DECISION (render_gpu/ir.js reportVectorDitherOmission): a vector
  // shading has no bit depth for a sub-LSB pattern to sit on, and rasterizing the
  // widget to carry one would trade resolution independence for an effect designed
  // to be invisible. So the dither is dropped and SAID OUT LOUD — never silently,
  // and never by quietly rasterizing.
  const view = { width: 64, height: 64, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 }, background: "#ffffff" };
  const plain = await irToSVG([rect({ x: 0, y: 0, w: 64, h: 64, fill: ramp() })], view);
  const dithered = await irToSVG([rect({ x: 0, y: 0, w: 64, h: 64, fill: ramp({ ditherMode: "bayer", ditherEmphasis: 4 }) })], view);
  assert.equal(dithered, plain, "the dithered export must be byte-identical to the undithered one");
  assert.match(plain, /<linearGradient/, "and it must still be a real vector gradient, not a rasterized <image>");
  assert.doesNotMatch(dithered, /<image/, "a dithered gradient must NOT route to raster in SVG");
});

/**
 * Pure function. PDF bytes as latin1 text with the WALL-CLOCK metadata blanked.
 *
 * pdf-lib stamps /CreationDate and /ModDate to the second, so two identical
 * renders one second apart differ. This suite caught that the hard way: the
 * comparison below passed repeatedly, then failed with "1457 vs 1457 bytes" —
 * equal length, different content — while the code under test was correct. A
 * byte-comparison that depends on both renders landing inside the same second is
 * not an assertion, it is a coin flip, and it would have gone red at random in a
 * gate that already churns. Blanking the two date fields removes the ONLY
 * nondeterminism pdf-lib introduces and leaves the real claim intact.
 */
function pdfSansTimestamps(bytes) {
  return Buffer.from(bytes).toString("latin1").replace(/\/(CreationDate|ModDate) \(D:[^)]*\)/g, "/$1 (D:BLANKED)");
}

test("PDF exports a dithered gradient as a TRUE VECTOR shading, identical to its undithered twin", async () => {
  // Same decision, and additionally: stripping the leaves BEFORE the shading cache
  // key is what stops one gradient minting a second, byte-identical /Shading per
  // dither setting.
  const view = { width: 64, height: 64, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 }, background: "#ffffff" };
  const plain = pdfSansTimestamps(await irToPDF([rect({ x: 0, y: 0, w: 64, h: 64, fill: ramp() })], view));
  const dithered = pdfSansTimestamps(await irToPDF([rect({ x: 0, y: 0, w: 64, h: 64, fill: ramp({ ditherMode: "blueNoise", ditherEmphasis: 2 }) })], view));
  assert.equal(dithered, plain, `the dithered PDF must be identical (${plain.length} vs ${dithered.length} chars)`);
  assert.match(plain, /ShadingType/, "and it must still be a real PDF shading, not a rasterized XObject");
  assert.doesNotMatch(plain, /\/Subtype \/Image/, "a dithered gradient must NOT route to raster in PDF");
});

test("PDF mints ONE shading for a gradient used both dithered and undithered", async () => {
  // THIS TEST EXISTS BECAUSE ITS ABSENCE WAS MEASURED. `shadingName` strips the
  // dither BEFORE its `JSON.stringify(paint)` cache key, and the claim in that
  // docblock is that the strip stops a second, byte-identical /Shading being minted
  // per dither setting. Deleting the strip and re-running this suite left it GREEN:
  // every other PDF assertion draws ONE gradient per document, where the cache has
  // nothing to collide with, so the strip's stated benefit was entirely unasserted.
  //
  // Two rects sharing one ramp — one dithered, one not — is the smallest scene that
  // can tell the difference: with the strip the two paints key alike and produce a
  // single /Sh1; without it they key apart and produce /Sh1 and /Sh2.
  const view = { width: 64, height: 64, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 }, background: "#ffffff" };
  const pdf = pdfSansTimestamps(await irToPDF([
    rect({ x: 0, y: 0, w: 32, h: 64, fill: ramp() }),
    rect({ x: 32, y: 0, w: 32, h: 64, fill: ramp({ ditherMode: "bayer", ditherEmphasis: 4 }) }),
  ], view));
  const shadings = new Set(pdf.match(/\/Sh\d+/g) ?? []);
  assert.deepEqual([...shadings], ["/Sh1"],
    `one ramp used twice must mint exactly one /Shading; got ${JSON.stringify([...shadings])} — the dither is leaking into the shading cache key`);
});


// A 1x1 PNG for the injected raster hook — the exporters need a rasterizer to take
// a raster route at all, and these assertions are about ROUTING, not pixels.
const STUB_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

// ── 4. BIT DEPTH (user, 2026-08-08) ──────────────────────────────────────────
// A FULL-RANGE ramp, not the near-black torture fixture: posterization is about
// where the LEVELS land across the whole 0..1 span, and a 10-level ramp cannot
// show 16 of them.
const fullRamp = (dither = {}) => parsePaint({
  type: "linearGradient",
  linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], from: { x: 0, y: 0 }, to: { x: 0, y: 1 } },
  ...dither,
});

/** Pure function. The DISTINCT values of one channel down a single column — the
 *  level count a quantisation produces, which is the thing bit depth controls. */
function columnLevels(px, sw, channel = 0, x = 10) {
  const out = new Set();
  for (let y = 0; y < px.length / (4 * sw); y++) out.add(px[(y * sw + x) * 4 + channel]);
  return [...out].sort((a, b) => a - b);
}

test("bitDepth 8 is BYTE-IDENTICAL to an absent one, with and without dither", () => {
  // THE BACK-COMPAT CLAIM. Note WHAT this actually proves and what it does not,
  // because the distinction was measured rather than guessed: `bitDepth: 8` is
  // dropped by parsePaint, so both sides here take the SAME path and this is a
  // statement about the PARSE layer (an 8-bit leaf never reaches a backend, a
  // shading cache key, or a shader uniform). That is exactly the property the
  // absent-is-default discipline needs.
  //
  // THE SHADER'S separate 8-bit branch is pinned STRUCTURALLY instead, by the
  // packDitherUniforms test below (quantise flag == 0 at 8 bits). Forcing the
  // shader to quantise explicitly at 8 bits was tried as a mutation and changed
  // NOTHING on the software backend — the two roundings agree there — so the
  // branch is DEFENSIVE rather than load-bearing on this path: it exists because
  // the GPU evaluates this in `half` precision, where a division by 255 has no
  // such guarantee, and because it costs one comparison to not find out the hard
  // way. Recorded so nobody deletes it expecting a test to catch them.
  assert.deepEqual(fullRamp({ bitDepth: 8 }), fullRamp(), "8 must not even reach the parsed object");
  assert.equal(diff(pixels(fullRamp()).px, pixels(fullRamp({ bitDepth: 8 })).px).n, 0);
  const d = { ditherMode: "bayer", ditherEmphasis: 1 };
  assert.equal(diff(pixels(fullRamp(d)).px, pixels(fullRamp({ ...d, bitDepth: 8 })).px).n, 0);
});

test("bitDepth posterizes to EXACTLY 2^bits evenly spaced levels, with NO dither", () => {
  // Hard posterization reachable with the dither OFF — the capability that was
  // nearly lost to a row-visibility rule (see core/properties.paintDitherIsOn).
  // MEASURED: 2 bits gives [0, 85, 170, 255] — 255/3 apart, i.e. the ends are held
  // exactly and the interior is evenly divided, which is what `round(v*L)/L` means.
  for (const bits of [1, 2, 3, 4]) {
    const { px, sw } = pixels(fullRamp({ bitDepth: bits }));
    const levels = columnLevels(px, sw);
    assert.equal(levels.length, 2 ** bits, `bitDepth ${bits} produced ${levels.length} distinct levels, expected ${2 ** bits}: [${levels.join(", ")}]`);
    assert.equal(levels[0], 0, "the bottom end must be held exactly");
    assert.equal(levels[levels.length - 1], 255, "the top end must be held exactly");
    const stepSize = 255 / (2 ** bits - 1);
    for (let i = 0; i < levels.length; i++)
      assert.ok(Math.abs(levels[i] - i * stepSize) <= 1, `level ${i} is ${levels[i]}, expected ~${(i * stepSize).toFixed(1)} (evenly spaced)`);
  }
  // ...and the undithered 8-bit ramp is NOT posterized, which is what makes the
  // above a measurement of this feature rather than of the ramp.
  const base = pixels(fullRamp());
  assert.ok(columnLevels(base.px, base.sw).length > 200, "the 8-bit ramp must still resolve hundreds of levels");
});

test("dither at LOW depth redistributes pixels WITHOUT adding levels", () => {
  // The defining behaviour of dithering: it cannot invent a colour the depth
  // cannot hold, it can only choose WHICH representable level each pixel takes.
  // A test that only checked "the pixels changed" would pass for a shader that
  // quantised to the wrong number of levels.
  for (const bits of [1, 2]) {
    const flat = pixels(fullRamp({ bitDepth: bits }));
    const noisy = pixels(fullRamp({ bitDepth: bits, ditherMode: "bayer", ditherEmphasis: 1 }));
    assert.ok(diff(flat.px, noisy.px).n > 0, `dither must move pixels at ${bits} bit(s)`);
    assert.deepEqual(columnLevels(noisy.px, noisy.sw), columnLevels(flat.px, flat.sw),
      `dither at ${bits} bit(s) introduced levels the depth cannot represent`);
  }
});

test("emphasis 1 does the SAME proportional work at EVERY depth — the stated relationship", () => {
  // core/properties.js PAINT_DEFAULT_BIT_DEPTH promises depth and emphasis are
  // ORTHOGONAL: depth sets the size of a step, emphasis scales the wobble in units
  // of that step. If that holds, emphasis 1 must scatter the SAME PROPORTION of
  // pixels whatever the depth — only the size of each jump changes.
  //
  // MEASURED, and it is a strikingly flat number: 18.8% of bytes move at 1, 2 and
  // 4 bits, against 18.5% at the full 8 (the earlier test's anchor). That
  // near-equality IS the orthogonality claim, expressed as something falsifiable.
  //
  // THE LOWER BOUND IS THE HALF THAT MATTERS, and this test originally lacked it:
  // it asserted only that the jump was no LARGER than one step, which a shader
  // that kept the hardcoded 1/255 step passes trivially (its wobble at 1 bit is
  // 1/255 of a 1/1 step, so it moves almost nothing and every upper bound holds).
  // That mutation was run and survived. With the lower bound it dies.
  for (const bits of [1, 2, 4]) {
    const flat = pixels(fullRamp({ bitDepth: bits }));
    const noisy = pixels(fullRamp({ bitDepth: bits, ditherMode: "bayer", ditherEmphasis: 1 }));
    const stepSize = 255 / (2 ** bits - 1);
    const d = diff(flat.px, noisy.px);
    assert.ok(d.frac > 0.12 && d.frac < 0.28,
      `at ${bits} bit(s) emphasis 1 moved ${(100 * d.frac).toFixed(1)}% of bytes; the orthogonality claim requires ~18-19% at EVERY depth (a step-independent wobble would move ~0% here)`);
    assert.ok(d.max <= stepSize + 1,
      `at ${bits} bit(s) emphasis 1 moved a channel by ${d.max}, more than the one step (${stepSize.toFixed(1)}) it is defined as`);
  }
});

test("packDitherUniforms derives levels + the quantise flag from bits", () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  assert.equal(packDitherUniforms({ mode: "bayer", emphasis: 1, bits: 8 }, I)[2], 255, "8 bits = 255 intervals");
  assert.equal(packDitherUniforms({ mode: "bayer", emphasis: 1, bits: 8 }, I)[3], 0, "8 bits must NOT set the explicit-quantise flag");
  assert.equal(packDitherUniforms({ mode: "bayer", emphasis: 1, bits: 1 }, I)[2], 1, "1 bit = 1 interval (two levels)");
  assert.equal(packDitherUniforms({ mode: "bayer", emphasis: 1, bits: 1 }, I)[3], 1, "below 8 bits must set the explicit-quantise flag");
  // A depth-only paint has NO dither mode; the packed mode must still be a number,
  // or the uniform is NaN and the shader's branch is poisoned.
  const depthOnly = packDitherUniforms({ mode: "off", emphasis: 0, bits: 2 }, I);
  assert.ok(Number.isFinite(depthOnly[0]), `a depth-only paint packed a non-finite mode code: ${depthOnly[0]}`);
  assert.equal(depthOnly[1], 0, "and no wobble");
});

test("parsePaint is LOUD on a bad bitDepth", () => {
  assert.throws(() => fullRamp({ bitDepth: 0 }), /bitDepth must be an INTEGER from 1 to 8/);
  assert.throws(() => fullRamp({ bitDepth: 9 }), /bitDepth must be an INTEGER from 1 to 8/);
  assert.throws(() => fullRamp({ bitDepth: 2.5 }), /bitDepth must be an INTEGER from 1 to 8/);
  assert.throws(() => fullRamp({ bitDepth: "2" }), /bitDepth must be an INTEGER from 1 to 8/);
  // NULL IS *NOT* AN ERROR — it is ABSENT, and that is the convention every
  // sibling leaf here already follows (`??`, as ditherEmphasis/spread/wavelength
  // do). A null at a leaf means DELETED in this codebase, which the repair
  // pipeline reports and restores to the default; refusing it at parse time would
  // make a repaired document throw on load. Asserted rather than left implicit
  // because this test originally expected the opposite and was wrong.
  assert.deepEqual(fullRamp({ bitDepth: null }), fullRamp(), "a null bitDepth is absent, i.e. 8");
});

test("a REDUCED-DEPTH gradient routes to RASTER in both vector exporters", async () => {
  // THE RULE THAT HAD TO CHANGE. At 8 bits a dropped dither is a <=1/255
  // difference and the gradient stays vector. Below 8 bits the posterization IS
  // the picture, so a smooth vector shading would export something the author did
  // not draw — the silent cross-backend divergence this project forbids. Both
  // exporters therefore route it to raster through the named predicate.
  assert.equal(opHasReducedDepthGradient({ fill: fullRamp({ bitDepth: 2 }) }), true);
  assert.equal(opHasReducedDepthGradient({ stroke: fullRamp({ bitDepth: 1, ditherMode: "bayer" }) }), true);
  assert.equal(opHasReducedDepthGradient({ fill: fullRamp({ ditherMode: "bayer" }) }), false, "an 8-bit dither must NOT rasterize — that rule is unchanged");
  assert.equal(opHasReducedDepthGradient({ fill: fullRamp() }), false);

  // A raster route needs a RASTERIZER, and both exporters demand one rather than
  // guessing — so a caller that supplies none now gets a loud configuration error
  // instead of a silently smooth gradient, which is the correct failure. The stub
  // returns a 1x1 PNG: this test asserts WHICH path was taken, not what the pixels
  // are (the tests/backdrop_export_region_test.js convention).
  const view = { width: 64, height: 64, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 }, background: "#ffffff", rasterize: async () => STUB_PNG };
  const lowSVG = await irToSVG([rect({ x: 0, y: 0, w: 64, h: 64, fill: fullRamp({ bitDepth: 2 }) })], view);
  assert.match(lowSVG, /<image/, "a 2-bit gradient must export as a raster <image> region in SVG");
  assert.doesNotMatch(lowSVG, /<linearGradient/, "...and must NOT export as a smooth vector gradient");

  const lowPDF = pdfSansTimestamps(await irToPDF([rect({ x: 0, y: 0, w: 64, h: 64, fill: fullRamp({ bitDepth: 2 }) })], view));
  assert.match(lowPDF, /\/Subtype \/Image/, "a 2-bit gradient must export as a raster XObject in PDF");
  assert.doesNotMatch(lowPDF, /ShadingType/, "...and must NOT mint a smooth shading");

  // The 8-bit case is untouched by all of the above — asserted here so a change to
  // the routing line that over-reached would be caught in the same test.
  const eightSVG = await irToSVG([rect({ x: 0, y: 0, w: 64, h: 64, fill: fullRamp({ ditherMode: "bayer" }) })], view);
  assert.match(eightSVG, /<linearGradient/, "an 8-bit dithered gradient must STILL be a vector shading");
});


test("quantisation happens in UNPREMULTIPLIED colour — a faded gradient keeps its levels", () => {
  // THE PREMULTIPLIED-ALPHA TRAP, and this test exists because its absence was
  // measured: dropping the unpremultiply from the shader left every other test in
  // this file green, because every other fixture here is fully OPAQUE and the
  // divide by 1.0 is a no-op.
  //
  // The incoming half4 is PREMULTIPLIED. Posterizing that value would quantise
  // colour and alpha TOGETHER, so a 50%-transparent mid-grey would land on a
  // different colour than the same grey at full opacity — a gradient fading out
  // would shift hue as it faded, which is not what "reduce the colour depth"
  // means. Quantise straight, then re-premultiply.
  //
  // The assertion: the same ramp at alpha 1 and at alpha 0.5 must posterize to the
  // SAME straight-colour levels. Read back Unpremul so the comparison is in the
  // space the quantisation is defined in.
  const bits = 2;
  const faded = parsePaint({
    type: "linearGradient",
    linear: { stops: [{ offset: 0, color: "#00000080" }, { offset: 1, color: "#ffffff80" }], from: { x: 0, y: 0 }, to: { x: 0, y: 1 } },
    bitDepth: bits,
  });
  // RENDERED ON A TRANSPARENT BACKGROUND, which this test needs and the others do
  // not: over the opaque black backdrop the rest of this file uses, a 50%-alpha
  // fill BLENDS to alpha 1 and the readback returns the composited colour — so the
  // straight value is gone before it can be compared and the test measures Skia's
  // blending rather than the shader's colour space. (Measured: it reported 43 vs
  // 85, which is exactly the premultiplied number, and would have been read as a
  // shader bug.)
  const clearShot = (fill) => {
    const surface = CanvasKit.MakeSurface(W, H);
    paintIR(CanvasKit, surface.getCanvas(), [rect({ x: 0, y: 0, w: W, h: H, fill })],
      { zoom: 1, panX: 0, panY: 0, dpr: 1 }, { fontCollection, background: [0, 0, 0, 0] });
    surface.flush();
    const img = surface.makeImageSnapshot();
    const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
    img.delete(); surface.dispose();
    return px;
  };
  const opaqueLevels = columnLevels(clearShot(fullRamp({ bitDepth: bits })), W);
  const fadedLevels = columnLevels(clearShot(faded), W);

  assert.equal(fadedLevels.length, opaqueLevels.length,
    `a half-transparent ramp posterized to ${fadedLevels.length} levels [${fadedLevels.join(", ")}] but the opaque one to ${opaqueLevels.length} [${opaqueLevels.join(", ")}] — the quantisation is seeing premultiplied colour`);
  // Unpremultiplying a 50%-alpha byte is lossy (128/255 is not exactly 0.5), so the
  // recovered levels are allowed to sit a couple of code values off the opaque
  // ones. Premultiplied quantisation misses by ~a third of the range, not by 2.
  for (let i = 0; i < fadedLevels.length; i++)
    assert.ok(Math.abs(fadedLevels[i] - opaqueLevels[i]) <= 4,
      `level ${i}: faded ${fadedLevels[i]} vs opaque ${opaqueLevels[i]} — quantised in the wrong colour space`);
});

console.log(`\n${passed} gradient dither tests passed`);
