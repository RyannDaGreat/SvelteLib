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
 * ── KNOWN BOUND: THE STARBURST IS ANGULARLY ISOTROPIC ─────────────────────────
 * The spike profile is pow(|cos(θ·S/2 + rot)|, sharp) × a radial falloff, i.e. a
 * function of the ANGLE alone times a function of the RADIUS alone. Every spike is
 * therefore the same length and the S spikes are exactly evenly spaced — correct for a
 * spherical lens, and wrong for an ANAMORPHIC one, whose image is desqueezed by a
 * horizontal stretch of s (s = 2 for the standard squeeze). Under that stretch a real
 * diffraction star keeps almost none of its symmetry:
 *   • the S-fold rotational symmetry (8-fold on the 8-blade default) collapses to
 *     2-fold — only the horizontal and vertical axes survive as mirrors;
 *   • every off-axis ray rotates TOWARD the horizontal, θ ↦ atan(tan θ / s), so the
 *     diagonal ray at 45° lands at atan(1/2) = 26.57°, pulled by 18.43°;
 *   • the horizontal rays come out EXACTLY s times longer than the vertical ones.
 * None of the three is expressible in an angle-only profile: reaching them needs a
 * genuinely anisotropic starburst (an elliptical radial falloff plus a per-ray angle
 * remap), not another knob. So an anamorphic starburst cannot be rendered correctly
 * here AT ALL.
 *
 * This is a BOUND, not a defect, and it currently costs nothing: a real anamorphic
 * iris is round and high-blade-count, so it barely stars in the first place. Both
 * anamorphic presets in plugins/demo/lens_flare.js hold `starburst` near zero on that
 * independent physical ground — the value is right for two separate reasons, and the
 * bound only becomes visible the day someone authors an anamorphic look that stars.
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
 * ── THE FEATURE SCALE (uFlareScale) ──────────────────────────────────────────
 * Because the frame is HEIGHT-normalized, every feature's size is a fraction of the
 * widget's own height: enlarge the box and the whole flare enlarges with it, and
 * nothing in the shader can say otherwise. `uFlareScale` is the one knob that
 * DECOUPLES the flare's internal feature size from the box size — a master
 * multiplier on every normalized LENGTH, so a full-frame box can still carry a
 * small flare (and vice versa) without touching six separate knobs.
 *
 * It scales SIZES ONLY, and it does it by DILATING THE SPACE each feature is measured
 * in ABOUT THAT FEATURE'S OWN CENTRE: divide the measuring offset by the scale and
 * every length that offset is compared against grows by it, while the centre itself
 * does not move. That single mechanism reaches all five features — the ghost discs
 * (about each ghost), the halo ring AND its derived rim thickness (about the optical
 * centre), the anamorphic streak's σx and σy together, so it grows isotropically and
 * keeps its aspect (about the light), the bloom's hot core and veiling glare (about
 * the light), and the starburst spike LENGTH (about the light; the spike ANGLE reads
 * the UNSCALED offset, because an angle is not a length). Four of those lengths — the
 * streak thickness, both bloom radii and the spike falloff — were structural constants
 * with no knob at all, so the scale is the only way to reach them.
 *
 * DELIBERATELY EXCLUDED, with reasons:
 *   • THE LIGHT POSITION (uLight) — a POSITION, and the one the user placed by
 *     dragging its own handle. Scaling it would teleport the sun.
 *   • THE GHOST CHAIN'S AXIAL POSITIONS (uGhostSpacing) — also POSITIONS, along the
 *     light→centre axis. A positional scale needs a fixed point and the flare has
 *     no free one: the geometry is pinned at BOTH ends (the light, and the optical
 *     centre the chain reflects through), so fixing either moves the other. Sizes
 *     need no fixed point at all, which is exactly why the scale is a size scale.
 *     It also keeps uFlareScale = 0 meaning "every feature vanishes" rather than
 *     "the ghosts pile up on the light".
 *   • uChromatic — already DIMENSIONLESS: it is a per-channel radius RATIO
 *     (size·(1±chroma)), so it rides each feature's scaled size automatically.
 *   • uBlades / uStarburstSharp / uStarburstRot — angular or exponential, not lengths.
 *   • THE DIRT FIELD (uDirt, DIRT_SCALE) — grime sits on the FRONT ELEMENT, fixed in
 *     the frame. It is not part of the flare pattern and must not breathe when the
 *     flare's features resize.
 *   • Every INTENSITY (uBrightness, uGhostIntensity, uHalo, uAnamorphic, uStarburst,
 *     uBloom) — brightness is uBrightness's job, not this one's.
 *
 * uFlareScale = 1 is the IDENTITY, byte-for-byte. Every use is a DIVIDE OF THE
 * MEASURING OFFSET by exactly 1.0, which is exact in IEEE-754, and — the reason this
 * formulation was chosen over multiplying each size — every size CONSTANT stays a
 * literal in the expression that consumed it, so nothing the compiler used to fold at
 * compile time is demoted to runtime float arithmetic. (Verified the hard way: the
 * first attempt scaled each size instead, which folded `2.0*STREAK_THICK*STREAK_THICK`
 * and `rl/BLOOM_CORE_SIZE` into runtime multiplies and shifted real pixels at
 * flareScale 1 — mathematically identical, not bit-identical. A document that predates
 * this knob now renders byte-identically once the repair pass fills the default.)
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
// UNIT_SPAN_SCRUB (core/properties.js) is the scrub sensitivity for the UNBOUNDED
// normalized knobs in the fill-param schema below (the light position, the dirt mix,
// the feature scale, the glow). Imported here because THE KNOB SCHEMA now lives in
// this shader file (the fill-material single-declaration rule) — rainy_window_shader.js
// imports the same constant for the same reason. core/ is DOM-free / bare-node-safe.
import { UNIT_SPAN_SCRUB } from "../../core/properties.js";
// MIN_POLYGON_BLADES (core/optics.js) is the SAME fact as this file's own
// MIN_BLADES: the fewest leaves that enclose a polygon. R6-3.11 requires the
// flare and plugins/aperture.js to agree about what a blade count MEANS, and a
// floor written out twice is the hand-maintained-mirror defect — so the row's
// bound is imported rather than transcribed. The SkSL copy below cannot import
// anything, so it stays a literal and tests/aperture_test.js gates it against
// this constant by reading the shader's own source text.
import { MIN_POLYGON_BLADES } from "../../core/optics.js";

