/**
 * RAMPS — the shared COLOUR-RAMP value model: a list of {offset, color} stops
 * plus the two aspects that decide how it is READ (`loop` and the interpolation
 * `space`), and the sampling/baking math every consumer runs. DOM-free pure JS
 * (bare-node testable, like the rest of core/).
 *
 * ── WHY (the duplication this ends) ───────────────────────────────────────────
 * The app had TWO colour ramps that could not share anything:
 *
 *   A GRADIENT PAINT's stops — a declared, sorted, keyframable LIST
 *     (core/properties.js GRADIENT_STOPS_LIST) with ABSOLUTE offsets in [0,1], a
 *     preset library of 343 baked ramps (web/gradient_presets.js), a general list
 *     control, and per-element `=` equations.
 *   A MANDELBROT PALETTE — a `select` over six hard-coded colour-name lists plus
 *     a comma-separated `text` OVERRIDE. Its own row said the cost out loud:
 *     "Being text, this switches rather than tweens." So a palette could not
 *     animate between two ramps at all, none of the 343 presets was reachable
 *     from it, and no stop was addressable by an equation.
 *
 * The user's ruling: "The palette in the Mandelbrot viewer could be the same as a
 * gradient selector. If gradient selector is not currently a generalizable
 * property, we should make it that way, because all those presets and stuff are
 * beautiful and should be integrated" — then "make them ramp-capable? and make
 * the gradient loop perhaps".
 *
 * So the generalizable thing is NOT "paint": a paint is a ramp PLUS geometry
 * (linear/radial, an angle, a radius), and a Mandelbrot palette has no geometry
 * to give — offering it a direction dial would be a false affordance. The
 * generalizable thing is the RAMP, and it factors as
 *
 *     PAINT     = ramp + geometry (type, angle | center+radius)
 *     PALETTE   = ramp, read cyclically, indexed by an escape-time axis
 *
 * which is why `loop` and `space` live HERE (aspects of a ramp, read identically
 * by both consumers) rather than as Mandelbrot behaviour.
 *
 * ── `loop`: THE EXACT BOUNDARY SEMANTICS ──────────────────────────────────────
 * This is the phrase that hides an off-by-one, so it is spelled out.
 *
 * loop = false (CLAMP — today's gradient behaviour, byte-identical):
 *   The ramp is defined on [offset_0, offset_last]. Below offset_0 the colour is
 *   c_0; above offset_last it is c_last. Offsets 0 and 1 are the two DISTINCT
 *   ENDS of the ramp. This is Skia/SVG TileMode.Clamp.
 *
 * loop = true (CIRCULAR — period exactly 1):
 *   The domain is the CIRCLE: R(t) = R(t + 1) for every t. The stops sit at
 *   offset_i on that circle, and the segment from the LAST stop to the FIRST is
 *   SYNTHESISED — it runs from offset_last to offset_0 + 1, so its length is
 *   1 − offset_last + offset_0. Consequences, stated because each is a place a
 *   reader could guess wrong:
 *     • offset 1 IS offset 0. They are the same point on the circle, not two
 *       ends. A ramp with stops at BOTH collapses the wrap segment to zero
 *       length, which produces a HARD SEAM there — that is how a seam is
 *       authored deliberately, and it is what CSS repeating-linear-gradient and
 *       Photoshop's gradient "repeat" do.
 *     • A ramp whose stops span only [0, 1 − 1/N) — i.e. offset_i = i/N — has a
 *       wrap segment of length exactly 1/N, so all N segments are equal and the
 *       ramp is SEAMLESS. That is what a cyclic palette needs, and it is why
 *       evenlySpacedRampStops uses i/N and NOT i/(N−1): i/(N−1) puts the last
 *       stop at offset 1, squashing the wrap segment to nothing and changing
 *       EVERY sampled colour. This is the off-by-one, and it is load-bearing.
 *     • Every t maps somewhere. There is no undefined region and no clamping.
 *
 * CIRCULAR was chosen over "tile the [0,1] ramp" because it is strictly more
 * general: tiling is CIRCULAR with the first stop's colour duplicated at offset
 * 1, so a user can still author a hard seam — whereas tiling cannot express a
 * seamless ramp at all without editing colours. It also reproduces the existing
 * Mandelbrot palette EXACTLY (see MANDELBROT NOTE in bakeRampLut).
 *
 * ── `space`: WHERE THE BLEND HAPPENS ─────────────────────────────────────────
 * "srgb" blends the stored (gamma-encoded) channels directly — what Skia, SVG
 * and PDF gradients do, so it is the DEFAULT and every existing gradient renders
 * unchanged. "oklab" decodes to linear light, converts to OKLab, blends, and
 * converts back — perceptually even, and the reason the Mandelbrot palettes do
 * not pass through mud. The space is a RAMP aspect because the named palettes
 * carry it with them: a ramp authored in OKLab and read in sRGB is a different
 * ramp, so moving those palettes into the shared library without the space
 * travelling alongside would have silently changed how they look.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ────────────────────────────────
 * It has no opinion about the UI, no opinion about the document, and it never
 * sorts. A "sorted" list means CANONICALISED ON WRITE (core/lists.js
 * canonicalOrder); the raster/SVG/PDF paths all treat stored ORDER as
 * authoritative, so re-sorting here would hide a write-path bug instead of
 * letting it fail where it happened. An out-of-order ramp is reported, loudly,
 * by checkRampStops.
 */

