/**
 * Finite-cut screened diffusion, in encoded-sRGB premultiplied RGBA.
 * Minimize ½ Σ_uncut (u_i−u_j)² + ½ Σ_sources m_i (u_i−color_i)².
 * Cell-centered no-flux square contains the unit box and all active source positions;
 * caller stretches that logical field to paint bounds, like radial gradients.
 *
 * Grid limitations: distinct crossings within one edge blend constraints. Subpixel
 * point disks use conservative bilinear mass lumping; a curve with no grid crossings
 * uses finite-length, normal-separated source quadrature, NOT an invented cut/line.
 * Refinement automatically restores disk support/cuts. Tiny regions and endpoint
 * singularities require resolution; algebraic convergence is not geometric accuracy.
 * Positive curves cut edges even at weak weight; exactly zero removes them entirely.
 * No clipping/quantization: bounded numerical undershoot survives in float output.
 *
 * The kernels (apply / jacobiSweep / restrict / prolong / vcycle / PCG) are written for
 * speed but perform the SAME floating-point operations in the SAME order as the
 * original straightforward loops, so output is bit-identical to them
 * (verified per texel on 17 fixtures at 128²..2048², 2026-09-30). Reordering a sum,
 * fusing across cells or changing precision changes every existing picture.
 */
import { featurePolyline, MULTIPOINT_CURVE_TOLERANCE } from './multipoint.js';

const CHANNELS = 4;
// Canonical polygon-excess budgets, tightened for source normals and knot-insertion
// stability (60 varied open/closed, subpixel/off-box fixtures in the solver harness).
const CURVE_TOLERANCE = MULTIPOINT_CURVE_TOLERANCE / 4096;
const RELATIVE_CURVE_TOLERANCE = MULTIPOINT_CURVE_TOLERANCE / 256;
const POINT_RADIUS = .04; // Original logical box units, independent of solve domain/grid.
const POINT_GAIN = 128; // Integrated point stiffness, calibrated by CPU prototype.
const CURVE_GAIN = 2048; // Robin conductance per original logical unit.
const JACOBI_DAMPING = .8; // Prototype's measured symmetric smoother.
const SMOOTH_STEPS = 2;
const BOTTOM_SIZE = 4;
const OUTPUT_SLACK = .01; // Larger violations are not credible premultiplied colors.
const CENTRE_SNAP = 1e-9; // Texels. Far above float noise (~1e-13 at 2048²), far below any authored offset.

/**
 * Pure function. Validate parsed features, then flatten using canonical geometry.
 * @param {object[]} features Parsed IR, nodes [N,6], straight RGBA stops [S,4].
 * @returns {object} Fresh normalized sources and original-unit square domain.
 * @example prepare([]) // {sources:[], domain:{x:0,y:0,w:1,h:1}}
 */
