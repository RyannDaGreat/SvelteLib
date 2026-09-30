/**
 * Geometry and paint helpers shared by the "Architecture & light" preset
 * family (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { finiteGeometry, polylineNodes, rectNodes } from "../multipoint_shapes.js";

const BOX_EDGES = {
  top: [[0, 0], [1, 0]], right: [[1, 0], [1, 1]], bottom: [[1, 1], [0, 1]], left: [[0, 1], [0, 0]],
};

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
 * @example clockwise([[0,0],[0,1],[1,1],[1,0]])[1] // [1,1] (counter-clockwise on screen, so reversed)
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