import { isHexColor, hexToRgb, rgbToHex } from "./interpolators.js";

/**
 * The interpolation SPACES a ramp may declare. Array VALUES are the stored state
 * / equation slugs; RAMP_SPACE_LABELS maps each to the Inspector's human label.
 * Declared here (the module that owns the mechanism) and imported by
 * core/properties.js for its select row — the same shape core/shapes.js
 * SHAPE_NAMES and core/film.js PERF_FAMILY_IDS already have.
 *
 * @example RAMP_SPACES // ["srgb", "oklab"]
 * @example RAMP_SPACES.includes("hsl") // false (no hue-rotating space is wired)
 */
export const RAMP_SPACES = ["srgb", "oklab"];
export const RAMP_SPACE_LABELS = {
  srgb: "sRGB (direct)",
  oklab: "OKLab (perceptual)",
};

/**
 * The space a ramp gets when it does not say — the one that leaves every
 * EXISTING gradient byte-identical, because Skia/SVG/PDF gradients blend the
 * stored channels directly. A ramp that needs perceptual blending says so.
 *
 * @example DEFAULT_RAMP_SPACE // "srgb"
 */
export const DEFAULT_RAMP_SPACE = "srgb";

// LOUD IMPORT-TIME GUARD (the core/properties.js ANTIALIAS_MODES precedent): a
// space with no label would show its raw id in the Inspector, and a stale label
// is a space someone forgot to delete.
for (const space of RAMP_SPACES)
  if (!(space in RAMP_SPACE_LABELS))
    throw new Error(`ramps: RAMP_SPACES declares "${space}" but RAMP_SPACE_LABELS has no human label for it — add one (the Inspector would show the raw id).`);
for (const space of Object.keys(RAMP_SPACE_LABELS))
  if (!RAMP_SPACES.includes(space))
    throw new Error(`ramps: RAMP_SPACE_LABELS labels "${space}", which is not in RAMP_SPACES — remove the stale entry.`);
if (!RAMP_SPACES.includes(DEFAULT_RAMP_SPACE))
  throw new Error(`ramps: DEFAULT_RAMP_SPACE "${DEFAULT_RAMP_SPACE}" is not one of ${JSON.stringify(RAMP_SPACES)}.`);

/**
 * THE PRESET-LIBRARY id a COLOUR RAMP's stop list declares (`presets:
 * COLOR_RAMP_LIBRARY`), which is what makes the preset picker a property of the
 * DECLARATION rather than of one mount point: any list that says this gets the
 * library, and no list that does not can accidentally acquire it.
 *
 * WHY AN ID AND NOT A BOOLEAN: the aspect names WHICH library, so a future
 * library over a different element shape (an easing-curve library, a font
 * pairing) is a new id and a new entry here — not a second boolean whose meaning
 * depends on the element shape it happens to sit beside. There is exactly one
 * today, and RAMP_PRESET_LIBRARIES is what a loud guard checks a declaration
 * against (core/properties.js checkListRow).
 *
 * @example COLOR_RAMP_LIBRARY // "colorRamp"
 * @example RAMP_PRESET_LIBRARIES.includes(COLOR_RAMP_LIBRARY) // true
 */
export const COLOR_RAMP_LIBRARY = "colorRamp";
export const RAMP_PRESET_LIBRARIES = [COLOR_RAMP_LIBRARY];

