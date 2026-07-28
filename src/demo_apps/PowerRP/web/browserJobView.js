/**
 * Pure view-model helpers for BROWSER render jobs — the sentences the Render Center
 * says about a render whose frames are being made in a tab.
 *
 * They live here, beside web/renderJobView.js and for the same two reasons: a pure
 * function inside a .svelte file cannot be doctested from bare node, and the
 * wording of "paused" versus "rendering" is a CORRECTNESS statement rather than a
 * cosmetic one — it must be defined once, in one place, and tested.
 *
 * THE DISTINCTION THAT MATTERS. A server job that is "rendering" really is
 * rendering. A browser job the server calls "rendering" may be doing nothing at
 * all, because the tab that was driving it was closed. Saying "Rendering frame 412
 * of 900" about a render that stopped an hour ago is the single most misleading
 * thing this dialog could do, so a browser job's line is built from the BROWSER's
 * view (web/browserRenderJobs.js browserJobStatuses) and names which of the three
 * situations it is in: driven here, driven in another tab of this browser, or
 * paused and waiting to be resumed.
 *
 * A browser job with NO local status at all is its own case: the server still has
 * it, but this browser holds none of its progress — it was submitted somewhere else
 * or the site data was cleared. That is not resumable HERE and must not offer to be.
 *
 * BROWSER_ENCODERS lives here too, and not beside the orchestrator that uses it,
 * for the same node-testability reason: the orchestrator imports the fetch layer
 * (which reads `location`) and so cannot be loaded in bare node, while the list of
 * encoders and the resume precision each one promises is exactly the kind of claim
 * a test should be able to read.
 */

import { SEGMENT_SECONDS } from "./mp4Encoder.js";

/**
 * The browser encoders offered in the Render Center, each with the measured
 * trade-off it is chosen FOR and — the part the user must be told before starting
 * a long render — how precisely it resumes. Order is dropdown order.
 *
 * WHICH IS FASTER DEPENDS ON THE LINK, so neither label claims to be "fastest"
 * outright any more. This one did, and it was wrong for the person reading it: the
 * user measured the in-page encoder FAR faster on their own setup while the label
 * promised the opposite.
 *
 * MEASURED, both encoders over the same frames (tests/browser_encode_measure_probe.js,
 * A/B section — the loops there carry no instrumentation inside a frame):
 *
 *        output      upload            wasm              winner
 *        320x240     123 fps  8.1 ms   168 fps  6.0 ms   wasm, 1.36x
 *        1280x720     33 fps 30.6 ms    25 fps 39.2 ms   upload, 1.28x
 *        1920x1080    17 fps 58.5 ms    10 fps 95.6 ms   upload, 1.64x
 *
 * AND THAT TABLE ONLY HOLDS WHEN THE POST IS FREE. It was measured with the browser
 * and the backend on ONE MACHINE, where a frame upload's round trip costs 3.8 ms
 * (median, all three sizes — it is latency, not bytes). Upload's whole advantage is
 * that 3.8 ms, so the crossover is exactly how much MORE a real round trip costs:
 * upload stops winning once the per-frame POST costs about 9 ms more at 720p or
 * 37 ms more at 1080p, and it carries 31 KiB / 60 KiB of PNG per frame to get there
 * against ~1.4 KiB of finished H.264. One network hop with a body that size passes
 * both thresholds immediately, which is why the two measurements disagree and why
 * BOTH are right: the numbers above are the same-machine case, and PowerRP exists to
 * be served to a browser somewhere else.
 *
 * NOT MEASURED, and it is not a speed question: the two produce different files.
 * "upload" ends in ffmpeg/libx264 at a CRF; "wasm" is a baseline-profile encoder at a
 * quantizer. Nobody has compared their size or quality at matched settings, so this
 * comment does not pretend to know — see the backburner note in the dump's manifest.
 */
export const BROWSER_ENCODERS = [
  {
    value: "upload",
    label: "Upload frames — fastest on this machine, resumes exactly",
    resume: "the exact frame it stopped on",
  },
  {
    value: "wasm",
    label: "Encode in page — fastest over a network, resumes per segment",
    // The number comes from the encoder itself, so the promise in the UI cannot
    // drift from the segment length that actually governs it.
    resume: `the last ${SEGMENT_SECONDS}-second segment it finished encoding`,
  },
];
/**
 * The default browser encoder.
 *
 * STILL "upload", and deliberately unchanged: the only measurement taken on this
 * machine says upload wins at every size people export (see BROWSER_ENCODERS), and
 * it resumes exactly. The case for flipping it is real and quantified above — over a
 * network the crossover is a few milliseconds of round trip — but it rests on a
 * measurement from a DIFFERENT machine than the one that can be re-run here, and it
 * would change the encoder every existing user's renders come out of. It is a
 * one-word change when that call is made.
 */
export const DEFAULT_BROWSER_ENCODER = "upload";

