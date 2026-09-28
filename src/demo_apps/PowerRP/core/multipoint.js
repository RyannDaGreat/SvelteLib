/** Multipoint paint geometry. Coordinates are fractions of the paint's local box;
 * nodes are [x, y, inX, inY, outX, outY], with handle OFFSETS from the anchor.
 * Geometry and arc-length colour stops are independent. No renderer or DOM state. */
import { evalCubic, partialCubic } from "./morph_geometry.js";
import { elementActive } from "./lists.js";

export const MULTIPOINT_TYPE = "multipointGradient";
export const MULTIPOINT_NODE_NAMES = ["x", "y", "inX", "inY", "outX", "outY"];
/** Geometric error budget in unit-box coordinates (under half a 1024px texel). */
export const MULTIPOINT_CURVE_TOLERANCE = 1 / 4096;
const MAX_SUBDIVISION_DEPTH = 16; // bounds work for singular/cusped cubics

/**
 * Pure function. A new editable colour source in the middle of the paint box.
 * @param {"point"|"line"|"curve"} kind - Initial geometry, not a stored discriminator.
 * @param {string} color - Main colour, including optional hex alpha.
 * @returns {object} Feature with numeric [N,6] nodes (e.g. [2,6] for a curve).
 * @example multipointFeature("line", "#f00").nodes // [[0.25,0.5,0,0,0,0],[0.75,0.5,0,0,0,0]]
 */
export function multipointFeature(kind = "point", color = "#7aa2f7") {
  if (!["point", "line", "curve"].includes(kind)) throw new Error(`Unknown Multipoint source: ${kind}`);
  const nodes = kind === "point" ? [[0.5, 0.5, 0, 0, 0, 0]]
    : kind === "line" ? [[0.25, 0.5, 0, 0, 0, 0], [0.75, 0.5, 0, 0, 0, 0]]
    : [[0.2, 0.65, 0, 0, 0.2, -0.5], [0.8, 0.35, -0.2, 0.5, 0, 0]];
  return { nodes, stops: [{ offset: 0, color, rightColor: color }], weight: 1, twoSided: false, closed: false };
}

/**
 * Pure function. A visible three-point starting fill, seeded from the previous solid.
 * @param {string} seed - Existing solid colour.
 * @returns {{features: object[]}} Editable state; no generated pixels.
 * @example freshMultipoint("#f00").features[0].stops[0].color // "#f00"
 */
export function freshMultipoint(seed) {
  const positions = [[0.2, 0.25], [0.8, 0.35], [0.45, 0.85]];
  return { features: [seed, "#ffd166", "#b56bff"].map((color, i) => ({
    ...multipointFeature("point", color), nodes: [[...positions[i], 0, 0, 0, 0]],
  })) };
}

/**
 * Pure function. Consecutive nodes → one cubic's [4,2] (x,y) control points.
 * @param {number[]} a - Start [x,y,inX,inY,outX,outY].
 * @param {number[]} b - End, same shape.
 * @returns {number[][]} [[anchor], [outgoing], [incoming], [anchor]].
 * @example nodeCubic([0,0,0,0,0.25,0], [1,1,-0.25,0,0,0]) // [[0,0],[0.25,0],[0.75,1],[1,1]]
 */
export function nodeCubic(a, b) {
  return [[a[0], a[1]], [a[0] + a[4], a[1] + a[5]], [b[0] + b[2], b[1] + b[3]], [b[0], b[1]]];
}

/**
 * Pure function. Adaptive polyline of an open/closed cubic chain, in paint-box units.
 * @param {number[][]} nodes - [N,6] anchor/handle tuples; e.g. [3,6].
 * @param {boolean} closed - Connect last anchor to first.
 * @param {number} tolerance - Maximum control-point deviation from a chord.
 * @returns {number[][]} [T,2] (x,y) samples, including the closing point if closed.
 * @example featurePolyline([[0,0,0,0,0,0],[1,0,0,0,0,0]]) // [[0,0],[1,0]]
 */