/** One 8-bit channel's full scale — a stored hex byte divided by this is the
 *  0..1 channel value (the same division render_gpu/ir.js parseColor makes, so a
 *  ramp stop and a solid colour decode to bit-identical floats). */
const BYTE_MAX = 255;

/** The sRGB transfer function's constants (IEC 61966-2-1). */
const SRGB_LINEAR_CUTOFF = 0.0031308;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_GAMMA_SCALE = 1.055;
const SRGB_GAMMA_OFFSET = 0.055;
/** The sRGB curve's exponent above the linear toe. */
const SRGB_GAMMA = 2.4;

/**
 * Pure function. Gamma-encoded sRGB to linear light — what a hex colour must
 * pass through before it can be interpolated perceptually or averaged.
 *
 * @param {number} v - encoded channel, 0..1 (clamped)
 * @returns {number} linear light, 0..1
 *
 * @example srgbToLinear(1) // 1
 * @example srgbToLinear(0) // 0
 * @example +srgbToLinear(0.7354).toFixed(4) // 0.5
 */
export function srgbToLinear(v) {
  const c = Math.min(1, Math.max(0, v));
  return c <= SRGB_LINEAR_CUTOFF * SRGB_LINEAR_SLOPE
    ? c / SRGB_LINEAR_SLOPE
    : Math.pow((c + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_SCALE, SRGB_GAMMA);
}

/**
 * Pure function. Linear light back to gamma-encoded sRGB — the inverse of
 * srgbToLinear, and the CPU twin of the shader's encodeSrgb.
 *
 * @param {number} v - linear light, 0..1 (clamped)
 * @returns {number} encoded channel, 0..1
 *
 * @example linearToSrgb(1) // 1
 * @example linearToSrgb(0) // 0
 * @example +linearToSrgb(srgbToLinear(0.42)).toFixed(6) // 0.42
 */
export function linearToSrgb(v) {
  const c = Math.min(1, Math.max(0, v));
  return c <= SRGB_LINEAR_CUTOFF
    ? c * SRGB_LINEAR_SLOPE
    : SRGB_GAMMA_SCALE * Math.pow(c, 1 / SRGB_GAMMA) - SRGB_GAMMA_OFFSET;
}

/**
 * Pure function. Linear sRGB to OKLab (Björn Ottosson's published matrices) — a
 * perceptually uniform space, so a straight line between two colours in it is a
 * straight line to the eye.
 *
 * @param {number} r - linear sRGB red, 0..1
 * @param {number} g - linear sRGB green, 0..1
 * @param {number} b - linear sRGB blue, 0..1
 * @returns {[number, number, number]} [L, a, b]
 *
 * @example linearSrgbToOklab(1, 1, 1).map((v) => +v.toFixed(4)) // [1, 0, 0]
 * @example linearSrgbToOklab(0, 0, 0) // [0, 0, 0]
 */
export function linearSrgbToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/**
 * Pure function. OKLab back to linear sRGB — Ottosson's published inverse. May
 * leave the gamut (a blend of two in-gamut colours can); callers clamp.
 *
 * @param {number} L - OKLab lightness
 * @param {number} a - OKLab green/red axis
 * @param {number} b - OKLab blue/yellow axis
 * @returns {[number, number, number]} linear sRGB
 *
 * @example oklabToLinearSrgb(1, 0, 0).map((v) => +v.toFixed(4)) // [1, 1, 1]
 * @example oklabToLinearSrgb(0, 0, 0) // [0, 0, 0]
 */
export function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/**
 * Pure function. A ramp stop's colour as [r, g, b, a] in 0..1 GAMMA-ENCODED
 * sRGB. A stop's colour is a `color`-kind slot, which every control in the app
 * writes as hex — anything else is a delta/fold bug and throws rather than being
 * guessed at. (render_gpu/ir.js parseColor is the renderer-side parser that also
 * accepts rgba() strings and float arrays; this is core, and core's colour form
 * is hex — core/interpolators.js isHexColor.)
 *
 * @param {string} color - "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa"
 * @returns {[number, number, number, number]} encoded sRGB + alpha, 0..1
 *
 * @example stopRgba("#ffffff") // [1, 1, 1, 1]
 * @example stopRgba("#000000") // [0, 0, 0, 1]
 * @example stopRgba("#ff000080").map((v) => +v.toFixed(4)) // [1, 0, 0, 0.502]
 */
export function stopRgba(color) {
  if (!isHexColor(color))
    throw new Error(`ramps.stopRgba: a ramp stop's colour must be hex ("#rrggbb" / "#rrggbbaa"), got ${JSON.stringify(color)}`);
  const bytes = hexToRgb(color);
  return [bytes[0] / BYTE_MAX, bytes[1] / BYTE_MAX, bytes[2] / BYTE_MAX, (bytes[3] ?? BYTE_MAX) / BYTE_MAX];
}

/**
 * Query (throws). Validates a ramp's stop list — the loud gate every sampler
 * runs first, so a malformed ramp fails where it is handed over rather than
 * painting nonsense. Requires at least two stops (one colour is a solid, not a
 * ramp — the same floor core/properties.js MIN_GRADIENT_STOPS declares), finite
 * offsets, and NON-DECREASING order (see the module header: stored order is
 * authoritative all the way down, so an out-of-order ramp is a write-path bug).
 *
 * @param {{offset: number, color: string}[]} stops
 * @returns {undefined} (throws on a malformed ramp)
 *
 * @example checkRampStops([{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}]) // undefined
 * @example // checkRampStops([{offset: 1, color: "#000"}, {offset: 0, color: "#fff"}])
 * @example // → throws: stop 1 sits at offset 0, before its predecessor's 1 …
 */
export function checkRampStops(stops) {
  if (!Array.isArray(stops) || stops.length < 2)
    throw new Error(`ramps: a ramp needs at least 2 stops, got ${JSON.stringify(stops)}`);
  stops.forEach((s, i) => {
    if (!s || typeof s !== "object" || typeof s.offset !== "number" || !Number.isFinite(s.offset))
      throw new Error(`ramps: stop ${i} has no finite "offset": ${JSON.stringify(s)}`);
    if (i > 0 && s.offset < stops[i - 1].offset)
      throw new Error(`ramps: stop ${i} sits at offset ${s.offset}, before its predecessor's ${stops[i - 1].offset} — a ramp's stored order is authoritative (it is canonicalised on write, core/lists.js canonicalOrder), so this is a write-path bug, not something to sort away here.`);
  });
}

/**
 * Pure function. EVENLY SPACED stop offsets for a bare colour list — the shape a
 * cyclic palette was stored in before ramps existed, and the ONE place the
 * loop/no-loop off-by-one is decided (see the module header):
 *
 *   loop  → offset_i = i / N        (N equal segments including the wrap one)
 *   clamp → offset_i = i / (N − 1)  (N − 1 segments, first stop at 0, last at 1)
 *
 * @param {string[]} colors - two or more hex colours, in order
 * @param {boolean} loop - whether the ramp is read circularly
 * @returns {{offset: number, color: string}[]}
 *
 * @example evenlySpacedRampStops(["#000000", "#ffffff"], false) // [{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}]
 * @example evenlySpacedRampStops(["#000000", "#ffffff"], true) // [{offset: 0, color: "#000000"}, {offset: 0.5, color: "#ffffff"}]
 * @example evenlySpacedRampStops(["#f00", "#0f0", "#00f", "#ff0"], true).map((s) => s.offset) // [0, 0.25, 0.5, 0.75]
 * @example evenlySpacedRampStops(["#f00", "#0f0", "#00f"], false).map((s) => s.offset) // [0, 0.5, 1]
 */
export function evenlySpacedRampStops(colors, loop) {
  if (!Array.isArray(colors) || colors.length < 2)
    throw new Error(`ramps.evenlySpacedRampStops: need at least 2 colours, got ${JSON.stringify(colors)}`);
  const spans = loop ? colors.length : colors.length - 1;
  return colors.map((color, i) => ({ offset: i / spans, color }));
}

/**
 * Pure function. The stored-order index of the segment `u` falls in, or −1 when
 * `u` is outside every declared segment (below the first stop, above the last,
 * or exactly on the last). The helper both samplers share so "which segment" is
 * decided once.
 *
 * @param {{offset: number}[]} stops
 * @param {number} u - a position in the ramp's own offset units
 * @returns {number} the index i such that offset_i <= u < offset_{i+1}, else -1
 *
 * @example rampSegmentAt([{offset: 0}, {offset: 0.5}, {offset: 1}], 0.25) // 0
 * @example rampSegmentAt([{offset: 0}, {offset: 0.5}, {offset: 1}], 0.75) // 1
 * @example rampSegmentAt([{offset: 0}, {offset: 1}], 1) // -1 (on the last stop: no segment starts there)
 * @example rampSegmentAt([{offset: 0.25}, {offset: 0.75}], 0.1) // -1 (below the first stop)
 */
export function rampSegmentAt(stops, u) {
  for (let i = 0; i < stops.length - 1; i++)
    if (u >= stops[i].offset && u < stops[i + 1].offset) return i;
  return -1;
}

/**
 * Pure function. Blends two encoded-sRGB rgba quads at `f` in the declared SPACE
 * and returns LINEAR rgb + alpha. Linear is the CANONICAL output because it is
 * what a shader LUT and any averaging need; sampleRamp encodes it back for the
 * consumers that want a stored colour, so the round trip happens at most once and
 * never inside the blend.
 *
 * Alpha always blends linearly in its own stored units — it is a coverage weight,
 * not a colour channel, so no colour space applies to it.
 *
 * @param {number[]} a - encoded sRGB + alpha, 0..1
 * @param {number[]} b - encoded sRGB + alpha, 0..1
 * @param {number} f - blend position, 0..1
 * @param {string} space - a RAMP_SPACES entry
 * @returns {[number, number, number, number]} LINEAR rgb (may leave the gamut) + alpha
 *
 * @example blendRampLinear([0, 0, 0, 1], [1, 1, 1, 1], 0, "srgb") // [0, 0, 0, 1]
 * @example blendRampLinear([0, 0, 0, 1], [1, 1, 1, 1], 1, "srgb") // [1, 1, 1, 1]
 * @example +blendRampLinear([0, 0, 0, 1], [1, 1, 1, 1], 0.5, "srgb")[0].toFixed(4) // 0.2140 (0.5 ENCODED is 21.4% of the light)
 */
export function blendRampLinear(a, b, f, space) {
  const alpha = a[3] + (b[3] - a[3]) * f;
  if (space === "srgb") {
    const mix = [0, 1, 2].map((k) => srgbToLinear(a[k] + (b[k] - a[k]) * f));
    return [mix[0], mix[1], mix[2], alpha];
  }
  const la = linearSrgbToOklab(srgbToLinear(a[0]), srgbToLinear(a[1]), srgbToLinear(a[2]));
  const lb = linearSrgbToOklab(srgbToLinear(b[0]), srgbToLinear(b[1]), srgbToLinear(b[2]));
  const lin = oklabToLinearSrgb(
    la[0] + (lb[0] - la[0]) * f,
    la[1] + (lb[1] - la[1]) * f,
    la[2] + (lb[2] - la[2]) * f,
  );
  return [lin[0], lin[1], lin[2], alpha];
}

/**
 * Pure function. The ramp's colour at position `t` as LINEAR rgb + alpha (0..1,
 * possibly out of gamut — the caller clamps). `loop` and `space` are the ramp's
 * declared aspects (module header); `phase` shifts the read position and is only
 * meaningful for a looping ramp (period exactly 1), which is why it is applied
 * BEFORE the wrap.
 *
 * Args:
 *   stops ({offset, color}[]): the ramp, in canonical (non-decreasing) order
 *   t (number): the read position
 *   ramp ({loop?, space?, phase?}): the ramp's aspects (defaults: clamp, sRGB, 0)
 *
 * Returns:
 *   [number, number, number, number] — LINEAR rgb + alpha
 *
 * @example sampleRampLinear([{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], 2, {}) // [1, 1, 1, 1] (clamped past the end)
 * @example sampleRampLinear([{offset: 0, color: "#ffffff"}, {offset: 1, color: "#ffffff"}], 0.5, {}) // [1, 1, 1, 1]
 * @example sampleRampLinear([{offset: 0, color: "#000000"}, {offset: 0.5, color: "#000000"}], 0.75, {loop: true}) // [0, 0, 0, 1] (the synthesised wrap segment)
 */
export function sampleRampLinear(stops, t, ramp) {
  checkRampStops(stops);
  const space = ramp.space ?? DEFAULT_RAMP_SPACE;
  if (!RAMP_SPACES.includes(space))
    throw new Error(`ramps.sampleRampLinear: unknown space ${JSON.stringify(space)} (known: ${RAMP_SPACES.join(", ")})`);
  const shifted = t + (ramp.phase ?? 0);
  const last = stops.length - 1;
  const at = (i) => stopRgba(stops[i].color);
  if (!ramp.loop) {
    if (shifted <= stops[0].offset) return blendRampLinear(at(0), at(0), 0, space);
    if (shifted >= stops[last].offset) return blendRampLinear(at(last), at(last), 0, space);
    const i = rampSegmentAt(stops, shifted);
    const span = stops[i + 1].offset - stops[i].offset;
    const f = span > 0 ? (shifted - stops[i].offset) / span : 0;
    return blendRampLinear(at(i), at(i + 1), f, space);
  }
  const u = shifted - Math.floor(shifted); // fract: the circle is [0, 1)
  const i = rampSegmentAt(stops, u);
  if (i >= 0) {
    const span = stops[i + 1].offset - stops[i].offset;
    const f = span > 0 ? (u - stops[i].offset) / span : 0;
    return blendRampLinear(at(i), at(i + 1), f, space);
  }
  // THE SYNTHESISED WRAP SEGMENT: last stop → first stop, running from
  // offset_last to offset_0 + 1. `u` below the first stop is lifted by one turn
  // so it lands inside that span; a zero-length span (stops at both 0 and 1) is
  // the deliberately-authored hard seam and reads as the last stop's colour.
  const wrapStart = stops[last].offset;
  const wrapSpan = stops[0].offset + 1 - wrapStart;
  const lifted = u < stops[0].offset ? u + 1 : u;
  const f = wrapSpan > 0 ? (lifted - wrapStart) / wrapSpan : 0;
  return blendRampLinear(at(last), at(0), f, space);
}

/**
 * Pure function. The ramp's colour at position `t` as an ENCODED sRGB hex string
 * — the form a stored colour, a CSS swatch or a stop list wants. Out-of-gamut
 * blends clamp per channel (rgbToHex's own clamp), as they must to be storable.
 *
 * @param {{offset: number, color: string}[]} stops - the ramp, canonical order
 * @param {number} t - the read position
 * @param {{loop?: boolean, space?: string, phase?: number}} ramp - the ramp's aspects
 * @returns {string} "#rrggbb" or "#rrggbbaa" when the blend is not fully opaque
 *
 * @example sampleRampHex([{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], 0.5, {}) // "#808080"
 * @example sampleRampHex([{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], 5, {}) // "#ffffff" (clamped past the end)
 * @example sampleRampHex([{offset: 0, color: "#000000"}, {offset: 0.5, color: "#ffffff"}], 1.25, {loop: true}) // "#808080" (period 1: 1.25 reads as 0.25)
 * @example sampleRampHex([{offset: 0, color: "#ff0000"}, {offset: 0.5, color: "#0000ff"}], 0, {loop: true, phase: 0.5}) // "#0000ff" (phase rotates the ramp)
 */
export function sampleRampHex(stops, t, ramp) {
  const lin = sampleRampLinear(stops, t, ramp);
  const bytes = [0, 1, 2].map((k) => linearToSrgb(lin[k]) * BYTE_MAX);
  return rgbToHex(lin[3] >= 1 ? bytes : [...bytes, lin[3] * BYTE_MAX]);
}

/**
 * Pure function. Bakes a ramp into a LOOK-UP TABLE of `count` entries in LINEAR
 * light, sampled at t = i / count, plus the table's MEAN. This is the form a
 * shader consumes: a uniform array it gathers between neighbours.
 *
 * WHY t = i / count AND NOT i / (count − 1): the LUT is itself read cyclically
 * by the shader (fract() plus a wrap-in-both-directions gather), so entry
 * `count − 1` blends back into entry 0 — the table covers the circle with
 * `count` equal steps, exactly as a looping ramp's stops do. Sampling at
 * i/(count − 1) would place two entries on the same point and shrink the last
 * step to nothing, the same off-by-one evenlySpacedRampStops exists to name.
 *
 * MANDELBROT NOTE (why this reproduces the pre-ramp palette exactly): the old
 * bake took N bare colours and sampled at x = (i/count)·N, floor/mod-wrapping
 * into the colour list — i.e. it treated the colours as EVENLY SPACED at i/N and
 * blended the last back into the first in OKLab. That is precisely
 * `bakeRampLut(evenlySpacedRampStops(colors, true), count, {loop: true,
 * space: "oklab"})`, which is what makes the migration pixel-preserving rather
 * than merely close.
 *
 * The MEAN is over the CLAMPED linear entries, because that is what the shader's
 * band-limit fades toward and it must match the table it is the mean of.
 *
 * Args:
 *   stops ({offset, color}[]): the ramp, canonical order
 *   count (number): LUT entries (a positive integer)
 *   ramp ({loop?, space?}): the ramp's aspects
 *
 * Returns:
 *   {lut: number[], mean: [number, number, number]} — lut is 3·count linear values
 *
 * @example bakeRampLut([{offset: 0, color: "#ffffff"}, {offset: 0.5, color: "#ffffff"}], 4, {loop: true}).lut // [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
 * @example bakeRampLut([{offset: 0, color: "#000000"}, {offset: 0.5, color: "#000000"}], 2, {loop: true}).mean // [0, 0, 0]
 * @example bakeRampLut([{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], 2, {}).lut.length // 6
 */
export function bakeRampLut(stops, count, ramp) {
  if (!(Number.isInteger(count) && count > 0))
    throw new Error(`ramps.bakeRampLut: count must be a positive integer, got ${JSON.stringify(count)}`);
  const lut = new Array(count * 3);
  const acc = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const linear = sampleRampLinear(stops, i / count, ramp);
    for (let k = 0; k < 3; k++) {
      const v = Math.min(1, Math.max(0, linear[k]));
      lut[i * 3 + k] = v;
      acc[k] += v;
    }
  }
  return { lut, mean: [acc[0] / count, acc[1] / count, acc[2] / count] };
}

