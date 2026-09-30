/**
 * Classic plane curves as exact parametric functions, plus the geometry helpers
 * that turn them into editable Multipoint nodes. Every curve is t ↦ [x, y, dx/dt,
 * dy/dt] in MATH coordinates (y up); `onScreen` maps one into the unit paint box.
 * The accuracy probes (check*.mjs) import these same curves.
 */
import { preset, boundary, point } from "./builders.js";
import { ellipseNodes, finiteGeometry, rectNodes } from "../multipoint_shapes.js";

const PI = Math.PI;

/**
 * Pure function. n evenly spaced parameters from a to b inclusive (an open curve's samples).
 * @param {number} a - First parameter.
 * @param {number} b - Last parameter.
 * @param {number} n - Sample count, at least 2.
 * @returns {number[]} [n] parameters.
 * @example linspace(0, 1, 5) // [0,0.25,0.5,0.75,1]
 */
export function linspace(a, b, n) {
  finiteGeometry([a, b, n]);
  if (!Number.isInteger(n) || n < 2) throw new Error("linspace needs an integer count of at least 2");
  return Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
}

/**
 * Pure function. n evenly spaced parameters covering one period, endpoint excluded (a closed curve's samples).
 * @param {number} start - First parameter.
 * @param {number} period - Positive parameter period.
 * @param {number} n - Sample count, at least 2.
 * @returns {number[]} [n] parameters.
 * @example cyclicSpace(0, 4, 4) // [0,1,2,3]
 */
export function cyclicSpace(start, period, n) {
  finiteGeometry([start, period, n]);
  if (!Number.isInteger(n) || n < 2 || period <= 0) throw new Error("cyclicSpace needs a positive period and an integer count of at least 2");
  return Array.from({ length: n }, (_, i) => start + period * i / n);
}

/**
 * Pure function. Cubic Hermite nodes at strictly increasing, possibly UNEVEN parameters.
 * Span i has step h_i = t_(i+1) − t_i; out_i = h_i·d_i/3 and in_(i+1) = −h_i·d_(i+1)/3, so each
 * span is the exact cubic Hermite interpolant (positions and tangents match the curve).
 * A zero derivative (a cusp) yields a zero handle, i.e. a sharp node. Open ends mirror
 * their single real handle, like hermiteNodes.
 * @param {function} curve - t ↦ [x, y, dx/dt, dy/dt].
 * @param {number[]} ts - [N] strictly increasing parameters; a closed curve omits the repeated endpoint.
 * @param {number} period - Closed: parameter period (the wrap span is ts[0] + period − ts[N−1]). Open: 0.
 * @returns {number[][]} [N,6] (x,y,inX,inY,outX,outY) tuples.
 * @example curveNodes((t) => [t, 0, 1, 0], [0, 3])[0] // [0,0,-1,-0,1,0]
 * @example curveNodes((t) => [t, t * t, 1, 2 * t], [0, 1, 3])[1] // [1,1,-1/3,-2/3,2/3,4/3]
 */
export function curveNodes(curve, ts, period = 0) {
  finiteGeometry([...ts, period]);
  if (ts.length < 2 || ts.some((t, i) => i && t <= ts[i - 1])) throw new Error("curveNodes needs at least two strictly increasing parameters");
  if (period && ts[0] + period <= ts.at(-1)) throw new Error("curveNodes: a closed period must exceed the parameter span");
  const steps = ts.slice(1).map((t, i) => t - ts[i]);
  if (period) steps.push(ts[0] + period - ts.at(-1));
  return ts.map((t, i) => {
    const sample = curve(t);
    finiteGeometry(sample);
    const [x, y, dx, dy] = sample;
    const hOut = steps[i] ?? steps[i - 1], hIn = i ? steps[i - 1] : period ? steps.at(-1) : steps[0];
    return [x, y, -dx * hIn / 3, -dy * hIn / 3, dx * hOut / 3, dy * hOut / 3];
  });
}

/**
 * Pure function. Closes an open chain whose last anchor returns to its first as ONE corner node.
 * The merged node keeps the arriving tangent as its in-handle and the departing one as its
 * out-handle — how a rose petal or lemniscate lobe meets itself at the origin at an angle.
 * @param {number[][]} nodes - [N,6] open chain with nodes[N−1] anchored on nodes[0], N ≥ 3.
 * @returns {number[][]} [N−1,6] nodes, to be stored with closed: true.
 * @example cornerLoop([[0,0,0,0,1,0],[1,1,0,0,0,0],[0,0,0,1,0,0]]) // [[0,0,0,1,1,0],[1,1,0,0,0,0]]
 */
