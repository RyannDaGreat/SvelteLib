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

import { parseColor } from "../ir.js";

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

// Pure (reads uniforms). The horizontal surface DIRECTION as a PARTITION-WEIGHTED
// blend of each ball's OWN outward gradient direction, using the SAME exp-softmin
// weights as blendAppearance: D = Σ ŵ_i · dir_i, dir_i = normalize(∇d_i), Σ ŵ_i = 1.
//
// WHY not normalize(∇F) like a lone bead: the smooth-union field has a SADDLE at a
// merge neck where ∇F → 0, so normalize(∇F) SPINS there → a shading singularity (the
// midpoint "pinch"/beak). Each individual dir_i is instead smooth everywhere (a ball's
// own outward direction), so blending them never divides a vanishing gradient. At a
// neck the two balls' directions are OPPOSED and their weights TIE, so they cancel:
// |D| → 0. Deep inside one ball that ball owns the pixel (ŵ_i → 1) so D = dir_i, |D| = 1
// — identical to the lone-bead normal. Thus |D| ∈ [0,1] is a DOMINANCE factor the dome
// folds in (Nxy = D·ω): full tilt where one ball dominates, flat (+z) at a contested
// neck. DIRECTION-ONLY (every dir_i is normalized) ⇒ the fixed-px central-difference
// step cancels ⇒ NO device-px magnitude anywhere ⇒ fully scale/zoom invariant.
float2 fieldNormalDir(float2 pl) {
  float minHalf = min(uHalfSize.x, uHalfSize.y);
  float unit = uUnit * minHalf;
  float k = max(uSmoothK * unit, BLEND_K_MIN_PX);   // same partition width as the appearance blend
  float eps = GRAD_EPS_PX;
  // pass 1 — nearest primitive distance (exp-softmin stability; cancels in the ratio).
  float dmin = FIELD_FAR;
  for (int i = 0; i < MAX_METABALLS; i++) {
    if (float(i) >= uBallCount) break;
    float type = uBalls[i * ${FIELDS_PER_BALL}];
    float2 c = float2((uBalls[i * ${FIELDS_PER_BALL} + 1] - 0.5) * 2.0 * uHalfSize.x,
                      (uBalls[i * ${FIELDS_PER_BALL} + 2] - 0.5) * 2.0 * uHalfSize.y);
    float r = max(uBalls[i * ${FIELDS_PER_BALL} + 3] * minHalf, 0.0);
    float el = max(uBalls[i * ${FIELDS_PER_BALL} + 4] * minHalf, 0.0);
    float ang = uBalls[i * ${FIELDS_PER_BALL} + 5];
    dmin = min(dmin, primitiveSDF(pl, type, c, r, el, ang));
  }
  // pass 2 — weighted sum of per-ball OUTWARD directions (central-difference gradient
  // of THIS primitive, normalized; magnitude discarded).
  float2 dsum = float2(0.0);
  float wsum = 0.0;
  for (int i = 0; i < MAX_METABALLS; i++) {
    if (float(i) >= uBallCount) break;
    float type = uBalls[i * ${FIELDS_PER_BALL}];
    float2 c = float2((uBalls[i * ${FIELDS_PER_BALL} + 1] - 0.5) * 2.0 * uHalfSize.x,
                      (uBalls[i * ${FIELDS_PER_BALL} + 2] - 0.5) * 2.0 * uHalfSize.y);
    float r = max(uBalls[i * ${FIELDS_PER_BALL} + 3] * minHalf, 0.0);
    float el = max(uBalls[i * ${FIELDS_PER_BALL} + 4] * minHalf, 0.0);
    float ang = uBalls[i * ${FIELDS_PER_BALL} + 5];
    float d = primitiveSDF(pl, type, c, r, el, ang);
    float w = exp(-(d - dmin) / k);
    float2 gi = float2(
      primitiveSDF(pl + float2(eps, 0.0), type, c, r, el, ang) - primitiveSDF(pl - float2(eps, 0.0), type, c, r, el, ang),
      primitiveSDF(pl + float2(0.0, eps), type, c, r, el, ang) - primitiveSDF(pl - float2(0.0, eps), type, c, r, el, ang)
    );
    float gl = length(gi);
    float2 diri = gl > 0.0 ? gi / gl : float2(0.0);   // own center: ω→0 makes this harmless
    dsum += w * diri;
    wsum += w;
  }
  return dsum / max(wsum, BLEND_EPS);
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

  // outward 2D horizontal direction — a PARTITION-WEIGHTED blend of each ball's OWN
  // outward direction (see fieldNormalDir), NOT normalize(∇F). |D| ≤ 1 is a DOMINANCE
  // factor: 1 where one ball owns the pixel (⇒ identical to the old lone-bead normal),
  // → 0 at a merge neck where opposed balls tie (⇒ flat +z, no singular pinch/beak).
  float2 D = fieldNormalDir(pl);

  // SPHERICAL-CAP dome coordinate ω: 1 at the rim (field ≈ 0), → 0 at the dome peak
  // (depth ≥ domeDepth). The 3D bead normal is (D·ω, √(1−ω²·|D|²)); for a lone ball
  // |D|=1 so this is exactly (∇F·ω, √(1−ω²)) as before — byte-identical, no regression.
  float domeDepth = max(uBulge * unit, 1.0);
  float t = max(-field, 0.0);                     // how deep inside the surface
  float omega = clamp(1.0 - t / domeDepth, 0.0, 1.0);
  float2 nlxy = D * omega;                        // horizontal normal, dominance-damped near necks
  float nz = sqrt(max(1.0 - dot(nlxy, nlxy), 0.0));
  // rotate the horizontal normal back to DEVICE space (refraction + light are screen-space)
  float2 Nxy = float2(cba * nlxy.x - sba * nlxy.y, sba * nlxy.x + cba * nlxy.y);
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

// The metaball primitive TYPE CODE the shader reads (mirrors the plugin's
// TYPE_CODE.sphere). A material FILL always synthesizes a single centered SPHERE
// (a lone water droplet filling the shape) — the tube/box selector is a widget-
// scene concern that needs a bbox aspect the fill mapping never sees.
const METABALL_SPHERE_CODE = 0;

// The fluid look default (the aqua droplet), moved out of the plugin so the ONE
// knob schema (below) lives beside the shader it drives. The colour's ALPHA is the
// "coloredness" — how strongly the fluid tints the refracted background.
const DEFAULT_FLUID_ALPHA = 0.35;
const DEFAULT_FLUID_RGB_HEX = "2fd9e0"; // aqua
export const DEFAULT_FLUID_COLOR = `#${DEFAULT_FLUID_RGB_HEX}${Math.round(DEFAULT_FLUID_ALPHA * 255).toString(16).padStart(2, "0")}`;
const LIGHT_ANGLE_DEFAULT = -Math.PI * 0.68; // direction TO the light: upper, slightly left — the water sheen

/**
 * THE METABALLS KNOB SCHEMA — the ONE declaration of the material's look knobs, in
 * the customProps row shape. Both consumers derive from it (the end-state ruling
 * "custom properties become material properties"):
 *   - plugins/demo/metaballs.js spreads it into its customProps (self.* rows),
 *     ADDING only its widget-side `shape` selector (the ball primitive, which needs
 *     the bbox aspect a fill never has — see METABALL_SPHERE_CODE);
 *   - the FILL-material UI renders it as the paint's param rows, resolved
 *     sparse-over-defaults by materials.resolveMaterialPaint.
 * `fluidColor` + `refraction` are the PER-BALL fluid material (they blend across a
 * widget-scene merge, and become the lone fill droplet's own appearance); the rest
 * are the GLOBAL surface + lighting knobs. `blurRadius`/`backdropScale` are op-level
 * render controls the fill router reads from resolvedParams (not shader uniforms).
 */
export const METABALLS_FILL_PARAMS = [
  // ── the fluid material (PER-WIDGET; blends across merges) ─────────────────────
  { name: "fluidColor", kind: "color", default: DEFAULT_FLUID_COLOR, label: "Fluid color", help: "The fluid's body color; its ALPHA is how strongly the fluid is colored (0 = clear water, 1 = fully colored). When two droplets merge, their colors BLEND — a red drop meeting a blue drop gives a purple neck." },
  { name: "refraction", kind: "number", default: 0.27, min: 0, label: "Refraction", help: "Maximum lens displacement (fraction of the mean ball radius) of the refracted background — how hard this droplet magnifies/bends the content beneath it. Blends across a merge with a neighbour's refraction." },
  // ── the field (merge + surface) — GLOBAL (leader-wide) ────────────────────────
  { name: "smoothK", kind: "number", default: 0.90, min: 0, label: "Merge (smooth-k)", help: "Smooth-union merge amount (fraction of the MEAN BALL RADIUS). 0 = a hard union of separate shapes; larger fuses neighbours (including balls from other metaball widgets) into one bulging blob with a smooth neck — THE metaball merge." },
  { name: "threshold", kind: "number", default: 0.08, min: 0, label: "Threshold", help: "Isosurface level (fraction of the mean ball radius): raises the fluid 'level' so every blob fattens and gaps close. Higher = plumper, more-merged droplets." },
  { name: "bulge", kind: "number", default: 0.80, min: 0.05, label: "Bulge", help: "Dome thickness (fraction of the mean ball radius): small = tall, sharply-curved beads (strong refraction); large = flatter puddles." },
  // ── the water look (reuses the glass refraction + lighting math) — GLOBAL ─────
  { name: "chromatic", kind: "number", default: 0.05, min: 0, label: "Chromatic", help: "Chromatic dispersion at the rim: the R/B channels refract slightly more/less than G. A tiny value gives a real colored-edge fringe; too much makes a rainbow swirl at each bead's core." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: LIGHT_ANGLE_DEFAULT, label: "Light angle", help: "Direction TO the light (screen space; -90° is straight above, 0° is from the right). The upper face of each bead catches the specular glint." },
  { name: "specular", kind: "number", default: 1.75, min: 0, label: "Specular", help: "Strength of the Blinn-Phong glint — the bright sparkle a real water droplet throws back at the light. The key water cue." },
  { name: "shininess", kind: "number", default: 66, min: 1, scrub: 0.5, label: "Shininess", help: "Specular exponent: higher = a tighter, sharper pinpoint glint; lower = a broad soft sheen." },
  { name: "fresnel", kind: "number", default: 0.95, min: 0, label: "Fresnel rim", help: "Brightness of the grazing rim, where a droplet catches a ring of the bright surroundings (environment reflection). Gives the bead its lit edge." },
  { name: "ambient", kind: "number", default: 0.28, min: 0, max: 1, label: "Contact shade", help: "Soft darkening on the unlit rim (0 = flat, higher = a rounder, seated bead). The shadow side that makes it read as 3D." },
  // ── render controls (world units + sample resolution) ────────────────────────
  { name: "blurRadius", kind: "number", default: 7, min: 0, label: "Environment blur", help: "Gaussian blur radius (world px) of the surroundings used for the fresnel rim glow. Softer = a smoother environment reflection." },
  { name: "backdropScale", kind: "number", default: 1.5, min: 0.25, max: 2, label: "Backdrop scale", help: "RESOLUTION FACTOR the content beneath is re-rendered at for the refraction: 1 = screen res, 2 = supersample (crisper droplets, slower), 0.5 = half res (faster, softer). The 0.25..2 bounds are a PERFORMANCE guard, not a look choice — below 0.25 the backdrop is uselessly coarse and above 2 the re-render cost balloons." },
];

/**
 * Pure function. The GLOBAL (leader-wide) surface + lighting knobs, passed straight
 * through by NAME (no unit conversion — lightAngle is already stored in radians via
 * the display:"degrees" bridge). THE one mapping both consumers share: the demo
 * widget's emit() (which adds the FUSED-SCENE balls) and the fill path's
 * metaballsFillUniformParams (which adds a lone centered sphere).
 *
 * @param {object} p - resolved knob params (every global knob present)
 * @returns {object} the packMetaballsUniforms global-knob subset
 *
 * @example metaballsGlobalParams({smoothK: 0.9, threshold: 0.08, chromatic: 0.05, lightAngle: -2.1, specular: 1.75, shininess: 66, fresnel: 0.95, bulge: 0.8, ambient: 0.28}).shininess // 66
 */
export function metaballsGlobalParams(p) {
  return {
    smoothK: p.smoothK,
    threshold: p.threshold,
    chromatic: p.chromatic,
    lightAngle: p.lightAngle,
    specular: p.specular,
    shininess: p.shininess,
    fresnel: p.fresnel,
    bulge: p.bulge,
    ambient: p.ambient,
  };
}

/**
 * Pure function. THE FILL mapping: schema params → packMetaballsUniforms params for
 * a material FILL of an arbitrary shape. A fill has no widget scene to fuse, so it is
 * ONE centered SPHERE filling the region (normalized coords: centre 0.5,0.5, radius
 * 1·minHalf, no elongation ⇒ aspect-free — identical to metaballRegion's lone-ball
 * output), carrying the schema's own `fluidColor` (alpha = coloredness) + `refraction`.
 * The global surface/light knobs pass through via metaballsGlobalParams. `blurRadius`
 * /`backdropScale` are DROPPED — the fill router reads them from resolvedParams.
 *
 * @param {object} p - resolved schema-shaped params (fluidColor, refraction, + globals)
 * @returns {object} packMetaballsUniforms-shaped params ({balls, ballCount, unit, …})
 *
 * @example metaballsFillUniformParams({fluidColor: "#2fd9e059", refraction: 0.27, smoothK: 0.9, threshold: 0.08, bulge: 0.8, chromatic: 0.05, lightAngle: -2.1, specular: 1.75, shininess: 66, fresnel: 0.95, ambient: 0.28}).ballCount // 1
 * @example metaballsFillUniformParams({fluidColor: "#000000", refraction: 0, smoothK: 0, threshold: 0, bulge: 0.5, chromatic: 0, lightAngle: 0, specular: 0, shininess: 1, fresnel: 0, ambient: 0}).balls.slice(0, 6) // [0, 0.5, 0.5, 1, 0, 0] (centered unit sphere)
 */
export function metaballsFillUniformParams(p) {
  const c = parseColor(p.fluidColor);
  const ball = [METABALL_SPHERE_CODE, 0.5, 0.5, 1, 0, 0, c[0], c[1], c[2], c[3], p.refraction];
  return { balls: ball, ballCount: 1, unit: 1, ...metaballsGlobalParams(p) };
}

/**
 * THE METABALLS MATERIAL DESCRIPTOR — the registry entry (materials.js). `id`
 * matches the plugin's `material` op field; `sksl` is the shader; `pack` maps the
 * framework's normalized `u` (device geometry + the material's own knobs) to the
 * uniform Float32Array. `backdrop: true` (explicit) selects the standard
 * {blurredBackdrop, sharpBackdrop} child pair + the below-content re-render.
 * `fillParams` + `toUniformParams` opt it into being a FILL on any shape (a lone
 * water droplet clipped to the shape — materials.isFillCapableMaterial).
 */
export const METABALLS_MATERIAL = {
  id: "metaballs",
  backdrop: true,
  sksl: METABALLS_SKSL,
  pack: packMetaballsUniforms,
  uniformFloats: METABALLS_UNIFORM_FLOATS,
  fillParams: METABALLS_FILL_PARAMS,
  toUniformParams: metaballsFillUniformParams,
};
