/**
 * DITHER VLM check — renders a smooth NEAR-FLAT vertical gradient (a ~16-level
 * span, the classic banding torture-test) through node_render.renderToPng four
 * ways and writes PNGs to .claude_vlm_checks/ for visual inspection:
 *   dither_off.png        — dithering off: hard 8-bit BANDS must be visible
 *   dither_bayer.png      — bayer mode, emphasis 1: bands broken into ordered grain
 *   dither_bluenoise.png  — blueNoise mode, emphasis 1: bands broken into soft grain
 *   dither_emphasis4.png  — blueNoise, emphasis 4: pronounced (grittier) grain
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

// The coordinator's mandated torture test: a NEAR-BLACK vertical gradient with a
// tiny span (~10-18 eight-bit levels) over ~1000px. 8-bit quantization gives wide
// (~60-100px) hard BANDS at dither=off; a working de-band pass dissolves them.
const TOP = "#000000";    // rgb(0, 0, 0)
const BOTTOM = "#0a0a12"; // rgb(10, 10, 18)

// One full-frame rect filled with a vertical linear gradient (objectBoundingBox
// from top y=0 to bottom y=1). Same IR path cameraFrameIR uses for the backdrop.
const gradient = parsePaint({
  type: "linearGradient",
  linear: {
    stops: [{ offset: 0, color: TOP }, { offset: 1, color: BOTTOM }],
    from: { x: 0, y: 0 },
    to: { x: 0, y: 1 },
  },
});
const commands = [rect({ x: 0, y: 0, w: W, h: H, fill: gradient })];

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude_vlm_checks");
fs.mkdirSync(OUT_DIR, { recursive: true });

const shots = [
  { file: "dither_off.png", dither: { mode: "off", emphasis: 1 } },
  { file: "dither_bayer.png", dither: { mode: "bayer", emphasis: 1 } },
  { file: "dither_bluenoise.png", dither: { mode: "blueNoise", emphasis: 1 } },
  { file: "dither_emphasis4.png", dither: { mode: "blueNoise", emphasis: 4 } },
];

for (const { file, dither } of shots) {
  const png = await renderToPng(commands, VIEW, { width: W, height: H, background: "#000000", dither });
  fs.writeFileSync(path.join(OUT_DIR, file), png);
  console.log(`wrote ${file}  (mode=${dither.mode}, emphasis=${dither.emphasis}, ${png.length} bytes)`);
}
console.log("DITHER VLM CHECK DONE →", OUT_DIR);
