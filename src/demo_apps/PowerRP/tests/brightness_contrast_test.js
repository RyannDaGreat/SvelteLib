/**
 * BRIGHTNESS / CONTRAST region-filter suite — plain node + CanvasKit's software
 * surface, no framework, no browser.
 * Run: node src/demo_apps/PowerRP/tests/brightness_contrast_test.js
 *
 * WHAT IT PROVES, and why each claim needs a MEASUREMENT rather than a comment:
 *
 *  (1) PURE-FUNCTION CONTRACTS — the uniform packer's length/order and its LOUD
 *      rejection of a non-finite knob (a NaN uniform blackens a whole region), and
 *      isNeutralTone's definition of the identity point.
 *  (2) emit() — neutral tone emits NOTHING (the blur.js radius-0 short-circuit, which
 *      is what makes the identity byte-exact STRUCTURALLY rather than by trusting
 *      floating point), a non-neutral tone emits exactly ONE materialBackdrop naming
 *      this material with mapped select codes, and an unknown mode throws LOUD.
 *  (3) THE SkSL COMPILES — through the real material framework, so a shader edit that
 *      breaks the uniform block or the syntax fails here and not in a browser.
 *  (4) IDENTITY, BYTE-MEASURED — with neutral params forced PAST the emit()
 *      short-circuit, all three modes with the hue lock both off and on render
 *      BYTE-IDENTICAL to the same scene with no widget at all. This is the claim the
 *      brief refuses to take on assertion: it is checked pixel-for-pixel over the
 *      whole surface, including the exact sRGB decode/encode round trip the linear
 *      mode performs.
 *  (5) THE DEFAULT MODE KEEPS THE TONAL RANGE — over a full black-to-white ramp at the
 *      same heavy contrast, the smooth curve flattens 5% of the ramp onto the endpoints
 *      (pure 8-bit quantization, since it fixes 0 and 1) and keeps 190 distinct tones,
 *      while the naive sRGB ramp flattens 44% and keeps 144. Same scene, same contrast:
 *      that difference IS the reason for the default. And the smooth BRIGHTNESS blows
 *      nothing at all, where a real +1-stop exposure blows a quarter of the ramp —
 *      asserted in BOTH directions, so each mode is held to what it claims to be.
 *  (6) MONOTONE + PIVOT-FIXED — a black-to-white ramp stays non-decreasing (no inversion
 *      anywhere in the curve), and each mode's OWN pivot is a fixed point: encoded
 *      mid-grey for smooth/sRGB, linear 18% grey for the linear mode.
 *  (7) THE HUE LOCK REALLY LOCKS HUE — on a saturated patch the channel RATIOS are
 *      preserved to within a quantization step with the lock on, and measurably move
 *      with it off. Both halves matter: the second is what proves the switch does
 *      something.
 *  (8) AN ADJUSTMENT OF NOTHING IS NOTHING — over a TRANSPARENT area the widget adds no
 *      opaque rectangle. This is the failure mode pdf_backend.js regionOverBackground
 *      documents (a sampler over an un-drawn page came out BLACK in every export), and
 *      the reason this material departs from its siblings' alpha convention.
 *  (9) PROXY QUALITY IS CHEAP — at quality "proxy" the op allocates NO offscreen
 *      surfaces (no below-content re-render) and runs no SkSL, and the region still
 *      reads as content rather than a hole.
 * (10) PDF AND SVG EXPORT THE REAL TONE — both exporters, driven through a REAL Skia
 *      rasterizer rather than a stub, produce a region whose pixels are the toned scene.
 *      backdrop_export_region_test.js pins that contract STRUCTURALLY for every sampler;
 *      this closes it with PIXELS for this one, because export-black is the specific
 *      regression this family has already shipped once.
 *
 * It also writes a VLM-checkable contact sheet per case to .claude_vlm_checks/.
 */

