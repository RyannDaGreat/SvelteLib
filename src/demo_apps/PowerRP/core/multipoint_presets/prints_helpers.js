/**
 * Geometry and paint helpers for the "Prints & patterns" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { catmullRomNodes, hermiteNodes, finiteGeometry, rectNodes, polylineNodes } from "../multipoint_shapes.js";

const FULL_TURN = 2 * Math.PI;

const INSET = 0.0;

/**
 * Pure function. A single-sided box frame: flat ground colour pinned on the whole box edge.
 * @param {string} color - #rrggbb.
 * @returns {object} Closed one-stop feature on the unit box.
 * @example ground("#ffffff").closed // true
 */
export function ground(color) {
  return boundary(rectNodes(INSET, INSET, 1, 1), [color], null, true);
}

/**
 * Pure function. Ground with a different colour on each box edge, so the interior diffuses a smooth
 * four-corner-free wash: top/bottom edges are lines pinned exactly on y=0 / y=1.
 * @param {string[]} top - Ramp left to right along y=0.
 * @param {string[]} bottom - Ramp left to right along y=1.
 * @param {string[]} left - Ramp top to bottom along x=0.
 * @param {string[]} right - Ramp top to bottom along x=1.
 * @returns {object[]} Four open single-sided features.
 * @example edgeRails(["#fff"], ["#000"], ["#888"], ["#888"]).length // 4
 */
export function edgeRails(top, bottom, left, right) {
  return [
    boundary(polylineNodes([[0, 0], [1, 0]]), top),
    boundary(polylineNodes([[0, 1], [1, 1]]), bottom),
    boundary(polylineNodes([[0, 0], [0, 1]]), left),
    boundary(polylineNodes([[1, 0], [1, 1]]), right),
  ];
}

/**
 * Pure function. Zigzag line across the box: one node per extremum with horizontal handles of length
 * round * half-period (round 1/3 reads as a sine, 0 as a sharp triangle wave). Left to right.
 * @param {object} o - {y, amp, halves>=1, round=0.12, x0=0, x1=1, sign=1} (sign +1 starts on a crest BELOW y).
 * @returns {number[][]} [halves+1, 6].
 * @example zigzagNodes({y:0.5,amp:0.1,halves:2}).map((n) => +n[1].toFixed(2)) // [0.6,0.4,0.6]
 */
export function zigzagNodes({ y, amp, halves, round = 0.12, x0 = 0, x1 = 1, sign = 1 }) {
  finiteGeometry([y, amp, halves, round, x0, x1, sign]);
  if (!Number.isInteger(halves) || halves < 1) throw new Error("zigzagNodes needs a positive integer half-period count");
  const dx = (x1 - x0) / halves, hx = dx * round;
  return Array.from({ length: halves + 1 }, (_, i) => [
    x0 + dx * i, y + amp * sign * (i % 2 ? -1 : 1), i ? -hx : 0, 0, i < halves ? hx : 0, 0]);
}

/**
 * Pure function. Boteh / paisley teardrop: a round bulb whose tail sweeps into a hook. The centreline starts
 * at the bulb centre heading along `angle`, then turns by `bend`*PI (positive = clockwise on screen) following
 * heading(s) = bend*PI*s^2, so the bulb end stays straight and the tip curls over. Both sides offset from that
 * centreline by a teardrop half-width profile; traced clockwise, so rightColor is INSIDE; first node is the tip (a corner).
 * @param {object} o - {cx,cy (bulb centre), length (arc length centre to tip), width (bulb radius), bend=0.5 (turn, in half-turns), angle=-PI/2, n=10 nodes}.
 * @returns {number[][]} [n,6] closed-shape nodes.
 * @example teardropNodes({cx:0.5,cy:0.6,length:0.4,width:0.15,bend:0}).length // 10
 */
export function teardropNodes({ cx, cy, length, width, bend = 0.5, angle = -Math.PI / 2, n = 10 }) {
  finiteGeometry([cx, cy, length, width, bend, angle, n]);
  if (length <= 0 || width <= 0 || !Number.isInteger(n) || n < 6) throw new Error("teardropNodes needs positive size and n >= 6");
  const PROFILE_SCALE = 1.25, PROFILE_SHARPNESS = 0.6, DERIVATIVE_STEP = 1e-5, INTEGRATION_STEPS = 48;
  const heading = (s) => bend * Math.PI * Math.max(0, s) ** 2;
  const centre = (sigma) => { // local (a, b) of the centreline at arc distance sigma (negative = straight behind the bulb centre)
    if (sigma <= 0) return [sigma, 0];
    const steps = Math.ceil(INTEGRATION_STEPS * sigma / length), h = sigma / steps;
    let a = 0, b = 0;
    for (let i = 0; i < steps; i++) { const s = (i + 0.5) * h / length; a += Math.cos(heading(s)) * h; b += Math.sin(heading(s)) * h; }
    return [a, b];
  };
  const local = (t) => { // t in [0,2pi): tip at 0, bulb end at pi, right side first
    const u = t < Math.PI ? t : FULL_TURN - t, side = t < Math.PI ? 1 : -1, s = (1 - Math.cos(u)) / 2;
    const half = width * PROFILE_SCALE * Math.sin(u) * Math.sin(u / 2) ** PROFILE_SHARPNESS;
    const sigma = length - s * (length + width), psi = heading(sigma / length), [a, b] = centre(sigma);
    return [a - side * half * Math.sin(psi), b + side * half * Math.cos(psi)];
  };
  const c = Math.cos(angle), sn = Math.sin(angle), turn = (p, q) => [c * p - sn * q, sn * p + c * q];
  const step = FULL_TURN / n;
  return hermiteNodes(Array.from({ length: n }, (_, i) => {
    const t = step * i, [a1, b1] = local(t + DERIVATIVE_STEP), [a0, b0] = local(t - DERIVATIVE_STEP);
    const [x, y] = turn(...local(t)), [dx, dy] = i ? turn((a1 - a0) / (2 * DERIVATIVE_STEP), (b1 - b0) / (2 * DERIVATIVE_STEP)) : [0, 0];
    return [cx + x, cy + y, dx, dy];
  }), step);
}

