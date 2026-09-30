/**
 * THE GPU MULTIPOINT SOLVER (WebGL2). It solves the SAME linear system as
 * core/multipoint_diffusion.js — the CPU still assembles it (assembleMultipoint:
 * curve rasterisation, finite cuts, Robin sources; multipointHierarchy: face-averaged
 * coarse conductances and the bottom Cholesky) — and runs the SAME algorithm on it:
 * preconditioned conjugate gradients whose preconditioner is one symmetric V-cycle
 * (damped Jacobi, SMOOTH_STEPS before and after, cell-centre bilinear restrict and its
 * exact adjoint prolong, an exact bottom solve). Every step is a fragment pass over
 * RGBA32F textures holding all four premultiplied channels at once; dot products are
 * 4×4-block reduction pyramids. It iterates on the SAME criterion as the CPU (the PCG
 * residual ‖r‖/‖b‖ ≤ tolerance) and then certifies the TRUE residual ‖b − A x‖/‖b‖,
 * recomputed from x, against max(tolerance, the float32 floor) — ATTAINABLE_FACTOR.
 *
 * WHY IT EXISTS (user, 2026-09-30: "It still seems to be taking its sweet time to
 * update. Are you sure it's using GPU? … why are you still waiting to do the GPU
 * solver? Go!"). The CPU solve is O(N²) work per V-cycle in single-threaded JS —
 * ~0.2 s at 512², ~3 s at 2048² — and it was the whole of that wait.
 *
 * FLOAT32, NOT FLOAT64. Fields differ from the CPU's by float32 rounding (measured and
 * recorded in claude_instructions.md "Multipoint GPU solver"); the user's ruling on
 * that: "If it's just a few bits different, then who cares". Results can also differ
 * by a few bits between GPU vendors. The CPU remains the single path in bare node
 * (cli/render.js has no WebGL2) — by design, not as a fallback.
 *
 * DOM-free: it needs only a WebGL2RenderingContext, which the owner creates (an
 * OffscreenCanvas in the page or in the refinement worker — multipointGpuSolver).
 */
import { multipointHierarchy, validateSolveLimits, MULTIPOINT_SOLVE_TOLERANCE, MULTIPOINT_MAX_ITERATIONS, MULTIPOINT_JACOBI_DAMPING, MULTIPOINT_SMOOTH_STEPS, MULTIPOINT_OUTPUT_SLACK } from "../core/multipoint_diffusion.js";
import { reportOnce } from "../core/report.js";
import { toHalf } from "./skia/shape_sdf.js";

