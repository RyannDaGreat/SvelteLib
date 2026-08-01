/**
 * THE MAP TILE REGISTRY — URL-addressed tile pixels, cached by URL, with an LRU
 * bound. The map widget's counterpart of gpu/image_registry.js (still images) and
 * gpu/svg_source_registry.js (fetched SVG text), and it is deliberately a THIN
 * layer over the image registry rather than a second decode pipeline.
 *
 * ── WHY IT DELEGATES INSTEAD OF FETCHING ─────────────────────────────────────
 * A tile IS an image at a URL. image_registry already does the fetch → Blob →
 * createImageBitmap decode, the once-only loud error, the CanvasKit Image
 * conversion (getSkiaImage), the repaint wake-up (onImageLoad) and — crucially —
 * `pendingImageRefs()`, which is what stops the headless render-job worker from
 * writing a PNG while pixels are still in flight. Fetching tiles separately would
 * mean reimplementing all five, and the fifth silently: a tile-shaped hole in an
 * exported frame with the job exiting 0 is exactly the failure the image
 * registry's pendingImageRefs exists to prevent. So a tile's URL goes straight
 * into that registry and this module adds only what a tile needs on top:
 *
 *   1. THE LRU BOUND (see below) — the one thing tiles need and photos do not.
 *   2. A per-tile RETRY-FREE failure record, so a 404 at the edge of a provider's
 *      coverage draws the missing affordance instead of being re-requested every
 *      frame (which would be both useless and rude to the provider).
 *
 * ── THE KEY SPACE IS UNBOUNDED, WHICH IS THE WHOLE PROBLEM ───────────────────
 * image_registry's header states its own precondition exactly: "cached forever is
 * only safe for a BOUNDED key space", bounded there by "the document's distinct
 * images". A TILE PYRAMID IS NOT BOUNDED BY THE DOCUMENT. Panning a world map at
 * z12 walks through millions of distinct URLs, and each resident tile costs its
 * pixels TWICE — an ImageBitmap plus a copy inside the CanvasKit wasm heap, whose
 * hard ceiling is 2 GiB. That is not a hypothetical: it is the measured PDF pan
 * crash recorded in image_registry (1674 MB of heap growth over 1000 pan steps,
 * dying at exactly 2048.0 MB inside getSkiaImage). A map pans further than a PDF.
 *
 * So this module OWNS THE LIFETIME of every ref it mints and calls
 * `releaseImage()` on eviction — the "explicit invalidation call" that header
 * reserves for precisely this case, and the same discipline pdf_page_raster's
 * trimPdfRegionCache follows. The budget is BYTES, not a count, for the reason
 * stated there: a count cap is meaningless when entry size varies, and bytes are
 * the physical quantity that runs out.
 *
 * ── WHAT MAKES A RENDER REPRODUCIBLE ─────────────────────────────────────────
 * Tiles are content-addressed by URL and a tile server returns the same pixels for
 * the same URL, so once a document's tiles are RESIDENT, two renders at one
 * document state are byte-identical. Before they are resident a frame draws the
 * loading affordance — never a stretched neighbour standing in for the real tile,
 * which would be a decoder lie of exactly the kind missing_media.js exists to
 * refuse. `pendingTileRefs()` is how a one-shot consumer (the render-job worker)
 * waits for residency instead of shipping a holed frame.
 *
 * Browser/CLI-facing (needs fetch + createImageBitmap), NOT part of DOM-free core/.
 */

import {
  BYTES_PER_PIXEL, ensureImage, getImage, imageStatus, onImageLoad, releaseImage,
} from "./image_registry.js";
import { truncate } from "../../core/report.js"; // THE shared log elision (was re-exported by image_registry until core/report.js took the nine copies)
import { tileUrl } from "../../web/tile_providers.js";

