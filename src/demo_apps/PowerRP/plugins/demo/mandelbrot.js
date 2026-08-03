/**
 * MANDELBROT — a DEMO WIDGET (plugins/demo/, the showcase folder) and a
 * GENERATIVE FOREGROUND material on the reusable MATERIAL FRAMEWORK. A rounded
 * rect that renders the Mandelbrot set at a centre and zoom of its own, thousands
 * of times deeper than ordinary floating point reaches, with the modern
 * orbit-average / distance-estimate colour stack over a SHARED COLOUR RAMP
 * (core/ramps.js) read cyclically and blended in OKLab.
 *
 * The mathematics, the measurements behind every default, and the honest limits
 * live beside the SkSL in render_gpu/skia/mandelbrot_shader.js. This file is the
 * WIDGET: what the document stores, what the Inspector shows, and how state
 * becomes one `materialFill` op.
 *
 * ── EVERY PROPERTY IS A PLAIN NUMBER, AND THAT IS THE WHOLE DESIGN ────────────
 * A deep-zoom centre needs far more digits than a float64 holds. The obvious fix
 * — store it as a decimal STRING — would make the single most important property
 * un-keyframable and un-tweenable, because a string cannot be interpolated. So
 * the centre is SPLIT:
 *
 *     centre = centerX + centerFineX · 10^(-fineExponent)
 *
 * Five plain numbers (`centerX`, `centerY`, `centerFineX`, `centerFineY`,
 * `fineExponent`), summed in exact decimal arithmetic by
 * mandelbrot_shader.splitCentreFixed before anything is rounded. Two float64s at
 * a chosen exponent give about 32 significant digits, and every one of them
 * keyframes, tweens and accepts a `= …` equation like any other knob.
 *
 * THOSE 32 DIGITS ARE ALL THERE ARE, AT ANY EXPONENT — the pair carries 2·53 bits
 * however it is scaled — which is why `fineExponent` has a DERIVED ceiling
 * (MANDELBROT_MAX_FINE_EXPONENT, 16: the first decade the coarse leaf cannot name).
 * Past it the resolution is flat and measured flat, while the fine slot's own value
 * grows by a decade a step until an ordinary pan overflows the exact-decimal sum.
 *
 * TO ANIMATE A ZOOM, TWEEN `zoomExponent` — linearly, for a constant-rate zoom
 * (the half-width is 10^(-zoomExponent)). Nobody tweens a 32-digit coordinate;
 * they hold the centre still and change the magnification. TO ANIMATE THE
 * COLOURS, tween `rampPhase`: it recolours without touching the iteration.
 *
 * ── THREE PRESET FAMILIES, NOT ONE LIST ──────────────────────────────────────
 * A fractal picture is made of three independent choices — WHERE, WHAT COLOUR, HOW
 * HARD — so there are three preset families with DISJOINT property key sets, and
 * they compose in any order: pick a location, then a palette, then a performance
 * setting, and none of them undoes another. The full account, including which knob
 * belongs to which family and why, is at LOCATION_PRESETS / COLOUR_PRESETS /
 * PERFORMANCE_PRESETS below.
 *
 * ── maxIterations IS EXPLICIT, ON PURPOSE ────────────────────────────────────
 * There is no automatic iteration count here and that is a considered decision,
 * not an omission. Iteration demand tracks the LOCAL MINIBROT PERIOD, not the
 * magnification — the counterexample is in fractalshades' own examples, where a
 * 5.07e-433 view needs 400 000 000 iterations while a 2e-2608 view, six times
 * deeper, needs only 10 100 100. A depth heuristic would be wrong in both
 * directions. A feedback loop over the rendered image (what Kalles Fraktaler
 * does) would be worse still: it would make the render depend on the previous
 * render instead of on the document, which is exactly what the purity invariant
 * forbids. So the knob is explicit, its cost is stated in its help text, and it
 * is the FIRST thing to turn down if a slide feels slow.
 *
 * ── THE CAMERA IS NOT AN INPUT ───────────────────────────────────────────────
 * The fractal window is defined entirely by this widget's own state: `w`/`h` fix
 * the aspect, `zoomExponent` fixes the complex half-width, and the centre fixes
 * the location. emit() reads nothing but `s.*`. Panning or zooming the editor
 * camera changes only how many device pixels sample that window — so the same
 * document at any camera zoom and any output resolution renders the same complex
 * points, and only the antialias (which is meant to track the sampling grid)
 * differs.
 *
 * Like every foreground material it emits ONE `materialFill` op naming the
 * "mandelbrot" material; it is NOT a backdrop sampler, so it composes normally.
 * Every knob is a CUSTOM self.* property (core/properties.js customProps — the
 * Blender-style mechanism) with ZERO evaluation-engine changes. Deterministic: no
 * time, no random, no feedback.
 *
 * DOM-free / bare-node-safe at import time.
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { CUSTOM_CATEGORY, bundle, bundleDefaults, customProps, defaults, props } from "../../core/properties.js";
import { cyclicRampStops, evenlySpacedRampStops } from "../../core/ramps.js";
import { reportOnce } from "../../core/report.js";
import { materialFill } from "../../render_gpu/ir.js";
import {
  MANDELBROT_FILL_PARAMS, MANDELBROT_MAX_FINE_EXPONENT, MANDELBROT_MAX_ITERATIONS,
  MANDELBROT_MAX_RESOLVABLE_DECADES, MANDELBROT_REF_LEN,
  MIN_PALETTE_SCALE, MIN_ZOOM_EXPONENT,
  approxCentre, bakeMandelbrotRamp, centreResolutionDecades,
  mandelbrotUniformParams, orbitBitsFor, referenceOrbitFor, scaledDecimal,
} from "../../render_gpu/skia/mandelbrot_shader.js";

// approxCentre now lives beside the split-centre helpers in mandelbrot_shader.js (the
// fill mapper needs it there, and it belongs with splitCentreFixed) — re-exported so
// the widget's public surface, and the tests that read it here, are unchanged.
export { approxCentre };

// THE PALETTE IS A SHARED COLOUR RAMP (core/ramps.js + the `ramp` BUNDLE), not a
// widget-private select. It used to be a `palette` select over six hard-coded
// colour lists PLUS a comma-separated `paletteStops` TEXT override, and the text
// row's own help stated the cost: "Being text, this switches rather than tweens".
// So a palette could not animate between two ramps at all, none of the shared
// library's 343 gradient presets was reachable from it, and no stop was
// addressable by an equation. The six named palettes are now ordinary ramp DATA
// (core/ramps.js CYCLIC_RAMPS), which is the user's ruling — "then make them
// ramp-capable ... make them ramps" — and their two pieces of domain knowledge
// travel WITH the data as ramp aspects rather than as widget behaviour:
//   loop: true   cyclicity is MANDATORY, not stylistic (a 1e-12 frame spans about
//                two iterations, so a ramp across the whole iteration range is one
//                flat colour), and the shader already reads the baked table
//                cyclically, so looping is decided entirely at bake time.
//   space: "oklab"   perceptual blending, which is why no ramp passes through mud.
// `paletteOffset` became the ramp's `rampPhase` — the SAME concept (its own help
// said "one full cycle per unit, and it wraps, so 1.25 looks exactly like 0.25",
// which is a phase on a period-1 looping ramp) — migrated by the declarative
// `legacyKeys` rename seam below. `paletteScale` STAYS a widget knob: iterations
// per colour cycle is escape-time domain knowledge, not a ramp aspect.

/**
 * Zoom depth (decades) below which an EXHAUSTED reference orbit can be rebased
 * harmlessly. The rebase sets the delta to an O(1) value, and the next step adds
 * the per-pixel offset `dc` to it; single precision resolves an O(1) number to
 * about 6e-8, so once one view half-width falls below that the offset is lost and
 * every pixel follows the same trajectory. 6 decades keeps a comfortable margin
 * inside that limit. See MANDELBROT_REF_LEN for the measurement.
 */
const EXHAUSTION_SAFE_DECADES = 6;

/**
 * Pure function. Whether a widget state and its reference orbit are in the
 * configuration where an EXHAUSTION REBASE can flatten the frame: the reference
 * came out SHORTER than full length (which happens only when the chosen centre
 * ESCAPES — referenceOrbit fills all MANDELBROT_REF_LEN points otherwise), the
 * iteration budget asks for more iterations than that reference holds, and the view
 * is deeper than EXHAUSTION_SAFE_DECADES so `d + dc == d` is possible at all.
 *
 * ONE DEFINITION, because there were two: emit() carried this expression inline and
 * tests/mandelbrot_test.js re-declared its own copy of EXHAUSTION_SAFE_DECADES to
 * re-type it. Two copies of a precision bound is how they come to disagree.
 *
 * @param {object} s - folded item state (maxIterations, zoomExponent)
 * @param {{count: number}} ref - the reference orbit from cachedOrbit
 * @returns {boolean}
 *
 * @example referenceExhaustionRisk({maxIterations: 2048, zoomExponent: 7.7}, {count: 370}) // true  (an escaping centre, deep)
 * @example referenceExhaustionRisk({maxIterations: 2048, zoomExponent: 5}, {count: 370}) // false (shallower than the bound: dc survives the rebase)
 * @example referenceExhaustionRisk({maxIterations: 780, zoomExponent: 10.5}, {count: 792}) // false (the budget stops BEFORE the reference does — the deep preset's whole trick)
 * @example referenceExhaustionRisk({maxIterations: 2048, zoomExponent: 10.5}, {count: 1024}) // false (a full-length reference is not exhausted early)
 */
export function referenceExhaustionRisk(s, ref) {
  return ref.count < MANDELBROT_REF_LEN
    && (s.maxIterations ?? 0) > ref.count
    && (s.zoomExponent ?? 0) > EXHAUSTION_SAFE_DECADES;
}

// MIN_ZOOM_EXPONENT / MIN_PALETTE_SCALE (the row floors, also enforced by the
// gestures and the floating bar) and the colour-axis / interior-test select
// options + codes now live in render_gpu/skia/mandelbrot_shader.js beside the fill
// schema (MANDELBROT_FILL_PARAMS), the single declaration the widget and the paint
// UI both derive from. The two MIN_* are imported back here for clampedZoomExponent
// and fieldWrites; the select constants stay entirely shader-side now.

/** Reference orbits kept alive between derives, keyed by the state that
 *  determines them. A derive re-runs emit() on every frame of a drag, and one
 *  orbit is a few hundred long-number multiplies — cheap, but not free, and
 *  perfectly cacheable because it is a pure function of five numbers. Small
 *  because the only interesting keys are "the widgets on this slide". */
const ORBIT_CACHE_LIMIT = 24;
const _orbitCache = new Map();

/** Baked palettes kept alive between derives, keyed by the stop list. Same
 *  reasoning as _orbitCache: pure, cheap, and re-requested every frame. */
const PALETTE_CACHE_LIMIT = 16;
const _paletteCache = new Map();

/**
 * Query (memoized; near-pure). The reference orbit for a widget state. Pure in
 * its inputs — the cache only avoids recomputing a value that is already fully
 * determined by them, so two identical documents always get identical orbits.
 *
 * @param {object} s - folded item state (centerX, centerY, centerFineX, centerFineY, fineExponent, zoomExponent)
 * @returns {{orbit: Float32Array, count: number, escaped: boolean}}
 *
 * @example cachedOrbit({centerX: 0, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 0}).count // 512 (C = 0 never escapes)
 * @example cachedOrbit({centerX: 1, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 0}).escaped // true (C = 1 escapes)
 */