export function cornerLoop(nodes) {
  if (nodes.length < 3) throw new Error("cornerLoop needs at least three nodes");
  const first = nodes[0], last = nodes.at(-1);
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-9) throw new Error("cornerLoop: the chain does not return to its first anchor");
  return [[first[0], first[1], last[2], last[3], first[4], first[5]], ...nodes.slice(1, -1).map((node) => [...node])];
}

/**
 * Pure function. Maps a math-space curve (y up) into the unit paint box (y down).
 * Rotation is counter-clockwise AS SEEN ON SCREEN; derivatives transform with the same linear map.
 * The flip keeps the picture upright, so a counter-clockwise math loop is still counter-clockwise
 * AS SEEN, and its LEFT side (a boundary's `color`) is its inside — the opposite of ellipseNodes,
 * which runs clockwise as seen and puts rightColor inside (verified by render).
 * @param {function} curve - t ↦ [x, y, dx/dt, dy/dt] in math coordinates.
 * @param {number} cx - Screen x of the math origin.
 * @param {number} cy - Screen y of the math origin.
 * @param {number|number[]} scale - Uniform scale, or [sx, sy].
 * @param {number} rotation - Radians, counter-clockwise on screen.
 * @returns {function} t ↦ [X, Y, dX/dt, dY/dt] in paint-box coordinates.
 * @example onScreen((t) => [t, 0, 1, 0], 0.5, 0.5, 0.25)(1) // [0.75,0.5,0.25,-0]
 * @example onScreen((t) => [0, t, 0, 1], 0.5, 0.5, 0.25)(1) // [0.5,0.25,0,-0.25]
 */
export function onScreen(curve, cx, cy, scale, rotation = 0) {
  const [sx, sy] = Array.isArray(scale) ? scale : [scale, scale];
  finiteGeometry([cx, cy, sx, sy, rotation]);
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return (t) => {
    const [x, y, dx, dy] = curve(t);
    return [cx + sx * (c * x - s * y), cy - sy * (s * x + c * y), sx * (c * dx - s * dy), -sy * (s * dx + c * dy)];
  };
}

/**
 * Pure function. A polar curve r(θ) as a Cartesian parametric curve in θ.
 * @param {function} radius - θ ↦ [r, dr/dθ].
 * @returns {function} θ ↦ [x, y, dx/dθ, dy/dθ].
 * @example polar(() => [2, 0])(Math.PI / 2).map((v) => Math.round(v)) // [0,2,-2,0]
 */
export function polar(radius) {
  return (theta) => {
    const [r, dr] = radius(theta), c = Math.cos(theta), s = Math.sin(theta);
    return [r * c, r * s, dr * c - r * s, dr * s + r * c];
  };
}

/**
 * Pure function. Rose (rhodonea) radius r = cos(kθ); one petal spans θ ∈ [−π/2k, π/2k].
 * @param {number} k - Petal frequency (odd k: k petals; even k: 2k petals).
 * @returns {function} θ ↦ [r, dr/dθ].
 * @example roseRadius(3)(0) // [1,-0]
 */
export function roseRadius(k) {
  finiteGeometry([k]);
  return (theta) => [Math.cos(k * theta), -k * Math.sin(k * theta)];
}

/**
 * Pure function. The Mandelbrot set's main cardioid c(t) = e^(it)/2 − e^(2it)/4, cusp at t = 0.
 * @param {number} t - Parameter in [0, 2π).
 * @returns {number[]} [x, y, dx/dt, dy/dt].
 * @example mandelbrotCardioid(0).slice(0, 2) // [0.25,0] (the cusp)
 */
export function mandelbrotCardioid(t) {
  return [Math.cos(t) / 2 - Math.cos(2 * t) / 4, Math.sin(t) / 2 - Math.sin(2 * t) / 4,
    -Math.sin(t) / 2 + Math.sin(2 * t) / 2, Math.cos(t) / 2 - Math.cos(2 * t) / 2];
}

