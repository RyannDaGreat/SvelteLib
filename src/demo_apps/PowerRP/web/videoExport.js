/**
 * VIDEO EXPORT (general) — the deterministic presentation → video pipeline.
 *
 * This module is FORMAT-AGNOSTIC. It owns the two things every video export
 * shares — (1) the DETERMINISTIC frame walk over the presentation timeline, and
 * (2) optional TEMPORAL-SUBSAMPLE motion blur — and drives a PLUGGABLE ENCODER.
 *
 * THREE encoders exist and none of them changed a line of this file, which is the
 * whole point of the seam:
 *   web/serverMp4Encoder.js createServerMp4Encoder  PNG per frame → server ffmpeg
 *                                                   → a downloadable Blob
 *   web/serverMp4Encoder.js createJobFrameEncoder   PNG per frame → a render JOB's
 *                                                   frame directory → shared encode
 *   web/mp4Encoder.js       createWasmMp4Encoder    single-threaded wasm H.264 in a
 *                                                   worker → .mp4 bytes, in the page
 * A WebM/VP9 encoder or an animated-GIF/APNG writer would be a fourth the same way.
 *
 * ── PIPELINE (frame source → encoder) ─────────────────────────────────────────
 *   time  ──sampleTimeline──▶ (slide, alpha)  ──renderFrame──▶ canvas  ──encoder──▶ .mp4
 * A pure timeline PLAN maps absolute presentation time → (slide, alpha); the
 * injected `renderFrame(index, alpha) → canvas` rasterizes a frame at the export
 * resolution (the caller wires it to the SAME deterministic camera path the
 * presenter/CLI use); the injected `encoder` consumes finished frames.
 *
 * ── ENCODER INTERFACE (pluggable) ─────────────────────────────────────────────
 *   encoder.addFrame(canvasSource, { timestamp, duration }) → Promise|void
 *   encoder.finalize() → Promise<*>   // the encoder's PRODUCT, passed through
 *   encoder.resumeFrom() → number     // OPTIONAL; see RESUMING below
 * The encoder owns codec/keyframe/muxing concerns; the pipeline never mentions
 * them, INCLUDING what "the finished thing" is: an in-page encoder finalizes to
 * bytes (web/mp4Encoder.js), a server-session encoder to a Blob and a render-job
 * encoder to a job record (web/serverMp4Encoder.js). exportVideo returns whatever
 * finalize returned, untouched.
 *
 * ── RESUMING (opts.startFrame) ────────────────────────────────────────────────
 * Because every frame is a pure function of its INDEX, the walk does not have to
 * start at zero. `startFrame` skips frames an earlier sitting already encoded — the
 * seam a resumable browser render is built on (web/browserRenderJobs.js). It is
 * the encoder, not the pipeline, that knows how far it got: the pipeline is handed
 * the number and trusts it.
 *
 * A SIMULATED DOCUMENT MAY NOT BE RESUMED, and nothing here can tell: "every frame
 * is a pure function of its INDEX" is exactly what simulated state gives up (see
 * below), so a resume at frame 500 restarts the trajectory from the initial
 * condition and encodes 500 frames of the WRONG motion onto the end of a correct
 * prefix. This pipeline is handed a plan and a renderer and has neither the
 * document nor the registry, so the refusal has to be made by the caller that does.
 * BOTH callers now make it: cli/render_job.js (core/document.stridedShardRefusal, and
 * it turns the frame skip off for the same reason) and web/browserRenderJobs.js, whose
 * `driveBrowserJob` is the first scope holding both the repaired doc and the registry
 * and refuses a resume of a simulated deck outright. That gap was open when this
 * paragraph was first written; it is closed.
 *
 * ── MOTION BLUR (temporal subsampling) ────────────────────────────────────────
 * `samples` (integer, DEFAULT 1) is the exposure subsample count. With samples=1
 * each output frame is one render at the frame-center time — zero extra cost,
 * the plain behavior. With samples=N>1, each output frame is the AVERAGE of N
 * renders taken at N evenly-spaced sub-times WITHIN that frame's 1/fps exposure
 * window (a box-filter temporal integral) → true motion blur. Crucially, the
 * pipeline sets the CONTROLLED TIME (`setTime`) for every sub-sample, so blur
 * applies to EVERYTHING time-driven — the tween/transition (via sampleTimeline's
 * alpha) AND ambient-clock effects (particle emitters, raycast-dither, and any
 * other consumer of render_gpu/particle_clock.particleTime()). Because those
 * effects read the controlled time, sampling time at sub-frame granularity blurs
 * them for free. Everything is a PURE function of (frameIndex, sampleIndex, fps),
 * so the export stays fully deterministic and reproducible.
 *
 * ── TWO CONSUMERS, ONE FRAME RECIPE ──────────────────────────────────────────
 * exportVideo walks the timeline IN ORDER into an encoder. The server-side
 * render-job worker (cli/render_job.js, whose page half is web/renderJobPage.js)
 * renders a STRIDED SHARD of the same timeline across parallel workers, so it
 * cannot use that walk — but its frames must be byte-identical to it. Both
 * therefore go through createFrameSampler, which owns the per-output-frame
 * recipe (sub-frame times → controlled time → sampleTimeline → render → average).
 *
 * ── SIMULATED STATE: AN EXPORT DICTATES ITS TIMESTEP ─────────────────────────
 * The FOURTH kind of state (manifest R7-9, core/simulation_history.js) reads `dt`
 * — the seconds one simulation step covers. In the presenter that is a MEASURED
 * frame interval; here it is DEFINITIONAL, so createFrameSampler DICTATES it
 * through setSimulationTimestepOverride and the max-timestep clamp never engages
 * (there is no measurement to correct). That is what makes an export exactly
 * reproducible while live playback is only approximately so.
 *
 * THE DIVISOR IS `fps * samples`, NOT `fps`, AND THAT IS THE WHOLE TRAP. Motion
 * blur renders `samples` sub-frames per output frame at `samples` DISTINCT
 * controlled times (subFrameTimes), and each one is a clock advance, so each one
 * rolls the simulation. A dictated `1/fps` would therefore advance the simulation
 * `samples` seconds for every second of video — a silently time-warped movie with
 * no error anywhere. `1/(fps*samples)` is exactly the spacing of consecutive
 * sub-times (including ACROSS an output-frame boundary), so the simulation
 * advances 1/fps per output frame at every sample count, which is the only reading
 * under which turning motion blur on does not change what the movie shows.
 *
 * ── POINTER INPUT: THE SECOND AMBIENT INPUT, DICTATED THE SAME WAY ────────────
 * R7-24 gave the pointer a seam of the same shape as the clock
 * (core/pointer_input.js). An export must DICTATE it too, for a blunter reason than
 * the timestep: **the editor's pointer feed keeps running while a render is in
 * flight**, so reading the ambient value would make an exported video follow whatever
 * the author's mouse happened to be doing — different every render, silently. So
 * createFrameSampler sets POINTER_REST and releases it, exactly as it does the
 * timestep, and that is what server.py's pointer-input export warning promises ("the
 * pointer renders at rest"). An OVERRIDE and not a freeze, because this render is
 * STATING a value rather than avoiding one — and it is the seam a future pointer
 * track plugs into unchanged, dictating sampled values here instead of rest.
 *
 * Node-runnable pure helpers (timelinePlan/sampleTimeline/subFrameTimes/
 * frameCount) — the node side of the worker imports them to compute a shard's
 * frame list. createFrameSampler and exportVideo need a DOM (canvas averaging)
 * and so are browser-only, but the timing math is unit-testable in node.
 */

