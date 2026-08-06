/**
 * BROWSER RENDER JOBS — the orchestrator that makes "rendered by the browser" a
 * BACKEND of the one render-job system, and makes it survive the tab closing.
 *
 * ── THE PROBLEM IT SOLVES ─────────────────────────────────────────────────────
 * A server-backend job belongs to the server: submit hands over a snapshot and the
 * browser is free to leave. A browser-backend job cannot work that way — the page
 * IS the frame producer — so before this module, closing the tab destroyed the
 * work. It does not any more: the tab closing PAUSES a browser render, and opening
 * the project again RESUMES it. Those are the words the UI uses, because they are
 * the true ones — nothing kept rendering while the tab was shut.
 *
 * ── ONE JOB LIST, TWO BACKENDS, AND WHO KNOWS WHAT ────────────────────────────
 * There is exactly one job record per render, so the Render Center lists both
 * backends together with the same cancel/delete/play affordances. But for a browser
 * job the RECORD's keeper cannot know the progress — the frames are being made in a
 * tab it has no handle on — so this module keeps the live truth and the modal reads
 * it from here. That is not a second system; it is the honest answer to "who knows
 * how far along this is".
 *
 * ── WHERE THE RECORD LIVES (and the ONLY thing static mode changes) ───────────
 * The frames have ALWAYS been made in this page. What used to require a server was
 * the RECORD — the row, its state, its finished movie — and that made a whole
 * working in-browser renderer unreachable on the static site, which showed the
 * pipeline and then refused to run it (the user: "We spent a long time creating an
 * in-browser rendering system. When we're on a static site, why not just hook up
 * that file system and only have the Browser option?").
 *
 * So the record's home is now a boot-time choice — web/renderBackend.js, HTTP →
 * projectApi, static → an IndexedDB renderings keyspace — and NOTHING in this file
 * knows which it got. The five calls have the same names, arguments and record
 * shape on both sides. There is no static branch in the frame walk, deliberately:
 * one would be a second definition of what a render IS.
 *
 * ── THE SNAPSHOT ──────────────────────────────────────────────────────────────
 * The document is serialized ONCE at submit. That exact string is POSTed to the
 * server as the job's snapshot AND stored in IndexedDB for resuming, so the two
 * cannot diverge, and every sitting of a resumed render draws the same deck. A
 * render is pure(document, [slide, alpha]); resuming against an edited deck would
 * splice two documents into one video and report success.
 *
 * ── TWO ENCODERS, CHOSEN ON MEASUREMENTS, NOT TASTE ───────────────────────────
 * Both implement web/videoExport.js's Encoder interface, both are resumable, and
 * they resume with different precision:
 *
 *   "upload"  web/serverMp4Encoder.js — PNG each frame to the server, ffmpeg at
 *             the end. Resumes at an EXACT FRAME (the server counts the PNGs on
 *             disk). Costs the server's scratch disk — gigabytes for a long 1080p
 *             render — and a round trip per frame.
 *   "wasm"    web/mp4Encoder.js — single-threaded wasm H.264 in a worker, nothing
 *             leaves the page until the finished movie. Resumes at a SEGMENT
 *             BOUNDARY, because the encoder only yields bytes when a segment
 *             closes.
 *
 * MEASURED back to back on the same deck, same frames, on a real plain-HTTP LAN
 * origin (tests/browser_encode_measure_probe.js — the A/B section, whose loops carry
 * no instrumentation inside a frame). Two independent runs of that probe, months
 * apart, both on this container:
 *
 *        output        upload              wasm                winner
 *        320x240       8.5 / 8.1 ms/f      5.8 / 6.0 ms/f      wasm, 1.36-1.47x
 *        1280x720      30.5 / 30.6 ms/f    40.0 / 39.2 ms/f    upload, 1.28-1.31x
 *        1920x1080     86.1 / 58.5 ms/f    92.8 / 95.6 ms/f    upload, 1.08-1.64x
 *
 * So the in-page encoder is NOT the speed win it was expected to be HERE: the
 * per-frame PNG it replaces costs ~6 ms at 1080p against ~62 ms for a wasm H.264
 * frame, and only the worker's overlap with rendering keeps them close. It wins
 * where the round trip dominates the pixels, i.e. small outputs.
 *
 * READ THAT TABLE WITH ITS PRECONDITION, WHICH IS THE WHOLE STORY. It was measured
 * with the browser and the backend ON ONE MACHINE, and a frame POST there costs
 * 3.8 ms — median, IDENTICAL at all three sizes, so it is pure latency and not bytes.
 * That 3.8 ms is upload's entire advantage, so the crossover is simply how much more
 * a REAL round trip costs: upload stops winning past about +9 ms per frame at 720p
 * or +37 ms at 1080p. And it must carry 31 KiB / 60 KiB of PNG per frame to earn it,
 * against ~1.4 KiB per frame of finished H.264 sent once at the end — about 40x less
 * data. One network hop with a body that size clears both thresholds at once.
 *
 * WHICH IS WHY A USER MEASURED THE OPPOSITE and was not mistaken: on a browser
 * talking to a server that is not the same machine, "Encode in page" is far faster.
 * Both measurements stand; they measured different links. The default is still
 * "upload" (it is what this machine's numbers support, and it resumes exactly) and
 * the dropdown labels now name the condition instead of promising a winner — see
 * web/browserJobView.js BROWSER_ENCODERS.
 *
 * "wasm" is therefore the honest choice for a small output, a machine with no room
 * for scratch frames, a link that is not loopback, or a render whose pixels must not
 * leave the page. Neither is a fallback for the other: the choice is explicit and
 * the consequence is stated in the UI.
 *
 * ── TWO TABS ──────────────────────────────────────────────────────────────────
 * IndexedDB is shared across tabs and the Web Locks API is secure-context gated
 * (measured absent on plain HTTP), so a driving tab stamps an advisory LEASE and
 * another tab reports "rendering in another tab" instead of interleaving frames.
 * See web/browserJobStore.js.
 */

