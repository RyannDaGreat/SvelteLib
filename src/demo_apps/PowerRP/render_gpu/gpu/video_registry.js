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

import { isMissingAssetUrl } from "../../core/asset_ref.js";
import { registerMissing } from "./missing_media.js";
import { truncate } from "../../core/report.js"; // THE shared log elision

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
 * autoplay intent). The editor calls this each paint with the currently VISIBLE
 * video sources (the POST-cull set), so a clip that is off-view — off SCREEN
 * (panned away) OR on another slide — has its browser decode STOPPED (no CPU
 * "when we're not looking at it") and stops pumping onVideoFrame. pause()/play()
 * preserves currentTime, so re-entering view RESUMES from where it left off, not a
 * restart; the toggles fire only on a real paused-state change, so no per-paint
 * thrash. Scrub elements (a separate, always-paused registry) are untouched.
 * No-op for a src with no element yet.
 *
 * @param {Iterable<string>} activeRefs the currently visible video source strings
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
  // The holds are scope-keyed REFERENCES into that LRU, so they must be dropped in
  // the same pass — a pin into a freed Image would hand a dead texture to a later
  // draw.
  for (const k of scrubHeld.keys()) if (k.startsWith(prefix)) scrubHeld.delete(k);
  for (const k of scrubFailed.keys()) if (k.startsWith(prefix)) scrubFailed.delete(k);
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
 * Query. Every src whose element exists but has no drawable frame yet — the
 * videoStatus === "loading" set. The TWIN of image_registry.pendingImageRefs,
 * and it exists for the same one-shot consumer: the headless render-job worker
 * must not write a PNG while a clip is still buffering its first frame, because
 * a player with no frame draws NOTHING and the hole would ship silently. An
 * errored src is NOT pending (it will never resolve; it was already reported).
 *
 * @example // nothing requested yet
 * pendingVideoSrcs() // []
 * @example // ensureVideo(url) just created the element
 * // pendingVideoSrcs() // [url]   — and [] once "loadeddata" fires or it errors
 */
export function pendingVideoSrcs() {
  const srcs = [];
  for (const src of registry.keys()) if (videoStatus(src) === "loading") srcs.push(src);
  return srcs;
}

/**
 * Query. Every video src — PLAYER or SCRUBBER — whose load PERMANENTLY FAILED.
 * The COUNTERPART of pendingVideoSrcs, and the reason it has to exist separately:
 * "pending" answers "wait longer", and an errored src is precisely the one that
 * will never resolve, so it is deliberately excluded there.
 *
 * WHAT IT IS FOR (R6-12.1, measured). A one-shot render used those two answers as
 * a partition — nothing pending ⇒ the frame is whole — and an errored src falls in
 * neither half. `sceneMedia` therefore left the ref out of the media map,
 * `paint_skia`'s `if (!img) break;` skipped the quad, and the worker wrote a frame
 * with a hole in it and EXITED 0. Reproduced: a `video` + `video_scrub` deck whose
 * src 404s renders to bare camera background, twice, at exit 0
 * (.frenzy/round6/W5A-shots/badsrc_hole.png). That is the whole of "the video
 * widget does not appear in Render Center output": not a missing await, a missing
 * FAILURE. `web/renderJobPage.js settledFrame` reads this and refuses the frame.
 *
 * BOTH registries in one answer, because the caller must not have to know there
 * are two — a hand-maintained union at the call site is the mirror that rots. The
 * forward reference to `scrubRegistry` (declared in the scrubber section below) is
 * the same shape `disposeUploaderScope` already uses.
 *
 * @returns {string[]} the failed srcs; a src used by BOTH a player and a scrubber
 *   is listed once
 *
 * @example // nothing requested yet
 * failedVideoSrcs() // []
 * @example // after ensureVideo("/asset/Gone/nope.mp4") errors
 * // failedVideoSrcs() // ["/asset/Gone/nope.mp4"]
 */
export function failedVideoSrcs() {
  const srcs = new Set();
  for (const [src, entry] of registry) if (entry.status === "error") srcs.add(src);
  for (const [src, entry] of scrubRegistry) if (entry.status === "error") srcs.add(src);
  return [...srcs];
}