import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { rect, materialBackdrop, pushTransform, popTransform } from "../render_gpu/ir.js";
import { getMaterial, isBackdropMaterial, materialEffect, materialIds } from "../render_gpu/skia/materials.js";
import { irToPDF } from "../render_gpu/pdf_backend.js";
import { irToSVG } from "../render_gpu/svg_backend.js";
import { packBrightnessContrastUniforms, BRIGHTNESS_CONTRAST_DISPLACED_EVALS } from "../render_gpu/skia/brightness_contrast_shader.js";
import { brightnessContrastPlugin, isNeutralTone, NEUTRAL_BRIGHTNESS, NEUTRAL_CONTRAST } from "../plugins/demo/brightness_contrast.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude_vlm_checks");

const W = 480, H = 320;                 // scene size in world units
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };  // dpr 1 so surface px == world px
const REGION = { x: 40, y: 40, w: 400, h: 240 };     // the adjusted region, inset so its edge is visible
const PAGE = "#101014";                 // the opaque page the scene sits on
const HEAVY_CONTRAST = 1.8;             // enough contrast that the naive ramp clips obviously
const CHANNEL_MAX = 255;                // 8-bit readback range
const LSB = 1;                          // one 8-bit quantization step — the tolerance for "did not move"
const RAMP_EDGE_SKIP = 2;               // skip the ramp's own antialiased end columns, which are not curve output
// Ceilings/floors for the clipping gate, set from the MEASURED numbers in rampDetail's
// docstring with room to spare — they separate "8-bit quantization at the endpoint"
// from "the curve destroyed a fifth of the range".
const SMOOTH_MAX_FLAT_FRAC = 0.08;      // smooth measured 5.1% of the ramp flattened, both ends together
const NAIVE_MIN_FLAT_FRAC = 0.30;       // the naive ramp measured 43.8%
const NAIVE_FLAT_RATIO = 4;             // and at least this many times smooth's (measured 8.7x)

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
/** Command. The async twin of test() (the backdrop_export_region_test.js atest precedent). */
async function atest(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
const fontCollection = CanvasKit.FontCollection.Make(); // the scenes carry no text

// ── the test scene ────────────────────────────────────────────────────────────
// Deliberately hostile to a naive tone curve: a full black-to-white RAMP (so any
// crushing or blowing at either end is countable), SATURATED colour bars (so a hue
// shift is measurable), and flat reference patches at pure black / mid-grey / pure
// white (so "the pivot did not move" is a direct read).
const RAMP = { x: 60, y: 60, w: 360, h: 90 };
const BARS = ["#cc3311", "#2266dd", "#22aa55", "#ddaa22", "#aa44cc"];
const BAR = { y: 165, h: 60, w: 70, gap: 2, x: 60 };
// Flat reference patches, including ONE AT EACH MODE'S PIVOT — the two pivots are the
// same perceptual place expressed in the two working spaces, which is exactly why
// neither needed a knob: 0x80 is ENCODED 0.502 (the smooth / sRGB pivot) and 0x76 is
// ENCODED 0.463, which decodes to LINEAR 0.1812 — the linear mode's 18% mid-grey.
const PIVOT_PATCH_ENCODED = "#808080";
const PIVOT_PATCH_LINEAR = "#767676";
const PATCHES = [["#000000", 60], [PIVOT_PATCH_LINEAR, 130], [PIVOT_PATCH_ENCODED, 200], ["#ffffff", 270]];
const PATCH = { y: 238, w: 70, h: 34 };
// Which patch is the fixed point of which mode's contrast.
const MODE_PIVOT_PATCH = { 0: PIVOT_PATCH_ENCODED, 1: PIVOT_PATCH_LINEAR, 2: PIVOT_PATCH_ENCODED };

/** Query→build. The scene beneath the widget: page, ramp, saturated bars, reference patches. */
function scene() {
  const cmds = [rect({ x: 0, y: 0, w: W, h: H, fill: PAGE })];
  cmds.push(rect({
    ...RAMP,
    fill: { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } } },
  }));
  BARS.forEach((fill, i) => cmds.push(rect({ x: BAR.x + i * (BAR.w + BAR.gap), y: BAR.y, w: BAR.w, h: BAR.h, fill })));
  PATCHES.forEach(([fill, x]) => cmds.push(rect({ x, y: PATCH.y, w: PATCH.w, h: PATCH.h, fill })));
  return cmds;
}

