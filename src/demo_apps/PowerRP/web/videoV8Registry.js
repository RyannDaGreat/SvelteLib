/**
 * V8 video registry — a tiny, self-contained pool of live HTML `<video>`
 * elements keyed by their source string, purpose-built for the V8 OVERLAY
 * player. Written FRESH (it deliberately does NOT reuse
 * render_gpu/gpu/video_registry.js): the overlay path never grabs frames into
 * CanvasKit Images, so this registry is far smaller — it owns the `<video>`
 * elements, the off-view playback gate, and a per-frame repaint nudge, and
 * nothing else. The GPU backends (videoV8_webgl2 / videoV8_webgpu) read the
 * live element straight off `getVideoV8` and upload/import its CURRENT frame
 * themselves (no CPU readback here).
 *
 * ── WHY AN ELEMENT, NOT A BITMAP ──────────────────────────────────────────────
 * A video is MOVING: the browser's playback clock advances the frame inside the
 * element. Each overlay paint samples the element's current frame directly to a
 * GPU texture (WebGL2 texImage2D from the element) or imports it as a
 * GPUExternalTexture (WebGPU) — zero CPU readback either way — so the registry
 * hands back the live element itself. The element owns playback
 * (autoplay/loop/muted); document/tween state never does (the video PLAYER's
 * playing must not mutate document state).
 *
 * ── THE ASYNC CONTRACT ────────────────────────────────────────────────────────
 * Element creation + first-frame decode are ASYNC; the overlay paint is
 * SYNC-shaped. So:
 *   - ensureVideoV8(src, flags) creates the element (idempotent — safe to call
 *     every paint). Flags applied ONCE at creation (a src is one clip).
 *   - getVideoV8(src) is the SYNC query the backends use: the element once it has
 *     a CURRENT frame (readyState >= HAVE_CURRENT_DATA), else null → the overlay
 *     draws NOTHING for it this frame (no placeholder; the poster rect the plugin
 *     emits into the Skia scene shows through until frames arrive).
 *   - onVideoV8Frame(cb) drives repaints as frames advance: the editor paints
 *     reactively (not a continuous rAF loop), so a PLAYING clip needs an explicit
 *     per-decoded-frame nudge to appear to MOVE. Driven by
 *     requestVideoFrameCallback (fires once per painted frame — the precise
 *     signal), falling back to "timeupdate".
 *
 * ── OFF-VIEW = ZERO COST ──────────────────────────────────────────────────────
 * setActiveVideoV8Refs(visibleSrcs) pauses every element NOT in the set and
 * resumes those that ARE. Fed the POST-cull visible set each paint, so a clip
 * panned off-screen or on another slide is PAUSED — the browser stops decoding
 * it entirely. pause()/play() preserves currentTime, so re-entry RESUMES from the
 * prior time (never restarts); toggles fire only on a real paused-state change so
 * there is no per-paint thrash.
 *
 * Loud-failure discipline: a load FAILURE (the element's "error" event) is
 * reported ONCE via console.error and the src is left in an "error" state; it is
 * never retried silently and never a silent success. A not-yet-decoded src is NOT
 * a failure — it is the normal in-flight state and stays quiet.
 *
 * DOM note: needs document.createElement("video") + HTMLMediaElement, so this is
 * browser-facing (not part of the DOM-free core/).
 */

/** readyState threshold at which a `<video>` has a drawable current frame
 * (HAVE_CURRENT_DATA). Named rather than a bare 2 because the HTMLMediaElement
 * constant is not reliably global outside a browser; the spec value is fixed. */
export const HAVE_CURRENT_DATA = 2;

/** Log-truncation bounds for src strings (data: URIs are enormous). */
const SRC_LOG_MAX = 48;
const SRC_LOG_HEAD = 24;

/** src → {status, el, error, presentedFrames}. Elements are cached for the life
 * of the page: video sources are static (a data: URI is immutable, an asset URL
 * is stable) and element creation + buffering is not free. */
const registry = new Map();

/** Repaint subscribers (onVideoV8Frame); notified when any frame advances. */
const listeners = new Set();

