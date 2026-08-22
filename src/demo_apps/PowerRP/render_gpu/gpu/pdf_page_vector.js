/**
 * The async PDF-page VECTOR ingest — the browser/CLI-facing HALF of the
 * PDF-as-vector feature (PDF P1). The TWIN of gpu/pdf_page_raster.js: where that
 * module rasterizes a page to a bitmap, this one extracts a page's DRAWING
 * PROGRAM (pdf.js `getOperatorList()`), classifies it, and — for a vector-safe
 * page — hands it to the PURE mapper (render_gpu/pdf_vector.js) to build a list
 * of `path` IR ops. Following the latexVector dual pattern, the whole-page raster
 * ref (pdf_page_raster.js) stays the ALWAYS-available fallback; this adds a
 * vector sub-list ON TOP when the page is safe, and plugins/pdf_page.js emit()
 * prefers it.
 *
 * ── WHY THE LEGACY pdf.js BUILD, AND WHAT IT IS *NOT* A CONTRAST WITH ────────
 * THIS PARAGRAPH WAS WRONG UNTIL 2026-08-22, and the way it was wrong is the
 * reason its "future optimization" note below was never taken up. It said
 * *"gpu/pdf_page_raster.js loads the MAIN pdfjs build + a Worker … this module
 * instead loads the legacy build"* — a contrast between two builds. There is no
 * such contrast: `pdf_page_raster.js:158` loads
 * `pdfjs-dist/legacy/build/pdf.mjs` too, and its worker at
 * `pdfjs-dist/legacy/build/pdf.worker.mjs?url` (:165). BOTH paths are on legacy;
 * what differs is only that the raster path additionally spins a Worker.
 *
 * So the choice here is not a divergence to justify — it is the same build, and
 * the reasons below are why LEGACY is right for both. This module loads
 * `pdfjs-dist/legacy/build/pdf.mjs`, which:
 *   - runs in BARE NODE with no Worker and no DOM (verified) — so the vector
 *     extraction path (operator list + viewport are plain data, no canvas) works
 *     in the headless CLI (cli/render.js) and node tests, not just the browser;
 *   - is a plain module specifier (no Vite-only `?url`), so a bare-node STATIC
 *     import graph that reaches this file (plugins/index.js → plugins/pdf_page.js
 *     → here) never fails to parse — the import is done LAZILY inside loadPdfjs()
 *     regardless, mirroring pdf_page_raster's bare-node-safety lesson.
 * Cost: this is a SEPARATE pdfjs INSTANCE from the raster path's (two parses of
 * the same document) — not, as this line used to say, a separate BUILD. They are
 * already the same build, so "consolidate both onto one build" was a task with
 * nothing to do, which is presumably why nobody did it. THE REAL REMAINING COST
 * is the second `import()` and the second `getDocument` parse; sharing them means
 * ONE document cache both paths read, which is a genuine piece of work (the raster
 * side owns a Worker and this side must run without one) and is still open.
 *
 * ── ASYNC + LOUD-FALLBACK CONTRACT (mirrors pdf_page_raster.js) ───────────────
 *   - ensurePdfPageVector(src, page) kicks an idempotent extract+classify; a
 *     no-op once that (src,page) is loading/ready/errored.
 *   - pdfPageVectorIRFor(src, page, box) is the SYNC query emit() calls: it
 *     returns the page's `path` ops mapped into `box` when the page is ready AND
 *     vector-safe, else null (emit falls back to the raster image op — the async
 *     "draw the fallback until vector lands" contract; no silent blank).
 *   - a page that classifies UNSAFE, or that throws while building (a classifier
 *     gap or a pdf.js op-layout drift), is reported ONCE via reportOnce and
 *     latched to raster-fallback (never retried, never a silent mis-render).
 * The built IR is memoized per (src,page) against the last box, so a static
 * repaint / playback frame reuses it and only rebuilds when the box changes.
 */

import { reportOnce, truncate } from "../../core/report.js";
import { classifyPdfPage, pdfPageVectorIR } from "../pdf_vector.js";

