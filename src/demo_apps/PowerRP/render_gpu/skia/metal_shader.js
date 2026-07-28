/**
 * THE METAL FILL MATERIAL (id "metal") — a physically-plausible, ANALYTICALLY-lit
 * metal fill for any shape: brass / copper / steel / aluminum / chrome / silver /
 * gold, with linear + RADIAL brushing, a fake-environment reflection gradient,
 * bezel bands, edge wear, anglage, and CREVICE-COUPLED patina + rust that catch in
 * the recesses of the true outline. A FOREGROUND material (backdrop:false — it
 * synthesizes its whole look, sampling no composite) and SHAPE-CONFORMING
 * (usesShapeSdf:true — the silhouette SDF child drives the bevel, the fake normal,
 * the crevice mask, and the anglage line).
 *
 * ── WHY NO HDRI, WHY ANALYTIC (user ruling, manifest item 55) ──────────────────
 * "no HDRI, it's too complicated — regular lighting the way the glass components
 * have lighting." So the metal look is built from three analytic tricks, none of
 * which needs an environment texture:
 *   1. A fake "sky-ground" reflection gradient (frenzy 5): a 1D grey ramp indexed
 *      by the surface normal's Y — bright sky reflected on up-facing bevel, dark
 *      ground on down-facing — TINTED by the metal's F0. This is what makes a flat
 *      fill read as reflective metal instead of a coloured card.
 *   2. Schlick Fresnel per channel (frenzy 1): grazing angles whiten toward 1, the
 *      single cue that separates metal from plastic. Metal has ZERO diffuse; its
 *      colour is the tinted reflection, not a Lambert albedo.
 *   3. A two-light analytic rig (warm key + dim cool fill) + a specular highlight,
 *      exactly the glass_shader precedent.
 *
 * ── SHAPE CONFORMITY (standing codebase rule; corkboard/glass precedent) ───────
 * The bevel/rim, the fake normal (N.xy = grad·t, N.z from the unit), the crevice
 * mask for aging, and the anglage edge line ALL read the silhouette SDF child
 * (render_gpu/skia/shape_sdf.js), so a gear gets a gear-shaped bevel with patina in
 * its tooth roots — not a rectangle's rim cut to a gear. The SDF gradient (and, for
 * free, its Laplacian → local curvature: concave tooth roots vs convex tips) comes
 * from five taps of the F16 child — the approved no-derivative idiom (SkSL ES2 has
 * no dFdx), reusing the tack_fill/cork_fill central-difference pattern.
 *
 * ── SkSL ES2 BUDGET (frenzy 8) ─────────────────────────────────────────────────
 * No derivatives (SDF gradient via child taps). Fixed 3-octave fbm (compile-time
 * loop bound — a uniform-driven bound trips "SKSL Program too large"). Lighting /
 * fresnel / env accumulate in FLOAT (half banding on smooth metal ramps) with a
 * final interleaved-gradient-noise dither of ±1/255. Hammered dimples are a 3×3
 * Worley behind a uniform guard; measured to still compile on the CPU surface.
 *
 * ── THE TWO SkSL VARIANTS SHARE ONE PACKER ─────────────────────────────────────
 * METAL_SKSL (base, analytic rounded-rect SDF over the bbox — the fallback when a
 * shape has no silhouette field) and METAL_FILL_SKSL (the silhouette-SDF child) are
 * the SAME uniform block (packMetal) plus the SAME shading function (metalShade);
 * only how they obtain d / grad / laplacian differs. paint_skia picks the fill
 * variant whenever the op carries a shapeSdf (materialFillRaster), exactly as it
 * does for corkboard.
 *
 * DOM-free at import (string SkSL + pure packers), like glass_shader.js.
 */

import { parseColor } from "../ir.js";

// ── metalType → F0 tint (frenzy 1/5/7) ────────────────────────────────────────
// The reflectance colour that TINTS the fake-environment reflection and the
// specular. Stylized sRGB-domain tints (the shader works in sRGB 0..1 like every
// other material here), chosen so each reads as its metal against the grey env
// ramp: chromatic spec (RGB spread > 0.3) for brass/copper/gold, achromatic
// (spread < 0.03) for steel/aluminum/chrome/silver (frenzy 5's separator). Copper
// keeps R >> G > B (frenzy 7); brass is R≈G with B crushed (true yellow).
export const METAL_F0 = {
  brass:    "#d9b451", // warm yellow, R≈G, B crushed
  copper:   "#c07845", // pink-orange, R >> G > B
  steel:    "#b6bcc2", // neutral gunmetal, faintly cool
  aluminum: "#d7dde1", // bright cool near-white
  chrome:   "#c4ccd4", // achromatic, high-contrast env
  silver:   "#cfd0cd", // neutral, a hair warm-grey
  gold:     "#f0c651", // rich warm yellow
};
const METAL_F0_FALLBACK = "#b6bcc2"; // unknown metalType ⇒ steel (loud drop happens upstream at the schema)

