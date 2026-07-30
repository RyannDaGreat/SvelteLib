/**
 * THE camera-frame recipe, one home. Rendering a document frame THROUGH THE
 * CAMERA is always the same sequence — evaluate the camera rect, draw its
 * background as the first world-space rect, then the derived scene — yet it was
 * hand-assembled in ~6 places in two subtly different idioms (cruft audit:
 * "camera-frame recipe hand-assembled ~6 places in 2 idioms"). This module is
 * the ONE builder + the ONE camera-rect query the pixel consumers share.
 *
 * Lives in web/ (not core/derive.js) BY NECESSITY: cameraRectAt needs
 * foldState (document.js) + evaluateState (expressions.js), and expressions.js
 * imports derive.js — putting either helper in derive.js would make an import
 * cycle. This is the lowest layer that already imports fold + evaluate + IR.
 *
 * CONSUMERS NOW: web/gpuService.js (renderCameraFrame — thumbnails/export/PNG,
 * and the camera-rebased minimap via CanvasView), web/main.js (the CLI hook),
 * web/PresentMode.svelte (cameraFrameIR for the tween/instant GPU frame), and
 * web/SlideNav.svelte + web/App.svelte (cameraRectAt) — outputs asserted
 * identical to the hand-assembled idioms they replaced.
 *
 * TODO (flagged, out of this task's fence — contested file): CanvasView.svelte
 * still hand-assembles the SAME bg-rect + sceneIR recipe (its own idiom, with
 * culling — cameraFrameIR already accepts cullRect for exactly that). Swap it
 * onto cameraFrameIR when its owner (the CanvasView regions) is free, to retire
 * the last copy.
 */

import { tweenedState } from "../core/document.js";
import { deriveRenderTree, cameraRect } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { canSkipNode } from "../core/view.js";
import { sceneIR, resolvedBackgroundFill } from "../render_gpu/ports.js";
import { preRasterizePdfPages } from "../render_gpu/pdf_display.js";
import { rect as rectCmd } from "../render_gpu/ir.js";
/**
 * Query (memoized fold + evaluate). THE evaluated folded state for
 * (doc, slide, alpha): folds the slide deltas then evaluates every equation, so
 * all properties are plain numbers. The ONE home for the
 * `evaluateState(tweenedState(...)).state` idiom the pixel consumers, the
 * presenter, and the CLI hook all repeat.
 *
 * THE FOLD IS `tweenedState`, NOT `foldState`: mid-transition, a widget whose own
 * properties are COUPLED (the deep-zoom Mandelbrot's centre against its
 * logarithmic zoom) gets to say how its state interpolates, which the leaf-wise
 * lerp cannot express. At alpha 0 and 1 the two are identical by construction.
 *
 * @param {object} doc PowerRP document.
 * @param {number} slideIndex Slide index.
 * @param {number} alpha Tween alpha (default 1).
 * @param {object} registry Plugin registry (equation evaluation + the tween hook).
 * @returns {object} Evaluated folded state ({items, vars} with numbers).
 *
 * @example // evaluatedStateAt(newDocument(), 0, 1, registry) // {items:{...}, vars:{...}}
 */
export function evaluatedStateAt(doc, slideIndex, alpha, registry) {
  return evaluationAt(doc, slideIndex, alpha, registry).state;
}

/**
 * Query (memoized fold + evaluate). The WHOLE evaluation for (doc, slide, alpha) —
 * `{state, errors, deps, clock}` — for the one caller that needs more than the
 * state: the presenter, which reads `clock` to know whether this slide's equations
 * animate off the presentation clock and therefore need a per-frame repaint.
 * `evaluatedStateAt` is this plus `.state`, so the two cannot drift.
 *
 * @param {object} doc PowerRP document.
 * @param {number} slideIndex Slide index.
 * @param {number} alpha Tween alpha.
 * @param {object} registry Plugin registry.
 * @returns {object} {state, errors, deps, clock} (see core/expressions.evaluateState).
 *
 * @example // evaluationAt(newDocument(), 0, 1, registry).clock // null — a fresh deck reads no clock
 */
export function evaluationAt(doc, slideIndex, alpha, registry) {
  // THE PROJECT SCRIPT (doc.meta.script) is threaded here rather than at each of
  // this module's callers, because this is the one place that holds the DOCUMENT
  // and evaluateState only ever sees the FOLD — the script cannot ride in the
  // folded state, so a seam that forgot it would render a scripted deck with every
  // scripted property fallen back to its default. Every pixel consumer (thumbnails,
  // PNG/MP4 export, the presenter, the CLI hook) reaches evaluation through here,
  // so threading it once covers all of them.
  return evaluateState(tweenedState(doc, slideIndex, alpha, registry), registry, doc.meta.script ?? "");
}

