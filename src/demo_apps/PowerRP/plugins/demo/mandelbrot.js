/**
 * MANDELBROT — a DEMO WIDGET (plugins/demo/, the showcase folder) and a
 * GENERATIVE FOREGROUND material on the reusable MATERIAL FRAMEWORK. A rounded
 * rect that renders the Mandelbrot set at a centre and zoom of its own, thousands
 * of times deeper than ordinary floating point reaches, with the modern
 * orbit-average / distance-estimate colour stack over a cyclic OKLab palette.
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
 * TO ANIMATE A ZOOM, TWEEN `zoomExponent` — linearly, for a constant-rate zoom
 * (the half-width is 10^(-zoomExponent)). Nobody tweens a 32-digit coordinate;
 * they hold the centre still and change the magnification. TO ANIMATE THE
 * COLOURS, tween `paletteOffset`: it recolours without touching the iteration.
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

import { standardBBoxAnchors } from "../../core/derive.js";
import { UNIT_SPAN_SCRUB, bundle, customProps, defaults, props } from "../../core/properties.js";
import { reportOnce } from "../../core/report.js";
import { materialFill } from "../../render_gpu/ir.js";
import {
  MANDELBROT_AXIS_CODE, MANDELBROT_ESCAPE_RADIUS, MANDELBROT_MAX_ITERATIONS, MANDELBROT_REF_LEN,
  bakeMandelbrotPalette, bitsForDepth, centreResolutionDecades, referenceOrbit, scaledDecimal, splitCentreFixed,
} from "../../render_gpu/skia/mandelbrot_shader.js";

const DEG2RAD = Math.PI / 180;

// UNIT_SPAN_SCRUB (core/properties.js, beside SECONDS_SCRUB) is the scrub
// sensitivity for an UNBOUNDED knob whose useful domain spans ONE unit — here
// `paletteOffset`, which the shader samples through fract() and is therefore
// periodic with period exactly 1, so 0.01/px gives one full palette rotation per
// 100 px of drag. It used to be declared here; three plugins had hand-written the
// same constant, so it moved to the registry.

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
 * Smallest `zoomExponent` the Inspector accepts. NEGATIVE, because the half-width
 * is 10^(-zoomExponent) and the whole set needs a half-width of about 1.6 — i.e.
 * an exponent of -0.2. A floor of 0 would make the widget unable to frame its own
 * home view, which is exactly the bug this constant exists to prevent. -1 allows a
 * half-width of 10, far outside anything worth looking at.
 */
const MIN_ZOOM_EXPONENT = -1;

/**
 * Smallest `paletteScale` the Inspector accepts — iterations per colour cycle, so
 * zero would divide by zero in the colour axis. Named because BOTH the Inspector
 * row and the floating bar's Bands field enforce it, and two copies of a floor is
 * how they come to disagree.
 */
const MIN_PALETTE_SCALE = 0.001;

/**
 * The built-in cyclic palettes. Each is a stop list whose LAST stop blends back
 * into its first (bakeMandelbrotPalette assumes that), because a deep-zoom
 * palette must CYCLE: measured, a 1e-12 frame spans 2.4 iterations riding on an
 * offset of 1117, so a non-cyclic palette(nu/maxIter) is one flat colour.
 * `ultrafractal` is the classic blue/white/orange; `twilight` and `magma` are
 * matplotlib's perceptually-uniform ramps (twilight is natively cyclic, magma
 * mirrored into one).
 */
const PALETTES = {
  ultrafractal: ["#000764", "#206bcb", "#edffff", "#ffaa00", "#000200"],
  twilight: ["#e2d9e2", "#7ba1c2", "#5e43a5", "#2f1436", "#8d2b50", "#c6896c"],
  magma: ["#000004", "#2d1161", "#721f81", "#b73779", "#f1605d", "#feb078", "#fcfdbf", "#feb078", "#f1605d", "#b73779", "#721f81", "#2d1161"],
  gold: ["#120b02", "#5a3d0a", "#b8860b", "#ffd700", "#fff4c2", "#ffd700", "#b8860b", "#5a3d0a"],
  ice: ["#01040f", "#062b56", "#1b6ea8", "#79c6e8", "#eaf8ff", "#79c6e8", "#1b6ea8", "#062b56"],
  ember: ["#050101", "#2b0a06", "#7c1d0c", "#d9541b", "#ffc46b", "#fff3d0", "#ffc46b", "#d9541b", "#7c1d0c", "#2b0a06"],
};

