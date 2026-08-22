/**
 * The shared PDF-PAGE raster registry — one PDF page rasterized to a bitmap
 * (via pdfjs-dist) and cached under a synthetic `data:` URI ref, keyed by
 * (src, page, scale). The TWIN of gpu/image_registry.js and
 * gpu/video_registry.js: it is how a PDF page reaches the GPU compositor's
 * media map WITHOUT the compositor knowing PDFs exist — the rasterized page
 * is just an ImageBitmap under a ref string, so `getImage`/`ensureImage`
 * (image_registry.js) resolve it exactly like a still image. The plugin
 * (plugins/pdf_page.js) never reaches into any compositor, and the compositor
 * never imports pdfjs-dist.
 *
 * ── WHY A SYNTHETIC data: REF INTO THE IMAGE REGISTRY (not a new IR op) ───────
 * A rasterized PDF page IS a bitmap — the render_gpu cornerstone (manifest
 * round 11: "the render-parity cornerstone holds for raster content") already
 * solved "how does a bitmap reach the GPU compositor AND the PDF backend AND
 * the SVG backend" for the image widget. Emitting a plain `image()` IR op
 * whose `ref` is this module's cache key means:
 *   - GPU: gpu/compositor.js `_imageSource` resolves it via
 *     gpu/image_registry.js exactly like a photo — ZERO compositor changes.
 *   - PDF export: pdf_backend.js `loadImageBytes(ref)` decodes any string ref
 *     (data URI or URL) uniformly — a rasterized-page ref needs no new
 *     backend code. This IS the manifest's "a raster embed is acceptable for
 *     v1 (the hybrid rule precedent)" — the PDF widget's PDF-export path is a
 *     raster PNG region, exactly like blur/bloom's hybrid raster regions,
 *     because the ref is already a rasterized bitmap by construction.
 *   - SVG export: svg_backend.js `_resolveHref` inlines a `data:` ref
 *     VERBATIM (no resolver needed) — again zero new backend code.
 * The alternative (a dedicated "pdfPage" IR op + new cases in all three
 * backends) would triple the surface for a v1 whose vector re-embed is
 * explicitly flagged as future work anyway (see the module footer). Reusing
 * the image path is the smaller, parity-proven surface — VECTOR PDF re-embed
 * (selectable text/vector page content in the exported PDF, instead of this
 * raster embed) is FLAGGED FUTURE WORK, not built here.
 *
 * ── THE CACHE KEY ──────────────────────────────────────────────────────────
 * `pdfPageRef(src, page, scale)` — a plain string key ("pdfpage:<src-hash-ish
 * len+slice>:<page>:<scale-rounded>"), NOT a real data: URI (the bitmap is
 * cached as an ImageBitmap directly via the image registry's `registry` Map
 * bypass — see registerRasterizedPage). scale is ROUNDED (PDF_SCALE_STEP) so
 * continuous resize/zoom doesn't mint a fresh cache entry (and a fresh
 * render) every pixel of drag — mirrors the glyph atlas's bucketed zoom
 * lesson (concerns.md "text crispness": exact-regime buckets, not
 * every-frame-exact). Re-render happens whenever (src, page, roundedScale)
 * changes — the manifest's "(src, page, scale)" cache spec.
 *
 * ── ASYNC CONTRACT (mirrors image_registry.js's async decode contract) ───────
 * Rasterization is async (pdfjs-dist parses + renders to a canvas). The
 * render path is SYNC-shaped, so:
 *   - `ensurePdfPageRasterized(src, page, scale)` kicks an idempotent
 *     render; a no-op if that exact key is already loading/ready/errored.
 *   - `pdfPageRef(src, page, scale)` is the SYNC key the plugin's emit()
 *     builds its `image()` op ref from — emit() never awaits.
 *   - the compositor's normal image_registry `getImage(ref)` returns null
 *     until the raster lands (draws nothing that frame — the manifest's
 *     "no silent placeholder" rule), then `onImageLoad` (image_registry.js)
 *     wakes a repaint exactly like a normal image decode landing.
 *
 * ── LOUD FAILURE DISCIPLINE (no silent fallbacks) ─────────────────────────────
 * A PDF that fails to load/parse, or a rasterization that throws, is reported
 * ONCE via console.error (core/report.js reportOnce) and the key is latched
 * "error" (never retried silently). Requesting a PAGE NUMBER OUTSIDE the
 * document's page count is NOT silently clamped-and-hidden: pdf_page.js
 * clamps the rendered page into range (so the widget still shows SOMETHING
 * rather than going blank on a stale/out-of-range page number — the same
 * "never brick the render" principle as the repair pipeline) but reports the
 * out-of-range request loudly via reportOnce (dev console) so the author
 * knows the requested page didn't exist. See plugins/pdf_page.js for the
 * clamp-and-report call site (the clamp decision itself is flagged to the
 * lead — see this task's report).
 *
 * DOM note: this module needs `document.createElement("canvas")` + pdfjs-dist
 * (which itself needs a Worker/fetch), all of which exist in browsers and in
 * the puppeteer-driven CLI (cli/render.js always runs through a REAL
 * Chromium page — see its header) but NOT in bare node. So, like
 * image_registry.js/video_registry.js, this module is browser/CLI-facing,
 * NOT part of the DOM-free `core/`.
 */

import {
  reserveImageSlot, registerRasterizedBitmap, releaseImage, abandonImageSlot, BYTES_PER_PIXEL,
} from "./image_registry.js";
import { reportOnce, truncate } from "../../core/report.js";
// rasterFitFactor lives with clampSurfaceSize/MAX_SURFACE_DIM: it is the ask-vs-got
// law for EVERY raster this app allocates, not a PDF-only concern (the backdrop
// materials in render_gpu/skia/paint_skia.js hit the identical defect).
import { rasterFitFactor } from "../../core/clip.js";

