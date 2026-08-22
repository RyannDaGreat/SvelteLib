/**
 * Pure placement math for the Video V7 per-widget overlay (no DOM access).
 *
 * The overlay stacks one small <canvas> per video_v7 widget OVER the Skia scene
 * and CSS-transforms each to the widget's on-screen quad. These helpers derive
 * that transform from the widget's world transform + the camera viewport using
 * the SAME mapping the Skia scene uses (screen = world*zoom + pan), so the
 * overlay canvases stay pixel-aligned with the rendered scene under pan/zoom/
 * rotate. Kept DOM-free and pure so they are unit-testable in bare node.
 */

import { apply } from "../core/transform.js";
import { isPlayableVideoSrc } from "../core/video_sampling.js";

/** The widget type this overlay serves (mirrors plugins/demo/video_v7.js). */
export const VIDEO_V7_TYPE = "video_v7";

/**
 * Pure function. Maps a WORLD point to editor-screen CSS pixels via the camera
 * viewport — the exact mapping the Skia scene canvas uses, so anything placed
 * with it lands pixel-aligned over the rendered scene.
 *
 * @param {{zoom:number,panX:number,panY:number}} view camera viewport (CSS px)
 * @param {number} wx world x
 * @param {number} wy world y
 * @returns {{x:number,y:number}} CSS-pixel screen point
 * @example screenPoint({zoom: 1, panX: 0, panY: 0}, 10, 20) // {x: 10, y: 20}
 * @example screenPoint({zoom: 0.5, panX: 5, panY: 5}, 100, 0) // {x: 55, y: 5}
 */
export function screenPoint(view, wx, wy) {
  return { x: wx * view.zoom + view.panX, y: wy * view.zoom + view.panY };
}

/**
 * Pure function. The CSS transform matrix mapping a widget's LOCAL box
 * (0,0)–(w,h) onto its on-screen quad, given the widget's world transform and
 * the camera viewport. Returns {a,b,c,d,e,f} for `matrix(a,b,c,d,e,f)` used with
 * `transform-origin: 0 0`. Derived from three mapped corners — the screen images
 * of local (0,0), (w,0), (0,h):
 *   a = (p10.x - p00.x)/w   b = (p10.y - p00.y)/w   (screen image of local +x)
 *   c = (p01.x - p00.x)/h   d = (p01.y - p00.y)/h   (screen image of local +y)
 *   e = p00.x               f = p00.y               (screen image of origin)
 * This affine map carries rotation + uniform scale + camera zoom exactly (a
 * similarity transform has no skew, but the general 6-value form also covers
 * rotation). Degenerate w<=0 or h<=0 → identity (no box to place).
 *
 * @param {{x:number,y:number,rotation:number,scale:number}} world widget world transform
 * @param {number} w local box width
 * @param {number} h local box height
 * @param {{zoom:number,panX:number,panY:number}} view camera viewport
 * @returns {{a:number,b:number,c:number,d:number,e:number,f:number}}
 * @example overlayCssMatrix({x: 0, y: 0, rotation: 0, scale: 1}, 100, 50, {zoom: 1, panX: 0, panY: 0}) // {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}
 * @example overlayCssMatrix({x: 10, y: 20, rotation: 0, scale: 2}, 100, 50, {zoom: 1, panX: 0, panY: 0}) // {a: 2, b: 0, c: 0, d: 2, e: 10, f: 20}
 * @example overlayCssMatrix({x: 0, y: 0, rotation: 0, scale: 1}, 100, 50, {zoom: 0.5, panX: 5, panY: 5}) // {a: 0.5, b: 0, c: 0, d: 0.5, e: 5, f: 5}
 */
export function overlayCssMatrix(world, w, h, view) {
  if (!(w > 0) || !(h > 0)) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const o = apply(world, 0, 0);
  const ax = apply(world, w, 0); // local +x axis endpoint in world
  const ay = apply(world, 0, h); // local +y axis endpoint in world
  const p00 = screenPoint(view, o.x, o.y);
  const p10 = screenPoint(view, ax.x, ax.y);
  const p01 = screenPoint(view, ay.x, ay.y);
  return {
    a: (p10.x - p00.x) / w, b: (p10.y - p00.y) / w,
    c: (p01.x - p00.x) / h, d: (p01.y - p00.y) / h,
    e: p00.x, f: p00.y,
  };
}

// `isPlayableVideoSrc` USED TO BE DEFINED HERE and now lives in
// core/video_sampling.js, because video_v6's overlay needs the same test and a
// web/ module for one video experiment is the wrong place for another's to reach.
// The move is recorded rather than silent: this file is where anyone looking for
// it will look first.

/**
 * Pure function. Builds the per-widget overlay descriptors for every visible
 * video_v7 node with a REAL source — the data the overlay manager needs to
 * create / position / play each canvas, with NO DOM access. One descriptor per
 * node, keyed by the node's stable `itemId`. The CSS matrix + box size come from
 * the node's world + viewport; the source, look, and playback flags from state.
 * Poster-only nodes (blank/image src) are omitted so the overlay leaves them to
 * the Skia poster.
 *
 * @param {Array<{itemId:string,type:string,state:object,world:object}>} nodes derived render nodes (post-cull, z-ordered)
 * @param {{zoom:number,panX:number,panY:number}} view camera viewport
 * @returns {Array<{itemId:string,src:string,w:number,h:number,matrix:object,opacity:number,cornerRadius:number,autoplay:boolean,loop:boolean,muted:boolean}>}
 * @example videoV7Descriptors([{itemId: "v", type: "video_v7", state: {src: "a.mp4", w: 100, h: 50}, world: {x: 0, y: 0, rotation: 0, scale: 1}}], {zoom: 1, panX: 0, panY: 0}) // [{itemId: "v", src: "a.mp4", w: 100, h: 50, matrix: {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}, opacity: 1, cornerRadius: 0, autoplay: true, loop: true, muted: true}]
 * @example videoV7Descriptors([{itemId: "r", type: "rect", state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}}], {zoom: 1, panX: 0, panY: 0}) // [] (only video_v7 nodes with a real source)
 */
export function videoV7Descriptors(nodes, view) {
  const out = [];
  for (const n of nodes) {
    if (n.type !== VIDEO_V7_TYPE) continue;
    const s = n.state;
    if (!isPlayableVideoSrc(s.src)) continue;
    const w = s.w ?? 0, h = s.h ?? 0;
    out.push({
      itemId: n.itemId,
      src: s.src,
      w, h,
      matrix: overlayCssMatrix(n.world, w, h, view),
      opacity: s.opacity ?? 1,
      cornerRadius: s.cornerRadius ?? 0,
      autoplay: s.autoplay ?? true,
      loop: s.loop ?? true,
      muted: s.muted ?? true,
    });
  }
  return out;
}
