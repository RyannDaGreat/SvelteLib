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

// ── THE SCRUBBER PATH (deterministic frame-at-time) ───────────────────────────
// The PLAYER above hands back a live <video> whose playback clock advances the
// frame. The SCRUBBER is the opposite: it PARKS a paused decoder at an exact
// time and awaits that one frame. It therefore needs its OWN elements — a
// player and a scrubber sharing one source must not fight over currentTime — so
// scrub elements live in a SEPARATE registry (never autoplay, never loop).
//
// The render path is sync-shaped but a seek is async, so this mirrors the image
// pipeline's async contract with a CACHE:
//   getScrubFrame(ck, ref, t, wrap)  — SYNC: the cached CanvasKit.Image for that
//     exact (ref, time, wrap) if decoded, else null AFTER kicking the async seek
//     (draw nothing this frame; notify() nudges a repaint when it lands).
//   requestScrubFrame(ck, ref, t, wrap) — ASYNC: seeks + awaits + caches the
//     frame, resolving to the Image (or null on failure). The one-shot pixel
//     paths (web/gpuService.js: thumbnails / PNG export / the puppeteer render
//     hook) AWAIT this BEFORE painting, so their output is deterministic.
// Unlike the player's per-paint frames, scrub frames are CACHED (a given
// (ref, time) frame is static) in a bounded LRU — during a live tween `time`
// sweeps continuously, so an unbounded cache would leak CanvasKit Images.

import { scrubFrameKey } from "../ir.js";

/** src → {status, el, error, ready:Promise, chain:Promise} for the paused
 * scrub decoders (SEPARATE from `registry` so the player never fights them). */
const scrubRegistry = new Map();

/** LRU cache key(scrubFrameKey) → CanvasKit.Image. Bounded: a live scrub sweeps
 * `time` continuously, so old frames must evict (and be .delete()d) or the wasm
 * heap leaks. Insertion-ordered Map ⇒ first key is the least-recently-used. */
const scrubCache = new Map();

/** key → in-flight Promise<Image|null> — dedups concurrent requests for the
 * SAME frame (N synced scrubbers → ONE seek). */
const scrubInflight = new Map();

/** Max decoded scrub frames kept at once. Comfortably exceeds the distinct
 * (source, time) frames a single scene realistically shows (a handful of
 * scrubbers), so a one-shot prepare pass never evicts a frame it still needs;
 * a live tween churns within this bound. */
export const SCRUB_CACHE_CAP = 64;

/** Seeking exactly to `duration` is undefined (past the last frame); back off a
 * hair so the last frame is what "the end" resolves to. Seconds. */
export const SCRUB_END_EPSILON = 1e-3;

/** A reused offscreen 2D canvas for the scrub frame grab (same reasoning as
 * `_frameCanvas`: the draw+read is synchronous, so it can be shared). */
let _scrubCanvas = null;

/**
 * Pure function. Resolves a requested scrub time against the real media
 * duration + wrap mode. "clamp" holds [0, duration); "loop" wraps modulo the
 * duration. An unknown duration (metadata not loaded / streaming) best-effort
 * clamps to >= 0. Kept pure + exported so the mapping is unit-testable without
 * a <video>.
 *
 * @example resolveScrubTime(1.5, 3, "clamp") // 1.5
 * @example resolveScrubTime(5, 3, "clamp") // 2.999  (clamped to just under the end)
 * @example resolveScrubTime(-1, 3, "clamp") // 0
 * @example resolveScrubTime(4, 3, "loop") // 1  (4 mod 3)
 * @example resolveScrubTime(-1, 3, "loop") // 2  (wraps positive)
 */
export function resolveScrubTime(t, duration, wrap) {
  const time = Number.isFinite(t) ? t : 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, time);
  const end = Math.max(0, duration - SCRUB_END_EPSILON);
  if (wrap === "loop") {
    const m = ((time % duration) + duration) % duration;
    return Math.min(m, end);
  }
  return Math.min(Math.max(0, time), end);
}

