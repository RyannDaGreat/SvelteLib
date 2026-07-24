/**
 * THE LENS FLARE material SkSL — a GENERATIVE (source) FOREGROUND material on the
 * reusable MATERIAL FRAMEWORK (render_gpu/skia/materials.js). It SYNTHESIZES a
 * physically-motivated motion-picture lens flare from a single light-source screen
 * position — ghost chain, anamorphic streak, halo ring, starburst spikes, chromatic
 * fringing, bloom/veiling glare, and a procedural dirt modulation — on a fully
 * TRANSPARENT field, so the widget composites ADDITIVELY over the scene beneath it
 * (the plugin defaults the shared effects-bundle blendMode to "screen").
 *
 * ── WHY A FOREGROUND (backdrop:false) MATERIAL ────────────────────────────────
 * Like the corkboard / raycast_dither family (and unlike glass/CRT backdrop
 * samplers), it samples NOTHING below it: every pixel is synthesized from uniforms.
 * So it rides the `materialFill` op + handleMaterialFill (paint_skia.js) — a plain
 * `effect.makeShader(uniforms)` fill with NO children, NO below-content re-render —
 * and the plugin wraps that ONE op in the effects bundle's effectSubtree with
 * blend:"screen" (render_gpu/effects.js applyEffects) to get the additive composite.
 * NO new IR op, NO backend edit.
 *
 * ── THE TECHNIQUES (procedural point-source family) ───────────────────────────
 * Grounded in the design note (.frenzy / task research), primarily:
 *   • mu6k's procedural `lensflare(uv,pos)` skeleton (ShaderToy 4sX3Rs): analytic
 *     discs/streaks/halo drawn from one light `pos`, no scene buffer.
 *   • John Chapman's "Pseudo Lens Flare" MATH reinterpreted for a point source:
 *     the GHOST CHAIN marches along the axis through the image centre
 *     (ghost i at lightPos·(1 − spacing·i) — the centred-space equivalent of
 *     Chapman's ghostVec = (0.5 − texcoord)·dispersal); CHROMATIC fringing via
 *     his textureDistorted idea (evaluate each feature at per-channel offsets);
 *     the HALO as a fixed-radius ring.
 *   • Anamorphic STREAK = an anisotropic Gaussian (σx ≫ σy), blue-tinted (Wronski).
 *   • STARBURST spike count from the aperture blade count — n spikes if n is even,
 *     2n if odd (diffraction physics) — rendered as pow(|cos(θ·S/2 + rot)|, sharp)
 *     × radial falloff, the rotation drivable per-frame.
 *   • Colour-TEMPERATURE tint (Kelvin→RGB, Tanner Helland) applied to the whole
 *     assembled flare, plus an explicit tint multiply.
 *
 * ── COORDINATE FRAME (aspect-correct, zoom/size-stable) ───────────────────────
 * `main(float2 fragCoord)` gets DEVICE px. It un-rotates the widget's world
 * rotation into a widget-local centred frame, then normalises by the HALF-HEIGHT
 * so the field is aspect-correct (y∈[-1,1], x∈[-aspect,aspect]) and identical at
 * any zoom/size — so a flare authored once holds when the widget is resized. The
 * light position is a [0,1] fraction of the widget (0.5,0.5 = centre), mapped into
 * the same centred frame. Ghosts reflect through the widget centre (the optical
 * axis), exactly like a real flare through the image centre.
 *
 * ── DETERMINISM (RenderTree = pure(document,[[slide,alpha]])) ─────────────────
 * The shader is a PURE function of (fragCoord, uniforms): no time, no Date.now, no
 * Math.random. The dirt/grunge is a pure hash of widget-local uv. Same doc ⇒
 * byte-identical pixels (starburst rotation is a plain keyframable knob, not a clock).
 *
 * DOM-free at import (only string SkSL + pure packers), like glass_shader.js /
 * corkboard_shader.js / raycast_dither_shader.js. `parseColor` (render_gpu/ir.js) is
 * the shared node-safe hex/rgb() parser — colour knobs pass through the op as
 * strings and are parsed HERE.
 */

import { parseColor } from "../ir.js";

