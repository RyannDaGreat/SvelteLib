/**
 * Geometry and paint helpers for the "Murals & street colour" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { catmullRomNodes, finiteGeometry, hermiteNodes, polylineNodes, rectNodes } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;

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
 * Pure function. Vertices pulled toward their centroid, leaving a hairline gap between
 * neighbouring facets (adjacent facets must not touch: touching curves fight).
 * @param {number[][]} points - [N,2] vertices.
 * @param {number} amount - Fraction of the distance to the centroid, in [0,1).
 * @returns {number[][]} [N,2] shrunk vertices.
 * @example shrink([[0,0],[2,0],[2,2],[0,2]], 0.5) // [[0.5,0.5],[1.5,0.5],[1.5,1.5],[0.5,1.5]]
 */
export function shrink(points, amount) {
  finiteGeometry([amount, ...points.flat()]);
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length, cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  return points.map(([x, y]) => [x + (cx - x) * amount, y + (cy - y) * amount]);
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
 * Pure function. Half-ellipse arch standing on the line y = base, walked left, over the top,
 * to the right, so the FIRST colour set is OUTSIDE (above) and the second INSIDE. The feet
 * are snapped exactly onto y = base (float overshoot would grow the solve domain).
 * @param {number} cx - Centre x.
 * @param {number} base - Foot line y.
 * @param {number} rx - Half width.
 * @param {number} ry - Height of the dome above the feet.
 * @returns {number[][]} [5,6] tuples.
 * @example archNodes(0.5, 1, 0.3, 0.4).map((n) => n.slice(0, 2).map((v) => +v.toFixed(2)))[2] // [0.5,0.6]
 */
export function archNodes(cx, base, rx, ry) {
  finiteGeometry([cx, base, rx, ry]);
  const nodes = sampled((t) => [cx - rx * Math.cos(Math.PI * t), base - ry * Math.sin(Math.PI * t)], 4);
  nodes[0][0] = cx - rx; nodes[0][1] = base;
  nodes[4][0] = cx + rx; nodes[4][1] = base;
  return openEnds(nodes);
}

/**
 * Pure function. Points on a closed radial shape r(theta), listed clockwise on screen from the
 * rightmost direction, as smooth closed nodes.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {function} radius - theta (screen radians, clockwise from +x) to [rx, ry].
 * @param {number} count - Anchor count >= 3.
 * @returns {number[][]} [count,6] closed Catmull-Rom tuples.
 * @example ring(0.5, 0.5, () => [0.2, 0.2], 4)[0].slice(0, 2) // [0.7,0.5]
 */
export function ring(cx, cy, radius, count) {
  finiteGeometry([cx, cy, count]);
  return catmullRomNodes(Array.from({ length: count }, (_, i) => {
    const a = FULL_TURN * i / count, [rx, ry] = radius(a);
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  }), true);
}

/**
 * Pure function. A parametric curve sampled into smooth nodes with exact numeric tangents.
 * @param {function} curve - t in [0,1] to [x, y].
 * @param {number} spans - Positive integer span count (spans + 1 nodes).
 * @returns {number[][]} [spans+1,6] tuples (ends NOT zeroed; use openEnds for open curves).
 * @example sampled((t) => [t, 0.5], 2).map((n) => n[0]) // [0,0.5,1]
 */
export function sampled(curve, spans) {
  finiteGeometry([spans]);
  const h = 1e-5;
  return hermiteNodes(Array.from({ length: spans + 1 }, (_, i) => {
    const t = i / spans, [x, y] = curve(t), [x1, y1] = curve(Math.min(1, t + h)), [x0, y0] = curve(Math.max(0, t - h));
    const span = Math.min(1, t + h) - Math.max(0, t - h);
    return [x, y, (x1 - x0) / span, (y1 - y0) / span];
  }), 1 / spans);
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
 * Pure function. Delaunay triangulation of a point set (Bowyer-Watson), unit-box friendly.
 * @param {number[][]} points - [N,2] distinct (x,y) points, N >= 3, not all collinear.
 * @returns {number[][][]} Triangles as [3,2] vertex lists (input order not preserved per triangle).
 * @example delaunay([[0,0],[1,0],[1,1],[0,1]]).length // 2
 */
export function delaunay(points) {
  finiteGeometry(points.flat());
  if (points.length < 3) throw new Error("delaunay needs at least three points");
  const big = 1e3;
  const all = [...points, [-big, -big], [big * 2, -big], [0, big * 2]];
  const n = points.length;
  const circum = ([a, b, c]) => {
    const [ax, ay] = all[a], [bx, by] = all[b], [cx, cy] = all[c];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    return { ux, uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris = [[n, n + 1, n + 2]].map((t) => ({ t, ...circum(t) }));
  for (let p = 0; p < n; p++) {
    const [px, py] = all[p];
    const bad = tris.filter((T) => (px - T.ux) ** 2 + (py - T.uy) ** 2 < T.r2 - 1e-12);
    const edges = new Map();
    for (const { t } of bad) for (let k = 0; k < 3; k++) {
      const e = [t[k], t[(k + 1) % 3]], key = [...e].sort().join();
      edges.set(key, edges.has(key) ? null : e);
    }
    tris = tris.filter((T) => !bad.includes(T));
    for (const e of edges.values()) if (e) { const t = [e[0], e[1], p]; tris.push({ t, ...circum(t) }); }
  }
  return tris.filter(({ t }) => t.every((i) => i < n)).map(({ t }) => t.map((i) => [...points[i]]));
}
