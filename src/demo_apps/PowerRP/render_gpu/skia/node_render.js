/**
 * Node entry for the Skia backend — inits CanvasKit once, builds the shared
 * FontCollection from ../../fonts, and renders an IR display list to PNG bytes on
 * a CPU raster surface. This is the seed of the headless CLI (Phase 6) and the
 * harness the render tests use; it shares paint_skia.js with the browser path,
 * so headless output matches the editor.
 *
 * The FontCollection holds the committed selectable families PLUS the Noto
 * fallback chain (Greek/Cyrillic/Arabic + COLOR EMOJI), so the Paragraph text
 * path resolves per-codepoint fallback identically to the browser.
 *
 * DOM-free, Node-only (uses fs + createRequire to load the CJS canvaskit-wasm
 * from an ESM module). The browser path inits CanvasKit against a WebGL2 surface
 * and injects a fetched FontCollection into the same paintIR().
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { paintIR } from "./paint_skia.js";
import { committedFaces, FALLBACK_FACES } from "../fonts.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts");

let _ck = null;
let _fontCollection = null;

/** Command (inits WASM + builds the FontCollection once; memoized). Returns the CanvasKit module. */
async function ensureCanvasKit() {
  if (_ck) return _ck;
  _ck = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
  _fontCollection = buildFontCollection(_ck);
  return _ck;
}

/**
 * Query→build (reads font files). Builds the shared FontCollection: registers the
 * committed selectable families (both weights share ONE cssFamily — Skia matches
 * weight via the run's fontStyle) plus the Noto fallback faces, into a
 * TypefaceFontProvider with font fallback enabled. A face whose TTF is MISSING is
 * reported loudly (console.warn) and skipped rather than crashing the whole
 * render — consistent with fonts.js's "a missing font must never throw in the
 * render path" contract.
 */
function buildFontCollection(CanvasKit) {
  const provider = CanvasKit.TypefaceFontProvider.Make();
  const faces = [
    ...committedFaces().map((f) => ({ family: f.cssFamily, file: f.file })),
    ...FALLBACK_FACES.map((f) => ({ family: f.family, file: f.file })),
  ];
  const missing = [];
  for (const { family, file } of faces) {
    const p = path.join(FONTS_DIR, file);
    if (!fs.existsSync(p)) { missing.push(file); continue; }
    provider.registerFont(fs.readFileSync(p), family);
  }
  if (missing.length) console.warn(`node_render: font files missing from fonts/, skipped: ${missing.join(", ")}`);
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(provider);
  fc.enableFontFallback();
  return fc;
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
  paintIR(CanvasKit, canvas, commands, view, { media, background, fontCollection: _fontCollection });
  surface.flush();
  const img = surface.makeImageSnapshot();
  if (!img) throw new Error("node_render: makeImageSnapshot returned null");
  const png = img.encodeToBytes();
  if (!png) throw new Error("node_render: encodeToBytes returned null");
  img.delete();
  surface.dispose();
  return png;
}
