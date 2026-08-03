/**
 * THE EFFECTS BUNDLE'S SIXTH EFFECT — `gaussianBlur` — end to end, in bare node.
 * Run: node src/demo_apps/PowerRP/tests/effect_blur_test.js
 *
 * WHY A PIXEL TEST AND NOT ONLY THE PURE GATES. effectsOff / effectsCullMargin /
 * effectSubtree are all covered by their own doctests and by the suites that read
 * BUNDLES.effects, and every one of them would still pass if the SKIA half drew
 * nothing at all: the op would be built correctly, wrapped correctly, marged
 * correctly, and the widget would come out sharp. "The IR is right" is not the
 * claim anyone cares about — "the picture is blurry" is. So this renders and
 * measures, on the CLI's SOFTWARE surface, which is also the cheapest available
 * proof that the effect survives a backend with no GPU at all.
 *
 * THE MEASUREMENT IS A/B AND SELF-CALIBRATING, deliberately. It renders TWO rects
 * differing in exactly one property — one at gaussianBlur 0, one at 14 — and
 * compares their edge ramps to each other rather than to a transcribed pixel
 * count. A hardcoded "the ramp is 55px" would be a number nobody could re-derive
 * and would break on any change to the render scale, the AA mode or the Gaussian's
 * support constant. The ratio between a sharp edge and a blurred one is the thing
 * the feature actually promises, and it holds under all of those.
 *
 * WHAT IT PROVES:
 *   (1) the sharp control really is sharp — its edge is antialiasing-width, so
 *       the comparison below has a real baseline rather than two blurred rects.
 *   (2) blur 14 produces an edge ramp many times wider, i.e. the ImageFilter is
 *       reaching the pixels at all.
 *   (3) the ramp lands within the cull halo the document model promised
 *       (BLUR_SUPPORT_SIGMAS * sigma) — the halo is what culling and the export
 *       capture rect both budget for, so a blur that spilled PAST it would be
 *       clipped at a viewport edge or cut out of an exported PNG.
 *   (4) blur is NOT free-floating: the identity (0) renders byte-identically to a
 *       document that never had the key, which is the absent-is-legacy promise.
 */

import assert from "node:assert/strict";
import { renderDocToPng } from "../cli/render.js";
import { decodePngRGBA } from "../render_gpu/tests/blend_oracle.js";
import { newDocument, withNewItem, serialize } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { BLUR_SUPPORT_SIGMAS } from "../render_gpu/ir.js";

let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => { passed++; console.log(`  ok  ${name}`); });
}

const registry = createRegistry();
registerPlugins(registry);

// The deck: two identical rects, side by side, differing ONLY in gaussianBlur.
// Colours are picked to be unambiguous under a decoder (no shared channel), so
// "which rect is this pixel" needs no tolerance.
const SHARP_FILL = "#e04070", BLURRED_FILL = "#40a0e0";
const SHARP_RGB = [224, 64, 112], BLURRED_RGB = [64, 160, 224];
const BLUR_UNITS = 14;      // canvas units of Gaussian sigma on the right-hand rect
const DOC_W = 1280;         // the default camera width these canvas units live in
const RENDER_W = 1024, RENDER_H = 576;
const SCALE = RENDER_W / DOC_W; // canvas unit -> device px

/** Query→build. The two-rect document, as serialized JSON. `blur` is the right rect's radius. */
function twoRectDoc(blur) {
  const rect = registry.get("rect").defaults;
  let doc = newDocument();
  [doc] = withNewItem(doc, 0, { ...rect, active: true, x: 200, y: 150, w: 300, h: 200, fill: SHARP_FILL, gaussianBlur: 0 });
  [doc] = withNewItem(doc, 0, { ...rect, active: true, x: 600, y: 150, w: 300, h: 200, fill: BLURRED_FILL, gaussianBlur: blur });
  return serialize(doc);
}

const png = decodePngRGBA(await renderDocToPng(twoRectDoc(BLUR_UNITS), { slide: 0, alpha: 1, width: RENDER_W, height: RENDER_H }));