import { ease } from "../core/interpolators.js";
import { resolveTransition } from "../core/transitions.js";
import { resetSimulation, setSimulationTimestepOverride } from "../core/simulation_history.js";
import { setPointerInputOverride, POINTER_REST } from "../core/pointer_input.js"; // the SECOND ambient input an export must dictate (R7-24)

/** Default frames per second for an export (UI default). */
export const DEFAULT_FPS = 30;
/** Default per-slide dwell (s) when a slide has no `autoAdvance` linger. The
 * presenter holds a slide until the user advances (indefinite); an export needs
 * a finite deterministic hold, so this is the export-only fallback. */
export const DEFAULT_HOLD_SECONDS = 2;
/** Default temporal subsample count — 1 = no motion blur (zero extra cost). */
export const DEFAULT_SAMPLES = 1;
/** RGBA channels per pixel — the accumulator stride. */
const CHANNELS = 4;

/**
 * Pure function. The presentation timeline PLAN for slides `startIndex`..
 * `endIndex` of `doc` — an ordered list of time SEGMENTS plus the total
 * duration, MATCHING the presenter (core/presentation.js): disabled slides are
 * skipped; each rendered slide contributes a HOLD, and each slide after the
 * first in the range is preceded by its transition-IN segment (when
 * `includeTransitions` and the transition has non-zero seconds). A slide's hold
 * length is its own `autoAdvance` linger when set, else `holdSeconds`.
 *
 * @param {object} doc PowerRP document (load-migrated: transitions resolved).
 * @param {object} [opts]
 * @param {number} [opts.startIndex] First slide index (default 0).
 * @param {number} [opts.endIndex] Last slide index inclusive (default last).
 * @param {boolean} [opts.includeTransitions] Include transition segments (default true).
 * @param {number} [opts.holdSeconds] Per-slide dwell fallback (default DEFAULT_HOLD_SECONDS).
 * @returns {{segments: {index:number, kind:"hold"|"transition", seconds:number, curve?:string}[], duration:number}}
 *
 * @example
 * // Two slides, a 0.5s tween into slide 1, 2s holds → 3 segments, 4.5s total.
 * timelinePlan({slides:[{},{transition:{type:"tween",seconds:0.5,curve:"smooth"}}]}, {holdSeconds:2})
 * // { segments:[{index:0,kind:"hold",seconds:2},{index:1,kind:"transition",seconds:0.5,curve:"smooth"},{index:1,kind:"hold",seconds:2}], duration:4.5 }
 */