function prepare(features) {
  if (!Array.isArray(features)) throw new Error('Multipoint features must be an array');
  let scale = 1;
  for (const f of features) {
    if (!f || !Array.isArray(f.nodes) || !f.nodes.length || !Array.isArray(f.stops) || !f.stops.length)
      throw new Error('Multipoint source needs nonempty nodes and stops');
    const weight = f.weight === undefined ? 1 : f.weight;
    if (!Number.isFinite(weight) || weight < 0) throw new Error('Multipoint weight must be finite and nonnegative');
    for (const key of ['twoSided', 'closed']) if (f[key] !== undefined && typeof f[key] !== 'boolean') throw new Error(`Multipoint ${key} must be boolean`);
    for (const node of f.nodes) {
      if (!Array.isArray(node) || node.length !== 6 || !Array.from(node).every(Number.isFinite)) throw new Error('Multipoint nodes must be finite [x,y,inX,inY,outX,outY]');
      if (f.weight !== 0) for (const v of node) scale = Math.max(scale, Math.abs(v));
    }
    for (const [i, s] of f.stops.entries()) {
      if (!s || !Number.isFinite(s.offset) || s.offset < 0 || s.offset > 1 || (i && s.offset < f.stops[i - 1].offset)) throw new Error('Multipoint stop offsets must be sorted in [0,1]');
      for (const color of [s.color, ...(f.twoSided || s.rightColor !== undefined ? [s.rightColor] : [])]) {
        if (!Array.isArray(color) || color.length !== CHANNELS || !Array.from(color).every(v => Number.isFinite(v) && v >= 0 && v <= 1))
          throw new Error('Multipoint colors must be finite straight RGBA in [0,1]');
      }
    }
  }
  // Scale BEFORE geometry arithmetic: finite off-box coordinates must not overflow
  // canonical control-point sums merely because the author moved a source far away.
  const sources = features.filter(f => f.weight !== 0).map(f => {
    const nodes = f.nodes.map(n => n.map(v => v / scale));
    let extent = 0;
    for (const n of nodes) extent = Math.max(extent, Math.abs(n[0] - nodes[0][0]), Math.abs(n[1] - nodes[0][1]), ...n.slice(2).map(Math.abs));
    // Relative accuracy also protects tiny loops from collapsing to a zero chord.
    const tolerance = Math.min(CURVE_TOLERANCE / scale, RELATIVE_CURVE_TOLERANCE * extent);
    return {...f, weight:f.weight ?? 1, points:featurePolyline(nodes, f.closed, tolerance)};
  });
  let x = 0, y = 0, xmax = 1 / scale, ymax = 1 / scale;
  for (const f of sources) for (const p of f.points) {
    if (!p.every(Number.isFinite)) throw new Error('Multipoint geometry overflow');
    x = Math.min(x, p[0]); y = Math.min(y, p[1]); xmax = Math.max(xmax, p[0]); ymax = Math.max(ymax, p[1]);
  }
  const width = Math.max(xmax - x, ymax - y);
  const domain = {x: x * scale, y: y * scale, w: width * scale, h: width * scale};
  if (!Object.values(domain).every(Number.isFinite) || domain.w <= 0) throw new Error('Multipoint domain overflow');
  for (const f of sources) {
    const points = f.points.map(p => [(p[0] - x) / width, (p[1] - y) / width]);
    f.points = points.filter((p, i) => !i || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  }
  return {sources, domain};
}

/**
 * Pure function. Premultiply BEFORE interpolating; equal offsets are stable last-wins.
 * Left limit uses first coincident stop, exact/right limit uses last. Ends extend.
 * @param {object[]} stops Stable offset-sorted parsed stops, straight RGBA [S,4].
 * @param {number} t Normalized flattened arc length.
 * @param {string} side 'color' or 'rightColor'.
 * @returns {number[]} Premultiplied RGBA [4].
 * @example sampleStops([{offset:0,color:[1,0,0,1]},{offset:1,color:[0,1,0,0]}],.5,'color') // [.5,0,0,.5]
 */
function sampleStops(stops, t, side) {
  let i = 0;
  while (i + 1 < stops.length && stops[i + 1].offset <= t) i++;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  const u = a.offset === b.offset ? 0 : Math.max(0, Math.min(1, (t - a.offset) / (b.offset - a.offset)));
  return a[side].map((v, c) => {
    const av = c === 3 ? v : v * a[side][3], bv = c === 3 ? b[side][c] : b[side][c] * b[side][3];
    return av + u * (bv - av);
  });
}

/**
 * Pure function. Allocate private four-neighbor graph and (N,N,4) RGBA work arrays.
 * @param {number} n Grid side.
 * @returns {object} Fresh level, e.g. level(4).b has shape (4,4,4).
 * @example level(4).mass.length // 16
 */
function level(n) {
  const cells = n * n, length = cells * CHANNELS;
  return { n, mass: new Float64Array(cells), right: new Float64Array(cells), down: new Float64Array(cells), diag: new Float64Array(cells), b: new Float64Array(length), u: new Float64Array(length), temp: new Float64Array(length), residual: new Float64Array(length) };
}

/**
 * Command. Add one color constraint to private graph mass/RHS arrays.
 * @param {object} g Graph with RHS (N,N,4), e.g. (128,128,4).
 * @param {number} i Cell index.
 * @param {number} mass Constraint stiffness.
 * @param {number[]} color Premultiplied RGBA [4].
 * @returns {undefined}
 * @example constrain(level(4),0,1,[1,0,0,1]) // undefined; first mass becomes 1
 */
function constrain(g, i, mass, color) {
  g.mass[i] += mass;
  for (let c = 0; c < CHANNELS; c++) g.b[CHANNELS * i + c] += mass * color[c];
}

/**
 * Command. Conservatively deposit mass bilinearly onto clamped cell centers.
 * @param {object} g Private graph to mutate, RHS (N,N,4), e.g. (128,128,4).
 * @param {number[]} p Normalized (x,y) location [2].
 * @param {number} mass Integrated stiffness.
 * @param {number[]} color Premultiplied RGBA [4].
 * @returns {undefined}
 * @example splat(level(4),[.5,.5],8,[1,0,0,1]) // undefined; four cells get mass 2
 */
function splat(g, p, mass, color) {
  const x = Math.max(0, Math.min(g.n - 1, p[0] * g.n - .5)), y = Math.max(0, Math.min(g.n - 1, p[1] * g.n - .5));
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const i = Math.min(g.n - 1, iy + dy) * g.n + Math.min(g.n - 1, ix + dx);
    constrain(g, i, mass * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), color);
  }
}

