/**
 * Geometry and paint helpers shared by the "Generative art" and "3D gradients & renders" preset
 * families (2026-09-30 research frenzy; tree-shaken to what the kept presets use).
 */
import { catmullRomNodes, finiteGeometry, hermiteNodes } from "../multipoint_shapes.js";
import { offsetPoints } from "./fluid_materials.js";

const FULL_TURN = 2 * Math.PI;

/**
 * Pure function. Closed band along a centreline with SQUARE ends (a marker stroke / Fidenza ribbon), clockwise
 * on screen, so a two-sided feature's rightColor is the band's fill. Long sides are smooth Catmull-Rom curves,
 * the two caps are straight cuts perpendicular to the flow.
 * @param {number[][]} points - [N,2] centreline anchors, N >= 2.
 * @param {number[]} widths - [N] full widths > 0.
 * @returns {number[][]} [2N,6] tuples (close the feature).
 * @example flowBandNodes([[0.2,0.5],[0.8,0.5]], [0.1,0.1]).map((n) => n.slice(0, 2)) // [[0.2,0.45],[0.8,0.45],[0.8,0.55],[0.2,0.55]]
 */
export function flowBandNodes(points, widths) {
  if (points.length < 2 || widths.length !== points.length) throw new Error("flowBandNodes needs >= 2 anchors and one width per anchor");
  finiteGeometry([...points.flat(), ...widths]);
  const left = catmullRomNodes(offsetPoints(points, widths.map((w) => -w / 2)));
  const right = catmullRomNodes(offsetPoints(points, widths.map((w) => w / 2))).reverse().map(([x, y, ix, iy, ox, oy]) => [x, y, ox, oy, ix, iy]);
  const nodes = [...left, ...right];
  const last = left.length - 1, first = nodes.length - 1;
  nodes[0] = [...nodes[0].slice(0, 2), 0, 0, ...nodes[0].slice(4)];
  nodes[last] = [...nodes[last].slice(0, 4), 0, 0];
  nodes[last + 1] = [...nodes[last + 1].slice(0, 2), 0, 0, ...nodes[last + 1].slice(4)];
  nodes[first] = [...nodes[first].slice(0, 4), 0, 0];
  return nodes;
}

/**
 * Pure function. Closed ellipse of `count` Hermite cubics starting at angle `start`, optionally tilted; clockwise on screen.
 * The stop ramp of a two-sided feature begins at `start`, so this places where the light/shade colours sit.
 * @param {object} o - {cx, cy, rx, ry=rx, start=0, tilt=0, count=4}.
 * @returns {number[][]} [count,6] tuples (close the feature).
 * @example ringNodes({cx:0.5,cy:0.5,rx:0.25})[0].slice(0, 2) // [0.75,0.5]
 */
export function ringNodes({ cx, cy, rx, ry = rx, start = 0, tilt = 0, count = 4 }) {
  finiteGeometry([cx, cy, rx, ry, start, tilt, count]);
  if (rx <= 0 || ry <= 0 || count < 3) throw new Error("ringNodes needs positive radii and count >= 3");
  const step = FULL_TURN / count, c = Math.cos(tilt), s = Math.sin(tilt);
  return hermiteNodes(Array.from({ length: count }, (_, i) => {
    const a = start + step * i, u = rx * Math.cos(a), v = ry * Math.sin(a), du = -rx * Math.sin(a), dv = ry * Math.cos(a);
    return [cx + u * c - v * s, cy + u * s + v * c, du * c - dv * s, du * s + dv * c];
  }), step);
}

/**
 * Pure function. Places stop offsets on a feature copy.
 * @param {object} feature - Feature whose stop count matches offsets.
 * @param {number[]} offsets - Strictly increasing in [0,1].
 * @returns {object} Copy with new offsets.
 * @example withOffsets({stops:[{offset:0,color:"#000000",rightColor:"#000000"},{offset:1,color:"#fff",rightColor:"#fff"}]}, [0,0.4]).stops[1].offset // 0.4
 */
export function withOffsets(feature, offsets) {
  finiteGeometry(offsets);
  if (offsets.length !== feature.stops.length || offsets.some((o, i) => o < 0 || o > 1 || (i && o <= offsets[i - 1]))) throw new Error("withOffsets: bad offsets");
  return { ...feature, stops: feature.stops.map((s, i) => ({ ...s, offset: offsets[i] })) };
}

/**
 * Pure function. Anchors of a curve parallel to a spine, offset sideways by a fixed distance.
 * @param {function} spine - t in [0,1] -> [x, y].
 * @param {number} offset - Signed sideways distance; positive is to the walker's right on screen (below a left-to-right spine).
 * @param {number} t0 - First spine parameter.
 * @param {number} t1 - Last spine parameter.
 * @param {number} n - Anchor count >= 2.
 * @returns {number[][]} [n,2] anchors.
 * @example alongSpine((t) => [t, 0.5], 0.1, 0, 1, 2) // [[0,0.6],[1,0.6]]
 */
export function alongSpine(spine, offset, t0, t1, n) {
  finiteGeometry([offset, t0, t1, n]);
  if (n < 2) throw new Error("alongSpine needs n >= 2");
  const EPS = 1e-4;
  return Array.from({ length: n }, (_, i) => {
    const t = t0 + (t1 - t0) * i / (n - 1), [x, y] = spine(t);
    const [ax, ay] = spine(t - EPS), [bx, by] = spine(t + EPS), len = Math.hypot(bx - ax, by - ay);
    return [x - offset * (by - ay) / len, y + offset * (bx - ax) / len];
  });
}