export function timelinePlan(doc, { startIndex = 0, endIndex = doc.slides.length - 1, includeTransitions = true, holdSeconds = DEFAULT_HOLD_SECONDS } = {}) {
  const enabled = [];
  for (let i = startIndex; i <= endIndex; i++) if (doc.slides[i]?.enabled !== false) enabled.push(i);
  const segments = [];
  enabled.forEach((index, pos) => {
    if (pos > 0 && includeTransitions) {
      const t = resolveTransition(doc, index);
      const seconds = Math.max(0, t.seconds);
      if (seconds > 0) segments.push({ index, kind: "transition", seconds, curve: t.curve });
    }
    const linger = doc.slides[index].autoAdvance;
    const hold = Math.max(0, typeof linger === "number" ? linger : holdSeconds);
    segments.push({ index, kind: "hold", seconds: hold });
  });
  return { segments, duration: segments.reduce((a, s) => a + s.seconds, 0) };
}

/** Pure. The (index, alpha) for a segment at local time `localT` (seconds into
 *  the segment). Holds are alpha 1; transitions ease localT/seconds by curve. */
function segmentSample(seg, localT) {
  if (seg.kind === "hold") return { index: seg.index, alpha: 1 };
  const frac = seg.seconds > 0 ? localT / seg.seconds : 1;
  const easeFn = ease(seg.curve === "linear" ? "linear" : "cubic");
  return { index: seg.index, alpha: easeFn(Math.max(0, Math.min(1, frac))) };
}

/**
 * Pure function. timelinePlan for a RENDER JOB's `params` — the mapping from the
 * Render Center's stored parameter names to timelinePlan's options, including the
 * hold-seconds default.
 *
 * It exists because that mapping was written out by hand at three call sites (the
 * download-an-mp4 export, the browser render-job orchestrator, and the server
 * worker's page half). Three copies of "what a job's slide range means" is three
 * chances for two backends to render different movies from the same job record.
 * web/browserRenderJobs.js goes through here; the other two predate it and can
 * adopt it.
 *
 * @param {object} doc Document (load-migrated).
 * @param {object} params Job params: startIndex/endIndex/includeTransitions/holdSeconds.
 * @returns {{segments: object[], duration: number}}
 *
 * @example
 * // Two slides, no transitions, 1 s each → a 2 s timeline.
 * planForParams({slides: [{}, {}]}, {startIndex: 0, endIndex: 1, includeTransitions: false, holdSeconds: 1})
 * // {segments: [{index: 0, kind: "hold", seconds: 1}, {index: 1, kind: "hold", seconds: 1}], duration: 2}
 * @example
 * // An omitted holdSeconds falls back to DEFAULT_HOLD_SECONDS, not to zero.
 * planForParams({slides: [{}]}, {startIndex: 0, endIndex: 0, includeTransitions: false}).duration // 2
 */
