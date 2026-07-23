/**
 * Shared browser CanvasKit bootstrap — inits the WASM module ONCE and builds the
 * shared FontCollection ONCE, for EVERY browser Skia consumer: the on-screen
 * editor surface (browser_surface.js) AND the offscreen pixel service that feeds
 * thumbnails / minimap / PNG export (web/gpuService.js). Extracted so both share
 * one CanvasKit instance + one FontCollection rather than each spinning up its own
 * (WASM init is expensive, and the font handles are bound to a single CanvasKit
 * instance — sharing keeps them valid for every consumer).
 *
 * The FontCollection wraps a TypefaceFontProvider holding the committed selectable
 * families (registered under their unique cssFamily) PLUS the Noto fallback chain
 * (Greek/Cyrillic/Arabic + COLOR EMOJI). The Paragraph text path in paint_skia.js
 * resolves per-codepoint fallback through it, so missing glyphs render as real
 * glyphs / color emoji instead of ☐ tofu.
 *
 * Browser-only (Vite `?url` asset imports, `import.meta.glob`, fetch). The Node
 * counterpart is render_gpu/skia/node_render.js, which does the same bootstrap
 * against fs instead of fetch. Both feed the SAME paint_skia.paintIR, so browser
 * and headless output match.
 */

import CanvasKitInit from "canvaskit-wasm/bin/canvaskit.js";
import canvaskitWasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";
import { committedFaces, FALLBACK_FACES } from "../fonts.js";

// Vite inlines every committed + fallback TTF at build time (offline-safe, hashed
// URLs) — the same mechanism web/fontLoader.js uses, resolved relative to THIS
// file. The Noto fallback set (~12.5 MB, mostly the 10.7 MB color-emoji face) is
// bundled here so the editor works with no network.
const FONT_URLS = import.meta.glob("../../fonts/*.ttf", { query: "?url", import: "default", eager: true });

let _ckPromise = null;
/** Command (inits the WASM module once; memoized). Returns Promise<CanvasKit module>. */
export function ensureCanvasKit() {
  if (!_ckPromise) _ckPromise = CanvasKitInit({ locateFile: () => canvaskitWasmUrl });
  return _ckPromise;
}

let _fontCollectionPromise = null;
/**
 * Query→build (fetches font files; memoized). Builds the shared FontCollection
 * ONCE and caches the promise so every consumer shares one set. A missing/failed
 * face is reported loudly and skipped (fonts.js contract: a missing font must
 * never throw in the render path).
 */
export function loadFontCollection(CanvasKit) {
  if (!_fontCollectionPromise) _fontCollectionPromise = buildFontCollection(CanvasKit);
  return _fontCollectionPromise;
}

/** Query→build (fetches font files). The uncached body of loadFontCollection. */
async function buildFontCollection(CanvasKit) {
  const provider = CanvasKit.TypefaceFontProvider.Make();
  // (family, file): committed selectable families under their cssFamily (both
  // weights share ONE family — Skia matches weight via the run's fontStyle), then
  // the broad fallback faces under their own family names.
  const faces = [
    ...committedFaces().map((f) => ({ family: f.cssFamily, file: f.file })),
    ...FALLBACK_FACES.map((f) => ({ family: f.family, file: f.file })),
  ];
  await Promise.all(
    faces.map(async ({ family, file }) => {
      const url = FONT_URLS[`../../fonts/${file}`];
      if (!url) { console.error(`browser_canvaskit: font "${file}" has no bundled URL — check fonts.js vs fonts/.`); return; }
      const buf = await (await fetch(url)).arrayBuffer();
      provider.registerFont(buf, family);
    }),
  );
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(provider);
  fc.enableFontFallback(); // resolve ANY registered face for a glyph outside the run's fontFamilies
  return fc;
}