/**
 * Query. A player element's live playback state — {paused, currentTime,
 * presentedFrames} — or null if `src` has no element yet. A diagnostic (like
 * videoUploadCount) so a probe can assert the off-view playback gate actually
 * PAUSED a culled clip and RESUMED it (from its prior currentTime) on re-entry.
 *
 * @example videoPlaybackState("nope://x") // null
 * @example // videoPlaybackState("clip.mp4") // {paused: false, currentTime: 1.2, presentedFrames: 36}
 */
export function videoPlaybackState(src) {
  const entry = registry.get(src);
  if (!entry) return null;
  const el = entry.el;
  return { paused: el.paused, currentTime: el.currentTime, presentedFrames: entry.presentedFrames };
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

  // THE RESOLVER ALREADY SAID THIS NAMES NOTHING. Registering it as "error"
  // WITHOUT an element is the point: the sentinel is a fetchable data: URI, so
  // assigning it to el.src loads FINE and then fails decode as "MediaError code
  // 4: Format error" — a sentence about a corrupt clip, for a clip that is
  // simply absent. Reported once (the entry latches, and ensureVideo returns
  // early ever after) and getVideo() answers null, which is already the paint
  // path's "no frame" contract, so the missing-media affordance draws normally.
  if (isMissingAssetUrl(src)) return registerMissing(registry, src, "ensureVideo");

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
//     exact (ref, time, wrap) if decoded, ELSE that source's most recently
//     decoded frame (the HOLD), else null. Kicks a COALESCED async seek on a
//     miss; notify() nudges a repaint when it lands.
//   requestScrubFrame(ck, ref, t, wrap) — ASYNC: seeks + awaits + caches the
//     frame, resolving to the Image (or null on failure). The one-shot pixel
//     paths (web/gpuService.js: thumbnails / PNG export / the puppeteer render
//     hook) AWAIT this BEFORE painting, so their output is deterministic.
// Unlike the player's per-paint frames, scrub frames are CACHED (a given
// (ref, time) frame is static) in a bounded LRU — during a live tween `time`
// sweeps continuously, so an unbounded cache would leak CanvasKit Images.
//
// ── WHAT A LIVE GESTURE NEEDS THAT A ONE-SHOT RENDER DOES NOT ─────────────────
// This path first served both consumers with one rule ("no exact frame ⇒ draw
// nothing"). That is right for a one-shot render, which AWAITS its frames, and
// wrong for a DRAG or a tween, which asks for a new time every paint and can never
// have the exact frame ready: the sync paint drew NOTHING for a not-yet-decoded
// frame and repainted when the seek landed, so the widget alternated blank/frame/
// blank/frame — the reported FLICKER (measured: 153 of 154 captured frames of a
// 2 s scrub were blank). Two mechanisms fix it, and they touch ONLY the LIVE path:
//   HOLD  — a miss draws the source's most recently DECODED frame (pinned in the
//     LRU) instead of nothing, so a scrub shows a slightly stale frame of the right
//     clip and snaps to the exact one when it lands (getScrubFrame). A few ms of a
//     stale frame beats a hole.
//   COALESCE — a live request that is superseded before it starts is DROPPED, so
//     the decoder always works on the time being asked for NOW, while the LAST
//     request of a gesture is always decoded (kickLiveScrubFrame).
// The AWAITED path (requestScrubFrame) keeps its exact-every-frame semantics
// untouched, because that is what makes an export reproducible: holding a stale
// frame in a deterministic path would make its pixels depend on DECODE TIMING,
// which pure(document, slide, alpha) forbids. This is the same preview-vs-settled
// split the rest of the app uses, and it is the discipline the V5 scrub path
// (render_gpu/skia/video_v5.js) proved first — mirrored here rather than shared,
// because that module is a deliberately standalone A/B alternative that does not
// import this one (and this one must not import it either).

import { scrubFrameKey } from "../ir.js";

/** src → {status, el, error, ready:Promise, chain:Promise, live, pumpQueued} for
 * the paused scrub decoders (SEPARATE from `registry` so the player never fights
 * them). `live`/`pumpQueued` are the LATEST-WINS seek coalescer (see
 * kickLiveScrubFrame). */
const scrubRegistry = new Map();

/** LRU cache key(scopedScrubKey) → CanvasKit.Image. Bounded: a live scrub sweeps
 * `time` continuously, so old frames must evict (and be .delete()d) or the wasm
 * heap leaks. Insertion-ordered Map ⇒ first key is the least-recently-used.
 * THE SOLE OWNER of every decoded scrub Image (scrubHeld only points into it). */
const scrubCache = new Map();

/** key → in-flight Promise<Image|null> — dedups concurrent requests for the
 * SAME frame (N synced scrubbers → ONE seek). */
const scrubInflight = new Map();

/** scopedHoldKey → the scrubCache key currently PINNED as that (scope, source)'s
 * HOLD: its most recently DECODED frame, drawn while a newer time is still
 * decoding so a live scrub never shows emptiness. A pin is a REFERENCE into
 * scrubCache, never a second owner — eviction skips pinned keys
 * (evictScrubFrames) so the outgoing frame stays alive until a newer decode
 * replaces it as the pin, and the LRU still performs the one .delete(). */
const scrubHeld = new Map();

/** scopedScrubKey → the message of a seek/decode that FAILED. Such a frame is
 * never held: a hold that can never resolve would make the drawn pixels depend on
 * cache history rather than on the document, and "stale forever" is a worse defect
 * than an honest empty quad. It draws nothing (exactly as this path behaved before
 * it grew a hold) and is not re-requested — the failure was already reported
 * LOUDLY, and this module's contract is that a failure is never retried silently. */
const scrubFailed = new Map();

/** Max decoded scrub frames kept at once. Comfortably exceeds the distinct
 * (source, time) frames a single scene realistically shows (a handful of
 * scrubbers), so a one-shot prepare pass never evicts a frame it still needs;
 * a live tween churns within this bound. The PINNED holds (at most one per
 * (scope, source)) are exempt, so the real ceiling is this cap plus the number of
 * live scrub sources. */
export const SCRUB_CACHE_CAP = 64;

/** Diagnostic counters for the scrub path (read via videoScrubStats). A live
 * gesture is a per-PAINT behaviour, so a probe needs the per-paint resolution
 * breakdown (exact / held / blank) and the request→decode ratio the coalescer
 * achieves; `blank` MUST stay at its first-frame-only value once a frame exists.
 * Cheap (integer adds on a path that already does a Map lookup). */
const _scrubStats = { requests: 0, exact: 0, held: 0, blank: 0, decoded: 0, dropped: 0 };

/** uploader.scopeId → how that scope's LAST paint resolved ("exact"/"held"/
 * "blank"/"failed"). PER SCOPE, not global, because the scopes answer different
 * questions and a global value would let one answer masquerade as the other: the
 * ON-SCREEN surface's GL scope is the one that must reach "exact" after a scrub
 * settles, while the offscreen "cpu" scope (thumbnails/export, which AWAITS its
 * frames) is "exact" by construction and would otherwise hide a stale canvas. */
const _scrubLastByScope = new Map();

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

/** Pure function. The HOLD key for an uploader + source: the (scope, source) pair
 * whose most recently decoded frame is pinned as the one to draw while a newer
 * time decodes. Scoped for the same reason scopedScrubKey is — a texture-backed
 * Image is usable only on its own GL context — and TIME-FREE, because the whole
 * point of the hold is that it survives the time changing. It is keyed on the
 * SOURCE, which is also what makes a stale frame unable to outlive its source: a
 * widget whose `src` changes asks under a DIFFERENT hold key, so it can never be
 * handed the previous video's picture (and a purged widget asks for nothing at
 * all).
 *
 * @example // scopedHoldKey({scopeId: "gl:0"}, "clip.mp4") // "gl:0|clip.mp4"
 */
function scopedHoldKey(uploader, ref) {
  return uploader.scopeId + "|" + ref;
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

  // The player's refusal (ensureVideo), applied to the SCRUB decoder. Both of
  // this function's consumers already `await entry.ready` and then bail on
  // `status === "error"`, so a refusal entry whose `ready` is already resolved
  // takes exactly that existing path — no new branch at either call site, and
  // the seek mutex (`chain`) is never armed for a clip that cannot decode.
  if (isMissingAssetUrl(src)) {
    registerMissing(scrubRegistry, src, "ensureVideo (scrub)");
    const entry = scrubRegistry.get(src);
    entry.ready = Promise.resolve();
    entry.chain = Promise.resolve();
    entry.live = null;
    entry.pumpQueued = false;
    return entry;
  }

  const el = document.createElement("video");
  el.muted = true;          // no audio on a scrubber (it is not playing)
  el.autoplay = false;      // NEVER plays — its time is document state
  el.loop = false;
  el.playsInline = true;
  el.crossOrigin = "anonymous";
  el.preload = "auto";
  // `live` = the ONE pending LIVE (fire-and-forget, droppable) frame request, or
  // null; `pumpQueued` = whether a pump task is already waiting on `chain` to claim
  // it. Together they are the latest-wins coalescer (kickLiveScrubFrame).
  const entry = { status: "loading", el, error: null, ready: null, chain: Promise.resolve(), live: null, pumpQueued: false };
  scrubRegistry.set(src, entry);

  // `ready` SETTLES ON EITHER OUTCOME — loaded OR failed. A FAILURE IS AN ANSWER,
  // NOT AN ABSENCE. It used to resolve only from `loadeddata`, so any src the
  // <video> rejects left `await entry.ready` in requestScrubFrame pending
  // FOREVER: measured as a render job blocked at 150 s having emitted zero
  // frames, with the `status === "error"` guard on the line right after that
  // await sitting unreachable. Worse, the default `BLANK_SRC` is a PNG data URI
  // that a <video> refuses outright (MediaError code 4), so an unsourced
  // scrubber was enough to hang a render — the deadlock was reachable without
  // any bad input from the author at all.
  let settleReady;
  entry.ready = new Promise((resolve) => { settleReady = resolve; });

  el.addEventListener("error", () => {
    entry.status = "error";
    const mediaErr = el.error;
    entry.error = new Error(mediaErr ? `MediaError code ${mediaErr.code}: ${mediaErr.message || "(no message)"}` : "unknown video error");
    console.error(`PowerRP video_registry (scrub): failed to load "${truncate(src)}" — ${entry.error.message}`);
    notify(src);
    settleReady();
  });

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
    settleReady();
  }, { once: true });
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
 * Command (async). THE seek-and-grab: parks `entry`'s paused decoder at `seekTime`
 * (resolved by `wrap`), grabs that one frame through the SAME
 * videoElementToSkiaImage helper the player uses (GPU texture upload with no
 * readback, or the guarded CPU fallback — no duplicated grab code), and caches it
 * under `key` — which also PINS it as the (scope, source) hold. Returns the cached
 * Image; throws on a failed seek/grab (the callers report loudly).
 *
 * Runs INSIDE the per-source seek mutex (`entry.chain`): one `<video>` can be
 * parked at only one time at a time, so both callers (the awaited
 * requestScrubFrame and the coalescing live pump) chain through it.
 */
