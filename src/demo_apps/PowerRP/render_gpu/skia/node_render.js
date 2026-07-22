/**
 * Node entry for the Skia backend — inits CanvasKit once, loads the committed
 * typefaces from ../../fonts, and renders an IR display list to PNG bytes on a
 * CPU raster surface. This is the seed of the headless CLI (Phase 6) and the
 * harness the render tests use; it shares paint_skia.js with the browser path,
 * so headless output matches the editor.
 *
 * DOM-free, Node-only (uses fs + createRequire to load the CJS canvaskit-wasm
 * from an ESM module). The browser path will init CanvasKit against a WebGL2
 * surface and inject fetched typefaces into the same paintIR().
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { paintIR } from "./paint_skia.js";
import { committedFaces, DEFAULT_FONT } from "../fonts.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts");

let _ck = null;
let _typefaces = null;

/** Command (inits WASM + loads fonts once; memoized). Returns the CanvasKit module. */
async function ensureCanvasKit() {
  if (_ck) return _ck;
  _ck = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
  _typefaces = loadTypefaces(_ck);
  return _ck;
}

/**
 * Query→build (reads font files). Builds the `${id}:${bold}` → Typeface map from
 * the committed faces present on disk. A registry face whose TTF is MISSING is
 * reported loudly (console.warn) and skipped rather than crashing the whole
 * render — consistent with fonts.js's "a missing font must never throw in the
 * render path" contract. `system` (no file) is stood in with Inter.
 */
function loadTypefaces(CanvasKit) {
  const map = new Map();
  const missing = [];
  for (const face of committedFaces()) {
    const file = path.join(FONTS_DIR, face.file);
    if (!fs.existsSync(file)) { missing.push(face.file); continue; }
    const tf = CanvasKit.Typeface.MakeTypefaceFromData(fs.readFileSync(file));
    if (!tf) throw new Error(`node_render: MakeTypefaceFromData failed for ${face.file}`);
    map.set(`${face.id}:${face.bold ? "b" : "r"}`, tf);
  }
  if (missing.length) console.warn(`node_render: committed font files missing from fonts/, skipped: ${missing.join(", ")}`);
  const interR = map.get("inter:r"), interB = map.get("inter:b");
  if (interR) map.set(`${DEFAULT_FONT}:r`, interR); // system stand-in (no committed file)
  if (interB) map.set(`${DEFAULT_FONT}:b`, interB);
  return map;
}

/**
 * Command (allocates a GPU/CPU surface, frees it). Renders IR `commands` through
 * `view` to a PNG on a `width`×`height` device-pixel CPU surface.
 *
 * Args:
 *   commands (object[]): IR display list
 *   view ({zoom, panX, panY, dpr}): camera mapping
 *   opts.width, opts.height (number): surface size in DEVICE pixels
 *   opts.background (string): CSS clear color
 *   opts.media (object): ref → CanvasKit Image
 *
 * Returns:
 *   Promise<Uint8Array>: encoded PNG bytes
 */
export async function renderToPng(commands, view, { width, height, background = "#ffffff", media = {} } = {}) {
  const CanvasKit = await ensureCanvasKit();
  const surface = CanvasKit.MakeSurface(width, height);
  if (!surface) throw new Error("node_render: MakeSurface returned null");
  const canvas = surface.getCanvas();
  paintIR(CanvasKit, canvas, commands, view, { media, background, typefaces: _typefaces });
  surface.flush();
  const img = surface.makeImageSnapshot();
  if (!img) throw new Error("node_render: makeImageSnapshot returned null");
  const png = img.encodeToBytes();
  if (!png) throw new Error("node_render: encodeToBytes returned null");
  img.delete();
  surface.dispose();
  return png;
}