export function cachedOrbit(s) {
  const fineExponent = Math.max(0, Math.round(s.fineExponent ?? 0));
  // orbitBitsFor is THE derivation referenceOrbitFor builds with, not a second copy
  // of it — a key that disagreed with the value would hand back an orbit built at a
  // precision the state never asked for, and nothing would say so.
  const bits = orbitBitsFor(s);
  const key = `${s.centerX}|${s.centerY}|${s.centerFineX}|${s.centerFineY}|${fineExponent}|${bits}`;
  const hit = _orbitCache.get(key);
  if (hit) return hit;
  // The orbit pipeline (splitCentreFixed → referenceOrbit) is shared with the fill
  // path through referenceOrbitFor; this function only adds the memo.
  const built = referenceOrbitFor(s);
  if (_orbitCache.size >= ORBIT_CACHE_LIMIT) _orbitCache.delete(_orbitCache.keys().next().value);
  _orbitCache.set(key, built);
  return built;
}

/**
 * Pure function. The RAMP a widget state describes: its stop list plus the three
 * aspects that decide how the ramp is read (core/ramps.js). One reader, so the
 * bake, the Inspector and any future consumer cannot disagree about what the
 * ramp IS.
 *
 * ABSENT ASPECTS FALL BACK TO THIS WIDGET'S OWN DEFAULTS, not to the registry's:
 * a Mandelbrot palette that lost `rampLoop` to a partial delta must still be
 * CYCLIC, because a non-cyclic one renders as one flat colour at depth. The stop
 * list has no such fallback — an absent ramp is a fold bug and checkRampStops
 * says so loudly at the bake.
 *
 * @param {object} s - folded item state (rampStops, rampLoop, rampSpace, rampPhase)
 * @returns {{stops: object[], loop: boolean, space: string, phase: number}}
 *
 * @example rampOf({rampStops: [{offset: 0, color: "#000000"}, {offset: 0.5, color: "#ffffff"}]}).loop // true
 * @example rampOf({rampStops: [], rampSpace: "srgb"}).space // "srgb"
 * @example rampOf({rampStops: [], rampPhase: 0.25}).phase // 0.25
 */
export function rampOf(s) {
  return {
    stops: s.rampStops,
    loop: s.rampLoop ?? RAMP_DEFAULTS.rampLoop,
    space: s.rampSpace ?? RAMP_DEFAULTS.rampSpace,
    phase: s.rampPhase ?? RAMP_DEFAULTS.rampPhase,
  };
}

/**
 * Query (memoized; near-pure). The baked palette + mean for a widget state. The
 * PHASE is deliberately NOT part of the key: the shader applies it per pixel
 * (samplePalette(t + uPaletteOffset)), so a phase animation re-reads one cached
 * table instead of re-baking 32 entries per frame.
 *
 * @param {object} s - folded item state (rampStops, rampLoop, rampSpace)
 * @returns {{palette: number[], mean: [number, number, number]}}
 *
 * @example cachedPalette({rampStops: [{offset: 0, color: "#ffffff"}, {offset: 0.5, color: "#ffffff"}]}).palette.length // 96
 */
export function cachedPalette(s) {
  const ramp = rampOf(s);
  const stops = ramp.stops;
  const key = `${ramp.loop}|${ramp.space}|${JSON.stringify(stops)}`;
  const hit = _paletteCache.get(key);
  if (hit) return hit;
  const built = bakeMandelbrotRamp(stops, ramp);
  if (_paletteCache.size >= PALETTE_CACHE_LIMIT) _paletteCache.delete(_paletteCache.keys().next().value);
  _paletteCache.set(key, built);
  return built;
}

/** Pure function. A state's fine exponent, normalized the one way every reader
 *  here normalizes it (non-negative integer).
 *  @example fineExponentOf({fineExponent: 16.4}) // 16
 *  @example fineExponentOf({}) // 0 */
function fineExponentOf(s) {
  return Math.max(0, Math.round(s.fineExponent ?? 0));
}

/**
 * Pure function. Whether the COARSE leaf can hold a centre delta by itself — the
 * question interiorView.writes asks before choosing which leaf a pan lands in.
 *
 * `Number.EPSILON` IS 2^-52, the relative spacing of float64, so EPSILON·|centre| is
 * an upper bound on ulp(centre): a delta at least that big is representable in the
 * coarse leaf, and one smaller than it must go to the fine leaf — where it is then
 * bounded by EPSILON·|centre|·10^fineExponent, which at the ceiling and |c| ≤ 2 is
 * 4.4, so the fine slot cannot grow. A centre of exactly 0 has no leading digits to
 * protect and its coarse leaf holds any delta EXACTLY (float64's exponent range does
 * the work a fine slot would do badly — a fine value of 1e-14 keeps only four digits
 * through splitCentreFixed's 18-place truncation), so it answers true.
 *
 * @param {number} centre - the axis's current absolute coordinate
 * @param {number} delta - the centre delta a gesture asks for
 * @returns {boolean}
 *
 * @example coarseLeafHolds(-0.7435669, 1e-3) // true
 * @example coarseLeafHolds(-0.7435669, 1e-30) // false (far below the float64 spacing there)
 * @example coarseLeafHolds(0, 1e-30) // true (a coordinate near zero needs no fine slot)
 */
function coarseLeafHolds(centre, delta) {
  return Math.abs(delta) >= Number.EPSILON * Math.abs(centre);
}

/** Pure function. The view's complex half-width, 10^(-zoomExponent) — emit()'s
 *  `halfWidth`, named once so the tween and the window cannot disagree.
 *  @example halfWidthOf({zoomExponent: 2}) // 0.01
 *  @example halfWidthOf({}) // 1 */
function halfWidthOf(s) {
  return Math.pow(10, -(s.zoomExponent ?? 0));
}

/** Pure function. A zoom exponent held at the SAME floor the Inspector row
 *  enforces — so a gesture, a typed value and the row cannot disagree about how far
 *  out the view may go (MIN_ZOOM_EXPONENT for why the floor is negative).
 *  @example clampedZoomExponent(6) // 6
 *  @example clampedZoomExponent(-9) // -1 (the floor: a half-width of 10) */
function clampedZoomExponent(z) {
  return Math.max(MIN_ZOOM_EXPONENT, z);
}

/**
 * Pure function. ONE AXIS OF THE SPLIT CENTRE AS AN EXACT DECIMAL STRING — all of
 * it, every digit the two float64s actually carry, with no rounding anywhere.
 *
 * WHY A STRING AND NOT A NUMBER: this is what the floating coordinate bar shows and
 * what a user pastes a published deep-zoom coordinate into. `approxCentre` — the
 * float64 sum — is the WRONG thing to display, because at fineExponent 16 it throws
 * away the entire fine half of the coordinate the widget exists to carry.
 *
 * The sum is `scaledDecimal`'s, the same exact-decimal arithmetic
 * mandelbrot_shader.splitCentreFixed uses to build the reference orbit, so what the
 * bar shows and what the shader renders cannot disagree. Trailing zeros are trimmed
 * because they are not information; nothing else is.
 *
 * WITH NO FINE PART the value IS a single float64, and JavaScript's own `String`
 * gives the SHORTEST decimal that round-trips to it — "-0.7435669", not the
 * "-0.743566900000000023" its 18-place expansion would show. That is not a rounding
 * (it names the identical float64) and it is the case every shipped preset is in, so
 * an ordinary view reads like the coordinate the user typed. A pair WITH a fine part
 * is genuinely a 30-plus-digit number and prints as one.
 *
 * @param {number} coarse - the leading digits
 * @param {number} fine - the fine offset, in units of 10^(-fineExponent)
 * @param {number} fineExponent - a non-negative integer
 * @returns {string} the exact decimal value of coarse + fine·10^(-fineExponent)
 *
 * @example splitCentreText(-0.5, 0, 0) // "-0.5"
 * @example splitCentreText(-0.7435669, 0, 0) // "-0.7435669" (no fine part: the shortest form that IS this float64)
 * @example splitCentreText(0.5, 5, 1) // "1"
 * @example splitCentreText(-0.7435669, 3, 16) // "-0.7435668999999997306016545437159948" (coarse's true float64 value plus 3e-16 — what actually renders)
 */
export function splitCentreText(coarse, fine, fineExponent) {
  if ((fine ?? 0) === 0) return String(coarse ?? 0);
  const fe = Math.max(0, Math.round(fineExponent ?? 0));
  const decimals = fe + SPLIT_TEXT_DECIMALS;
  const scaled = scaledDecimal(coarse ?? 0, decimals) + scaledDecimal(fine ?? 0, SPLIT_TEXT_DECIMALS);
  return decimalString(scaled, decimals);
}

/**
 * Pure function. A TYPED decimal string → the split-centre leaves that hold it, at
 * a given fine exponent: `{coarse, fine}` with `coarse + fine·10^(-fineExponent)`
 * equal to the typed value to every digit the pair can represent.
 *
 * THIS IS A CANONICAL RE-SPLIT, AND IT IS DELIBERATELY NOT `interiorView.writes`.
 * A gesture NUDGES a coordinate, so it must leave the coarse anchor alone and put
 * the delta in the fine slot — otherwise a drag would quantize a 32-digit centre to
 * float64, which is `writes`'s whole reason for existing. A TYPED absolute
 * coordinate is the opposite situation: it defines both halves, so `coarse` takes
 * the best float64 and `fine` takes the EXACT remainder. Rounding the typed value
 * through float64 (a plain Number()) is the failure this function exists to prevent
 * — that is exactly how a pasted deep coordinate loses its last sixteen digits.
 *
 * At fineExponent 0 there is no fine channel to speak of (the widget's own help
 * text: "0 turns the fine part off entirely"), so the value is taken at float64 and
 * the fine slot is left at zero — the same reading zoomTweenAxis takes.
 *
 * @param {string} text - a decimal number, e.g. "-0.743566900000000012345"
 * @param {number} fineExponent - a non-negative integer
 * @returns {{coarse: number, fine: number}|null} null when `text` is not a number
 *
 * PRECISION OF THE ROUND TRIP: every typed digit survives down to about 10^(-33),
 * the pair's own resolution (two float64s at the chosen exponent). The residual
 * itself is stored in a float64, so re-reading a 25-decimal coordinate reproduces it
 * with an error near 10^(-34) — one part in 10^25 of the coordinate. Compare a plain
 * `Number(text)`, which loses everything past the 17th digit.
 *
 * @example parseSplitCentre("-0.5", 0) // {coarse: -0.5, fine: 0}
 * @example parseSplitCentre("1", 1) // {coarse: 1, fine: 0}
 * @example parseSplitCentre("nonsense", 0) // null
 * @example parseSplitCentre("-0.7435669000000000123456789", 16) // {coarse: -0.7435669, fine: 0.18255975643715994} (the fine slot holds the digits float64 dropped)
 * @example splitCentreText(-0.7435669, 0.18255975643715994, 16).slice(0, 28) // "-0.7435669000000000123456789" (every typed digit read back)
 */
export function parseSplitCentre(text, fineExponent) {
  const trimmed = String(text).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const fe = Math.max(0, Math.round(fineExponent ?? 0));
  const coarse = Number(trimmed);
  if (!Number.isFinite(coarse)) return null;
  if (fe === 0) return { coarse, fine: 0 };
  const decimals = fe + SPLIT_TEXT_DECIMALS;
  const residual = decimalScaled(trimmed, decimals) - scaledDecimal(coarse, decimals);
  return { coarse, fine: Number(decimalString(residual, SPLIT_TEXT_DECIMALS)) };
}

/**
 * How many decimal places past the coarse part the text helpers carry. THE SAME
 * number splitCentreFixed scales the fine slot by (its COARSE_DECIMALS), because
 * these functions must reproduce that sum exactly, not a near-enough one. It is
 * private there, so it is stated here with the reason it must match rather than
 * being a second, drifting constant.
 */
