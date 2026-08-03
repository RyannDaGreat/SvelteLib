/**
 * fontBytes.js — ONE FETCH PER FONT FILE, PER PAGE.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Two different subsystems need the SAME ~12.5 MB of committed TTFs at the same
 * moment during boot, for two different reasons:
 *
 *   · web/fontLoader.js builds browser `FontFace`s so canvas2D (the glyph atlas)
 *     rasterizes the real face instead of silently substituting.
 *   · render_gpu/skia/browser_canvaskit.js hands the raw buffers to Skia's
 *     `TypefaceFontProvider.registerFont` for the FontCollection.
 *
 * Neither can use the other's product — a FontFace does not expose its bytes,
 * and a Skia typeface is not a CSS face — so both need the FILE. Without a shared
 * cache both fetch it, and the second fetch is pure waste.
 *
 * ── THE BUG THIS WAS EXTRACTED TO FIX, AND ITS LESSON ────────────────────────
 * This deduplication USED TO BE FREE BY ACCIDENT: the two loaders happened to run
 * strictly one after the other (the wasm prefetch, and therefore the Skia font
 * build behind it, was kicked from the editor's mount, which waited on the CSS
 * font load), so the second pass hit the HTTP cache for every file. When the wasm
 * prefetch moved to module load so it would stop being blocked by 3.4 MB of
 * fonts, the two passes began to OVERLAP, nothing was warm, and a Fast-3G cold
 * boot's wire total went 12.7 MB → 51.9 MB — 26 TTFs downloaded twice.
 *
 * THE LESSON, which is why this is a module with a docblock and not two lines
 * inside fontLoader: ORDERING IS NOT A CACHE STRATEGY. A dedup that works only
 * because two things happen in a particular sequence is invisible in the source,
 * survives no scheduling change, and fails silently and expensively when it goes.
 *
 * ── WHY ITS OWN FILE, rather than an export from fontLoader.js ───────────────
 * A CYCLE, and it was not theoretical — it shipped for one build and threw
 * `fontBytes is not a function` at runtime. `browser_canvaskit.js` already
 * imports `render_gpu/fonts.js`, and `fontLoader.js` imports it too; adding
 * `browser_canvaskit → fontLoader` closed a loop in which `fontBytes` was still
 * uninitialized at the moment the font build called it. This module imports
 * NOTHING, so it cannot participate in a cycle no matter who imports it. (This is
 * also the failure class CLAUDE.md warns is invisible to the build: a green
 * `vite build` bound the name to undefined and shipped it.)
 */

/** The one in-flight-or-settled fetch per font FILE, keyed by basename — which is
 *  unique across ../fonts/ and is the key both callers already have in hand. */
const cache = new Map();

/**
 * Query→fetch (memoized per file). The bytes of one font file, fetched AT MOST
 * ONCE per page however many callers ask and in whatever order they ask.
 *
 * Returns a PRIVATE COPY each call. Both consumers can take ownership of a buffer
 * they are handed — `FontFace(family, buffer)` and Skia's `registerFont` may each
 * detach it — so handing the same ArrayBuffer to two consumers is how one of them
 * silently ends up with an empty face and renders tofu with no error anywhere.
 *
 * Failure is LOUD and is NOT cached as a success: a non-OK response throws, so a
 * fonts.js/glob mismatch surfaces as an error naming the URL rather than as
 * unexplained tofu much later.
 *
 * @param {string} file Font basename, e.g. "Inter-Regular.ttf"
 * @param {string} url The hashed asset URL vite resolved for that basename
 * @returns {Promise<ArrayBuffer>} a private copy of the file's bytes
 *
 * @example // await fontBytes("Inter-Regular.ttf", "/assets/Inter-Regular-DeGX228b.ttf")
 * @example // two overlapping callers, same file ⇒ ONE network request, two copies
 */
export async function fontBytes(file, url) {
  if (!cache.has(file)) {
    cache.set(file, (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fontBytes: ${url} → HTTP ${res.status} ${res.statusText}`);
      return await res.arrayBuffer();
    })());
  }
  return (await cache.get(file)).slice(0);
}
