/**
 * GRAPH SCALE — the DOM-free pure foundation the whole graph* family stands on:
 * the data-space ↔ widget-local-space mapping, "nice" tick GENERATION, tick-label
 * FORMATTING, and the staggered grow-in (lagged reveal) that both graphBars and
 * graphGrid animate through. Every function here is PURE and doctested; nothing
 * in this file reads a clock, the filesystem, or any global — that keeps a graph
 * render splittable across machines (the three-kinds-of-state law) and lets the
 * bare-node CLI use the exact same tick math the GPU editor does.
 *
 * ── WHY A NEW MODULE (no precedent to extend) ─────────────────────────────────
 * Report 07 (codebase precedent map) is explicit: "NO scale/tick/axis precedent
 * exists anywhere — a new core scale-mapping module is required and is the
 * family's shared foundation." graphLine, graphTickMarks, graphGrid and graphBars
 * all import THIS so a ruler and the bars/curve authored with the same
 * `xRange`/`yRange` line up with zero extra math (the shared 3-tuple convention).
 *
 * ── THE LOAD-BEARING TICK TRAP (digest 01, trap #1) ───────────────────────────
 * Tick VALUES are generated as `offset + i·step` with i an INTEGER, never by a
 * float accumulator (`0, 0.1, 0.2, 0.30000000000000004, …`), and the FORMATTER
 * rounds to the step's own decimal precision — the single most common naive-plot
 * bug. `niceStep` hardcodes matplotlib's `[1, 2, 2.5, 5, 10]` "nice" multiples
 * (trap #2); `minorSubdivisions` reproduces the 4-vs-5 divisibility choice
 * (trap #4); `formatTick` clamps negative zero (trap #11).
 */

import { ease } from "./interpolators.js";
import { clamp01Or0 as clamp01 } from "./unit_interval.js";

/** Matplotlib MaxNLocator's "nice" step multiples — the multiples humans read
 *  fastest (digest 01, trap #2). A step is one of these times a power of ten. */
export const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** Cap on generated ticks/subdivisions so a pathological range/step (e.g. a
 *  step near zero) cannot spin out an unbounded array — it fails LOUDLY as a
 *  clamped, obviously-wrong tick count rather than hanging the renderer. */
export const MAX_TICKS = 1000;

/**
 * Pure function. Clamps a value to the unit interval [0, 1] (missing/NaN → 0) —
 * the reveal/alpha guard. THE SHARED fail-closed clamp (core/unit_interval.js
 * `clamp01Or0`), re-exported under this name so the graph plugins keep importing
 * it from here. This used to be a `v ?? 0` copy, which handled an absent value but
 * passed NaN straight through; the shared one refuses every non-finite input.
 *
 * @example clamp01(0.25) // 0.25
 * @example clamp01(1.5) // 1
 * @example clamp01(-3) // 0
 */
export { clamp01 };

/**
 * Pure function. Parses a range SPEC into `{min, max, step}`. The spec is the
 * graph family's shared 3-tuple convention (Manim `x_range`): a string
 * `"[min, max, step]"` (brackets optional) or a real array `[min, max, step]`.
 * A 2-element spec leaves `step` at 1 (a caller wanting an auto step uses
 * `niceStep`). Throws LOUDLY on a spec that is not two or three finite numbers —
 * a malformed range must not silently collapse an axis to a point.
 *
 * @param {string|number[]} spec - "[0, 10, 1]" or [0, 10, 1]
 * @returns {{min: number, max: number, step: number}}
 *
 * @example parseRange("[0, 10, 2]") // {min: 0, max: 10, step: 2}
 * @example parseRange([-5, 5, 1]) // {min: -5, max: 5, step: 1}
 * @example parseRange("0, 1, 0.25") // {min: 0, max: 1, step: 0.25}
 * @example parseRange("[-3.14, 3.14]") // {min: -3.14, max: 3.14, step: 1}
 */
export function parseRange(spec) {
  const parts = Array.isArray(spec)
    ? spec
    : String(spec).replace(/[[\]]/g, "").split(",").map((s) => Number(s.trim()));
  if (!(parts.length === 2 || parts.length === 3) || parts.some((n) => typeof n !== "number" || !Number.isFinite(n)))
    throw new Error(`graph_scale.parseRange: expected "[min, max, step]" of finite numbers, got ${JSON.stringify(spec)}`);
  return { min: parts[0], max: parts[1], step: parts.length === 3 ? parts[2] : 1 };
}

