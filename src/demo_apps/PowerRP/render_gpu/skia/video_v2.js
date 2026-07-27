/**
 * Video V2 — the DIRECT-UPLOAD Skia video path (a fresh, self-contained module).
 *
 * WHY THIS EXISTS (the V2 approach, done right): this is a from-scratch
 * reimplementation that owns its OWN `<video>` elements, its OWN per-GrContext
 * texture cache, and its OWN playback gate, so it can be evaluated against the
 * existing player path without entangling the two. It deliberately does NOT import
 * render_gpu/gpu/video_registry.js or any plugin.
 *
 * THE CORE IDEA: upload the `<video>` element's CURRENT frame STRAIGHT to a GL
 * texture via CanvasKit `surface.makeImageFromTextureSource(videoEl)` (first
 * frame) and `surface.updateTextureFromSource(image, videoEl)` (every subsequent
 * frame) — no `drawImage`→canvas→`MakeImageFromCanvasImageSource` CPU readback on
 * the hot path. The texture-backed Image is REUSED in place and only refreshed
 * when a NEW decoded frame has arrived (a frame-advance gate on
 * `requestVideoFrameCallback`'s `presentedFrames`), so a paint burst that redraws
 * the same frame N times uploads ZERO extra times. Full resolution (the Image is
 * sized from videoWidth/videoHeight), full frame rate (every decoded frame is
 * eligible), no downscale, no rate cap.
 *
 * TEXTURE ↔ CONTEXT SCOPING: a texture-backed CanvasKit Image is usable ONLY on
 * the GrContext that minted it (the editor surface and the presenter surface have
 * DIFFERENT GL contexts). We therefore key the texture cache by the
 * `ctx.makeSurface` FACTORY IDENTITY — one factory per SkiaSurface, i.e. one per
 * GrContext — and mint a tiny 1×1 helper Surface from that same factory to call
 * makeImageFromTextureSource/updateTextureFromSource. Because the helper Surface
 * and the on-screen/scene Surface share the ONE GrContext, the texture Image is
 * drawable on the caller's canvas. When a new factory identity appears (present
 * enter/exit, HMR) we simply START A NEW BUCKET and leave the old one untouched:
 * we NEVER `.delete()` a cached Image, because a `.delete()` on a possibly
 * torn-down GrContext faults the wasm heap. The abandoned textures are a small,
 * bounded, one-per-context-churn leak — the documented, safe trade.
 *
 * OFF-VIEW = ZERO DECODE: playback is gated on the POST-CULL DRAW set. Every draw
 * stamps the element's `lastDrawnAt`; a self-owned rAF sweep pauses any element
 * NOT drawn within ACTIVE_GRACE_MS (a culled/off-slide widget is never drawn, so
 * it goes stale and pauses — the browser then stops decoding it) and resumes it,
 * from its prior currentTime, the moment it is drawn again. The sweep stops itself
 * once everything is paused, so a fully idle/off-view scene costs nothing ongoing.
 * A visibly-playing surface (the presenter's rAF draws every ~16 ms, well inside
 * the grace window) never false-pauses.
 *
 * DOM-SAFE IN NODE: no module-load DOM access. `drawVideoV2` early-returns when
 * there is no `document` (the Node CPU/CLI paint), so this file imports cleanly in
 * bare node and simply draws nothing headless — exactly like the current `video`
 * op with an empty media map (not a regression).
 *
 * FAILURES ARE LOUD: a `<video>` error handler reports to console.error and a
 * null makeImageFromTextureSource throws — never a silent blank.
 */

/** Below this HTMLMediaElement.readyState a frame is not yet drawable
 * (HAVE_CURRENT_DATA — the current playback position has decoded data). */
const HAVE_CURRENT_DATA = 2;

/** An element drawn within this many ms is considered "on screen and playing".
 * The presenter's rAF draws every ~16 ms (far inside this window) so a visible
 * clip never false-pauses; an idle editor or a culled/off-slide widget stops
 * being drawn and pauses this long after its last draw (freeing decode CPU). */
