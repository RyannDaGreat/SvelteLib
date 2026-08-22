/**
 * Video V5 registry — the MAIN-THREAD half of the off-main-thread video path
 * (its twin worker is render_gpu/skia/video_v5_worker.js). A FRESH, standalone
 * alternative to render_gpu/gpu/video_registry.js: it does NOT import or extend
 * that module — it owns its own `<video>` elements, its own worker, and its own
 * Skia texture cache, so the two paths can run side by side for an A/B.
 *
 * ── THE HYPOTHESIS (V5) ───────────────────────────────────────────────────────
 * The existing path uploads frames with texImage2D(<video>), whose YUV->RGBA
 * colour convert runs on the MAIN thread every frame — the cost that competes
 * with drag/pan input. V5 moves that convert to a Web Worker: the `<video>`
 * (which cannot live in a worker) stays on the main thread and owns playback, but
 * its frames are piped OUT via captureStream()->MediaStreamTrackProcessor, whose
 * `readable` (a ReadableStream<VideoFrame>) is TRANSFERRED to the worker. The
 * worker does createImageBitmap (the convert) and transfers back an already-RGBA
 * ImageBitmap; the main thread's only per-frame GPU work is texImage2D(bitmap) —
 * an upload of pre-converted pixels.
 *
 * ── MODES ─────────────────────────────────────────────────────────────────────
 *   worker (primary) — MediaStreamTrackProcessor + captureStream + Worker all
 *     present. The full off-main-thread pipeline above.
 *   main (fallback)  — any of those missing. requestVideoFrameCallback (or
 *     "timeupdate") drives createImageBitmap(<video>) ON the main thread. The
 *     read loop is on-main, but createImageBitmap still resolves its convert off
 *     the main thread, so this is a DEGRADED off-main-thread path, NOT a
 *     texImage2D(<video>) main-thread convert. Which mode is chosen is reported
 *     LOUDLY once (console.info) — never a silent fallback.
 *
 * ── THE FRAME (a per-src ImageBitmap) ─────────────────────────────────────────
 * The registry keeps the LATEST ImageBitmap per src (`entry.latest`) plus a
 * monotonic `entry.seq` (the frame-advance marker). getVideoV5Frame uploads it to
 * a Skia Image through the caller's uploader — reusing ONE texture-backed Image
 * per (GPU-scope, src) and refreshing it in place ONLY when `seq` advanced (so a
 * repaint burst that outruns the ~30 fps decode does not re-upload the SAME frame
 * at paint-rate — the V5 analogue of video_registry's playerFrameMarker). A newer
 * bitmap CLOSES the one it replaces (each bitmap closed exactly once — no leak).
 *
 * ── ZERO COST OFF-VIEW ────────────────────────────────────────────────────────
 * setActiveVideoV5Refs pauses every `<video>` NOT in the visible set. A paused
 * element stops feeding captureStream, so the worker's read() blocks (no frames,
 * no createImageBitmap, no CPU) — "no cost when we're not looking at it".
 * pause()/play() preserves currentTime, so re-entry RESUMES, not restarts.
 *
 * ── ASYNC CONTRACT (manifest F3) ──────────────────────────────────────────────
 * Element create + first-frame decode are async. getVideoV5Frame returns null
 * until a bitmap exists (draw NOTHING — never a placeholder); onVideoV5Frame
 * nudges the reactive editor to repaint as frames land. A load FAILURE is loud
 * (console.error) and leaves the src in "error" (never retried silently).
 *
 * Browser-only (needs <video>/createImageBitmap/Worker). The Node CLI never
 * imports it (it passes its own empty media map).
 *
 * Imports ONLY the shared pure IR key helper (scrubFrameKey) from ir.js — NOT
 * render_gpu/gpu/video_registry.js. The "standalone alternative" invariant above
 * is specifically that V5 does not depend on the CORE video registry, so the two
 * PLAYER + SCRUBBER paths stay independently A/B-swappable; a pure IR key is not
 * that dependency. The scrub section below deliberately RE-OWNS its infrastructure
 * (its own paused decoders, LRU, time-resolver) in the same spirit as the player
 * half re-owns HAVE_CURRENT_DATA/the uploader-reuse logic.
 *
 * THAT SENTENCE USED TO NAME `truncate` TOO, AND THAT PART WAS NOT INDEPENDENCE.
 * A log line's elision has nothing to do with A/B-swappability: this file elided a
 * src at 32 characters with no length suffix while six other modules elided the
 * same kind of string at 48/24 with one, so a reader comparing two console lines
 * about the same asset saw two different strings. It now uses core/report.js
 * truncate like everything else. Re-owning the DECODER is a design position;
 * re-owning the LOGGING was drift wearing that position's clothes.
 */

import { scrubFrameKey } from "../ir.js";
import { truncate } from "../../core/report.js"; // THE shared log elision; this file's own copy elided at 32 chars with no length, so one src read three ways in three files

/** src -> entry (see makeEntry). */
const registry = new Map();
/** worker id -> src, for routing worker messages back (a data-URI src is a poor
 *  postMessage key, and ids survive a src's element being rebuilt). */
const idToSrc = new Map();
/** "scope|src" -> {img, w, h, seq}: ONE reused texture-backed Image per GPU
 *  uploader-scope per src (refreshed in place; rebuilt on a dimension change).
 *  Registry-owned (freed by disposeVideoV5Scope / resetVideoV5Registry), NOT by
 *  the per-paint media release — mirrors video_registry._playerFrames. */
const playerImages = new Map();
/** Repaint subscribers (onVideoV5Frame); notified with the src whose frame advanced. */
const listeners = new Set();

let nextId = 1;
let _worker = null;
let _reportedMode = false;
/** Diagnostic: total ImageBitmap->GPU-texture uploads (create + in-place refresh)
 *  since load — a probe confirms the seq gate keeps this at ~video-rate. */
let _uploadCount = 0;

/** readyState threshold for a drawable current frame (HAVE_CURRENT_DATA). Named
 *  (not a bare 2) because the HTMLMediaElement constant isn't reliably global. */
const HAVE_CURRENT_DATA = 2;

/** Feature detection (evaluated lazily so a bare-import in a non-DOM context is
 *  harmless). Worker mode needs all three; else main-mode fallback. */