/** Pure function. A brightness_contrast op over REGION with the given knobs (bypasses
 * emit(), which is exactly what lets the neutral case be measured through the SHADER). */
function toneOp({ mode = 0, brightness = 0, contrast = 1, preserveHue = 0, cornerRadius = 0 }) {
  return materialBackdrop({
    material: "brightness_contrast",
    cx: REGION.x + REGION.w / 2, cy: REGION.y + REGION.h / 2,
    halfW: REGION.w / 2, halfH: REGION.h / 2,
    cornerRadius, blurRadius: 0, backdropScale: 1,
    params: { mode, brightness, contrast, preserveHue },
  });
}

/**
 * Command (allocates a surface, frees it). Renders `commands` and returns the readback
 * pixels (RGBA_8888, UNPREMULTIPLIED so a channel is directly the displayed value), the
 * PNG bytes, and the count of offscreen surfaces paintIR allocated.
 */
function render(commands, { quality = "full", background = PAGE } = {}) {
  let surfaces = 0;
  const makeSurface = (w, h) => { surfaces++; return CanvasKit.MakeSurface(w, h); };
  const surface = CanvasKit.MakeSurface(W, H); // the SINK — not counted
  if (!surface) throw new Error("brightness_contrast_test: MakeSurface(sink) returned null");
  paintIR(CanvasKit, surface.getCanvas(), commands, VIEW, { fontCollection, background, makeSurface, quality });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  const png = img.encodeToBytes();
  img.delete();
  surface.dispose();
  return { px: Uint8Array.from(px), png, surfaces };
}

/** Pure function. The RGBA quadruple at world (x, y) — dpr 1, so world px == surface px.
 * @example // pixelAt(px, 0, 0) // [16, 16, 20, 255] on the PAGE colour */
function pixelAt(px, x, y) {
  const o = (y * W + x) * 4;
  return [px[o], px[o + 1], px[o + 2], px[o + 3]];
}

/**
 * Pure function. TONAL DETAIL SURVIVAL along the ramp's mid-row: how many columns the
 * curve has flattened onto pure black (`crushed`) and pure white (`blown`), and how many
 * DISTINCT tones are left out of `cols`.
 *
 * This is the honest clipping metric, and it is NOT the same as "count extreme samples
 * anywhere in the region": a curve that fixes 0 and 1 still quantizes a few codes at
 * each end onto the endpoint, because 8 bits cannot represent the difference. What
 * separates a good contrast operator from a clipping one is the WIDTH of the flat end
 * and how much of the tonal range survives — measured, at contrast 1.8: the smooth curve
 * flattens 9 of 356 columns at each end and keeps 190 tones, the naive ramp flattens 78
 * at each end and keeps 144.
 *
 * @param {Uint8Array} px - RGBA readback of the whole surface
 * @returns {{crushed: number, blown: number, distinct: number, cols: number}}
 *
 * @example // rampDetail(sourcePixels)          // {crushed: 0, blown: 0, distinct: 252, cols: 356}
 * @example // rampDetail(smoothContrast18Pixels) // {crushed: 9, blown: 9, distinct: 190, cols: 356}
 * @example // rampDetail(naiveContrast18Pixels)  // {crushed: 78, blown: 78, distinct: 144, cols: 356}
 */
function rampDetail(px) {
  const row = RAMP.y + Math.floor(RAMP.h / 2);
  const seen = new Set();
  let crushed = 0, blown = 0;
  for (let x = RAMP.x + RAMP_EDGE_SKIP; x < RAMP.x + RAMP.w - RAMP_EDGE_SKIP; x++) {
    const g = pixelAt(px, x, row)[1];
    if (g === 0) crushed++;
    if (g === CHANNEL_MAX) blown++;
    seen.add(g);
  }
  return { crushed, blown, distinct: seen.size, cols: RAMP.w - 2 * RAMP_EDGE_SKIP };
}

