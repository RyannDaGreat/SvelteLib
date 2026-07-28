/**
 * PowerRP headless RENDER-JOB worker — the frame producer for a DETACHED
 * server-side MP4 render (server/server.py's render-job supervisor spawns it).
 *
 * It is `cli/render.js` scaled from ONE still to a whole timeline, and it exists
 * because the browser must stop being the renderer: a page refresh, a closed
 * laptop, or a Vite HMR reload used to destroy an in-flight export with no way to
 * recover it. Here the browser only SUBMITS; this process makes the pixels and the
 * server owns the progress, so any tab can ask "how far along?" at any time.
 *
 * ── WHAT IT WRITES ────────────────────────────────────────────────────────────
 * `frame_%06d.png` into the job's frames/ dir, one per output frame of its SHARD.
 * The file COUNT is the progress signal — no IPC, no heartbeat file, nothing to
 * lose. A supervisor (or any HTTP client) reads it by listing a directory.
 *
 * ── THE TIMELINE IS THE CLIENT'S TIMELINE ─────────────────────────────────────
 * timelinePlan/sampleTimeline/frameCount are imported from web/videoExport.js —
 * the SAME pure helpers the in-browser export walks (that module's header calls
 * them out as node-runnable for exactly this reason). Re-deriving hold/transition
 * segment math here would be a second home for it, and the two would drift.
 *
 * ── AMBIENT TIME: WHY setParticleTimeOverride IS MANDATORY ────────────────────
 * render_gpu/particle_clock.js has two regimes, and its PAUSED regime returns a
 * FIXED freeze time for the editor, thumbnails, the pixel service AND cli/render.js
 * — correct for a still, catastrophic for a movie. Every particleTime() consumer
 * (particle emitters, rainy-window, raycast-dither, glitch, sky, the cursor spin)
 * would read the same `t` on every frame, so the export would be a video of a
 * FROZEN sparkler. It would not error; it would just be silently wrong. The
 * in-browser pipeline already avoids this by driving the clock per frame
 * (videoExport's `setTime`, wired to setParticleTimeOverride in app.svelte.js), so
 * this worker does the identical thing — the clock is set from (frameIndex, fps)
 * BEFORE each render, which keeps every frame a pure function of the frame index.
 *
 * ── SHARDING: WHY FRAME-RANGE PARALLELISM IS SOUND HERE ───────────────────────
 * `--shard k --shards n` renders frames k, k+n, k+2n, … STRIDED (not contiguous)
 * so that a deck whose slides differ wildly in cost still spreads evenly across
 * workers. This is only legitimate because no document state is AUTOREGRESSIVE:
 * every widget is either PROPERTY state (computable from [[slide, alpha]] alone)
 * or RECORDABLE state (needs an ambient `t`, but is a pure function of it —
 * particle_clock's own docstring says a particle's picture is "a pure function of
 * (params, t, seed)"). Frame N therefore never needs frame N-1, and a worker can
 * jump straight to its own frames. If a genuinely autoregressive widget is ever
 * added — a physics sim carrying velocity across frames — this striding becomes
 * silently WRONG and the supervisor must fall back to a single shard.
 *
 * Parallelism is not a micro-optimisation here: a material-heavy slide measures
 * MINUTES per frame on this software surface (node has no GL context, so every
 * generative SkSL material runs per-pixel on the CPU), so the shard count is the
 * difference between a usable render and a multi-day one.
 *
 * ── KNOWN BOUND: MEDIA DOES NOT RENDER HEADLESSLY ─────────────────────────────
 * Like cli/render.js, this passes an EMPTY media map, so image/video widgets draw
 * as NOTHING. That is a silently wrong picture, so it is not left to be
 * discovered: the supervisor inspects the snapshot at SUBMIT time and records a
 * loud warning on the job (server.py's media_warning), which the Render Center
 * shows on the job itself.
 *
 * Usage (spawned by the server; runnable by hand for debugging):
 *   node cli/render_job.js <jobDir> [--shard K] [--shards N]
 * where <jobDir> holds job.json (the params) and doc.json (the SNAPSHOT).
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { deserialize, repairedDocument } from "../core/document.js";
import { cameraRect } from "../core/derive.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { fitRectView } from "../core/view.js";
import { cameraFrameIR, evaluatedStateAt } from "../web/cameraFrame.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { cameraAntialias, antialiasCoverage } from "../render_gpu/skia/render_settings.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { timelinePlan, sampleTimeline, frameCount } from "../web/videoExport.js";
import { parseArgs } from "./render.js";

/** One PNG pixel per device pixel — matches the editor's PNG export and cli/render.js. */
const DPR = 1;
/** Zero-padding for frame filenames. MUST equal server.py's EXPORT_FRAME_PAD: the
 *  ffmpeg input pattern is `frame_%06d.png`, and the padding is what makes the
 *  names sort lexicographically == numerically. */