/**
 * Command. Deposit fixed-logical-radius point; subpixel disks retain total mass.
 * @param {object} g Private graph to mutate, RHS (N,N,4), e.g. (128,128,4).
 * @param {object} f Prepared source; first PARSED stop defines a point, not side mean.
 * @param {number} width Original-unit domain width.
 * @returns {undefined}
 * @example addPoint(level(4),{points:[[.5,.5]],stops:[{offset:0,color:[1,0,0,1]}],weight:1},1) // undefined
 */
function addPoint(g, f, width) {
  const n = g.n, r = POINT_RADIUS * n / width, p = f.points[0], mass = POINT_GAIN * f.weight;
  const color = sampleStops([f.stops[0]], 0, 'color');
  if (r < 1) { splat(g, p, mass, color); return; }
  const entries = [];
  let sum = 0;
  for (let y = Math.max(0, Math.floor(p[1] * n - r)); y <= Math.min(n - 1, Math.ceil(p[1] * n + r)); y++) {
    for (let x = Math.max(0, Math.floor(p[0] * n - r)); x <= Math.min(n - 1, Math.ceil(p[0] * n + r)); x++) {
      const k = Math.max(0, 1 - ((x + .5 - p[0] * n) / r) ** 2 - ((y + .5 - p[1] * n) / r) ** 2) ** 2;
      if (k > 0) { entries.push([y * n + x, k]); sum += k; }
    }
  }
  for (const [i, k] of entries) constrain(g, i, mass * (k / sum), color);
}

/**
 * Pure function. Grid cell and in-cell fraction of one curve crossing, measured in
 * texels from cell centres along the crossing axis. A crossing ON a cell centre
 * (or within float noise of one) is resolved by one consistent symbolic
 * perturbation — the curve is treated as lying an infinitesimal step to the +x
 * side — so the horizontal and vertical passes agree on which side owns the
 * centre cell. Without it a sloped path through centres gave that cell BOTH side
 * colours and two uncut edges bridging the sides: a visible leak across the cut.
 * @param {number} crossing Crossing coordinate in texel units (cell centre = integer).
 * @param {boolean} northOfCentre True for a vertical-grid-line crossing of a segment
 *   with dx·dy > 0: the +x-perturbed curve passes just NORTH of the centre there.
 * @returns {number[]} [cell, fraction]: the crossing lies between cell and cell+1.
 * @example crossingCell(3.25, false) // [3, 0.25]
 * @example crossingCell(46.99999999999999, false) // [47, 0]
 * @example crossingCell(47, true) // [46, 1]
 */
function crossingCell(crossing, northOfCentre) {
  const centre = Math.round(crossing);
  if (Math.abs(crossing - centre) > CENTRE_SNAP) { const cell = Math.floor(crossing); return [cell, crossing - cell]; }
  return northOfCentre ? [centre - 1, 1] : [centre, 0];
}

/**
 * Command. Add finite two-sided cuts; unresolved curves get finite-length sources.
 * Screen-left is cross(tangent, offset)<0 (y points down); no endpoint rays.
 * @param {object} g Private graph to mutate, RHS (N,N,4), e.g. (128,128,4).
 * @param {object} f Prepared curve with normalized points [T,2].
 * @param {number} width Original-unit domain width.
 * @returns {undefined}
 * @example addCurve(level(4),{points:[[.2,.5],[.8,.5]],stops:[{offset:0,color:[1,0,0,1]}],weight:1},1) // undefined
 */