/**
 * Pure function. Shortens a src for log messages (data: URIs can be megabytes).
 *
 * @param {string} src the source string
 * @returns {string} a short, human-readable form
 * @example truncateSrc("clip.mp4") // "clip.mp4"
 * @example truncateSrc("data:video/mp4;base64," + "A".repeat(200)) // "data:video/mp4;base64,AA…(222 chars)"
 */
export function truncateSrc(src) {
  return src.length > SRC_LOG_MAX ? `${src.slice(0, SRC_LOG_HEAD)}…(${src.length} chars)` : src;
}

/** Command. Notifies every repaint subscriber that `src` advanced a frame. */
function notify(src) {
  for (const cb of listeners) cb(src);
}

/**
 * Command (near-pure: idempotent). Ensures a `<video>` element exists for `src`,
 * configured with the playback flags, and kicks its load. A no-op if the element
 * already exists — safe to call on every paint from a sync render pass. Flags are
 * applied ONCE at creation (a src is one clip). Returns the element.
 *
 * muted MUST be true for autoplay to actually play (browser autoplay policy
 * blocks unmuted autoplay). The plugin defaults it true; this honors whatever the
 * caller passes.
 *
 * @param {string} src a non-empty video source string (URL or data: URI)
 * @param {{autoplay?: boolean, loop?: boolean, muted?: boolean}} flags playback flags
 * @returns {HTMLVideoElement} the created or cached element
 * @example // ensureVideoV8("clip.mp4", {autoplay: true, loop: true, muted: true}); ... getVideoV8("clip.mp4")
 */
