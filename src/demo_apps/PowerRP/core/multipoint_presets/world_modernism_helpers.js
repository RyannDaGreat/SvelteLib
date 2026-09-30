/**
 * Geometry and paint helpers for the "World modernism" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { catmullRomNodes, finiteGeometry, polylineNodes, rectNodes } from "../multipoint_shapes.js";

const BOX_EDGES = {
  top: [[0, 0], [1, 0]], right: [[1, 0], [1, 1]], bottom: [[1, 1], [0, 1]], left: [[0, 1], [0, 0]],
};

/**
 * Pure function. Zeroes the two unused end handles of an open curve (first in-handle,
 * last out-handle), which would otherwise reach outside the box.
 * @param {number[][]} nodes - [N,6] tuples.
 * @returns {number[][]} Copy with unused end handles zeroed.
 * @example openEnds([[0,0,-1,0,1,0],[1,0,-1,0,1,0]]) // [[0,0,0,0,1,0],[1,0,-1,0,0,0]]
 */
export function openEnds(nodes) {
  const last = nodes.length - 1;
  return nodes.map((n, i) => [n[0], n[1], i === 0 ? 0 : n[2], i === 0 ? 0 : n[3], n[4] * (i === last ? 0 : 1), n[5] * (i === last ? 0 : 1)]);
}

/**
 * Pure function. Smooth open Catmull-Rom curve through points with quiet ends.
 * @param {number[][]} points - [N,2] (x,y) anchors, N >= 2.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples.
 * @example smooth([[0,0.5],[0.5,0.4],[1,0.5]]).length // 3
 */
export function smooth(points) {
  return openEnds(catmullRomNodes(points));
}

/**
 * Pure function. Closed smooth Catmull-Rom loop through points (close the feature too).
 * @param {number[][]} points - [N,2] (x,y) anchors, N >= 3, listed CLOCKWISE on screen.
 * @returns {number[][]} [N,6] tuples.
 * @example loop([[0.5,0.1],[0.9,0.5],[0.5,0.9],[0.1,0.5]]).length // 4
 */
export function loop(points) {
  return catmullRomNodes(points, true);
}

/**
 * Pure function. Twice the signed area of a polygon (screen coordinates, y down);
 * positive means the vertices run CLOCKWISE on screen, so rightColor lands inside.
 * @param {number[][]} points - [N,2] vertices.
 * @returns {number} Shoelace sum.
 * @example signedArea([[0,0],[1,0],[1,1],[0,1]]) // 2
 * @example signedArea([[0,0],[0,1],[1,1],[1,0]]) // -2
 */