// ── shared prelude: deterministic noise + env ramp + dither ───────────────────
// Pure SkSL, concatenated into BOTH variants BEFORE the uniform block, so it may
// not reference uniforms.
const PRELUDE = `
const int   FBM_OCTAVES = 3;          // frenzy 8: fixed small octave count (uniform-driven bound would blow the program)
const float FBM_GAIN = 0.5;
const float FBM_LAC  = 2.0;
const float HASH_X = 127.1;
const float HASH_Y = 311.7;
const float HASH_MUL = 43758.5453;

// Pure. Deterministic 2D hash -> [0,1). Value-noise lattice (frenzy 8: hash + smoothstep).
float hash21(float2 p) {
  float n = sin(dot(p, float2(HASH_X, HASH_Y))) * HASH_MUL;
  return fract(n);
}
// Pure. Value noise in [0,1], cubic-smooth interpolation of the hash lattice.
float vnoise(float2 x) {
  float2 i = floor(x), f = fract(x);
  float2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0)), d = hash21(i + float2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Pure. 3-octave fbm, range ~[0,1].
float fbm(float2 x) {
  float s = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  for (int o = 0; o < FBM_OCTAVES; o++) {
    s += amp * vnoise(x * freq);
    norm += amp; freq *= FBM_LAC; amp *= FBM_GAIN;
  }
  return s / norm;
}
// Pure. Rotate a 2-vector by angle a.
float2 rot2(float2 v, float a) {
  float c = cos(a), s = sin(a);
  return float2(c * v.x - s * v.y, s * v.x + c * v.y);
}
// Pure. Rounded-rect SDF (iq). <0 inside. p LOCAL & centered.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// Pure. The fake "sky-ground" 1D reflection ramp (frenzy 5), keyed on t in [0,1]
// (t = N.y*0.5+0.5): a greyscale environment the metal reflects, TINTED downstream
// by F0. Stops: 0 #2b2b2b, .22 #9a9a9a, .45 #f5f5f5, .55 #d8d8d8, .78 #6e6e6e, 1 #1a1a1a.
float skyGroundRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  float c = mix(0.169, 0.604, smoothstep(0.0, 0.22, t));
  c = mix(c, 0.961, smoothstep(0.22, 0.45, t));
  c = mix(c, 0.847, smoothstep(0.45, 0.55, t));
  c = mix(c, 0.431, smoothstep(0.55, 0.78, t));
  c = mix(c, 0.102, smoothstep(0.78, 1.0, t));
  return c;
}
// Pure. Interleaved-gradient-noise dither in [0,1) for a fragment (frenzy 8: ±1/255
// on the final colour to kill half-float banding on the smooth metal ramps).
float ign(float2 p) {
  return fract(52.9829189 * fract(dot(p, float2(0.06711056, 0.00583715))));
}
// Pure. 2D Worley: distance to the nearest of a 3×3 cell-jittered feature-point
// lattice, plus the DIRECTION to it. Returns float3(dist, dirx, diry). Drives the
// hammered-copper dimples (frenzy 7) — dist is a per-cell dome, dir perturbs N.
float3 worley(float2 x) {
  float2 ip = floor(x), fp = fract(x);
  float best = 8.0; float2 bestDir = float2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float2 g = float2(float(i), float(j));
      float2 o = float2(hash21(ip + g), hash21(ip + g + 17.0));
      float2 r = g + o - fp;
      float dd = dot(r, r);
      if (dd < best) { best = dd; bestDir = r; }
    }
  }
  float dist = sqrt(best);
  return float3(dist, dist > 1e-4 ? bestDir / dist : float2(0.0));
}
`;

