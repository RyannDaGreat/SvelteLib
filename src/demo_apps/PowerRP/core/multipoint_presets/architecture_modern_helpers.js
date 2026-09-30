/**
 * Geometry and paint helpers for the "Architecture & light" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary, closedRamp } from "./builders.js";
import { polylineNodes, rectNodes, finiteGeometry, catmullRomNodes } from "../multipoint_shapes.js";

/**
 * Pure function. A box-wide single-sided frame on the unit-box border: pins the field's edge colours, so every
 * shape inside is set on a smooth ground. Several colours become a closed ramp around the perimeter (TL, TR, BR, BL).
 * @param {string[]} colors - One colour, or an open ramp (auto-closed, so no seam).
 * @returns {object} Closed single-sided feature with 4 nodes.
 * @example frame(["#000000"]).closed // true
 */
export function frame(colors) {
  return boundary(polylineNodes([[0, 0], [1, 0], [1, 1], [0, 1]]), colors.length > 1 ? closedRamp(colors) : colors, null, true);
}

/**
 * Pure function. A crisp closed polygon: `inside` colours the interior, `outside` the hairline just beyond.
 * Colour arguments are a colour or an open ramp (auto-closed, so no seam); both sides get equal length.
 * @param {number[][]} points - [N,2] clockwise (x,y) corners.
 * @param {string|string[]} inside - Interior colour(s).
 * @param {string|string[]} outside - Exterior colour(s).
 * @returns {object} Closed two-sided feature.
 * @example shape([[0,0],[1,0],[1,1]], "#fff", "#000").twoSided // true
 */
export function shape(points, inside, outside) {
  return nodeShape(points.length && points[0].length === 6 ? points : polylineNodes(points), inside, outside);
}

/**
 * Pure function. Like `shape` but from ready [N,6] nodes (clockwise on screen, so the inside is on the right).
 * @param {number[][]} nodes - [N,6] anchor/relative-handle tuples.
 * @param {string|string[]} inside - Interior colour(s).
 * @param {string|string[]} outside - Exterior colour(s).
 * @returns {object} Closed two-sided feature.
 * @example nodeShape([[0.5,0.2,0,0,0,0],[0.8,0.8,0,0,0,0],[0.2,0.8,0,0,0,0]], "#fff", "#000").stops.length // 1
 */
export function nodeShape(nodes, inside, outside) {
  const fit = (c) => (Array.isArray(c) ? closedRamp(c) : [c]);
  const a = fit(inside), b = fit(outside);
  const n = Math.max(a.length, b.length);
  const pad = (r) => (r.length === n ? r : Array(n).fill(r[0]));
  return boundary(nodes, pad(b), pad(a), true);
}

/**
 * Pure function. An axis-aligned clockwise rect as a crisp `shape` (ramps run from the top-left corner).
 * @param {number} x0 - Left edge.
 * @param {number} y0 - Top edge.
 * @param {number} x1 - Right edge.
 * @param {number} y1 - Bottom edge.
 * @param {string|string[]} inside - Interior colour(s).
 * @param {string|string[]} outside - Exterior colour(s).
 * @returns {object} Closed two-sided feature with 4 nodes.
 * @example panel(0.1, 0.1, 0.9, 0.9, "#fff", "#000").nodes.length // 4
 */
export function panel(x0, y0, x1, y1, inside, outside) {
  return shape(rectNodes(x0, y0, x1, y1).map(([x, y]) => [x, y]), inside, outside);
}

/**
 * Pure function. A smooth closed single-sided blob through clockwise points: a soft patch of one colour.
 * @param {number[][]} points - [N,2] clockwise (x,y) anchors, N >= 2.
 * @param {string} color - Patch colour.
 * @param {string|null} inside - Optional different interior colour (makes it two-sided).
 * @returns {object} Closed feature.
 * @example softBlob([[0.5,0.2],[0.8,0.5],[0.5,0.8],[0.2,0.5]], "#fff").nodes.length // 4
 */
export function softBlob(points, color, inside = null) {
  return boundary(catmullRomNodes(points, true), [color], inside ? [inside] : null, true);
}

/**
 * Pure function. Insets a convex clockwise polygon: edge i (from point i to i+1) moves inward by
 * `dists[i]` (0 leaves that edge, e.g. one lying on the box border, exactly where it is).
 * @param {number[][]} points - [N,2] clockwise convex corners.
 * @param {number|number[]} dists - One inset for all edges or [N] per-edge insets.
 * @returns {number[][]} [N,2] corners of the inset polygon.
 * @example insetPolygon([[0,0],[1,0],[1,1],[0,1]], 0.1)[0].map((v) => +v.toFixed(2)) // [0.1,0.1]
 */
