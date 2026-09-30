/**
 * Geometry and paint helpers for the "Op art & spirals" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { polylineNodes, finiteGeometry, hermiteNodes, ellipseNodes } from "../multipoint_shapes.js";
import { sampledNodes } from "./swirls.js";

/**
 * Pure function. A vertical wave x = x0 + amp*sin(2*pi*cycles*u + phase), u = 1 - y, walked from the bottom edge to the
 * top edge, so a two-sided feature's rightColor lies EAST of it. Both ends land exactly on y = 1 and y = 0.
 * @param {object} o - {x0, amp, cycles, phase=0, spans}; spans = cubic span count (spans + 1 nodes).
 * @returns {number[][]} [spans+1, 6] tuples, end handles zeroed.
 * @example vWaveNodes({x0:0.5, amp:0.1, cycles:1, spans:4}).map((n) => +n[0].toFixed(2)) // [0.5,0.6,0.5,0.4,0.5]
 */
export function vWaveNodes({ x0, amp, cycles, phase = 0, spans }) {
  finiteGeometry([x0, amp, cycles, phase, spans]);
  const w = FULL_TURN * cycles;
  return openEnds(sampledNodes((u) => [x0 + amp * Math.sin(w * u + phase), 1 - u, amp * w * Math.cos(w * u + phase), -1], 0, 1, spans));
}

/**
 * Pure function. Positions of a geometric progression of gaps: n + 1 points from 0 to 1 whose successive gaps
 * multiply by `ratio` (ratio < 1 bunches toward the end, ratio > 1 toward the start).
 * @param {number} n - Gap count >= 1.
 * @param {number} ratio - Positive gap ratio.
 * @returns {number[]} n + 1 increasing positions, first exactly 0 and last exactly 1.
 * @example geometricStops(2, 1) // [0,0.5,1]
 * @example geometricStops(3, 2).map((v) => +v.toFixed(3)) // [0,0.143,0.429,1]
 */
export function geometricStops(n, ratio) {
  finiteGeometry([n, ratio]);
  if (!Number.isInteger(n) || n < 1 || ratio <= 0) throw new Error("geometricStops needs a positive integer n and ratio");
  const gaps = Array.from({ length: n }, (_, i) => ratio ** i), total = gaps.reduce((a, b) => a + b, 0);
  let acc = 0;
  return [0, ...gaps.map((g, i) => (i === n - 1 ? 1 : (acc += g / total)))];
}

/**
 * Pure function. Clockwise-on-screen regular polygon (or rotated square = diamond) with sharp corners, optionally
 * squashed, as closed-feature nodes (rightColor INSIDE).
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Horizontal circumradius.
 * @param {number} ry - Vertical circumradius.
 * @param {number} sides - Integer >= 3.
 * @param {number} rotation - Angle of the first vertex, screen radians (0 = right, -pi/2 = top).
 * @returns {number[][]} [sides, 6] zero-handle tuples.
 * @example polyNodes(0.5, 0.5, 0.4, 0.4, 4, -Math.PI / 2)[0].map((v) => +v.toFixed(2)) // [0.5,0.1,0,0,0,0]
 */
export function polyNodes(cx, cy, rx, ry, sides, rotation = -Math.PI / 2) {
  finiteGeometry([cx, cy, rx, ry, sides, rotation]);
  if (!Number.isInteger(sides) || sides < 3 || rx <= 0 || ry <= 0) throw new Error("polyNodes needs sides >= 3 and positive radii");
  return polylineNodes(Array.from({ length: sides }, (_, i) => {
    const a = rotation + FULL_TURN * i / sides;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  }));
}

/**
 * Pure function. Hue-shifted copy of a colour list: rotates the list left by k (palette phase for lamella stripes).
 * @param {string[]} colors - Palette.
 * @param {number} k - Rotation steps (may exceed length or be negative).
 * @returns {string[]} Rotated copy.
 * @example rotated(["a", "b", "c"], 1) // ["b","c","a"]
 */
export function rotated(colors, k) {
  const n = colors.length, s = ((k % n) + n) % n;
  return [...colors.slice(s), ...colors.slice(0, s)];
}

const FULL_TURN = 2 * Math.PI;

const DERIVATIVE_STEP = 1e-5;

/**
 * Pure function. A graph y = f(x) over x in [0,1] as cubic nodes (numeric tangents), walked left to right,
 * so `colors` lie ABOVE and `rightColors` BELOW. Endpoints land exactly on x = 0 and x = 1.
 * @param {function} f - x -> y in the unit box.
 * @param {number} spans - Positive integer cubic span count (spans + 1 nodes).
 * @returns {number[][]} [spans+1, 6] tuples.
 * @example graphNodes((x) => 0.5, 2).map((n) => n[0]) // [0,0.5,1]
 */