// ── the shared uniform block (packMetal order) ────────────────────────────────
// Declared in BOTH variants (the fill variant prepends `uniform shader shapeSdf`).
const METAL_UNIFORMS = `
uniform float2 uCenter;      // region center (device px)
uniform float2 uHalfSize;    // region half-extents (device px)
uniform float  uCornerRadius;// analytic rounded-rect radius (device px; base variant only)
uniform float  uAngle;       // widget world rotation (radians)
uniform float  uScale;       // device px per WORLD unit (world-locked texture)
uniform float3 uF0;          // metalType reflectance tint (sRGB 0..1)
uniform float  uRoughness;   // 0 mirror .. 1 satin (drives spec exponent + streak)
uniform float  uBrushAmount; // 0..1 brushed-anisotropy strength
uniform float  uBrushAngle;  // linear brush direction (radians)
uniform float  uRadialBrush; // 0/1 radial (turned) vs linear brushing
uniform float2 uLightDir;    // direction TO the key light in SCREEN space (cos,sin)
uniform float  uWearAmount;  // 0..1 convex-edge wear (scrubs aging back to bare metal)
uniform float  uPatinaAmount;// 0..1 verdigris/tarnish coverage in recesses
uniform float3 uPatinaColor; // patina tone (sRGB 0..1)
uniform float  uRustCoverage;// 0..1 rust-spot coverage (independent of patina)
uniform float  uBevelWidth;  // bezel band width (device px)
uniform float  uSeed;        // texture seed (deterministic; NOT time)
uniform float  uWarmthBoost; // 0..1 extra R/G warmth (gold/copper)
uniform float  uRgbSplit;    // 0..1 env chromatic aberration (chrome)
uniform float  uHammerAmount;// 0..1 hammered dimple depth (copper)
`;

