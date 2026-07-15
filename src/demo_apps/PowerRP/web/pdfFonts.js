/**
 * Browser seams that feed the committed fonts into the PDF backend so vector
 * text embeds the SAME face the glyph atlas rasterizes (manifest "Text fonts",
 * PDF EXPORT embedFont). The backend (render_gpu/pdf_backend.js) stays DOM-free;
 * these three helpers are its browser environment adapters:
 *
 *   - fontkit()       — dynamically imports @pdf-lib/fontkit (code-split, like
 *                       pdf-lib itself: costs nothing until a PDF export).
 *   - loadFontBytes   — fetches a committed TTF by basename from the Vite ?url
 *                       asset table (offline: bundled local files, no network).
 *   - measureTextAscent — a per-font (fontId, bold) → ascent-fraction function,
 *                       measured from canvas2D fontBoundingBoxAscent of the SAME
 *                       family fontString() uses, so PDF baselines land exactly
 *                       where the GPU atlas top-anchors each face.
 *
 * The committed fonts must be LOADED (web/fontLoader.js) before measuring, or
 * canvas2D reports the fallback face's ascent. Export runs post-boot, after
 * fontLoader settled, so callers can measure directly.
 */

import { fontString } from "../render_gpu/gpu/glyph_atlas.js";

/** Same ?url table as fontLoader — Vite inlines each at build (offline). */
const FONT_URLS = import.meta.glob("../fonts/*.ttf", { query: "?url", import: "default", eager: true });

/** Query (async; may fetch a bundled local asset). Committed TTF bytes by
 * basename. Loud on a missing file (a registry/file mismatch — never silent). */
export async function loadFontBytes(basename) {
  const url = FONT_URLS[`../fonts/${basename}`];
  if (!url) throw new Error(`pdfFonts: no committed file for "${basename}" — check render_gpu/fonts.js vs the fonts/ dir`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pdfFonts: failed to load committed font "${basename}" (${url}) — HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Query (async; dynamic import). The @pdf-lib/fontkit instance pdf-lib needs
 * to embed a custom TTF. Code-split so it loads only on export. */
export async function fontkit() {
  const mod = await import("@pdf-lib/fontkit");
  return mod.default ?? mod;
}

/**
 * Query. A per-font ascent-fraction function for irToPDF's textAscent option.
 * Measures each committed face's canvas fontBoundingBoxAscent (the exact value
 * the glyph atlas top-anchors on) so PDF baselines match the GPU per font.
 * Memoized per (fontId, bold). The font must already be loaded.
 */
export function measureTextAscent() {
  const mctx = document.createElement("canvas").getContext("2d");
  const REF_SIZE = 100; // any size — the fraction is size-relative
  const cache = new Map();
  return (fontId, bold) => {
    const key = `${fontId}|${bold ? 1 : 0}`;
    let frac = cache.get(key);
    if (frac === undefined) {
      mctx.font = fontString(REF_SIZE, bold, fontId);
      frac = mctx.measureText("Mg").fontBoundingBoxAscent / REF_SIZE;
      cache.set(key, frac);
    }
    return frac;
  };
}

/**
 * Query. The per-RUN measure seam the PDF backend's RICH-TEXT layout needs
 * (irToPDF opts.measureText): (text, {size, bold, font, italic}) → {width,
 * ascent, descent} at the run's nominal size, from canvas2D — the SAME face
 * fontString() names AND the SAME metrics the GPU glyph atlas measures, so the
 * shared layout (core/richtext) puts every run at the SAME position in both
 * backends (the parity lever). Uses the SAME font syntax as the atlas
 * (glyph_atlas.fontString, incl. italic synthesis). The committed fonts must be
 * loaded (web/fontLoader.js) before measuring; export runs post-boot.
 */
export function measureText() {
  const mctx = document.createElement("canvas").getContext("2d");
  return (str, { size, bold, font, italic }) => {
    mctx.font = fontString(size, !!bold, font, !!italic);
    const t = mctx.measureText(str);
    return { width: t.width, ascent: t.fontBoundingBoxAscent, descent: t.fontBoundingBoxDescent };
  };
}