// pdfjs-dist is loaded LAZILY (dynamic import, at first use inside
// loadPdfjs() below) — NEVER as a static top-level import. WHY: a static
// `import "pdfjs-dist/build/pdf.worker.mjs?url"` is a Vite-only specifier
// (the `?url` suffix) that a bare-node `import` cannot parse at all
// ("does not provide an export named 'default'") — and core/ + the
// render_gpu/ node test suites MUST stay importable in bare node (PowerRP
// CLAUDE.md's hard invariant). Since plugins/pdf_page.js is reached via
// plugins/index.js's static import chain, ANY static top-level Vite-only
// import here would break every bare-node suite that touches render_gpu the
// moment pdf_page is registered — reproduced during this task's fleet
// integration (a lead-reported blocking bug) and fixed by this lazy-load.
// A bare-node caller that never triggers rasterization (ensurePdfDoc/
// ensurePdfPageRasterized aren't called) never touches this module's guts at
// all — only the FUNCTIONS below are import-time-safe; invoking them outside
// a browser (no `document`/dynamic Worker support) still throws, loudly, at
// CALL time, which is correct (this module is browser/CLI-facing, like
// image_registry.js/video_registry.js — see the module header).
// ── WHY THE **LEGACY** BUILD, MAIN *AND* WORKER (2026-08-02, WORKSTREAM AX) ──
// This module used to import the MODERN build (`pdfjs-dist` bare specifier +
// `pdfjs-dist/build/pdf.worker.mjs?url`). That shipped a REAL crash to real
// users, reported from the live site's console:
//   AssetThumb: thumbnail render failed for "…dnd_character_sheet.pdf":
//   TypeError: i(...).getOrInsertComputed is not a function
//     at VA.ph → VA.getOptionalContentConfig → og.render
// pdfjs-dist 5.7's MODERN build calls `Map.prototype.getOrInsertComputed` — the
// TC39 upsert proposal — as a NATIVE builtin, with no polyfill (11 call sites in
// build/pdf.mjs, 8 in build/pdf.worker.mjs). Chrome only shipped it very
// recently, so on any ordinary slightly-older Chrome EVERY PDF page render
// throws, which means every PDF asset thumbnail and every PDF widget raster
// fails. The gate's own Chrome happens to HAVE the builtin, which is exactly why
// no probe caught it: the bug is invisible on the machine that tests it.
//
// The LEGACY build is pdf.js's own supported answer for browsers it no longer
// targets natively: it is the same source transpiled with core-js polyfills
// bundled in, and it POLYFILLS THIS EXACT METHOD (legacy/build/pdf.mjs installs
// both `Map.prototype.getOrInsertComputed` and the WeakMap twin before use).
// So the fix is not ours to hand-write — it is to consume the variant upstream
// publishes for this situation.
//
// CHOSEN OVER A HAND-ROLLED POLYFILL, deliberately. A ~4-line
// `Map.prototype.getOrInsertComputed` shim would fix TODAY's crash and nothing
// else: the modern build is compiled for a browser baseline, not just this one
// method, so the next brand-new builtin pdf.js adopts breaks us again the same
// silent way — and we would only learn from another user's console. Legacy moves
// the whole baseline question upstream, permanently. It ALSO matches the
// precedent already in this repo: gpu/pdf_page_vector.js has loaded
// `pdfjs-dist/legacy/build/pdf.mjs` since PDF P1, so after this change BOTH pdfjs
// consumers are on ONE build variant instead of two.
//
// MEASURED COST (node_modules, unminified, 2026-08-02): main 817 KB → 1007 KB
// (+23%), worker 2161 KB → 2333 KB (+8%). That is bytes NO ONE downloads until
// they actually open a PDF — this module is reached only through a lazy
// `await import()` (see the note above) and lands in its own chunk. Trading
// ~360 KB on a PDF-only lazy chunk for "PDFs render at all" is not a close call.
//
// MAIN AND WORKER MUST COME FROM THE SAME VARIANT. pdf.js's main thread and its
// worker exchange an internal, version- AND build-coupled message protocol;
// mixing a modern main with a legacy worker (or vice versa) is the classic
// pdf.js misconfiguration, and it would ALSO reintroduce this very bug through
// the back door — the worker build has its own 8 getOrInsertComputed call sites,
// so a modern worker keeps throwing no matter what the main thread runs. Both
// specifiers below therefore say `legacy/` and must be changed together.
let pdfjsLibPromise = null;
/** Command (near-pure: memoized). Dynamically imports the LEGACY pdfjs-dist
 * build and wires its MATCHING legacy worker script (Vite's `?url` import, done
 * INSIDE this dynamic import so bare node never parses it) exactly once per
 * process. See the block comment above for why legacy, both halves. */
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      // Vite's `?url` import (the fontLoader.js/pdfFonts.js precedent) gives
      // the worker script a served URL without bundling it into this
      // module's own chunk — pdfjs-dist's pipeline parses/decodes on a
      // Worker. Nested inside this dynamic import so it is NEVER evaluated
      // by a bare-node static import graph. LEGACY, to match the main build
      // immediately above — see the block comment.
      const { default: pdfWorkerUrl } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url");
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjsLib;
    })();
  }
  return pdfjsLibPromise;
}

/**
 * Scale is rounded to the nearest multiple of this step before it enters the
 * cache key, so continuous resize/zoom drags reuse one raster instead of
 * re-rendering (and re-caching) every intermediate scale. LINKED PRECEDENT:
 * mirrors the glyph atlas's bucketed-zoom fix (concerns.md 2026-07-15 "Opus1
 * text crispness" — exact-regime buckets rather than a fresh render per
 * pixel of zoom); 0.1 is one order of magnitude finer than the atlas's
 * measured "up to ~10% magnification" softness tolerance, small enough that
 * the rounding itself is imperceptible. FLAGGED PENDING USER RATIFICATION
 * (no closer in-repo precedent than the analogy above — the codebase
 * convention per concerns.md is to flag such constants rather than silently
 * assert them as settled).
 */
export const PDF_SCALE_STEP = 0.1;

/** src → {status: "loading"|"ready"|"error", numPages: number|null, docPromise: Promise, error: Error|null} */
const docs = new Map();
/** "<src>|<page>|<roundedScale>" → {status, ref, error, promise, bytes, lastUsed}
 *  The WHOLE-PAGE raster cache. `bytes`/`lastUsed` have the same meaning as in
 *  `regions` — see PDF_RASTER_CACHE_BYTES for why this map is budgeted at all. */
const pages = new Map();
/** "<src>|<page>" → {w, h} in PDF POINTS at pdfjs scale 1 (native page size —
 * the "how big is one PDF unit in canvas units" conversion the widget needs
 * to pick a rasterization scale from its own world-space bbox; see
 * pdfPagePointSize). */
const pointSizes = new Map();

/**
 * Pure function. Rounds a raster scale to the PDF_SCALE_STEP grid (never
 * below the step itself — a zero/negative scale would rasterize nothing).
 *
 * @example roundPdfScale(1.234) // 1.2
 * @example roundPdfScale(0.03) // 0.1
 */
export function roundPdfScale(scale) {
  const rounded = Math.round(scale / PDF_SCALE_STEP) * PDF_SCALE_STEP;
  return Math.max(PDF_SCALE_STEP, Number(rounded.toFixed(1)));
}

/**
 * Pure function. Clamps a requested 1-based page number into [1, pageCount],
 * reporting (via the returned `outOfRange` flag — the caller decides how
 * loudly) whenever the raw request fell outside the document's actual page
 * range. Returns page 1 for a non-finite/non-positive request (the same
 * "never brick, always show something" reasoning as clamping past the end).
 *
 * Args:
 *   requestedPage (number): the (possibly equation-evaluated) requested page
 *   pageCount (number): the PDF's total page count (>= 1)
 *
 * Returns:
 *   {page: number, outOfRange: boolean}
 *
 * @example clampPage(1, 5) // {page: 1, outOfRange: false}
 * @example clampPage(9, 5) // {page: 5, outOfRange: true}
 * @example clampPage(0, 5) // {page: 1, outOfRange: true}
 * @example clampPage(-3, 5) // {page: 1, outOfRange: true}
 * @example clampPage(3.7, 5) // {page: 3, outOfRange: false} (equations may yield fractional pages; floored, not rounded, so page N stays "the Nth page" until fully tweened to N+1)
 */
export function clampPage(requestedPage, pageCount) {
  const n = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : NaN;
  if (!Number.isFinite(n)) return { page: 1, outOfRange: true };
  if (n < 1) return { page: 1, outOfRange: true };
  if (n > pageCount) return { page: pageCount, outOfRange: true };
  return { page: n, outOfRange: false };
}