/**
 * THE NAMED CYCLIC RAMPS — the six palettes the Mandelbrot widget shipped as a
 * `select`, now ordinary ramp DATA so they are reachable from the shared preset
 * library like any other preset (the user's ruling: "then make them ramp-capable
 * ... make them ramps", not a parallel select beside the real control).
 *
 * THEIR DOMAIN KNOWLEDGE IS PRESERVED IN THE DATA, not in a widget's code:
 * every one carries `loop: true` and `space: "oklab"`, which is why those are
 * ramp aspects. Cyclicity is MANDATORY rather than stylistic — measured, a 1e-12
 * frame spans 2.4 iterations riding on an offset of 1117, so a ramp stretched
 * across the whole iteration range renders as one flat colour — and OKLab is why
 * none of them passes through mud.
 *
 * `colors` is the authored form (evenly spaced round the circle); `stops` is
 * derived from it by evenlySpacedRampStops so the i/N spacing has exactly one
 * home. `ultrafractal` is the classic blue/white/orange; `twilight` and `magma`
 * are matplotlib's perceptually-uniform ramps (twilight is natively cyclic,
 * magma mirrored into one).
 *
 * ONE HOME, TWO CONSUMERS: plugins/demo/mandelbrot.js takes its DEFAULT ramp and
 * its colour presets from here, and web/GradientPresetPicker.svelte offers the
 * same records as a preset family. A second copy for the picker would have been
 * the seventh hand-maintained mirror in this codebase.
 *
 * @example CYCLIC_RAMPS.gold.stops.length // 8
 * @example CYCLIC_RAMPS.gold.loop // true
 * @example CYCLIC_RAMPS.gold.space // "oklab"
 * @example CYCLIC_RAMPS.gold.stops[1].offset // 0.125
 */
