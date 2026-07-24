/**
 * The METABALLS SkSL material — Blender-style metaballs (metaSphere / metaTube /
 * metaSquare) that MERGE into smooth blobs and are lit + refracted so they read
 * as WATER DROPLETS on the content beneath them. A member of the reusable
 * MATERIAL FRAMEWORK (render_gpu/skia/materials.js), the same path CRT rides:
 * ONE `materialBackdrop` op, the shared below-content re-render, and the
 * standard {blurredBackdrop, sharpBackdrop} child pair — no new IR op, no
 * paint_skia edit.
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
 * ── THE WATER LOOK (reuses the glass refraction + lighting math) ──────────────
 * The 2D field GRADIENT gives the outward surface normal; a SPHERICAL-CAP dome
 * coordinate `ω` (1 at the rim where the field ≈ threshold, → 0 at the dome peak
 * deep inside) lifts it to a 3D normal N = (∇F·ω, √(1−ω²)) — a bead that bulges
 * toward the viewer at its centre and turns grazing at its rim. Then, exactly as
 * glass_shader.js does:
 *   • REFRACTION — sample the SHARP backdrop displaced along the horizontal
 *     normal (a lens bend, with chromatic dispersion split across R/B at the rim);
 *   • a FRESNEL rim that pulls in a soft ring of the BLURRED backdrop + white
 *     (the bright environment catch every water droplet has);
 *   • a Blinn-Phong SPECULAR glint from a top light (the signature water sparkle);
 *   • a subtle diffuse contact-shade on the far (unlit) rim for volume.
 *
 * Fully DETERMINISTIC — no time / no random; the droplet field is static.
 * DOM-free at import (only string SkSL + a pure packer), like crt_shader.js.
 */

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
// MAX_METABALLS/FIELDS_PER_BALL define the fixed uniform-array budget; the packer
// asserts the same numbers so a mismatch fails loudly.
export const MAX_METABALLS = 6;    // roster size (unused slots have ballCount gating)
export const FIELDS_PER_BALL = 6;  // per ball: [type, cx, cy, r, elong, angle]

