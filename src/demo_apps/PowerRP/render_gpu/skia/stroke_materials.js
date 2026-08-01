/**
 * THE STROKE-MATERIAL FRAMEWORK — a registry of STROKE materials, the twin of the
 * fill-material framework (render_gpu/skia/materials.js + comic_shader.js's
 * fillParams). Where a FILL material shades a shape's interior with an SkSL region
 * op, a STROKE material paints the shape's OUTLINE — parameterized by ARC LENGTH
 * along the path, not by the bounding box — so it can do things a shader region
 * fundamentally cannot: a gradient that runs ALONG the stroke, a WIDTH that varies
 * down the path, dashes/dots, and a hand-drawn WAVY wobble.
 *
 * ── THE STROKE-MATERIAL CONTRACT ──────────────────────────────────────────────
 * An entry is `{ id, title, strokeParams, render }`:
 *   - `id`          — the string a stroke paint {type:"material", material:{id}}
 *                     names. Distinct from every FILL material id (the two
 *                     registries never collide, so materials.resolveMaterialPaint
 *                     can find either by id).
 *   - `title`       — human label for the PaintField dropdown.
 *   - `strokeParams`— the knob SCHEMA, an array of customProps-shaped rows
 *                     ({name, kind, default, min?, max?, step?, scrub?, options?,
 *                     optionLabels?, help}) — the EXACT shape comic's fillParams
 *                     uses, so ports.resolveMaterialPaint folds schema-defaults ⊕
 *                     sparse-stored into `resolvedParams` the SAME way (it reads
 *                     `entry.strokeParams ?? entry.fillParams`). The PaintField
 *                     renders these rows when it edits a STROKE slot.
 *   - `render(CanvasKit, canvas, path, params, strokeWidth, opacity, aa)` — a
 *                     COMMAND. `path` is the op's geometry as a LOCAL-space Skia
 *                     Path; `canvas` already rides the local→device CTM
 *                     (paint_skia applies the view before calling), so the stroke
 *                     is drawn in LOCAL units and rides the camera like every
 *                     other bit of geometry. `params` is the resolved knob map.
 *                     The renderer owns nothing it does not create (it must delete
 *                     every Skia object it allocates; it must NOT delete `path`).
 *                     `path` arrives ALREADY phase-rotated by the framework when a
 *                     closed outline carries a stroke phase, so materials never
 *                     implement phase themselves.
 *
 * DETERMINISM / STATE KIND. A stroke material is PROPERTY STATE: a pure function of
 * (geometry, knobs) with no ambient input — no wall clock, no Math.random. The
 * wavy material's random wobble is a SEEDED deterministic function of arc position
 * (drawn through core/particles.js's randUnit, the SAME (seed, i, stream) hash the
 * particle sim uses), so the same document renders byte-identically in the editor,
 * the CLI, and both video backends (CLAUDE.md: "Picking a seed and STORING it is
 * property state"). Crucially, the sine part and the random part are SEPARATE
 * knobs: with randomness = 0 the seed is inert and the stroke is a clean sine.
 *
 * DOM-free at import (only pure JS + string schemas), like materials.js — CanvasKit
 * arrives as a render() argument, never an import. `parseColor` (render_gpu/ir.js)
 * is the shared node-safe colour parser; `randUnit` (core/particles.js) is the
 * shared node-safe seeded hash.
 */

import { parseColor } from "../ir.js";
import { randUnit } from "../../core/particles.js"; // the seeded (seed,i,stream) hash — the sparkler's, reused so a stored seed is property state
import { elementActive } from "../../core/lists.js"; // the shared per-element visibility read — hidden stops ramp straight past, byte-identically to never authoring them
import { unitNormal } from "../../core/geometry.js"; // THIS file's name, but not this file's home: it imports the two brush modules below, so they could not import back
import { reportOnce } from "../../core/report.js"; // loud-once sink for a knob outside its physical domain
import { particleTime } from "../particle_clock.js"; // THE presentation clock seam (recordable state) — wavy's BOIL re-seeds from it; frozen in the editor, driven per-frame by exports (the glitch-shader precedent)
import { BRUSH_STROKE } from "./brush_strokes.js"; // the 23-archetype textured BRUSH material (drawAtlas stamping), kept in its own file
import { TEXTURE_BRUSH } from "./texture_brush.js"; // the rp-paint-demo TEXTURE ribbon brush (skia_draw_trail twin, 23 in-repo textures), kept in its own file

// ── arc-length sampling budget (WHY each exists — no magic numbers) ───────────
const GRADIENT_SEGMENT_SPACING = 3;  // local px per colour band when walking an along-gradient (finer = smoother ramp, more draws)
const WAVY_SAMPLE_SPACING = 2.5;     // local px between wobble samples — must be << the shortest wavelength or the sine aliases
const RIBBON_SAMPLE_SPACING = 2.5;   // local px between variable-width ribbon samples
const MAX_STROKE_SEGMENTS = 4000;    // hard cap on samples/bands per contour, so a pathological length can't stall the frame
const MIN_STROKE_SEGMENTS = 2;       // a degenerate-short contour still gets a 2-sample stroke
const DASH_DOT_ON = 0.01;            // "on" length of a DOT mark (≈0): with a round cap it prints a dot of diameter = strokeWidth
const DASH_MIN_INTERVAL = 1e-3;      // MakeDash needs strictly-positive intervals; clamp a 0-gap authoring extreme up to this
const NOISE_HARMONICS = 3;           // sine octaves summed in the seeded wobble — enough for an organic hand-drawn irregularity, cheap to evaluate

