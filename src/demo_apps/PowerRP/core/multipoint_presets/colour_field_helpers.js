/**
 * Geometry and paint helpers for the "Colour field" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { finiteGeometry } from "../multipoint_shapes.js";

const SNAP = 1e-9;

/**
 * Pure function. Corner list of a rotated rectangle, clockwise on screen.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} hw - Positive half-width along the rotated x axis.
 * @param {number} hh - Positive half-height.
 * @param {number} angle - Rotation in radians (positive = clockwise on screen).
 * @returns {number[][]} [4,2] (x,y) corners.
 * @example rotRect(0.5, 0.5, 0.2, 0.1, 0).map((p) => p.map((v) => +v.toFixed(2))) // [[0.3,0.4],[0.7,0.4],[0.7,0.6],[0.3,0.6]]
 */
export function rotRect(cx, cy, hw, hh, angle) {
  finiteGeometry([cx, cy, hw, hh, angle]);
  if (!(hw > 0) || !(hh > 0)) throw new Error("rotRect needs positive half sizes");
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
}

/**
 * Pure function. Clips a convex or simple polygon to an axis-aligned rectangle (Sutherland-Hodgman),
 * snapping coordinates that land on the rectangle edge exactly onto it.
 * @param {number[][]} poly - [N,2] (x,y) vertices, N >= 3.
 * @param {number[]} box - [x0,y0,x1,y1] clip rectangle.
 * @returns {number[][]} [M,2] clipped vertices (possibly empty).
 * @example clipPolygon([[-1,0.5],[0.5,-1],[2,0.5],[0.5,2]], [0,0,1,1]).length // 4 (the unit box lies wholly inside this diamond)
 * @example clipPolygon([[0.2,0.2],[0.8,0.2],[0.8,0.8]], [0,0,1,1]).length // 3
 */
export function clipPolygon(poly, [x0, y0, x1, y1]) {
  finiteGeometry([x0, y0, x1, y1, ...poly.flat()]);
  const planes = [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]]; // [axis, limit, inside sign]
  let out = poly;
  for (const [axis, limit, sign] of planes) {
    const src = out; out = [];
    const inside = (p) => sign * (p[axis] - limit) >= -SNAP;
    src.forEach((p, i) => {
      const q = src[(i + 1) % src.length], pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = (limit - p[axis]) / (q[axis] - p[axis]), pt = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
        pt[axis] = limit; out.push(pt);
      }
    });
  }
  return out.map(([x, y]) => [Math.min(x1, Math.max(x0, x)), Math.min(y1, Math.max(y0, y))]);
}

/**
 * Pure function. Closed chevron band: a V whose arms reach x = 0 and x = 1, `thick` tall measured
 * vertically, clockwise on screen. Apex sits at `top + depth` (upper edge) — apex down for depth > 0.
 * @param {number} top - y of the upper edge at the box sides.
 * @param {number} depth - Vertical drop of the apex relative to the sides (negative = apex up).
 * @param {number} thick - Positive vertical thickness.
 * @param {number} [apexX] - x of the apex.
 * @returns {number[][]} [6,2] (x,y) vertices.
 * @example chevronBand(0.1, 0.25, 0.1).map((p) => p.map((v) => +v.toFixed(2))) // [[0,0.1],[0.5,0.35],[1,0.1],[1,0.2],[0.5,0.45],[0,0.2]]
 */
export function chevronBand(top, depth, thick, apexX = 0.5) {
  finiteGeometry([top, depth, thick, apexX]);
  if (!(thick > 0)) throw new Error("chevronBand needs positive thickness");
  return [[0, top], [apexX, top + depth], [1, top], [1, top + thick], [apexX, top + depth + thick], [0, top + thick]];
}
