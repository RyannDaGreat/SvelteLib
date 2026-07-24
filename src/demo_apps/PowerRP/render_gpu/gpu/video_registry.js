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
 * registry): a video is MOVING. Each render grabs the element's CURRENT frame
 * straight to a GPU texture (surface.makeImageFromTextureSource / updateTexture
 * FromSource — no CPU readback; see the SHARED VIDEO-FRAME GRAB below) — so the
 * registry hands back the live `<video>` element itself, and the browser's
 * playback clock advances the frame. The element owns playback (autoplay/loop/muted);
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

// ── THE SHARED VIDEO-FRAME GRAB (player + scrubber, one path) ─────────────────
// A <video> element's current frame becomes a CanvasKit Image through an
// "uploader". TWO uploaders, ONE grab helper (videoElementToSkiaImage):
//   • GPU (browser on-screen / presenter surface): uploads the element STRAIGHT
//     to a GL texture via surface.makeImageFromTextureSource — NO getImageData /
//     no CPU readback. This is THE perf fix: the old path did drawImage(el → 2D
//     canvas) → MakeImageFromCanvasImageSource, and that helper does a full-res
//     getImageData (GPU→CPU) then re-uploads to a texture — a GPU→CPU→GPU
//     roundtrip PER video PER paint (~8 MB each way at 1080p) that dropped the
//     editor from 120 fps to ~16-30. updateTextureFromSource refreshes the
//     texture in place (zero per-frame allocation on the reuse path).
//   • CPU (offscreen pixel service, headless/CLI): no GL surface, so it KEEPS the
//     drawImage → MakeImageFromCanvasImageSource readback. This is the GUARDED
//     fallback — reached only when there is genuinely no surface (a software
//     raster surface can't upload a texture), so a browser on-screen frame can
//     never silently take the slow route.
// Both the player (getSkiaVideoFrame, live per-paint) and the scrubber
// (requestScrubFrame, after its seek settles) grab through videoElementToSkiaImage
// — ONE source of truth for "video frame → CanvasKit Image".

/** A single reused offscreen 2D canvas for the CPU-uploader readback. Shared by
 * the player-CPU and scrubber-CPU grabs — the draw+read is synchronous
 * (MakeImageFromCanvasImageSource reads the pixels before returning), so
 * back-to-back grabs can share it without clobbering. */
let _frameCanvas = null;

/**
 * Query→build (per-scope stable). A GPU uploader bound to a CanvasKit surface.
 * `getSurface` is a THUNK (not the surface itself) so the uploader survives the
 * on-screen surface's recreation on resize — the GL context / GrContext (which
 * OWNS the textures) is stable across that; only the surface OBJECT is remade.
 * `scopeId` tags the Images this uploader creates: a texture-backed Image is
 * usable ONLY on its own GL context (WebGL textures aren't cross-context), so the
 * player + scrub caches key by scope to never hand one context's texture to
 * another.
 *
 * @param CanvasKit the shared browser CanvasKit module (also read by the media
 *   builder for still images — uploader.CanvasKit)
 * @param {() => (object|null)} getSurface reads the live on-screen CanvasKit Surface
 * @param {string} scopeId unique per GL context (per SkiaSurface instance)
 * @returns {{isGpu: true, scopeId: string, CanvasKit: object, grab: Function, refresh: Function}}
 * @example // makeGpuUploader(CK, () => surface, "gl:0").grab(videoEl) // texture-backed Image, no readback
 */
export function makeGpuUploader(CanvasKit, getSurface, scopeId) {
  const need = () => {
    const s = getSurface();
    if (!s) throw new Error(`makeGpuUploader: no surface for scope "${scopeId}" (the GL surface is null — a collapsed pane must not reach the grab path)`);
    return s;
  };
  return {
    isGpu: true,
    scopeId,
    CanvasKit,
    /** fresh texture-backed Image of el's CURRENT frame (throws on a null upload). */
    grab(el) {
      // makeImageFromTextureSource sizes from el.videoWidth/videoHeight by default
      // (CanvasKit prefers videoWidth/videoHeight for a <video>), so NO ImageInfo
      // and NO offscreen canvas are needed — the element uploads directly.
      const img = need().makeImageFromTextureSource(el);
      if (!img) throw new Error(`makeGpuUploader.grab: makeImageFromTextureSource returned null for a ${el.videoWidth}×${el.videoHeight} frame (scope "${scopeId}")`);
      return img;
    },
    /** refresh img's existing texture in place from el (reuse; no readback, no alloc). */
    refresh(img, el) {
      need().updateTextureFromSource(img, el);
    },
  };
}