function caps() {
  const proto = typeof HTMLVideoElement !== "undefined" ? HTMLVideoElement.prototype : null;
  return {
    worker: typeof Worker !== "undefined",
    mstp: typeof MediaStreamTrackProcessor !== "undefined",
    captureStream: !!proto && typeof proto.captureStream === "function",
    rvfc: !!proto && typeof proto.requestVideoFrameCallback === "function",
  };
}

/** Query→build (lazy singleton). THE shared frame-extraction worker. Created on
 *  first need (never at import) so merely importing this module spawns no thread.
 *  Vite bundles the worker via the import.meta.url URL form. */
function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL("./video_v5_worker.js", import.meta.url), { type: "module" });
  _worker.onmessage = (e) => {
    const m = e.data;
    const src = idToSrc.get(m.id);
    const entry = src === undefined ? null : registry.get(src);
    if (!entry) { m.bitmap?.close(); return; } // stale (detached/reset) — drop the frame
    if (m.type === "error") { entry.status = "error"; console.error(`PowerRP video_v5 worker: ${m.message}`); return; }
    if (m.type === "frame") deliverBitmap(entry, m.bitmap, m.width, m.height);
  };
  _worker.onerror = (e) => console.error("PowerRP video_v5 worker crashed —", e.message || e);
  return _worker;
}

/** Command (reports the active pipeline mode ONCE — loud, never silent). */
function reportModeOnce(mode) {
  if (_reportedMode) return;
  _reportedMode = true;
  const c = caps();
  console.info(`PowerRP video_v5: frame pipeline mode = "${mode}" (Worker=${c.worker} MediaStreamTrackProcessor=${c.mstp} captureStream=${c.captureStream} rVFC=${c.rvfc}).`);
}

/** Pure-ish factory. A fresh registry entry for `src`. */
function makeEntry(src) {
  const el = document.createElement("video");
  el.src = src;
  el.loop = true; el.muted = true; el.autoplay = true; el.playsInline = true; el.preload = "auto";
  el.crossOrigin = "anonymous"; // let same-origin/CORS assets feed captureStream/createImageBitmap untainted
  return { src, status: "loading", el, id: nextId++, mode: null, pipelineStarted: false, latest: null, latestW: 0, latestH: 0, seq: 0, error: null };
}

/**
 * Command (idempotent element create + pipeline start; fire-and-forget). Safe to
 * call every paint — an existing src is a no-op. Creates the `<video>`, starts
 * autoplay, and (once it has data) starts the worker/main frame pipeline.
 *
 * @param {string} src the video source string (URL or data: URI)
 */
export function ensureVideoV5(src) {
  if (registry.has(src)) return;
  const entry = makeEntry(src);
  registry.set(src, entry);
  idToSrc.set(entry.id, src);
  entry.el.addEventListener("error", () => {
    entry.status = "error";
    console.error(`PowerRP video_v5: <video> failed to load "${truncate(src)}" — ${entry.el.error?.message ?? "unknown media error"}`);
  });
  const onReady = () => { if (entry.status !== "error") { entry.status = "ready"; startPipeline(entry); notify(src); } };
  if (entry.el.readyState >= HAVE_CURRENT_DATA) onReady();
  else entry.el.addEventListener("loadeddata", onReady, { once: true });
  entry.el.play?.().catch((e) => console.warn(`PowerRP video_v5: autoplay of "${truncate(src)}" was blocked — ${e?.message ?? e}`));
}

/** Command. Starts the frame pipeline for a ready entry (worker mode, else main). */
function startPipeline(entry) {
  if (entry.pipelineStarted) return;
  entry.pipelineStarted = true;
  const c = caps();
  if (c.worker && c.mstp && c.captureStream) {
    try {
      const stream = entry.el.captureStream();
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("captureStream() produced no video track");
      const proc = new MediaStreamTrackProcessor({ track });
      entry.mode = "worker";
      entry.stream = stream; entry.track = track;
      getWorker().postMessage({ type: "attach", id: entry.id, readable: proc.readable }, [proc.readable]);
      reportModeOnce("worker");
      return;
    } catch (err) {
      // A real capability gap (e.g. a tainted cross-origin source) — reported, then
      // the honest degraded off-main-thread path, never a silent main-thread convert.
      console.warn(`PowerRP video_v5: worker pipeline unavailable for "${truncate(entry.src)}" (${err?.message ?? err}); using main-thread createImageBitmap fallback.`);
    }
  }
  entry.mode = "main";
  reportModeOnce("main");
  startMainLoop(entry);
}

/** Command. Main-mode fallback loop: rVFC (or "timeupdate") -> createImageBitmap
 *  (<video>) on the main thread. The convert still resolves off-thread inside
 *  createImageBitmap; only the loop lives on-main. A paused (off-view) element
 *  presents no frames, so its pending rVFC never fires — this costs nothing
 *  off-view WITHOUT tearing the loop down (see the unconditional re-arm below). */
function startMainLoop(entry) {
  const el = entry.el;
  const c = caps();
  const tick = async () => {
    if (entry.status === "error") return;
    try {
      const bitmap = await createImageBitmap(el);
      deliverBitmap(entry, bitmap, bitmap.width, bitmap.height);
    } catch (err) {
      console.error(`PowerRP video_v5: createImageBitmap(<video>) failed for "${truncate(entry.src)}" — ${err?.message ?? err}`);
    }
    // Re-arm UNCONDITIONALLY. A pending rVFC on a paused element never fires
    // (paused = no frame presented = zero cost), so keeping ONE pending callback
    // across an off-view pause is free AND self-heals on resume. A prior
    // `!el.paused` guard here stranded the loop: if setActiveVideoV5Refs paused
    // the element WHILE this tick's `await createImageBitmap` was in flight, the
    // tick resolved paused and skipped the re-arm, leaving NO pending callback —
    // so on slide-return el.play() resumed playback (currentTime advanced) but no
    // tick ever ran again and the clip froze on its last frame until forced (the
    // "V5 slide-return freeze").
    if (c.rvfc) el.requestVideoFrameCallback(tick);
  };
  if (c.rvfc) el.requestVideoFrameCallback(tick);
  else el.addEventListener("timeupdate", tick);
}

/** Command. Stores a newly-arrived bitmap as the latest frame, closing the one it
 *  supersedes (so every bitmap is closed exactly once), bumps the frame-advance
 *  marker, and wakes repaint subscribers. */
