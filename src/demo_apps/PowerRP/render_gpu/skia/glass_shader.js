/**
 * The Liquid Glass SkSL shader — the single source of truth for the macOS
 * "Liquid Glass" material (macOS 26 Tahoe). REAL SkSL: compiles through
 * CanvasKit.RuntimeEffect.Make and is the FIRST RuntimeEffect in the tree
 * (render_gpu/skia/paint_skia.js handleGlassBackdrop compiles + caches it once).
 *
 * Grounded in .frenzy/glass/design.md (12 VLM-inspected macOS reference
 * screenshots) and evolved from that dump's VLM-verified prototype
 * (glass.sksl.js). Pipeline, per output pixel `p` (DEVICE px), given a rounded-
 * rect region (center/half-size/corner) and two child image shaders — a BLURRED
 * backdrop and the SHARP backdrop, both in device space:
 *
 *   1. rotate p into the panel's LOCAL frame; the REGION SDF (a squircle whose
 *      flat edges relax into the corner curve as surface tension rises)
 *      -> antialiased coverage + inside-distance
 *   2. edge weight (1 at the rim, 0 by uEdgeFalloff inward) = the effect band
 *   3. outward SDF normal (numerical gradient), rotated back to device space
 *   4. REFRACTION: sample the blurred backdrop displaced OUTWARD along the
 *      normal, scaled by the edge weight (the glass-bevel bend, strongest at the
 *      border) + a thin crisp caustic at the very rim
 *   5. desaturate + LUMINANCE-ADAPTIVE tint (pale over dark content, smoky over
 *      light content — the macOS content-adaptive skin, low strength = CLARITY)
 *   6. SPECULAR from a light ABOVE (screen space): a thin bright rim on the lit
 *      edge + a broad soft sheen, minus a faint contact shadow on the far edge
 * `uMaterialize` (0..1) drives the Spotlight appear ramp.
 *
 * THREE macOS-fidelity passes over the prototype (design.md Part 4 "still off"):
 *   (a) CLARITY — lower tint strength, higher saturation kept, subtler sheen so
 *       the backdrop reads THROUGH the glass instead of a milky frost.
 *   (b) ADAPTIVE TINT — the tint neutral is luminance-driven (light over dark,
 *       dark over light), not a fixed white overlay.
 *   (c) SQUIRCLE — continuous-curvature corners via an Lp-norm superellipse SDF
 *       (SQUIRCLE_N > 2), Apple's rounded-corner construction, not a plain arc.
 *
 * ── THE REGION BOUNDARY IS ONE CURVE, DEFINED ONCE ───────────────────────────
 * The SkSL `sdGlassScaled` below and the JS `glassOutlinePoints` below it are the two
 * halves of a SINGLE curve definition: a distance field and a point generator for
 * the SAME zero set. Everything that draws this widget's boundary — the shader
 * body, the hairline stroke, the drop shadow, the thumbnail stand-in — goes
 * through one of those two, so there is no second construction to drift.
 * (Before this, the stroke and the shadow were CanvasKit.RRectXY circular
 * rounded rects while the shader body was an Lp squircle: at the default
 * cornerRadius 48 / squircle 4 the two silhouettes disagreed by 9.1 world px on
 * the corner diagonal — 2^(1/2 - 1/n) - 1 = 18.9% of the radius — which read as
 * the stroke slicing a chord across the glass corner. glass_outline_test.js
 * pins them together.)
 */

import { parseColor } from "../ir.js";
import { schemaAngleRadians } from "../../core/properties.js";