/**
 * Query→build. A CPU uploader — the guarded readback fallback for surfaces with
 * NO GL texture path (the offscreen pixel service's software surface; headless
 * node). Produces context-PORTABLE Images (MakeImageFromCanvasImageSource reads
 * pixels to CPU), so all CPU consumers share ONE scope ("cpu").
 *
 * @param CanvasKit the shared CanvasKit module
 * @returns {{isGpu: false, scopeId: "cpu", CanvasKit: object, grab: Function}}
 * @example // makeCpuUploader(CK).grab(videoEl) // a portable CanvasKit Image (drawImage→MakeImageFromCanvasImageSource)
 */
export function makeCpuUploader(CanvasKit) {
  return {
    isGpu: false,
    scopeId: "cpu",
    CanvasKit,
    grab(el) {
      const w = el.videoWidth, h = el.videoHeight;
      if (!_frameCanvas) _frameCanvas = document.createElement("canvas");
      _frameCanvas.width = w; _frameCanvas.height = h;
      _frameCanvas.getContext("2d").drawImage(el, 0, 0, w, h); // the current frame at native resolution
      const img = CanvasKit.MakeImageFromCanvasImageSource(_frameCanvas);
      if (!img) throw new Error(`makeCpuUploader.grab: MakeImageFromCanvasImageSource returned null for a ${w}×${h} frame`);
      return img;
    },
  };
}

/**
 * Query→build. THE single video-frame grab: `videoEl`'s CURRENT frame → a
 * CanvasKit Image via `uploader` (GPU texture upload with no readback, or the
 * guarded CPU readback). Throws (never a silent null) when the element has no
 * frame dimensions or the upload fails — a hidden failure here would mask the
 * perf regression this replaces. BOTH the player and the scrubber grab through
 * this one function (single source of truth).
 *
 * @param uploader a GPU or CPU uploader (makeGpuUploader / makeCpuUploader)
 * @param videoEl an HTMLVideoElement with a decoded current frame
 * @returns a CanvasKit Image (texture-backed on GPU, CPU-portable on the fallback)
 * @example // videoElementToSkiaImage(gpuUploader, videoEl) // texture-backed Image of the current frame
 */
export function videoElementToSkiaImage(uploader, videoEl) {
  const w = videoEl.videoWidth, h = videoEl.videoHeight;
  if (!(w > 0 && h > 0)) throw new Error(`videoElementToSkiaImage: element has no frame dimensions (videoWidth×videoHeight = ${w}×${h})`);
  return uploader.grab(videoEl);
}

/** "scope|ref" → {img, w, h}: the ONE reused texture-backed player frame per GPU
 * uploader-scope per source. Refreshed in place each paint (updateTextureFromSource),
 * recreated only on a dimension change. REGISTRY-OWNED (never deleted by the
 * per-paint media release — that would destroy the reusable texture); freed by
 * disposeUploaderScope / resetVideoRegistry. CPU uploaders do NOT use this (their
 * frames are fresh + caller-deleted per paint). */
const _playerFrames = new Map();

/** Diagnostic counter (read via videoUploadCount): total <video>→GPU-texture
 * uploads (texImage2D — first creates AND in-place refreshes) since load. Lets a
 * probe confirm the frame-advance gate below keeps uploads at ~video-rate, not
 * paint-rate. Cheap (one integer add on the GPU path). */
let _uploadCount = 0;

/** Query. Total <video>→GPU-texture uploads so far (a diagnostic; see _uploadCount).
 * @example videoUploadCount() // 0  (before any GPU player/scrub frame is grabbed) */
export function videoUploadCount() { return _uploadCount; }

