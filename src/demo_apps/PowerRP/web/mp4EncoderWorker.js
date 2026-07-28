/**
 * THE H.264 ENCODE WORKER — where the wasm encoder actually lives.
 *
 * It exists for one reason: compressing a 1080p frame with a single-threaded wasm
 * H.264 encoder is hundreds of milliseconds of straight-line computation, and on
 * the main thread that would freeze the editor for the entire length of a render.
 * The page renders frames (which it must — the Skia/WebGL2 surface and the whole
 * plugin graph need a DOM) and ships their RGBA here.
 *
 * SINGLE-THREADED ON PURPOSE. A multithreaded wasm build would need
 * SharedArrayBuffer → cross-origin isolation → HTTPS, and PowerRP must work on
 * plain HTTP from a LAN IP. This worker is a plain module worker, which needs
 * nothing of the sort. See web/mp4Encoder.js's header for the full capability
 * measurement.
 *
 * SEGMENTS. The encoder library only yields a finished .mp4 when finalized, so a
 * job is encoded as consecutive fixed-length SEGMENTS, each from its own encoder
 * instance and therefore beginning on an IDR. A closed segment is posted straight
 * back so the page can persist it; that is what makes a render resumable. The
 * caller stitches the segments (web/mp4Samples.js).
 *
 * A CLASSIC WORKER, NOT A MODULE WORKER, AND THAT IS FORCED. The encoder ships as
 * a webpack `libraryTarget: "var"` bundle — it assigns a global `HME` and exports
 * nothing at all (no ESM exports, no `module.exports`). Imported as a module its
 * `var HME` would be module-scoped and therefore invisible; loaded with
 * `importScripts` it lands on the worker global, which is the library's designed
 * usage. Its wasm is base64-inlined in that same file, so there is no second fetch
 * and no .wasm MIME configuration to get wrong on a plain-HTTP origin.
 *
 * PROTOCOL (all messages are {type, …}):
 *   in   init   {encoderScriptUrl, width, height, fps, qp, speed, framesPerSegment,
 *                firstSegmentIndex, firstFrame}
 *   in   frame  {buffer}          RGBA bytes, TRANSFERRED (zero-copy)
 *   in   finish {}                close the partial segment and stop
 *   out  ready   {}               the wasm module is loaded and init is complete
 *   out  ack     {}               one frame consumed (the caller's backpressure)
 *   out  segment {index, firstFrame, frames, bytes}   bytes TRANSFERRED back
 *   out  done    {}               after finish, once the last segment is posted
 *   out  error   {message, stack} anything at all went wrong
 *
 * EVERY failure is posted as `error` and the worker stops accepting frames. There
 * is no path on which a frame is silently dropped: the caller counts frames and
 * refuses to write a movie whose segments do not add up.
 */

/** The one open session: null until `init`. */
let session = null;

/**
 * Command (async; allocates wasm memory). A configured, initialized encoder
 * instance for one segment. Its first frame is always an IDR, which is precisely
 * why a segment boundary is a valid concatenation point.
 *
 * `groupOfPictures` is set to the segment length so there is exactly ONE keyframe
 * per segment: a second keyframe inside a segment would cost bytes for a seek
 * point the segment boundary already provides.
 *
 * @param {object} cfg {width, height, fps, qp, speed, framesPerSegment}
 * @returns {Promise<object>} an initialized encoder
 */
async function newSegmentEncoder(cfg) {
  const enc = await self.HME.createH264MP4Encoder();
  enc.width = cfg.width;
  enc.height = cfg.height;
  enc.frameRate = cfg.fps;
  enc.quantizationParameter = cfg.qp;
  enc.speed = cfg.speed;
  enc.groupOfPictures = cfg.framesPerSegment;
  // A unique filename per segment: the library's virtual filesystem is SHARED
  // between encoder instances, so a fixed name would have two live segments
  // writing over each other.
  enc.outputFilename = `segment_${cfg.nextIndex}.mp4`;
  enc.initialize();
  return enc;
}