import { deserialize, repairedDocument, printRepairReports, documentIsSimulated } from "../core/document.js";
import { planForParams, frameCount, exportVideo } from "./videoExport.js";
import { createLetterboxFrameRenderer } from "./transitionRender.js";
import { settledFrame } from "./settledFrame.js"; // #281: an export gets ONE chance at its pixels
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
// THE RECORD BACKEND, not projectApi directly. A browser render's frames have
// always been made HERE; only the job RECORD was server-shaped, and that is now a
// one-line choice (web/renderBackend.js) between the server and IndexedDB. Nothing
// below this line knows which it got — see the header's "WHERE THE RECORD LIVES".
import { renderRecordStore, selectableEncoders, defaultEncoderForMode } from "./renderBackend.js";
import { ACTIVE_STATES } from "./renderJobView.js";
import { createJobFrameEncoder, framesOnServer } from "./serverMp4Encoder.js";
import { createWasmMp4Encoder, segmentFrames } from "./mp4Encoder.js";
import {
  putBrowserJob, getBrowserJob, listBrowserJobs, updateBrowserJob, deleteBrowserJob,
  putBrowserJobSegment, getBrowserJobSegments, framesPersisted, driverState, newDriverId,
  LEASE_HEARTBEAT_MS,
} from "./browserJobStore.js";

// The encoder list and the resume precision each one promises live in
// web/browserJobView.js so a bare-node test can read them (this module imports the
// fetch layer and therefore needs a browser). Re-exported here because this is
// where a caller looks for them.
import { BROWSER_ENCODERS, DEFAULT_BROWSER_ENCODER } from "./browserJobView.js";
export { BROWSER_ENCODERS, DEFAULT_BROWSER_ENCODER };

/** This tab's advisory lease identity, minted once per page load. */
const DRIVER_ID = newDriverId();

/**
 * LIVE progress for the jobs THIS TAB is driving: jobId → {framesDone,
 * framesTotal, phase}. A plain object read by the Render Center on its existing
 * poll — no store, no subscription, because the modal already re-reads everything
 * once a second and two notification mechanisms would be one too many.
 *
 * `phase` is "rendering" | "encoding" | "uploading".
 */
const live = {};

/**
 * Job ids this tab has been asked to STOP driving.
 *
 * Cancelling on the server is not enough to stop a browser render, and the two
 * encoders fail differently if you rely on it: the upload encoder notices at once
 * (its next frame POST is refused with a 409), but the in-page encoder never talks
 * to the server until the movie is finished, so it would render every remaining
 * frame at full speed and only then discover it had been cancelled. A cancel has to
 * be observable HERE, which is what this set is for — the frame walk checks it after
 * every frame.
 */
const cancelled = new Set();

/** Query. A snapshot of this tab's live browser-render progress, by job id.
 *  @example liveBrowserProgress() // {} (a tab that has not started a render)
 *  @example // with one render in flight, keyed by job id:
 *  @example //   {"ab12": {framesDone: 40, framesTotal: 120, phase: "rendering"}} */