/**
 * THE RESIDENT-TILE BUDGET, in bytes of decoded pixels.
 *
 * 64 MiB is ONE QUARTER of the 256 MiB pdf_page_raster budgets for its region
 * cache, and the smaller share is deliberate rather than timid: a PDF region is
 * one big raster per frame, while tiles are many small ones that are RE-USED
 * across frames (pan back and the tile is still there), so the working set that
 * actually matters is the visible screen plus a little history. A 4K screen fully
 * covered at the correct zoom is ~130 tiles ≈ 34 MB at 256²·4 B, so this budget
 * holds a full screen plus roughly a screen of pan history, and it leaves the
 * wasm heap's remaining headroom to the glyph atlas, other media and Skia's own
 * per-frame surfaces. A map is one widget on a slide, not the whole slide.
 */
export const TILE_CACHE_BYTES = 64 * 1024 * 1024;

/** One decoded 256² RGBA tile, in bytes — the unit the budget counts in.
 *  @example TILE_BYTES // 262144 */
export const TILE_BYTES = 256 * 256 * BYTES_PER_PIXEL;

/**
 * url → {bytes}. INSERTION ORDER IS THE LRU ORDER: every hit re-inserts (delete
 * then set), so the front of the map is genuinely the least recently used. The
 * same structure and the same reasoning as pdf_page_raster's `regions`.
 */
const resident = new Map();

/** urls that failed (404 outside coverage, network error). Kept so a dead tile is
 *  requested ONCE — a per-frame retry of a tile the provider does not have is
 *  wasted bandwidth against a donated server and would never succeed. */
const failed = new Set();

/**
 * Pure function. THE TILE REF — the URL a tile's pixels live at. A tile is
 * content-addressed by its URL and nothing else, so this is just `tileUrl`, named
 * here so every consumer of the registry speaks one vocabulary ("ref") with the
 * image registry it delegates to.
 *
 * @param {object} provider - a web/tile_providers.js descriptor
 * @param {{x: number, y: number, z: number}} tile - tile coordinates
 * @returns {string} the absolute tile URL
 *
 * @example // tileRef(TILE_PROVIDERS.osm, {x: 0, y: 0, z: 0}) // "https://a.tile.openstreetmap.org/0/0/0.png"
 */
export function tileRef(provider, tile) {
  return tileUrl(provider, tile.x, tile.y, tile.z);
}

/**
 * Command (near-pure: idempotent). Ensures a tile is being fetched/decoded, and
 * marks it most-recently-used. Safe to call every frame for every visible tile —
 * that is exactly how the pre-pass uses it.
 *
 * A tile already known to have FAILED is not re-requested (see `failed`).
 *
 * @param {string} ref - a tile URL
 * @returns {void}
 */
export function ensureTile(ref) {
  if (failed.has(ref)) return;
  if (resident.has(ref)) {
    // Touch: re-insert at the back so eviction takes genuinely-cold tiles.
    const entry = resident.get(ref);
    resident.delete(ref);
    resident.set(ref, entry);
    return;
  }
  resident.set(ref, { bytes: 0 });
  ensureImage(ref);
}

/**
 * Query. The decoded tile for `ref` if it is ready, else null — the SYNC question
 * a paint path asks. Null means "draw the loading/missing affordance this frame",
 * never "draw something else that looks like a map".
 *
 * @param {string} ref - a tile URL
 * @returns {ImageBitmap|null}
 */
export function getTile(ref) {
  return getImage(ref);
}

/**
 * Query. A tile's state: "unloaded" | "loading" | "ready" | "error". Read from
 * the image registry (the one source of truth for the decode) rather than
 * mirrored here, so the two can never disagree about whether a tile has landed.
 *
 * @param {string} ref - a tile URL
 * @returns {string}
 */
export function tileStatus(ref) {
  return failed.has(ref) ? "error" : imageStatus(ref);
}

