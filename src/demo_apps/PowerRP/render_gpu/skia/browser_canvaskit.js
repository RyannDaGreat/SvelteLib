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
import { committedFaces, fontFileFor, FALLBACK_FACES } from "../fonts.js";
import { bootStage, fetchWithProgress } from "../../web/bootProgress.js";
import { fontBytes } from "../../web/fontBytes.js";
import { makeSkiaRunMeasure } from "./text_layout.js";
import { setInkMeasure } from "../../core/ink_metrics.js";
import { setGlyphOutlines } from "../../core/glyph_outlines.js";
import { makeFontkitOutlines } from "../fontkit_outlines.js";

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
    _ckPromise = fetchWithProgress(canvaskitWasmUrl, "wasm", "Downloading renderer").then(async (bytes) => {
      // COMPILE/INSTANTIATE. There is NO progress event for this — the browser
      // compiles ~7 MB of wasm behind one opaque promise — so the splash row shows
      // its name and a live elapsed clock rather than a bar. That is the honest
      // display for a stage that genuinely cannot be metered (web/index.html's
      // STAGES roster documents the rule); inventing a percentage here is exactly
      // the thing the user's "don't bullshit them" ruling forbids.
      bootStage("wasm-init", "Compiling renderer", {});
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
      try {
        const ck = await CanvasKitInit({ locateFile: () => blobUrl });
        bootStage("wasm-init", "Compiling renderer", { done: true });
        return ck;
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
  bootStage("skia-fonts", "Preparing text", { loaded: 0, total: faces.length, unit: "count" });
  // The fetched bytes are KEPT, keyed by file, for the glyph-outline seam below.
  // Re-fetching them there would re-download ~12.5 MB (or at best re-decode the
  // cache) to parse files this pass already has in hand, so the buffers are
  // captured on the way past instead.
  const registeredBytes = new Map();
  await Promise.all(
    faces.map(async ({ family, file }) => {
      const url = FONT_URLS[`../../fonts/${file}`];
      if (!url) { console.error(`browser_canvaskit: font "${file}" has no bundled URL — check fonts.js vs fonts/.`); return; }
      // THROUGH THE SHARED PER-FILE CACHE (web/fontBytes.js), not a bare
      // fetch. The committed faces in this list are the SAME FILES fontLoader is
      // loading for canvas2D at the same moment; a bare fetch here downloaded
      // every one of them a second time (measured: +2.5 MB on the wire, 26 files,
      // once the two loaders stopped accidentally running in sequence). The Noto
      // fallbacks are unique to this list and simply get their single fetch here.
      const buf = await fontBytes(file, url);
      provider.registerFont(buf, family);
      registeredBytes.set(file, buf);
      bootStage("skia-fonts", "Preparing text", { loaded: ++facesDone, total: faces.length, unit: "count", done: facesDone === faces.length });
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
  // THE GLYPH-OUTLINE SEAM (core/glyph_outlines) — the ink-metrics seam's twin,
  // installed at the same point and for the same reason: the faces are in hand.
  // Outlines come from FONTKIT, not CanvasKit, because CanvasKit 0.41.1 has no
  // glyph-outline API at all (measured — the argument is in
  // core/glyph_outlines.js's header, and text_layout.js's glyph pass already says
  // the same thing from the other side).
  //
  // AWAITED, NOT FIRE-AND-FORGET, and the dynamic import is why it can be:
  // fontkit is ~200 KB and only text morphing needs it, so it is code-split the
  // way web/pdfFonts.js splits it for the PDF path. Installing it before this
  // function returns means the seam is ready at the same instant the measure is
  // — a text widget never sees one installed without the other, which would be a
  // state where it could lay out but not morph.
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  setGlyphOutlines(makeFontkitOutlines(
    (fontId, bold) => {
      const file = fontFileFor(fontId, bold);
      return file ? (registeredBytes.get(file) ?? null) : null;
    },
    fontkit,
  ));
  return fc;
}
