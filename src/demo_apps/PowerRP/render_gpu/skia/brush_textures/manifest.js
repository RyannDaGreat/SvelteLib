/**
 * THE TEXTURE-BRUSH PALETTE MANIFEST — the 23 real brush-stroke textures the
 * texture brush (render_gpu/skia/texture_brush.js) sweeps along a stroke as a
 * ribbon. Each entry names a WebP file that sits beside this manifest, its
 * display name, a media CATEGORY (so real-world presets can pick "a watercolour"
 * without pinning an exact id), and the ATTRIBUTION URL it was downloaded from.
 *
 * ── PROVENANCE ────────────────────────────────────────────────────────────────
 * These are the top 23 chosen (by eye, for variety across media and colour) from
 * the demo's `TEXTURE_URLS` — OnlyGFX's free watercolour-banner and oil
 * paint-stroke packs, the exact palette rp's
 * `misc/skia_trail_interactive_paint_demo.py` uses. Each source PNG (200 KB–2 MB)
 * was alpha-bbox-cropped, downscaled to 512 px wide, and re-encoded as WebP q82 —
 * ~15–30 KB each, ~0.45 MB total, so the repo stays GitHub-friendly (house rule).
 * Alpha is preserved (the ribbon reads the texture's own soft edges).
 *
 * ── HOW THE URL RESOLVES (portable, bare-node-safe) ───────────────────────────
 * `textureUrl(id)` builds the served URL with `new URL(file, import.meta.url)`.
 * That is the ONE construct that works in BOTH worlds this module loads in:
 *   - Vite (the editor + the ?cli render page): resolves to a served asset URL
 *     that `fetch` + `createImageBitmap` decode (render_gpu/gpu/image_registry.js).
 *   - bare node (the doctest gate imports this file): resolves to a `file://` URL
 *     with NO filesystem access — the module just loads; nothing fetches it there.
 * NO static `import x from "./x.webp"` and NO `import.meta.glob`: both would throw
 * at import time in bare node and break the doctest gate.
 *
 * DOM-free at import (pure JS + string data); no CanvasKit, no fetch here.
 */

/** src → served URL. `import.meta.url` is this file's URL in every loader; joining
 * a relative filename onto it is Vite's documented asset-reference idiom and is a
 * plain `file://` join in node. */
const HERE = import.meta.url;

/**
 * The 23 curated textures. `src` is the original OnlyGFX URL (attribution +
 * re-download seed); `file` is the committed WebP beside this manifest.
 */
