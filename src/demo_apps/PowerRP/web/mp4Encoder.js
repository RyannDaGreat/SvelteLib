/**
 * MP4 / H.264 ENCODER, IN THE PAGE — the video-export pipeline's (web/videoExport.js)
 * encoder that turns rendered canvases into .mp4 bytes WITHOUT a server round trip
 * per frame. It implements that pipeline's tiny Encoder interface —
 * `addFrame(canvasSource, {timestamp, duration})` + `finalize()` — so the pipeline,
 * its deterministic frame walk and its motion-blur subsampling are untouched; only
 * where the bytes are compressed changes.
 *
 * ── THIS FILE HAS A HISTORY, AND IT MATTERS ───────────────────────────────────
 * The first version of this module encoded with the browser's WebCodecs
 * `VideoEncoder`. It was deleted because `VideoEncoder` is exposed ONLY IN A SECURE
 * CONTEXT (https, or http on loopback). PowerRP's CORE TENET is that the app works
 * on PLAIN HTTP from any origin — a LAN IP, no certificate — and on such an origin
 * `window.isSecureContext` is false and `VideoEncoder` is simply undefined. The
 * encode was moved to the server (ffmpeg over uploaded PNGs), which works but costs
 * a PNG compression and an HTTP round trip PER FRAME.
 *
 * This version does the encode in the page again, in WEBASSEMBLY, which has no
 * secure-context requirement at all. Measured on a real plain-HTTP LAN origin,
 * these are available: WebAssembly, OffscreenCanvas, IndexedDB. These are NOT:
 * SharedArrayBuffer, crossOriginIsolated, OPFS, VideoEncoder, Web Locks. The
 * missing SharedArrayBuffer is why the encoder must be SINGLE-THREADED: a
 * multithreaded wasm build needs SAB, SAB needs cross-origin isolation, and
 * cross-origin isolation needs HTTPS — the exact wall WebCodecs died on. Nothing
 * in this module may reintroduce it.
 *
 * ── WHY minih264 (h264-mp4-encoder) ───────────────────────────────────────────
 * It is a single-threaded, dependency-free wasm H.264 baseline encoder plus a
 * minimal MP4 writer, ~1.7 MB with its wasm base64-inlined, that needs no
 * configuration beyond size/rate/QP. The alternatives were weighed by downloading
 * and inspecting them: @ffmpeg/core is ~31 MB per build and its fast variant is the
 * multithreaded one (SAB — out); mp4-wasm turns out to be a MUXER whose encoding
 * path is WebCodecs, out for exactly the reason the deleted file was.
 *
 * ── AND IT IS NOT THE SPEED WIN IT WAS EXPECTED TO BE. SAY SO. ────────────────
 * The hypothesis behind this module was that the PNG compression dominated the old
 * path. It does not. Measured per 1080p frame on a plain-HTTP LAN origin
 * (tests/browser_encode_measure.mjs): render 29.8 ms (75%), PNG 6.4 ms (16%),
 * upload 3.7 ms (9%). A wasm H.264 frame at the same size costs ~62 ms, and only
 * the worker's overlap with rendering keeps the whole pipeline within 8% of the
 * upload path (86.1 vs 92.8 ms/frame end to end). It WINS at small outputs, where
 * the round trip dominates the pixels (320x240: 5.8 vs 8.5 ms/frame), and it wins
 * decisively on BYTES — ~1.4 KiB of H.264 per 1080p frame against 60 KiB of PNG.
 * See web/browserRenderJobs.js for the full table and which encoder is the default.
 *
 * ── SEGMENTS: WHY THE ENCODE IS A SEQUENCE, NOT A STREAM ──────────────────────
 * The library produces a COMPLETE .mp4 only when it is finalized; there is no
 * "hand me the bitstream so far". A render that must survive the page closing
 * therefore cannot be one long encode. So a job is encoded as consecutive
 * SEGMENTS of `segmentFrames(fps)` frames. Each segment is a self-contained .mp4
 * from its own encoder instance — so it necessarily begins on an IDR — and is
 * handed to `onSegment` the instant it closes, which is where the persistence
 * layer writes it down. `finalize()` closes the last partial segment and REMUXES
 * every segment into one continuous movie (web/mp4Samples.js): compressed samples
 * are copied, never re-encoded, so a resumed render is bit-identical to an
 * uninterrupted one.
 *
 * THE RESUME POINT IS THEREFORE THE LAST SEGMENT THAT WAS CLOSED AND PERSISTED, and
 * that is stated exactly rather than rounded off, because the difference is real
 * work: the frames of the segment that was mid-encode are lost, AND SO ARE the
 * frames still sitting in the worker's queue when the page went away (bounded by
 * IN_FLIGHT_HIGH_WATER). The measured worst case is therefore a little over one
 * segment — a probe that rendered 41 frames with a 20-frame segment resumed from 20,
 * not 40, because segment 1 had not finished encoding yet. Because the segment
 * length is ALSO the keyframe period, one number describes the keyframe cadence and
 * the order of the lost work.
 *
 * ── THE ENCODE RUNS IN A WORKER ───────────────────────────────────────────────
 * H.264 compression is hundreds of milliseconds of straight-line wasm per frame at
 * 1080p; on the main thread it would freeze the editor for the length of the
 * render. web/mp4EncoderWorker.js owns the wasm module and this file owns the
 * conversation with it. The frame's RGBA buffer is TRANSFERRED (zero-copy), and a
 * bounded number of frames is allowed in flight so rendering and encoding overlap
 * instead of alternating.
 */

