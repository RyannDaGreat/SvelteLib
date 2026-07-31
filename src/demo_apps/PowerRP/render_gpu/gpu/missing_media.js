/**
 * missing_media.js — ONE refusal, shared by the image and video registries.
 *
 * THE BUG THIS EXISTS FOR. In static mode a document can reference an asset that
 * is genuinely absent (a deck opened from a zip whose assets/ never carried the
 * file, a ref to another project's asset). The resolution seam answers such a ref
 * with the LOUD MISSING SENTINEL (core/asset_ref.js MISSING_ASSET_URL) rather
 * than a URL — that part is correct and deliberate.
 *
 * What was wrong is what the media registries then did with it. The sentinel is a
 * `data:` URI, and a data: URI is a REAL, FETCHABLE resource: `fetch()` resolves
 * it 200 with 21 bytes of `text/plain`. So handing it onward does not produce a
 * clean "missing asset" failure — it produces a decode failure one layer later:
 *
 *   - `<video>.src = sentinel`  → "MediaError code 4: Format error"
 *   - `createImageBitmap(blob)` → an image-decode error on 21 bytes of text
 *
 * Both sentences describe a CORRUPT FILE. The file is not corrupt; it is absent.
 * A user chasing "Format error" goes looking for a bad encode, which is the wrong
 * investigation entirely, and the console says nothing about WHICH ref it was
 * (the sentinel is the same 21 bytes for every missing asset in the deck).
 *
 * THE FIX, and why it is a refusal rather than a repair: a registry cannot
 * conjure the bytes, so the only honest outcome is to report the real cause and
 * latch. `registerMissing` writes the entry in the terminal "error" state WITHOUT
 * an element or a bitmap, so:
 *
 *   - the report happens ONCE per ref — `ensureImage`/`ensureVideo` both return
 *     early on an existing entry, and this entry exists from the first call, so a
 *     per-frame render loop cannot re-log it;
 *   - `getImage`/`getVideo` answer null, which is ALREADY the paint path's
 *     "no frame this time" contract, so the normal missing-media affordance draws
 *     instead of a half-initialized element sitting in an error loop;
 *   - `pendingImageRefs`/`pendingVideoRefs` exclude it (they select "loading"),
 *     so an exporter waiting on decodes is not blocked forever by a ref that can
 *     never resolve.
 *
 * WHY THE MESSAGE DOES NOT NAME THE DOCUMENT REF, though it would be the most
 * useful thing it could say: a registry is handed the RESOLVED src and nothing
 * else, and every missing asset in a deck resolves to the SAME 21 bytes — the
 * identity is destroyed one layer up, at the resolver. So this message points at
 * the layer that still has it (`localAssetStore.resolveUrl` already logs the ref
 * by name, on the same load), rather than inventing a ref it cannot know. Fixing
 * that properly means threading the ref through resolution, which is a larger
 * change than this refusal and is deliberately not bundled into it.
 */

/**
 * Command (mutates `registry`, writes one console.error). Register `src` as
 * permanently missing and report it ONCE, naming the ref.
 *
 * Shaped to satisfy BOTH registries' entry contracts at once — `el` for the
 * video registry, `bitmap`/`promise` for the image registry — because the two
 * readers only ever test `status`, and a single shape keeps this refusal from
 * needing a per-registry variant that could drift.
 *
 * @param {Map} registry - the module's src → entry map
 * @param {string} src - the resolved src (the missing sentinel)
 * @param {string} who - the calling function, for the message ("ensureVideo")
 * @returns {null} always — the caller's "nothing to hand back" answer
 *
 * @example
 * >>> const reg = new Map();
 * >>> registerMissing(reg, "data:,powerrp-missing-asset", "ensureVideo")  // logs once
 * null
 * >>> reg.get("data:,powerrp-missing-asset").status
 * 'error'
 */
export function registerMissing(registry, src, who) {
  const error = new Error("the resolver returned the MISSING-ASSET SENTINEL, so this src names no stored file (never imported, or it belongs to a different project)");
  registry.set(src, { status: "error", el: null, bitmap: null, error, presentedFrames: 0, promise: Promise.resolve(null) });
  console.error(`PowerRP ${who}: refusing to load the missing-asset sentinel — ${error.message}. Nothing was loaded and this is reported ONCE; the widget draws its missing-media state. The failing REF is named by the resolveUrl error logged on this same load (the sentinel is identical for every missing asset, so it cannot be identified from here).`);
  return null;
}
