/**
 * THE DRAIN — "render this frame, then keep re-rendering until every async raster
 * it needs has actually arrived, and REFUSE if one never will."
 *
 * User, 2026-08-01: "a major issue when I render videos, the PDF is nowhere to be
 * found. I think we're going to have to have a concept such as settled and not
 * settled."
 *
 * ── WHY THIS FILE EXISTS AT ALL: IT WAS ONE CONSUMER'S PRIVATE HABIT ─────────
 * All of this lived inside web/renderJobPage.js — correct, well argued, and
 * reachable by exactly ONE of the app's pixel consumers. Every other exporter
 * rendered once and wrote whatever was on the canvas at that instant. So the
 * server-side video renderer waited and the in-browser one did not, which is why
 * the same deck could export a PDF page from one path and a hole from the other.
 * R6-11 recorded the shape of it: "settledFrame is unshared across three consumers
 * of one renderer."
 *
 * Moving it here is the whole of the fix. Nothing about the logic below changed;
 * it stopped being a local habit and became the protocol.
 *
 * ── THE TWO QUESTIONS, AND WHY THEY ARE NOT ONE LIST ─────────────────────────
 * PENDING means "wait longer". FAILED means "this will never arrive". They are
 * not two views of the same set, and conflating them IS the original defect: a
 * ref whose load has already failed is precisely the thing that is NOT pending,
 * so "nothing is pending" has never meant "the frame is whole". A 404'd video left
 * the media map without its entry, paint_skia's `if (!img) break;` skipped the
 * quad, the pending set was empty on the first check, and the job wrote a holed
 * frame and exited 0 — the widget "does not appear in Render Center output", with
 * nothing anywhere saying so.
 *
 * ── ALL FOUR REGISTRIES ──────────────────────────────────────────────────────
 * image (which backs PDF pages, LaTeX, Mermaid, plain images and scene3d),
 * video, svg sources, and text assets. An earlier fix covered video alone, so the
 * rule held only for the registry the bug was found in.
 *
 * ── WHAT THIS IS *NOT* FOR ───────────────────────────────────────────────────
 * EXPORTS, not thumbnails. A thumbnail or a minimap that draws before its PDF
 * decodes is cosmetically stale for a moment and then repaints itself — the
 * editor has `onImageLoad` for exactly that. Making those paths block would trade
 * a self-healing blink for a stalled UI, and could hang the editor on a broken
 * asset that costs nothing where it is. An EXPORT has no second chance: whatever
 * it writes is the artefact.
 */

import { pendingImageRefs, failedImageRefs, onImageLoad } from "../render_gpu/gpu/image_registry.js";
import { pendingVideoSrcs, failedVideoSrcs, onVideoFrame } from "../render_gpu/gpu/video_registry.js";
import { pendingSvgSources, failedSvgSources, onSvgSourceLoad } from "../render_gpu/gpu/svg_source_registry.js";
import { pendingTextAssets, failedTextAssets, onTextAssetLoad } from "../render_gpu/gpu/text_asset_registry.js";
import { truncate } from "../core/report.js";

/**
 * How long a pending raster may make NO progress before the frame is refused.
 * Generous because a first Mermaid frame pays an engine import plus a typeset,
 * and a cold PDF pays a document open — both seconds, legitimately.
 */
const RASTER_STALL_SECONDS = 30;

/** Poll interval backing the event subscriptions, so a registry that completes
 *  without firing an event cannot wedge the loop. */
const RASTER_POLL_MS = 100;

/**
 * Query. Every async load still in flight, across all four registries.
 *
 * @returns {string[]} refs/srcs currently loading
 */
export function pendingRasters() {
  return [...pendingImageRefs(), ...pendingVideoSrcs(), ...pendingSvgSources(), ...pendingTextAssets()];
}

/**
 * Query. Every async load that has PERMANENTLY failed. See the module docblock on
 * why this is separate from `pendingRasters` and why that separation is the bug.
 *
 * SCOPE: the registries are module-global caches, so this answers "every src that
 * has failed IN THIS PAGE", not "every src this frame needs". Those coincide in a
 * dedicated render-job page, which renders one document; a consumer that renders
 * several documents in one page must reset the registries between them or it will
 * refuse a frame over a clip the current deck never mentions.
 *
 * @returns {string[]} refs/srcs whose failure is already decided
 */
export function failedRasters() {
  return [...failedVideoSrcs(), ...failedImageRefs(), ...failedSvgSources(), ...failedTextAssets()];
}

/**
 * Command (async). Resolves on the next raster event from any registry, or after
 * RASTER_POLL_MS if none arrives. Both wake reasons are equivalent to the caller:
 * it re-examines the pending set either way.
 */
export function waitForRasterProgress() {
  return new Promise((resolve) => {
    let offImage = null, offVideo = null, offSvg = null, offText = null, timer = null;
    const finish = () => {
      offImage?.(); offVideo?.(); offSvg?.(); offText?.();
      clearTimeout(timer);
      resolve();
    };
    offImage = onImageLoad(finish);
    offVideo = onVideoFrame(finish);
    offSvg = onSvgSourceLoad(finish);
    offText = onTextAssetLoad(finish);
    timer = setTimeout(finish, RASTER_POLL_MS);
  });
}

/**
 * Command (async). Renders a frame and RE-RENDERS it until nothing is pending,
 * then returns it. Throws rather than returning a frame with a hole in it.
 *
 * Two refusals, and the ORDER matters:
 *   1. a ref that has ALREADY failed for good — checked FIRST and on every pass,
 *      INCLUDING the pass where nothing is pending, because a failed ref is never
 *      pending and that is the entire hazard;
 *   2. a pending raster that made no progress for RASTER_STALL_SECONDS.
 *
 * PROGRESS MEANS SOMETHING LEFT THE PENDING SET. A set that merely GREW — this
 * frame asked for a new raster — is not progress and must not reset the clock, or
 * a permanently stuck ref could hide forever behind a stream of new ones.
 *
 * @param {() => Promise<*>} render Re-render this exact frame (idempotent).
 * @param {string} [label] Prefix for the refusal messages, naming the caller.
 * @returns {Promise<*>} whatever `render` returns, once settled
 */
export async function settledFrame(render, label = "settledFrame") {
  let out = await render();
  let waiting = null;
  let progressedAt = performance.now();
  for (;;) {
    const failed = failedRasters();
    if (failed.length > 0)
      throw new Error(`${label}: ${failed.length} media source(s) FAILED to load, so this frame would be written with a hole where each of them should be — ${failed.map(truncate).join(", ")}. The load error itself was reported on the console above.`);
    const pending = pendingRasters();
    if (pending.length === 0) return out;
    const now = new Set(pending);
    if (waiting === null || [...waiting].some((ref) => !now.has(ref))) progressedAt = performance.now();
    else if (performance.now() - progressedAt > RASTER_STALL_SECONDS * 1000)
      throw new Error(`${label}: ${pending.length} raster(s) made no progress for ${RASTER_STALL_SECONDS}s and this frame cannot be drawn whole — ${pending.map(truncate).join(", ")}`);
    waiting = now;
    await waitForRasterProgress();
    out = await render();
  }
}
