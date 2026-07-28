/**
 * SHADOW OPACITY ABOVE 1 — THE OVERDRIVE CONTRACT. Plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/shadow_overdrive_test.js
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────────
 * `shadow.opacity` and `innerShadow.opacity` used to carry an invented `max: 1`
 * (core/properties.js). Deleting that line ALONE would have shipped a knob that
 * lies, because every spelling the renderer had for the value pins at 1:
 * SkColor4f's alpha (the drop shadow folded opacity into its tint colour),
 * SkPaint::setAlphaf (the inner shadow's composite), and an 8-bit alpha channel
 * itself. MEASURED before the fix: opacity 1.5, 3, 255 and 1e6 were BYTE-IDENTICAL
 * to opacity 1 — the same class of defect as the inert anti-aliasing toggle
 * (commit fd203bf, "Fix inert AA"). So this suite does not test that the property
 * accepts a large number; it tests that the number reaches the PIXELS.
 *
 * ── WHAT "ABOVE 1" MEANS, AND THE CORRECTION IT ENCODES ──────────────────────
 * Source-over is out = src·α + dst·(1−α), and it is true that nothing in that
 * equation breaks at α > 1. But feeding α > 1 to it directly is NOT the useful
 * reading: where the shadow fully covers, a dark shadow at α = 1 is ALREADY at
 * the shadow colour, and overshooting past it lands out of gamut and clamps back
 * to the very same pixel. All of the available behaviour lives where coverage is
 * PARTIAL. So the semantic is a COVERAGE MULTIPLIER with the clamp on the
 * PRODUCT, not on the factor:
 *
 *     coverage' = min(1, colorAlpha · opacity · coverage)
 *
 * The solid core cannot move (assertion CORE below), the soft penumbra is driven
 * to full strength, and the falloff hardens. That is the same artistic gesture as
 * `bloom.strength` past 1 ("higher over-glows"), which the effects bundle has
 * always allowed, through the same colour-matrix mechanism.
 *
 * ── THE ASSERTIONS ────────────────────────────────────────────────────────────
 *   PRODUCT     opacity and the shadow colour's own alpha are interchangeable
 *               factors below 1 — the historic contract, byte-for-byte.
 *   LIVE        1.0 / 1.5 / 3.0 are all DIFFERENT, and monotonically darker.
 *   CORE        a fully-covered pixel is byte-identical at 1.0 and 3.0.
 *   SATURATION  the derived ceiling: coverage is an 8-bit channel, so its
 *               smallest non-zero value is 1/255 and a multiplier of 255 drives
 *               every reachable pixel to full coverage. 255 and 1e6 must render
 *               identically, and 254 must NOT (the bound is exact, not rounded).
 *   HALO        every pixel overdrive changes lies INSIDE the op's own cull
 *               margin, so no shadow escapes its substrate and gets sliced (the
 *               manifest's 16.1 "top and left of the shadow cut off" class).
 *   EXPORT      the shadowOnly re-issue — literally the op pdf_backend and
 *               svg_backend hand to the GPU rasterizer for the embedded shadow
 *               PNG — carries the overdrive, and a REAL PDF and a REAL SVG
 *               export both change with it while carrying NO /ca or
 *               fill/flood-opacity attribute at all. That matters because both
 *               of those alpha models are specified in [0, 1]: an overdriven
 *               shadow has no spelling there, so the only correct export is the
 *               baked raster this asserts, and a future "optimization" that
 *               routes the value through gsAlphaPair or flood-opacity would
 *               silently clamp it. This is the gate against that.
 *   INNER       the same four properties for the inner shadow.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { paintIR } from "../skia/paint_skia.js";
import { rect, effectSubtree, pushTransform, popTransform, BLUR_SUPPORT_SIGMAS } from "../ir.js";
import { committedFaces, FALLBACK_FACES } from "../fonts.js";
import { renderToPng } from "../skia/node_render.js";
import { irToPDF } from "../pdf_backend.js";
import { irToSVG } from "../svg_backend.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(HERE, "..", "..", "fonts");
const OUT_DIR = path.resolve(HERE, "..", "..", ".claude_vlm_checks");

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const SIZE = { w: 420, h: 300 };
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const BACKGROUND = "#ffffff"; // white, so the shadow's own ramp is the only signal
const BOX = { x: 70, y: 60, w: 200, h: 90 };
const BLUR = 6;                 // Gaussian sigma, world units
const OFFSET = 40;              // dx = dy, big enough that the shadow clears the widget
// A pixel deep inside the OFFSET silhouette (so coverage is 1) and OUTSIDE the
// widget (so nothing is drawn over it): it must be at least BLUR_SUPPORT_SIGMAS·σ
// from every edge of the shifted rect, and below the widget's bottom edge.
const CORE = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h + 5 };
// The saturation bound, DERIVED: coverage is stored in an 8-bit alpha channel, so
// its smallest non-zero value is 1/255; a multiplier of 255 therefore lifts every
// pixel the shadow can reach (byte ≥ 1) to full coverage, and nothing above it can
// change a pixel. Not a chosen round number — 2^8−1 is the channel's own quantum.
const SATURATION_DRIVE = 255;

const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

/** Query→build (reads font files). The shared FontCollection — paintIR requires one
 *  even for a text-free scene (node_render.js recipe, as effect_bounds_test.js). */