const FRAME_INDEX_PAD = 6;

/**
 * Pure function. The output frame indices this shard owns — a STRIDE over the
 * whole range, so cost variation across the timeline spreads evenly rather than
 * handing one worker every expensive slide.
 *
 * @param {number} total Total output frames in the timeline.
 * @param {number} shard 0-based shard index.
 * @param {number} shards Number of shards (≥ 1).
 * @returns {number[]} ascending frame indices
 *
 * @example shardFrames(10, 0, 3) // [0, 3, 6, 9]
 * @example shardFrames(10, 2, 3) // [2, 5, 8]
 * @example shardFrames(4, 0, 1) // [0, 1, 2, 3]
 */
export function shardFrames(total, shard, shards) {
  const frames = [];
  for (let i = shard; i < total; i += shards) frames.push(i);
  return frames;
}

/**
 * Pure function. The absolute presentation time (seconds) at the CENTRE of output
 * frame `frameIndex` at `fps` — the single sub-sample time videoExport's
 * subFrameTimes yields for samples=1, restated here because this worker renders
 * exactly one sample per frame (see the module header on motion blur).
 *
 * @param {number} frameIndex 0-based output frame index.
 * @param {number} fps Frames per second (> 0).
 * @returns {number} seconds
 *
 * @example frameCentreTime(0, 30) // 0.016666666666666666
 * @example frameCentreTime(1, 2) // 0.75
 */
export function frameCentreTime(frameIndex, fps) {
  return (frameIndex + 0.5) / fps;
}

/**
 * Pure function. The frame filename for an output index, zero-padded so a plain
 * lexicographic listing is numeric order (what ffmpeg's %06d pattern requires).
 *
 * @param {number} index 0-based output frame index.
 * @returns {string}
 *
 * @example frameFileName(0) // "frame_000000.png"
 * @example frameFileName(1234) // "frame_001234.png"
 */
export function frameFileName(index) {
  return `frame_${String(index).padStart(FRAME_INDEX_PAD, "0")}.png`;
}

/**
 * Command (reads the job dir, writes PNGs). Renders this shard's frames of the
 * job's timeline into `<jobDir>/frames/`.
 *
 * Args:
 *   jobDir (string): the job directory holding job.json + doc.json
 *   shard (number): 0-based shard index
 *   shards (number): total shard count
 *
 * Returns:
 *   Promise<{rendered: number, total: number}>
 *
 * Untested as a unit (it needs a real job dir and a CanvasKit surface); the
 * end-to-end server test tests/render_jobs_test.py exercises it.
 */
