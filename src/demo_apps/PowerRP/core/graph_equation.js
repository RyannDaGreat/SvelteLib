/**
 * GRAPH EQUATION — the per-sample equation SANDBOX for the graph* family.
 * graphLine's curve, graphBars' per-bar value, and any graph widget that plots a
 * formula sample the SAME evaluator: a compiled `(scope) → value` function run
 * against a plain scope object, once per sample point.
 *
 * ── IT REUSES core/expressions.js, IT DOES NOT DUPLICATE IT (digest 06) ───────
 * The document-wide equation system already compiles arbitrary JS
 * (`new Function` + `with(scope)`), excises `Math.random`, blocks
 * `Date`/`performance`/wall-clock, and routes `time` through particleTime(). This
 * module imports that machine's pieces — `compileEquationFn`, `SAFE_MATH`,
 * `BLOCKED_GLOBALS` — so the block-list can never drift from a second copy. What
 * it does NOT reuse is the doc-wide slot / dependency-graph evaluator: that
 * solves a different problem (one equation graph, evaluated once), where this
 * one samples ONE source N times over a domain.
 *
 * ── WHY A PLAIN SCOPE, NOT A PROXY (digest 06) ────────────────────────────────
 * The doc-wide evaluator wraps its scope in a `has: () => true` Proxy to seal
 * global fall-through and record dependencies. Neither is wanted here: there are
 * no cross-item dependencies to record (a curve reads only its own domain and
 * vars), and a Proxy measured ~17× slower per sample. A plain object throws free
 * ReferenceErrors on a typo (which is the loud behaviour we want) — but a plain
 * object does NOT seal fall-through by itself, so this module shadows every
 * BLOCKED_GLOBALS name to `undefined` and installs SAFE_MATH as `Math`, using an
 * Object.create(null) base so no prototype member (`constructor`, `toString`) is
 * even reachable through `with`. That matches the EXISTING security posture: the
 * doc-wide Proxy guards bare-identifier determinism, not member-access escapes
 * (`(0).constructor` is undefended there too — the author is trusted); this scope
 * guards exactly the same surface.
 *
 * ── DETERMINISM (the three-kinds-of-state law) ────────────────────────────────
 * A curve is PROPERTY STATE unless its source reads `time`, in which case it is
 * RECORDABLE STATE — a pure function of elapsed time, seekable, Δt=0 ⟹
 * byte-identical. `time` is read ONCE per sampling pass (constant across the
 * curve), never a wall clock. Randomness is the ORDER-INDEPENDENT `(seed, i,
 * stream)` hash from core/particles.js (not a sequential PRNG), so sample order
 * cannot change the picture. `^` is JavaScript's XOR here, NOT exponent — use
 * `**` or `pow()` (the plugins' help text says so, loudly).
 *
 * ── ERRORS ARE WHOLE-CURVE AND LOUD (digest 06) ───────────────────────────────
 * A compile error, or the FIRST sample that throws, aborts the whole curve and
 * returns an error STATE (`{points: [], error}`) the widget renders as a red box
 * (the mermaid convention). There is deliberately NO per-sample try/catch: it
 * would hide which input broke, and an unexplained gap is indistinguishable from
 * a legitimate NaN. A non-finite RESULT (an asymptote's Infinity) is not an
 * error — it becomes a `null` gap the polyline breaks across.
 */

import { compileEquationFn, SAFE_MATH, BLOCKED_GLOBALS } from "./expressions.js";
import { randUnit } from "./particles.js";
import { particleTime } from "../render_gpu/particle_clock.js";
import { rect, text } from "../render_gpu/ir.js";

// THE graph-family error palette — the SAME saturated pink-red / danger-red /
// deep-red the mermaid and latex widgets use for a compile/parse failure. Those
// two re-declare it per file because no plugin may import another; the graph
// family instead SHARES it here in core, so graphLine and graphBars render an
// identical red box without a plugin importing a plugin (digest 06's loud
// whole-curve error convention).
const ERROR_BG = "#f6c9c4";
const ERROR_BORDER = "#c0392b";
const ERROR_TEXT = "#7a1210";
const ERROR_BORDER_WIDTH = 3;
const ERROR_PADDING = 8;
const ERROR_TEXT_FRACTION = 0.14; // label size as a fraction of box height
const ERROR_TEXT_MAX = 18;

/**
 * Pure function. A widget-sized RED ERROR BOX (a filled/stroked rect + a wrapped
 * message) — the display list a graph widget emits when its equation fails to
 * compile or throws. Two ops (box, label), local coords, top-left origin. Shared
 * by graphLine/graphBars so the loud-error affordance is identical and DRY.
 *
 * @param {number} w - widget width (local units)
 * @param {number} h - widget height (local units)
 * @param {string} message - the error text (already prefixed by the caller)
 * @returns {object[]} two display-list ops
 *
 * @example errorAffordance(200, 60, "Graph error: bad").length // 2
 * @example errorAffordance(200, 60, "x")[0].op // "rect"
 * @example errorAffordance(200, 60, "x")[1].op // "text"
 */
