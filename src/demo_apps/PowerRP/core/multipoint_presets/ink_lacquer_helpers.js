/**
 * Geometry and paint helpers for the "Ink, lacquer & gold" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { hermiteNodes, finiteGeometry, catmullRomNodes, polylineNodes, mixHex } from "../multipoint_shapes.js";
import { boxEdge, atOffsets } from "./retro_eras.js";

const DERIVATIVE_STEP = 1e-5;

/**
 * Pure function. Zeroes the outer handles of an open curve so its ends stop bulging past the box.
 * @param {number[][]} nodes - [N,6] open-curve nodes.
 * @returns {number[][]} [N,6] copy with first in-handle and last out-handle zero.
 * @example openEnds([[0,0,-1,0,1,0],[1,0,-1,0,1,0]]) // [[0,0,0,0,1,0],[1,0,-1,0,0,0]]
 */
export function openEnds(nodes) {
  const copy = nodes.map((n) => [...n]);
  copy[0][2] = 0; copy[0][3] = 0;
  copy.at(-1)[4] = 0; copy.at(-1)[5] = 0;
  return copy;
}

/**
 * Pure function. The graph y = f(x) over x in [0,1] as cubic nodes, endpoints exactly on x = 0 and x = 1
 * with zeroed end handles. Walked left to right, so `colors` lie ABOVE and `rightColors` BELOW.
 * @param {function} f - x -> y.
 * @param {number} spans - Positive integer span count.
 * @returns {number[][]} [spans+1, 6] tuples.
 * @example graphNodes(() => 0.5, 2).map((n) => n[0]) // [0, 0.5, 1]
 */
export function graphNodes(f, spans) {
  if (!Number.isInteger(spans) || spans < 1) throw new Error("graphNodes needs a positive integer span count");
  const h = DERIVATIVE_STEP;
  return openEnds(hermiteNodes(Array.from({ length: spans + 1 }, (_, i) => {
    const x = i / spans, y = f(x);
    finiteGeometry([y]);
    return [x, y, 1, (f(x + h) - f(x - h)) / (2 * h)];
  }), 1 / spans));
}

/**
 * Pure function. A horizon line y = base + sum of sines, two-sided: `above` over the line, `below` under it.
 * @param {number} base - Mean height.
 * @param {number[][]} waves - [[frequency, amplitude, phase], ...].
 * @param {string[]} above - Palette above (left to right).
 * @param {string[]} below - Matching palette below.
 * @param {number} spans - Cubic spans.
 * @returns {object} Open two-sided feature.
 * @example ridge(0.5, [], ["#fff"], ["#000"], 2).twoSided // true
 */
export function ridge(base, waves, above, below, spans = 8) {
  return boundary(graphNodes((x) => base + waves.reduce((s, [k, a, p]) => s + a * Math.sin(k * x + p), 0), spans), above, below);
}

/**
 * Pure function. Four box edges pinning a field: top/bottom flat colours, left/right vertical ramps.
 * The ramps must start/end on the top/bottom colours so the corners agree.
 * @param {string} top - Colour along the top edge.
 * @param {string} bottom - Colour along the bottom edge.
 * @param {string[]} sides - Ramp top to bottom applied to both side edges (<= 4 stops).
 * @returns {object[]} Four open single-sided features.
 * @example frame("#000000", "#ffffff", ["#000000", "#ffffff"]).length // 4
 */
export function frame(top, bottom, sides, rightSides = sides) {
  return [boxEdge("top", [top]), boxEdge("left", sides), boxEdge("right", rightSides), boxEdge("bottom", [bottom])];
}

/**
 * Pure function. Piecewise-linear colour of a vertical field; `stops` are [y, colour] pairs with y increasing.
 * @param {Array<[number,string]>} stops - Sorted by y.
 * @param {number} y - Query height, clamped to the ends.
 * @returns {string} Lowercase #rrggbb.
 * @example fieldAt([[0,"#000000"],[1,"#ffffff"]], 0.5) // "#808080"
 */
export function fieldAt(stops, y) {
  if (y <= stops[0][0]) return stops[0][1];
  const j = stops.findIndex(([sy]) => sy >= y);
  if (j < 0) return stops.at(-1)[1];
  const [y0, c0] = stops[j - 1], [y1, c1] = stops[j];
  return mixHex(c0, c1, (y - y0) / (y1 - y0));
}

/**
 * Pure function. Four box edges whose side ramps sample a vertical field function (4 evenly spaced heights).
 * @param {Array<[number,string]>} field - [y, colour] stops.
 * @returns {object[]} Four open single-sided features.
 * @example fieldFrame([[0,"#000000"],[1,"#ffffff"]]).length // 4
 */
