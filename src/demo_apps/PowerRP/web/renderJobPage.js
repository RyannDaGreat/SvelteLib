/**
 * THE PAGE HALF of the server-side render-job worker (cli/render_job.js).
 *
 * cli/render_job.js is a Node process with no pixels in it: it boots this app in
 * a headless browser, imports this module into the page, and asks it for one
 * finished frame at a time. Everything that decides what a frame LOOKS like
 * happens here, in the browser, through the editor's own modules —
 * transitionRender's letterbox composite, videoExport's frame sampler,
 * gpuService's Skia/WebGL2 surface.
 *
 * ── WHY THE BROWSER, AND NOT A SECOND RENDERER (user ruling, 2026-07-28) ──────
 * The backend used to render in BARE NODE on a software Skia surface
 * (render_gpu/skia/node_render.js → CanvasKit.MakeSurface, no GL context). That
 * is a SECOND renderer, and it silently lacked five things the editor has:
 *   · image / video / PDF / filmstrip — no `createImageBitmap` in node, so every
 *     one of them drew NOTHING;
 *   · LaTeX — MathJax throws without a DOM;
 *   · Mermaid — dies loading a .ttf;
 *   · motion blur — needs a canvas to average sub-frames on;
 *   · a GPU — `MakeSurface` never asks for a context, so it is CPU-only on ANY
 *     hardware, forever.
 * Running the editor's own code in a headless browser closes all five at once,
 * and keeps closing them: `render_gpu/skia/browser_surface.js` has NO CPU branch
 * — it always asks for WebGL2 and lets ANGLE bind SwiftShader, Mesa, or a real
 * driver underneath — so every consumer of it inherits CPU-and-GPU for free.
 * Reuse is the MECHANISM here, not a style preference.
 *
 * ── THE PROTOCOL (three globals, driven over CDP) ─────────────────────────────
 *   __powerrp_renderJobOpen(docJson, params) → {frames, glRenderer, …}
 *   __powerrp_renderJobFrame(index)          → base64 PNG for output frame index
 *   __powerrp_renderJobClose()               → releases the controlled-time override
 * `frames` is computed HERE and is authoritative: the node side shards the range
 * it is given rather than re-deriving the timeline, so the two halves cannot
 * disagree about how long the video is.
 *
 * ── AMBIENT TIME IS DRIVEN, NOT INHERITED ─────────────────────────────────────
 * render_gpu/particle_clock.js has two regimes and its PAUSED regime returns a
 * FIXED freeze time for every still consumer (editor viewport, thumbnails, the
 * pixel service). A movie rendered in that regime is a movie of a FROZEN
 * sparkler — no error, just silently wrong. createFrameSampler drives the clock
 * from (frameIndex, fps) through `setParticleTimeOverride` exactly as the
 * in-browser export does, so every frame stays a pure function of its index.
 *
 * ── EVERY FRAME IS SETTLED BEFORE IT IS RETURNED ──────────────────────────────
 * The editor is reactive: an image / equation / diagram / PDF page that is still
 * rasterizing simply draws nothing, and `onImageLoad` nudges a repaint when it
 * lands. A one-shot render has no next repaint, so it must WAIT — see
 * settledFrame below. Without it the worker would write frames with holes in
 * them and report success, which is precisely the failure mode the bare-node
 * renderer had.
 */

import { deserialize, repairedDocument, printRepairReports } from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { loadFonts } from "./fontLoader.js";
import { timelinePlan, frameCount, createFrameSampler, DEFAULT_HOLD_SECONDS } from "./videoExport.js";
import { createLetterboxFrameRenderer } from "./transitionRender.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { pendingImageRefs, failedImageRefs, onImageLoad } from "../render_gpu/gpu/image_registry.js";
import { pendingVideoSrcs, failedVideoSrcs, onVideoFrame, resetVideoRegistry } from "../render_gpu/gpu/video_registry.js";
import { pendingSvgSources, failedSvgSources, onSvgSourceLoad } from "../render_gpu/gpu/svg_source_registry.js";
import { pendingTextAssets, failedTextAssets, onTextAssetLoad } from "../render_gpu/gpu/text_asset_registry.js"; // CSV/JSON data assets a plugin-asset widget charts (core/plugin_assets.js assetText)
import { gpuAccelerated } from "./gpuService.js";
import { truncate } from "../core/report.js"; // THE shared log elision (a tenth private copy lived here, with drifted constants)