function addCurve(g, f, width) {
  const n = g.n, points = f.points, lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = lengths.reduce((a, b) => a + b, 0), right = f.twoSided ? 'rightColor' : 'color';
  if (!total) { addPoint(g, f, width); return; }
  let traveled = 0, crossings = 0;
  for (let k = 0; k < lengths.length; k++) {
    const a = points[k], b = points[k + 1], length = lengths[k], dx = b[0] - a[0], dy = b[1] - a[1];
    if (!length) continue;
    for (let axis = 0; axis < 2; axis++) {
      const along = 1 - axis, across = axis, delta = b[along] - a[along];
      if (!delta) continue;
      const first = Math.max(0, Math.ceil(Math.min(a[along], b[along]) * n - .5));
      const last = Math.min(n - 1, Math.floor(Math.max(a[along], b[along]) * n - .5));
      for (let line = first; line <= last; line++) {
        const t = ((line + .5) / n - a[along]) / delta;
        // Own shared vertices once, but BOTH finite open endpoints are included.
        if (t < 0 || t > 1 || (t === 1 && (f.closed || k < lengths.length - 1))) continue;
        const [cell, fraction] = crossingCell((a[across] + t * (b[across] - a[across])) * n - .5, axis === 1 && dx * dy > 0);
        if (cell < 0 || cell >= n - 1) continue;
        const s = (traveled + t * length) / total;
        const lc = sampleStops(f.stops, s, 'color'), rc = sampleStops(f.stops, s, right);
        const firstIsLeft = axis === 0 ? dy < 0 : dx > 0, i = axis === 0 ? line * n + cell : cell * n + line;
        const resistance = (n / CURVE_GAIN / width) / f.weight;
        (axis === 0 ? g.right : g.down)[i] = 0;
        constrain(g, i, 1 / (fraction + resistance), firstIsLeft ? lc : rc);
        constrain(g, i + (axis === 0 ? 1 : n), 1 / (1 - fraction + resistance), firstIsLeft ? rc : lc);
        crossings++;
      }
    }
    traveled += length;
  }
  traveled = 0;
  for (let k = 0; k < lengths.length; k++) {
    const a = points[k], b = points[k + 1], length = lengths[k];
    if (!length) continue;
    const boundary = [0, 1].some(axis => a[axis] === b[axis] && (a[axis] === 0 || a[axis] === 1));
    if (crossings && !boundary) { traveled += length; continue; }
    const start = traveled / total, end = (traveled + length) / total;
    const knots = [start, ...f.stops.map(s => s.offset).filter(s => s > start && s < end), end];
    // Split at color knots and at most one texel of arc: this also resolves paths
    // along the OUTER boundary, which have no interior grid-edge intersections.
    const normal = [(b[1] - a[1]) / length / (2 * n), -(b[0] - a[0]) / length / (2 * n)];
    for (let j = 1; j < knots.length; j++) {
      const span = knots[j] - knots[j - 1], steps = Math.ceil(span * total * n);
      for (let q = 0; q < steps; q++) {
        const s = knots[j - 1] + span * (q + .5) / steps, t = (s - start) * total / length;
        const center = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        const mass = CURVE_GAIN * f.weight * (span * total * width / steps);
        for (const side of [1, -1]) {
          // An outward-facing boundary color belongs OUTSIDE, not clamped inside.
          if (center.some((v, axis) => (v === 0 && side * normal[axis] < 0) || (v === 1 && side * normal[axis] > 0))) continue;
          splat(g, center.map((v, axis) => v + side * normal[axis]), mass, sampleStops(f.stops, s, side === 1 ? 'color' : right));
        }
      }
    }
    traveled += length;
  }
}

/**
 * Command. Form graph diagonal from edges and source mass.
 * @param {object} g Level whose diag is replaced.
 * @returns {undefined}
 * @example finishDiagonal(level(4)) // undefined
 */
function finishDiagonal(g) {
  const {n, mass, right, down, diag} = g;
  for (let i = 0; i < mass.length; i++) diag[i] = mass[i] + right[i] + down[i] + (i % n ? right[i - 1] : 0) + (i >= n ? down[i - n] : 0);
}

/**
 * Command. Build coarse operators; attach exact bottom Cholesky to bottom level.
 * @param {object} fine Finest graph (receives cholesky only when already bottom size).
 * @returns {object[]} Hierarchy (first entry references fine).
 * @example (() => { const g = level(4); g.mass.fill(1); finishDiagonal(g); return hierarchy(g).length; })() // 1
 */