// The refraction PRE_BULGE (the materialize->0 backdrop bulge). Exported as a JS
// constant AND interpolated into the SkSL below, so the shader and the JS
// backdrop-region math (paint_skia.js maxGlassDisplacement) read the SAME value —
// there is exactly one source of truth. String(1.7) === "1.7", so the compiled
// shader text is byte-identical to the former inline literal.
export const GLASS_PRE_BULGE = 1.7;

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
// The MATERIAL-CHARACTER knobs (squircle, sheen, specular tightness, contact
// shadow, caustic, edge light, tint adaptivity) are UNIFORMS, not constants —
// the demo widget exposes them as self.* custom properties so the material
// equation is fully user-tweakable. Only structural constants stay baked in.
export const GLASS_SKSL = `
const float AA_PX = 1.0;            // coverage antialias half-width (~1 device px)
const float NORMAL_EPS_PX = 1.0;    // central-difference step for the SDF normal: one device pixel, the finest step the raster can resolve
const float SHEEN_POWER = 5.0;      // falloff SHAPE of the broad surface sheen (its STRENGTH is the uSheen uniform)
const float RIM_WEIGHT = 1.15;      // relative weight of the thin edge hairline vs the broad sheen (the crisp top rim IS the signature highlight)
const float PRE_BULGE = ${GLASS_PRE_BULGE};        // extra refraction at materialize->0 (Stage 0: backdrop bulges before the glass settles)
const float APPEAR_END = 0.8;       // materialize value by which the frosted skin is fully faded in
const float PERIMETER_PX = 2.5;     // width of the crisp bright edge OUTLINE (its brightness is the uEdgeLight uniform)
const float ADAPT_LO = 0.30;        // backdrop luminance at/below which the tint neutral is fully PALE (light glass over dark content)
const float ADAPT_HI = 0.70;        // backdrop luminance at/above which the tint neutral is fully SMOKY (dark glass over light content)
const float ADAPT_LIGHT = 0.96;     // the PALE neutral value used over DARK content (adaptive tint pass b)
const float ADAPT_DARK = 0.06;      // the SMOKY neutral value used over LIGHT content (adaptive tint pass b)
const float ADAPT_FIXED = 0.75;     // the NON-adaptive frosted neutral (used when uAdaptivity -> 0: a plain pale tint)
const half3 REC709 = half3(0.2126, 0.7152, 0.0722); // luminance weights for desaturation + adaptive tint

uniform shader blurredBackdrop;     // child 0: Gaussian-blurred composite-so-far (device space)
uniform shader sharpBackdrop;       // child 1: the un-blurred composite-so-far (device space)
uniform float2 uCenter;             // region center (device px)
uniform float2 uHalfSize;           // region half-extents (device px)
uniform float uCornerRadius;        // rounded-rect corner radius (device px)
uniform float uEdgeFalloff;         // inward decay distance of the effect band (device px)
uniform float uRefractionStrength;  // max edge displacement at the rim (device px)
uniform float uAngle;               // panel rotation (radians): rotates the SDF frame so a rotated widget stays correct
uniform float uLightAngle;          // direction TO the light (radians; -PI/2 = straight above), in SCREEN space
uniform float uLightIntensity;      // specular strength
uniform float uSaturation;          // backdrop saturation kept (1 = unchanged, 0 = gray)
uniform float4 uTint;               // tint COLOR CAST (rgb, multiplies the adaptive neutral) + STRENGTH (a); low alpha = clear
uniform float uMaterialize;         // 0 = gone, 1 = fully settled glass
// ── user-tweakable material-character knobs (self.* custom props) ────────────
uniform float uSquircle;            // corner Lp-norm exponent: 2 == circular arc, >2 == continuous "squircle" curvature (Apple's corners)
uniform float uSheen;               // STRENGTH of the broad surface sheen (kept low for clarity)
uniform float uSpecPower;           // tightness of the edge specular lobe: higher => thinner bright hairline on the lit edge
uniform float uContactShadow;       // strength of the faint dark edge OPPOSITE the light (glass contact shading)
uniform float uCaustic;             // how much SHARP (unblurred) backdrop bleeds into the very rim (bright refracted streaks)
uniform float uEdgeLight;           // brightness of the crisp perimeter outline (glass edge catch-light)
uniform float uAdaptivity;          // 0 = fixed frosted tint, 1 = fully luminance-adaptive (pale over dark, smoky over light)
uniform float uChromatic;           // chromatic aberration: R/B channels sample at +/- this fraction of the refraction displacement (rim fringing)
uniform float uSurfaceTension;      // 0 = a rectangle with squircle corners (flat edges), 1 = the fully RELAXED superellipse inscribed in the box (no flat edge anywhere)

// Pure. The region SDF in PRE-SCALED space: negative inside, p LOCAL+centered.
// Divide by glassAniso below to read it as a device-px distance.
//
// THE SHAPE. The region is the Minkowski sum of an inner RECTANGLE of half-size
// INNER with an Lp "ball" of exponent n whose semi-axes are the corner radii
// rr, so its boundary in the first quadrant is
//
//     ((x - inner.x)/rr.x)^n + ((y - inner.y)/rr.y)^n = 1
//
// clipped to x >= inner.x, y >= inner.y, plus the straight runs of the inner
// rectangle. SURFACE TENSION shrinks INNER to zero and grows RR to the
// half-size in step (rr = mix(r, h, tension), inner = h - rr), which
//   * keeps the OUTER extent at h for every tension (the widget still fills its
//     own bbox, so resize handles and hit tests stay honest), and
//   * removes the straight runs entirely at tension 1, leaving the pure
//     superellipse |x/h.x|^n + |y/h.y|^n = 1 — a curve with NO flat region.
// That is the physical picture: surface tension pulls a pinned liquid toward
// minimum perimeter, i.e. toward the roundest shape its footprint allows.
//
// THE DISTANCE. An anisotropic Lp gauge has no closed-form distance, so this takes
// the standard route: pre-scale the plane by s = ref/rr, which turns the
// anisotropic gauge into the ISOTROPIC one this shader has always used (gauge
// radius REF), and evaluate the isotropic Lp rounded-box SDF there. What comes back
// is a distance measured in the STRETCHED metric; glassAniso returns the stretch so
// the caller can divide it out. At tension 0 — and at ANY tension on a square panel
// — s is exactly (1, 1) and every line here reduces, operation for operation, to
// the squircle SDF that shipped before surface tension existed.
//
// The point arrives ALREADY pre-scaled (main does pl * s once) rather than being
// scaled inside, because this is evaluated five times per pixel — once for the
// distance and four times for the numerical normal — and s is positive, so
// abs(p)*s == abs(p*s) and the scaling commutes out of all five. That is what makes
// the tension machinery cost two multiplies per PIXEL instead of ten.
float sdGlassScaled(float2 ps, float2 innerScaled, float ref, float n) {
  float2 q = abs(ps) - innerScaled;
  float2 qp = max(q, 0.0);
  return pow(pow(qp.x, n) + pow(qp.y, n), 1.0 / n) + min(max(q.x, q.y), 0.0) - ref;
}

// Pure. The local metric stretch the pre-scale introduced, as a positive factor:
//
//     aniso = |s * grad| / |grad|      (grad = the gauge gradient, unnormalized)
//
// The RATIO — not |s * grad| alone — is deliberate. It removes exactly the error
// the pre-scale introduced and NOTHING else. |s * grad| alone would ALSO divide out
// the isotropic Lp SDF's own inherited inexactness (|grad| != 1 for n > 2, the
// price of the radial-gauge form), which would change every existing glass render;
// and measured, it is also simply worse — over a +-22 px band the mean error
// against true Euclidean distance is 11.5 px that way against 0.8 px this way.
//
// MEASURED accuracy of the ratio form (scratchpad sweep over aspect x radius x
// exponent x tension): within the +-1 px coverage band the error against true
// Euclidean distance is <= 0.25 px at EVERY tension, so the silhouette and its
// antialiasing are exact to well under a pixel. Further in, the radial-gauge error
// grows with tension and aspect ratio: over the default 22 px effect band it goes
// 3.5 px -> 6.0 px (tension 0 -> 1) on the default 440x150 panel, and reaches ~60 px
// on an extreme 7.5:1 panel at tension 1. That only makes the soft bevel band
// non-uniform in width; it can never move the edge.
float glassAniso(float2 ps, float2 innerScaled, float2 s, float n) {
  float2 q = abs(ps) - innerScaled;
  float2 qp = max(q, 0.0);
  // Where the point is inside the INNER rectangle the gauge is flat and the
  // distance is governed by the max-component term instead, whose gradient is that
  // axis; the guarded components keep pow(0, n-1) from becoming 0/0.
  float2 g = (qp.x > 0.0 || qp.y > 0.0)
    ? float2(qp.x > 0.0 ? pow(qp.x, n - 1.0) : 0.0, qp.y > 0.0 ? pow(qp.y, n - 1.0) : 0.0)
    : (q.x > q.y ? float2(1.0, 0.0) : float2(0.0, 1.0));
  float gn = length(g);
  // gn == 0 only at a critical point of the gauge (underflow of qp^(n-1) right on
  // the inner corner); 1.0 is the no-stretch value, so the guard cannot perturb it.
  return gn > 0.0 ? length(s * g) / gn : 1.0;
}

// Pure. Outward unit normal of the region via central differences of the PRE-SCALED
// distance. The pre-scaled field's gradient is already normal to the true boundary —
// dividing a field by a positive scalar cannot rotate its gradient at a zero
// crossing — so the normal needs no anisotropy correction, and skipping it here is
// what keeps the four extra evaluations as cheap as they always were.
//
// STEPSCALED is NORMAL_EPS_PX * s: a step of s.x in pre-scaled space is a step of
// exactly one device pixel in the panel's own frame, so each difference comes out as
// the LOCAL derivative and the two components stay commensurate (they would not if
// both axes stepped by the same amount in a stretched space, and the normal would
// tilt toward the compressed axis).
float2 normalLocal(float2 ps, float2 innerScaled, float2 stepScaled, float ref, float n) {
  float dx = sdGlassScaled(ps + float2(stepScaled.x, 0.0), innerScaled, ref, n) - sdGlassScaled(ps - float2(stepScaled.x, 0.0), innerScaled, ref, n);
  float dy = sdGlassScaled(ps + float2(0.0, stepScaled.y), innerScaled, ref, n) - sdGlassScaled(ps - float2(0.0, stepScaled.y), innerScaled, ref, n);
  float2 g = float2(dx, dy);
  float len = length(g);
  return len > 0.0 ? g / len : float2(0.0, -1.0);
}

half4 main(float2 p) {
  // Rotate the device pixel into the panel's LOCAL centered frame (uAngle == 0
  // is the axis-aligned common case). cos/sin of the widget rotation.
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y);
  float r = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y)); // capsule-safe clamp
  float n = max(uSquircle, 2.0);                   // >=2: never concave (2 == circular arc)
  // The boundary family (see sdGlassScaled): corner semi-axes rr, inner rectangle
  // h - rr, and the pre-scale that makes the corner gauge isotropic. All of it is
  // uniform-derived. At tension 0, rr is (r, r), the pre-scale is exactly (1, 1),
  // inner is exactly h - r, and every line below reduces to the pre-tension
  // expression term for term.
  float tension = clamp(uSurfaceTension, 0.0, 1.0);
  float2 rr = mix(float2(r), uHalfSize, tension);
  float2 inner = uHalfSize - rr;
  float ref = max(rr.x, rr.y);
  // ref/rr, guarded: rr is 0 only for a zero-extent axis or for r == 0 at tension
  // 0, and in both of those the shape has no corner to scale, so 1 is the value.
  float2 s = float2(rr.x > 0.0 ? ref / rr.x : 1.0, rr.y > 0.0 ? ref / rr.y : 1.0);
  float2 ps = pl * s;                              // the point in the isotropic gauge frame
  float2 innerScaled = inner * s;

  // The pre-scale is the IDENTITY whenever the two corner semi-axes agree — at
  // tension 0 always, and at any tension on a SQUARE panel. There is then no stretch
  // to divide out and 1.0 is the exact answer, so the whole anisotropy evaluation is
  // skipped. The test is exact by construction (s is ref/rr over equal operands,
  // which is 1.0 to the bit) and the general branch is also correct if it is ever
  // taken, so this is an algebraic shortcut and not a special case — it is why the
  // default look costs what it cost before.
  float dScaled = sdGlassScaled(ps, innerScaled, ref, n);
  float d = (s.x == 1.0 && s.y == 1.0) ? dScaled : dScaled / glassAniso(ps, innerScaled, s, n);
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);
  if (cov <= 0.0) { return half4(0.0); }          // outside region: contribute nothing
  float distInside = -d;
  float edge = 1.0 - smoothstep(0.0, uEdgeFalloff, distInside);
  float2 Nl = normalLocal(ps, innerScaled, s * NORMAL_EPS_PX, ref, n);
  // Rotate the local normal back to DEVICE space (refraction + light live in
  // screen space, so the light stays "from above" however the panel is turned).
  float2 N = float2(ca * Nl.x - sa * Nl.y, sa * Nl.x + ca * Nl.y);
  float m = clamp(uMaterialize, 0.0, 1.0);
  float appear = smoothstep(0.0, APPEAR_END, m);
  float refrAmt = mix(PRE_BULGE, 1.0, m);

  // (4) refraction — displace outward along the normal, scaled by the edge band.
  // CHROMATIC ABERRATION (edge-only dispersion): sample each channel at a slightly
  // different displacement — RED toward the glass center (less outward), GREEN at
  // the base, BLUE away from center (more outward) — the documented Liquid Glass
  // convention (matches real dispersion: shorter wavelengths bend more). Scaled by
  // the edge band so it is a faint rim fringe, ~0 in the interior; tiny by default.
  float2 disp = N * (uRefractionStrength * edge * refrAmt);
  float caAmt = uChromatic * edge;
  half3 body = half3(
    blurredBackdrop.eval(p + disp * (1.0 - caAmt)).r,
    blurredBackdrop.eval(p + disp).g,
    blurredBackdrop.eval(p + disp * (1.0 + caAmt)).b
  );
  half3 caustic = sharpBackdrop.eval(p + disp).rgb;
  body = mix(body, caustic, half(uCaustic * edge));

  // (5) desaturate + LUMINANCE-ADAPTIVE tint (pass a clarity + pass b adaptive).
  // uAdaptivity blends the neutral between a fixed frosted tint and the
  // luminance-adaptive neutral (pale over dark content, smoky over light).
  half lum = dot(body, REC709);
  body = mix(half3(lum), body, half(uSaturation));
  float adapt = smoothstep(ADAPT_LO, ADAPT_HI, float(lum));       // 0 over dark, 1 over light
  half3 adaptiveNeutral = mix(half3(ADAPT_LIGHT), half3(ADAPT_DARK), half(adapt));
  half3 neutral = mix(half3(ADAPT_FIXED), adaptiveNeutral, half(clamp(uAdaptivity, 0.0, 1.0)));
  half3 tintColor = neutral * half3(uTint.rgb);                  // user hue tints the neutral
  body = mix(body, tintColor, half(uTint.a * appear));

  // (6) specular — light from above (screen space). The broad sheen is a SMOOTH
  // gradient along the light direction (brighter toward the light), normalized by
  // the panel size — NOT a radial-from-center term, which creases where the
  // center direction flips. rim/contact are edge-band lobes on the SDF normal.
  float2 L = float2(cos(uLightAngle), sin(uLightAngle));
  float rim = pow(max(dot(N, L), 0.0), uSpecPower) * edge;
  float grad = dot(p - uCenter, L) / max(length(uHalfSize), 1.0); // ~ -1..1, + toward the light
  float sheen = pow(clamp(grad * 0.5 + 0.5, 0.0, 1.0), SHEEN_POWER);
  float dark = pow(max(dot(N, -L), 0.0), uSpecPower) * edge;
  float spec = (rim * RIM_WEIGHT + sheen * uSheen) * uLightIntensity;

  // crisp bright edge outline all around (brighter on the lit edge)
  float perim = 1.0 - smoothstep(0.0, PERIMETER_PX, distInside);
  float outline = perim * uEdgeLight * (0.6 + 0.4 * max(dot(N, L), 0.0));

  half3 outc = body + half3((spec + outline) * appear) - half3(dark * uContactShadow * appear);
  return half4(outc * half(cov), half(cov));       // premultiplied
}
`;

