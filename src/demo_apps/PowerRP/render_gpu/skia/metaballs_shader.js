/**
 * The METABALLS SkSL material — Blender-style metaballs (metaSphere / metaTube /
 * metaSquare) that MERGE into smooth blobs and are lit + refracted so they read
 * as WATER DROPLETS on the content beneath them. A member of the reusable
 * MATERIAL FRAMEWORK (render_gpu/skia/materials.js), the same path CRT rides:
 * ONE `materialBackdrop` op, the shared below-content re-render, and the
 * standard {blurredBackdrop, sharpBackdrop} child pair — no new IR op, no
 * paint_skia edit.
 *
 * ── ONE BALL PER WIDGET, PER-WIDGET FLUID MATERIAL ────────────────────────────
 * Each metaball widget contributes exactly ONE ball (its bbox + a `shape`), and
 * the slide's balls FUSE across widgets (core/derive.collectMetaballScene). Each
 * ball carries its OWNING widget's FLUID APPEARANCE — a fluid color (rgb + a
 * "coloredness" strength) and a refraction amount — packed ALONGSIDE geometry.
 * At every pixel the appearance is a FIELD-WEIGHTED blend of the balls (below), so
 * a RED droplet merging a BLUE one shows a smooth PURPLE neck and refraction
 * crosses the neck with no seam — and changing any one widget's color/refraction
 * is visibly local to its lobe. Surface-SHAPE knobs (merge/threshold/dome) and
 * LIGHTING (light/specular/fresnel/ambient) stay GLOBAL: the fused surface is one
 * body under one light, so those are taken from the leader widget.
 *
 * ── THE FIELD (implicit surface) ──────────────────────────────────────────────
 * Each primitive contributes a 2D SIGNED DISTANCE (negative inside its surface):
 *   metaSphere — a disk:           d = |p − c| − r
 *   metaTube   — a capsule (SDF) between a−b of radius r
 *   metaSquare — a rounded box (SDF), half-extents (r+e, r), corner ρ
 * They are combined with the polynomial SMOOTH-MINIMUM (Inigo Quilez), whose
 * blend width `k` (uSmoothK) is the MERGE AMOUNT — larger k fuses neighbours into
 * one bulging blob with a smooth neck instead of a hard intersection:
 *
 *   smin(a, b, k) = mix(b, a, h) − k·h·(1 − h),   h = clamp(½ + (b−a)/(2k), 0, 1)
 *
 * The implicit SURFACE is the level set F(p) = uThreshold; inside is F < threshold
 * (raising the threshold fattens every blob, like a rising fluid level). Coverage
 * is the antialiased crossing of that level set.
 *
 * ── THE APPEARANCE BLEND (field-weighted partition of unity) ──────────────────
 * At a pixel, ball i's CONTRIBUTION weight is the exponential-softmin partition of
 * the SAME SDFs that drive the smooth-union:  w_i = exp(−(d_i − d_min)/k)  (d_min,
 * the nearest ball's distance, is subtracted for exp() stability and cancels in the
 * ratio). The blended fluid color / strength / refraction are Σ(w_i·x_i)/Σ(w_i).
 * Deep inside one ball w_i≈1 for that ball alone (its own color); at the neck the
 * two balls' weights are comparable (a smooth mix → the purple neck). k = the merge
 * width, so color blends over exactly the region geometry merges over.
 *
 * ── THE WATER LOOK (reuses the glass refraction + lighting math) ──────────────
 * The 2D field GRADIENT gives the outward surface normal; a SPHERICAL-CAP dome
 * coordinate `ω` (1 at the rim where the field ≈ threshold, → 0 at the dome peak
 * deep inside) lifts it to a 3D normal N = (∇F·ω, √(1−ω²)) — a bead that bulges
 * toward the viewer at its centre and turns grazing at its rim. Then, exactly as
 * glass_shader.js does:
 *   • REFRACTION — sample the SHARP backdrop displaced along the horizontal
 *     normal (a lens bend, with chromatic dispersion split across R/B at the rim);
 *     the displacement magnitude is the BLENDED per-ball refraction;
 *   • a FRESNEL rim that pulls in a soft ring of the BLURRED backdrop + white
 *     (the bright environment catch every water droplet has);
 *   • a Blinn-Phong SPECULAR glint from a top light (the signature water sparkle);
 *   • a subtle diffuse contact-shade on the far (unlit) rim for volume;
 *   • the BLENDED fluid color multiplies the refracted body at its blended strength
 *     (an absorptive tint — a real translucent colored fluid).
 *
 * Fully DETERMINISTIC — no time / no random; the droplet field is static.
 * DOM-free at import (only string SkSL + a pure packer), like crt_shader.js.
 */

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
// MAX_METABALLS/FIELDS_PER_BALL define the fixed uniform-array budget; the packer
// asserts the same numbers so a mismatch fails loudly.
// MAX_METABALLS is a GENEROUS cap: since the metaball archetype FUSES every
// metaball widget on the slide into one leader-emitted field (core/derive.
// collectMetaballScene), the array must hold the balls of MANY copy-pasted
// widgets — one ball each. 32 ≈ 32 single-ball widgets melting together; the
// per-pixel loop breaks at uBallCount, so an unused cap costs only array size,
// not shader work. Overflow is clamped + reported LOUDLY by the plugin (never
// silently dropped).
export const MAX_METABALLS = 32;   // slide-wide fused-ball budget (ballCount gates the active prefix)
// Per ball: geometry [type, cx, cy, r, elong, angle] + FLUID APPEARANCE
// [colR, colG, colB, colStrength, refraction]. Appearance is blended per-pixel by
// the field-weighted partition of unity so merges cross-fade color + refraction.
export const FIELDS_PER_BALL = 11;