// uCenter 2 + uHalfSize 2 + uAngle 1 = 5 (framework geometry)
//   + uLight 2 + 17 scalar knobs + uStreakColor 3 + uTempTint 3 + uTint 3
//   = 5 + 2 + 17 + 3 + 3 + 3 = 33 (enumerated + asserted below)
const LENS_FLARE_UNIFORM_FLOATS = 33;

/** Compile-time upper bound on the ghost chain (the SkSL loop is fixed-length and
 * gated by uGhostCount, so the count is a smooth keyframable knob). */
export const MAX_GHOSTS = 8;

export const LENS_FLARE_SKSL = `
// ── structural constants (WHY each; only the CHARACTER knobs are uniforms) ────
const float TWO_PI = 6.28318530718;
const float EPS    = 1e-4;             // guards normalize()/divide AND pow() BASES on degenerate inputs
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
// TECHNICAL guard, NOT a taste bound. The spike profile is pow(|cos θ|, sharp), and
// |cos θ| is EXACTLY 0 along the rays perpendicular to each spike. pow(0, e) is
// well-defined only for e > 0: at e <= 0 the shading language leaves it UNDEFINED, so
// whatever a given backend happens to return there is non-deterministic and would break
// RenderTree = pure(document,...). Flooring the BASE (never the exponent) makes the
// profile total for every exponent, which is what lets uStarburstSharp reach 0.
// Same value + same technique as this file's ghost-size / halo-thickness / streak-σ
// divide guards, and as sky_shader.js's own pow(max(·, EPS), ·) phase/airmass guards.
const float SPIKE_BASE_EPS = EPS;

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
uniform float  uFlareScale;    // MASTER FEATURE SIZE: dilates the space each feature is measured in (see THE FEATURE SCALE)
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

  // THE FEATURE SCALE, guarded once (see the header note for what it scales and
  // what it deliberately does not). The max() is the SAME technique, the SAME EPS
  // and the SAME reason as this file's ghost-size / halo-thickness / streak-sigma /
  // SPIKE_BASE_EPS guards: it makes every length below TOTAL. Without it,
  // uFlareScale = 0 divides by zero at the exact light pixel (0/0 -> NaN, which
  // blackens the whole region), and a NEGATIVE value inverts the bloom core's
  // exponential to +inf (NaN once uBloom is 0). Flooring here means 0 and every
  // negative collapse to a sub-pixel point — "off", deterministically. The knob's
  // own row carries min 0 precisely so a negative is REFUSED at the Inspector
  // rather than silently swallowed here (plugins/demo/lens_flare.js bounds policy).
  float fscale = max(uFlareScale, EPS);
  // Each feature is scaled by DILATING THE SPACE IT IS MEASURED IN about its OWN
  // centre — dividing the measuring offset by fscale is algebraically identical to
  // multiplying that feature's radius/sigma by it, and it leaves every CENTRE (the
  // light, each ghost, the optical axis) exactly where it was. Two things follow for
  // free: a derived size like the halo's thickness-as-a-fraction-of-radius scales
  // WITH its radius automatically, and every size CONSTANT below stays a literal the
  // compiler can still fold — so at fscale = 1 the divides are exact identities and
  // the arithmetic is bit-for-bit what it was before this knob existed.
  float rlS = rl / fscale;              // distance from the light  (bloom, starburst)
  float rcS = rc / fscale;              // distance from the centre (halo)
  float2 toLightS = toLight / fscale;   // offset from the light    (streak)

  float3 flare = float3(0.0);

  // ── BLOOM / VEILING GLARE: a tight hot core + a broad low-contrast veil ──────
  float core = uBloom * exp(-rlS / BLOOM_CORE_SIZE);
  float veil = uBloom * BLOOM_VEIL_GAIN / (1.0 + (rlS / BLOOM_VEIL_SIZE) * (rlS / BLOOM_VEIL_SIZE));
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
    float3 g = ghostRGB((uv - gc) / fscale, size, uBlades, uChromatic); // grows each disc about ITS OWN gc
    flare += on * uGhostIntensity * vary * (1.0 - t * 0.5) * g;
  }

  // ── HALO RING: chromatic gaussian annulus about the centre, light-side biased ─
  float haloThick = uHaloRadius * HALO_THICK_FRAC;
  float3 haloC = haloRGB(rcS, uHaloRadius, haloThick, uChromatic); // rcS grows ring AND rim together
  float haloSide = HALO_SIDE_BASE + HALO_SIDE_GAIN * max(dot(normalize(uv + EPS), normalize(lightPos + float2(EPS))), 0.0);
  flare += uHalo * haloSide * haloC;

  // ── ANAMORPHIC STREAK: anisotropic gaussian (σx≫σy) + a faint wider haze band ─
  float sy = toLightS.y, sx = toLightS.x;
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
  // SPIKE_BASE_EPS floors the BASE so pow() stays defined at uStarburstSharp <= 0
  // (see the constant). It only bites in the ~1e-4 rad sliver where the cosine is
  // under EPS, i.e. sub-pixel at any sane radius: measured over a 960x540 frame, the
  // floor left sharp 1 and sharp 18 BYTE-IDENTICAL and moved 4 pixels by at most
  // 2/255 at sharp 0.25 (.claude_vlm_checks). So it buys the pow's totality for free.
  float spikeBase = max(abs(cos((ang + uStarburstRot) * spikeCount * 0.5)), SPIKE_BASE_EPS);
  float spikes = pow(spikeBase, uStarburstSharp);
  // rlS (not rl) lengthens the spikes with the scale; the ANGLE above stays on the
  // UNSCALED offset, because an angle is not a length and must not move with it.
  float star = uStarburst * spikes * exp(-rlS * STARBURST_FALLOFF);
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
 *   flareScale, ghostCount, ghostSpacing, ghostSize, ghostIntensity, anamorphic,
 *   streakLength, streakColor, halo, haloRadius, starburst, blades, starburstSharp,
 *   starburstRotation, chromatic, bloom, dirt, colorTemp, tint}
 * @returns {Float32Array} length 33
 *
 * @example packLensFlare({cx:0,cy:0,halfW:640,halfH:360,angle:0,lightX:0.72,lightY:0.28,
 *   brightness:1,flareScale:1,ghostCount:5,ghostSpacing:0.32,ghostSize:0.08,ghostIntensity:0.25,
 *   anamorphic:0.3,streakLength:0.3,streakColor:"#99b3ff",halo:0.3,haloRadius:0.45,
 *   starburst:0.3,blades:8,starburstSharp:24,starburstRotation:0,chromatic:0.012,
 *   bloom:0.6,dirt:0.2,colorTemp:5500,tint:"#ffffff"}).length // 33
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
    num("flareScale", u.flareScale),
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

// ── PROXY stand-in (thumbnail quality) ────────────────────────────────────────
// The lens flare is HEAVY (a 21-knob per-pixel shader whose default size is
// camera-bound → the full frame). At thumbnail size the SkSL is ~1.3s of CPU
// raster per render, invisible detail no one reads at ~100px. The proxy stand-in is
// a single soft RADIAL gradient GLOW centred at the light position — the ONE thing a
// tiny flare thumbnail must convey ("a bright flare here"). No SkSL, no ghost chain,
// no fbm. paint_skia.js turns this spec into a Skia radial gradient.
const PROXY_GLOW_RADIUS_FRAC = 0.9;  // glow radius as a fraction of the region half-diagonal (broad, like the flare's veil)
// TECHNICAL floor on the finished radius, NOT a bound on flareScale. The radius
// scales with THE FEATURE SCALE (the veil it stands in for does), and an equation
// can drive that scale negative — the shader floors negatives to "collapsed", but a
// negative RADIUS makes the gradient constructor hand back a NULL shader, and a null
// shader leaves the paint's own colour behind: the region would paint SOLID instead
// of vanishing. Zero is measured-safe (a zero-radius radial gradient draws nothing at
// all), so zero is the floor and a collapsed flare correctly shows an empty thumbnail.
const PROXY_MIN_GLOW_RADIUS = 0;
const PROXY_CORE_ALPHA = 0.85;       // opacity of the hot centre (× brightness), fading to 0 at the rim
const PROXY_MID_STOP = 0.35;         // radial stop where the falloff transitions core→broad-veil
const PROXY_MID_ALPHA_FRAC = 0.4;    // veil alpha at PROXY_MID_STOP as a fraction of the core alpha

/** Pure. Clamp x into [0,1]. @example cl01(1.4) // 1 */
function cl01(x) { return Math.min(1, Math.max(0, x)); }

/**
 * Pure function. The lens-flare PROXY stand-in spec: a soft RADIAL glow centred at
 * the light source, warm-white (the light's tint × its colour temperature × its
 * brightness), fading to transparent so the region reads as "a bright flare" over
 * the scene beneath — never a hole, never the full shader. Coordinates are in the
 * region's LOCAL space (paint_skia.js applies the view+world CTM). Colours are
 * [r,g,b,a] in 0..1.
 *
 * The light position is a [0,1] fraction of the region (uLight semantics): its LOCAL
 * point is (cx + (lightX·2−1)·halfW, cy + (lightY·2−1)·halfH). The radius tracks THE
 * FEATURE SCALE (`flareScale`), because the veil this glow stands in for does — so a
 * flare whose rings have been dialled down reads as a smaller glow at thumbnail size
 * instead of lying about its extent.
 *
 * @param {object} params - the flare's op params ({lightX, lightY, flareScale, tint, colorTemp, brightness, ...})
 * @param {{cx:number, cy:number, halfW:number, halfH:number}} region - local-space geometry
 * @returns {{kind:"radial", cx:number, cy:number, radius:number, stops:Array<{offset:number, color:[number,number,number,number]}>}}
 *
 * @example lensFlareProxyFill({lightX: 0.72, lightY: 0.3, tint: "#fff2e6", colorTemp: 5200, brightness: 1}, {cx: 128, cy: 72, halfW: 128, halfH: 72}).kind // "radial"
 * @example lensFlareProxyFill({lightX: 1, lightY: 0, tint: "#ffffff", colorTemp: 6500, brightness: 1}, {cx: 128, cy: 72, halfW: 128, halfH: 72}).cx // 256 (light at the right edge)
 * @example lensFlareProxyFill({lightX: 0.5, lightY: 0.5, tint: "#ffffff", colorTemp: 6500, brightness: 1}, {cx: 100, cy: 100, halfW: 100, halfH: 100}).stops.length // 3
 * @example lensFlareProxyFill({flareScale: 0.5, tint: "#ffffff", colorTemp: 6500, brightness: 1}, {cx: 0, cy: 0, halfW: 300, halfH: 400}).radius // 225 (half of 0.9*500)
 */
export function lensFlareProxyFill(params, region) {
  const lightX = params.lightX ?? 0.5;
  const lightY = params.lightY ?? 0.5;
  const gx = region.cx + (lightX * 2 - 1) * region.halfW;
  const gy = region.cy + (lightY * 2 - 1) * region.halfH;
  const radius = Math.max(
    PROXY_MIN_GLOW_RADIUS,
    PROXY_GLOW_RADIUS_FRAC * Math.hypot(region.halfW, region.halfH) * (params.flareScale ?? 1),
  );
  const tint = rgb("tint", params.tint ?? "#ffffff");
  const temp = kelvinToRGB(params.colorTemp ?? 6500);
  const c = [cl01(tint[0] * temp[0]), cl01(tint[1] * temp[1]), cl01(tint[2] * temp[2])];
  const core = cl01(PROXY_CORE_ALPHA * (params.brightness ?? 1));
  return {
    kind: "radial",
    cx: gx, cy: gy, radius,
    stops: [
      { offset: 0, color: [c[0], c[1], c[2], core] },
      { offset: PROXY_MID_STOP, color: [c[0], c[1], c[2], core * PROXY_MID_ALPHA_FRAC] },
      { offset: 1, color: [c[0], c[1], c[2], 0] },
    ],
  };
}

// ── FILL-MATERIAL SCHEMA (materials as PAINT on any shape) ────────────────────
/**
 * THE LENS-FLARE FILL-PARAM SCHEMA — the ONE declaration of the flare's look knobs,
 * in the customProps row shape (the end-state ruling "custom properties become
 * material properties"). Both consumers derive from it: plugins/demo/lens_flare.js
 * spreads it into its widget customProps (self.* rows), and the FILL-material UI
 * (PaintField) renders it as the paint's param rows, resolved sparse-over-defaults
 * by resolveMaterialPaint.
 *
 * WIDGET GEOMETRY IS NOT HERE. The flare's box (x/y/w/h) — bound to the camera by
 * `= camera.*` equations in the plugin's defaults — is positioning, not a look knob;
 * it stays widget-side. So does the widget's effects bundle (the "screen" blend that
 * makes the standalone widget composite additively). As the FILL of a shape the flare
 * paints its premultiplied field straight into the clip.
 *
 * BOUNDS POLICY (manifest "no arbitrary constraints invented by Claude"): every
 * remaining min/max is GEOMETRIC or TECHNICAL and says so in its help. A knob whose
 * only limit was taste carries none. Where a floor of 0 survives it is because the
 * shader's own guard would SILENTLY swallow a negative (a silent clamp discards the
 * user's value) — so the Inspector refuses it at the row instead.
 */
export const LENS_FLARE_FILL_PARAMS = [
  { name: "lightX", kind: "number", default: 0.72, scrub: UNIT_SPAN_SCRUB, help: "Light-source horizontal position as a fraction of the widget: 0 = left edge, 0.5 = centre, 1 = right edge. UNBOUNDED — negative or above 1 puts the light off the box entirely (the off-frame sun), and the ghost chain still marches from there through the widget centre and sweeps across the frame." },
  { name: "lightY", kind: "number", default: 0.3, scrub: UNIT_SPAN_SCRUB, help: "Light-source vertical position as a fraction of the widget: 0 = top, 0.5 = centre, 1 = bottom. UNBOUNDED, exactly like the horizontal position — a sun above or below the frame is a normal thing to want." },
  { name: "brightness", kind: "number", default: 1.2, min: 0, help: "Overall gain on the whole flare — the adjustable master intensity of the additive light added to the scene. Floor 0 (off): the shader clamps the assembled flare to [0,1] before premultiplying, so a negative gain would be silently swallowed rather than subtract light." },
  { name: "flareScale", kind: "number", default: 1, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Master size of every flare FEATURE — the ghosts, the halo ring, the streak, the glow and the starburst spikes all scale together, about their own centres. 1 = the sizes the knobs below name literally; 0.5 = a flare half the size in a box of the same size; 0 = every feature collapses (off). This is how a full-frame flare can still carry small rings: resize the box for the flare's REACH, then drag the second yellow handle to set the ring size independently. No upper cap — a big value simply grows the features past the box. Floor 0 because a size cannot be negative; below it the shader's own guard would silently swallow the value (and the bloom core's exponential would invert to infinity)." },
  { name: "ghostCount", kind: "number", default: 6, min: 0, max: MAX_GHOSTS, step: 1, help: `Number of aperture "ghosts" (iris reflections) marching along the axis through the centre. 0 = none; up to ${MAX_GHOSTS} — that ceiling is the shader's FIXED loop bound (SkSL cannot loop a uniform number of times), not a matter of taste.` },
  { name: "ghostSpacing", kind: "number", default: 0.33, help: "How far apart the ghosts are spaced along the axis: ghost i sits at light·(1 − spacing·i), so ~0.3 puts one near the centre. Higher = more spread out; 0 stacks them all on the light; a negative value marches the chain outward AWAY from the centre instead." },
  { name: "ghostSize", kind: "number", default: 0.11, min: 0, help: "Base radius of the ghost discs (normalized to widget height). Ghosts grow along the chain from this base. Floor 0 because a radius cannot be negative; 0 itself is a valid vanishing point (the shader guards the divide)." },
  { name: "ghostIntensity", kind: "number", default: 0.4, min: 0, help: "Brightness of the ghost chain. Floor 0 (off) for the same reason as the master gain — negative light is clamped away, not subtracted." },
  { name: "anamorphic", kind: "number", default: 0.5, min: 0, help: "Intensity of the horizontal anamorphic streak (the blue JJ-Abrams light bar). 0 = off; floor 0 as above." },
  { name: "streakLength", kind: "number", default: 0.4, min: 0, help: "Horizontal length (σx) of the anamorphic streak, in normalized units. Longer = a wider light bar. Floor 0 because a gaussian σ cannot be negative; 0 itself collapses the streak (the shader guards the divide)." },
  { name: "streakColor", kind: "color", default: "#6fa8ff", help: "Colour of the anamorphic streak — classically a coating blue." },
  { name: "halo", kind: "number", default: 0.45, min: 0, help: "Intensity of the halo ring around the optical centre. 0 = off; floor 0 as above." },
  { name: "haloRadius", kind: "number", default: 0.45, min: 0, help: "Radius of the halo ring (normalized to widget height, measured from the centre). No upper cap — a huge ring simply passes outside the box. Floor 0 because a radius cannot be negative." },
  { name: "starburst", kind: "number", default: 0.4, min: 0, help: "Intensity of the diffraction starburst (the radial spikes from the aperture blades). 0 = off; floor 0 as above." },
  { name: "blades", kind: "number", default: 8, min: MIN_POLYGON_BLADES, step: 1, help: "Aperture blade count. Diffraction physics: an EVEN count gives that many spikes; an ODD count gives twice as many (e.g. 9 blades → 18 spikes). Also shapes the ghost iris polygon. Floor 3 is geometric (an iris polygon needs three sides) and matches the shader's own MIN_BLADES — below it the shader would silently clamp." },
  { name: "starburstSharp", kind: "number", default: 18, min: 0, scrub: 0.1, help: "Spike thinness (exponent). Higher = razor-thin spikes; lower = soft, fat rays; 0 = no spikes at all, just an even radial glow. No upper cap — a huge exponent is simply a hairline star." },
  { name: "starburstRotation", kind: "angle", display: "degrees", default: 0.2, help: "Rotation of the starburst spikes — keyframe it (or bind an equation) to make the spikes swim as a camera turns. Uncapped: past 360° keeps counting, so a keyframed 720° spins twice." },
  { name: "chromatic", kind: "number", default: 0.02, help: "Chromatic dispersion amount: how far the red/blue channels split at each iris/halo edge (spectral fringing). Tiny is realistic; a negative value disperses the other way (blue outside instead of red)." },
  { name: "glow", kind: "number", default: 1.0, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Bloom / veiling glare intensity — the tight hot core at the light plus a broad soft haze that washes the frame. Floor 0 (off) as above. (Named 'glow', not 'bloom': the effects bundle owns a separate nested `bloom` vector-glow substrate — toUniformParams renames glow → the shader's uBloom.)" },
  { name: "dirt", kind: "number", default: 0.18, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Procedural lens-dirt/grunge modulation: 0 = clean glass; 1 = the whole flare is broken up by a dusty grime field (all procedural — no texture asset). No upper cap — past 1 the grime mix extrapolates, crushing the dirtiest patches all the way to black for a harsher, higher-contrast grime. Floor 0 (clean) as above." },
  { name: "colorTemp", kind: "number", default: 5200, min: 1000, max: 12000, help: "Colour temperature in Kelvin of the light's cast on the flare: ~3200 K = warm amber, 6500 K = neutral white, ~9000 K+ = cool blue. The range is the domain of the Kelvin→RGB fit the shader uses (KELVIN_TABLE); outside it the fit is undefined and the packer would silently pin the value." },
  { name: "tint", kind: "color", default: "#fff2e6", help: "Explicit colour multiply over the whole flare, on top of the temperature cast." },
];

/**
 * Pure function. SCHEMA params (LENS_FLARE_FILL_PARAMS names) → the PACKER's params
 * (packLensFlare's keys). The ONLY difference is the ONE deliberate rename glow →
 * bloom (the schema knob is called "glow" to avoid colliding with the effects
 * bundle's nested `bloom`; the shader uniform is uBloom); every other knob passes
 * through by the same name. THE one mapping both consumers share: the demo widget's
 * emit() AND the fill-material shape path (paint_skia handleMaterialPaintShape reads
 * it as entry.toUniformParams).
 *
 * @param {object} p - schema-shaped params (resolved: every knob present)
 * @returns {object} packLensFlare-shaped params
 *
 * @example lensFlareUniformParams({lightX: 0.72, lightY: 0.3, brightness: 1.2, flareScale: 1, ghostCount: 6, ghostSpacing: 0.33, ghostSize: 0.11, ghostIntensity: 0.4, anamorphic: 0.5, streakLength: 0.4, streakColor: "#6fa8ff", halo: 0.45, haloRadius: 0.45, starburst: 0.4, blades: 8, starburstSharp: 18, starburstRotation: 0.2, chromatic: 0.02, glow: 1, dirt: 0.18, colorTemp: 5200, tint: "#fff2e6"}).bloom // 1
 * @example lensFlareUniformParams({glow: 0.6}).bloom // 0.6
 */
export function lensFlareUniformParams(p) {
  return {
    lightX: p.lightX, lightY: p.lightY, brightness: p.brightness, flareScale: p.flareScale,
    ghostCount: p.ghostCount, ghostSpacing: p.ghostSpacing, ghostSize: p.ghostSize, ghostIntensity: p.ghostIntensity,
    anamorphic: p.anamorphic, streakLength: p.streakLength, streakColor: p.streakColor,
    halo: p.halo, haloRadius: p.haloRadius,
    starburst: p.starburst, blades: p.blades, starburstSharp: p.starburstSharp, starburstRotation: p.starburstRotation,
    chromatic: p.chromatic, bloom: p.glow, dirt: p.dirt,
    colorTemp: p.colorTemp, tint: p.tint,
  };
}

// ── material descriptor (registry entry) ──────────────────────────────────────
// FOREGROUND, GENERATIVE material: `backdrop: false` binds NO children and skips
// the below-content re-render — handleMaterialFill just makeShader+fill. `id`
// matches the plugin's `material` op field. `proxyFill` gives the thumbnail/minimap
// (quality:"proxy") path a cheap radial-glow stand-in instead of the 21-knob SkSL.
// `fillParams` + `toUniformParams` opt the flare into being PAINT on any shape.
export const LENS_FLARE_MATERIAL = {
  id: "lens_flare",
  sksl: LENS_FLARE_SKSL,
  pack: packLensFlare,
  uniformFloats: LENS_FLARE_UNIFORM_FLOATS,
  backdrop: false,
  proxyFill: lensFlareProxyFill,
  fillParams: LENS_FLARE_FILL_PARAMS,
  toUniformParams: lensFlareUniformParams,
};