// ── the shared shading function — reads the uniforms, so it comes AFTER them ───
// Given the interior distance (device px, >0 inside), the OUTWARD unit silhouette
// gradient, the SDF Laplacian (curvature proxy: >0 concave / recess, <0 convex /
// tip), and the widget-local centered position, returns the lit metal colour.
const METAL_SHADE = `
const float LIGHT_Z = 0.55;        // key light lifted off the plane
const float BEVEL_SLOPE = 0.9;     // how hard the bevel band tilts the normal outward
const float ENV_NORMAL_W = 0.85;   // weight of N.y in the env ramp key (bevel reflection)
const float ENV_FACE_W = 0.22;     // weight of the broad face gradient (top-lit plate look)
const float SPEC_EXP_ROUGH = 6.0;  // Blinn exponent at roughness=1 (satin)
const float SPEC_EXP_SMOOTH = 340.0;// Blinn exponent at roughness=0 (polished)
const float SPEC_GAIN = 0.9;       // key-highlight strength
const float COOL_FILL = 0.10;      // dim cool fill from the opposite side
const float RIM_BOOST = 0.30;      // fresnel rim boost near the silhouette
const float BRUSH_CONTRAST = 0.55; // streak light/dark modulation
const float BRUSH_FREQ = 70.0;     // brush streak frequency (cycles per world unit)
const float BRUSH_JITTER = 0.06;   // tangent-angle jitter amplitude (radians)
const float RADIAL_RMIN = 12.0;    // clamp radius near center (frenzy 2 moire fix), device px
const float CREVICE_SPAN = 2.2;    // crevice band as a multiple of the bevel width
const float CURV_GAIN = 3.0;       // Laplacian -> curvature scale
const float PATINA_FREQ = 3.2;     // verdigris patch frequency (cycles per world unit)
const float PATINA_GAIN = 1.35;    // patina mask gain
const float WEAR_FREQ = 5.0;       // edge-wear grunge frequency
const float RUST_FREQ = 0.07;      // rust-SPOT frequency (LOW -> discrete blotches, not even oxidation)
const float ANGLAGE_W = 2.0;       // anglage bright-line band (device px)
const float ANGLAGE_BRIGHT = 0.5;  // anglage line brightness
const float HAMMER_FREQ = 3.4;     // hammered dimple frequency (cycles per world unit)
const float HAMMER_SLOPE = 0.5;    // hammered normal perturbation
const float3 RUST_PRIMARY = float3(0.717, 0.255, 0.055); // #B7410E
const float3 RUST_RECESS  = float3(0.353, 0.141, 0.063); // #5A2410 deep pitting

half3 metalShade(float distIn, float2 grad, float lap, float2 p) {
  // 2.5D bevel normal: tilt the surface outward within the bevel band, flat inside.
  float bw = max(uBevelWidth, 1.0);
  float bevelT = 1.0 - smoothstep(0.0, bw, distIn);   // 1 at the rim -> 0 in the interior
  float2 nxy = grad * bevelT * BEVEL_SLOPE;

  // world-locked texture coordinate (pan-stable, zoom-locked) + seed decorrelation.
  float2 tc = p / uScale + uSeed * 17.0;

  // hammered dimples perturb the normal per Worley cell (frenzy 7).
  if (uHammerAmount > 0.0) {
    float3 w = worley(tc * HAMMER_FREQ);
    float dome = 1.0 - w.x;                            // 1 at a cell centre (dome top)
    nxy += w.yz * dome * uHammerAmount * HAMMER_SLOPE;
  }
  float nz = sqrt(max(1e-3, 1.0 - dot(nxy, nxy)));
  float3 N = float3(nxy, nz);

  float3 L = normalize(float3(normalize(uLightDir), LIGHT_Z));
  float3 V = float3(0.0, 0.0, 1.0);
  float3 H = normalize(L + V);
  float NdotV = clamp(N.z, 0.0, 1.0);
  float NdotL = dot(N, L);
  float NdotH = max(dot(N, H), 0.0);

  // fresnel (whitens toward 1 at grazing — the metal-vs-plastic cue, frenzy 1).
  float fres = pow(1.0 - NdotV, 5.0);
  float3 f0 = uF0 * float3(1.0 + uWarmthBoost * 0.18, 1.0 + uWarmthBoost * 0.04, 1.0 - uWarmthBoost * 0.12);
  float3 tint = mix(f0, float3(1.0), fres);           // grazing reflection whitens

  // fake environment reflection: sky-ground ramp keyed on N.y + a broad face
  // gradient (top brighter), with optional per-channel split for chrome.
  float faceGrad = clamp(-p.y / (uHalfSize.y + 1.0), -1.0, 1.0);
  float envKey = clamp(0.5 + 0.5 * N.y * ENV_NORMAL_W + faceGrad * ENV_FACE_W, 0.0, 1.0);
  float split = uRgbSplit * 0.12;
  float3 env = float3(skyGroundRamp(envKey + split), skyGroundRamp(envKey), skyGroundRamp(envKey - split));

  // brushed anisotropy: streaks constant along the tangent, indexed by the
  // perpendicular coordinate only (frenzy 2). Radial uses arc-length-constant
  // grooves (theta * radius) with a near-centre radius clamp (moire fix).
  float streak = 1.0;
  if (uBrushAmount > 0.0) {
    float bcoord;
    if (uRadialBrush > 0.5) {
      float radius = max(length(p), RADIAL_RMIN);
      bcoord = atan(p.y, p.x) * radius * (BRUSH_FREQ / max(uScale, 1.0));
    } else {
      float2 B = float2(-sin(uBrushAngle), cos(uBrushAngle)); // perpendicular to the brush dir
      bcoord = dot(p, B) * (BRUSH_FREQ / max(uScale, 1.0));
    }
    float n = fbm(float2(bcoord, uSeed * 3.0));
    float jitter = (fbm(float2(bcoord * 0.5 + 11.0, uSeed)) - 0.5) * BRUSH_JITTER;
    streak = 1.0 + uBrushAmount * BRUSH_CONTRAST * (n - 0.5) * 2.0;
    envKey = clamp(envKey + jitter, 0.0, 1.0);
  }
  env *= streak;

  // body = tinted reflected environment; metal has NO diffuse albedo.
  float3 col = env * tint;

  // key specular highlight (Blinn), tightened by low roughness, brushed by streak.
  float shin = mix(SPEC_EXP_ROUGH, SPEC_EXP_SMOOTH, 1.0 - uRoughness);
  float spec = pow(NdotH, shin) * step(0.0, NdotL) * streak;
  col += f0 * spec * SPEC_GAIN;

  // dim cool fill light from the opposite side (frenzy 1: sells shape without an env).
  float3 Lc = normalize(float3(-normalize(uLightDir), LIGHT_Z * 0.6));
  col += COOL_FILL * max(dot(N, Lc), 0.0) * float3(0.82, 0.9, 1.0) * f0;

  // fresnel rim boost concentrated on the bevel (grazing catch-light).
  col += tint * fres * RIM_BOOST;

  // ── aging: crevice mask from the SDF (recesses catch patina/rust) ──────────
  // The curvature term is EDGE-GATED: the SDF Laplacian also spikes on the interior
  // MEDIAL AXIS (a rect's diagonals, a disc's centre), which is NOT a crevice — that
  // spike drew a spurious dark "X" of patina. Multiplying by edgeCrev keeps only the
  // concavity that sits NEAR the outline (gear tooth roots), where real grime collects.
  float edgeCrev = 1.0 - smoothstep(0.0, bw * CREVICE_SPAN, distIn);
  float concave = clamp(lap * CURV_GAIN, 0.0, 1.0) * edgeCrev; // concave AND near the edge
  float crevice = clamp(edgeCrev * 0.65 + concave * 0.8, 0.0, 1.0);

  if (uPatinaAmount > 0.0) {
    // domain-warped fbm patchiness (frenzy 3), thresholded.
    float2 warp = float2(fbm(tc * PATINA_FREQ * 1.3), fbm(tc * PATINA_FREQ * 1.3 + 7.0));
    float patch = smoothstep(0.35, 0.65, fbm(tc * PATINA_FREQ + 0.4 * warp));
    float mask = clamp(uPatinaAmount * crevice * patch * PATINA_GAIN, 0.0, 1.0);
    // oxide is DIELECTRIC: kill the metal, replace with matte Lambert-lit patina.
    float pd = 0.55 + 0.45 * max(NdotL, 0.0);
    col = mix(col, uPatinaColor * pd, mask);
  }

  if (uRustCoverage > 0.0) {
    // DISCRETE SPOTS: a low-frequency blob field places the spots (their COUNT rises with
    // rustCoverage via the threshold); a high-frequency speckle textures within each spot;
    // crevices bias where rust first takes hold.
    float blob = fbm(tc * RUST_FREQ + 31.0);
    float spots = smoothstep(1.0 - uRustCoverage, 1.0 - uRustCoverage * 0.45, blob + 0.25 * crevice);
    float speckle = 0.65 + 0.5 * fbm(tc * RUST_FREQ * 22.0);
    float mask = clamp(spots * speckle, 0.0, 1.0);
    float3 rcol = mix(RUST_PRIMARY, RUST_RECESS, crevice) * (0.75 + 0.4 * fbm(tc * RUST_FREQ * 40.0));
    float rd = 0.6 + 0.4 * max(NdotL, 0.0);
    col = mix(col, rcol * rd, mask);
  }

  // edge wear: convex edges scrubbed back to bright bare metal (frenzy 9), the
  // inverse of patina — biased to tips/crests by the convex curvature.
  if (uWearAmount > 0.0) {
    float convex = clamp(-lap * CURV_GAIN, 0.0, 1.0);
    float wear = clamp(uWearAmount * convex * edgeCrev * (0.5 + 0.5 * fbm(tc * WEAR_FREQ)), 0.0, 1.0);
    col = mix(col, env * f0 + f0 * spec, wear);
  }

  // anglage: a thin bright polished line on convex edges (frenzy 9 — the strongest
  // "expensive machined" tell), fading in just inside the silhouette.
  float convexE = clamp(-lap * CURV_GAIN, 0.0, 1.0);
  float line = (1.0 - smoothstep(ANGLAGE_W, ANGLAGE_W + 1.5, distIn)) * smoothstep(0.0, 1.5, distIn);
  col += float3(1.0) * line * convexE * ANGLAGE_BRIGHT;

  return half3(col);
}
`;