export function fieldFrame(field) {
  const side = [0, 1 / 3, 2 / 3, 1].map((y) => fieldAt(field, y));
  return frame(side[0], side[3], side);
}

/**
 * Pure function. Cumulative chord-length fraction of each anchor around a closed polygon (anchor 0 = 0).
 * @param {number[][]} pts - [N,2].
 * @returns {number[]} [N] fractions in [0,1).
 * @example closedFractions([[0,0],[1,0],[1,1],[0,1]]) // [0,0.25,0.5,0.75]
 */
export function closedFractions(pts) {
  const lens = pts.map((p, i) => Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]));
  const total = lens.reduce((a, b) => a + b, 0);
  let acc = 0;
  return pts.map((_, i) => { const f = acc / total; acc += lens[i]; return f; });
}

/**
 * Pure function. A soft ink mass: smooth closed silhouette (points CLOCKWISE on screen) whose rim runs from ink at
 * anchor 0 through `right` at anchor rightIdx to `base` at anchor baseIdx and back, while the outside colour follows the
 * surrounding vertical field at those anchors — so a base coloured like the field dissolves into the mist with no halo.
 * @param {number[][]} pts - [N<=13,2] clockwise anchors; pts[0] is the ink-dark crown.
 * @param {Array<[number,string]>} field - Vertical field the outside colour is sampled from.
 * @param {object} o - {rightIdx, baseIdx, top, right, base} inside colours.
 * @returns {object} Closed two-sided feature with 4 stops.
 * @example inkMass([[0.5,0.1],[0.7,0.5],[0.5,0.8],[0.3,0.5]], [[0,"#ffffff"],[1,"#ffffff"]], {rightIdx:1,baseIdx:2,top:"#000000",right:"#333333",base:"#ffffff"}).closed // true
 */
export function inkMass(pts, field, { rightIdx, baseIdx, top, right, base, sharp = false }) {
  const out = (i) => fieldAt(field, pts[i][1]);
  const fr = closedFractions(pts);
  const feature = boundary(sharp ? polylineNodes(pts) : catmullRomNodes(pts, true), [out(0), out(rightIdx), out(baseIdx), out(0)], [top, right, base, top], true);
  return atOffsets(feature, [0, fr[rightIdx], fr[baseIdx], 1]);
}

/**
 * Pure function. Sharp-cornered tapered ribbon (a crack, a bolt, a dry-brush stroke) as a closed polygon:
 * out along the walker's left edge, back along the right, so a two-sided closed feature's rightColors are its fill.
 * A zero width at an end gives a pointed tip.
 * @param {number[][]} points - [N,2] centreline, N >= 2, consecutive points distinct.
 * @param {number[]} widths - [N] full widths >= 0.
 * @returns {number[][]} [<=2N,6] zero-handle nodes; close the feature.
 * @example zigzagRibbon([[0,0],[1,0]], [0,0.1]).length // 4 (the zero-width tip is two coincident nodes)
 */
export function zigzagRibbon(points, widths) {
  if (points.length < 2 || widths.length !== points.length) throw new Error("zigzagRibbon needs matching points and widths");
  finiteGeometry([...points.flat(), ...widths]);
  const seg = (i) => { const [x0, y0] = points[i], [x1, y1] = points[i + 1], l = Math.hypot(x1 - x0, y1 - y0);
    if (!l) throw new Error("zigzagRibbon points must be distinct"); return [(y1 - y0) / l, -(x1 - x0) / l]; };
  const normals = points.map((_, i) => {
    const a = seg(Math.max(0, i - 1)), b = seg(Math.min(points.length - 2, i));
    const nx = a[0] + b[0], ny = a[1] + b[1], l = Math.hypot(nx, ny) || 1;
    return [nx / l, ny / l, Math.max(0.5, (a[0] * b[0] + a[1] * b[1] + 1) / 2)];
  });
  const side = (sign) => points.map(([x, y], i) => [x + sign * normals[i][0] * widths[i] / 2 / normals[i][2] ** 0.5, y + sign * normals[i][1] * widths[i] / 2 / normals[i][2] ** 0.5]);
  const left = side(1), right = side(-1).reverse();
  const outline = [...left, ...right].filter(([x, y], i, all) => i === 0 || Math.hypot(x - all[i - 1][0], y - all[i - 1][1]) > 1e-9);
  return polylineNodes(outline);
}