function deliverBitmap(entry, bitmap, w, h) {
  entry.latest?.close(); // the previous frame is superseded; free it (no leak)
  entry.latest = bitmap;
  entry.latestW = w; entry.latestH = h;
  entry.seq += 1;
  notify(entry.src);
}

/** Command. Notifies repaint subscribers that `src`'s frame advanced. */
function notify(src) { for (const cb of listeners) cb(src); }

/**
 * Query→build. Uploads an ALREADY-RGBA ImageBitmap to a fresh CanvasKit Image via
 * `uploader` — the colour convert already happened off the main thread (in the
 * worker, or in createImageBitmap for the main/scrub paths), so this is a plain
 * texture upload (GPU) / pixel wrap (CPU), no convert on this thread. GPU:
 * makeImageFromTextureSource(bitmap). CPU: MakeImageFromCanvasImageSource(bitmap)
 * (an ImageBitmap is a CanvasImageSource). Throws (never a silent null) on a null
 * upload. The caller owns the returned Image's lifetime.
 *
 * @param uploader a GPU or CPU uploader (video_registry.makeGpuUploader / makeCpuUploader)
 * @param bitmap an ImageBitmap of a decoded frame
 */
function uploadBitmap(uploader, bitmap) {
  if (uploader.isGpu) return uploader.grab(bitmap);
  const img = uploader.CanvasKit.MakeImageFromCanvasImageSource(bitmap);
  if (!img) throw new Error(`video_v5: MakeImageFromCanvasImageSource returned null for a ${bitmap.width}×${bitmap.height} frame`);
  return img;
}

/**
 * Query→build (near-pure: idempotent ensure + a per-paint upload). The V5 player's
 * current frame as a CanvasKit Image via `uploader`, or null when no frame exists
 * yet (draw NOTHING — the async contract). GPU: a REUSED texture-backed Image per
 * (scope, src), refreshed in place ONLY when the frame advanced (seq) — the caller
 * must NOT delete it (registry-owned). CPU: a FRESH portable Image the caller
 * deletes after paint (browser_media.release).
 *
 * @param uploader a GPU or CPU uploader (video_registry.makeGpuUploader / makeCpuUploader)
 * @param {string} src the video source string
 * @example // getVideoV5Frame(gpuUploader, url) // null until a frame lands, then a reused texture-backed Image
 */
export function getVideoV5Frame(uploader, src) {
  ensureVideoV5(src);
  const entry = registry.get(src);
  if (!entry || entry.status === "error") return null;
  const bitmap = entry.latest;
  if (!bitmap) return null; // no frame yet → draw nothing; onVideoV5Frame nudges repaints as they land
  const w = entry.latestW, h = entry.latestH;
  if (!(w > 0 && h > 0)) return null;
  if (!uploader.isGpu) return uploadBitmap(uploader, bitmap); // CPU: fresh portable Image (caller deletes)
  const key = uploader.scopeId + "|" + src;
  let slot = playerImages.get(key);
  if (slot && (slot.w !== w || slot.h !== h)) { slot.img.delete(); playerImages.delete(key); slot = null; } // dims changed → rebuild
  if (!slot) {
    // makeImageFromTextureSource(bitmap): upload the ALREADY-RGBA bitmap to a GL
    // texture — no colour convert on this (main) thread (the worker did it).
    slot = { img: uploader.grab(bitmap), w, h, seq: entry.seq };
    playerImages.set(key, slot);
    _uploadCount += 1;
  } else if (slot.seq !== entry.seq) {
    uploader.refresh(slot.img, bitmap); // frame ADVANCED → in-place re-upload
    slot.seq = entry.seq;
    _uploadCount += 1;
  }
  return slot.img; // registry-owned; caller must NOT delete
}

/**
 * Command. Pause every V5 `<video>` NOT in `activeRefs`; resume those that ARE
 * (honoring autoplay). Paused elements stop feeding captureStream, so the worker
 * starves — zero decode/convert cost off-view. Preserves currentTime (resume, not
 * restart); toggles only on a real paused-state change (no per-paint thrash).
 *
 * @param {Iterable<string>} activeRefs currently visible V5 video sources
 */
export function setActiveVideoV5Refs(activeRefs) {
  const active = activeRefs instanceof Set ? activeRefs : new Set(activeRefs);
  for (const [src, entry] of registry) {
    if (entry.status === "error") continue;
    const el = entry.el;
    if (active.has(src)) {
      if (el.autoplay && el.paused) el.play?.().catch((e) => console.error(`PowerRP video_v5: resume of "${truncate(src)}" was blocked — ${e?.message ?? e}`));
    } else if (!el.paused) {
      el.pause?.();
    }
  }
}

/**
 * Command. Subscribe to per-frame repaint nudges (the reactive editor re-renders
 * as frames land). Returns an unsubscribe fn.
 *
 * @param {(src: string) => void} cb called with the src whose frame advanced
 * @example // const off = onVideoV5Frame((src) => repaintIfVisible(src)); ... off();
 */
