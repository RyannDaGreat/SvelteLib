/**
 * projectPreviews.js — DOM-free helpers for the Open Project modal's preview
 * GRID (App.svelte). The modal lists saved server projects as cards; each card
 * shows a first-slide thumbnail rendered CLIENT-side through the shared Skia
 * pixel service (web/gpuService.renderCameraFrame) — the server keeps no
 * per-project thumbnail, so the client rasterizes slide 0 of each project's doc.
 *
 * These helpers are the pure/near-pure bits (render-size math, bounded-
 * concurrency scheduling, relative-time phrasing) so the .svelte shell stays a
 * thin consumer and the logic is unit-testable in bare node. The Command that
 * actually loads + rasterizes + reads back a doc lives in App.svelte (it touches
 * the network, CanvasKit, and reactive state).
 */

/** Max project previews rendered concurrently. The Skia raster path itself is
 *  serialized inside gpuService (one CPU surface at a time), so this really
 *  bounds the concurrent loadProject FETCHES + docs held in memory — small so 50
 *  projects don't spawn 50 in-flight requests, large enough to hide latency. */
export const PROJECT_PREVIEW_CONCURRENCY = 4;

/** Base thumbnail width in CSS px (multiplied by dpr at render time). Roughly a
 *  card's on-screen width — a little generous so the preview stays crisp when a
 *  card grows to fill its grid track. The proxy render path makes this cheap. */
export const PROJECT_PREVIEW_BASE_W = 320;

/**
 * Pure function. Device-pixel render size for a project preview: a fixed base
 * width (scaled by dpr) with height derived from the camera rect's aspect, so
 * the thumbnail is never distorted (the card tile letterboxes it via
 * object-fit). Returns null for a degenerate rect (non-positive w/h) — the
 * caller then shows a name-only placeholder instead of rasterizing.
 *
 * @param {{w:number,h:number}} rect  Camera rect in world units.
 * @param {number} baseW  Base thumbnail width in CSS px (pre-dpr).
 * @param {number} dpr  Device pixel ratio (>=1).
 * @returns {{width:number,height:number}|null}
 *
 * @example previewRenderSize({ w: 1280, h: 720 }, 320, 2)  // { width: 640, height: 360 }
 * @example previewRenderSize({ w: 800, h: 800 }, 320, 1)   // { width: 320, height: 320 }
 * @example previewRenderSize({ w: 0, h: 720 }, 320, 2)     // null  (degenerate)
 */
export function previewRenderSize(rect, baseW, dpr) {
  if (!(rect.w > 0) || !(rect.h > 0)) return null;
  const width = Math.max(1, Math.round(baseW * dpr));
  const height = Math.max(1, Math.round(width * (rect.h / rect.w)));
  return { width, height };
}

/**
 * Near-pure async function (orders/limits calls to `worker`, which has the side
 * effects). Applies `worker` to each item with at most `limit` invocations in
 * flight at once, and resolves once every item is done. Results are surfaced by
 * the worker's own side effects (no return array). A worker rejection propagates
 * and aborts the pool, so a worker that must not halt the rest should
 * swallow+report its own failures (the Open-modal worker does exactly that).
 *
 * @param {Array<T>} items  Work items.
 * @param {number} limit  Max concurrent worker calls (clamped to >=1).
 * @param {(item: T, index: number) => Promise<void>} worker  Per-item async task.
 * @returns {Promise<void>}  Resolves when all items are processed.
 * @template T
 *
 * @example
 * // Runs all three, at most two at a time, in item order per lane:
 * // const seen = [];
 * // await mapWithConcurrency([1, 2, 3], 2, async (n) => { seen.push(n); });
 * // seen.sort() // [1, 2, 3]
 */
export async function mapWithConcurrency(items, limit, worker) {
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const runLane = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: lanes }, runLane));
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 604800;

/**
 * Query (reads the ambient locale via Intl). A short, human-readable "time ago"
 * for a file mtime relative to `nowMs`, choosing the largest sensible unit
 * (seconds → minutes → hours → days → weeks). Uses Intl.RelativeTimeFormat with
 * numeric:"auto" so ~now reads "now" and one-unit deltas read "yesterday" etc.
 * A future mtime (clock skew) also formats sanely ("in 3 minutes").
 *
 * @param {number} mtimeSeconds  File mtime as a UNIX timestamp in SECONDS (the
 *   server's list_projects contract — os.path.getmtime).
 * @param {number} nowMs  Current time in MILLISECONDS (Date.now()).
 * @returns {string}
 *
 * @example relativeMtime(0, 5_000)                  // "5 seconds ago"  (mtime 0s, now 5s)
 * @example relativeMtime(0, 2 * 3600 * 1000)        // "2 hours ago"
 * @example relativeMtime(0, 0)                      // "now"
 */
export function relativeMtime(mtimeSeconds, nowMs) {
  const deltaS = Math.round(mtimeSeconds - nowMs / 1000); // negative = in the past
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(deltaS);
  if (abs < SECONDS_PER_MINUTE) return rtf.format(deltaS, "second");
  if (abs < SECONDS_PER_HOUR) return rtf.format(Math.round(deltaS / SECONDS_PER_MINUTE), "minute");
  if (abs < SECONDS_PER_DAY) return rtf.format(Math.round(deltaS / SECONDS_PER_HOUR), "hour");
  if (abs < SECONDS_PER_WEEK) return rtf.format(Math.round(deltaS / SECONDS_PER_DAY), "day");
  return rtf.format(Math.round(deltaS / SECONDS_PER_WEEK), "week");
}

/**
 * Pure function. The card meta line for a project: slide count + relative
 * modified time, joined by a middot. A null/undefined slideCount (unreadable
 * doc.json server-side) reads "? slides"; a null mtime drops the time half.
 *
 * @param {{slideCount:?number, mtime:?number}} project  One listProjects entry.
 * @param {number} nowMs  Current time in MILLISECONDS (Date.now()).
 * @returns {string}
 *
 * @example projectMetaLine({ slideCount: 3, mtime: 0 }, 2 * 3600 * 1000) // "3 slides · 2 hours ago"
 * @example projectMetaLine({ slideCount: 1, mtime: 0 }, 0)               // "1 slide · now"
 * @example projectMetaLine({ slideCount: null, mtime: null }, 0)         // "? slides"
 */
export function projectMetaLine(project, nowMs) {
  const n = project.slideCount;
  const slides = `${n ?? "?"} ${n === 1 ? "slide" : "slides"}`;
  if (project.mtime == null) return slides;
  return `${slides} · ${relativeMtime(project.mtime, nowMs)}`;
}
