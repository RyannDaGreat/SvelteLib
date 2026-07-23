/**
 * The shared video-source registry — live HTML `<video>` elements keyed by
 * their source string (a URL or a `data:` URI, exactly what the video widget
 * stores in `state.src`). The TWIN of gpu/image_registry.js: it is how a video
 * reaches the GPU compositor's media map WITHOUT the web layer threading a
 * media object through every GpuCompositor.create() call site (the editor
 * viewport, the presenter, the pixel service, the CLI all create the compositor
 * with an empty media map). The compositor consults THIS registry as a fallback
 * (see gpu/compositor.js `_videoSource`), and the plugin never reaches into any
 * compositor.
 *
 * Why an ELEMENT, not a decoded bitmap (the one shape difference from the image
 * registry): a video is MOVING. The compositor imports the element's CURRENT
 * frame each render via importExternalTexture (zero-copy) — so the registry
 * hands back the live `<video>` element itself, and the browser's playback
 * clock advances the frame. The element owns playback (autoplay/loop/muted);
 * document/tween state never does (manifest: the video PLAYER's playing does
 * NOT change document state).
 *
 * ── THE ASYNC CONTRACT (manifest F3 + the round-12 async rule) ────────────────
 * Element creation + first-frame decode are ASYNC; the render path is
 * SYNC-shaped (emit → sceneIR → one command submit). So:
 *   - `ensureVideo(src, flags)` creates the element (idempotent). Fire-and-forget;
 *     safe to call every frame (a src already created is a no-op — the flags are
 *     applied ONCE, at creation, since a src is one clip; a later flag change on
 *     the same src is a rare edit handled by resetVideoRegistry, not a silent
 *     mutation). `flags` = {autoplay, loop, muted} off the widget state.
 *   - `getVideo(src)` is the SYNC query the compositor uses: the `<video>`
 *     element once it has a CURRENT frame (readyState ≥ HAVE_CURRENT_DATA), else
 *     null. A null means "no frame yet" — the compositor draws NOTHING for that
 *     video this frame (no silent placeholder graphic; the manifest rule),
 *     exactly like the image pipeline skips a not-yet-decoded bitmap.
 *   - `onVideoFrame(cb)` lets a repaint-driver re-render as frames advance (the
 *     editor's paint loop is reactive, not a continuous rAF loop, so a PLAYING
 *     video needs an explicit per-frame nudge — this is what makes a clip appear
 *     to MOVE in the editor viewport; the presenter's rAF loop needs no nudge).
 *     Returns an unsubscribe fn. Driven by requestVideoFrameCallback where the
 *     browser supports it (fires once per painted video frame — the precise
 *     signal), falling back to the element's "timeupdate"/"loadeddata" events.
 *
 * Loud failure discipline (manifest rule): an element whose load FAILS (its
 * "error" event, or a decode reject) is reported once via console.error and the
 * src is left in an "error" state (never retried silently, never a silent
 * success). A missing/undecoded src is NOT a failure — it is the normal
 * in-flight state and stays quiet.
 *
 * Elements are cached forever by design: video sources are static (a data URI is
 * immutable; a project asset URL is stable), element creation + buffering is not
 * free, and the count is bounded by the document's distinct videos.
 * resetVideoRegistry() is the explicit invalidation hook (tests; a future
 * mutable-source policy) — not a silent cache bypass.
 *
 * DOM note: this module needs `document.createElement("video")` +
 * HTMLMediaElement, which exist in browsers but NOT in bare node. So it is
 * browser/CLI-facing (like the compositor), NOT part of the DOM-free `core/`.
 * The PDF backend does its own frame grab and does NOT depend on this module.
 */

/** src → {status, el, error, listeners:Set, onFrame:fn|null} */
const registry = new Map();

/** Repaint subscribers (see onVideoFrame); notified when any frame advances. */
const listeners = new Set();

/** readyState threshold: a video has a drawable current frame at
 * HAVE_CURRENT_DATA (2). Named rather than a bare 2 — the HTMLMediaElement
 * constant isn't reliably global outside a browser, so the compositor and this
 * module share this literal by the same reasoning (the spec value is fixed). */
export const HAVE_CURRENT_DATA = 2;

/**
 * Query. The `<video>` element for `src` if it has a current frame, else null.
 * SYNC — this is what the compositor calls on the render path. A null answer
 * means "no drawable frame yet" (still loading, or a load error): draw nothing
 * this frame.
 *
 * @example getVideo("data:video/mp4;base64,AAAA") // null  (until ensureVideo creates + decodes it)
 */