const ACTIVE_GRACE_MS = 200;

/** src → element entry. One `<video>` per distinct source, created lazily. */
const _entries = new Map();

/** ctx.makeSurface (factory identity ≙ one GrContext) → texture bucket
 * { helper: Surface, images: Map<src, {img, marker}> }.
 *
 * CONTRACT ON CALLERS: whoever passes `makeSurface` into paintIR MUST pass an
 * IDENTITY-STABLE function per GrContext — one closure created once, not a fresh
 * closure per paint. Identity is the only handle this module has on "which GPU
 * context", so a new closure means a new bucket: a helper render target plus a
 * full-resolution video texture per paint, held in this strong Map and never
 * reused or freed. That is exactly the leak web/gpuService.js caused when it minted
 * its offscreen factory inside renderJob (fixed there by hoisting the factory to a
 * service singleton). Surfaces may be recreated freely — only the FACTORY identity
 * must hold, which is what lets an on-screen surface survive a resize.
 *
 * Entries are therefore bounded by the number of live GL contexts (the editor
 * surface, the presenter surface, the offscreen pixel service), each holding one
 * reused texture per distinct video source. */
const _gpuBuckets = new Map();

/** Monotonic count of real texture uploads (mint + refresh) — a diagnostic that
 * lets a probe prove uploads happen ONLY on frame advance, not per paint. */
let _uploadCount = 0;

/** The self-owned pause-sweep rAF handle (null ⇒ not scheduled). */
let _sweepRaf = null;