import { remuxAvcSegments } from "./mp4Samples.js";

/**
 * Seconds of video per SEGMENT — and therefore, exactly, three things at once:
 * the keyframe period, the granularity a paused render resumes at, and the most
 * rendering a closed tab can cost. Two seconds keeps a 1080p segment to a few
 * hundred KiB (one IndexedDB write) while making the worst-case redo trivial.
 */
export const SEGMENT_SECONDS = 2;
/**
 * minih264 quantization parameter per quality preset (its valid range is 10..51;
 * LOWER = better quality, larger file). Unlike x264's CRF this is a FIXED
 * quantizer — there is no rate control in this encoder — so the same number means
 * "how coarsely each block is quantized" rather than "hold this perceptual
 * quality". The scale and direction match closely enough that the Render Center's
 * one quality control drives both backends; the values are chosen to land near
 * their libx264 CRF namesakes in practice.
 */
export const QUALITY_QP = { low: 38, medium: 30, high: 22 };
/** minih264's own quantizer bounds. Anything outside makes initialize() reject. */
export const QP_MIN = 10;
export const QP_MAX = 51;
/**
 * minih264 `speed` (0 = best quality, 10 = fastest). 5 is the library's own
 * middle: at 0 a 1080p frame costs multiple seconds of wasm, which would make the
 * encode — not the render — the bottleneck, and this is a slide deck, not a
 * feature film.
 */
export const ENCODER_SPEED = 5;
/**
 * Frames allowed in flight to the worker before addFrame waits. Bounded so a long
 * deck cannot queue its whole self into worker memory; >1 so the render of frame
 * N+1 overlaps the encode of frame N (the whole reason the worker exists).
 */
const IN_FLIGHT_HIGH_WATER = 4;
/** RGBA bytes per pixel — the frame buffer stride the worker expects. */
const CHANNELS = 4;

/**
 * Query (async; resolves a bundler asset URL). The encoder bundle's URL — not its
 * exports: it is a webpack `libraryTarget: "var"` script that the WORKER loads with
 * importScripts (see web/mp4EncoderWorker.js's header for why it cannot be imported
 * as a module). `?url` makes the bundler resolve and serve/emit the file while
 * leaving it unparsed.
 *
 * LAZY rather than a top-level import for two reasons: it keeps 1.7 MB out of the
 * module graph until someone actually encodes, and bare node ignores the `?url`
 * suffix and would EXECUTE the bundle on import — which is exactly what the node
 * test suites that read this module's pure helpers must not pay for.
 *
 * @returns {Promise<string>} an absolute URL
 */