export function liveBrowserProgress() {
  return { ...live };
}

/** Query (reads crypto, via DRIVER_ID). This tab's lease identity. Exposed so the
 *  UI can say "this tab". The id is random, so the example asserts its SHAPE — see
 *  web/browserJobStore.js newDriverId, which mints it.
 *  @example thisDriverId().startsWith("d-") // true */
export function thisDriverId() {
  return DRIVER_ID;
}

/**
 * Command (async; builds an encoder, may spawn a worker). THE encoder for a
 * browser job, by kind. Both are resumable; `resumeFrom()` is how each reports the
 * frame it continues at (see the header for the precision difference).
 *
 * @param {string} kind "upload" | "wasm"
 * @param {object} job The stored browser job record.
 * @returns {Promise<{addFrame:Function, finalize:Function, resumeFrom:Function, abort?:Function}>}
 */
async function buildEncoder(kind, job) {
  const { width, height, fps, crf } = job.params;
  if (kind === "upload") {
    // The resume point is read BEFORE the encoder is built, because the encoder
    // needs it as its starting frame index — a fresh encoder writing from 0 over a
    // half-full frames directory would silently re-render what is already there.
    const firstFrame = await framesOnServer(job.project, job.id);
    return createJobFrameEncoder({ project: job.project, jobId: job.id, firstFrame });
  }
  if (kind === "wasm") {
    const priorSegments = await getBrowserJobSegments(job.id);
    return createWasmMp4Encoder({
      width, height, fps, quality: crf,
      priorSegments,
      onSegment: (segment) => putBrowserJobSegment(job.id, segment),
    });
  }
  throw new Error(`browserRenderJobs: unknown encoder ${JSON.stringify(kind)} — expected one of ${BROWSER_ENCODERS.map((e) => e.value).join(", ")}`);
}

/**
 * Command (async; finishes the job on the server). Hand the finished product to
 * the server so the movie lands in the project's renders/ folder and the shared
 * job record reaches "done".
 *
 * The upload encoder's finalize already did this (the server ran ffmpeg over the
 * PNGs and returned the record); the wasm encoder produced BYTES in the page, so
 * they are handed to the record store as the job's output. In HTTP mode that is a
 * POST and the movie lands in renders/; in static mode it is an IndexedDB write and
 * the movie lands in the renderings keyspace. Same call, same returned record.
 *
 * @param {string} kind Encoder kind.
 * @param {object} job Stored browser job.
 * @param {*} product Whatever the encoder's finalize() returned.
 * @returns {Promise<object>} the finished server job record
 */
async function deliver(kind, job, product) {
  if (kind === "upload") return product; // already the finished job record
  live[job.id] = { ...live[job.id], phase: "uploading" };
  return renderRecordStore(job.project).postRenderJobOutput(job.project, job.id, product.bytes, product.frames);
}

/**
 * Command (async; submits to the server, writes IndexedDB, then renders). Submit a
 * BROWSER-backend render job and start driving it.
 *
 * Returns as soon as the job EXISTS (server record + local record), exactly like
 * the server backend — the frame walk continues in the background and the Render
 * Center polls it. The returned record is the server's.
 *
 * @param {object} o
 * @param {string} o.project
 * @param {string} o.name Job name; also the output filename stem.
 * @param {object} o.params width/height/fps/crf/samples/range/background/…
 * @param {object} o.doc The LIVE document; serialized here, once (the snapshot).
 * @param {object} o.registry Plugin registry, for rendering.
 * @param {string} [o.encoder] "upload" | "wasm" — must be one this MODE offers
 *   (defaultEncoderForMode(); static mode has only "wasm").
 * @returns {Promise<object>} the submitted job record
 */
export async function submitBrowserRenderJob({ project, name, params, doc, registry, encoder = defaultEncoderForMode() }) {
  // CHECKED AGAINST THIS MODE, not against the full list. "upload" is a TRANSPORT —
  // it POSTs a PNG per frame and asks a server to run ffmpeg — so in static mode it
  // is not a slower option, it is an impossible one. Caught here, at submit, rather
  // than at frame zero: the alternative is a job record, a lease and a wasm worker
  // all created for a render whose first frame cannot go anywhere.
  if (!selectableEncoders().some((e) => e.value === encoder))
    throw new Error(`browserRenderJobs: encoder ${JSON.stringify(encoder)} is not available here — this page offers ${selectableEncoders().map((e) => e.value).join(", ")}.`);
  // ONE serialization, used for BOTH snapshots — see the header.
  const docJson = JSON.stringify(doc);
  const plan = planForParams(doc, params);
  const framesTotal = frameCount(plan.duration, params.fps);
  const job = await renderRecordStore(project).submitRenderJob(project, {
    name, backend: "client", framesTotal, params, doc: JSON.parse(docJson),
  });
  const record = await putBrowserJob({
    id: job.id, project, name, params, docJson, framesTotal, encoder,
    segmentFrames: segmentFrames(params.fps),
  });
  // Deliberately NOT awaited: the job is tracked by polling, so the caller (a
  // modal that may be closed a second later) must not hold this promise.
  driveBrowserJob(record, registry).catch((e) => console.error(`Browser render job "${name}" failed:`, e));
  return job;
}