/**
 * Pure function. The synthetic image-registry ref key for a rasterized PDF
 * page. NOT a real data: URI — a plain cache key the image registry stores
 * an ImageBitmap under directly (see registerRasterizedBitmap). Rounds scale
 * via roundPdfScale so the key is stable across a continuous resize/zoom.
 *
 * @example pdfPageRef("blob:x", 1, 1) // "pdfpage:blob:x:1:1"
 * @example pdfPageRef("blob:x", 3, 2.34) // "pdfpage:blob:x:3:2.3"
 */
export function pdfPageRef(src, page, scale) {
  return `pdfpage:${src}:${page}:${roundPdfScale(scale)}`;
}

/**
 * Query. The load status of a PDF document src: "unloaded", "loading",
 * "ready" (numPages known), or "error".
 *
 * @example pdfDocStatus("blob:nope") // "unloaded"
 */
export function pdfDocStatus(src) {
  return docs.get(src)?.status ?? "unloaded";
}

/**
 * Query. The page count of an already-loaded PDF src, or null if it is not
 * ready yet (still loading, never requested, or errored). The `page`
 * property's Inspector clamp (plugins/pdf_page.js) reads this.
 *
 * @example pdfPageCount("blob:nope") // null
 */
export function pdfPageCount(src) {
  const entry = docs.get(src);
  return entry && entry.status === "ready" ? entry.numPages : null;
}

/**
 * Command (near-pure: idempotent). Ensures the PDF document at `src` (a
 * data: URI, blob: URI, or URL — anything pdfjs-dist's getDocument accepts)
 * is loading/loaded. Safe to call every frame. Errors are reported once via
 * reportOnce and latch the src "error" (never retried silently).
 *
 * @example // ensurePdfDoc(dataUri); ...later... pdfPageCount(dataUri) → 5
 */
export function ensurePdfDoc(src) {
  if (typeof src !== "string" || src.length === 0)
    throw new Error(`ensurePdfDoc: src must be a non-empty string, got ${JSON.stringify(src)}`);
  const existing = docs.get(src);
  if (existing) return existing.docPromise;

  const entry = { status: "loading", numPages: null, error: null, docPromise: null };
  entry.docPromise = loadPdfjs()
    .then((pdfjsLib) => pdfjsLib.getDocument({ url: src }).promise)
    .then((doc) => {
      entry.status = "ready";
      entry.numPages = doc.numPages;
      return doc;
    })
    .catch((e) => {
      entry.status = "error";
      entry.error = e instanceof Error ? e : new Error(String(e));
      reportOnce(`pdf_page_raster:doc:${src}`, `PowerRP pdf_page_raster: failed to load PDF "${truncate(src)}" — ${entry.error.message}`);
      return null;
    });
  docs.set(src, entry);
  return entry.docPromise;
}

/**
 * Query. The native PDF-POINT size (pdfjs scale-1 viewport width/height) of
 * (src, page), or null if not measured yet. This is the "how many canvas
 * units is one PDF point" conversion the plugin needs to turn its OWN
 * world-space size into a pdfjs `scale` — the same role a photo's
 * naturalWidth/naturalHeight plays for an image widget's aspect, except a
 * PDF page's size isn't known until pdfjs has opened the document, so it is
 * cached here (populated by ensurePdfPagePointSize) instead of being
 * synchronously derivable from the src string alone.
 *
 * @example pdfPagePointSize("blob:nope", 1) // null
 */
export function pdfPagePointSize(src, page) {
  return pointSizes.get(`${src}|${page}`) ?? null;
}

/**
 * Command (near-pure: idempotent). Ensures (src, page)'s native point size is
 * measured and cached (pdfPagePointSize reads it back synchronously once
 * ready). Safe to call every frame; a no-op once cached or erroring.
 *
 * @example // ensurePdfPagePointSize(dataUri, 1); ...later... pdfPagePointSize(dataUri, 1) → {w: 612, h: 792}
 */
export function ensurePdfPagePointSize(src, page) {
  const key = `${src}|${page}`;
  if (pointSizes.has(key)) return Promise.resolve(pointSizes.get(key));
  return (async () => {
    const doc = await ensurePdfDoc(src);
    if (!doc) return null; // ensurePdfDoc already reported the load failure
    if (page < 1 || page > doc.numPages) return null; // out-of-range — the plugin's clampPage call handles reporting
    const pdfPage = await doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const size = { w: viewport.width, h: viewport.height };
    pointSizes.set(key, size);
    return size;
  })().catch((e) => {
    reportOnce(`pdf_page_raster:size:${key}`, `PowerRP pdf_page_raster: failed to measure "${truncate(src)}" page ${page} — ${e?.message ?? e}`);
    return null;
  });
}

/**
 * Command (near-pure: idempotent). Ensures a specific (src, page, scale) is
 * rasterized and registered into the image registry under pdfPageRef(...).
 * A no-op if that exact key is already loading/ready/errored — safe to call
 * every frame from a sync emit(). Fire-and-forget: the render path never
 * awaits this; it reads pdfPageRef(...) through the normal image_registry
 * getImage/onImageLoad path (a not-yet-rasterized page draws nothing this
 * frame, exactly like an undecoded image — the manifest async rule).
 *
 * `page` MUST already be clamped into [1, pageCount] by the caller
 * (plugins/pdf_page.js) — this module rasterizes exactly the page it is
 * asked for and does not re-clamp (clamping is the plugin's documented
 * responsibility, keeping this module a dumb, testable raster cache).
 *
 * @example // ensurePdfPageRasterized(dataUri, 1, 1); ...later... getImage(pdfPageRef(dataUri, 1, 1)) → ImageBitmap
 */
