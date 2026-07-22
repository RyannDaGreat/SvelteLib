/**
 * Shared browser CanvasKit bootstrap — inits the WASM module ONCE and builds the
 * committed-typeface map ONCE, for EVERY browser Skia consumer: the on-screen
 * editor surface (browser_surface.js) AND the offscreen pixel service that feeds
 * thumbnails / minimap / PNG export (web/gpuService.js). Extracted so both share
 * one CanvasKit instance + one Typeface set rather than each spinning up its own
 * (WASM init is expensive, and the Typefaces are bound to a single CanvasKit
 * instance — sharing keeps them valid for every consumer).
 *
 * Browser-only (Vite `?url` asset imports, `import.meta.glob`, fetch). The Node
 * counterpart is render_gpu/skia/node_render.js, which does the same bootstrap
 * against fs instead of fetch. Both feed the SAME paint_skia.paintIR, so browser
 * and headless output match.
 */

import CanvasKitInit from "canvaskit-wasm/bin/canvaskit.js";
import canvaskitWasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";
import { committedFaces, DEFAULT_FONT } from "../fonts.js";

// Vite inlines every committed TTF at build time (offline-safe, hashed URLs) —
// the same mechanism web/fontLoader.js uses, resolved relative to THIS file.
const FONT_URLS = import.meta.glob("../../fonts/*.ttf", { query: "?url", import: "default", eager: true });

let _ckPromise = null;
/** Command (inits the WASM module once; memoized). Returns Promise<CanvasKit module>. */
export function ensureCanvasKit() {
  if (!_ckPromise) _ckPromise = CanvasKitInit({ locateFile: () => canvaskitWasmUrl });
  return _ckPromise;
}

let _typefacesPromise = null;
/**
 * Query→build (fetches font files; memoized). Builds the `${id}:${bold}` →
 * Typeface map ONCE and caches the promise so every consumer shares one set.
 * A missing/failed face is reported loudly and skipped (fonts.js contract: a
 * missing font must never throw in the render path); `system` stands in as Inter.
 */
export function loadTypefaces(CanvasKit) {
  if (!_typefacesPromise) _typefacesPromise = buildTypefaces(CanvasKit);
  return _typefacesPromise;
}

/** Query→build (fetches font files). The uncached body of loadTypefaces. */
async function buildTypefaces(CanvasKit) {
  const map = new Map();
  await Promise.all(
    committedFaces().map(async (face) => {
      const url = FONT_URLS[`../../fonts/${face.file}`];
      if (!url) { console.error(`browser_canvaskit: committed font "${face.file}" has no bundled URL — check fonts.js vs fonts/.`); return; }
      const buf = await (await fetch(url)).arrayBuffer();
      const tf = CanvasKit.Typeface.MakeTypefaceFromData(buf);
      if (!tf) { console.error(`browser_canvaskit: MakeTypefaceFromData failed for ${face.file}`); return; }
      map.set(`${face.id}:${face.bold ? "b" : "r"}`, tf);
    }),
  );
  const interR = map.get("inter:r"), interB = map.get("inter:b");
  if (interR) map.set(`${DEFAULT_FONT}:r`, interR);
  if (interB) map.set(`${DEFAULT_FONT}:b`, interB);
  return map;
}
