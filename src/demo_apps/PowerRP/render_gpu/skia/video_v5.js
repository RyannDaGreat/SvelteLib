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
 */

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
  if (!uploader.isGpu) {
    // CPU (offscreen/headless): a fresh portable Image (caller deletes). An
    // ImageBitmap is a CanvasImageSource, so MakeImageFromCanvasImageSource takes it.
    const img = uploader.CanvasKit.MakeImageFromCanvasImageSource(bitmap);
    if (!img) throw new Error(`video_v5: MakeImageFromCanvasImageSource returned null for a ${w}×${h} frame`);
    return img;
  }
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
}

/** Pure function. Shortens a src for a log line (a data: URI can be megabytes).
 *  @example truncate("data:video/mp4;base64,AAAABBBBCCCCDDDD...") // "data:video/mp4;base64,AAAABBBB…" */
function truncate(src) { return typeof src === "string" && src.length > 32 ? src.slice(0, 32) + "…" : String(src); }