export function planForParams(doc, params) {
  return timelinePlan(doc, {
    startIndex: params.startIndex,
    endIndex: params.endIndex,
    includeTransitions: params.includeTransitions,
    holdSeconds: params.holdSeconds ?? DEFAULT_HOLD_SECONDS,
  });
}

/**
 * Pure function. The (slide index, tween alpha) shown at absolute presentation
 * time `t` seconds, per `plan`. Clamps t to [0, duration]; the SAME ease the
 * presenter uses maps a transition's local time to alpha.
 *
 * @param {{segments:object[], duration:number}} plan From timelinePlan.
 * @param {number} t Absolute time in seconds.
 * @returns {{index:number, alpha:number}}
 *
 * @example
 * // At t=0 (start of slide 0's hold): slide 0, fully applied.
 * sampleTimeline(timelinePlan({slides:[{},{transition:{type:"tween",seconds:2,curve:"linear"}}]}, {holdSeconds:2}), 0) // {index:0, alpha:1}
 * @example
 * // 1s into slide 1's 2s LINEAR transition (starts at t=2): halfway.
 * sampleTimeline(timelinePlan({slides:[{},{transition:{type:"tween",seconds:2,curve:"linear"}}]}, {holdSeconds:2}), 3) // {index:1, alpha:0.5}
 */
export function sampleTimeline({ segments, duration }, t) {
  if (segments.length === 0) return { index: 0, alpha: 1 };
  const clamped = Math.max(0, Math.min(duration, t));
  const last = segments[segments.length - 1];
  let acc = 0;
  for (const seg of segments) {
    if (clamped < acc + seg.seconds || seg === last) return segmentSample(seg, clamped - acc);
    acc += seg.seconds;
  }
  return segmentSample(last, last.seconds);
}

/**
 * Pure function. The N sub-sample times (seconds) for output frame `frameIndex`
 * at `fps` with `samples` temporal subsamples: the CENTERS of N equal
 * sub-intervals within the frame's exposure window [i/fps, (i+1)/fps). N=1
 * yields the single frame-center time (a half-frame into the interval).
 *
 * @param {number} frameIndex 0-based output frame index.
 * @param {number} samples Temporal subsample count (≥1).
 * @param {number} fps Frames per second.
 * @returns {number[]} length `samples`, ascending.
 *
 * @example subFrameTimes(0, 1, 2) // [0.25]
 * @example subFrameTimes(1, 1, 2) // [0.75]
 * @example subFrameTimes(0, 2, 2) // [0.125, 0.375]
 */
export function subFrameTimes(frameIndex, samples, fps) {
  const times = [];
  for (let s = 0; s < samples; s++) times.push((frameIndex + (s + 0.5) / samples) / fps);
  return times;
}

/**
 * Pure function. The number of output frames for a `duration`-second timeline at
 * `fps` (rounded to the nearest whole frame; never negative).
 *
 * @example frameCount(4.5, 30) // 135
 * @example frameCount(0, 30) // 0
 */
export function frameCount(duration, fps) {
  return Math.max(0, Math.round(duration * fps));
}