/**
 * Pure function. The RGB triple at (x, y) of a decoded RGBA image.
 * @example // rgbAt({width: 2, data: Uint8Array.from([1,2,3,255, 9,9,9,255])}, 1, 0) // [9, 9, 9]
 */
function rgbAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

const eqRgb = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const WHITE = [255, 255, 255]; // the default camera background

/**
 * Query. The first scanline crossing BOTH rects' solid cores, with each core's
 * x-extent. Found rather than assumed: the rects' device rows depend on the camera
 * fit, and a hardcoded row would silently start measuring background one day.
 */
function scanlineCrossingBoth(img) {
  for (let y = 0; y < img.height; y++) {
    const sharp = [], blurred = [];
    for (let x = 0; x < img.width; x++) {
      const c = rgbAt(img, x, y);
      if (eqRgb(c, SHARP_RGB)) sharp.push(x);
      else if (eqRgb(c, BLURRED_RGB)) blurred.push(x);
    }
    if (sharp.length && blurred.length) return { y, sharp, blurred };
  }
  throw new Error("effect_blur_test: no scanline shows both rects' solid cores — the fixture did not render as designed");
}

/**
 * Pure function. How many pixels a rect's edge takes to fall from its solid core
 * to pure background, walking outward from `edgeX` in direction `step` (-1 left,
 * +1 right). This IS the quantity "blurriness" means at an edge: 1-2 px is
 * antialiasing, tens of px is a Gaussian.
 *
 * @example // a hard edge against background: the very next pixel is background
 * // rampWidth(img, 100, 40, -1) // 1
 */
function rampWidth(img, edgeX, y, step) {
  let n = 0;
  for (let x = edgeX; x >= 0 && x < img.width; x += step) {
    if (eqRgb(rgbAt(img, x, y), WHITE)) break;
    n++;
    if (n > img.width) break;
  }
  return n;
}

const { y: scanY, sharp, blurred } = scanlineCrossingBoth(png);
const sharpRamp = rampWidth(png, Math.min(...sharp), scanY, -1);
const blurredRamp = rampWidth(png, Math.max(...blurred), scanY, +1);
const sigmaPx = BLUR_UNITS * SCALE;
const haloPx = sigmaPx * BLUR_SUPPORT_SIGMAS;

console.log(`      scanline y=${scanY}: sharp core x ${Math.min(...sharp)}..${Math.max(...sharp)}, blurred core x ${Math.min(...blurred)}..${Math.max(...blurred)}`);
console.log(`      edge ramps — sharp ${sharpRamp}px, blurred ${blurredRamp}px (sigma ${sigmaPx.toFixed(1)}px, ${BLUR_SUPPORT_SIGMAS}-sigma halo ${haloPx.toFixed(0)}px)`);

// An antialiased straight edge is a couple of pixels. Allowing a few keeps this
// robust to the AA mode; the point is that it is NOT tens, so the ratio below has
// a real baseline and is not two blurred rects being compared to each other.
const MAX_ANTIALIAS_RAMP_PX = 6;
await test("(1) the CONTROL rect is genuinely sharp — its edge is antialiasing, not a blur", () => {
  assert.ok(sharpRamp <= MAX_ANTIALIAS_RAMP_PX,
    `the gaussianBlur-0 rect's edge ramps over ${sharpRamp}px, which is not an antialiased edge — the A/B has no sharp baseline, so the ratio below would prove nothing`);
});

// A Gaussian's visible ramp reaches ~2.9 sigma (where the coverage byte first hits
// 1); at sigma 11.2px that is ~32px against the control's ~3. 5x is far below that
// and far above any antialiasing, so it separates the two cases without pinning a
// number that moves with the AA mode or the render scale.
const MIN_BLUR_RAMP_RATIO = 5;
await test("(2) blur 14 softens the edge by more than an order of antialiasing", () => {
  const ratio = blurredRamp / Math.max(sharpRamp, 1);
  assert.ok(ratio >= MIN_BLUR_RAMP_RATIO,
    `the blurred rect's edge ramps over ${blurredRamp}px vs the sharp rect's ${sharpRamp}px (${ratio.toFixed(1)}x) — the ImageFilter is not reaching the pixels`);
});

