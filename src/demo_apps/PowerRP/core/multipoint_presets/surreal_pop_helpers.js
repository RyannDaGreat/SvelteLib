/**
 * Geometry and paint helpers shared by the "Surrealism" and "Pop & contemporary" preset
 * families (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { hermiteNodes, finiteGeometry, catmullRomNodes, ellipseNodes, polylineNodes } from "../multipoint_shapes.js";
import { ribbonOutline } from "./swirls.js";

const DERIVATIVE_STEP = 1e-5;

/**
 * Pure function. Graph y = f(x) over x in [0,1] as cubic nodes with numeric tangents, walked left to right
 * (colours ABOVE, rightColors BELOW). End handles are zeroed so the curve cannot leave the box.
 * @param {function} f - x -> y in the unit box.
 * @param {number} spans - Positive integer span count.
 * @returns {number[][]} [spans+1, 6] tuples, endpoints exactly on x = 0 and x = 1.
 * @example graphNodes(() => 0.5, 2).map((n) => n[0]) // [0,0.5,1]
 */
export function graphNodes(f, spans) {
  finiteGeometry([spans]);
  if (!Number.isInteger(spans) || spans < 1) throw new Error("graphNodes needs a positive integer span count");
  const nodes = hermiteNodes(Array.from({ length: spans + 1 }, (_, i) => {
    const x = i / spans, y = f(x);
    finiteGeometry([y]);
    return [x, y, 1, (f(Math.min(1, x + DERIVATIVE_STEP)) - f(Math.max(0, x - DERIVATIVE_STEP))) / (2 * DERIVATIVE_STEP)];
  }), 1 / spans);
  return openEnds(nodes);
}

/**
 * Pure function. Zeroes the unused end handles of an open curve.
 * @param {number[][]} nodes - [N,6] tuples.
 * @returns {number[][]} Copy with first in-handle and last out-handle zero.
 * @example openEnds([[0,0,-1,0,1,0],[1,0,-1,0,1,0]]) // [[0,0,0,0,1,0],[1,0,-1,0,0,0]]
 */
export function openEnds(nodes) {
  const last = nodes.length - 1;
  return nodes.map((n, i) => [n[0], n[1], i === 0 ? 0 : n[2], i === 0 ? 0 : n[3], i === last ? 0 : n[4], i === last ? 0 : n[5]]);
}

/**
 * Pure function. Horizontal line at y, left to right (colours above, rightColors below).
 * @param {number} y - Height in the unit box.
 * @returns {number[][]} [2,6].
 * @example hLine(0.5)[1] // [1,0.5,0,0,0,0]
 */
export function hLine(y) {
  finiteGeometry([y]);
  return [[0, y, 0, 0, 0, 0], [1, y, 0, 0, 0, 0]];
}

/**
 * Pure function. Closed smooth ring through points given in CLOCKWISE screen order (colours outside, rightColors inside).
 * @param {number[][]} points - [N,2], N >= 3.
 * @returns {number[][]} [N,6] closed Catmull-Rom tuples (close the feature).
 * @example ring([[0.5,0.2],[0.8,0.5],[0.5,0.8],[0.2,0.5]]).length // 4
 */
export function ring(points) {
  if (points.length < 3) throw new Error("ring needs at least three points");
  return catmullRomNodes(points, true);
}

/**
 * Pure function. Stack of two-sided parallel open curves; band i takes its colour from BOTH curves bounding it, so
 * bands render flat. Curves run left to right (bands above the first, below the last) or bottom to top (west/east).
 * Colours are strings or equal-length arrays (stops along the curve).
 * @param {number[][][]} curves - M node lists.
 * @param {(string|string[])[]} bands - M + 1 band colours.
 * @returns {object[]} M features.
 * @example bandStack([hLine(0.5)], ["#000000", "#ffffff"]).length // 1
 */
export function bandStack(curves, bands) {
  if (bands.length !== curves.length + 1) throw new Error("bandStack needs one more band colour than curves");
  const width = Math.max(...bands.map((b) => (Array.isArray(b) ? b.length : 1)));
  const fit = (b) => (Array.isArray(b) ? b : Array(width).fill(b));
  return curves.map((nodes, i) => boundary(nodes, fit(bands[i]), fit(bands[i + 1])));
}