// uCenter 2 + uHalfSize 2 + uAngle 1 = 5 (framework geometry)
//   + uLight 2 + 13 scalar knobs + uStreakColor 3 + uTempTint 3 + uTint 3
//   = 5 + 2 + 13 + 3 + 3 + 3 = 29 ... (enumerated + asserted below)
const LENS_FLARE_UNIFORM_FLOATS = 32;

/** Compile-time upper bound on the ghost chain (the SkSL loop is fixed-length and
 * gated by uGhostCount, so the count is a smooth keyframable knob). */
export const MAX_GHOSTS = 8;

export const LENS_FLARE_SKSL = `
// ── structural constants (WHY each; only the CHARACTER knobs are uniforms) ────
const float TWO_PI = 6.28318530718;
const float EPS    = 1e-4;             // guards normalize()/divide on degenerate inputs
const int   N_GHOSTS = ${MAX_GHOSTS}; // fixed loop bound; uGhostCount gates it

// ghost chain shaping ---------------------------------------------------------
const float GHOST_SIZE_NEAR = 0.55;    // disc radius (×uGhostSize) for the ghost nearest the light
const float GHOST_SIZE_FAR  = 1.9;     // disc radius (×uGhostSize) for the ghost nearest/past centre — real ghosts grow along the chain
const float GHOST_SOFT      = 0.55;    // soft-edge width as a fraction of the disc radius (0 = hard iris, 1 = all falloff)
const float GHOST_RING_W    = 0.16;    // gaussian width of the bright IRIS RIM at the disc edge
const float GHOST_FILL      = 0.58;    // weight of the filled disc body (bright enough that the iris discs read against a bright sky, not just a dark scene)
const float GHOST_RIM       = 0.75;    // weight of the iris rim (the crisp aperture edge)
const float GHOST_ROUNDNESS = 0.22;    // blend the polygon iris toward a circle (0 = sharp n-gon, 1 = round)
const float GHOST_VARY_BASE = 0.6;     // per-ghost intensity floor
const float GHOST_VARY      = 0.4;     // per-ghost intensity variation (hashed by index) so the chain is not uniform
const float GHOST_HASH_SEED = 12.9898; // standard shader-art angular hash seed
const float GHOST_HASH_MUL  = 43758.5453;

// halo ------------------------------------------------------------------------
const float HALO_THICK_FRAC = 0.12;    // ring gaussian thickness as a fraction of haloRadius
const float HALO_SIDE_BASE  = 0.35;    // halo brightness floor on the far (anti-light) side
const float HALO_SIDE_GAIN  = 0.65;    // extra halo brightness on the light side (dot with light dir)

// anamorphic streak -----------------------------------------------------------
const float STREAK_THICK    = 0.012;   // σy of the horizontal streak (thin = the razor JJ-Abrams line)
const float STREAK_HAZE_THICK = 5.0;   // the faint wider haze band is this × thicker in y
const float STREAK_HAZE_LEN = 1.7;     // and this × longer in x
const float STREAK_HAZE_GAIN = 0.4;    // weight of that haze band relative to the core streak

// starburst -------------------------------------------------------------------
const float STARBURST_FALLOFF = 4.0;   // radial fade of the spikes away from the light (bigger = shorter spikes)
const float MIN_BLADES = 3.0;          // an iris has at least 3 blades

// bloom / veiling glare -------------------------------------------------------
const float BLOOM_CORE_SIZE = 0.05;    // exp falloff length of the tight hot core at the light
const float BLOOM_VEIL_SIZE = 0.8;     // radius scale of the broad low-contrast veil (wide so a strong flare washes a large area)
const float BLOOM_VEIL_GAIN = 0.4;     // weight of the veil relative to the core (the atmospheric veiling glare the light casts across the frame)

// procedural dirt -------------------------------------------------------------
const float DIRT_SCALE = 5.5;          // grunge noise frequency in widget-uv
const float DIRT_OFFSET = 3.7;         // lattice offset so the dirt field is decorrelated from any other noise
const float DIRT_LO = 0.45;            // darkest the dirt modulation drives the flare at uDirt=1 (never fully black)

// fbm value-noise (shared shader-art constants; matches corkboard/raycast) -----
const float HASH_MUL_X = 123.34;
const float HASH_MUL_Y = 456.21;
const float HASH_ADD   = 45.32;
const int   FBM_OCTAVES = 3;
const float FBM_GAIN = 0.5;
const float FBM_LACUNARITY = 2.0;
const float SMOOTH3 = 3.0;
const float SMOOTH2 = 2.0;

// ── framework-set geometry (device px) — NOT user knobs ───────────────────────
uniform float2 uCenter;    // widget centre (device px)
uniform float2 uHalfSize;  // widget half-extents (device px)
uniform float  uAngle;     // widget world rotation (radians)
// ── user-tweakable knobs (self.* custom props) ────────────────────────────────
uniform float2 uLight;         // light position as a [0,1] fraction of the widget (0.5,0.5 = centre)
uniform float  uBrightness;    // overall additive gain on the whole flare
uniform float  uGhostCount;    // number of aperture ghosts along the axis (0..N_GHOSTS)
uniform float  uGhostSpacing;  // axis spacing: ghost i sits at lightPos·(1 − spacing·i)
uniform float  uGhostSize;     // ghost disc radius scale (normalized units)
uniform float  uGhostIntensity;// ghost chain brightness
uniform float  uAnamorphic;    // horizontal anamorphic streak intensity
uniform float  uStreakLength;  // σx of the streak (longer = wider horizontal flare)
uniform float3 uStreakColor;   // streak tint (classic anamorphic blue)
uniform float  uHalo;          // halo ring intensity
uniform float  uHaloRadius;    // halo ring radius (normalized, from the centre)
uniform float  uStarburst;     // diffraction-spike (starburst) intensity
uniform float  uBlades;        // aperture blade count → spikes = n (even) | 2n (odd)
uniform float  uStarburstSharp;// spike thinness (pow exponent; higher = razor spikes)
uniform float  uStarburstRot;  // starburst rotation (radians) — spikes swim with the camera
uniform float  uChromatic;     // chromatic dispersion amount (per-channel feature offset)
uniform float  uBloom;         // bloom / veiling-glare intensity at the source
uniform float  uDirt;          // procedural dirt/grunge modulation amount (0 = clean)
uniform float3 uTempTint;      // colour-temperature RGB (Kelvin→RGB, computed in the packer)
uniform float3 uTint;          // explicit tint multiply

// Pure. 2D white-noise hash -> [0,1). Same p => same value on a given backend.
float hash21(float2 p) {
  p = fract(p * float2(HASH_MUL_X, HASH_MUL_Y));
  p += dot(p, p + HASH_ADD);
  return fract(p.x * p.y);
}
// Pure. Value noise in [0,1] (smooth cubic interpolation of a hashed lattice).
float vnoise(float2 x) {
  float2 i = floor(x); float2 f = fract(x);
  float a = hash21(i);
  float b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0));
  float d = hash21(i + float2(1.0, 1.0));
  float2 u = f * f * (SMOOTH3 - SMOOTH2 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Pure. Fractal Brownian motion for the dirt grunge. Range ~[0,1].
float fbm(float2 x) {
  float s = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  for (int o = 0; o < FBM_OCTAVES; o++) {
    s += amp * vnoise(x * freq);
    norm += amp; freq *= FBM_LACUNARITY; amp *= FBM_GAIN;
  }
  return s / norm;
}
// Pure. Rotate a 2-vector by angle a (rows: [c -s; s c]).
float2 rot2(float2 v, float a) {
  float c = cos(a), s = sin(a);
  return float2(c * v.x - s * v.y, s * v.x + c * v.y);
}
// Pure. Deterministic scalar hash of a ghost index (per-ghost variation). -> [0,1).
float hash1(float n) { return fract(sin(n * GHOST_HASH_SEED) * GHOST_HASH_MUL); }

// Pure. Multiply length by this before comparing to a ghost radius so the iris
// reads as a regular polygon: for a blades-gon (apothem = size) the boundary at
// angle ang sits at length·cos(a)/size = 1, a = (ang mod seg) − seg/2. Blended
// toward a circle by roundness.
float ngonInv(float ang, float blades, float roundness) {
  float n = max(blades, MIN_BLADES);
  float seg = TWO_PI / n;
  float a = mod(ang, seg) - seg * 0.5;
  return mix(cos(a), 1.0, roundness);
}
// Pure. One ghost's scalar profile at a given disc radius 'size': a soft-edged
// polygon disc (fill) plus a bright iris RIM at the edge. 'd' is uv relative to
// the ghost centre.
float ghostProfile(float2 d, float size, float blades) {
  float ang = atan(d.y, d.x);
  float x = length(d) * ngonInv(ang, blades, GHOST_ROUNDNESS) / max(size, EPS); // 1 at the iris edge
  float body = 1.0 - smoothstep(1.0 - GHOST_SOFT, 1.0, x);
  float rim = exp(-((x - 1.0) * (x - 1.0)) / (GHOST_RING_W * GHOST_RING_W));
  return body * GHOST_FILL + rim * GHOST_RIM;
}
// Pure. A ghost as an RGB triple with CHROMATIC fringing: R/G/B sample the profile
// at slightly different radii (Chapman's textureDistorted, per-channel offset), so
// the iris rim splits into spectral colour. 'chroma' is the dispersion amount.
float3 ghostRGB(float2 d, float size, float blades, float chroma) {
  return float3(
    ghostProfile(d, size * (1.0 + chroma), blades),
    ghostProfile(d, size, blades),
    ghostProfile(d, size * (1.0 - chroma), blades));
}
// Pure. The halo ring's scalar profile: a gaussian annulus at radius 'radius'.
float haloProfile(float r, float radius, float thickness) {
  float x = (r - radius) / max(thickness, EPS);
  return exp(-x * x);
}
// Pure. Halo as an RGB triple with chromatic fringing (per-channel radius offset).
float3 haloRGB(float r, float radius, float thickness, float chroma) {
  return float3(
    haloProfile(r, radius * (1.0 + chroma), thickness),
    haloProfile(r, radius, thickness),
    haloProfile(r, radius * (1.0 - chroma), thickness));
}

half4 main(float2 fragCoord) {
  // device -> widget-local centred, then aspect-correct height-normalized uv.
  float2 pl = rot2(fragCoord - uCenter, -uAngle);
  float halfH = max(uHalfSize.y, 1.0);
  float aspect = uHalfSize.x / halfH;
  float2 uv = pl / halfH;                                   // y∈[-1,1], x∈[-aspect,aspect]
  float2 lightPos = float2((uLight.x * 2.0 - 1.0) * aspect, uLight.y * 2.0 - 1.0);

  float2 toLight = uv - lightPos;   // fragment relative to the light
  float rl = length(toLight);
  float rc = length(uv);            // fragment distance from the optical centre

  float3 flare = float3(0.0);

  // ── BLOOM / VEILING GLARE: a tight hot core + a broad low-contrast veil ──────
  float core = uBloom * exp(-rl / BLOOM_CORE_SIZE);
  float veil = uBloom * BLOOM_VEIL_GAIN / (1.0 + (rl / BLOOM_VEIL_SIZE) * (rl / BLOOM_VEIL_SIZE));
  flare += float3(core + veil);

  // ── GHOST CHAIN: analytic iris discs marching through the optical centre ─────
  float invCount = 1.0 / max(uGhostCount, 1.0);
  for (int i = 1; i <= N_GHOSTS; i++) {
    float fi = float(i);
    float on = step(fi - 0.5, uGhostCount);                 // 1 while i <= count (no divergent break)
    float t = fi * invCount;                                // 0..1 chain position
    float2 gc = lightPos * (1.0 - uGhostSpacing * fi);      // reflection through centre (Chapman axis march)
    float size = uGhostSize * mix(GHOST_SIZE_NEAR, GHOST_SIZE_FAR, t);
    float vary = GHOST_VARY_BASE + GHOST_VARY * hash1(fi);  // per-ghost brightness (not uniform)
    float3 g = ghostRGB(uv - gc, size, uBlades, uChromatic);
    flare += on * uGhostIntensity * vary * (1.0 - t * 0.5) * g;
  }

  // ── HALO RING: chromatic gaussian annulus about the centre, light-side biased ─
  float haloThick = uHaloRadius * HALO_THICK_FRAC;
  float3 haloC = haloRGB(rc, uHaloRadius, haloThick, uChromatic);
  float haloSide = HALO_SIDE_BASE + HALO_SIDE_GAIN * max(dot(normalize(uv + EPS), normalize(lightPos + float2(EPS))), 0.0);
  flare += uHalo * haloSide * haloC;

  // ── ANAMORPHIC STREAK: anisotropic gaussian (σx≫σy) + a faint wider haze band ─
  float sy = toLight.y, sx = toLight.x;
  float sigX = max(uStreakLength, EPS);
  float streak = exp(-(sy * sy) / (2.0 * STREAK_THICK * STREAK_THICK)) * exp(-(sx * sx) / (2.0 * sigX * sigX));
  float hazeThick = STREAK_THICK * STREAK_HAZE_THICK, hazeLen = sigX * STREAK_HAZE_LEN;
  float haze = exp(-(sy * sy) / (2.0 * hazeThick * hazeThick)) * exp(-(sx * sx) / (2.0 * hazeLen * hazeLen));
  flare += uAnamorphic * (streak + STREAK_HAZE_GAIN * haze) * uStreakColor;

  // ── STARBURST: diffraction spikes; spikeCount = n (even) | 2n (odd blades) ────
  float n = max(uBlades, MIN_BLADES);
  float isEven = step(mod(n, 2.0), 0.5);
  float spikeCount = n * (2.0 - isEven);
  float ang = atan(toLight.y, toLight.x);
  float spikes = pow(abs(cos((ang + uStarburstRot) * spikeCount * 0.5)), uStarburstSharp);
  float star = uStarburst * spikes * exp(-rl * STARBURST_FALLOFF);
  flare += float3(star);

  // ── PROCEDURAL DIRT: a gentle grunge modulation of the assembled flare ───────
  float grime = fbm(uv * DIRT_SCALE + DIRT_OFFSET);
  float dirtMask = mix(1.0, DIRT_LO + (1.0 - DIRT_LO) * grime, uDirt);
  flare *= dirtMask;

  // ── COLOUR + GAIN: temperature tint × explicit tint × overall brightness ─────
  flare *= uTempTint * uTint * uBrightness;

  // Premultiplied output (the corkboard/raycast convention). Alpha = the flare's
  // own intensity so it composites additively under blend:"screen" (the plugin
  // default) — and gracefully as a transparent-where-dark overlay under "normal".
  float3 c = clamp(flare, 0.0, 1.0);
  float a = clamp(max(max(c.r, c.g), c.b), 0.0, 1.0);
  return half4(half3(c) * half(a), half(a));
}
`;