/**
 * Pure function. Maps a DATA value `v` in `[min, max]` onto a LOCAL pixel span
 * `[0, extent]`. `flip` reverses the axis, which is how a y-axis is drawn with
 * math's "up is positive" convention on a screen whose local y grows DOWNward:
 * data `min` lands at the bottom (`extent`), data `max` at the top (`0`). A
 * degenerate range (min === max) has no scale, so everything collapses to the
 * span's start — the only truthful answer (the polygon zero-extent precedent).
 *
 * @param {number} v - data value
 * @param {number} min - data range minimum
 * @param {number} max - data range maximum
 * @param {number} extent - local pixel span
 * @param {boolean} flip - reverse (for a screen-down y-axis)
 * @returns {number} local pixel coordinate
 *
 * @example dataToLocal(5, 0, 10, 200, false) // 100
 * @example dataToLocal(0, 0, 10, 200, true) // 200
 * @example dataToLocal(10, 0, 10, 200, true) // 0
 * @example dataToLocal(3, 3, 3, 200, false) // 0
 */
export function dataToLocal(v, min, max, extent, flip = false) {
  const span = max - min;
  const t = span === 0 ? 0 : (v - min) / span;
  return flip ? extent * (1 - t) : extent * t;
}

/**
 * Pure function. The number of decimal places a step IMPLIES, so a formatter
 * rounds `0.30000000000000004` back to `"0.3"` (digest 01, trap #1). Reads the
 * step's own decimal expansion up to a sane cap; an integer step needs none.
 *
 * @param {number} step - tick step
 * @returns {number} decimal places (0..10)
 *
 * @example decimalsForStep(1) // 0
 * @example decimalsForStep(0.1) // 1
 * @example decimalsForStep(0.25) // 2
 * @example decimalsForStep(2.5) // 1
 * @example decimalsForStep(10) // 0
 */
export function decimalsForStep(step) {
  const s = Math.abs(step);
  if (!Number.isFinite(s) || s === 0 || s === Math.floor(s)) return 0;
  for (let d = 1; d <= 10; d++)
    if (Math.abs(s * 10 ** d - Math.round(s * 10 ** d)) < 1e-9) return d;
  return 10;
}

/**
 * Pure function. The "nice" step (a NICE_STEPS multiple times a power of ten)
 * closest to covering `range` in about `targetCount` intervals — matplotlib's
 * MaxNLocator strategy (digest 01, trap #2), NOT a log-uniform step. Guarantees
 * a positive step; a non-positive range falls back to 1.
 *
 * @param {number} range - data span (max - min)
 * @param {number} targetCount - desired interval count
 * @returns {number} a nice step > 0
 *
 * @example niceStep(10, 5) // 2
 * @example niceStep(100, 5) // 20
 * @example niceStep(1, 5) // 0.2
 * @example niceStep(7, 7) // 1
 */
export function niceStep(range, targetCount) {
  if (!(range > 0) || !(targetCount > 0)) return 1;
  const rough = range / targetCount;
  const mag = 10 ** Math.floor(Math.log10(rough));
  let best = NICE_STEPS[0] * mag, bestErr = Infinity;
  for (const m of NICE_STEPS) {
    const cand = m * mag;
    const err = Math.abs(cand - rough);
    if (err < bestErr) { bestErr = err; best = cand; }
  }
  return best;
}

/**
 * Pure function. Tick VALUES across `[min, max]` at `step` (from `offset`),
 * generated as `offset + i·step` with i an INTEGER and each value ROUNDED to the
 * step's decimal precision — never a float accumulator (digest 01, trap #1). The
 * first tick is the least `offset + i·step` that is >= min (within a rounding
 * epsilon so an on-boundary min is included). Clamped to MAX_TICKS.
 *
 * @param {number} min - range minimum
 * @param {number} max - range maximum
 * @param {number} step - tick spacing (> 0)
 * @param {number} offset - comb origin (ticks pass through this value)
 * @returns {number[]} tick values, ascending
 *
 * @example tickValues(0, 5, 1) // [0, 1, 2, 3, 4, 5]
 * @example tickValues(0, 1, 0.25) // [0, 0.25, 0.5, 0.75, 1]
 * @example tickValues(-2, 2, 1) // [-2, -1, 0, 1, 2]
 * @example tickValues(0.5, 2.5, 1, 0.5) // [0.5, 1.5, 2.5]
 */
export function tickValues(min, max, step, offset = 0) {
  if (!(step > 0)) throw new Error(`graph_scale.tickValues: step must be > 0, got ${JSON.stringify(step)}`);
  const decimals = decimalsForStep(step);
  const round = (v) => +v.toFixed(Math.min(decimals + 2, 12));
  const eps = step * 1e-9;
  const i0 = Math.ceil((min - offset - eps) / step);
  const out = [];
  for (let i = i0; out.length <= MAX_TICKS; i++) {
    const v = round(offset + i * step);
    if (v > max + eps) break;
    out.push(v);
  }
  return out;
}