function hierarchy(fine) {
  const levels = [fine];
  while (levels.at(-1).n > BOTTOM_SIZE) {
    const f = levels.at(-1), n = f.n / 2, c = level(n);
    for (let y = 0; y < f.n; y++) for (let x = 0; x < f.n; x++) {
      const i = y * f.n + x, j = (y >> 1) * n + (x >> 1);
      c.mass[j] += f.mass[i];
      // Coarse diffusion coefficient is a face average, reaction is a cell sum.
      if (x % 2) c.right[j] += f.right[i] / 2;
      if (y % 2) c.down[j] += f.down[i] / 2;
    }
    finishDiagonal(c);
    levels.push(c);
  }
  const g = levels.at(-1), count = g.n * g.n;
  const l = new Float64Array(count * count);
  for (let i = 0; i < count; i++) {
    l[i * count + i] = g.diag[i];
    if (i % g.n) l[i * count + i - 1] = -g.right[i - 1];
    if (i >= g.n) l[i * count + i - g.n] = -g.down[i - g.n];
  }
  for (let i = 0; i < count; i++) for (let j = 0; j <= i; j++) {
    let value = l[i * count + j];
    for (let k = 0; k < j; k++) value -= l[i * count + k] * l[j * count + k];
    if (i === j && value <= 0) throw new Error('coarse system not positive definite');
    l[i * count + j] = i === j ? Math.sqrt(value) : value / l[j * count + j];
  }
  g.cholesky = l;
  return levels;
}

/**
 * Command. Apply the four-channel graph Laplacian plus source diagonal:
 * out = A x, or out = b − A x when `b` is given (the fused residual).
 * Row/column loops replace per-cell `i % n` / `i >= n` tests; the arithmetic and
 * its order are unchanged (diag term, then left, right, up, down).
 * @param {object} g Graph.
 * @param {Float64Array} x (H,W,4) RGBA, e.g. (128,128,4).
 * @param {Float64Array} out Same shape, overwritten; must not alias x.
 * @param {Float64Array|null} b Optional right-hand side (H,W,4) for out = b − A x.
 * @returns {undefined}
 * @example apply(level(4),new Float64Array(64),new Float64Array(64)) // undefined
 */
function apply(g, x, out, b = null) {
  const {n, diag, right, down} = g, stride = CHANNELS * n;
  for (let y = 0, i = 0; y < n; y++) {
    for (let col = 0; col < n; col++, i++) {
      const j = CHANNELS * i, d = diag[i], left = col ? right[i - 1] : 0, up = y ? down[i - n] : 0, east = right[i], south = down[i];
      // Four fixed channels: test each neighbor once, not once per channel.
      let r0 = d * x[j], r1 = d * x[j + 1], r2 = d * x[j + 2], r3 = d * x[j + 3];
      if (left) { const k = j - CHANNELS; r0 -= left*x[k]; r1 -= left*x[k+1]; r2 -= left*x[k+2]; r3 -= left*x[k+3]; }
      if (east) { const k = j + CHANNELS; r0 -= east*x[k]; r1 -= east*x[k+1]; r2 -= east*x[k+2]; r3 -= east*x[k+3]; }
      if (up) { const k = j - stride; r0 -= up*x[k]; r1 -= up*x[k+1]; r2 -= up*x[k+2]; r3 -= up*x[k+3]; }
      if (south) { const k = j + stride; r0 -= south*x[k]; r1 -= south*x[k+1]; r2 -= south*x[k+2]; r3 -= south*x[k+3]; }
      if (b) { out[j] = b[j] - r0; out[j+1] = b[j+1] - r1; out[j+2] = b[j+2] - r2; out[j+3] = b[j+3] - r3; }
      else { out[j] = r0; out[j+1] = r1; out[j+2] = r2; out[j+3] = r3; }
    }
  }
}

/**
 * Command. Symmetric weighted-Jacobi smoothing of level.u, starting from u = 0.
 * Each sweep writes u + ω D⁻¹(b − A u) into level.temp and swaps the two arrays,
 * so level.u is replaced (not mutated in place). The first sweep from zero needs
 * no operator application: A·0 = 0 exactly, so it is ω D⁻¹ b.
 * @param {object} g Level with b (H,W,4), e.g. (128,128,4); u is overwritten.
 * @returns {undefined}
 * @example (() => { const g = level(4); g.diag.fill(1); smoothFromZero(g); return g.u[0]; })() // 0
 */
function smoothFromZero(g) {
  const {diag, b} = g, u = g.u;
  for (let i = 0; i < diag.length; i++) {
    const scale = JACOBI_DAMPING / diag[i], j = i * CHANNELS;
    u[j] = 0 + scale * b[j]; u[j+1] = 0 + scale * b[j+1]; u[j+2] = 0 + scale * b[j+2]; u[j+3] = 0 + scale * b[j+3];
  }
  for (let step = 1; step < SMOOTH_STEPS; step++) jacobiSweep(g);
}

