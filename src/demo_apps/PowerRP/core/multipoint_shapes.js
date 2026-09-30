/**
 * Pure geometry for authoring native Multipoint paints: every helper returns [N,6]
 * node tuples [x,y,inX,inY,outX,outY] (relative handles) in the unit paint box, y down.
 * Shared by every preset family; family-specific shapes live in core/multipoint_presets/.
 */

const FULL_TURN = 2 * Math.PI;
// Eight cubic spans per turn keep spirals/waves editable without coarse corners.
const MAX_ANGLE_STEP = Math.PI / 4;
const QUARTER_CIRCLE_HANDLE = 4 * (Math.SQRT2 - 1) / 3;

/**
 * Pure function. Rejects nonfinite geometry before it can become stored data.
 * @param {number[]} values - Numeric geometry parameters.
 * @returns {void}
 * @example finiteGeometry([0.5, 0.25]) // undefined
 */
export function finiteGeometry(values) {
  if (!values.every(Number.isFinite)) throw new Error("Multipoint preset geometry must be finite");
}

/**
 * Pure function. Converts uniform Hermite samples to relative Bézier handles.
 * For parameter step h, outgoing = h·tangent/3, incoming = −outgoing.
 * @param {number[][]} samples - [N,4] tuples (x,y,dx/dt,dy/dt), e.g. [3,4].
 * @param {number} step - Positive spacing in the samples' parameter t.
 * @returns {number[][]} [N,6] tuples (x,y,inX,inY,outX,outY), e.g. [3,6].
 * @example hermiteNodes([[0,0,1,0],[1,1,1,2]], 1)[1] // [1,1,-1/3,-2/3,1/3,2/3]
 */
export function hermiteNodes(samples, step) {
  finiteGeometry([step]);
  if (step <= 0 || !samples.length) throw new Error("Hermite samples need a positive step and at least one sample");
  return samples.map((sample) => {
    if (sample.length !== 4) throw new Error("Hermite samples must be [x,y,dx/dt,dy/dt] tuples");
    finiteGeometry(sample);
    const [x, y, dx, dy] = sample;
    const hx = dx * step / 3, hy = dy * step / 3;
    finiteGeometry([hx, hy]);
    return [x, y, -hx, -hy, hx, hy];
  });
}

/**
 * Pure function. Four quarter-circle cubics, scaled to an axis-aligned ellipse.
 * Starts at the rightmost point; positive traversal is clockwise in screen space.
 * Close the feature rather than duplicating its first node. Maximum radial error
 * for a circle is below 0.000273 times its radius (not an exact rational circle).
 * @param {number} cx - Center x.
 * @param {number} cy - Center y.
 * @param {number} rx - Positive horizontal radius.
 * @param {number} ry - Positive vertical radius; defaults to rx.
 * @returns {number[][]} [4,6] anchor/relative-handle tuples.
 * @example ellipseNodes(0.5, 0.5, 0.25)[0].slice(0, 2) // [0.75,0.5]
 */
export function ellipseNodes(cx, cy, rx, ry = rx) {
  finiteGeometry([cx, cy, rx, ry]);
  if (rx <= 0 || ry <= 0) throw new Error("Ellipse radii must be positive");
  const kx = rx * QUARTER_CIRCLE_HANDLE, ky = ry * QUARTER_CIRCLE_HANDLE;
  const nodes = [
    [cx + rx, cy, 0, -ky, 0, ky],
    [cx, cy + ry, kx, 0, -kx, 0],
    [cx - rx, cy, 0, ky, 0, -ky],
    [cx, cy - ry, -kx, 0, kx, 0],
  ];
  finiteGeometry(nodes.flat());
  return nodes;
}

/**
 * Pure function. Cubic approximation of an Archimedean spiral with exact tangents.
 * r(t) = startRadius + (endRadius − startRadius)·t; θ(t) = phase + 2π·turns·t.
 * @param {object} options - {cx,cy,startRadius,endRadius,turns,phase=0}; turns signed, nonzero.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 9 nodes for one turn.
 * @example spiralNodes({cx:0.5,cy:0.5,startRadius:0.1,endRadius:0.4,turns:1})[0].slice(0,2) // [0.6,0.5]
 */
export function spiralNodes({ cx, cy, startRadius, endRadius, turns, phase = 0 }) {
  const sweep = FULL_TURN * turns, radialStep = endRadius - startRadius;
  finiteGeometry([cx, cy, startRadius, endRadius, sweep, radialStep, phase]);
  if (startRadius < 0 || endRadius < 0 || turns === 0) throw new Error("Spiral radii must be nonnegative and turns nonzero");
  const segments = Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP);
  const samples = Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments, r = startRadius + radialStep * t, angle = phase + sweep * t;
    const c = Math.cos(angle), s = Math.sin(angle);
    return [cx + r * c, cy + r * s, radialStep * c - r * sweep * s, radialStep * s + r * sweep * c];
  });
  return hermiteNodes(samples, 1 / segments);
}