async function decodeScrubFrame(entry, uploader, ref, seekTime, wrap, key) {
  const el = entry.el;
  const effective = resolveScrubTime(seekTime, el.duration, wrap);
  await seekTo(el, effective);
  const img = videoElementToSkiaImage(uploader, el);
  cacheScrubFrame(scopedHoldKey(uploader, ref), key, img);
  _scrubStats.decoded += 1;
  notify(ref);
  return img;
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
 * This is the EXACT / AWAITED path: every requested frame is decoded, never
 * coalesced away, because the one-shot pixel consumers (thumbnails, PNG export,
 * the headless render hook via browser_media.prepareSceneScrubFrames) await it and
 * then paint — dropping a request here, or letting a HOLD stand in for one, would
 * make those renders depend on decode timing instead of on the document. The live
 * editor paint uses getScrubFrame, which does both.
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
    // Serialize this seek behind any other in-flight seek on the SAME element.
    const run = entry.chain.then(() => decodeScrubFrame(entry, uploader, ref, seekTime, wrap, key));
    entry.chain = run.catch(() => {}); // keep the mutex alive past a failed seek
    return await run;
  })().catch((e) => {
    noteScrubFailure(key, ref, seekTime, e);
    return null;
  }).finally(() => scrubInflight.delete(key));

  scrubInflight.set(key, job);
  return job;
}