/**
 * Pure function. The one-line status for a browser job, given the server record and
 * this browser's status entry (or null/undefined when this browser has none).
 *
 * @param {object} job Server job record ({state, framesTotal, name, …}).
 * @param {object|null} status From browserJobStatuses: {framesDone, framesTotal,
 *   phase, driver, resumeGranularity, error} — or null if this browser has none.
 * @returns {string}
 *
 * @example
 * // Being rendered by this very tab:
 * browserJobStatusLine({state: "rendering", framesTotal: 900}, {driver: "here", phase: "rendering", framesDone: 412, framesTotal: 900})
 * // "Rendering frame 412 of 900 in this tab"
 * @example
 * // Driven here, but still deciding where to continue from (no frame count yet):
 * browserJobStatusLine({state: "rendering"}, {driver: "here", phase: "starting", framesDone: null, framesTotal: 900})
 * // "Starting in this tab — working out where to continue from"
 * @example
 * // The tab was closed — the render PAUSED, it did not continue:
 * browserJobStatusLine({state: "rendering", framesTotal: 900}, {driver: "paused", framesDone: 400, framesTotal: 900, resumeGranularity: "segment boundary"})
 * // "Paused at 400 of 900 frames — nothing is rendering. Resume to continue (resumes at a segment boundary)."
 * @example
 * // Another tab of the same browser holds the lease:
 * browserJobStatusLine({state: "rendering"}, {driver: "elsewhere", framesDone: 12, framesTotal: 900})
 * // "Rendering frame 12 of 900 in another tab of this browser"
 * @example
 * // The server still has it, this browser does not:
 * browserJobStatusLine({state: "rendering", framesTotal: 900}, null)
 * // "Unfinished, and this browser holds none of its progress — it was started elsewhere, or this site's data was cleared. It cannot be resumed here."
 */
export function browserJobStatusLine(job, status) {
  if (!status)
    return "Unfinished, and this browser holds none of its progress — it was started elsewhere, or this site's data was cleared. It cannot be resumed here.";
  const total = status.framesTotal ?? job.framesTotal ?? "?";
  // The browser's count wins when it has one. It does NOT for a paused "upload"
  // job: that encoder's progress is the PNG count on the server's disk, which is
  // already in the server record, so falling through to it is reading the right
  // authority rather than guessing.
  const done = status.framesDone ?? job.framesDone ?? 0;
  if (status.error) return `Stopped: ${status.error}`;
  if (status.driver === "elsewhere") return `Rendering frame ${done} of ${total} in another tab of this browser`;
  if (status.driver === "here") {
    if (status.phase === "starting") return `Starting in this tab — working out where to continue from`;
    if (status.phase === "encoding") return `Finishing the movie (${total} frames encoded)`;
    if (status.phase === "uploading") return `Saving the movie to the project (${total} frames)`;
    return `Rendering frame ${done} of ${total} in this tab`;
  }
  return `Paused at ${done} of ${total} frames — nothing is rendering. Resume to continue (resumes at a ${status.resumeGranularity ?? "segment boundary"}).`;
}

/**
 * Pure function. A browser job's progress as a fraction in [0, 1], or null when
 * there is no denominator (the caller shows an indeterminate bar instead of
 * inventing a percentage).
 *
 * @param {object|null} status From browserJobStatuses.
 * @param {object|null} [job] The server record, consulted when the browser has no
 *   count of its own (the "upload" encoder's progress is the server's frame count).
 * @returns {number|null}
 *
 * @example browserJobProgress({framesDone: 45, framesTotal: 90}) // 0.5
 * @example browserJobProgress({framesDone: 100, framesTotal: 90}) // 1
 * @example browserJobProgress({framesDone: 0, framesTotal: 0}) // null
 * @example browserJobProgress(null) // null
 * @example browserJobProgress({framesDone: null, framesTotal: 90}, {framesDone: 30}) // 0.3333333333333333
 */
export function browserJobProgress(status, job = null) {
  if (!status?.framesTotal) return null;
  const done = status.framesDone ?? job?.framesDone ?? 0;
  return Math.min(1, done / status.framesTotal);
}

/**
 * Pure function. Is this row's job a browser render that THIS browser can resume
 * right now? True only when the server still considers it unfinished AND this
 * browser holds its progress AND nothing is currently driving it.
 *
 * @param {object} job Server job record.
 * @param {object|null} status From browserJobStatuses.
 * @param {string[]} activeStates The server's "still working" states.
 * @returns {boolean}
 *
 * @example canResume({backend: "client", state: "rendering"}, {driver: "paused", canResumeHere: true}, ["rendering"]) // true
 * @example canResume({backend: "client", state: "rendering"}, {driver: "here", canResumeHere: false}, ["rendering"]) // false
 * @example canResume({backend: "client", state: "done"}, {driver: "paused", canResumeHere: true}, ["rendering"]) // false
 * @example canResume({backend: "server", state: "rendering"}, null, ["rendering"]) // false
 */
export function canResume(job, status, activeStates) {
  return job.backend === "client" && activeStates.includes(job.state) && Boolean(status?.canResumeHere);
}
