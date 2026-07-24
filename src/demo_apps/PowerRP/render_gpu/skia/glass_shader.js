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
 *   1. rotate p into the panel's LOCAL frame; SQUIRCLE (continuous-corner) SDF
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
 */

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

// Pure. Signed distance to a rounded rect with CONTINUOUS (squircle) corners:
// the corner quadrant uses an Lp norm (p = n) instead of Euclidean (p == 2), the
// standard superellipse construction of Apple-style continuous curvature. Flat
// edges are unaffected (only one component is positive there). <0 inside. p is
// LOCAL and centered (already rotated into the panel frame).
float sdSquircle(float2 p, float2 h, float r, float n) {
  float2 q = abs(p) - (h - r);
  float2 qp = max(q, 0.0);
  float corner = pow(pow(qp.x, n) + pow(qp.y, n), 1.0 / n);
  return corner + min(max(q.x, q.y), 0.0) - r;
}

// Pure. Outward unit normal of the region SDF via central differences (local frame).
float2 normalLocal(float2 p, float2 h, float r, float n) {
  float e = 1.0;
  float dx = sdSquircle(p + float2(e, 0.0), h, r, n) - sdSquircle(p - float2(e, 0.0), h, r, n);
  float dy = sdSquircle(p + float2(0.0, e), h, r, n) - sdSquircle(p - float2(0.0, e), h, r, n);
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

  float d = sdSquircle(pl, uHalfSize, r, n);
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);
  if (cov <= 0.0) { return half4(0.0); }          // outside region: contribute nothing
  float distInside = -d;
  float edge = 1.0 - smoothstep(0.0, uEdgeFalloff, distInside);
  float2 Nl = normalLocal(pl, uHalfSize, r, n);
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

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
const GLASS_UNIFORM_FLOATS = 24;

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
 *    chromatic}
 * @returns {Float32Array} length 24, in shader-uniform order
 *
 * @example
 * packGlassUniforms({cx:100,cy:80,halfW:60,halfH:40,cornerRadius:20,
 *   edgeFalloff:16,refractionStrength:10,angle:0,lightAngle:-1.57,
 *   lightIntensity:0.6,saturation:0.9,tint:[1,1,1,0.14],materialize:1,
 *   squircle:4,sheen:0.1,specPower:8,contactShadow:0.26,caustic:0.12,
 *   edgeLight:0.14,adaptivity:1,chromatic:0.08}).length // 24
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