/**
 * Pure function. Nephroid of a unit circle's reflection caustic: x = (3cos t − cos 3t)/4,
 * y = (3 sin t − sin 3t)/4. Cusps at t = 0, π; it touches the unit circle at t = ±π/2.
 * @param {number} t - Parameter.
 * @returns {number[]} [x, y, dx/dt, dy/dt].
 * @example nephroid(0) // [0.5,0,0,0]
 */
export function nephroid(t) {
  return [(3 * Math.cos(t) - Math.cos(3 * t)) / 4, (3 * Math.sin(t) - Math.sin(3 * t)) / 4,
    (-3 * Math.sin(t) + 3 * Math.sin(3 * t)) / 4, (3 * Math.cos(t) - 3 * Math.cos(3 * t)) / 4];
}

/**
 * Pure function. Lissajous figure x = sin(a·t + δ), y = sin(b·t).
 * @param {number} a - Horizontal frequency.
 * @param {number} b - Vertical frequency.
 * @param {number} delta - Horizontal phase.
 * @returns {function} t ↦ [x, y, dx/dt, dy/dt].
 * @example lissajous(1, 1, 0)(0) // [0,0,1,1]
 */
export function lissajous(a, b, delta) {
  finiteGeometry([a, b, delta]);
  return (t) => [Math.sin(a * t + delta), Math.sin(b * t), a * Math.cos(a * t + delta), b * Math.cos(b * t)];
}

/**
 * Pure function. Lemniscate of Bernoulli x = cos t/(1+sin²t), y = sin t·cos t/(1+sin²t), unit half-width.
 * Right lobe t ∈ [−π/2, π/2] (counter-clockwise), left lobe t ∈ [π/2, 3π/2] (clockwise); both pass the origin at 45°.
 * @param {number} t - Parameter.
 * @returns {number[]} [x, y, dx/dt, dy/dt].
 * @example lemniscate(0) // [1,0,-0,1]
 */
export function lemniscate(t) {
  const s = Math.sin(t), c = Math.cos(t), d = 1 + s * s;
  return [c / d, s * c / d, -s * (3 - s * s) / (d * d), (Math.cos(2 * t) * d - 2 * s * s * c * c) / (d * d)];
}

/**
 * Pure function. Logarithmic spiral radius r = e^(bθ); b = ln φ / (π/2) is the golden spiral (×φ per quarter turn).
 * @param {number} b - Growth rate per radian.
 * @returns {function} θ ↦ [r, dr/dθ].
 * @example logSpiralRadius(0.5)(0) // [1,0.5]
 */
export function logSpiralRadius(b) {
  finiteGeometry([b]);
  return (theta) => [Math.exp(b * theta), b * Math.exp(b * theta)];
}

/**
 * Pure function. Fermat's spiral r² = θ as ONE smooth curve through the origin:
 * s ↦ (s·cos s², s·sin s²); s < 0 is the opposite arm, so both arms interlock.
 * @param {number} s - Signed parameter; the arm has turned s²/2π turns at s.
 * @returns {number[]} [x, y, dx/ds, dy/ds].
 * @example fermatSpiral(0) // [0,0,1,0]
 */
export function fermatSpiral(s) {
  const c = Math.cos(s * s), n = Math.sin(s * s);
  return [s * c, s * n, c - 2 * s * s * n, n + 2 * s * s * c];
}

/**
 * Pure function. Involute of the unit circle, x = cos t + t·sin t, y = sin t − t·cos t (a cusp at t = 0).
 * @param {number} t - Unwound angle, t ≥ 0.
 * @returns {number[]} [x, y, dx/dt, dy/dt].
 * @example involute(0) // [1,0,0,0]
 */
export function involute(t) {
  return [Math.cos(t) + t * Math.sin(t), Math.sin(t) - t * Math.cos(t), t * Math.cos(t), t * Math.sin(t)];
}

/**
 * Pure function. Hypotrochoid (spirograph): x = (R−r)cos t + d·cos((R−r)t/r), y = (R−r)sin t − d·sin((R−r)t/r).
 * @param {number} R - Fixed ring radius.
 * @param {number} r - Rolling wheel radius.
 * @param {number} d - Pen distance from the wheel's centre.
 * @returns {function} t ↦ [x, y, dx/dt, dy/dt].
 * @example hypotrochoid(3, 1, 1)(0) // [3,0,0,0]  (d = r: a deltoid's cusp)
 */