/**
 * Command (async; renders and encodes). Drive one browser job to completion,
 * starting from wherever its encoder says it got to.
 *
 * Claims the advisory lease first and REFUSES (loudly, without touching anything)
 * when another tab's lease is still warm — two tabs interleaving frames into one
 * job would corrupt it.
 *
 * A failure marks the job cancelled on the server and records the reason locally,
 * so the list never shows a browser job spinning at a percentage forever.
 *
 * @param {object} record A stored browser job record.
 * @param {object} registry Plugin registry.
 * @param {AbortSignal} [signal] Cancels the frame walk.
 * @returns {Promise<object>} the finished server job record
 */
export async function driveBrowserJob(record, registry, signal = undefined) {
  // Same order as browserJobStatuses, for the same reason: `now` before the read.
  const now = Date.now();
  const fresh = await getBrowserJob(record.id);
  if (!fresh) throw new Error(`browser render job ${record.id} is not in this browser's store`);
  const state = driverState(fresh, DRIVER_ID, now, Boolean(live[record.id]));
  // A SECOND DRIVE IN THIS TAB IS REFUSED, not just a second tab. Two frame walks
  // into one job interleave frames and corrupt the output whether or not they share
  // a JS context, and this case was REACHABLE: the lease-derived verdict reported a
  // job this tab was rendering as "paused", which put a Resume button on it, and
  // this guard let the click through. It is a fact check now, not a lease check.
  if (state === "here")
    throw new Error(`Render "${fresh.name}" is already being rendered by this tab — a second pass over the same job would interleave frames into one movie.`);
  if (state === "elsewhere")
    throw new Error(`Render "${fresh.name}" is already being rendered by another tab of this browser. Close that tab, or wait for it to finish.`);

  const job = await updateBrowserJob(record.id, { driverId: DRIVER_ID, heartbeatAt: Date.now(), error: null });
  // Claim the live slot BEFORE any of the slow setup (document repair, wasm module
  // load, asking the server how many frames it already has). Without this there is
  // a window in which this tab IS driving the job but reports nothing, and a
  // watcher — the Render Center, or a probe — cannot tell that from "paused".
  live[job.id] = { framesDone: null, framesTotal: job.framesTotal, phase: "starting" };
  const { doc, reports } = repairedDocument(deserialize(job.docJson), registry);
  printRepairReports(reports);
  const plan = planForParams(doc, job.params);
  const { width, height, fps, samples, background } = job.params;
  // THE DRAIN (#281). This path used to render each frame ONCE and encode whatever
  // was on the canvas at that instant, while the SERVER-side renderer waited for
  // its rasters — so the same deck could export a PDF page from one path and a
  // hole from the other, with the in-browser one exiting successfully. R6-11
  // recorded it as "settledFrame is unshared across three consumers of one
  // renderer"; sharing it is the fix, and an unarrivable asset now REFUSES the
  // job loudly instead of silently encoding a gap.
  const base = createLetterboxFrameRenderer({ doc, registry, width, height, background });
  const renderFrame = (index, alpha) => settledFrame(() => base(index, alpha), "browser render");

  const heartbeat = setInterval(() => {
    updateBrowserJob(job.id, { heartbeatAt: Date.now() })
      .catch((e) => console.error(`Could not refresh the lease on browser render job ${job.id}:`, e));
  }, LEASE_HEARTBEAT_MS);

  // RELEASING THE LEASE WHEN THE TAB GOES AWAY is an optimization, not the
  // correctness mechanism. Without it, a closed tab's lease stays warm until it goes
  // stale, so for up to LEASE_STALE_MS a reopened page would say "rendering in
  // another tab" about a tab that no longer exists — true-ish, but useless. With it
  // the reopened page can resume immediately. It is BEST EFFORT by nature (an
  // IndexedDB transaction started during pagehide may not commit), which is
  // acceptable precisely because the staleness timeout still guarantees the job
  // becomes resumable either way. `pagehide` rather than `beforeunload`: it also
  // fires when the page is frozen into the back/forward cache.
  const releaseLease = () => {
    updateBrowserJob(job.id, { driverId: null, heartbeatAt: 0 }).catch(() => {
      // Nothing can be reported from a page that is being torn down; the staleness
      // timeout is the fallback and it is not silent — see driverState.
    });
  };
  addEventListener("pagehide", releaseLease);

  let encoder = null;
  try {
    encoder = await buildEncoder(job.encoder, job);
    const startFrame = await encoder.resumeFrom();
    // ── A RESUME IS A COLD START IN THE MIDDLE OF A TRAJECTORY ──────────────────
    // SIMULATED state (an equation reading `@` or `dt`) makes frame N a function of
    // frames 0..N-1, so resuming at frame N without having integrated 0..N-1 produces
    // a video that is CONTINUOUS IN THE FILE and DISCONTINUOUS IN THE MOTION — a
    // plausible wrong deliverable, which is the failure this project forbids outright.
    // `core/document.stridedShardRefusal` is the same law for the sharded case; this is
    // its resume-shaped sibling, and it lives HERE because this is the first scope that
    // holds both the repaired doc and the registry (`web/videoExport.exportVideo` has
    // neither, which is why it cannot make this check itself).
    //
    // It REFUSES rather than silently restarting from 0: the already-encoded frames are
    // in the encoder and re-adding them would duplicate them, so the honest recovery is
    // a fresh render, which the sentence tells the author to start.
    if (startFrame > 0 && documentIsSimulated(doc, registry)) {
      throw new Error(
        `Cannot RESUME this render: the document contains SIMULATED STATE (an equation reading \`@\` or \`dt\`), `
        + `so frame ${startFrame} depends on every frame before it. Resuming here would restart the motion `
        + `mid-file and produce a plausible but wrong video. Start a FRESH render instead — a simulated deck `
        + `must be walked from frame 0 in order.`);
    }
    live[job.id] = { framesDone: startFrame, framesTotal: job.framesTotal, phase: "rendering" };
    const product = await exportVideo({
      plan, renderFrame, encoder, width, height, fps, samples,
      setTime: setParticleTimeOverride, // recordable state is DRIVEN, never inherited
      startFrame,
      signal,
      onProgress: (_fraction, framesDone, total) => {
        live[job.id] = { framesDone, framesTotal: total, phase: "rendering" };
        // Checked HERE rather than trusted to the server (see `cancelled`): the
        // in-page encoder never asks the server anything mid-render, so a cancel it
        // did not observe locally would keep the machine busy to the last frame.
        if (cancelled.has(job.id))
          throw new Error(`Render "${job.name}" was cancelled at frame ${framesDone} of ${total}.`);
      },
    });
    live[job.id] = { ...live[job.id], phase: "encoding" };
    const finished = await deliver(job.encoder, job, product);
    // The local record and its segments exist only to make the render resumable.
    // The movie is on the server now, so they are dead weight.
    await deleteBrowserJob(job.id);
    delete live[job.id];
    return finished;
  } catch (e) {
    delete live[job.id];
    // The wasm encoder owns a Worker holding a wasm heap; a failed or cancelled
    // drive must give it back. Segments already persisted are untouched, which is
    // what keeps a cancelled-by-closing-the-tab render resumable.
    encoder?.abort?.();
    const message = String(e?.message ?? e);
    await updateBrowserJob(job.id, { driverId: null, heartbeatAt: 0, error: message })
      .catch((err) => console.error(`Could not record the failure on browser render job ${job.id}:`, err));
    // An abort is a user action; the job record becomes "cancelled" either way,
    // and the local resume record stays so the user can see why.
    await renderRecordStore(job.project).cancelRenderJob(job.project, job.id)
      .catch((err) => console.error(`Could not mark render job ${job.id} cancelled:`, err));
    throw e;
  } finally {
    clearInterval(heartbeat);
    removeEventListener("pagehide", releaseLease);
  }
}