/**
 * Command (browser — allocates the averaging scratch). THE per-output-frame
 * renderer: `sample(frameIndex)` produces ONE finished frame of the timeline,
 * motion blur included. `release()` frees the controlled-time override.
 *
 * Split out of exportVideo because there are now TWO consumers and only one may
 * own this recipe. exportVideo walks the whole timeline in order into an
 * encoder; the headless render-job worker (cli/render_job.js via
 * web/renderJobPage.js) renders a STRIDED SHARD of the same timeline —
 * frames k, k+n, k+2n… — so it cannot use a sequential loop, but it must produce
 * byte-identical frames. A second copy of the sub-frame averaging would be a
 * second definition of what motion blur MEANS.
 *
 * Sampling frame i: for each of `samples` sub-times t (subFrameTimes) it sets
 * the controlled time (`setTime(t)` — the caller wires this to the ambient
 * particle/shader clock so time-driven effects animate and blur), samples the
 * timeline (sampleTimeline → slide, alpha) and renders. With samples>1 the N
 * sub-frames are AVERAGED (box filter); samples=1 skips all averaging and
 * allocates no scratch, so it is exactly one render per frame.
 *
 * Every frame is a pure function of (frameIndex, fps, samples, plan) — nothing
 * carries over between frames — which is what makes a strided shard legitimate,
 * FOR EVERY DOCUMENT BUT A SIMULATED ONE. Simulated state (manifest R7-9) is the
 * one thing that does carry over: frame N is a function of frames 0..N-1, so the
 * strided walk above is refused for such a document BEFORE any browser is
 * launched (cli/render_job.js, core/document.stridedShardRefusal). This line used
 * to state the purity without the exception, which is exactly how a strided shard
 * of a pendulum would have shipped as a plausible wrong video.
 *
 * THE SIMULATION IS RESET HERE AND DICTATED HERE. Construction is the start of a
 * render, so `resetSimulation()` puts every `@` back on its authored initial
 * condition — a second export in one page must not inherit the first one's
 * trajectory — and `setSimulationTimestepOverride(1/(fps*samples))` makes every
 * step definitional rather than measured (see the module header for why the
 * divisor carries `samples`). `release()` returns the simulation to measured time,
 * beside the controlled-time release it already does.
 *
 * @param {object} o
 * @param {{segments:object[], duration:number}} o.plan Timeline (timelinePlan).
 * @param {(index:number, alpha:number)=>Promise<CanvasImageSource>} o.renderFrame
 *   Deterministic frame renderer at the export resolution (width×height).
 * @param {number} o.width  Output width in px.
 * @param {number} o.height Output height in px.
 * @param {number} o.fps    Frames per second.
 * @param {number} [o.samples] Temporal subsamples (default 1 = no motion blur).
 * @param {(t:number|null)=>void} [o.setTime] Controlled-time setter (default no-op).
 * @returns {{sample: (frameIndex:number)=>Promise<CanvasImageSource>, release: ()=>void}}
 *
 * @example
 * // const s = createFrameSampler({plan, renderFrame, width: 96, height: 64, fps: 6, setTime});
 * // await s.sample(0)  // → the canvas for output frame 0 (rendered at t = 0.5/6 s)
 * // s.release()        // → setTime(null) + measured dt: back to the deterministic freeze
 */
export function createFrameSampler({ plan, renderFrame, width, height, fps, samples = DEFAULT_SAMPLES, setTime = () => {} }) {
  const n = Math.max(1, Math.round(samples));
  // SIMULATED STATE (see the docblock): this render starts from the initial
  // condition, and its `dt` is DICTATED at the spacing of consecutive sub-frame
  // times — 1/(fps*n), because every sub-frame is its own clock advance and so its
  // own simulation step.
  resetSimulation();
  setSimulationTimestepOverride(1 / (fps * n));
  // POINTER INPUT (R7-24) IS DICTATED HERE FOR THE SAME REASON `dt` IS.
  // It is the second ambient input, and an export must not read the LIVE one: the
  // editor's pointer feed keeps running while a render is in flight, so without this
  // an exported video would follow whatever the author's mouse happened to be doing —
  // different every render, and silently so. Dictating POINTER_REST is what makes the
  // export reproducible, and it is exactly what `server.py`'s pointer-input export
  // warning promises the author ("the pointer renders at rest").
  //
  // An OVERRIDE rather than `withPointerFrozen`, deliberately: a freeze guards against
  // reading the ambient value, whereas this render is STATING one — and it is the seam
  // a future pointer track plugs into unchanged (it would dictate sampled values here
  // instead of rest, and nothing else in this file would change).
  setPointerInputOverride(POINTER_REST);
  // Averaging scratch — allocated ONLY when blurring (samples>1), so samples=1 is
  // truly zero extra cost. `accum` sums RGBA across sub-frames as floats; `blend`
  // holds the divided result the consumer reads.
  const accum = n > 1 ? new Float32Array(width * height * CHANNELS) : null;
  let blend = null;
  if (n > 1) {
    blend = document.createElement("canvas");
    blend.width = width;
    blend.height = height;
  }

  const renderAt = async (t) => {
    setTime(t); // controlled time BEFORE the render, so ambient-clock effects sample t
    const { index, alpha } = sampleTimeline(plan, t);
    return renderFrame(index, alpha);
  };

  return {
    async sample(frameIndex) {
      const times = subFrameTimes(frameIndex, n, fps);
      if (n === 1) return renderAt(times[0]);
      accum.fill(0);
      for (const t of times) {
        const canvas = await renderAt(t);
        const px = canvas.getContext("2d").getImageData(0, 0, width, height).data;
        for (let j = 0; j < accum.length; j++) accum[j] += px[j];
      }
      const out = new Uint8ClampedArray(accum.length);
      for (let j = 0; j < accum.length; j++) out[j] = accum[j] / n; // box-filter average
      blend.getContext("2d").putImageData(new ImageData(out, width, height), 0, 0);
      return blend;
    },
    release() {
      setTime(null); // release the controlled-time override
      setSimulationTimestepOverride(null); // …and return `dt` to MEASURED time
      setPointerInputOverride(null); // …and the pointer to the AMBIENT one (R7-24)
    },
  };
}