export function hypotrochoid(R, r, d) {
  finiteGeometry([R, r, d]);
  const q = (R - r) / r;
  return (t) => [(R - r) * Math.cos(t) + d * Math.cos(q * t), (R - r) * Math.sin(t) - d * Math.sin(q * t),
    -(R - r) * Math.sin(t) - d * q * Math.sin(q * t), (R - r) * Math.cos(t) - d * q * Math.cos(q * t)];
}

/**
 * Pure function. Temple Fay's butterfly radius without its slow sin⁵ drift: r = e^(sin θ) − 2cos 4θ.
 * @param {number} theta - Polar angle.
 * @returns {number[]} [r, dr/dθ].
 * @example butterflyRadius(0) // [-1,1]
 */
export function butterflyRadius(theta) {
  const e = Math.exp(Math.sin(theta));
  return [e - 2 * Math.cos(4 * theta), Math.cos(theta) * e + 8 * Math.sin(4 * theta)];
}

/**
 * Pure function. Four cubics approximating the superellipse |x/rx|ⁿ + |y/ry|ⁿ = 1.
 * Axis tips and the four diagonal points 2^(−1/n) are exact, and so are the tip tangents:
 * perpendicular to the axis for n > 1 (rounded), along it for n < 1 (a concave star's cusp),
 * straight for n = 1 (a diamond). n = 2 reproduces ellipseNodes' circle handle 0.5523.
 * Clockwise on screen from the rightmost tip, like ellipseNodes, so rightColor is inside.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} rx - Positive horizontal radius.
 * @param {number} ry - Positive vertical radius.
 * @param {number} n - Positive exponent: 2/3 astroid, 1 diamond, 2 ellipse, 4 squircle.
 * @returns {number[][]} [4,6] anchor/relative-handle tuples.
 * @example superellipseNodes(0.5, 0.5, 0.25, 0.25, 2)[0].map((v) => +v.toFixed(4)) // [0.75,0.5,0,-0.1381,0,0.1381]
 * @example superellipseNodes(0.5, 0.5, 0.25, 0.25, 1)[0] // [0.75,0.5,0,0,0,0]
 */
export function superellipseNodes(cx, cy, rx, ry, n) {
  finiteGeometry([cx, cy, rx, ry, n]);
  if (rx <= 0 || ry <= 0 || n <= 0) throw new Error("Superellipse radii and exponent must be positive");
  // Cubic (1,0),(1,k),(k,1),(0,1) has midpoint (4+3k)/8; (1,0),(1−j,0),(0,1−j),(0,1) has (4−3j)/8.
  const diagonal = 2 ** (-1 / n), k = Math.max(0, (8 * diagonal - 4) / 3), j = Math.max(0, (4 - 8 * diagonal) / 3);
  const tangent = [k, j]; // (across-axis, along-axis) handle fractions at a tip; one is always zero
  const nodes = [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([ux, uy]) => {
    // Clockwise on screen: travel direction at tip (ux,uy) is (−uy, ux); the in-handle mirrors it.
    const ox = (-uy * tangent[0] - ux * tangent[1]), oy = (ux * tangent[0] - uy * tangent[1]);
    const ix = (uy * tangent[0] - ux * tangent[1]), iy = (-ux * tangent[0] - uy * tangent[1]);
    return [cx + rx * ux, cy + ry * uy, rx * ix, ry * iy, rx * ox, ry * oy];
  });
  finiteGeometry(nodes.flat());
  return nodes;
}

/**
 * Pure function. A root of f in [a, b] by bisection, where f(a) and f(b) differ in sign.
 * @param {function} f - Continuous scalar function.
 * @param {number} a - Bracket start.
 * @param {number} b - Bracket end.
 * @returns {number} x with |f(x)| at the double-precision floor of the bracket.
 * @example bisectRoot((x) => x * x - 2, 0, 2) // 1.414213562373095 (√2, within one ulp)
 */
export function bisectRoot(f, a, b) {
  finiteGeometry([a, b]);
  if (Math.sign(f(a)) === Math.sign(f(b))) throw new Error("bisectRoot needs a sign change across [a, b]");
  let lo = a, hi = b;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(f(mid)) === Math.sign(f(lo))) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Pure function. One closed loop of a curve that leaves and returns to the same point (a petal, a lobe).
 * @param {function} curve - t ↦ [x, y, dx/dt, dy/dt], with curve(a) and curve(b) coincident.
 * @param {number} a - Parameter where the loop leaves its corner.
 * @param {number} b - Parameter where it returns.
 * @param {number} samples - Samples including both ends; the loop keeps samples − 1 nodes.
 * @returns {number[][]} [samples−1, 6] nodes for a closed feature, cornered at curve(a).
 * @example loopNodes(onScreen(polar(roseRadius(2)), .5, .5, .4), -PI / 4, PI / 4, 5).length // 4
 */