export function ensurePdfPageRasterized(src, page, scale) {
  const key = `${src}|${page}|${roundPdfScale(scale)}`;
  const ref = pdfPageRef(src, page, scale);
  requestedSinceTrim.add(ref); // this frame needs it — never evict it out from under the paint
  const hit = pages.get(key);
  if (hit) { hit.lastUsed = ++useSeq; return hit.promise; }

  // RESERVE THE IMAGE-REGISTRY SLOT SYNCHRONOUSLY, before any await below.
  // WHY: the GPU compositor's _imageSource(ref) fallback calls getImage(ref)
  // (null while unrasterized) then ensureImage(ref) — and ensureImage only
  // skips its OWN fetch() attempt when the registry already has an entry for
  // ref. Without reserving first, a compositor frame that runs between "this
  // function started" and "the bitmap is ready" would see no entry, call
  // ensureImage(ref), and fetch() the fake "pdfpage:…" string — guaranteed to
  // fail and PERMANENTLY latch the ref to "error" before the real bitmap
  // ever lands (reproduced + fixed during this widget's verification; see
  // image_registry.js's reserveImageSlot doc for the full mechanism).
  reserveImageSlot(ref);
  const entry = { status: "loading", ref, error: null, promise: null, bytes: 0, lastUsed: ++useSeq };
  entry.promise = (async () => {
    const doc = await ensurePdfDoc(src);
    if (!doc) throw new Error("PDF document failed to load"); // ensurePdfDoc already reported this
    const pdfPage = await doc.getPage(page);
    // Piggyback the point-size measurement (scale-1 viewport) onto this same page
    // fetch — free, and fills pdfPagePointSize for the NEXT emit() without a
    // second doc.getPage() round trip. Also the basis for the fit-cap below.
    const unit = pdfPage.getViewport({ scale: 1 });
    const sizeKey = `${src}|${page}`;
    if (!pointSizes.has(sizeKey)) pointSizes.set(sizeKey, { w: unit.width, h: unit.height });
    // CAP the raster scale so the WHOLE page fits within PDF_MAX_RASTER_DIM on
    // BOTH edges — DOWNSCALE the page, never clip it. This is the whole-page twin
    // of the region path's clampDim (which the whole-page path lacked): a page
    // whose widget was resized far past PDF_MAX_RASTER_DIM points would otherwise
    // mint a giant canvas + bitmap → a CanvasKit heap overrun when the bitmap
    // uploads as a texture (the unbounded-allocation class this task fixes).
    const requested = roundPdfScale(scale);
    const effScale = requested * rasterFitFactor(unit.width * requested, unit.height * requested, PDF_MAX_RASTER_DIM);
    if (effScale < requested) reportOnce(`pdf_page_raster:cap:${key}`, `PowerRP pdf_page_raster: whole-page raster for "${truncate(src)}" page ${page} @${requested}x would exceed ${PDF_MAX_RASTER_DIM}px/edge — capped to ${effScale.toFixed(3)}x (page shown at lower resolution).`);
    const viewport = pdfPage.getViewport({ scale: effScale });
    const canvas = document.createElement("canvas");
    canvas.width = clampDim(viewport.width);
    canvas.height = clampDim(viewport.height);
    const ctx = canvas.getContext("2d");
    await pdfPage.render({ canvasContext: ctx, canvas, viewport }).promise;
    const bitmap = await createImageBitmap(canvas);
    entry.status = "ready";
    entry.bytes = canvas.width * canvas.height * BYTES_PER_PIXEL; // what this page costs the budget
    registerRasterizedBitmap(ref, bitmap); // wakes image_registry.onImageLoad subscribers too
    return bitmap;
  })().catch((e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    // The slot reserved above will never be filled. Left "loading" it would sit in
    // pendingImageRefs() forever and make renderJobPage.settledFrame fail the whole
    // render naming THIS ref instead of the real failure reported just below.
    abandonImageSlot(ref, `pdf_page_raster: whole-page raster failed — ${entry.error.message}`, true); // a REAL failure: an export must refuse rather than write a hole
    reportOnce(`pdf_page_raster:page:${key}`, `PowerRP pdf_page_raster: failed to rasterize "${truncate(src)}" page ${page} @${roundPdfScale(scale)}x — ${entry.error.message}`);
    return null;
  });
  pages.set(key, entry);
  return entry.promise;
}

// ── DISPLAY RE-RASTER: a page SUB-RECT at display resolution (Chrome model) ───
// The manifest RENDER PIVOT (2026-07-23): the editor DISPLAY re-rasterizes only
// the VISIBLE region of a placed page at the CURRENT zoom, so text/vectors stay
// crisp at any magnification while the cost stays bounded by the SCREEN (a
// window into a huge virtual page), not the zoom. The whole-page raster above
// stays the FALLBACK (thumbnails / CLI / export / the first frame before the
// view-driven region lands, and any consumer with no pre-pass). This region
// path is keyed by (src, page, normalized-sub-rect, scale) and driven by the
// pure core/clip.visibleSourceRect primitive from the render-time pre-pass (the
// only place that knows the live view) — see render_gpu/pdf_display.js.

/** The largest region-raster canvas edge, device px. A hard allocation cap so a
 * pathological box aspect (a page stretched far past its native proportions,
 * where the derived height/width can outrun the viewport bound) can never mint a
 * giant canvas. 4096 is the conservative floor of the WebGL2 MAX_TEXTURE_SIZE
 * guaranteed by every target browser (the same ceiling the glyph atlas assumes)
 * — a region needing more than this is downsized, staying crisp for every real
 * PDF while bounding memory. */
export const PDF_MAX_RASTER_DIM = 4096;

/** The largest FULL-PAGE DEVICE dimension (px per edge) we will ever drive
 * pdf.js's getViewport at. THE deep-sub-region-zoom crash fix: the region path's
 * `scale` (device px per PDF point) is computed upstream (pdf_display.js) as
 * deviceRect.w / (sourceRect.sw · point.w); zoom deep into a small sub-rect and
 * sourceRect.sw → 0, so `scale` explodes without bound (e.g. sw=0.001, a 600pt
 * page → scale ≈ 3300, a ~2,000,000-px full-page transform). clampDim already
 * bounds OUR output canvas (≤ PDF_MAX_RASTER_DIM), but pdf.js sizes its OWN
 * internal scratch canvases (transparency groups / soft masks / tiling patterns /
 * big embedded images) to the DEVICE transform — the whole page at `scale`,
 * point.{w,h}·scale px — NOT to our clamped output. Left unbounded that mints a
 * multi-million-px internal canvas → wasm heap OOM / tab crash (the one class the
 * existing 4096/8192 output clamps never see). So we cap the effective scale to
 * PDF_MAX_DEVICE_DIM / max(point.w, point.h): the full-page device extent can
 * never exceed this many px/edge. 8192 = 2 × PDF_MAX_RASTER_DIM, matching the
 * WebGL2 surface ceiling (MAX_SURFACE_DIM in core/clip.js) — a region spanning ≥
 * half the page still reaches the 4096 output clamp (never under-resolved), while
 * a deeper sub-region renders blurry-but-safe. That blurry-cap-instead-of-crash
 * is exactly what native PDF viewers (Preview / Chrome PDFium) do: cap the zoom
 * and show a progressive upscale rather than allocate an unbounded raster. The
 * clamp is SILENT (no per-frame console.warn — deep zoom would spam it every
 * frame; a deliberate quality/safety clamp is not an error, mirroring clampDim /
 * clampSurfaceSize, which clamp silently for the same reason). */
export const PDF_MAX_DEVICE_DIM = 2 * PDF_MAX_RASTER_DIM;