/**
 * Query (memoized fold + evaluate). THE camera rect for (doc, slide, alpha):
 * evaluates the folded state (the camera's own x/y/w/h/background may be
 * equations) and reads cameraRect. The ONE home for the
 * `cameraRect(evaluateState(foldState(...)).state, meta)` idiom.
 *
 * @param {object} doc PowerRP document.
 * @param {number} slideIndex Slide index.
 * @param {number} alpha Tween alpha (default 1).
 * @param {object} registry Plugin registry (for equation evaluation).
 * @returns {{x:number,y:number,w:number,h:number,background:string}}
 *
 * @example // cameraRectAt(newDocument(), 0, 1, registry) // {x:0, y:0, w:1280, h:720, background:"#ffffff"}
 */
export function cameraRectAt(doc, slideIndex, alpha, registry) {
  return cameraRect(evaluatedStateAt(doc, slideIndex, alpha, registry), doc.meta);
}

/**
 * Near-pure function (may idempotently kick async PDF region rasters when a live
 * view is supplied; the returned IR is a deterministic function of the inputs +
 * registry state). THE display-list for one camera frame of an EVALUATED state:
 * the camera's background as the first world-space rect (covers exactly the
 * camera rect — so an arbitrary view, like the minimap's, still paints the
 * camera region even where the frame's clear is transparent), followed by the
 * derived scene's IR. Optionally CULLS nodes whose bounds miss `cullRect`
 * (world-space AABB) via the standard culling protocol; omit `cullRect` to
 * emit every node (the thumbnail/export/minimap consumers don't cull today).
 *
 * PDF DISPLAY RE-RASTER (manifest RENDER PIVOT): when a caller that knows the
 * live view passes `view` + `viewW/viewH` (device px), this runs the PDF
 * re-raster pre-pass (render_gpu/pdf_display) so placed PDF pages are crisp at
 * the current zoom, and threads the descriptor map into sceneIR. Consumers with
 * NO view (thumbnails, CLI, PNG/SVG/PDF export) omit it → the whole-page raster
 * / vector-export fallback, exactly as before (byte-identical to the pre-pivot
 * output for those paths).
 *
 * THE OWNING PROJECT (`opts.project`) is threaded to deriveRenderTree, which is
 * where an asset ref becomes a URL a registry can actually load (core/asset_ref.js
 * states the grammar; core/derive.js's docblock states why the seam is there and
 * not at the op level). Callers that hold a DOCUMENT should pass `doc.meta.name`.
 * Omitting it is safe for an all-absolute document (every document written before
 * this grammar) and throws loudly, naming the ref, for one that actually holds a
 * relative ref.
 *
 * WHAT THAT NAME RESOLVES TO IS MODE-AWARE, and deliberately NOT decided here.
 * In static mode it must become a `blob:` URL from browser storage, and this
 * module is not the only derive entry point — web/app.svelte.js's nodes(), its
 * PDF/SVG/copy exporters, CanvasView and PresentMode all derive with the project
 * NAME and never call this function. So the mapping is installed once on
 * core/asset_ref (`setProjectNameResolver`, from web/storageMode.js at boot) and
 * every one of those paths gets the same answer. Threading a resolver through
 * this argument instead would have fixed only the callers that thread it — which
 * is exactly why the measured blank-video bug survived an earlier attempt.
 *
 * @param {object} state EVALUATED folded state (equations already numbers).
 * @param {object} meta doc.meta ({slideW, slideH}) — the camera-rect fallback.
 * @param {object} registry Plugin registry.
 * @param {{cullRect?: object, view?: object, viewW?: number, viewH?: number, project?: string}} [opts]
 *   Optional world-space cull rect + live view (view + device-px canvas size) to
 *   drive the PDF display re-raster, and the owning project for ref resolution.
 * @returns {Array} IR command list: [cameraBgRect, ...sceneIR(nodes)].
 *
 * @example // cameraFrameIR(evaluatedState, doc.meta, registry, {project: doc.meta.name}) // [rectCmd(bg), ...scene]
 */
export function cameraFrameIR(state, meta, registry, { cullRect = null, view = null, viewW = 0, viewH = 0, project = "" } = {}) {
  const rect = cameraRect(state, meta);
  let nodes = deriveRenderTree(state, registry, project || meta?.name || "");
  if (cullRect) nodes = nodes.filter((n) => !canSkipNode(n, cullRect));
  const pdfDisplay = view && viewW > 0 && viewH > 0 ? preRasterizePdfPages(nodes, view, viewW, viewH) : null;
  return [
    // resolvedBackgroundFill (NOT bare parsePaint): the camera background is a
    // full PAINT prop — Solid / Linear / Radial / MATERIAL / `=` equation — and
    // this rect is hand-assembled OUTSIDE sceneIR, so a MATERIAL background is
    // resolved HERE (ports.resolvedBackgroundFill; unresolved it threw at the
    // painter every frame — the camera-background freeze). A plain "#rrggbb"
    // string is still a solid, byte-identically.
    rectCmd({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: resolvedBackgroundFill(rect.background, nodes) }),
    ...sceneIR(nodes, { pdfDisplay }),
  ];
}