/**
 * How long a raster may make NO PROGRESS before the frame is declared stalled.
 * It is a no-progress window, NOT a budget for the work: every landed bitmap
 * resets it, so a slow deck simply keeps resetting it and never trips it. The
 * value is ~6x the slowest warm-up this app has (the lazy MathJax / Mermaid
 * engine import plus a first typeset, which tests/mermaid_probe.js budgets 4.5 s
 * for on a software rasterizer), because the only thing that should ever hit it
 * is a raster that will NEVER arrive — and one of those exists today: a FAILED
 * latex/mermaid typeset marks its own entry "error" but leaves the image-registry
 * slot it reserved stuck at "loading" and never notifies. Without this the worker
 * would hang forever on such a deck; with it, it names the stuck refs and dies.
 */
const RASTER_STALL_SECONDS = 30;
/**
 * The heartbeat of the stall detector. Waiting purely on onImageLoad/onVideoFrame
 * would sleep forever exactly in the case worth detecting (a raster that never
 * notifies), so the wait also wakes on this interval to re-examine the pending
 * set. Nothing renders on this tick — it only re-checks — so it is cheap.
 */
const RASTER_POLL_MS = 100;
/** The `data:image/png;base64,` prefix a canvas data URL carries before the bytes. */
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** The open session: null until __powerrp_renderJobOpen, one at a time. */
let session = null;

/**
 * Query. Every async load this page is still waiting on — image decodes, LaTeX
 * typesets, Mermaid renders, PDF page rasters (all of which land in the image
 * registry), video elements that have no first frame yet, SVG sources, and TEXT
 * DATA ASSETS (a CSV a chart widget is plotting). The last one is not a raster,
 * but it gates a frame for exactly the same reason: a chart whose data has not
 * arrived draws no bars, and writing that frame ships an empty chart at exit 0.
 *
 * @returns {string[]} pending refs/srcs, empty when the scene can be drawn whole
 *
 * @example // with nothing outstanding
 * pendingRasters() // []
 */
function pendingRasters() {
  return [...pendingImageRefs(), ...pendingVideoSrcs(), ...pendingSvgSources(), ...pendingTextAssets()];
}

/**
 * Query. Every async load this page will NEVER complete — the refs whose failure
 * is already decided. `pendingRasters` and this are not two views of one list:
 * pending means "wait longer", and a permanently failed ref is exactly the thing
 * that is not pending, so nothing pending has never meant the frame is whole.
 *
 * That gap IS the R6-12.1 defect. A `video` whose src 404s left the media map
 * without its entry, `paint_skia`'s `if (!img) break;` skipped the quad, the
 * pending set was empty on the very first check, and the worker wrote a frame with
 * a hole in it and exited 0 — the widget "does not appear in Render Center output"
 * with nothing anywhere saying so. Reproduced end-to-end before this landed.
 *
 * SCOPE: the media registries are MODULE-GLOBAL caches, so this answers "every
 * src that has failed IN THIS PAGE", not "every src this frame needs". Those two
 * are the same thing here and only here, because a render-job page renders exactly
 * ONE document — openSession refuses a second concurrent session and clears the
 * video registry, so nothing another deck loaded can be in it. A consumer that
 * runs a render inside the LIVE EDITOR page (web/browserRenderJobs.js, the in-page
 * Export MP4 — neither of which settles at all today) may NOT reuse this as-is: a
 * clip the user broke an hour ago would refuse an export of an unrelated deck.
 * That consumer needs the failed set intersected with the scene's own refs, which
 * is a question only render_gpu/skia/browser_media.js can answer, since it is what
 * walks the display list for media ops.
 *
 * ONLY VIDEO TODAY, and that is a known gap rather than a claim: the image
 * registry (LaTeX / Mermaid / PDF page rasters / plain images all land there),
 * the SVG source registry and the text-asset registry each hold their own error
 * state and none of them publishes it. Each needs the same twin of its
 * `pendingX()` before it can join this line; that is a hand-back, not an omission
 * to be papered over here.
 *
 * @returns {string[]} refs that can never resolve, empty when nothing has failed
 *
 * @example // with nothing broken
 * failedRasters() // []
 */
