/**
 * Geometry and paint helpers for the "Ornament & tile" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { finiteGeometry, polylineNodes, rectNodes, finiteGeometry as finite, hermiteNodes } from "../multipoint_shapes.js";

/**
 * Pure function. A flat background: the whole box as a single-sided clockwise frame of one colour,
 * which pins that colour along every edge so the interior diffuses toward it.
 * @param {string} color - #rrggbb.
 * @returns {object} Closed single-sided feature over the unit box.
 * @example ground("#102040").closed // true
 */
export function ground(color) {
  return boundary(rectNodes(0, 0, 1, 1), [color], null, true);
}

/**
 * Pure function. A star with concave curved sides: `points` cusps on a circle, each side bowed toward the centre
 * by handles of length `pull` times the cusp radius. Clockwise on screen from the first cusp.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Cusp radius.
 * @param {number} points - Integer cusp count >= 3.
 * @param {number} pull - Handle length as a fraction of r (0 = straight polygon, ~0.45 = deep astroid).
 * @param {number} rotation - Angle of the first cusp (default straight up).
 * @returns {number[][]} [points,6] nodes; close the feature.
 * @example cuspStarNodes(0.5, 0.5, 0.4, 4, 0.3)[0].map((v) => +v.toFixed(2)) // [0.5,0.1,0,0.12,0,0.12]
 */
export function cuspStarNodes(cx, cy, r, points, pull, rotation = -Math.PI / 2) {
  finiteGeometry([cx, cy, r, points, pull, rotation]);
  if (!Number.isInteger(points) || points < 3 || r <= 0) throw new Error("cuspStarNodes needs a positive radius and integer points >= 3");
  return Array.from({ length: points }, (_, i) => {
    const a = rotation + 2 * Math.PI * i / points, hx = -Math.cos(a) * r * pull, hy = -Math.sin(a) * r * pull;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), hx, hy, hx, hy];
  });
}

/**
 * Pure function. A pointed (equilateral-ish) arch standing on a flat base: straight jambs, circular arcs of radius
 * `radius` centred on the opposite spring line, sharp apex. Clockwise from the bottom-left corner.
 * @param {number} x0 - Left jamb x.
 * @param {number} x1 - Right jamb x.
 * @param {number} yBase - Base y (larger than ySpring).
 * @param {number} ySpring - y where the arcs begin.
 * @param {number} radius - Arc radius >= (x1 - x0)/2 (equal = equilateral, larger = lancet).
 * @returns {number[][]} [6,6] nodes; close the feature. Apex y = ySpring - sqrt(radius^2 - (radius - w/2)^2).
 * @example archNodes(0.2, 0.8, 0.9, 0.7, 0.6)[2].slice(0, 2).map((v) => +v.toFixed(3)) // [0.5,0.18]
 */
export function archNodes(x0, x1, yBase, ySpring, radius) {
  finite([x0, x1, yBase, ySpring, radius]);
  const w = x1 - x0;
  if (radius < w / 2 || yBase <= ySpring) throw new Error("archNodes needs radius >= half width and base below spring");
  const cosT = (w / 2 - radius) / radius, phi = Math.PI - Math.acos(cosT) ;
  const theta = Math.PI + phi, k = 4 / 3 * Math.tan(phi / 4) * radius;
  const dx = -Math.sin(theta), dy = Math.cos(theta), xm = (x0 + x1) / 2, ya = ySpring + radius * Math.sin(theta);
  return polylineNodes([[x0, yBase]]).concat([
    [x0, ySpring, 0, 0, 0, -k],
    [xm, ya, -k * dx, -k * dy, k * dx, -k * dy],
    [x1, ySpring, 0, -k, 0, 0],
    [x1, yBase, 0, 0, 0, 0],
  ]).map((n) => n.map((v) => v + 0));
}

/**
 * Pure function. A Greek cross (equal arms), 12 sharp corners, clockwise from the top arm's top-left corner.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} arm - Half-length of each arm from the centre.
 * @param {number} thick - Half-thickness of each arm.
 * @returns {number[][]} [12,6] zero-handle nodes.
 * @example crossNodes(0.5, 0.5, 0.3, 0.05)[0].slice(0, 2) // [0.45,0.2]
 */
export function crossNodes(cx, cy, arm, thick) {
  finite([cx, cy, arm, thick]);
  const t = thick, a = arm;
  return polylineNodes([[-t, -a], [t, -a], [t, -t], [a, -t], [a, t], [t, t], [t, a], [-t, a], [-t, t], [-a, t], [-a, -t], [-t, -t]].map(([x, y]) => [cx + x, cy + y]));
}

const DIFF_STEP = 1e-5;

/**
 * Pure function. Smooth closed ribbon along a spiral with EXACT per-edge Hermite tangents (no Catmull-Rom
 * corner-cutting): the outline walks the walker's left edge forward, then the right edge back, clockwise on screen.
 * Both ends are pointed when the width profile is 0 there, so the outline is 2*spans nodes (tips shared).
 * @param {object} o - {cx, cy, r0, r1, turns, phase, spans, width}: spiral r(t)=r0+(r1-r0)t, angle phase+2*pi*turns*t,
 *   `width` a function t in [0,1] -> full ribbon width (must be 0 at t=0 and t=1).
 * @returns {number[][]} [2*spans,6] nodes; close the feature.
 * @example spiralRibbonNodes({cx:0.5,cy:0.5,r0:0.2,r1:0.05,turns:1,phase:0,spans:4,width:(t)=>0.1*Math.sin(Math.PI*t)}).length // 8
 */
export function spiralRibbonNodes({ cx, cy, r0, r1, turns, phase, spans, width }) {
  finite([cx, cy, r0, r1, turns, phase, spans]);
  if (Math.abs(width(0)) > 1e-6 || Math.abs(width(1)) > 1e-6) throw new Error("spiralRibbonNodes needs width 0 at both ends");
  const centre = (t) => [cx + (r0 + (r1 - r0) * t) * Math.cos(phase + 2 * Math.PI * turns * t), cy + (r0 + (r1 - r0) * t) * Math.sin(phase + 2 * Math.PI * turns * t)];
  const edge = (t, side) => {
    const [ax, ay] = centre(t - DIFF_STEP), [bx, by] = centre(t + DIFF_STEP), len = Math.hypot(bx - ax, by - ay), [x, y] = centre(t);
    const h = side * width(t) / 2;
    return [x + h * (by - ay) / len, y - h * (bx - ax) / len];
  };
  const sample = (t, side, dir) => {
    const [x, y] = edge(t, side), [ax, ay] = edge(Math.max(0, t - DIFF_STEP), side), [bx, by] = edge(Math.min(1, t + DIFF_STEP), side);
    const span = Math.min(1, t + DIFF_STEP) - Math.max(0, t - DIFF_STEP);
    return [x, y, dir * (bx - ax) / span, dir * (by - ay) / span];
  };
  const ts = Array.from({ length: spans + 1 }, (_, i) => i / spans);
  const left = hermiteNodes(ts.map((t) => sample(t, 1, 1)), 1 / spans);
  const right = hermiteNodes([...ts].reverse().map((t) => sample(t, -1, -1)), 1 / spans);
  const tip = [left.at(-1)[0], left.at(-1)[1], left.at(-1)[2], left.at(-1)[3], right[0][4], right[0][5]];
  const closure = [left[0][0], left[0][1], right.at(-1)[2], right.at(-1)[3], left[0][4], left[0][5]];
  return [closure, ...left.slice(1, -1), tip, ...right.slice(1, -1)];
}
