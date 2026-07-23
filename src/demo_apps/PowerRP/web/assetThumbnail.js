/**
 * Asset tile PRESENTATION — the single pure decision of how one asset renders in
 * the library grid (Asset Explorer + AssetField picker), from the general
 * `{thumbnail?, badge?}` metadata the server attaches (manifest #25).
 *
 * The generalization: EVERY asset can carry an optional cached preview
 * `thumbnail` (a bitmap URL) and a corner `badge` (generic text). A PDF gets a
 * server-cached first-page thumbnail + a page-count badge; images render their
 * own file as the thumbnail; video captures a frame client-side; sound/font/
 * other fall back to a kind icon. New kinds slot in by extending ONE switch here.
 *
 * DOM-free, pure — importable in bare node, unit-tested. The impure rasterize+
 * store orchestration for a not-yet-cached PDF thumbnail lives in
 * app.svelte.js (ensureAssetThumbnail), gated by `needsClientThumbnail` below.
 */

/**
 * Asset kinds that SHOULD have a rendered preview bitmap but cannot show their
 * raw file directly (unlike an image) — so when the server has no cached
 * thumbnail yet, the client rasterizes one. Today: PDF. (Video is excluded: it
 * captures a frame through its own VideoThumbnail component, not this path.)
 */
export const CLIENT_THUMBNAIL_KINDS = new Set(["pdf"]);

/** Per-kind fallback glyph (iconify id) for a tile with no preview bitmap. */
export const KIND_ICON = {
  video: "mdi:play-circle-outline",
  sound: "mdi:music-note",
  image: "mdi:image-outline",
  pdf: "mdi:file-pdf-box",
  font: "mdi:format-font",
  other: "mdi:file-outline",
};

/** Optional leading glyph shown INSIDE a badge, per kind (page icon for a PDF's
 *  page count). null = a plain text badge. */
export const BADGE_ICON = { pdf: "mdi:file-document-outline" };

/**
 * Pure function. The corner-badge text for a PDF page count (manifest #25:
 * "a page-count badge"). Singular/absent handled so the badge never lies.
 *
 * @param {number} n - page count
 * @returns {string|null} badge text, or null when unknown/degenerate
 *
 * @example pageCountBadge(5) // "5"
 * @example pageCountBadge(1) // "1"
 * @example pageCountBadge(0) // null
 * @example pageCountBadge(undefined) // null
 */
export function pageCountBadge(n) {
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

/**
 * Pure function. The tile presentation descriptor for an asset. The ONE place
 * that maps an asset (its kind + any cached {thumbnail, badge}) to how a tile
 * draws it. Extend the switch to add a new kind.
 *
 * Returns:
 *   {
 *     mode: "image" | "video" | "thumbnail" | "icon",
 *     src: string|null,        // the bitmap URL for "image"/"video"/"thumbnail"
 *     icon: string|null,       // the kind glyph for "icon"
 *     badge: string|null,      // generic corner text (page count, …)
 *     badgeIcon: string|null,  // optional leading glyph inside the badge
 *     needsClientThumbnail: boolean, // a preview SHOULD exist but none is cached → rasterize
 *   }
 *
 * @param {{kind:string, url:string, thumbnail?:string, badge?:string}} asset
 *
 * @example
 * // An image renders its own file:
 * // assetTilePresentation({kind:"image", url:"/asset/P/a.png"})
 * // => {mode:"image", src:"/asset/P/a.png", icon:null, badge:null, badgeIcon:null, needsClientThumbnail:false}
 * @example
 * // A PDF WITH a cached thumbnail + page-count badge:
 * // assetTilePresentation({kind:"pdf", url:"/asset/P/d.pdf", thumbnail:"/asset/P/.thumbs/d.pdf/9.png", badge:"5"})
 * // => {mode:"thumbnail", src:"/asset/P/.thumbs/d.pdf/9.png", icon:null, badge:"5", badgeIcon:"mdi:file-document-outline", needsClientThumbnail:false}
 * @example
 * // A PDF with NO cached thumbnail yet → icon now, client rasterizes:
 * // assetTilePresentation({kind:"pdf", url:"/asset/P/d.pdf"}).needsClientThumbnail // true
 * @example
 * // A font: kind icon, no preview:
 * // assetTilePresentation({kind:"font", url:"/asset/P/f.ttf"}).mode // "icon"
 */
export function assetTilePresentation(asset) {
  const kind = asset?.kind ?? "other";
  const badge = typeof asset?.badge === "string" && asset.badge ? asset.badge : null;
  const base = { mode: "icon", src: null, icon: KIND_ICON[kind] ?? KIND_ICON.other, badge, badgeIcon: null, needsClientThumbnail: false };

  if (kind === "image") return { ...base, mode: "image", src: asset.url };
  if (kind === "video") return { ...base, mode: "video", src: asset.url };
  if (asset?.thumbnail) {
    // Any kind with a cached preview bitmap (a server-rasterized PDF page 1).
    return { ...base, mode: "thumbnail", src: asset.thumbnail, badgeIcon: BADGE_ICON[kind] ?? null };
  }
  if (CLIENT_THUMBNAIL_KINDS.has(kind)) {
    // A preview SHOULD exist (PDF) but none is cached — show the icon now and
    // signal the caller to rasterize + store one.
    return { ...base, badgeIcon: BADGE_ICON[kind] ?? null, needsClientThumbnail: true };
  }
  return base; // sound / font / other → kind icon (+ any badge)
}
