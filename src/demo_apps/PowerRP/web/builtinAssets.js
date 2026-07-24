/**
 * The BUILT-IN ASSET REGISTRY — the single catalog of SHIP-WITH-THE-APP assets
 * (cursors today; extensible for future built-ins). This is DELIBERATELY a
 * SEPARATE surface from a user's PROJECT assets: project assets are server-
 * backed, per-project, and listed by web/AssetExplorer.svelte; built-ins are
 * bundled with the app, the same for every project, and must NEVER appear in
 * that project asset list (task #68: cursors were pulled OUT of the Asset
 * Explorer for exactly this reason). Widgets read built-ins DIRECTLY (the
 * cursor widget reads render_gpu/gpu/svg_raster.js today); this module adds the
 * general, categorized catalog + a programmatic lookup, so a browsable "Built-in
 * Assets" surface (web/BuiltinAssetBrowser.svelte) and any future widget can
 * enumerate built-ins WITHOUT re-implementing the per-category glue.
 *
 * ── SHAPE ─────────────────────────────────────────────────────────────────────
 * A category is `{id, label, icon, description, load}`; `load()` returns that
 * category's asset entries. An asset entry matches the ASSET-LIST shape the tile
 * grid consumes (web/AssetThumb.svelte / assetThumbnail.js):
 *   {name, kind, url, src?, size?, builtin: true}
 * so a built-in tile renders through the SAME generalized media path as a
 * project asset (an image kind renders its `url` — for cursors a self-contained
 * SVG data URI — no server route needed, offline/CLI-friendly).
 *
 * ── ADDING A CATEGORY ─────────────────────────────────────────────────────────
 * Add ONE row to CATEGORY_DEFS with a `load` Query returning asset entries. No
 * other file needs to know the concrete category (the browser renders whatever
 * builtinCategories() returns) — the plugin-roster registration pattern.
 *
 * ── LAZINESS (boot cleanliness) ───────────────────────────────────────────────
 * The cursor loader behind `load` uses Vite's `import.meta.glob` (browser/CLI
 * only, resolved lazily inside svg_raster.js). This module never triggers it at
 * import time: builtinCategories() loads (and memoizes) on FIRST call — i.e.
 * when the browser UI first mounts — so app boot pays nothing.
 */

import { builtinCursorAssets } from "../render_gpu/gpu/svg_raster.js";

/**
 * The declarative built-in-asset category table. Cursors is the first (and
 * today only) population; each future built-in kind is one more row. `load` is a
 * Query returning the category's asset entries (the ASSET-LIST shape above).
 */
const CATEGORY_DEFS = [
  {
    id: "cursors",
    label: "Cursors",
    icon: "mdi:cursor-default-outline",
    description:
      "macOS-style pointer cursors, drawn as crisp vector. The Cursor widget draws these; the beach ball is the classic busy spinner.",
    load: builtinCursorAssets,
  },
];

/** Memoized catalog (built once on first builtinCategories() call). */
let categoryCache = null;

/**
 * Query (browser/CLI — the underlying cursor glob is a Vite macro). The built-in
 * asset catalog: every category with its `assets` loaded and MEMOIZED. Safe to
 * call repeatedly (the reactive browser re-reads it) — the glob runs once.
 *
 * Returns:
 *   {id, label, icon, description, assets}[] — assets are ASSET-LIST entries
 *   ({name, kind, url, src?, size?, builtin:true}).
 *
 * @example
 * // builtinCategories()[0].id            // "cursors"
 * // builtinCategories()[0].assets[0].builtin  // true
 * // builtinCategories()[0].assets.length      // 39  (the bundled cursor set)
 */
export function builtinCategories() {
  if (categoryCache) return categoryCache;
  categoryCache = CATEGORY_DEFS.map((c) => ({
    id: c.id,
    label: c.label,
    icon: c.icon,
    description: c.description,
    assets: c.load(),
  }));
  return categoryCache;
}

/**
 * Pure function. The built-in IDENTIFIER for an asset file name — the bare name
 * a widget references (a cursor's `cursorKind`, e.g.), i.e. the file name with
 * its final extension stripped. A name without an extension is returned as-is.
 *
 * @param {string} name - the asset file name (e.g. "beachball.svg")
 * @returns {string} the identifier (e.g. "beachball")
 *
 * @example builtinAssetId("beachball.svg")  // "beachball"
 * @example builtinAssetId("resizenorthsouth.svg") // "resizenorthsouth"
 * @example builtinAssetId("busy")           // "busy"  (no extension → unchanged)
 */
export function builtinAssetId(name) {
  return String(name).replace(/\.[^.]+$/, "");
}

/**
 * Query (browser/CLI). One built-in asset entry by category id + identifier —
 * the programmatic twin of the browser, for a widget to read a built-in DIRECTLY
 * (e.g. its `.src` SVG string). Throws LOUDLY on an unknown category or id (a
 * typo must not silently resolve to nothing — the svg_raster.cursorSource
 * discipline).
 *
 * @param {string} categoryId - a category id (e.g. "cursors")
 * @param {string} id - a built-in identifier (e.g. "beachball")
 * @returns {{name:string, kind:string, url:string, src?:string, builtin:true}}
 *
 * @example
 * // builtinAsset("cursors", "beachball").kind   // "image"
 * // builtinAsset("cursors", "nope")             // throws: unknown cursors built-in "nope"
 */
export function builtinAsset(categoryId, id) {
  const cats = builtinCategories();
  const cat = cats.find((c) => c.id === categoryId);
  if (!cat)
    throw new Error(`builtinAsset: unknown category "${categoryId}" (known: ${cats.map((c) => c.id).join(", ")})`);
  const asset = cat.assets.find((a) => builtinAssetId(a.name) === id);
  if (!asset)
    throw new Error(`builtinAsset: unknown ${categoryId} built-in "${id}" (known: ${cat.assets.map((a) => builtinAssetId(a.name)).join(", ")})`);
  return asset;
}