// THE HALO IS MEASURED FROM THE WIDGET'S BOX EDGE, NOT FROM ITS SOLID CORE, and
// getting that wrong is how this check first failed on correct code. A Gaussian
// pulls the fully-saturated core INWARD while pushing faint ink OUTWARD, so the
// core-to-background ramp (55px here) spans BOTH movements and is nearly twice the
// outward spill. effectsCullMargin budgets only the outward half — it inflates the
// node's AABB, and the AABB is the nominal box. Measuring from the core made the
// assertion compare a two-sided quantity against a one-sided bound.
const BLURRED_BOX_RIGHT_UNITS = 900; // the right rect's x + w, in canvas units
const boxRightPx = BLURRED_BOX_RIGHT_UNITS * SCALE;

/** Query. The last x holding any ink at all on row `y`, scanning right from `fromX`. */
function lastInkRightOf(img, fromX, y) {
  let x = Math.round(fromX);
  while (x < img.width && !eqRgb(rgbAt(img, x, y), WHITE)) x++;
  return x - 1;
}

await test("(3) the blur stays INSIDE the cull halo the document model budgets for", () => {
  // effectsCullMargin / effectSubtree.margin both promise BLUR_SUPPORT_SIGMAS*sigma
  // OUTSIDE the box. Ink past that is ink culling can discard and the export
  // capture rect can clip, so this keeps the halo honest rather than decorative.
  // (Theory puts the visible edge at ~2.9 sigma, where the coverage byte first
  // reaches 1 — so passing at 3 sigma is expected to be close, not comfortable.)
  const spillPx = lastInkRightOf(png, boxRightPx, scanY) - boxRightPx;
  console.log(`      outward spill past the box edge: ${spillPx.toFixed(1)}px = ${(spillPx / sigmaPx).toFixed(2)} sigma (halo budget ${BLUR_SUPPORT_SIGMAS} sigma)`);
  assert.ok(spillPx <= haloPx,
    `the blur reaches ${spillPx.toFixed(1)}px past the box, beyond the ${haloPx.toFixed(0)}px halo effectsCullMargin promises — a blurred widget at a viewport edge would be culled with visible ink, and an exported PNG would clip it`);
  // And it must actually USE the halo: a spill far below the budget would mean the
  // blur is being clipped somewhere (the effect region is the obvious suspect),
  // which is invisible on a rect in open space and ruinous at a region boundary.
  const MIN_SPILL_SIGMAS = 2;
  assert.ok(spillPx >= MIN_SPILL_SIGMAS * sigmaPx,
    `the blur only reaches ${(spillPx / sigmaPx).toFixed(2)} sigma past the box — a Gaussian's visible edge should land near 2.9 sigma, so something is CLIPPING the spill (check the effect source region)`);
});

await test("(4) ABSENT-IS-LEGACY: gaussianBlur 0 renders byte-identically to a doc without the key", async () => {
  // The identity must not merely LOOK unblurred — it must take the pass-through
  // path in applyEffects, producing the exact bytes a pre-blur document did. A
  // stray effectSubtree wrap at radius 0 would round-trip through an 8-bit
  // offscreen and shift soft coverage by a byte, which is invisible on screen and
  // is exactly the kind of drift the bundle's byte-identity rule exists to forbid.
  const rect = registry.get("rect").defaults;
  const build = (extra) => {
    let doc = newDocument();
    [doc] = withNewItem(doc, 0, { ...rect, active: true, x: 200, y: 150, w: 300, h: 200, fill: SHARP_FILL, ...extra });
    return serialize(doc);
  };
  const opts = { slide: 0, alpha: 1, width: 320, height: 180 };
  const withZero = await renderDocToPng(build({ gaussianBlur: 0 }), opts);
  const without = await renderDocToPng(build({}), opts);
  assert.deepEqual(Buffer.from(withZero), Buffer.from(without),
    "a gaussianBlur-0 item rendered differently from one with no gaussianBlur key at all — the identity is not taking the pass-through path");
});

console.log(`\n${passed} blur effect checks passed`);