export function loopNodes(curve, a, b, samples) {
  const nodes = curveNodes(curve, linspace(a, b, samples));
  const [x0, y0] = nodes[0], last = nodes.at(-1);
  last[0] = x0; last[1] = y0; // the two ends agree to rounding; snap so the corner is exact
  return cornerLoop(nodes);
}


/**
 * Pure function. Cassini oval |PF₁|·|PF₂| = b² with foci (±1, 0), for b ≥ 1 (one connected oval):
 * r² = cos 2θ + √(b⁴ − sin² 2θ). b = 1 is the lemniscate; b ≥ √2 is convex; between is a peanut.
 * @param {number} b - Product constant's square root, at least 1 (strictly above 1 keeps r > 0).
 * @returns {function} θ ↦ [r, dr/dθ].
 * @example cassiniRadius(Math.SQRT2)(PI / 2)[0] // 1
 */
export function cassiniRadius(b) {
  finiteGeometry([b]);
  if (b <= 1) throw new Error("cassiniRadius needs b > 1 (b ≤ 1 splits or pinches the oval)");
  return (theta) => {
    const s = Math.sin(2 * theta), c = Math.cos(2 * theta), root = Math.sqrt(b ** 4 - s * s);
    const r = Math.sqrt(c + root);
    return [r, (-2 * s - 2 * s * c / root) / (2 * r)];
  };
}

/**
 * Pure function. Limaçon of Pascal r = b + cos θ; b < 1 adds an inner loop (where r < 0).
 * @param {number} b - Offset; 0 is a circle through the origin, 1 the cardioid, above 1 a dimpled oval.
 * @returns {function} θ ↦ [r, dr/dθ].
 * @example limaconRadius(0.5)(0) // [1.5,-0]
 */
export function limaconRadius(b) {
  finiteGeometry([b]);
  return (theta) => [b + Math.cos(theta), -Math.sin(theta)];
}

/**
 * Pure function. ellipseNodes' four-cubic circle, but starting at any angle (so a ramp's origin can sit anywhere).
 * Clockwise as seen (screen angle increases, y down), so rightColor is inside.
 * @param {number} cx - Centre x.
 * @param {number} cy - Centre y.
 * @param {number} r - Positive radius.
 * @param {number} start - Screen angle of the first node, radians (0 = rightmost, π/2 = bottom).
 * @returns {number[][]} [4,6] anchor/relative-handle tuples.
 * @example circleNodes(0.5, 0.5, 0.25, 0)[0].map((v) => +v.toFixed(4)) // [0.75,0.5,0,-0.1381,0,0.1381]
 */
export function circleNodes(cx, cy, r, start) {
  finiteGeometry([cx, cy, r, start]);
  if (r <= 0) throw new Error("Circle radius must be positive");
  const k = r * 4 * (Math.SQRT2 - 1) / 3;
  return [0, 1, 2, 3].map((i) => {
    const a = start + i * PI / 2, c = Math.cos(a), s = Math.sin(a);
    return [cx + r * c, cy + r * s, k * s, -k * c, -k * s, k * c];
  });
}

/**
 * Pure function. A harmonograph trace: a Lissajous figure whose pendulums lose amplitude as e^(−λt).
 * x = e^(−λt)·sin(a·t + δ), y = e^(−λt)·sin(b·t).
 * @param {number} a - Horizontal frequency.
 * @param {number} b - Vertical frequency.
 * @param {number} delta - Horizontal phase.
 * @param {number} damping - Decay rate λ per unit t (0 is a plain Lissajous figure).
 * @returns {function} t ↦ [x, y, dx/dt, dy/dt].
 * @example dampedLissajous(1, 1, 0, 0)(0) // [0,0,1,1]
 */
export function dampedLissajous(a, b, delta, damping) {
  finiteGeometry([a, b, delta, damping]);
  return (t) => {
    const e = Math.exp(-damping * t), sx = Math.sin(a * t + delta), sy = Math.sin(b * t);
    return [e * sx, e * sy, e * (a * Math.cos(a * t + delta) - damping * sx), e * (b * Math.cos(b * t) - damping * sy)];
  };
}