/** Pure function. Index of the first differing byte between two equal-length pixel
 * buffers, or -1 when they are identical.
 * @example firstDiff(Uint8Array.of(1, 2), Uint8Array.of(1, 2)) // -1
 * @example firstDiff(Uint8Array.of(1, 2), Uint8Array.of(1, 9)) // 1 */
function firstDiff(a, b) {
  if (a.length !== b.length) throw new Error(`firstDiff: length mismatch ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** Pure function. The largest RELATIVE deviation between two colour triples' channel
 * RATIOS, normalized by each triple's own max channel. 0 = identical hue+saturation
 * (only brightness differs), which is exactly what the hue lock promises.
 * @example ratioDrift([200, 100, 50], [100, 50, 25]) // 0 (same ratios, half as bright)
 * @example +ratioDrift([200, 100, 50], [200, 150, 50]).toFixed(2) // 0.25 (green pulled up) */
function ratioDrift(a, b) {
  const na = Math.max(...a) || 1, nb = Math.max(...b) || 1;
  return Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] / na - b[i] / nb)));
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const shots = [];
/** Command (writes a PNG to .claude_vlm_checks/ and records it for the summary). */
function shot(name, png) {
  const out = path.join(OUT_DIR, `brightness_contrast_${name}.png`);
  fs.writeFileSync(out, Buffer.from(png));
  shots.push(out);
}

// ══ (1) pure-function contracts ═══════════════════════════════════════════════
test("packBrightnessContrastUniforms: 10 floats in declaration order", () => {
  const u = packBrightnessContrastUniforms({ cx: 200, cy: 150, halfW: 210, halfH: 140, cornerRadius: 12, angle: 0.25, mode: 1, brightness: -1.2, contrast: 1.6, preserveHue: 1 });
  assert.equal(u.length, 10);
  assert.deepEqual([...u].map((v) => Math.round(v * 1e4) / 1e4), [200, 150, 210, 140, 12, 0.25, 1, -1.2, 1.6, 1]);
});

test("packBrightnessContrastUniforms: LOUD on a non-finite knob (a NaN uniform blackens the region)", () => {
  const base = { cx: 0, cy: 0, halfW: 8, halfH: 6, cornerRadius: 0, angle: 0, mode: 0, brightness: 0, contrast: 1, preserveHue: 0 };
  assert.throws(() => packBrightnessContrastUniforms({ ...base, contrast: NaN }), /"contrast" must be a finite number/);
  assert.throws(() => packBrightnessContrastUniforms({ ...base, brightness: Infinity }), /"brightness" must be a finite number/);
  assert.throws(() => packBrightnessContrastUniforms({ ...base, halfW: "8" }), /"halfW" must be a finite number/);
});

test("the shader is a POINT operation: it samples the backdrop only at the fragment coordinate", () => {
  // The premise of the material's zero outward reach (see the maxSampleReach note on
  // the descriptor). brightness_contrast_shader.js throws at IMPORT if this stops
  // holding, so reaching this line already proves it; asserting the exported list keeps
  // the property visible in the suite that owns the material's contract.
  assert.deepEqual(BRIGHTNESS_CONTRAST_DISPLACED_EVALS, []);
});

test("isNeutralTone: identity is brightness 0 + contrast 1, in EVERY mode and either hue setting", () => {
  for (const mode of ["smooth", "linear", "srgb"])
    for (const preserveHue of [false, true])
      assert.equal(isNeutralTone({ brightness: NEUTRAL_BRIGHTNESS, contrast: NEUTRAL_CONTRAST, mode, preserveHue }), true, `${mode}/${preserveHue}`);
  assert.equal(isNeutralTone({ brightness: 0, contrast: 1.4 }), false);
  assert.equal(isNeutralTone({ brightness: -0.2, contrast: 1 }), false);
});

// ══ (2) emit() ════════════════════════════════════════════════════════════════
const DEF = brightnessContrastPlugin.defaults;

test("the plugin's DEFAULT is a visible amount, not its identity (the blur.js default-6 precedent)", () => {
  assert.equal(DEF.brightness, NEUTRAL_BRIGHTNESS);
  assert.notEqual(DEF.contrast, NEUTRAL_CONTRAST);
  assert.equal(isNeutralTone(DEF), false);
  assert.equal(brightnessContrastPlugin.emit(DEF).length, 1);
});

test("emit(): a NEUTRAL tone emits NOTHING (identity is structural, not floating point)", () => {
  const neutral = { ...DEF, brightness: NEUTRAL_BRIGHTNESS, contrast: NEUTRAL_CONTRAST };
  for (const mode of ["smooth", "linear", "srgb"])
    for (const preserveHue of [false, true])
      assert.deepEqual(brightnessContrastPlugin.emit({ ...neutral, mode, preserveHue }), [], `${mode}/${preserveHue}`);
});

test("emit(): a non-neutral tone emits exactly ONE materialBackdrop with mapped codes", () => {
  const cmds = brightnessContrastPlugin.emit({ ...DEF, mode: "linear", brightness: -1.2, contrast: 1.6, preserveHue: true });
  assert.equal(cmds.length, 1);
  const c = cmds[0];
  assert.equal(c.op, "materialBackdrop");
  assert.equal(c.material, "brightness_contrast");
  assert.deepEqual(c.params, { mode: 1, brightness: -1.2, contrast: 1.6, preserveHue: 1 });
  // A tone curve is a POINT operation: no blurred child is ever built and a
  // supersampled below-content re-render would cost more and resolve less.
  assert.equal(c.blurRadius, 0);
  assert.equal(c.backdropScale, 1);
  assert.equal(c.halfW, DEF.w / 2);
  assert.equal(c.halfH, DEF.h / 2);
});

test("emit(): mode select codes cover every declared option, and an unknown mode throws LOUD", () => {
  const codes = ["smooth", "linear", "srgb"].map((mode) => brightnessContrastPlugin.emit({ ...DEF, mode })[0].params.mode);
  assert.deepEqual(codes, [0, 1, 2]);
  assert.throws(() => brightnessContrastPlugin.emit({ ...DEF, mode: "filmic" }), /unknown mode "filmic"/);
});

// ══ (3) the SkSL compiles through the real framework ══════════════════════════
test("the material is REGISTERED as a backdrop material and its SkSL compiles", () => {
  assert.ok(materialIds().includes("brightness_contrast"));
  const m = getMaterial("brightness_contrast");
  assert.equal(isBackdropMaterial(m), true);
  assert.equal(m.usesBlurredBackdrop, false); // a point operation never reads the blurred child
  assert.ok(materialEffect(CanvasKit, m), "SkSL must compile (materialEffect throws with the compiler error otherwise)");
});

// ══ (4) IDENTITY, byte-measured through the SHADER ════════════════════════════
const bare = render(scene());
shot("00_source", bare.png);

test("IDENTITY: neutral params render BYTE-IDENTICAL to no widget at all, in every mode", () => {
  for (const [label, mode] of [["smooth", 0], ["linear", 1], ["srgb", 2]])
    for (const preserveHue of [0, 1]) {
      const withOp = render([...scene(), toneOp({ mode, brightness: 0, contrast: 1, preserveHue })]);
      const i = firstDiff(bare.px, withOp.px);
      assert.equal(i, -1, `${label} hueLock=${preserveHue}: first differing byte at ${i} (px ${Math.floor(i / 4) % W},${Math.floor(i / 4 / W)}) — bare ${bare.px[i]} vs toned ${withOp.px[i]}`);
    }
});

// ══ (5) the default mode CANNOT clip; the naive one does ══════════════════════
const smoothPunch = render([...scene(), toneOp({ mode: 0, contrast: HEAVY_CONTRAST })]);
const srgbPunch = render([...scene(), toneOp({ mode: 2, contrast: HEAVY_CONTRAST })]);
shot("01_smooth_punch", smoothPunch.png);
shot("02_srgb_punch_clips", srgbPunch.png);

test(`at contrast ${HEAVY_CONTRAST} the SMOOTH curve keeps the tonal range; the naive ramp destroys a third of it`, () => {
  const src = rampDetail(bare.px);
  const smooth = rampDetail(smoothPunch.px);
  const naive = rampDetail(srgbPunch.px);
  const flat = (d) => d.crushed + d.blown;
  for (const [label, d] of [["source", src], ["smooth", smooth], ["sRGB ", naive]])
    console.log(`      ${label}: crushed ${String(d.crushed).padStart(3)}  blown ${String(d.blown).padStart(3)}  of ${d.cols} ramp columns; ${d.distinct} distinct tones survive`);
  assert.equal(flat(src), 0, "the source ramp must span the full range with nothing flat");
  assert.ok(flat(smooth) <= src.cols * SMOOTH_MAX_FLAT_FRAC, `smooth flattened ${flat(smooth)}/${src.cols} columns — above the ${SMOOTH_MAX_FLAT_FRAC * 100}% quantization allowance, so it is really clipping`);
  assert.ok(flat(naive) >= src.cols * NAIVE_MIN_FLAT_FRAC, `the naive ramp must visibly clip at this contrast: ${flat(naive)}/${src.cols}`);
  assert.ok(flat(naive) >= flat(smooth) * NAIVE_FLAT_RATIO, `the naive ramp must clip far more than smooth: ${flat(naive)} vs ${flat(smooth)}`);
  assert.ok(smooth.distinct > naive.distinct, `smooth must preserve more distinct tones: ${smooth.distinct} vs ${naive.distinct}`);
});

test("SMOOTH brightness cannot blow highlights; LINEAR brightness is an exposure and CAN (each mode is what it says)", () => {
  const smoothLift = rampDetail(render([...scene(), toneOp({ mode: 0, brightness: 1 })]).px);
  const exposureLift = rampDetail(render([...scene(), toneOp({ mode: 1, brightness: 1 })]).px);
  console.log(`      brightness +1: smooth blown ${smoothLift.blown}, linear-light (+1 stop) blown ${exposureLift.blown} of ${smoothLift.cols}`);
  assert.equal(smoothLift.blown, 0, "the smooth gamma lift fixes white, so a full-range ramp must have nothing blown");
  assert.equal(smoothLift.crushed, 0, "and it fixes black too");
  assert.ok(exposureLift.blown > smoothLift.cols * 0.1, `+1 stop of real exposure must clip the highlights (that IS exposure): ${exposureLift.blown}`);
});

// ══ (6) monotone + pivot-fixed ═══════════════════════════════════════════════
test("every mode keeps the ramp MONOTONE (no inversion anywhere in the curve)", () => {
  const row = RAMP.y + Math.floor(RAMP.h / 2);
  for (const [label, mode, brightness] of [["smooth", 0, 0.3], ["linear", 1, 0.5], ["srgb", 2, 0.05]]) {
    const px = render([...scene(), toneOp({ mode, brightness, contrast: 1.5 })]).px;
    let prev = -1;
    for (let x = RAMP.x + 2; x < RAMP.x + RAMP.w - 2; x++) {
      const g = pixelAt(px, x, row)[1];
      assert.ok(g >= prev - LSB, `${label}: ramp inverted at x=${x} (${prev} -> ${g})`);
      prev = Math.max(prev, g);
    }
  }
});

test("contrast is a FIXED POINT at each mode's own pivot (encoded mid-grey; linear 18% grey)", () => {
  for (const [label, mode] of [["smooth", 0], ["linear", 1], ["srgb", 2]]) {
    const [, patchX] = PATCHES.find(([fill]) => fill === MODE_PIVOT_PATCH[mode]);
    const probe = [patchX + Math.floor(PATCH.w / 2), PATCH.y + Math.floor(PATCH.h / 2)];
    const source = pixelAt(bare.px, ...probe);
    const got = pixelAt(render([...scene(), toneOp({ mode, contrast: HEAVY_CONTRAST })]).px, ...probe);
    for (let ch = 0; ch < 3; ch++)
      assert.ok(Math.abs(got[ch] - source[ch]) <= LSB, `${label}: its pivot patch moved ${source[ch]} -> ${got[ch]} (contrast must leave the pivot alone)`);
  }
});

// ══ (7) the hue lock ══════════════════════════════════════════════════════════
const hueLocked = render([...scene(), toneOp({ mode: 0, contrast: HEAVY_CONTRAST, preserveHue: 1 })]);
shot("03_smooth_punch_hue_locked", hueLocked.png);

test("the hue lock preserves channel RATIOS on saturated colour; per-channel grading moves them", () => {
  let worstLocked = 0, bestFree = 0;
  BARS.forEach((_, i) => {
    const probe = [BAR.x + i * (BAR.w + BAR.gap) + Math.floor(BAR.w / 2), BAR.y + Math.floor(BAR.h / 2)];
    const src = pixelAt(bare.px, ...probe).slice(0, 3);
    worstLocked = Math.max(worstLocked, ratioDrift(src, pixelAt(hueLocked.px, ...probe).slice(0, 3)));
    bestFree = Math.max(bestFree, ratioDrift(src, pixelAt(smoothPunch.px, ...probe).slice(0, 3)));
  });
  console.log(`      worst ratio drift over the colour bars: hue-locked ${worstLocked.toFixed(4)}, per-channel ${bestFree.toFixed(4)}`);
  // 2 LSB / 255 is the quantization floor for a ratio read off an 8-bit readback.
  assert.ok(worstLocked <= 3 / CHANNEL_MAX, `hue lock must hold the ratios: drift ${worstLocked}`);
  assert.ok(bestFree > 10 * worstLocked + 0.02, `per-channel grading must measurably move the ratios (else the lock switch does nothing): ${bestFree} vs ${worstLocked}`);
});

// ══ (8) an adjustment of NOTHING is NOTHING ══════════════════════════════════
test("over a TRANSPARENT area the widget adds no opaque rectangle (the export-black failure mode)", () => {
  // No page rect and a transparent clear: the region has literally nothing beneath it.
  const empty = render([toneOp({ mode: 0, brightness: -1, contrast: HEAVY_CONTRAST })], { background: "#00000000" });
  shot("04_over_transparent", empty.png);
  const probe = [REGION.x + Math.floor(REGION.w / 2), REGION.y + Math.floor(REGION.h / 2)];
  assert.equal(pixelAt(empty.px, ...probe)[3], 0, "the centre of the region must stay fully transparent, not become an opaque toned rect");
  let opaque = 0;
  for (let y = REGION.y; y < REGION.y + REGION.h; y++)
    for (let x = REGION.x; x < REGION.x + REGION.w; x++) if (pixelAt(empty.px, x, y)[3] > 0) opaque++;
  assert.equal(opaque, 0, `${opaque} px of the region became non-transparent over an empty page`);
});

// ══ (9) proxy quality is cheap ════════════════════════════════════════════════
test("PROXY quality: no offscreen surfaces, no SkSL, and the region still reads as content", () => {
  const cmds = [...scene(), pushTransform({ x: 0, y: 0 }), toneOp({ mode: 0, contrast: HEAVY_CONTRAST }), popTransform()];
  const full = render(cmds, { quality: "full" });
  const proxy = render(cmds, { quality: "proxy" });
  shot("05_proxy", proxy.png);
  console.log(`      offscreen surfaces: full=${full.surfaces} proxy=${proxy.surfaces}`);
  assert.equal(proxy.surfaces, 0, "a backdrop sampler at proxy quality must allocate no below-content re-render");
  assert.ok(full.surfaces > 0, "the full path is expected to re-render the content beneath");
  const probe = [REGION.x + Math.floor(REGION.w / 2), REGION.y + Math.floor(REGION.h / 2)];
  const [r, g, b, a] = pixelAt(proxy.px, ...probe);
  assert.equal(a, CHANNEL_MAX, "the proxy stand-in must sit over opaque page content, not punch a hole");
  assert.ok(Math.max(r, g, b) > 3, "the proxy must not render black");
});

// ══ (10) PDF / SVG export renders the REAL TONE, not black ════════════════════
// The brief's standing hazard: backdrop materials have silently exported BLACK before
// (pdf_backend.js regionOverBackground documents the measurement — 92% of a region's
// opaque pixels near-black over a light page). backdrop_export_region_test.js pins that
// contract STRUCTURALLY with a stub rasterizer; this closes it with REAL PIXELS for this
// material, through BOTH exporters, using the same Skia rasterizer the editor paints on.
await atest("PDF and SVG export the real toned pixels (not black), through a REAL rasterizer", async () => {
  const page = { width: W, height: H, view: { zoom: 1, panX: 0, panY: 0 }, background: PAGE };
  const cmds = [...scene(), toneOp({ mode: 0, brightness: 0.5, contrast: 1.4 })];
  const captured = [];
  /** Command (records the region, returns real PNG bytes). The exporters' raster hook,
   * wired to the SAME paintIR + software Skia surface the CLI renderer uses. */
  const rasterize = async (ir, rasterView, wPx, hPx, background) => {
    let surfaces = 0;
    const surface = CanvasKit.MakeSurface(wPx, hPx);
    if (!surface) throw new Error("brightness_contrast_test: MakeSurface(raster region) returned null");
    paintIR(CanvasKit, surface.getCanvas(), ir, { ...rasterView, dpr: 1 }, { fontCollection, background, makeSurface: (w, h) => { surfaces++; return CanvasKit.MakeSurface(w, h); } });
    surface.flush();
    const img = surface.makeImageSnapshot();
    const px = Uint8Array.from(img.readPixels(0, 0, { width: wPx, height: hPx, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB }));
    const png = img.encodeToBytes();
    img.delete();
    surface.dispose();
    captured.push({ wPx, hPx, px, surfaces });
    return png;
  };

  for (const [label, exporter] of [["PDF", irToPDF], ["SVG", irToSVG]]) {
    captured.length = 0;
    const out = await exporter(cmds, { ...page, rasterize });
    assert.ok(out && out.length > 0, `${label}: exporter produced nothing`);
    assert.ok(captured.length > 0, `${label}: a backdrop sampler must force a raster region`);
    // The sampler must have had scene content to sample (a below-content re-render).
    assert.ok(captured.some((c) => c.surfaces > 0), `${label}: no below-content re-render happened in any raster region`);
    // The headline: the region is the TONED SCENE, not black and not a flat slab.
    for (const c of captured) {
      let sum = 0, distinct = new Set();
      for (let i = 0; i < c.px.length; i += 4) { const v = c.px[i + 1]; sum += v; distinct.add(v); }
      const mean = sum / (c.px.length / 4);
      console.log(`      ${label} raster region ${c.wPx}x${c.hPx}: mean green ${mean.toFixed(1)}, ${distinct.size} distinct greens`);
      assert.ok(mean > 20, `${label}: the exported region is near-black (mean green ${mean.toFixed(1)}) — the export-black bug`);
      assert.ok(distinct.size > 32, `${label}: the exported region has only ${distinct.size} distinct greens — the scene beneath did not survive`);
    }
  }
});

// ── the extra looks, for the VLM check only ───────────────────────────────────
shot("06_dim_for_overlay", render([...scene(), toneOp({ mode: 1, brightness: -1.2, contrast: 1 })]).png);
shot("07_exposure_plus_1_stop", render([...scene(), toneOp({ mode: 1, brightness: 1, contrast: 1 })]).png);
shot("08_wash_out", render([...scene(), toneOp({ mode: 0, brightness: 0.4, contrast: 0.45 })]).png);
shot("09_rounded_rotated", render([...scene(), pushTransform({ x: 0, y: 0, rotation: 0.12, scale: 1 }), toneOp({ mode: 0, contrast: 1.6, cornerRadius: 40 }), popTransform()]).png);

console.log(`\n  ${shots.length} PNGs written for a VLM check:`);
for (const s of shots) console.log(`    ${s}`);
console.log(`\nOK brightness_contrast_test — ${passed} tests passed`);
