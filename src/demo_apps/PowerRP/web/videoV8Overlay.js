/**
 * V8 video overlay — the manager that ties the pieces together, plus the pure
 * world→clip quad math it uses.
 *
 * ARCHITECTURE (the V8 approach): ONE `<canvas>` stacked directly over the Skia
 * scene canvas, transparent everywhere except where a video plays. Each paint,
 * for every on-screen `video_v8` widget, this computes the widget's four screen
 * corners (through the SAME view math the scene uses, so it stays pinned under
 * pan/zoom/rotate) and hands the backend a textured quad. The backend
 * (videoV8_backend.js → WebGPU zero-copy or WebGL2 upload) draws the current
 * frame there; uncovered pixels are transparent so the Skia scene shows through.
 *
 * WHY AN OVERLAY (not a Skia draw): the scene renderer is Skia/CanvasKit and the
 * "perfect" path is a GPU-native video texture (WebGPU external texture / WebGL2
 * texImage2D from the element). A separate stacked canvas lets that GPU path run
 * untouched over the Skia scene on plain HTTP. The trade-off — a KNOWN BOUND — is
 * z-order: the overlay composites ABOVE the whole Skia scene, so a widget stacked
 * on TOP of a video in document z-order still draws visually beneath the live
 * frame. The plugin emits a dark POSTER rect into the scene at the correct z (so
 * the widget is visible/selectable, and the CLI/PDF path shows a deterministic
 * poster); the live frame rides on top.
 *
 * The pure functions (worldToClip, clipCornersForBox, videoV8SourcesOf) are
 * DOM-free and doctested; the manager (createVideoV8Overlay) is a Command that
 * owns the canvas + backend + element registry.
 */

import * as T from "../core/transform.js";
import { selectVideoV8Backend } from "../render_gpu/gpu/videoV8_backend.js";
import { ensureVideoV8, getVideoV8, videoV8FrameMarker } from "./videoV8Registry.js";

/** The widget type this overlay draws (matches plugins/demo/video_v8.js). */
export const VIDEO_V8_TYPE = "video_v8";
/** Local-box corners in draw order (top-left, top-right, bottom-right,
 * bottom-left), as [unitX, unitY] fractions of the box — UVs are the same
 * fractions (widget-top-left → video-top-left → upright). */
const UNIT_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

/**
 * Pure function. Maps a WORLD point to WebGPU/WebGL clip space (NDC) for a device
 * canvas of `canvasW × canvasH` px under `view` {zoom, panX, panY, dpr}. This is
 * the scene's own mapping (device = (world*zoom + pan)*dpr) followed by the
 * device→NDC normalize, with Y flipped so device-top (dy=0) is NDC +1 (visual
 * top). Using the identical mapping is what keeps the overlay pinned to the scene
 * under any pan/zoom.
 *
 * @param {number} wx world x
 * @param {number} wy world y
 * @param {{zoom:number,panX:number,panY:number,dpr:number}} view
 * @param {number} canvasW device px width
 * @param {number} canvasH device px height
 * @returns {{x:number,y:number}} clip-space point (x,y in [-1,1])
 * @example worldToClip(0, 0, {zoom:1,panX:0,panY:0,dpr:1}, 100, 100) // {x: -1, y: 1}
 * @example worldToClip(100, 100, {zoom:1,panX:0,panY:0,dpr:1}, 100, 100) // {x: 1, y: -1}
 * @example worldToClip(50, 50, {zoom:1,panX:0,panY:0,dpr:1}, 100, 100) // {x: 0, y: 0}
 */
export function worldToClip(wx, wy, view, canvasW, canvasH) {
  const dx = (wx * view.zoom + view.panX) * view.dpr;
  const dy = (wy * view.zoom + view.panY) * view.dpr;
  return { x: (dx / canvasW) * 2 - 1, y: 1 - (dy / canvasH) * 2 };
}

