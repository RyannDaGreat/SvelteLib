/**
 * THE BLEND-MODE SKIA MAPPING — how each `blendMode` id (core/properties.js
 * BLEND_MODES: Photoshop's layer-blend set) becomes a real Skia composite in
 * render_gpu/skia/paint_skia.js handleEffectSubtree.
 *
 * The set splits in TWO, and this module is the ONE place that says which is
 * which (the import-time guard at the bottom proves the split is exhaustive and
 * disjoint, so a mode added to BLEND_MODES and forgotten here fails at load
 * instead of silently painting Normal):
 *
 *   NATIVE — Skia's own `SkBlendMode` covers 17 of the 26 (CanvasKit's
 *     BlendMode enum, empirically enumerated in this build: Multiply, Screen,
 *     Overlay, Darken, Lighten, ColorDodge, ColorBurn, HardLight, SoftLight,
 *     Difference, Exclusion, Plus, Hue, Saturation, Color, Luminosity +
 *     SrcOver). These are ONE `paint.setBlendMode()` call — zero shader cost,
 *     and they are the modes PDF `/BM` and CSS `mix-blend-mode` also name, so
 *     they are the ones that can export as vector blend state.
 *
 *   SkSL — the other 9 are Photoshop modes with NO Skia equivalent (Linear Burn,
 *     Darker Color, Lighter Color, Vivid Light, Linear Light, Pin Light, Hard
 *     Mix, Subtract, Divide). Each is a short per-pixel function, so each ships
 *     as a RUNTIME BLENDER: `CanvasKit.RuntimeEffect.MakeForBlender` +
 *     `paint.setBlender()`. Skia hands the shader `src` and `dst` itself, so
 *     this needs NO backdrop-texture plumbing at all — the reason shipping nine
 *     extra modes is cheap rather than a compositor rewrite.
 *
 * ── THE COMPOSITE WRAPPER (why every custom mode shares one body) ─────────────
 * An SkSL blender receives PREMULTIPLIED src/dst (probe-verified: drawing
 * rgb(0.8,0.4,0.2) at alpha 0.5 and returning `src.rgb` reads back
 * (102,51,26) ≈ 0.5×(204,102,51), not (204,102,51)). Photoshop / PDF / W3C
 * blend functions are all defined on UNPREMULTIPLIED channels under the union
 * composite
 *
 *     co = (1-αb)·cs + (1-αs)·cb + αs·αb·B(Cb, Cs)
 *     αo = αs + αb - αs·αb
 *
 * (lowercase = premultiplied, uppercase = unpremultiplied, B = the mode's own
 * per-mode function). `blendSkSL` emits exactly that around a mode's B, so a
 * mode contributes ONLY its B and can never get the alpha algebra wrong.
 *
 * THAT WRAPPER IS PROVEN, NOT ASSERTED: render_gpu/tests/blend_modes_test.js
 * feeds it hand-written B functions for eleven modes Skia ALSO implements
 * natively (Multiply, Screen, Darken, Lighten, Difference, Exclusion, Overlay,
 * HardLight, ColorBurn, ColorDodge, SoftLight) and requires the SkSL result to
 * match `setBlendMode` within 1/255 across opaque and partial-alpha cases. The
 * nine shipped formulas rest on that verified substrate.
 *
 * ── SOFT LIGHT: WHICH DEFINITION ──────────────────────────────────────────────
 * Soft Light is NATIVE here, i.e. Skia's `SoftLight`, which is the PDF 32000-1 /
 * W3C compositing definition (the piecewise form with the cubic below 0.25 and
 * √Cb above). Photoshop's own curve is a DIFFERENT function (the widely-quoted
 * `2·Cb·Cs + Cb²·(1-2·Cs)` / `√Cb·(2·Cs-1) + 2·Cb·(1-Cs)` pair). The W3C one is
 * chosen deliberately: it is what PDF `/BM /SoftLight` and every browser's
 * `mix-blend-mode: soft-light` compute, so "Soft Light" means the same thing in
 * the editor, in an exported PDF and in an exported SVG. Reimplementing
 * Photoshop's variant would buy a closer Photoshop match at the cost of the
 * editor and the exporters disagreeing — the exact class of bug export parity
 * exists to prevent.
 *
 * DOM-free at import (string SkSL + pure builders), like frosted_shader.js /
 * glass_shader.js. The RuntimeEffect/Blender cache mirrors materials.js
 * materialEffect: compile once per mode per CanvasKit instance.
 */

