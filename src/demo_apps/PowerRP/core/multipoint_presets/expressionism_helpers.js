/**
 * Geometry and paint helpers shared by the "Art Nouveau & Symbolism" and "Fauvism & Expressionism" preset
 * families (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { polylineNodes, rectNodes, ellipseNodes, finiteGeometry, catmullRomNodes } from "../multipoint_shapes.js";

/**
 * Pure function. Twice the signed area of a polygon (positive = clockwise on screen, y down).
 * @param {number[][]} pts - [N,2] (x,y) vertices.
 * @returns {number} Shoelace sum.
 * @example shoelace([[0,0],[1,0],[1,1],[0,1]]) // 2 (clockwise on screen)
 */
export function shoelace(pts) {
  finiteGeometry(pts.flat());
  return pts.reduce((s, [x, y], i) => { const [u, v] = pts[(i + 1) % pts.length]; return s + x * v - u * y; }, 0);
}

/**
 * Pure function. Closed flat-colour polygon (outside line colour, inside fill), vertices
 * re-ordered clockwise so rightColor is always INSIDE.
 * @param {number[][]} pts - [N,2] (x,y) vertices in any winding.
 * @param {string} outside - Colour just outside the rim.
 * @param {string} inside - Colour filling the polygon.
 * @returns {object} Closed two-sided feature.
 * @example poly([[0,0],[0,1],[1,0]], "#000000", "#ffffff").closed // true
 */
export function poly(pts, outside, inside) {
  const cw = shoelace(pts) > 0 ? pts : [...pts].reverse();
  return boundary(polylineNodes(cw), [outside], [inside], true);
}

/**
 * Pure function. Rectangle panel, outline colour outside, fill inside.
 * @param {number[]} box - [x0,y0,x1,y1].
 * @param {string} outside - Line colour.
 * @param {string} inside - Fill colour.
 * @returns {object} Closed two-sided feature.
 * @example panel([0,0,0.5,1], "#000000", "#ffffff").nodes.length // 4
 */
export function panel([x0, y0, x1, y1], outside, inside) {
  return boundary(rectNodes(x0, y0, x1, y1), [outside], [inside], true);
}

/**
 * Pure function. Circle/ellipse disc, outside colour and inside colour.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Horizontal radius.
 * @param {number|null} ry - Vertical radius (null = rx).
 * @param {string} outside - Colour outside the rim.
 * @param {string} inside - Colour inside.
 * @returns {object} Closed two-sided feature.
 * @example disc(0.5,0.5,0.1,null,"#000000","#ffffff").nodes.length // 4
 */
export function disc(cx, cy, rx, ry, outside, inside) {
  return boundary(ellipseNodes(cx, cy, rx, ry ?? rx), [outside], [inside], true);
}

const EDGE_ENDS = { top: [[0, 0], [1, 0]], right: [[1, 0], [1, 1]], bottom: [[1, 1], [0, 1]], left: [[0, 1], [0, 0]] };

/**
 * Pure function. Single-sided colour ramp lying exactly on one unit-box edge
 * (top runs left to right, right top to bottom, bottom right to left, left bottom to top).
 * @param {"top"|"right"|"bottom"|"left"} side - Box edge.
 * @param {string[]} colors - Ramp along the walk.
 * @returns {object} Open two-node feature.
 * @example edge("top", ["#ff0000"]).nodes.map((n) => n.slice(0, 2)) // [[0,0],[1,0]]
 */
export function edge(side, colors) {
  if (!EDGE_ENDS[side]) throw new Error(`Unknown box edge: ${side}`);
  return boundary(polylineNodes(EDGE_ENDS[side]), colors);
}

/**
 * Pure function. All four box edges from one colour per corner-ish side (top,right,bottom,left).
 * @param {string[]} sides - [top,right,bottom,left] colours (one each).
 * @returns {object[]} Four edge features.
 * @example frame(["#f00","#0f0","#00f","#ff0"]).length // 4
 */
export function frame([top, right, bottom, left]) {
  return [edge("top", [top]), edge("right", [right]), edge("bottom", [bottom]), edge("left", [left])];
}

/**
 * Pure function. Closed smooth blob through points (Catmull-Rom), winding forced clockwise.
 * @param {number[][]} pts - [N,2] anchors.
 * @param {string} outside - Colour outside.
 * @param {string} inside - Colour inside.
 * @returns {object} Closed two-sided feature.
 * @example blobThrough([[0.5,0.2],[0.8,0.5],[0.5,0.8],[0.2,0.5]], "#000000", "#ffffff").closed // true
 */
export function blobThrough(pts, outside, inside) {
  const cw = shoelace(pts) > 0 ? pts : [...pts].reverse();
  return boundary(catmullRomNodes(cw, true), [outside], [inside], true);
}

/**
 * Pure function. Closed ribbon (thin stroke with flat colour) around a centre line, tapering
 * linearly from width w0 to w1; sides are smooth Catmull-Rom curves, ends are sharp points
 * when a width is 0. Winding forced clockwise so rightColor is INSIDE.
 * @param {number[][]} pts - [N,2] centre line anchors, N >= 2.
 * @param {number|number[]} w0 - Full width at the first anchor (>= 0), or an array of N widths (then w1 is ignored).
 * @param {number} w1 - Full width at the last anchor (>= 0).
 * @param {string} outside - Colour outside the ribbon.
 * @param {string} inside - Colour inside.
 * @returns {object} Closed two-sided feature with 2N nodes.
 * @example ribbonThrough([[0.1,0.5],[0.5,0.4],[0.9,0.5]], 0.04, 0.04, "#fff", "#000").nodes.length // 6
 */
export function ribbonThrough(pts, w0, w1, outside, inside) {
  finiteGeometry([...[w0].flat(), w1 ?? 0, ...pts.flat()]);
  const n = pts.length;
  const side = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const half = (Array.isArray(w0) ? w0[i] : w0 + (w1 - w0) * i / (n - 1)) / 2;
    return { nx: -dy / len * half, ny: dx / len * half, p };
  });
  const left = side.map(({ p, nx, ny }) => [p[0] + nx, p[1] + ny]);
  const right = side.map(({ p, nx, ny }) => [p[0] - nx, p[1] - ny]).reverse();
  return blobThrough([...left, ...right], outside, inside);
}
