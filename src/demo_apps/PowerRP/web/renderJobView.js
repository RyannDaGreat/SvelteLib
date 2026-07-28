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

/**
 * Pure function. A job warning flattened to ONE compact line for the collapsed
 * warning fold's <summary> — newlines and whitespace runs become single spaces
 * (the display truncates with CSS ellipsis, so no length cap here). The full
 * text, formatting intact, lives in the fold's body; this is only the teaser.
 *
 * @param {string} text The job record's `warning`.
 * @returns {string}
 *
 * @example warningPreview("The render worker reported:\nrender_job: frames went flat") // "The render worker reported: render_job: frames went flat"
 * @example warningPreview("  one   line  ") // "one line"
 */
export function warningPreview(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Pure function. Render-progress time estimate — THE SAME MATH AS rp.eta
 * (rp.r._eta): one observed session where `startN` items already existed when
 * observation began, `elapsedSeconds` have passed, and `n` exist now.
 *
 *   proportion = (n − startN) / (total − startN)
 *   eta        = elapsed / proportion        (estimated total session time)
 *   etr        = eta − elapsed               (estimated time remaining)
 *   rate       = (n − startN) / elapsed
 *
 * Subtracting startN is rp's `start_n` and it is why a RESUMED job (frames
 * already on disk when the dialog starts watching) cannot fake a fast rate.
 * Returns null while the session has made no progress — rp prints "NO
 * PROGRESS; INFINITE TIME REMAINING" for that; the caller shows nothing.
 * (rp's high-water clamp for a mid-flight GROWING total is deliberately not
 * mirrored: framesTotal is fixed at submit, so proportion is already monotone.)
 *
 * @param {number} n Items done now.
 * @param {number} total Total items.
 * @param {number} startN Items that were already done at session start.
 * @param {number} elapsedSeconds Seconds since session start (> 0 for an estimate).
 * @returns {{etrSeconds: number, etaSeconds: number, rate: number}|null}
 *
 * @example etaEstimate(5, 10, 0, 10) // {etrSeconds: 10, etaSeconds: 20, rate: 0.5}
 * @example etaEstimate(700, 1000, 600, 50) // {etrSeconds: 150, etaSeconds: 200, rate: 2}
 * @example etaEstimate(600, 1000, 600, 50) // null (no session progress yet)
 * @example etaEstimate(0, 0, 0, 5) // null
 */
export function etaEstimate(n, total, startN, elapsedSeconds) {
  if (!(total > startN) || !(elapsedSeconds > 0)) return null;
  const proportion = (n - startN) / (total - startN);
  if (proportion <= 0) return null;
  const eta = elapsedSeconds / proportion;
  return { etrSeconds: eta - elapsedSeconds, etaSeconds: eta, rate: (n - startN) / elapsedSeconds };
}

/**
 * Pure function. Seconds as a python-timedelta-style clock, whole seconds —
 * the H:MM:SS shape rp.eta prints (hours unpadded, may exceed 24).
 *
 * @param {number} seconds Non-negative duration.
 * @returns {string}
 *
 * @example formatClock(83) // "0:01:23"
 * @example formatClock(3722) // "1:02:02"
 * @example formatClock(90000) // "25:00:00"
 */
export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/**
 * Pure function. The status-line suffix for an etaEstimate: ETR and rate in
 * rp.eta's vocabulary, or "" for null (no estimate yet — say nothing rather
 * than something wrong).
 *
 * @param {{etrSeconds: number, rate: number}|null} est An etaEstimate result.
 * @returns {string}
 *
 * @example etaSuffix({etrSeconds: 150, etaSeconds: 200, rate: 2}) // " · ETR 0:02:30 · 2.00/s"
 * @example etaSuffix(null) // ""
 */
export function etaSuffix(est) {
  if (!est) return "";
  return ` · ETR ${formatClock(est.etrSeconds)} · ${est.rate.toFixed(2)}/s`;
}