// ── uniform packer ──────────────────────────────────────────────────────────

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens the whole
 * region — fail loudly). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`lensFlare pack: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string/array) -> its rgb triple [r,g,b] via the shared
 * node-safe parseColor. Alpha is dropped (a flare tint is an RGB multiply). */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

// Kelvin→RGB reference points (neutral at 6500 K). Values between are interpolated.
const KELVIN_MIN = 1000;
const KELVIN_MAX = 12000;
const KELVIN_NEUTRAL = 6500;
// (Kelvin, r, g, b) — a coarse fit of the Tanner Helland / Neil Bartlett curve,
// normalized so 6500 K ≈ white. Warm (low K) = amber; cool (high K) = blue.
const KELVIN_TABLE = [
  [1000, 1.00, 0.42, 0.10],
  [2000, 1.00, 0.58, 0.28],
  [3200, 1.00, 0.78, 0.55],
  [4500, 1.00, 0.89, 0.76],
  [5500, 1.00, 0.95, 0.90],
  [6500, 1.00, 1.00, 1.00],
  [8000, 0.85, 0.90, 1.00],
  [10000, 0.75, 0.83, 1.00],
  [12000, 0.69, 0.79, 1.00],
];

/**
 * Pure function. Colour temperature in Kelvin → an RGB TINT multiplier, normalized
 * so 6500 K is neutral white. A piecewise-linear read of KELVIN_TABLE (a coarse fit
 * of the Tanner Helland Kelvin→RGB curve). Warm (low K) skews amber, cool (high K)
 * skews blue — the cast a real light source lends the whole flare.
 *
 * @param {number} kelvin - colour temperature (clamped to [1000, 12000])
 * @returns {[number, number, number]} rgb multiplier, each in [0,1]
 *
 * @example kelvinToRGB(6500) // [1, 1, 1]
 * @example kelvinToRGB(3200) // [1, 0.78, 0.55]
 * @example kelvinToRGB(10000) // [0.75, 0.83, 1]
 */
export function kelvinToRGB(kelvin) {
  const k = Math.min(KELVIN_MAX, Math.max(KELVIN_MIN, num("colorTemp", kelvin)));
  for (let i = 1; i < KELVIN_TABLE.length; i++) {
    const [k1, r1, g1, b1] = KELVIN_TABLE[i];
    if (k <= k1) {
      const [k0, r0, g0, b0] = KELVIN_TABLE[i - 1];
      const f = (k - k0) / (k1 - k0);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  const last = KELVIN_TABLE[KELVIN_TABLE.length - 1];
  return [last[1], last[2], last[3]];
}

/**
 * Pure function. Packs the lens-flare uniforms into the flat Float32Array CanvasKit
 * expects (SkSL declaration order; float2=2, float3=3). `u` is the material
 * framework's normalized input: DEVICE-px region geometry {cx, cy, halfW, halfH,
 * angle} (+ the unused cornerRadius/scale the framework also supplies) plus this
 * material's already-evaluated knobs (the op's `params`). Colours pass through as
 * strings/arrays and are parsed here; colorTemp becomes an RGB tint via kelvinToRGB.
 *
 * @param {object} u {cx, cy, halfW, halfH, angle, lightX, lightY, brightness,
 *   ghostCount, ghostSpacing, ghostSize, ghostIntensity, anamorphic, streakLength,
 *   streakColor, halo, haloRadius, starburst, blades, starburstSharp, starburstRotation,
 *   chromatic, bloom, dirt, colorTemp, tint}
 * @returns {Float32Array} length 32
 *
 * @example packLensFlare({cx:0,cy:0,halfW:640,halfH:360,angle:0,lightX:0.72,lightY:0.28,
 *   brightness:1,ghostCount:5,ghostSpacing:0.32,ghostSize:0.08,ghostIntensity:0.25,
 *   anamorphic:0.3,streakLength:0.3,streakColor:"#99b3ff",halo:0.3,haloRadius:0.45,
 *   starburst:0.3,blades:8,starburstSharp:24,starburstRotation:0,chromatic:0.012,
 *   bloom:0.6,dirt:0.2,colorTemp:5500,tint:"#ffffff"}).length // 32
 */
export function packLensFlare(u) {
  const streak = rgb("streakColor", u.streakColor);
  const temp = kelvinToRGB(u.colorTemp);
  const tint = rgb("tint", u.tint);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("angle", u.angle),
    num("lightX", u.lightX), num("lightY", u.lightY),
    num("brightness", u.brightness),
    num("ghostCount", u.ghostCount),
    num("ghostSpacing", u.ghostSpacing),
    num("ghostSize", u.ghostSize),
    num("ghostIntensity", u.ghostIntensity),
    num("anamorphic", u.anamorphic),
    num("streakLength", u.streakLength),
    streak[0], streak[1], streak[2],
    num("halo", u.halo),
    num("haloRadius", u.haloRadius),
    num("starburst", u.starburst),
    num("blades", u.blades),
    num("starburstSharp", u.starburstSharp),
    num("starburstRotation", u.starburstRotation),
    num("chromatic", u.chromatic),
    num("bloom", u.bloom),
    num("dirt", u.dirt),
    temp[0], temp[1], temp[2],
    tint[0], tint[1], tint[2],
  ]);
  if (out.length !== LENS_FLARE_UNIFORM_FLOATS) throw new Error(`packLensFlare: ${out.length} floats, expected ${LENS_FLARE_UNIFORM_FLOATS}`);
  return out;
}

// ── material descriptor (registry entry) ──────────────────────────────────────
// FOREGROUND, GENERATIVE material: `backdrop: false` binds NO children and skips
// the below-content re-render — handleMaterialFill just makeShader+fill. `id`
// matches the plugin's `material` op field.
export const LENS_FLARE_MATERIAL = {
  id: "lens_flare",
  sksl: LENS_FLARE_SKSL,
  pack: packLensFlare,
  uniformFloats: LENS_FLARE_UNIFORM_FLOATS,
  backdrop: false,
};