/** Pure function. The frame-advance marker for a player entry/element: the rVFC
 * `presentedFrames` count (increments once per DECODED frame — the precise "new
 * frame" signal), falling back to `currentTime` before the first rVFC tick or
 * where rVFC is unsupported. A texture is re-uploaded ONLY when this changes, so a
 * repaint burst (drag/pan) that outruns the ~30 fps decode does not re-upload the
 * SAME frame at paint-rate.
 *
 * @example playerFrameMarker({presentedFrames: 7}, {currentTime: 0.23}) // 7
 * @example playerFrameMarker({presentedFrames: 0}, {currentTime: 0.23}) // 0.23 (pre-first-frame fallback)
 */
function playerFrameMarker(entry, el) {
  if (entry && entry.presentedFrames > 0) return entry.presentedFrames;
  return el.currentTime;
}

/**
 * Query→build (near-pure: idempotent element create + a per-paint frame grab).
 * The player's CURRENT frame as a CanvasKit Image via `uploader`, or null when
 * there is no drawable frame yet (draw NOTHING — the async contract). On a GPU
 * uploader the Image is REUSED across paints (one texture per scope+ref, refreshed
 * in place ONLY when the frame advanced — playerFrameMarker) so there is zero
 * per-frame allocation AND no redundant re-upload during a repaint burst — and the
 * caller must NOT delete it (the registry owns it). On a CPU uploader it is a FRESH image the caller
 * deletes after the frame is painted (browser_media.release). ensureVideo is
 * kicked with the default playback flags (autoplay/loop/muted); onVideoFrame
 * drives the per-frame repaint that re-runs this.
 *
 * @param uploader a GPU or CPU uploader (makeGpuUploader / makeCpuUploader)
 * @param {string} ref the video source string
 * @example // getSkiaVideoFrame(gpuUploader, url) // null until a frame decodes, then a reused texture-backed Image
 */
export function getSkiaVideoFrame(uploader, ref) {
  ensureVideo(ref); // idempotent create with the player's default flags (autoplay/loop/muted)
  const el = getVideo(ref); // <video> with a current frame, or null (loading/error)
  if (!el) return null; // no drawable frame yet → draw nothing; onVideoFrame nudges repaints as frames land
  const w = el.videoWidth, h = el.videoHeight;
  if (!(w > 0 && h > 0)) return null; // frame dimensions not known yet → draw nothing
  if (!uploader.isGpu) return videoElementToSkiaImage(uploader, el); // CPU: fresh per paint (caller deletes)
  // GPU: reuse ONE texture-backed Image per (scope, ref); refresh it in place, but
  // ONLY when the frame actually ADVANCED (playerFrameMarker) — a repaint burst
  // (dragging/panning while a clip plays) would otherwise re-upload the SAME frame
  // at paint-rate, wasted GPU bandwidth that caps interaction fps.
  const key = uploader.scopeId + "|" + ref;
  const marker = playerFrameMarker(registry.get(ref), el);
  let slot = _playerFrames.get(key);
  if (slot && (slot.w !== w || slot.h !== h)) { slot.img.delete(); _playerFrames.delete(key); slot = null; } // dims changed → rebuild
  if (!slot) {
    slot = { img: videoElementToSkiaImage(uploader, el), w, h, marker };
    _playerFrames.set(key, slot);
    _uploadCount += 1; // videoElementToSkiaImage did a texImage2D
  } else if (slot.marker !== marker) {
    uploader.refresh(slot.img, el); // frame ADVANCED → re-upload; an unchanged frame reuses the texture as-is
    slot.marker = marker;
    _uploadCount += 1;
  }
  return slot.img; // registry-owned; the caller must NOT delete it
}

/**
 * Command. Perf gate on the PLAYER registry: pause every playing `<video>` whose
 * src is NOT in `activeRefs`, and resume those that ARE (honoring the clip's
 * autoplay intent). The editor calls this each paint with the CURRENT slide's
 * video sources, so a clip on ANOTHER slide (e.g. created by a thumbnail render)
 * stops decoding AND stops pumping onVideoFrame — killing the off-slide
 * repaint/decode storm that dropped the editor to ~16-30 fps. Scrub elements (a
 * separate, always-paused registry) are untouched. No-op for a src with no
 * element yet.
 *
 * @param {Iterable<string>} activeRefs the current slide's video source strings
 * @example // setActiveVideoRefs(["clip.mp4"]) // pauses every other player video, (re)plays clip.mp4
 */