const CHANNELS = 4;
const REDUCE_BLOCK = 4; // texels per axis summed by one reduction fragment: 16-way partial sums
const EPS32 = 2 ** -24; // float32 unit roundoff
// THE FLOAT32 CERTIFICATE. A float32 field cannot always meet the CPU's relative
// residual 1e-5: b is SPARSE (nonzero only at constraint texels) while x is dense, so
// rounding x itself leaves ‖b − A·fl32(x)‖/‖b‖ at 5e-6 (512²) and 8e-5 (2048²) for the
// default three-point fill even when x is the EXACT solution rounded (measured in
// Float64; .scratchpad/multipoint_gpu/f32_floor.mjs). That floor tracked
// eps32·‖|b| + |A||x|‖/‖b‖ at a steady 0.10–0.17 of it on every fixture measured, so a
// solve is converged at max(tolerance, ATTAINABLE_FACTOR × that bound). The factor
// covers the floor plus the GPU's own float32 evaluation of b − A x.
const ATTAINABLE_FACTOR = 2;
const VIOLATION_NONFINITE = 1e30; // the violation pyramid's marker for a NaN/Inf texel
// Pools are kept per grid side so the editor's interim and final sizes do not reallocate
// every solve; beyond this many sides the least recent pool is freed.
const MAX_POOLS = 2;
// Pools for larger grids are freed right after their solve: a 2048² pool is ~0.7 GB of
// GPU memory, and those sizes are rare, slow solves where reallocation is noise.
const POOL_KEEP_MAX_SIZE = 512;
// Renderer strings of software GL: the GPU path is still correct and faster than the
// JS solver at ≥512², but too slow to solve every editor frame (multipoint.js).
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 outColor;
`;

// A x at texel p for operator texel layout (right, down, mass, diag): the four-neighbour
// graph Laplacian plus source mass — core apply()'s operator, but evaluated in
// DIFFERENCE FORM, m·x + Σ w·(x − x_nb), not d·x − Σ w·x_nb. The two are equal in exact
// arithmetic (diag = mass + Σ w, core finishDiagonal); in float32 the second cancels
// catastrophically on smooth fields (≈4c − 4c, leaving the tiny m·c in rounding noise),
// which MEASURED as a 7/255 field error at 2048² that no iteration count removed.
const APPLY = `
uniform sampler2D uOp; uniform sampler2D uX;
vec4 applyA(ivec2 p, out vec4 xc, out float d) {
  vec4 o = texelFetch(uOp, p, 0);
  d = o.w; xc = texelFetch(uX, p, 0);
  vec4 r = o.z * xc;
  if (p.x > 0) { float w = texelFetch(uOp, p - ivec2(1, 0), 0).x; if (w != 0.0) r += w * (xc - texelFetch(uX, p - ivec2(1, 0), 0)); }
  if (o.x != 0.0) r += o.x * (xc - texelFetch(uX, p + ivec2(1, 0), 0));
  if (p.y > 0) { float w = texelFetch(uOp, p - ivec2(0, 1), 0).y; if (w != 0.0) r += w * (xc - texelFetch(uX, p - ivec2(0, 1), 0)); }
  if (o.y != 0.0) r += o.y * (xc - texelFetch(uX, p + ivec2(0, 1), 0));
  return r;
}
`;

// Cell-centre bilinear partner index along one axis: odd cells lean to the next coarse
// cell, even ones to the previous, clamped at the border (core restrict/prolong).
const PARTNER = `
int partner(int f, int c, int m) { return (f & 1) == 1 ? min(m - 1, c + 1) : max(0, c - 1); }
`;

const SHADERS = {
  apply: HEADER + APPLY + `void main() { vec4 xc; float d; outColor = applyA(ivec2(gl_FragCoord.xy), xc, d); }`,
  residual: HEADER + APPLY + `uniform sampler2D uB;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); vec4 xc; float d; outColor = texelFetch(uB, p, 0) - applyA(p, xc, d); }`,
  jacobi: HEADER + APPLY + `uniform sampler2D uB; uniform float uOmega;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); vec4 xc; float d; vec4 ax = applyA(p, xc, d);
  outColor = xc + (uOmega / d) * (texelFetch(uB, p, 0) - ax); }`,
  smoothFromZero: HEADER + `uniform sampler2D uOp; uniform sampler2D uB; uniform float uOmega;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); outColor = (uOmega / texelFetch(uOp, p, 0).w) * texelFetch(uB, p, 0); }`,
  restrict: HEADER + PARTNER + `uniform sampler2D uFine; uniform int uM;