export function onVideoV5Frame(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Command. Frees the texture-backed Images created under a GPU uploader's
 * `scopeId`, before its GL context is torn down (SkiaSurface.dispose) — a later
 * .delete() on a dead context would fault the wasm heap. No-op for "cpu".
 *
 * @param {string} scopeId the disposed uploader's scope tag
 */
export function disposeVideoV5Scope(scopeId) {
  const prefix = scopeId + "|";
  for (const [k, slot] of playerImages) if (k.startsWith(prefix)) { slot.img.delete?.(); playerImages.delete(k); }
  // The scrub LRU is scope-keyed too (a texture-backed scrub Image is context-
  // bound), so free this scope's cached scrub frames on the same teardown. The
  // holds are scope-keyed REFERENCES into that LRU, so they must be dropped in the
  // same pass — a pin into a freed Image would hand a dead texture to a later draw.
  for (const [k, img] of scrubCache) if (k.startsWith(prefix)) { img?.delete?.(); scrubCache.delete(k); }
  for (const k of scrubHeld.keys()) if (k.startsWith(prefix)) scrubHeld.delete(k);
  for (const k of scrubFailed.keys()) if (k.startsWith(prefix)) scrubFailed.delete(k);
}

/** Query. Total ImageBitmap->GPU-texture uploads so far (diagnostic; the seq gate
 *  should keep this at ~video-rate, not paint-rate).
 *  @example videoV5UploadCount() // 0 (before any frame is uploaded) */
export function videoV5UploadCount() { return _uploadCount; }

/**
 * Query. A V5 clip's live state, or null if `src` has no element yet — a probe
 * asserts off-view PAUSE/RESUME and that frames advance.
 *
 * @example videoV5State("nope://x") // null
 * @returns {{status,mode,paused,currentTime,seq,hasBitmap}|null}
 */
export function videoV5State(src) {
  const entry = registry.get(src);
  if (!entry) return null;
  return { status: entry.status, mode: entry.mode, paused: entry.el.paused, currentTime: entry.el.currentTime, seq: entry.seq, hasBitmap: !!entry.latest };
}

/**
 * Command. Tears the whole registry down (tests / explicit invalidation): detach
 * every worker loop, close every bitmap, delete every texture Image, pause + drop
 * every element. Not a silent cache bypass — the one documented reset hook.
 */
export function resetVideoV5Registry() {
  for (const [src, entry] of registry) {
    if (_worker && entry.mode === "worker") _worker.postMessage({ type: "detach", id: entry.id });
    entry.latest?.close();
    try { entry.el.pause?.(); entry.el.removeAttribute("src"); entry.el.load?.(); } catch (e) { console.warn(`PowerRP video_v5: teardown of "${truncate(src)}" —`, e?.message ?? e); }
  }
  for (const [, slot] of playerImages) slot.img.delete?.();
  registry.clear();
  idToSrc.clear();
  playerImages.clear();
  resetVideoV5ScrubRegistry();
}

// ── THE V5 SCRUBBER PATH (deterministic frame-at-time, off-main-thread convert) ─
// The PLAYER above hands back a live, LOOPING <video> whose wall clock advances
// the frame (non-deterministic). The V5 SCRUBBER is the opposite: it PARKS a
// PAUSED decoder at an EXACT time (document state) and awaits THAT one frame.
// This is the off-main-thread analogue of gpu/video_registry.js's scrubber — it
// re-owns its own paused decoders + LRU (the standalone philosophy of this
// module), and its ONE difference from the core scrubber is the frame grab: after
// the seek settles it runs createImageBitmap(<video>) (the YUV->RGBA convert
// resolves OFF the main thread — the same "V5 quality" the main-mode player loop
// uses) and uploads the already-RGBA bitmap (uploadBitmap), rather than the core
// path's makeImageFromTextureSource(<video>) main-thread convert.
//
// Scrub decoders are SEPARATE from the player registry (a player + a scrubber on
// one source must not fight over currentTime) and NEVER autoplay/loop. The render
// path is sync-shaped but a seek is async, so this mirrors the image pipeline's
// async contract with a bounded LRU cache, exactly like the core scrubber.
//
// ── WHAT A LIVE GESTURE NEEDS THAT A ONE-SHOT RENDER DOES NOT ─────────────────
// The first cut of this path served both consumers with one rule ("no exact frame
// ⇒ draw nothing"). That is right for a one-shot render, which AWAITS its frames,
// and wrong for a DRAG, which asks for a new time every paint and can never have
// the exact frame ready. Measured on a 2 s scrub: every single captured frame was
// empty — the clip disappeared for the whole gesture — and every intermediate time
// was still seeked, so the decoder ran seconds behind the pointer. Two mechanisms
// fix it, and they only touch the LIVE path:
//   HOLD  — a miss draws the source's most recently DECODED frame (pinned in the
//     LRU) instead of nothing, so a scrub shows a slightly stale frame of the right
//     clip and snaps to the exact one when it lands (getVideoV5ScrubFrame).
//   COALESCE — a live request that is superseded before it starts is DROPPED, so
//     the decoder always works on the time being asked for NOW, while the LAST
//     request of a gesture is always decoded (kickLiveV5ScrubFrame).
// The AWAITED path (requestVideoV5ScrubFrame) keeps its old exact-every-frame
// semantics untouched, because that is what makes an export reproducible.

/** src → {status, el, error, ready:Promise, chain:Promise, live, pumpQueued} for the
 *  PAUSED V5 scrub decoders (separate from `registry` so the player never fights
 *  them). `live`/`pumpQueued` are the LATEST-WINS seek coalescer (see
 *  kickLiveV5ScrubFrame). */
const scrubRegistry = new Map();
/** scopedV5ScrubKey → CanvasKit.Image: the bounded LRU of decoded scrub frames.
 *  A live scrub sweeps `time` continuously, so old frames must evict (+ .delete())
 *  or the wasm heap leaks. Insertion-ordered ⇒ first key is least-recently-used.
 *  THE SOLE OWNER of every decoded scrub Image (scrubHeld only points into it). */
const scrubCache = new Map();
/** scopedV5ScrubKey → in-flight Promise<Image|null> — dedups concurrent requests
 *  for the SAME frame (N synced V5 scrubbers → ONE seek+decode). */
const scrubInflight = new Map();
/** scopedV5HoldKey → the scrubCache key currently PINNED as that (scope, source)'s
 *  HOLD: its most recently DECODED frame, drawn while a newer time is still
 *  decoding so a scrub never shows emptiness. A pin is a REFERENCE into scrubCache,
 *  never a second owner — eviction skips pinned keys (evictV5ScrubFrames) so the
 *  outgoing frame stays alive until a newer decode replaces it as the pin, and the
 *  LRU still performs the one .delete(). */
const scrubHeld = new Map();
/** scopedV5ScrubKey → `{message, attempts}` for a seek/decode that FAILED. Such a
 *  frame is never held: a hold that can never resolve would make the drawn pixels
 *  depend on cache history rather than on the document, and "stale forever" is a
 *  worse defect than an honest empty quad. It draws nothing (exactly as before this
 *  file grew a hold), and every failure is reported LOUDLY — this module's contract
 *  is that a failure is never retried SILENTLY, which is not the same as never
 *  retried.
 *
 *  IT COUNTS ATTEMPTS BECAUSE "FAILED" WAS TREATED AS PERMANENT AND IS NOT.
 *  `createImageBitmap` on an already-loaded element throws InvalidStateError
 *  TRANSIENTLY — measured clustering into windows on this host, with the same tree
 *  green minutes later (tests/image_stack_live_probe.js's docblock records what is
 *  and is not established about the trigger). One such throw used to blacklist the
 *  key for the LIFE OF THE PAGE: the widget went blank and stayed blank, and no
 *  paint, scrub or reselect could ever bring it back, because the one gate that
 *  could re-request it read `scrubFailed.has(key)`. A transient browser state was
 *  recorded as a permanent document one.
 *
 *  A RETRY COSTS ONE DECODE, NOT ONE PER PAINT. The live pump is coalesced per
 *  source (`entry.pumpQueued`), so re-kicking a failed key on every paint still
 *  yields at most one seek+decode in flight for that source at a time. So
 *  V5_SCRUB_MAX_ATTEMPTS attempts are V5_SCRUB_MAX_ATTEMPTS real decodes spread
 *  across a genuine interval, not three consecutive frames of one gesture. Past the
 *  cap the key is permanent — an endlessly-retrying blank quad would be a silent
 *  spin, which is the thing this map was written to prevent. */
const scrubFailed = new Map();

/** How many times a failing (scope, source, time, wrap) frame is decoded before the
 *  failure is treated as PERMANENT. Small, because the failure mode this exists for
 *  is a brief window, and because each attempt is a real seek+decode: the point is
 *  to survive a transient throw, not to grind on a clip that genuinely will not
 *  decode. The AWAITED path (requestVideoV5ScrubFrame) never consulted this map at
 *  all and so was always retry-on-request; this cap governs the LIVE paint path. */
const V5_SCRUB_MAX_ATTEMPTS = 3;

/** Max decoded V5 scrub frames kept at once — comfortably exceeds the distinct
 *  (source, time) frames a realistic scene shows, so a one-shot prepare pass never
 *  evicts a frame it still needs; a live tween churns within this bound. The
 *  PINNED holds (at most one per (scope, source)) are exempt, so the real ceiling
 *  is this cap plus the number of live scrub sources. */
export const V5_SCRUB_CACHE_CAP = 64;
/** Seeking exactly to `duration` is undefined (past the last frame); back off a
 *  hair so "the end" resolves to the last real frame. Seconds. */
export const V5_SCRUB_END_EPSILON = 1e-3;

/** Diagnostic counters for the scrub path (read via videoV5ScrubStats). A live
 *  gesture is a per-PAINT behaviour, so a probe needs the per-paint resolution
 *  breakdown (exact / held / blank) and the request→decode ratio the coalescer
 *  achieves; `blank` MUST stay at its first-frame-only value once a frame exists.
 *  Cheap (integer adds on a path that already does a Map lookup). */
const _scrubStats = { requests: 0, exact: 0, held: 0, blank: 0, decoded: 0, dropped: 0 };
/** uploader.scopeId → how that scope's LAST paint resolved ("exact"/"held"/"blank"/
 *  "failed"). PER SCOPE, not global, because the scopes answer different questions
 *  and a global value would let one answer masquerade as the other: the ON-SCREEN
 *  surface's GL scope is the one that must reach "exact" after a scrub settles, while
 *  the offscreen "cpu" scope (thumbnails/export, which awaits its frames) is "exact"
 *  by construction and would otherwise hide a stale editor canvas. */
const _scrubLastByScope = new Map();
/** uploader.scopeId → decodes completed for that scope. Per scope for the same
 *  reason: the offscreen thumbnail/export scope decodes on its own schedule, so a
 *  global count cannot be used to observe when the EDITOR's own decode backlog has
 *  drained (a probe's smoothness measurement). */
const _scrubDecodedByScope = new Map();

/**
 * Pure function. Resolves a requested scrub time against the real media duration +
 * wrap mode. "clamp" holds [0, duration); "loop" wraps modulo the duration; an
 * unknown duration best-effort clamps to >= 0. A standalone twin of
 * video_registry.resolveScrubTime (this module re-owns its scrub infrastructure);
 * kept pure + exported so the mapping is unit-testable without a <video>.
 *
 * @example resolveV5ScrubTime(1.5, 3, "clamp") // 1.5
 * @example resolveV5ScrubTime(5, 3, "clamp") // 2.999  (clamped to just under the end)
 * @example resolveV5ScrubTime(-1, 3, "clamp") // 0
 * @example resolveV5ScrubTime(4, 3, "loop") // 1  (4 mod 3)
 * @example resolveV5ScrubTime(-1, 3, "loop") // 2  (wraps positive)
 */
export function resolveV5ScrubTime(t, duration, wrap) {
  const time = Number.isFinite(t) ? t : 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, time);
  const end = Math.max(0, duration - V5_SCRUB_END_EPSILON);
  if (wrap === "loop") {
    const m = ((time % duration) + duration) % duration;
    return Math.min(m, end);
  }
  return Math.min(Math.max(0, time), end);
}