// ── THE SHAPE-CONFORMING FILL VARIANT ────────────────────────────────────────
// The glass FILL of an arbitrary shape (gear, star, blob) must catch its rim light
// on EVERY tooth and notch, not trace the bbox rectangle. This variant is a
// character-for-character mirror of GLASS_SKSL's LOOK math (refraction → tint →
// specular → outline), with ONE difference: the region distance `d` and the surface
// normal `N` come from the SILHOUETTE SDF child (render_gpu/skia/shape_sdf.js,
// device px, negative inside) instead of the analytic squircle. So the refraction
// bevel, the edge specular, the perimeter catch-light and the contact shadow all ride
// the true outline. The UNIFORM BLOCK is IDENTICAL to GLASS_SKSL (same order, same 25
// floats — packGlassMaterial is unchanged); the four purely-geometric uniforms
// (uCornerRadius, uAngle, uSquircle, uSurfaceTension) are simply unused here (the SDF
// already carries rotation and the exact silhouette). Only the FILL path binds this;
// the glass WIDGET keeps GLASS_SKSL, byte-identical.
export const GLASS_FILL_SKSL = `
const float AA_PX = 1.0;
const float NORMAL_EPS_PX = 1.0;
const float SHEEN_POWER = 5.0;
const float RIM_WEIGHT = 1.15;
const float PRE_BULGE = ${GLASS_PRE_BULGE};
const float APPEAR_END = 0.8;
const float PERIMETER_PX = 2.5;
const float ADAPT_LO = 0.30;
const float ADAPT_HI = 0.70;
const float ADAPT_LIGHT = 0.96;
const float ADAPT_DARK = 0.06;
const float ADAPT_FIXED = 0.75;
const half3 REC709 = half3(0.2126, 0.7152, 0.0722);

uniform shader blurredBackdrop;     // child 0
uniform shader sharpBackdrop;       // child 1
uniform shader shapeSdf;            // child 2: silhouette signed distance (device px, <0 inside)
uniform float2 uCenter;
uniform float2 uHalfSize;
uniform float uCornerRadius;        // unused in the fill variant (the SDF is the silhouette)
uniform float uEdgeFalloff;
uniform float uRefractionStrength;
uniform float uAngle;               // unused (the device-space SDF already carries rotation)
uniform float uLightAngle;
uniform float uLightIntensity;
uniform float uSaturation;
uniform float4 uTint;
uniform float uMaterialize;
uniform float uSquircle;            // unused
uniform float uSheen;
uniform float uSpecPower;
uniform float uContactShadow;
uniform float uCaustic;
uniform float uEdgeLight;
uniform float uAdaptivity;
uniform float uChromatic;
uniform float uSurfaceTension;      // unused

half4 main(float2 p) {
  // Silhouette distance + normal, straight from the SDF child (device space).
  float d = shapeSdf.eval(p).r;
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);
  if (cov <= 0.0) { return half4(0.0); }
  float distInside = -d;
  float edge = 1.0 - smoothstep(0.0, uEdgeFalloff, distInside);
  float2 g = float2(
    shapeSdf.eval(p + float2(NORMAL_EPS_PX, 0.0)).r - shapeSdf.eval(p - float2(NORMAL_EPS_PX, 0.0)).r,
    shapeSdf.eval(p + float2(0.0, NORMAL_EPS_PX)).r - shapeSdf.eval(p - float2(0.0, NORMAL_EPS_PX)).r);
  float glen = length(g);
  float2 N = glen > 0.0 ? g / glen : float2(0.0, -1.0);   // outward silhouette normal (device space)

  float m = clamp(uMaterialize, 0.0, 1.0);
  float appear = smoothstep(0.0, APPEAR_END, m);
  float refrAmt = mix(PRE_BULGE, 1.0, m);

  // (4) refraction along the silhouette normal (chromatic split, as the base shader).
  float2 disp = N * (uRefractionStrength * edge * refrAmt);
  float caAmt = uChromatic * edge;
  half3 body = half3(
    blurredBackdrop.eval(p + disp * (1.0 - caAmt)).r,
    blurredBackdrop.eval(p + disp).g,
    blurredBackdrop.eval(p + disp * (1.0 + caAmt)).b
  );
  half3 caustic = sharpBackdrop.eval(p + disp).rgb;
  body = mix(body, caustic, half(uCaustic * edge));

  // (5) desaturate + luminance-adaptive tint (identical to GLASS_SKSL).
  half lum = dot(body, REC709);
  body = mix(half3(lum), body, half(uSaturation));
  float adapt = smoothstep(ADAPT_LO, ADAPT_HI, float(lum));
  half3 adaptiveNeutral = mix(half3(ADAPT_LIGHT), half3(ADAPT_DARK), half(adapt));
  half3 neutral = mix(half3(ADAPT_FIXED), adaptiveNeutral, half(clamp(uAdaptivity, 0.0, 1.0)));
  half3 tintColor = neutral * half3(uTint.rgb);
  body = mix(body, tintColor, half(uTint.a * appear));

  // (6) specular: rim/contact on the silhouette normal; the broad sheen stays a soft
  // bbox-directional gradient (it is a face wash, not an edge effect).
  float2 L = float2(cos(uLightAngle), sin(uLightAngle));
  float rim = pow(max(dot(N, L), 0.0), uSpecPower) * edge;
  float grad = dot(p - uCenter, L) / max(length(uHalfSize), 1.0);
  float sheen = pow(clamp(grad * 0.5 + 0.5, 0.0, 1.0), SHEEN_POWER);
  float dark = pow(max(dot(N, -L), 0.0), uSpecPower) * edge;
  float spec = (rim * RIM_WEIGHT + sheen * uSheen) * uLightIntensity;

  float perim = 1.0 - smoothstep(0.0, PERIMETER_PX, distInside);
  float outline = perim * uEdgeLight * (0.6 + 0.4 * max(dot(N, L), 0.0));

  half3 outc = body + half3((spec + outline) * appear) - half3(dark * uContactShadow * appear);
  return half4(outc * half(cov), half(cov));
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
const GLASS_UNIFORM_FLOATS = 25;

/**
 * Pure function. Packs glass params into the flat Float32Array CanvasKit expects
 * (uniform declaration order, tightly packed: float2 = 2 slots, float4 = 4). All
 * lengths/positions are DEVICE px; angles are radians. The two child shaders
 * (blurred, sharp) are passed separately to makeShaderWithChildren.
 *
 * @param {object} u - device-space uniforms:
 *   {cx, cy, halfW, halfH, cornerRadius, edgeFalloff, refractionStrength, angle,
 *    lightAngle, lightIntensity, saturation, tint:[r,g,b,a], materialize,
 *    squircle, sheen, specPower, contactShadow, caustic, edgeLight, adaptivity,
 *    chromatic, surfaceTension}
 * @returns {Float32Array} length 25, in shader-uniform order
 *
 * @example
 * packGlassUniforms({cx:100,cy:80,halfW:60,halfH:40,cornerRadius:20,
 *   edgeFalloff:16,refractionStrength:10,angle:0,lightAngle:-1.57,
 *   lightIntensity:0.6,saturation:0.9,tint:[1,1,1,0.14],materialize:1,
 *   squircle:4,sheen:0.1,specPower:8,contactShadow:0.26,caustic:0.12,
 *   edgeLight:0.14,adaptivity:1,chromatic:0.08,surfaceTension:0}).length // 25
 */
export function packGlassUniforms(u) {
  const out = new Float32Array([
    u.cx, u.cy,
    u.halfW, u.halfH,
    u.cornerRadius,
    u.edgeFalloff,
    u.refractionStrength,
    u.angle,
    u.lightAngle,
    u.lightIntensity,
    u.saturation,
    u.tint[0], u.tint[1], u.tint[2], u.tint[3],
    u.materialize,
    u.squircle,
    u.sheen,
    u.specPower,
    u.contactShadow,
    u.caustic,
    u.edgeLight,
    u.adaptivity,
    u.chromatic,
    u.surfaceTension,
  ]);
  if (out.length !== GLASS_UNIFORM_FLOATS)
    throw new Error(`packGlassUniforms: packed ${out.length} floats, expected ${GLASS_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * Pure function. The glass shader's MAXIMUM outward backdrop-sample displacement
 * (device px) — exactly how far OUTSIDE the panel the refraction reads the
 * backdrop. The refraction is strongest at the rim (edge weight = 1) with the
 * materialize->0 PRE_BULGE, and chromatic aberration pushes the BLUE channel a
 * further (1 + chromatic)x (see the SkSL `main`: the blue tap samples at
 * `p + disp * (1 + caAmt)`, caAmt = uChromatic * edge <= chromatic). A backdrop
 * region that clamps rendering to the panel must add this (plus the blur support)
 * as margin, or the refracted rim would sample past the rendered pixels.
 *
 *   maxDisp = refractionDev · PRE_BULGE · (1 + chromatic)
 *
 * @param {number} refractionDev - refraction strength in DEVICE px (world·scale·zoom·dpr)
 * @param {number} chromatic - chromatic aberration fraction (0..1)
 * @returns {number} maximum outward displacement in device px
 *
 * @example maxGlassDisplacement(10, 0.08) // 18.36   (10 · 1.7 · 1.08)
 * @example maxGlassDisplacement(0, 0) // 0
 */
export function maxGlassDisplacement(refractionDev, chromatic) {
  return refractionDev * GLASS_PRE_BULGE * (1 + chromatic);
}

// ── THE LIQUID GLASS FILL MATERIAL (registry entry) ──────────────────────────
// Liquid Glass predates the material registry: the glass WIDGET (plugins/demo/
// glass.js) emits its own `glassBackdrop` op through paint_skia.js
// handleGlassBackdrop, a legacy path this descriptor leaves entirely alone and
// BYTE-IDENTICAL — GLASS_SKSL and packGlassUniforms are UNCHANGED, so the widget
// renders bit-for-bit as before. This entry is purely ADDITIVE: it opts glass
// into the FILL-material framework (materials.isFillCapableMaterial) so
// "Liquid Glass" appears in the paint "Mat" dropdown and can shade ANY shape,
// exactly like the sibling backdrop materials (frosted / comic / crt). It routes
// through the SAME machinery those use — paint_skia.js handleMaterialPaintShape
// synthesizes a region op with cornerRadius 0 over the shape's bbox and CLIPS to
// the shape, then handleMaterialBackdrop re-renders the content beneath, packs
// these uniforms, and draws.
//
// WHY THE GLASS_SKSL NEEDS NO "PLAIN RECT MODE" UNIFORM. The concern was that
// glass's signature effect lives at its OWN SDF edge, and a fill wants the glass
// to cover the whole clip with the clip doing the shaping. But the fill region op
// arrives at cornerRadius 0, and glassUniformParams below pins squircle = 2 and
// surfaceTension = 0, which is exactly the shader's own r = 0 / tension = 0
// DEGENERATE case: sdGlassScaled reduces, term for term, to a plain rectangle SDF
// whose interior coverage is 1 across the entire bbox. The clip is then the only
// silhouette. So no new mode uniform was needed — the plain rectangle already IS
// a code path the shipped shader handles. (A NON-zero surfaceTension would have
// been actively wrong here: it shrinks the glass to a superellipse inscribed in
// the bbox, leaving the clip's corners unpainted — which is why the outline knobs
// are fixed, not exposed. The refraction bevel therefore rides the bbox
// rectangle edges: for a rectangular shape it traces the outline like real glass;
// for a star/ellipse the rim bevel appears where the silhouette meets the bbox
// edge while the interior reads as blurred, tinted, sheened glass. cornerRadius,
// squircle and surfaceTension stay WIDGET-side per the comic precedent — a fill's
// shape IS its geometry, and the shape clip, not an SDF, does the shaping.)

/**
 * THE LIQUID GLASS FILL KNOB SCHEMA — the ONE declaration of the fill's look
 * knobs, in the customProps row shape (the fill-material framework renders it as
 * the paint's param rows, resolved sparse-over-defaults by
 * materials.resolveMaterialPaint). Mirrors the glass WIDGET's optics knobs
 * (plugins/demo/glass.js) but DELIBERATELY OMITS the ones meaningless for a fill:
 *   - cornerRadius / squircle / surfaceTension — outline geometry; the shape clip
 *     is the silhouette (see the block comment above), so these stay widget-side.
 *   - materialize — the appear RAMP, an animation knob; a fill is settled glass.
 *   - shadowStrength — the drop shadow is drawn only by the legacy handleGlassBackdrop,
 *     not by the fill path (handleMaterialBackdrop), so it would be inert here.
 * `blurRadius` and `backdropScale` are OP-LEVEL (not shader uniforms): the fill
 * router reads them straight from resolvedParams to size the blurred child and the
 * below-content re-render, so glassUniformParams does NOT forward them — the
 * frosted precedent. Fractional knobs carry a small (0.01) scrub per B.2/B.3; the
 * mins mirror the widget's real bounds (no arbitrary clamps).
 */
export const GLASS_FILL_PARAMS = [
  { name: "blurRadius", kind: "number", default: 8, min: 0, help: "Gaussian blur radius (world px) of the backdrop seen THROUGH the glass. Moderate keeps it readable — Liquid Glass is a frost, not an opaque blur." },
  { name: "refractionStrength", kind: "number", default: 14, min: 0, help: "Maximum edge displacement (world px). The defining Liquid Glass trait: surrounding content bends inward at the rim (strong at the border, ~0 in the interior). For a fill the rim is the shape's bbox edge." },
  { name: "edgeFalloff", kind: "number", default: 22, min: 0, help: "How far inward (world px) the refraction + specular band decays. Larger = a wider bevelled rim." },
  { name: "lightAngle", kind: "angle", default: -111.6, help: "Direction TO the light (degrees, screen space; -90° is straight above, 0° from the right). The lit edge catches the thin bright highlight." },
  { name: "lightIntensity", kind: "number", default: 0.8, min: 0, step: 0.01, help: "Strength of the top-light specular (the thin rim hairline + the broad soft sheen)." },
  { name: "tint", kind: "color", default: "rgba(255,255,255,0.14)", help: "The glass skin's colour CAST (rgb) and STRENGTH (alpha). The neutral is luminance-adaptive — pale over dark content, smoky over light — and this tints it; keep the alpha low for clarity." },
  { name: "saturation", kind: "number", default: 0.92, min: 0, max: 1, step: 0.01, help: "How much backdrop colour is kept (1 = unchanged, 0 = gray). Slightly below 1 for the subtle frosted desaturation." },
  { name: "sheen", kind: "number", default: 0.1, min: 0, step: 0.01, help: "Strength of the broad surface sheen (the soft gradient of light across the face). Kept low so the interior stays clear." },
  { name: "specularPower", kind: "number", default: 8, min: 1, help: "Tightness of the edge specular lobe: higher = a thinner, crisper bright hairline on the lit edge." },
  { name: "contactShadow", kind: "number", default: 0.26, min: 0, step: 0.01, help: "Darkness of the faint contact shadow on the edge OPPOSITE the light (the glass sitting on the surface)." },
  { name: "caustic", kind: "number", default: 0.12, min: 0, step: 0.01, help: "How much SHARP (unblurred) backdrop bleeds into the very rim — the bright refracted streaks. Low to avoid ghosting." },
  { name: "edgeLight", kind: "number", default: 0.14, min: 0, step: 0.01, help: "Brightness of the crisp perimeter outline (the glass edge catching light all the way around)." },
  { name: "tintAdaptivity", kind: "number", default: 1, min: 0, max: 1, step: 0.01, help: "0 = a fixed frosted tint; 1 = fully luminance-adaptive (pale skin over dark content, smoky over light — the macOS content-adaptive look)." },
  { name: "chromatic", kind: "number", default: 0.08, min: 0, step: 0.01, help: "Chromatic aberration at the refracting rim: the R/B channels sample slightly off the G. A TINY value gives a faint coloured edge fringe like real glass; large = a rainbow smear." },
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, step: 0.05, help: "RESOLUTION FACTOR the content beneath is re-rendered at for the refraction: 1 = screen resolution, 2 = supersample (crisper refraction, slower), 0.5 = half res (faster, softer)." },
];