/**
 * Command. SMOOTH_STEPS weighted-Jacobi sweeps from the current level.u.
 * @param {object} g Level with b and u (H,W,4), e.g. (128,128,4).
 * @returns {undefined}
 * @example (() => { const g = level(4); g.diag.fill(1); smooth(g); return g.u[0]; })() // 0
 */
function smooth(g) {
  for (let step = 0; step < SMOOTH_STEPS; step++) jacobiSweep(g);
}

/**
 * Command. One weighted-Jacobi sweep u ← u + ω D⁻¹(b − A u), fused into one pass
 * that writes level.temp and then swaps it with level.u.
 * @param {object} g Level with b and u (H,W,4), e.g. (128,128,4).
 * @returns {undefined}
 * @example (() => { const g = level(4); g.diag.fill(1); jacobiSweep(g); return g.u[0]; })() // 0
 */
function jacobiSweep(g) {
  const {n, diag, right, down, b} = g, x = g.u, out = g.temp, stride = CHANNELS * n;
  for (let y = 0, i = 0; y < n; y++) {
    for (let col = 0; col < n; col++, i++) {
      const j = CHANNELS * i, d = diag[i], left = col ? right[i - 1] : 0, up = y ? down[i - n] : 0, east = right[i], south = down[i];
      let r0 = d * x[j], r1 = d * x[j + 1], r2 = d * x[j + 2], r3 = d * x[j + 3];
      if (left) { const k = j - CHANNELS; r0 -= left*x[k]; r1 -= left*x[k+1]; r2 -= left*x[k+2]; r3 -= left*x[k+3]; }
      if (east) { const k = j + CHANNELS; r0 -= east*x[k]; r1 -= east*x[k+1]; r2 -= east*x[k+2]; r3 -= east*x[k+3]; }
      if (up) { const k = j - stride; r0 -= up*x[k]; r1 -= up*x[k+1]; r2 -= up*x[k+2]; r3 -= up*x[k+3]; }
      if (south) { const k = j + stride; r0 -= south*x[k]; r1 -= south*x[k+1]; r2 -= south*x[k+2]; r3 -= south*x[k+3]; }
      const scale = JACOBI_DAMPING / d;
      out[j] = x[j] + scale * (b[j] - r0); out[j+1] = x[j+1] + scale * (b[j+1] - r1);
      out[j+2] = x[j+2] + scale * (b[j+2] - r2); out[j+3] = x[j+3] + scale * (b[j+3] - r3);
    }
  }
  g.u = out; g.temp = x;
}

/**
 * Command. Restrict fine.residual into coarse.b: the exact adjoint of `prolong`.
 * Cell-center weights (.75², .75·.25, .25·.75, .25²), clamped at the border.
 * @param {object} fine Fine level (H,W,4).
 * @param {object} coarse Half-size level (H/2,W/2,4), e.g. 128² -> 64².
 * @returns {undefined}
 * @example restrict(level(8),level(4)) // undefined, zero residual restricts to zero
 */
function restrict(fine, coarse) {
  const n = fine.n, m = coarse.n, v = fine.residual, cb = coarse.b;
  cb.fill(0);
  for (let y = 0; y < n; y++) {
    const cy = y >> 1, ny = y % 2 ? Math.min(m - 1, cy + 1) : Math.max(0, cy - 1);
    for (let x = 0; x < n; x++) {
      const cx = x >> 1, nx = x % 2 ? Math.min(m - 1, cx + 1) : Math.max(0, cx - 1);
      const i = CHANNELS * (y * n + x), a = CHANNELS * (cy * m + cx), b = CHANNELS * (cy * m + nx), c = CHANNELS * (ny * m + cx), d = CHANNELS * (ny * m + nx);
      for (let ch = 0; ch < CHANNELS; ch++) {
        const r = v[i + ch];
        cb[a + ch] += .5625 * r; cb[b + ch] += .1875 * r;
        cb[c + ch] += .1875 * r; cb[d + ch] += .0625 * r;
      }
    }
  }
}

/**
 * Command. Add the bilinear (cell-center) interpolation of coarse.u into fine.u.
 * @param {object} fine Fine level (H,W,4).
 * @param {object} coarse Half-size level (H/2,W/2,4), e.g. 128² -> 64².
 * @returns {undefined}
 * @example prolong(level(8),level(4)) // undefined, zero correction adds zero
 */