/**
 * Command (async). Resume a paused browser job by id. Throws when there is no
 * local record (its bytes are not in this browser) or when another tab holds it.
 *
 * @param {string} jobId
 * @param {object} registry Plugin registry.
 * @returns {Promise<object>} the finished server job record
 */
export async function resumeBrowserRenderJob(jobId, registry) {
  const record = await getBrowserJob(jobId);
  if (!record)
    throw new Error(`Render job ${jobId} has no saved progress in this browser, so it cannot be resumed here. It was submitted from a different browser or its local data was cleared — delete it and submit again.`);
  return driveBrowserJob(record, registry);
}

/**
 * Query (async). What the Render Center should say about every browser job of
 * `project`, by job id: `{framesDone, framesTotal, phase, driver, resumeGranularity,
 * canResumeHere, error}`.
 *
 * `driver` is "here" | "elsewhere" | "paused" — the difference the UI must not
 * blur, because a paused render is not a running one.
 *
 * @param {string} project
 * @returns {Promise<object>} jobId → status
 */
export async function browserJobStatuses(project) {
  // `now` IS CAPTURED BEFORE THE READ, and that order is load-bearing. The frame
  // walk blocks the main thread for a whole output frame, so this read's callback
  // can be delayed by seconds; taking `now` afterwards compared a pre-block
  // heartbeat against a post-block clock and made a healthy lease look expired by
  // exactly the length of one frame. Captured first, a delayed read can only make
  // the heartbeat look YOUNGER — see driverState's `now` parameter.
  const now = Date.now();
  const stored = await listBrowserJobs(project);
  const out = {};
  for (const job of stored) {
    const liveEntry = live[job.id];
    // WHETHER THIS TAB IS DRIVING IS READ FROM MEMORY, NEVER FROM THE LEASE. A live
    // entry exists for exactly as long as driveBrowserJob is inside its try block,
    // so it cannot go stale while frames are landing — which is what the lease did.
    const driver = driverState(job, DRIVER_ID, now, Boolean(liveEntry));
    // A driving tab's in-memory count is the freshest truth; a paused job's truth
    // is what was written down, which for the wasm encoder is its segments and for
    // the upload encoder is the server's frame count (already in the job list).
    const framesDone = liveEntry?.framesDone
      ?? (job.encoder === "wasm" ? framesPersisted(await getBrowserJobSegments(job.id)) : null);
    out[job.id] = {
      framesDone,
      framesTotal: job.framesTotal,
      phase: liveEntry?.phase ?? null,
      driver,
      encoder: job.encoder,
      resumeGranularity: BROWSER_ENCODERS.find((e) => e.value === job.encoder)?.resume ?? "unknown",
      canResumeHere: driver === "paused",
      error: job.error,
    };
  }
  return out;
}