/**
 * Command. Registers (ref, seekTime, wrap) as the source's LATEST live frame
 * request and makes sure one pump task is queued behind the per-source seek mutex.
 *
 * LATEST-WINS COALESCING — the reason a live scrub feels smooth. A drag (or a
 * tween) emits one request per paint (~60/s), while a seek+grab costs tens of
 * milliseconds, so decoding every requested time would serialize a backlog whose
 * head is seconds behind the pointer: the widget would trail the gesture and only
 * "catch up" long after release. Instead a request that arrives while an older one
 * is still WAITING replaces it and is never decoded (counted as `dropped`), so the
 * decoder always works on the time the user is asking for NOW. The pump claims the
 * newest request only when it reaches the front of the mutex; any request made
 * after that claim queues exactly one more pump, so the FINAL request of a gesture
 * is always decoded — that is what makes the settled frame exact rather than merely
 * recent.
 *
 * ONE SLOT PER SOURCE, so two scrubbers on ONE source at DIFFERENT times supersede
 * each other and only one of them decodes per pump. That still converges by this
 * module's standing async contract — every decode notify()s, every repaint
 * re-requests whatever is still missing — so N such widgets settle in N repaints,
 * each showing the held frame until its own turn. (N scrubbers at the SAME time
 * share one key and never conflict; that is the frame-lockstep case.)
 */