/** Near-pure helper (reads the global clock). High-resolution now in ms. */
function perfNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Pure function. The frame-advance MARKER a texture is cached under: the decoded
 * frame counter (`requestVideoFrameCallback`'s presentedFrames) when available,
 * else the element's wall-clock currentTime. The texture is re-uploaded only when
 * this value changes, so redundant same-frame paints upload nothing.
 *
 * Args:
 *   presentedFrames (number): decoded-frame counter (0 if rVFC hasn't fired / is unsupported)
 *   currentTime (number): the element's currentTime in seconds (the fallback)
 *
 * Returns:
 *   number: the marker
 *
 * @example frameMarker(5, 1.2) // 5   (frame counter preferred)
 * @example frameMarker(0, 1.2) // 1.2 (no counter yet → currentTime)
 */
export function frameMarker(presentedFrames, currentTime) {
  return presentedFrames > 0 ? presentedFrames : currentTime;
}

/**
 * Command (creates + owns a `<video>` element on first call for `src`). Idempotent
 * — returns the existing entry on repeat calls; playback flags are applied ONCE at
 * creation (mirroring the browser's own element semantics: muted MUST be set
 * before src for autoplay to be allowed). Kicks a `requestVideoFrameCallback` pump
 * that advances the entry's presentedFrames per decoded frame.
 *
 * @param {string} src the video source (data: URI, URL, or asset URL)
 * @param {{autoplay?: boolean, loop?: boolean, muted?: boolean}} flags playback config
 * @returns {object} the entry {el, presentedFrames, lastDrawnAt, autoplay}
 */
export function ensureVideoV2(src, { autoplay = true, loop = true, muted = true } = {}) {
  const existing = _entries.get(src);
  if (existing) return existing;
  const el = document.createElement("video");
  // muted BEFORE src: the browser's autoplay policy only permits autoplay on a
  // muted element, and the decision is made at load time.
  el.muted = muted;
  el.loop = loop;
  el.autoplay = autoplay;
  el.playsInline = true;
  el.crossOrigin = "anonymous";
  el.preload = "auto";
  el.addEventListener("error", () => {
    const err = el.error;
    console.error(`video_v2: <video> failed to load "${src}"` + (err ? ` (code ${err.code}: ${err.message})` : ""));
  });
  const entry = { el, presentedFrames: 0, lastDrawnAt: 0, autoplay };
  // The rVFC pump: one callback per DECODED frame updates the advance counter so
  // the draw path can skip re-uploading a frame it already has. Falls back to a
  // no-op when rVFC is unsupported (marker then rides currentTime).
  const pump = (_now, metadata) => {
    entry.presentedFrames = metadata && typeof metadata.presentedFrames === "number" ? metadata.presentedFrames : entry.presentedFrames + 1;
    if (typeof el.requestVideoFrameCallback === "function") el.requestVideoFrameCallback(pump);
  };
  if (typeof el.requestVideoFrameCallback === "function") el.requestVideoFrameCallback(pump);
  el.src = src;
  el.load();
  _entries.set(src, entry);
  return entry;
}

/** Query. True iff the element has a decoded, correctly-sized frame to draw. */
function isDrawable(el) {
  return el.readyState >= HAVE_CURRENT_DATA && el.videoWidth > 0 && el.videoHeight > 0;
}

/**
 * Query→build (mints/refreshes a GL texture). The current frame of `entry.el` as a
 * texture-backed CanvasKit Image on the GrContext behind `ctx.makeSurface`,
 * uploaded via makeImageFromTextureSource (first time) / updateTextureFromSource
 * (subsequent), REUSED in place and refreshed only on frame advance. The returned
 * Image is BUCKET-OWNED (never deleted by the caller). Returns null when no frame
 * is decoded yet.
 *
 * @param CanvasKit the CanvasKit module
 * @param ctx paintIR's render ctx (carries makeSurface — the GrContext factory)
 * @param entry an ensureVideoV2 entry
 * @param {string} src the cache key
 */
function resolveGpuFrame(CanvasKit, ctx, entry, src) {
  const el = entry.el;
  if (!isDrawable(el)) return null;
  let bucket = _gpuBuckets.get(ctx.makeSurface);
  if (!bucket) {
    const helper = ctx.makeSurface(1, 1); // sizes the IMAGE from videoWidth/Height, not this surface — 1×1 is enough
    if (!helper) throw new Error("video_v2: ctx.makeSurface(1,1) returned null — cannot mint a GPU texture surface");
    bucket = { helper, images: new Map() };
    _gpuBuckets.set(ctx.makeSurface, bucket);
  }
  const marker = frameMarker(entry.presentedFrames, el.currentTime);
  const rec = bucket.images.get(src);
  if (!rec) {
    const img = bucket.helper.makeImageFromTextureSource(el);
    if (!img) throw new Error(`video_v2: makeImageFromTextureSource returned null for "${src}"`);
    bucket.images.set(src, { img, marker });
    _uploadCount++;
    return img;
  }
  if (rec.marker !== marker) {
    bucket.helper.updateTextureFromSource(rec.img, el);
    rec.marker = marker;
    _uploadCount++;
  }
  return rec.img;
}

/**
 * Query→build (CPU readback). A FRESH CanvasKit Image of the current frame via
 * drawImage→MakeImageFromCanvasImageSource — the poster/thumbnail fallback for a
 * non-live surface (gpuService, CLI) where no GrContext texture upload is
 * available. The caller MUST delete the returned Image after drawing it. Returns
 * null when no frame is decoded yet.
 */
function resolveCpuFrame(CanvasKit, entry) {
  const el = entry.el;
  if (!isDrawable(el)) return null;
  const c = document.createElement("canvas");
  c.width = el.videoWidth;
  c.height = el.videoHeight;
  c.getContext("2d").drawImage(el, 0, 0);
  return CanvasKit.MakeImageFromCanvasImageSource(c);
}

/** Command (stamps the draw time; ensures the pause sweep is running). */
function markDrawn(entry) {
  entry.lastDrawnAt = perfNow();
  ensureSweep();
}

/** Command (schedules the pause sweep if idle and rAF exists). */
function ensureSweep() {
  if (_sweepRaf !== null || typeof requestAnimationFrame === "undefined") return;
  _sweepRaf = requestAnimationFrame(sweepTick);
}

/**
 * Command (pauses/resumes every element by draw recency; reschedules while any
 * element is active). An element drawn within ACTIVE_GRACE_MS with autoplay on is
 * PLAYED; every other element is PAUSED (preserving currentTime, so a resume
 * continues rather than restarts). Off-view/culled widgets are never drawn → they
 * pause here → the browser stops decoding them. Stops itself when nothing is
 * active (zero ongoing cost) and restarts on the next draw.
 */
function sweepTick() {
  _sweepRaf = null;
  const now = perfNow();
  let anyActive = false;
  for (const entry of _entries.values()) {
    const el = entry.el;
    const active = entry.autoplay && now - entry.lastDrawnAt <= ACTIVE_GRACE_MS && isDrawable(el);
    if (active) {
      anyActive = true;
      if (el.paused) el.play().catch((err) => console.error(`video_v2: play() rejected for "${el.src}": ${err && err.message ? err.message : err}`));
    } else if (!el.paused) {
      el.pause();
    }
  }
  if (anyActive) _sweepRaf = requestAnimationFrame(sweepTick);
}

/**
 * Command (draws one `videoV2` op on `canvas` in its already view+world-transformed
 * local space). Ensures the element, marks it drawn (drives the pause sweep),
 * resolves the current frame (GPU direct-upload when ctx.liveGpu, else CPU
 * poster), and blits the quad honoring the op's source-rect crop + opacity. Draws
 * nothing (no throw) in Node or before the first frame decodes.
 *
 * @param CanvasKit the CanvasKit module
 * @param canvas the CanvasKit Canvas (CTM already at the op's local space)
 * @param cmd the videoV2 IR op
 * @param {number} opacity group opacity 0..1
 * @param ctx paintIR's render ctx (media, makeSurface, liveGpu, …)
 */
export function drawVideoV2(CanvasKit, canvas, cmd, opacity, ctx) {
  if (typeof document === "undefined") return; // Node/CLI CPU paint has no <video> — draw nothing (matches the video op with empty media)
  const entry = ensureVideoV2(cmd.ref, { autoplay: cmd.autoplay, loop: cmd.loop, muted: cmd.muted });
  markDrawn(entry);
  const gpu = ctx.liveGpu === true;
  const img = gpu ? resolveGpuFrame(CanvasKit, ctx, entry, cmd.ref) : resolveCpuFrame(CanvasKit, entry);
  if (!img) return;
  const iw = img.width(), ih = img.height();
  const s = cmd.src;
  const src = CanvasKit.LTRBRect(s.sx * iw, s.sy * ih, (s.sx + s.sw) * iw, (s.sy + s.sh) * ih);
  const dest = CanvasKit.LTRBRect(cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h);
  const p = new CanvasKit.Paint();
  p.setAlphaf(opacity);
  canvas.drawImageRect(img, src, dest, p, false);
  p.delete();
  if (!gpu) img.delete(); // CPU frame is a fresh per-paint readback we own; GPU frame is bucket-owned (reused in place)
}

// ── diagnostics (read by the verification probe) ──────────────────────────────

/** Query. Total real texture uploads since load (mint + refresh). */
export function videoV2UploadCount() {
  return _uploadCount;
}

/**
 * Query. Live playback state for a source, or null if not registered. `drawnAgoMs`
 * lets a probe confirm an off-view clip stopped being drawn.
 */
export function videoV2PlaybackState(src) {
  const entry = _entries.get(src);
  if (!entry) return null;
  const el = entry.el;
  return {
    paused: el.paused,
    currentTime: el.currentTime,
    presentedFrames: entry.presentedFrames,
    readyState: el.readyState,
    videoWidth: el.videoWidth,
    videoHeight: el.videoHeight,
    drawnAgoMs: perfNow() - entry.lastDrawnAt,
  };
}

/** Query. The registered source keys (probe convenience). */
export function videoV2Sources() {
  return [..._entries.keys()];
}

// A dev hook so a puppeteer probe can read diagnostics without importing the
// module graph. Guarded window assignment only — no DOM mutation, Node-safe.
if (typeof window !== "undefined") {
  window.__powerrp_videoV2 = { uploadCount: videoV2UploadCount, playbackState: videoV2PlaybackState, sources: videoV2Sources };
}
