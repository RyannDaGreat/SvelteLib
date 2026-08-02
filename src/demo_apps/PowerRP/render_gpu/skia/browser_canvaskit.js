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
import { bootStage, fetchWithProgress } from "../../web/bootProgress.js";
import { makeSkiaRunMeasure } from "./text_layout.js";
import { setInkMeasure } from "../../core/ink_metrics.js";

// Vite inlines every committed + fallback TTF at build time (offline-safe, hashed
// URLs) — the same mechanism web/fontLoader.js uses, resolved relative to THIS
// file. The Noto fallback set (~12.5 MB, mostly the 10.7 MB color-emoji face) is
// bundled here so the editor works with no network.
const FONT_URLS = import.meta.glob("../../fonts/*.ttf", { query: "?url", import: "default", eager: true });

let _ckPromise = null;
/**
 * Command (inits the WASM module once; memoized). Returns Promise<CanvasKit module>.
 *
 * THE BIG COLD-BOOT DOWNLOAD, and therefore the boot splash's main number. The
 * ~7 MB canvaskit.wasm is what makes a first load "a big gray box" for seconds,
 * so it is PREFETCHED here with fetch + a ReadableStream reader
 * (web/bootProgress.fetchWithProgress) to get REAL byte progress.
 *
 * WHY A BLOB URL AND NOT `wasmBinary`. Emscripten's documented "here are the
 * bytes" hooks are `wasmBinary` and `instantiateWasm`, and NEITHER EXISTS in
 * this CanvasKit build — verified by grep against
 * node_modules/canvaskit-wasm/bin/canvaskit.js, which contains zero occurrences
 * of either and unconditionally fetches whatever `locateFile` returns. Passing
 * `wasmBinary` would therefore be silently ignored and the 7 MB would download
 * TWICE: once for the progress bar and once for the module. So the prefetched
 * bytes are wrapped in a Blob and `locateFile` returns THAT object URL — the
 * module's own fetch then hits the in-memory blob, costs no network, and the
 * download stays single. The URL is revoked once init settles; holding it would
 * pin 7 MB for the life of the page.
 *
 * `canvaskitWasmUrl` is a Vite `?url` import, so it is already base-prefixed at
 * BUILD time — the prefetch is correct under `--base /SvelteLib/` for free, with
 * no runtime base math to get wrong.
 *
 * The prefetch failing is NOT swallowed: it rejects, and the caller routes that
 * to the splash's loud error surface.
 */
export function ensureCanvasKit() {
  if (!_ckPromise) {
    _ckPromise = fetchWithProgress(canvaskitWasmUrl, "wasm", "Graphics engine").then(async (bytes) => {
      bootStage("wasm-init", "Starting graphics engine", {});
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
      try {
        return await CanvasKitInit({ locateFile: () => blobUrl });
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    });
  }
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
  // BOOT STAGE 2. These faces are ~12.5 MB (the 10.7 MB colour-emoji face
  // dominates), so on a cold cache this is a visible slice of boot and the
  // splash must account for it. Progress is counted in FACES COMPLETED, not
  // bytes: they download in parallel, so a byte total would be the sum of a
  // dozen concurrent unknowns — face counts are a number we actually have.
  let facesDone = 0;
  bootStage("fonts", "Fonts", { loaded: 0, total: faces.length, unit: "count" });
  await Promise.all(
    faces.map(async ({ family, file }) => {
      const url = FONT_URLS[`../../fonts/${file}`];
      if (!url) { console.error(`browser_canvaskit: font "${file}" has no bundled URL — check fonts.js vs fonts/.`); return; }
      const buf = await (await fetch(url)).arrayBuffer();
      provider.registerFont(buf, family);
      bootStage("fonts", "Fonts", { loaded: ++facesDone, total: faces.length, unit: "count" });
    }),
  );
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(provider);
  fc.enableFontFallback(); // resolve ANY registered face for a glyph outside the run's fontFamilies
  // THE INK-METRICS SEAM (core/ink_metrics): now that the faces are registered,
  // give DOM-free core a real text measure so a text widget's `localBounds`
  // reports where the type ACTUALLY is. Installed HERE — the one place in the
  // browser where CanvasKit and the FontCollection are both known-ready — rather
  // than at each consumer, so every browser Skia consumer (editor surface AND the
  // offscreen pixel service) shares one measure. Before this runs, bounds fall
  // back to a monospace estimate and say so once; it is not silent either way.
  setInkMeasure(makeSkiaRunMeasure(CanvasKit, fc));
  return fc;
}
