/**
 * SERVER-SIDE MP4 ENCODER — the video-export pipeline's (web/videoExport.js)
 * encoder that offloads H.264 encoding to the SERVER (ffmpeg). It implements the
 * SAME tiny Encoder interface as the old in-browser encoder —
 * addFrame(canvasSource, {timestamp, duration}) + finalize() → Promise<Blob> —
 * so the pipeline (and its client-side motion-blur temporal subsampling) is
 * unchanged; only WHERE the bytes are encoded moves off the page.
 *
 * WHY server-side (the CORE reason): the browser's WebCodecs VideoEncoder is a
 * SECURE-CONTEXT-ONLY API (HTTPS / http://localhost). PowerRP is a personal
 * offline tool that runs on PLAIN HTTP on a LAN IP, where `VideoEncoder` is
 * undefined — so in-browser MP4 export is impossible there. The app's core
 * tenant is HTTPS-INDEPENDENCE (it must work on plain non-localhost HTTP
 * everywhere), which WebCodecs can never satisfy. The client still renders every
 * frame DETERMINISTICALLY (RenderTree = pure(doc, [[slide, alpha]])); it just
 * ships the finished PNGs to the server, which runs libx264 and returns the .mp4.
 *
 * STREAMING (flat RAM, ordered frames): a session is a SERVER-minted uuid
 * (beginMp4Export — the server owns the id so the client needs no
 * secure-context-only crypto.randomUUID). Each addFrame serializes its canvas to
 * a PNG and POSTs it as the next frame index, AWAITING the response before
 * returning — so frames land in order and the browser never holds more than one
 * PNG at a time (natural backpressure). finalize POSTs {fps, crf}; the server
 * encodes the numbered PNGs and returns the MP4 bytes as a Blob, then deletes its
 * scratch. LOUD on any non-OK response or unreachable server (no silent
 * fallback) — the transport is projectApi.js, mirroring its error idiom.
 */

import { beginMp4Export, postMp4ExportFrame, encodeMp4Export, postRenderJobFrame, finishRenderJob, listRenderJobs } from "./projectApi.js";

/** libx264 CRF (Constant Rate Factor) per quality preset — LOWER = higher
 *  quality / larger file. 23 is x264's own default (visually good); 18 is near
 *  visually-lossless; 28 is noticeably smaller. The server validates the chosen
 *  CRF against the codec's [CRF_MIN, CRF_MAX] range. */
export const QUALITY_CRF = { low: 28, medium: 23, high: 18 };
/** libx264 CRF bounds: 0 = lossless (huge), 51 = worst. The custom-quality input
 *  clamps to this and the server rejects anything outside it. */
export const CRF_MIN = 0;
export const CRF_MAX = 51;
/** Default CRF when quality is unspecified (x264's own default == "medium"). */
export const DEFAULT_CRF = QUALITY_CRF.medium;

/**
 * Near-pure helper (reads the canvas bitmap; allocates a Blob). Serializes a
 * canvas to PNG bytes via toBlob (a regular <canvas>) or convertToBlob (an
 * OffscreenCanvas). Rejects LOUDLY if the encode yields no blob.
 *
 * EXPORTED so a probe can time THE function this path actually calls rather than
 * a lookalike: tests/browser_encode_measure_probe.js measures PNG encode against
 * the WASM encoder it replaces, and a second copy of the call would make that
 * comparison a comparison of two probes.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @returns {Promise<Blob>} an image/png blob
 *
 * @example await canvasToPngBlob(document.createElement("canvas")) // Blob { type: "image/png" }
 */
export function canvasToPngBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null (PNG encode failed)"))),
      "image/png",
    );
  });
}

/**
 * Command (async). Build a server-side MP4 encoder implementing the video-export
 * Encoder interface. Begins a server export session UP FRONT (so an unreachable
 * or non-OK server fails LOUDLY before a single frame is rendered), then:
 *   addFrame(canvasSource, _meta) — PNG-encode the canvas and POST it as the next
 *     frame index, awaited (backpressure). The {timestamp, duration} the pipeline
 *     passes are ignored: the server derives all timing from fps + frame order.
 *   finalize() → Promise<Blob> — POST {fps, crf}; the server runs ffmpeg and
 *     returns the "video/mp4" bytes (then cleans up its scratch).
 *
 * @param {object} o
 * @param {number} o.fps Frames per second (> 0).
 * @param {number} [o.crf] libx264 CRF (0..51, lower = better). Default DEFAULT_CRF.
 * @returns {Promise<{addFrame:Function, finalize:Function}>}
 *
 * @example
 * const enc = await createServerMp4Encoder({ fps: 30, crf: 23 });
 * await enc.addFrame(canvas, { timestamp: 0, duration: 33333 });
 * const blob = await enc.finalize(); // Blob { type: "video/mp4" }
 */