function failedRasters() {
  // ALL FOUR REGISTRIES, not just video. This returned failedVideoSrcs() alone,
  // which meant R6-12.1's fix — "nothing pending has never meant the frame is
  // whole" — held only for the registry it was found in. The image registry backs
  // PDF PAGES, LaTeX, Mermaid, plain images and scene3d rasters, and an errored ref
  // there was in neither set: not pending (pendingImageRefs selects "loading"
  // only), not failed (no query existed). So the frame was declared whole,
  // paint_skia's `if (!img) break;` skipped the quad, and the job exited 0 having
  // written a hole — which is the likeliest reason a PDF is missing from an mp4
  // while looking correct in the editor, where onImageLoad supplies the later
  // repaint that a one-shot render does not have.
  return [...failedVideoSrcs(), ...failedImageRefs(), ...failedSvgSources(), ...failedTextAssets()];
}

/**
 * Command (async). Resolves on the next raster event, or after RASTER_POLL_MS if
 * none arrives. Both wake reasons are equivalent to the caller: it re-examines
 * the pending set either way.
 */
function waitForRasterProgress() {
  return new Promise((resolve) => {
    let offImage = null;
    let offVideo = null;
    let offSvg = null;
    let offText = null;
    let timer = null;
    const finish = () => {
      offImage?.();
      offVideo?.();
      offSvg?.();
      offText?.();
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
 * Command (async; renders repeatedly). ONE fully-resolved frame: renders, and
 * while anything is still rasterizing, waits for it and renders AGAIN — because
 * the widget that was pending drew nothing in the render that requested it.
 *
 * Throws LOUDLY, naming the refs, in BOTH of the ways a frame can fail to be
 * whole. A hole must fail the render, not quietly ship:
 *   - a raster that made no progress for RASTER_STALL_SECONDS — it will probably
 *     never arrive, and the frame has an equation-shaped gap in it;
 *   - a ref that has ALREADY failed for good (failedRasters). This one is checked
 *     FIRST and on every pass, including the pass where nothing is pending,
 *     because a failed ref is never pending — that is the whole hazard.
 *
 * @param {() => Promise<HTMLCanvasElement>} render Re-render this exact frame.
 * @returns {Promise<HTMLCanvasElement>}
 */
async function settledFrame(render) {
  let canvas = await render();
  let waiting = null;             // the pending set as of the last check
  let progressedAt = performance.now();
  for (;;) {
    const failed = failedRasters();
    if (failed.length > 0)
      throw new Error(`renderJobPage: ${failed.length} media source(s) FAILED to load, so this frame would be written with a hole where each of them should be — ${failed.map(truncate).join(", ")}. The load error itself was reported on this job's console output above.`);
    const pending = pendingRasters();
    if (pending.length === 0) return canvas;
    const now = new Set(pending);
    // PROGRESS = something that WAS pending no longer is. A set that merely grew
    // (this frame asked for a new raster) is not progress and must not reset the
    // clock, or a permanently stuck ref could hide behind a stream of new ones.
    if (waiting === null || [...waiting].some((ref) => !now.has(ref))) progressedAt = performance.now();
    else if (performance.now() - progressedAt > RASTER_STALL_SECONDS * 1000)
      throw new Error(`renderJobPage: ${pending.length} raster(s) made no progress for ${RASTER_STALL_SECONDS}s and this frame cannot be drawn whole — ${pending.map(truncate).join(", ")}`);
    waiting = now;
    await waitForRasterProgress();
    canvas = await render();
  }
}

/**
 * Command (async; builds a registry, repairs the doc, allocates canvases).
 * Opens a render session for one job and returns what the node side needs.
 *
 * Args:
 *   docJson (string): the job's document SNAPSHOT, serialized
 *   params (object): the job params — width/height/fps/background/samples and
 *     the slide range (startIndex/endIndex/includeTransitions/holdSeconds)
 *
 * Returns:
 *   Promise<{frames: number, glAccelerated: boolean, glRenderer: string}> —
 *   `frames` is the authoritative output-frame count for the whole timeline;
 *   the GL fields are reported by the worker so which backend ANGLE bound is a
 *   fact in the log rather than a guess (see cli/render_job.js).
 */
async function openSession(docJson, params) {
  if (session) throw new Error("renderJobPage: a render session is already open (close it first)");
  // A SESSION'S MEDIA STATE BELONGS TO THAT SESSION. The video registry is a
  // module-global cache with a TERMINAL "error" state per src, and failedRasters
  // now refuses a frame on the strength of it — so a src that failed under a
  // PREVIOUS document in this page would refuse every frame of the next one, for a
  // clip the new deck does not even mention. A worker page renders one document
  // and this is a no-op there; it is what makes that true rather than assumed, and
  // it is the difference between a scoped refusal and a latch. (Caught by
  // tests/render_job_media_hole_probe.js, which renders three decks through one
  // page and would otherwise have had to work around the implementation.)
  resetVideoRegistry();
  await loadFonts(); // memoized with main.js's boot load; text must never rasterize in a substituted face
  const registry = createRegistry();
  registerAll(registry, createCommands());
  // The editor's load-boundary repair, exactly as the editor runs it, so a job's
  // pixels cannot drift from what the author saw. Repairs are reported, never silent.
  const { doc, reports } = repairedDocument(deserialize(docJson), registry);
  printRepairReports(reports);
  const { width, height, fps, background, samples, startIndex, endIndex, includeTransitions, holdSeconds } = params;
  const plan = timelinePlan(doc, {
    startIndex, endIndex, includeTransitions,
    holdSeconds: holdSeconds ?? DEFAULT_HOLD_SECONDS,
  });
  const frames = frameCount(plan.duration, fps);
  if (frames === 0)
    throw new Error("renderJobPage: the selected range produced no frames (empty range, or a zero total duration — e.g. transitions off with a 0s hold).");
  const base = createLetterboxFrameRenderer({ doc, registry, width, height, background });
  const sampler = createFrameSampler({
    plan,
    // Each sub-sample render is SETTLED before the sampler averages it, so motion
    // blur cannot average a half-loaded frame into a loaded one.
    renderFrame: (index, alpha) => settledFrame(() => base(index, alpha)),
    width, height, fps, samples,
    setTime: setParticleTimeOverride, // drive the ambient clock — see the header
  });
  session = { sampler, frames };
  return { frames, glAccelerated: await gpuAccelerated(), glRenderer: glRendererString() };
}

/**
 * Query. The GL backend ANGLE actually bound, as a human-readable string, or a
 * reason it could not be read. Logged once per worker so "did it use the GPU?"
 * is answered by the log rather than assumed — the one thing this container
 * (no GPU) cannot demonstrate, and the one line that proves it on a box that has one.
 *
 * @example // "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)"
 * @example // "no WebGL2 context"   (a browser/flag combination without WebGL2)
 */
function glRendererString() {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return "no WebGL2 context";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}

/**
 * Command (async; renders). Output frame `index` of the open session as base64
 * PNG bytes. Base64 because a CDP evaluate returns JSON — the node side decodes
 * it straight into the file it writes.
 *
 * @param {number} index 0-based output frame index (< session.frames)
 * @returns {Promise<string>} base64 (no data-URL prefix)
 */
async function renderFrameBase64(index) {
  if (!session) throw new Error("renderJobPage: no render session is open");
  if (!(index >= 0 && index < session.frames))
    throw new Error(`renderJobPage: frame ${index} is outside this job's 0..${session.frames - 1} range`);
  const canvas = await session.sampler.sample(index);
  return canvas.toDataURL("image/png").slice(PNG_DATA_URL_PREFIX.length);
}

/** Command. Ends the session and returns the ambient clock to its freeze regime. */
function closeSession() {
  session?.sampler.release();
  session = null;
}

window.__powerrp_renderJobOpen = openSession;
window.__powerrp_renderJobFrame = renderFrameBase64;
window.__powerrp_renderJobClose = closeSession;