/**
 * Pure function. Tick VALUES for a "MaxN" locator: pick the nice step that yields
 * about `maxN` intervals over `[min, max]`, then generate them. The count-driven
 * sibling of `tickValues` (which is step-driven).
 *
 * @example maxNTickValues(0, 10, 5) // [0, 2, 4, 6, 8, 10]
 * @example maxNTickValues(0, 1, 4) // [0, 0.25, 0.5, 0.75, 1]
 */
export function maxNTickValues(min, max, maxN) {
  return tickValues(min, max, niceStep(max - min, maxN));
}

/**
 * Pure function. How many MINOR intervals sit inside one MAJOR interval —
 * matplotlib's AutoMinorLocator 4-vs-5 rule (digest 01, trap #4): a major step
 * whose leading significant digit is 1 or 5 subdivides into 5 (minor ticks land
 * on round numbers), otherwise into 4. Reads the step's mantissa, not the raw
 * magnitude, so it is scale-invariant (step 0.1 behaves like step 1).
 *
 * @param {number} step - the major step
 * @returns {number} 4 or 5
 *
 * @example minorSubdivisions(1) // 5
 * @example minorSubdivisions(2) // 4
 * @example minorSubdivisions(5) // 5
 * @example minorSubdivisions(0.1) // 5
 * @example minorSubdivisions(2.5) // 4
 */
export function minorSubdivisions(step) {
  const s = Math.abs(step);
  if (!(s > 0)) return 4;
  const mantissa = s / 10 ** Math.floor(Math.log10(s));
  const lead = Math.round(mantissa * 10) / 10; // 1, 2, 2.5, 5, or ~10
  return lead === 1 || lead === 5 || lead === 10 ? 5 : 4;
}

/**
 * Pure function. The MINOR tick values between the major ticks of `[min, max]`:
 * each major interval split into `subdivisions` parts, the interior split points
 * kept (the major values themselves are excluded — they already carry major
 * ticks). Values are integer-index generated and rounded (trap #1 again).
 *
 * @example minorTickValues(0, 2, 1, 2) // [0.5, 1.5]
 * @example minorTickValues(0, 1, 1, 4) // [0.25, 0.5, 0.75]
 */
export function minorTickValues(min, max, majorStep, subdivisions) {
  if (!(subdivisions >= 2)) return [];
  const minorStep = majorStep / subdivisions;
  const majorSet = new Set(tickValues(min, max, majorStep).map((v) => +v.toFixed(9)));
  return tickValues(min, max, minorStep).filter((v) => !majorSet.has(+v.toFixed(9)));
}

/**
 * Pure function. Formats a tick VALUE to its label string, per `opts`:
 *   format: "auto" | "fixed" | "percent" | "scientific"
 *   decimals: places (auto → derived from the step via `decimalsForStep`)
 *   prefix / suffix: strings wrapped around the number
 *   percentMul: value that reads as 100% (percent mode; default 1, so a 0..1
 *     fraction axis reads as a percentage — differs from mpl's xmax=100 default,
 *     chosen because a graph axis is far more often a fraction than a raw count)
 * NEGATIVE ZERO is clamped to 0 (digest 01, trap #11 — "-0" reads as a bug on a
 * symmetric axis).
 *
 * @param {number} v - the tick value
 * @param {object} opts - {format, decimals, step, prefix, suffix, percentMul}
 * @returns {string} label
 *
 * @example formatTick(0.5, {format: "fixed", decimals: 1}) // "0.5"
 * @example formatTick(2, {format: "fixed", decimals: 0}) // "2"
 * @example formatTick(0.5, {format: "percent"}) // "50%"
 * @example formatTick(-0, {format: "fixed", decimals: 0}) // "0"
 * @example formatTick(3, {format: "fixed", decimals: 0, suffix: "°"}) // "3°"
 * @example formatTick(0.3, {format: "auto", step: 0.1}) // "0.3"
 */
