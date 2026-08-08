/**
 * DITHER VLM check — the PAINT-LEVEL dither, on the repo's own banding torture
 * fixture. Renders a smooth NEAR-FLAT vertical gradient through
 * node_render.renderToPng and writes PNGs to .claude_vlm_checks/ for visual
 * inspection:
 *   dither_off.png          — no dither: hard 8-bit BANDS must be visible
 *   dither_bayer.png        — bayer, emphasis 1: bands broken into ordered grain
 *   dither_bluenoise.png    — blueNoise, emphasis 1: bands broken into soft grain
 *   dither_emphasis4.png    — blueNoise, emphasis 4: pronounced (grittier) grain
 *   dither_radial.png       — RADIAL ramp, blueNoise emphasis 4: the rings break up
 *   dither_half_and_half.png— the SAME frame, dithered gradient beside an
 *                             undithered one, which is the whole point of moving
 *                             this off the camera: one fill can be de-banded
 *                             without touching the fill next to it.
 *
 * THIS USED TO CHECK A WHOLE-FRAME CAMERA PASS. The camera's `ditherMode` /
 * `ditherEmphasis` were uprooted (user ruling, 2026-08-07) and dithering is now a
 * property of the PAINT, so the shots are built by setting the leaves on each
 * gradient rather than by passing a `dither` render option — that option no longer
 * exists and node_render REFUSES it loudly.
 *
 * Run: node tests/dither_vlm_check.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { rect, parsePaint } from "../render_gpu/ir.js";

const W = 400;
const H = 1000;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 }; // world == device px

// The banding torture test: a NEAR-BLACK vertical gradient with a tiny span
// (~10-18 eight-bit levels) over ~1000px. 8-bit quantization gives wide
// (~60-100px) hard BANDS undithered; a working de-band dissolves them.
const TOP = "#000000";    // rgb(0, 0, 0)
const BOTTOM = "#0a0a12"; // rgb(10, 10, 18)

/** Query→build. The torture ramp as a paint, with `dither` merged onto the PAINT
 *  (not onto a render option): {} is undithered, {ditherMode, ditherEmphasis} is not. */
const ramp = (dither = {}) => parsePaint({
  type: "linearGradient",
  linear: {
    stops: [{ offset: 0, color: TOP }, { offset: 1, color: BOTTOM }],
    from: { x: 0, y: 0 },
    to: { x: 0, y: 1 },
  },
  ...dither,
});

/** Query→build. The same ramp as a RADIAL gradient — it quantizes into concentric
 *  RINGS rather than horizontal bands, which is why dither applies here too. */
const radialRamp = (dither = {}) => parsePaint({
  type: "radialGradient",
  radial: {
    stops: [{ offset: 0, color: BOTTOM }, { offset: 1, color: TOP }],
    center: { x: 0.5, y: 0.5 },
    r: 0.7,
  },
  ...dither,
});

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude_vlm_checks");
fs.mkdirSync(OUT_DIR, { recursive: true });

const shots = [
  { file: "dither_off.png", scene: [rect({ x: 0, y: 0, w: W, h: H, fill: ramp() })], note: "no dither" },
  { file: "dither_bayer.png", scene: [rect({ x: 0, y: 0, w: W, h: H, fill: ramp({ ditherMode: "bayer", ditherEmphasis: 1 }) })], note: "bayer e=1" },
  { file: "dither_bluenoise.png", scene: [rect({ x: 0, y: 0, w: W, h: H, fill: ramp({ ditherMode: "blueNoise", ditherEmphasis: 1 }) })], note: "blueNoise e=1" },
  { file: "dither_emphasis4.png", scene: [rect({ x: 0, y: 0, w: W, h: H, fill: ramp({ ditherMode: "blueNoise", ditherEmphasis: 4 }) })], note: "blueNoise e=4" },
  { file: "dither_radial.png", scene: [rect({ x: 0, y: 0, w: W, h: H, fill: radialRamp({ ditherMode: "blueNoise", ditherEmphasis: 4 }) })], note: "RADIAL blueNoise e=4" },
  // THE ONE THE CAMERA PASS COULD NOT DRAW: two ramps, one frame, one dithered.
  {
    file: "dither_half_and_half.png",
    scene: [
      rect({ x: 0, y: 0, w: W / 2, h: H, fill: ramp() }),
      rect({ x: W / 2, y: 0, w: W / 2, h: H, fill: ramp({ ditherMode: "blueNoise", ditherEmphasis: 4 }) }),
    ],
    note: "LEFT undithered / RIGHT blueNoise e=4 — per-paint, in one frame",
  },
];

for (const { file, scene, note } of shots) {
  const png = await renderToPng(scene, VIEW, { width: W, height: H, background: "#000000" });
  fs.writeFileSync(path.join(OUT_DIR, file), png);
  console.log(`wrote ${file}  (${note}, ${png.length} bytes)`);
}
console.log("DITHER VLM CHECK DONE →", OUT_DIR);