// ── the BASE variant: analytic rounded-rect SDF over the bbox (SDF-less fallback) ──
export const METAL_SKSL = PRELUDE + METAL_UNIFORMS + METAL_SHADE + `
const float ANALYTIC_EPS = 1.0;    // central-difference step for the analytic gradient/laplacian (device px)
half4 main(float2 fragCoord) {
  float2 p = rot2(fragCoord - uCenter, -uAngle);      // device -> widget-local, centered
  float d = sdRoundRect(p, uHalfSize, uCornerRadius);
  float cov = 1.0 - smoothstep(-1.0, 1.0, d);
  if (cov <= 0.0) return half4(0.0);
  float e = ANALYTIC_EPS;
  float dxp = sdRoundRect(p + float2(e, 0.0), uHalfSize, uCornerRadius);
  float dxm = sdRoundRect(p - float2(e, 0.0), uHalfSize, uCornerRadius);
  float dyp = sdRoundRect(p + float2(0.0, e), uHalfSize, uCornerRadius);
  float dym = sdRoundRect(p - float2(0.0, e), uHalfSize, uCornerRadius);
  float2 g = float2(dxp - dxm, dyp - dym);
  float glen = length(g);
  float2 grad = glen > 1e-4 ? g / glen : float2(0.0, 1.0);
  float lap = (dxp + dxm + dyp + dym - 4.0 * d) / (e * e);
  half3 col = metalShade(-d, grad, lap, p);
  col += half3(half((ign(fragCoord) - 0.5) / 255.0));
  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── the SHAPE-CONFORMING variant: the silhouette SDF child drives everything ──────
// d, the outward gradient AND the Laplacian all come from FIVE taps of the F16 SDF
// child (frenzy 8: no dFdx — the approved central-difference idiom, reusing the four
// gradient taps for the Laplacian). shapeSdf is child 0; the uniform block follows.
export const METAL_FILL_SKSL = PRELUDE + `
uniform shader shapeSdf;   // child 0: silhouette signed distance (device px, <0 inside)
` + METAL_UNIFORMS + METAL_SHADE + `
const float SDF_EPS = 1.5;         // SDF child central-difference step (device px)
half4 main(float2 fragCoord) {
  float d = shapeSdf.eval(fragCoord).r;
  float cov = 1.0 - smoothstep(-1.0, 1.0, d);
  if (cov <= 0.0) return half4(0.0);
  float e = SDF_EPS;
  float dxp = shapeSdf.eval(fragCoord + float2(e, 0.0)).r;
  float dxm = shapeSdf.eval(fragCoord - float2(e, 0.0)).r;
  float dyp = shapeSdf.eval(fragCoord + float2(0.0, e)).r;
  float dym = shapeSdf.eval(fragCoord - float2(0.0, e)).r;
  float2 g = float2(dxp - dxm, dyp - dym);
  float glen = length(g);
  float2 grad = glen > 1e-4 ? g / glen : float2(0.0, 1.0);
  float lap = (dxp + dxm + dyp + dym - 4.0 * d) / (e * e);
  float2 p = rot2(fragCoord - uCenter, -uAngle);      // widget-local (world-locked texture)
  half3 col = metalShade(-d, grad, lap, p);
  col += half3(half((ign(fragCoord) - 0.5) / 255.0));
  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── uniform packer ────────────────────────────────────────────────────────────
const METAL_UNIFORM_FLOATS = 27;

/** Pure. Asserts `v` is a finite number (a NaN uniform blackens a region — fail loudly). */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`metal pack: "${name}" must be a finite number, got ${v}`);
  return v;
}
/** Pure. A colour knob (string/array) -> [r,g,b] via the node-safe parseColor (alpha dropped). */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