export const METABALLS_SKSL = `
const int MAX_METABALLS = ${MAX_METABALLS};
const float AA_PX = 1.0;              // coverage antialias half-width (~1 device px)
const float FIELD_FAR = 1.0e6;        // smin seed: "no primitive yet" distance
const float GRAD_EPS_PX = 1.0;        // central-difference step for the field gradient (device px)
const float CAP_DENOM_EPS = 1.0e-3;   // guards the capsule's dot(ba,ba) division when a==b (zero-length tube => a disk)
const float BOX_ROUND = 0.5;          // metaSquare corner radius as a fraction of its short half-extent (rounded, not sharp — reads as a fat droplet)
const float BLEND_K_MIN_PX = 1.0;     // minimum appearance-blend width (device px): at merge=0, color/refraction switch over ~1px (crisp, AA-width) instead of dividing by zero
const float BLEND_EPS = 1.0e-4;       // guards the Σweight division in the appearance blend
const float FRESNEL_POWER = 3.0;      // grazing sharpness of the bright rim (higher = a thinner rim)
const float FRESNEL_WHITE = 0.6;      // the achromatic part of the rim catch-light
const float FRESNEL_ENV = 0.4;        // the part of the rim catch-light taken from the blurred surroundings (environment reflection)
const float LIGHT_ELEVATION = 0.7;    // how far the light tilts toward the viewer (z of the light dir): keeps the glint on the upper face, not the silhouette

uniform shader blurredBackdrop;  // child 0: Gaussian-blurred composite-so-far (device space) — the environment/rim glow source
uniform shader sharpBackdrop;    // child 1: the un-blurred composite-so-far (device space) — refracted through each bead
uniform float2 uCenter;          // region center (device px)
uniform float2 uHalfSize;        // region half-extents (device px)
uniform float uAngle;            // widget rotation (radians): rotate the field frame so a rotated widget stays correct
uniform float uBallCount;        // how many roster slots are active (0..MAX_METABALLS)
// per ball: type, cx, cy (0..1 of the region box), r, elong (fraction of region min
// half-size), angle(rad), fluid color R,G,B, color STRENGTH (coloredness), refraction.
uniform float uBalls[${MAX_METABALLS * FIELDS_PER_BALL}];
// uUnit is the FIELD's BALL-INTRINSIC reference length (a fraction of the region's
// min half-size = the MEAN ball radius). The merge/threshold/dome/refraction knobs
// scale by this — NOT the region min half-size — so the look is invariant to how
// big the fused UNION region is (two far-apart droplets in a huge region merge and
// dome exactly like two in a tight one; region size cancels for ball GEOMETRY, but
// would otherwise blow up these distance knobs). uUnit·minHalf = mean ball radius.
uniform float uUnit;             // reference length (mean ball radius) as a fraction of the region min half-size
// ── user-tweakable GLOBAL look knobs (leader widget's self.* custom props) ────
// (color + refraction are PER-BALL, packed in uBalls, and blended per pixel.)
uniform float uSmoothK;          // smooth-union MERGE amount (fraction of the MEAN BALL RADIUS): 0 = hard union, larger = blobs fuse
uniform float uThreshold;        // isosurface level (fraction of the MEAN BALL RADIUS): raises the "fluid level" so every blob fattens
uniform float uChromatic;        // chromatic dispersion at the rim (R/B sample a fraction more/less than G)
uniform float uLightAngle;       // in-plane direction TO the light (radians; -PI/2 = above), screen space
uniform float uSpecular;         // Blinn-Phong glint strength (the water sparkle)
uniform float uShininess;        // Blinn-Phong exponent: higher = a tighter, sharper glint
uniform float uFresnel;          // strength of the bright grazing rim
uniform float uBulge;            // dome thickness (fraction of the MEAN BALL RADIUS): small = tall peaked beads, large = flat puddles
uniform float uAmbient;          // contact shading on the unlit rim (0 = flat, higher = a rounder, seated bead)

// Pure. Signed distance to a disk. <0 inside.
float sdCircle(float2 p, float2 c, float r) { return length(p - c) - r; }

// Pure. Signed distance to a capsule (segment a→b, radius r). <0 inside. The
// dot(ba,ba) division is floored so a zero-length tube degrades to a disk.
float sdCapsule(float2 p, float2 a, float2 b, float r) {
  float2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), CAP_DENOM_EPS), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Pure. Signed distance to a rounded box centered at c, rotated by ang, with
// half-extents 'hs' and corner radius 'rad'. <0 inside.
float sdRoundBox(float2 p, float2 c, float ang, float2 hs, float rad) {
  float cb = cos(ang), sb = sin(ang);
  float2 d0 = p - c;
  float2 q = float2(cb * d0.x + sb * d0.y, -sb * d0.x + cb * d0.y); // into the box's local frame
  float2 dd = abs(q) - hs + rad;
  return length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0) - rad;
}

// Pure. One primitive's SDF from DECODED geometry (type code + centre/radius/elong/
// angle in device px/rad). Factored out of the ball loops so the field, the
// gradient, and the appearance blend share ONE definition (the uBalls indexing
// stays in each caller's loop, where SkSL requires loop-var array indices).
float primitiveSDF(float2 pl, float type, float2 c, float r, float e, float ang) {
  if (type < 0.5) {
    return sdCircle(pl, c, r);                                  // metaSphere
  } else if (type < 1.5) {
    float2 axis = float2(cos(ang), sin(ang)) * e;
    return sdCapsule(pl, c - axis, c + axis, r);                // metaTube
  }
  return sdRoundBox(pl, c, ang, float2(r + e, r), r * BOX_ROUND); // metaSquare
}

// Pure (reads uniforms). The combined metaball field at a LOCAL centered point
// pl (device px): the polynomial smooth-union of every active primitive's SDF.
// k is the merge width in device px. Returns the signed union distance (no
// threshold applied — the threshold is a constant offset, so the gradient of
// this function is the surface normal regardless).
float sceneField(float2 pl) {
  float minHalf = min(uHalfSize.x, uHalfSize.y);
  float unit = uUnit * minHalf;         // mean ball radius (device px) — the ball-intrinsic scale
  float k = uSmoothK * unit;            // merge width relative to a ball, NOT the (union) region
  float f = FIELD_FAR;
  for (int i = 0; i < MAX_METABALLS; i++) {
    if (float(i) >= uBallCount) break;
    // Indices must be loop-var arithmetic (i·stride + const) — an intermediate
    // int is rejected by SkSL as a non-constant index.
    float type = uBalls[i * ${FIELDS_PER_BALL}];
    float2 c = float2((uBalls[i * ${FIELDS_PER_BALL} + 1] - 0.5) * 2.0 * uHalfSize.x,
                      (uBalls[i * ${FIELDS_PER_BALL} + 2] - 0.5) * 2.0 * uHalfSize.y);
    float r = max(uBalls[i * ${FIELDS_PER_BALL} + 3] * minHalf, 0.0);
    float e = max(uBalls[i * ${FIELDS_PER_BALL} + 4] * minHalf, 0.0);
    float ang = uBalls[i * ${FIELDS_PER_BALL} + 5];
    float d = primitiveSDF(pl, type, c, r, e, ang);
    // smooth-union (IQ polynomial smin): fuse this primitive into the field.
    float h = clamp(0.5 + 0.5 * (d - f) / max(k, 1.0e-4), 0.0, 1.0);
    f = mix(d, f, h) - k * h * (1.0 - h);
  }
  return f;
}

// Pure (reads uniforms). FIELD-WEIGHTED blend of every ball's FLUID APPEARANCE at
// pl (see header): an exponential-softmin partition of unity over the SAME SDFs the
// smooth-union uses. Returns the blended fluid color, its blended strength
// (coloredness), and the blended refraction fraction via out-params. dmin (the
// nearest ball's distance) is subtracted for exp() stability; it cancels in the
// normalized ratio.
void blendAppearance(float2 pl, out float3 col, out float strength, out float refr) {
  float minHalf = min(uHalfSize.x, uHalfSize.y);
  float unit = uUnit * minHalf;
  float k = max(uSmoothK * unit, BLEND_K_MIN_PX);   // blend width tracks the MERGE knob
  // pass 1 — nearest ball distance (exp stability).
  float dmin = FIELD_FAR;
  for (int i = 0; i < MAX_METABALLS; i++) {
    if (float(i) >= uBallCount) break;
    float type = uBalls[i * ${FIELDS_PER_BALL}];
    float2 c = float2((uBalls[i * ${FIELDS_PER_BALL} + 1] - 0.5) * 2.0 * uHalfSize.x,
                      (uBalls[i * ${FIELDS_PER_BALL} + 2] - 0.5) * 2.0 * uHalfSize.y);
    float r = max(uBalls[i * ${FIELDS_PER_BALL} + 3] * minHalf, 0.0);
    float e = max(uBalls[i * ${FIELDS_PER_BALL} + 4] * minHalf, 0.0);
    float ang = uBalls[i * ${FIELDS_PER_BALL} + 5];
    dmin = min(dmin, primitiveSDF(pl, type, c, r, e, ang));
  }
  // pass 2 — exponential-softmin weighted appearance.
  float wsum = 0.0;
  float3 csum = float3(0.0);
  float asum = 0.0;
  float rsum = 0.0;
  for (int i = 0; i < MAX_METABALLS; i++) {
    if (float(i) >= uBallCount) break;
    float type = uBalls[i * ${FIELDS_PER_BALL}];
    float2 c = float2((uBalls[i * ${FIELDS_PER_BALL} + 1] - 0.5) * 2.0 * uHalfSize.x,
                      (uBalls[i * ${FIELDS_PER_BALL} + 2] - 0.5) * 2.0 * uHalfSize.y);
    float r = max(uBalls[i * ${FIELDS_PER_BALL} + 3] * minHalf, 0.0);
    float e = max(uBalls[i * ${FIELDS_PER_BALL} + 4] * minHalf, 0.0);
    float ang = uBalls[i * ${FIELDS_PER_BALL} + 5];
    float d = primitiveSDF(pl, type, c, r, e, ang);
    float w = exp(-(d - dmin) / k);
    csum += w * float3(uBalls[i * ${FIELDS_PER_BALL} + 6], uBalls[i * ${FIELDS_PER_BALL} + 7], uBalls[i * ${FIELDS_PER_BALL} + 8]);
    asum += w * uBalls[i * ${FIELDS_PER_BALL} + 9];
    rsum += w * uBalls[i * ${FIELDS_PER_BALL} + 10];
    wsum += w;
  }
  float inv = 1.0 / max(wsum, BLEND_EPS);
  col = csum * inv;
  strength = asum * inv;
  refr = rsum * inv;
}

half4 main(float2 p) {
  // device pixel → the widget's LOCAL centered frame (uAngle == 0 is axis-aligned).
  float cba = cos(uAngle), sba = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(cba * d0.x + sba * d0.y, -sba * d0.x + cba * d0.y);
  float minHalf = min(uHalfSize.x, uHalfSize.y);
  float unit = uUnit * minHalf;                   // mean ball radius (device px) — see uUnit

  float F = sceneField(pl);
  float thresh = uThreshold * unit;
  float field = F - thresh;                       // < 0 inside a droplet
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, field);
  if (cov <= 0.0) { return half4(0.0); }          // outside every droplet: contribute nothing

  // outward 2D normal from the field gradient (an SDF gradient is ~unit length).
  float e = GRAD_EPS_PX;
  float2 g = float2(
    sceneField(pl + float2(e, 0.0)) - sceneField(pl - float2(e, 0.0)),
    sceneField(pl + float2(0.0, e)) - sceneField(pl - float2(0.0, e))
  );
  float glen = length(g);
  float2 nl = glen > 0.0 ? g / glen : float2(0.0, -1.0);

  // SPHERICAL-CAP dome coordinate ω: 1 at the rim (field ≈ 0), → 0 at the dome
  // peak (depth ≥ domeDepth). The 3D bead normal is (∇F·ω, √(1−ω²)).
  float domeDepth = max(uBulge * unit, 1.0);
  float t = max(-field, 0.0);                     // how deep inside the surface
  float omega = clamp(1.0 - t / domeDepth, 0.0, 1.0);
  float nz = sqrt(max(1.0 - omega * omega, 0.0));
  // rotate the horizontal normal back to DEVICE space (refraction + light are screen-space)
  float2 Nxy = float2(cba * nl.x - sba * nl.y, sba * nl.x + cba * nl.y) * omega;
  float3 N = float3(Nxy, nz);

  // PER-BALL FLUID APPEARANCE — the field-weighted blend at this pixel (color +
  // its strength + refraction). This is what makes a red bead merging a blue bead
  // read purple at the neck, and refraction cross-fade across it.
  float3 fluidCol;
  float fluidStrength;
  float fluidRefr;
  blendAppearance(pl, fluidCol, fluidStrength, fluidRefr);

  // REFRACTION — a MAGNIFYING lens. Sample the SHARP backdrop displaced TOWARD
  // the bead centre (−Nxy): the horizontal slope |Nxy| = ω is greatest at the rim
  // and zero dead-centre, so the surroundings are pulled inward and enlarged
  // through the drop (a real convex water lens), clearest at its peak. Chromatic
  // dispersion splits R/B across the displacement (rim fringe). The displacement
  // magnitude is the BLENDED per-ball refraction.
  float refr = fluidRefr * unit;
  float2 disp = -Nxy * refr;
  float caAmt = uChromatic;
  half3 body = half3(
    sharpBackdrop.eval(p + disp * (1.0 - caAmt)).r,
    sharpBackdrop.eval(p + disp).g,
    sharpBackdrop.eval(p + disp * (1.0 + caAmt)).b
  );

  // FLUID COLOR: an absorptive tint — the refracted body multiplied by the blended
  // fluid color at the blended strength (0 = clear/colorless, 1 = fully colored).
  body = mix(body, body * half3(fluidCol), half(fluidStrength));

  // FRESNEL rim: the grazing edge (nz → 0) catches a bright ring of white +
  // blurred surroundings — the environment reflection on a real droplet.
  float fres = pow(1.0 - nz, FRESNEL_POWER) * uFresnel;
  half3 env = blurredBackdrop.eval(p).rgb;
  body = body + half3(fres) * (half3(FRESNEL_WHITE) + env * half(FRESNEL_ENV));

  // SPECULAR: Blinn-Phong glint from a top light (screen space), viewer straight
  // on (V = +z). The half-vector highlight lands on the upper flank of each bead.
  float3 L = normalize(float3(cos(uLightAngle), sin(uLightAngle), LIGHT_ELEVATION));
  float3 V = float3(0.0, 0.0, 1.0);
  float3 Hh = normalize(L + V);
  float spec = pow(max(dot(N, Hh), 0.0), max(uShininess, 1.0)) * uSpecular;

  // CONTACT SHADE: a soft darkening on the unlit rim (diffuse term, edge-weighted)
  // seats the bead and rounds it.
  float diffuse = 0.5 + 0.5 * dot(N, L);
  float shade = 1.0 - uAmbient * (1.0 - diffuse) * omega;

  half3 outc = body * half(shade) + half3(spec);
  return half4(outc * half(cov), half(cov));      // premultiplied
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
//   float2 uCenter(2) + float2 uHalfSize(2) + uAngle(1) + uBallCount(1)
//   + uBalls[MAX·11] + uUnit(1)
//   + uSmoothK/uThreshold/uChromatic/uLightAngle/uSpecular/uShininess/uFresnel/uBulge/uAmbient(9)
const METABALLS_UNIFORM_FLOATS = 2 + 2 + 1 + 1 + MAX_METABALLS * FIELDS_PER_BALL + 1 + 9;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens a whole
 * shader region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packMetaballsUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/**
 * Pure function. Packs the metaballs material's uniforms into the flat
 * Float32Array CanvasKit expects (uniform-declaration order; float2 = 2 slots,
 * the `uBalls` array = MAX_METABALLS·FIELDS_PER_BALL contiguous floats — CanvasKit
 * RuntimeEffect packs scalar arrays TIGHTLY, verified). The framework
 * (paint_skia.js handleMaterialBackdrop) resolves geometry to DEVICE px and
 * `angle` to radians before calling; the two child shaders are passed separately
 * to makeShaderWithChildren.
 *
 * `u.balls` is a flat [type, cx, cy, r, elong, angle, colR, colG, colB, colStrength,
 * refraction, …] list (length ≤ MAX_METABALLS·FIELDS_PER_BALL); shorter lists
 * zero-pad the roster tail (gated by ballCount anyway). Fluid COLOR and REFRACTION
 * are PER BALL (blended per pixel by the shader) — no global tint/refraction knob.
 *
 * @param {object} u - {cx, cy, halfW, halfH, angle (device px/rad), balls:number[],
 *   ballCount, unit, smoothK, threshold, chromatic, lightAngle, specular,
 *   shininess, fresnel, bulge, ambient}. `unit` is the mean ball radius as a
 *   fraction of the region's min half-size (the ball-intrinsic scale the distance
 *   knobs ride, so a big fused region does not over-merge).
 * @returns {Float32Array} length METABALLS_UNIFORM_FLOATS, in shader-uniform order
 *
 * @example
 * packMetaballsUniforms({cx:400,cy:300,halfW:380,halfH:210,angle:0,
 *   balls:[0,0.4,0.5,0.22,0,0, 1,0,0,0.5, 0.27,  0,0.6,0.55,0.2,0,0, 0,0,1,0.5, 0.1],
 *   ballCount:2,unit:0.21,smoothK:0.9,threshold:0.08,chromatic:0.04,
 *   lightAngle:-1.95,specular:0.9,shininess:40,fresnel:0.5,bulge:0.8,ambient:0.35}
 * ).length // 368 (2+2+1+1+352+1+9, MAX_METABALLS=32, FIELDS_PER_BALL=11)
 */
export function packMetaballsUniforms(u) {
  const ballsIn = Array.isArray(u.balls) ? u.balls : [];
  const balls = new Array(MAX_METABALLS * FIELDS_PER_BALL).fill(0);
  for (let i = 0; i < balls.length && i < ballsIn.length; i++) balls[i] = num(`balls[${i}]`, ballsIn[i]);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("angle", u.angle),
    num("ballCount", u.ballCount),
    ...balls,
    num("unit", u.unit),
    num("smoothK", u.smoothK),
    num("threshold", u.threshold),
    num("chromatic", u.chromatic),
    num("lightAngle", u.lightAngle),
    num("specular", u.specular),
    num("shininess", u.shininess),
    num("fresnel", u.fresnel),
    num("bulge", u.bulge),
    num("ambient", u.ambient),
  ]);
  if (out.length !== METABALLS_UNIFORM_FLOATS)
    throw new Error(`packMetaballsUniforms: packed ${out.length} floats, expected ${METABALLS_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE METABALLS MATERIAL DESCRIPTOR — the registry entry (materials.js). `id`
 * matches the plugin's `material` op field; `sksl` is the shader; `pack` maps the
 * framework's normalized `u` (device geometry + the material's own knobs) to the
 * uniform Float32Array. `backdrop: true` (explicit) selects the standard
 * {blurredBackdrop, sharpBackdrop} child pair + the below-content re-render.
 */
export const METABALLS_MATERIAL = {
  id: "metaballs",
  backdrop: true,
  sksl: METABALLS_SKSL,
  pack: packMetaballsUniforms,
  uniformFloats: METABALLS_UNIFORM_FLOATS,
};