function buildFontCollection() {
  const provider = CanvasKit.TypefaceFontProvider.Make();
  for (const { family, file } of [...committedFaces().map((f) => ({ family: f.cssFamily, file: f.file })), ...FALLBACK_FACES]) {
    const p = path.join(FONTS_DIR, file);
    if (fs.existsSync(p)) provider.registerFont(fs.readFileSync(p), family);
  }
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(provider);
  fc.enableFontFallback();
  return fc;
}
const fontCollection = buildFontCollection();

/** Query→build. The scene: a coloured widget with a black drop shadow at `opacity`. */
function scene({ opacity, color = "#000000", innerShadow = null }) {
  return [
    effectSubtree({
      ...BOX,
      shadow: opacity === null ? null : { dx: OFFSET, dy: OFFSET, blur: BLUR, color, opacity },
      innerShadow,
      content: [pushTransform(IDENTITY), rect({ ...BOX, fill: "#3f76ff" }), popTransform()],
    }),
  ];
}

/**
 * Command. Paints `commands` on a fresh software surface and returns its RGBA
 * bytes (unpremultiplied) plus the PNG for eyeballing.
 */
function render(commands) {
  const surface = CanvasKit.MakeSurface(SIZE.w, SIZE.h);
  if (!surface) throw new Error("shadow_overdrive_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), commands, VIEW, {
    fontCollection, background: BACKGROUND,
    makeSurface: (w, h) => CanvasKit.MakeSurface(w, h),
  });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: SIZE.w, height: SIZE.h, colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  const png = img.encodeToBytes();
  img.delete();
  surface.dispose();
  return { px, png };
}

/** Pure function. Count of differing bytes between two equal-length frames.
 * @example differingBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3])) // 1
 * @example differingBytes(new Uint8Array([9, 9]), new Uint8Array([9, 9])) // 0
 */
function differingBytes(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** Pure function. The largest absolute byte difference between two frames.
 * @example maxByteDiff(new Uint8Array([10, 20]), new Uint8Array([10, 25])) // 5
 * @example maxByteDiff(new Uint8Array([4]), new Uint8Array([4])) // 0
 */
function maxByteDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Pure function. A frame's RED channel at a device pixel (the shadow is grey, so
 * one channel carries the whole signal against a white page).
 * @example redAt(new Uint8Array([7, 0, 0, 255]), 0, 0, 1) // 7
 */
function redAt(px, x, y, width) {
  return px[(Math.round(y) * width + Math.round(x)) * 4];
}

/** Pure function. Mean of a frame's red channel — a monotone darkness summary.
 * @example meanRed(new Uint8Array([0, 0, 0, 255, 255, 0, 0, 255])) // 127.5
 */
function meanRed(px) {
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) { sum += px[i]; n++; }
  return sum / n;
}

