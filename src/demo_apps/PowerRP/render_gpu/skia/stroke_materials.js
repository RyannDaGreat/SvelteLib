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
 *                     ({name, kind, default, min?, max?, step?, options?,
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
 *
 * DETERMINISM / STATE KIND. A stroke material is PROPERTY STATE: a pure function of
 * (geometry, knobs) with no ambient input — no wall clock, no Math.random. The
 * wavy material's wobble is a SEEDED deterministic function of arc position, so the
 * same document renders byte-identically in the editor, the CLI, and both video
 * backends (CLAUDE.md: "Picking a seed and STORING it is property state").
 *
 * DOM-free at import (only pure JS + string schemas), like materials.js — CanvasKit
 * arrives as a render() argument, never an import. `parseColor` (render_gpu/ir.js)
 * is the shared node-safe colour parser.
 */

import { parseColor } from "../ir.js";

// ── arc-length sampling budget (WHY each exists — no magic numbers) ───────────
const GRADIENT_SEGMENT_SPACING = 3;  // local px per colour band when walking an along-gradient (finer = smoother ramp, more draws)
const WAVY_SAMPLE_SPACING = 2.5;     // local px between wobble samples — must be << the shortest wavelength or the sine aliases
const RIBBON_SAMPLE_SPACING = 2.5;   // local px between variable-width ribbon samples
const MAX_STROKE_SEGMENTS = 4000;    // hard cap on samples/bands per contour, so a pathological length can't stall the frame
const MIN_STROKE_SEGMENTS = 2;       // a degenerate-short contour still gets a 2-sample stroke
const DASH_DOT_ON = 0.01;            // "on" length of a DOT dash (≈0): with a round cap it prints a dot of diameter = strokeWidth
const DASH_MIN_INTERVAL = 1e-3;      // MakeDash needs strictly-positive intervals; clamp a 0-gap authoring extreme up to this
const WAVY_WOBBLE_FRAC = 0.3;        // seeded secondary-harmonic amplitude, as a fraction of the primary amplitude
const WAVY_WOBBLE_FREQ_BASE = 1.7;   // seeded harmonic's base frequency multiplier (≠ integer, so it never phase-locks to the primary)

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
 * Pure function. The LEFT unit normal of a tangent vector (tx, ty) — a 90°
 * counter-clockwise rotation, normalized. Used to offset a path point to one side
 * for the wavy displacement and the variable-width ribbon edges. A zero-length
 * tangent (a degenerate sample) returns [0, 0] rather than NaN.
 *
 * @param {number} tx - tangent x
 * @param {number} ty - tangent y
 * @returns {[number, number]} unit normal (nx, ny)
 *
 * @example unitNormal(1, 0) // [0, 1]
 * @example unitNormal(0, 2) // [-1, 0]
 * @example unitNormal(0, 0) // [0, 0]
 */
export function unitNormal(tx, ty) {
  const len = Math.hypot(tx, ty);
  if (!(len > 0)) return [0, 0];
  return [-ty / len, tx / len];
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
 * Pure function. A deterministic pseudo-random value in [-1, 1) from an integer
 * seed and a channel index k — a sin-fract hash (no Math.random, so a stored seed
 * is property state). Two DIFFERENT k on the same seed decorrelate, which is how
 * the wavy wobble draws two independent harmonic parameters from one seed.
 *
 * @param {number} seed - the material's stored seed
 * @param {number} k - channel index (1, 2, …)
 * @returns {number} deterministic value in [-1, 1)
 *
 * @example hashSeed(7, 1) // a deterministic value in [-1, 1)
 */
export function hashSeed(seed, k) {
  const x = Math.sin(seed * 127.1 + k * 311.7) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

/**
 * Pure function. The WAVY material's normal-direction displacement at arc distance
 * `s` along a contour of length `length`. The primary term is a clean sine of
 * `frequency` full waves across the whole path (phase in cycles). When `seed` is
 * non-zero a smaller, seed-decorrelated secondary harmonic is added, giving a
 * hand-drawn irregular wobble instead of a mechanical sine; `seed === 0` is the
 * pure sine (a clean contract, easy to reason about).
 *
 *     d(s) = A·sin(2π·(f·s/L + φ))                              (seed = 0)
 *          + 0.3·A·sin(2π·(f·(1.7+r1)·s/L + r2))               (seed ≠ 0; r = hashSeed)
 *
 * @param {number} s - arc distance along the contour (local px)
 * @param {number} length - the contour's total length (local px)
 * @param {number} amplitude - peak displacement A (local px)
 * @param {number} frequency - full waves f across the whole path
 * @param {number} phase - phase φ in cycles (0..1 tiles one wave)
 * @param {number} seed - wobble seed (0 = clean sine)
 * @returns {number} signed displacement along the left normal (local px)
 *
 * @example wavyDisplacement(0, 100, 6, 8, 0, 0) // 0
 * @example wavyDisplacement(100, 100, 6, 8, 0, 0) // a deterministic value near 0 (a whole number of waves)
 * @example wavyDisplacement(50, 100, 6, 8, 0.25, 0) // a deterministic displacement
 */
export function wavyDisplacement(s, length, amplitude, frequency, phase, seed) {
  const u = length > 0 ? s / length : 0;
  let d = amplitude * Math.sin(2 * Math.PI * (frequency * u + phase));
  if (seed !== 0) {
    const r1 = hashSeed(seed, 1), r2 = hashSeed(seed, 2);
    d += WAVY_WOBBLE_FRAC * amplitude * Math.sin(2 * Math.PI * (frequency * (WAVY_WOBBLE_FREQ_BASE + r1) * u + r2));
  }
  return d;
}

/**
 * Pure function. The dash INTERVAL array for a stroke dash pattern, in local px,
 * matching CanvasKit.PathEffect.MakeDash's [on, off, on, off, …] contract:
 *   - "dash"    → [dash, gap]           a plain dashed line
 *   - "dot"     → [DASH_DOT_ON, gap]    a near-zero "on" that a round cap prints as a dot
 *   - "dashDot" → [dash, gap, DASH_DOT_ON, gap]   alternating dash · dot
 * `strokeWidth` is accepted for symmetry with the other patterns (a dot's visible
 * size comes from the round cap = strokeWidth, so it is not needed in the array).
 *
 * @param {string} pattern - "dash" | "dot" | "dashDot"
 * @param {number} dash - dash length (local px)
 * @param {number} gap - gap length (local px)
 * @param {number} strokeWidth - stroke width (local px)
 * @returns {number[]} even-length interval array
 *
 * @example dashIntervals("dash", 16, 10, 4) // [16, 10]
 * @example dashIntervals("dot", 16, 10, 4) // [0.01, 10]
 * @example dashIntervals("dashDot", 16, 10, 4) // [16, 10, 0.01, 10]
 */
export function dashIntervals(pattern, dash, gap, strokeWidth) {
  if (pattern === "dot") return [DASH_DOT_ON, gap];
  if (pattern === "dashDot") return [dash, gap, DASH_DOT_ON, gap];
  return [dash, gap];
}

// ── shared draw plumbing (Commands / near-pure builders) ──────────────────────

/**
 * Near-pure builder (allocates a Skia Paint; caller deletes). A stroke paint with
 * the given rgba (alpha folded with `opacity`), width, caps and joins.
 */
function strokePaintOf(CanvasKit, rgba, width, opacity, aa, cap, join) {
  const p = new CanvasKit.Paint();
  p.setStyle(CanvasKit.PaintStyle.Stroke);
  p.setStrokeWidth(width);
  p.setAntiAlias(aa);
  p.setStrokeCap(cap ?? CanvasKit.StrokeCap.Round);
  p.setStrokeJoin(join ?? CanvasKit.StrokeJoin.Round);
  p.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], (rgba[3] ?? 1) * opacity));
  return p;
}

/** Query. Maps a cap knob string to the CanvasKit enum (default round). */
function capEnum(CanvasKit, cap) {
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
 * Command. ALONG-GRADIENT stroke: a 3-stop colour ramp (start → mid → end) run
 * ALONG the path's arc length. The path is walked in short bands; each band is
 * stroked with the ramp colour at its arc fraction, wrapped by `repeat` (how many
 * times the ramp cycles over the whole path) and shifted by `phase`. This is the
 * arc-length gradient a bbox shader cannot express — the colour follows the WIRE,
 * not the bounding box.
 */
function renderAlongGradient(CanvasKit, canvas, path, p, width, opacity, aa) {
  const stops = [
    { offset: 0, color: parseColor(p.colorStart) },
    { offset: clamp01(p.midpoint), color: parseColor(p.colorMid) },
    { offset: 1, color: parseColor(p.colorEnd) },
  ].sort((a, b) => a.offset - b.offset);
  const paint = strokePaintOf(CanvasKit, stops[0].color, width, opacity, aa);
  forEachContour(CanvasKit, path, (c) => {
    const L = c.length();
    if (!(L > 0)) return;
    const steps = arcStepCount(L, GRADIENT_SEGMENT_SPACING, MAX_STROKE_SEGMENTS);
    for (let i = 0; i < steps; i++) {
      const tt = frac((i + 0.5) / steps * p.repeat + p.phase);
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
 * band. This is a true variable-width brush, not a uniform stroke.
 */
function renderWidthProfile(CanvasKit, canvas, path, p, width, opacity, aa) {
  const rgba = parseColor(p.color);
  const profile = [[0, p.wStart], [clamp01(p.midpoint), p.wMid], [1, p.wEnd]].sort((a, b) => a[0] - b[0]);
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
      const hw = half * sampleProfile(profile, d / L);
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
 * CanvasKit.PathEffect.MakeDash — plain dashes, round-capped dots, or an
 * alternating dash·dot, at the chosen cap and phase. The single cheapest stroke
 * material (one drawPath, no arc walk).
 */
function renderDashes(CanvasKit, canvas, path, p, width, opacity, aa) {
  const rgba = parseColor(p.color);
  const intervals = dashIntervals(p.pattern, p.dash, p.gap, width).map((v) => Math.max(v, DASH_MIN_INTERVAL));
  const paint = strokePaintOf(CanvasKit, rgba, width, opacity, aa, capEnum(CanvasKit, p.cap));
  const eff = CanvasKit.PathEffect.MakeDash(intervals, p.phase);
  paint.setPathEffect(eff);
  canvas.drawPath(path, paint);
  eff.delete();
  paint.delete();
}

/**
 * Command. WAVY stroke: displaces every arc sample sideways by
 * wavyDisplacement(...) and strokes the resampled path, giving a sine wave (or,
 * with a non-zero seed, a hand-drawn irregular wobble) that follows the shape's
 * outline. Deterministic in the seed — property state, reproducible across
 * backends.
 */
function renderWavy(CanvasKit, canvas, path, p, width, opacity, aa) {
  const rgba = parseColor(p.color);
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
      const disp = wavyDisplacement(d, L, p.amplitude, p.frequency, p.phase, p.seed);
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
  strokeParams: [
    { name: "colorStart", kind: "color", default: "#ff2d55", help: "Colour at the START of the stroke's arc length (t = 0)." },
    { name: "colorMid", kind: "color", default: "#ffcc00", help: "Colour at the profile's MIDPOINT along the arc." },
    { name: "colorEnd", kind: "color", default: "#0a84ff", help: "Colour at the END of the stroke's arc length (t = 1)." },
    { name: "midpoint", kind: "number", default: 0.5, min: 0, max: 1, step: 0.01, help: "Where the middle colour sits along the arc (fraction 0..1)." },
    { name: "repeat", kind: "number", default: 1, min: 0.1, step: 0.1, help: "How many times the whole start→mid→end ramp cycles over the path. 1 = one pass; 3 = three repeats." },
    { name: "phase", kind: "number", default: 0, min: 0, max: 1, step: 0.01, help: "Shifts the ramp along the path (fraction of one cycle). Keyframe it to make the colours flow." },
  ],
  render: renderAlongGradient,
};

export const WIDTH_PROFILE_STROKE = {
  id: "widthProfile",
  title: "Width Profile",
  strokeParams: [
    { name: "color", kind: "color", default: "#111827", help: "The stroke colour (a variable-width brush is one solid ink)." },
    { name: "wStart", kind: "number", default: 0.25, min: 0, step: 0.05, help: "Width MULTIPLIER at the start of the path (× the stroke width). 0 = a sharp point." },
    { name: "wMid", kind: "number", default: 1.4, min: 0, step: 0.05, help: "Width multiplier at the profile's midpoint — the belly of the brush." },
    { name: "wEnd", kind: "number", default: 0.25, min: 0, step: 0.05, help: "Width multiplier at the end of the path. 0 = a sharp point (a calligraphic taper)." },
    { name: "midpoint", kind: "number", default: 0.5, min: 0, max: 1, step: 0.01, help: "Where the mid width sits along the arc (fraction 0..1)." },
  ],
  render: renderWidthProfile,
};

export const DASHES_STROKE = {
  id: "dashes",
  title: "Dashes / Dots",
  strokeParams: [
    { name: "color", kind: "color", default: "#111827", help: "The dash/dot colour." },
    { name: "pattern", kind: "select", options: ["dash", "dot", "dashDot"], optionLabels: { dash: "Dashes", dot: "Dots", dashDot: "Dash-dot" }, default: "dash", help: "Dashes, round Dots (dash length ≈ 0 + a round cap), or an alternating dash·dot." },
    { name: "dash", kind: "number", default: 16, min: 0, step: 1, help: "Dash length in local px (unused by the pure-Dot pattern)." },
    { name: "gap", kind: "number", default: 10, min: 0, step: 1, help: "Gap between marks in local px." },
    { name: "phase", kind: "number", default: 0, step: 1, help: "Offset the pattern along the path (local px). Keyframe it for a marching-ants crawl." },
    { name: "cap", kind: "select", options: ["butt", "round", "square"], optionLabels: { butt: "Butt", round: "Round", square: "Square" }, default: "round", help: "Dash end cap. Round is required for the Dot pattern to read as dots." },
  ],
  render: renderDashes,
};

export const WAVY_STROKE = {
  id: "wavy",
  title: "Wavy",
  strokeParams: [
    { name: "color", kind: "color", default: "#7c3aed", help: "The wavy stroke's colour." },
    { name: "amplitude", kind: "number", default: 6, min: 0, step: 0.5, help: "Peak sideways displacement in local px — how tall the waves are." },
    { name: "frequency", kind: "number", default: 8, min: 0, step: 0.5, help: "Number of complete waves across the WHOLE path (arc-length parameterized, so it stays even on curves)." },
    { name: "phase", kind: "number", default: 0, min: 0, max: 1, step: 0.01, help: "Shifts the wave along the path (fraction of one cycle). Keyframe it to make the wave travel." },
    { name: "seed", kind: "number", default: 0, min: 0, step: 1, help: "0 = a clean mechanical sine. Any other value adds a seeded secondary wobble for a hand-drawn, irregular look (deterministic — same seed, same wobble)." },
  ],
  render: renderWavy,
};

// id → entry. A new stroke material appends ONE entry here (mirrors materials.js).
const STROKE_MATERIALS = Object.fromEntries(
  [ALONG_GRADIENT_STROKE, WIDTH_PROFILE_STROKE, DASHES_STROKE, WAVY_STROKE].map((m) => [m.id, m]),
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