void main() {
  ivec2 C = ivec2(gl_FragCoord.xy); vec4 s = vec4(0.0); int n = 2 * uM;
  for (int dy = -1; dy <= 2; dy++) for (int dx = -1; dx <= 2; dx++) {
    ivec2 f = 2 * C + ivec2(dx, dy);
    if (f.x < 0 || f.y < 0 || f.x >= n || f.y >= n) continue;
    ivec2 c = f >> 1, nb = ivec2(partner(f.x, c.x, uM), partner(f.y, c.y, uM));
    float wx = (c.x == C.x ? 0.75 : 0.0) + (nb.x == C.x ? 0.25 : 0.0);
    float wy = (c.y == C.y ? 0.75 : 0.0) + (nb.y == C.y ? 0.25 : 0.0);
    if (wx * wy != 0.0) s += (wx * wy) * texelFetch(uFine, f, 0);
  }
  outColor = s;
}`,
  prolong: HEADER + PARTNER + `uniform sampler2D uFineU; uniform sampler2D uCoarseU; uniform int uM;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy), c = f >> 1, nb = ivec2(partner(f.x, c.x, uM), partner(f.y, c.y, uM));
  outColor = texelFetch(uFineU, f, 0) + 0.5625 * texelFetch(uCoarseU, c, 0) + 0.1875 * texelFetch(uCoarseU, ivec2(nb.x, c.y), 0)
    + 0.1875 * texelFetch(uCoarseU, ivec2(c.x, nb.y), 0) + 0.0625 * texelFetch(uCoarseU, nb, 0);
}`,
  bottom: HEADER + `uniform sampler2D uInv; uniform sampler2D uB; uniform int uM;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); int i = p.y * uM + p.x, count = uM * uM; vec4 s = vec4(0.0);
  for (int j = 0; j < count; j++) s += texelFetch(uInv, ivec2(j, i), 0).r * texelFetch(uB, ivec2(j % uM, j / uM), 0);
  outColor = s;
}`,
  // X + sign·(num/den)·Y with num and den read from 1×1 reduction results, so the PCG
  // scalars α = rz/pᵀAp and β = rz'/rz never leave the GPU (a readback costs ~0.6 ms).
  axpyScalar: HEADER + `uniform sampler2D uX; uniform sampler2D uY; uniform sampler2D uNum; uniform sampler2D uDen; uniform float uSign;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float a = uSign * texelFetch(uNum, ivec2(0), 0).r / texelFetch(uDen, ivec2(0), 0).r;
  outColor = texelFetch(uX, p, 0) + a * texelFetch(uY, p, 0);
}`,
  fill: HEADER + `uniform vec4 uValue; void main() { outColor = uValue; }`,
  copy: HEADER + `uniform sampler2D uX; void main() { outColor = texelFetch(uX, ivec2(gl_FragCoord.xy), 0); }`,
  dot: HEADER + `uniform sampler2D uA; uniform sampler2D uB; uniform int uN;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * ${REDUCE_BLOCK}; float s = 0.0;
  for (int dy = 0; dy < ${REDUCE_BLOCK}; dy++) for (int dx = 0; dx < ${REDUCE_BLOCK}; dx++) {
    ivec2 p = o + ivec2(dx, dy);
    if (p.x < uN && p.y < uN) s += dot(texelFetch(uA, p, 0), texelFetch(uB, p, 0));
  }
  outColor = vec4(s, 0.0, 0.0, 0.0);
}`,
  sum: HEADER + `uniform sampler2D uA; uniform int uN;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * ${REDUCE_BLOCK}; float s = 0.0;
  for (int dy = 0; dy < ${REDUCE_BLOCK}; dy++) for (int dx = 0; dx < ${REDUCE_BLOCK}; dx++) {
    ivec2 p = o + ivec2(dx, dy);
    if (p.x < uN && p.y < uN) s += texelFetch(uA, p, 0).r;
  }
  outColor = vec4(s, 0.0, 0.0, 0.0);
}`,
  // Σ over channels of (|b| + |A||x|)² at this texel: the scale of float32 rounding in
  // x and in evaluating b − A x (Higham's componentwise bound); reduced with "sum".
  magnitude: HEADER + `uniform sampler2D uOp; uniform sampler2D uX; uniform sampler2D uB; uniform int uN;