/**
 * Pure function. Packs the metal material's uniforms in METAL_UNIFORMS declaration
 * order. `u` is the framework's normalized input (device geometry {cx,cy,halfW,
 * halfH,cornerRadius,angle} + `scale` = device px per world unit) merged with the
 * toUniformParams output ({f0, roughness, brushAmount, brushAngle[rad], radialBrush
 * [0/1], lightAngle[rad], wearAmount, patinaAmount, patinaColor, rustCoverage,
 * bevelWidthPct, seed, warmthBoost, rgbSplit, hammerAmount}). bevelWidthPct is a
 * percentage of the shortest HALF-extent, resolved to device px here.
 *
 * @param {object} u - device geometry + metalToUniformParams output
 * @returns {Float32Array} length 27
 *
 * @example packMetal({cx:0,cy:0,halfW:90,halfH:90,cornerRadius:0,angle:0,scale:1,
 *   f0:"#d9b451",roughness:0.25,brushAmount:0,brushAngle:0,radialBrush:0,
 *   lightAngle:-2.2,wearAmount:0,patinaAmount:0,patinaColor:"#43b3ae",rustCoverage:0,
 *   bevelWidthPct:8,seed:7,warmthBoost:0,rgbSplit:0,hammerAmount:0}).length // 27
 */
export function packMetal(u) {
  const f0 = rgb("f0", u.f0), patina = rgb("patinaColor", u.patinaColor);
  const a = num("lightAngle", u.lightAngle);
  const bevelDev = Math.max(Math.min(num("halfW", u.halfW), num("halfH", u.halfH)) * (num("bevelWidthPct", u.bevelWidthPct) / 100), 1);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("scale", u.scale),
    f0[0], f0[1], f0[2],
    num("roughness", u.roughness),
    num("brushAmount", u.brushAmount), num("brushAngle", u.brushAngle), num("radialBrush", u.radialBrush),
    Math.cos(a), Math.sin(a),
    num("wearAmount", u.wearAmount),
    num("patinaAmount", u.patinaAmount),
    patina[0], patina[1], patina[2],
    num("rustCoverage", u.rustCoverage),
    bevelDev,
    num("seed", u.seed),
    num("warmthBoost", u.warmthBoost),
    num("rgbSplit", u.rgbSplit),
    num("hammerAmount", u.hammerAmount),
  ]);
  if (out.length !== METAL_UNIFORM_FLOATS) throw new Error(`packMetal: ${out.length} floats, expected ${METAL_UNIFORM_FLOATS}`);
  return out;
}

