/**
 * MP4 / H.264 ENCODER — the first pluggable encoder for the general video-export
 * pipeline (web/videoExport.js). It implements that pipeline's tiny Encoder
 * interface — `addFrame(canvasSource, {timestamp, duration})` + `finalize() →
 * Blob` — on top of the browser's WebCodecs `VideoEncoder` (H.264/avc) and a
 * tiny in-browser MP4 muxer (`mp4-muxer`). Everything is offline in the page: no
 * server, no network. A different container/codec (WebM/VP9, GIF, server ffmpeg)
 * would be a sibling module implementing the SAME interface.
 *
 * WHY WebCodecs (not MediaRecorder): PowerRP is DETERMINISTIC
 * (RenderTree = pure(doc, [[slide, alpha]])). MediaRecorder captures a canvas in
 * real time — it drops frames and is non-reproducible, so it is the WRONG tool.
 * WebCodecs encodes the frames we hand it, exactly, frame by frame.
 *
 * AVAILABILITY (reported honestly): WebCodecs `VideoEncoder` is exposed only in a
 * SECURE CONTEXT — HTTPS or http://localhost (127.0.0.1/::1). On a plain-HTTP
 * LAN-IP origin `window.isSecureContext` is false and `VideoEncoder` is
 * undefined, so MP4 export is UNAVAILABLE there and fails LOUDLY (see
 * videoExportUnavailableReason) — the same secure-context gate that makes the app
 * serve trusted HTTPS when available (run_server.sh) and use localhost in dev.
 * There is deliberately NO MediaRecorder fallback (it would be non-deterministic).
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/** Force a keyframe at least this often (seconds) so the .mp4 stays seekable. */
export const KEYFRAME_INTERVAL_SECONDS = 2;

/** Quality presets as H.264 target BITS-PER-PIXEL-PER-FRAME (bpp). bitrate =
 * width·height·fps·bpp. Static slide content compresses far below these, so the
 * encoder spends only the bits it needs; the ceiling just bounds motion frames
 * (transitions, video/animated widgets). 0.09 ≈ visually lossless for slides. */
export const QUALITY_PRESETS = { low: 0.04, medium: 0.09, high: 0.18 };

// Backpressure: keep the encoder's internal queue bounded so a long deck doesn't
// balloon memory faster than the (software) encoder drains it.
const ENCODE_QUEUE_HIGH_WATER = 16;
const ENCODE_QUEUE_LOW_WATER = 8;

// H.264 (avc1) level table: [level_idc hex, MaxFrameSize (macroblocks),
// MaxMacroblocksPerSecond]. Standard Annex-A limits; a 16×16-px macroblock. The
// LOWEST level whose limits cover the frame is chosen so the encoder is asked
// for exactly the capability the resolution needs (too low a level for a big
// frame makes configure() reject).
const AVC_LEVELS = [
  { hex: "1e", maxFs: 1620, maxMbps: 40500 },      // 3.0  — 720×480
  { hex: "1f", maxFs: 3600, maxMbps: 108000 },     // 3.1  — 1280×720
  { hex: "20", maxFs: 5120, maxMbps: 216000 },     // 3.2
  { hex: "28", maxFs: 8192, maxMbps: 245760 },     // 4.0  — 1920×1080@30
  { hex: "2a", maxFs: 8704, maxMbps: 522240 },     // 4.2  — 1080p@60
  { hex: "32", maxFs: 22080, maxMbps: 589824 },    // 5.0  — 2560×1600
  { hex: "33", maxFs: 36864, maxMbps: 983040 },    // 5.1  — 4096×2048
  { hex: "34", maxFs: 36864, maxMbps: 2073600 },   // 5.2  — 4K@60
  { hex: "3c", maxFs: 139264, maxMbps: 4177920 },  // 6.0  — 8K
  { hex: "3e", maxFs: 139264, maxMbps: 16711680 }, // 6.2  — 8K@120
];
const MACROBLOCK = 16; // px per macroblock edge (H.264)
// Baseline profile (profile_idc 0x42, constraint flags 0x00): the most broadly
// supported ENCODE profile across Chrome's software/hardware encoders (no
// B-frames — fine for slides). The container's real profile/level come from the
// encoder's emitted SPS, not this hint.
const AVC_PROFILE_PREFIX = "avc1.4200";

/**
 * Pure function. The H.264 codec string for `width`×`height` at `fps`: Baseline
 * profile plus the LOWEST standard level whose frame-size and macroblock-rate
 * limits both cover the request (falls back to the top level for absurd sizes,
 * which the encoder then rejects loudly).
 *
 * @param {number} width  Frame width in px.
 * @param {number} height Frame height in px.
 * @param {number} fps    Frames per second.
 * @returns {string} e.g. "avc1.42001f"
 *
 * @example avcCodecString(1280, 720, 30) // "avc1.42001f"  (level 3.1)
 * @example avcCodecString(1920, 1080, 30) // "avc1.420028" (level 4.0)
 * @example avcCodecString(3840, 2160, 30) // "avc1.420033" (level 5.1)
 */
export function avcCodecString(width, height, fps) {
  const fs = Math.ceil(width / MACROBLOCK) * Math.ceil(height / MACROBLOCK);
  const mbps = fs * fps;
  const level = AVC_LEVELS.find((l) => fs <= l.maxFs && mbps <= l.maxMbps) ?? AVC_LEVELS[AVC_LEVELS.length - 1];
  return AVC_PROFILE_PREFIX + level.hex;
}