/** Stored angle → radians, reading each row's DECLARED storage unit from the
 *  schema above rather than restating it here (core/properties.schemaAngleRadians). */
const toRadians = schemaAngleRadians(GLASS_FILL_PARAMS);

/**
 * Pure function. SCHEMA params (GLASS_FILL_PARAMS names/kinds — degrees, a colour
 * string) → the numeric params packGlassMaterial consumes (packGlassUniforms's own
 * key names). THE one mapping both fill consumers share: the PaintField param rows
 * and the fill-material region-op synthesis (paint_skia handleMaterialPaintShape
 * reads it as entry.toUniformParams). `lightAngle` converts degrees → radians (the
 * comic precedent); `tint` is parsed to an [r,g,b,a] array HERE so the shader
 * packer and the proxy overlay read one already-resolved colour. `blurRadius` and
 * `backdropScale` are DROPPED — they are op-level, not shader uniforms (frosted
 * precedent). squircle/surfaceTension/materialize are PINNED to the plain-rect
 * fill values (see the block comment above).
 *
 * @param {object} p - schema-shaped params (resolved: every knob present)
 * @returns {object} packGlassMaterial-shaped params
 *
 * @example glassUniformParams({refractionStrength:14, edgeFalloff:22, lightAngle:-111.6, lightIntensity:0.8, tint:"rgba(255,255,255,0.14)", saturation:0.92, sheen:0.1, specularPower:8, contactShadow:0.26, caustic:0.12, edgeLight:0.14, tintAdaptivity:1, chromatic:0.08}).squircle // 2
 * @example glassUniformParams({refractionStrength:14, edgeFalloff:22, lightAngle:-111.6, lightIntensity:0.8, tint:"rgba(255,255,255,0.14)", saturation:0.92, sheen:0.1, specularPower:8, contactShadow:0.26, caustic:0.12, edgeLight:0.14, tintAdaptivity:1, chromatic:0.08}).specPower // 8
 * @example glassUniformParams({refractionStrength:14, edgeFalloff:22, lightAngle:-111.6, lightIntensity:0.8, tint:"rgba(255,255,255,0.14)", saturation:0.92, sheen:0.1, specularPower:8, contactShadow:0.26, caustic:0.12, edgeLight:0.14, tintAdaptivity:1, chromatic:0.08}).tint // [1, 1, 1, 0.14]
 */