async function encoderScriptUrl() {
  const mod = await import("h264-mp4-encoder/embuild/dist/h264-mp4-encoder.web.js?url");
  if (typeof mod.default !== "string")
    throw new Error("mp4Encoder: the bundler did not resolve the encoder script to a URL — the `?url` import returned " + typeof mod.default);
  return new URL(mod.default, location.href).href;
}

/**
 * Pure function. Frames per encode segment at `fps` — at least one, so a
 * pathologically low fps still segments.
 *
 * @param {number} fps Frames per second of the output.
 * @returns {number}
 *
 * @example segmentFrames(30) // 60
 * @example segmentFrames(10) // 20
 * @example segmentFrames(0.2) // 1
 */
export function segmentFrames(fps) {
  return Math.max(1, Math.round(SEGMENT_SECONDS * fps));
}

/**
 * Pure function. The minih264 quantization parameter for a Render Center quality
 * value: a preset name ("low"/"medium"/"high") or an explicit number, clamped to
 * the encoder's valid [QP_MIN, QP_MAX].
 *
 * @param {string|number} quality Preset name, or a QP/CRF-scale number.
 * @returns {number}
 *
 * @example encoderQp("medium") // 30
 * @example encoderQp(18) // 18
 * @example encoderQp(4) // 10   (clamped to the encoder's minimum)
 * @example encoderQp(99) // 51  (clamped to the encoder's maximum)
 */
export function encoderQp(quality) {
  const raw = typeof quality === "number" ? quality : QUALITY_QP[quality];
  if (raw === undefined)
    throw new Error(`mp4Encoder: unknown quality ${JSON.stringify(quality)} — expected a number or one of ${Object.keys(QUALITY_QP).join(", ")}`);
  return Math.max(QP_MIN, Math.min(QP_MAX, Math.round(raw)));
}

/**
 * Query. Whether the in-page encoder can run here. Unlike the WebCodecs version
 * this asks about WebAssembly and Workers, NEITHER of which is secure-context
 * gated — so on any browser this app otherwise runs in, the answer is yes.
 * @returns {boolean}
 */
export function isWasmEncoderAvailable() {
  return typeof WebAssembly !== "undefined" && typeof Worker !== "undefined";
}

/**
 * Query. Why the in-page encoder cannot run here, or null when it can. Names the
 * missing capability so the failure is actionable instead of a silent no-op.
 * @returns {string|null}
 */
export function wasmEncoderUnavailableReason() {
  if (isWasmEncoderAvailable()) return null;
  const missing = [
    typeof WebAssembly === "undefined" ? "WebAssembly" : null,
    typeof Worker === "undefined" ? "Worker" : null,
  ].filter(Boolean);
  return `In-page MP4 encoding needs ${missing.join(" and ")}, which this browser does not expose. (Neither is secure-context gated, so this is a browser-age problem, not an https one — the Server backend renders and encodes without the browser.)`;
}

/**
 * Near-pure helper (reads the canvas bitmap; allocates). The canvas's pixels as
 * RGBA bytes, which is what the wasm encoder consumes — the moral equivalent of
 * the PNG encode it replaces, minus the compression.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {number} width Expected width; a mismatch throws.
 * @param {number} height Expected height.
 * @returns {Uint8ClampedArray} length width*height*4
 *
 * @example // canvasRgba(document.createElement("canvas"), 300, 150).length // 180000
 */
export function canvasRgba(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height)
    throw new Error(`mp4Encoder: frame is ${canvas.width}×${canvas.height} but the encoder was configured for ${width}×${height} — the encode would be garbage.`);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("mp4Encoder: the frame canvas has no 2D context to read pixels from.");
  return ctx.getImageData(0, 0, width, height).data;
}