export const CYCLIC_RAMPS = Object.fromEntries(Object.entries({
  ultrafractal: { label: "Ultra Fractal (blue / cream / amber)", colors: ["#000764", "#206bcb", "#edffff", "#ffaa00", "#000200"] },
  twilight: { label: "Twilight (dusk + wine)", colors: ["#e2d9e2", "#7ba1c2", "#5e43a5", "#2f1436", "#8d2b50", "#c6896c"] },
  magma: { label: "Magma (black → cream)", colors: ["#000004", "#2d1161", "#721f81", "#b73779", "#f1605d", "#feb078", "#fcfdbf", "#feb078", "#f1605d", "#b73779", "#721f81", "#2d1161"] },
  gold: { label: "Gold (molten metal)", colors: ["#120b02", "#5a3d0a", "#b8860b", "#ffd700", "#fff4c2", "#ffd700", "#b8860b", "#5a3d0a"] },
  ice: { label: "Ice (deep blue → white)", colors: ["#01040f", "#062b56", "#1b6ea8", "#79c6e8", "#eaf8ff", "#79c6e8", "#1b6ea8", "#062b56"] },
  ember: { label: "Ember (charcoal → flame)", colors: ["#050101", "#2b0a06", "#7c1d0c", "#d9541b", "#ffc46b", "#fff3d0", "#ffc46b", "#d9541b", "#7c1d0c", "#2b0a06"] },
}).map(([id, r]) => [id, {
  id,
  label: r.label,
  colors: r.colors,
  stops: evenlySpacedRampStops(r.colors, true),
  loop: true,
  space: "oklab",
}]));

