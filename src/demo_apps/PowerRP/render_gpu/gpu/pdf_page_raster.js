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

import { reserveImageSlot, registerRasterizedBitmap } from "./image_registry.js";
import { reportOnce } from "../../core/report.js";

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
let pdfjsLibPromise = null;
/** Command (near-pure: memoized). Dynamically imports pdfjs-dist and wires
 * its worker script (Vite's `?url` import, done INSIDE this dynamic import
 * so bare node never parses it) exactly once per process. */
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const pdfjsLib = await import("pdfjs-dist");
      // Vite's `?url` import (the fontLoader.js/pdfFonts.js precedent) gives
      // the worker script a served URL without bundling it into this
      // module's own chunk — pdfjs-dist's pipeline parses/decodes on a
      // Worker. Nested inside this dynamic import so it is NEVER evaluated
      // by a bare-node static import graph.
      const { default: pdfWorkerUrl } = await import("pdfjs-dist/build/pdf.worker.mjs?url");
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
/** "<src>|<page>|<roundedScale>" → {status, ref, error} */
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
  if (pages.has(key)) return pages.get(key).promise;

  const ref = pdfPageRef(src, page, scale);
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
  const entry = { status: "loading", ref, error: null, promise: null };
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
    const fitScale = Math.min(PDF_MAX_RASTER_DIM / unit.width, PDF_MAX_RASTER_DIM / unit.height);
    const effScale = Math.min(requested, fitScale);
    if (effScale < requested) reportOnce(`pdf_page_raster:cap:${key}`, `PowerRP pdf_page_raster: whole-page raster for "${truncate(src)}" page ${page} @${requested}x would exceed ${PDF_MAX_RASTER_DIM}px/edge — capped to ${effScale.toFixed(3)}x (page shown at lower resolution).`);
    const viewport = pdfPage.getViewport({ scale: effScale });
    const canvas = document.createElement("canvas");
    canvas.width = clampDim(viewport.width);
    canvas.height = clampDim(viewport.height);
    const ctx = canvas.getContext("2d");
    await pdfPage.render({ canvasContext: ctx, canvas, viewport }).promise;
    const bitmap = await createImageBitmap(canvas);
    entry.status = "ready";
    registerRasterizedBitmap(ref, bitmap); // wakes image_registry.onImageLoad subscribers too
    return bitmap;
  })().catch((e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
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

/** Cap on distinct cached REGION rasters. v1 re-rasters the visible window on
 * every pan/zoom change (TILING for smooth pan is backburnered — manifest), so
 * a long pan/zoom session would otherwise accumulate one entry per distinct
 * view. When the cache exceeds this, the OLDEST entries are evicted (Map keeps
 * insertion order) — a crude bounded LRU. Sized for "a handful of PDF widgets ×
 * a healthy scrollback of recent views" without unbounded growth. */
export const PDF_REGION_CACHE_MAX = 64;

/** "<src>|<page>|<sx>,<sy>,<sw>,<sh>|<roundedScale>" → {status, ref, error, promise} */
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
  if (regions.has(key)) return { ref };

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
  // already deduped by the regions.has(key) early-return above.)
  const myGeneration = bumpRegionGeneration(src, page);
  const entry = { status: "loading", ref, error: null, promise: null };
  entry.promise = (async () => {
    const doc = await ensurePdfDoc(src);
    if (!doc) throw new Error("PDF document failed to load"); // ensurePdfDoc already reported this
    const pdfPage = await doc.getPage(page);
    // Full-page viewport at the (capped) display scale, shifted so the sub-rect's
    // top-left sits at the canvas origin (pdf.js viewport is already y-down,
    // top-left origin — the same frame our normalized sourceRect uses).
    const viewport = pdfPage.getViewport({
      scale: deviceScale,
      offsetX: -sourceRect.sx * point.w * deviceScale,
      offsetY: -sourceRect.sy * point.h * deviceScale,
    });
    const canvasW = clampDim(Math.round(sourceRect.sw * point.w * deviceScale));
    const canvasH = clampDim(Math.round(sourceRect.sh * point.h * deviceScale));
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
      // too so revisiting this exact view re-renders instead of forever resolving
      // to the reserved-but-empty registry slot.
      bitmap.close();
      regions.delete(key);
      return null;
    }
    entry.status = "ready";
    registerRasterizedBitmap(ref, bitmap); // wakes image_registry.onImageLoad → repaint
    return bitmap;
  })().catch((e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    reportOnce(`pdf_page_raster:region:${key}`, `PowerRP pdf_page_raster: failed to rasterize "${truncate(src)}" page ${page} region @${roundedScale}x — ${entry.error.message}`);
    return null;
  });
  regions.set(key, entry);
  if (regions.size > PDF_REGION_CACHE_MAX) evictOldestRegion();
  return { ref };
}

/** Pure function. Clamps a raster canvas edge into [1, PDF_MAX_RASTER_DIM],
 * flooring any non-finite (NaN/±∞) input to 1 — a NaN edge would otherwise pass
 * through `Math.min(4096, NaN) === NaN` straight into canvas.width and produce a
 * broken (0-area or heap-overrunning) raster. Rounds fractional edges.
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

/** Command. Drops the oldest region-cache entry (Map insertion order = LRU-ish).
 * The evicted bitmap stays in the image registry (bounded by distinct refs, and
 * cheap to re-register); this only bounds THIS module's per-key bookkeeping. */
function evictOldestRegion() {
  const oldest = regions.keys().next().value;
  if (oldest !== undefined) regions.delete(oldest);
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

/** Pure function. Shortens a src for log messages (data URIs are huge).
 * @example truncate("data:application/pdf;base64," + "A".repeat(200)) // "data:application/pdf;base64,AA…(228 chars)"
 */
function truncate(src) {
  return src.length > 48 ? `${src.slice(0, 24)}…(${src.length} chars)` : src;
}

/**
 * Command. Drops all cached PDF documents and rasterized pages. For tests
 * that need a clean registry; also the invalidation hook for a future
 * mutable-source policy (mirrors resetImageRegistry/resetVideoRegistry).
 */
export function resetPdfPageRaster() {
  docs.clear();
  pages.clear();
  pointSizes.clear();
  regions.clear();
  regionGenerations.clear();
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