// pdfjs (legacy build) is loaded LAZILY (dynamic import inside loadPdfjs) so a
// bare-node static import of this module never evaluates pdfjs at import time —
// only at first extraction CALL. See the module header's bare-node note.
let pdfjsLibPromise = null;
/** Command (near-pure: memoized). Dynamically imports the legacy pdfjs build
 * (node + browser, no worker) exactly once per process. */
function loadPdfjs() {
  if (!pdfjsLibPromise) pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsLibPromise;
}

/** src → {status, docPromise, error} — the vector-side document cache (its OWN
 * legacy-build doc; see the module header on why it does not share the raster
 * path's main-build doc). */
const docs = new Map();
/** "<src>|<page>" → {status:"loading"|"ready"|"error", vectorSafe, reason,
 * pageViewport:{width,height,transform}, opList:{fnArray,argsArray}, error}. */
const pages = new Map();
/** "<src>|<page>" → {boxKey, ir} — memoized built IR against the last box, so a
 * static repaint reuses it and only rebuilds on an actual box change. */
const irMemo = new Map();

const pageKey = (src, page) => `${src}|${page}`;
const boxKey = (box) => `${box.x},${box.y},${box.w},${box.h}`;

/**
 * Query (near-pure). A pdf.js getDocument SOURCE for `src` that works in BOTH
 * node and the browser: a `data:` URI is decoded to bytes ({data}) because the
 * node build's getDocument only accepts file:// URLs, while any other src (blob:,
 * file:, http(s), relative) passes as {url}. atob is a global in node ≥16 and the
 * browser.
 *
 * @param {string} src a data: URI, blob: URI, file:// or http(s) URL
 * @returns {{data:Uint8Array}|{url:string}}
 *
 * @example // getDocumentSource("data:application/pdf;base64,JVBERi0=") // {data: Uint8Array(...)}
 * @example getDocumentSource("file:///x.pdf") // {url: "file:///x.pdf"}
 */
export function getDocumentSource(src) {
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    if (comma < 0) throw new Error("getDocumentSource: malformed data URI (no comma)");
    const meta = src.slice(0, comma);
    const payload = src.slice(comma + 1);
    if (!meta.includes("base64")) throw new Error("getDocumentSource: only base64 data URIs are supported");
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { data: bytes };
  }
  return { url: src };
}

/**
 * Command (near-pure: idempotent). Ensures the PDF at `src` is loading/loaded on
 * the VECTOR-side legacy-build instance. Safe to call every frame. Errors are
 * reported once and latch the src "error".
 */
function ensureVectorDoc(src) {
  const existing = docs.get(src);
  if (existing) return existing.docPromise;
  const entry = { status: "loading", docPromise: null, error: null };
  entry.docPromise = loadPdfjs()
    .then((pdfjsLib) => pdfjsLib.getDocument({ ...getDocumentSource(src), isEvalSupported: false }).promise)
    .then((doc) => { entry.status = "ready"; return doc; })
    .catch((e) => {
      entry.status = "error";
      entry.error = e instanceof Error ? e : new Error(String(e));
      reportOnce(`pdf_page_vector:doc:${src}`, `PowerRP pdf_page_vector: failed to open PDF "${truncate(src)}" for vector extraction — ${entry.error.message}`);
      return null;
    });
  docs.set(src, entry);
  return entry.docPromise;
}

/**
 * Command (near-pure: idempotent). Ensures (src, page)'s operator list is
 * extracted and classified. A no-op once that key is loading/ready/errored —
 * safe to call every frame from a sync emit(). Fire-and-forget: the render path
 * reads pdfPageVectorIRFor(...) synchronously and draws the raster fallback until
 * this lands. On a UNSAFE classification it stores the reason (logged by
 * pdfPageVectorIRFor's first read); on an extraction error it reports loudly.
 *
 * `page` MUST already be clamped into [1, pageCount] by the caller
 * (plugins/pdf_page.js, via pdf_page_raster.clampPage) — this module extracts
 * exactly the page it is asked for.
 *
 * @example // ensurePdfPageVector(dataUri, 1); ...later... pdfPageVectorIRFor(dataUri, 1, {x:0,y:0,w:300,h:240}) → [path, ...]
 */