/**
 * Pure function. A FRESH copy of a named cyclic ramp's stops — never the shared
 * record, so neither a document nor a preview can alias author-time data (the
 * GradientPresetPicker freshStops discipline, one level down).
 *
 * @param {string} id - a CYCLIC_RAMPS key
 * @returns {{offset: number, color: string}[]}
 *
 * @example cyclicRampStops("gold").length // 8
 * @example cyclicRampStops("gold")[0] // {offset: 0, color: "#120b02"}
 */
export function cyclicRampStops(id) {
  const ramp = CYCLIC_RAMPS[id];
  if (!ramp) throw new Error(`ramps.cyclicRampStops: unknown cyclic ramp ${JSON.stringify(id)} (known: ${Object.keys(CYCLIC_RAMPS).join(", ")})`);
  return ramp.stops.map((s) => ({ offset: s.offset, color: s.color }));
}

// ── THE LEGACY MANDELBROT PALETTE → RAMP CONVERSION ──────────────────────────
//
// Two properties became one. The old state was a `select` naming one of the six
// CYCLIC_RAMPS plus a comma-separated `text` OVERRIDE that won when it listed at
// least two colours; the new state is a ramp stop LIST plus its `loop`/`space`
// aspects. The conversion below is the pure half; the document walk that applies
// it lives in core/ramp_migration.js (see that file's header for why it is not in
// core/document.js beside its seven siblings).