/**
 * Command (frees the encoder, posts a message). Finalize the open segment, post
 * its bytes back (transferred), and clear it. A no-op when the segment has no
 * frames — an empty segment is not a segment.
 */
function closeSegment() {
  const s = session;
  if (!s.encoder || s.framesInSegment === 0) return;
  s.encoder.finalize();
  const bytes = s.encoder.FS.readFile(s.encoder.outputFilename);
  // Copy out of the wasm heap before delete() frees it, into a standalone buffer
  // that can be transferred to the page.
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  s.encoder.FS.unlink(s.encoder.outputFilename);
  s.encoder.delete();
  s.encoder = null;
  const index = s.nextIndex;
  const firstFrame = s.segmentFirstFrame;
  const frames = s.framesInSegment;
  s.nextIndex += 1;
  s.framesInSegment = 0;
  s.segmentFirstFrame = firstFrame + frames;
  self.postMessage({ type: "segment", index, firstFrame, frames, bytes: out.buffer }, [out.buffer]);
}

/**
 * Command (async; encodes into wasm memory). Add one RGBA frame, opening a new
 * segment first if none is live and closing the current one when it is full.
 *
 * @param {ArrayBuffer} buffer RGBA bytes, width*height*4.
 */
async function addFrame(buffer) {
  const s = session;
  const expected = s.cfg.width * s.cfg.height * 4;
  if (buffer.byteLength !== expected)
    throw new Error(`frame is ${buffer.byteLength} bytes but ${s.cfg.width}×${s.cfg.height} RGBA is ${expected}`);
  if (!s.encoder) s.encoder = await newSegmentEncoder({ ...s.cfg, nextIndex: s.nextIndex });
  s.encoder.addFrameRgba(new Uint8Array(buffer));
  s.framesInSegment += 1;
  if (s.framesInSegment >= s.cfg.framesPerSegment) closeSegment();
}

/** A serial queue: frames must be encoded in the order they arrive, and each
 *  addFrame awaits a wasm instantiation on a segment boundary. */
let tail = Promise.resolve();
const serial = (fn) => { tail = tail.then(fn); return tail; };

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    if (session) { self.postMessage({ type: "error", message: "a session is already open" }); return; }
    serial(async () => {
      try {
        // The library is loaded HERE rather than at worker start because only the
        // page can resolve its URL (see the header — it is a classic script whose
        // path comes from the bundler).
        if (!self.HME) self.importScripts(m.encoderScriptUrl);
        if (!self.HME?.createH264MP4Encoder)
          throw new Error(`${m.encoderScriptUrl} loaded but defined no global HME.createH264MP4Encoder — the encoder bundle is not the expected build`);
        session = {
          cfg: {
            width: m.width, height: m.height, fps: m.fps, qp: m.qp, speed: m.speed,
            framesPerSegment: m.framesPerSegment,
          },
          encoder: null,
          framesInSegment: 0,
          nextIndex: m.firstSegmentIndex,
          segmentFirstFrame: m.firstFrame,
        };
        self.postMessage({ type: "ready" });
      } catch (err) {
        self.postMessage({ type: "error", message: String(err?.message ?? err), stack: err?.stack ?? null });
      }
    });
    return;
  }
  if (!session) { self.postMessage({ type: "error", message: `received "${m.type}" before init` }); return; }

  if (m.type === "frame") {
    serial(async () => {
      try {
        await addFrame(m.buffer);
        self.postMessage({ type: "ack" });
      } catch (err) {
        self.postMessage({ type: "error", message: String(err?.message ?? err), stack: err?.stack ?? null });
        session = null; // stop accepting work; the page re-throws at its next call
      }
    });
    return;
  }
  if (m.type === "finish") {
    serial(async () => {
      try {
        closeSegment();
        self.postMessage({ type: "done" });
      } catch (err) {
        self.postMessage({ type: "error", message: String(err?.message ?? err), stack: err?.stack ?? null });
      }
    });
    return;
  }
  self.postMessage({ type: "error", message: `unknown message type ${JSON.stringify(m.type)}` });
};