/**
 * Pure function. Are ALL pixels where two frames differ inside `box` (device px)?
 * The cull-margin claim, stated as a pixel property.
 *
 * @example diffsWithin(new Uint8Array([0, 0, 0, 255]), new Uint8Array([9, 0, 0, 255]), 1, {x: -1, y: -1, w: 3, h: 3}) // true
 * @example diffsWithin(new Uint8Array([0, 0, 0, 255]), new Uint8Array([9, 0, 0, 255]), 1, {x: 5, y: 5, w: 1, h: 1}) // false
 */
function diffsWithin(a, b, width, box) {
  for (let i = 0; i < a.length; i += 4) {
    let same = true;
    for (let c = 0; c < 4; c++) if (a[i + c] !== b[i + c]) same = false;
    if (same) continue;
    const p = i / 4, x = p % width, y = Math.floor(p / width);
    if (x < box.x || x >= box.x + box.w || y < box.y || y >= box.y + box.h) return false;
  }
  return true;
}

const checks = [];
/** Command. Runs one named assertion, recording pass/fail. */
function check(name, fn) {
  fn();
  checks.push(name);
  console.log(`  ok  ${name}`);
}

// ── DROP SHADOW ───────────────────────────────────────────────────────────────
const at = new Map();
for (const k of [0.5, 1.0, 1.5, 3.0, 254, SATURATION_DRIVE, 1e6])
  at.set(k, render(scene({ opacity: k })));

check("PRODUCT: below 1, opacity and the shadow colour's own alpha are interchangeable factors", () => {
  // drive = colorAlpha · opacity, so (1 × 0.5) and (0.5 × 1) must be the same pixels.
  const viaOpacity = render(scene({ opacity: 0.5, color: "#000000" }));
  const viaColorAlpha = render(scene({ opacity: 1.0, color: "#00000080" })); // alpha 0x80/255 ≈ 0.502
  assert.ok(maxByteDiff(viaOpacity.px, viaColorAlpha.px) <= 1,
    `the product contract broke: max byte diff ${maxByteDiff(viaOpacity.px, viaColorAlpha.px)} (0x80/255 vs 0.5 is itself a 1/255 rounding, so 1 byte is the floor here)`);
});

check("LIVE: 1.0 / 1.5 / 3.0 are DIFFERENT renders (the pre-fix defect: all three were byte-identical)", () => {
  assert.notEqual(differingBytes(at.get(1.0).px, at.get(1.5).px), 0, "opacity 1.5 renders identically to 1.0 — the overdrive is INERT");
  assert.notEqual(differingBytes(at.get(1.5).px, at.get(3.0).px), 0, "opacity 3.0 renders identically to 1.5 — the overdrive is INERT");
});

check("LIVE: darkness is MONOTONE in the drive (a bigger opacity is never lighter)", () => {
  const means = [0.5, 1.0, 1.5, 3.0, SATURATION_DRIVE].map((k) => meanRed(at.get(k).px));
  for (let i = 1; i < means.length; i++)
    assert.ok(means[i] < means[i - 1], `mean red did not decrease from drive step ${i - 1} to ${i}: ${means.join(" > ")}`);
});

check("CORE: a FULLY covered shadow pixel is byte-identical at 1.0 and 3.0 (already at the shadow colour)", () => {
  const one = redAt(at.get(1.0).px, CORE.x, CORE.y, SIZE.w);
  const three = redAt(at.get(3.0).px, CORE.x, CORE.y, SIZE.w);
  // Sanity: the sample really is a saturated black core, not a penumbra pixel.
  assert.ok(one <= 1, `the CORE sample is not a solid shadow at opacity 1 (red ${one}) — the fixture geometry is wrong, not the renderer`);
  assert.equal(three, one, `overdrive moved a fully covered pixel (${one} → ${three}); it may only act where coverage is partial`);
});

