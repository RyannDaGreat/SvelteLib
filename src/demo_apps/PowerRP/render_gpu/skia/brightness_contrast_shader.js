/**
 * The BRIGHTNESS / CONTRAST SkSL material — a TONE ADJUSTMENT region filter on the
 * reusable MATERIAL FRAMEWORK (render_gpu/skia/materials.js). A rounded-rect region
 * that re-tones the composite-so-far beneath it: two knobs (brightness, contrast),
 * three honest tone-math MODES, and one orthogonal hue-lock switch.
 *
 * It is REAL SkSL (compiles through CanvasKit.RuntimeEffect.Make; the framework
 * compiles + caches it once per CanvasKit instance, exactly like frosted_shader.js /
 * crt_shader.js / comic_shader.js). Its two children are the framework's STANDARD
 * backdrop contract — a BLURRED and a SHARP device-space image shader of everything
 * below in z-order, in THIS order:
 *   blurredBackdrop — DECLARED ONLY, never evaluated (see usesBlurredBackdrop below)
 *   sharpBackdrop   — the tone this filter re-grades (the whole effect)
 *
 * ── WHY THREE MODES AND NOT ONE COMPROMISE ────────────────────────────────────
 * "Brightness/contrast" is where naive implementations look bad, and the three
 * plausible operators disagree in ways no single blend can reconcile, so the mode is
 * an honest choice rather than a hidden opinion. All three are IDENTITY at
 * brightness 0 / contrast 1.
 *
 * (0) SMOOTH — THE DEFAULT, and the one built for THIS signal. The composite beneath
 *     is DISPLAY-REFERRED: an 8-bit sRGB-encoded frame with NO headroom above white
 *     and no footroom below black. The correct contrast operator for such a signal is
 *     one that FIXES both endpoints, so no detail can be pushed off either end. The
 *     one used here is the logistic gain (Perlin/Hoffert's `gain`, in exact power
 *     form):
 *
 *           c
 *          x
 *     ─────────────
 *      c          c
 *     x  + (1 - x)
 *
 *     Its properties are what make it the right pick, not merely a nice curve:
 *       - IDENTITY at c = 1, EXACTLY (the denominator is x + (1-x) = 1).
 *       - Its SLOPE AT THE PIVOT IS EXACTLY c — measured 1.000000000 / 1.500000000 /
 *         2.000000000 / 3.000000000 for those c. So `contrast` keeps PRECISELY the
 *         meaning it has in the naive slider (and in a CSS `contrast()` filter) for
 *         tones near mid-grey; it only differs where the naive one would clip.
 *       - It fixes 0, ½ and 1, and maps [0,1] onto [0,1], so it CANNOT clip. At
 *         c = 3 the naive ramp crushes 0.25 → 0.0000 and blows 0.75 → 1.0000 (both
 *         details gone); this curve gives 0.0357 and 0.9643 — punchier, all detail
 *         still there.
 *     Brightness in this mode is a GAMMA (midtone lift), which likewise fixes 0 and 1:
 *
 *      ⎛ -b⎞
 *      ⎝2  ⎠
 *     x
 *
 *     b = 0 is identity, b = +1 halves the exponent (0.25 → 0.5000), b = -1 doubles
 *     it (0.25 → 0.0625). Neither knob can crush or blow anything.
 *
 * (1) LINEAR — the PHOTOGRAPHIC operator, for when the intent is a real light change.
 *     Decodes to linear light, applies brightness as an EXPOSURE in STOPS (L·2^b) and
 *     contrast as a power about photographic mid-grey:
 *
 *          c
 *       ⎛L⎞
 *     P⋅⎜─⎟          P = 0.18
 *       ⎝P⎠
 *
 *     then re-encodes. This is the ASC-CDL / compositor-style pivoted contrast. It
 *     CAN clip, and that is not a defect being hidden: raising exposure past white
 *     IS clipping, and a scene-referred operator on a display-referred signal has no
 *     headroom to put the overflow in. Measured: c = 2 sends linear 1.0 to 5.556. Use
 *     it when "one stop brighter" is the intent; use SMOOTH when "more punch" is.
 *
 * (2) SRGB — the naive per-channel ramp, `(x + b - ½)·c + ½`, clamped. Kept ONLY so
 *     that (a) a figure can be matched to what another tool produced, and (b) the
 *     clipping the default avoids is visible side by side rather than asserted in a
 *     comment. Labelled as clipping wherever it is surfaced.
 *
 * ── THE PIVOT ─────────────────────────────────────────────────────────────────
 * Modes 0 and 2 pivot at ENCODED 0.5, mode 1 at LINEAR 0.18. These are the SAME
 * perceptual place, which is why neither needed a knob: encoded 0.5 decodes to linear
 * 0.2140, and linear 0.18 encodes to 0.4614. A LINEAR 0.5 pivot would have been the
 * real error (it encodes to 0.735 — three quarters of the way up the ramp).
 *
 * ── HUE LOCK (orthogonal to the mode) ─────────────────────────────────────────
 * Per-channel tone mapping moves the channel RATIOS, so it shifts hue and pumps
 * saturation as contrast rises (usually wanted — it reads as "punchy"). With the hue
 * lock on, the curve is applied to Rec.709 luma ALONE and the triple is re-scaled by
 * the ratio, which preserves the ratios (hence hue and saturation) exactly and
 * changes only tone. The scaling happens in each mode's OWN working space (encoded
 * for 0 and 2, linear light for 1), so the lock never silently changes which space
 * the mode grades in. A ratio can push a channel out of gamut, so the result is
 * clamped: the lock trades gamut for hue fidelity, by design.
 *
 * ── ALPHA: THIS MATERIAL DELIBERATELY DEPARTS FROM ITS SIBLINGS ───────────────
 * frosted / crt / comic / glass all return `alpha = coverage`: they SYNTHESIZE new
 * opaque content (a frost, a tube, a print), so replacing the pixel is correct. An
 * ADJUSTMENT is different by definition — it adjusts what is THERE, and where nothing
 * is there it must do nothing. So this shader UN-PREMULTIPLIES the sample, tones the
 * straight colour, and re-premultiplies by the SAMPLED alpha. Over an opaque
 * composite (every camera frame: web/cameraFrame.js draws the background as a real
 * rect) that is bit-identical to the sibling convention. Over a TRANSPARENT area it
 * is the difference between "invisible" and an opaque toned rectangle — the same
 * failure mode pdf_backend.js regionOverBackground documents, where a sampler over an
 * un-drawn page came out BLACK in every export.
 *
 * DOM-free at import (only string SkSL + a pure packer), like frosted_shader.js /
 * comic_shader.js. `parseColor` is not needed: this material exposes no colour knob.
 */