/**
 * Pure function. The H.264 target bitrate (bits/s) for `width`×`height` at `fps`
 * and a bits-per-pixel-per-frame factor `bpp` (see QUALITY_PRESETS).
 *
 * @example qualityBitrate(1920, 1080, 30, 0.09) // 5598720
 * @example qualityBitrate(1280, 720, 30, 0.04) // 1105920
 */
export function qualityBitrate(width, height, fps, bpp) {
  return Math.round(width * height * fps * bpp);
}

/**
 * Query. Whether MP4 export can run here — WebCodecs `VideoEncoder` + `VideoFrame`
 * are present (they are gated to secure contexts). Reads globals.
 * @returns {boolean}
 */
export function isVideoExportAvailable() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/**
 * Query. A human explanation of WHY MP4 export is unavailable here, or null when
 * it IS available. Names the secure-context requirement and the concrete origin
 * state so the failure is actionable (never a silent no-op). Reads globals.
 * @returns {string|null}
 */
export function videoExportUnavailableReason() {
  if (isVideoExportAvailable()) return null;
  const secure = typeof window !== "undefined" ? window.isSecureContext : false;
  return (
    "MP4 export needs the WebCodecs VideoEncoder API, which browsers expose only in a SECURE CONTEXT " +
    "(HTTPS or http://localhost). " +
    (secure
      ? "This is a secure context but the browser still has no VideoEncoder — try a current Chrome/Edge (or a recent Safari/Firefox)."
      : "This origin is NOT secure (window.isSecureContext === false — e.g. plain http:// on a LAN IP), so VideoEncoder is unavailable. Open the editor over https:// or http://localhost.") +
    " (No MediaRecorder fallback: it drops frames and would not be frame-exact.)"
  );
}

/** Near-pure helper (awaits encoder drain). Resolves once the encoder's queue
 *  falls to `target`, via `dequeue` events — the backpressure valve. */
function drainTo(encoder, target) {
  if (encoder.encodeQueueSize <= target) return Promise.resolve();
  return new Promise((resolve) => {
    const onDequeue = () => {
      if (encoder.encodeQueueSize <= target) {
        encoder.removeEventListener("dequeue", onDequeue);
        resolve();
      }
    };
    encoder.addEventListener("dequeue", onDequeue);
  });
}

/**
 * Command (async). Builds an MP4/H.264 encoder for `width`×`height` @ `fps` at
 * `bitrate`, implementing the video-export Encoder interface:
 *   addFrame(canvasSource, { timestamp, duration }) — encode one frame; forces a
 *     keyframe at frame 0 and every KEYFRAME_INTERVAL_SECONDS (seekability);
 *     applies backpressure so a long deck can't outrun the encoder.
 *   finalize() → Promise<Blob> — flush, mux (moov FIRST via fastStart so the
 *     file is instantly seekable), and return the "video/mp4" bytes.
 *
 * Throws LOUDLY when WebCodecs is unavailable (secure-context gate) or the
 * encoder rejects the codec config. An async encoder error is captured and
 * re-thrown at the next addFrame/finalize (never swallowed).
 *
 * @param {object} o
 * @param {number} o.width  Output width in px (even — H.264 4:2:0).
 * @param {number} o.height Output height in px (even).
 * @param {number} o.fps    Frames per second.
 * @param {number} o.bitrate Target H.264 bitrate (bits/s).
 * @param {number} [o.keyframeIntervalSeconds] Keyframe cadence (default 2s).
 * @returns {Promise<{addFrame:Function, finalize:Function}>}
 */
export async function createMp4Encoder({ width, height, fps, bitrate, keyframeIntervalSeconds = KEYFRAME_INTERVAL_SECONDS }) {
  const reason = videoExportUnavailableReason();
  if (reason) throw new Error(reason);

  const codec = avcCodecString(width, height, fps);
  const config = { codec, width, height, bitrate, framerate: fps };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported)
    throw new Error(`MP4 export: this browser's H.264 encoder rejected ${codec} at ${width}×${height} @ ${fps}fps, ${bitrate}bps. Try a smaller resolution or a lower fps.`);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height, frameRate: fps },
    fastStart: "in-memory",
  });

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; },
  });
  encoder.configure(config);

  const keyEvery = Math.max(1, Math.round(keyframeIntervalSeconds * fps));
  let count = 0;

  return {
    /** Command (async). Encode one frame; awaits drain under backpressure. */
    async addFrame(source, { timestamp, duration }) {
      if (encoderError) throw encoderError;
      const frame = new VideoFrame(source, { timestamp, duration });
      encoder.encode(frame, { keyFrame: count % keyEvery === 0 });
      frame.close();
      count += 1;
      if (encoder.encodeQueueSize > ENCODE_QUEUE_HIGH_WATER) await drainTo(encoder, ENCODE_QUEUE_LOW_WATER);
    },
    /** Command (async). Flush + mux; returns the finished .mp4 Blob. */
    async finalize() {
      try {
        await encoder.flush();
        if (encoderError) throw encoderError;
        muxer.finalize();
        return new Blob([muxer.target.buffer], { type: "video/mp4" });
      } finally {
        // close() throws if already closed by the error path — swallow ONLY that
        // cleanup race (the real error, if any, is already propagating).
        try { encoder.close(); } catch { /* already closed */ }
      }
    },
  };
}
