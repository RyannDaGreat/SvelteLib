/**
 * Geometry and paint helpers shared by the "Marbling" preset
 * family (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { finiteGeometry, catmullRomNodes, ellipseNodes, mixHex } from "../multipoint_shapes.js";
import { featurePolyline } from "../multipoint.js";

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
 * Pure function. Rotates and translates local node tuples (anchors AND relative handles) about the origin.
 * @param {number[][]} nodes - [N,6] local tuples.
 * @param {number} angle - Clockwise-on-screen radians.
 * @param {number[]} to - Destination [x, y] of the local origin.
 * @param {number} scale - Uniform scale.
 * @returns {number[][]} [N,6] placed tuples.
 * @example placeNodes([[1,0,0,0,0,0]], Math.PI/2, [0.5,0.5], 1)[0].slice(0,2) // [0.5,1.5]
 */
export function placeNodes(nodes, angle, [tx, ty], scale = 1) {
  finiteGeometry([angle, tx, ty, scale, ...nodes.flat()]);
  const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  const rot = (x, y) => [x * c - y * s, x * s + y * c];
  return nodes.map(([x, y, ix, iy, ox, oy]) => [...[rot(x, y)].map(([rx, ry]) => [rx + tx, ry + ty])[0], ...rot(ix, iy), ...rot(ox, oy)]);
}

/**
 * Pure function. A tulip in local coordinates (unit width and height, origin at the centre, tips up): three pointed
 * petal tips over a rounded belly, six nodes, clockwise on screen (rightColor is INSIDE).
 * @returns {number[][]} [6,6] tuples spanning x in [-0.5,0.5], y in [-0.5,0.5].
 * @example tulipNodes().length // 6
 */
export function tulipNodes() {
  return [
    [-0.5, -0.42, -0.2, 0.45, 0, 0],     // left tip; in-handle pulls the belly out
    [-0.2, -0.1, 0, 0, 0, 0],            // left notch
    [0, -0.5, 0, 0, 0, 0],               // centre tip
    [0.2, -0.1, 0, 0, 0, 0],             // right notch
    [0.5, -0.42, 0, 0, 0.2, 0.45],       // right tip; out-handle pulls the belly out
    [0, 0.5, 0.33, 0, -0.33, 0],         // bottom
  ];
}

/**
 * Pure function. A pointed lens (leaf, petal or slim stem) between two tips, bulging by `bulge` of its length to each
 * side and optionally bowed sideways (a crescent) and leaning. Two nodes, wound clockwise on screen (first arc a -> b
 * bulges to the left of travel), so rightColor is INSIDE.
 * @param {number[]} a - First tip [x, y].
 * @param {number[]} b - Second tip [x, y].
 * @param {number} bulge - Half-width as a fraction of the length.
 * @param {number} lean - Skews the widest point toward b (positive) or a (negative), fraction of length.
 * @param {number} bow - Curves the whole lens toward the left of travel (positive) by this fraction of its length.
 * @returns {number[][]} [2,6] tuples.
 * @example lensNodes([0,0],[1,0],0.2).length // 2
 */
export function lensNodes([ax, ay], [bx, by], bulge, lean = 0, bow = 0) {
  finiteGeometry([ax, ay, bx, by, bulge, lean, bow]);
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  if (!len) throw new Error("lensNodes needs distinct tips");
  const px = dy / len * len * 1.33, py = -dx / len * len * 1.33;   // unit left normal times 4/3 of the length
  const ux = dx * lean, uy = dy * lean;                          // shifts the widest point along the axis
  const up = [px * (bulge + bow) + ux, py * (bulge + bow) + uy], down = [px * (bow - bulge) + ux, py * (bow - bulge) + uy];
  return [[ax, ay, ...down, ...up], [bx, by, ...up, ...down]];
}

/**
 * Pure function. Non-uniform scale of node tuples about the origin (anchors and handles alike).
 * @param {number[][]} nodes - [N,6] tuples.
 * @param {number} sx - Horizontal factor.
 * @param {number} sy - Vertical factor.
 * @returns {number[][]} [N,6] tuples.
 * @example scaleNodes([[1,2,1,1,-1,-1]], 2, 3) // [[2,6,2,3,-2,-3]]
 */
