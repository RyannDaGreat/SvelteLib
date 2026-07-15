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
 * and the camera-rebased minimap via CanvasView) and web/main.js (the CLI hook)
 * — the ones the cruft-batch task scoped, whose outputs are asserted identical.
 *
 * TODO (flagged, out of this task's fence — contested files): CanvasView.svelte
 * and PresentMode.svelte hand-assemble the SAME bg-rect + sceneIR recipe (their
 * own idioms, with culling in CanvasView's case — cameraFrameIR already accepts
 * cullRect for exactly that). Swap them onto cameraFrameIR when their owners
 * (Opus26 / the CanvasView regions) are free, to retire the last copies.
 */

import { foldState } from "../core/document.js";
import { deriveRenderTree, cameraRect } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { canSkipNode } from "../core/view.js";
import { sceneIR } from "../render_gpu/ports.js";
import { rect as rectCmd, parseColor } from "../render_gpu/ir.js";

/**
 * Query (memoized fold + evaluate). THE camera rect for (doc, slide, alpha):
 * folds the state, evaluates its equations (the camera's own x/y/w/h/background
 * may be equations), and reads cameraRect. The ONE home for the
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
  const state = evaluateState(foldState(doc, slideIndex, alpha), registry).state;
  return cameraRect(state, doc.meta);
}

/**
 * Pure function. THE display-list for one camera frame of an EVALUATED state:
 * the camera's background as the first world-space rect (covers exactly the
 * camera rect — so an arbitrary view, like the minimap's, still paints the
 * camera region even where the frame's clear is transparent), followed by the
 * derived scene's IR. Optionally CULLS nodes whose bounds miss `cullRect`
 * (world-space AABB) via the standard culling protocol; omit `cullRect` to
 * emit every node (the thumbnail/export/minimap consumers don't cull today).
 *
 * @param {object} state EVALUATED folded state (equations already numbers).
 * @param {object} meta doc.meta ({slideW, slideH}) — the camera-rect fallback.
 * @param {object} registry Plugin registry.
 * @param {{cullRect?: object}} [opts] Optional world-space cull rect.
 * @returns {Array} IR command list: [cameraBgRect, ...sceneIR(nodes)].
 *
 * @example // cameraFrameIR(evaluatedState, {slideW:1280,slideH:720}, registry) // [rectCmd(bg), ...scene]
 */
export function cameraFrameIR(state, meta, registry, { cullRect = null } = {}) {
  const rect = cameraRect(state, meta);
  let nodes = deriveRenderTree(state, registry);
  if (cullRect) nodes = nodes.filter((n) => !canSkipNode(n, cullRect));
  return [
    rectCmd({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: parseColor(rect.background) }),
    ...sceneIR(nodes),
  ];
}