export function graphNodes(f, spans) {
  finiteGeometry([spans]);
  if (!Number.isInteger(spans) || spans < 1) throw new Error("graphNodes needs a positive integer span count");
  const h = DERIVATIVE_STEP;
  return hermiteNodes(Array.from({ length: spans + 1 }, (_, i) => {
    const x = i / spans, y = f(x);
    return [x, y, 1, (f(x + h) - f(x - h)) / (2 * h)];
  }), 1 / spans);
}

/**
 * Pure function. A stack of two-sided parallel curves whose bands take a colour from BOTH bounding curves, so each
 * band renders crisp. Curves must run left to right (or bottom to top for vertical bands): band i lies before
 * curve i (above / west), band i+1 after it. A band is a colour, an array of stops (a hue drift along the curves),
 * or {a, b}: colour `a` on its leading edge fading to `b` on its trailing edge (satin shading across the band).
 * @param {number[][][]} curves - M node lists.
 * @param {(string|string[]|{a:(string|string[]),b:(string|string[])})[]} bands - M + 1 bands.
 * @returns {object[]} M features.
 * @example bandStack([[[0,0.5,0,0,0,0],[1,0.5,0,0,0,0]]], ["#000000", {a: "#ffffff", b: "#888888"}]).length // 1
 */
export function bandStack(curves, bands) {
  if (bands.length !== curves.length + 1) throw new Error("bandStack needs one more band colour than curves");
  const edge = (band, side) => (band && band.a !== undefined ? band[side] : band);
  const width = Math.max(...bands.flatMap((b) => [edge(b, "a"), edge(b, "b")]).map((c) => (Array.isArray(c) ? c.length : 1)));
  const fit = (c) => (Array.isArray(c) ? c : Array(width).fill(c));
  return curves.map((nodes, i) => boundary(openEnds(nodes), fit(edge(bands[i], "b")), fit(edge(bands[i + 1], "a"))));
}

/**
 * Pure function. Zeroes the two unused end handles of an open curve (first in-handle, last out-handle), which would
 * otherwise reach outside the box.
 * @param {number[][]} nodes - [N,6] tuples.
 * @returns {number[][]} Copy with unused handles zeroed.
 * @example openEnds([[0,0,-1,0,1,0],[1,0,-1,0,1,0]]) // [[0,0,0,0,1,0],[1,0,-1,0,0,0]]
 */
export function openEnds(nodes) {
  return nodes.map((n, i) => [n[0], n[1], i === 0 ? 0 : n[2], i === 0 ? 0 : n[3], i === nodes.length - 1 ? 0 : n[4], i === nodes.length - 1 ? 0 : n[5]]);
}

/**
 * Pure function. Straight vertical line at x, walked bottom to top so rightColor lies EAST of it.
 * @param {number} x - Position.
 * @returns {number[][]} [2,6] tuples.
 * @example vLine(0.25) // [[0.25,1,0,0,0,0],[0.25,0,0,0,0,0]]
 */
export const vLine = (x) => [[x, 1, 0, 0, 0, 0], [x, 0, 0, 0, 0, 0]];

/** Pure function. Straight horizontal line at y, left to right (rightColor BELOW). @example hLine(0.5)[1] // [1,0.5,0,0,0,0] */
export const hLine = (y) => [[0, y, 0, 0, 0, 0], [1, y, 0, 0, 0, 0]];

/**
 * Pure function. A stack of nested closed two-sided rings, outermost first, whose bands take a colour from BOTH
 * bounding rings (crisp edges, satin shading inside a band). Rings must be wound clockwise on screen. band 0 lies
 * outside ring 0, band i+1 inside ring i; a band is a colour, stop array, or {a, b} (outer edge a, inner edge b).
 * @param {number[][][]} rings - M closed node lists, outermost first.
 * @param {(string|string[]|{a:(string|string[]),b:(string|string[])})[]} bands - M + 1 bands, outermost first.
 * @returns {object[]} M closed features.
 * @example ringStack([ellipseNodes(0.5,0.5,0.3)], ["#000000", "#ffffff"]).length // 1
 */
export function ringStack(rings, bands) {
  if (bands.length !== rings.length + 1) throw new Error("ringStack needs one more band than rings");
  const edge = (band, side) => (band && band.a !== undefined ? band[side] : band);
  const width = Math.max(...bands.flatMap((b) => [edge(b, "a"), edge(b, "b")]).map((c) => (Array.isArray(c) ? c.length : 1)));
  const fit = (c) => (Array.isArray(c) ? c : Array(width).fill(c));
  const closedRing = (colors) => (colors.length > 1 && colors[0] !== colors.at(-1) ? [...colors.slice(0, -1), colors[0]] : colors);
  return rings.map((nodes, i) => boundary(nodes, closedRing(fit(edge(bands[i], "b"))), closedRing(fit(edge(bands[i + 1], "a"))), true));
}