// ── the fill-param SCHEMA (materials as PAINT on any shape) ────────────────────
// The consolidated knob schema (frenzy 10). metalType is a SELECT that DRIVES the
// F0 tint (metalToUniformParams maps it); every other knob is the shader's own.
export const METAL_FILL_PARAMS = [
  { name: "metalType", kind: "select", options: ["brass", "copper", "steel", "aluminum", "chrome", "silver", "gold"],
    optionLabels: { brass: "Brass", copper: "Copper", steel: "Steel", aluminum: "Aluminum", chrome: "Chrome", silver: "Silver", gold: "Gold" },
    default: "brass", help: "The base metal — sets the reflectance tint (F0). Brass/copper/gold read warm and chromatic; steel/aluminum/chrome/silver read cool and achromatic." },
  { name: "roughness", kind: "number", default: 0.25, min: 0, max: 1, help: "Surface finish: 0 = mirror-polished (a tight bright hotspot), 1 = satin/brushed (a broad soft sheen)." },
  { name: "brushAmount", kind: "number", default: 0, min: 0, max: 1, help: "Brushed-metal anisotropy strength — directional streaks that catch the light. 0 = smooth." },
  { name: "brushAngle", kind: "angle", default: 0, help: "Direction (degrees) the linear brushing runs. Ignored when Radial brush is on." },
  { name: "radialBrush", kind: "boolean", default: false, help: "On: circular/turned brushing radiating from the centre (a machined turntable finish). Off: straight linear brushing along Brush angle." },
  { name: "lightAngle", kind: "angle", default: -126, help: "Direction (degrees) TO the key light in screen space. Upper-left by convention — one global angle sells the whole scene." },
  { name: "wearAmount", kind: "number", default: 0, min: 0, max: 1, help: "Edge wear: scrubs aging back to bright bare metal on the convex edges/tips (the parts a thumb rubs)." },
  { name: "patinaAmount", kind: "number", default: 0, min: 0, max: 1, help: "Verdigris/tarnish coverage — collects in the recesses and crevices of the outline (tooth roots, the rim)." },
  { name: "patinaColor", kind: "color", default: "rgb(67,179,174)", help: "The patina tone. Verdigris teal for brass/copper; a dark sulfide brown for tarnished silver (before polishing)." },
  { name: "rustCoverage", kind: "number", default: 0, min: 0, max: 1, help: "How many rust spots — orange oxidation blotches, biased to the crevices. Independent of patina." },
  { name: "bevelWidth", kind: "number", default: 8, min: 0, max: 40, help: "Bezel band width as a percentage of the shortest side. The rim that catches the sky reflection and follows every tooth." },
  { name: "seed", kind: "number", default: 7, help: "Texture seed — changes the brushing/patina/rust pattern deterministically (NOT animated)." },
  { name: "warmthBoost", kind: "number", default: 0, min: 0, max: 1, help: "Extra warmth in the reflection — richer gold/copper. Leave at 0 for steel/aluminum." },
  { name: "rgbSplit", kind: "number", default: 0, min: 0, max: 1, help: "Chromatic aberration in the reflection — the colour-fringe sheen of polished chrome." },
  { name: "hammerAmount", kind: "number", default: 0, min: 0, max: 1, help: "Hammered dimples — a planished, hand-beaten copper surface of overlapping strike marks." },
];

const DEG2RAD = Math.PI / 180;

/**
 * Pure function. Maps the schema-shaped resolved params to the packer's params:
 * metalType (a select string) -> its F0 tint; the two angle knobs degrees -> radians;
 * the boolean -> 0/1; bevelWidth passed through as a percentage the packer resolves.
 * The seam paint_skia reads as `entry.toUniformParams` (comicUniformParams precedent).
 *
 * @param {object} p - resolved schema params (every knob present)
 * @returns {object} packMetal-shaped params
 *
 * @example metalToUniformParams({metalType:"copper",roughness:0.2,brushAmount:0,brushAngle:0,radialBrush:false,lightAngle:-126,wearAmount:0,patinaAmount:0,patinaColor:"#43b3ae",rustCoverage:0,bevelWidth:8,seed:7,warmthBoost:0,rgbSplit:0,hammerAmount:0}).f0 // "#c07845"
 * @example metalToUniformParams({metalType:"steel",roughness:0.1,brushAmount:0,brushAngle:90,radialBrush:true,lightAngle:0,wearAmount:0,patinaAmount:0,patinaColor:"#000",rustCoverage:0,bevelWidth:8,seed:1,warmthBoost:0,rgbSplit:0,hammerAmount:0}).radialBrush // 1
 */
export function metalToUniformParams(p) {
  return {
    f0: METAL_F0[p.metalType] ?? METAL_F0_FALLBACK,
    roughness: p.roughness,
    brushAmount: p.brushAmount,
    brushAngle: p.brushAngle * DEG2RAD,
    radialBrush: p.radialBrush ? 1 : 0,
    lightAngle: p.lightAngle * DEG2RAD,
    wearAmount: p.wearAmount,
    patinaAmount: p.patinaAmount,
    patinaColor: p.patinaColor,
    rustCoverage: p.rustCoverage,
    bevelWidthPct: p.bevelWidth,
    seed: p.seed,
    warmthBoost: p.warmthBoost,
    rgbSplit: p.rgbSplit,
    hammerAmount: p.hammerAmount,
  };
}