/**
 * Command (async). Forget a browser job's local progress. Called when the user
 * deletes or cancels the job — the server record and movie are the caller's
 * business; this drops the resume data so a deleted job cannot be resumed.
 */
export async function forgetBrowserRenderJob(jobId) {
  // Ask the frame walk to stop FIRST. Dropping the record without this would leave
  // a drive rendering into a job whose resume data no longer exists.
  cancelled.add(jobId);
  delete live[jobId];
  await deleteBrowserJob(jobId);
}

/**
 * Command (async). Drop local RESUME data for browser jobs the record store no
 * longer has as active — a job that finished, was cancelled or was deleted has no
 * use for a document snapshot and half-encoded segments, and keeping them would let
 * the UI offer to resume something that is over.
 *
 * Note the two databases this straddles, because they are easy to confuse: the
 * RESUME data (snapshot + segments + lease) is web/browserJobStore.js's
 * `powerrp-browser-renders`; the JOB RECORD is the server's, or in static mode
 * web/localRenderStore.js's `powerrp-renderings`. This drops the former against the
 * latter's verdict, in either mode.
 *
 * Returns the ids it dropped, so a caller can report rather than guess.
 *
 * @param {string} project
 * @returns {Promise<string[]>}
 */
export async function pruneFinishedBrowserJobs(project) {
  const [stored, jobs] = await Promise.all([listBrowserJobs(project), renderRecordStore(project).listRenderJobs(project)]);
  const active = new Set(jobs.filter((j) => ACTIVE_STATES.includes(j.state)).map((j) => j.id));
  const dropped = [];
  for (const job of stored) {
    if (active.has(job.id)) continue;
    if (live[job.id]) continue; // this tab is mid-delivery; not finished yet
    // A record carrying an ERROR is the only account of why a render stopped — the
    // server's own record says no more than "cancelled". Keep it until the user
    // deletes the job, or the explanation vanishes on the next dialog open.
    if (job.error) continue;
    await deleteBrowserJob(job.id);
    dropped.push(job.id);
  }
  return dropped;
}