check(`SATURATION: the derived ceiling ${SATURATION_DRIVE} = 1/(1/255), the 8-bit coverage quantum — above it nothing can change`, () => {
  assert.equal(differingBytes(at.get(SATURATION_DRIVE).px, at.get(1e6).px), 0,
    `drive ${SATURATION_DRIVE} and 1e6 differ — the saturation bound is not where the derivation says it is`);
  assert.notEqual(differingBytes(at.get(254).px, at.get(SATURATION_DRIVE).px), 0,
    `drive 254 already equals ${SATURATION_DRIVE} — the bound is LOWER than 1/(8-bit quantum), so the derivation in core/properties.js is wrong`);
});

check("HALO: overdrive changes NO pixel outside the op's own cull margin (the 16.1 sliced-shadow class)", () => {
  // The margin ir.js computes for this shadow, and the world→device box it covers.
  const margin = BLUR * BLUR_SUPPORT_SIGMAS + Math.hypot(OFFSET, OFFSET);
  const built = effectSubtree({ ...BOX, shadow: { dx: OFFSET, dy: OFFSET, blur: BLUR, color: "#000000", opacity: 1 }, content: [] });
  assert.equal(built.margin, margin, "the fixture's margin math drifted from ir.js effectSubtree");
  const box = { x: BOX.x - margin, y: BOX.y - margin, w: BOX.w + 2 * margin, h: BOX.h + 2 * margin };
  assert.ok(diffsWithin(at.get(1.0).px, at.get(SATURATION_DRIVE).px, SIZE.w, box),
    "a saturated shadow changed pixels OUTSIDE its cull margin — the halo bound no longer covers every opacity");
});

check("EXPORT: the shadowOnly re-issue (the exact op PDF/SVG rasterize) carries the overdrive", () => {
  // pdf_backend.emitEffect and svg_backend.emitEffectSVG both hand the GPU
  // rasterizer this op; if IT responds to the drive, both exports do, with no
  // /ca or fill-opacity in the path to clamp it.
  const only = (opacity) => render([{
    ...effectSubtree({ ...BOX, shadow: { dx: OFFSET, dy: OFFSET, blur: BLUR, color: "#000000", opacity }, content: [pushTransform(IDENTITY), rect({ ...BOX, fill: "#3f76ff" }), popTransform()] }),
    shadowOnly: true,
  }]);
  const a = only(1.0), b = only(3.0);
  assert.notEqual(differingBytes(a.px, b.px), 0, "the shadow-only raster ignores the overdrive — PDF and SVG would export a shadow the editor does not draw");
  assert.ok(meanRed(b.px) < meanRed(a.px), "the shadow-only raster got lighter at a higher drive");
});

// The two vector exporters, driven with the REAL node Skia rasterizer (not a stub
// PNG) so their embedded shadow really is the pixels the editor draws.
const rasterize = async (rawCmds, view, wPx, hPx, background) =>
  renderToPng(rawCmds, { ...view, dpr: 1 }, { width: wPx, height: hPx, background });
const EXPORT_OPTS = { width: SIZE.w, height: SIZE.h, view: VIEW, background: BACKGROUND, rasterize };

await (async () => {
  const [pdfOne, pdfThree] = [await irToPDF(scene({ opacity: 1.0 }), EXPORT_OPTS), await irToPDF(scene({ opacity: 3.0 }), EXPORT_OPTS)];
  const [svgOne, svgThree] = [await irToSVG(scene({ opacity: 1.0 }), EXPORT_OPTS), await irToSVG(scene({ opacity: 3.0 }), EXPORT_OPTS)];

  check("EXPORT PDF: a real export CHANGES with the overdrive, and carries NO /ca alpha state for it", () => {
    const latin1 = (b) => Buffer.from(b).toString("latin1");
    assert.notEqual(latin1(pdfOne), latin1(pdfThree), "the PDF export is identical at opacity 1 and 3 — the export dropped the overdrive");
    // PDF's /CA /ca pair is specified in [0, 1]; the shadow must NOT ride it, or
    // a 3.0 would clamp to 1.0 and the page would disagree with the editor.
    for (const [name, bytes] of [["1.0", pdfOne], ["3.0", pdfThree]])
      for (const [, v] of latin1(bytes).matchAll(/\/ca ([0-9.]+)/g))
        assert.ok(Number(v) <= 1, `PDF at opacity ${name} wrote /ca ${v} — an out-of-range alpha constant, which readers clamp`);
  });

  check("EXPORT SVG: a real export CHANGES with the overdrive, and carries NO opacity attribute for it", () => {
    assert.notEqual(String(svgOne), String(svgThree), "the SVG export is identical at opacity 1 and 3 — the export dropped the overdrive");
    // fill-opacity / flood-opacity / opacity are all [0, 1] in SVG, same hazard.
    for (const [name, s] of [["1.0", svgOne], ["3.0", svgThree]])
      for (const m of String(s).matchAll(/(?:fill|flood|stop)-opacity="([^"]+)"|\sopacity="([^"]+)"/g))
        assert.ok(Number(m[1] ?? m[2]) <= 1, `SVG at opacity ${name} wrote an opacity attribute of ${m[1] ?? m[2]} — out of SVG's [0, 1] range`);
  });
})();