export function formatTick(v, opts = {}) {
  const { format = "auto", prefix = "", suffix = "", percentMul = 1 } = opts;
  let n = v === 0 ? 0 : v; // clamps -0 → 0 (Object.is(-0, 0) is false, but 0 === -0)
  if (Object.is(n, -0)) n = 0;
  const decimals = opts.decimals ?? (opts.step != null ? decimalsForStep(opts.step) : 0);
  let body;
  if (format === "percent") {
    const pct = (n / percentMul) * 100;
    body = `${+pct.toFixed(opts.decimals ?? 0)}%`;
  } else if (format === "scientific") {
    body = n.toExponential(decimals);
  } else {
    // "auto" and "fixed" both round to a fixed decimal count; auto derives it
    // from the step, fixed from the explicit `decimals`. `+…toFixed` strips a
    // trailing ".0" so an integer tick reads "2", not "2.0", when decimals is 0.
    body = decimals > 0 ? n.toFixed(decimals) : String(+n.toFixed(6));
  }
  return `${prefix}${body}${suffix}`;
}

/**
 * Pure function. The stagger KEY for element `index` of `count`, per a grow
 * DIRECTION — the permutation fed into `laggedReveal`'s `i·lagRatio` so a chart
 * can grow left→right, right→left, from the center out, or from the edges in
 * (digest 10, §5 growDirection). Returns a 0-based rank; the actual delay is
 * `laggedReveal`'s job.
 *
 * @param {number} index - element index (0..count-1)
 * @param {number} count - total elements
 * @param {string} direction - "index-ascending"|"index-descending"|"center-out"|"edges-in"
 * @returns {number} stagger rank (0 = first to start)
 *
 * @example staggerKey(0, 5, "index-ascending") // 0
 * @example staggerKey(0, 5, "index-descending") // 4
 * @example staggerKey(2, 5, "center-out") // 0
 * @example staggerKey(2, 5, "edges-in") // 2
 */
export function staggerKey(index, count, direction = "index-ascending") {
  const mid = (count - 1) / 2;
  if (direction === "index-descending") return count - 1 - index;
  if (direction === "center-out") return Math.round(Math.abs(index - mid));
  if (direction === "edges-in") return Math.round(mid - Math.abs(index - mid));
  return index;
}

/**
 * Pure function. The LAGGED-REVEAL grow-up factor for element `index` of `count`
 * at overall `progress` ∈ [0,1], staggered by `lagRatio` ∈ [0,1] — the single
 * formula that unifies Manim's LaggedStart and D3's `delay(i·k)` (digest 10, §5):
 *
 *     d   = 1 / (1 + (N-1)·lagRatio)          per-element window width
 *     s_i = rank · lagRatio · d               this element's start offset
 *     a   = clamp01((progress - s_i) / d)     its local, uneased alpha
 *
 * Proven at both limits: `lagRatio = 0` → every element's alpha equals
 * `progress` (all together); `lagRatio = 1` → element i owns exactly the window
 * `[i/N, (i+1)/N]` (strict sequence). `rank` (from `staggerKey`) chooses the
 * order. Returns the LINEAR local alpha; the caller applies an ease.
 *
 * @param {number} index - element index (0..count-1)
 * @param {number} count - total elements (N)
 * @param {number} progress - overall reveal 0..1
 * @param {number} lagRatio - stagger 0 (together) .. 1 (sequential)
 * @param {string} direction - grow order (see staggerKey)
 * @returns {number} local alpha in [0, 1]
 *
 * @example laggedReveal(0, 4, 0, 0) // 0
 * @example laggedReveal(0, 4, 1, 1) // 1
 * @example laggedReveal(3, 4, 0.5, 1) // 0
 * @example laggedReveal(0, 1, 0.5, 0.5) // 0.5
 * @example laggedReveal(2, 4, 0.5, 0) // 0.5
 */
export function laggedReveal(index, count, progress, lagRatio, direction = "index-ascending") {
  const N = Math.max(1, count);
  const rank = staggerKey(index, N, direction);
  const d = 1 / (1 + (N - 1) * clamp01(lagRatio));
  const start = rank * clamp01(lagRatio) * d;
  return clamp01((clamp01(progress) - start) / d);
}

/**
 * Pure function. The eased grow-up HEIGHT FACTOR for element `index`: the linear
 * `laggedReveal` alpha run through the app's `ease` vocabulary. This is the value
 * a bar/grid-line multiplies its full extent by.
 *
 * @param {number} index - element index
 * @param {number} count - total elements
 * @param {number} progress - overall reveal 0..1
 * @param {number} lagRatio - stagger 0..1
 * @param {string} easeName - "linear"|"cubic"|"quad_in"|"quad_out"
 * @param {string} direction - grow order
 * @returns {number} eased factor in [0, 1]
 *
 * @example easedReveal(0, 1, 0, 0, "cubic") // 0
 * @example easedReveal(0, 1, 1, 0, "cubic") // 1
 * @example easedReveal(0, 1, 0.5, 0, "linear") // 0.5
 */