export function glassUniformParams(p) {
  return {
    refractionStrength: p.refractionStrength, // world px — packGlassMaterial scales by u.scale
    edgeFalloff: p.edgeFalloff,               // world px — same
    lightAngle: toRadians("lightAngle", p.lightAngle),
    lightIntensity: p.lightIntensity,
    saturation: p.saturation,
    tint: parseColor(p.tint),                 // → [r, g, b, a]; alpha is the skin STRENGTH
    sheen: p.sheen,
    specPower: p.specularPower,
    contactShadow: p.contactShadow,
    caustic: p.caustic,
    edgeLight: p.edgeLight,
    adaptivity: p.tintAdaptivity,
    chromatic: p.chromatic,
    // FIXED for a fill: the clip is the silhouette, so the glass region is the full
    // bbox RECTANGLE (a plain rect SDF), and it is settled (no appear ramp).
    squircle: 2,
    surfaceTension: 0,
    materialize: 1,
  };
}

/**
 * Pure function. Packs a glass FILL's uniforms into the Float32Array CanvasKit
 * expects, by mapping the material framework's normalized `u` onto packGlassUniforms.
 * `u` carries DEVICE-px region geometry {cx, cy, halfW, halfH, cornerRadius, angle}
 * + `scale` (world→device length) + glass's own knobs (glassUniformParams output,
 * spread in by name). The ONLY work beyond forwarding is scaling the two WORLD-px
 * shader lengths — refractionStrength and edgeFalloff — to device px by `u.scale`,
 * exactly as the legacy handleGlassBackdrop does (`* sd`). cornerRadius arrives
 * already device-px (0 for a fill); the tint is already an [r,g,b,a] array.
 *
 * @param {object} u - {cx, cy, halfW, halfH, cornerRadius, angle, scale} + glassUniformParams output
 * @returns {Float32Array} length 25, in shader-uniform order (packGlassUniforms)
 *
 * @example packGlassMaterial({cx:100,cy:80,halfW:90,halfH:90,cornerRadius:0,angle:0,scale:1,edgeFalloff:22,refractionStrength:14,lightAngle:-1.95,lightIntensity:0.8,saturation:0.92,tint:[1,1,1,0.14],materialize:1,squircle:2,sheen:0.1,specPower:8,contactShadow:0.26,caustic:0.12,edgeLight:0.14,adaptivity:1,chromatic:0.08,surfaceTension:0}).length // 25
 * @example packGlassMaterial({cx:100,cy:80,halfW:90,halfH:90,cornerRadius:0,angle:0,scale:2,edgeFalloff:22,refractionStrength:14,lightAngle:-1.95,lightIntensity:0.8,saturation:0.92,tint:[1,1,1,0.14],materialize:1,squircle:2,sheen:0.1,specPower:8,contactShadow:0.26,caustic:0.12,edgeLight:0.14,adaptivity:1,chromatic:0.08,surfaceTension:0})[6] // 28
 */