export function insetPolygon(points, dists) {
  const n = points.length, d = Array.isArray(dists) ? dists : Array(n).fill(dists);
  finiteGeometry([...points.flat(), ...d]);
  // Edge i as an offset line; for a clockwise polygon on a y-down screen, inside is the right of travel.
  const lines = points.map(([x0, y0], i) => {
    const [x1, y1] = points[(i + 1) % n], len = Math.hypot(x1 - x0, y1 - y0);
    const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
    return { px: x0 + nx * d[i], py: y0 + ny * d[i], dx: (x1 - x0) / len, dy: (y1 - y0) / len };
  });
  return points.map((_, i) => {
    const a = lines[(i + n - 1) % n], b = lines[i];
    const cross = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(cross) < 1e-9) return [b.px, b.py];
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / cross;
    return [a.px + a.dx * t, a.py + a.dy * t];
  });
}

const ARC_HANDLE = 0.5523;

/**
 * Pure function. A round-headed arch window (semicircular/elliptical head, straight jambs, flat sill) as five
 * clockwise nodes starting at the crown, so a closed ramp [a, b, a] runs crown -> sill -> crown (vertical gradient).
 * @param {number} l - Left jamb x.
 * @param {number} r - Right jamb x.
 * @param {number} top - Crown y.
 * @param {number} bottom - Sill y.
 * @param {number} rise - Height of the round head (springing line sits at top + rise).
 * @returns {number[][]} [5,6] anchor/relative-handle tuples; close the feature.
 * @example archNodes(0.2, 0.4, 0.1, 0.9, 0.1)[0] // [0.3,0.1,-0.05523,0,0.05523,0]
 */
export function archNodes(l, r, top, bottom, rise) {
  finiteGeometry([l, r, top, bottom, rise]);
  if (!(r > l && bottom > top + rise && rise > 0)) throw new Error("archNodes needs r > l and bottom > top + rise");
  const kx = (r - l) / 2 * ARC_HANDLE, ky = rise * ARC_HANDLE, cx = (l + r) / 2;
  return [[cx, top, -kx, 0, kx, 0], [r, top + rise, 0, -ky, 0, 0], [r, bottom, 0, 0, 0, 0], [l, bottom, 0, 0, 0, 0], [l, top + rise, 0, 0, 0, -ky]];
}

/** Pure function. A horizontal edge-to-edge line at y, walked left to right (rightColor BELOW). @example hLine(0.5)[1] // [1,0.5,0,0,0,0] */
export const hLine = (y) => [[0, y, 0, 0, 0, 0], [1, y, 0, 0, 0, 0]];

/** Pure function. A vertical edge-to-edge line at x, walked bottom to top (rightColor EAST). @example vLine(0.5)[0] // [0.5,1,0,0,0,0] */
export const vLine = (x) => [[x, 1, 0, 0, 0, 0], [x, 0, 0, 0, 0, 0]];

const CIRCLE_HANDLE = 0.5523;

/**
 * Pure function. Four-node closed "egg" whose top/right/bottom/left radii differ, clockwise from the right node.
 * `squareness` scales the handles (0.5523 = elliptical arcs, toward 0.8 = soft squircle).
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number[]} radii - [top, right, bottom, left] positive distances from the centre to each node.
 * @param {number} squareness - Handle/radius ratio, in (0, 1].
 * @returns {number[][]} [4,6] anchor/relative-handle tuples; close the feature.
 * @example eggNodes(0.5, 0.5, [0.2, 0.3, 0.2, 0.3], 0.5523)[0].map((v) => +v.toFixed(3)) // [0.8,0.5,0,-0.11,0,0.11]
 */
export function eggNodes(cx, cy, [top, right, bottom, left], squareness = CIRCLE_HANDLE) {
  finiteGeometry([cx, cy, top, right, bottom, left, squareness]);
  if (![top, right, bottom, left].every((r) => r > 0) || !(squareness > 0 && squareness <= 1)) throw new Error("eggNodes needs positive radii and squareness in (0,1]");
  const s = squareness;
  return [
    [cx + right, cy, 0, -top * s, 0, bottom * s],
    [cx, cy + bottom, right * s, 0, -left * s, 0],
    [cx - left, cy, 0, bottom * s, 0, -top * s],
    [cx, cy - top, -left * s, 0, right * s, 0],
  ];
}

/**
 * Pure function. A crisp rect whose interior runs a true vertical gradient: nodes start at the top-centre so the
 * closed ramp [top, bottom, top] meets `bottom` exactly at the bottom-centre.
 * @param {number} x0 - Left edge.
 * @param {number} y0 - Top edge.
 * @param {number} x1 - Right edge.
 * @param {number} y1 - Bottom edge.
 * @param {string} top - Interior colour at the top.
 * @param {string} bottom - Interior colour at the bottom.
 * @param {string} outside - Colour just outside the rect.
 * @returns {object} Closed two-sided feature with 5 nodes.
 * @example verticalPane(0.1, 0.1, 0.3, 0.9, "#fff", "#f80", "#000").nodes.length // 5
 */