// ── knob-scrub calibration (how much ONE drag-pixel moves a numeric knob) ─────
// The house law: one on-screen drag-pixel = one increment, and a comfortable drag
// is ~100–200 px, so a knob's scrub is (its useful domain) ÷ ~150. Fractions and
// multipliers get the finest step; pixel lengths a coarser one.
const UNIT_SCRUB = 0.01;   // fractions / multipliers / phases-in-cycles (useful domain ~0..1.5)
const AMP_FREQ_SCRUB = 0.5; // wavy amplitude (px) & frequency (wave count) — matches their long-standing step (slider-audit ruling)
const PX_SCRUB = 0.5;       // dash / gap / dot / dash-phase LENGTHS, in local px (useful domain ~0..75)
const REPEAT_SCRUB = 0.05;  // alongGradient ramp-cycle count (useful domain ~0..8)
const DOTS_SCRUB = 0.05;    // dashes dots-per-dash count (rounds to a whole number; fine enough to land on each integer)

// alongGradient's DEFAULT colour ramp — the three colours it used to hard-code as
// colorStart/colorMid/colorEnd knobs, now the concrete list its `stops` row seeds
// when the material is chosen (web/PaintField.svelte). Kept identical to those old
// knob defaults so a freshly-authored alongGradient renders byte-identically to
// one authored before the stops list existed.
const ALONG_GRADIENT_DEFAULT_STOPS = [
  { offset: 0, color: "#ff2d55" },
  { offset: 0.5, color: "#ffcc00" },
  { offset: 1, color: "#0a84ff" },
];

// ── pure helpers (doctested) ──────────────────────────────────────────────────

/**
 * Pure function. Linear interpolation from a to b at parameter t.
 *
 * @param {number} a - value at t=0
 * @param {number} b - value at t=1
 * @param {number} t - interpolation parameter
 * @returns {number}
 *
 * @example lerp(0, 10, 0.25) // 2.5
 * @example lerp(2, 4, 0.5) // 3
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Pure function. Clamps x into [0, 1].
 *
 * @example clamp01(0.3) // 0.3
 * @example clamp01(1.5) // 1
 * @example clamp01(-0.2) // 0
 */
export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Pure function. The fractional part of x, always in [0, 1) (a negative input
 * wraps forward, so it tiles a repeating pattern seamlessly).
 *
 * @example frac(1.25) // 0.25
 * @example frac(-0.25) // 0.75
 * @example frac(3) // 0
 */
export function frac(x) {
  return x - Math.floor(x);
}

/**
 * Pure function. How many arc-length samples/bands to take on a contour of the
 * given LOCAL length: one per `spacing` local px, floored at MIN_STROKE_SEGMENTS
 * and capped at `cap` so an enormous path can never stall a frame.
 *
 * @param {number} length - contour length in local px
 * @param {number} spacing - target local px between samples
 * @param {number} cap - hard maximum
 * @returns {number} integer sample count
 *
 * @example arcStepCount(100, 5, 4000) // 20
 * @example arcStepCount(1, 5, 4000) // 2
 * @example arcStepCount(1000000000, 5, 10) // 10
 */
export function arcStepCount(length, spacing, cap) {
  return Math.max(MIN_STROKE_SEGMENTS, Math.min(cap, Math.ceil(length / spacing)));
}

/**
 * Pure function. Piecewise-linear sample of a WIDTH PROFILE at parameter t. The
 * profile is a list of [t, value] control points sorted by t; t outside the
 * profile's span clamps to the nearest endpoint (a flat extension, never an
 * extrapolation).
 *
 * @param {Array<[number, number]>} stops - sorted [t, value] control points
 * @param {number} t - query parameter (arc fraction 0..1)
 * @returns {number} interpolated value
 *
 * @example sampleProfile([[0, 0.2], [0.5, 1.4], [1, 0.2]], 0.25) // 0.8
 * @example sampleProfile([[0, 0.2], [0.5, 1.4], [1, 0.2]], 0) // 0.2
 * @example sampleProfile([[0, 0.2], [0.5, 1.4], [1, 0.2]], 1) // 0.2
 */
export function sampleProfile(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const span = stops[i][0] - stops[i - 1][0];
      const f = span > 0 ? (t - stops[i - 1][0]) / span : 0;
      return lerp(stops[i - 1][1], stops[i][1], f);
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Pure function. Piecewise-linear colour of a gradient at parameter t. The stops
 * are {offset, color:[r,g,b,a]} sorted by offset; t clamps to the endpoint
 * colours. Every channel (including alpha) lerps independently.
 *
 * @param {Array<{offset:number, color:number[]}>} stops - sorted gradient stops
 * @param {number} t - query parameter 0..1
 * @returns {[number, number, number, number]} rgba in 0..1
 *
 * @example sampleGradientColor([{offset: 0, color: [0, 0, 0, 1]}, {offset: 1, color: [1, 1, 1, 1]}], 0.5) // [0.5, 0.5, 0.5, 1]
 * @example sampleGradientColor([{offset: 0, color: [0, 0, 0, 1]}, {offset: 1, color: [1, 1, 1, 1]}], 0) // [0, 0, 0, 1]
 * @example sampleGradientColor([{offset: 0.25, color: [1, 0, 0, 1]}, {offset: 0.75, color: [0, 0, 1, 1]}], 0.5) // [0.5, 0, 0.5, 1]
 */
export function sampleGradientColor(stops, t) {
  if (t <= stops[0].offset) return [...stops[0].color];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const span = stops[i].offset - stops[i - 1].offset;
      const f = span > 0 ? (t - stops[i - 1].offset) / span : 0;
      const a = stops[i - 1].color, b = stops[i].color;
      return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f)];
    }
  }
  return [...stops[stops.length - 1].color];
}