/**
 * Command (near-pure: idempotent). Ensures a PAUSED scrub <video> exists for
 * `src`. Separate from ensureVideo (the player) so the two never fight over
 * currentTime. `entry.ready` resolves after the element has loaded AND a warm-up
 * seek has primed the decoder — the FIRST seek after load decodes a black frame
 * (a cold-decoder race proven in prototyping), so a throwaway warm-up seek to
 * mid-clip fires before any real grab. Returns the entry.
 */
function ensureScrubElement(src) {
  if (typeof src !== "string" || src.length === 0)
    throw new Error(`ensureScrubElement: src must be a non-empty string, got ${JSON.stringify(src)}`);
  const existing = scrubRegistry.get(src);
  if (existing) return existing;

  const el = document.createElement("video");
  el.muted = true;          // no audio on a scrubber (it is not playing)
  el.autoplay = false;      // NEVER plays — its time is document state
  el.loop = false;
  el.playsInline = true;
  el.crossOrigin = "anonymous";
  el.preload = "auto";
  const entry = { status: "loading", el, error: null, ready: null, chain: Promise.resolve() };
  scrubRegistry.set(src, entry);

  el.addEventListener("error", () => {
    entry.status = "error";
    const mediaErr = el.error;
    entry.error = new Error(mediaErr ? `MediaError code ${mediaErr.code}: ${mediaErr.message || "(no message)"}` : "unknown video error");
    console.error(`PowerRP video_registry (scrub): failed to load "${truncate(src)}" — ${entry.error.message}`);
    notify(src);
  });

  entry.ready = new Promise((resolve) => {
    el.addEventListener("loadeddata", async () => {
      if (entry.status !== "error") entry.status = "ready";
      // WARM-UP: prime the cold decoder with one throwaway seek to a NON-ZERO
      // time (guaranteed to fire `seeked`, unlike re-seeking to the current 0),
      // so every real grab below is frame-accurate rather than black.
      try {
        const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        await seekTo(el, dur > 0 ? dur / 2 : 0);
      } catch (e) {
        console.error(`PowerRP video_registry (scrub): warm-up seek of "${truncate(src)}" failed — ${e?.message ?? e}`);
      }
      notify(src);
      resolve();
    }, { once: true });
  });
  el.src = src;
  el.load();
  return entry;
}

/**
 * Command (async). Seeks `el` to `t` and resolves once the target frame is
 * decoded. Uses the spec-reliable `el.seeking` flag: assigning currentTime sets
 * `seeking` true iff a real seek is needed, so we await `seeked` only then (and
 * grab immediately when the decoder is already parked there — re-seeking to the
 * current time would never fire `seeked` and would hang). rVFC is deliberately
 * NOT used: a PAUSED element never presents a frame headless, so rVFC never
 * fires (proven — it hangs). Rejects on the element's error event.
 */
function seekTo(el, t) {
  return new Promise((resolve, reject) => {
    const onErr = () => { cleanup(); reject(new Error("video error during seek")); };
    const onSeeked = () => { cleanup(); resolve(); };
    const cleanup = () => { el.removeEventListener("seeked", onSeeked); el.removeEventListener("error", onErr); };
    el.addEventListener("error", onErr, { once: true });
    el.currentTime = t;
    if (el.seeking) el.addEventListener("seeked", onSeeked);
    else { cleanup(); resolve(); } // already parked at t — no seek, frame is current
  });
}

/**
 * Query→build (async). The decoded CanvasKit Image for `ref` at exactly
 * `seekTime` (resolved by `wrap`), caching it in the LRU. Dedups concurrent
 * identical requests, and SERIALIZES seeks per source (one <video> can only be
 * at one time at a time). Resolves null on load/seek/decode failure (reported
 * loudly, never silent). The caller MUST NOT delete the returned Image — the
 * LRU owns its lifetime (a scrub frame is reused across paints, unlike a
 * player frame).
 *
 * @param CanvasKit the shared CanvasKit module (the Image binds to it)
 */