export async function runShard(jobDir, shard, shards) {
  const job = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"));
  const docJson = await readFile(path.join(jobDir, "doc.json"), "utf8");
  const framesDir = path.join(jobDir, "frames");
  await mkdir(framesDir, { recursive: true });

  const { width, height, fps, background, startIndex, endIndex, includeTransitions, holdSeconds, quality } = job.params;
  const registry = createRegistry();
  registerAll(registry, createCommands());
  // The editor's load-boundary repair, exactly as cli/render.js runs it, so the
  // job's pixels cannot drift from the editor's. Repairs are reported, never silent.
  const { doc } = repairedDocument(deserialize(docJson), registry);
  const plan = timelinePlan(doc, { startIndex, endIndex, includeTransitions, holdSeconds });
  const total = frameCount(plan.duration, fps);
  if (total === 0)
    throw new Error("render_job: the selected range produced no frames (empty range, or a zero total duration — e.g. transitions off with a 0s hold).");

  const mine = shardFrames(total, shard, shards);
  let rendered = 0;
  for (const frameIndex of mine) {
    const outPath = path.join(framesDir, frameFileName(frameIndex));
    // RESUME: a frame already on disk is a FINISHED frame (writes are atomic —
    // see below), so a job re-queued after a server restart skips what it has and
    // picks up where it stopped instead of re-rendering hours of work.
    if (existsSync(outPath)) continue;
    // AMBIENT TIME FIRST, before anything reads it (see the header): every
    // particleTime() consumer must see THIS frame's t, not the still-image freeze.
    const t = frameCentreTime(frameIndex, fps);
    setParticleTimeOverride(t);
    const { index, alpha } = sampleTimeline(plan, t);
    const state = evaluatedStateAt(doc, index, alpha, registry);
    const rect = cameraRect(state, doc.meta);
    const commands = cameraFrameIR(state, doc.meta, registry);
    const view = fitRectView(rect, width, height, DPR);
    const antialias = antialiasCoverage(cameraAntialias(state));
    // `background` (the user's letterbox colour) clears the whole frame; the
    // camera's own background then fills the camera rect as the IR's first world
    // rect — the same composite the in-browser export builds with fillRect+drawImage.
    const png = await renderToPng(commands, view, { width, height, background, media: {}, antialias, quality });
    // ATOMIC: write a temp file then rename. The server's progress signal is a
    // COUNT of frame_*.png files, and resume treats any such file as complete —
    // both would be wrong if a killed worker could leave a half-written PNG behind.
    //
    // The temp name carries THIS PROCESS'S pid, and that is not decoration. A
    // SIGKILLed server cannot reap its workers, so they keep rendering as orphans;
    // when the next server boots and resumes the job it spawns a fresh worker for
    // the same shard, and for a while TWO processes are writing the same frames.
    // With one shared ".part" name they raced and one lost its file mid-rename
    // (ENOENT) — a resumed job died on its own leftovers. Per-pid temp names make
    // the overlap merely wasteful instead of fatal: whichever finishes last renames
    // over the other, and since a frame is a pure function of (snapshot, index) the
    // two are byte-identical anyway.
    const tmpPath = `${outPath}.${process.pid}.part`;
    await writeFile(tmpPath, Buffer.from(png));
    await rename(tmpPath, outPath);
    rendered += 1;
  }
  // Release the override so a reused process (a test importing this) returns to
  // the deterministic freeze regime, mirroring videoExport's `finally setTime(null)`.
  setParticleTimeOverride(null);
  return { rendered, total };
}

/** Command (the CLI entry). Renders one shard and prints a one-line summary. */
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), new Set());
  if (positional.length !== 1) {
    console.error("Usage: node render_job.js <jobDir> [--shard K] [--shards N]");
    process.exit(1);
  }
  const shards = Number.isFinite(flags.shards) ? flags.shards : 1;
  const shard = Number.isFinite(flags.shard) ? flags.shard : 0;
  if (!(shards >= 1) || !(shard >= 0) || shard >= shards)
    throw new Error(`render_job: bad shard ${shard} of ${shards} (need 0 <= shard < shards, shards >= 1)`);
  const started = performance.now();
  const { rendered, total } = await runShard(positional[0], shard, shards);
  const seconds = (performance.now() - started) / 1000;
  console.log(`shard ${shard}/${shards}: rendered ${rendered} of ${total} frames in ${seconds.toFixed(1)}s (${(seconds / Math.max(1, rendered)).toFixed(2)}s/frame)`);
}

// Run only as a script, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) await main();