const SPLIT_TEXT_DECIMALS = 18;

/**
 * Pure function. A decimal STRING → a BigInt scaled by 10^decimals, exactly (no
 * float64 anywhere on the path, which is the point — `Number(text)` is precisely
 * the rounding the split centre exists to avoid). Digits past `decimals` are
 * TRUNCATED, which is the honest treatment: they are past what the pair can hold.
 *
 * @param {string} text - a validated decimal number
 * @param {number} decimals - fractional places to scale by
 * @returns {bigint}
 *
 * @example decimalScaled("1.5", 3) // 1500n
 * @example decimalScaled("-0.25", 2) // -25n
 * @example decimalScaled("2", 0) // 2n
 * @example decimalScaled("0.98765", 3) // 987n (past the scale: truncated, not rounded)
 */
function decimalScaled(text, decimals) {
  const neg = text.startsWith("-");
  const body = text.replace(/^[+-]/, "");
  const [ip, fp = ""] = body.split(".");
  const frac = fp.slice(0, decimals).padEnd(decimals, "0");
  return (neg ? -1n : 1n) * BigInt((ip === "" ? "0" : ip) + (decimals === 0 ? "" : frac));
}

/**
 * Pure function. A BigInt scaled by 10^decimals → its exact decimal string, with
 * trailing fractional zeros trimmed (and the point dropped when nothing is left).
 * The inverse of decimalScaled.
 *
 * @param {bigint} scaled - the numerator
 * @param {number} decimals - fractional places it is scaled by
 * @returns {string}
 *
 * @example decimalString(1500n, 3) // "1.5"
 * @example decimalString(-25n, 2) // "-0.25"
 * @example decimalString(0n, 4) // "0"
 * @example decimalString(2000n, 3) // "2"
 */
