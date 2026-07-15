/**
 * The shared image-source registry — decoded ImageBitmaps keyed by their
 * source string (a URL or a `data:` URI, exactly what the image widget stores
 * in `state.src`). This is how a still image reaches the GPU compositor's
 * media map WITHOUT the web layer having to thread a media object through
 * every GpuCompositor.create() call site (the editor viewport, the presenter,
 * the pixel service, the CLI all create the compositor with an empty media
 * map): the compositor consults THIS registry as a fallback (see
 * gpu/compositor.js `_imageBindGroup`), and the plugin never has to reach into
 * any compositor.
 *
 * ── THE ASYNC CONTRACT (manifest F3 + the round-12 async rule) ────────────────
 * Bitmap decode is ASYNC; the render path is SYNC-shaped (emit → sceneIR →
 * one command submit). So:
 *   - `ensureImage(src)` kicks an idempotent decode. Fire-and-forget; safe to
 *     call every frame (a src already loading/loaded is a no-op).
 *   - `getImage(src)` is the SYNC query the compositor uses: the decoded
 *     ImageBitmap when ready, else null. A null means "not decoded yet" — the
 *     compositor draws NOTHING for that image this frame (no silent placeholder
 *     graphic; the manifest rule), exactly like the video pipeline skips a
 *     not-yet-decoded frame.
 *   - `onImageLoad(cb)` lets a repaint-driver re-render when a decode resolves
 *     (the editor's paint loop is reactive, not a continuous rAF loop, so a
 *     late-arriving bitmap needs an explicit nudge). Returns an unsubscribe fn.
 *
 * Loud failure discipline (manifest rule): a decode that FAILS is reported once
 * via console.error and the src is left in an "error" state (never retried
 * silently, never a silent success). A missing/undecoded src is NOT a failure —
 * it is the normal in-flight state and stays quiet.
 *
 * Bitmaps are cached forever by design: image sources are static (a data URI
 * is immutable; a project asset URL is stable), decode is not free, and the
 * count is bounded by the document's distinct images. If animated/mutable
 * sources ever land they get an explicit invalidation call — not a silent
 * cache bypass (FINDINGS "image refs upload once").
 *
 * DOM note: decoding needs `createImageBitmap` + `fetch`/`Blob`, which exist in
 * browsers and in node ≥18's global fetch/Blob but NOT `createImageBitmap`. So
 * this module is browser/CLI-facing (like the compositor), NOT part of the
 * DOM-free `core/`. The PDF backend does its own DOM-free base64 decode and
 * does NOT depend on this module.
 */

/** src → {status: "loading"|"ready"|"error", bitmap: ImageBitmap|null, error: Error|null} */
const registry = new Map();

/** Repaint subscribers (see onImageLoad); notified when any decode resolves. */
const listeners = new Set();

/**
 * Query. The decoded ImageBitmap for `src` if it is ready, else null. SYNC —
 * this is what the compositor calls on the render path. A null answer means
 * "not decoded yet" (still loading, or a load error): draw nothing this frame.
 *
 * @example getImage("data:image/png;base64,AAAA") // null  (until ensureImage resolves it)
 */
export function getImage(src) {
  const entry = registry.get(src);
  return entry && entry.status === "ready" ? entry.bitmap : null;
}

/**
 * Query. The load status of `src`: "unloaded" (never requested), "loading",
 * "ready", or "error". Lets callers/tests distinguish in-flight from failed.
 *
 * @example imageStatus("nope://x") // "unloaded"
 */
export function imageStatus(src) {
  return registry.get(src)?.status ?? "unloaded";
}

/**
 * Command (near-pure: idempotent). Ensures `src` is decoding into an
 * ImageBitmap. A no-op if it is already loading, ready, or errored — so it is
 * safe to call on every frame from a sync render pass. Fire-and-forget: the
 * returned promise resolves to the bitmap (or null on error) for callers that
 * WANT to await (the CLI/parity harness), but the render path ignores it.
 *
 * @example // ensureImage(dataUri); ...later... getImage(dataUri) → ImageBitmap
 */
export function ensureImage(src) {
  if (typeof src !== "string" || src.length === 0)
    throw new Error(`ensureImage: src must be a non-empty string, got ${JSON.stringify(src)}`);
  const existing = registry.get(src);
  if (existing) return existing.promise;

  const entry = { status: "loading", bitmap: null, error: null, promise: null };
  entry.promise = (async () => {
    // fetch handles data: URIs and http(s)/relative URLs uniformly; the Blob
    // → createImageBitmap path is the standard decode (premultiply happens at
    // GPU upload, not here).
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    entry.status = "ready";
    entry.bitmap = bitmap;
    notify(src);
    return bitmap;
  })().catch((e) => {
    // Loud, once, then latched to "error" (no silent retry, no silent success).
    entry.status = "error";
    entry.error = e instanceof Error ? e : new Error(String(e));
    console.error(`PowerRP image_registry: failed to load "${truncate(src)}" — ${entry.error.message}`);
    notify(src); // wake repaint drivers so an errored image stops being "pending"
    return null;
  });
  registry.set(src, entry);
  return entry.promise;
}

