/**
 * Geometry and paint helpers for the "Marbling" preset module
 * (2026-09-30 research frenzy, round 4; tree-shaken to what the kept presets use).
 */
import { boundary } from "./builders.js";
import { finiteGeometry, catmullRomNodes, mixHex } from "../multipoint_shapes.js";
import { featurePolyline } from "../multipoint.js";
import { twirlPoint, coilNodes } from "./swirls.js";

const FULL_TURN = 2 * Math.PI;

/**
 * Pure function. Zigzag ("come and go") line across the box: one node per extremum with horizontal handles of
 * length `round` times the half-period, so round = 1/3 reads as a sine and round -> 0 as a sharp triangle wave.
 * @param {object} o - {y, amp, halves (half-period count >= 1), round=0.12, x0=0, x1=1, sign=1}; sign +1 starts on a
 *   crest below the midline y (y + amp, screen-down), -1 above it.
 * @returns {number[][]} [halves+1, 6] tuples, left to right.
 * @example zigzagNodes({y:0.5,amp:0.1,halves:2}).map((n) => +n[1].toFixed(2)) // [0.6,0.4,0.6]
 */
export function zigzagNodes({ y, amp, halves, round = 0.12, x0 = 0, x1 = 1, sign = 1 }) {
  finiteGeometry([y, amp, halves, round, x0, x1, sign]);
  if (!Number.isInteger(halves) || halves < 1) throw new Error("zigzagNodes needs a positive integer half-period count");
  const dx = (x1 - x0) / halves, hx = dx * round;
  return Array.from({ length: halves + 1 }, (_, i) => [x0 + dx * i, y + amp * sign * (i % 2 ? -1 : 1), -hx, 0, hx, 0]);
}

/**
 * Pure function. Scalloped ("combed") line: round humps on y with sharp tips of depth `depth` between them, as
 * dragged by a comb. Left to right, so `colors` lie above. depth > 0 points the tips down.
 * @param {object} o - {y, depth, teeth, hump=0.3 (hump handle, fraction of a tooth), tipX=0.12 (tip handle run),
 *   tipY=0.8 (tip handle rise as a fraction of depth), lean=0 (tip x-offset as fraction of half a tooth), x0=0, x1=1}.
 * @returns {number[][]} [2*teeth+1, 6] tuples.
 * @example scallopNodes({y:0.5,depth:0.1,teeth:2}).length // 5
 */