export function packGlassMaterial(u) {
  return packGlassUniforms({
    cx: u.cx, cy: u.cy, halfW: u.halfW, halfH: u.halfH,
    cornerRadius: u.cornerRadius,               // device px — 0 for a fill (the clip shapes it)
    edgeFalloff: u.edgeFalloff * u.scale,       // world px → device px
    refractionStrength: u.refractionStrength * u.scale,
    angle: u.angle,
    lightAngle: u.lightAngle, lightIntensity: u.lightIntensity,
    saturation: u.saturation, tint: u.tint, materialize: u.materialize,
    squircle: u.squircle, sheen: u.sheen, specPower: u.specPower,
    contactShadow: u.contactShadow, caustic: u.caustic, edgeLight: u.edgeLight,
    adaptivity: u.adaptivity, chromatic: u.chromatic, surfaceTension: u.surfaceTension,
  });
}

/**
 * Pure function. The glass fill's `proxyBackdrop` hook (materials.resolveProxyBackdrop):
 * the ONE translucent overlay rounded-rect thumbnails and the minimap draw over the
 * already-composited content INSTEAD of running the glass SkSL per pixel.
 *
 * Glass IS mostly a tinted veil (its interior is nearly clear), so the honest cheap
 * stand-in is that tint over the content beneath. `params.tint` is already the
 * [r,g,b,a] glassUniformParams produced, so the overlay is that colour at that
 * alpha. The default rgba(255,255,255,0.14) yields exactly the shared frost stand-in
 * ([1,1,1,0.14]); a dark preset (Smoked Obsidian) yields a DARK overlay, so the
 * thumbnail reads as a dark panel — the same lightens-when-it-should-darken defect
 * the frosted/brightness hooks exist to end. resolveProxyBackdrop validates the
 * channels (0..1) and treats alpha 0 as "draw no overlay".
 *
 * @param {{tint: number[]}} params - the fill op's params (glassUniformParams output)
 * @returns {{tint: [number, number, number, number]}} overlay colour, channels 0..1
 *
 * @example glassProxyBackdrop({tint: [1, 1, 1, 0.14]}) // {tint: [1, 1, 1, 0.14]}
 * @example glassProxyBackdrop({tint: [0.07, 0.07, 0.1, 0.62]}).tint[3] // 0.62
 */