// ── INNER SHADOW ──────────────────────────────────────────────────────────────
const inner = (opacity) => render(scene({
  opacity: null,
  innerShadow: { dx: OFFSET / 4, dy: OFFSET / 4, blur: BLUR, color: "#000000", opacity },
}));
const innerAt = new Map([[1.0, inner(1.0)], [1.5, inner(1.5)], [3.0, inner(3.0)], [SATURATION_DRIVE, inner(SATURATION_DRIVE)], [1e6, inner(1e6)]]);

check("INNER LIVE: 1.0 / 1.5 / 3.0 are DIFFERENT (the pre-fix defect: setAlphaf pinned all three at 1)", () => {
  assert.notEqual(differingBytes(innerAt.get(1.0).px, innerAt.get(1.5).px), 0, "inner shadow 1.5 renders identically to 1.0 — INERT");
  assert.notEqual(differingBytes(innerAt.get(1.5).px, innerAt.get(3.0).px), 0, "inner shadow 3.0 renders identically to 1.5 — INERT");
});

check("INNER LIVE: monotone, and the recess stays INSIDE the widget (no new outward halo)", () => {
  const means = [1.0, 1.5, 3.0, SATURATION_DRIVE].map((k) => meanRed(innerAt.get(k).px));
  for (let i = 1; i < means.length; i++)
    assert.ok(means[i] < means[i - 1], `inner-shadow mean red did not decrease at step ${i}: ${means.join(" > ")}`);
  assert.ok(diffsWithin(innerAt.get(1.0).px, innerAt.get(SATURATION_DRIVE).px, SIZE.w, BOX),
    "an overdriven INNER shadow painted outside the widget's own box — it must stay clipped to the silhouette");
});

check(`INNER SATURATION: the same ${SATURATION_DRIVE} ceiling`, () => {
  assert.equal(differingBytes(innerAt.get(SATURATION_DRIVE).px, innerAt.get(1e6).px), 0,
    "the inner shadow keeps changing past the 8-bit coverage ceiling");
});

// ── the eyeball artifacts ─────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const written = [];
for (const [k, r] of at) {
  const f = path.join(OUT_DIR, `shadow_overdrive_${String(k).replace(".", "p")}.png`);
  fs.writeFileSync(f, r.png);
  written.push(path.basename(f));
}
for (const [k, r] of innerAt) {
  const f = path.join(OUT_DIR, `inner_shadow_overdrive_${String(k).replace(".", "p")}.png`);
  fs.writeFileSync(f, r.png);
  written.push(path.basename(f));
}

console.log(`\nmeasured drop-shadow mean red: ${[0.5, 1.0, 1.5, 3.0, 254, SATURATION_DRIVE, 1e6].map((k) => `${k}→${meanRed(at.get(k).px).toFixed(3)}`).join("  ")}`);
console.log(`measured CORE red (fully covered): ${[1.0, 1.5, 3.0, SATURATION_DRIVE].map((k) => `${k}→${redAt(at.get(k).px, CORE.x, CORE.y, SIZE.w)}`).join("  ")}`);
console.log(`\n${checks.length} shadow-overdrive checks passed`);
console.log(`renders for eyeballing: ${OUT_DIR}/ (${written.length} PNGs)`);
