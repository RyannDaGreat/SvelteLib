/**
 * THE SHARED PRESET-DISTINCTNESS METRIC — one colour-aware image distance, for
 * every family probe that has to prove its presets are not near-duplicates.
 * Bare node (pngjs only); no browser, no GPU.
 *
 * WHY THIS EXISTS. R6-3.13 made pairwise-distinctness the enforcement arm of the
 * anti-duplicate rule and told every future family to copy the lens-flare probe's
 * shape. Copying it verbatim copies its metric too, and that metric is a sha256
 * of the PNG BYTES (tests/lens_flare_presets_probe.js:101; transcribed again at
 * tests/sky_presets_probe.js:118) — exact identity, which passes any pair
 * differing by a single least-significant bit. Meanwhile six more probes each
 * grew their own pixel diff with three different meanings. So the repo has no
 * shared answer to "are these two pictures the same", which is the one question
 * a preset table has to answer about itself.
 *
 * THE METRIC IS PER-CHANNEL, NEVER REDUCED TO GREY. R6-3.16(b): shipped "Punch"
 * and "Punch, Hue Locked" differ ONLY in chroma — the hue lock rescales the RGB
 * triple to hold Rec.709 luma fixed by construction — so a luminance digest reads
 * them as identical and produces a FALSE RED on a correct table. Per-channel
 * absolute difference sees that pair; a grey axis cannot. This is not a new
 * invention: per-channel mean-abs is already the repo's dominant pixel metric
 * (tests/option_hover_preview_probe.js, render_pipeline_probe.js and four more),
 * and the {maxDelta, fraction} shape is the oldest one
 * (render_gpu/tests/material_reach_test.js:229). This merges the two.
 * If a PERCEPTUAL distance is ever wanted, core/ramps.js already ships
 * srgbToLinear / linearSrgbToOklab — no new dependency needed.
 *
 * WHAT IT DOES NOT DECIDE. How far apart is "far enough" is NOT derivable from
 * first principles and is deliberately not baked in here. Only the floor is
 * derivable, and it is exact: the renderer is deterministic at a frozen clock
 * (that is what the byte-digest gate relies on), so the noise floor is ZERO and
 * the smallest meaningful difference is one 8-bit code value — below that, no
 * display can show the pair apart. Everything above that is a JUDGEMENT about how
 * different two presets should look, so each family CALIBRATES its own bound in
 * its own probe against a pair known to be correctly-distinct. See R6-25.3.
 */

import { PNG } from "pngjs";

// One 8-bit sRGB code value: the smallest difference a display can represent.
// Two frames closer than this everywhere ARE the same picture after
// quantization, whatever the arithmetic says.
export const DISPLAYABLE_CODE_VALUE = 1;

// RGBA, so a pixel is four bytes and the alpha one is index 3.
const BYTES_PER_PIXEL = 4;
const COLOUR_CHANNELS = 3;

/**
 * Query (decodes bytes). A screenshot's bytes as a decoded PNG. puppeteer >= 23
 * hands back a Uint8Array and pngjs wants a Buffer, which is the one line four
 * probes each rewrote.
 *
 * @param {Uint8Array|Buffer} bytes - PNG file bytes
 * @returns {{width: number, height: number, data: Buffer}} RGBA, row-major
 */
export function readPng(bytes) {
  return PNG.sync.read(Buffer.from(bytes));
}