export function errorAffordance(w, h, message) {
  const box = rect({ x: 0, y: 0, w, h, cornerRadius: 0, fill: ERROR_BG, stroke: ERROR_BORDER, strokeWidth: ERROR_BORDER_WIDTH });
  const size = Math.max(1, Math.min(ERROR_TEXT_MAX, h * ERROR_TEXT_FRACTION));
  const label = text({
    text: message,
    x: ERROR_PADDING, y: ERROR_PADDING,
    size, color: ERROR_TEXT,
    boxW: Math.max(1, w - 2 * ERROR_PADDING), boxH: Math.max(1, h - 2 * ERROR_PADDING),
  });
  return [box, label];
}

/** Default sample count for a parametric curve — a point count (not a step), so
 *  it is resolution-independent (digest 05: matplotlib 100–500; tangent_lines'
 *  CIRCLE_SAMPLES=64 is the in-repo precedent, doubled twice for smooth zoo
 *  curves). */
export const DEFAULT_NUM_POINTS = 256;

/** Bare math names exposed for hand-authoring convenience — each a REFERENCE
 *  into SAFE_MATH (never a second implementation, so no divergence), so `sin(t)`
 *  and `Math.sin(t)` are the same function. `random` and `Math.random` are NOT
 *  here: randomness must be the seeded, order-independent draw below. */
const BARE_MATH = ["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "cbrt", "abs", "exp", "expm1", "log", "log2", "log10", "pow", "sign", "floor", "ceil", "round", "trunc", "min", "max", "hypot", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh"];

/**
 * Pure function. A deterministic uint32 seed from a source string (FNV-1a) — the
 * `random` stream's seed, so a given equation always draws the same noise
 * (reproducibility: same document ⇒ same picture). The same hash the doc-wide
 * evaluator seeds its random with.
 *
 * @param {string} s - the equation source
 * @returns {number} a uint32 seed
 *
 * @example typeof sampleSeed("Math.sin(t)") // "number"
 * @example sampleSeed("a") !== sampleSeed("b") // true
 * @example sampleSeed("x") === sampleSeed("x") // true
 */