import { BLEND_MODES } from "../../core/properties.js";

/**
 * NATIVE modes: blend id → the CanvasKit `BlendMode` enum KEY that implements it
 * exactly. Stored as key STRINGS (not enum values) so this module stays DOM-free
 * and CanvasKit-free at import; paint_skia resolves `CanvasKit.BlendMode[key]`.
 *
 * "normal" is SrcOver (ordinary painting-over) and "add" is Plus — Skia's
 * clamped additive mode, which IS Photoshop's Linear Dodge (Add). Both spellings
 * predate Photoshop-parity and are kept verbatim for document back-compat.
 */
export const SKIA_NATIVE_BLEND_MODES = {
  normal: "SrcOver",
  darken: "Darken", multiply: "Multiply", colorBurn: "ColorBurn",
  lighten: "Lighten", screen: "Screen", colorDodge: "ColorDodge", add: "Plus",
  overlay: "Overlay", softLight: "SoftLight", hardLight: "HardLight",
  difference: "Difference", exclusion: "Exclusion",
  hue: "Hue", saturation: "Saturation", color: "Color", luminosity: "Luminosity",
};

// Guard against a divide-by-zero producing inf/NaN (a NaN channel poisons the
// whole composite and clamp() cannot rescue it). Smaller than 1/255, so it never
// changes an 8-bit result; only the degenerate exactly-zero denominators hit it.
const DIVIDE_EPSILON = 1e-4;

/**
 * SkSL modes: blend id → the BODY of `half3 mixColor(half3 Cb, half3 Cs)`, the
 * mode's blend function B on UNPREMULTIPLIED backdrop (Cb) and source (Cs)
 * channels, each already clamped to 0..1 by the wrapper. The wrapper also clamps
 * the RESULT, which is what lets the arithmetic modes (Linear Burn, Subtract,
 * Linear Light) be written as the bare expression Photoshop documents.
 *
 * Formulas, per channel unless noted:
 *   linearBurn    Cb + Cs - 1                    (add the two, subtract white)
 *   subtract      Cb - Cs
 *   divide        Cb / Cs, and 1 (white) where Cs is 0 — Photoshop's
 *                 divide-by-zero result, so it is spelled out rather than left
 *                 to the epsilon
 *   linearLight   Cb + 2·Cs - 1                  Linear Burn below mid-source and
 *                 Linear Dodge above it; BOTH halves reduce to this one
 *                 expression, which is why there is no branch
 *   pinLight      Cs ≤ ½ ? min(Cb, 2·Cs) : max(Cb, 2·Cs-1)   (Darken / Lighten
 *                 against the stretched source; continuous at ½, both give Cb)
 *   vividLight    Cs ≤ ½ ? ColorBurn(Cb, 2·Cs) : ColorDodge(Cb, 2·Cs-1)
 *   hardMix       Cb + Cs ≥ 1 ? 1 : 0            (Vivid Light thresholded — the
 *                 posterizing mode; each channel goes fully on or fully off)
 *
 * The last two are NON-SEPARABLE — they do not work per channel:
 *   darkerColor   the WHOLE colour with the smaller channel total
 *   lighterColor  the WHOLE colour with the larger channel total
 * "Channel total" is Adobe's own documented wording ("compares the total of all
 * channel values for the blend and base color"), i.e. an EQUAL-weight R+G+B sum
 * — NOT the 0.30/0.59/0.11 luminance that Skia's Hue/Saturation/Color/Luminosity
 * use. That difference is why these are their own modes and not just Darken /
 * Lighten: Darken picks per channel and can invent a colour present in neither
 * layer, these two always return one of the two input colours whole. A tie keeps
 * the backdrop.
 */