export function signedArea(points) {
  finiteGeometry(points.flat());
  return points.reduce((sum, [x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    return sum + x * ny - nx * y;
  }, 0);
}

/**
 * Pure function. The vertex list, reversed if needed so it runs clockwise on screen.
 * @param {number[][]} points - [N,2] vertices.
 * @returns {number[][]} Clockwise copy.
 * @example clockwise([[0,0],[0,1],[1,1],[1,0]])[1] // [1,1] (reversed: the input ran anticlockwise on screen)
 */
export function clockwise(points) {
  return signedArea(points) >= 0 ? points.map((p) => [...p]) : points.map((p) => [...p]).reverse();
}

/**
 * Pure function. A sharp-cornered flat facet: inside colour on the right (clockwise),
 * outside colour on the left, both constant.
 * @param {number[][]} points - [N,2] vertices, any winding.
 * @param {string} inside - Colour inside the facet.
 * @param {string} outside - Colour just outside (the joint / trim colour).
 * @returns {object} Closed two-sided feature.
 * @example facet([[0,0],[1,0],[0,1]], "#ff0000", "#000000").closed // true
 */
export function facet(points, inside, outside) {
  return boundary(polylineNodes(clockwise(points)), [outside], [inside], true);
}

/**
 * Pure function. A flat-coloured facet with a colour RAMP inside (constant outside).
 * Closed ramps repeat their first colour so the seam is invisible.
 * @param {number[][]} nodes - [N,6] closed nodes, clockwise.
 * @param {string[]} insideRamp - Open ramp of interior colours (<= 3).
 * @param {string} outside - Outside colour.
 * @returns {object} Closed two-sided feature.
 * @example shadedCell(loop([[0.5,0.1],[0.9,0.5],[0.5,0.9],[0.1,0.5]]), ["#fff","#000"], "#888").stops.length // 3
 */
export function shadedCell(nodes, insideRamp, outside) {
  const inside = closedRamp(insideRamp);
  return boundary(nodes, inside.map(() => outside), inside, true);
}

/**
 * Pure function. One box edge as a single-sided constant ramp, walked so the interior is on its right.
 * @param {"top"|"right"|"bottom"|"left"} side - Box edge.
 * @param {string[]} colors - Ramp along the walk (top: left to right, bottom: right to left).
 * @returns {object} Open two-node feature lying exactly on the edge.
 * @example boxEdge("bottom", ["#000000"]).nodes.map((n) => n.slice(0, 2)) // [[1,1],[0,1]]
 */
export function boxEdge(side, colors) {
  if (!BOX_EDGES[side]) throw new Error(`Unknown box edge: ${side}`);
  return boundary(polylineNodes(BOX_EDGES[side]), colors);
}

/**
 * Pure function. Single-sided ramp around the whole unit-box border (clockwise from the
 * top-left corner): a crease-free backdrop the interior diffuses toward.
 * @param {string[]} colors - Open ramp; the seam colour is appended when longer than one.
 * @returns {object} Closed four-node feature.
 * @example boxFrame(["#101010"]).stops.length // 1
 */
export function boxFrame(colors) {
  return boundary(rectNodes(0, 0, 1, 1), colors.length > 1 ? closedRamp(colors) : colors, null, true);
}

/**
 * Pure function. Axis-aligned flat facet.
 * @param {number} x0 - Left.
 * @param {number} y0 - Top.
 * @param {number} x1 - Right.
 * @param {number} y1 - Bottom.
 * @param {string} inside - Interior colour.
 * @param {string} outside - Colour just outside.
 * @returns {object} Closed two-sided feature.
 * @example box(0.1, 0.1, 0.4, 0.3, "#f00", "#000").nodes.length // 4
 */
export function box(x0, y0, x1, y1, inside, outside) {
  return boundary(rectNodes(x0, y0, x1, y1), [outside], [inside], true);
}

/**
 * Pure function. A straight two-node line between two points.
 * @param {number[]} from - [x, y] start.
 * @param {number[]} to - [x, y] end.
 * @returns {number[][]} [2,6] zero-handle nodes.
 * @example seg([0, 1], [0.5, 0]).length // 2
 */
export function seg(from, to) {
  return polylineNodes([from, to]);
}

/**
 * Pure function. A stack of two-sided curves whose bands take their colour from BOTH bounding curves, so each
 * band renders crisp. Curves run so that band i lies on the LEFT of curve i and band i+1 on its right (left
 * to right: above then below; bottom to top: west then east). A band is a colour, an array of stops (a drift
 * along the curves), or {a, b}: colour(s) `a` on its leading edge fading to `b` on its trailing edge.
 * @param {number[][][]} curves - M node lists.
 * @param {(string|string[]|{a:(string|string[]),b:(string|string[])})[]} bands - M + 1 bands.
 * @returns {object[]} M features.
 * @example bandStack([[[0,0.5,0,0,0,0],[1,0.5,0,0,0,0]]], ["#000000", {a: "#ffffff", b: "#888888"}]).length // 1
 */
export function bandStack(curves, bands) {
  if (bands.length !== curves.length + 1) throw new Error("bandStack needs one more band than curves");
  const edge = (band, side) => (band && band.a !== undefined ? band[side] : band);
  const width = Math.max(...bands.flatMap((b) => [edge(b, "a"), edge(b, "b")]).map((c) => (Array.isArray(c) ? c.length : 1)));
  const fit = (c) => (Array.isArray(c) ? c : Array(width).fill(c));
  return curves.map((nodes, i) => boundary(openEnds(nodes), fit(edge(bands[i], "b")), fit(edge(bands[i + 1], "a"))));
}

/**
 * Pure function. A closed smooth loop through points where the listed anchors are made SHARP
 * corners (handles zeroed): flame tips, blade points, petal ends.
 * @param {number[][]} points - [N,2] anchors, clockwise on screen.
 * @param {number[]} corners - Indices of anchors to sharpen.
 * @returns {number[][]} [N,6] closed nodes.
 * @example cornered([[0.5,0],[1,1],[0,1]], [0])[0] // [0.5,0,0,0,0,0]
 */
export function cornered(points, corners) {
  const nodes = loop(points);
  return nodes.map((n, i) => (corners.includes(i) ? [n[0], n[1], 0, 0, 0, 0] : n));
}

/**
 * Pure function. Closed outline of a tapered brush stroke around an open spine, any direction:
 * the two sides are offset by per-point half widths and the outline is forced clockwise so its
 * interior is the stroke.
 * @param {number[][]} spine - [N,2] centre-line points, N >= 2.
 * @param {number[]} halfWidths - [N] half thickness at each spine point (small at the tips).
 * @returns {number[][]} [2N,6] closed smooth nodes.
 * @example brushStroke([[0.1,0.5],[0.5,0.5],[0.9,0.5]], [0.005,0.03,0.005]).length // 6
 */
export function brushStroke(spine, halfWidths) {
  finiteGeometry([...halfWidths, ...spine.flat()]);
  if (spine.length !== halfWidths.length) throw new Error("brushStroke needs one half width per spine point");
  const side = (sign) => spine.map(([x, y], i) => {
    const [ax, ay] = spine[Math.max(0, i - 1)], [bx, by] = spine[Math.min(spine.length - 1, i + 1)];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    return [x - sign * (by - ay) / len * halfWidths[i], y + sign * (bx - ax) / len * halfWidths[i]];
  });
  return loop(clockwise([...side(1), ...side(-1).reverse()]));
}