/**
 * THE budget, in BYTES of decoded pixels, for EVERY raster this module holds —
 * whole-page (`pages`) AND visible-region (`regions`) — the fix for the reported
 * "zoom into a PDF, move around once in a while, the editor dies" crash.
 *
 * WHY ONE BUDGET OVER BOTH MAPS, AND NOT TWO. There is ONE physical resource:
 * CanvasKit's wasm heap. Two independent budgets would be two names for one
 * number and would each be individually satisfied while jointly overrunning it.
 *
 * WHY THE WHOLE-PAGE MAP NEEDED BUDGETING AT ALL — it was the surviving half of
 * the leak the region budget was written for, and it is the LARGER half. A
 * whole-page ref is `pdfPageRef(src, page, roundPdfScale(scale))` where the
 * plugin's scale (plugins/pdf_page.js emit) is
 *   wholeScale = croppedWidth · world.scale · PDF_RASTER_DENSITY / pagePointWidth
 * — a CONTINUOUS function of the widget's SIZE, bucketed to PDF_SCALE_STEP. So it
 * is NOT, as image_registry's "cached forever" paragraph assumed of ordinary
 * images, "bounded by the document's distinct images": every 0.1 of scale a
 * RESIZE drag (or a scale tween, or a scaled group) sweeps through mints another
 * whole-page raster of up to PDF_MAX_RASTER_DIM² · 4 = 64 MB, and nothing ever
 * freed one. Measured (tests/pdf_resize_leak_probe.js) on the 2026-07-28 code: a
 * single resize drag from 200 to 2200 px wide left 139 CanvasKit Images alive and
 * ZERO deleted — 1976.9 MB, of which the budgeted region cache was only 147.7 MB —
 * and the editor died at exactly 2048.0 MB with `RuntimeError: memory access out
 * of bounds`, the reported crash verbatim. Zoom and pan alone never triggered it,
 * which is why the earlier fix (region-only) measured clean and shipped: 700 steps
 * of random zoom+pan hold at a 382 MB plateau. That is also why the user saw it
 * only "once in a while" — the trigger is resizing, not panning.
 *
 * WHY BYTES AND NOT A COUNT. This cap used to be `PDF_REGION_CACHE_MAX = 64`
 * entries, and eviction dropped only THIS module's bookkeeping while explicitly
 * leaving the pixels alive in the image registry ("cheap to re-register"). Both
 * halves of that were wrong. v1 re-rasters the visible window on EVERY view change
 * (tiling is backburnered), so panning a zoomed page mints roughly one region per
 * frame, and each one costs its pixels TWICE: an ImageBitmap, plus a copy inside
 * the CanvasKit WASM HEAP the moment image_registry.getSkiaImage converts it for
 * paint. Nothing ever freed either copy. Measured (tests/pdf_pan_leak_probe.js):
 * the wasm heap grew 1:1 with raster pixels — 1674 MB of growth for 1717 MB of
 * rasters across 1000 pan steps — and the editor died at exactly 2048.0 MB with
 * `RuntimeError: memory access out of bounds` inside getSkiaImage. A COUNT cap
 * cannot prevent that: 64 regions at the PDF_MAX_RASTER_DIM ceiling is 64 · 64 MiB
 * = 4 GiB, twice the whole heap. The physical quantity is bytes, so the cap is
 * bytes.
 *
 * WHERE THE NUMBER COMES FROM (two independent derivations, same answer):
 *   · THE HEAP CEILING. CanvasKit's wasm linear memory declares a maximum of
 *     32768 pages × 64 KiB = 2 GiB (canvaskit.wasm's memory section; its JS glue
 *     also refuses any heap resize above 2147483648). 256 MiB is ONE EIGHTH of
 *     that, leaving 1.75 GiB for the things that actually have to be resident —
 *     the glyph atlas, every other image and video texture, Skia's own
 *     allocations, and the scratch surfaces paintIR allocates per frame.
 *   · THE IN-REPO PRECEDENT. core/clip.js already ratifies exactly this quantity
 *     as safe, for a single allocation: "8192² · 4 = 256 MB, comfortably inside
 *     the wasm heap" (MAX_SURFACE_DIM). One surface-envelope's worth of pixels is
 *     a budget this codebase has already reasoned about, so the whole raster
 *     cache gets one of them.
 * At a typical full-viewport region (~868×519 = 1.8 MB measured above) that is
 * ~150 recent views of scrollback; at the PDF_MAX_RASTER_DIM extreme it is 4.
 *
 * The budget is charged a raster's SINGLE-copy size (canvasW · canvasH ·
 * BYTES_PER_PIXEL). The ImageBitmap-plus-wasm-copy doubling noted above is a
 * constant factor, so it lives in the one-eighth headroom rather than in the
 * arithmetic — writing it into the charge would just halve an already conservative
 * budget twice over. And the budget is a CACHE bound, never a correctness bound:
 * the rasters one frame needs are always kept even if they exceed it, and that
 * overrun is reported loudly (see trimPdfRasterCache).
 */
export const PDF_RASTER_CACHE_BYTES = 256 * 1024 * 1024;

/** Monotonic use counter — the LRU clock. Stamped onto an entry when it is created
 * and on every cache HIT, in BOTH maps. WHY A STAMP AND NOT Map INSERTION ORDER
 * (which is what the region cache alone used): the budget now spans TWO maps, and
 * "least recently used across both" is a total order that two independent
 * insertion orders cannot express. One clock, one order, one trim. */
let useSeq = 0;

/** The refs any consumer has ASKED FOR since the last trim — the keep-set, gathered
 * at the ONE place that can know it. Every ensure*Rasterized call adds its ref, and
 * trimPdfRasterCache consumes and clears it.
 *
 * WHY NOT AN ARGUMENT FROM THE CALLER (which is how the region-only trim did it):
 * the per-frame caller (render_gpu/pdf_display.preRasterizePdfPages) knows the
 * REGION refs because it computes them, but it CANNOT know the WHOLE-PAGE refs —
 * those come from `wholeScale`, which plugins/pdf_page.js emit() derives, and a
 * pre-pass that recomputed that formula would be a hand-maintained mirror of the
 * plugin, drifting silently the day either side changed. Asking the module what it
 * was asked for needs no such mirror and covers both maps with one mechanism. */
let requestedSinceTrim = new Set();

/** "<src>|<page>|<sx>,<sy>,<sw>,<sh>|<roundedScale>" → {status, ref, error, promise, bytes, lastUsed}
 *  The VISIBLE-REGION raster cache. `bytes` is the decoded size of this region's
 *  raster (0 until it lands) and `lastUsed` its stamp off the shared LRU clock —
 *  together the quantities PDF_RASTER_CACHE_BYTES budgets across both maps. */
const regions = new Map();

/** "<src>|<page>" → monotonically increasing generation int, bumped each time a
 * NEW region render is kicked for that page (never on a cache hit). The
 * generation gate for stale in-flight renders: a fast zoom kicks many successive
 * full-window region renders for one page (distinct sub-rect/scale keys), but by
 * the time the CPU worker catches up only the LAST is still wanted. A resolving
 * render whose snapshot generation is no longer current DISCARDS its bitmap
 * instead of publishing a GPU texture for a view already zoomed past (the render
 * stampede + never-evicted-texture growth of §3B in the pdf_perf research).
 * Keyed PER (src,page), NOT globally, so two different pages/PDFs rendering at
 * once never supersede each other (a global counter would make co-visible PDF
 * widgets cascade on load). */
const regionGenerations = new Map();

/**
 * Pure function. The synthetic image-registry ref for a rasterized page
 * SUB-RECT. `sourceRect` is the normalized [0,1] region of the page; `scale`
 * (device px per PDF point) is bucketed via roundPdfScale so sub-bucket zoom
 * jitter reuses one raster. The normalized coords are fixed to 6 dp to kill
 * float noise while keeping distinct views distinct.
 *
 * @example pdfPageRegionRef("blob:x", 1, {sx: 0, sy: 0, sw: 0.5, sh: 0.5}, 3) // "pdfregion:blob:x:1:0.000000,0.000000,0.500000,0.500000:3"
 */
export function pdfPageRegionRef(src, page, sourceRect, scale) {
  const k = [sourceRect.sx, sourceRect.sy, sourceRect.sw, sourceRect.sh].map((v) => v.toFixed(6)).join(",");
  return `pdfregion:${src}:${page}:${k}:${roundPdfScale(scale)}`;
}