export async function requestScrubFrame(CanvasKit, ref, seekTime, wrap) {
  const key = scrubFrameKey(ref, seekTime, wrap);
  const cached = scrubCache.get(key);
  if (cached) { touchLru(key); return cached; }
  const pending = scrubInflight.get(key);
  if (pending) return pending;

  const entry = ensureScrubElement(ref);
  const job = (async () => {
    await entry.ready;
    if (entry.status === "error") return null;
    const el = entry.el;
    const effective = resolveScrubTime(seekTime, el.duration, wrap);
    // Serialize this seek behind any other in-flight seek on the SAME element.
    const run = entry.chain.then(async () => {
      await seekTo(el, effective);
      const w = el.videoWidth, h = el.videoHeight;
      if (!(w > 0 && h > 0)) throw new Error("scrub frame has no dimensions");
      if (!_scrubCanvas) _scrubCanvas = document.createElement("canvas");
      _scrubCanvas.width = w; _scrubCanvas.height = h;
      _scrubCanvas.getContext("2d").drawImage(el, 0, 0, w, h);
      const img = CanvasKit.MakeImageFromCanvasImageSource(_scrubCanvas);
      if (!img) throw new Error("MakeImageFromCanvasImageSource returned null");
      return img;
    });
    entry.chain = run.catch(() => {}); // keep the chain alive past a failed seek
    const img = await run;
    cacheScrubFrame(key, img);
    notify(ref);
    return img;
  })().catch((e) => {
    console.error(`PowerRP video_registry (scrub): frame at ${seekTime}s of "${truncate(ref)}" failed — ${e?.message ?? e}`);
    return null;
  }).finally(() => scrubInflight.delete(key));

  scrubInflight.set(key, job);
  return job;
}

/**
 * Query→build (near-pure: kicks an async seek on a miss). The SYNC render-path
 * accessor: the cached CanvasKit Image for (ref, seekTime, wrap) if decoded,
 * else null — kicking requestScrubFrame so the frame lands and notify() nudges
 * a repaint (the image pipeline's async contract, applied to seeks). Draw
 * NOTHING for a null (never a placeholder). The caller must NOT delete the
 * Image (the LRU owns it).
 *
 * @param CanvasKit the shared CanvasKit module
 * @example // getScrubFrame(CK, "clip.mp4", 1.5, "clamp") // null until decoded, then the cached frame
 */
export function getScrubFrame(CanvasKit, ref, seekTime, wrap) {
  const key = scrubFrameKey(ref, seekTime, wrap);
  const cached = scrubCache.get(key);
  if (cached) { touchLru(key); return cached; }
  requestScrubFrame(CanvasKit, ref, seekTime, wrap); // fire-and-forget; repaints on land
  return null;
}

/** Command. Inserts `img` under `key` and evicts the least-recently-used frame
 * (deleting its CanvasKit Image) when the cache exceeds SCRUB_CACHE_CAP. */
function cacheScrubFrame(key, img) {
  scrubCache.set(key, img);
  while (scrubCache.size > SCRUB_CACHE_CAP) {
    const oldest = scrubCache.keys().next().value;
    const evicted = scrubCache.get(oldest);
    scrubCache.delete(oldest);
    evicted?.delete?.();
  }
}

/** Command. Marks `key` most-recently-used (re-insert at the Map's tail). */
function touchLru(key) {
  const img = scrubCache.get(key);
  scrubCache.delete(key);
  scrubCache.set(key, img);
}

/**
 * Command. Tears down all cached elements (pause + drop the src so the browser
 * releases the buffer) and forgets all state. For tests that need a clean
 * registry; also the invalidation hook for a future mutable-source / flag-change
 * policy. Listeners are kept (they are wiring, not data). Also clears the
 * scrubber's elements + LRU frame cache (deleting the cached Images).
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
  for (const entry of scrubRegistry.values()) {
    try {
      entry.el.removeAttribute("src");
      entry.el.load?.();
    } catch (e) {
      console.error(`PowerRP video_registry (scrub): teardown failed — ${e?.message ?? e}`);
    }
  }
  scrubRegistry.clear();
  for (const img of scrubCache.values()) img?.delete?.();
  scrubCache.clear();
  scrubInflight.clear();
}