/**
 * Pure function. Smooth seeded pseudo-noise in ≈[-1, 1] at arc fraction `u`,
 * summed from `harmonics` sine octaves whose frequency, phase and weight are drawn
 * deterministically from (seed, k) via core/particles.js `randUnit`. This is the
 * hand-drawn irregularity behind the WAVY material's random part: PROPERTY STATE
 * (a stored seed reproduces byte-identically — no Math.random), and separable from
 * the material's clean sine because it is a distinct additive term.
 *
 * `streamFreq` and `streamPhase` pick INDEPENDENT random channels of the shared
 * hash, so two noises drawn from ONE seed (the amplitude-jitter noise and the
 * phase-wander noise) never move together. Octave k contributes weight 1/k (a
 * pink-ish 1/k falloff, so the low, broad wobbles dominate) at frequency
 * (k + a sub-octave jitter) waves across the path; the sum is normalized by the
 * total weight so the result stays near [-1, 1].
 *
 * @param {number} seed - the material's stored seed (integer)
 * @param {number} u - arc fraction along the contour (0..1)
 * @param {number} streamFreq - random channel for the octave frequencies
 * @param {number} streamPhase - random channel for the octave phases
 * @param {number} harmonics - how many octaves to sum (>= 1)
 * @returns {number} deterministic noise value, ≈[-1, 1]
 *
 * @example seededNoise(3, 0.5, 0, 1, 3) // -0.41559529997175115
 * @example seededNoise(3, 0.5, 0, 1, 3) === seededNoise(3, 0.5, 0, 1, 3) // true
 * @example seededNoise(3, 0.5, 0, 1, 3) !== seededNoise(3, 0.5, 2, 3, 3) // true
 */
export function seededNoise(seed, u, streamFreq, streamPhase, harmonics) {
  let v = 0, norm = 0;
  for (let k = 1; k <= harmonics; k++) {
    const weight = 1 / k;
    const freq = k + randUnit(seed, k, streamFreq); // ≈k waves + a sub-octave jitter, so octaves decorrelate
    const phase = randUnit(seed, k, streamPhase);   // octave phase, in cycles
    v += weight * Math.sin(2 * Math.PI * (freq * u + phase));
    norm += weight;
  }
  return v / norm;
}

/**
 * Pure function. The WAVY material's normal-direction displacement at arc distance
 * `s` along a contour of length `length`. TWO fully separable parts:
 *   - a CLEAN deterministic sine of `amplitude`·`frequency`·`phase`, and
 *   - a SEEDED random part with two independent knobs: `randomness` jitters the
 *     wave HEIGHT (amplitude jitter) and `wander` jitters WHERE the peaks fall
 *     (frequency/phase jitter). Both are 0 by default, which makes the seed inert
 *     and the result a pure sine — the answer to "why does wavy have a seed?".
 *
 *     u = s / L
 *     d(s) = (1 + randomness·nA(u)) · amplitude · sin(2π·(frequency·u + phase + wander·nP(u)))
 *            where nA, nP = seededNoise on independent channels (≈[-1, 1])
 *
 * randomness = wander = 0 ⇒ d(s) = amplitude·sin(2π·(frequency·u + phase)), the
 * clean sine, identical for every seed.
 *
 * @param {number} s - arc distance along the contour (local px)
 * @param {number} length - the contour's total length (local px)
 * @param {number} amplitude - peak displacement A (local px)
 * @param {number} frequency - full waves f across the whole path
 * @param {number} phase - phase φ in cycles (0..1 tiles one wave)
 * @param {number} randomness - amplitude-jitter amount (0 = clean sine; fraction of A)
 * @param {number} wander - frequency/phase-jitter amount (0 = even wavelength; cycles of drift)
 * @param {number} seed - wobble seed (only meaningful when randomness or wander > 0)
 * @returns {number} signed displacement along the left normal (local px)
 *
 * @example wavyDisplacement(0, 100, 6, 8, 0, 0, 0, 0) // 0
 * @example wavyDisplacement(25, 100, 6, 1, 0, 0, 0, 0) // 6
 * @example wavyDisplacement(30, 100, 6, 8, 0, 0, 0, 7) === wavyDisplacement(30, 100, 6, 8, 0, 0, 0, 999) // true
 * @example wavyDisplacement(30, 100, 6, 8, 0, 0.5, 0, 7) !== wavyDisplacement(30, 100, 6, 8, 0, 0.5, 0, 8) // true
 */
export function wavyDisplacement(s, length, amplitude, frequency, phase, randomness, wander, seed) {
  const u = length > 0 ? s / length : 0;
  const ampEnv = 1 + randomness * seededNoise(seed, u, 0, 1, NOISE_HARMONICS);
  const wanderPhase = wander * seededNoise(seed, u, 2, 3, NOISE_HARMONICS);
  return ampEnv * amplitude * Math.sin(2 * Math.PI * (frequency * u + phase + wanderPhase));
}