function decimalString(scaled, decimals) {
  const neg = scaled < 0n;
  const digits = (neg ? -scaled : scaled).toString().padStart(decimals + 1, "0");
  const ip = digits.slice(0, digits.length - decimals);
  const fp = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${ip}${fp ? `.${fp}` : ""}`;
}

/**
 * Pure function. THE ZOOM TWEEN's shape parameter: how much of the way from the
 * TARGET half-width back to the START half-width the frame is at tween alpha `a`.
 * 1 at a = 0, 0 at a = 1, and it decays with the FRAME, not with alpha.
 *
 *       w(a) - wTo
 * lam = ───────────
 *       wFrom - wTo
 *
 * WHY THIS EXISTS — the bug it fixes, measured. `zoomExponent` is a logarithm, so
 * tweening it linearly shrinks the frame EXPONENTIALLY (half-width 10^(-z)), which
 * is the correct constant-rate zoom. But the CENTRE used to tween linearly in
 * alpha, and a target point's screen offset — in half-widths, where 1.0 is the
 * frame edge — is then (1 - a)·(cTo - cFrom)/w(a): a decaying term over an
 * exploding one, which PEAKS NEAR THE END instead of falling. Measured for
 * z: 0.5 → 6 and c: -0.6 → -0.7435669 (whole set → seahorse tail):
 *
 *     alpha            0     0.1    0.25     0.5     0.75      0.9      1
 *     linear       -0.45   -1.45   -8.07    -128    -1514    -4046      0
 *     w-linear     -0.45   -0.45   -0.45   -0.45    -0.43    -0.33      0
 *
 * The target swung 4170 half-widths off frame and snapped back — the "it curved
 * around and it was weird" the user reported. Making the centre linear in the
 * HALF-WIDTH instead makes the offset lam·(cTo - cFrom)/w(a), which is monotone by
 * construction (both factors shrink together) and exact at both endpoints.
 *
 * @param {number} zFrom - the start zoom exponent
 * @param {number} zTo - the target zoom exponent
 * @param {number} alpha - tween strength in [0, 1]
 * @returns {number} lam in [0, 1], or NaN when there is no zoom (wFrom === wTo)
 *
 * @example zoomTweenLam(0, 2, 0) // 1
 * @example zoomTweenLam(0, 2, 1) // 0
 * @example zoomTweenLam(0, 2, 0.5) // 0.09090909090909091 (w = 0.1: a tenth of the way in scale, nine tenths of the way in offset)
 * @example zoomTweenLam(2, 0, 0.5) // 0.9090909090909091 (zooming OUT is the exact time-reverse)
 * @example Number.isNaN(zoomTweenLam(3, 3, 0.5)) // true (no zoom — a pure pan stays linear in alpha)
 */
export function zoomTweenLam(zFrom, zTo, alpha) {
  const wFrom = Math.pow(10, -zFrom), wTo = Math.pow(10, -zTo);
  if (wFrom === wTo) return NaN;
  return (Math.pow(10, -(zFrom + (zTo - zFrom) * alpha)) - wTo) / (wFrom - wTo);
}

/**
 * Pure function. ONE axis of the zoom-corrected centre, in the SPLIT
 * representation: `{coarse, fine}` at the TARGET's fine exponent, holding
 *
 *     c(a) = cTo + lam⋅(cFrom - cTo)
 *
 * WHY THE COARSE PART IS PINNED TO THE TARGET'S. The pair is stored as
 * coarse + fine·10^(-fineExponent) so a 32-digit centre keyframes as two plain
 * numbers, and the naive per-leaf tween lerps BOTH — which makes the coarse leaf
 * step through the tween in float64 ulps (about 1e-16 for a coordinate near 0.7).
 * That is invisible at the widget's shipped depths and ruinous past about 1e-14,
 * where one ulp is thousands of half-widths. Pinning coarse to cTo's and letting
 * the FINE leaf carry the whole interpolated offset makes the error proportional
 * to lam — i.e. to the frame — so it is a constant ~1e-17 of a half-width at EVERY
 * depth, and the target's own deep digits arrive EXACTLY at alpha 1 (lam = 0).
 *
 * All arithmetic is on the offset FROM the target's coarse digits, never on two
 * near-equal absolute coordinates, which is what keeps the deep digits alive.
 *
 * AT fineExponent 0 THE COARSE PART TAKES IT ALL INSTEAD, and the fine slot simply
 * snaps to the target's. `fineExponent: 0` is the widget's own declaration that
 * float64 is enough here (its help text: "0 turns the fine part off entirely"), so
 * there is no precision to protect — and a tween that quietly filled a slot the
 * widget calls off would leave the Inspector showing a Centre X that is not the
 * centre. The two branches produce the SAME sum; they differ only in which leaf
 * carries it.
 *
 * @param {{coarse: number, fine: number, fineExponent: number}} from - start axis
 * @param {{coarse: number, fine: number, fineExponent: number}} to - target axis
 * @param {number} lam - zoomTweenLam(...)
 * @returns {{coarse: number, fine: number}} the split centre at this alpha
 *
 * @example zoomTweenAxis({coarse: -0.6, fine: 0, fineExponent: 0}, {coarse: -0.75, fine: 0, fineExponent: 0}, 0) // {coarse: -0.75, fine: 0} (lam 0 = the target exactly)
 * @example zoomTweenAxis({coarse: -0.6, fine: 0, fineExponent: 0}, {coarse: -0.75, fine: 0, fineExponent: 0}, 1) // {coarse: -0.6, fine: 0} (lam 1 = the start; fine stays off)
 * @example zoomTweenAxis({coarse: 0, fine: 4, fineExponent: 2}, {coarse: 0, fine: 2, fineExponent: 2}, 0.5) // {coarse: 0, fine: 3} (a shared coarse leaves the deep digits to lerp in FINE units)
 */
export function zoomTweenAxis(from, to, lam) {
  const dTo = to.fine * Math.pow(10, -to.fineExponent);
  const dFrom = (from.coarse - to.coarse) + from.fine * Math.pow(10, -from.fineExponent);
  const d = dTo + lam * (dFrom - dTo);
  if (to.fineExponent === 0) return { coarse: to.coarse + d - to.fine, fine: to.fine };
  return { coarse: to.coarse, fine: d * Math.pow(10, to.fineExponent) };
}

/**
 * Pure function. THE WIDGET'S OWN STATE INTERPOLATION (the core/document.js
 * `tweenedState` hook): the centre leaves that replace the naive per-leaf lerp
 * while a slide transition tweens this widget, or `{}` when the naive lerp is
 * already right.
 *
 * The widget declares this because the widget is what knows that its centre and
 * its zoom are COUPLED — see zoomTweenLam for the measurement. `zoomExponent`
 * itself is deliberately left alone (linear in alpha IS the constant-rate zoom),
 * and so is every colour/iteration knob.
 *
 * `fineExponent` is written to the TARGET's, not lerped: it is a precision
 * REPRESENTATION choice, not a visual one, and the tween needs the resolution the
 * destination needs from the first frame (a lerped-and-rounded integer would
 * instead step through intermediate resolutions the deep end cannot use).
 *
 * RETURNS `{}` — deferring to the naive tween — in exactly three cases, each for a
 * stated reason rather than as a fallback:
 *   - NO ZOOM (zoomExponent equal at both ends): a pan at fixed magnification is a
 *     straight line in the plane, and lam is undefined (0/0).
 *   - A LEAF THAT IS NOT A FINITE NUMBER at either end: an `=` equation (or a
 *     freshly created item with the key absent) is governed by the equation, and
 *     the coupling law is defined on numbers.
 *   - ALPHA AT AN ENDPOINT: the endpoints are the stored states by definition.
 *
 * @param {object} from - the folded state on the PREVIOUS slide
 * @param {object} to - the folded state on THIS slide (the delta at alpha 1)
 * @param {number} alpha - tween strength in (0, 1)
 * @returns {object} a flat {stateKey: value} override map, possibly empty
 *
 * @example mandelbrotPlugin.interpolateState({centerX: -0.6, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 0}, {centerX: -0.75, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 1}, 1).centerX // -0.75
 * @example mandelbrotPlugin.interpolateState({centerX: 0, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 2}, {centerX: 9, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 2}, 0.5) // {} (no zoom → the naive linear pan is correct)
 * @example mandelbrotPlugin.interpolateState({centerX: "= 1 + 1", centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 0}, {centerX: -0.75, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 6}, 0.5) // {} (an equation-bound centre is the equation's business)
 */
function interpolateMandelbrotState(from, to, alpha) {
  const KEYS = ["centerX", "centerY", "centerFineX", "centerFineY", "fineExponent", "zoomExponent"];
  for (const key of KEYS)
    if (!Number.isFinite(from[key]) || !Number.isFinite(to[key])) return {};
  const lam = zoomTweenLam(from.zoomExponent, to.zoomExponent, alpha);
  if (!Number.isFinite(lam)) return {};
  const feFrom = fineExponentOf(from), feTo = fineExponentOf(to);
  const x = zoomTweenAxis(
    { coarse: from.centerX, fine: from.centerFineX, fineExponent: feFrom },
    { coarse: to.centerX, fine: to.centerFineX, fineExponent: feTo }, lam);
  const y = zoomTweenAxis(
    { coarse: from.centerY, fine: from.centerFineY, fineExponent: feFrom },
    { coarse: to.centerY, fine: to.centerFineY, fineExponent: feTo }, lam);
  return {
    centerX: x.coarse, centerFineX: x.fine,
    centerY: y.coarse, centerFineY: y.fine,
    fineExponent: feTo,
  };
}

/**
 * THIS WIDGET'S RAMP ASPECT DEFAULTS — the `ramp` bundle's registry defaults
 * (core/properties.js) with the two the fractal OVERRIDES, and the reason each is
 * overridden rather than inherited:
 *
 *   rampLoop: true    The registry default is FALSE, because a gradient PAINT has
 *                     always clamped and must keep rendering byte-identically. A
 *                     Mandelbrot palette is the opposite case: cyclicity is
 *                     MANDATORY (measured, a 1e-12 frame spans 2.4 iterations
 *                     riding on an offset of 1117, so a clamped ramp paints one
 *                     flat colour), so this widget declares it.
 *   rampSpace: oklab  The registry default is sRGB, which is what Skia/SVG/PDF
 *                     gradients do. The named palettes were authored for
 *                     perceptual blending and look wrong without it.
 *
 * ONE declaration, read by BOTH `defaults` (what a new widget gets) and rampOf
 * (what a partial delta falls back to), so the two cannot drift.
 *
 * @example RAMP_DEFAULTS.rampLoop // true
 * @example RAMP_DEFAULTS.rampSpace // "oklab"
 * @example RAMP_DEFAULTS.rampPhase // 0 (inherited from the registry)
 */
const RAMP_DEFAULTS = { ...bundleDefaults("ramp"), rampLoop: true, rampSpace: "oklab" };

/** The named cyclic ramp a FRESH mandelbrot widget gets. Gold is the shipped
 *  default look ("Molten Gold" is the first COLOUR preset) and it is also the
 *  fallback the retired `palette` select documented, so the migration and a fresh
 *  widget agree by construction. */
const DEFAULT_MANDELBROT_RAMP = "gold";

/** The Inspector row the shared `ramp` bundle is spliced in FRONT of, so the
 *  colour block reads ramp-then-scale-then-axis as it always has. */
const RAMP_ROWS_BEFORE = "paletteScale";

/**
 * Pure function. This widget's rows with the shared `ramp` BUNDLE spliced in
 * ahead of `paletteScale`, re-categorised into the widget's own Custom region.
 *
 * WHY A SPLICE RATHER THAN CONCATENATION: the four ramp rows belong in the middle
 * of the colour block, and `inspector` is a flat ordered array — appending them
 * would put the ramp AFTER the boundary glow and the interior colour, i.e. the
 * palette's own colours would sit below every knob that modifies them. Splicing by
 * KEY rather than by index means reordering the widget's own rows can never move
 * the bundle to the wrong place.
 *
 * @param {object[]} rows - this widget's customProps rows
 * @returns {object[]} rows with the four ramp rows inserted
 *
 * @example spliceRampRows([{key: "a"}, {key: "paletteScale"}]).map((r) => r.key)
 * // ["a", "rampStops", "rampLoop", "rampSpace", "rampPhase", "paletteScale"]
 * @example spliceRampRows([{key: "a"}, {key: "paletteScale"}]).length // 6
 */
function spliceRampRows(rows) {
  const at = rows.findIndex((r) => r.key === RAMP_ROWS_BEFORE);
  if (at < 0) throw new Error(`mandelbrot: no "${RAMP_ROWS_BEFORE}" row to splice the ramp bundle in front of — the colour block moved, so update RAMP_ROWS_BEFORE.`);
  const recategorised = Object.fromEntries(bundle("ramp").map((r) => [r.key, { category: CUSTOM_CATEGORY }]));
  return [...rows.slice(0, at), ...bundle("ramp", recategorised), ...rows.slice(at)];
}

// THE LOOK + EXPLORATION KNOBS LIVE IN THE SHADER ENTRY now (mandelbrot_shader.
// MANDELBROT_FILL_PARAMS — the fill-material framework's single-declaration rule:
// "custom properties become material properties"). This widget spreads that SAME
// schema into its customProps and adds only its widget-side geometry knob
// (cornerRadius). The RAMP is deliberately NOT in that schema — a stop-list is not a
// v1 row kind — so it stays the shared `ramp` BUNDLE, spliced into the Inspector by
// spliceRampRows() just before `paletteScale` and defaulted in `defaults` below.
const CUSTOM = customProps([
  ...MANDELBROT_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 0, min: 0, label: "Corner radius", help: "Rounded-corner radius of the panel (world px). 0 = sharp corners." },
]);

/**
 * ── THE THREE PRESET FAMILIES ────────────────────────────────────────────────
 *
 * One list that sets everything is the wrong shape for a fractal, because the three
 * things a fractal picture is made of are INDEPENDENT: WHERE you are, WHAT COLOUR it
 * is, and HOW HARD the renderer works. So there are three families, and they COMPOSE
 * — pick a location, then a colour, then a performance setting, in any order, and
 * none of them disturbs another.
 *
 * WHAT MAKES THAT TRUE IS NOT GOOD INTENTIONS, IT IS DISJOINT KEY SETS.
 * applyPreset writes exactly the keys a preset lists, so two presets can only fight
 * if they name the same key. tests/mandelbrot_test.js asserts the three families'
 * key sets do not intersect, which is what makes "a colour preset can never move the
 * view" a checked property rather than a promise.
 *
 *   LOCATION     centre (5 numbers) + zoomExponent + maxIterations
 *   COLOUR       palette, scale/offset/axis, silk, cloth, relief, glow, interior
 *   PERFORMANCE  interiorTest, interiorThreshold
 *
 * `maxIterations` belongs to LOCATION and not to PERFORMANCE, which is the one
 * assignment worth defending. Iteration demand is a property OF THE PLACE (see the
 * maxIterations help text), and it does NOT degrade gracefully: measured, scaling the
 * budget to 0.3x saves 1.09x on the seahorse and 1.25x on the whole set — nothing —
 * while at 1e-10.5, where the whole frame escapes within a few iterations of 500, the
 * same 0.3x turns 100% OF THE FRAME BLACK. A "draft iterations" knob was designed,
 * measured, and dropped for exactly that reason. Moving the view is a location
 * preset's declared purpose, so LOCATION is the one family allowed to move it.
 *
 * THE SHAPE IS `presetFamilies`, core/registry.js's — `[{id, title, presets}]`,
 * resolved into one Tools-pane group per family (namespaced `presets.<id>`, so a
 * family id can never collide with a command group's). A plugin declares
 * `presetFamilies` OR a flat `presets`, never both; registry.presetFamiliesOf throws
 * on the contradiction, and tests/tool_groups_test.js enforces the disjointness rule
 * across every plugin that declares more than one family.
 */

/**
 * Pure function. A `paletteScale` EQUATION that reads the location's own iteration
 * budget, so the argument means "colour cycles across the whole budget" and the band
 * density follows wherever you go.
 *
 * WHY AN EQUATION AND NOT A NUMBER, measured. `paletteScale` is iterations per
 * colour cycle, so a fixed number gives a wildly different band density at a
 * location needing 200 iterations than at one needing 2048 — and once one pixel
 * spans a whole cycle the analytic band-limit fades the palette to its own mean, so
 * a gold that looks rich at 800 iterations turns into FLAT CREAM at 2048. Rendered
 * side by side at four locations, one equation held up where no single constant did.
 * Equation-valued item properties are established (plugins/tangent_lines.js writes
 * `= self.w / @id.w`); this is the same mechanism inside a preset, and it stays a
 * pure function of document state, keyframable and editable like any other value.
 *
 * NOT FOR EITHER OF THE OTHER TWO AXES, whose scale is not in iterations at all: the
 * screen-distance axis reads OCTAVES of estimated distance per cycle, and the
 * log-iteration axis reads OCTAVES of iteration (the shader's `log2(1 + nu)`). Both
 * take a small plain number with nothing to do with the budget — which is the point
 * of those axes, since a scale in octaves does not need retuning as the view deepens.
 *
 * @param {number} cycles - colour cycles across the whole iteration budget
 * @returns {string} an equation value for `paletteScale`
 *
 * @example paletteCycles(25) // "= self.max_iterations / 25"
 * @example // at maxIterations 2048 that evaluates to 81.92 iterations per cycle
 */
export function paletteCycles(cycles) {
  return `= self.max_iterations / ${cycles}`;
}

/**
 * LOCATIONS, shallowest first. Every coordinate is either published (Wolfgang
 * Beyer's Wikipedia zoom sequence; Robert Munafo's Mu-Ency, whose `@` values are
 * FULL widths, so a half-width is half of one) or produced by Newton in this repo's
 * own solvers and then confirmed against published digits where any exist.
 *
 * EVERY ONE WAS RENDERED AND GATED, and the gate is not taste. A pixel that neither
 * escapes nor gets certified interior has merely run out of budget, and the shader
 * paints it the INTERIOR COLOUR — so an under-iterated view is not blurry, it is
 * BLACK, and it looks exactly like real set. Each location below leaves at most 0.2%
 * of a probe frame in that state at the budget it ships with, and at most 0.9% at the
 * hard cap. That test threw out most of the classical valley views: dwell beside a
 * cardioid cusp is about pi/eps, so a cusp-centred frame of half-width h across W
 * pixels needs about pi*W/(2h) iterations — 7854 at 400 px and h = 0.08, against a
 * cap of MANDELBROT_MAX_ITERATIONS. Munafo's own settings agree: he renders Seahorse
 * Valley at 20000 iterations and the deepest seahorse detail at 200000.
 *
 * `meanIter/px` in each description is the MACHINE-INDEPENDENT cost: the mean number
 * of iterations a pixel actually runs, measured on a float64 mirror of the shader
 * kernel. Wall clock is that times a per-iteration constant plus a fixed per-pixel
 * colouring cost worth roughly 20 iterations (fitted over views from 31 to 503
 * iterations per pixel), so the ratios here are the ratios you will feel — but NOT
 * wall clock, and not even a faithful cost ratio on a CHEAP view: the mirror runs
 * the escape kernel only, so the colour epilogue (a 32-stop samplePalette gather
 * per pixel) is absent from the figure and merely fitted as that constant, which at
 * 30 iterations per pixel is comparable to the whole traced cost.
 */
const LOCATION_PRESETS = [
  {
    name: "Whole Set (home)",
    description: "The whole Mandelbrot set — the view to start a zoom animation from. Tween Zoom exponent up from here. 30 iterations per pixel: the cheapest location here, because the derivative certificate disposes of the 19% of the frame that is interior almost immediately.",
    props: {
      centerX: -0.6, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: -0.2041, maxIterations: 2048,
    },
  },
  {
    name: "Feigenbaum Cascade",
    description: "The period-doubling cascade on the real axis, ending at the Myrberg-Feigenbaum point c = -1.401155189092050: the published accumulation of the 1, 2, 4, 8, ... bulb sequence, each bulb smaller than the last by the universal ratio delta = 4.669201609. The one view here that is a CASCADE rather than a spiral or a rosette, and the only one centred on a constant that appears outside this subject at all. 96 iterations per pixel, 25% of the frame interior. THE TIGHTEST LOCATION HERE against the under-iteration gate (0.67% of a probe frame unfinished against the 1% budget) — the cascade's n-th bulb needs about 2^n iterations to certify, so there is always a little of it the budget cannot finish; move the frame rather than raise the budget if that margin ever has to grow.",
    props: {
      centerX: -1.401155189092050, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 1.1, maxIterations: 2048,
    },
  },
  {
    name: "Period-4 Island (the needle)",
    description: "A miniature copy of the whole set strung on the western antenna, inside a dark starburst of filaments. Its centre is the exact period-4 nucleus (Z_4(c) = 0, found by Newton here and matching the published -1.9407998065294847). 25 iterations per pixel — the cheapest view in the set, and a full-length reference orbit, because a nucleus never escapes.",
    props: {
      centerX: -1.940799806529485, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 2.35, maxIterations: 1500,
    },
  },
  {
    name: "Elephant Parade",
    description: "The chain of heads-and-trunks marching out of the cardioid cusp at c = 1/4, framed OFF the cusp where it is renderable. 114 iterations per pixel. Munafo's Elephant Valley 3, widened and mirrored; the cusp itself is not shippable at any budget this widget has.",
    props: {
      centerX: 0.2925755, centerY: 0.0149977, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 2.6, maxIterations: 2048,
    },
  },
  {
    name: "Seahorse Valley",
    description: "The valley itself, not one of its tails: a whole row of seahorses at once, each a spiral wound on the filament between the cardioid and the period-2 disc. The valley hangs off the PARABOLIC root c = -3/4 (exact — it is where the disc |c + 1| = 1/4 touches the cardioid), and the frame is deliberately off that root, because dwell beside a parabolic point goes as pi/eps and a root-centred frame needs thousands of times this budget. 143 iterations per pixel; the frame was placed by measurement, not quoted. Its companion \"Seahorse Tail\" is one tail of this same valley, three decades further in.",
    props: {
      centerX: -0.7463, centerY: 0.1102, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 2.6, maxIterations: 2048,
    },
  },
  {
    name: "Seahorse Tail",
    description: "The most recognisable image in the whole set — step 04 of Beyer's Wikipedia zoom sequence, at its published centre and diameter. 94 iterations per pixel.",
    props: {
      centerX: -0.7435669, centerY: 0.1314023, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 2.9416, maxIterations: 800,
    },
  },
  {
    name: "Triple Spiral",
    description: "A dense triple logarithmic spiral: Munafo's Triple Spiral Valley 2, the valley hanging off the period-3 bulb's bond point at (-1 + i*sqrt(27))/8. 230 iterations per pixel.",
    props: {
      centerX: -0.15625, centerY: 0.653411, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 3.3116, maxIterations: 1500,
    },
  },
  {
    name: "Scepter Valley",
    description: "A branching scepter: a straight spine of filament with paired side-branches and a minibrot strung on it, which is what the set does at a bond point of ODD internal angle instead of the spirals it makes at even ones. Munafo's Scepter Valley, hanging off the root c = -5/4 where the period-4 bulb meets the period-2 disc (exact — the disc is |c + 1| = 1/4). Framed off the root by measurement for the same parabolic-dwell reason as Seahorse Valley. 137 iterations per pixel at 1500.",
    props: {
      centerX: -1.2505, centerY: 0.0201, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 3.4, maxIterations: 1500,
    },
  },
  {
    name: "Cauliflower Medallion",
    description: "An EMBEDDED JULIA SET — a four-eyed symmetric medallion where the set briefly imitates a Julia set of its own centre. Munafo's cauliflower medallion, beside the period-3 island. 73 iterations per pixel at only 200 iterations: the best picture per iteration in the whole set.",
    props: {
      centerX: -1.74876455, centerY: 0.00000001, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 4.9135, maxIterations: 200,
    },
  },
  {
    name: "Misiurewicz Double Spiral",
    description: "A pair of interlocking logarithmic spirals at a MISIUREWICZ POINT: c whose critical orbit lands exactly on a repelling cycle after a finite pre-period — measured here as M(24,1) with multiplier 1.039. Tan Lei's theorem says the set is asymptotically SELF-SIMILAR under scaling by that multiplier at such a point, which is why the companion preset five decades deeper looks like the same picture. 181 iterations per pixel.",
    props: {
      centerX: -0.775683768009054, centerY: 0.136467368294690, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 5.2, maxIterations: 400,
    },
  },
  {
    name: "Second-Order Embedded Julia",
    description: "A dense network of nested rosettes: an embedded Julia set that itself contains embedded Julia sets, which needs renormalization as well as Tan Lei similarity to exist at all. Step 3 of Munafo's second-order embedded-Julia zoom, beside the period-3 island whose period-101 satellite drives it. 164 iterations per pixel.",
    props: {
      centerX: -1.76866786284, centerY: 0.00164558054, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 5.6478, maxIterations: 800,
    },
  },
  {
    name: "Period-13 Mandala",
    description: "An ornate radial mandala of spikes and spirals around a period-13 minibrot, found by Newton in this repo (atom-domain search then Z_13(c) = 0) rather than quoted. 67 iterations per pixel, and a full-length reference orbit.",
    props: {
      centerX: -1.7848971600749979, centerY: -0.016977287181925371, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 5.9, maxIterations: 2048,
    },
  },
  {
    name: "Starfish (1e-10)",
    description: "An eight-fold rosette of petals at 1e-10.1 — Munafo's starfish, once an ARTMATRIX postcard. 619 iterations per pixel: one of the two dearest locations here, and worth it.",
    props: {
      centerX: -0.124422584272, centerY: -0.839099344521, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 10.1278, maxIterations: 2048,
    },
  },
  {
    name: "Misiurewicz Spiral at the Ceiling (1e-10.5)",
    description: "THE SAME POINT as the Misiurewicz Double Spiral, five decades deeper — and it is recognisably the same picture, which is Tan Lei's self-similarity in one A/B pair. Sitting at the widget's verified depth ceiling with nothing wrongly black and 504 iterations per pixel, this is the deep preset that is actually CORRECT: the iteration count is held just under the reference orbit's own length (792), because a Misiurewicz centre sits on a repelling cycle and its reference eventually escapes.",
    props: {
      centerX: -0.775683768009054, centerY: 0.136467368294690, centerFineX: 0, centerFineY: 0, fineExponent: 0,
      zoomExponent: 10.5, maxIterations: 780,
    },
  },
];

/**
 * The deepest shipped Location preset — the one that demonstrates the ONLY
 * document-level answer to referenceExhaustionRisk, so the report can name it
 * instead of restating its numbers (its budget is held just under its reference's
 * own escape index). Chosen by DEPTH rather than by list position so reordering the
 * presets cannot silently point the advice at the wrong place.
 */
const DEEPEST_LOCATION_PRESET = LOCATION_PRESETS.reduce((a, b) => (b.props.zoomExponent > a.props.zoomExponent ? b : a));

/**
 * THE REFERENCE-EXHAUSTION REPORT — and its being a CONSTANT is the fix, not a
 * stylistic choice. Read this before putting a number back into it.
 *
 * WHAT WENT WRONG. This used to be a template interpolating the reference's escape
 * index, the instantaneous `zoomExponent` and `maxIterations`. All three change on
 * every frame of a zoom tween, and a render job runs on N BROWSERS — N independent
 * module graphs, therefore N independent reportOnce memories. So the job's warning
 * came back holding one message per WORKER, each naming a different frame:
 * eight paragraphs of one problem, quoting "a zoom of 1e-6.420616081593235" (a log
 * glued to an `1e`, which is not a number anyone can read or type) and advising
 * "lower Max iterations to" eight different values for one document-level setting.
 * server.py's merged_warning already deduplicates the worker's report BY LINE, so a
 * text that is a pure function of DOCUMENT-LEVEL facts collapses to exactly one
 * line with no new plumbing anywhere. A constant is the strongest possible way to
 * say that, and it cannot be broken by accident.
 *
 * WHY NO COUNT OR RANGE EITHER, which is the natural next request. Each browser
 * renders a STRIDED subset of the timeline, so "112 frames affected, 91..409
 * iterations" would be one worker's slice, not the job's — eight different
 * summaries instead of eight different single frames, and the dedup would keep all
 * eight. A true per-job tally has to be merged where the job lives, which is a new
 * machine-readable reporting channel and not a widget's business.
 *
 * WHY IT NOW SAYS "CAN" AND NOT "DOES". Measured — the SkSL kernel transcribed
 * op-for-op into fp32 (Math.fround after every operation) against float64 direct
 * iteration, 25 680 samples per view, on the exact frames that raised this report
 * (an escaping reference of 101 and of 370 points at 10^-6.06 and 10^-7.70, budget
 * 2048): NO pixel reached the exhaustion rebase at all, and the smooth-count field
 * matched float64 to 0.01% and 0.07% of samples respectively with the same standard
 * deviation. The reason is structural — a reference that stopped because it ESCAPED
 * has |Z| > 2 in its tail, and the rebasing invariant |d| <= |z| puts any pixel that
 * gets there outside |z| = 1, from which the escape radius is a few squarings away.
 * The flat failure MANDELBROT_REF_LEN measures needs the reference to run out while
 * the pixel orbit is still small, which is a different configuration. The same
 * harness reproduces that failure (refCount forced to 128 at 10^-10.5: 81% of
 * samples wrong, field deviation collapsing from 29.8 to 25.6), so its "not
 * degraded" verdict on an escaping reference is a measurement and not a silence.
 *
 * AND THE STRONGER A/B, which needs no float64 arbiter at all: the same fp32 kernel
 * run against a 4096-POINT reference of the same centre, differing only in reach.
 * At the reported frame the two fields are BYTE-IDENTICAL (mean difference 0.0000,
 * zero samples differing), and they stay identical at 10^-12, where 100% of pixels
 * DO take the exhaustion rebase — because the iterations they run afterwards stay at
 * three however deep the view goes. That is the structural claim, measured.
 */
export const REFERENCE_EXHAUSTION_REPORT = `PowerRP mandelbrot: this centre's reference orbit ESCAPES before its full ${MANDELBROT_REF_LEN} points, Max iterations asks for more iterations than that reference holds, and the view is deeper than 10^-${EXHAUSTION_SAFE_DECADES} — the configuration where the shader must rebase off the END of the reference. There the per-pixel offset can fall below a single-precision ulp of the rebased delta, and where it does every pixel follows one trajectory: the frame goes FLAT rather than glitching, which is the hardest kind of wrong to notice. IT IS A RISK THAT GROWS WITH DEPTH, NOT A CERTAINTY — measured out to 10^-7.7 an escaping reference never reaches that rebase, because its tail is already outside |Z| = 2 and a pixel there escapes within a few squarings — so LOOK AT THE DEEPEST FRAMES of the shot rather than trusting either this line or the render. SAID ONCE PER RENDER, DELIBERATELY: the escape index, the zoom and the budget all change on every frame of a zoom, so a per-frame line puts one copy per render worker in a job's warning and quotes a different value in each. THE FIX IS AUTHORIAL, so nothing here is rewritten: move the centre onto a point whose orbit does NOT escape (a minibrot's nucleus), since an escaping centre structurally cannot carry a long reference; or end the zoom shallower than 10^-${EXHAUSTION_SAFE_DECADES}; or hold Max iterations under the escape index the way the shipped "${DEEPEST_LOCATION_PRESET.name}" Location preset does. No number is offered for that last one ON PURPOSE — the safe budget is the SMALLEST escape index the whole tween passes through, and one frame cannot know it.`;

/**
 * COLOURS. Palette and colouring stack ONLY: no centre, no zoom, no iteration count,
 * so any of these lands on any location. Every one was rendered at a SHALLOW
 * (1e-2.9, 800 iterations), a MIDDLE (1e-5.9, 2048) and a DEEP (1e-10.5, 780)
 * location, because a palette that looks good shallow and dies deep is a bug and not
 * a style: two candidates (a triangle-average "woven cloth" and a log-axis rainbow)
 * were dropped for exactly that, and two more were retuned after going flat at the
 * middle location. `paletteScale` is therefore an equation — see paletteCycles.
 */
/**
 * Pure function. The RAMP half of a COLOUR preset's `props`: a ramp's stops plus
 * the aspects that decide how it is read, as the four keys a preset writes.
 *
 * WHY A HELPER AND NOT FOUR LITERAL KEYS PER PRESET: nine presets would each
 * re-type `rampLoop: true, rampSpace: "oklab", rampPhase: 0`, and the moment one
 * was typed wrong that preset would silently render a clamped or a muddy palette.
 * It also keeps every preset's key SET identical, which is what the disjoint-key
 * guarantee between the three families rests on (tests/tool_groups_test.js).
 *
 * @param {{offset: number, color: string}[]} stops - the ramp
 * @returns {object} the four ramp keys a preset writes
 *
 * @example Object.keys(rampProps([{offset: 0, color: "#000"}, {offset: 0.5, color: "#fff"}]))
 * // ["rampStops", "rampLoop", "rampSpace", "rampPhase"]
 * @example rampProps([{offset: 0, color: "#000000"}, {offset: 0.5, color: "#ffffff"}]).rampLoop // true
 */
function rampProps(stops) {
  return { rampStops: stops, ...RAMP_DEFAULTS };
}

/**
 * Pure function. A COLOUR preset's ramp keys for one of the NAMED cyclic ramps —
 * read from the ONE home the preset library also reads (core/ramps.js
 * CYCLIC_RAMPS), so a preset and a picker swatch of the same name can never
 * disagree.
 *
 * @param {string} id - a CYCLIC_RAMPS key
 * @returns {object} the four ramp keys
 *
 * @example namedRampProps("gold").rampStops.length // 8
 * @example namedRampProps("gold").rampSpace // "oklab"
 */
function namedRampProps(id) {
  return rampProps(cyclicRampStops(id));
}

/**
 * Pure function. A COLOUR preset's ramp keys for a bespoke CYCLIC colour list —
 * the three presets that used to carry a comma-separated `paletteStops` override
 * string. The colours are spaced i/N round the circle, which is exactly what the
 * old comma-separated override resolved to, so those three presets render
 * unchanged.
 *
 * @param {string[]} colors - two or more hex colours, in cycle order
 * @returns {object} the four ramp keys
 *
 * @example cyclicRampProps(["#000000", "#ffffff"]).rampStops // [{offset: 0, color: "#000000"}, {offset: 0.5, color: "#ffffff"}]
 * @example cyclicRampProps(["#0b0d10", "#6e7680", "#e8eef5", "#6e7680"]).rampStops.length // 4
 */
function cyclicRampProps(colors) {
  return rampProps(evenlySpacedRampStops(colors, true));
}

const COLOUR_PRESETS = [
  {
    name: "Molten Gold",
    description: "Molten metal with a glowing rim: silk over woven cloth over lit relief, in a warm gold ramp. The default look.",
    props: {
      ...namedRampProps("gold"), paletteScale: paletteCycles(50), colorAxis: "iteration",
      stripeAmount: 0.45, stripeDensity: 4, triangleAmount: 0.3, shadeAmount: 0.45, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.3, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Ultra Fractal Blue",
    description: "The classic deep-zoom look: navy through cream to amber, the highest-contrast palette here. If a view seems washed out in anything else, try this first.",
    props: {
      ...namedRampProps("ultrafractal"), paletteScale: paletteCycles(33), colorAxis: "iteration",
      stripeAmount: 0.55, stripeDensity: 4, triangleAmount: 0.25, shadeAmount: 0.5, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.3, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Twilight Rose",
    description: "Dusk and wine over pale silk — matplotlib's natively cyclic twilight ramp, heavy on the stripe average. Retuned from 12 to 25 cycles after it went flat purple at a 2048-iteration location.",
    props: {
      ...namedRampProps("twilight"), paletteScale: paletteCycles(25), colorAxis: "iteration",
      stripeAmount: 0.6, stripeDensity: 5, triangleAmount: 0.15, shadeAmount: 0.35, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.25, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Ice Porcelain",
    description: "White lace on deep blue with a bright boundary rim — the coldest and cleanest of the set, and the one that shows filament detail best.",
    props: {
      ...namedRampProps("ice"), paletteScale: paletteCycles(85), colorAxis: "iteration",
      stripeAmount: 0.5, stripeDensity: 6, triangleAmount: 0.2, shadeAmount: 0.4, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.35, glowWidth: 1.2, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Ember Forge",
    description: "Charcoal into flame, with the cloth texture pushed up and the light raking low. The warmest and darkest look here.",
    props: {
      ...namedRampProps("ember"), paletteScale: paletteCycles(25), colorAxis: "iteration",
      stripeAmount: 0.4, stripeDensity: 3, triangleAmount: 0.35, shadeAmount: 0.5, lightAngle: -45, lightHeight: 1.2,
      glowAmount: 0.4, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Brushed Chrome",
    description: "Machined metal: a near-neutral grey ramp with the stripe average almost fully open and the relief hard, which is what makes the escape-time field read as a turned metal surface rather than as colour. The only look here with no hue at all.",
    props: {
      ...cyclicRampProps(["#0b0d10", "#6e7680", "#e8eef5", "#6e7680"]), paletteScale: paletteCycles(20), colorAxis: "iteration",
      stripeAmount: 0.9, stripeDensity: 8, triangleAmount: 0.1, shadeAmount: 0.75, lightAngle: -60, lightHeight: 0.7,
      glowAmount: 0.15, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#05070a",
    },
  },
  {
    name: "Neon Filament",
    description: "Electric cyan filaments on near-black: the distance-estimate glow carries the picture and the palette stays out of the way. Retuned from 16 cycles and 1.3 glow, which blew out to flat white at a 2048-iteration location.",
    props: {
      ...cyclicRampProps(["#03010a", "#1b0a3a", "#4b1e8c", "#10d0ff", "#b8f8ff", "#10d0ff", "#4b1e8c", "#1b0a3a"]), paletteScale: paletteCycles(40), colorAxis: "iteration",
      stripeAmount: 0.2, stripeDensity: 4, triangleAmount: 0.1, shadeAmount: 0.15, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.9, glowWidth: 0.7, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Blueprint",
    description: "A flat two-tone technical look with no silk, no cloth and no relief — just the boundary picked out in white on blue. For a figure on a slide, where a lit metal fractal would fight the text.",
    props: {
      ...cyclicRampProps(["#071a2b", "#1e5f8f", "#cfe8ff", "#1e5f8f"]), paletteScale: paletteCycles(30), colorAxis: "iteration",
      stripeAmount: 0, stripeDensity: 4, triangleAmount: 0, shadeAmount: 0, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.55, glowWidth: 1.4, bandLimit: true, boundaryAA: false, interiorColor: "#04101c",
    },
  },
  {
    name: "Contour Map",
    description: "Smooth magma contours banded on the DISTANCE to the set instead of on the iteration count, so the picture reads as a relief map rather than as escape time. This is the one look here that never needs retuning as you zoom: the distance estimate in pixels is distributed identically at every depth, so its scale is octaves rather than iterations and 1.15 is 1.15 at 1e-2 and at 1e-10 alike. Verified at 1e-2.9 and 1e-10.5 side by side — the band density is visibly the same in both. THE COLOUR PRESET TO REACH FOR WHEN TWEENING A ZOOM, since an iteration-axis palette drifts under one and this cannot.",
    props: {
      ...namedRampProps("magma"), paletteScale: 1.15, colorAxis: "distance",
      stripeAmount: 0, stripeDensity: 4, triangleAmount: 0, shadeAmount: 0.35, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.2, glowWidth: 1.6, bandLimit: true, boundaryAA: false, interiorColor: "#05030a",
    },
  },
  {
    name: "Verdigris Octave",
    description: "Oxidised copper: pale mint lace over patina green, banded on the LOG of the iteration count, where n..2n is one cycle. That axis is the middle ground between the other two — it still follows the escape time, but its bands hold their density as the view deepens instead of crowding, so a slow zoom keeps its texture. The only green in the set, and deliberately so: it has to be told apart from Ice Porcelain at a glance, which shares its lace but not its hue.",
    props: {
      ...cyclicRampProps(["#101a14", "#1f6f5c", "#7fd6b4", "#e8f7ee", "#7fd6b4", "#1f6f5c"]), paletteScale: 0.42, colorAxis: "logIteration",
      stripeAmount: 0.35, stripeDensity: 5, triangleAmount: 0.2, shadeAmount: 0.4, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.3, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#0a120e",
    },
  },
  {
    name: "Etched Plate",
    description: "Ink on laid paper: the only look here that turns EDGE COVERAGE BLEND on, so the set's boundary is blended by what the distance estimate says the set covers of each pixel — the physically-motivated antialias, which the widget's own help says overstates coverage. That is a defect on a cream lace filament field and exactly right here, where the overstatement is what thickens the ink and makes the plate read as a print rather than as a render. Raking light at -120 degrees and a low lamp do the rest. Rendered against Brushed Chrome at the same location to confirm it is a second monochrome and not the same one: chrome is satin on a dark ground, this is black on a light one.",
    props: {
      ...cyclicRampProps(["#f4efe4", "#1b1a17", "#f4efe4", "#8a8478"]), paletteScale: paletteCycles(60), colorAxis: "iteration",
      stripeAmount: 0.25, stripeDensity: 6, triangleAmount: 0.15, shadeAmount: 0.6, lightAngle: -120, lightHeight: 0.9,
      glowAmount: 0.2, glowWidth: 1, bandLimit: true, boundaryAA: true, interiorColor: "#1b1a17",
    },
  },
  {
    name: "Flat Escape Time (the control)",
    description: "Silk, cloth, relief, glow and the band-limit ALL OFF: a plain banded 1990s escape-time fractal. Not a look to ship a slide with — a control. Put it beside any other colour preset at the same location to see what the modern colour stack is actually doing.",
    props: {
      ...namedRampProps("ultrafractal"), paletteScale: paletteCycles(33), colorAxis: "iteration",
      stripeAmount: 0, stripeDensity: 4, triangleAmount: 0, shadeAmount: 0, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0, glowWidth: 1, bandLimit: false, boundaryAA: false, interiorColor: "#000000",
    },
  },
];

/**
 * PERFORMANCE — and the honest answer to "what speed knobs exist here", which is
 * fewer than one would hope.
 *
 * WHAT DOES NOT EXIST: a resolution or downsample control. This material runs its
 * per-pixel loop once per DEVICE PIXEL, and nothing in the widget's state changes
 * that. Adding one means drawing the materialFill into an offscreen surface at 1/N
 * scale and blitting it up — a change in render_gpu/skia/paint_skia.js, not here —
 * and it would be the single largest speed dial available, since it removes N^2 of
 * the work outright. Quantizing the sample grid inside the shader instead would NOT
 * help: the invocations still all run.
 *
 * WHAT DOES NOT WORK: turning the iteration budget down. Measured — 0.3x the budget
 * buys 1.09x on the seahorse tail and 1.25x on the whole set, and at 1e-10.5 it
 * blacks out the entire frame, because there the whole picture escapes within a few
 * iterations of 500 and a budget is either enough or it is not. See the family note
 * above.
 *
 * WHAT ACTUALLY WORKS is the interior certificate, and its whole cost lives in these
 * two knobs. Measured in iterations per pixel on the whole-set view (19% interior),
 * which is the case where any of this matters:
 *
 *     threshold 1e-2   24 it/px      certificate OFF   408 it/px
 *     threshold 1e-3   31 it/px      (13.3x dearer, and pixel-identical)
 *     threshold 1e-5   42 it/px
 *
 * On a view with NO interior in frame all four measure identically (1.00x) — there
 * is nothing to certify. So this family is a real dial on interior-heavy views and a
 * no-op elsewhere, which is exactly what it should be, and why the number that
 * actually predicts a slide's cost is printed on the LOCATION preset instead.
 */
const PERFORMANCE_PRESETS = [
  {
    name: "Fast Interior Test",
    description: "Declares a point interior as soon as the derivative product falls below 1e-2. Measured 24 iterations per pixel on the whole set against 31 for the standard setting — about 0.8x the cost, with the same 19.4% of the frame certified. No effect at all on a view with no interior in frame.",
    props: { interiorTest: "derivative", interiorThreshold: 1e-2 },
  },
  {
    name: "Standard Interior Test",
    description: "The default: the derivative certificate at 1e-3. 31 iterations per pixel on the whole set. Use this to get back after trying the others.",
    props: { interiorTest: "derivative", interiorThreshold: 1e-3 },
  },
  {
    name: "Cautious Interior Test",
    description: "Waits for the derivative product to reach 1e-5 before declaring a point interior. 42 iterations per pixel on the whole set — about 1.35x the standard cost — and it certifies 19.2% rather than 19.4%, i.e. it stops just short of the boundary instead of a hair inside it.",
    props: { interiorTest: "derivative", interiorThreshold: 1e-5 },
  },
  {
    name: "Brute Force (verification)",
    description: "No interior certificate: every interior pixel runs the full iteration budget. 408 iterations per pixel on the whole set — 13.3x the standard cost, and PIXEL-IDENTICAL. This is not a quality setting; it exists so the certificate can be checked against brute force, which is the only way to know it is not filling pixels that would have escaped.",
    props: { interiorTest: "off", interiorThreshold: 1e-3 },
  },
];

/** THE THREE FAMILIES in the registry's shape, shallowest concern first: where you
 *  are, then what colour it is, then how hard the renderer works. */
const PRESET_FAMILIES = [
  { id: "location", title: "Locations", presets: LOCATION_PRESETS },
  { id: "colour", title: "Colours", presets: COLOUR_PRESETS },
  { id: "performance", title: "Performance", presets: PERFORMANCE_PRESETS },
];

export const mandelbrotPlugin = {
  type: "demo_mandelbrot",
  ephemeral: EPHEMERAL.NONE,
  title: "Mandelbrot",
  capabilities: { bbox: true, transform: true, resizable: true },
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): INTERIOR
  // EXPLORE MODE — drag to pan inside the fractal, wheel to zoom inside it, Escape
  // to leave. `interiorView` below is that mode's CONTENT (the two pure questions
  // web/interiorNav.js asks it); this string is what says a double-click enters it.
  activate: "navigate_interior",
  /**
   * THE INTERIOR VIEW — the web/interiorNav.js contract, and the reason exploring
   * a fractal needed no fractal-specific editor code at all.
   *
   * Navigation writes THIS WIDGET'S OWN keyframable properties, never a transient
   * editor camera: RenderTree = pure(document, [[slide, alpha]]), so an interior
   * view held in the editor would make a reload, a CLI render and a PDF export all
   * disagree with the screen. Writing ordinary properties is also what makes an
   * explored view tweenable and `=`-bindable at no extra cost — and it is why a
   * coordinate already bound to an `=` equation REFUSES the mode outright
   * (interiorNav's equationBoundInteriorProps) rather than being flattened to the
   * number it currently evaluates to.
   *
   * Interior units are COMPLEX units, and the window IS the rect emit() renders.
   */
  interiorView: {
    /**
     * Pure function. State → the complex window the panel shows. The half-width
     * is `10^(-zoomExponent)` (emit()'s `halfWidth`), and the complex half-height
     * is that times the box aspect h/w — matching the shader's `uv · aspect`, so
     * the window the user drags is exactly the window that renders.
     *
     * @param {object} s - folded item state (the split centre, zoomExponent, w, h)
     * @returns {{x: number, y: number, w: number, h: number}} complex-plane rect
     *
     * @example mandelbrotPlugin.interiorView.window({centerX: 0, centerY: 0, zoomExponent: 0, w: 200, h: 100}) // {x: -1, y: -0.5, w: 2, h: 1} (half-width 1, half-height 0.5 from the 2:1 box)
     * @example mandelbrotPlugin.interiorView.window({centerX: 0, centerFineX: 50, fineExponent: 2, centerY: 0, zoomExponent: 1, w: 100, h: 100}) // {x: 0.4, y: -0.1, w: 0.2, h: 0.2} (centre 0.5 = coarse 0 + fine 50e-2)
     */
    window(s) {
      const fe = fineExponentOf(s);
      const halfW = halfWidthOf(s);
      const halfH = halfW * ((s.h || 1) / (s.w || 1));
      return { x: approxCentre(s.centerX, s.centerFineX, fe) - halfW, y: approxCentre(s.centerY, s.centerFineY, fe) - halfH, w: 2 * halfW, h: 2 * halfH };
    },
    /**
     * Pure function. A new window → the keyframable writes that store it. EACH AXIS
     * SENDS ITS DELTA TO THE LEAF THAT CAN HOLD IT: the FINE slot when the coarse
     * leaf cannot resolve the delta (coarseLeafHolds), the coarse leaf when it can —
     * and the other leaf is left ALONE either way, so a typed 32-digit coordinate
     * keeps its deep digits through a drag. The zoom is inverted from the window's
     * own half-width and clamped at MIN_ZOOM_EXPONENT, the same floor the Inspector
     * row enforces.
     *
     * WHY THE ROUTE IS A CONDITION AND NOT ALWAYS THE FINE SLOT — measured. This
     * sent EVERY delta to the fine slot whenever `fineExponent > 0`, which scales it
     * by 10^fineExponent with nothing relating the two, so a pan at a SHALLOW zoom
     * with a large exponent stored wrote a fine value far outside its intended range:
     * at the exponent ceiling the row used to declare (80), one 50-px wheel tick at
     * the shallowest zoom wrote 1.9e80 (a full-frame pan, 2e81) and the next render
     * threw from inside scaledDecimal, which — inside CanvasView's render $effect —
     * froze the editor. MANDELBROT_MAX_FINE_EXPONENT bounds that
     * write to 4e16 for any legitimate view; the route is what makes the fine slot's
     * growth IMPOSSIBLE rather than merely slow (unrouted, at the ceiling, 1e5
     * complex units of panning — 25 000 whole-set diameters — still reaches the wall).
     *
     * AND THE ROUTE COSTS NOTHING, which is the measurement that matters: `window`
     * builds the window from approxCentre, a FLOAT64 sum, so the delta this function
     * sees is a difference of two float64s near |c| — either exactly 0 or at least
     * one ulp of the centre. Measured on a 520-px box, a 50-px wheel tick arrives as
     * 2.2e-16 at zoomExponent 15 and as EXACTLY 0 at 16 and deeper. So every delta
     * the fine slot ever received was one the coarse leaf could hold, and the deltas
     * the coarse leaf cannot hold arrive as zero: the depth of an interior PAN is
     * bounded at about 1e-16 by the float64 window, whatever the fine exponent says.
     * Lifting that bound means carrying the interior window itself in the split
     * representation, which is a change to the interiorView contract, not to this
     * function — and until it happens the fine slot is written by the toolbar's typed
     * coordinate (parseSplitCentre), the Inspector and the tween, never by a pan.
     *
     * @param {object} s - folded item state (the window is re-derived from it)
     * @param {{x: number, y: number, w: number, h: number}} win - the new complex window
     * @returns {object} a flat {stateKey: value} map of keyframable leaves
     *
     * @example mandelbrotPlugin.interiorView.writes({centerX: 0, centerY: 0, zoomExponent: 0, w: 200, h: 100}, {x: 0.9, y: -0.05, w: 0.2, h: 0.1}) // {zoomExponent: 1, centerX: 1, centerY: 0} (zoomed ten-fold onto c = 1)
     * @example mandelbrotPlugin.interiorView.writes({centerX: 0, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 2, zoomExponent: 1, w: 100, h: 100}, {x: 0.4, y: -0.1, w: 0.2, h: 0.2}) // {zoomExponent: 1, centerX: 0.5, centerY: 0} (a 0.5 pan is nothing like fine: the coarse leaf holds it exactly)
     * @example mandelbrotPlugin.interiorView.writes({centerX: -0.7435669, centerY: 0.1314023, centerFineX: 3, centerFineY: 0, fineExponent: 16, zoomExponent: 2, w: 100, h: 100}, {x: -0.7435668999999997, y: 0.1214023, w: 0.02, h: 0.02}) // {zoomExponent: 2, centerX: -0.7335669, centerFineY: 0} (a 0.01 pan: coarse takes it and centerFineX's 3e-16 is left alone, so the sum stays exact)
     * @example mandelbrotPlugin.interiorView.writes({centerX: -0.7435669, centerY: 0.1314023, centerFineX: 3, centerFineY: 0, fineExponent: 16, zoomExponent: 2, w: 100, h: 100}, {x: -0.7535668999999997, y: 0.1214023, w: 0.02, h: 0.02}) // {zoomExponent: 2, centerFineX: 3, centerFineY: 0} (an UNMOVED window: both axes stay in the fine leaf — this is the set equationBoundInteriorProps reads)
     */
    writes(s, win) {
      const fe = fineExponentOf(s);
      const old = mandelbrotPlugin.interiorView.window(s);
      const dx = (win.x + win.w / 2) - (old.x + old.w / 2);
      const dy = (win.y + win.h / 2) - (old.y + old.h / 2);
      const unit = Math.pow(10, fe);
      const out = { zoomExponent: clampedZoomExponent(-Math.log10(win.w / 2)) };
      if (fe > 0 && !coarseLeafHolds(approxCentre(s.centerX, s.centerFineX, fe), dx))
        out.centerFineX = (s.centerFineX ?? 0) + dx * unit;
      else out.centerX = (s.centerX ?? 0) + dx;
      if (fe > 0 && !coarseLeafHolds(approxCentre(s.centerY, s.centerFineY, fe), dy))
        out.centerFineY = (s.centerFineY ?? 0) + dy * unit;
      else out.centerY = (s.centerY ?? 0) + dy;
      return out;
    },
  },
  /**
   * Pure function. THE FLOATING BAR (web/CanvasToolbar.svelte's `fields` spec) —
   * the on-canvas readout explore mode puts above the widget.
   *
   * The user's request: "there's no visual indication when I'm editing it. There
   * should be a bar just like text editing or cursors on the top in the canvas …
   * it should … tell me the coordinates that I'm zooming into and stuff so that I
   * can actually edit those in text on the top. And maybe some other quick toolbar
   * things for controlling different properties of the Mandelbrot."
   *
   * ── WHY THESE FIVE FIELDS, ARGUED FROM THE PROPERTY LIST ─────────────────────
   * The three coordinates are the request. The two extra knobs are not a guess:
   * they are the ONLY two properties this file itself names as the thing to reach
   * for, and both citations are above.
   *   `maxIterations`  — the header's own words: "it is the FIRST thing to turn down
   *                      if a slide feels slow"
   *   `paletteScale`   — its row's help: "This is the knob to reach for when a view
   *                      looks either stripey or washed out"
   * Everything else stays in the Inspector, where a 26-row widget belongs; a bar
   * that grew to a second Inspector would be a worse Inspector.
   *
   * ── WHY Re/Im ARE ONE FIELD EACH AND NOT TWO ─────────────────────────────────
   * A centre axis is stored as coarse + fine (five leaves for two numbers), but a
   * COORDINATE is one number and pasting one is the whole point of the field. So
   * each axis shows the EXACT decimal sum (splitCentreText — never the float64
   * `approxCentre`, which would drop the deep half) and takes a typed value back
   * through parseSplitCentre, which re-splits it losslessly. `keys` names the
   * stored leaves the field would write, so the host can refuse to clobber an `=`
   * equation on any of them — the same ruling interior explore already makes.
   *
   * @param {object} s - folded, EVALUATED item state
   * @returns {{fields: object[]}} the toolbar spec
   */
  floatingToolbar(s) {
    const fe = fineExponentOf(s);
    return {
      label: "Mandelbrot view",
      fields: [
        { id: "centreRe", label: "Re", value: splitCentreText(s.centerX, s.centerFineX, fe), keys: ["centerX", "centerFineX"], size: "wide", help: "Real part of the view centre, to every digit the split centre carries. Paste a published deep-zoom coordinate here." },
        { id: "centreIm", label: "Im", value: splitCentreText(s.centerY, s.centerFineY, fe), keys: ["centerY", "centerFineY"], size: "wide", help: "Imaginary part of the view centre, to every digit the split centre carries." },
        { id: "zoom", label: "Zoom", value: String(s.zoomExponent ?? 0), keys: ["zoomExponent"], size: "narrow", help: "Magnification as a decimal exponent: the view's half-width is 10^(-Zoom), so 6 is a 1e-6 window. Tween this for a zoom." },
        { id: "iterations", label: "Iter", value: String(s.maxIterations ?? 0), keys: ["maxIterations"], size: "narrow", help: "The iteration budget — the first thing to turn down if a slide feels slow, and to turn UP if the frame goes black." },
        { id: "bands", label: "Bands", value: String(s.paletteScale ?? 0), keys: ["paletteScale"], size: "narrow", help: "Iterations per colour cycle. The knob to reach for when a view looks either stripey or washed out." },
      ],
    };
  },
  /**
   * Pure function. A bar field's typed text → the keyframable writes that store it,
   * or null when the text is not a value this field accepts (the host then leaves
   * the field alone rather than committing a guess).
   *
   * The centre fields go through parseSplitCentre, so a 30-digit paste keeps its
   * digits; the zoom goes through the SAME floor the Inspector row and the explore
   * gestures use. Writing ordinary state keys is what makes a typed coordinate
   * keyframe and tween like any other value.
   *
   * @param {object} s - folded item state
   * @param {string} id - the field id from floatingToolbar
   * @param {string} text - what the user typed
   * @returns {object|null} a flat {stateKey: value} map, or null
   *
   * @example mandelbrotPlugin.fieldWrites({fineExponent: 0}, "centreRe", "-0.75") // {centerX: -0.75, centerFineX: 0}
   * @example mandelbrotPlugin.fieldWrites({fineExponent: 0}, "zoom", "6") // {zoomExponent: 6}
   * @example mandelbrotPlugin.fieldWrites({fineExponent: 0}, "zoom", "-99") // {zoomExponent: -1} (clamped to the row's own floor)
   * @example mandelbrotPlugin.fieldWrites({fineExponent: 0}, "iterations", "1200") // {maxIterations: 1200}
   * @example mandelbrotPlugin.fieldWrites({fineExponent: 0}, "centreRe", "banana") // null
   */
  fieldWrites(s, id, text) {
    const fe = fineExponentOf(s);
    if (id === "centreRe" || id === "centreIm") {
      const split = parseSplitCentre(text, fe);
      if (!split) return null;
      return id === "centreRe"
        ? { centerX: split.coarse, centerFineX: split.fine }
        : { centerY: split.coarse, centerFineY: split.fine };
    }
    const n = Number(String(text).trim());
    if (String(text).trim() === "" || !Number.isFinite(n)) return null;
    if (id === "zoom") return { zoomExponent: clampedZoomExponent(n) };
    if (id === "iterations") return { maxIterations: Math.max(1, Math.min(MANDELBROT_MAX_ITERATIONS, Math.round(n))) };
    if (id === "bands") return { paletteScale: Math.max(MIN_PALETTE_SCALE, n) };
    throw new Error(`mandelbrot fieldWrites: unknown field "${id}" (declared: centreRe, centreIm, zoom, iterations, bands)`);
  },
  // THE COUPLED-STATE TWEEN (core/document.js tweenedState). The centre and the
  // zoom are not independent knobs — a linear-in-alpha centre leaves an
  // exponentially shrinking frame — so the widget declares how ITS state tweens
  // rather than leaving the generic per-leaf lerp to produce a zoom that curves
  // away and snaps back. See interpolateMandelbrotState / zoomTweenLam above for
  // the law, the measurement, and the three cases that defer to the generic lerp.
  interpolateState: interpolateMandelbrotState,
  // paletteOffset → rampPhase: a pure KEY RENAME, so it goes through the
  // declarative seam core/document.js withLegacyKeysRenamed already applies at the
  // load boundary (the arrow's headSize → headLength precedent). The value moves
  // VERBATIM — numbers, equation strings and keyframed animations all survive — so
  // an old palette-cycling animation keeps cycling.
  // THE OTHER TWO legacy keys (`palette`, `paletteStops`) are NOT renames: two
  // properties collapse into one ramp with a VALUE transform, which legacyKeys
  // cannot express. That migration is core/ramp_migration.js.
  legacyKeys: { paletteOffset: "rampPhase" },
  defaults: {
    type: "demo_mandelbrot", x: 140, y: 140, w: 520, h: 390, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint hairline framing the panel (optional; strokeWidth 0 = none).
    stroke: "rgba(255,255,255,0.28)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    // THE DEFAULT RAMP: gold, from the ONE home the preset library also reads
    // (core/ramps.js CYCLIC_RAMPS) — a literal colour list here would be the
    // mirror this consolidation exists to remove. Fresh stops, never the shared
    // record, so a document can never alias author-time data.
    rampStops: cyclicRampStops(DEFAULT_MANDELBROT_RAMP),
    ...RAMP_DEFAULTS,
    ...CUSTOM.defaults,     // the mandelbrot.* knobs (self.*)
  },
  inspector: [
    ...bundle("transform"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    // The look knobs, with the shared `ramp` BUNDLE spliced in just before
    // `paletteScale` so the colour rows still read as one block. The bundle's rows
    // are re-categorised into the widget's own "Custom" region (a row's category is
    // an overridable aspect — core/properties.js props()) because that is where
    // every other knob of this widget lives; filing four of them under Formatting
    // would split one concept across two accordions.
    ...spliceRampRows(CUSTOM.rows),
  ],
  // Three DECLARED families, one Tools-pane group each. NOT also a flat `presets`:
  // core/registry.js refuses both at once, and a flat list is what the split exists
  // to replace.
  presetFamilies: PRESET_FAMILIES,
  /**
   * Near-pure function (memoized reference orbit + palette bake; both pure in
   * their inputs). State → display-list: ONE materialFill op naming the
   * "mandelbrot" material. The bbox (w, h) IS the panel (local space; sceneIR
   * wraps it in the node's world) and fixes the fractal window's aspect;
   * `zoomExponent` fixes its complex half-width; the split centre becomes the
   * long-number reference orbit. The `interiorTest` / `colorAxis` select strings
   * map to the shader's numeric codes (the metaballs TYPE_CODE pattern) and the
   * light angle converts degrees to radians here.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    const ref = cachedOrbit(s);
    const pal = cachedPalette(s);
    const fineExponent = Math.max(0, Math.round(s.fineExponent ?? 0));
    // A zoom deeper than the split centre can resolve does not fail — it renders a
    // perfectly valid view of a QUANTIZED neighbour of the requested point, which
    // is exactly the kind of plausible-but-wrong result that must never be silent.
    // A STORED fine exponent past the ceiling: a document written while the row
    // offered 80. NOTHING IS REWRITTEN — the pair still names a real coordinate, and
    // lowering the exponent alone would MOVE THE VIEW by 10^(fineExponent - ceiling)
    // fine units, which is exactly the silent relocation this widget's tests exist to
    // prevent (see MANDELBROT_MAX_FINE_EXPONENT). So it is said out loud, with the two
    // consequences and the one migration that keeps the coordinate.
    if (fineExponent > MANDELBROT_MAX_FINE_EXPONENT) {
      reportOnce(`mandelbrot-fine-exponent-${fineExponent}`, `PowerRP mandelbrot: fine exponent ${fineExponent} is past the ${MANDELBROT_MAX_FINE_EXPONENT} two plain numbers can use — the centre resolves to about 1e-${centreResolutionDecades(fineExponent)} either way, and every fine-slot write scales its delta by 10^${fineExponent}, which passes the exact-decimal formatter's limit after only 1e${21 - fineExponent} complex units of panning. TO KEEP THIS COORDINATE: lower Fine exponent to ${MANDELBROT_MAX_FINE_EXPONENT}, then re-enter the coordinate in the floating bar. The exponent change alone MOVES THE VIEW (the fine offsets change units); a typed coordinate is re-split losslessly and puts it back.`);
    }
    // NO PER-FRAME NUMBER IN THIS LINE, for the reason REFERENCE_EXHAUSTION_REPORT
    // spells out at length: `zoomExponent` changes on every frame of a zoom tween and
    // a render job runs N BROWSERS, so quoting the instantaneous value puts one
    // paragraph per worker in the job's warning, each naming a different frame. The
    // fine exponent and the resolution it buys are DOCUMENT-level facts, so this text
    // is one line however many frames trip it. It also names the cost consequence,
    // because a bound that is applied and not mentioned is a silent degradation.
    const resolvable = centreResolutionDecades(fineExponent);
    if ((s.zoomExponent ?? 0) > resolvable) {
      reportOnce(`mandelbrot-centre-resolution-${fineExponent}`, `PowerRP mandelbrot: this view zooms deeper than the centre can resolve at fine exponent ${fineExponent} (good to about 1e-${resolvable}). The view is centred on a quantized neighbour of the requested point, and past 1e-${MANDELBROT_MAX_RESOLVABLE_DECADES} the reference orbit stops gaining precision with the zoom (orbitBitsFor's cap — deeper digits would be exact digits of the WRONG point). Raise "Fine exponent" (${MANDELBROT_MAX_FINE_EXPONENT} is the usual deep-zoom setting) and move the extra digits into "Centre X/Y fine".`);
    }
    // A SHORT reference is the widget's one silent-wrong-image risk. Running past
    // the reference's end is normal and measured-safe at the shipped full length
    // (1024 points drive 2048 iterations at 1e-10.5, indistinguishable from a
    // 2048-point reference) — so what is worth reporting is not "maxIterations
    // exceeds the reference" but "the reference came out SHORTER THAN FULL LENGTH",
    // which happens when the chosen centre escapes. See referenceExhaustionRisk for
    // the predicate and REFERENCE_EXHAUSTION_REPORT for why the message carries no
    // per-frame number: a zoom TWEEN passes through hundreds of these states, and one
    // report per state is one report per render worker in the job's warning.
    if (referenceExhaustionRisk(s, ref)) reportOnce(REFERENCE_EXHAUSTION_REPORT);
    return [materialFill({
      material: "mandelbrot",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      // THE ONE schema→uniform mapper the fill path also uses
      // (mandelbrot_shader.mandelbrotUniformParams): the widget passes its MEMOIZED
      // orbit (cachedOrbit) and its STATE-ramp palette (cachedPalette); a fill passes
      // a fresh orbit + the default gold palette. `s` carries rampPhase (the ramp
      // bundle key, default 0), which the mapper reads as the shader's paletteOffset —
      // identical to the old inline `rampOf(s).phase`.
      params: mandelbrotUniformParams(s, ref, pal),
      stroke: strokeW > 0 ? s.stroke : null,
      strokeWidth: strokeW,
      opacity: s.opacity ?? 1,
    })];
  },
  hitTest(s, lx, ly) {
    return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
  },
  snapFeatures(s) {
    return [{ kind: "point", x: s.w / 2, y: s.h / 2, id: "center" }];
  },
  anchors: standardBBoxAnchors,
  // NO top-level commands: reached ONLY via the "Add Demo Widget" submenu, like
  // every other plugins/demo/ widget. This file previously carried its own
  // `add-demo-mandelbrot` command purely because the submenu is a hand-written list
  // in web/App.svelte and nothing lets a plugin join it — so a plugin command was
  // the workaround that made the widget reachable at all. That entry now exists in
  // the submenu proper, and two ids for one action is exactly what the one-owner
  // convention forbids (the command registry throws on a duplicate id).
};