/**
 * Command. Reserves `ref`'s registry slot in the "loading" state, SYNCHRONOUSLY,
 * with no fetch attempt — the seam a non-fetchable raster SOURCE uses before
 * it starts its OWN async work (render_gpu/gpu/pdf_page_raster.js: a PDF page
 * rasterized via pdfjs-dist, keyed by a synthetic pdfPageRef(...) string that
 * is not a real fetchable URI). WHY this must run BEFORE any `await`: the
 * compositor's `_imageSource(ref)` fallback calls `getImage(ref)` (null while
 * loading) then `ensureImage(ref)` (gpu/compositor.js `_imageSource`) — and
 * `ensureImage` only skips its OWN fetch() when `registry.has(ref)` is
 * already true. Without reserving the slot first, a compositor frame that
 * runs between "rasterization started" and "registerRasterizedBitmap
 * called" would see no entry, call ensureImage(ref), and `fetch()` the fake
 * ref (guaranteed to fail, permanently latching the key to "error" before
 * the real bitmap ever arrives — reproduced and fixed during this task's
 * verification). A no-op if the slot is already reserved/ready/errored
 * (idempotent, like ensureImage itself).
 *
 * @example // reserveImageSlot("pdfpage:x:1:1"); imageStatus("pdfpage:x:1:1") // "loading"
 */
export function reserveImageSlot(ref) {
  if (typeof ref !== "string" || ref.length === 0)
    throw new Error(`reserveImageSlot: ref must be a non-empty string, got ${JSON.stringify(ref)}`);
  if (registry.has(ref)) return;
  registry.set(ref, { status: "loading", bitmap: null, error: null, promise: null });
}

/**
 * Command. Fills an ALREADY-DECODED bitmap into `ref`'s slot directly,
 * skipping the fetch+createImageBitmap decode path (the reserveImageSlot
 * twin — see it for the full "why a non-fetchable ref needs this pair"
 * reasoning). Overwrites a "loading" placeholder (the expected prior state
 * when reserveImageSlot was called first) but is a no-op if the slot is
 * somehow ALREADY "ready" (content-addressed key: refs here are (src, page,
 * scale) — the same ref always means the same pixels, so a second fill would
 * be redundant, not a correction). Wakes onImageLoad subscribers exactly like
 * a normal ensureImage() decode landing, so the compositor's reactive
 * repaint-on-load path needs no special case for registry-injected bitmaps.
 *
 * @example // reserveImageSlot("pdfpage:x:1:1"); registerRasterizedBitmap("pdfpage:x:1:1", bitmap); getImage("pdfpage:x:1:1") → bitmap
 */
export function registerRasterizedBitmap(ref, bitmap) {
  if (typeof ref !== "string" || ref.length === 0)
    throw new Error(`registerRasterizedBitmap: ref must be a non-empty string, got ${JSON.stringify(ref)}`);
  if (registry.get(ref)?.status === "ready") return; // already filled — the same ref always means the same pixels
  registry.set(ref, { status: "ready", bitmap, error: null, promise: Promise.resolve(bitmap) });
  notify(ref);
}

/**
 * Command. Subscribes to decode-resolution events (a src became ready or
 * errored). The editor's paint loop is reactive, so a bitmap that arrives
 * after the frame that requested it needs this to trigger a repaint. Returns
 * an unsubscribe function.
 *
 * @example // const off = onImageLoad((src) => scheduleRepaint()); ... off();
 */
export function onImageLoad(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Command. Notifies every repaint subscriber that `src` resolved. */
function notify(src) {
  for (const cb of listeners) cb(src);
}

/** Pure function. Shortens a src for log messages (data URIs are huge).
 * @example truncate("data:image/png;base64," + "A".repeat(200)) // "data:image/png;base64,AA…(222 chars)"
 */
export function truncate(src) {
  return src.length > 48 ? `${src.slice(0, 24)}…(${src.length} chars)` : src;
}

/**
 * Command. Drops all cached bitmaps (closing them) and forgets all state.
 * For tests that need a clean registry; also the invalidation hook for a
 * future mutable-source policy. Listeners are kept (they are wiring, not data).
 */
export function resetImageRegistry() {
  for (const entry of registry.values()) entry.bitmap?.close?.();
  registry.clear();
}