/**
 * Pure function. The dash INTERVAL array for a stroke dash pattern, in local px,
 * matching CanvasKit.PathEffect.MakeDash's [on, off, on, off, …] contract. The
 * pattern is a CONTINUOUS dash+dots builder plus three named presets that pin the
 * classic looks EXACTLY (so older documents — which stored `pattern` — render
 * unchanged):
 *   - "custom"  → [dash, gap] then `dots` short marks: [..., dot, gap] each. The
 *                 general builder — dots 0 is a plain dashed line, 1 is dash-dot,
 *                 2 is dash-dot-dot, and dash → 0 turns the dash itself into a dot.
 *   - "dash"    → [dash, gap]                       a plain dashed line
 *   - "dot"     → [dot, gap]                        one round-capped dot per period
 *   - "dashDot" → [dash, gap, dot, gap]             alternating dash · dot
 * A "dot" mark under `DASH_DOT_ON` is floored there (a round cap then prints it as
 * a dot of diameter = strokeWidth). `strokeWidth` is accepted for symmetry (a
 * dot's visible size comes from the cap, not the array).
 *
 * @param {string} pattern - "custom" | "dash" | "dot" | "dashDot"
 * @param {number} dash - long dash-mark length (local px)
 * @param {number} gap - gap between marks (local px)
 * @param {number} dot - short dot-mark length (local px; ~0 prints a round dot)
 * @param {number} dots - dots after each dash in "custom" (rounded, >= 0)
 * @param {number} strokeWidth - stroke width (local px)
 * @returns {number[]} even-length interval array
 *
 * @example dashIntervals("dash", 16, 10, 0.01, 0, 4) // [16, 10]
 * @example dashIntervals("dot", 16, 10, 0.01, 0, 4) // [0.01, 10]
 * @example dashIntervals("dashDot", 16, 10, 0.01, 0, 4) // [16, 10, 0.01, 10]
 * @example dashIntervals("custom", 16, 10, 0.01, 0, 4) // [16, 10]
 * @example dashIntervals("custom", 16, 10, 0.01, 2, 4) // [16, 10, 0.01, 10, 0.01, 10]
 */
export function dashIntervals(pattern, dash, gap, dot, dots, strokeWidth) {
  const dotOn = Math.max(dot, DASH_DOT_ON);
  if (pattern === "dash") return [dash, gap];
  if (pattern === "dot") return [dotOn, gap];
  if (pattern === "dashDot") return [dash, gap, dotOn, gap];
  // "custom" (and any new document's default): a dash then `dots` short dots.
  const n = Math.max(0, Math.round(dots));
  const out = [dash, gap];
  for (let i = 0; i < n; i++) out.push(dotOn, gap);
  return out;
}

/**
 * Pure function. The EFFECTIVE colour-ramp stops for an alongGradient stroke, as
 * {offset, color} records in canonical (offset-sorted) order with hidden stops
 * removed. TWO sources, ABSENT-IS-LEGACY (the same absent-means-old rule the
 * gradient-angle migration uses):
 *   - NEW  — an authored `stops` LIST (resolvedParams.stops, the real state path
 *            web/PaintField.svelte's gradient stops editor writes) with its
 *            aligned visibility companion `stopsActive`: hidden stops are dropped
 *            through the shared core/lists.elementActive read — byte-identical to
 *            never having authored them — and the survivors sorted by offset.
 *   - LEGACY — the three colour knobs colorStart / colorMid / colorEnd sitting at
 *            0 / midpoint / 1. A document authored before the stops list existed
 *            stores these and NO `stops`, so `stops` being absent (its schema
 *            default is null) is the sentinel that selects this path, and such a
 *            document renders byte-identically.
 * Never sorts in place / never mutates its input. A stored `stops` whose visible
 * survivors are empty (every stop hidden — which the editor's minimum-visible
 * floor forbids, but a raw document could hold) falls back to the full list so
 * the ramp is never colourless.
 *
 * @param {object} p - the resolved knob map (resolvedParams)
 * @returns {Array<{offset:number, color:string}>} sorted, visible ramp stops
 *
 * @example alongGradientStops({colorStart: "#ff0000", colorMid: "#00ff00", colorEnd: "#0000ff", midpoint: 0.5}) // [{offset: 0, color: "#ff0000"}, {offset: 0.5, color: "#00ff00"}, {offset: 1, color: "#0000ff"}]
 * @example alongGradientStops({stops: [{offset: 1, color: "#0000ff"}, {offset: 0, color: "#ff0000"}]}) // [{offset: 0, color: "#ff0000"}, {offset: 1, color: "#0000ff"}]
 * @example alongGradientStops({stops: [{offset: 0, color: "#ff0000"}, {offset: 0.5, color: "#00ff00"}, {offset: 1, color: "#0000ff"}], stopsActive: [true, false, true]}) // [{offset: 0, color: "#ff0000"}, {offset: 1, color: "#0000ff"}]
 */
export function alongGradientStops(p) {
  if (Array.isArray(p.stops) && p.stops.length) {
    const visible = p.stops.filter((_, i) => elementActive(p.stopsActive, i));
    const usable = visible.length ? visible : p.stops;
    return usable.map((s) => ({ offset: s.offset, color: s.color })).sort((a, b) => a.offset - b.offset);
  }
  return [
    { offset: 0, color: p.colorStart },
    { offset: clamp01(p.midpoint), color: p.colorMid },
    { offset: 1, color: p.colorEnd },
  ].sort((a, b) => a.offset - b.offset);
}

// ── shared draw plumbing (Commands / near-pure builders) ──────────────────────

/**
 * Near-pure builder (allocates a Skia Paint; caller deletes). A stroke paint with
 * the given rgba (alpha folded with `opacity`), width and cap.
 *
 * THE JOIN IS ROUND AND IS NOT A KNOB, deliberately. Every material that reaches
 * this builder strokes a RESAMPLED contour, not the author's outline: `wavy`
 * rebuilds the path at WAVY_SAMPLE_SPACING and `alongGradient` chops it into
 * GRADIENT_SEGMENT_SPACING bands, so the vertices Skia joins here are sampling
 * artefacts a few units apart, not the corners the author drew. A Miter on those
 * would grow a spike at every wave crest. The widget-level strokeJoin property
 * (core/properties.js) therefore does NOT reach a material stroke, and the
 * Inspector hides the row while one is selected rather than offering a control
 * that changes nothing.
 *
 * This used to take a seventh `join` argument defaulting to Round with `??`. No
 * caller ever passed it, in any of the three call sites, so the fallback was the
 * only live branch — a knob that looked settable and was not. Removed rather than
 * wired: the paragraph above is why it should never be wired here.
 */