/**
 * Pure function. Shrinks a spine parameter range [t0, t1] from whichever end sticks out until every anchor of a
 * parallel band (with half-width w/2 sideways) lies inside [margin, 1 - margin]^2. Lets a family of parallel
 * bands be authored as "as long as fits" instead of hand-cropped.
 * @param {function} spine - t in [0,1] -> [x, y].
 * @param {number} offset - Sideways offset, as alongSpine.
 * @param {number} w - Band full width.
 * @param {number} t0 - Desired first parameter.
 * @param {number} t1 - Desired last parameter.
 * @param {number} margin - Inset from the box edge.
 * @returns {number[]} [a, b] with t0 <= a < b <= t1.
 * @example fitRange((t) => [t, 0.5], 0, 0.1, -0.5, 1.5, 0.1) // [0.1, 0.9] (approximately)
 */
export function fitRange(spine, offset, w, t0, t1, margin) {
  finiteGeometry([offset, w, t0, t1, margin]);
  const STEP = 0.005, MIN_SPAN = 0.1;
  const inside = ([x, y]) => x >= margin && x <= 1 - margin && y >= margin && y <= 1 - margin;
  const endsOk = (t) => [-1, 1].every((side) => inside(alongSpine(spine, offset + side * w / 2, t, t + 1e-3, 2)[0]));
  let a = t0, b = t1;
  while (b - a > MIN_SPAN && !endsOk(a)) a += STEP;
  while (b - a > MIN_SPAN && !endsOk(b)) b -= STEP;
  if (b - a <= MIN_SPAN) throw new Error("fitRange: no room for a band at this offset");
  return [a, b];
}

/**
 * Pure function. Quadratic Bezier spine as a function of t (for alongSpine / fitRange).
 * @param {number[]} p0 - Start (x, y).
 * @param {number[]} p1 - Control (x, y).
 * @param {number[]} p2 - End (x, y).
 * @returns {function} t -> [x, y]; t outside [0,1] extrapolates along the same parabola.
 * @example quadSpine([0,0],[0.5,1],[1,0])(0.5) // [0.5,0.5]
 */
export function quadSpine(p0, p1, p2) {
  finiteGeometry([...p0, ...p1, ...p2]);
  return (t) => [0, 1].map((k) => (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * p1[k] + t * t * p2[k]);
}

/**
 * Pure function. A square (or rectangle) rotated about its centre, as four sharp corners, clockwise on screen
 * starting at the top-left corner of the unrotated shape.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} hw - Half width.
 * @param {number} hh - Half height.
 * @param {number} angle - Rotation in radians, clockwise on screen.
 * @param {number[][]} jitter - Optional [4,2] (dx, dy) corner displacements (default none).
 * @returns {number[][]} [4,2] corner points.
 * @example spunSquare(0.5, 0.5, 0.1, 0.1, 0).map((p) => p.map((v) => +v.toFixed(2))) // [[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6]]
 */
export function spunSquare(cx, cy, hw, hh, angle, jitter = [[0, 0], [0, 0], [0, 0], [0, 0]]) {
  finiteGeometry([cx, cy, hw, hh, angle, ...jitter.flat()]);
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v], i) => [cx + u * c - v * s + jitter[i][0], cy + u * s + v * c + jitter[i][1]]);
}

/**
 * Pure function. Orthographic projection of a unit cube after rotations about x, then y, then z.
 * Returns the three camera-facing faces as screen quads (clockwise on screen) with a brightness in [0,1]
 * from a light direction, so a preset can paint a "Mohr cube" by data rather than by hand.
 * @param {object} o - {cx, cy, size, rx, ry, rz, light=[-0.4,-0.7,0.6]}; size = cube edge length in the unit box.
 * @returns {{quad: number[][], shade: number}[]} Three faces, each quad [4,2].
 * @example cubeFaces({cx:0.5,cy:0.5,size:0.4,rx:0.6,ry:0.6,rz:0}).length // 3
 */
export function cubeFaces({ cx, cy, size, rx, ry, rz, light = [-0.4, -0.7, 0.6] }) {
  finiteGeometry([cx, cy, size, rx, ry, rz, ...light]);
  const rot = ([x, y, z]) => {
    let [a, b, c] = [x, y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)]; // about x
    [a, c] = [a * Math.cos(ry) + c * Math.sin(ry), -a * Math.sin(ry) + c * Math.cos(ry)]; // about y
    return [a * Math.cos(rz) - b * Math.sin(rz), a * Math.sin(rz) + b * Math.cos(rz), c]; // about z
  };
  const lightLen = Math.hypot(...light);
  const faces = [[[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]], [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]]];
  const half = size / 2;
  return faces.map(([normal, corners]) => ({ normal: rot(normal), corners: corners.map(rot) })).filter(({ normal }) => normal[2] > 0).map(({ normal, corners }) => {
    let quad = corners.map(([x, y]) => [cx + x * half, cy + y * half]);
    // Screen winding: make it clockwise on screen (y down) regardless of the face's own order.
    const area = quad.reduce((s, [x, y], i) => s + x * quad[(i + 1) % 4][1] - quad[(i + 1) % 4][0] * y, 0);
    if (area < 0) quad = quad.reverse();
    const shade = Math.max(0, (normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2]) / lightLen);
    return { quad, shade };
  });
}
