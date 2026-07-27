/**
 * Video V5 frame-extraction worker — the OFF-MAIN-THREAD half of the V5 video
 * pipeline (render_gpu/skia/video_v5.js is the main-thread half).
 *
 * WHY THIS EXISTS (the V5 hypothesis): the existing video path
 * (render_gpu/gpu/video_registry.js) uploads each frame with
 * texImage2D(<video>), whose YUV->RGBA colour conversion runs on the MAIN
 * thread — the per-frame cost that competes with drag/pan input handling. V5
 * moves that conversion off the main thread: the main thread hands this worker a
 * transferred `ReadableStream<VideoFrame>` (from a MediaStreamTrackProcessor on
 * the <video>'s captureStream track); the worker reads each decoded VideoFrame,
 * converts it to an already-RGBA ImageBitmap with createImageBitmap (the
 * conversion, now here), closes the frame, and transfers the ImageBitmap back.
 * The main thread then only does texImage2D(ImageBitmap) — a plain upload of
 * already-converted pixels, no colour convert.
 *
 * MULTIPLEXED: one worker serves every clip; each attached clip has a numeric
 * `id` (assigned by the registry) so N videos share ONE extra thread.
 *
 * BACKPRESSURE: MediaStreamTrackProcessor keeps a small internal queue and drops
 * the OLDEST frames when the reader can't keep up — so a slow main thread makes
 * this worker skip stale frames (show the newest), never accumulate unbounded
 * VideoFrames. We await createImageBitmap per frame (process one at a time), so
 * the drop happens upstream in the processor, not as a growing queue here.
 *
 * FRAME LIFETIME (loud discipline): every VideoFrame is close()d in a `finally`
 * — a leaked VideoFrame permanently stalls the decoder (a hard-to-see hang), so
 * this is not optional. Errors are POSTED BACK (type:"error"), never swallowed.
 *
 * @example // main: worker.postMessage({type:"attach", id, readable}, [readable])
 * @example // worker->main: {type:"frame", id, bitmap, width, height, seq}  (bitmap transferred)
 */

/** id -> {reader, cancelled} — one active frame-read loop per attached clip. */
const loops = new Map();

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "attach") attach(msg.id, msg.readable);
  else if (msg.type === "detach") detach(msg.id);
};

/**
 * Command (starts an async read loop; posts frames back). Reads VideoFrames from
 * the transferred readable until it ends or the clip is detached, converting each
 * to an ImageBitmap off the main thread. Replaces any prior loop for `id` (the
 * clip's <video> was re-created).
 *
 * @param {number} id the registry's per-clip id
 * @param {ReadableStream} readable a transferred ReadableStream<VideoFrame>
 */
async function attach(id, readable) {
  detach(id); // supersede any prior loop for this id
  const reader = readable.getReader();
  const loop = { reader, cancelled: false };
  loops.set(id, loop);
  let seq = 0;
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || loop.cancelled) { frame?.close(); break; }
      let bitmap;
      try {
        // THE off-main-thread work: VideoFrame (often YUV) -> RGBA ImageBitmap.
        bitmap = await createImageBitmap(frame);
      } finally {
        frame.close(); // ALWAYS release — a leaked VideoFrame stalls the decoder
      }
      if (loop.cancelled) { bitmap.close(); break; }
      seq += 1;
      self.postMessage({ type: "frame", id, bitmap, width: bitmap.width, height: bitmap.height, seq }, [bitmap]);
    }
  } catch (err) {
    // Reported, never swallowed (the registry marks the src errored + logs).
    self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
  } finally {
    if (loops.get(id) === loop) loops.delete(id);
  }
}

/**
 * Command (cancels a clip's read loop). Wakes the pending read() (which then
 * resolves done) and forgets the loop. Idempotent / no-op for an unknown id.
 *
 * @param {number} id the registry's per-clip id
 */
function detach(id) {
  const loop = loops.get(id);
  if (!loop) return;
  loop.cancelled = true;
  // cancel() unblocks the awaiting read(); its promise rejecting is expected
  // teardown, but reported (never silently swallowed) per the loud-failure rule.
  loop.reader.cancel().catch((err) => console.warn("video_v5_worker: reader.cancel() rejected during detach —", (err && err.message) || err));
  loops.delete(id);
}