export function ensureVideoV8(src, { autoplay = true, loop = true, muted = true } = {}) {
  if (typeof src !== "string" || src.length === 0)
    throw new Error(`ensureVideoV8: src must be a non-empty string, got ${JSON.stringify(src)}`);
  const existing = registry.get(src);
  if (existing) return existing.el;

  const el = document.createElement("video");
  el.muted = !!muted;        // set BEFORE src/play so the autoplay policy sees a muted element
  el.loop = !!loop;
  el.autoplay = !!autoplay;
  el.playsInline = true;     // iOS/Safari: play in place, never fullscreen-hijack
  el.crossOrigin = "anonymous"; // allow importExternalTexture / texImage2D of cross-origin assets that permit it
  el.preload = "auto";
  const entry = { status: "loading", el, error: null, presentedFrames: 0 };
  registry.set(src, entry);

  el.addEventListener("error", () => {
    entry.status = "error";
    const mediaErr = el.error;
    entry.error = new Error(mediaErr ? `MediaError code ${mediaErr.code}: ${mediaErr.message || "(no message)"}` : "unknown video error");
    console.error(`PowerRP videoV8Registry: failed to load "${truncateSrc(src)}" — ${entry.error.message}`);
    notify(src); // wake repaint drivers so an errored video stops being "pending"
  });

  el.addEventListener("loadeddata", () => {
    if (entry.status !== "error") entry.status = "ready";
    notify(src); // first frame available → repaint
    if (autoplay) el.play?.().catch((e) => {
      // A rejected play() is reported, not swallowed — not fatal (the element
      // still holds a first frame we can draw). The usual cause is an unmuted
      // autoplay the browser blocked; muted:true avoids it.
      console.error(`PowerRP videoV8Registry: autoplay of "${truncateSrc(src)}" was blocked — ${e?.message ?? e} (a video needs muted:true to autoplay)`);
    });
  }, { once: true });

  // Per-frame repaint nudge. requestVideoFrameCallback fires once per PAINTED
  // frame (the precise signal); re-arm it each call so a playing clip keeps
  // nudging. metadata.presentedFrames is the decoded-frame counter the backends'
  // upload gate reads (videoV8FrameMarker) to skip re-uploading an unchanged frame.
  // Where unsupported, "timeupdate" (coarser, but real) drives repaints.
  if (typeof el.requestVideoFrameCallback === "function") {
    const pump = (_now, metadata) => {
      if (metadata && Number.isFinite(metadata.presentedFrames)) entry.presentedFrames = metadata.presentedFrames;
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
 * Query. The `<video>` element for `src` if it has a current frame, else null.
 * SYNC — this is what the overlay backends call on the paint path. A null means
 * "no drawable frame yet" (still loading, or a load error): draw nothing.
 *
 * @param {string} src the source string
 * @returns {HTMLVideoElement|null}
 * @example getVideoV8("never-requested") // null
 */
export function getVideoV8(src) {
  const entry = registry.get(src);
  if (!entry || entry.status === "error") return null;
  return entry.el.readyState >= HAVE_CURRENT_DATA ? entry.el : null;
}

/**
 * Query. A monotonic marker that changes exactly when `src` presents a NEW
 * decoded frame: the rVFC presentedFrames count, falling back to currentTime
 * before the first rVFC tick or where rVFC is unsupported. The WebGL2 backend
 * re-uploads a texture ONLY when this changes, so a repaint burst (pan/drag) that
 * outruns the ~30fps decode never re-uploads the SAME frame at paint-rate.
 * Returns 0 for a src with no element yet.
 *
 * @param {string} src the source string
 * @returns {number}
 * @example videoV8FrameMarker("never-requested") // 0
 */
export function videoV8FrameMarker(src) {
  const entry = registry.get(src);
  if (!entry) return 0;
  if (entry.presentedFrames > 0) return entry.presentedFrames;
  return entry.el.currentTime;
}

/**
 * Command. Off-view playback gate: pause every element whose src is NOT in
 * `activeRefs`, and resume (honoring autoplay intent) those that ARE. The editor
 * calls this each paint with the POST-cull visible video sources, so a clip
 * off-screen or on another slide has its browser decode STOPPED. pause()/play()
 * preserves currentTime, so re-entry RESUMES from where it left off; toggles fire
 * only on a real paused-state change (no per-paint thrash). No-op for a src with
 * no element yet.
 *
 * @param {Iterable<string>} activeRefs the currently visible video source strings
 * @example // setActiveVideoV8Refs(["clip.mp4"]) // pauses every other V8 video, (re)plays clip.mp4
 */
export function setActiveVideoV8Refs(activeRefs) {
  const active = activeRefs instanceof Set ? activeRefs : new Set(activeRefs);
  for (const [src, entry] of registry) {
    if (entry.status === "error") continue;
    const el = entry.el;
    if (active.has(src)) {
      if (el.autoplay && el.paused) el.play?.().catch((e) => console.error(`PowerRP videoV8Registry: resume of "${truncateSrc(src)}" was blocked — ${e?.message ?? e}`));
    } else if (!el.paused) {
      el.pause?.();
    }
  }
}

/**
 * Command. Subscribes to frame-advance events (a src got its first frame,
 * errored, or a playing clip painted a new frame). The editor's paint loop is
 * reactive, so a PLAYING video needs this to keep repainting. Returns an
 * unsubscribe function.
 *
 * @param {(src: string) => void} cb called with the src that advanced
 * @returns {() => void} unsubscribe
 * @example // const off = onVideoV8Frame(() => scheduleRepaint()); ... off();
 */
export function onVideoV8Frame(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Query. A src's live playback state — {paused, currentTime, presentedFrames} —
 * or null if it has no element yet. A diagnostic so a probe can assert the
 * off-view gate PAUSED a culled clip and RESUMED it (from its prior currentTime)
 * on re-entry.
 *
 * @param {string} src the source string
 * @returns {{paused: boolean, currentTime: number, presentedFrames: number}|null}
 * @example videoV8PlaybackState("never-requested") // null
 */
export function videoV8PlaybackState(src) {
  const entry = registry.get(src);
  if (!entry) return null;
  const el = entry.el;
  return { paused: el.paused, currentTime: el.currentTime, presentedFrames: entry.presentedFrames };
}

/**
 * Command. Tears down every cached element (pause + drop src so the browser frees
 * the buffer) and forgets all state. For tests that need a clean registry.
 * Listeners are kept (they are wiring, not data).
 */
export function resetVideoV8Registry() {
  for (const entry of registry.values()) {
    try {
      entry.el.pause?.();
      entry.el.removeAttribute("src");
      entry.el.load?.();
    } catch (e) {
      // Teardown of a half-initialized element can throw in odd states; report
      // (never silent) but keep clearing the rest.
      console.error(`PowerRP videoV8Registry: teardown of a cached element failed — ${e?.message ?? e}`);
    }
  }
  registry.clear();
}