const PALETTE_OPTIONS = Object.keys(PALETTES);
const PALETTE_LABELS = {
  ultrafractal: "Ultra Fractal (blue / cream / amber)",
  twilight: "Twilight (dusk + wine)",
  magma: "Magma (black → cream)",
  gold: "Gold (molten metal)",
  ice: "Ice (deep blue → white)",
  ember: "Ember (charcoal → flame)",
};

const AXIS_OPTIONS = ["iteration", "logIteration", "distance"];
const AXIS_LABELS = {
  iteration: "Iteration (classic)",
  logIteration: "Log iteration (n..2n is one cycle)",
  distance: "Screen distance (zoom-invariant)",
};

const INTERIOR_OPTIONS = ["derivative", "off"];
const INTERIOR_LABELS = {
  derivative: "Derivative certificate (fast)",
  off: "Off (always run to Max iterations)",
};

const INTERIOR_CODE = { off: 0, derivative: 1 };

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
  const bits = bitsForDepth(s.zoomExponent ?? 0);
  const key = `${s.centerX}|${s.centerY}|${s.centerFineX}|${s.centerFineY}|${fineExponent}|${bits}`;
  const hit = _orbitCache.get(key);
  if (hit) return hit;
  const built = referenceOrbit(
    splitCentreFixed(s.centerX ?? 0, s.centerFineX ?? 0, fineExponent, bits),
    splitCentreFixed(s.centerY ?? 0, s.centerFineY ?? 0, fineExponent, bits),
    bits, MANDELBROT_REF_LEN,
  );
  if (_orbitCache.size >= ORBIT_CACHE_LIMIT) _orbitCache.delete(_orbitCache.keys().next().value);
  _orbitCache.set(key, built);
  return built;
}

/**
 * Pure function. The colour stops a widget state asks for: the `paletteStops`
 * override when it names at least two colours, else the named `palette`. The
 * override is a comma-separated list and is DISCRETE — it is a text property, so
 * it switches rather than tweens, unlike every numeric knob here.
 *
 * @param {object} s - folded item state (palette, paletteStops)
 * @returns {string[]} at least two colour strings
 *
 * @example paletteStopsFor({palette: "gold"}).length // 8
 * @example paletteStopsFor({palette: "gold", paletteStops: "#000000, #ffffff"}) // ["#000000", "#ffffff"]
 * @example paletteStopsFor({palette: "ice", paletteStops: "#ff0000"}).length // 8 (one stop cannot cycle — the named palette wins)
 */