// ---------------------------------------------------------------------------------------------
// Catalog. Every loop built with onScreen runs counter-clockwise as seen, so its INSIDE is `color`
// (first palette) and its OUTSIDE is rightColor; ellipseNodes/circleNodes/superellipseNodes/rectNodes
// run clockwise, so theirs is the reverse. Numbers are authored composition data.
// ---------------------------------------------------------------------------------------------
const GOLDEN_GROWTH = Math.log((1 + Math.sqrt(5)) / 2) / (PI / 2);
const GOLDEN_ANGLE = PI * (3 - Math.sqrt(5));
const BUTTERFLY_ZEROS = [[0.1, 0.3], [2.8, 3.0], [3.3, 3.5], [4.3, 4.5], [5, 5.2], [5.9, 6.1]]
  .map(([a, b]) => bisectRoot((t) => butterflyRadius(t)[0], a, b));
const FERMAT_END = Math.sqrt(2 * PI); // one full turn per arm
// u^0.65 spacing balances the slow centre against the fast rim (measured best; uniform-θ kinks the centre).
const FERMAT_ARM = linspace(0, 1, 7).slice(1).map((u) => FERMAT_END * u ** 0.65);
// The caustic stops short of the wall it grazes (at ±π/2): touching it leaks its colour onto the rim.
const CAUSTIC_REACH = PI / 2 - 0.3;
const CASSINI_SCALE = 0.46 / Math.sqrt(1 + 1.8 ** 2); // shared foci at ±1; the outermost oval (b = 1.8) fills the box
const PEARLS = [ // [lit, shade] per seed, gold at the heart of the head to violet at its rim
  ["#fff8e1", "#c9a46a"], ["#ffefc2", "#c98f4f"], ["#ffe0a8", "#c27a43"], ["#ffcf9c", "#b8653f"], ["#ffbd9a", "#a9523f"],
  ["#ffab9f", "#9a4248"], ["#fb9bb0", "#873a56"], ["#ec8fc4", "#733463"], ["#d58ad6", "#5f316e"], ["#b98ae0", "#4c2e74"]];
const PEARL_GROUND = ["#3d2352", "#382050", "#331d4c", "#2e1b48", "#291843", "#24163e", "#201339", "#1c1134", "#180f2f", "#150d2a"];