/**
 * Command (async; spawns a Worker, allocates wasm memory). Build an in-page
 * MP4/H.264 encoder implementing the video-export Encoder interface.
 *
 *   addFrame(canvasSource, _meta) — read the canvas's RGBA and hand it to the
 *     worker. The pipeline's {timestamp, duration} are ignored: the timeline is
 *     uniform at `fps` and the remux derives every timestamp from the frame INDEX,
 *     so a lost frame is a loud count mismatch rather than a mis-timed movie.
 *   finalize() → Promise<{bytes, frames, segments}> — close the last segment,
 *     remux everything into one .mp4, and return its bytes.
 *
 * `onSegment(segment)` is awaited as each segment closes — that is the persistence
 * hook (see web/browserRenderJobs.js). `priorSegments` lets a RESUMED job supply
 * the segments it already has, so finalize remuxes the whole movie; `firstFrame`
 * is then the frame index this encoder starts at.
 *
 * @param {object} o
 * @param {number} o.width  Output width in px (even — H.264 4:2:0).
 * @param {number} o.height Output height in px (even).
 * @param {number} o.fps    Frames per second.
 * @param {string|number} o.quality Preset name or explicit QP (see encoderQp).
 * @param {(seg:{index:number, firstFrame:number, frames:number, bytes:Uint8Array})=>Promise<void>|void} [o.onSegment]
 * @param {{index:number, firstFrame:number, frames:number, bytes:Uint8Array}[]} [o.priorSegments]
 *   Already-encoded segments from an earlier sitting, in order.
 * @returns {Promise<{addFrame:Function, finalize:Function, abort:Function}>}
 *
 * @example
 * const enc = await createWasmMp4Encoder({ width: 320, height: 240, fps: 10, quality: "medium" });
 * await enc.addFrame(canvas, { timestamp: 0, duration: 100000 });
 * const { bytes, frames } = await enc.finalize(); // Uint8Array of a playable .mp4
 */