function prolong(fine, coarse) {
  const n = fine.n, m = coarse.n, u = fine.u, cu = coarse.u;
  for (let y = 0; y < n; y++) {
    const cy = y >> 1, ny = y % 2 ? Math.min(m - 1, cy + 1) : Math.max(0, cy - 1);
    for (let x = 0; x < n; x++) {
      const cx = x >> 1, nx = x % 2 ? Math.min(m - 1, cx + 1) : Math.max(0, cx - 1);
      const i = CHANNELS * (y * n + x), a = CHANNELS * (cy * m + cx), b = CHANNELS * (cy * m + nx), c = CHANNELS * (ny * m + cx), d = CHANNELS * (ny * m + nx);
      for (let ch = 0; ch < CHANNELS; ch++)
        u[i + ch] += .5625 * cu[a + ch] + .1875 * cu[b + ch] + .1875 * cu[c + ch] + .0625 * cu[d + ch];
    }
  }
}

/**
 * Command. One symmetric multigrid V-cycle: level.u ← approximately A⁻¹ level.b.
 * Mutates hierarchy work vectors; level.u/temp may swap identity (read them fresh).
 * @param {object[]} levels Coarse hierarchy.
 * @param {number} index Current level.
 * @returns {undefined}
 * @example (() => { const g = level(4); g.mass.fill(1); finishDiagonal(g); vcycle(hierarchy(g),0); return g.u[0]; })() // 0
 */
function vcycle(levels, index) {
  const g = levels[index];
  if (index === levels.length - 1) {
    const l = g.cholesky, count = g.diag.length, u = g.u, b = g.b;
    for (let i = 0; i < count; i++) for (let ch = 0; ch < CHANNELS; ch++) {
      let v = b[CHANNELS * i + ch];
      for (let j = 0; j < i; j++) v -= l[i * count + j] * u[CHANNELS * j + ch];
      u[CHANNELS * i + ch] = v / l[i * count + i];
    }
    for (let i = count - 1; i >= 0; i--) for (let ch = 0; ch < CHANNELS; ch++) {
      let v = u[CHANNELS * i + ch];
      for (let j = i + 1; j < count; j++) v -= l[j * count + i] * u[CHANNELS * j + ch];
      u[CHANNELS * i + ch] = v / l[i * count + i];
    }
    return;
  }
  smoothFromZero(g);
  apply(g, g.u, g.residual, g.b);
  restrict(g, levels[index + 1]);
  vcycle(levels, index + 1);
  prolong(g, levels[index + 1]);
  smooth(g);
}

/**
 * Pure function. Euclidean dot product.
 * @param {TypedArray} a Vector.
 * @param {TypedArray} b Same-length vector.
 * @returns {number} Inner product.
 * @example dot([1,2],[3,4]) // 11
 */
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/**
 * Pure function. True iff every element is finite.
 * @param {ArrayLike<number>} values Numeric vector.
 * @returns {boolean}
 * @example allFinite([1, 2]) // true
 * @example allFinite([1, Infinity]) // false
 */
function allFinite(values) { for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false; return true; }

/**
 * Pure function. The square solve domain solveMultipoint uses for these features:
 * the bounding square of the unit paint box and every active source, in paint-box
 * units. Lets a caller size the grid from the domain's device span before solving.
 * @param {object[]} features Same parsed features solveMultipoint accepts (validated).
 * @returns {{x:number,y:number,w:number,h:number}} Square domain, w === h >= 1.
 * @example multipointDomain([]) // {x:0,y:0,w:1,h:1}
 * @example multipointDomain([{nodes:[[1.5,.5,0,0,0,0]],stops:[{offset:0,color:[1,0,0,1]}]}]).w // 1.5 (off-box point widens the square)
 */
export function multipointDomain(features) { return prepare(features).domain; }

/**
 * Pure function. Solve parsed Multipoint features without DOM, cache or input mutation.
 * Unit-box geometry is isotropic; caller maps returned domain back to paint bounds.
 * @param {object[]} features Visible IR features: nodes [N,6], independent stops
 *   {offset,color:[R,G,B,A],rightColor:[R,G,B,A]}, twoSided, closed, weight.
 *   Straight encoded-sRGB colors in [0,1]; coordinates may be any finite number
 *   whose containing square is representable. Zero weight is exactly inactive.
 * @param {object} options Power-of-two size >=4, positive tolerance, maxIterations>=1.
 * @returns {object} {pixels:Float32Array,size,domain:{x,y,w,h},iterations,
 *   relativeResidual,converged}. Pixels (H,W,4), e.g. (128,128,4), are row-major
 *   PREMULTIPLIED encoded-sRGB RGBA, never 8-bit. Residual is recomputed in Float64
 *   before output rounding. Caller MUST report converged:false; never hide it.
 * @example solveMultipoint([{nodes:[[.5,.5,0,0,0,0]],stops:[{offset:0,color:[1,0,0,.5]}]}]).pixels.slice(0,4) // Float32Array [.5,0,0,.5]
 */