function kickLiveScrubFrame(uploader, ref, seekTime, wrap, key) {
  const entry = ensureScrubElement(ref);
  if (entry.live) _scrubStats.dropped += 1; // superseded before it was ever decoded
  entry.live = { uploader, seekTime, wrap, key };
  if (entry.pumpQueued) return; // the queued pump will claim whatever the newest request is by then
  entry.pumpQueued = true;
  // The pump OWNS its failure (reported against the key it actually claimed, which
  // is not necessarily this call's `key`), so `run` never rejects and stays usable
  // as the mutex directly.
  entry.chain = entry.chain.then(async () => {
    await entry.ready; // load + warm-up seek; requests made while waiting are superseded above
    const job = entry.live;
    entry.live = null;
    entry.pumpQueued = false; // claimed — a later request queues a FRESH pump behind this decode
    if (!job || entry.status === "error") return null;
    try {
      return await decodeScrubFrame(entry, job.uploader, ref, job.seekTime, job.wrap, job.key);
    } catch (e) {
      noteScrubFailure(job.key, ref, job.seekTime, e);
      return null;
    }
  });
}

/** Command, UNTESTED. Reports a failed scrub frame LOUDLY and records the key as
 * failed, so the hold never covers for it and it is not silently re-requested every
 * paint. Untested because a seek/grab failure on an ALREADY-LOADED element could not
 * be induced from a probe; the sibling guard it feeds — a source that fails to LOAD
 * draws nothing rather than holding another clip's frame — IS covered
 * (tests/video_scrub_live_probe.js, the broken-source phase). */
function noteScrubFailure(key, ref, seekTime, err) {
  scrubFailed.set(key, String(err?.message ?? err));
  console.error(`PowerRP video_registry (scrub): frame at ${seekTime}s of "${truncate(ref)}" failed — ${err?.message ?? err}`);
}

/**
 * Query→build (near-pure: kicks a coalesced async seek on a miss). The SYNC
 * render-path accessor for the LIVE editor/presenter paint: the cached CanvasKit
 * Image for (ref, seekTime, wrap) if that exact frame is decoded, ELSE the
 * (scope, source)'s most recently decoded frame — the HOLD — else null. The caller
 * must NOT delete the Image (the LRU owns it).
 *
 * WHY IT HOLDS. A seek is async while the paint is sync, so during a scrub there is
 * always a window with no frame decoded at the requested time. Returning null there
 * made the widget draw NOTHING for that paint and a frame for the next — blank,
 * frame, blank, frame: the FLICKER. So mid-gesture this returns a slightly STALE
 * frame of the SAME clip and the pipeline snaps to the requested one when it lands.
 *
 * IT ALWAYS CONVERGES, so the determinism contract survives. The hold is only ever
 * returned on a MISS, the miss always kicks a request, and the coalescer guarantees
 * the LAST requested time is decoded (see kickLiveScrubFrame) — after which this
 * returns the exact frame. The one-shot pixel consumers never see a hold at all:
 * browser_media.prepareSceneScrubFrames AWAITS every scrub frame before painting, so
 * their lookups are exact hits. `pure(document, slide, alpha)` is unchanged.
 *
 * A stale frame can never OUTLIVE its source: the hold is keyed on (scope, source)
 * (scopedHoldKey), so a widget whose `src` changed asks under a different key and
 * gets a blank rather than the previous clip's picture, and a purged widget asks for
 * nothing at all.
 *
 * A null (no frame has EVER decoded for this source) still draws nothing — with
 * nothing decoded there is nothing honest to show, and a placeholder is forbidden.
 *
 * @param uploader a GPU or CPU uploader (makeGpuUploader / makeCpuUploader)
 * @example // getScrubFrame(gpuUploader, "clip.mp4", 1.5, "clamp") // null before the first decode, then the exact frame or the held one
 */