/** The legacy `palette` select's fallback — the ramp an unknown or absent name
 *  resolved to (the old paletteStopsFor: `PALETTES[s.palette] ?? PALETTES.gold`).
 *  Named so the migration and the plugin default cannot drift apart. */
export const DEFAULT_CYCLIC_RAMP = "gold";

/**
 * Pure function. The COLOURS a legacy `paletteStops` text override named: its
 * comma-separated entries, trimmed, empties dropped. Returns [] when the
 * override does not name at least two colours — the old rule, verbatim ("one
 * stop cannot cycle — the named palette wins").
 *
 * @param {string} text - the stored override
 * @returns {string[]} two or more colours, or []
 *
 * @example legacyOverrideColors("#000000, #ffffff") // ["#000000", "#ffffff"]
 * @example legacyOverrideColors("") // []
 * @example legacyOverrideColors("#ff0000") // [] (one colour cannot cycle)
 * @example legacyOverrideColors("  #001028 ,#ffd27f , ") // ["#001028", "#ffd27f"]
 */
export function legacyOverrideColors(text) {
  const parts = String(text ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  return parts.length >= 2 ? parts : [];
}

/**
 * Pure function. The RAMP STOPS a legacy {palette, paletteStops} pair resolved
 * to: the override's colours when it named two or more, else the named cyclic
 * ramp's, evenly spaced round the circle (i/N — the loop spacing, which is what
 * makes the conversion reproduce the old bake exactly rather than approximately).
 *
 * @param {{palette?: string, paletteStops?: string}} legacy - the old item state
 * @returns {{offset: number, color: string}[]}
 *
 * @example rampStopsFromLegacyPalette({palette: "gold"}).length // 8
 * @example rampStopsFromLegacyPalette({palette: "gold", paletteStops: "#000000, #ffffff"}) // [{offset: 0, color: "#000000"}, {offset: 0.5, color: "#ffffff"}]
 * @example rampStopsFromLegacyPalette({palette: "nope"}).length // 8 (unknown name → the documented gold fallback)
 * @example rampStopsFromLegacyPalette({}).length // 8 (no palette at all → the same fallback)
 */
export function rampStopsFromLegacyPalette(legacy) {
  const override = legacyOverrideColors(legacy.paletteStops);
  if (override.length) return evenlySpacedRampStops(override, true);
  return cyclicRampStops(legacy.palette in CYCLIC_RAMPS ? legacy.palette : DEFAULT_CYCLIC_RAMP);
}