/**
 * Pure function. Cubic approximation of a sine wave, including exact tangents.
 * x(t) = x0 + (x1 − x0)·t; y(t) = y + amplitude·sin(2π·cycles·t + phase).
 * @param {object} options - {x0,x1,y,amplitude,cycles=1,phase=0}; cycles may be signed or zero.
 * @returns {number[][]} [N,6] anchor/relative-handle tuples; 9 nodes for one cycle.
 * @example waveNodes({x0:0,x1:1,y:0.5,amplitude:0.2,cycles:0.5})[2].slice(0,2) // [0.5,0.7]
 */
export function waveNodes({ x0, x1, y, amplitude, cycles = 1, phase = 0 }) {
  const sweep = FULL_TURN * cycles, width = x1 - x0;
  finiteGeometry([x0, x1, y, amplitude, sweep, width, phase]);
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_ANGLE_STEP));
  const samples = Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments, angle = sweep * t + phase;
    return [x0 + width * t, y + amplitude * Math.sin(angle), width, amplitude * sweep * Math.cos(angle)];
  });
  return hermiteNodes(samples, 1 / segments);
}

/**
 * Pure function. Straight polyline: zero handles make every span a line segment.
 * @param {number[][]} points - [N,2] (x,y) anchors, N >= 1, e.g. [[0,1],[0,0],[1,0]].
 * @returns {number[][]} [N,6] anchor/relative-handle tuples.
 * @example polylineNodes([[0,1],[0,0]]) // [[0,1,0,0,0,0],[0,0,0,0,0,0]]
 */
export function polylineNodes(points) {
  if (!points.length || points.some((p) => p.length !== 2)) throw new Error("Polyline needs nonempty [x,y] points");
  finiteGeometry(points.flat());
  return points.map(([x, y]) => [x, y, 0, 0, 0, 0]);
}

/**
 * Pure function. Axis-aligned rectangle as four sharp corners, clockwise on screen
 * (top-left, top-right, bottom-right, bottom-left), so a two-sided feature's
 * rightColor lands INSIDE. Close the feature; the first corner is not repeated.
 * @param {number} x0 - Left edge.
 * @param {number} y0 - Top edge.
 * @param {number} x1 - Right edge, greater than x0.
 * @param {number} y1 - Bottom edge, greater than y0.
 * @returns {number[][]} [4,6] zero-handle tuples.
 * @example rectNodes(0.1, 0.2, 0.9, 0.8)[1] // [0.9,0.2,0,0,0,0]
 */
export function rectNodes(x0, y0, x1, y1) {
  finiteGeometry([x0, y0, x1, y1]);
  if (!(x1 > x0 && y1 > y0)) throw new Error("rectNodes needs x1 > x0 and y1 > y0");
  return polylineNodes([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
}

/**
 * Pure function. Smooth Catmull–Rom curve through points, as editable cubic nodes.
 * Tangent at p_i = (p_{i+1} − p_{i−1})/2; open ends use the one-sided difference.
 * @param {number[][]} points - [N,2] (x,y) anchors, N ≥ 2.
 * @param {boolean} closed - Wrap tangents around (close the feature too).
 * @returns {number[][]} [N,6] anchor/relative-handle tuples.
 * @example catmullRomNodes([[0,0],[0.5,0.5],[1,0]])[1] // [0.5,0.5,-1/6,0,1/6,0]
 */
export function catmullRomNodes(points, closed = false) {
  if (points.length < 2) throw new Error("catmullRomNodes needs at least two points");
  finiteGeometry(points.flat());
  const n = points.length;
  const at = (i) => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  return hermiteNodes(points.map(([x, y], i) => {
    const [a, b] = [at(i - 1), at(i + 1)];
    const span = closed || (i > 0 && i < n - 1) ? 2 : 1;
    return [x, y, (b[0] - a[0]) / span, (b[1] - a[1]) / span];
  }), 1);
}

/**
 * Pure function. Linear blend of two #rrggbb colours in encoded sRGB (authoring aid).
 * @param {string} a - Start colour, #rrggbb.
 * @param {string} b - End colour, #rrggbb.
 * @param {number} t - Blend fraction in [0,1]; 0 → a, 1 → b.
 * @returns {string} Lowercase #rrggbb.
 * @example mixHex("#000000", "#ffffff", 0.5) // "#808080"
 * @example mixHex("#ff0000", "#0000ff", 0.25) // "#bf0040"
 */
export function mixHex(a, b, t) {
  if (![a, b].every((c) => /^#[0-9a-f]{6}$/i.test(c)) || !(t >= 0 && t <= 1)) throw new Error(`mixHex needs #rrggbb colours and t in [0,1]: ${a} ${b} ${t}`);
  const channel = (c, i) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, "0")).join("");
}