export function glassProxyBackdrop(params) {
  const t = params.tint; // [r, g, b, a] — glassUniformParams already parsed it
  return { tint: [t[0], t[1], t[2], t[3]] };
}

/**
 * THE LIQUID GLASS MATERIAL DESCRIPTOR — the registry entry (materials.js). A
 * BACKDROP material (no `backdrop`/`sampler` flag ⇒ defaults to backdrop): its
 * `sksl` is GLASS_SKSL, whose two children are the standard {blurredBackdrop,
 * sharpBackdrop} pair handleMaterialBackdrop feeds. `usesBlurredBackdrop` is
 * OMITTED (defaults to build the blur) because the glass refraction really does
 * sample the blurred child. `maxSampleReach` mirrors the legacy glassRegion margin
 * (maxGlassDisplacement) so the fill gets glass's region-bounded backdrop instead
 * of a full-surface re-render. `title` is the paint-dropdown label
 * (PaintField reads `descriptor.title ?? id`). The legacy `glassBackdrop` op path
 * (the widget) does NOT use this entry.
 */
export const GLASS_MATERIAL = {
  id: "glass",
  title: "Liquid Glass",
  sksl: GLASS_SKSL,
  pack: packGlassMaterial,
  uniformFloats: GLASS_UNIFORM_FLOATS,
  fillParams: GLASS_FILL_PARAMS,
  toUniformParams: glassUniformParams,
  proxyBackdrop: glassProxyBackdrop,
  // SHAPE-CONFORMING FILL: the fill variant takes its region distance + rim normal
  // from the silhouette SDF child, so the refraction bevel and edge light follow the
  // real outline (a glass gear reads as a GLASS GEAR — rim on every tooth). The widget
  // path keeps GLASS_SKSL, byte-identical.
  usesShapeSdf: true,
  fillSksl: GLASS_FILL_SKSL,
  // The glass shader reads the blurred backdrop displaced OUTWARD along the rim
  // normal, up to maxGlassDisplacement(refractionDev, chromatic) — the same reach
  // the legacy glassRegion declares. Region-bounds the fill's backdrop re-render.
  maxSampleReach: (u) => maxGlassDisplacement(u.refractionStrength * u.scale, u.chromatic),
};

// ── the region boundary, in JS ────────────────────────────────────────────────
// The other half of the ONE curve definition (see the file header). The SkSL
// above answers "how far is this pixel from the boundary"; these answer "where IS
// the boundary", which is what a stroke, a shadow silhouette or a thumbnail
// stand-in needs. Both read the same clamps and the same rr/inner family, so a
// change to the shape is a change to both in one diff.

/**
 * Pure function. The clamped shape parameters the SkSL derives from the raw
 * uniforms — the single place the region's geometry is decided. Lengths are in
 * whatever unit the caller passes (WORLD for the outline, DEVICE for the shader).
 *
 *   n     = max(squircle, 2)                 // >= 2: never concave
 *   r     = min(cornerRadius, halfW, halfH)  // capsule-safe
 *   rr    = mix(r, half, tension)            // corner semi-axes
 *   inner = half - rr                        // inner rectangle (0 at tension 1)
 *
 * @param {number} halfW,halfH - region half-extents
 * @param {number} cornerRadius - requested corner radius
 * @param {number} squircle - corner Lp exponent
 * @param {number} surfaceTension - 0 (flat edges) .. 1 (pure superellipse)
 * @returns {{n: number, rrX: number, rrY: number, innerX: number, innerY: number}}
 *
 * @example glassShapeParams(220, 75, 48, 4, 0)
 * // {n: 4, rrX: 48, rrY: 48, innerX: 172, innerY: 27}
 * @example glassShapeParams(220, 75, 48, 4, 1)
 * // {n: 4, rrX: 220, rrY: 75, innerX: 0, innerY: 0}   (pure superellipse)
 * @example glassShapeParams(100, 60, 999, 4, 0).rrX // 60 (radius clamps to the shorter half-side)
 */
export function glassShapeParams(halfW, halfH, cornerRadius, squircle, surfaceTension) {
  const n = Math.max(squircle, 2);
  const t = Math.min(1, Math.max(0, surfaceTension));
  const r = Math.min(cornerRadius, Math.min(halfW, halfH));
  const rrX = r + t * (halfW - r);
  const rrY = r + t * (halfH - r);
  return { n, rrX, rrY, innerX: halfW - rrX, innerY: halfH - rrY };
}

/**
 * Pure function. Signed distance to the glass region — the JS twin of the SkSL
 * `sdGlassScaled` / `glassAniso` pair, transliterated from them operation for
 * operation (including the identity-pre-scale shortcut). It exists so the boundary
 * generator below can be PROVEN to sit on the shader's zero set instead of merely
 * looking like it does, and so bare-node code can reason about the region without
 * a GPU.
 *
 * @param {number} px,py - point in the region's LOCAL centered frame
 * @param {number} halfW,halfH - region half-extents
 * @param {number} cornerRadius,squircle,surfaceTension - shape knobs
 * @returns {number} negative inside, ~Euclidean distance in the input's units
 *
 * @example glassSdf(220, 0, 220, 75, 48, 4, 0) // 0  (on the flat right edge)
 * @example glassSdf(0, 0, 220, 75, 48, 4, 0) // -75  (centre, distance to the top edge)
 * @example Math.round(glassSdf(220, 40, 220, 75, 48, 4, 0)) // 0  (STILL on the edge: tension 0 is flat there)
 * @example Math.round(glassSdf(220, 40, 220, 75, 48, 4, 1)) // 4  (tension 1 has pulled the edge inward, so the point is now OUTSIDE)
 */