export function verticalPane(x0, y0, x1, y1, top, bottom, outside) {
  finiteGeometry([x0, y0, x1, y1]);
  return shape([[(x0 + x1) / 2, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], [top, bottom], outside);
}

/**
 * Pure function. Clips a convex polygon to the half-plane {p : (p - origin) . normal <= 0} (Sutherland-Hodgman).
 * @param {number[][]} poly - [N,2] vertices.
 * @param {number[]} origin - Point on the clip line.
 * @param {number[]} normal - Outward normal (need not be unit).
 * @returns {number[][]} Clipped [M,2] vertices (empty when nothing survives).
 * @example clipPolygon([[0,0],[1,0],[1,1],[0,1]], [0.5,0], [1,0]).length // 4
 */
export function clipPolygon(poly, [ox, oy], [nx, ny]) {
  finiteGeometry([ox, oy, nx, ny, ...poly.flat()]);
  const side = ([x, y]) => (x - ox) * nx + (y - oy) * ny, out = [];
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  });
  return out;
}

/**
 * Pure function. Voronoi cells of `sites` inside the unit box, each inset by `gap`/2 from its neighbours and by `margin`
 * from the box edges: the polygons are tiles or patches separated by thin mortar. Vertices run
 * clockwise on screen.
 * @param {number[][]} sites - [N,2] cell centres.
 * @param {number} gap - Vein width between neighbouring cells.
 * @param {number} margin - Inset from the box edges.
 * @param {number} aspect - Vertical distance weight: below 1 stretches cells vertically, above 1 flattens them.
 * @returns {number[][][]} N polygons of [M,2] vertices.
 * @example voronoiCells([[0.25,0.5],[0.75,0.5]], 0.1, 0).map((c) => c.length) // [4,4]
 */
export function voronoiCells(sites, gap, margin = 0, aspect = 1) {
  finiteGeometry([gap, margin, aspect, ...sites.flat()]);
  return sites.map((s, i) => {
    let poly = [[margin, margin], [1 - margin, margin], [1 - margin, 1 - margin], [margin, 1 - margin]];
    sites.forEach((t, j) => {
      if (i === j) return;
      const dx = t[0] - s[0], dy = (t[1] - s[1]) * aspect * aspect, d = Math.hypot(dx, dy);   // normal M(t - s), M = diag(1, aspect^2)
      const mid = [(s[0] + t[0]) / 2 - dx / d * gap / 2, (s[1] + t[1]) / 2 - dy / d * gap / 2];
      poly = clipPolygon(poly, mid, [dx, dy]);
    });
    if (poly.length < 3) throw new Error("voronoiCells: a cell vanished (sites too close for the gap)");
    return poly;
  });
}

/**
 * Pure function. Rounds a polygon into smooth closed nodes (Catmull-Rom through its vertices) after pulling each
 * vertex toward the centroid by `round` (0 = keep the corner, 1 = collapse) and shortening any handle that would leave the unit box.
 * @param {number[][]} poly - [M,2] clockwise vertices.
 * @param {number} round - Corner pull fraction in [0,1).
 * @returns {number[][]} [M,6] closed tuples.
 * @example roundedPolygon([[0,0],[1,0],[1,1],[0,1]], 0).length // 4
 */
export function roundedPolygon(poly, round = 0) {
  const n = poly.length, cx = poly.reduce((a, p) => a + p[0], 0) / n, cy = poly.reduce((a, p) => a + p[1], 0) / n;
  return boxHandles(catmullRomNodes(poly.map(([x, y]) => [x + (cx - x) * round, y + (cy - y) * round]), true));
}

/**
 * Pure function. Shortens any handle whose tip would leave the unit box, keeping its direction.
 * @param {number[][]} nodes - [N,6] tuples whose anchors lie in the box.
 * @returns {number[][]} New [N,6] tuples.
 * @example boxHandles([[0.9, 0.5, 0, 0, 0.2, 0.1]]) // [[0.9,0.5,0,0,0.1,0.05]]
 */
export function boxHandles(nodes) {
  return nodes.map(([x, y, ix, iy, ox, oy]) => {
    const fit = (hx, hy) => {
      let k = 1;
      for (const [p, h] of [[x, hx], [y, hy]]) { if (p + h > 1) k = Math.min(k, (1 - p) / h); if (p + h < 0) k = Math.min(k, -p / h); }
      return [hx * k, hy * k];
    };
    return [x, y, ...fit(ix, iy), ...fit(ox, oy)];
  });
}