export const BRUSH_TEXTURES = [
  { id: "wc_amber_wash",      name: "Amber Wash",        category: "watercolor", file: "wc_amber_wash.webp",      src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-1.png" },
  { id: "wc_blue_wash",       name: "Blue Wash",         category: "watercolor", file: "wc_blue_wash.webp",       src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-12.png" },
  { id: "wc_soft_teal",       name: "Soft Teal Wash",    category: "watercolor", file: "wc_soft_teal.webp",       src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-18.png" },
  { id: "wc_coral_wash",      name: "Coral Wash",        category: "watercolor", file: "wc_coral_wash.webp",      src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-19.png" },
  { id: "wc_gold_wash",       name: "Gold Wash",         category: "watercolor", file: "wc_gold_wash.webp",       src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-8.png" },
  { id: "wc_rose_wash",       name: "Rose Wash",         category: "watercolor", file: "wc_rose_wash.webp",       src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-9.png" },
  { id: "wc_indigo_pool",     name: "Indigo Pool",       category: "watercolor", file: "wc_indigo_pool.webp",     src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-23.png" },
  { id: "wc_sunset_wash",     name: "Sunset Wash",       category: "watercolor", file: "wc_sunset_wash.webp",     src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-16.png" },
  { id: "wc_granular_umber",  name: "Granular Umber",    category: "grunge",     file: "wc_granular_umber.webp",  src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-20.png" },
  { id: "wc_umber_scrub",     name: "Umber Scrub",       category: "grunge",     file: "wc_umber_scrub.webp",     src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-13.png" },
  { id: "wc_dry_streak",      name: "Dry Watercolor",    category: "dry-brush",  file: "wc_dry_streak.webp",      src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-22.png" },
  { id: "wc_green_rake",      name: "Green Rake",        category: "dry-brush",  file: "wc_green_rake.webp",      src: "https://www.onlygfx.com/wp-content/uploads/2017/05/colorful-watercolor-brush-stroke-banner-2-24.png" },
  { id: "oil_blue_bristle",   name: "Blue Oil Bristle",  category: "oil",        file: "oil_blue_bristle.webp",   src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-3.png" },
  { id: "oil_forest_drag",    name: "Forest Drag",       category: "dry-brush",  file: "oil_forest_drag.webp",    src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-6.png" },
  { id: "oil_chartreuse",     name: "Chartreuse Gouache",category: "gouache",    file: "oil_chartreuse.webp",     src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-7.png" },
  { id: "oil_teal_slick",     name: "Teal Slick",        category: "oil",        file: "oil_teal_slick.webp",     src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-29.png" },
  { id: "oil_cobalt_sweep",   name: "Cobalt Sweep",      category: "oil",        file: "oil_cobalt_sweep.webp",   src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-44.png" },
  { id: "oil_crimson_bristle",name: "Crimson Ink",       category: "ink",        file: "oil_crimson_bristle.webp",src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-12.png" },
  { id: "oil_cobalt_flat",    name: "Cobalt Marker",     category: "marker",     file: "oil_cobalt_flat.webp",    src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-40.png" },
  { id: "oil_peach_smear",    name: "Peach Gouache",     category: "gouache",    file: "oil_peach_smear.webp",    src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-41.png" },
  { id: "oil_ember_smear",    name: "Ember Smear",       category: "gouache",    file: "oil_ember_smear.webp",    src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-39.png" },
  { id: "oil_olive_rake",     name: "Olive Rake",        category: "dry-brush",  file: "oil_olive_rake.webp",     src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-8.png" },
  { id: "oil_scarlet_hook",   name: "Scarlet Ink",       category: "ink",        file: "oil_scarlet_hook.webp",   src: "https://www.onlygfx.com/wp-content/uploads/2017/07/paint-brush-stroke-10-16.png" },
];

/**
 * Query. The served URL for texture `id`'s WebP file, or throws on an unknown id
 * (a typo must not silently resolve to a missing asset). Browser: a Vite asset
 * URL; node: a `file://` URL (never fetched there).
 *
 * @param {string} id - a BRUSH_TEXTURES id
 * @returns {string} an absolute URL string
 *
 * @example textureUrl("wc_amber_wash").endsWith("wc_amber_wash.webp") // true
 */
export function textureUrl(id) {
  const tex = getTexture(id);
  return new URL(tex.file, HERE).href;
}

/**
 * Query. Every texture id in palette order — the texture SELECT knob's options
 * and the palette grid's order.
 *
 * @example textureIds().length // 23
 * @example textureIds().includes("oil_blue_bristle") // true
 */
export function textureIds() {
  return BRUSH_TEXTURES.map((t) => t.id);
}

/**
 * Query. The texture record for `id`. Throws LOUDLY on an unknown id (no silent
 * fallback — CLAUDE.md).
 *
 * @param {string} id
 * @returns {{id:string,name:string,category:string,file:string,src:string}}
 *
 * @example getTexture("wc_blue_wash").name // "Blue Wash"
 * @example getTexture("wc_blue_wash").category // "watercolor"
 */
export function getTexture(id) {
  const tex = BRUSH_TEXTURES.find((t) => t.id === id);
  if (!tex) throw new Error(`brush_textures: unknown texture "${id}" (known: ${textureIds().join(", ")})`);
  return tex;
}

/**
 * Query. The FIRST texture id in `category`, or null when none exists — how a
 * real-world preset names "a watercolour" without pinning one exact texture, so a
 * preset survives the palette being recurated. Category order follows palette
 * order, so "first" is stable.
 *
 * @param {string} category - one of the manifest's category strings
 * @returns {string|null}
 *
 * @example firstTextureOf("ink") // "oil_crimson_bristle"
 * @example firstTextureOf("nope") // null
 */
export function firstTextureOf(category) {
  const tex = BRUSH_TEXTURES.find((t) => t.category === category);
  return tex ? tex.id : null;
}