export function paletteStopsFor(s) {
  const override = String(s.paletteStops ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (override.length >= 2) return override;
  return PALETTES[s.palette] ?? PALETTES.gold;
}

/**
 * Query (memoized; near-pure). The baked palette + mean for a widget state.
 *
 * @param {object} s - folded item state (palette, paletteStops)
 * @returns {{palette: number[], mean: [number, number, number]}}
 *
 * @example cachedPalette({palette: "gold"}).palette.length // 96
 */
export function cachedPalette(s) {
  const stops = paletteStopsFor(s);
  const key = stops.join("|");
  const hit = _paletteCache.get(key);
  if (hit) return hit;
  const built = bakeMandelbrotPalette(stops);
  if (_paletteCache.size >= PALETTE_CACHE_LIMIT) _paletteCache.delete(_paletteCache.keys().next().value);
  _paletteCache.set(key, built);
  return built;
}

/**
 * Pure function. The centre's coarse+fine parts collapsed to one float64 — the
 * ONLY thing the shader needs the absolute coordinate for (the triangle-inequality
 * average's |c|, an aesthetic channel where fp32 error is invisible). Everything
 * geometric goes through the long-number reference orbit instead, which is why
 * this deliberately lossy sum is safe.
 *
 * @param {number} coarse - the leading digits
 * @param {number} fine - the fine offset, in units of 10^(-fineExponent)
 * @param {number} fineExponent - a non-negative integer
 * @returns {number}
 *
 * @example approxCentre(-0.5, 0, 0) // -0.5
 * @example approxCentre(0.5, 5, 1) // 1
 */
export function approxCentre(coarse, fine, fineExponent) {
  return (coarse ?? 0) + (fine ?? 0) * Math.pow(10, -Math.max(0, Math.round(fineExponent ?? 0)));
}

/** Pure function. A state's fine exponent, normalized the one way every reader
 *  here normalizes it (non-negative integer).
 *  @example fineExponentOf({fineExponent: 16.4}) // 16
 *  @example fineExponentOf({}) // 0 */
function fineExponentOf(s) {
  return Math.max(0, Math.round(s.fineExponent ?? 0));
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

const CUSTOM = customProps([
  // ── WHERE (the split centre + the zoom) ──────────────────────────────────────
  { name: "centerX", kind: "number", default: -0.7435669, label: "Centre X", help: "Real part of the view centre — the leading digits. A plain number, so it keyframes and takes a `= …` equation like anything else. For a deep location, put the first ~16 digits here and the next ~16 in Centre X fine." },
  { name: "centerY", kind: "number", default: 0.1314023, label: "Centre Y", help: "Imaginary part of the view centre — the leading digits." },
  { name: "centerFineX", kind: "number", default: 0, label: "Centre X fine", help: "Extra precision for Centre X, in units of 10^(-Fine exponent). The true centre is Centre X + Centre X fine x 10^(-Fine exponent), summed in exact decimal arithmetic — two plain numbers give about 32 significant digits, which is what makes a deep centre keyframable at all." },
  { name: "centerFineY", kind: "number", default: 0, label: "Centre Y fine", help: "Extra precision for Centre Y, in units of 10^(-Fine exponent)." },
  { name: "fineExponent", kind: "number", default: 0, min: 0, max: 80, step: 1, label: "Fine exponent", help: "Decimal exponent of the fine centre offsets: 0 turns the fine part off entirely, 16 continues the coordinate right where the coarse number's digits run out. AT 0 THE CENTRE ONLY RESOLVES TO ABOUT 1e-17, so any zoom deeper than that needs this set (the widget reports it out loud if you forget). Cannot exceed 80." },
  { name: "zoomExponent", kind: "number", default: 2.9416, min: MIN_ZOOM_EXPONENT, label: "Zoom exponent", help: "Magnification: the view's half-width is 10^(-Zoom exponent), so 3 is a 1e-3 window and 30 is a 1e-30 one; NEGATIVE values zoom OUT (the whole set needs about -0.2, a half-width of 1.6). TWEEN THIS, LINEARLY, for a constant-rate zoom — it is the one property a zoom animation should touch. Past 1e-17 you must also set Fine exponent, or the centre quantizes. Verified with real structure to about 1e-11; deeper than that the reference orbit that rides to the GPU may be too short for the depth (its length is fixed by how much uniform space a graphics card is guaranteed to have), and the way that shows up is a FLAT frame rather than a noisy one." },
  // ── HOW HARD (the speed knobs) ───────────────────────────────────────────────
  { name: "maxIterations", kind: "number", default: 900, min: 1, max: MANDELBROT_MAX_ITERATIONS, step: 1, label: "Max iterations", help: `The iteration BUDGET, and it is NOT a smooth quality dial — this is the knob whose behaviour surprises people. A pixel that neither escapes nor is certified interior by the budget is painted the INTERIOR COLOUR, so a view set too low does not go blurry, it goes BLACK, and the black looks exactly like real set. Measured: at 0.3x the needed budget the whole-set view costs 1.25x less and the 1e-10.5 view goes 100% black, because at depth the whole frame escapes within a few iterations of each other. So set it to what the PLACE needs and leave it — each Location preset carries a measured value. Cost is what is left over: it is close to linear in the iterations a pixel ACTUALLY runs, which is far below this ceiling wherever most of the frame escapes early (measured 30 per pixel on the whole set at a budget of 2048, against 504 at 1e-10.5). There is deliberately no automatic value: demand follows the local structure, not the zoom. Capped at ${MANDELBROT_MAX_ITERATIONS}, twice the ${MANDELBROT_REF_LEN}-point reference orbit — as far past the reference as reusing it has been measured to hold up.` },
  { name: "interiorTest", kind: "select", options: INTERIOR_OPTIONS, optionLabels: INTERIOR_LABELS, default: "derivative", label: "Interior test", help: "How points INSIDE the set are recognised early. The derivative certificate watches the product of 2z along the orbit: it collapses toward zero for a point captured by a cycle, which proves the point is interior long before Max iterations. Measured on the whole-set view: 4.3x faster (608 ms against 2638 ms) with pixel-identical results — 14.6% interior either way, so no wrongly-filled pixels. It saves nothing on a view with no interior in frame (measured 1.00x on the seahorse tail), because there is nothing to certify. Turn it off only to check it against a brute-force render." },
  { name: "interiorThreshold", kind: "number", default: 1e-3, min: 0, label: "Interior threshold", help: "How small the derivative product must get before a point is declared interior. Smaller is more cautious and slower; larger is faster but can eventually fill a pixel that would have escaped." },
  { name: "escapeRadius", kind: "number", default: MANDELBROT_ESCAPE_RADIUS, min: 16, label: "Escape radius", help: "How far a point must fly before it counts as escaped. 256 is calibrated, not arbitrary: the smooth iteration count's error is 3.1 iterations at radius 2 but 0.0000047 at 256, and the distance estimate needs at least 100 to be meaningful at all. Lower it only to see the banding come back." },
  // ── THE PALETTE ─────────────────────────────────────────────────────────────
  { name: "palette", kind: "select", options: PALETTE_OPTIONS, optionLabels: PALETTE_LABELS, default: "gold", label: "Palette", help: "Which cyclic colour ramp to use. All of them cycle, and at depth that is mandatory rather than stylistic: a 1e-12 frame spans about two iterations, so any palette stretched across the whole iteration range would be one flat colour. Stops are interpolated perceptually (OKLab), so no ramp passes through mud." },
  { name: "paletteStops", kind: "text", default: "", label: "Palette override", help: "Your own palette: two or more comma-separated colours (\"#001028, #ffd27f, #7a2f10\"), cycled and interpolated in OKLab. Empty uses the named palette above. Being text, this switches rather than tweens." },
  { name: "paletteScale", kind: "number", default: 18, min: MIN_PALETTE_SCALE, label: "Palette scale", help: "Iterations per colour cycle (or octaves per cycle on the Screen distance axis). Small = tight rainbow banding; large = broad sweeps of one colour. This is the knob to reach for when a view looks either stripey or washed out." },
  // `scrub` is MANDATORY here and cannot be inferred: the row is unbounded and its
  // default is 0, so there is no evidence of scale anywhere in the declaration, and
  // NumericField falls back to DraggableNumber's 1 unit per drag-PIXEL. Measured, a
  // 100 px drag ran 0 → 90 — a knob whose whole meaningful domain is one unit wide.
  // The shader samples the palette through fract() (`samplePalette(t + uPaletteOffset)`),
  // so the period is exactly 1 and the row is unbounded only because the rotation is
  // PERIODIC, not because it is large. That is the same situation, with the same fix,
  // as plugins/demo/sky.js timeOfDay and plugins/demo/lens_flare.js UNIT_SPAN_SCRUB.
  { name: "paletteOffset", kind: "number", default: 0, scrub: UNIT_SPAN_SCRUB, label: "Palette offset", help: "Rotates the palette along the colour axis — one full cycle per unit, and it wraps, so 1.25 looks exactly like 0.25. KEYFRAME THIS for a palette-cycling animation: it only recolours, so it costs nothing extra to animate." },
  { name: "colorAxis", kind: "select", options: AXIS_OPTIONS, optionLabels: AXIS_LABELS, default: "iteration", label: "Colour axis", help: "What the palette is indexed by. Iteration is the familiar escape-time look. Log iteration makes the band n..2n one cycle, so the banding density holds as you zoom. Screen distance uses the distance estimate in pixels, which is distributed identically at every depth and therefore needs no retuning — flatter looking, but it never needs adjusting mid-zoom." },
  // ── THE TEXTURE (orbit averages) ─────────────────────────────────────────────
  { name: "stripeAmount", kind: "number", default: 0.45, min: 0, max: 1, step: 0.01, label: "Silk (stripe average)", help: "Stripe Average Colouring: the running average of a wave riding on the orbit's ANGLE, which drapes the escape-time field in silk or brushed metal. The single biggest visual difference between this and a 1990s rainbow fractal. 0 is exactly off." },
  { name: "stripeDensity", kind: "number", default: 4, min: 1, step: 1, label: "Silk density", help: "How many light/dark silk bands the orbit's angle sweeps through per full turn. Low is broad satin, high is fine thread." },
  { name: "triangleAmount", kind: "number", default: 0.3, min: 0, max: 1, step: 0.01, label: "Cloth (triangle average)", help: "Triangle Inequality Average: the same idea as Silk but built from the orbit's LENGTH instead of its angle, so it looks nothing like it and the two mix well — silk over woven cloth. 0 is exactly off." },
  // ── THE LIGHT (relief + glow) ────────────────────────────────────────────────
  { name: "shadeAmount", kind: "number", default: 0.45, min: 0, max: 1, step: 0.01, label: "Relief", help: "Lambert shading from the orbit's derivative, which gives the set a lit three-dimensional relief with no extra samples at all. 0 is exactly off." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: -45, label: "Light angle", help: "Direction TO the light for the relief (screen space; -90 is straight above). KEYFRAME THIS for a light sweeping across the fractal." },
  { name: "lightHeight", kind: "number", default: 1.5, min: 0, label: "Light height", help: "How far the relief light sits out of the plane. Low is dramatic raking shadow; high flattens the relief toward evenly lit." },
  { name: "glowAmount", kind: "number", default: 0.3, min: 0, label: "Boundary glow", help: "Brightens pixels the distance estimate says are within a hair of the set, which recovers the hair-fine filaments that point sampling loses entirely. 0 is off." },
  { name: "glowWidth", kind: "number", default: 1, min: 0.05, label: "Glow width", help: "How far the boundary glow reaches, measured in screen pixels of estimated distance to the set. About 1 keeps it to a crisp rim; larger gives a soft halo." },
  { name: "bandLimit", kind: "boolean", default: true, label: "Band limit", help: "Antialiases the PALETTE analytically: the colour gradient is known exactly from the distance estimate, so where one pixel would span a whole colour cycle the palette fades to its own average instead of aliasing into noise. Free, since the distance estimate is already computed. Turn it off to see the noise it removes." },
  { name: "boundaryAA", kind: "boolean", default: false, label: "Edge coverage blend", help: "Blends toward the interior colour where the distance estimate says the set covers part of the pixel — the physically-motivated antialias of the set's edge. OFF by default because the estimate is a LOWER bound (within a factor of four), so it overstates coverage and turns dense filament fields dark; measured, it made the seahorse preset's cream lace black. The Boundary glow is the treatment that actually looks right. On is available for the physical reading." },
  { name: "interiorColor", kind: "color", default: "#000000", label: "Interior colour", help: "Colour of points inside the set. Its ALPHA makes the interior see-through, so content behind the widget shows through the black heart of the set." },
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
 * NOT for the screen-distance axis, whose scale is OCTAVES of estimated distance per
 * cycle — a small plain number with nothing to do with the iteration count.
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
 * COLOURS. Palette and colouring stack ONLY: no centre, no zoom, no iteration count,
 * so any of these lands on any location. Every one was rendered at a SHALLOW
 * (1e-2.9, 800 iterations), a MIDDLE (1e-5.9, 2048) and a DEEP (1e-10.5, 780)
 * location, because a palette that looks good shallow and dies deep is a bug and not
 * a style: two candidates (a triangle-average "woven cloth" and a log-axis rainbow)
 * were dropped for exactly that, and two more were retuned after going flat at the
 * middle location. `paletteScale` is therefore an equation — see paletteCycles.
 */
const COLOUR_PRESETS = [
  {
    name: "Molten Gold",
    description: "Molten metal with a glowing rim: silk over woven cloth over lit relief, in a warm gold ramp. The default look.",
    props: {
      palette: "gold", paletteStops: "", paletteScale: paletteCycles(50), paletteOffset: 0, colorAxis: "iteration",
      stripeAmount: 0.45, stripeDensity: 4, triangleAmount: 0.3, shadeAmount: 0.45, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.3, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Ultra Fractal Blue",
    description: "The classic deep-zoom look: navy through cream to amber, the highest-contrast palette here. If a view seems washed out in anything else, try this first.",
    props: {
      palette: "ultrafractal", paletteStops: "", paletteScale: paletteCycles(33), paletteOffset: 0, colorAxis: "iteration",
      stripeAmount: 0.55, stripeDensity: 4, triangleAmount: 0.25, shadeAmount: 0.5, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.3, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Twilight Rose",
    description: "Dusk and wine over pale silk — matplotlib's natively cyclic twilight ramp, heavy on the stripe average. Retuned from 12 to 25 cycles after it went flat purple at a 2048-iteration location.",
    props: {
      palette: "twilight", paletteStops: "", paletteScale: paletteCycles(25), paletteOffset: 0, colorAxis: "iteration",
      stripeAmount: 0.6, stripeDensity: 5, triangleAmount: 0.15, shadeAmount: 0.35, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.25, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Ice Porcelain",
    description: "White lace on deep blue with a bright boundary rim — the coldest and cleanest of the set, and the one that shows filament detail best.",
    props: {
      palette: "ice", paletteStops: "", paletteScale: paletteCycles(85), paletteOffset: 0, colorAxis: "iteration",
      stripeAmount: 0.5, stripeDensity: 6, triangleAmount: 0.2, shadeAmount: 0.4, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.35, glowWidth: 1.2, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Ember Forge",
    description: "Charcoal into flame, with the cloth texture pushed up and the light raking low. The warmest and darkest look here.",
    props: {
      palette: "ember", paletteStops: "", paletteScale: paletteCycles(25), paletteOffset: 0, colorAxis: "iteration",
      stripeAmount: 0.4, stripeDensity: 3, triangleAmount: 0.35, shadeAmount: 0.5, lightAngle: -45, lightHeight: 1.2,
      glowAmount: 0.4, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Brushed Chrome",
    description: "Machined metal: a near-neutral grey ramp with the stripe average almost fully open and the relief hard, which is what makes the escape-time field read as a turned metal surface rather than as colour. The only look here with no hue at all.",
    props: {
      palette: "gold", paletteStops: "#0b0d10, #6e7680, #e8eef5, #6e7680", paletteScale: paletteCycles(20), paletteOffset: 0, colorAxis: "iteration",
      stripeAmount: 0.9, stripeDensity: 8, triangleAmount: 0.1, shadeAmount: 0.75, lightAngle: -60, lightHeight: 0.7,
      glowAmount: 0.15, glowWidth: 1, bandLimit: true, boundaryAA: false, interiorColor: "#05070a",
    },
  },
  {
    name: "Neon Filament",
    description: "Electric cyan filaments on near-black: the distance-estimate glow carries the picture and the palette stays out of the way. Retuned from 16 cycles and 1.3 glow, which blew out to flat white at a 2048-iteration location.",
    props: {
      palette: "gold", paletteStops: "#03010a, #1b0a3a, #4b1e8c, #10d0ff, #b8f8ff, #10d0ff, #4b1e8c, #1b0a3a", paletteScale: paletteCycles(40), paletteOffset: 0, colorAxis: "iteration",
      stripeAmount: 0.2, stripeDensity: 4, triangleAmount: 0.1, shadeAmount: 0.15, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.9, glowWidth: 0.7, bandLimit: true, boundaryAA: false, interiorColor: "#000000",
    },
  },
  {
    name: "Blueprint",
    description: "A flat two-tone technical look with no silk, no cloth and no relief — just the boundary picked out in white on blue. For a figure on a slide, where a lit metal fractal would fight the text.",
    props: {
      palette: "gold", paletteStops: "#071a2b, #1e5f8f, #cfe8ff, #1e5f8f", paletteScale: paletteCycles(30), paletteOffset: 0, colorAxis: "iteration",
      stripeAmount: 0, stripeDensity: 4, triangleAmount: 0, shadeAmount: 0, lightAngle: -45, lightHeight: 1.5,
      glowAmount: 0.55, glowWidth: 1.4, bandLimit: true, boundaryAA: false, interiorColor: "#04101c",
    },
  },
  {
    name: "Flat Escape Time (the control)",
    description: "Silk, cloth, relief, glow and the band-limit ALL OFF: a plain banded 1990s escape-time fractal. Not a look to ship a slide with — a control. Put it beside any other colour preset at the same location to see what the modern colour stack is actually doing.",
    props: {
      palette: "ultrafractal", paletteStops: "", paletteScale: paletteCycles(33), paletteOffset: 0, colorAxis: "iteration",
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
     * Pure function. A new window → the keyframable writes that store it. At
     * fineExponent > 0 the centre delta goes into the FINE slots and the coarse
     * digits are left ALONE — that is the whole point of the split centre, and it
     * is what stops a drag from flattening a typed 32-digit coordinate to float64.
     * The zoom is inverted from the window's own half-width and clamped at
     * MIN_ZOOM_EXPONENT, the same floor the Inspector row enforces.
     *
     * @param {object} s - folded item state (the window is re-derived from it)
     * @param {{x: number, y: number, w: number, h: number}} win - the new complex window
     * @returns {object} a flat {stateKey: value} map of keyframable leaves
     *
     * @example mandelbrotPlugin.interiorView.writes({centerX: 0, centerY: 0, zoomExponent: 0, w: 200, h: 100}, {x: 0.9, y: -0.05, w: 0.2, h: 0.1}) // {zoomExponent: 1, centerX: 1, centerY: 0} (zoomed ten-fold onto c = 1)
     * @example mandelbrotPlugin.interiorView.writes({centerX: 0, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 2, zoomExponent: 1, w: 100, h: 100}, {x: 0.4, y: -0.1, w: 0.2, h: 0.2}) // {zoomExponent: 1, centerFineX: 50, centerFineY: 0} (NO centerX key — the coarse digits are untouched)
     */
    writes(s, win) {
      const fe = fineExponentOf(s);
      const old = mandelbrotPlugin.interiorView.window(s);
      const dx = (win.x + win.w / 2) - (old.x + old.w / 2);
      const dy = (win.y + win.h / 2) - (old.y + old.h / 2);
      const out = { zoomExponent: clampedZoomExponent(-Math.log10(win.w / 2)) };
      if (fe > 0) {
        const unit = Math.pow(10, fe);
        out.centerFineX = (s.centerFineX ?? 0) + dx * unit;
        out.centerFineY = (s.centerFineY ?? 0) + dy * unit;
      } else {
        out.centerX = (s.centerX ?? 0) + dx;
        out.centerY = (s.centerY ?? 0) + dy;
      }
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
  defaults: {
    type: "demo_mandelbrot", x: 140, y: 140, w: 520, h: 390, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint hairline framing the panel (optional; strokeWidth 0 = none).
    stroke: "rgba(255,255,255,0.28)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the mandelbrot.* knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
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
    const { palette, mean } = cachedPalette(s);
    const fineExponent = Math.max(0, Math.round(s.fineExponent ?? 0));
    // A zoom deeper than the split centre can resolve does not fail — it renders a
    // perfectly valid view of a QUANTIZED neighbour of the requested point, which
    // is exactly the kind of plausible-but-wrong result that must never be silent.
    const resolvable = centreResolutionDecades(fineExponent);
    if ((s.zoomExponent ?? 0) > resolvable) {
      reportOnce(`mandelbrot-centre-resolution-${fineExponent}`, `PowerRP mandelbrot: zoom exponent ${s.zoomExponent} is deeper than the centre can resolve at fine exponent ${fineExponent} (good to about 1e-${resolvable}). The view is centred on a quantized neighbour of the requested point. Raise "Fine exponent" (16 is the usual deep-zoom setting) and move the extra digits into "Centre X/Y fine".`);
    }
    // A SHORT reference is the widget's one silent-wrong-image risk. Running past
    // the reference's end is normal and measured-safe at the shipped full length
    // (1024 points drive 2048 iterations at 1e-10.5, indistinguishable from a
    // 2048-point reference) — so what is worth reporting is not "maxIterations
    // exceeds the reference" but "the reference came out SHORTER THAN FULL LENGTH",
    // which happens when the chosen centre escapes and is the case the user can
    // actually act on. Past EXHAUSTION_SAFE_DECADES that shortfall annihilates the
    // per-pixel offset in single precision and flattens the frame — see
    // MANDELBROT_REF_LEN for the measurement.
    if (ref.count < MANDELBROT_REF_LEN && (s.maxIterations ?? 0) > ref.count && (s.zoomExponent ?? 0) > EXHAUSTION_SAFE_DECADES) {
      reportOnce("mandelbrot-reference-exhausted", `PowerRP mandelbrot: the reference orbit escapes after ${ref.count} of ${MANDELBROT_REF_LEN} iterations but Max iterations is ${s.maxIterations}, at a zoom of 1e-${s.zoomExponent}. Past about 1e-${EXHAUSTION_SAFE_DECADES} a reference that short loses the per-pixel offset to single-precision rounding and the frame goes FLAT. Move the centre nearer the set (an escaping centre cannot carry a long reference), or lower Max iterations to ${ref.count}.`);
    }
    return [materialFill({
      material: "mandelbrot",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      params: {
        centerApproxX: approxCentre(s.centerX, s.centerFineX, fineExponent),
        centerApproxY: approxCentre(s.centerY, s.centerFineY, fineExponent),
        halfWidth: Math.pow(10, -(s.zoomExponent ?? 0)),
        maxIter: s.maxIterations,
        refCount: ref.count,
        escapeRadius: s.escapeRadius,
        interiorTest: INTERIOR_CODE[s.interiorTest] ?? 1,
        interiorThreshold: s.interiorThreshold,
        colorAxis: MANDELBROT_AXIS_CODE[s.colorAxis] ?? 0,
        paletteScale: s.paletteScale,
        paletteOffset: s.paletteOffset,
        stripeAmount: s.stripeAmount,
        stripeDensity: s.stripeDensity,
        triangleAmount: s.triangleAmount,
        shadeAmount: s.shadeAmount,
        lightAngle: s.lightAngle * DEG2RAD,
        lightHeight: s.lightHeight,
        glowAmount: s.glowAmount,
        glowWidth: s.glowWidth,
        bandLimit: s.bandLimit ? 1 : 0,
        boundaryAA: s.boundaryAA ? 1 : 0,
        interiorColor: s.interiorColor,
        palette,
        paletteMean: mean,
        orbit: ref.orbit,
      },
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
  // NO top-level commands: reached ONLY via the "Insert Demo Widget" submenu, like
  // every other plugins/demo/ widget. This file previously carried its own
  // `add-demo-mandelbrot` command purely because the submenu is a hand-written list
  // in web/App.svelte and nothing lets a plugin join it — so a plugin command was
  // the workaround that made the widget reachable at all. That entry now exists in
  // the submenu proper, and two ids for one action is exactly what the one-owner
  // convention forbids (the command registry throws on a duplicate id).
};