export function solveMultipoint(features, {size = 128, tolerance = 1e-5, maxIterations = 160} = {}) {
  if (!Number.isInteger(size) || size < BOTTOM_SIZE || !Number.isInteger(Math.log2(size))) throw new Error('Multipoint size must be a power of two >= 4');
  if (!Number.isFinite(tolerance) || tolerance <= 0 || !Number.isInteger(maxIterations) || maxIterations < 1) throw new Error('invalid solve tolerance/iteration limit');
  const {sources, domain} = prepare(features), g = level(size), length = g.b.length;
  for (let i = 0; i < size * size; i++) { g.right[i] = i % size < size - 1 ? 1 : 0; g.down[i] = i + size < size * size ? 1 : 0; }
  for (const f of sources) addCurve(g, f, domain.w);
  finishDiagonal(g);
  if (!allFinite(g.diag) || !allFinite(g.b)) throw new Error('Multipoint source strength overflowed numerical system');
  let mass = 0;
  for (let i = 0; i < g.mass.length; i++) mass += g.mass[i];
  if (!Number.isFinite(mass) || (sources.length && !mass)) throw new Error('Multipoint source mass overflow/underflow');
  if (!mass) return {pixels:new Float32Array(length),size,domain,iterations:0,relativeResidual:0,converged:true};
  const rhs = g.b, x = new Float64Array(length), r = new Float64Array(length), p = new Float64Array(length), ap = new Float64Array(length);
  const average = [0,0,0,0];
  for (let i = 0; i < length; i++) average[i % CHANNELS] += rhs[i] / mass;
  for (let i = 0; i < length; i++) x[i] = average[i % CHANNELS];
  apply(g, x, r, rhs);
  const norm = Math.sqrt(dot(rhs, rhs)) || 1;
  if (!Number.isFinite(norm)) throw new Error('Multipoint RHS norm overflow');
  let relativeResidual = Math.sqrt(dot(r, r)) / norm, iterations = 0;
  if (relativeResidual > tolerance) {
    const levels = hierarchy(g);
    // The fine level's right-hand side IS the PCG residual: vcycle only reads it.
    g.b = r; vcycle(levels, 0); p.set(g.u);
    let rz = dot(r, g.u);
    while (relativeResidual > tolerance && iterations < maxIterations) {
      apply(g, p, ap);
      const denominator = dot(p, ap);
      if (!(denominator > 0) || !(rz > 0) || !Number.isFinite(denominator + rz)) throw new Error('PCG lost positive definiteness');
      const alpha = rz / denominator;
      let rr = 0;
      for (let i = 0; i < length; i++) { x[i] += alpha * p[i]; r[i] -= alpha * ap[i]; }
      for (let i = 0; i < length; i++) rr += r[i] * r[i];
      iterations++;
      relativeResidual = Math.sqrt(rr) / norm;
      if (relativeResidual <= tolerance) break;
      vcycle(levels, 0);
      const z = g.u, next = dot(r, z), beta = next / rz;
      for (let i = 0; i < length; i++) p[i] = z[i] + beta * p[i];
      rz = next;
    }
  }
  apply(g, x, r, rhs);
  relativeResidual = Math.sqrt(dot(r, r)) / norm;
  if (!Number.isFinite(relativeResidual)) throw new Error('Multipoint non-finite residual');
  const converged = relativeResidual <= tolerance, pixels = new Float32Array(x);
  for (let i = 0; i < pixels.length; i++) {
    if (!Number.isFinite(pixels[i])) throw new Error('Multipoint non-finite output');
    const upper = i % CHANNELS === 3 ? 1 : pixels[i - i % CHANNELS + 3];
    if (converged && (pixels[i] < -OUTPUT_SLACK || pixels[i] > upper + OUTPUT_SLACK)) throw new Error('Multipoint converged output violates premultiplied bounds');
  }
  return {pixels,size,domain,iterations,relativeResidual,converged};
}