function strokePaintOf(CanvasKit, rgba, width, opacity, aa, cap) {
  const p = new CanvasKit.Paint();
  p.setStyle(CanvasKit.PaintStyle.Stroke);
  p.setStrokeWidth(width);
  p.setAntiAlias(aa);
  p.setStrokeCap(cap ?? CanvasKit.StrokeCap.Round);
  p.setStrokeJoin(CanvasKit.StrokeJoin.Round);
  p.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], (rgba[3] ?? 1) * opacity));
  return p;
}

/**
 * Query. Maps a cap knob string to the CanvasKit enum (default round). THE ONLY
 * cap-id → StrokeCap map in this codebase; exported because paint_skia.js's
 * polyline case needs the same translation for the op's POLYLINE_CAP contract,
 * and a second copy of a three-line switch is how two spellings of one fact
 * begin. Its join twin (skJoin) lives in paint_skia.js, which is its only
 * consumer — a material stroke never takes a join id (see strokePaintOf above).
 *
 * @param {object} CanvasKit - the CanvasKit module (its StrokeCap enum)
 * @param {string} cap - "butt" | "square" | "round" (the SVG stroke-linecap words)
 * @returns {object} the CanvasKit.StrokeCap member
 *
 * @example capEnum(CanvasKit, "butt") // CanvasKit.StrokeCap.Butt
 * @example capEnum(CanvasKit, "round") // CanvasKit.StrokeCap.Round
 */
export function capEnum(CanvasKit, cap) {
  if (cap === "butt") return CanvasKit.StrokeCap.Butt;
  if (cap === "square") return CanvasKit.StrokeCap.Square;
  return CanvasKit.StrokeCap.Round;
}

/**
 * Command. Runs `fn(contour)` for every contour of `path`, deleting each measured
 * contour and the iterator afterward (the ContourMeasureIter memory contract). A
 * multi-subpath op (a donut, a dashed compound outline) is measured per contour.
 */
function forEachContour(CanvasKit, path, fn) {
  const iter = new CanvasKit.ContourMeasureIter(path, false, 1);
  let c;
  while ((c = iter.next())) {
    fn(c);
    c.delete();
  }
  iter.delete();
}

// ── the FOUR built-in stroke materials ────────────────────────────────────────

/**
 * Command. ALONG-GRADIENT stroke: a colour ramp run ALONG the path's arc length.
 * The path is walked in short bands; each band is stroked with the ramp colour at
 * its arc fraction, wrapped by `repeat` (how many times the ramp cycles over the
 * whole path) and shifted by `phase`. This is the arc-length gradient a bbox
 * shader cannot express — the colour follows the WIRE, not the bounding box.
 *
 * THE RAMP IS THE REAL GRADIENT EDITOR'S STOP LIST (alongGradientStops): an
 * authored, keyframable, visibility-aware `stops` list edited through the same
 * ListField + ramp preset library every gradient paint uses, with the legacy
 * three-colour knobs mapped in for documents that predate it (absent-is-legacy).
 * `repeat` MUST be > 0 (a cycle count); a value <= 0 is reported loudly and
 * treated as a single pass rather than clamped in the UI.
 */
function renderAlongGradient(CanvasKit, canvas, path, p, width, opacity, aa) {
  let repeat = p.repeat;
  if (!(repeat > 0)) {
    reportOnce(
      `stroke-material:alongGradient:repeat<=0`,
      `PowerRP stroke material "alongGradient": repeat must be > 0 (a ramp-cycle count), got ${p.repeat} — rendering a single pass.`,
    );
    repeat = 1;
  }
  const stops = alongGradientStops(p).map((s) => ({ offset: s.offset, color: parseColor(s.color) }));
  const paint = strokePaintOf(CanvasKit, stops[0].color, width, opacity, aa);
  forEachContour(CanvasKit, path, (c) => {
    const L = c.length();
    if (!(L > 0)) return;
    const steps = arcStepCount(L, GRADIENT_SEGMENT_SPACING, MAX_STROKE_SEGMENTS);
    for (let i = 0; i < steps; i++) {
      const tt = frac((i + 0.5) / steps * repeat + p.phase);
      const col = sampleGradientColor(stops, tt);
      paint.setColor(CanvasKit.Color4f(col[0], col[1], col[2], (col[3] ?? 1) * opacity));
      const seg = c.getSegment(L * i / steps, L * (i + 1) / steps, true);
      canvas.drawPath(seg, paint);
      seg.delete();
    }
  });
  paint.delete();
}

/**
 * Command. WIDTH-PROFILE stroke: the stroke width varies along the path via a
 * 3-point profile (wStart → wMid → wEnd, the mid at `midpoint`). Built as a FILLED
 * RIBBON — each arc sample is offset ±(width/2 · profileMultiplier) along the
 * normal; the left edge forward then the right edge backward close one filled
 * band. `endStyle` finishes the two ends: "flat" cuts them square at the profile
 * width (the default), "taper" pulls the outermost sample to the centreline so
 * each end comes to a sharp point (a nib entry/exit) regardless of the end width.
 * This is a true variable-width brush, not a uniform stroke.
 */