export function glassSdf(px, py, halfW, halfH, cornerRadius, squircle, surfaceTension) {
  const { n, rrX, rrY, innerX, innerY } = glassShapeParams(halfW, halfH, cornerRadius, squircle, surfaceTension);
  const ref = Math.max(rrX, rrY);
  const sX = rrX > 0 ? ref / rrX : 1;
  const sY = rrY > 0 ? ref / rrY : 1;
  const qX = (Math.abs(px) - innerX) * sX;
  const qY = (Math.abs(py) - innerY) * sY;
  const qpX = Math.max(qX, 0), qpY = Math.max(qY, 0);
  const d = (qpX ** n + qpY ** n) ** (1 / n) + Math.min(Math.max(qX, qY), 0) - ref;
  if (sX === 1 && sY === 1) return d; // identity pre-scale: no stretch to divide out
  let gX, gY;
  if (qpX > 0 || qpY > 0) {
    gX = qpX > 0 ? qpX ** (n - 1) : 0;
    gY = qpY > 0 ? qpY ** (n - 1) : 0;
  } else if (qX > qY) { gX = 1; gY = 0; } else { gX = 0; gY = 1; }
  const gn = Math.hypot(gX, gY);
  return gn > 0 ? d / (Math.hypot(sX * gX, sY * gY) / gn) : d;
}

// Maximum allowed deviation of the outline polyline from the true boundary, in
// DEVICE px — the flattening tolerance of the outline polyline. DERIVED, not
// chosen: the shader's own coverage antialias band is +-AA_PX = 1 device px, so an
// outline that never strays more than a tenth of that band cannot be seen to part
// company with the shader's edge — a stroke is at least a pixel wide and is itself
// antialiased. Not assumed either: glass_outline_test.js sweeps aspect x radius x
// exponent x tension x zoom and measures the deviation actually achieved.
export const GLASS_OUTLINE_MAX_SAGITTA_PX = 0.1;

/**
 * Pure function. A closed polyline ON the glass region's boundary, in the region's
 * LOCAL centered frame, at the SAME units the half-extents are given in. This is
 * what draws the hairline stroke, the drop-shadow silhouette and the thumbnail
 * stand-in, so all three follow the shader's own curve at every corner radius,
 * exponent and surface tension.
 *
 * THE POINTS ARE EXACT. Each corner quadrant comes from the closed-form Lame
 * parameterization
 *
 *     x = inner.x + rr.x * cos(theta)^(2/n)
 *     y = inner.y + rr.y * sin(theta)^(2/n)         theta in [0, pi/2]
 *
 * which satisfies ((x-inner.x)/rr.x)^n + ((y-inner.y)/rr.y)^n = 1 identically — so
 * every emitted point is on the SDF's zero set by construction. There is no Newton
 * or bisection refinement of the POSITIONS and therefore no residual to bound; the
 * only approximation anywhere is the straight CHORD between two exact points.
 *
 * THE CHORDS ARE ADAPTIVE. Rather than a global sample count from a curvature
 * bound, each chord is bisected in theta until it is flat enough, which is the
 * classic curve-flattening recursion and is output-sensitive: a nearly straight
 * stretch gets one segment, a tight nose gets many. (A closed-form count was tried
 * first and rejected: a lower bound on the minimum radius of curvature of an
 * ANISOTROPIC Lame arc is loose by an order of magnitude once the semi-axes differ
 * a lot, and a thin corner — say semi-axes 1e-6 by 37 device px, which a
 * near-zero-width panel produces — demanded hundreds of thousands of samples for a
 * curve whose total width is a millionth of a pixel.)
 *
 * Two stopping tests, both geometric, neither an iteration cap:
 *   * the mid-arc point is within GLASS_OUTLINE_MAX_SAGITTA_PX of the chord — the
 *     deviation is inside tolerance, so subdividing buys nothing;
 *   * the chord is itself shorter than that tolerance — it cannot deviate from
 *     anything by more than its own length, which is what guarantees termination
 *     (each bisection roughly halves the chord).
 *
 * The four straight runs of the inner rectangle need no samples at all: they fall
 * out as the segments joining one quadrant's last point to the next quadrant's
 * first, and they vanish on their own at tension 1, where inner is (0, 0).
 *
 * @param {number} halfW,halfH - region half-extents
 * @param {number} cornerRadius,squircle,surfaceTension - shape knobs
 * @param {number} deviceScale - local length -> device px (world.scale*zoom*dpr),
 *   so the flattening tolerance tracks how big the widget actually is on screen
 * @returns {Array<[number, number]>} closed loop (the first point is NOT repeated)
 *
 * @example glassOutlinePoints(100, 60, 0, 4, 0, 1)
 * // [[100, 60], [-100, 60], [-100, -60], [100, -60]]   (radius 0 -> the bare rectangle)
 * @example glassOutlinePoints(220, 75, 48, 4, 0, 2).length // 92
 * @example glassOutlinePoints(220, 75, 48, 4, 0, 2)[0] // [220, 27]  (start of the flat right edge)
 * @example glassOutlinePoints(220, 75, 48, 4, 1, 2).length // 138  (tension 1: all arc, no straight runs)
 * @example glassOutlinePoints(220, 75, 48, 4, 1, 8).length // 266  (zoomed in 4x: finer chords)
 */
export function glassOutlinePoints(halfW, halfH, cornerRadius, squircle, surfaceTension, deviceScale) {
  const { n, rrX, rrY, innerX, innerY } = glassShapeParams(halfW, halfH, cornerRadius, squircle, surfaceTension);
  const exponent = 2 / n;
  const arcAt = (theta) => [innerX + rrX * Math.cos(theta) ** exponent, innerY + rrY * Math.sin(theta) ** exponent];
  // The flattening tolerance, expressed in the caller's own units so every
  // comparison below is a plain local length.
  const tol = GLASS_OUTLINE_MAX_SAGITTA_PX / (deviceScale > 0 ? deviceScale : 1);

  const pts = [];
  const push = ([x, y]) => {
    const last = pts[pts.length - 1];
    if (last && last[0] === x && last[1] === y) return;
    pts.push([x, y]);
  };

  /** Emits the arc over (t0, t1], subdividing while the chord is too far from it. */
  function flatten(t0, t1, p0, p1, signX, signY) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const chord = Math.hypot(dx, dy);
    if (chord > tol) {
      const tm = 0.5 * (t0 + t1);
      const pm = arcAt(tm);
      // Perpendicular distance from the mid-arc point to the chord (2D cross
      // product over the chord length). Zero-length chords took the branch above.
      const deviation = Math.abs((pm[0] - p0[0]) * dy - (pm[1] - p0[1]) * dx) / chord;
      if (deviation > tol) {
        flatten(t0, tm, p0, pm, signX, signY);
        flatten(tm, t1, pm, p1, signX, signY);
        return;
      }
    }
    push([signX * p1[0], signY * p1[1]]);
  }

  // Walk the four quadrants in order, each swept in the direction that keeps the
  // loop continuous; consecutive quadrants are joined by the inner rectangle's
  // straight runs. [signX, signY, sweepBackwards]
  const QUADRANTS = [[1, 1, false], [-1, 1, true], [-1, -1, false], [1, -1, true]];
  const START = 0, END = Math.PI / 2;
  for (const [signX, signY, backwards] of QUADRANTS) {
    const t0 = backwards ? END : START, t1 = backwards ? START : END;
    const p0 = arcAt(t0);
    push([signX * p0[0], signY * p0[1]]);
    flatten(t0, t1, p0, arcAt(t1), signX, signY);
  }
  const first = pts[0], last = pts[pts.length - 1];
  if (pts.length > 1 && first[0] === last[0] && first[1] === last[1]) pts.pop();
  return pts;
}