export function setActiveVideoRefs(activeRefs) {
  const active = activeRefs instanceof Set ? activeRefs : new Set(activeRefs);
  for (const [src, entry] of registry) {
    if (entry.status === "error") continue;
    const el = entry.el;
    if (active.has(src)) {
      if (el.autoplay && el.paused) el.play?.().catch((e) => console.error(`PowerRP video_registry: resume of "${truncate(src)}" was blocked — ${e?.message ?? e}`));
    } else if (!el.paused) {
      el.pause?.();
    }
  }
}

/**
 * Command. Frees the texture-backed player + scrub Images created under a GPU
 * uploader's `scopeId`, to be called BEFORE its GL context is torn down
 * (SkiaSurface.dispose) — a later eviction .delete() on a dead context would
 * fault the wasm heap. Deletes and forgets every _playerFrames / scrubCache entry
 * tagged with the scope. No-op for the "cpu" scope's portable images (they carry
 * no GL context lifetime, and the shared CPU scope outlives any one job).
 *
 * @param {string} scopeId the disposed uploader's scope tag
 */
export function disposeUploaderScope(scopeId) {
  const prefix = scopeId + "|";
  for (const [k, slot] of _playerFrames) if (k.startsWith(prefix)) { slot.img.delete?.(); _playerFrames.delete(k); }
  for (const [k, img] of scrubCache) if (k.startsWith(prefix)) { img?.delete?.(); scrubCache.delete(k); }
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
  // presentedFrames: the rVFC decoded-frame counter (the frame-advance gate in
  // getSkiaVideoFrame reads it so a paint burst doesn't re-upload the same frame).
  const entry = { status: "loading", el, error: null, presentedFrames: 0 };
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
  // keeps nudging. Its metadata.presentedFrames is the decoded-frame counter the
  // frame-advance gate (playerFrameMarker) uses to skip redundant texture uploads.
  // Where unsupported, "timeupdate" (coarser, but real) drives repaints as
  // playback advances (the gate then falls back to currentTime).
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

/** Pure function. The scrub LRU key for an uploader: the (ref, time, wrap) frame
 * key PREFIXED by the uploader scope, because a texture-backed scrub Image is
 * usable only on its OWN GL context (a CPU uploader's images are portable and
 * share the single "cpu" scope). The media-map key paint_skia reads is still the
 * UNSCOPED scrubFrameKey (browser_media re-keys) — this scope tag is a CACHE
 * concern only.
 *
 * @example // scopedScrubKey({scopeId: "gl:0"}, "clip.mp4", 1.5, "clamp") // "gl:0|clip.mp4@1.5#clamp"
 */
function scopedScrubKey(uploader, ref, seekTime, wrap) {
  return uploader.scopeId + "|" + scrubFrameKey(ref, seekTime, wrap);
}

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
 * player frame). After the seek settles the frame is grabbed through the SAME
 * videoElementToSkiaImage helper the player uses (GPU texture upload with no
 * readback, or the guarded CPU fallback) — no duplicated grab code.
 *
 * @param uploader a GPU or CPU uploader (makeGpuUploader / makeCpuUploader); its
 *   scope keys the LRU entry, since a texture-backed Image is context-bound
 */
export async function requestScrubFrame(uploader, ref, seekTime, wrap) {
  const key = scopedScrubKey(uploader, ref, seekTime, wrap);
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
    // Serialize this seek behind any other in-flight seek on the SAME element,
    // then grab the parked frame through the shared helper (no readback on GPU).
    const run = entry.chain.then(async () => {
      await seekTo(el, effective);
      return videoElementToSkiaImage(uploader, el);
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
 * @param uploader a GPU or CPU uploader (makeGpuUploader / makeCpuUploader)
 * @example // getScrubFrame(gpuUploader, "clip.mp4", 1.5, "clamp") // null until decoded, then the cached frame
 */
export function getScrubFrame(uploader, ref, seekTime, wrap) {
  const key = scopedScrubKey(uploader, ref, seekTime, wrap);
  const cached = scrubCache.get(key);
  if (cached) { touchLru(key); return cached; }
  requestScrubFrame(uploader, ref, seekTime, wrap); // fire-and-forget; repaints on land
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
  // Free every reused player-frame texture Image (all scopes) — they are
  // registry-owned (the per-paint media release never deletes them).
  for (const slot of _playerFrames.values()) slot.img?.delete?.();
  _playerFrames.clear();
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