/**
 * Pure function. COLOUR-AWARE distance between two equally-sized RGBA images.
 * Alpha is ignored (a screenshot is opaque; an alpha difference is not something
 * the viewer sees). Three numbers, because one cannot answer both "how different"
 * and "how much of it differs":
 *
 *   meanAbs  — mean |Δ| per colour channel over every pixel, in 8-bit code
 *              values. The overall magnitude. DILUTED by area: a large change in
 *              a small region reads small, which is why maxAbs is here too.
 *   maxAbs   — the largest single-channel difference anywhere. The visibility
 *              floor: below DISPLAYABLE_CODE_VALUE the images are the same after
 *              quantization.
 *   fraction — share of pixels differing in ANY colour channel. The area term:
 *              separates "one corner changed" from "the whole frame changed".
 *
 * Throws on a size mismatch rather than comparing a prefix — two differently
 * sized frames are not a distance question, they are a broken fixture, and the
 * silent-prefix version of this is how a resized probe keeps "passing".
 *
 * @param {{width: number, height: number, data: Buffer|Uint8Array}} a - decoded RGBA image
 * @param {{width: number, height: number, data: Buffer|Uint8Array}} b - the other one
 * @returns {{meanAbs: number, maxAbs: number, fraction: number}}
 *
 * @example imageDistance({width: 1, height: 1, data: [10, 20, 30, 255]}, {width: 1, height: 1, data: [10, 20, 30, 255]})
 * // {meanAbs: 0, maxAbs: 0, fraction: 0}
 * @example imageDistance({width: 1, height: 1, data: [0, 0, 0, 255]}, {width: 1, height: 1, data: [0, 0, 30, 255]})
 * // {meanAbs: 10, maxAbs: 30, fraction: 1}   (30 over three channels; the one pixel differs)
 * @example imageDistance({width: 2, height: 1, data: [0, 0, 0, 255, 9, 9, 9, 255]}, {width: 2, height: 1, data: [0, 0, 0, 255, 9, 9, 12, 255]})
 * // {meanAbs: 0.5, maxAbs: 3, fraction: 0.5}   (3 over six channels; one of two pixels differs)
 * @example // a chroma-only pair (same Rec.709 luma, different hue) measures NONZERO — that is the point
 */
export function imageDistance(a, b) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`imageDistance: ${a.width}x${a.height} vs ${b.width}x${b.height} — same-size frames only`);
  const pixels = a.width * a.height;
  let sum = 0, maxAbs = 0, differing = 0;
  for (let i = 0; i < pixels * BYTES_PER_PIXEL; i += BYTES_PER_PIXEL) {
    let pixelChanged = false;
    for (let c = 0; c < COLOUR_CHANNELS; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      sum += d;
      if (d > maxAbs) maxAbs = d;
      if (d > 0) pixelChanged = true;
    }
    if (pixelChanged) differing++;
  }
  return {
    meanAbs: pixels ? sum / (pixels * COLOUR_CHANNELS) : 0,
    maxAbs,
    fraction: pixels ? differing / pixels : 0,
  };
}

/**
 * Pure function. Are these two frames the same picture as far as any display is
 * concerned? True when no channel anywhere differs by a full code value. This is
 * the ONE bound derivable without judgement, so it is the only one shipped here.
 *
 * @param {{maxAbs: number}} distance - an imageDistance result
 * @returns {boolean}
 *
 * @example indistinguishable({meanAbs: 0, maxAbs: 0, fraction: 0}) // true
 * @example indistinguishable({meanAbs: 0.01, maxAbs: 3, fraction: 0.002}) // false (a 3-level difference is displayable)
 */
export function indistinguishable(distance) {
  return distance.maxAbs < DISPLAYABLE_CODE_VALUE;
}

/**
 * Pure function. The CLOSEST pair among named frames, by meanAbs — so a family
 * probe reports the narrowest margin in its table rather than a bare pass/fail,
 * and an author can see which two presets are converging before they collide.
 *
 * @param {Array<{name: string, png: object}>} frames - decoded frames, each named
 * @returns {{a: string, b: string, distance: {meanAbs: number, maxAbs: number, fraction: number}}|null} null for fewer than two frames
 *
 * @example // closestPair([{name: "Punch", png: p}, {name: "Punch, Hue Locked", png: q}])
 * // {a: "Punch", b: "Punch, Hue Locked", distance: {meanAbs: 6.2, maxAbs: 41, fraction: 0.83}}
 * @example closestPair([{name: "only", png: {width: 1, height: 1, data: [0, 0, 0, 255]}}]) // null
 */
export function closestPair(frames) {
  let best = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const distance = imageDistance(frames[i].png, frames[j].png);
      if (!best || distance.meanAbs < best.distance.meanAbs)
        best = { a: frames[i].name, b: frames[j].name, distance };
    }
  return best;
}