export function getScrubFrame(uploader, ref, seekTime, wrap) {
  const key = scopedScrubKey(uploader, ref, seekTime, wrap);
  _scrubStats.requests += 1;
  const cached = scrubCache.get(key);
  if (cached) { touchLru(key); return noteScrubResolution(uploader, "exact", cached); }
  // A frame that FAILED, or a source that failed to load, gets no hold and no retry
  // (see scrubFailed): a stale frame that can never resolve would silently replace a
  // reported failure with wrong-but-plausible pixels.
  if (scrubFailed.has(key) || scrubRegistry.get(ref)?.status === "error") return noteScrubResolution(uploader, "failed", null);
  kickLiveScrubFrame(uploader, ref, seekTime, wrap, key); // fire-and-forget; repaints on land
  const heldKey = scrubHeld.get(scopedHoldKey(uploader, ref));
  // The pin (evictScrubFrames) is what makes this lookup safe: a held key cannot
  // have been evicted + deleted out from under the draw.
  const held = heldKey === undefined ? undefined : scrubCache.get(heldKey);
  if (held) return noteScrubResolution(uploader, "held", held);
  return noteScrubResolution(uploader, "blank", null);
}

/** Command (returns `img` so callers stay one-liners). Records how this paint
 * resolved, globally and per uploader scope, then hands the Image back. */
function noteScrubResolution(uploader, how, img) {
  if (how === "exact") _scrubStats.exact += 1;
  else if (how === "held") _scrubStats.held += 1;
  else _scrubStats.blank += 1; // "blank" and "failed" both draw nothing
  _scrubLastByScope.set(uploader.scopeId, how);
  return img;
}

/** Command. Inserts `img` under `key`, PINS it as `holdKey`'s hold (superseding
 * that source's previous pin, which becomes evictable again), then evicts down to
 * the cap. */
function cacheScrubFrame(holdKey, key, img) {
  scrubCache.set(key, img);
  scrubHeld.set(holdKey, key);
  evictScrubFrames();
}

/** Command. Evicts least-recently-used frames (deleting each CanvasKit Image — the
 * LRU is their sole owner, so each is deleted exactly once) until the cache is back
 * within SCRUB_CACHE_CAP, SKIPPING every pinned hold: the frame a scrub is currently
 * showing must outlive the newer frame that has not decoded yet. Pins are at most
 * one per (scope, source), so the cache can exceed the cap only by that count, and
 * an all-pinned cache simply stops evicting rather than deleting a live frame. */
function evictScrubFrames() {
  const pinned = new Set(scrubHeld.values());
  for (const key of scrubCache.keys()) {
    if (scrubCache.size <= SCRUB_CACHE_CAP) return;
    if (pinned.has(key)) continue;
    const evicted = scrubCache.get(key);
    scrubCache.delete(key);
    evicted?.delete?.();
  }
}

/**
 * Query. The scrub path's diagnostic counters — a live gesture is a per-PAINT
 * behaviour, so a probe reads the per-paint resolution breakdown (`exact`/`held`/
 * `blank`) and the request→decode ratio the coalescer achieves (`decoded` vs
 * `dropped`). `blank` must stop rising once a source has decoded its first frame,
 * and `lastResolution[<the on-screen GL scope>]` must be "exact" once a scrub has
 * settled — that is the convergence check, and it is per scope precisely so the
 * offscreen "cpu" scope (always exact, since it awaits) cannot stand in for the
 * editor's. `cacheSize`/`pinned` prove the LRU + pins stay bounded.
 *
 * @example videoScrubStats().blank // 0 (before any scrub frame is requested)
 * @example videoScrubStats().lastResolution // {} (before any scrub frame is requested)
 * @returns {{requests,exact,held,blank,decoded,dropped,lastResolution,cacheSize,pinned,failed,inflight}}
 */
export function videoScrubStats() {
  return {
    ..._scrubStats,
    lastResolution: Object.fromEntries(_scrubLastByScope),
    cacheSize: scrubCache.size, pinned: scrubHeld.size, failed: scrubFailed.size, inflight: scrubInflight.size,
  };
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
    entry.live = null; // drop any coalesced request so a pump cannot seek a torn-down element
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
  scrubHeld.clear(); // references into the now-deleted Images
  scrubFailed.clear();
  scrubInflight.clear();
}