// ── named constants (WHY each exists — no magic numbers) ──────────────────────
export const BRIGHTNESS_CONTRAST_SKSL = `
const float AA_PX = 1.0;      // coverage antialias half-width (~1 device px), matching frosted/comic
const float3 REC709 = float3(0.2126, 0.7152, 0.0722);  // Rec.709 luma weights (the hue-lock axis)
const float PIVOT_ENC = 0.5;  // contrast pivot for the ENCODED modes. Encoded 0.5 = linear 0.2140, i.e. essentially photographic mid-grey — which is why this needs no knob
const float PIVOT_LIN = 0.18; // contrast pivot for the LINEAR mode: 18% mid-grey (encodes to 0.4614)
const float MIN_CONTRAST = 1e-3;  // pow(x, 0) is undefined at x = 0; a contrast this low is already a flat grey, so flooring here costs nothing visible
const float LUMA_FLOOR = 1e-6;    // below this a pixel carries no hue to preserve, so the hue lock returns the toned luma as neutral grey instead of dividing by ~0
// The sRGB transfer function (IEC 61966-2-1) — the SAME constants mandelbrot_shader.js
// uses. Exact piecewise, not a pure-power approximation: the decode/encode round trip
// is then byte-exact over all 256 8-bit codes (measured: worst delta 0), which is what
// lets the LINEAR mode be a true identity at neutral settings.
const float SRGB_ENC_CUTOFF = 0.04045;
const float SRGB_LIN_CUTOFF = 0.0031308;
const float SRGB_SLOPE  = 12.92;
const float SRGB_SCALE  = 1.055;
const float SRGB_OFFSET = 0.055;
const float SRGB_EXP    = 2.4;

uniform shader blurredBackdrop;  // child 0: DECLARED ONLY to satisfy the framework's fixed {blurred, sharp} pair — a tone adjustment re-grades the SHARP tone and never evaluates this (see BRIGHTNESS_CONTRAST_MATERIAL.usesBlurredBackdrop)
uniform shader sharpBackdrop;    // child 1: the composite-so-far (device space, sRGB-encoded, PREMULTIPLIED) — the tone this filter re-grades
uniform float2 uCenter;          // region center (device px)
uniform float2 uHalfSize;        // region half-extents (device px)
uniform float uCornerRadius;     // rounded-rect corner radius (device px)
uniform float uAngle;            // region rotation (radians): rotate the SDF frame so a rotated region stays correct
// ── user-tweakable knobs (self.* custom props) ───────────────────────────────
uniform float uMode;             // 0 = smooth (display-referred, cannot clip), 1 = linear (exposure in stops + pivoted power), 2 = sRGB direct (naive, clips)
uniform float uBrightness;       // 0 = neutral. Mode 0: gamma exponent 2^-b. Mode 1: exposure in STOPS. Mode 2: additive offset
uniform float uContrast;         // 1 = neutral. Slope at the pivot in every mode
uniform float uPreserveHue;      // 0/1 hue lock: tone the Rec.709 luma alone and re-scale the triple by the ratio

// Pure. Signed distance to a rounded rect (local, centered). <0 inside.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Pure. Gamma-encoded sRGB -> linear light (IEC 61966-2-1, exact piecewise).
float3 srgbToLinear(float3 c) {
  float3 lo = c / SRGB_SLOPE;
  float3 hi = pow((c + SRGB_OFFSET) / SRGB_SCALE, float3(SRGB_EXP));
  return mix(hi, lo, step(c, float3(SRGB_ENC_CUTOFF)));
}

// Pure. Linear light -> gamma-encoded sRGB (the exact inverse of srgbToLinear).
float3 linearToSrgb(float3 c) {
  float3 lo = c * SRGB_SLOPE;
  float3 hi = SRGB_SCALE * pow(c, float3(1.0 / SRGB_EXP)) - SRGB_OFFSET;
  return mix(hi, lo, step(c, float3(SRGB_LIN_CUTOFF)));
}

// Pure. MODE 0 curve, in the ENCODED domain: gamma brightness (fixes 0 and 1) then
// the logistic-gain contrast (fixes 0, 1/2, 1; slope c at the pivot). Neither step can
// leave [0,1], so nothing clips. The clamp before the gain matters: a float32 gamma
// can land a hair above 1, and pow(negative, c) on the (1-y) term would be NaN.
float3 smoothCurve(float3 x, float b, float c) {
  float3 y = clamp(pow(clamp(x, 0.0, 1.0), float3(exp2(-b))), 0.0, 1.0);
  float3 u = pow(y, float3(c));
  float3 v = pow(1.0 - y, float3(c));
  return u / (u + v);
}

// Pure. MODE 1 curve, in LINEAR light: exposure in stops, then a power about
// photographic mid-grey. Deliberately unclamped here — main() clamps once on the way
// back to the display, so the overflow is visible as clipping rather than as a
// silently different curve shape.
float3 linearCurve(float3 lin, float b, float c) {
  float3 exposed = max(lin, 0.0) * exp2(b);
  return PIVOT_LIN * pow(exposed / PIVOT_LIN, float3(c));
}

// Pure. MODE 2 curve, in the ENCODED domain: the naive per-channel ramp, clamped.
// This is the operator the default mode exists to replace; it is here so the two can
// be compared, not because it is good.
float3 srgbCurve(float3 x, float b, float c) {
  return clamp((x + b - PIVOT_ENC) * c + PIVOT_ENC, 0.0, 1.0);
}

// Pure. What the curve should be FED: the triple itself (per-channel grading), or its
// Rec.709 luma broadcast to all three channels (hue lock). One curve evaluation
// either way — the lock changes the curve's input, not how many times it runs.
float3 curveInput(float3 v, float hueLock) {
  return hueLock > 0.5 ? float3(dot(v, REC709)) : v;
}

// Pure. The curve's OUTPUT reassembled: the per-channel result as-is, or — under the
// hue lock — v re-scaled so its luma becomes the toned luma, which preserves the
// channel ratios (hue + saturation) exactly. A pixel at (or below) LUMA_FLOOR has no
// ratios to preserve, so it becomes the toned luma as neutral grey.
float3 curveOutput(float3 v, float3 toned, float hueLock) {
  if (hueLock <= 0.5) { return toned; }
  float y = dot(v, REC709);
  return y > LUMA_FLOOR ? v * (toned.x / y) : float3(toned.x);
}

half4 main(float2 p) {
  // Rotate the device pixel into the region's LOCAL centered frame (uAngle == 0 is
  // the axis-aligned common case), then rounded-rect SDF -> antialiased coverage.
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y);
  float r = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y)); // capsule-safe clamp
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, sdRoundRect(pl, uHalfSize, r));
  if (cov <= 0.0) { return half4(0.0); }        // outside the region: contribute nothing

  // UN-PREMULTIPLY to a straight colour. Nothing beneath => nothing to adjust (see
  // the ALPHA note in this file's header for why an adjustment must not go opaque).
  half4 s = sharpBackdrop.eval(p);
  float a = float(s.a);
  if (a <= 0.0) { return half4(0.0); }
  float3 rgb = clamp(float3(s.rgb) / a, 0.0, 1.0);

  float c = max(uContrast, MIN_CONTRAST);
  float3 outc;
  if (uMode < 0.5) {
    // (0) SMOOTH — display-referred; the ENCODED domain IS its working space.
    outc = curveOutput(rgb, smoothCurve(curveInput(rgb, uPreserveHue), uBrightness, c), uPreserveHue);
  } else if (uMode < 1.5) {
    // (1) LINEAR — scene-referred; LINEAR LIGHT is its working space, so the hue
    // lock's ratio scaling happens there too, not in the encoded domain.
    float3 lin = srgbToLinear(rgb);
    float3 adj = curveOutput(lin, linearCurve(curveInput(lin, uPreserveHue), uBrightness, c), uPreserveHue);
    outc = linearToSrgb(clamp(adj, 0.0, 1.0));
  } else {
    // (2) SRGB — the naive ramp, in the ENCODED domain.
    outc = curveOutput(rgb, srgbCurve(curveInput(rgb, uPreserveHue), uBrightness, c), uPreserveHue);
  }

  // Re-premultiply by the SAMPLED alpha times coverage: the adjustment inherits the
  // opacity of whatever it adjusted.
  float o = a * cov;
  return half4(half3(clamp(outc, 0.0, 1.0)) * half(o), half(o));
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
// geometry 6 (uCenter2 uHalfSize2 uCornerRadius1 uAngle1) + 4 knobs = 10.
const BRIGHTNESS_CONTRAST_UNIFORM_FLOATS = 10;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens the whole
 * region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packBrightnessContrastUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/**
 * Pure function. Packs the Brightness/Contrast material's uniforms into the flat
 * Float32Array CanvasKit expects (SkSL declaration order, tight-packed: float2 = 2
 * slots). `u` is the material framework's normalized input: DEVICE-px region geometry
 * {cx, cy, halfW, halfH, cornerRadius, angle} (the framework resolves world -> device
 * before calling) + this material's own already-evaluated knobs (the op's `params`,
 * spread in by name). `mode` arrives as the shader's NUMERIC code (the plugin maps its
 * `select` string through MODE_CODE, the metaballs/comic TYPE_CODE pattern) and
 * `preserveHue` as 0/1. The two child shaders are passed separately to
 * makeShaderWithChildren.
 *
 * @param {object} u - {cx, cy, halfW, halfH, cornerRadius, angle, mode, brightness,
 *   contrast, preserveHue} (device geometry + the material knobs; `scale` is present
 *   but unused — a tone curve has no world-unit knob)
 * @returns {Float32Array} length 10, in shader-uniform order
 *
 * @example
 * packBrightnessContrastUniforms({cx:200,cy:150,halfW:210,halfH:140,cornerRadius:0,
 *   angle:0,mode:0,brightness:0,contrast:1,preserveHue:0}).length // 10
 * @example
 * packBrightnessContrastUniforms({cx:0,cy:0,halfW:80,halfH:60,cornerRadius:12,
 *   angle:0,mode:1,brightness:-1.2,contrast:1,preserveHue:0})[7] // -1.2  (brightness)
 */
export function packBrightnessContrastUniforms(u) {
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("mode", u.mode),
    num("brightness", u.brightness),
    num("contrast", u.contrast),
    num("preserveHue", u.preserveHue)
  ]);
  if (out.length !== BRIGHTNESS_CONTRAST_UNIFORM_FLOATS)
    throw new Error(`packBrightnessContrastUniforms: packed ${out.length} floats, expected ${BRIGHTNESS_CONTRAST_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE BRIGHTNESS / CONTRAST MATERIAL DESCRIPTOR — the registry entry
 * (render_gpu/skia/materials.js). A BACKDROP material: its SkSL declares the standard
 * {blurredBackdrop, sharpBackdrop} children, so the `materialBackdrop` op +
 * handleMaterialBackdrop re-render the content beneath to feed them. `id` matches the
 * plugin's `material` op field; `pack` maps the framework's normalized `u` to the
 * uniform Float32Array.
 *
 * `usesBlurredBackdrop: false` — the same DECLARED PERFORMANCE CAPABILITY comic
 * halftone introduced, and for the same reason: a tone curve is a POINT operation on
 * the sharp tone, so the SkSL above only DECLARES the blurred child (to satisfy the
 * framework's fixed pair) and never evaluates it. Building it would mean a full
 * Gaussian blur of the composite-so-far every frame for a texture nothing reads — it
 * was measured at two thirds of the comic widget's whole per-frame cost. The flag
 * defaults to the SAFE value, so only this explicit `false` opts out, and the
 * import-time cross-check below makes lying about it impossible.
 */
export const BRIGHTNESS_CONTRAST_MATERIAL = {
  id: "brightness_contrast",
  sksl: BRIGHTNESS_CONTRAST_SKSL,
  pack: packBrightnessContrastUniforms,
  uniformFloats: BRIGHTNESS_CONTRAST_UNIFORM_FLOATS,
  backdrop: true,
  usesBlurredBackdrop: false,
  // NO `maxSampleReach` YET — DELIBERATELY, AND NOT FOR LACK OF THE ANSWER.
  //
  // This material's true outward reach IS ZERO: `main` evaluates sharpBackdrop.eval(p)
  // at the fragment's own device coordinate and nowhere else (a tone curve is a POINT
  // operation), and the guard below holds the SkSL to that. `maxSampleReach: () => 0`
  // is therefore the honest declaration, and it shrinks the backdrop the framework
  // builds from the whole surface to the panel — measured 230,400 offscreen px down to
  // 40,000 on a 160x110 panel over 640x360.
  //
  // It is withheld because declaring it MEASURABLY CHANGES PIXELS, and the cause is in
  // shared code rather than here. Measured (render_gpu/tests/material_reach_test.js
  // geometry): declaring reach 0 moves 148 of 921,600 bytes against the full-surface
  // path, on the antialiased rim of a shape crossing the panel edge. That is NOT an
  // edge clamp — a clamp is impossible for a point sampler, because
  // handleMaterialBackdrop adds COVERAGE_AA_SLOP_PX (2 device px) on top of any
  // declared reach, and the residual is NON-MONOTONE in the declared value (148 at
  // reach 0, 140 at 1, 67 at 4, 0 at 8, then 1 byte again at 16). `frosted` declares
  // reach 0 too and shows ZERO difference only because it keeps its blurred child, so
  // BLUR_SUPPORT_SIGMAS x its blur sigma already widens its region ~26 px — past the
  // point where the residual disappears. In other words the framework's region-bounded
  // backdrop and its full-surface backdrop are not byte-equivalent for a SMALL region,
  // whatever the material's reach; `crt (rotated)`'s 1-byte failure in that suite is
  // the same class.
  //
  // So absence is chosen for exactly the reason the protocol documents it: it keeps the
  // full-surface behaviour, which is "expensive but never wrong". Picking some larger
  // reach because it happens to make the diff vanish would be a fudge dressed as a
  // measurement. Restoring the line is a ONE-LINE change once that seam is understood,
  // and the guard below is already written to hold it honest.
};

// LOUD IMPORT-TIME GUARD (the comic_shader.js precedent): a material claiming it does
// not sample the blurred child, whose SkSL then evals it, would render WRONG — an
// un-blurred texture silently substituted for a blurred one. Cross-checking the claim
// against the shader source at load makes that impossible to ship.
if (BRIGHTNESS_CONTRAST_MATERIAL.usesBlurredBackdrop === false && /\bblurredBackdrop\s*\.\s*eval\b/.test(BRIGHTNESS_CONTRAST_SKSL))
  throw new Error('brightness_contrast_shader: BRIGHTNESS_CONTRAST_MATERIAL declares usesBlurredBackdrop:false but BRIGHTNESS_CONTRAST_SKSL evals blurredBackdrop — the handler skips building that child, so the shader would sample a SHARP texture where it expects a blurred one. Remove the flag or stop evaluating the child.');

// THE SAME GUARD FOR THE ZERO-REACH CLAIM. `maxSampleReach: () => 0` bounds the
// backdrop the framework re-renders to this panel alone, so a LATER edit that added a
// neighbourhood tap — a Sobel edge term, a local-contrast halo, any eval at p ± d —
// would silently read a texture that stops at the panel edge and CLAMP there, which
// shows up as a rim artifact rather than an error. Sweeping every backdrop eval in the
// source for a bare `p` argument at import makes that unshippable, exactly as the
// blurred-child check above does for its claim.
const SHARP_EVAL_ARGS = [...BRIGHTNESS_CONTRAST_SKSL.matchAll(/\bsharpBackdrop\s*\.\s*eval\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
if (SHARP_EVAL_ARGS.length === 0)
  throw new Error("brightness_contrast_shader: BRIGHTNESS_CONTRAST_SKSL never evaluates sharpBackdrop — a tone adjustment with no backdrop sample would render nothing.");
export const BRIGHTNESS_CONTRAST_DISPLACED_EVALS = SHARP_EVAL_ARGS.filter((arg) => arg !== "p");
if (BRIGHTNESS_CONTRAST_DISPLACED_EVALS.length > 0)
  throw new Error(`brightness_contrast_shader: BRIGHTNESS_CONTRAST_SKSL samples the backdrop AWAY from the fragment coordinate (${BRIGHTNESS_CONTRAST_DISPLACED_EVALS.map((a) => `sharpBackdrop.eval(${a})`).join(", ")}), so this is no longer the POINT operation this file is documented as. Two claims stop being true at once: the zero outward reach (see the maxSampleReach note on the descriptor) and "a tone curve reads only the pixel it re-grades". Update both, and declare the real outward reach in device px, rather than deleting this guard.`);