export function getVideo(src) {
  const entry = registry.get(src);
  if (!entry || entry.status === "error") return null;
  return entry.el.readyState >= HAVE_CURRENT_DATA ? entry.el : null;
}

/** A single reused offscreen 2D canvas for grabbing video frames. Reused (not
 * reallocated per paint) — the draw+read below is synchronous, so back-to-back
 * getSkiaVideoFrame calls can share it without clobbering (JS is single-threaded
 * and MakeImageFromCanvasImageSource reads the pixels before returning). */
let _frameCanvas = null;

/**
 * Query→build (near-pure: idempotent element create + a per-call frame grab).
 * The `<video>` element's CURRENT frame as a FRESH CanvasKit Image for the Skia
 * paint path, or null when there is no drawable frame yet (draw NOTHING — the
 * async contract). The video twin of image_registry.getSkiaImage, with the one
 * shape difference the registries already carry: a video MOVES, so this grabs a
 * NEW image every paint and NEVER caches — the CALLER MUST delete() the returned
 * Image after the frame is painted (see render_gpu/skia/browser_media.js
 * `release`). ensureVideo is kicked with the default playback flags
 * (autoplay/loop/muted — the video PLAYER's shipped defaults); onVideoFrame
 * drives the per-frame repaint that re-runs this.
 *
 * WHY the offscreen canvas (not MakeImageFromCanvasImageSource(el) directly):
 * that helper sizes its internal read from the element's `.width`/`.height`
 * ATTRIBUTES, which a bare `<video>` leaves at 0 — a getImageData(…, 0, …)
 * IndexSizeError every frame. So we draw the element (whose FRAME size is
 * `videoWidth`/`videoHeight`) onto a canvas sized to those, then make the image
 * from the canvas (whose `.width`/`.height` ARE set). This is exactly the
 * "draw the element to an offscreen 2d canvas → CanvasKit image" recipe.
 *
 * @param CanvasKit the shared browser CanvasKit module (the Image binds to it)
 * @example // getSkiaVideoFrame(CK, url) // null until a frame decodes, then a fresh CanvasKit.Image the caller deletes
 */
export function getSkiaVideoFrame(CanvasKit, ref) {
  ensureVideo(ref); // idempotent create with the player's default flags (autoplay/loop/muted)
  const el = getVideo(ref); // <video> with a current frame, or null (loading/error)
  if (!el) return null; // no drawable frame yet → draw nothing; onVideoFrame nudges repaints as frames land
  const w = el.videoWidth, h = el.videoHeight;
  if (!(w > 0 && h > 0)) return null; // frame dimensions not known yet → draw nothing
  if (!_frameCanvas) _frameCanvas = document.createElement("canvas");
  _frameCanvas.width = w; _frameCanvas.height = h;
  _frameCanvas.getContext("2d").drawImage(el, 0, 0, w, h); // the current frame at native resolution
  const img = CanvasKit.MakeImageFromCanvasImageSource(_frameCanvas);
  if (!img) throw new Error(`getSkiaVideoFrame: MakeImageFromCanvasImageSource returned null for ref "${truncate(ref)}"`);
  return img; // per-paint frame — the caller deletes it (never cached: a video moves)
}

/**
 * Query. The load status of `src`: "unloaded" (never requested), "loading",
 * "ready", or "error". "ready" means the element exists and has ≥1 frame; it
 * stays "ready" while playing (the frame advances, the status doesn't).
 *
 * @example videoStatus("nope://x") // "unloaded"
 */
export function videoStatus(src) {
  const entry = registry.get(src);
  if (!entry) return "unloaded";
  if (entry.status === "error") return "error";
  return entry.el.readyState >= HAVE_CURRENT_DATA ? "ready" : "loading";
}

/**
 * Command (near-pure: idempotent). Ensures a `<video>` element exists for `src`,
 * configured with the playback flags. A no-op if the element already exists — so
 * it is safe to call on every frame from a sync render pass. Flags are applied
 * ONCE at creation (a src is one clip; changing autoplay/loop/muted on an
 * existing src is a rare edit that goes through resetVideoRegistry, not a silent
 * per-frame re-mutation). Returns the element (created or cached).
 *
 * muted MUST be true for autoplay to work under browser autoplay policy; the
 * plugin defaults it true and this honors whatever the state says (an unmuted
 * autoplay simply gets paused by the browser — that is the browser's rule, not
 * ours to override).
 *
 * @example // ensureVideo(dataUri, {autoplay: true, loop: true, muted: true}); ...later... getVideo(dataUri) → <video>
 */