/**
 * Command (near-pure: idempotent, evicts on overflow). Ensures the page SUB-RECT
 * `sourceRect` (normalized [0,1] of the whole page) is rasterized at `scale`
 * (device px per PDF point) into the image registry under pdfPageRegionRef(...),
 * and returns a DISPLAY DESCRIPTOR {ref} the caller places at its computed local
 * rect. A no-op (returns the same ref) if that exact key is already loading/
 * ready/errored — safe to call every frame from the render-time pre-pass.
 *
 * The sub-rect is rendered via a pdf.js OFFSET viewport: a full-page viewport at
 * `scale` shifted by (-sx·pw·scale, -sy·ph·scale) device px so the region's
 * top-left lands at the canvas origin, into a canvas sized to the region (its
 * natural point-aspect at `scale`, clamped to PDF_MAX_RASTER_DIM). The widget's
 * image op then STRETCHES this region bitmap into its local rect (handling any
 * box-vs-page aspect distortion at draw time, so the raster itself is undistorted).
 *
 * `page` MUST already be clamped into [1, pageCount] by the caller — like
 * ensurePdfPageRasterized, this is a dumb cache and does not re-clamp.
 *
 * Args:
 *   src (string), page (number): the page.
 *   sourceRect ({sx,sy,sw,sh}): normalized [0,1] sub-rect of the page.
 *   scale (number): device px per PDF point (the display resolution).
 *   point ({w,h}): the page's native size in PDF points (pdfPagePointSize).
 *
 * Returns:
 *   {ref: string}: the image-registry ref for this region raster.
 */
export function ensurePdfPageRegionRasterized(src, page, sourceRect, scale, point) {
  const ref = pdfPageRegionRef(src, page, sourceRect, scale);
  const key = ref;
  requestedSinceTrim.add(ref); // this frame needs it — never evict it out from under the paint
  const hit = regions.get(key);
  if (hit) {
    hit.lastUsed = ++useSeq; // TOUCH: a view revisited stays hot in the shared LRU order
    return { ref };
  }

  reserveImageSlot(ref); // synchronous, before any await — see the full-page path's reserve note
  const roundedScale = roundPdfScale(scale);
  // FIX 1 — CAP THE DEVICE SCALE we drive pdf.js at (see PDF_MAX_DEVICE_DIM).
  // roundedScale is unbounded at deep sub-region zoom; pdf.js sizes its internal
  // scratch surfaces to the full-page device transform (point·scale), not to our
  // clampDim-bounded output canvas, so an unbounded scale OOMs the wasm heap.
  // Cap so the full-page device extent stays ≤ PDF_MAX_DEVICE_DIM px/edge. Every
  // downstream dimension below (offset, canvas size, viewport) uses deviceScale,
  // so the region is captured consistently at the (possibly capped) resolution —
  // deep zoom renders blurry-but-safe, positioning is unaffected (the caller
  // places {ref} by normalized sourceRect, not by raster pixel dims). The cache
  // key stays keyed on the requested roundedScale (via ref/key above).
  const deviceScale = Math.min(roundedScale, PDF_MAX_DEVICE_DIM / Math.max(point.w, point.h));
  // FIX 2 — GENERATION GATE. Snapshot the generation this render is kicked at; a
  // fast zoom kicks many successive region renders for this (src,page) and only
  // the latest is still wanted. On resolve we compare against the current
  // generation and DISCARD a superseded bitmap. (Identical-key stampede is
  // already deduped by the cache-hit early-return above.)
  const myGeneration = bumpRegionGeneration(src, page);
  const entry = { status: "loading", ref, error: null, promise: null, bytes: 0, lastUsed: ++useSeq };
  entry.promise = (async () => {
    const doc = await ensurePdfDoc(src);
    if (!doc) throw new Error("PDF document failed to load"); // ensurePdfDoc already reported this
    const pdfPage = await doc.getPage(page);
    // Full-page viewport at the (capped) display scale, shifted so the sub-rect's
    // top-left sits at the canvas origin (pdf.js viewport is already y-down,
    // top-left origin — the same frame our normalized sourceRect uses).
    // ONE scale drives BOTH the pdf.js viewport and the output canvas. They used to
    // be derived separately — viewport at deviceScale, canvas at clampDim(...) — so
    // whenever the canvas clamp bit, pdf.js kept drawing at full device scale into a
    // canvas too small to hold the result and the region came out CLIPPED at its
    // right and bottom rather than downscaled, then stretched across the widget's
    // whole box at draw time. Reachable from the Inspector alone, with no zoom: a
    // 612x792pt page in "raster" mode at rasterDPI 600 asks for 5080x6574 px and
    // loses 19% of its width and 38% of its height. See rasterFitFactor.
    const rasterScale = deviceScale * rasterFitFactor(
      sourceRect.sw * point.w * deviceScale, sourceRect.sh * point.h * deviceScale, PDF_MAX_RASTER_DIM);
    if (rasterScale < deviceScale)
      reportOnce(`pdf_page_raster:regioncap:${src}|${page}`, `PowerRP pdf_page_raster: the requested region raster for "${truncate(src)}" page ${page} exceeds ${PDF_MAX_RASTER_DIM}px/edge — rendering it at ${rasterScale.toFixed(2)}x instead of ${deviceScale.toFixed(2)}x (the page is shown whole, at lower resolution). Lower rasterDPI, or reduce the widget's size, to get the resolution you asked for.`);
    const viewport = pdfPage.getViewport({
      scale: rasterScale,
      offsetX: -sourceRect.sx * point.w * rasterScale,
      offsetY: -sourceRect.sy * point.h * rasterScale,
    });
    // clampDim is a backstop here (rasterScale already fits) against a NaN/negative
    // edge ever reaching canvas.width, not the sizing policy it used to be.
    const canvasW = clampDim(Math.round(sourceRect.sw * point.w * rasterScale));
    const canvasH = clampDim(Math.round(sourceRect.sh * point.h * rasterScale));
    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    await pdfPage.render({ canvasContext: ctx, canvas, viewport }).promise;
    const bitmap = await createImageBitmap(canvas);
    if (myGeneration !== currentRegionGeneration(src, page)) {
      // STALE: a newer region render for this (src,page) was kicked while this
      // one was in flight (fast-zoom stampede). We CREATED this ImageBitmap and
      // have NOT published it (registerRasterizedBitmap not yet called), so
      // closing it is safe and frees it immediately — NEVER close a bitmap already
      // handed to the registry (use-after-free). Drop this module's cache entry
      // too so revisiting this exact view re-renders, and ABANDON the registry slot
      // we reserved: left "loading" it would sit in pendingImageRefs() forever, and
      // a superseded raster must never be what makes a headless render give up.
      bitmap.close();
      regions.delete(key);
      // NOT a failure (no third argument): the newer view's ref carries the pixels, so
      // this ref is terminal-but-benign. Marking it "error" here is what made every PDF
      // video export refuse itself — settledFrame re-renders to settle, each pass
      // superseded the last one's in-flight region, and each supersede minted a phantom
      // failure. See image_registry.abandonImageSlot.
      abandonImageSlot(ref, "pdf_page_raster: region raster superseded by a newer view");
      return null;
    }
    entry.status = "ready";
    entry.bytes = canvasW * canvasH * BYTES_PER_PIXEL; // what this region costs the budget
    registerRasterizedBitmap(ref, bitmap); // wakes image_registry.onImageLoad → repaint
    return bitmap;
  })().catch((e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    abandonImageSlot(ref, `pdf_page_raster: region raster failed — ${entry.error.message}`, true); // a REAL failure: an export must refuse rather than write a hole
    reportOnce(`pdf_page_raster:region:${key}`, `PowerRP pdf_page_raster: failed to rasterize "${truncate(src)}" page ${page} region @${roundedScale}x — ${entry.error.message}`);
    return null;
  });
  regions.set(key, entry);
  return { ref };
}