export const METABALLS_SKSL = `
const int MAX_METABALLS = ${MAX_METABALLS};
const float AA_PX = 1.0;              // coverage antialias half-width (~1 device px)
const float FIELD_FAR = 1.0e6;        // smin seed: "no primitive yet" distance
const float GRAD_EPS_PX = 1.0;        // central-difference step for the field gradient (device px)
const float CAP_DENOM_EPS = 1.0e-3;   // guards the capsule's dot(ba,ba) division when a==b (zero-length tube => a disk)
const float BOX_ROUND = 0.5;          // metaSquare corner radius as a fraction of its short half-extent (rounded, not sharp — reads as a fat droplet)
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
uniform float uBalls[${MAX_METABALLS * FIELDS_PER_BALL}]; // per ball: type, cx, cy (0..1 of the box), r, elong (fraction of min half-size), angle(rad)
// ── user-tweakable look knobs (self.* custom props) ──────────────────────────
uniform float uSmoothK;          // smooth-union MERGE amount (fraction of the min half-size): 0 = hard union, larger = blobs fuse
uniform float uThreshold;        // isosurface level (fraction of the min half-size): raises the "fluid level" so every blob fattens
uniform float uRefraction;       // max lens displacement (fraction of the min half-size) of the refracted backdrop
uniform float uChromatic;        // chromatic dispersion at the rim (R/B sample a fraction more/less than G)
uniform float4 uTint;            // water tint color CAST (rgb, multiplies the body) + STRENGTH (a)
uniform float uLightAngle;       // in-plane direction TO the light (radians; -PI/2 = above), screen space
uniform float uSpecular;         // Blinn-Phong glint strength (the water sparkle)
uniform float uShininess;        // Blinn-Phong exponent: higher = a tighter, sharper glint
uniform float uFresnel;          // strength of the bright grazing rim
uniform float uBulge;            // dome thickness (fraction of the min half-size): small = tall peaked beads, large = flat puddles
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

// Pure (reads uniforms). The combined metaball field at a LOCAL centered point
// pl (device px): the polynomial smooth-union of every active primitive's SDF.
// k is the merge width in device px. Returns the signed union distance (no
// threshold applied — the threshold is a constant offset, so the gradient of
// this function is the surface normal regardless).
float sceneField(float2 pl) {
  float minHalf = min(uHalfSize.x, uHalfSize.y);
  float k = uSmoothK * minHalf;
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
    float d;
    if (type < 0.5) {
      d = sdCircle(pl, c, r);                                  // metaSphere
    } else if (type < 1.5) {
      float2 axis = float2(cos(ang), sin(ang)) * e;
      d = sdCapsule(pl, c - axis, c + axis, r);                // metaTube
    } else {
      d = sdRoundBox(pl, c, ang, float2(r + e, r), r * BOX_ROUND); // metaSquare
    }
    // smooth-union (IQ polynomial smin): fuse this primitive into the field.
    float h = clamp(0.5 + 0.5 * (d - f) / max(k, 1.0e-4), 0.0, 1.0);
    f = mix(d, f, h) - k * h * (1.0 - h);
  }
  return f;
}

half4 main(float2 p) {
  // device pixel → the widget's LOCAL centered frame (uAngle == 0 is axis-aligned).
  float cba = cos(uAngle), sba = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(cba * d0.x + sba * d0.y, -sba * d0.x + cba * d0.y);
  float minHalf = min(uHalfSize.x, uHalfSize.y);

  float F = sceneField(pl);
  float thresh = uThreshold * minHalf;
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
  float domeDepth = max(uBulge * minHalf, 1.0);
  float t = max(-field, 0.0);                     // how deep inside the surface
  float omega = clamp(1.0 - t / domeDepth, 0.0, 1.0);
  float nz = sqrt(max(1.0 - omega * omega, 0.0));
  // rotate the horizontal normal back to DEVICE space (refraction + light are screen-space)
  float2 Nxy = float2(cba * nl.x - sba * nl.y, sba * nl.x + cba * nl.y) * omega;
  float3 N = float3(Nxy, nz);

  // REFRACTION — a MAGNIFYING lens. Sample the SHARP backdrop displaced TOWARD
  // the bead centre (−Nxy): the horizontal slope |Nxy| = ω is greatest at the rim
  // and zero dead-centre, so the surroundings are pulled inward and enlarged
  // through the drop (a real convex water lens), clearest at its peak. Chromatic
  // dispersion splits R/B across the displacement (rim fringe).
  float refr = uRefraction * minHalf;
  float2 disp = -Nxy * refr;
  float caAmt = uChromatic;
  half3 body = half3(
    sharpBackdrop.eval(p + disp * (1.0 - caAmt)).r,
    sharpBackdrop.eval(p + disp).g,
    sharpBackdrop.eval(p + disp * (1.0 + caAmt)).b
  );

  // water TINT: a gentle multiplicative color cast, strength = uTint.a.
  body = mix(body, body * half3(uTint.rgb), half(uTint.a));

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
//   + uBalls[36] + uSmoothK/uThreshold/uRefraction/uChromatic(4) + float4 uTint(4)
//   + uLightAngle/uSpecular/uShininess/uFresnel/uBulge/uAmbient(6) = 56
const METABALLS_UNIFORM_FLOATS = 2 + 2 + 1 + 1 + MAX_METABALLS * FIELDS_PER_BALL + 4 + 4 + 6;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens a whole
 * shader region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packMetaballsUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/**
 * Pure function. Packs the metaballs material's uniforms into the flat
 * Float32Array CanvasKit expects (uniform-declaration order; float2 = 2 slots,
 * float4 = 4, the `uBalls` array = MAX_METABALLS·FIELDS_PER_BALL contiguous
 * floats — CanvasKit RuntimeEffect packs scalar arrays TIGHTLY, verified). The
 * framework (paint_skia.js handleMaterialBackdrop) resolves geometry to DEVICE px
 * and `angle` to radians before calling; the two child shaders are passed
 * separately to makeShaderWithChildren.
 *
 * `u.balls` is a flat [type, cx, cy, r, elong, angle, …] list (length ≤
 * MAX_METABALLS·FIELDS_PER_BALL); shorter lists zero-pad the roster tail (gated
 * by ballCount anyway). `u.tint` is a parsed [r, g, b, a] array.
 *
 * @param {object} u - {cx, cy, halfW, halfH, angle (device px/rad), balls:number[],
 *   ballCount, smoothK, threshold, refraction, chromatic, tint:[r,g,b,a],
 *   lightAngle, specular, shininess, fresnel, bulge, ambient}
 * @returns {Float32Array} length 56, in shader-uniform order
 *
 * @example
 * packMetaballsUniforms({cx:400,cy:300,halfW:380,halfH:210,angle:0,
 *   balls:[0,0.4,0.5,0.22,0,0, 0,0.6,0.55,0.2,0,0],ballCount:2,
 *   smoothK:0.35,threshold:0.05,refraction:0.18,chromatic:0.04,
 *   tint:[0.85,0.95,1,0.12],lightAngle:-1.95,specular:0.9,shininess:40,
 *   fresnel:0.5,bulge:0.5,ambient:0.35}).length // 56
 */
export function packMetaballsUniforms(u) {
  const ballsIn = Array.isArray(u.balls) ? u.balls : [];
  const balls = new Array(MAX_METABALLS * FIELDS_PER_BALL).fill(0);
  for (let i = 0; i < balls.length && i < ballsIn.length; i++) balls[i] = num(`balls[${i}]`, ballsIn[i]);
  const tint = Array.isArray(u.tint) ? u.tint : [1, 1, 1, 0];
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("angle", u.angle),
    num("ballCount", u.ballCount),
    ...balls,
    num("smoothK", u.smoothK),
    num("threshold", u.threshold),
    num("refraction", u.refraction),
    num("chromatic", u.chromatic),
    num("tintR", tint[0]), num("tintG", tint[1]), num("tintB", tint[2]), num("tintA", tint[3]),
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