/**
 * Pure function. Vertical-ish open curve from the top edge to the bottom edge through sway points,
 * both ends exactly on the box. Travelling downward, LEFT of travel is screen-right (east), so
 * `colors` lie on the east side and `rightColors` on the west.
 * @param {number} x0 - Top end x.
 * @param {number} x1 - Bottom end x.
 * @param {number[]} sways - x offsets at evenly spaced interior heights.
 * @returns {number[][]} [sways.length + 2, 6] nodes.
 * @example fallNodes(0.5, 0.5, [0.1]).length // 3
 */
export function fallNodes(x0, x1, sways) {
  finiteGeometry([x0, x1, ...sways]);
  const n = sways.length + 1;
  return catmullRomNodes([[x0, 0], ...sways.map((s, i) => [x0 + (x1 - x0) * (i + 1) / n + s, (i + 1) / n]), [x1, 1]]);
}

/**
 * Pure function. A 3x3 grid of clockwise quadrilateral cells (TL, TR, BR, BL) whose interior vertices are
 * jittered, each cell retreated toward its centroid by `gap` so pale seams separate neighbours. Rim vertices
 * slide only along the box edge, so every cell stays inside the unit box.
 * @param {number[][][]} jitter - [4][4][2] (dx,dy) offsets per grid vertex; dx is ignored on the left/right rim, dy on top/bottom.
 * @param {number} gap - Corner retreat distance.
 * @returns {number[][][]} [9][4][2] (x,y) corner lists, row-major.
 * @example iceCells(Array.from({length:4},()=>Array(4).fill([0,0])), 0)[4][0] // [1/3,1/3]
 */
export function iceCells(jitter, gap) {
  finiteGeometry([gap, ...jitter.flat(2)]);
  const at = (i, j) => [j / 3 + (j % 3 ? jitter[i][j][0] : 0), i / 3 + (i % 3 ? jitter[i][j][1] : 0)];
  return Array.from({ length: 9 }, (_, n) => {
    const i = Math.floor(n / 3), j = n % 3;
    const corners = [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)];
    const mx = corners.reduce((a, c) => a + c[0], 0) / 4, my = corners.reduce((a, c) => a + c[1], 0) / 4;
    return corners.map(([x, y]) => {
      const k = Math.min(1, gap / Math.hypot(mx - x, my - y));
      return [x + (mx - x) * k, y + (my - y) * k];
    });
  });
}

/**
 * Pure function. Left-to-right curve on the slanted line y = offset - slope*x, clipped to the unit box with
 * both ends exactly ON the box edge, bowed by `bow` (zero at the ends). `colors` lie above the curve.
 * @param {number} offset - y at x=0; must lie in (0, 1 + slope*(1-tiny)) so the clipped line is nondegenerate.
 * @param {number} slope - Positive descent (up-right rise) per unit x.
 * @param {number} bow - Peak sideways (y) bulge of the four-node curve.
 * @returns {number[][]} [4,6] nodes.
 * @example slantNodes(0.5, 0.3, 0).map((n) => n.slice(0, 2).map((v) => +v.toFixed(2)))[3] // [1,0.2]
 */
export function slantNodes(offset, slope, bow) {
  finiteGeometry([offset, slope, bow]);
  const x0 = offset > 1 ? (offset - 1) / slope : 0, x1 = offset - slope < 0 ? offset / slope : 1;
  if (!(x1 - x0 > 0.05)) throw new Error("slantNodes line is (nearly) outside the box");
  const pts = [0, 1, 2, 3].map((i) => {
    const t = i / 3, x = x0 + (x1 - x0) * t;
    return [x, offset - slope * x + bow * Math.sin(Math.PI * t)];
  });
  pts[0][1] = offset > 1 ? 1 : offset; // snap exactly onto the box edge
  pts[3][1] = offset - slope < 0 ? 0 : offset - slope;
  return catmullRomNodes(pts);
}