function renderWidthProfile(CanvasKit, canvas, path, p, width, opacity, aa) {
  const rgba = parseColor(p.color);
  const profile = [[0, p.wStart], [clamp01(p.midpoint), p.wMid], [1, p.wEnd]].sort((a, b) => a[0] - b[0]);
  const taper = p.endStyle === "taper";
  const paint = new CanvasKit.Paint();
  paint.setStyle(CanvasKit.PaintStyle.Fill);
  paint.setAntiAlias(aa);
  paint.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], (rgba[3] ?? 1) * opacity));
  const half = width / 2;
  forEachContour(CanvasKit, path, (c) => {
    const L = c.length();
    if (!(L > 0)) return;
    const steps = arcStepCount(L, RIBBON_SAMPLE_SPACING, MAX_STROKE_SEGMENTS);
    const left = [], right = [];
    for (let i = 0; i <= steps; i++) {
      const d = L * i / steps;
      const pt = c.getPosTan(d);
      const n = unitNormal(pt[2], pt[3]);
      // Taper: the two extreme samples collapse to the centreline (a sharp point).
      const hw = taper && (i === 0 || i === steps) ? 0 : half * sampleProfile(profile, d / L);
      left.push([pt[0] + n[0] * hw, pt[1] + n[1] * hw]);
      right.push([pt[0] - n[0] * hw, pt[1] - n[1] * hw]);
    }
    const b = new CanvasKit.PathBuilder();
    b.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < left.length; i++) b.lineTo(left[i][0], left[i][1]);
    for (let i = right.length - 1; i >= 0; i--) b.lineTo(right[i][0], right[i][1]);
    b.close();
    const ribbon = b.detach();
    b.delete();
    canvas.drawPath(ribbon, paint);
    ribbon.delete();
  });
  paint.delete();
}

/**
 * Command. DASHES stroke: one dashed/dotted stroke of the whole path via
 * CanvasKit.PathEffect.MakeDash — the continuous dash+dots builder (or a classic
 * preset), at the chosen cap and phase. The single cheapest stroke material (one
 * drawPath, no arc walk).
 */
function renderDashes(CanvasKit, canvas, path, p, width, opacity, aa) {
  const rgba = parseColor(p.color);
  const intervals = dashIntervals(p.pattern, p.dash, p.gap, p.dot, p.dots, width).map((v) => Math.max(v, DASH_MIN_INTERVAL));
  const paint = strokePaintOf(CanvasKit, rgba, width, opacity, aa, capEnum(CanvasKit, p.cap));
  const eff = CanvasKit.PathEffect.MakeDash(intervals, p.phase);
  paint.setPathEffect(eff);
  canvas.drawPath(path, paint);
  eff.delete();
  paint.delete();
}

/**
 * Command. WAVY stroke: displaces every arc sample sideways by
 * wavyDisplacement(...) and strokes the resampled path, giving a clean sine wave
 * (randomness = wander = 0) or, with either random knob raised, a seeded
 * hand-drawn wobble that follows the shape's outline. Deterministic in the seed —
 * property state, reproducible across backends.
 */
function renderWavy(CanvasKit, canvas, path, p, width, opacity, aa) {
  const rgba = parseColor(p.color);
  // BOIL: the effective seed steps |boil| times per presentation second (the
  // particleTime seam — RECORDABLE: the editor freezes it, exports override it
  // per frame, so a boiling stroke exports correctly and Δt = 0 changes nothing).
  // boil 0 (the default) never reads the clock: byte-identical static wobble.
  const boil = p.boil ?? 0;
  const seed = boil !== 0 ? (p.seed ?? 0) + Math.floor(particleTime() * Math.abs(boil)) : (p.seed ?? 0);
  const paint = strokePaintOf(CanvasKit, rgba, width, opacity, aa);
  forEachContour(CanvasKit, path, (c) => {
    const L = c.length();
    if (!(L > 0)) return;
    const steps = arcStepCount(L, WAVY_SAMPLE_SPACING, MAX_STROKE_SEGMENTS);
    const closed = c.isClosed();
    const b = new CanvasKit.PathBuilder();
    for (let i = 0; i <= steps; i++) {
      const d = L * i / steps;
      const pt = c.getPosTan(d);
      const n = unitNormal(pt[2], pt[3]);
      const disp = wavyDisplacement(d, L, p.amplitude, p.frequency, p.phase, p.randomness, p.wander, seed);
      const x = pt[0] + n[0] * disp, y = pt[1] + n[1] * disp;
      if (i === 0) b.moveTo(x, y); else b.lineTo(x, y);
    }
    if (closed) b.close();
    const wpath = b.detach();
    b.delete();
    canvas.drawPath(wpath, paint);
    wpath.delete();
  });
  paint.delete();
}

// ── the entries + registry ────────────────────────────────────────────────────

