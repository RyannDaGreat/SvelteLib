/**
 * Geometry and paint helpers for the "Microscopy & natural science" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { polylineNodes, finiteGeometry } from "../multipoint_shapes.js";
import { insetPolygon } from "./geometric.js";
import { ribbonNodes } from "./retro_eras.js";

/**
 * Pure function. Where a ray from (x, y) leaves the unit box, plus which side it leaves by
 * as a clockwise perimeter coordinate in [0,4) (0 = top-left corner, 1 = top-right, ...).
 * @param {number} x - Start x in (0,1).
 * @param {number} y - Start y in (0,1).
 * @param {number} angle - Screen radians (0 = +x, π/2 = down).
 * @returns {{point: number[], perimeter: number}} Exit point and clockwise perimeter position.
 * @example exitOf(0.5, 0.5, 0).perimeter // 1.5
 */
export function exitOf(x, y, angle) {
  finiteGeometry([x, y, angle]);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const reach = (p, d) => (d > 1e-12 ? (1 - p) / d : d < -1e-12 ? -p / d : Infinity);
  const t = Math.min(reach(x, dx), reach(y, dy));
  const ex = Math.min(1, Math.max(0, x + t * dx)), ey = Math.min(1, Math.max(0, y + t * dy));
  const perimeter = ey === 0 ? ex : ex === 1 ? 1 + ey : ey === 1 ? 3 - ex : 4 - ey;
  return { point: [ex, ey], perimeter };
}

/**
 * Pure function. Closed two-sided stroke: a tapered ribbon along a centreline whose inside is
 * `inside` and whose surroundings (the walker's left) are `outside`.
 * @param {number[][]} points - [N,2] centreline.
 * @param {number[]} widths - [N] full widths at each anchor.
 * @param {string} inside - Fill colour.
 * @param {string} outside - Colour just outside the stroke (the local field).
 * @returns {object} Closed feature.
 * @example stroke([[0.2,0.5],[0.8,0.5]], [0,0.02], "#ffffff", "#000000").closed // true
 */
export function stroke(points, widths, inside, outside) {
  return boundary(ribbonNodes(points, widths), [outside], [inside], true);
}

/**
 * Pure function. A convex polygon as a closed two-sided tile with a ramp inside and a
 * constant seam colour outside; the polygon is pulled in by `gap` so neighbours leave a seam.
 * @param {number[][]} polygon - [K,2] convex clockwise vertices.
 * @param {number} gap - Inset distance (half the seam width).
 * @param {string[]} inside - Ramp (first colour repeated at the end automatically).
 * @param {string} seam - Outside colour.
 * @returns {object} Closed feature with sharp corners.
 * @example tile([[0,0],[1,0],[1,1],[0,1]], 0.1, ["#ff0000"], "#000000").nodes.length // 4
 */
export function tile(polygon, gap, inside, seam) {
  const ring = inside.length > 1 ? [...inside, inside[0]] : inside;
  return boundary(polylineNodes(gap ? insetPolygon(polygon, gap) : polygon), ring.map(() => seam), ring, true);
}

/**
 * Pure function. Clips a convex polygon to the half-plane {p : (p − origin)·normal ≥ 0}
 * (Sutherland–Hodgman); vertex order and orientation are preserved.
 * @param {number[][]} polygon - [K,2] convex vertices.
 * @param {number[]} origin - [x, y] point on the clipping line.
 * @param {number[]} normal - [nx, ny] pointing to the kept side.
 * @returns {number[][]} Clipped polygon (possibly empty).
 * @example clipHalfPlane([[0,0],[1,0],[1,1],[0,1]], [0.5,0], [1,0]).length // 4
 */
export function clipHalfPlane(polygon, origin, normal) {
  finiteGeometry([...polygon.flat(), ...origin, ...normal]);
  const side = (p) => (p[0] - origin[0]) * normal[0] + (p[1] - origin[1]) * normal[1];
  const out = [];
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length], sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) { const t = sa / (sa - sb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  });
  return tidyPolygon(out);
}

const TIDY_EPS = 1e-9;

/**
 * Pure function. Drops repeated and collinear vertices from a polygon.
 * @param {number[][]} polygon - [K,2] vertices.
 * @returns {number[][]} Polygon without zero-length or straight-through vertices.
 * @example tidyPolygon([[0,0],[0.5,0],[1,0],[1,1],[1,1]]).length // 3
 */
export function tidyPolygon(polygon) {
  const distinct = polygon.filter((p, i) => Math.hypot(p[0] - polygon[(i + 1) % polygon.length][0], p[1] - polygon[(i + 1) % polygon.length][1]) > TIDY_EPS);
  return distinct.filter((p, i) => {
    const a = distinct[(i + distinct.length - 1) % distinct.length], b = distinct[(i + 1) % distinct.length];
    return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > TIDY_EPS;
  });
}

/**
 * Pure function. The slab of a convex polygon lying between two parallel lines, measured along a
 * direction: all p with d0 ≤ p·(cos a, sin a) ≤ d1.
 * @param {number[][]} polygon - [K,2] convex vertices.
 * @param {number} angle - Screen radians of the measuring direction.
 * @param {number} d0 - Lower bound along the direction.
 * @param {number} d1 - Upper bound along the direction.
 * @returns {number[][]} Clipped polygon.
 * @example slab([[0,0],[1,0],[1,1],[0,1]], 0, 0.25, 0.75).map((p) => p[0]) // [0.25,0.75,0.75,0.25]
 */
export function slab(polygon, angle, d0, d1) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const low = clipHalfPlane(polygon, [c * d0, s * d0], [c, s]);
  return low.length ? clipHalfPlane(low, [c * d1, s * d1], [-c, -s]) : low;
}