export function featurePolyline(nodes, closed = false, tolerance = MULTIPOINT_CURVE_TOLERANCE) {
  if (!nodes.length) return [];
  const out = [[nodes[0][0], nodes[0][1]]];
  /** Command. Appends a cubic's adaptive samples to this call's private output. */
  function append(c, depth) {
    const [a, b, d, e] = c;
    const chord = Math.hypot(e[0] - a[0], e[1] - a[1]);
    const polygon = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - b[0], d[1] - b[1]) + Math.hypot(e[0] - d[0], e[1] - d[1]);
    // Control-polygon excess also detects collinear loops/backtracking, unlike
    // distance-to-infinite-line alone. No angle/normal is fabricated for a dot.
    if (depth >= MAX_SUBDIVISION_DEPTH || polygon - chord <= tolerance) out.push(e);
    else {
      append(partialCubic(c, 0, 0.5), depth + 1);
      append(partialCubic(c, 0.5, 1), depth + 1);
    }
  }
  const segments = nodes.length - 1 + (closed && nodes.length > 1 ? 1 : 0);
  for (let i = 0; i < segments; i++) append(nodeCubic(nodes[i], nodes[(i + 1) % nodes.length]), 0);
  return out;
}

/**
 * Pure function. Position at normalized arc length of an (x,y) polyline.
 * @param {number[][]} points - Nonempty [T,2] points, e.g. [[0,0],[1,0],[1,1]].
 * @param {number} offset - Fraction of total length, clamped to [0,1].
 * @returns {{x:number,y:number,dx:number,dy:number}} Position and unit tangent.
 * @example pointAlongPolyline([[0,0],[1,0],[1,1]], 0.75) // {x:1,y:0.5,dx:0,dy:1}
 */
export function pointAlongPolyline(points, offset) {
  if (!points.length) throw new Error("pointAlongPolyline needs at least one point");
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!total) return { x: points[0][0], y: points[0][1], dx: 1, dy: 0 };
  let left = Math.max(0, Math.min(1, offset)) * total;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i];
    if (length && (left <= length || i === lengths.length - 1)) {
      const [a, b] = [points[i], points[i + 1]];
      const t = left / length;
      return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t,
        dx: (b[0] - a[0]) / length, dy: (b[1] - a[1]) / length };
    }
    left -= length;
  }
  return { x: points.at(-1)[0], y: points.at(-1)[1], dx: 1, dy: 0 };
}

/**
 * Pure function. Nearest normalized arc-length coordinate on a polyline.
 * @param {number[][]} points - Nonempty [T,2] (x,y) samples.
 * @param {{x:number,y:number}} point - Point in the same coordinate system.
 * @returns {number} Offset in [0,1]; 0 for a singleton/zero-length chain.
 * @example nearestPolylineOffset([[0,0],[1,0],[1,1]], {x:1.2,y:0.5}) // 0.75
 */
export function nearestPolylineOffset(points, point) {
  let best = Infinity, distance = 0, at = 0, total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    const t = length ? Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / length ** 2)) : 0;
    const d = Math.hypot(point.x - a[0] - dx * t, point.y - a[1] - dy * t);
    if (d < best) { best = d; at = distance + length * t; }
    distance += length;
    total += length;
  }
  return total ? at / total : 0;
}

/**
 * Pure function. Inserts a shaping node without changing either adjacent cubic.
 * Hidden nodes are retained but bypassed, exactly as by the renderer. Open ends
 * extend the visible endpoint's last step. A closed beginning is inserted at the
 * closing seam instead, keeping the colour ramp's origin and addresses unchanged.
 * Stops remain independent; input is immutable.
 * @param {object} feature - Stored feature with [N,6] nodes.
 * @param {number} index - Insertion index in [0,N].
 * @returns {object} Feature with one additional node, and aligned visibility.
 * @example insertFeatureNode(multipointFeature("line", "#f00"), 1).nodes[1] // [0.5,0.5,-0.125,0,0.125,0]
 */