export const ALONG_GRADIENT_STROKE = {
  id: "alongGradient",
  title: "Along Gradient",
  // The colour ramp is a real gradient STOP LIST (kind:"stops"), edited through the
  // same ListField + ramp preset library every gradient paint uses — insert-between,
  // per-stop visibility, purge-with-minimum, per-stop ColorField/NumericField at real
  // state paths (…material.params.stops.<i>.color/.offset) and a per-stop keyframe ◆.
  // Its schema default is NULL: absent stops is the sentinel that a document predates
  // this list, so renderAlongGradient (alongGradientStops) maps the LEGACY three
  // colour knobs below in for it, byte-identically. `seed` is the concrete list
  // web/PaintField.svelte writes into a fresh authoring so the editor is never empty.
  strokeParams: [
    { name: "stops", kind: "stops", default: null, seed: ALONG_GRADIENT_DEFAULT_STOPS, help: "The colours the gradient ramps through ALONG the stroke's arc length (t = 0 at the start, t = 1 at the end). Insert between two stops for their average; hide a stop to ramp straight past it; pick a preset from the ramp library." },
    { name: "repeat", kind: "number", default: 1, scrub: REPEAT_SCRUB, help: "How many times the whole ramp cycles over the path. 1 = one pass; 3 = three repeats. Must be > 0 (a value at or below 0 is reported and drawn as one pass)." },
    { name: "phase", kind: "number", default: 0, scrub: UNIT_SCRUB, help: "Shifts the ramp along the path (fraction of one cycle; it wraps, so 1.25 looks like 0.25). Keyframe it to make the colours flow." },
    // ── LEGACY, back-compat only (superseded by `stops`; hidden from the Inspector,
    //    but kept in the schema so a pre-stops-list document still RESOLVES its stored
    //    colours instead of having them dropped as unknown knobs — alongGradientStops
    //    reads them when `stops` is absent). `stopsActive` is the stops list's aligned
    //    visibility companion (core/lists.js), likewise hidden and likewise present so
    //    a hidden stop survives resolution and the render can honour it. ──
    { name: "colorStart", kind: "color", default: "#ff2d55", hidden: true, help: "Legacy: colour at the START of the arc (t = 0). Superseded by the Stops list." },
    { name: "colorMid", kind: "color", default: "#ffcc00", hidden: true, help: "Legacy: colour at the MIDPOINT along the arc. Superseded by the Stops list." },
    { name: "colorEnd", kind: "color", default: "#0a84ff", hidden: true, help: "Legacy: colour at the END of the arc (t = 1). Superseded by the Stops list." },
    { name: "midpoint", kind: "number", default: 0.5, min: 0, max: 1, scrub: UNIT_SCRUB, hidden: true, help: "Legacy: where the middle colour sat along the arc (fraction 0..1). Superseded by the Stops list." },
    { name: "stopsActive", kind: "stopsActive", default: undefined, hidden: true, help: "Per-stop visibility companion for the Stops list (core/lists.js). Managed by the stops editor, not a knob." },
  ],
  render: renderAlongGradient,
};

export const WIDTH_PROFILE_STROKE = {
  id: "widthProfile",
  title: "Width Profile",
  strokeParams: [
    { name: "color", kind: "color", default: "#111827", help: "The stroke colour (a variable-width brush is one solid ink)." },
    { name: "wStart", kind: "number", default: 0.25, min: 0, scrub: UNIT_SCRUB, help: "Width MULTIPLIER at the start of the path (× the stroke width). 0 = a sharp point; no upper cap — a belly wider than the stroke width is fine." },
    { name: "wMid", kind: "number", default: 1.4, min: 0, scrub: UNIT_SCRUB, help: "Width multiplier at the profile's midpoint — the belly of the brush." },
    { name: "wEnd", kind: "number", default: 0.25, min: 0, scrub: UNIT_SCRUB, help: "Width multiplier at the end of the path. 0 = a sharp point (a calligraphic taper)." },
    { name: "midpoint", kind: "number", default: 0.5, min: 0, max: 1, scrub: UNIT_SCRUB, help: "Where the mid width sits along the arc (fraction 0..1)." },
    { name: "endStyle", kind: "select", options: ["flat", "taper"], optionLabels: { flat: "Flat", taper: "Taper to point" }, default: "flat", help: "How the ribbon's two ENDS are finished. Flat = cut square at the end width (default). Taper = pull each end to the centreline so it comes to a sharp point regardless of the start/end width — a nib entry/exit. (This is intrinsic to the width profile; general stroke caps live in the stroke framework.)" },
  ],
  render: renderWidthProfile,
};

export const DASHES_STROKE = {
  id: "dashes",
  title: "Dashes / Dots",
  strokeParams: [
    { name: "color", kind: "color", default: "#111827", help: "The dash/dot colour." },
    { name: "pattern", kind: "select", options: ["custom", "dash", "dot", "dashDot"], optionLabels: { custom: "Custom (dash + dots)", dash: "Dashes", dot: "Dots", dashDot: "Dash-dot" }, default: "custom", help: "PRESET / builder mode. Custom drives the pattern from the continuous knobs below (Dash, Gap, Dot size, Dots per dash) — everything from a plain dashed line to Morse. Dashes / Dots / Dash-dot reproduce the three classic looks exactly (and keep documents authored before the builder rendering unchanged)." },
    { name: "dash", kind: "number", default: 16, min: 0, scrub: PX_SCRUB, help: "Length of the long DASH mark in local px. 0 turns the dash itself into a round dot. (Ignored by the pure-Dot preset.)" },
    { name: "gap", kind: "number", default: 10, min: 0, scrub: PX_SCRUB, help: "Gap between every mark in local px." },
    { name: "dot", kind: "number", default: DASH_DOT_ON, min: 0, scrub: PX_SCRUB, help: "Length of each short DOT mark in local px. Near 0 with a round cap it prints a round dot of diameter = stroke width; raise it toward the dash length for a dash-dash rhythm." },
    { name: "dots", kind: "number", default: 0, min: 0, step: 1, scrub: DOTS_SCRUB, help: "Custom mode only: how many short dots follow each dash (0 = a plain dashed line, 1 = dash-dot, 2 = dash-dot-dot, …). Rounded to a whole number." },
    { name: "phase", kind: "number", default: 0, scrub: PX_SCRUB, help: "Offset the pattern along the path (local px). Keyframe it for a marching-ants crawl." },
    { name: "cap", kind: "select", options: ["butt", "round", "square"], optionLabels: { butt: "Butt", round: "Round", square: "Square" }, default: "round", help: "Dash end cap. Round is required for a Dot to read as a dot." },
  ],
  render: renderDashes,
};