/** Pure function. The scrub LRU key for an uploader: the shared media-map key
 *  (videoV5FrameKey via scrubFrameKey) PREFIXED by the uploader scope, because a
 *  texture-backed scrub Image is usable only on its OWN GL context (CPU images are
 *  portable and share the single "cpu" scope). The media-map key paint_skia reads
 *  is the UNSCOPED videoV5FrameKey (browser_media re-keys); this scope tag is a
 *  CACHE concern only.
 *
 *  @example // scopedV5ScrubKey({scopeId: "gl:0"}, "clip.mp4", 1.5, "clamp") // "gl:0|clip.mp4@1.5000@clamp"
 */
function scopedV5ScrubKey(uploader, ref, seekTime, wrap) {
  return uploader.scopeId + "|" + scrubFrameKey(ref, seekTime, wrap);
}

/** Pure function. The HOLD key for an uploader + source: the (scope, source) pair
 *  whose most recently decoded frame is pinned as the one to draw while a newer
 *  time decodes. Scoped for the same reason scopedV5ScrubKey is — a texture-backed
 *  Image is usable only on its own GL context — and TIME-FREE, because the whole
 *  point of the hold is that it survives the time changing.
 *
 *  @example // scopedV5HoldKey({scopeId: "gl:0"}, "clip.mp4") // "gl:0|clip.mp4"
 */
function scopedV5HoldKey(uploader, ref) {
  return uploader.scopeId + "|" + ref;
}

/**
 * Command (near-pure: idempotent). Ensures a PAUSED scrub <video> exists for
 * `src`. Separate from makeEntry/ensureVideoV5 (the player) so the two never fight
 * over currentTime. `entry.ready` resolves after load AND a warm-up seek has
 * primed the decoder — the FIRST seek after load on a cold decoder can decode a
 * black frame (proven in the core scrubber), so a throwaway warm-up seek to
 * mid-clip fires before any real grab. Returns the entry.
 */
