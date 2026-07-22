/**
 * Headless CLI renderer test — proves cli/render.js renders a real document
 * end-to-end in bare Node (repair → fold → evaluate → cameraFrameIR → Skia
 * CanvasKit CPU surface → PNG), no browser/Vite/puppeteer.
 * Run: node src/demo_apps/PowerRP/tests/cli_render_test.js
 *
 * Covers: (1) a supported slide yields a valid non-trivial PNG at the default
 * size and a mid-tween alpha; (2) Phase 1b has landed — a slide whose widgets
 * emit backdrop ops (blur + magnifier) now renders a valid PNG through the same
 * Skia path (paint_skia implements blurBackdrop/magnifyBackdrop/cropSubtree/
 * effectSubtree/latexVector). This replaces the earlier Phase-1a "throws loudly"
 * bound now that those ops are implemented.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocToPng } from "../cli/render.js";

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "demo.powerrp.json");
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]; // \x89 P N G
const MIN_PNG_BYTES = 1000; // a blank/failed encode is far smaller than any real frame

/** Query. Do the first bytes match the PNG signature? */
function isPng(bytes) {
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

const docJson = await readFile(DEMO, "utf8");

// (1) Slides render to valid PNGs (slide 0 full, slide 1 mid-tween) and, with
// Phase 1b landed, (2) slide 2's backdrop ops (blur + magnifier) render through
// the SAME Skia path instead of throwing the old Phase-1a bound.
for (const opts of [
  { slide: 0, alpha: 1, width: 1280, height: 720 },
  { slide: 1, alpha: 0.5, width: 640, height: 360 },
  { slide: 2, alpha: 1, width: 1280, height: 720 },
]) {
  const png = await renderDocToPng(docJson, opts);
  assert.ok(png instanceof Uint8Array, `slide ${opts.slide}: expected Uint8Array`);
  assert.ok(isPng(png), `slide ${opts.slide}: not a PNG (bad magic)`);
  assert.ok(png.length >= MIN_PNG_BYTES, `slide ${opts.slide}: PNG too small (${png.length} bytes)`);
}

console.log("OK cli_render_test — slides 0/1/2 render to valid PNGs (Phase 1b backdrop ops implemented)");