export function insertFeatureNode(feature, index) {
  const nodes = feature.nodes.map((n) => n.slice());
  const count = nodes.length;
  if (!Number.isInteger(index) || index < 0 || index > count || !count) throw new Error("Multipoint node insertion needs an existing path and a valid index");
  const visible = nodes.map((_, i) => i).filter((i) => elementActive(feature.nodesActive, i));
  // A closed curve's seam is also its end. Keep the original visible origin so
  // inserting there does not shift every independent arc-length colour address.
  if (feature.closed && visible.length > 1 && index <= visible[0]) index = count;
  let before = visible.findLast((i) => i < index);
  let after = visible.find((i) => i >= index);
  if (feature.closed && visible.length > 1) {
    before ??= visible.at(-1);
    after ??= visible[0];
  }
  let inserted;
  if (before === undefined || after === undefined || before === after) {
    const prepend = before === undefined && after !== undefined;
    const edge = nodes[prepend ? visible[0] : visible.at(-1) ?? Math.min(index, count - 1)];
    const inner = nodes[prepend ? visible[1] : visible.at(-2)];
    // No visible path direction: extend a quarter box horizontally.
    const dx = inner ? edge[0] - inner[0] : prepend ? -0.25 : 0.25;
    const dy = inner ? edge[1] - inner[1] : 0;
    inserted = [edge[0] + dx, edge[1] + dy, 0, 0, 0, 0];
  } else {
    const c = nodeCubic(nodes[before], nodes[after]);
    const l = partialCubic(c, 0, 0.5), r = partialCubic(c, 0.5, 1), p = evalCubic(c, 0.5);
    nodes[before][4] = l[1][0] - l[0][0]; nodes[before][5] = l[1][1] - l[0][1];
    nodes[after][2] = r[2][0] - r[3][0]; nodes[after][3] = r[2][1] - r[3][1];
    inserted = [p[0], p[1], l[2][0] - p[0], l[2][1] - p[1], r[1][0] - p[0], r[1][1] - p[1]];
  }
  nodes.splice(index, 0, inserted);
  const active = Array.from({ length: count }, (_, i) => elementActive(feature.nodesActive, i));
  active.splice(index, 0, true);
  return { ...feature, nodes, ...(feature.nodesActive ? { nodesActive: active } : {}) };
}

/**
 * Pure function. Reverses traversal while preserving geometry and physical sides.
 * @param {object} feature - Stored nodes/stops and optional visibility companions.
 * @returns {object} Reversed feature; left/right colours and handle roles swapped.
 * @example reverseFeature(multipointFeature("line", "#f00")).nodes[0][0] // 0.75
 */
export function reverseFeature(feature) {
  const order = feature.nodes.map((_, i) => i).reverse();
  if (feature.closed && order.length > 1) {
    // Keep the closed path's visible origin, so 1-offset addresses the same spot.
    const origin = feature.nodes.findIndex((_, i) => elementActive(feature.nodesActive, i));
    const pivot = order.indexOf(origin < 0 ? 0 : origin);
    order.push(...order.splice(0, pivot));
  }
  const nodes = order.map((i) => {
    const [x, y, ix, iy, ox, oy] = feature.nodes[i];
    return [x, y, ox, oy, ix, iy];
  });
  const stops = feature.stops.map((s) => ({ ...s, offset: 1 - s.offset,
    ...(feature.twoSided ? { color: s.rightColor, rightColor: s.color } : {}),
  })).reverse();
  return { ...feature, nodes, stops,
    ...(feature.nodesActive ? { nodesActive: order.map((i) => elementActive(feature.nodesActive, i)) } : {}),
    ...(feature.stopsActive ? { stopsActive: feature.stops.map((_, i) => elementActive(feature.stopsActive, i)).reverse() } : {}),
  };
}