/**
 * Query. Every tile still in flight — the refs a render asked for and did not get.
 * EMPTY MEANS THE MAP IS FULLY PAINTABLE, which is what a one-shot consumer needs
 * before it writes a file. The render-job worker already loops on the image
 * registry's `pendingImageRefs()`, and because tiles ARE image refs they appear
 * there automatically; this narrower query exists so a caller can say which of the
 * pending refs are map tiles when it reports a stall.
 *
 * @returns {string[]}
 */
export function pendingTileRefs() {
  const out = [];
  for (const ref of resident.keys()) if (imageStatus(ref) === "loading") out.push(ref);
  return out;
}

/**
 * Command. Records that a tile's decode finished, charging its real size to the
 * budget, and evicts the coldest tiles until the budget holds again.
 *
 * `keep` NAMES THE TILES THE CURRENT FRAME NEEDS and they are never evicted, even
 * if the visible set alone exceeds the budget. That is the cache-vs-correctness
 * rule pdf_page_raster states: a budget bounds HISTORY, and evicting a tile the
 * frame being painted requires would produce a hole and then immediately re-fetch
 * it — a thrash that makes the picture worse and the network load higher. An
 * overrun is reported once so a pathological map is visible rather than silent.
 *
 * @param {Iterable<string>} keep - refs the current frame requires
 * @returns {number} bytes freed
 */
export function trimTileCache(keep) {
  const protectedRefs = new Set(keep);
  // Charge every resident tile its true decoded size now that bitmaps have landed.
  let total = 0;
  for (const [ref, entry] of resident) {
    if (entry.bytes === 0) {
      const bitmap = getImage(ref);
      if (bitmap) entry.bytes = bitmap.width * bitmap.height * BYTES_PER_PIXEL;
    }
    total += entry.bytes;
  }
  let freed = 0;
  for (const [ref, entry] of resident) {
    if (total <= TILE_CACHE_BYTES) break;
    if (protectedRefs.has(ref)) continue;
    freed += releaseImage(ref); // frees BOTH copies: the ImageBitmap and the wasm-heap CanvasKit Image
    total -= entry.bytes;
    resident.delete(ref);
  }
  return freed;
}

/**
 * Command. Marks a tile as permanently unavailable so it is never re-requested.
 * Called by the pre-pass when the image registry reports an error for a tile ref.
 * Reported ONCE per ref: a provider legitimately has no tile in some places (past
 * a coverage edge, over open ocean in some layers), so this is a normal condition
 * that must still be VISIBLE rather than swallowed.
 *
 * @param {string} ref - a tile URL
 */
export function markTileFailed(ref) {
  if (failed.has(ref)) return;
  failed.add(ref);
  releaseImage(ref);
  resident.delete(ref);
  console.warn(`PowerRP tile_registry: no tile at "${truncate(ref)}" — the provider returned an error for it. It will NOT be requested again; the map draws its missing-tile state there. This is normal past a provider's coverage or zoom limit.`);
}

/** Command. Subscribes to tile decode completion — the repaint wake-up. It IS
 *  image_registry's onImageLoad (a tile is an image ref), re-exported so a map
 *  consumer does not have to know that. Returns an unsubscribe function. */
export const onTileLoad = onImageLoad;

/**
 * Command. Drops every resident tile, freeing both pixel copies, and forgets the
 * failure set. For tests that need a clean registry, and the invalidation hook if
 * a provider's tiles are ever versioned.
 *
 * @returns {number} bytes freed
 */
export function resetTileRegistry() {
  let freed = 0;
  for (const ref of resident.keys()) freed += releaseImage(ref);
  resident.clear();
  failed.clear();
  return freed;
}

/** Query. How many tiles are resident and what they cost — for the probe that
 *  asserts crop economy, and for a future status readout.
 *  @example // tileCacheStats() // {count: 12, bytes: 3145728} */
export function tileCacheStats() {
  let bytes = 0;
  for (const entry of resident.values()) bytes += entry.bytes;
  return { count: resident.size, bytes };
}