/**
 * Pure function. Soft bump profile: smoothstep hill centred at c with half-width w and height h.
 * @param {number} x - Position.
 * @param {number} c - Centre.
 * @param {number} w - Positive half-width.
 * @param {number} h - Height (signed).
 * @returns {number} Offset, 0 outside [c-w, c+w], h at c.
 * @example bump(0.5, 0.5, 0.2, 0.1) // 0.1
 * @example bump(0.9, 0.5, 0.2, 0.1) // 0
 */
export function bump(x, c, w, h) {
  finiteGeometry([x, c, w, h]);
  if (w <= 0) throw new Error("bump needs a positive half-width");
  const t = Math.min(1, Math.abs(x - c) / w), s = 1 - t;
  return h * s * s * (3 - 2 * s);
}

/**
 * Pure function. Closed clockwise polygon: `outside` colour outside, `inside` inside.
 * @param {number[][]} points - [N,2] vertices in clockwise screen order.
 * @param {string} outside - Colour just outside the edge.
 * @param {string} inside - Colour just inside the edge.
 * @returns {object} Closed two-sided feature.
 * @example poly([[0,0],[1,0],[1,1]], "#000000", "#ffffff").closed // true
 */
export function poly(points, outside, inside) {
  return boundary(polylineNodes(points), [outside], [inside], true);
}

/**
 * Pure function. Closed two-sided ellipse: `outside` colour outside, `inside` inside.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Half-width.
 * @param {string} outside - Colour just outside.
 * @param {string} inside - Colour just inside.
 * @param {number} ry - Half-height (default rx).
 * @returns {object} Closed two-sided feature with 4 nodes.
 * @example disc(0.5, 0.5, 0.1, "#000000", "#ffffff").nodes.length // 4
 */
export function disc(cx, cy, rx, outside, inside, ry = rx) {
  return boundary(ellipseNodes(cx, cy, rx, ry), [outside], [inside], true);
}

/**
 * Pure function. Closed ring whose inside is a shaded ramp (stops around the ring clockwise from its first node,
 * which for ellipseNodes/blobNodes is the rightmost point), with one constant `outside` colour.
 * @param {number[][]} nodes - Closed [N,6] tuples.
 * @param {string} outside - Colour just outside the edge.
 * @param {string[]} insideRamp - Inside colours; the first is repeated at the end (seam rule).
 * @returns {object} Closed two-sided feature.
 * @example shaded(ellipseNodes(0.5,0.5,0.1), "#000000", ["#ffffff", "#888888"]).stops.length // 3
 */
export function shaded(nodes, outside, insideRamp) {
  const inner = closedRamp(insideRamp);
  return boundary(nodes, inner.map(() => outside), inner, true);
}

/**
 * Pure function. Star polygon (clockwise, first tip on top) as sharp nodes.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} outer - Tip radius.
 * @param {number} inner - Valley radius.
 * @param {number} points - Integer tip count >= 2.
 * @returns {number[][]} [2*points,6].
 * @example starNodesFor(0.5, 0.5, 0.2, 0.1, 5).length // 10
 */
export function starNodesFor(cx, cy, outer, inner, points) {
  finiteGeometry([cx, cy, outer, inner, points]);
  if (!Number.isInteger(points) || points < 2 || outer <= 0 || inner <= 0) throw new Error("starNodesFor needs positive radii and integer points >= 2");
  return polylineNodes(Array.from({ length: 2 * points }, (_, i) => {
    const a = -Math.PI / 2 + Math.PI * i / points, r = i % 2 ? inner : outer;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }));
}

/**
 * Pure function. Closed CLOCKWISE outline of a brush stroke along a centreline (so rightColor is INSIDE the stroke).
 * Wraps swirls.ribbonOutline, whose raw order runs counter-clockwise on screen for left-to-right paths.
 * @param {number[][]} points - [N,2] centreline anchors, N >= 2.
 * @param {number[]} widths - [N] half-widths.
 * @returns {number[][]} [2N+1,6] closed Catmull-Rom tuples.
 * @example strokeNodes([[0.1,0.5],[0.9,0.5]], [0.02,0.02]).length // 5
 */
export function strokeNodes(points, widths) {
  return catmullRomNodes(ribbonOutline(points, widths).reverse(), true);
}
