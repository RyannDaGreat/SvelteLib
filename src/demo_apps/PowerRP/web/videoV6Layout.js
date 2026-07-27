/**
 * Video V6 — pure screen-quad layout math (DOM-free).
 *
 * The V6 video overlay is a SEPARATE canvas stacked over the Skia scene; to draw
 * a widget's live frame it must place a textured quad at the widget's exact
 * on-screen rect. These helpers turn a derived render node + the current view
 * into device-pixel corners and then into the clip-space vertex data the GPU /
 * WebGL2 engine uploads. They mirror the view mapping in core/view.js
 * (device = (world*zoom + pan)*dpr) and the world_to_clip convention of the old
 * WebGPU compositor (clip.y is flipped because device Y is down, clip Y is up).
 *
 * Kept pure + separate from the engine (videoV6Gpu.js, which owns the GPU/GL
 * device) so the geometry is unit-testable in bare node with no browser.
 */

import * as T from "../core/transform.js";

/** Floats per vertex in the engine's interleaved buffer: clip x,y + uv u,v +
 *  per-vertex opacity. Exported so the engine's vertex layout stays in sync. */
export const FLOATS_PER_VERTEX = 5;

/** Two triangles (TL,TR,BR + TL,BR,BL) fanning the 4 quad corners. */
const TRIANGLE_CORNER_INDICES = [0, 1, 2, 0, 2, 3];

/** The 4 quad corners as fractions of (w,h): TL, TR, BR, BL — the SAME order as
 *  their UVs, so corner i samples texel QUAD_UV[i]. */
const CORNER_FRACTIONS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const QUAD_UV = [[0, 0], [1, 0], [1, 1], [0, 1]]; // TL,TR,BR,BL — uv (0,0) is the frame's top-left (external-texture & unflipped texImage2D convention)

/**
 * Pure function. Maps a world point to a device pixel under `view`, inverting
 * nothing — this IS the forward camera mapping device = (world*zoom + pan)*dpr
 * that core/view.js documents. Used to place the video quad's corners.
 *
 * @param {number} wx World X.
 * @param {number} wy World Y.
 * @param {{zoom:number, panX:number, panY:number, dpr:number}} view The camera.
 * @returns {{x:number, y:number}} Device-pixel coordinate.
 *
 * @example deviceOfWorld(10, 20, {zoom: 2, panX: 5, panY: 0, dpr: 1}) // {x: 25, y: 40}
 * @example deviceOfWorld(0, 0, {zoom: 1, panX: 0, panY: 0, dpr: 2}) // {x: 0, y: 0}
 */
export function deviceOfWorld(wx, wy, view) {
  return { x: (wx * view.zoom + view.panX) * view.dpr, y: (wy * view.zoom + view.panY) * view.dpr };
}

/**
 * Pure function. The four device-pixel corners (TL, TR, BR, BL) of a render
 * node's box under `view`, honouring its full similarity transform (rotation +
 * scale) via T.apply — so a rotated video draws as a rotated quad, no special
 * casing. `node.world` is the widget's world transform; `node.state.w/h` its
 * local size.
 *
 * @param {{state:{w:number,h:number}, world:object}} node A derived render node.
 * @param {{zoom:number, panX:number, panY:number, dpr:number}} view The camera.
 * @returns {Array<{x:number, y:number}>} Four device-pixel corners TL,TR,BR,BL.
 *
 * @example
 * // An axis-aligned 100×50 box at world (10,20), zoom 1, dpr 1:
 * videoV6DeviceQuad(
 *   {state: {w: 100, h: 50}, world: {x: 10, y: 20, rotation: 0, scale: 1}},
 *   {zoom: 1, panX: 0, panY: 0, dpr: 1},
 * ) // [{x:10,y:20},{x:110,y:20},{x:110,y:70},{x:10,y:70}]
 */
export function videoV6DeviceQuad(node, view) {
  const w = node.state.w ?? 0, h = node.state.h ?? 0;
  return CORNER_FRACTIONS.map(([fx, fy]) => {
    const wp = T.apply(node.world, fx * w, fy * h);
    return deviceOfWorld(wp.x, wp.y, view);
  });
}

/**
 * Pure function. Device pixel → WebGPU/WebGL clip space [-1,1]². X maps linearly;
 * Y is FLIPPED (device Y grows downward, clip Y grows upward) — the same flip the
 * old compositor's world_to_clip applied.
 *
 * @example deviceToClip(0, 0, 100, 100) // {x: -1, y: 1}
 * @example deviceToClip(100, 100, 100, 100) // {x: 1, y: -1}
 * @example deviceToClip(50, 50, 100, 100) // {x: 0, y: 0}
 */
export function deviceToClip(x, y, deviceW, deviceH) {
  return { x: (x / deviceW) * 2 - 1, y: 1 - (y / deviceH) * 2 };
}

/**
 * Pure function. Interleaved vertex data for ONE textured quad: 6 vertices
 * (two triangles), each [clipX, clipY, u, v, opacity]. Corners are device-pixel
 * TL,TR,BR,BL (as from videoV6DeviceQuad); the engine uploads this straight into
 * its vertex buffer.
 *
 * @param {Array<{x:number,y:number}>} cornersDevice Four device-px corners TL,TR,BR,BL.
 * @param {number} opacity Per-vertex opacity (0..1), premultiplied in the shader.
 * @param {number} deviceW Canvas backing width in device px.
 * @param {number} deviceH Canvas backing height in device px.
 * @returns {Float32Array} 6 × FLOATS_PER_VERTEX floats.
 *
 * @example
 * // Full-canvas quad at opacity 1 → first vertex is clip TL (-1,1), uv (0,0):
 * const d = quadVertexData([{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}], 1, 100, 100);
 * d.length // 30
 * Array.from(d.slice(0, 5)) // [-1, 1, 0, 0, 1]
 */
export function quadVertexData(cornersDevice, opacity, deviceW, deviceH) {
  const clip = cornersDevice.map((c) => deviceToClip(c.x, c.y, deviceW, deviceH));
  const data = new Float32Array(TRIANGLE_CORNER_INDICES.length * FLOATS_PER_VERTEX);
  TRIANGLE_CORNER_INDICES.forEach((idx, i) => {
    const p = clip[idx], uv = QUAD_UV[idx];
    data.set([p.x, p.y, uv[0], uv[1], opacity], i * FLOATS_PER_VERTEX);
  });
  return data;
}
