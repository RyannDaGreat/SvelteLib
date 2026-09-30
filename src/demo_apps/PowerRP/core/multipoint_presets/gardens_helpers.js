/**
 * Geometry and paint helpers for the "Gardens & petals" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { catmullRomNodes, finiteGeometry, hermiteNodes } from "../multipoint_shapes.js";

/**
 * Pure function. Zeroes the two unused end handles of an open curve (first in-handle, last out-handle).
 * @param {number[][]} nodes - [N,6] tuples.
 * @returns {number[][]} Copy with unused handles zeroed.
 * @example openEnds([[0,0,-1,0,1,0],[1,0,-1,0,1,0]]) // [[0,0,0,0,1,0],[1,0,-1,0,0,0]]
 */
export function openEnds(nodes) {
  return nodes.map((n, i) => [n[0], n[1], i === 0 ? 0 : n[2], i === 0 ? 0 : n[3], i === nodes.length - 1 ? 0 : n[4], i === nodes.length - 1 ? 0 : n[5]]);
}

/**
 * Pure function. Smooth open curve through [x,y] anchors with unused end handles zeroed.
 * @param {number[][]} points - [N,2] anchors, N >= 2.
 * @returns {number[][]} [N,6] tuples.
 * @example smoothOpen([[0,0],[0.5,0.5],[1,0]])[0] // [0,0,0,0,0.16666666666666666,0.16666666666666666]
 */
export const smoothOpen = (points) => openEnds(catmullRomNodes(points));

/**
 * Pure function. A stack of two-sided parallel curves whose bands take a colour from BOTH bounding curves, so each
 * band renders crisp. Curves run left to right (band i lies above curve i, band i+1 below it). A band is a colour, an
 * array of stops (colour drift along the curves), or {a, b}: `a` on its leading edge, `b` on its trailing edge.
 * @param {number[][][]} curves - M node lists.
 * @param {(string|string[]|{a:(string|string[]),b:(string|string[])})[]} bands - M + 1 bands.
 * @returns {object[]} M features.
 * @example bandStack([[[0,0.5,0,0,0,0],[1,0.5,0,0,0,0]]], ["#000000", "#ffffff"]).length // 1
 */
export function bandStack(curves, bands) {
  if (bands.length !== curves.length + 1) throw new Error("bandStack needs one more band colour than curves");
  const edge = (band, side) => (band && band.a !== undefined ? band[side] : band);
  const width = Math.max(...bands.flatMap((b) => [edge(b, "a"), edge(b, "b")]).map((c) => (Array.isArray(c) ? c.length : 1)));
  const fit = (c) => (Array.isArray(c) ? c : Array(width).fill(c));
  return curves.map((nodes, i) => boundary(openEnds(nodes), fit(edge(bands[i], "b")), fit(edge(bands[i + 1], "a"))));
}

/**
 * Pure function. Open curve nodes for the part of a parametric curve inside the unit box. The two ends are bisected to
 * the box boundary and snapped exactly onto it (so the solve domain never grows), end handles are zeroed.
 * @param {function} curve - t -> [x, y] (any smooth parametrisation).
 * @param {number} t0 - Start parameter.
 * @param {number} t1 - End parameter.
 * @param {number} spans - Cubic span count (>= 1) over the inside portion.
 * @returns {number[][]} [spans+1,6] tuples, walked in increasing t.
 * @example insideNodes((t) => [t, 0.5], -1, 2, 2).map((n) => n[0]) // [0,0.5,1]
 */
export function insideNodes(curve, t0, t1, spans) {
  finiteGeometry([t0, t1, spans]);
  const inside = (t) => { const [x, y] = curve(t); return x >= 0 && x <= 1 && y >= 0 && y <= 1; };
  const steps = 800, ts = Array.from({ length: steps + 1 }, (_, i) => t0 + (t1 - t0) * i / steps);
  const first = ts.findIndex(inside), last = steps - [...ts].reverse().findIndex(inside);
  if (first < 0) throw new Error("insideNodes: curve never enters the unit box");
  const edge = (a, b) => { // bisect between an outside t (a) and inside t (b)
    for (let k = 0; k < 60; k++) { const m = (a + b) / 2; if (inside(m)) b = m; else a = m; }
    return b;
  };
  const ta = first === 0 ? ts[0] : edge(ts[first - 1], ts[first]), tb = last === steps ? ts[steps] : edge(ts[last + 1], ts[last]);
  const snap = ([x, y]) => [Math.min(1, Math.max(0, Math.round(x * 1e9) / 1e9)), Math.min(1, Math.max(0, Math.round(y * 1e9) / 1e9))];
  const h = 1e-5, step = (tb - ta) / spans;
  const samples = Array.from({ length: spans + 1 }, (_, i) => {
    const t = ta + step * i, [x, y] = snap(curve(t));
    const [ax, ay] = curve(t - h), [bx, by] = curve(t + h);
    return [x, y, (bx - ax) / (2 * h), (by - ay) / (2 * h)];
  });
  return openEnds(hermiteNodes(samples, 1 / spans).map((n) => n.map((v) => v + 0)));
}

/**
 * Pure function. Elliptical curve t -> point, for insideNodes: centre (cx,cy), radii (rx,ry), angle t in radians
 * (0 = right, pi/2 = down; increasing t is clockwise on screen, so the centre lies to the RIGHT of travel).
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Horizontal radius.
 * @param {number} ry - Vertical radius.
 * @returns {function} t -> [x, y].
 * @example ellipseCurve(0.5,0.5,0.25,0.25)(0) // [0.75,0.5]
 */