export function easedReveal(index, count, progress, lagRatio, easeName = "cubic", direction = "index-ascending") {
  return ease(easeName)(laggedReveal(index, count, progress, lagRatio, direction));
}

/** Decimals kept in a generated path `d` — enough to be pixel-exact at any sane
 *  zoom, few enough to keep a serialized/logged path readable (the polygon
 *  DEFAULT_POINT_PRECISION precedent, one higher for sub-pixel curves). */
const PATH_PRECISION = 3;

/** Pure helper. A path coordinate, rounded to PATH_PRECISION and stripped of a
 *  trailing ".000". @example pathNum(1.23456) // 1.235 */
function pathNum(v) {
  return +v.toFixed(PATH_PRECISION);
}

/**
 * Pure function. Splits a sampled polyline into SUBPATHS at DISCONTINUITIES: a
 * break is inserted wherever two consecutive points are farther apart than
 * `jumpThreshold` (a SCREEN-space distance, digest 05's Tier-A jump heuristic —
 * the pragmatic stand-in for asymptote detection, since no tool auto-detects
 * them). A non-positive/absent threshold means "never break" → one subpath. This
 * is why a graphLine emits ONE path op with several M-started subpaths rather
 * than a spurious line streaking across a `tan` asymptote.
 *
 * @param {number[][]} points - [[x, y], ...] in LOCAL/screen units
 * @param {number} jumpThreshold - break when a segment exceeds this length
 * @returns {number[][][]} an array of subpaths (each a point list)
 *
 * A NON-FINITE point (an asymptote's ±Infinity, a NaN from `0/0`, or a `null`
 * gap the caller inserted) also breaks the subpath and is itself dropped — an
 * unplottable sample must not streak a line to the edge of the world.
 *
 * @param {Array<number[]|null>} points - [[x, y], ...] (LOCAL units; null/non-finite = gap)
 * @param {number} jumpThreshold - break when a segment exceeds this length
 * @returns {number[][][]} an array of subpaths (each a point list)
 *
 * @example breakSubpaths([[0, 0], [1, 0], [50, 0], [51, 0]], 10) // [[[0, 0], [1, 0]], [[50, 0], [51, 0]]]
 * @example breakSubpaths([[0, 0], [1, 0], [2, 0]], 0) // [[[0, 0], [1, 0], [2, 0]]]
 * @example breakSubpaths([[0, 0], [1, 0], null, [5, 0], [6, 0]], 0) // [[[0, 0], [1, 0]], [[5, 0], [6, 0]]]
 * @example breakSubpaths([], 10) // []
 */
export function breakSubpaths(points, jumpThreshold) {
  const finite = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const out = [];
  let prev = null;
  for (const p of points) {
    if (!finite(p)) { prev = null; continue; }
    if (prev === null || (jumpThreshold > 0 && Math.hypot(p[0] - prev[0], p[1] - prev[1]) > jumpThreshold))
      out.push([p]);
    else out[out.length - 1].push(p);
    prev = p;
  }
  return out;
}

/**
 * Pure function. An SVG path `d` for a list of SUBPATHS: each subpath opens with
 * `M` and continues with `L`, and `closed` appends `Z` to every subpath that has
 * enough points to enclose area (>= 3). Single-point subpaths (an isolated
 * sample stranded between two jumps) are skipped — a lone point has no segment to
 * draw. Reuses the all-M/L form so it round-trips through the raster, SVG and PDF
 * backends identically (the polygon openPathD precedent).
 *
 * @param {number[][][]} subpaths - [[[x, y], ...], ...] in local units
 * @param {boolean} closed - close each subpath (a curve drawn as a filled loop)
 * @returns {string} SVG path data ("" when nothing is drawable)
 *
 * @example polylinePathD([[[0, 0], [10, 0], [10, 10]]], false) // "M0 0 L10 0 L10 10"
 * @example polylinePathD([[[0, 0], [10, 0], [5, 8]]], true) // "M0 0 L10 0 L5 8 Z"
 * @example polylinePathD([[[0, 0], [10, 0]], [[20, 0], [30, 5]]], false) // "M0 0 L10 0 M20 0 L30 5"
 * @example polylinePathD([[[5, 5]]], false) // ""
 */
export function polylinePathD(subpaths, closed = false) {
  const parts = [];
  for (const sp of subpaths) {
    if (sp.length < 2) continue;
    const [first, ...rest] = sp;
    let d = `M${pathNum(first[0])} ${pathNum(first[1])}` + rest.map(([x, y]) => ` L${pathNum(x)} ${pathNum(y)}`).join("");
    if (closed && sp.length >= 3) d += " Z";
    parts.push(d);
  }
  return parts.join(" ");
}