export function ensureVideo(src, { autoplay = true, loop = true, muted = true } = {}) {
  if (typeof src !== "string" || src.length === 0)
    throw new Error(`ensureVideo: src must be a non-empty string, got ${JSON.stringify(src)}`);
  const existing = registry.get(src);
  if (existing) return existing.el;

  const el = document.createElement("video");
  // muted BEFORE src/play so the autoplay policy sees a muted element.
  el.muted = !!muted;
  el.loop = !!loop;
  el.autoplay = !!autoplay;
  el.playsInline = true; // iOS/Safari: play in place, never fullscreen-hijack
  el.crossOrigin = "anonymous"; // allow importExternalTexture / canvas grab of cross-origin assets that permit it
  el.preload = "auto";
  const entry = { status: "loading", el, error: null };
  registry.set(src, entry);

  // Loud failure: the element's error event (bad codec, 404, decode failure).
  el.addEventListener("error", () => {
    entry.status = "error";
    const mediaErr = el.error;
    entry.error = new Error(mediaErr ? `MediaError code ${mediaErr.code}: ${mediaErr.message || "(no message)"}` : "unknown video error");
    console.error(`PowerRP video_registry: failed to load "${truncate(src)}" — ${entry.error.message}`);
    notify(src); // wake repaint drivers so an errored video stops being "pending"
  });

  const onReady = () => {
    if (entry.status !== "error") entry.status = "ready";
    notify(src); // first frame available → repaint
    if (autoplay) el.play?.().catch((e) => {
      // A rejected play() is reported, not swallowed — but it is not fatal
      // (the element still holds a first frame we can draw). The usual cause
      // is an unmuted autoplay the browser blocked; muted:true avoids it.
      console.error(`PowerRP video_registry: autoplay of "${truncate(src)}" was blocked — ${e?.message ?? e} (a video needs muted:true to autoplay)`);
    });
  };
  el.addEventListener("loadeddata", onReady, { once: true });

  // Per-frame repaint nudge. requestVideoFrameCallback fires once per PAINTED
  // video frame (the precise signal); re-arm it each call so a playing clip
  // keeps nudging. Where unsupported, "timeupdate" (coarser, but real) drives
  // repaints as playback advances.
  if (typeof el.requestVideoFrameCallback === "function") {
    const pump = () => {
      notify(src);
      el.requestVideoFrameCallback(pump);
    };
    el.requestVideoFrameCallback(pump);
  } else {
    el.addEventListener("timeupdate", () => notify(src));
  }

  el.src = src;
  el.load();
  return el;
}

/**
 * Command. Subscribes to frame-advance events (a src got its first frame,
 * errored, or a playing clip painted a new frame). The editor's paint loop is
 * reactive, so a PLAYING video needs this to keep repainting; the presenter's
 * rAF loop does not. Returns an unsubscribe function.
 *
 * @example // const off = onVideoFrame(() => scheduleRepaint()); ... off();
 */
export function onVideoFrame(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Command. Notifies every repaint subscriber that `src` advanced. */
function notify(src) {
  for (const cb of listeners) cb(src);
}

/** Pure function. Shortens a src for log messages (data URIs are huge).
 * @example truncate("data:video/mp4;base64," + "A".repeat(200)) // "data:video/mp4;base64,AA…(222 chars)"
 */
export function truncate(src) {
  return src.length > 48 ? `${src.slice(0, 24)}…(${src.length} chars)` : src;
}

/**
 * Command. Tears down all cached elements (pause + drop the src so the browser
 * releases the buffer) and forgets all state. For tests that need a clean
 * registry; also the invalidation hook for a future mutable-source / flag-change
 * policy. Listeners are kept (they are wiring, not data).
 */
export function resetVideoRegistry() {
  for (const entry of registry.values()) {
    try {
      entry.el.pause?.();
      entry.el.removeAttribute("src");
      entry.el.load?.();
    } catch (e) {
      // Teardown of a half-initialized element can throw in odd states; report
      // (never silent) but keep clearing the rest.
      console.error(`PowerRP video_registry: teardown of a cached element failed — ${e?.message ?? e}`);
    }
  }
  registry.clear();
}