/**
 * Query. The bytes of decoded pixels this module currently holds across BOTH
 * caches (whole-page + visible-region) — what PDF_RASTER_CACHE_BYTES budgets.
 * In-flight (still rasterizing) entries count 0 because their pixels do not
 * exist yet.
 *
 * @example // pdfRasterCacheBytes() // 0 — nothing rasterized yet
 * @example // after one 868x519 region has landed: pdfRasterCacheBytes() // 1802448
 */
export function pdfRasterCacheBytes() {
  let total = 0;
  for (const entry of pages.values()) total += entry.bytes;
  for (const entry of regions.values()) total += entry.bytes;
  return total;
}

/**
 * Pure function. Picks the best already-landed scale out of `cachedScales` for a
 * request at `wantScale` — the INTERACTION-LOD choice, factored out of the cache
 * lookup below so the policy is stated once and is testable in bare node. Any
 * second lookup that wants a nearest scale must come through here too; the
 * region twin that did not is why this sentence names the rule rather than a count.
 *
 * THE RULE IS "NEAREST, PREFERRING SHARPER". A drag is a continuous zoom sweep, so
 * the wanted bucket is usually one or two steps off something resident. Ties and
 * near-ties go to the LARGER scale because upsampling a too-small raster is visibly
 * soft while downsampling a too-large one is not — the same asymmetry mipmapping
 * relies on. Distance is measured in log space so "half the resolution" and "twice
 * the resolution" are equally far: on a linear metric, 0.5x (off by 0.5) would beat
 * 4x (off by 3) even though 0.5x is the blurry one.
 *
 * @param {number} wantScale - the scale the frame would have requested
 * @param {number[]} cachedScales - scales already resident for this page
 * @returns {number|null} the scale to draw, or null when nothing is cached
 *
 * @example bestCachedScale(2.0, [1.0, 4.0]) // 4 (EQUIDISTANT in log space → the sharper one: |ln(1/2)| = |ln(4/2)|)
 * @example bestCachedScale(2.0, [1.9, 4.0]) // 1.9 (much closer than 4)
 * @example bestCachedScale(2.0, []) // null (nothing resident — caller draws a placeholder)
 *
 * (Declared above its caller; see pdfPageRasterRefForDisplay at the end of this
 * section for THE seam the widgets actually call.)
 */
export function bestCachedScale(wantScale, cachedScales) {
  if (!(wantScale > 0) || cachedScales.length === 0) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const scale of cachedScales) {
    if (!(scale > 0)) continue;
    const distance = Math.abs(Math.log(scale / wantScale));
    // `<=` is the tie-break: equal distance keeps the LARGER scale, because the
    // loop meets scales in ascending order only by accident and a later equal
    // candidate is the bigger one whenever the list is sorted that way. Sorting is
    // done by the caller, which owns the map iteration order.
    if (distance <= bestDistance) { bestDistance = distance; best = scale; }
  }
  return best;
}

/**
 * Query (reads the cache; near-pure — it touches LRU stamps and the keep-set).
 * The best ALREADY-RASTERIZED whole-page ref for (src, page), or null when the page
 * has no raster at any scale. Requests NOTHING: this is the read half of the
 * interaction LOD, so a drag draws what is resident instead of kicking a fresh
 * rasterization for every zoom bucket it sweeps through.
 *
 * The returned ref is added to `requestedSinceTrim` for the same reason
 * ensurePdfPageRasterized adds its own: the frame about to paint uses this Image
 * SYNCHRONOUSLY, so the trim must not free it out from under the draw.
 *
 * @example pdfBestCachedPageRef("blob:never-rasterized", 1, 2.0) // null (cold cache)
 * @example // with scales 1.0 and 1.9 resident for page 1:
 * @example //   pdfBestCachedPageRef(src, 1, 2.0) -> {ref: "pdfpage:<src>:1:1.9", scale: 1.9}
 */
export function pdfBestCachedPageRef(src, page, wantScale) {
  const prefix = `${src}|${page}|`;
  const scales = [];
  for (const [key, entry] of pages) {
    if (!key.startsWith(prefix) || entry.status !== "ready") continue;
    scales.push(Number(key.slice(prefix.length)));
  }
  scales.sort((a, b) => a - b);
  const scale = bestCachedScale(wantScale, scales);
  if (scale == null) return null;
  const entry = pages.get(`${prefix}${scale}`);
  entry.lastUsed = ++useSeq;
  const ref = pdfPageRef(src, page, scale);
  requestedSinceTrim.add(ref);
  return { ref, scale };
}

// NO "BEST CACHED REGION" LOOKUP, DELIBERATELY. One existed here — the region
// twin of pdfBestCachedPageRef — and it had NO caller: pdf_display asks only for
// whole-page rasters when a gesture is live, and the docblock naming it as the
// caller was simply wrong. It also could not have been correct if wired: it
// carried its own nearest-scale loop with a strict `<`, so a tie kept whichever
// entry Map iteration reached first rather than the sharper raster, contradicting
// bestCachedScale's "identical for whole pages and regions". A region raster is
// keyed by the VISIBLE WINDOW, which moves every frame of a pan, so a useful
// version has to ignore the sub-rect and return the region's own sourceRect for
// the caller to place. If that fallback is ever wanted, write it THROUGH
// bestCachedScale so the policy stays stated once.

/**
 * THE INTERACTION-LOD PLACEHOLDER — the flat fill a PDF-family widget draws while a
 * gesture is live and NOTHING is resident for that page.
 *
 * The user asked "Why don't we just make them white rectangles?", and this is that
 * — but PAPER, not white. It is the same value pdf_packet already ships as its
 * `paper` default, so an un-landed sheet reads as a blank page of the same stock as
 * its neighbours instead of a bright white hole punched in the fan. A literal
 * #ffffff would be the one colour guaranteed to flash against every real page,
 * since a scanned or rendered PDF page is never pure white at its edges.
 *
 * It is shared here rather than per-plugin so the three widgets cannot drift into
 * three different "loading" colours for one gesture.
 */
export const PDF_PLACEHOLDER_PAPER = "#fbfaf7";

/**
 * Command (near-pure: idempotent) OR Query, depending on `interactive` — THE ONE
 * SEAM the three PDF-family widgets ask for a whole-page raster through, so the
 * interaction-LOD policy is written once instead of three times.
 *
 *   interactive (the default, and everything that is not an editor drag):
 *     exactly the old behaviour — request `wantScale` and return its ref, whether
 *     or not it has landed yet. Byte-identical, and the reason exports, the CLI,
 *     thumbnails and the presenter needed no changes at all.
 *   NOT interactive (a live pointer gesture in the editor):
 *     request NOTHING and return the best raster already resident. This is the
 *     whole fix. A drag sweeps continuously through PDF_SCALE_STEP buckets, and
 *     each new bucket is a cache miss that kicks a fresh pdf.js page render — for
 *     paper_peacock once per SHEET per frame, which is the case the user reported
 *     as "laggy to drag around".
 *
 * Returns null ONLY when the page has no raster at ANY scale — a genuinely cold
 * cache, not a miss at this scale — which is the caller's cue to draw a
 * placeholder. Once anything has landed, a drag always draws real pixels.
 *
 * @param {boolean} interactive - false only while an editor pointer gesture is live
 * @returns {string|null} an image-registry ref, or null when nothing is resident
 *
 * @example pdfPageRasterRefForDisplay("blob:never-rasterized", 1, 2.0, false) // null (nothing resident; caller draws the placeholder)
 * @example // interactive (the default) always returns a ref and REQUESTS that scale:
 * @example //   pdfPageRasterRefForDisplay(src, 1, 2.0) -> "pdfpage:<src>:1:2"
 * @example // dragging, with 1.9 already resident:
 * @example //   pdfPageRasterRefForDisplay(src, 1, 2.0, false) -> "pdfpage:<src>:1:1.9" (requests nothing)
 */