/**
 * Pure function. The metal PROXY stand-in (thumbnail quality): a solid fill of the
 * F0 tint, so a thumbnail reads as "a metal fill is here" with no per-pixel SkSL.
 * `params` is the packer-shaped op params (metalToUniformParams output ⇒ f0 present).
 *
 * @param {object} params - op params ({f0, ...})
 * @returns {{kind:"solid", color:[number,number,number,number]}}
 *
 * @example metalProxyFill({f0: "#d9b451"}).kind // "solid"
 * @example metalProxyFill({}).color[3] // 1
 */
export function metalProxyFill(params) {
  const c = parseColor(params.f0 ?? METAL_F0_FALLBACK);
  return { kind: "solid", color: [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, 1] }; // slightly darker than the tint (env-reflection mean)
}

// ── the material descriptor (registry entry) ──────────────────────────────────
export const METAL_MATERIAL = {
  id: "metal",
  sksl: METAL_SKSL,
  pack: packMetal,
  uniformFloats: METAL_UNIFORM_FLOATS,
  backdrop: false,
  usesShapeSdf: true,
  fillSksl: METAL_FILL_SKSL,
  fillParams: METAL_FILL_PARAMS,
  toUniformParams: metalToUniformParams,
  proxyFill: metalProxyFill,
};

// ── PRESETS (exported as data; the integrator merges into material_presets.js) ──
// A preset is {id, title, description?, params} with a SPARSE map of METAL_FILL_PARAMS
// knob names (material_presets.js shape). Every preset the user demanded, plus extras.
export const METAL_PRESETS = [
  { id: "polished_brass", title: "Polished Brass", description: "Mirror-bright yellow brass, a tight hotspot.",
    params: { metalType: "brass", roughness: 0.1, bevelWidth: 8, warmthBoost: 0.3 } },
  { id: "brushed_brass", title: "Brushed Brass", description: "Satin brass with straight linear brushing.",
    params: { metalType: "brass", roughness: 0.4, brushAmount: 0.8, brushAngle: 0, warmthBoost: 0.25 } },
  { id: "radial_brushed_brass", title: "Radially Brushed Brass", description: "Turned brass with circular brushing and darker patinaed crevices — the gear look.",
    params: { metalType: "brass", roughness: 0.42, brushAmount: 0.85, radialBrush: true, patinaAmount: 0.45, patinaColor: "rgb(74,63,42)", bevelWidth: 7, warmthBoost: 0.2 } },
  { id: "patina_brass", title: "Patina Brass", description: "Aged brass gone to green verdigris in the recesses.",
    params: { metalType: "brass", roughness: 0.5, patinaAmount: 0.85, patinaColor: "rgb(67,179,174)", wearAmount: 0.3, bevelWidth: 8 } },
  { id: "shiny_chrome", title: "Shiny Chrome", description: "Cold high-contrast chrome with a colour-split sheen.",
    params: { metalType: "chrome", roughness: 0.05, rgbSplit: 0.5, bevelWidth: 9 } },
  { id: "rusty_steel", title: "Rusty Steel", description: "Weathered steel eaten by rust spots, heaviest in the crevices.",
    params: { metalType: "steel", roughness: 0.6, rustCoverage: 0.7, patinaAmount: 0.2, patinaColor: "rgb(90,54,36)", wearAmount: 0.2, bevelWidth: 7 } },
  { id: "steel", title: "Steel", description: "Clean brushed stainless steel.",
    params: { metalType: "steel", roughness: 0.35, brushAmount: 0.6, brushAngle: 0, bevelWidth: 8 } },
  { id: "aluminum", title: "Aluminum", description: "Bright cool aluminum with a fine radial turn.",
    params: { metalType: "aluminum", roughness: 0.3, brushAmount: 0.5, radialBrush: true, bevelWidth: 8 } },
  { id: "copper", title: "Copper", description: "Warm pink-orange polished copper.",
    params: { metalType: "copper", roughness: 0.18, warmthBoost: 0.4, bevelWidth: 8 } },
  { id: "hammered_copper", title: "Hammered Copper", description: "Hand-planished copper of overlapping strike marks.",
    params: { metalType: "copper", roughness: 0.32, hammerAmount: 0.8, warmthBoost: 0.35, bevelWidth: 8 } },
  { id: "tarnished_silver", title: "Tarnished Silver", description: "Silver before polishing — crusty black sulfide in the crevices.",
    params: { metalType: "silver", roughness: 0.45, patinaAmount: 0.9, patinaColor: "rgb(43,27,18)", bevelWidth: 7 } },
  { id: "polished_silver", title: "Polished Silver", description: "Bright neutral silver, freshly polished.",
    params: { metalType: "silver", roughness: 0.08, bevelWidth: 8 } },
  { id: "gold", title: "Gold", description: "Rich warm polished gold.",
    params: { metalType: "gold", roughness: 0.12, warmthBoost: 0.5, bevelWidth: 9 } },
];