export const PRESETS = [
  // Placement: math origin at (0.72, 0.5), ×0.5. Period-2 disc: centre −1, radius 1/4 → (0.22, 0.5) r 0.125.
  // Period-3 bulbs (near-circles): centre −0.1226 ± 0.7449i, radius ≈ 0.095, tangent to the cardioid at t = ±2π/3.
  preset("mandelbrot-bulb", "Mandelbrot bulb", "The main cardioid and its bulbs: black inside, burning gold at the edge, cooling into navy.", [
    boundary(curveNodes(onScreen(mandelbrotCardioid, 0.72, 0.5, 0.5), cyclicSpace(0, 2 * PI, 8), 2 * PI),
      ["#07050f", "#150a26", "#07050f"], ["#fff2c4", "#ff9a4d", "#fff2c4"], true),
    boundary(ellipseNodes(0.22, 0.5, 0.125), ["#ff7a3d"], ["#07050f"], true),
    ...[0.1275, 0.8725].map((y) => boundary(ellipseNodes(0.6587, y, 0.0475), ["#ffc36e"], ["#07050f"], true)),
    boundary(rectNodes(0, 0, 1, 1), ["#0a1238"], null, true),
  ]),
  preset("cup-caustic", "Cup caustic", "Lamplight folded into a nephroid cusp on espresso, inside a lit cream cup.", [
    boundary(ellipseNodes(0.5, 0.5, 0.45), ["#1c2a38", "#1c2a38", "#1c2a38"], ["#d6c4ad", "#fffaf1", "#d6c4ad"], true),
    boundary(ellipseNodes(0.5, 0.5, 0.38), ["#c9b59b", "#f7eddd", "#c9b59b"], ["#4a2412", "#1f0e07", "#4a2412"], true),
    boundary(curveNodes(onScreen(nephroid, 0.5, 0.5, 0.38), linspace(-CAUSTIC_REACH, CAUSTIC_REACH, 7)),
      ["#3a1a0c", "#7a4220", "#3a1a0c"], ["#c77a3a", "#fff4d2", "#c77a3a"]),
  ]),
  preset("compass-rose", "Compass rose", "An eight-petal rhodonea, coral and sea-glass petals alternating on ink.", [
    ...Array.from({ length: 8 }, (_, i) => boundary(loopNodes(onScreen(polar(roseRadius(4)), 0.5, 0.5, 0.47, i * PI / 4), -PI / 8, PI / 8, 5),
      i % 2 ? ["#1f7f8f", "#c9fff2", "#1f7f8f"] : ["#b33a5e", "#ffd6c9", "#b33a5e"],
      i % 2 ? ["#101d3a", "#1d3a5a", "#101d3a"] : ["#1a1838", "#3a2450", "#1a1838"], true)),
    point(0.5, 0.5, "#fff0e8"),
  ]),
  preset("lissajous-weave", "Lissajous weave", "A 3:2 oscilloscope figure whose crossings weave ice-lit and midnight cells.", [
    boundary(curveNodes(onScreen(lissajous(3, 2, PI / 2), 0.5, 0.5, 0.42), cyclicSpace(0, 2 * PI, 12), 2 * PI),
      ["#9ff7ff", "#3fa9ff", "#c3a7ff", "#9ff7ff"], ["#050b1c", "#0a1430", "#110b2a", "#050b1c"], true),
  ]),
  // One feature per pendulum swing: the slightly detuned 1:1.08 pair drifts from circle to a flat
  // diagonal as it decays, and the two-sided pen line weaves wherever a later swing recrosses.
  preset("harmonograph-trace", "Harmonograph", "Three decaying pendulum swings, cream to violet, nested like agate.",
    [0, 1, 2].map((swing) => boundary(curveNodes(onScreen(dampedLissajous(1, 1.08, PI / 2, 0.05), 0.5, 0.5, 0.46),
      linspace(2 * PI * swing, 2 * PI * (swing + 1), 13)),
    [["#fbf1dc", "#f3d2a8", "#ecae96"], ["#ecae96", "#e58f9c", "#cf7fae"], ["#cf7fae", "#a77fc0", "#7f86c8"]][swing],
    [["#1d2a55", "#2d2d68", "#40306e"], ["#40306e", "#56306f", "#6a346c"], ["#6a346c", "#5a2f60", "#3a2450"]][swing]))),
  preset("lemniscate-lobes", "Lemniscate", "Bernoulli's infinity: an ember lobe and a lagoon lobe crossing at a spark.", [
    boundary(loopNodes(onScreen(lemniscate, 0.5, 0.5, 0.46, PI), -PI / 2, PI / 2, 7), ["#ff6b4a", "#ffe08a", "#ff6b4a"], ["#1a1030", "#2b1840", "#1a1030"], true),
    boundary(loopNodes(onScreen(lemniscate, 0.5, 0.5, 0.46), -PI / 2, PI / 2, 7), ["#1fb5a8", "#b8fff0", "#1fb5a8"], ["#1a1030", "#2b1840", "#1a1030"], true),
    point(0.5, 0.5, "#fff6e0"),
  ]),
  preset("superellipse-ladder", "Superellipse ladder", "Nested superellipses from a four-point star through circle to square.", [
    ...[[0.47, 10, "#161a45", "#3a3f9e"], [0.37, 4, "#232a6b", "#7b3fa8"], [0.28, 2, "#4a3196", "#d63c7c"],
      [0.195, 1, "#9b2d86", "#ff8a5c"], [0.125, 0.55, "#e0465e", "#ffd36b"]]
      .map(([r, n, outside, inside]) => boundary(superellipseNodes(0.5, 0.5, r, r, n), [outside], [inside], true)),
    point(0.5, 0.5, "#fff4c2"),
  ]),
  preset("golden-nautilus", "Golden nautilus", "Two turns of the golden spiral: blush nacre whorls shadowed in plum.", [
    boundary(curveNodes(onScreen(polar(logSpiralRadius(GOLDEN_GROWTH)), 0.41, 0.43, 0.64 / Math.exp(GOLDEN_GROWTH * 4 * PI), -PI / 4), linspace(0, 4 * PI, 13)),
      ["#fff6ec", "#ffd3bf", "#f0a08e"], ["#8a4a6e", "#5a2a52", "#2e1434"]),
  ]),
  preset("fermat-swirl", "Fermat swirl", "Fermat's double spiral splitting the square into interlocking navy and coral.", [
    boundary(curveNodes(onScreen(fermatSpiral, 0.5, 0.5, 0.5 / FERMAT_END), [...FERMAT_ARM.map((s) => -s).reverse(), 0, ...FERMAT_ARM]),
      ["#122046", "#2f8f9f", "#122046"], ["#f7d9b0", "#ff7f6a", "#f7d9b0"]),
  ]),
  preset("involute-turbine", "Involute turbine", "Five involute blades unwinding from a hub, each lit on one face.", [
    ...Array.from({ length: 5 }, (_, i) => boundary(curveNodes(onScreen(involute, 0.5, 0.5, 0.14, i * 2 * PI / 5), linspace(0, 3.2, 5)),
      ["#ffe2b8", "#ffa27f", "#a45a86"], ["#2e1840", "#51275f", "#a45a86"])),
    boundary(ellipseNodes(0.5, 0.5, 0.14), ["#51275f"], ["#fff3e0"], true),
  ]),
  preset("spirograph-star", "Spirograph star", "A 5:2 hypotrochoid star, its overlaps woven light and dark.", [
    boundary(curveNodes(onScreen(hypotrochoid(5, 2, 1.6), 0.5, 0.52, 0.47 / 4.6, PI / 2), cyclicSpace(0, 4 * PI, 12), 4 * PI),
      ["#ffd36b", "#ff5fa2", "#5fd8ff", "#ffd36b"], ["#1a0f3a", "#2a1450", "#0f1f45", "#1a0f3a"], true),
  ]),
  preset("fay-butterfly", "Fay butterfly", "Temple Fay's butterfly curve in morpho blue, each lobe its own wing.", [
    ...BUTTERFLY_ZEROS.map((a, i) => {
      const b = BUTTERFLY_ZEROS[i + 1] ?? BUTTERFLY_ZEROS[0] + 2 * PI, samples = i === 0 ? 9 : b - a > 0.8 ? 5 : 4;
      return boundary(loopNodes(onScreen(polar(butterflyRadius), 0.5, 0.6, 0.15), a, b, samples),
        i === 0 ? ["#1d6fd6", "#8ff0ff", "#1d6fd6"] : ["#2b2fa8", "#6fb8ff", "#2b2fa8"], ["#0c1024", "#0c1024", "#0c1024"], true);
    }),
  ]),
  preset("golden-pearls", "Golden pearls", "Ten pearls on Vogel's golden-angle spiral, lit from the upper left.",
    PEARLS.map(([lit, shade], n) => {
      const r = 0.13 * Math.sqrt(n + 0.6), a = n * GOLDEN_ANGLE, ground = PEARL_GROUND[n];
      return boundary(circleNodes(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), 0.035 + 0.009 * n, PI / 4),
        [ground, ground, ground], [shade, lit, shade], true);
    })),
  preset("cassini-ovals", "Cassini ovals", "Nested Cassini ovals around two foci, pinching from peanut to glowing twins.", [
    ...[[1.04, 12, "#ffd88a", "#ffb26b"], [1.2, 8, "#ff8f6a", "#f0677a"], [1.45, 8, "#d04f86", "#b2458f"], [1.8, 8, "#8a3a93", "#3b2270"]]
      .map(([b, n, inside, outside]) => boundary(curveNodes(onScreen(polar(cassiniRadius(b)), 0.5, 0.5, CASSINI_SCALE), cyclicSpace(0, 2 * PI, n), 2 * PI),
        [inside], [outside], true)),
    point(0.5 - CASSINI_SCALE, 0.5, "#fffbe6"), point(0.5 + CASSINI_SCALE, 0.5, "#fffbe6"),
  ]),
  preset("limacon-bulb", "Limaçon", "Pascal's limaçon standing upright: a cream seed glowing inside a mint bulb.", [
    boundary(curveNodes(onScreen(polar(limaconRadius(0.5)), 0.5, 0.8, 0.42, PI / 2), cyclicSpace(0, 2 * PI, 12), 2 * PI),
      ["#3fd0c9", "#fff3c8", "#fff3c8", "#3fd0c9"], ["#0b1a33", "#1f2f5a", "#1f2f5a", "#0b1a33"], true),
  ]),
];