export function scaleNodes(nodes, sx, sy) {
  finiteGeometry([sx, sy, ...nodes.flat()]);
  return nodes.map(([x, y, ix, iy, ox, oy]) => [x * sx, y * sy, ix * sx, iy * sy, ox * sx, oy * sy]);
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
 * from the box edges: the polygons are the drops of a stone/battal marbling separated by thin veins. Vertices run
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

/**
 * Pure function. A straight segment pushed through any point warp, as a smooth open Catmull-Rom curve. Ends that
 * the warp leaves on the box boundary stay on it. Walked from `from` to `to`.
 * @param {number[]} from - Start [x, y].
 * @param {number[]} to - End [x, y].
 * @param {number} samples - Anchor count >= 2.
 * @param {function} warp - [x, y] -> [x, y].
 * @returns {number[][]} [samples, 6] tuples with the unused end handles zeroed.
 * @example warpedLine([0,0.5],[1,0.5],3,(p) => p).map((n) => n[0]) // [0,0.5,1]
 */
export function warpedLine([x0, y0], [x1, y1], samples, warp) {
  if (!Number.isInteger(samples) || samples < 2) throw new Error("warpedLine needs at least two samples");
  return fitToBox(openEnds(boxHandles(catmullRomNodes(Array.from({ length: samples }, (_, j) => {
    const t = j / (samples - 1);
    return warp([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
  })))));
}

const FIT_SHRINK = 0.9, FIT_TRIES = 30, FIT_EPSILON = 1e-9;

/**
 * Pure function. Shrinks every handle by 10% at a time until the flattened curve lies inside the unit box (float
 * overshoot from Catmull-Rom or trig endpoints would otherwise enlarge the solve domain and blur the whole paint).
 * @param {number[][]} nodes - [N,6] tuples whose anchors lie inside the box.
 * @param {boolean} closed - Whether the curve is closed.
 * @returns {number[][]} [N,6] tuples.
 * @example fitToBox([[0,0,0,0,0.1,-0.1],[1,1,-0.1,0.1,0,0]]).length // 2
 */
export function fitToBox(nodes, closed = false) {
  let cur = nodes;
  for (let i = 0; i < FIT_TRIES; i++) {
    if (featurePolyline(cur, closed).every(([x, y]) => x >= -FIT_EPSILON && x <= 1 + FIT_EPSILON && y >= -FIT_EPSILON && y <= 1 + FIT_EPSILON)) return cur;
    cur = cur.map(([x, y, ix, iy, ox, oy]) => [x, y, ix * FIT_SHRINK, iy * FIT_SHRINK, ox * FIT_SHRINK, oy * FIT_SHRINK]);
  }
  throw new Error("fitToBox: curve cannot be contained (an anchor lies outside the box?)");
}

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

/**
 * Pure function. A teardrop / bell pointing DOWN: round top, sharp bottom tip, four nodes clockwise on screen
 * (rightColor INSIDE). Rings of different size about the same centre stay nested, tips separated.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} w - Full width.
 * @param {number} h - Full height.
 * @returns {number[][]} [4,6] closed tuples.
 * @example dropNodes(0.5,0.5,0.2,0.4)[2].slice(0,2) // [0.5,0.7]
 */
export function dropNodes(cx, cy, w, h) {
  finiteGeometry([cx, cy, w, h]);
  const k = 0.5523;
  return [
    [cx, cy - h / 2, -k * w / 2, 0, k * w / 2, 0],
    [cx + w / 2, cy - h * 0.1, 0, -k * h * 0.4, 0, h * 0.35],
    [cx, cy + h / 2, 0, 0, 0, 0],
    [cx - w / 2, cy - h * 0.1, 0, h * 0.35, 0, -k * h * 0.4],
  ];
}

/**
 * Pure function. A satin band for bandStack/ringStack: `base` lightened toward white on its leading edge, `deep` on
 * its trailing edge. Either may be a stop array (hue drift); the result keeps their length.
 * @param {string|string[]} base - Body colour(s).
 * @param {string|string[]} deep - Trailing-edge colour(s), defaults to base.
 * @param {number} lift - Fraction toward white on the leading edge, in [0,1].
 * @returns {{a: (string|string[]), b: (string|string[])}}
 * @example satin("#000000", "#000000", 0.5).a // "#808080"
 */
export function satin(base, deep = base, lift = 0.3) {
  const light = (c) => (Array.isArray(c) ? c.map((x) => mixHex(x, "#ffffff", lift)) : mixHex(c, "#ffffff", lift));
  return { a: light(base), b: deep };
}