vec4 absTerm(ivec2 q, vec4 ax, float w) { return w * (ax + abs(texelFetch(uX, q, 0))); }
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * ${REDUCE_BLOCK}; float s = 0.0;
  for (int dy = 0; dy < ${REDUCE_BLOCK}; dy++) for (int dx = 0; dx < ${REDUCE_BLOCK}; dx++) {
    ivec2 p = o + ivec2(dx, dy);
    if (p.x >= uN || p.y >= uN) continue;
    vec4 op = texelFetch(uOp, p, 0), ax = abs(texelFetch(uX, p, 0)), m = abs(texelFetch(uB, p, 0)) + op.z * ax;
    if (p.x > 0) m += absTerm(p - ivec2(1, 0), ax, texelFetch(uOp, p - ivec2(1, 0), 0).x);
    if (op.x != 0.0) m += absTerm(p + ivec2(1, 0), ax, op.x);
    if (p.y > 0) m += absTerm(p - ivec2(0, 1), ax, texelFetch(uOp, p - ivec2(0, 1), 0).y);
    if (op.y != 0.0) m += absTerm(p + ivec2(0, 1), ax, op.y);
    s += dot(m, m);
  }
  outColor = vec4(s, 0.0, 0.0, 0.0);
}`,
  // Largest premultiplied-bounds violation (core solveMultipoint's OUTPUT_SLACK rule:
  // every channel in [−slack, alpha + slack], alpha in [−slack, 1 + slack]); NaN/Inf
  // texels report VIOLATION_NONFINITE so they cannot hide inside a max.
  violation: HEADER + `uniform sampler2D uA; uniform int uN; uniform float uSlack;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * ${REDUCE_BLOCK}; float m = 0.0;
  for (int dy = 0; dy < ${REDUCE_BLOCK}; dy++) for (int dx = 0; dx < ${REDUCE_BLOCK}; dx++) {
    ivec2 p = o + ivec2(dx, dy);
    if (p.x >= uN || p.y >= uN) continue;
    vec4 v = texelFetch(uA, p, 0);
    if (any(isnan(v)) || any(isinf(v))) { m = ${VIOLATION_NONFINITE.toExponential()}; continue; }
    vec4 upper = vec4(v.aaa, 1.0) + uSlack;
    m = max(m, max(max(max(-uSlack - v.r, -uSlack - v.g), max(-uSlack - v.b, -uSlack - v.a)), 0.0));
    vec4 over = v - upper;
    m = max(m, max(max(over.r, over.g), max(over.b, over.a)));
  }
  outColor = vec4(m, 0.0, 0.0, 0.0);
}`,
  max: HEADER + `uniform sampler2D uA; uniform int uN;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * ${REDUCE_BLOCK}; float m = 0.0;
  for (int dy = 0; dy < ${REDUCE_BLOCK}; dy++) for (int dx = 0; dx < ${REDUCE_BLOCK}; dx++) {
    ivec2 p = o + ivec2(dx, dy);
    if (p.x < uN && p.y < uN) m = max(m, texelFetch(uA, p, 0).r);
  }
  outColor = vec4(m, 0.0, 0.0, 0.0);
}`,
};

/**
 * Pure function. The side lengths of a reduction pyramid over an n×n texture, each
 * pass summing REDUCE_BLOCK×REDUCE_BLOCK texels, down to a single texel.
 * @param {number} n - Grid side, e.g. 2048.
 * @returns {number[]} Pass output sides, e.g. [512, 128, 32, 8, 2, 1].
 * @example reductionSides(2048) // [512, 128, 32, 8, 2, 1]
 * @example reductionSides(128) // [32, 8, 2, 1]
 * @example reductionSides(4) // [1]
 */
export function reductionSides(n) {
  const sides = [];
  for (let m = n; m > 1;) { m = Math.ceil(m / REDUCE_BLOCK); sides.push(m); }
  return sides;
}

/**
 * Pure function. The dense inverse of the bottom level's SPD matrix from its lower
 * Cholesky factor L (A = L Lᵀ): A⁻¹ = L⁻ᵀ L⁻¹, in Float64, returned as Float32 for a
 * texture. The GPU bottom solve is then one matrix-vector product per cell — the same
 * exact coarse solve the CPU's forward/back substitution performs.
 * @param {Float64Array} l - (count,count) row-major lower factor.
 * @param {number} count - Unknowns, e.g. 16 for a 4×4 bottom grid.
 * @returns {Float32Array} (count,count) row-major A⁻¹.
 * @example Array.from(choleskyInverse(new Float64Array([2, 0, 1, 1]), 2)) // [0.5, -0.5, -0.5, 1] (A = [[4,2],[2,2]])
 */
export function choleskyInverse(l, count) {
  const linv = new Float64Array(count * count);
  for (let col = 0; col < count; col++) {
    for (let i = col; i < count; i++) {
      let v = i === col ? 1 : 0;
      for (let k = col; k < i; k++) v -= l[i * count + k] * linv[k * count + col];
      linv[i * count + col] = v / l[i * count + i];
    }
  }
  const inv = new Float32Array(count * count);
  for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
    let s = 0;
    for (let k = Math.max(i, j); k < count; k++) s += linv[k * count + i] * linv[k * count + j];
    inv[i * count + j] = s;
  }
  return inv;
}

/**
 * Pure function. One level's operator as an RGBA32F texel array: (right, down, mass,
 * diag) per cell — the east/south conductances and source mass the difference-form
 * stencil reads, plus the diagonal the Jacobi smoother divides by.
 * @param {object} g - Operator level {n, right, down, mass, diag} (Float64 (N,N) arrays).
 * @returns {Float32Array} (N,N,4) texels.
 * @example Array.from(packOperator({n:1, right:[0], down:[0], mass:[0.5], diag:[3]})) // [0, 0, 0.5, 3]
 */
export function packOperator(g) {
  const cells = g.n * g.n, out = new Float32Array(cells * CHANNELS);
  for (let i = 0; i < cells; i++) {
    out[CHANNELS * i] = g.right[i]; out[CHANNELS * i + 1] = g.down[i];
    out[CHANNELS * i + 2] = g.mass[i]; out[CHANNELS * i + 3] = g.diag[i];
  }
  return out;
}

/**
 * Command. Compiles and links one full-screen-triangle fragment program, and records
 * a setter per active uniform (sampler/int → uniform1i, float → uniform1f, vec4 → uniform4fv).
 * @param {WebGL2RenderingContext} gl - Owning context.
 * @param {string} name - Program name, for error messages.
 * @param {string} fragment - GLSL ES 3.00 source.
 * @returns {{handle: WebGLProgram, set: object}} set[name](value).
 */
function program(gl, name, fragment) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Multipoint GPU shader "${name}" failed to compile: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const handle = gl.createProgram();
  gl.attachShader(handle, compile(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(handle, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(handle);
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) throw new Error(`Multipoint GPU program "${name}" failed to link: ${gl.getProgramInfoLog(handle)}`);
  const set = {};
  for (let i = 0; i < gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS); i++) {
    const info = gl.getActiveUniform(handle, i), loc = gl.getUniformLocation(handle, info.name);
    set[info.name] = info.type === gl.FLOAT ? (v) => gl.uniform1f(loc, v)
      : info.type === gl.FLOAT_VEC4 ? (v) => gl.uniform4fv(loc, v)
      : (v) => gl.uniform1i(loc, v);
    set[info.name].sampler = info.type === gl.SAMPLER_2D;
  }
  return { handle, set };
}

/**
 * Command. Allocates one render-target texture with its framebuffer, refusing loudly
 * if the driver cannot render to it (or ran out of memory).
 * @param {WebGL2RenderingContext} gl - Owning context.
 * @param {number} w - Width in texels.
 * @param {number} h - Height in texels.
 * @param {number} internal - Sized format, e.g. gl.RGBA32F.
 * @returns {{tex: WebGLTexture, fbo: WebGLFramebuffer, w: number, h: number}}
 */
function target(gl, w, h, internal) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER), error = gl.getError();
  if (status !== gl.FRAMEBUFFER_COMPLETE || error !== gl.NO_ERROR)
    throw new Error(`Multipoint GPU could not allocate a ${w}×${h} render target (framebuffer status 0x${status.toString(16)}, GL error 0x${error.toString(16)}).`);
  return { tex, fbo, w, h };
}

/**
 * Command. Builds the GPU solver on a WebGL2 context: checks float render targets,
 * compiles every pass, and returns the solver. Throws with the precise missing
 * capability — the caller reports it and keeps the CPU path.
 * @param {WebGL2RenderingContext} gl - A context this solver may own outright.
 * @returns {{renderer: string, software: boolean, solve: Function, dispose: Function}} `software` = a software GL renderer (SwiftShader, llvmpipe).
 */
export function createMultipointGpu(gl) {
  if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("WebGL2 lacks EXT_color_buffer_float (float render targets)");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  const programs = Object.fromEntries(Object.entries(SHADERS).map(([name, source]) => [name, program(gl, name, source)]));
  const vao = gl.createVertexArray();
  const pools = new Map();
  let half = null; // readback path, decided on the first output target

  /** Command. One full-screen pass of `name` into `dest` with the given uniforms. */
  function pass(name, dest, uniforms) {
    const p = programs[name];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo);
    gl.viewport(0, 0, dest.w, dest.h);
    gl.useProgram(p.handle);
    let unit = 0;
    for (const [key, value] of Object.entries(uniforms)) {
      const setter = p.set[key];
      if (!setter) throw new Error(`Multipoint GPU pass "${name}" has no uniform ${key}`);
      if (setter.sampler) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, value.tex); setter(unit++); }
      else setter(value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Command. Runs a reduction pyramid whose FINAL 1×1 lands in `result` (a named scalar
   * target), not in the shared chain — so several scalars can stay alive on the GPU.
   * @param {object[]} chain - The pool's pyramid targets (the last, 1×1, is unused).
   * @param {object} result - 1×1 R32F target receiving the scalar.
   * @param {string} firstName - First pass (dot / violation), reading the n×n inputs.
   * @param {object} firstUniforms - Its input textures (and slack).
   * @param {number} n - Input side.
   * @param {string} restName - Pass folding one level into the next (sum / max).
   * @returns {undefined}
   */
  function reduceInto(chain, result, firstName, firstUniforms, n, restName) {
    const last = chain.length - 1, dest = (i) => (i === last ? result : chain[i]);
    pass(firstName, dest(0), { ...firstUniforms, uN: n });
    for (let i = 1; i <= last; i++) pass(restName, dest(i), { uA: chain[i - 1], uN: chain[i - 1].w });
  }

  /** Command. Reads a 1×1 scalar target (a GPU sync when work is still in flight). */
  function readScalar(t) {
    const out = new Float32Array(CHANNELS);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out);
    return out[0];
  }

  /** Command. The size-n texture pool: every level's operator and work vectors. */
  function poolFor(n, levels) {
    if (pools.has(n)) { const p = pools.get(n); pools.delete(n); pools.set(n, p); return p; }
    while (pools.size >= MAX_POOLS) { const [oldest, p] = pools.entries().next().value; freePool(p); pools.delete(oldest); }
    const rgba = (m) => target(gl, m, m, gl.RGBA32F);
    const pool = {
      levels: levels.map((g) => ({ n: g.n, op: rgba(g.n), b: rgba(g.n), u: rgba(g.n), tmp: rgba(g.n), res: rgba(g.n) })),
      fine: { rhs: rgba(n), x: rgba(n), r: rgba(n), p: rgba(n), ap: rgba(n) },
      chain: reductionSides(n).map((m) => target(gl, m, m, gl.R32F)),
      // Named 1×1 scalars: pᵀAp, rᵀr, and rᵀz for this iteration and the next.
      scalar: { den: target(gl, 1, 1, gl.R32F), rr: target(gl, 1, 1, gl.R32F), rz: target(gl, 1, 1, gl.R32F), rzNext: target(gl, 1, 1, gl.R32F), bound: target(gl, 1, 1, gl.R32F), mag: target(gl, 1, 1, gl.R32F) },
      out: target(gl, n, n, gl.RGBA16F),
      inv: null,
    };
    pools.set(n, pool);
    return pool;
  }

  /** Command. Frees every texture/framebuffer of a pool. */
  function freePool(pool) {
    const all = [...pool.levels.flatMap((l) => [l.op, l.b, l.u, l.tmp, l.res]), ...Object.values(pool.fine), ...pool.chain, ...Object.values(pool.scalar), pool.out];
    for (const t of all) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); }
    if (pool.inv) gl.deleteTexture(pool.inv.tex);
  }

  /** Command. Uploads Float32 texels into an RGBA32F/R32F texture. */
  function upload(t, data, format) {
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, format, gl.FLOAT, data);
  }

  /** Command. One symmetric V-cycle: levels[i].u ← M⁻¹ b (b = `rhs` on the fine level). */
  function vcycle(pool, i, rhs) {
    const L = pool.levels[i], b = i === 0 ? rhs : L.b;
    if (i === pool.levels.length - 1) { pass("bottom", L.u, { uInv: pool.inv, uB: b, uM: L.n }); return; }
    const sweep = () => { pass("jacobi", L.tmp, { uOp: L.op, uX: L.u, uB: b, uOmega: MULTIPOINT_JACOBI_DAMPING }); [L.u, L.tmp] = [L.tmp, L.u]; };
    pass("smoothFromZero", L.u, { uOp: L.op, uB: b, uOmega: MULTIPOINT_JACOBI_DAMPING });
    for (let s = 1; s < MULTIPOINT_SMOOTH_STEPS; s++) sweep();
    pass("residual", L.res, { uOp: L.op, uX: L.u, uB: b });
    const C = pool.levels[i + 1];
    pass("restrict", C.b, { uFine: L.res, uM: C.n });
    vcycle(pool, i + 1, null);
    pass("prolong", L.tmp, { uFineU: L.u, uCoarseU: C.u, uM: C.n }); [L.u, L.tmp] = [L.tmp, L.u];
    for (let s = 0; s < MULTIPOINT_SMOOTH_STEPS; s++) sweep();
  }

  /**
   * Command. Solves an assembled system (core assembleMultipoint) and reads the
   * converged field back as upload-ready F16 texels.
   * @param {object} assembled - {size, fine, mass, average, norm} from assembleMultipoint; mass > 0.
   * @param {object} options - {tolerance, maxIterations}, as solveMultipoint.
   * @returns {{half: Uint16Array, iterations: number, relativeResidual: number, target: number, converged: boolean, ms: object}}
   *   half is (size,size,4) F16 premultiplied encoded-sRGB RGBA, row-major like the CPU pixels.
   *   target = max(tolerance, the float32 floor) the true residual was certified against.
   */
  function solve(assembled, { tolerance = MULTIPOINT_SOLVE_TOLERANCE, maxIterations = MULTIPOINT_MAX_ITERATIONS } = {}) {
    validateSolveLimits(tolerance, maxIterations);
    if (!(assembled.mass > 0)) throw new Error("Multipoint GPU solve needs at least one active source (mass > 0).");
    if (gl.isContextLost()) throw new Error("Multipoint GPU context was lost.");
    const t0 = performance.now(), n = assembled.size, levels = multipointHierarchy(assembled.fine);
    const pool = poolFor(n, levels), fine = pool.fine, L0 = pool.levels[0];
    gl.bindVertexArray(vao);
    levels.forEach((g, i) => upload(pool.levels[i].op, packOperator(g), gl.RGBA));
    upload(fine.rhs, new Float32Array(assembled.fine.b), gl.RGBA);
    const bottom = levels.at(-1), count = bottom.n * bottom.n;
    if (pool.inv) gl.deleteTexture(pool.inv.tex);
    const invTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, invTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, count, count);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, count, count, gl.RED, gl.FLOAT, choleskyInverse(bottom.cholesky, count));
    pool.inv = { tex: invTex, w: count, h: count };
    const t1 = performance.now();

    // Ping-pong partners outside the V-cycle (each pass needs a target it does not read):
    // x ↔ L0.tmp, r ↔ L0.b (the fine level's own b slot is unused — the V-cycle reads
    // r as the fine RHS), p ↔ ap (ap is dead once r is updated). z is L0.u.
    // ONE sync per iteration (rᵀr); α and β stay on the GPU. The loop stops on the CPU's
    // own test — the recursively updated residual ≤ tolerance — because float32 PCG's
    // recursive residual keeps falling below the float32 floor (measured). Only the final
    // certificate uses the float32-aware target (ATTAINABLE_FACTOR).
    const S = pool.scalar, norm = assembled.norm;
    const dotInto = (result, a, b) => reduceInto(pool.chain, result, "dot", { uA: a, uB: b }, n, "sum");
    pass("fill", fine.x, { uValue: assembled.average });
    pass("residual", fine.r, { uOp: L0.op, uX: fine.x, uB: fine.rhs }); // r0 = b − A x0
    dotInto(S.rr, fine.r, fine.r);
    let relativeResidual = Math.sqrt(readScalar(S.rr)) / norm, iterations = 0;
    if (relativeResidual > tolerance) {
      vcycle(pool, 0, fine.r);
      pass("copy", fine.p, { uX: L0.u });
      dotInto(S.rz, fine.r, L0.u);
      while (relativeResidual > tolerance && iterations < maxIterations) {
        pass("apply", fine.ap, { uOp: L0.op, uX: fine.p });
        dotInto(S.den, fine.p, fine.ap);
        pass("axpyScalar", L0.tmp, { uX: fine.x, uY: fine.p, uNum: S.rz, uDen: S.den, uSign: 1 }); [fine.x, L0.tmp] = [L0.tmp, fine.x];
        pass("axpyScalar", L0.b, { uX: fine.r, uY: fine.ap, uNum: S.rz, uDen: S.den, uSign: -1 }); [fine.r, L0.b] = [L0.b, fine.r];
        dotInto(S.rr, fine.r, fine.r);
        const rr = readScalar(S.rr), denominator = readScalar(S.den), rz = readScalar(S.rz); // one sync, then idle reads
        if (!(denominator > 0) || !(rz > 0) || !Number.isFinite(denominator + rz)) throw new Error("Multipoint GPU PCG lost positive definiteness");
        iterations++;
        relativeResidual = Math.sqrt(rr) / norm;
        if (relativeResidual <= tolerance) break;
        vcycle(pool, 0, fine.r);
        dotInto(S.rzNext, fine.r, L0.u);
        pass("axpyScalar", fine.ap, { uX: L0.u, uY: fine.p, uNum: S.rzNext, uDen: S.rz, uSign: 1 }); [fine.p, fine.ap] = [fine.ap, fine.p];
        [S.rz, S.rzNext] = [S.rzNext, S.rz];
      }
    }
    // The TRUE residual, recomputed from x, decides convergence (as on the CPU), against
    // the same float32-aware target.
    pass("residual", L0.res, { uOp: L0.op, uX: fine.x, uB: fine.rhs });
    dotInto(S.rr, L0.res, L0.res);
    reduceInto(pool.chain, S.mag, "magnitude", { uOp: L0.op, uX: fine.x, uB: fine.rhs }, n, "sum");
    reduceInto(pool.chain, S.bound, "violation", { uA: fine.x, uSlack: MULTIPOINT_OUTPUT_SLACK }, n, "max");
    relativeResidual = Math.sqrt(readScalar(S.rr)) / norm;
    const stop = Math.max(tolerance, ATTAINABLE_FACTOR * EPS32 * Math.sqrt(readScalar(S.mag)) / norm);
    if (!Number.isFinite(relativeResidual)) throw new Error("Multipoint GPU non-finite residual");
    const converged = relativeResidual <= stop;
    const violation = readScalar(S.bound);
    if (violation >= VIOLATION_NONFINITE) throw new Error("Multipoint GPU non-finite output");
    if (converged && violation > 0) throw new Error(`Multipoint GPU converged output violates premultiplied bounds by ${violation}`);
    const t2 = performance.now();
    pass("copy", pool.out, { uX: fine.x });
    const out = readHalf(pool.out);
    const t3 = performance.now();
    if (n > POOL_KEEP_MAX_SIZE) { freePool(pool); pools.delete(n); }
    return { half: out, iterations, relativeResidual, target: stop, converged, ms: { upload: t1 - t0, solve: t2 - t1, readback: t3 - t2 } };
  }

  /**
   * Command. Reads an RGBA16F target as F16 bits. Uses the driver's native HALF_FLOAT
   * read when it offers one (the GPU's own float→half rounding, no CPU conversion);
   * otherwise reads FLOAT (always legal for float targets) and converts with the
   * shared toHalf, the same routine the CPU path uses.
   * @param {object} t - RGBA16F target.
   * @returns {Uint16Array} (h,w,4) F16 bits.
   */
  function readHalf(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    if (half === null) half = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA
      && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.HALF_FLOAT;
    const count = t.w * t.h * CHANNELS, out = new Uint16Array(count);
    if (half) { gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.HALF_FLOAT, out); return out; }
    const f32 = new Float32Array(count);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, f32);
    for (let i = 0; i < count; i++) out[i] = toHalf(f32[i]);
    return out;
  }

  /** Command. Frees every pool, program and the VAO. */
  function dispose() {
    for (const p of pools.values()) freePool(p);
    pools.clear();
    for (const p of Object.values(programs)) gl.deleteProgram(p.handle);
    gl.deleteVertexArray(vao);
  }

  return { renderer, software: SOFTWARE_RENDERER.test(renderer), solve, dispose, get halfReadback() { return half; } };
}

let realmSolver; // undefined = not tried, null = unavailable here, else the solver

/**
 * Query (creates this JS realm's GPU context on first use). THE GPU solver for this
 * realm — the page or a refinement worker — or null when there is none. Bare node has
 * no OffscreenCanvas: null there is the designed CPU path and is not reported. In a
 * browser realm, a missing WebGL2 / float-render-target capability is reported LOUDLY
 * once (reportOnce) and the CPU solver is used from then on.
 * @returns {object|null} createMultipointGpu's solver, or null.
 */
export function multipointGpuSolver() {
  if (realmSolver !== undefined) return realmSolver;
  if (typeof OffscreenCanvas === "undefined") return (realmSolver = null);
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("OffscreenCanvas.getContext('webgl2') returned null");
    realmSolver = createMultipointGpu(gl);
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      realmSolver = null;
      reportOnce("multipoint-gpu-lost", "Multipoint GPU solver lost its WebGL2 context; Multipoint fills now solve on the CPU (slower, same picture).");
    });
  } catch (error) {
    realmSolver = null;
    reportOnce("multipoint-gpu-unavailable", `Multipoint GPU solver unavailable (${error.message}); Multipoint fills solve on the CPU instead — the same picture, several times slower at 512² and above.`);
  }
  return realmSolver;
}