export const WAVY_STROKE = {
  id: "wavy",
  animated: (params) => (params.boil ?? 0) !== 0, // boil 0 (default) never reads the clock — static, so no repaint loop
  title: "Wavy",
  strokeParams: [
    { name: "color", kind: "color", default: "#7c3aed", help: "The wavy stroke's colour." },
    { name: "amplitude", kind: "number", default: 6, min: 0, scrub: 0.1, help: "Peak sideways displacement in local px — how tall the sine waves are. (Scrubs at 0.1/px — user calibration; negative would only mirror the wave, which Phase already does.)" },
    { name: "frequency", kind: "number", default: 8, min: 0, scrub: AMP_FREQ_SCRUB, help: "Number of complete sine waves across the WHOLE path (arc-length parameterized, so it stays even on curves)." },
    { name: "phase", kind: "number", default: 0, scrub: UNIT_SCRUB, help: "Shifts the wave along the path (fraction of one cycle; it wraps, so 1.25 looks like 0.25). Keyframe it to make the wave travel." },
    { name: "randomness", kind: "number", default: 0, scrub: UNIT_SCRUB, help: "AMPLITUDE JITTER, and the ONLY thing that makes the seed matter. 0 = a clean mechanical sine (seed irrelevant). Away from 0 the wave HEIGHT wanders irregularly along the path — a hand-drawn look — by this fraction of the amplitude (1 ≈ a wobble as tall as the wave; unbounded both ways — a NEGATIVE value flips the jitter stream sign, a different but equally valid wobble). Deterministic: same seed, same wobble." },
    { name: "wander", kind: "number", default: 0, scrub: UNIT_SCRUB, help: "FREQUENCY / PHASE JITTER. 0 = perfectly even wavelength. Away from 0 the peaks drift off the metronome — the wave stretches and compresses along the path — by up to this many cycles of seeded phase drift (unbounded both ways; negative flips the drift stream). Independent of amplitude jitter; 0 by default (seed stays inert until this or Randomness is raised)." },
    { name: "seed", kind: "number", default: 0, min: 0, step: 1, help: "WHICH random wobble — a stored integer (property state, not a live random draw). Only meaningful when Randomness or Wander is above 0; changing it reshuffles the irregularity without touching the underlying sine." },
    // THE BOIL (Round 3 #50 — the user's "sketchy stroke": seed = round(time·2)).
    // RECORDABLE state via the ONE clock seam: 0 (default) = static, byte-identical;
    // above 0 the effective seed re-rolls |boil| times per presentation second, so
    // the squiggle "boils" like a hand-drawn cartoon while presenting/exporting
    // (frozen deterministically in the editor, like the sparkler). Sign is
    // irrelevant (the step count floors either way), so no clamp.
    { name: "boil", kind: "number", default: 0, scrub: 0.1, help: "Re-rolls the random wobble this many times per second of presentation time, so the stroke looks alive and hand-sketched (2 is a classic cartoon boil). 0 = a still stroke. Frozen in the editor; moves while presenting and in exports. Needs Randomness or Wander above 0 to have anything to re-roll." },
  ],
  render: renderWavy,
};

// id → entry. A new stroke material appends ONE entry here (mirrors materials.js).
const STROKE_MATERIALS = Object.fromEntries(
  [ALONG_GRADIENT_STROKE, WIDTH_PROFILE_STROKE, DASHES_STROKE, WAVY_STROKE, BRUSH_STROKE, TEXTURE_BRUSH].map((m) => [m.id, m]),
);

/**
 * Pure function. Is `entry` a STROKE-capable material (declares a strokeParams
 * schema and a render command)? The stroke twin of isFillCapableMaterial.
 *
 * @param {{strokeParams?: Array, render?: Function}} entry
 * @returns {boolean}
 *
 * @example isStrokeCapableMaterial({id: "wavy", strokeParams: [], render: () => {}}) // true
 * @example isStrokeCapableMaterial({id: "comic", fillParams: []}) // false
 */
export function isStrokeCapableMaterial(entry) {
  return Array.isArray(entry?.strokeParams) && typeof entry?.render === "function";
}

/**
 * Query. True iff `id` names a registered stroke material — the disambiguator
 * materials.resolveMaterialPaint uses to route a paint's id to the stroke registry
 * rather than the fill one.
 *
 * @example hasStrokeMaterial("wavy") // true
 * @example hasStrokeMaterial("comic") // false
 */
export function hasStrokeMaterial(id) {
  return Object.prototype.hasOwnProperty.call(STROKE_MATERIALS, id);
}

/**
 * Query. Resolves a stroke-material id to its entry. Throws LOUDLY on an unknown
 * id (a typo must not silently no-op a whole stroke).
 *
 * @param {string} id
 * @returns {{id:string, title:string, strokeParams:Array, render:Function}}
 *
 * @example getStrokeMaterial("wavy").id // "wavy"
 */
export function getStrokeMaterial(id) {
  const m = STROKE_MATERIALS[id];
  if (!m) throw new Error(`stroke_materials.getStrokeMaterial: unknown stroke material "${id}" (known: ${Object.keys(STROKE_MATERIALS).join(", ")})`);
  return m;
}

/**
 * Query. Every registered stroke-material id — the PaintField stroke dropdown's
 * list and the stroke-matrix probe's axis, so both grow automatically as
 * materials are added.
 *
 * @example strokeMaterialIds().includes("wavy") // true
 */
export function strokeMaterialIds() {
  return Object.keys(STROKE_MATERIALS);
}