export function scallopNodes({ y, depth, teeth, hump = 0.3, tipX = 0.12, tipY = 0.8, lean = 0, x0 = 0, x1 = 1 }) {
  finiteGeometry([y, depth, teeth, hump, tipX, tipY, lean, x0, x1]);
  if (!Number.isInteger(teeth) || teeth < 1) throw new Error("scallopNodes needs a positive integer tooth count");
  const dx = (x1 - x0) / teeth, nodes = [[x0, y, 0, 0, dx * hump, 0]];
  for (let k = 0; k < teeth; k++) {
    nodes.push([x0 + dx * (k + 0.5 + lean * 0.5), y + depth, -dx * tipX, -depth * tipY, dx * tipX, -depth * tipY]);
    nodes.push([x0 + dx * (k + 1), y, -dx * hump, 0, dx * hump, 0]);
  }
  return nodes;
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
 * Pure function. Closed ring point set through n clockwise anchors r(theta) = radius(theta), as smooth closed nodes.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {function} radius - theta (screen radians, clockwise) -> radius pair [rx, ry].
 * @param {number} n - Anchor count >= 3.
 * @returns {number[][]} [n,6] closed Catmull-Rom tuples.
 * @example ringNodes(0.5,0.5,() => [0.2,0.2],4)[0].slice(0,2) // [0.7,0.5]
 */
export function ringNodes(cx, cy, radius, n) {
  finiteGeometry([cx, cy, n]);
  return catmullRomNodes(Array.from({ length: n }, (_, i) => {
    const a = FULL_TURN * i / n, [rx, ry] = radius(a);
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  }), true);
}

/**
 * Pure function. Rosette of round petals: sharp notches on radius r alternate with smooth petal tips on radius R,
 * each petal a single cubic pair (unlike lobedNodes, which is a Catmull-Rom blob). Clockwise on screen, so
 * rightColor is INSIDE. 2*lobes nodes.
 * @param {object} o - {cx, cy, lobes, R, r, phase=0 (angle of the first notch), squash=1, push=0.9 (notch handle, fraction of R-r),
 *   round=0.8 (tip handle, fraction of R*sin(pi/lobes))}.
 * @returns {number[][]} [2*lobes, 6] closed tuples.
 * @example petalRingNodes({cx:0.5,cy:0.5,lobes:4,R:0.2,r:0.03}).length // 8
 */
export function petalRingNodes({ cx, cy, lobes, R, r, phase = 0, squash = 1, push = 0.9, round = 0.8 }) {
  finiteGeometry([cx, cy, lobes, R, r, phase, squash, push, round]);
  if (!Number.isInteger(lobes) || lobes < 2) throw new Error("petalRingNodes needs at least two lobes");
  const h1 = (R - r) * push, h2 = R * Math.sin(Math.PI / lobes) * round, nodes = [];
  for (let i = 0; i < lobes; i++) {
    const an = phase + FULL_TURN * i / lobes, at = an + Math.PI / lobes;
    const [cn, sn, ct, st] = [Math.cos(an), Math.sin(an), Math.cos(at), Math.sin(at)];
    nodes.push([cx + r * cn, cy + squash * r * sn, h1 * cn, squash * h1 * sn, h1 * cn, squash * h1 * sn]);
    nodes.push([cx + R * ct, cy + squash * R * st, h2 * st, -squash * h2 * ct, -h2 * st, squash * h2 * ct]);
  }
  return nodes;
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

/**
 * Pure function. Composes point warps left to right.
 * @param {...function} warps - [x, y] -> [x, y].
 * @returns {function} The composite warp.
 * @example compose((p) => [p[0] + 1, p[1]], (p) => [p[0], p[1] * 2])([0, 1]) // [1,2]
 */
export const compose = (...warps) => (p) => warps.reduce((q, w) => w(q), p);

/**
 * Pure function. Twirl warp factory (see twirlPoint): rotation fades quadratically to zero at `radius`. Keep the
 * disc inside the unit box (cx +- radius) so box-edge line ends never move.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} radius - Fade radius.
 * @param {number} angle - Radians at the centre, clockwise on screen.
 * @returns {function} [x, y] -> [x, y].
 * @example twirl(0.5, 0.5, 0.2, 1)([0.9, 0.5]) // [0.9,0.5]
 */
export const twirl = (cx, cy, radius, angle) => (p) => twirlPoint(p, { cx, cy, radius, angle });

/**
 * Pure function. Horizontal lines at heights `ys`, each pushed through `warp` and stacked with bandStack.
 * @param {number[]} ys - Line heights.
 * @param {function} warp - Point warp fixing the box edge.
 * @param {number} samples - Anchors per line.
 * @param {Array} bands - ys.length + 1 bands.
 * @returns {object[]} Features.
 * @example flowBands([0.5], (p) => p, 3, ["#000000", "#ffffff"]).length // 1
 */
export const flowBands = (ys, warp, samples, bands) => bandStack(ys.map((y) => warpedLine([0, y], [1, y], samples, warp)), bands);

/**
 * Pure function. An organic closed cell: elliptical radii wobbled by two harmonics, n smooth clockwise anchors.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Horizontal radius.
 * @param {number} ry - Vertical radius.
 * @param {number} wobble - Relative radius wobble (0 = plain ellipse).
 * @param {number} phase - Wobble phase, radians.
 * @param {number} n - Anchor count.
 * @returns {number[][]} [n,6] closed tuples.
 * @example blob(0.5, 0.5, 0.2, 0.2, 0, 0, 4).length // 4
 */
export const blob = (cx, cy, rx, ry, wobble, phase, n = 5) => ringNodes(cx, cy, (a) => {
  const k = 1 + wobble * Math.sin(2 * a + phase) + 0.5 * wobble * Math.sin(3 * a + 2 * phase);
  return [rx * k, ry * k];
}, n);

/**
 * Pure function. Concentric organic rings, outermost first: one blob outline scaled by each factor, its centre
 * drifting linearly from `from` (outermost) to `to` (innermost) so the set reads as a hand-dropped ink series rather
 * than a bullseye. Nested as long as the drift per ring stays below the ring gap.
 * @param {object} o - {from:[x,y], to:[x,y], rx, ry, wobble, phase, n, scales}; scales descend from ~1.
 * @returns {number[][][]} one [n,6] closed node list per scale, clockwise on screen.
 * @example blobStack({from:[0.5,0.5],to:[0.5,0.5],rx:0.4,ry:0.4,wobble:0,phase:0,n:4,scales:[1,0.5]}).length // 2
 */
export function blobStack({ from, to, rx, ry, wobble, phase, n, scales }) {
  finiteGeometry([...from, ...to, rx, ry, wobble, phase, n, ...scales]);
  return scales.map((k, i) => {
    const t = scales.length > 1 ? i / (scales.length - 1) : 0;
    return fitToBox(blob(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, rx * k, ry * k, wobble, phase, n), true);
  });
}

/**
 * Pure function. A pointed "Gothic" arch standing on the tray floor (y = 1): three nodes, walked left to right so
 * `colors` lie OUTSIDE (above) and `rightColors` INSIDE. Both feet sit exactly on y = 1; the apex is sharp.
 * @param {number} cx - Apex x.
 * @param {number} halfWidth - Distance from apex column to each foot.
 * @param {number} apexY - Apex height (smaller is taller), in (0,1).
 * @param {number} lean - Apex shift as a fraction of halfWidth (positive leans right).
 * @param {number} belly - Fullness of the shoulders in [0,1]: 0 is a tent, 1 a round dome.
 * @returns {number[][]} [3,6] tuples, unused end handles zeroed.
 * @example archNodes(0.5, 0.2, 0.4)[0].slice(0, 2) // [0.3,1]
 */
export function archNodes(cx, halfWidth, apexY, lean = 0, belly = 0.5) {
  finiteGeometry([cx, halfWidth, apexY, lean, belly]);
  const h = 1 - apexY, ax = cx + lean * halfWidth;
  const rise = h * (0.25 + 0.5 * belly), run = halfWidth * (0.2 + 0.5 * belly), drop = h * (0.1 + 0.3 * (1 - belly));
  return [
    [cx - halfWidth, 1, 0, 0, 0, -rise],
    [ax, apexY, -run, drop, run, drop],
    [cx + halfWidth, 1, 0, -rise, 0, 0],
  ];
}

/**
 * Pure function. Deterministic 32-bit PRNG (mulberry32) as a thunk returning floats in [0,1).
 * @param {number} seed - Integer seed.
 * @returns {function} () -> float in [0,1).
 * @example seeded(1)() === seeded(1)() // true
 */
export function seeded(seed) {
  finiteGeometry([seed]);
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure function. Jittered staggered lattice of points filling the unit box: row i holds `counts[i]` points at even
 * spacing, each shifted by a seeded fraction of the pitch. The seed fixes the layout, so it is safe to store.
 * @param {number} seed - Integer seed.
 * @param {number[]} counts - Points per row, e.g. [3,2,3,2]; rows are evenly spaced top to bottom.
 * @param {number} jitter - Max shift as a fraction of the row pitch.
 * @returns {{cx:number, cy:number, pitchX:number, pitchY:number}[]} Points in reading order.
 * @example latticeSites(1, [2, 1], 0).map((s) => [s.cx, s.cy]) // [[0.25,0.25],[0.75,0.25],[0.5,0.75]]
 */
export function latticeSites(seed, counts, jitter) {
  finiteGeometry([seed, jitter, ...counts]);
  const rand = seeded(seed), rows = counts.length;
  return counts.flatMap((n, i) => Array.from({ length: n }, (_, j) => {
    const pitchX = 1 / n, pitchY = 1 / rows;
    return { cx: (j + 0.5) * pitchX + (rand() - 0.5) * 2 * jitter * pitchX, cy: (i + 0.5) * pitchY + (rand() - 0.5) * 2 * jitter * pitchY, pitchX, pitchY };
  }));
}

/**
 * Pure function. Rotates a clockwise polygon so it starts at its rightmost vertex, matching the start of
 * `ellipseNodes`, so a three-stop inside ramp lights the same side of every cell.
 * @param {number[][]} poly - [M,2] clockwise vertices.
 * @returns {number[][]} Same vertices, rightmost first.
 * @example startRight([[0,0],[2,0],[1,1]])[0] // [2,0]
 */
export function startRight(poly) {
  const k = poly.reduce((best, p, i) => (p[0] > poly[best][0] ? i : best), 0);
  return [...poly.slice(k), ...poly.slice(0, k)];
}

/**
 * Pure function. Stacked lines between arbitrary box-edge endpoint pairs (e.g. tilted streams), each pushed through
 * `warp` and stacked with bandStack. Lines run left to right and must not cross.
 * @param {number[][][]} ends - One [[x0,y0],[x1,y1]] pair per line, first line on top.
 * @param {number} samples - Anchors per line.
 * @param {function} warp - Point warp that fixes the box edge.
 * @param {Array} bands - ends.length + 1 bands.
 * @returns {object[]} Features.
 * @example lineBands([[[0,0.5],[1,0.5]]], 3, (p) => p, ["#000000", "#ffffff"]).length // 1
 */
export const lineBands = (ends, samples, warp, bands) => bandStack(ends.map(([a, b]) => warpedLine(a, b, samples, warp)), bands);

/**
 * Pure function. Vertical swell warp: y shifts by a sine of x, fading to zero at the top and bottom edges (so box-edge
 * line ends never move).
 * @param {number} amp - Peak vertical shift at mid-height.
 * @param {number} cycles - Sine cycles across the box width.
 * @param {number} phase - Phase in cycles.
 * @returns {function} [x, y] -> [x, y].
 * @example swell(0.1, 1)([0.25, 0.5])[1] // 0.6
 */
export const swell = (amp, cycles, phase = 0) => ([x, y]) => {
  finiteGeometry([amp, cycles, phase, x, y]);
  return [x, y + amp * Math.sin(FULL_TURN * (x * cycles + phase)) * 4 * y * (1 - y)];
};

/**
 * Pure function. Parallel tilted stream endpoints for lineBands: line k runs from (0, y) to (1, y + drop).
 * @param {number[]} ys - Left-edge heights, top line first.
 * @param {number} drop - Right-edge height minus left-edge height (negative rises to the right).
 * @returns {number[][][]} One [[0,y],[1,y+drop]] pair per line.
 * @example tilted([0.4, 0.6], -0.2) // [[[0,0.4],[1,0.2]],[[0,0.6],[1,0.4]]]
 */
export const tilted = (ys, drop) => { finiteGeometry([drop, ...ys]); return ys.map((y) => [[0, y], [1, y + drop]]); };

/**
 * Pure function. Nested arches sharing one apex column, outermost first; each is the widest arch scaled about its feet's
 * base by `k` (apex height and half-width both scale), so they stay nested.
 * @param {number} cx - Apex column x.
 * @param {number} halfWidth - Outermost half-width.
 * @param {number} apexY - Outermost apex height (smaller is taller).
 * @param {number[]} scales - Descending scale factors, e.g. [1, 0.6].
 * @param {number} lean - Apex lean, see archNodes.
 * @param {number} belly - Shoulder fullness, see archNodes.
 * @returns {number[][][]} One [3,6] node list per scale.
 * @example fan(0.5, 0.2, 0.3, [1, 0.5]).length // 2
 */
export const fan = (cx, halfWidth, apexY, scales, lean = 0, belly = 0.5) =>
  scales.map((k) => archNodes(cx, halfWidth * k, 1 - (1 - apexY) * k, lean, belly));

/**
 * Pure function. `n` descending scale factors from 1 down to `floor`, evenly spaced (for blobStack / ring sets).
 * @param {number} n - Count >= 2.
 * @param {number} floor - Smallest factor in (0,1).
 * @returns {number[]} n factors.
 * @example scalesDown(3, 0.5) // [1,0.75,0.5]
 */
export const scalesDown = (n, floor) => { finiteGeometry([n, floor]); return Array.from({ length: n }, (_, i) => 1 - (1 - floor) * i / (n - 1)); };

/**
 * Pure function. Shaded stone cells: Voronoi drops netted by thin veins. Each cell is a closed two-sided feature with
 * the `vein` colour outside and an inside ramp [shade, mid, lit, shade] that starts at the rightmost vertex and runs
 * clockwise, so `lit` sits upper-left, `mid` lower-left and `shade` right: every cell is lit from the same side.
 * @param {number[][]} sites - [N,2] cell centres.
 * @param {number} gap - Vein width (>= 0.02; thinner gaps leak vein colour into the cells).
 * @param {number} round - Corner rounding in [0,1), see roundedPolygon.
 * @param {string[]} vein - Vein colours cycled over cells.
 * @param {function} bodyOf - cell index -> [lit, mid, shade] colours.
 * @returns {object[]} N closed features.
 * @example stoneSheet([[0.3,0.5],[0.7,0.5]], 0.04, 0.1, ["#000000"], () => ["#ffffff","#888888","#444444"]).length // 2
 */
export function stoneSheet(sites, gap, round, vein, bodyOf) {
  return voronoiCells(sites, gap, STONE_EDGE).map((cell, i) => {
    const [lit, mid, shade] = bodyOf(i), v = vein[i % vein.length];
    return boundary(roundedPolygon(startRight(cell), round), [v, v, v, v], [shade, mid, lit, shade], true);
  });
}

const STONE_EDGE = 0.006;

/**
 * Pure function. Concentric copies of one petal rosette (see petalRingNodes), outermost first and each scaled by a factor,
 * so they stay nested. The first petal tip points up.
 * @param {object} o - {cx, cy, lobes, R (outer tip radius), notch (notch radius / tip radius), scales, squash=1}.
 * @returns {number[][][]} One [2*lobes,6] closed node list per scale.
 * @example bloomRings({cx:0.5,cy:0.5,lobes:5,R:0.4,notch:0.3,scales:[1,0.5]}).length // 2
 */
export const bloomRings = ({ cx, cy, lobes, R, notch, scales, squash = 1 }) =>
  scales.map((k) => petalRingNodes({ cx, cy, lobes, R: R * k, r: R * k * notch, phase: -Math.PI / 2 - Math.PI / lobes, squash }));

/**
 * Pure function. Vertical streams at heights `xs`, walked bottom to top (so band i lies WEST of line i), each pushed
 * through `warp` and stacked with bandStack.
 * @param {number[]} xs - Line x positions, westmost first.
 * @param {number} samples - Anchors per line.
 * @param {function} warp - Point warp that fixes the box edge.
 * @param {Array} bands - xs.length + 1 bands, westmost first.
 * @returns {object[]} Features.
 * @example vlineBands([0.5], 3, (p) => p, ["#000000", "#ffffff"]).length // 1
 */
export const vlineBands = (xs, samples, warp, bands) => bandStack(xs.map((x) => warpedLine([x, 1], [x, 0], samples, warp)), bands);

/**
 * Pure function. Horizontal swell warp: x shifts by a sine of y, fading to zero at the left and right box edges.
 * @param {number} amp - Peak shift at mid-width.
 * @param {number} cycles - Sine cycles across the box height.
 * @param {number} phase - Phase in cycles.
 * @returns {function} [x, y] -> [x, y].
 * @example swell2(0.1, 1)([0.5, 0.25])[0] // 0.6
 */
export const swell2 = (amp, cycles, phase = 0) => ([x, y]) => {
  finiteGeometry([amp, cycles, phase, x, y]);
  return [x + amp * Math.sin(FULL_TURN * (y * cycles + phase)) * 4 * x * (1 - x), y];
};

const WHIRL_FADE_MID = 0.5;

/**
 * Pure function. A multi-arm marbled whirl: N interleaved two-sided spiral arms about one centre, phases 2pi*k/N, so
 * together they separate N colour channels (the nightingale-nest swirl of ebru). Going outward along a ray the arms
 * alternate, and each arm's OUTER side borders one channel and its INNER side the next: pass `order[k] = [outerRamp,
 * innerRamp]` and make arm k's inner ramp equal the outer ramp of the arm that follows it inward. The last two stops
 * of every ramp are blended toward `ground` (half, then fully) so arm ends dissolve into the surroundings instead of
 * leaving specks. Ramps must have >= 2 stops and equal length.
 * @param {object} o - {cx, cy, r0, r1, turns, order: [[outerRamp[], innerRamp[]], ...], ground: "#rrggbb"}; turns > 0 is clockwise outward.
 * @returns {object[]} One two-sided open feature per arm (ceil(4*turns)+1 nodes each).
 * @example whirlArms({cx:0.5,cy:0.5,r0:0.02,r1:0.4,turns:1,order:[[["#000000","#111111"],["#ffffff","#eeeeee"]],[["#ffffff","#eeeeee"],["#000000","#111111"]]],ground:"#888888"}).length // 2
 */
export function whirlArms({ cx, cy, r0, r1, turns, order, ground }) {
  finiteGeometry([cx, cy, r0, r1, turns]);
  if (!order.length) throw new Error("whirlArms needs at least one arm");
  const fade = (ramp) => [...ramp.slice(0, -2), mixHex(ramp.at(-2), ground, WHIRL_FADE_MID), ground];
  // A negative-turn coil runs counter-clockwise, which puts its OUTER side on the right of travel: swap the ramps.
  return order.map(([outer, inner], k) => {
    const [left, right] = turns > 0 ? [outer, inner] : [inner, outer];
    return boundary(coilNodes({ cx, cy, r0, r1, turns, phase: FULL_TURN * k / order.length }), fade(left), fade(right));
  });
}

/**
 * Pure function. Sawtooth comb line: `teeth` leaning teeth across the box, each rising slowly to a crest over the
 * fraction `lean` of its width and falling steeply over the rest. One node per extremum with horizontal handles
 * `round` times the local span, so round -> 0 gives sharp teeth. Left to right, y increasing downward, so
 * `colors` lie above.
 * @param {object} o - {y (valley line), amp (crest height above it), teeth, lean in (0,1), round=0.15}
 * @returns {number[][]} [2*teeth+1, 6] tuples whose end handles are zeroed.
 * @example sawNodes({y:0.5,amp:0.1,teeth:2,lean:0.75}).map((n) => +n[0].toFixed(3)) // [0,0.375,0.5,0.875,1]
 */
export function sawNodes({ y, amp, teeth, lean, round = 0.15 }) {
  finiteGeometry([y, amp, teeth, lean, round]);
  if (!Number.isInteger(teeth) || teeth < 1 || lean <= 0 || lean >= 1) throw new Error("sawNodes needs integer teeth >= 1 and lean in (0,1)");
  const w = 1 / teeth, nodes = [];
  for (let k = 0; k < teeth; k++) {
    nodes.push([k * w, y, 0, 0, 0, 0], [(k + lean) * w, y - amp, 0, 0, 0, 0]);
  }
  nodes.push([1, y, 0, 0, 0, 0]);
  return openEnds(nodes.map((n, i) => {
    const span = Math.min(i > 0 ? n[0] - nodes[i - 1][0] : Infinity, i < nodes.length - 1 ? nodes[i + 1][0] - n[0] : Infinity) * round;
    return [n[0], n[1], -span, 0, span, 0];
  }));
}

/**
 * Pure function. Uniform scale of node tuples about a centre (anchors and relative handles alike), for nested copies.
 * @param {number[][]} nodes - [N,6] tuples.
 * @param {number} k - Scale factor > 0.
 * @param {number[]} centre - [x, y] fixed point.
 * @returns {number[][]} [N,6] tuples.
 * @example scaleAbout([[1,0,0,0,0,0]], 0.5, [0,0])[0] // [0.5,0,0,0,0,0]
 */
export function scaleAbout(nodes, k, [cx, cy]) {
  finiteGeometry([k, cx, cy, ...nodes.flat()]);
  if (k <= 0) throw new Error("scaleAbout needs k > 0");
  return nodes.map(([x, y, ix, iy, ox, oy]) => [cx + (x - cx) * k, cy + (y - cy) * k, ix * k, iy * k, ox * k, oy * k]);
}

/**
 * Pure function. A paisley (boteh) outline: a round belly at the lower left tapering into a sharp tail that sweeps up
 * and curls to the right. Eight nodes, clockwise on screen (rightColor INSIDE), inside the unit box, with a sharp tip.
 * The centre returned is a point inside the belly from which every ray meets the outline once, so scaled copies about
 * it (scaleAbout) are properly nested.
 * @returns {{nodes: number[][], centre: number[]}}
 * @example botehNodes().nodes.length // 8
 */
export function botehNodes() {
  const pts = [[0.74, 0.1], [0.78, 0.36], [0.68, 0.64], [0.46, 0.88], [0.22, 0.78], [0.16, 0.52], [0.3, 0.3], [0.56, 0.3]];
  const nodes = catmullRomNodes(pts, true);
  nodes[0] = [nodes[0][0], nodes[0][1], 0, 0, 0, 0];
  return { nodes: fitToBox(nodes, true), centre: [0.46, 0.56] };
}

/**
 * Pure function. Rotates node tuples (anchors and relative handles) about a centre, clockwise on screen for positive angles.
 * @param {number[][]} nodes - [N,6] tuples.
 * @param {number} angle - Radians.
 * @param {number[]} centre - [x, y] fixed point.
 * @returns {number[][]} [N,6] tuples.
 * @example rotateAbout([[1,0,0,0,0,0]], Math.PI, [0,0])[0].map(Math.round) // [-1,0,0,0,0,0]
 */
export function rotateAbout(nodes, angle, [cx, cy]) {
  finiteGeometry([angle, cx, cy]);
  const c = Math.cos(angle), s = Math.sin(angle);
  const rot = (x, y) => [x * c - y * s, x * s + y * c];
  return nodes.map(([x, y, ix, iy, ox, oy]) => { const [rx, ry] = rot(x - cx, y - cy); return [cx + rx, cy + ry, ...rot(ix, iy), ...rot(ox, oy)]; });
}
