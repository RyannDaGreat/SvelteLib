/**
 * ASSET THUMBNAIL rasterizer (manifest #25) — a small cached PREVIEW bitmap +
 * a BADGE value for an asset that needs one rendered. Today: PDF assets (a
 * first-page thumbnail + a page-count badge).
 *
 * WHY a separate module from pdf_page_raster.js: that module rasterizes a
 * placed PDF WIDGET's page into the GPU compositor's image registry (a scene
 * bitmap). This one produces a standalone PNG data URL for the ASSET LIBRARY
 * tile — a different consumer (an <img> in the Explorer, and bytes POSTed to the
 * server thumbnail cache), not a scene draw. It REUSES pdf_page_raster's
 * `ensurePdfDoc` READ-ONLY to open the document (one pdfjs load path, one error
 * discipline) and then renders page 1 to its OWN small canvas — it never mutates
 * the scene image registry, so it can never disturb the widget render path.
 *
 * Browser/CLI-only (needs `document.createElement("canvas")` + pdfjs via
 * ensurePdfDoc). Like pdf_page_raster.js, the FUNCTIONS throw loudly if invoked
 * in bare node; the pure helpers below are import-time-safe.
 *
 * LOUD FAILURE (no silent fallback): a PDF that fails to open/render rejects
 * with a descriptive Error — the caller (app.ensureAssetThumbnail) reports it
 * and shows the plain kind icon, never a silently-blank tile.
 */

import { ensurePdfDoc } from "./pdf_page_raster.js";

/**
 * The longest edge (CSS px) of a rendered asset thumbnail. Big enough to stay
 * crisp in the ~72px Explorer tile on a 2–3x display (the tile upscales a
 * cover-fit <img>), small enough that the cached PNG is a few KB. Not tied to
 * the tile's CSS size (that is fluid) — a fixed raster budget, like a video
 * poster frame.
 */
export const THUMBNAIL_MAX_EDGE = 256;

/**
 * Pure function. The pdfjs render scale (canvas px per PDF point) that fits a
 * page of `pointW`×`pointH` points into a `maxEdge`×`maxEdge` box, preserving
 * aspect. Never returns a non-positive scale (a degenerate page falls back to
 * 1) so the canvas is always at least 1px.
 *
 * @example thumbnailScale(612, 792, 256) // 0.32323232323232326  (792 * s = 256)
 * @example thumbnailScale(792, 612, 256) // 0.32323232323232326  (landscape: width bounds)
 * @example thumbnailScale(0, 0, 256) // 1
 */
export function thumbnailScale(pointW, pointH, maxEdge) {
  const longest = Math.max(pointW, pointH);
  if (!(longest > 0)) return 1;
  return maxEdge / longest;
}

/**
 * Command (drives an off-DOM canvas + pdfjs; the impure step). Renders page
 * `page` (1-based) of the PDF at `src` to a small PNG data URL and returns it
 * with the document's page count — the {thumbnail, badge} an asset tile needs.
 * Rejects loudly on an open/render failure (no blank-canvas fallback).
 *
 * @param {string} src Absolute PDF URL (or data:/blob: URI).
 * @param {number} [maxEdge] Longest thumbnail edge in px (THUMBNAIL_MAX_EDGE).
 * @param {number} [page] 1-based page to render (default 1 — the cover).
 * @returns {Promise<{dataUrl: string, pageCount: number}>}
 */
export async function renderPdfThumbnail(src, maxEdge = THUMBNAIL_MAX_EDGE, page = 1) {
  if (typeof src !== "string" || !src) {
    throw new Error(`renderPdfThumbnail: src must be a non-empty string, got ${JSON.stringify(src)}`);
  }
  const doc = await ensurePdfDoc(src); // reused READ-ONLY; already reports load failures loudly
  if (!doc) throw new Error(`renderPdfThumbnail: PDF failed to load — "${src.slice(0, 64)}"`);
  const pageCount = doc.numPages;
  const clamped = Math.min(Math.max(1, page | 0), pageCount);
  const pdfPage = await doc.getPage(clamped);
  const unit = pdfPage.getViewport({ scale: 1 });
  const scale = thumbnailScale(unit.width, unit.height, maxEdge);
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d");
  // White backing: PDFs assume paper white; without it a transparent canvas
  // reads as black on a dark tile (a page that's blank would vanish).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, canvas, viewport }).promise;
  return { dataUrl: canvas.toDataURL("image/png"), pageCount };
}