function ensureV5ScrubElement(src) {
  if (typeof src !== "string" || src.length === 0)
    throw new Error(`ensureV5ScrubElement: src must be a non-empty string, got ${JSON.stringify(src)}`);
  const existing = scrubRegistry.get(src);
  if (existing) return existing;

  const el = document.createElement("video");
  el.muted = true;      // no audio on a scrubber (it never plays)
  el.autoplay = false;  // NEVER plays — its time is document state
  el.loop = false;
  el.playsInline = true;
  el.crossOrigin = "anonymous"; // let CORS assets feed createImageBitmap untainted
  el.preload = "auto";
  // `live` = the ONE pending LIVE (fire-and-forget, droppable) frame request, or
  // null; `pumpQueued` = whether a pump task is already waiting on `chain` to claim
  // it. Together they are the latest-wins coalescer (kickLiveV5ScrubFrame).
  const entry = { status: "loading", el, error: null, ready: null, chain: Promise.resolve(), live: null, pumpQueued: false };
  scrubRegistry.set(src, entry);

  el.addEventListener("error", () => {
    entry.status = "error";
    console.error(`PowerRP video_v5 (scrub): <video> failed to load "${truncate(src)}" — ${el.error?.message ?? "unknown media error"}`);
    notify(src);
  });

  entry.ready = new Promise((resolve) => {
    el.addEventListener("loadeddata", async () => {
      if (entry.status !== "error") entry.status = "ready";
      // WARM-UP: prime the cold decoder with one throwaway seek to a NON-ZERO time
      // (guaranteed to fire `seeked`, unlike re-seeking to the current 0), so every
      // real grab below is frame-accurate rather than black.
      try {
        const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        await seekV5(el, dur > 0 ? dur / 2 : 0);
      } catch (e) {
        console.error(`PowerRP video_v5 (scrub): warm-up seek of "${truncate(src)}" failed — ${e?.message ?? e}`);
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
 * resolve immediately when the decoder is already parked there — re-seeking to the
 * current time would never fire `seeked` and would hang). rVFC is deliberately NOT
 * used: a PAUSED element never presents a frame headless, so rVFC never fires.
 * Rejects on the element's error event.
 */
function seekV5(el, t) {
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
 * (resolved by `wrap`), grabs that one frame via createImageBitmap (the YUV->RGBA
 * convert resolves OFF the main thread), uploads it, and caches it under `key` —
 * which also PINS it as the (scope, source) hold. Returns the cached Image; throws
 * on a failed seek/decode (the callers report loudly).
 *
 * Runs INSIDE the per-source seek mutex (`entry.chain`): one `<video>` can be
 * parked at only one time at a time, so both callers (the awaited
 * requestVideoV5ScrubFrame and the coalescing live pump) chain through it.
 */
async function decodeV5ScrubFrame(entry, uploader, ref, seekTime, wrap, key) {
  const el = entry.el;
  const effective = resolveV5ScrubTime(seekTime, el.duration, wrap);
  await seekV5(el, effective);
  const bitmap = await createImageBitmap(el); // OFF-main-thread YUV->RGBA convert
  let img;
  try { img = uploadBitmap(uploader, bitmap); }
  finally { bitmap.close(); } // the CanvasKit Image now owns the pixels; free the bitmap
  cacheV5ScrubFrame(scopedV5HoldKey(uploader, ref), key, img);
  _scrubStats.decoded += 1;
  _scrubDecodedByScope.set(uploader.scopeId, (_scrubDecodedByScope.get(uploader.scopeId) ?? 0) + 1);
  notify(ref);
  return img;
}

/**
 * Query→build (async). The decoded CanvasKit Image for `ref` at exactly `seekTime`
 * (resolved by `wrap`), converted OFF the main thread and cached in the LRU. Dedups
 * concurrent identical requests, and SERIALIZES seeks per source (one <video> can
 * be at only one time at a time). Resolves null on load/seek/decode failure
 * (reported loudly, never silent). The caller MUST NOT delete the returned Image —
 * the LRU owns its lifetime.
 *
 * This is the EXACT / AWAITED path: every requested frame is decoded, never
 * coalesced away, because the one-shot pixel consumers (thumbnails, PNG export, the
 * headless render hook via browser_media.prepareSceneScrubFrames) await it and then
 * paint — dropping a request here would make those renders non-deterministic. The
 * live editor paint uses getVideoV5ScrubFrame, which DOES coalesce.
 *
 * @param uploader a GPU or CPU uploader (video_registry.makeGpuUploader / makeCpuUploader);
 *   its scope keys the LRU entry, since a texture-backed Image is context-bound
 */
export async function requestVideoV5ScrubFrame(uploader, ref, seekTime, wrap) {
  const key = scopedV5ScrubKey(uploader, ref, seekTime, wrap);
  const cached = scrubCache.get(key);
  if (cached) { touchScrubLru(key); return cached; }
  const pending = scrubInflight.get(key);
  if (pending) return pending;

  const entry = ensureV5ScrubElement(ref);
  const job = (async () => {
    await entry.ready;
    if (entry.status === "error") return null;
    const run = entry.chain.then(() => decodeV5ScrubFrame(entry, uploader, ref, seekTime, wrap, key));
    entry.chain = run.catch(() => {}); // keep the mutex alive past a failed seek
    return await run;
  })().catch((e) => {
    noteV5ScrubFailure(key, ref, seekTime, e);
    return null;
  }).finally(() => scrubInflight.delete(key));

  scrubInflight.set(key, job);
  return job;
}

/**
 * Command. Registers (ref, seekTime, wrap) as the source's LATEST live frame
 * request and makes sure one pump task is queued behind the per-source seek mutex.
 *
 * LATEST-WINS COALESCING — the reason a live scrub feels smooth. A drag emits one
 * request per paint (~60/s), while a seek+decode costs tens of milliseconds, so
 * decoding every requested time would serialize a backlog whose head is seconds
 * behind the pointer: the widget would trail the gesture and only "catch up" long
 * after release. Instead a request that arrives while an older one is still WAITING
 * replaces it and is never decoded (counted as `dropped`), so the decoder always
 * works on the time the user is asking for NOW. The pump claims the newest request
 * only when it reaches the front of the mutex; any request made after that claim
 * queues exactly one more pump, so the FINAL request of a gesture is always decoded
 * — that is what makes the settled frame exact rather than merely recent.
 *
 * ONE SLOT PER SOURCE, so two scrubbers on ONE source at DIFFERENT times supersede
 * each other and only one of them decodes per pump. That still converges by the
 * module's standing async contract — every decode notify()s, every repaint re-requests
 * whatever is still missing — so N such widgets settle in N repaints, each showing
 * the held frame until its own turn. (N scrubbers at the SAME time share one key and
 * never conflict; that is the frame-lockstep case.)
 */
function kickLiveV5ScrubFrame(uploader, ref, seekTime, wrap, key) {
  const entry = ensureV5ScrubElement(ref);
  if (entry.live) _scrubStats.dropped += 1; // superseded before it was ever decoded
  entry.live = { uploader, seekTime, wrap, key };
  if (entry.pumpQueued) return; // the queued pump will claim whatever the newest request is by then
  entry.pumpQueued = true;
  // The pump OWNS its failure (reports it against the key it actually claimed, which
  // is not necessarily this call's `key`), so `run` never rejects and stays usable as
  // the mutex directly.
  entry.chain = entry.chain.then(async () => {
    await entry.ready; // load + warm-up seek; requests made while waiting are superseded above
    const job = entry.live;
    entry.live = null;
    entry.pumpQueued = false; // claimed — a later request queues a FRESH pump behind this decode
    if (!job || entry.status === "error") return null;
    try {
      return await decodeV5ScrubFrame(entry, job.uploader, ref, job.seekTime, job.wrap, job.key);
    } catch (e) {
      noteV5ScrubFailure(job.key, ref, job.seekTime, e);
      return null;
    }
  });
}

/** Command. Reports a failed scrub frame LOUDLY and counts the attempt, so the hold
 *  never covers for it and it is not silently re-requested forever. The message says
 *  WHICH of the two it is — a retry pending, or the cap reached and the frame given
 *  up on — because "failed" alone left a reader unable to tell a blank quad that is
 *  about to recover from one that never will.
 *
 *  The failing-decode branch itself is UNTESTED in the sense the previous docblock
 *  meant: a seek/decode failure on an ALREADY-LOADED element could not be INDUCED
 *  from a probe. It is nonetheless the branch the field reports hit (see
 *  scrubFailed), which is why it now counts instead of latching. The sibling guard it
 *  feeds — a source that fails to LOAD draws nothing rather than holding another
 *  clip's frame — IS covered (tests/video_v5_scrub_live_probe.js, the broken-source
 *  phase), and the counting rule itself is covered by
 *  render_gpu/tests/video_v5_retry_test.js against the map directly. */
function noteV5ScrubFailure(key, ref, seekTime, err) {
  const attempts = (scrubFailed.get(key)?.attempts ?? 0) + 1;
  const message = String(err?.message ?? err);
  scrubFailed.set(key, { message, attempts });
  const verdict = attempts >= V5_SCRUB_MAX_ATTEMPTS
    ? `giving up after ${attempts} attempt(s)`
    : `attempt ${attempts} of ${V5_SCRUB_MAX_ATTEMPTS}, will retry`;
  console.error(`PowerRP video_v5 (scrub): frame at ${seekTime}s of "${truncate(ref)}" failed — ${message} (${verdict})`);
}

/**
 * Pure function. Whether this key's failures have reached the cap, i.e. the frame is
 * given up on rather than pending another try. A key with NO record has not failed,
 * so it is not given up on either.
 *
 * @param {Map<string, {message:string, attempts:number}>} failed the failure map
 * @param {string} key a scopedV5ScrubKey
 * @param {number} [cap] attempts at which a failure becomes permanent
 * @returns {boolean}
 * @example v5ScrubGivenUp(new Map(), "k") // false  (never failed)
 * @example v5ScrubGivenUp(new Map([["k", {message: "x", attempts: 1}]]), "k") // false  (retry pending)
 * @example v5ScrubGivenUp(new Map([["k", {message: "x", attempts: 3}]]), "k") // true
 */
export function v5ScrubGivenUp(failed, key, cap = V5_SCRUB_MAX_ATTEMPTS) {
  return (failed.get(key)?.attempts ?? 0) >= cap;
}

/**
 * Query→build (near-pure: kicks a coalesced async seek on a miss). The SYNC
 * render-path accessor for the LIVE editor paint: the cached CanvasKit Image for
 * (ref, seekTime, wrap) if that exact frame is decoded, ELSE the (scope, source)'s
 * most recently decoded frame — the HOLD — else null. The caller must NOT delete
 * the Image (the LRU owns it).
 *
 * WHY IT HOLDS. A seek is async while the paint is sync, so during a scrub there is
 * always a window with no frame decoded at the requested time. Returning null there
 * made the widget draw NOTHING — the clip visibly DISAPPEARED for the whole gesture
 * (proven: every captured frame of a 2 s drag was empty), which is worse than
 * useless: you cannot scrub to something you cannot see. So mid-gesture this returns
 * a slightly STALE frame of the SAME clip and the pipeline snaps to the requested
 * one when it lands. That is the preview-vs-settled split used throughout this
 * codebase: a cheap in-gesture preview, an exact settled result.
 *
 * IT ALWAYS CONVERGES, so the determinism contract survives. The hold is only ever
 * returned on a MISS, the miss always kicks a request, and the coalescer guarantees
 * the LAST requested time is decoded (see kickLiveV5ScrubFrame) — after which this
 * returns the exact frame. The one-shot pixel consumers never see a hold at all:
 * browser_media.prepareSceneScrubFrames AWAITS every scrub frame before painting, so
 * their lookups are exact hits. `pure(document, slide, alpha)` is unchanged.
 *
 * A null (no frame has EVER decoded for this source) still draws nothing — with
 * nothing decoded there is nothing honest to show, and a placeholder is forbidden.
 *
 * @param uploader a GPU or CPU uploader (video_registry.makeGpuUploader / makeCpuUploader)
 * @example // getVideoV5ScrubFrame(gpuUploader, "clip.mp4", 1.5, "clamp") // null before the first decode, then the exact frame or the held one
 */
export function getVideoV5ScrubFrame(uploader, ref, seekTime, wrap) {
  const key = scopedV5ScrubKey(uploader, ref, seekTime, wrap);
  _scrubStats.requests += 1;
  const cached = scrubCache.get(key);
  if (cached) { touchScrubLru(key); return noteV5ScrubResolution(uploader, "exact", cached); }
  // A frame GIVEN UP ON, or a source that failed to load, gets no hold: a stale frame
  // that can never resolve would silently replace a reported failure with
  // wrong-but-plausible pixels. `v5ScrubGivenUp` and not `scrubFailed.has` — a key
  // that has failed FEWER than V5_SCRUB_MAX_ATTEMPTS times falls through to the kick
  // below and is decoded again, because the failure this guard meets in the field
  // (a transient createImageBitmap throw) recovers on its own and `.has` made it
  // permanent. Past the cap the behaviour is exactly what it always was.
  if (v5ScrubGivenUp(scrubFailed, key) || scrubRegistry.get(ref)?.status === "error") return noteV5ScrubResolution(uploader, "failed", null);
  kickLiveV5ScrubFrame(uploader, ref, seekTime, wrap, key); // fire-and-forget; repaints on land
  const heldKey = scrubHeld.get(scopedV5HoldKey(uploader, ref));
  // The pin (evictV5ScrubFrames) is what makes this lookup safe: a held key cannot
  // have been evicted + deleted out from under the draw.
  const held = heldKey === undefined ? undefined : scrubCache.get(heldKey);
  if (held) return noteV5ScrubResolution(uploader, "held", held);
  return noteV5ScrubResolution(uploader, "blank", null);
}

/** Command (returns `img` so callers stay one-liners). Records how this paint
 *  resolved, globally and per uploader scope, then hands the Image back. */
function noteV5ScrubResolution(uploader, how, img) {
  if (how === "exact") _scrubStats.exact += 1;
  else if (how === "held") _scrubStats.held += 1;
  else _scrubStats.blank += 1; // "blank" and "failed" both draw nothing
  _scrubLastByScope.set(uploader.scopeId, how);
  return img;
}

/** Command. Inserts `img` under `key`, PINS it as `holdKey`'s hold (superseding
 *  that source's previous pin, which becomes evictable again), then evicts down to
 *  the cap. */
function cacheV5ScrubFrame(holdKey, key, img) {
  scrubCache.set(key, img);
  scrubHeld.set(holdKey, key);
  evictV5ScrubFrames();
}

/** Command. Evicts least-recently-used frames (deleting each CanvasKit Image —
 *  the LRU is their sole owner) until the cache is back within
 *  V5_SCRUB_CACHE_CAP, SKIPPING every pinned hold: the frame a scrub is currently
 *  showing must outlive the newer frame that has not decoded yet. Pins are at most
 *  one per (scope, source), so the cache can exceed the cap only by that count, and
 *  an all-pinned cache simply stops evicting rather than deleting a live frame. */
function evictV5ScrubFrames() {
  const pinned = new Set(scrubHeld.values());
  for (const key of scrubCache.keys()) {
    if (scrubCache.size <= V5_SCRUB_CACHE_CAP) return;
    if (pinned.has(key)) continue;
    const evicted = scrubCache.get(key);
    scrubCache.delete(key);
    evicted?.delete?.();
  }
}

/** Command. Marks `key` most-recently-used (re-insert at the Map's tail). */
function touchScrubLru(key) {
  const img = scrubCache.get(key);
  scrubCache.delete(key);
  scrubCache.set(key, img);
}

/**
 * Query. A V5 scrub decoder's state, or null if `src` has no scrub element yet — a
 * probe asserts the paused decoder loaded and parked at a seeked time.
 *
 * @example videoV5ScrubState("nope://x") // null
 * @returns {{status,paused,currentTime,duration}|null}
 */
export function videoV5ScrubState(src) {
  const entry = scrubRegistry.get(src);
  if (!entry) return null;
  const el = entry.el;
  return { status: entry.status, paused: el.paused, currentTime: el.currentTime, duration: el.duration };
}

/**
 * Command. Tears down the V5 scrub registry + LRU (called from
 * resetVideoV5Registry): drop every element's source and delete every cached
 * Image. Not a silent bypass — part of the one documented reset hook.
 */
export function resetVideoV5ScrubRegistry() {
  for (const [src, entry] of scrubRegistry) {
    entry.live = null; // drop any coalesced request so a pump cannot seek a torn-down element
    try { entry.el.removeAttribute("src"); entry.el.load?.(); } catch (e) { console.warn(`PowerRP video_v5 (scrub): teardown of "${truncate(src)}" —`, e?.message ?? e); }
  }
  scrubRegistry.clear();
  for (const img of scrubCache.values()) img?.delete?.();
  scrubCache.clear();
  scrubHeld.clear(); // references into the now-deleted Images
  scrubFailed.clear();
  scrubInflight.clear();
}

/**
 * Query. The scrub path's diagnostic counters — a live gesture is a per-PAINT
 * behaviour, so a probe reads the per-paint resolution breakdown (`exact`/`held`/
 * `blank`) and the request→decode ratio the coalescer achieves (`decoded` vs
 * `dropped`). `blank` must stop rising once a source has decoded its first frame, and
 * `lastResolution[<the on-screen GL scope>]` must be "exact" once a scrub has settled
 * — that is the convergence check, and it is per scope precisely so the offscreen
 * "cpu" scope (always exact, since it awaits) cannot stand in for the editor's.
 * `cacheSize`/`pinned` prove the LRU + pins stay bounded.
 *
 * @example videoV5ScrubStats().blank // 0 (before any scrub frame is requested)
 * @example videoV5ScrubStats().lastResolution // {} (before any scrub frame is requested)
 * @returns {{requests,exact,held,blank,decoded,dropped,lastResolution,decodedByScope,cacheSize,pinned,failed,inflight}}
 */
export function videoV5ScrubStats() {
  return {
    ..._scrubStats,
    lastResolution: Object.fromEntries(_scrubLastByScope),
    decodedByScope: Object.fromEntries(_scrubDecodedByScope),
    // `failed` counts keys GIVEN UP ON, not keys that have ever thrown, so a
    // transient failure awaiting its retry does not read as a lost frame; `retrying`
    // is that second population, reported rather than folded in.
    cacheSize: scrubCache.size, pinned: scrubHeld.size,
    failed: [...scrubFailed.keys()].filter((k) => v5ScrubGivenUp(scrubFailed, k)).length,
    retrying: [...scrubFailed.keys()].filter((k) => !v5ScrubGivenUp(scrubFailed, k)).length,
    inflight: scrubInflight.size,
  };
}
