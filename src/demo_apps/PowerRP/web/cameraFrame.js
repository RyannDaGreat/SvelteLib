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
 * NOT ONLY PIXEL CONSUMERS ANY MORE (R7-2/R7-4): web/PresentMode.svelte also feeds
 * `evaluatedStateAt(doc, frame.index, frame.alpha, registry)` to the AUDIO mirror,
 * from the same paint() that feeds cameraFrameIR. That is the whole fix for "the
 * presentation audio behaves differently" and for a filter cutoff that stepped
 * instead of sweeping: sound now comes out of the same [[slide, alpha]] evaluation
 * the picture does, so the two cannot disagree.
 *
 * TODO (flagged, out of this task's fence — contested file): CanvasView.svelte
 * still hand-assembles the SAME bg-rect + sceneIR recipe (its own idiom, with
 * culling — cameraFrameIR already accepts cullRect for exactly that). Swap it
 * onto cameraFrameIR when its owner (the CanvasView regions) is free, to retire
 * the last copy.
 */

import { tweenedState } from "../core/document.js";
import { deriveRenderTree, cameraRect } from "../core/derive.js";
import { contentSizesFor } from "./contentSizes.js"; // intrinsic sizes: produced here, consumed as an evaluateState input
import { evaluateState } from "../core/expressions.js";
import { canSkipNode } from "../core/view.js";
import { sceneIR, resolvedBackgroundFill } from "../render_gpu/ports.js";
import { preRasterizePdfPages } from "../render_gpu/pdf_display.js";
import { prepareMapTiles } from "../render_gpu/map_display.js";
import { prepareScene3dViews } from "../render_gpu/scene3d_display.js";
import { prepareLiveAnalysis } from "../render_gpu/gpu/live_analysis_registry.js";
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
  // CONTENT INTRINSIC SIZES ride the same argument for the same reason (#277):
  // they are an input evaluateState cannot fetch for itself without becoming
  // impure, they are not in the fold, and every pixel consumer reaches evaluation
  // through here — so threading them once covers thumbnails, PNG/MP4 export, the
  // presenter and the CLI hook, exactly as the script already is.
  const folded = tweenedState(doc, slideIndex, alpha, registry);
  return evaluateState(folded, registry, doc.meta.script ?? "", contentSizesFor(folded, doc.meta?.name ?? ""));
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
 * not at the op level). Omitting it falls back to `meta?.name`, which is safe
 * ONLY for a bare-node/CLI caller that holds nothing but the document itself
 * (an all-absolute document — every one written before this grammar — needs no
 * project at all; a relative ref with no project throws loudly, naming the ref).
 * A BROWSER CALLER RENDERING THE APP'S OWN OPEN DOCUMENT MUST NOT RELY ON THIS
 * FALLBACK — it must pass `app.projectName()` explicitly. `doc.meta.name` and
 * `projectName()` agree for an ordinary saved project but diverge for an open
 * DRAFT, where `projectName()` answers the draft key and `meta.name` is still
 * the human name; the assets are staged under the KEY. A caller that fell back
 * here (gpuService.js's thumbnail/minimap/PNG-export path once did) resolved
 * every ref against the wrong, empty keyspace and rendered the missing-asset
 * sentinel for a reload-restored or freshly-opened draft.
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
 * LIVE AUDIO ANALYSIS (R7-5) is the FOURTH pre-pass, run here like the three
 * above it because this function is the one that holds the derived node list —
 * a caller cannot build the map itself without deriving the tree a second time.
 *
 * IT IS AN EXPLICIT BOOLEAN OPT-IN, NOT `view`-DRIVEN, and that is the whole
 * safety property. A surface passes `liveAnalysis: true` when it has a running
 * AudioContext whose output the author is watching — the presenter, and the editor
 * canvas (which does not come through this function and calls
 * `prepareLiveAnalysis` directly). EVERY OTHER CALLER MUST NOT: thumbnails, the
 * minimap, PNG/PDF/SVG export, the video render job and the CLI hook all render
 * something that must be reproducible, and live samples are not — an export that
 * drew them would differ run to run, and a headless render has no samples at all.
 * Gating on `view` instead would have been exactly wrong: the presenter passes a
 * view, and so does anything else that knows its camera, so live audio would have
 * leaked into surfaces that must never see it.
 *
 * @param {{cullRect?: object, view?: object, viewW?: number, viewH?: number, project?: string, live?: boolean, liveAnalysis?: boolean}} [opts]
 *   Optional world-space cull rect + live view (view + device-px canvas size) to
 *   drive the PDF display re-raster, and the owning project for ref resolution.
 *   `live` declares that the CALLER repaints when an async raster lands — see the
 *   note at the sceneIR call below; it is deliberately NOT inferred from `view`.
 *   `liveAnalysis` declares that this surface may draw LIVE audio analysis, and is
 *   likewise an explicit opt-in.
 * @returns {Array} IR command list: [cameraBgRect, ...sceneIR(nodes)].
 *
 * @example // cameraFrameIR(evaluatedState, doc.meta, registry, {project: doc.meta.name}) // [rectCmd(bg), ...scene]
 */
export function cameraFrameIR(state, meta, registry, { cullRect = null, view = null, viewW = 0, viewH = 0, project = "", live = false, liveAnalysis = false } = {}) {
  const rect = cameraRect(state, meta);
  const allNodes = deriveRenderTree(state, registry, project || meta?.name || "");
  let nodes = allNodes;
  if (cullRect) nodes = nodes.filter((n) => !canSkipNode(n, cullRect));
  const liveView = view && viewW > 0 && viewH > 0;
  const pdfDisplay = liveView ? preRasterizePdfPages(nodes, view, viewW, viewH) : null;
  // The MAP tile pre-pass, the twin of the PDF one and for the same reason: emit()
  // is camera-free, so the tile DEPTH (which follows the camera's device px per
  // world unit) and the tile LIST (which follows the visible crop) are decided
  // here, in the one layer that knows the view. No live view — export, thumbnails,
  // the CLI — means no descriptor and the widget takes its camera-free fallback.
  const mapTiles = liveView ? prepareMapTiles(nodes, view, viewW, viewH) : null;
  // The 3D VIEWPORT pre-pass, the third of the same shape (todo #257): a scene's
  // render RESOLUTION follows the camera and its sub-frustum follows the visible
  // crop, so neither can be decided in emit(). No live view — export, thumbnails,
  // the CLI — means no descriptor, and the widget renders its whole self at its
  // own world scale exactly as it did before this pre-pass existed.
  const scene3d = liveView ? prepareScene3dViews(nodes, view, viewW, viewH) : null;
  // THE ANALYSIS PRE-PASS. Gated on the caller's own opt-in rather than on `view`
  // (see the docblock), and built from the POST-CULL list: a culled node draws
  // nothing, so it needs no descriptor. Its ring keeps filling either way — the
  // engine's subscription is not driven by rendering, which is what R7-6 means by
  // "a culled audio widget keeps playing".
  const analysisColumns = liveAnalysis ? prepareLiveAnalysis(nodes) : null;
  return [
    // resolvedBackgroundFill (NOT bare parsePaint): the camera background is a
    // full PAINT prop — Solid / Linear / Radial / MATERIAL / `=` equation — and
    // this rect is hand-assembled OUTSIDE sceneIR, so a MATERIAL background is
    // resolved HERE (ports.resolvedBackgroundFill; unresolved it threw at the
    // painter every frame — the camera-background freeze). A plain "#rrggbb"
    // string is still a solid, byte-identically.
    rectCmd({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: resolvedBackgroundFill(rect.background, nodes) }),
    // `live` IS AN EXPLICIT OPT-IN AND IS NOT DERIVED FROM `view`. The two are
    // different questions and conflating them was a real defect, caught before it
    // shipped: a view says "I know where the camera is", `live` says "I WILL
    // REPAINT when an asynchronous raster arrives". web/PresentMode.svelte passes
    // a view and does NOT repaint on image load — it repaints on navigation, on a
    // tween, and on a slide holding an animated widget, and subscribes to
    // image_registry not at all. Handing it `live` would let a stale frame be
    // drawn and then never replaced, so a presented slide could sit indefinitely
    // showing a 3D scene at the WRONG POSE: strictly worse than a hole, because it
    // looks right. The pre-passes above are still driven by `view`, because a
    // resolution decision does not depend on repainting and the presenter should
    // get its scenes at presentation resolution.
    // `wireNodes` IS THE PRE-CULL TREE, and passing it is the whole reason this
    // function keeps `allNodes` around (WORKSTREAM BN). A node-flow WIRE spans two
    // nodes; culling asks only whether ONE node's own bounds miss the view. So a
    // wire from an off-camera source into an on-camera sink — visible for most of
    // its length, and the commonest arrangement in a patch that runs off the edge
    // of a slide — would simply vanish if the wire pass read the culled list.
    // Presentation mode is the only caller that culls, so without this line the
    // presenter would show a DIFFERENT set of wires than the PDF/PNG export of the
    // same slide, which is exactly the split the user asked to close. With no
    // cullRect, `allNodes === nodes` and this is the same object it always was.
    ...sceneIR(nodes, { pdfDisplay, mapTiles, scene3d, liveAnalysis: analysisColumns, live, wireNodes: allNodes }),
  ];
}