export const BLEND_MIX_BODIES = {
  linearBurn: `return Cb + Cs - 1.0;`,
  subtract: `return Cb - Cs;`,
  divide: `
  // mix(white, Cb/Cs, Cs>0): step() picks white exactly where the source is 0.
  half3 q = Cb / max(Cs, half3(${DIVIDE_EPSILON}));
  return mix(half3(1.0), q, step(half3(${DIVIDE_EPSILON}), Cs));`,
  linearLight: `return Cb + 2.0 * Cs - 1.0;`,
  pinLight: `
  half3 lo = min(Cb, 2.0 * Cs);          // Darken against the doubled source
  half3 hi = max(Cb, 2.0 * Cs - 1.0);    // Lighten against the doubled-and-shifted source
  return mix(lo, hi, step(half3(0.5), Cs));`,
  vividLight: `
  half3 s2 = 2.0 * Cs;
  // ColorBurn(Cb, s2): the (1-Cb) numerator makes a white backdrop stay white.
  half3 burn = 1.0 - min(half3(1.0), (1.0 - Cb) / max(s2, half3(${DIVIDE_EPSILON})));
  // ColorDodge(Cb, s2-1): its 1-(s2-1) denominator is 2-s2.
  half3 dodge = min(half3(1.0), Cb / max(2.0 - s2, half3(${DIVIDE_EPSILON})));
  return mix(burn, dodge, step(half3(1.0), s2));`,
  hardMix: `return step(half3(1.0), Cb + Cs);`,
  darkerColor: `
  half tb = Cb.r + Cb.g + Cb.b, ts = Cs.r + Cs.g + Cs.b;
  return ts < tb ? Cs : Cb;`,
  lighterColor: `
  half tb = Cb.r + Cb.g + Cb.b, ts = Cs.r + Cs.g + Cs.b;
  return ts > tb ? Cs : Cb;`,
};

/**
 * Pure function. Wraps a `mixColor` BODY (a blend function B on unpremultiplied
 * channels) in the W3C/PDF union composite, yielding complete SkSL blender
 * source for `CanvasKit.RuntimeEffect.MakeForBlender`.
 *
 * The un/re-premultiply round trip is what makes a mode's body readable as the
 * textbook formula; the `sa > 0` / `da > 0` guards keep a fully transparent
 * side from dividing by zero (an empty side contributes nothing anyway, since
 * its premultiplied rgb is 0 and its αs·αb term vanishes).
 *
 * @param {string} mixBody - the body of `half3 mixColor(half3 Cb, half3 Cs)`;
 *   must `return` a half3. Cb/Cs arrive clamped to 0..1.
 * @returns {string} SkSL source declaring `half4 main(half4 src, half4 dst)`
 *
 * @example blendSkSL("return Cb * Cs;").includes("half4 main(half4 src, half4 dst)") // true
 * @example blendSkSL("return min(Cb, Cs);").includes("half3 mixColor") // true
 */
export function blendSkSL(mixBody) {
  return `
half3 mixColor(half3 Cb, half3 Cs) {
${mixBody}
}

half4 main(half4 src, half4 dst) {
  half sa = src.a, da = dst.a;
  half3 Cs = sa > 0.0 ? src.rgb / sa : half3(0.0);
  half3 Cb = da > 0.0 ? dst.rgb / da : half3(0.0);
  half3 B = clamp(mixColor(clamp(Cb, 0.0, 1.0), clamp(Cs, 0.0, 1.0)), 0.0, 1.0);
  return half4((1.0 - da) * src.rgb + (1.0 - sa) * dst.rgb + sa * da * B, sa + da - sa * da);
}`;
}

