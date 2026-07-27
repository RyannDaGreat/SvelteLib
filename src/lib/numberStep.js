/**
 * numberStep.js — deriving a scrubbable row's two numbers (its per-pixel drag
 * COEFFICIENT and its rounding STEP) from whatever the row declared.
 *
 * ── THE DOCTRINE: PRECISION EVIDENCE MAY ONLY REFINE, NEVER COARSEN ──────────
 * Every source below is EVIDENCE about how finely a property is meant to move.
 * Evidence that proves a property is FRACTIONAL is acted on; evidence that
 * merely FAILS to prove it is fractional is NOT treated as proof of the
 * opposite. Concretely: a default of `5` may be a star-point COUNT or a gamma
 * of 5 — so an integer default yields NO step (the control stays continuous)
 * rather than a whole-unit grid. Measured on this codebase: 437 unbounded rows
 * carry a non-zero integer default, and `text.lineSpacing = 1`, `sky.atmosphere
 * = 1`, `demo_comic.gamma = 1` are among them — quantizing those to whole units
 * would recreate exactly the "opacity just flicks between 0 and 1" bug the
 * manifest already records. Coarsening must therefore be DECLARED (`step`),
 * never inferred.
 *
 * ── THE INVARIANT: step ≤ coefficient ───────────────────────────────────────
 * One pixel of drag must always advance the value by at least one step, or the
 * grid swallows the drag and the control appears frozen until the pointer has
 * travelled step/coefficient pixels. Every DERIVED step here is ≤ the
 * coefficient it is paired with (resolveScrub returns them together for exactly
 * this reason — two independent guesses is how they came to disagree). An
 * EXPLICIT `step` is the author's word and is never second-guessed.
 */

/**
 * The coarsest grid this module will ever INFER: one whole unit. A row that
 * wants coarser quantization than that (a 100 K colour-temperature grid, say)
 * must declare `step` — the doctrine above, expressed as a number: inference
 * refines below a whole unit and stops there.
 */
export const COARSEST_DERIVED_STEP = 1;

/**
 * Pure function. Count the decimal places in a number's shortest decimal
 * string. Reads the sign-stripped `String(|v|)` form, so it reflects how the
 * value is naturally written (0.25 → 2, 5 → 0), and unwinds scientific
 * notation (1e-7 → 7) so tiny magnitudes still report their true precision.
 *
 * @param {number} v - The value to inspect.
 * @returns {number} Count of digits after the decimal point (0 for integers).
 *
 * @example decimalPlaces(0.25) // 2
 * @example decimalPlaces(2.5) // 1
 * @example decimalPlaces(5) // 0
 * @example decimalPlaces(240) // 0
 * @example decimalPlaces(-0.05) // 2
 * @example decimalPlaces(1e-7) // 7
 */