export function ensurePdfPageVector(src, page) {
  if (typeof src !== "string" || src.length === 0)
    throw new Error(`ensurePdfPageVector: src must be a non-empty string, got ${JSON.stringify(src)}`);
  const key = pageKey(src, page);
  const existing = pages.get(key);
  if (existing) return existing.promise;

  const entry = { status: "loading", vectorSafe: false, reason: "loading", pageViewport: null, opList: null, error: null, promise: null };
  entry.promise = (async () => {
    const doc = await ensureVectorDoc(src);
    if (!doc) throw new Error("PDF document failed to open"); // ensureVectorDoc already reported it
    const pdfPage = await doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const opList = await pdfPage.getOperatorList();
    const { vectorSafe, reason } = classifyPdfPage(opList);
    entry.pageViewport = { width: viewport.width, height: viewport.height, transform: Array.from(viewport.transform) };
    entry.opList = opList;
    entry.vectorSafe = vectorSafe;
    entry.reason = reason;
    entry.status = "ready";
    return entry;
  })().catch((e) => {
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    reportOnce(`pdf_page_vector:extract:${key}`, `PowerRP pdf_page_vector: failed to extract "${truncate(src)}" page ${page} — ${entry.error.message}`);
    return entry;
  });
  pages.set(key, entry);
  return entry.promise;
}

/**
 * Query. The extract status of (src, page): "unloaded", "loading", "ready", or
 * "error".
 *
 * @example pdfPageVectorStatus("nope", 1) // "unloaded"
 */
export function pdfPageVectorStatus(src, page) {
  return pages.get(pageKey(src, page))?.status ?? "unloaded";
}

/**
 * Query→build (near-pure: memoized rebuild). The page's `path` IR ops mapped into
 * `box`, when (src, page) is READY and VECTOR-SAFE; else null (the caller draws
 * the raster fallback). The FIRST time a page is found unsafe, its reason is
 * logged ONCE (loud, never silent). If the pure mapper THROWS (a classifier gap
 * or pdf.js op-layout drift), the page is latched to raster-fallback and reported
 * — never a silent mis-render. Memoizes the built IR against the last box so a
 * static repaint reuses it and rebuilds only on a box change.
 *
 * Args:
 *   src (string), page (number): the ready page
 *   box ({x,y,w,h}): the widget's local target box (crop-inset rect)
 *
 * Returns:
 *   object[] | null: `path` IR ops, or null (not ready / unsafe / build failed)
 *
 * @example // pdfPageVectorIRFor(dataUri, 1, {x:0,y:0,w:300,h:240}) → [path, path, ...] once ready+safe, else null
 */
export function pdfPageVectorIRFor(src, page, box) {
  const key = pageKey(src, page);
  const entry = pages.get(key);
  if (!entry || entry.status !== "ready") return null; // loading / errored / never requested
  if (!entry.vectorSafe) {
    reportOnce(`pdf_page_vector:raster:${key}`, `PowerRP pdf_page_vector: page ${page} of "${truncate(src)}" renders as RASTER (not vector) — ${entry.reason}.`);
    return null;
  }
  const bk = boxKey(box);
  const memo = irMemo.get(key);
  if (memo && memo.boxKey === bk) return memo.ir;
  let ir;
  try {
    ir = pdfPageVectorIR(entry.opList, { pageViewport: entry.pageViewport, box });
  } catch (e) {
    // The classifier passed but the mapper could not faithfully build this page.
    // Latch it to raster-fallback (never retried) and report loudly — the "no
    // silent fallback" rule; the raster ref keeps the widget rendering.
    entry.vectorSafe = false;
    entry.reason = `vector build failed: ${e instanceof Error ? e.message : String(e)}`;
    reportOnce(`pdf_page_vector:build:${key}`, `PowerRP pdf_page_vector: page ${page} of "${truncate(src)}" fell back to RASTER — ${entry.reason}.`);
    return null;
  }
  irMemo.set(key, { boxKey: bk, ir });
  return ir;
}

/**
 * Command. Drops all cached vector docs, pages, and memoized IR. For tests that
 * need a clean registry; mirrors resetPdfPageRaster/resetImageRegistry.
 */
export function resetPdfPageVector() {
  docs.clear();
  pages.clear();
  irMemo.clear();
}