export function sampleSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pure function. Builds the per-curve SCOPE object equations run against: a
 * prototype-less bag of the sandbox symbols (digest 06's v1 list) with the
 * per-sample slots (`x`, `t`, `i`) initialised to 0 and mutated by the sampler.
 * Every BLOCKED_GLOBALS name is present as `undefined` so `Date.now()` throws
 * under `with` rather than reaching the wall clock; `Math` is SAFE_MATH (no
 * `random`); document `vars` are spread in by name LAST (an author var may
 * intentionally shadow a bare-math alias). `random(stream)` is the
 * order-independent `(seed, i, stream)` hash, reading the CURRENT sample index.
 *
 * @param {object} vars - document variables, {name: number}
 * @param {number} seed - the source's sampleSeed (for `random`)
 * @param {number} clock - the presentation time to expose as `time`
 * @param {number} N - the total sample count, exposed as `N`
 * @returns {object} a null-prototype scope
 *
 * @example buildScope({}, 1, 0, 4).N // 4
 * @example buildScope({}, 1, 5, 4).time // 5
 * @example buildScope({speed: 7}, 1, 0, 4).speed // 7
 * @example buildScope({}, 1, 0, 4).Date // undefined
 * @example buildScope({}, 1, 0, 4).TAU // 6.283185307179586
 * @example buildScope({}, 1, 0, 4).Math.sin(0) // 0
 * @example "random" in buildScope({}, 1, 0, 4).Math // false
 */
export function buildScope(vars, seed, clock, N) {
  const scope = Object.create(null);
  for (const g of BLOCKED_GLOBALS) scope[g] = undefined;
  scope.Math = SAFE_MATH;
  for (const k of BARE_MATH) scope[k] = SAFE_MATH[k];
  scope.PI = Math.PI;
  scope.TAU = Math.PI * 2;
  scope.E = Math.E;
  scope.N = N;
  scope.time = clock;
  scope.i = 0;
  scope.x = 0;
  scope.t = 0;
  scope.random = (stream = 0) => randUnit(seed, scope.i, stream | 0);
  for (const [k, v] of Object.entries(vars ?? {})) scope[k] = v;
  return scope;
}

/**
 * Pure function. The parameter value of sample `i` of `N` across `[tStart,
 * tEnd]` — a resolution-independent linear sweep (i/(N-1)), so the endpoints are
 * hit exactly. A single-sample curve (N < 2) sits at tStart.
 *
 * @example sampleT(0, 4, 0, 0) // 0
 * @example sampleT(0, 1, 4, 3) // 1
 * @example sampleT(0, 10, 5, 2) // 5
 */
export function sampleT(tStart, tEnd, N, i) {
  return N < 2 ? tStart : tStart + (tEnd - tStart) * (i / (N - 1));
}

/**
 * Query (reads the presentation clock via particleTime unless `clock` is given).
 * Samples ONE source equation into DATA-space points, interpreting its return by
 * `mode` — the sugar over one parametric core (digest 05), and the reason a
 * graphLine needs only ONE Monaco-editable `source` property (the mermaid
 * codeEditor pattern):
 *   - "parametric": source returns `[x, y]` (or `{x, y}`) — the full curve.
 *   - "explicit":   source returns `y`; x is the domain value t (a y = f(x) plot).
 *   - "polar":      source returns `r`; (x, y) = (r·cos t, r·sin t).
 * Returns `{points, error}`: on success `points` is `[[x, y]|null, …]` in DATA
 * space (a `null` marks a non-finite/unplottable sample — an asymptote gap), and
 * `error` is null. On a COMPILE error or the FIRST runtime throw (including a
 * parametric source that does not return a pair) it returns `{points: [],
 * error}` — whole-curve and loud, no per-sample catch.
 *
 * @param {object} spec - {mode, source, tStart, tEnd, numPoints, vars, clock}
 * @returns {{points: Array<number[]|null>, error: (string|null)}}
 *
 * @example sampleCurve({mode: "explicit", source: "t * 2", tStart: 0, tEnd: 1, numPoints: 2, clock: 0}) // {points: [[0, 0], [1, 2]], error: null}
 * @example sampleCurve({mode: "parametric", source: "[t, t * t]", tStart: 0, tEnd: 2, numPoints: 3, clock: 0}).points // [[0, 0], [1, 1], [2, 4]]
 * @example typeof sampleCurve({mode: "explicit", source: "Math.sin(", tStart: 0, tEnd: 1, numPoints: 2, clock: 0}).error // "string"
 * @example sampleCurve({mode: "explicit", source: "t * 2", tStart: 0, tEnd: 1, numPoints: 2, clock: 0}).error // null
 * @example sampleCurve({mode: "parametric", source: "t", tStart: 0, tEnd: 1, numPoints: 2, clock: 0}).points // []
 */
export function sampleCurve(spec) {
  const mode = spec.mode ?? "parametric";
  const source = spec.source ?? "";
  const tStart = spec.tStart ?? 0;
  const tEnd = spec.tEnd ?? 1;
  const N = Math.max(2, Math.floor(spec.numPoints ?? DEFAULT_NUM_POINTS));
  const clock = spec.clock ?? particleTime();
  const seed = sampleSeed(source);

  let fn;
  try {
    fn = compileEquationFn(source);
  } catch (e) {
    return { points: [], error: `Compile error: ${e.message}` };
  }

  const scope = buildScope(spec.vars, seed, clock, N);
  const points = [];
  try {
    for (let i = 0; i < N; i++) {
      const tv = sampleT(tStart, tEnd, N, i);
      scope.i = i;
      scope.x = tv;
      scope.t = tv;
      const res = fn(scope);
      let x, y;
      if (mode === "polar") {
        const r = Number(res);
        x = r * Math.cos(tv);
        y = r * Math.sin(tv);
      } else if (mode === "explicit") {
        x = tv;
        y = Number(res);
      } else {
        if (Array.isArray(res)) { x = Number(res[0]); y = Number(res[1]); }
        else if (res && typeof res === "object") { x = Number(res.x); y = Number(res.y); }
        else throw new Error(`a parametric source must return [x, y], got ${typeof res}`);
      }
      points.push(Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null);
    }
  } catch (e) {
    return { points: [], error: `Error: ${e.message}` };
  }
  return { points, error: null };
}

/**
 * Query (reads the presentation clock via particleTime unless `clock` given).
 * Evaluates ONE equation once per index `0..N-1`, exposing `i` and `N` (the
 * graphBars per-bar-value path: `f(i)` in direct mode) OR sampling `x` over a
 * range (`f(x)` in riemann mode, when `xs` is supplied). Returns `{values,
 * error}` with the same whole-curve LOUD error contract as sampleCurve. A
 * non-finite value is kept as-is (a bar reads it as height 0 downstream), NOT
 * turned into a gap — a bar chart has no "gap" concept.
 *
 * @param {object} spec - {equation, count, vars, clock, xs}
 * @returns {{values: number[], error: (string|null)}}
 *
 * @example sampleIndexed({equation: "i * 2", count: 4, clock: 0}) // {values: [0, 2, 4, 6], error: null}
 * @example sampleIndexed({equation: "x + 1", count: 3, xs: [0, 1, 2], clock: 0}).values // [1, 2, 3]
 * @example typeof sampleIndexed({equation: "1 +", count: 2, clock: 0}).error // "string"
 */
export function sampleIndexed(spec) {
  const equation = spec.equation ?? "";
  const count = Math.max(0, Math.floor(spec.count ?? 0));
  const clock = spec.clock ?? particleTime();
  const seed = sampleSeed(equation);
  let fn;
  try {
    fn = compileEquationFn(equation);
  } catch (e) {
    return { values: [], error: `Compile error: ${e.message}` };
  }
  const scope = buildScope(spec.vars, seed, clock, count);
  const values = [];
  try {
    for (let i = 0; i < count; i++) {
      scope.i = i;
      const xv = spec.xs ? spec.xs[i] : i;
      scope.x = xv;
      scope.t = xv;
      values.push(Number(fn(scope)));
    }
  } catch (e) {
    return { values: [], error: `Error: ${e.message}` };
  }
  return { values, error: null };
}