export function decimalPlaces(v) {
  const s = Math.abs(v).toString();
  if (s.includes("e") || s.includes("E")) {
    const [mantissa, expText] = s.split(/[eE]/);
    const exponent = parseInt(expText, 10);
    const dot = mantissa.indexOf(".");
    const mantissaDecimals = dot < 0 ? 0 : mantissa.length - dot - 1;
    return Math.max(0, mantissaDecimals - exponent);
  }
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Pure function. The intelligent fallback step for a numeric control given no
 * explicit step: the granularity implied by its DEFAULT value's own precision,
 * i.e. 10^(-decimalPlaces(defaultValue)). So a default of 0.25 scrubs in 0.01s,
 * 0.3 in 0.1s, and an integer default in whole units.
 *
 * A null/undefined/non-finite default, OR a default of exactly 0, returns null
 * — "no step, stay continuous" — so a control with no meaningful default keeps
 * its free-scrub behavior instead of being forced onto an integer grid.
 *
 * @param {number|null|undefined} defaultValue - The property's default value.
 * @returns {number|null} The step, or null to leave the control continuous.
 *
 * @example defaultStep(0.25) // 0.01
 * @example defaultStep(0.3) // 0.1
 * @example defaultStep(2.5) // 0.1
 * @example defaultStep(5) // 1
 * @example defaultStep(240) // 1
 * @example defaultStep(0.005) // 0.001
 * @example defaultStep(0) // null  (no meaningful precision → stay continuous)
 * @example defaultStep(null) // null
 */
export function defaultStep(defaultValue) {
  if (defaultValue == null || !Number.isFinite(defaultValue) || defaultValue === 0) return null;
  return 10 ** -decimalPlaces(defaultValue);
}

/**
 * Pure function. The largest power of ten that is ≤ |x| — the coarsest grid a
 * single increment of `x` can still advance. This is the COMPUTED-quantity twin
 * of defaultStep: defaultStep reads an AUTHORED literal's written precision
 * (0.25 → 0.01), while a computed increment carries float noise instead of
 * authorial intent, so its MAGNITUDE is what means anything (a span/100 of
 * 0.009000000000000001 must give 0.001, not 1e-18).
 *
 * @param {number|null|undefined} x - An increment (units per pixel of drag).
 * @returns {number|null} 10^⌊log10|x|⌋, or null when x is 0/absent/non-finite.
 *
 * @example stepAtMost(0.0175) // 0.01  (one pixel spans 1.75 steps)
 * @example stepAtMost(0.009000000000000001) // 0.001  (float noise ignored)
 * @example stepAtMost(0.11) // 0.1
 * @example stepAtMost(110) // 100
 * @example stepAtMost(1) // 1
 * @example stepAtMost(0) // null
 */
export function stepAtMost(x) {
  if (x == null || !Number.isFinite(x) || x === 0) return null;
  return 10 ** Math.floor(Math.log10(Math.abs(x)));
}

/**
 * Pure function. `step`, unless it is COARSER than one `increment` of drag — in
 * which case the finer stepAtMost(increment) replaces it, so one pixel always
 * moves the value (the step ≤ coefficient invariant). A null step stays null:
 * "no grid" is already as fine as a grid gets.
 *
 * @param {number|null} step - The candidate grid.
 * @param {number|null} increment - Units per pixel of drag.
 * @returns {number|null} The candidate, or a refinement of it, or null.
 *
 * @example refinedStep(0.1, 0.0095) // 0.001  (0.1 would need 10px per tick)
 * @example refinedStep(0.01, 0.02) // 0.01  (already finer than a pixel)
 * @example refinedStep(0.001, null) // 0.001  (no increment known → unchanged)
 * @example refinedStep(null, 0.02) // null  (no grid to refine)
 */
export function refinedStep(step, increment) {
  if (step == null || increment == null) return step;
  return step <= Math.abs(increment) ? step : stepAtMost(increment);
}

/**
 * Pure function. Resolves THE TWO NUMBERS a scrubbable row needs — its drag
 * COEFFICIENT (units per pixel) and its rounding STEP — as ONE decision, from
 * whatever aspects the row declared. Returning them together is the point: a
 * step derived in ignorance of the coefficient is how a control ends up with a
 * grid coarser than its own drag (see the module header's invariant).
 *
 * COEFFICIENT — units per pixel. The first source that KNOWS wins:
 *   1. explicit `scrub`   used verbatim (the author calibrated this row)
 *   2. both bounds        span/dragPx — the full range across one drag run
 *   3. FRACTIONAL evidence |default|/dragPx — its own MAGNITUDE across one drag
 *      run, i.e. one pixel ≈ 1% of the value. Same shape as the bounded rule,
 *      with the value's magnitude standing in for the span it never declared.
 *      Fractionality is proven by a non-integer default OR a non-integer BOUND
 *      (`{default: 1, min: 0.05}` — a glow width whose default reads integral).
 *   4. nothing knowable   null — the caller keeps its own default
 *
 * STEP — one formula, because the grid is a consequence of the drag and not an
 * independent guess:
 *   1. explicit `step`    the author's grid, used verbatim
 *   2. otherwise          stepAtMost(coefficient), capped at
 *                         COARSEST_DERIVED_STEP; null when the coefficient is
 *                         unknown, so the control stays CONTINUOUS rather than
 *                         being forced onto a fabricated whole-unit grid.
 *
 * WHY MAGNITUDE AND NOT THE DEFAULT'S WRITTEN PRECISION (defaultStep). The
 * written precision reads well ("a default of 0.001 should tick by 0.001") and
 * fails in both directions on real rows. Too coarse: 437 unbounded rows carry an
 * integer default, so whole-unit ticks would quantize `sky.atmosphere = 1` and
 * `text.lineSpacing = 1`. Too fine: `demo_mandelbrot.centerX = -0.7435669` would
 * tick at 1e-7/px, freezing the control. Too narrow: a 0.001 threshold ticking
 * by 0.001 can never reach 5e-4 at all. Magnitude lands all three (unchanged,
 * 0.0074/px, 1e-5/px) with one expression, so that is the statistic used.
 *
 * An INTEGER default with no other evidence is "nothing knowable" (module
 * header): it cannot prove the property is fractional, so it must not coarsen or
 * re-scale anything. A 0 default is doubly mute — even PROVEN fractional it has
 * no magnitude to spread across a drag run, so such a row needs a declared
 * `scrub` and nothing here can rescue it.
 *
 * @param {object} row - The declared aspects.
 * @param {number|null} [row.step] - Explicit grid, if the author set one.
 * @param {number|null} [row.scrub] - Explicit units-per-pixel, if calibrated.
 * @param {number|null} [row.min] - Lower bound (null = unbounded).
 * @param {number|null} [row.max] - Upper bound (null = unbounded).
 * @param {number|null} [row.defaultValue] - The property's default value.
 * @param {number} row.dragPx - Pixels of drag that span a bounded row's range.
 * @returns {{step: number|null, coefficient: number|null}} Nulls mean "unknown
 *   — keep the control's own behavior"; never a fabricated 1.
 *
 * @example // opacity: bounded 0..1 with an explicit grid — author's step wins
 * resolveScrub({step: 0.01, min: 0, max: 1, defaultValue: 1, dragPx: 100})
 * // {step: 0.01, coefficient: 0.01}
 * @example // a 0..1 knob whose default is the integer 1: the RANGE proves it
 * // fractional even though the default cannot (the old opacity 0↔1 bug)
 * resolveScrub({min: 0, max: 1, defaultValue: 1, dragPx: 100})
 * // {step: 0.01, coefficient: 0.01}
 * @example // an unbounded fractional knob: 100px spans its own magnitude
 * resolveScrub({defaultValue: 0.8, dragPx: 100})
 * // {step: 0.001, coefficient: 0.008}
 * @example // a deep-zoom coordinate: magnitude, not its 7 written decimals
 * // (which would have given 1e-7/px — a frozen control)
 * resolveScrub({defaultValue: -0.7435669, dragPx: 100})
 * // {step: 0.001, coefficient: 0.007435669000000001}
 * @example // a calibrated row: the declared scrub sets both
 * resolveScrub({scrub: 0.11, defaultValue: 3, dragPx: 100})
 * // {step: 0.1, coefficient: 0.11}
 * @example // a half-open row whose BOUND is fractional (demo_comic.gamma): the
 * // bound proves it, the default gives the scale
 * resolveScrub({min: 0.1, defaultValue: 1, dragPx: 100})
 * // {step: 0.01, coefficient: 0.01}
 * @example // nothing knowable (a positional row, or a 0 default): unchanged
 * resolveScrub({defaultValue: 0, dragPx: 100})
 * // {step: null, coefficient: null}
 */
export function resolveScrub({ step = null, scrub = null, min = null, max = null, defaultValue = null, dragPx }) {
  if (!Number.isFinite(dragPx) || dragPx <= 0)
    throw new Error(`resolveScrub: dragPx must be a positive number of pixels (got ${dragPx})`);
  const bounded = Number.isFinite(min) && Number.isFinite(max);
  // Proof of fractionality, from any of the row's own numbers (see header): a
  // non-integer default, or a non-integer BOUND — `min: 0.05` on a glow width
  // says the property is fractional however its default happens to be written.
  const fractional =
    (Number.isFinite(defaultValue) && !Number.isInteger(defaultValue)) ||
    (Number.isFinite(min) && !Number.isInteger(min)) ||
    (Number.isFinite(max) && !Number.isInteger(max));
  // The scale to spread across one drag run. A 0 default has no magnitude to
  // spread, so proof of fractionality alone still leaves nothing to compute.
  const magnitude = Number.isFinite(defaultValue) ? Math.abs(defaultValue) / dragPx : 0;

  const coefficient =
    scrub != null ? scrub
    : bounded ? (max - min) / dragPx
    : fractional && magnitude > 0 ? magnitude
    : null;

  const derived = stepAtMost(coefficient);
  return {
    step: step ?? (derived == null ? null : Math.min(COARSEST_DERIVED_STEP, derived)),
    coefficient,
  };
}