/**
 * Command (async, browser — allocates canvases, drives the encoder). Renders the
 * whole `plan` to video via the injected `encoder`, applying `samples`-way
 * temporal-subsample motion blur. Returns the encoder's finalized Blob.
 *
 * The frames themselves come from createFrameSampler (see it for the motion-blur
 * and controlled-time contract); this function owns only the WALK — in order,
 * abortable, one encoder timestamp per output frame.
 *
 * LOUD on abort (opts.signal) and on an empty timeline. Always releases the
 * controlled-time override in `finally` (setTime(null)) so the editor returns to
 * its deterministic freeze afterward.
 *
 * @param {object} o
 * @param {{segments:object[], duration:number}} o.plan Timeline (timelinePlan).
 * @param {(index:number, alpha:number)=>Promise<CanvasImageSource>} o.renderFrame
 *   Deterministic frame renderer at the export resolution (width×height).
 * @param {{addFrame:Function, finalize:Function}} o.encoder Pluggable encoder.
 * @param {number} o.width  Output width in px.
 * @param {number} o.height Output height in px.
 * @param {number} o.fps    Frames per second.
 * @param {number} [o.samples] Temporal subsamples (default 1 = no motion blur).
 * @param {(t:number|null)=>void} [o.setTime] Controlled-time setter (default no-op).
 * @param {(fraction:number, framesDone:number, total:number)=>void} [o.onProgress]
 *   Called after each output frame. `fraction` counts from the START of the
 *   timeline, not of this sitting, so a resumed render's bar continues rather
 *   than restarting.
 * @param {number} [o.startFrame] First output frame to render (default 0) — see
 *   the header's RESUMING note. Must be within [0, total].
 * @param {AbortSignal} [o.signal] Cancels the export (throws AbortError).
 * @returns {Promise<*>} whatever the encoder's finalize() produced
 */
export async function exportVideo({ plan, renderFrame, encoder, width, height, fps, samples = DEFAULT_SAMPLES, setTime = () => {}, onProgress, startFrame = 0, signal }) {
  const total = frameCount(plan.duration, fps);
  if (total === 0) throw new Error("Video export: the selected range produced no frames (empty range, or a zero total duration — e.g. transitions off with a 0s hold).");
  if (!(startFrame >= 0 && startFrame <= total))
    throw new Error(`Video export: startFrame ${startFrame} is outside this timeline's 0..${total} frames — a resume point that does not exist would silently produce the wrong movie.`);
  const usPerFrame = 1e6 / fps;
  const sampler = createFrameSampler({ plan, renderFrame, width, height, fps, samples, setTime });
  try {
    for (let i = startFrame; i < total; i++) {
      if (signal?.aborted) throw new DOMException("Video export cancelled.", "AbortError");
      const frameSource = await sampler.sample(i);
      await encoder.addFrame(frameSource, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) });
      onProgress?.((i + 1) / total, i + 1, total);
    }
  } finally {
    sampler.release(); // release the controlled-time override no matter what
  }
  return encoder.finalize();
}