export function pdfPageRasterRefForDisplay(src, page, wantScale, interactive = true) {
  if (interactive) {
    ensurePdfPageRasterized(src, page, wantScale);
    return pdfPageRef(src, page, wantScale);
  }
  return pdfBestCachedPageRef(src, page, wantScale)?.ref ?? null;
}

/**
 * Command. Brings BOTH raster caches back inside PDF_RASTER_CACHE_BYTES by FREEING
 * the least recently used entries across them — bookkeeping AND pixels
 * (image_registry.releaseImage deletes the CanvasKit Image, which is the copy that
 * lives in the wasm heap, and closes the ImageBitmap). Called once per frame by the
 * display pre-pass (render_gpu/pdf_display.preRasterizePdfPages); without it nothing
 * ever frees a raster and a session walks the wasm heap into its 2 GiB ceiling (see
 * PDF_RASTER_CACHE_BYTES for both measurements).
 *
 * THE KEEP-SET IS `requestedSinceTrim`, not an argument: every ref any consumer
 * asked for since the previous trim. Those are the refs the frame about to paint
 * needs, and they are never evicted whatever the budget says — a CanvasKit Image is
 * used SYNCHRONOUSLY during paint, so freeing one the next paint wants would draw a
 * hole, or worse use freed memory. See that Set's declaration for why the caller
 * cannot supply this list itself.
 *
 * When the live set ALONE exceeds the budget nothing can be freed. That is a real
 * (if exotic) over-subscription — many maximal-resolution PDF pages co-visible — so
 * it is REPORTED, loudly and once, rather than silently honoured or silently
 * ignored: correctness wins (the frame still paints) and the user learns the deck is
 * running at the heap ceiling instead of meeting a crash later.
 *
 * In-flight entries are also kept: they have no pixels to free yet, and dropping a
 * reserved slot would send the compositor's ensureImage fallback off to fetch() a
 * synthetic ref (image_registry.reserveImageSlot).
 *
 * Returns:
 *   {evicted, freedBytes, bytes}: how many rasters were freed, how many bytes that
 *   reclaimed, and the total cache size afterwards.
 *
 * @example // steady state, everything the frame asked for still fits
 * // trimPdfRasterCache() // {evicted: 0, freedBytes: 0, bytes: 41943040}
 * @example // after a resize drag has left stale size buckets behind
 * // trimPdfRasterCache() // {evicted: 37, freedBytes: 1610612736, bytes: 268435456}
 */
export function trimPdfRasterCache() {
  const keep = requestedSinceTrim;
  requestedSinceTrim = new Set();
  let bytes = pdfRasterCacheBytes();
  let evicted = 0;
  let freedBytes = 0;
  if (bytes > PDF_RASTER_CACHE_BYTES) {
    // ONE order over BOTH maps — least recently used first. A whole-page raster for
    // a size the widget no longer has and a region for a view long panned away are
    // the same kind of garbage, and which is stalest is a question only the shared
    // clock can answer.
    const evictable = [];
    for (const map of [pages, regions])
      for (const [key, entry] of map)
        if (entry.status === "ready" && !keep.has(entry.ref)) evictable.push({ map, key, entry });
    evictable.sort((a, b) => a.entry.lastUsed - b.entry.lastUsed);
    for (const { map, key, entry } of evictable) {
      if (bytes <= PDF_RASTER_CACHE_BYTES) break;
      map.delete(key);
      releaseImage(entry.ref); // frees the wasm-heap Image copy AND the ImageBitmap
      freedBytes += entry.bytes;
      bytes -= entry.bytes;
      evicted++;
    }
  }
  if (bytes > PDF_RASTER_CACHE_BYTES)
    reportOnce("pdf_page_raster:budget", `PowerRP pdf_page_raster: the PDF rasters ONE frame needs total ${(bytes / 1048576).toFixed(0)} MB, over the ${(PDF_RASTER_CACHE_BYTES / 1048576).toFixed(0)} MB raster-cache budget — keeping them all (a frame must paint), but this deck is running close to CanvasKit's 2 GiB wasm heap ceiling. Reduce the number of co-visible PDF pages, their size, or their zoom.`);
  return { evicted, freedBytes, bytes };
}

/** Pure function. Clamps a raster canvas edge into [1, PDF_MAX_RASTER_DIM],
 * flooring any non-finite (NaN/±∞) input to 1 — a NaN edge would otherwise pass
 * through `Math.min(4096, NaN) === NaN` straight into canvas.width and produce a
 * broken (0-area or heap-overrunning) raster. Rounds fractional edges.
 *
 * A BACKSTOP, NOT A SIZING POLICY: every caller now derives its canvas from a
 * rasterFitFactor-corrected scale, so this should never actually reduce anything.
 * It stays because a NaN or negative edge reaching canvas.width must still be
 * impossible.
 * @example clampDim(0) // 1
 * @example clampDim(9000) // 4096
 * @example clampDim(300) // 300
 * @example clampDim(NaN) // 1
 * @example clampDim(Infinity) // 4096
 */
export function clampDim(px) {
  if (Number.isNaN(px)) return 1; // NaN is meaningless; ±∞ flow through min/max below
  return Math.max(1, Math.min(PDF_MAX_RASTER_DIM, Math.round(px)));
}

/** Command. Bumps and returns the region-render generation for (src, page).
 * Call exactly once per newly-kicked region render (never on a cache hit).
 * Mutates regionGenerations — see that Map's doc for the stale-discard rationale. */
function bumpRegionGeneration(src, page) {
  const gkey = `${src}|${page}`;
  const next = (regionGenerations.get(gkey) ?? 0) + 1;
  regionGenerations.set(gkey, next);
  return next;
}

/** Query. The current (latest-kicked) region-render generation for (src, page),
 * or 0 if none has been kicked. Reads regionGenerations. */
function currentRegionGeneration(src, page) {
  return regionGenerations.get(`${src}|${page}`) ?? 0;
}

/**
 * Command. Drops all cached PDF documents and rasterized pages. For tests
 * that need a clean registry; also the invalidation hook for a future
 * mutable-source policy (mirrors resetImageRegistry/resetVideoRegistry).
 */
export function resetPdfPageRaster() {
  docs.clear();
  pointSizes.clear();
  for (const map of [pages, regions]) {
    for (const entry of map.values()) releaseImage(entry.ref); // pixels too, not just bookkeeping
    map.clear();
  }
  regionGenerations.clear();
  requestedSinceTrim = new Set();
}

// ── FUTURE WORK (flagged, not built here) ───────────────────────────────────
// VECTOR PDF re-embed: today's PDF EXPORT of a pdf_page widget is a raster
// PNG region (this module's bitmap, embedded via the same image XObject path
// as a photo) — the "hybrid rule" precedent (manifest: shadow/bloom/blend
// already accept a raster region for v1). A future upgrade could re-embed
// the SOURCE PDF page's own vector content (selectable text, crisp at any
// zoom) via pdf-lib's page-embedding APIs instead of rasterizing — flagged
// future work, not attempted here (out of this widget's v1 scope per the
// task brief).