/**
 * Pure function. Is `mode` composited by a custom SkSL blender rather than one
 * of Skia's own blend modes? The two halves are exhaustive and disjoint (the
 * import guard below proves it), so this is also "NOT native".
 *
 * @param {string} mode - a core/properties.js BLEND_MODES id
 * @returns {boolean}
 *
 * @example blendNeedsSkSL("vividLight") // true
 * @example blendNeedsSkSL("multiply") // false (Skia has it natively)
 */
export function blendNeedsSkSL(mode) {
  return mode in BLEND_MIX_BODIES;
}

// Compiled Blender cache, keyed by blend id + guarded by the CanvasKit instance
// it was compiled against — materials.js materialEffect's `_effects` pattern.
// A blender is cached, not just its RuntimeEffect: these blenders take NO
// uniforms, so one instance per mode per CanvasKit is correct and reusable for
// the process lifetime (the same reason materialEffect keeps its effects).
const _blenders = new Map(); // blend id → { blender, ck }

/**
 * Query→build (compiles once per mode per CanvasKit instance; memoized).
 * Returns the CanvasKit Blender implementing `mode`, for `paint.setBlender()`.
 * Throws LOUDLY on a native/unknown mode or an SkSL compile error — never
 * returns a stand-in, because a silently-Normal blend is invisible in review.
 *
 * The returned blender is CACHED and must NOT be deleted by the caller.
 *
 * @param CanvasKit - the initialized CanvasKit module
 * @param {string} mode - a BLEND_MODES id for which blendNeedsSkSL(mode) is true
 */
export function blenderFor(CanvasKit, mode) {
  const body = BLEND_MIX_BODIES[mode];
  if (!body)
    throw new Error(`blend_modes.blenderFor: "${mode}" has no SkSL body — ${mode in SKIA_NATIVE_BLEND_MODES ? `it is NATIVE (CanvasKit.BlendMode.${SKIA_NATIVE_BLEND_MODES[mode]}), use setBlendMode` : `it is not a known blend mode (known: ${BLEND_MODES.join(", ")})`}`);
  const cached = _blenders.get(mode);
  if (cached && cached.ck === CanvasKit) return cached.blender;
  let err = null;
  const effect = CanvasKit.RuntimeEffect.MakeForBlender(blendSkSL(body), (e) => { err = e; });
  if (!effect) throw new Error(`blend_modes: blend mode "${mode}" SkSL failed to compile:\n${err}`);
  const blender = effect.makeBlender([]);
  if (!blender) throw new Error(`blend_modes: blend mode "${mode}" compiled but makeBlender returned null`);
  _blenders.set(mode, { blender, ck: CanvasKit });
  return blender;
}

// LOUD IMPORT-TIME GUARD (the render_settings.js ANTIALIAS_MODES precedent): the
// native map and the SkSL bodies must PARTITION core/properties.js BLEND_MODES.
// A mode offered in the Inspector with no entry in either table would fall
// through paint_skia's dispatch — the "silently paints Normal" fake option the
// house rules forbid — and an entry here for a mode nobody can select is dead
// shader source. Both fail at load instead.
for (const mode of BLEND_MODES) {
  const native = mode in SKIA_NATIVE_BLEND_MODES, sksl = mode in BLEND_MIX_BODIES;
  if (!native && !sksl)
    throw new Error(`blend_modes: BLEND_MODES declares "${mode}" but nothing implements it — map it in SKIA_NATIVE_BLEND_MODES (a CanvasKit.BlendMode key) or give it a BLEND_MIX_BODIES SkSL body, or the option would silently composite as Normal.`);
  if (native && sksl)
    throw new Error(`blend_modes: "${mode}" is in BOTH SKIA_NATIVE_BLEND_MODES and BLEND_MIX_BODIES — pick one (native is free, SkSL is a shader).`);
}
for (const mode of [...Object.keys(SKIA_NATIVE_BLEND_MODES), ...Object.keys(BLEND_MIX_BODIES)])
  if (!BLEND_MODES.includes(mode))
    throw new Error(`blend_modes: "${mode}" is implemented here but is not in core/properties.js BLEND_MODES — nobody can select it; remove it or offer it.`);