/**
 * Command (async). The SAME Encoder interface, but writing into an existing
 * RENDER JOB's frame directory instead of an anonymous export session.
 *
 * This is what makes "browser" a BACKEND of the job system rather than a second
 * system beside it: a browser-rendered job and a server-rendered job fill the
 * same directory and are finished by the same ffmpeg step, so they share one
 * record, one progress signal, one output location and one entry in the Render
 * Center. The only difference is who produced the pixels.
 *
 * Unlike createServerMp4Encoder, finalize() returns the finished JOB RECORD, not
 * a Blob: the movie is now a file in the project's renders/ folder, so there is
 * nothing to hold in memory and a URL to play instead.
 *
 * ── AND IT IS RESUMABLE, BECAUSE THE FRAMES ARE ON DISK ───────────────────────
 * `firstFrame` is where this sitting starts writing. A render interrupted by the
 * page closing has already landed every frame it finished in the job's frames
 * directory (each written atomically server-side via a .part rename, so a
 * half-received PNG is never counted), and the server's frame COUNT is therefore
 * an exact resume point — accurate to ONE FRAME, unlike an in-page encoder, which
 * can only resume at a segment boundary. `resumeFrom()` reads that count.
 *
 * MEASURED, and the reason this path did not become legacy when the in-page wasm
 * encoder arrived: whole-pipeline, back to back on the same deck, it runs at 30.5
 * ms/frame at 720p and 86.1 ms/frame at 1080p against the wasm encoder's 40.0 and
 * 92.8 — the PNG it is blamed for costs ~6 ms at 1080p, while a wasm H.264 frame
 * costs ~62. It is the FASTER browser encoder at any ordinary output size, and it
 * resumes at an exact frame rather than a segment. Its costs are the server's
 * scratch disk (gigabytes for a long 1080p render) and moving ~40x more bytes:
 * 60 KiB of PNG per frame where the wasm path sends ~1.4 KiB of H.264, which is
 * what makes the other encoder the right choice over a slow link.
 *
 * @param {object} o
 * @param {string} o.project Project name that owns the job.
 * @param {string} o.jobId   The job to fill.
 * @param {number} [o.firstFrame] Frame index this sitting starts at (default 0).
 * @returns {Promise<{addFrame:Function, finalize:Function, resumeFrom:Function}>}
 *
 * @example
 * const enc = await createJobFrameEncoder({ project: "Deck", jobId: "ab12" });
 * await enc.addFrame(canvas, { timestamp: 0, duration: 33333 });
 * const job = await enc.finalize(); // {state: "done", output: "Render.mp4", …}
 */
export async function createJobFrameEncoder({ project, jobId, firstFrame = 0 }) {
  let index = firstFrame;
  return {
    /** Command (async). PNG-encode `source` and POST it as the next job frame. */
    async addFrame(source, _meta) {
      const png = await canvasToPngBlob(source);
      await postRenderJobFrame(project, jobId, index, png);
      index += 1;
    },
    /** Query (async). The exact frame this job should continue from: the number of
     *  frames already on the server's disk. */
    async resumeFrom() {
      return framesOnServer(project, jobId);
    },
    /** Command (async). Ask the server for the shared encode; returns the job record. */
    async finalize() {
      if (index === 0) throw new Error("Browser render job: no frames were rendered to encode.");
      return finishRenderJob(project, jobId);
    },
  };
}

/**
 * Query (async). How many frames of `jobId` are already on the server — the
 * resume point for the upload encoder. Throws LOUDLY if the job is not in the
 * project's list (a resume against a job the server has forgotten must not
 * silently start over at frame 0 and produce a video missing its first half).
 *
 * @param {string} project
 * @param {string} jobId
 * @returns {Promise<number>}
 *
 * @example await framesOnServer("Deck", "ab12") // 420
 */
export async function framesOnServer(project, jobId) {
  const jobs = await listRenderJobs(project);
  const job = jobs.find((j) => j.id === jobId);
  if (!job)
    throw new Error(`Browser render job ${jobId} is no longer in project "${project}" on the server, so its already-rendered frames cannot be found. Delete it locally and submit again.`);
  return job.framesDone ?? 0;
}

export async function createServerMp4Encoder({ fps, crf = DEFAULT_CRF }) {
  const sessionId = await beginMp4Export();
  let count = 0;
  return {
    /** Command (async). PNG-encode `source` and POST it as the next frame. */
    async addFrame(source, _meta) {
      const png = await canvasToPngBlob(source);
      await postMp4ExportFrame(sessionId, count, png);
      count += 1;
    },
    /** Command (async). Encode the uploaded frames server-side; returns the .mp4 Blob. */
    async finalize() {
      if (count === 0) throw new Error("Server MP4 export: no frames were rendered to encode.");
      return encodeMp4Export(sessionId, { fps, crf });
    },
  };
}