export async function createWasmMp4Encoder({ width, height, fps, quality, onSegment = null, priorSegments = [] }) {
  const reason = wasmEncoderUnavailableReason();
  if (reason) throw new Error(reason);
  if (width % 2 !== 0 || height % 2 !== 0)
    throw new Error(`mp4Encoder: H.264 4:2:0 needs EVEN dimensions; got ${width}×${height}.`);

  const perSegment = segmentFrames(fps);
  const qp = encoderQp(quality);
  const segments = [...priorSegments];
  const startFrame = priorSegments.reduce((n, s) => n + s.frames, 0);

  // A CLASSIC worker (no `type: "module"`): the encoder bundle exports nothing and
  // must be pulled in with importScripts. See the worker's header.
  const worker = new Worker(new URL("./mp4EncoderWorker.js", import.meta.url));
  // An async worker failure has no call stack to attach to, so it is captured and
  // re-thrown at the next addFrame/finalize. Never swallowed.
  let workerError = null;
  let inFlight = 0;
  let nextSegmentIndex = priorSegments.length;
  let framesAdded = 0;
  /** Resolvers waiting for the worker to drain below the high water mark. */
  let drainWaiters = [];
  /** Resolver for a pending finalize. */
  let finishWaiter = null;
  /** Resolver for the one-time init handshake. */
  let readyWaiter = null;
  const segmentQueue = [];

  const fail = (message) => {
    workerError = workerError ?? new Error(message);
    for (const r of drainWaiters) r();
    drainWaiters = [];
    finishWaiter?.();
    readyWaiter?.();
  };

  worker.onerror = (e) => fail(`mp4Encoder worker crashed: ${e.message ?? e.type} (${e.filename}:${e.lineno})`);
  worker.onmessageerror = () => fail("mp4Encoder worker could not deserialize a message (a frame buffer was not transferable).");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "error") { fail(`mp4Encoder worker: ${m.message}${m.stack ? `\n${m.stack}` : ""}`); return; }
    if (m.type === "ack") {
      inFlight -= 1;
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const r of waiters) r();
      return;
    }
    if (m.type === "segment") {
      segmentQueue.push({ index: m.index, firstFrame: m.firstFrame, frames: m.frames, bytes: new Uint8Array(m.bytes) });
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const r of waiters) r();
      return;
    }
    if (m.type === "done") { finishWaiter?.(); return; }
    if (m.type === "ready") { readyWaiter?.(); return; }
    fail(`mp4Encoder: unexpected worker message ${JSON.stringify(m.type)}`);
  };

  /** Command (async). Drain the segment queue through onSegment, in order. */
  async function flushSegments() {
    while (segmentQueue.length > 0) {
      const seg = segmentQueue.shift();
      if (seg.index !== nextSegmentIndex)
        throw new Error(`mp4Encoder: segments arrived out of order (expected ${nextSegmentIndex}, got ${seg.index}) — the movie would be scrambled.`);
      nextSegmentIndex += 1;
      segments.push(seg);
      if (onSegment) await onSegment(seg);
    }
  }

  /** Command (async). Resolve once the worker has fewer than `limit` frames in flight. */
  function waitForCapacity(limit) {
    if (workerError || inFlight < limit) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  const scriptUrl = await encoderScriptUrl();
  // The handshake is AWAITED so a wasm-load failure surfaces here — before a
  // single frame is rendered — rather than as a mystery on frame one.
  await new Promise((resolve) => {
    readyWaiter = resolve;
    worker.postMessage({
      type: "init",
      encoderScriptUrl: scriptUrl,
      width, height, fps, qp, speed: ENCODER_SPEED,
      framesPerSegment: perSegment,
      firstSegmentIndex: nextSegmentIndex,
      firstFrame: startFrame,
    });
  });
  readyWaiter = null;
  if (workerError) throw workerError;

  return {
    /** Query. The frame index this encoder continues from: everything in the
     *  segments handed to it, and nothing from the segment that was mid-encode
     *  when a previous sitting ended. THE resume point, stated exactly. */
    resumeFrom() {
      return startFrame;
    },

    /** Command (async). Encode one frame; applies backpressure and persists any
     *  segment that closed. Re-throws a captured worker error. */
    async addFrame(source, _meta) {
      if (workerError) throw workerError;
      const rgba = canvasRgba(source, width, height);
      if (rgba.length !== width * height * CHANNELS)
        throw new Error(`mp4Encoder: expected ${width * height * CHANNELS} RGBA bytes, got ${rgba.length}.`);
      // A copy is unavoidable: getImageData's buffer is fresh each call but
      // Uint8ClampedArray cannot be transferred, only its ArrayBuffer can — and
      // that IS this frame's own buffer, so the transfer is zero-copy.
      const buffer = rgba.buffer;
      inFlight += 1;
      framesAdded += 1;
      worker.postMessage({ type: "frame", buffer }, [buffer]);
      await flushSegments();
      await waitForCapacity(IN_FLIGHT_HIGH_WATER);
      if (workerError) throw workerError;
    },

    /**
     * Command (async). Close the final segment, remux every segment into ONE
     * .mp4, terminate the worker. Returns {bytes, frames, segments}.
     */
    async finalize() {
      if (workerError) throw workerError;
      await new Promise((resolve) => {
        finishWaiter = resolve;
        worker.postMessage({ type: "finish" });
      });
      finishWaiter = null;
      if (workerError) throw workerError;
      await flushSegments();
      worker.terminate();
      const frames = segments.reduce((n, s) => n + s.frames, 0);
      if (frames !== startFrame + framesAdded)
        throw new Error(`mp4Encoder: ${startFrame + framesAdded} frames were submitted but the segments hold ${frames} — refusing to write a movie that is missing frames.`);
      const bytes = remuxAvcSegments(segments.map((s) => s.bytes), { width, height, fps, expectedFrames: frames });
      return { bytes, frames, segments: segments.length };
    },

    /** Command. Stop the encode and free the worker WITHOUT producing a movie.
     *  Segments already handed to onSegment stay persisted — that is what makes a
     *  cancelled-by-closing-the-tab render resumable. */
    abort() {
      worker.terminate();
    },
  };
}
