/**
 * Pure view-model helpers for RENDER JOB records — the vocabulary the Render
 * Center and the toolbar badge both read a job through.
 *
 * They live here rather than inside RenderCenterModal.svelte for two reasons:
 * the toolbar badge needs the same "is this job working / has it been seen"
 * predicates the list uses (two copies would be two chances to disagree about
 * what the badge counts), and a pure function in a .svelte file cannot be
 * doctested from bare node. Everything here is a pure function of one server
 * record, so the whole file runs in the node test suite.
 *
 * A job record comes from server.py's job_view: {id, name, backend, state,
 * framesDone, framesTotal, params, output, outputPath, bytes, error, warning,
 * seen, createdAt, startedAt, finishedAt}.
 */

/** The states in which a job is still working. MUST match server.py's
 *  JOB_ACTIVE_STATES — the server decides what "active" means; this is the
 *  client's copy of that one list, named so a drift is greppable. */
export const ACTIVE_STATES = ["queued", "rendering", "encoding"];

/** Icon per job state, so the list is scannable without reading every line. */
export const STATE_ICONS = {
  queued: "mdi:tray-full",
  rendering: "mdi:cog",
  encoding: "mdi:filmstrip",
  done: "mdi:check-circle",
  failed: "mdi:alert-circle",
  cancelled: "mdi:cancel",
  interrupted: "mdi:power-plug-off",
};

/**
 * Pure function. Is this job still working? Drives the progress bar, the Cancel
 * affordance, the auto-expand default and the toolbar badge.
 *
 * @param {object} job A job record.
 * @returns {boolean}
 *
 * @example jobIsActive({state: "rendering"}) // true
 * @example jobIsActive({state: "queued"}) // true
 * @example jobIsActive({state: "done"}) // false
 */
export function jobIsActive(job) {
  return ACTIVE_STATES.includes(job.state);
}

/**
 * Pure function. Has this job finished successfully without the user having
 * looked at it yet? This is the "there is something new for you" condition — the
 * other half of the toolbar badge.
 *
 * @param {object} job A job record.
 * @returns {boolean}
 *
 * @example jobIsUnseenResult({state: "done", seen: false}) // true
 * @example jobIsUnseenResult({state: "done", seen: true}) // false
 * @example jobIsUnseenResult({state: "rendering", seen: false}) // false
 */
export function jobIsUnseenResult(job) {
  return job.state === "done" && !job.seen;
}

/**
 * Pure function. The toolbar badge count for a project's jobs: everything still
 * working PLUS everything finished that has not been seen. Zero means no badge.
 *
 * @param {object[]} jobs Job records.
 * @returns {number}
 *
 * @example renderBadgeCount([{state: "rendering"}, {state: "done", seen: true}]) // 1
 * @example renderBadgeCount([{state: "done", seen: false}, {state: "queued"}]) // 2
 * @example renderBadgeCount([{state: "done", seen: true}]) // 0
 */
export function renderBadgeCount(jobs) {
  return jobs.filter((j) => jobIsActive(j) || jobIsUnseenResult(j)).length;
}

/**
 * Pure function. The DEFAULT expanded/collapsed state for a job row: OPEN while
 * a job is working or when it has finished and the user has not seen it yet;
 * CLOSED otherwise.
 *
 * Collapsed-by-default is a real constraint, not a preference: an expanded row
 * mounts a <video>, so defaulting everything open would make opening the Render
 * Center fetch every movie in the project at once. An explicit user toggle
 * overrides this (the modal keeps those overrides).
 *
 * @param {object} job A job record.
 * @returns {boolean} true = expanded
 *
 * @example defaultExpanded({state: "rendering", seen: false}) // true
 * @example defaultExpanded({state: "done", seen: false}) // true
 * @example defaultExpanded({state: "done", seen: true}) // false
 * @example defaultExpanded({state: "failed", seen: true}) // false
 */
export function defaultExpanded(job) {
  return jobIsActive(job) || jobIsUnseenResult(job);
}

/**
 * Pure function. A job's progress as a fraction in [0, 1], or null when there is
 * no denominator yet — the caller shows an INDETERMINATE bar in that case rather
 * than dividing by zero or inventing a percentage.
 *
 * @param {object} job A job record.
 * @returns {number|null}
 *
 * @example jobProgress({framesDone: 5, framesTotal: 10}) // 0.5
 * @example jobProgress({framesDone: 12, framesTotal: 10}) // 1
 * @example jobProgress({framesDone: 0, framesTotal: 0}) // null
 */
export function jobProgress(job) {
  if (!job.framesTotal) return null;
  return Math.min(1, job.framesDone / job.framesTotal);
}

/**
 * Pure function. The one-line status sentence for a job row — what the state
 * MEANS, not just its name ("encoding" is otherwise opaque, and "queued" needs
 * to explain that something else is ahead of it).
 *
 * @param {object} job A job record.
 * @returns {string}
 *
 * @example jobStatusLine({state: "rendering", framesDone: 4, framesTotal: 10}) // "Rendering frame 4 of 10"
 * @example jobStatusLine({state: "encoding"}) // "Encoding the movie (ffmpeg)"
 * @example jobStatusLine({state: "done", framesTotal: 120}) // "Finished — 120 frames"
 */
export function jobStatusLine(job) {
  if (job.state === "queued") return "Queued — waiting for the current render to finish";
  if (job.state === "rendering") return `Rendering frame ${job.framesDone} of ${job.framesTotal || "?"}`;
  if (job.state === "encoding") return "Encoding the movie (ffmpeg)";
  if (job.state === "done") return `Finished — ${job.framesTotal} frames`;
  if (job.state === "cancelled") return "Cancelled";
  if (job.state === "interrupted") return "Interrupted by a server restart";
  return "Failed";
}