export const ellipseCurve = (cx, cy, rx, ry) => (t) => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];

/**
 * Pure function. Where a ray from (cx,cy) at `angle` (screen radians, y down) leaves the unit box, snapped exactly to it.
 * @param {number} cx - Ray origin x, inside the box.
 * @param {number} cy - Ray origin y, inside the box.
 * @param {number} angle - Screen angle, 0 = right, pi/2 = down.
 * @returns {number[]} [x, y] on the box boundary.
 * @example boxHit(0.5, 0.5, 0) // [1,0.5]
 */
export function boxHit(cx, cy, angle) {
  finiteGeometry([cx, cy, angle]);
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const tx = ux > 1e-12 ? (1 - cx) / ux : ux < -1e-12 ? -cx / ux : Infinity, ty = uy > 1e-12 ? (1 - cy) / uy : uy < -1e-12 ? -cy / uy : Infinity;
  const t = Math.min(tx, ty), snap = (v) => Math.min(1, Math.max(0, Math.round(v * 1e9) / 1e9));
  return [snap(cx + ux * t), snap(cy + uy * t)];
}

/**
 * Pure function. An open curve running outward from radius r0 around (cx,cy) along `angle` to the box boundary, with
 * a sideways bow `bend` (fraction of its length) in the middle. Walked outward, so the LOWER-angle side is its left.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} angle - Screen angle of the ray.
 * @param {number} r0 - Start radius.
 * @param {number} [bend=0] - Sideways bow at mid-length, as a fraction of the length (positive = toward lower angles... see test).
 * @param {number} [spans=2] - Point count between ends is spans-1; spans >= 2.
 * @returns {number[][]} [spans+1,6] tuples.
 * @example rayNodes(0.5,0.5,0,0.1).map((n) => n.slice(0,2)) // [[0.6,0.5],[0.8,0.5],[1,0.5]]
 */
export function rayNodes(cx, cy, angle, r0, bend = 0, spans = 2) {
  finiteGeometry([r0, bend, spans]);
  const [ex, ey] = boxHit(cx, cy, angle), ux = Math.cos(angle), uy = Math.sin(angle);
  const sx = cx + ux * r0, sy = cy + uy * r0, len = Math.hypot(ex - sx, ey - sy);
  const pts = Array.from({ length: spans + 1 }, (_, i) => {
    const s = i / spans, off = bend * len * Math.sin(Math.PI * s);
    return i === 0 ? [sx, sy] : i === spans ? [ex, ey] : [sx + (ex - sx) * s - uy * off, sy + (ey - sy) * s + ux * off];
  });
  return smoothOpen(pts);
}

/**
 * Pure function. A palmate (maple-like) leaf outline: sharp tips, convex lobe flanks, V-shaped sinuses. Clockwise on
 * screen (rightColor INSIDE). Every flank is a cubic whose controls sit 0.4 of the way along the chord, pushed
 * sideways, away from the lobe's axis, by `bulge` x chord.
 * @param {object} o - {cx, cy, outer (tip radius), inner (sinus radius), lobes (>= 3), phase (first tip angle), bulge=0.25}.
 * @returns {number[][]} [2*lobes,6] tuples; close the feature.
 * @example mapleNodes({cx:0.5,cy:0.5,outer:0.3,inner:0.1,lobes:5,phase:0}).length // 10
 */
export function mapleNodes({ cx, cy, outer, inner, lobes, phase = 0, bulge = 0.25 }) {
  finiteGeometry([cx, cy, outer, inner, lobes, phase, bulge]);
  if (!(outer > inner && inner > 0) || !Number.isInteger(lobes) || lobes < 3) throw new Error("mapleNodes needs outer > inner > 0 and integer lobes >= 3");
  const half = Math.PI / lobes, pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  // Control offset (relative to `from`) for the flank from -> to; `side` = +1 bulges clockwise-of-axis, -1 counter-clockwise.
  const control = (from, to, a, side) => {
    const dx = to[0] - from[0], dy = to[1] - from[1], n = [-Math.sin(a) * side, Math.cos(a) * side];
    const along = 0.4, sign = Math.sign(-dy * n[0] + dx * n[1]) || 1, len = Math.hypot(dx, dy);
    return [dx * along + sign * (-dy / len) * bulge * len, dy * along + sign * (dx / len) * bulge * len];
  };
  const tips = Array.from({ length: lobes }, (_, i) => pt(outer, phase + 2 * half * i));
  const sinuses = Array.from({ length: lobes }, (_, i) => pt(inner, phase + 2 * half * i + half));
  return tips.flatMap((T, i) => {
    const a = phase + 2 * half * i, S = sinuses[i], Sprev = sinuses[(i + lobes - 1) % lobes], Tnext = tips[(i + 1) % lobes];
    const [ox, oy] = control(T, S, a, 1), [ix, iy] = control(T, Sprev, a, -1);
    const [sInX, sInY] = control(S, T, a, 1), [sOutX, sOutY] = control(S, Tnext, a + 2 * half, -1);
    return [[T[0], T[1], ix, iy, ox, oy], [S[0], S[1], sInX, sInY, sOutX, sOutY]];
  });
}