/**
 * Pure function. The four clip-space corners (with UVs) of a widget's box, given
 * its `world` similarity transform, local size `w×h`, and the view. Each local
 * corner is mapped local→world (T.apply, which applies rotation+scale+translation)
 * then world→clip (worldToClip), so a rotated/scaled/panned widget's quad tracks
 * the scene exactly. UV = the same unit fraction as the corner, so the video draws
 * upright (top-left texel under the widget's top-left).
 *
 * @param {{x:number,y:number,rotation:number,scale:number}} world the item transform
 * @param {number} w local width
 * @param {number} h local height
 * @param {{zoom:number,panX:number,panY:number,dpr:number}} view
 * @param {number} canvasW device px width
 * @param {number} canvasH device px height
 * @returns {{x:number,y:number,u:number,v:number}[]} 4 corners (TL, TR, BR, BL)
 * @example clipCornersForBox({x:0,y:0,rotation:0,scale:1}, 100, 100, {zoom:1,panX:0,panY:0,dpr:1}, 100, 100)[0] // {x: -1, y: 1, u: 0, v: 0}
 * @example clipCornersForBox({x:0,y:0,rotation:0,scale:1}, 100, 100, {zoom:1,panX:0,panY:0,dpr:1}, 100, 100)[2] // {x: 1, y: -1, u: 1, v: 1}
 */
export function clipCornersForBox(world, w, h, view, canvasW, canvasH) {
  return UNIT_CORNERS.map(([ux, uy]) => {
    const wp = T.apply(world, ux * w, uy * h);
    const clip = worldToClip(wp.x, wp.y, view, canvasW, canvasH);
    return { x: clip.x, y: clip.y, u: ux, v: uy };
  });
}

/**
 * Pure function. The distinct non-empty `src` strings among `nodes` whose widget
 * type is the V8 video type — exactly the sources the overlay tracks/plays.
 * Mirrors CanvasView.videoSourcesOf but for the fresh V8 type, so the caller can
 * feed setActiveVideoV8Refs the post-cull visible set (off-view = paused).
 *
 * @param {Array<{type:string, state:{src?:string}}>} nodes derived render nodes
 * @returns {Set<string>} distinct source strings
 * @example videoV8SourcesOf([{type:"video_v8", state:{src:"a.mp4"}}, {type:"rect", state:{}}]) // Set {"a.mp4"}
 * @example videoV8SourcesOf([{type:"video_v8", state:{src:""}}]) // Set {}
 */
export function videoV8SourcesOf(nodes) {
  const set = new Set();
  for (const n of nodes) if (n.type === VIDEO_V8_TYPE && typeof n.state.src === "string" && n.state.src.length > 0) set.add(n.state.src);
  return set;
}

/**
 * Command (async; creates a GPU backend). Builds the overlay manager on `canvas`.
 * Selects the WebGPU or WebGL2 backend (videoV8_backend.js). Returns
 * {kind, paint, dispose}.
 *
 * `paint(nodes, view, canvasW, canvasH)` renders one overlay frame: sizes the
 * canvas to the scene's device px, ensures a `<video>` element exists for each
 * on-screen V8 video (idempotent), and draws a textured quad for every one that
 * has a decoded current frame. A src with no frame yet draws nothing (the scene's
 * poster rect shows until it decodes). Always clears first, so a video that left
 * view vanishes. Does NOT gate playback — the caller owns setActiveVideoV8Refs
 * with the post-cull set (single source of truth for the off-view pause).
 *
 * @param {HTMLCanvasElement} canvas the overlay canvas
 * @param {{preferWebGL2?: boolean}} [opts] forwarded to the selector (tests / A-B)
 * @returns {Promise<{kind: string, paint: Function, dispose: () => void}>}
 */
export async function createVideoV8Overlay(canvas, opts = {}) {
  const backend = await selectVideoV8Backend(canvas, opts);

  function paint(nodes, view, canvasW, canvasH) {
    if (canvas.width !== canvasW) canvas.width = canvasW;
    if (canvas.height !== canvasH) canvas.height = canvasH;
    const quads = [];
    for (const n of nodes) {
      if (n.type !== VIDEO_V8_TYPE) continue;
      const src = n.state.src;
      if (typeof src !== "string" || src.length === 0) continue;
      // Idempotent: create the element on first sight, honoring the widget's flags.
      ensureVideoV8(src, { autoplay: n.state.autoplay ?? true, loop: n.state.loop ?? true, muted: n.state.muted ?? true });
      const el = getVideoV8(src);
      if (!el) continue; // no decoded frame yet → poster shows through
      const corners = clipCornersForBox(n.world, n.state.w ?? 0, n.state.h ?? 0, view, canvasW, canvasH);
      quads.push({ src, el, corners, opacity: n.state.opacity ?? 1, frameMarker: videoV8FrameMarker(src) });
    }
    backend.draw(quads);
  }

  return { kind: backend.kind, paint, dispose: () => backend.dispose() };
}
