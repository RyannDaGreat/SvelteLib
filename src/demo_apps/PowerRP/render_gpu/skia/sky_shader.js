/**
 * THE SKY DOME material SkSL — the `sky` widget, a GENERATIVE (source) FOREGROUND
 * material on the reusable MATERIAL FRAMEWORK (render_gpu/skia/materials.js). It
 * synthesizes a PHYSICALLY-BASED sky: an analytic single-scattering atmosphere
 * (Rayleigh + Mie) driven by the scene's suns, a horizon/ground, and — at night —
 * a procedural star field + Milky Way band. FULLY PROCEDURAL: no textures (so the
 * time-of-day rotation of the star sphere wraps with zero seams).
 *
 * ── WHY GENERATIVE (backdrop:false) ──────────────────────────────────────────
 * Like raycast_dither / corkboard it samples NOTHING below it — every pixel is
 * synthesized from uniforms. It rides the `materialFill` op + handleMaterialFill:
 * a plain effect.makeShader(uniforms) fill, NO children, NO backdrop re-render.
 *
 * ── THE SIBLING QUERY (the `sky*` archetype's crux) ──────────────────────────
 * The sky READS the other sky-family widgets. core/derive.resolveSkyScene attaches
 * a WORLD-space {suns, moons} summary to this node's state; plugins/demo/sky.js
 * emit() maps each sun's world centre into THIS box's local [-1,1] frame (via the
 * node's own `world`, the arg-3 seam) and passes them as the `suns` param. So a
 * sun's POSITION in the box IS its sky position + elevation (drives blue-zenith ↔
 * red-horizon), and its COLOUR tints the scattering — moving/recolouring a skySun
 * deterministically changes the sky. Deterministic ⇒ RenderTree stays pure.
 *
 * ── PHYSICS (grounded; see .claude_sky_design.md for sources) ─────────────────
 * Rayleigh β ∝ 1/λ⁴ (blue scatters ~5.7× red → blue zenith); Mie forward lobe
 * (Cornette-Shanks, g≈0.76 → warm aureole toward a low sun). Airmass reddening:
 * a low sun's transmitted light exp(-(βR+βM)·airmass) loses blue first → sunset.
 * Closed-form single scatter (no nested ray-march): inScatter = scatterCoef/βtot ·
 * (1 − exp(-βtot·airmassView)), tinted by the sun's transmittance. Stars: sine-free
 * hash over a square world-px lattice, magnitude-distributed, blackbody-tinted, each
 * scintillating on its own seeded phase. Milky Way: great-circle band mask × fbm
 * mottling over the view DIRECTION.
 *
 * ── THE NIGHT SKY IS ONE RIGID DOME (BM) ─────────────────────────────────────
 * The star field and the Milky Way turn together, about an explicit CELESTIAL POLE
 * whose altitude is the observer's latitude — one angle (uTimeOfDay), applied in each
 * layer's own chart because the two charts are each load-bearing and incompatible.
 * See SKY_POLE_AXIS for the defect this replaced, the two unifications that were
 * measured and rejected, and why "share the rotation, not the space" is the only
 * option left. A LONG EXPOSURE is that same rotation integrated: uTrailArc turns of
 * dome rotation accumulated in-shader, so stars smear into concentric arcs about the
 * pole and the band smears along the same arcs, while the ground stays sharp.
 *
 * DOM-free at import (string SkSL + a pure packer), like glass/raycast_dither.
 * parseColor (render_gpu/ir.js) is the shared node-safe hex/rgb parser.
 */

import { parseColor } from "../ir.js";
import * as T from "../../core/transform.js";
import { collectSkyScene } from "../../core/derive.js";
import { particleTime } from "../particle_clock.js";

/** Max suns/moons the sky reads (fixed uniform-array sizes; the packer pads). */
export const SKY_MAX_SUNS = 4;
export const SKY_MAX_MOONS = 2;

// geometry 8 + scalars 13 + float3 tints 12 + float2[4] suns 8 + float4[4] sunColor 16
// The scalars grew from 10 to 13 with BM's twinkle + trailArc + trailSamples.
const SKY_UNIFORM_FLOATS = 8 + 13 + 12 + 8 + 16; // = 57

export const SKY_SKSL = `
// ── structural constants (the physics; only CHARACTER knobs are uniforms) ─────
const int   MAX_SUNS   = ${SKY_MAX_SUNS};
const float PI         = 3.14159265;
const float HALF_PI    = 1.57079633;
const float TWO_PI     = 6.28318531;
// Rayleigh scattering coefficients ∝ 1/λ⁴ (relative, blue-heavy: 5.8/13.5/33.1 at
// 440/550/680 nm, scaled to give O(0.1–0.5) optical depth at unit airmass).
const float3 BETA_R    = float3(0.058, 0.135, 0.331);
const float  BETA_M    = 0.021;   // Mie (wavelength-independent haze), scaled by turbidity
const float  MIE_G     = 0.76;    // Mie asymmetry (forward-scatter peak → sun aureole)
const float  SUN_RADIANCE = 2.6;  // sun radiance scale: keeps the RED channel unsaturated at
                                  // high sun (a BLUE zenith, not blown white) while the long
                                  // horizon airmass still saturates it warm — tuned with uExposure
const float  AZ_SPAN   = 1.65;    // radians of azimuth the box half-width spans
const float  STAR_THRESHOLD = 0.86; // per-cell hash cutoff: higher = fewer stars
const float  STAR_MAG_POW = 3.2;  // magnitude distribution: high power = rare bright stars
const float  MW_SIGMA  = 0.24;    // Milky-Way band half-width (in sin-galactic-latitude)
// Milky-Way noise frequencies, in noise cells per unit of DIRECTION (≈ per radian of
// arc on the unit sphere). They replace the old per-axis (2.2, 3.0) / (5.0, 6.0)
// pairs of the azimuth/elevation domain with one isotropic figure each, because a
// direction has no preferred axis: 2.6 is the coarse mottling that gives the band its
// clumps, 5.5 the finer dust that bites lanes out of it.
const float  MW_MOTTLE_FREQ = 2.6;
const float  MW_DUST_FREQ   = 5.5;
// The world-px span uStarDensity counts star-lattice cells across. It is the sky
// widget's DEFAULT WIDTH (plugins/demo/sky.js defaults w: 1000), so at the default box
// the knob still reads as "cells across the box" exactly as it did while the lattice
// was box-relative — the number keeps its old intuition after losing its old
// dependence on the box. See starField for why that dependence had to go.
const float  STAR_SPAN_PX = 1000.0;
// ── THE CELESTIAL POLE (BM): ONE ANGLE, ONE POLE, TWO NATURAL FRAMES ──────────
// A real sky is ONE RIGID DOME turning about the celestial pole, so the star field
// and the Milky Way must MOVE TOGETHER. They used not to, and the two were not even
// the same KIND of motion — MEASURED at 600x600, timeOfDay 0.20 -> 0.21, the
// per-quadrant displacement of each layer rendered alone:
//   stars  (14,-10) (7,11) (-6,-9) (-8,8)  — a CURL about the box centre (rotation)
//   galaxy (11, 0)  (11,0) (11, 0) (11,0)  — a UNIFORM SLIDE (translation)
// because starField rotated the flat world-px LATTICE about the box centre while
// main() rotated the view DIRECTION about the world +Y (zenith) axis. Two different
// groups acting on two different spaces; neither had a pole, and the user saw the
// band drift sideways under stars that wheeled.
//
// WHY THE TWO LAYERS DO NOT SHARE A SPACE, only a rotation. The obvious unification —
// rotate one point and let both layers read it — was built and MEASURED, and it is
// wrong in both directions:
//   Route the BAND through the star plane (rotate in the plane, then domeDir back to
//     a direction) and the rotation is NOT RIGID: composing a plane rotation with the
//     non-linear box->dome map drifts the angular distance between two sky features by
//     up to 3 degrees per 0.05 turn (measured over sample pairs), so the constellations
//     would visibly deform as the night went on.
//   Route the STARS through the sphere and they stop being round: the box->dome
//     Jacobian is anisotropic, measured aspect 1.07 / 1.18 / 0.76 at up = -0.5 / 0 /
//     +0.5, so stars would come out as ellipses whose eccentricity VARIES ACROSS THE
//     FRAME — a worse version of the uniform stretch R6-9.1 removed, and it would
//     break that law's two pinned halves (roundness, box-size independence).
// Each layer's frame is load-bearing and neither can be given up. So what is shared is
// THE ROTATION ITSELF — one angle about one pole — applied in each layer's own frame:
//   the STARS turn in the flat lattice plane about SKY_POLE_PX (a plane isometry, so
//     they stay round and box-independent),
//   the BAND turns on the sphere about SKY_POLE_AXIS by Rodrigues (a true rotation of
//     the sphere, exactly rigid — measured drift 0.000000000 degrees — so the band
//     keeps its shape and its seamless direction-domain noise).
// The two are the SAME physical rotation seen in two charts, and they are kept in
// agreement by construction: both read uTimeOfDay through the same TWO_PI, and the
// plane pole is the sphere pole's own projection (see SKY_POLE_PX).
//
// THE POLE'S ALTITUDE IS THE OBSERVER'S LATITUDE — that is what the celestial pole's
// elevation MEANS — so a single constant fixes the whole geometry. 45 degrees is the
// mid-northern default: high enough that the pole sits well above the horizon (so
// trails curve visibly rather than reading as straight streaks) and low enough that it
// is not overhead. Due north is +z, the direction domeDir gives at vx = 0.
const float  SKY_POLE_LAT = 0.7853981634; // 45 degrees, in radians
const float3 SKY_POLE_AXIS = float3(0.0, 0.7071067812, 0.7071067812); // (0, sin, cos) of the above
// The pole in the STAR PLANE, as a fixed WORLD-px offset from the box centre. That
// frame is forced, not chosen: the star lattice lives in world px measured from the box
// centre (starField says why), and a pole expressed in the BOX-NORMALIZED frame would
// MOVE when the box grew, breaking R6-9.1 LAW 1(b) — growing the box about its centre
// must leave the overlapping stars byte-identical. A length from the centre is
// box-independent by construction. Stated as a fraction of STAR_SPAN_PX so it is in the
// same unit as the lattice pitch: up and left of centre, the classic northern star-trail
// framing with the pole just outside the frame.
const float2 SKY_POLE_PX = float2(-0.45, 0.62) * STAR_SPAN_PX;
// Loop bound for the long-exposure accumulation. SkSL requires a CONSTANT trip count
// (the loop is unrolled), so the knob clamps into this and the shader always compiles
// to the same program. 64 is where the arc reads CONTINUOUS rather than as a string of
// beads at the trail lengths the presets use — see the trailSamples row for the
// measurement that sets it.
const int    MAX_TRAIL_SAMPLES = 64;
// How many cells BACK ALONG THE TRAIL the star walk looks. See starField's own note:
// a trailed pixel is lit by a star that started up-arc of it, and the search has to
// reach that far or the trail is clipped. This is a BAND (a constant extra cost per
// pixel), not a wider square, and it is the reason trailArc carries a documented
// ceiling: 24 cells is roughly what the walk can afford, so the honest exposure range
// is the arc that fits inside it. Trails do not grow past that — they stop.
const int    TRAIL_LOOKBACK = 24;
const float  EDGE_AA   = 1.0;     // rounded-rect coverage AA half-width (device px)
const float  EPS       = 1e-3;
// DIVIDE GUARD for the closed-form single-scatter ratio scatterCoef/betaTot below.
// betaTot = uAtmosphere·(BETA_R + BETA_M·uTurbidity/3), so it is EXACTLY ZERO at
// uAtmosphere = 0 — and scatterCoef carries the same uAtmosphere factor, so the ratio
// is 0/0 there: an UNGUARDED NaN whose rendering is backend-defined (measured on the
// raster backend: the whole dome comes out flat white, indistinguishable from a
// blown-out exposure). The ratio itself is atmosphere-INVARIANT (the factor cancels),
// so flooring the divisor cannot change any sky that renders: BETA_FLOOR sits seven
// decades below the betaTot of the thinnest sky that still shows anything
// (uAtmosphere 0.001 ⇒ betaTot.r ≈ 6e-5), and thinner ones already render exactly the
// uAtmosphere = 0 frame. It turns uAtmosphere = 0 into its exact physical limit —
// no scattering, a black airless sky — instead of a NaN. It also keeps the per-channel
// pole a NEGATIVE uTurbidity would walk into (betaTot.r = 0 at uTurbidity = −8.2857…)
// finite and deterministic rather than NaN.
const float  BETA_FLOOR = 1e-12;

// ── framework-set geometry (device px) — NOT user knobs ───────────────────────
uniform float2 uCenter;
uniform float2 uHalfSize;
uniform float  uCornerRadius;
uniform float  uAngle;
uniform float  uScale;         // device px per world unit (the star lattice's own frame)
uniform float  uTime;          // ambient animation seconds (frozen in editor/CLI)
// ── user knobs (self.* custom props) ──────────────────────────────────────────
uniform float  uHorizon;       // horizon height in box frame (up units; 0 = middle, <0 = lower)
uniform float  uTurbidity;     // haze: scales Mie (2 = clear, 8 = hazy)
uniform float  uAtmosphere;    // overall atmosphere thickness (scales all scattering)
uniform float  uExposure;      // HDR tone-map exposure
uniform float  uStarDensity;   // star lattice cells across STAR_SPAN_PX world px
uniform float  uStarSize;      // star core radius, world px (independent of density)
uniform float  uMilkyWay;      // Milky-Way band strength (0 = off)
uniform float  uTimeOfDay;     // 0..1 — rotates the whole dome about the celestial pole
uniform float  uTwinkle;       // twinkle AMOUNT (0 = none; the ONE clock reader)
uniform float  uTrailArc;      // long exposure: TURNS of dome rotation the shutter was open
uniform float  uTrailSamples;  // samples accumulated along that arc
uniform float  uMoonlight;     // night ambient lift from moon(s) illuminated fraction
uniform float  uSunCount;      // number of active suns (0..MAX_SUNS)
// ── colour tints ──────────────────────────────────────────────────────────────
uniform float3 uZenith;        // day zenith colour multiplier
uniform float3 uGround;        // ground/foreground colour below the horizon
uniform float3 uNight;         // deep night sky colour
uniform float3 uGalaxyTint;    // Milky-Way glow tint
// ── the queried suns (box frame [-1,1]; .a of colour = intensity) ─────────────
uniform float2 uSunPos[${SKY_MAX_SUNS}];
uniform float4 uSunColor[${SKY_MAX_SUNS}];

// Pure. Sine-free 2D hash -> [0,1) (stable at large coords, unlike fract(sin())).
float hash21(float2 p) {
  p = fract(p * float2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}
// Pure. 2->2 hash for a per-cell star position.
float2 hash22(float2 p) {
  float n = hash21(p);
  return float2(n, hash21(p + n));
}
// Pure. Sine-free 3D hash -> [0,1), hash21's sibling (same construction, one more axis).
float hash31(float3 p) {
  p = fract(p * float3(233.34, 851.73, 419.21));
  p += dot(p, p.yzx + 23.45);
  return fract((p.x + p.y) * p.z);
}
// Pure. 3D value noise (trilinear over a smoothstepped hashed lattice).
float vnoise3(float3 x) {
  float3 i = floor(x), f = fract(x);
  float3 u = f * f * (3.0 - 2.0 * f);
  float n00 = mix(hash31(i), hash31(i + float3(1.0, 0.0, 0.0)), u.x);
  float n10 = mix(hash31(i + float3(0.0, 1.0, 0.0)), hash31(i + float3(1.0, 1.0, 0.0)), u.x);
  float n01 = mix(hash31(i + float3(0.0, 0.0, 1.0)), hash31(i + float3(1.0, 0.0, 1.0)), u.x);
  float n11 = mix(hash31(i + float3(0.0, 1.0, 1.0)), hash31(i + float3(1.0, 1.0, 1.0)), u.x);
  return mix(mix(n00, n10, u.y), mix(n01, n11, u.y), u.z);
}
// Pure. 5-octave fbm over a DIRECTION. THE SEAM FIX (R6-9.2): the Milky-Way mottling
// used to be 2D fbm over (atan(rd.x, rd.z), asin(rd.y)), and atan2's branch cut at
// ±PI is a HARD DISCONTINUITY in that domain. The cut is invisible while the sky
// looks straight ahead — the box spans only ±AZ_SPAN = ±1.65 rad of azimuth — but
// uTimeOfDay ROTATES the direction before the projection, so the cut SWEEPS ACROSS
// THE BOX. Measured at 900x500: a vertical step 60-170x the median column-to-column
// difference, its column tracking uTimeOfDay exactly (tod 0.25 -> col 21, 0.35 ->
// 192, 0.5 -> 449, 0.6 -> 620, 0.7 -> 792, 0.75 -> 877, each within 1 px of the
// predicted phi = uTimeOfDay*TWO_PI - PI), i.e. present for roughly HALF the
// uTimeOfDay range — including the 0.7 that five of the six shipped sky presets use.
// Noising the 3-vector itself has no branch cut and no pole to compress, so it is
// seamless by construction rather than by tuning; the widget stays FULLY PROCEDURAL,
// which is the precedent remedy (rainy-window v2, task #104).
float fbm3(float3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise3(p); p = p * 2.0 + 19.7; a *= 0.5; }
  return v;
}
// Pure. Rotate a 2-vector by angle.
float2 rot2(float2 v, float a) { float c = cos(a), s = sin(a); return float2(c * v.x - s * v.y, s * v.x + c * v.y); }
// Pure. THE SKY ROTATION IN THE STAR PLANE (BM): turns the lattice point "pw" (world
// px, y-up, box centre at the origin) about the pole's projected position. A rotation
// of the plane about a point is an ISOMETRY (determinant 1, no shear), which is what
// keeps a star round (R6-9.1 LAW 1a); the pole is a fixed world-px offset from the box
// centre, so nothing here reads the box's size (LAW 1b).
float2 skyRotatePlane(float2 pw, float turns) {
  return SKY_POLE_PX + rot2(pw - SKY_POLE_PX, turns * TWO_PI);
}
// Pure. THE SAME ROTATION ON THE SPHERE (BM): Rodrigues' formula turns a direction
// about SKY_POLE_AXIS by the same angle. This is an exact rotation of the sphere, so
// the band keeps its shape and every angular distance is preserved — measured drift
// 0.000000000 degrees between sample pairs, against up to 3 degrees for the
// plane-rotate-then-project alternative that was tried first and rejected.
float3 skyRotateDir(float3 v, float turns) {
  float a = turns * TWO_PI, c = cos(a), s = sin(a);
  float3 k = SKY_POLE_AXIS;
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
// Pure. Rounded-rect SDF (iq). <0 inside.
float sdRoundRect(float2 p, float2 h, float r) { float2 q = abs(p) - (h - r); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// Pure. Rayleigh phase P_R(μ) = 3/(16π)(1+μ²) (unnormalized 3/4 form, folded into scale).
float phaseR(float mu) { return 0.75 * (1.0 + mu * mu); }
// Pure. Cornette-Shanks Mie phase (forward lobe for anisotropy g).
float phaseM(float mu, float g) {
  float g2 = g * g;
  return 1.5 * ((1.0 - g2) / (2.0 + g2)) * (1.0 + mu * mu) / pow(max(1.0 + g2 - 2.0 * g * mu, EPS), 1.5);
}
// Pure. Kasten (1966) relative airmass from sin(elevation); clamps below-horizon.
float airmass(float sinElev) {
  float s = max(sinElev, 0.0);
  float zdeg = degrees(acos(clamp(s, 0.0, 1.0)));
  return 1.0 / (s + 0.15 * pow(max(93.885 - zdeg, EPS), -1.253));
}
// Pure. A view/sun direction on the dome from box coords (vx across, up vertical).
float3 domeDir(float vx, float up) {
  float theta = ((up - uHorizon) / max(1.0 - uHorizon, EPS)) * HALF_PI; // horizon->0, top->PI/2
  float phi = vx * AZ_SPAN;
  float ct = cos(theta);
  return float3(ct * sin(phi), sin(theta), ct * cos(phi));
}
// Pure. Blackbody-ish star tint from a hash: mostly blue-white, rare warm.
float3 starTint(float h) {
  float3 cool = float3(0.75, 0.85, 1.0), warm = float3(1.0, 0.75, 0.45);
  return mix(float3(1.0), mix(cool, warm, h), 0.6);
}
// Query-like. The star-field contribution at a point of the box, in WORLD PX.
//
// THE STRETCH FIX (R6-9.1). This lattice used to live in the dome's (azimuth,
// elevation) parameter plane, which sounds angular but is not: the box→dome map is
// AFFINE in both axes (atan2 of domeDir's own sin/cos returns phi exactly, asin of
// its sin returns theta exactly), so the grid was really an ANISOTROPIC lattice in
// BOX coordinates whose per-axis pitch ratio is AZ_SPAN·(1−uHorizon)·halfH/(PI·halfW).
// Stars therefore came out as ELLIPSES whose eccentricity was the box's aspect, and
// resizing the widget restretched every one of them. Measured, night sky, default
// knobs, median star blob w/h: 1.50 in a square box, 5.00 in a 3:1 box (predicted
// 4.97), 0.67 in a 1:3 box — the user's "stars STRETCH when the sky is stretched".
//
// The grid is now a SQUARE lattice in WORLD PX (the widget's own local plane,
// centred on the box, y-up), so a star is round at every aspect and keeps its size
// and spacing when the box is resized: pw is a length, and the box only decides how
// much of the lattice you can see. WORLD px and not DEVICE px deliberately — device
// px would make the star field a function of zoom and dpr, so a 1080p and a 4K export
// of one document would not be the same picture, which the editor-vs-renderer law
// forbids. uHorizon no longer moves the stars either; it used to slide AND rescale
// them, since it set the vertical origin and pitch.
//
// cellPx is the lattice pitch and sizePx the star core radius, both world px, and
// they are now INDEPENDENT: the old form had one grid doing both jobs, so the only
// way to enlarge a star was to remove stars.
//
// "pw" ARRIVES ALREADY ROTATED (BM). This function used to wheel the lattice itself
// by uTimeOfDay about the box centre, which is half of why the dome was not rigid —
// see SKY_POLE_AXIS. The rotation now happens ONCE in the caller, and the Milky Way
// takes the SAME angle in its own frame, so neither layer can drift against the other.
//
// TWINKLE is "twinkleAmt", not the old baked 0.7 + 0.3·sin(…). The factor is
// 1 − amt + amt·sin(…), so amt = 0.3 reproduces the old expression EXACTLY (0.7 =
// 1 − 0.3) and amt = 0 is exactly 1.0 — a star that does not read the clock at all.
// That zero is what SKY_MATERIAL's param-predicated "animated" is asserting about,
// so it has to be an exact identity rather than a small number: see the entry.
//
// ── THE LONG EXPOSURE IS ANALYTIC, NOT POINT-SAMPLED (BM) ────────────────────
// "arcRad" is the angle this star sweeps while the shutter is open, and the glow is
// integrated ALONG THAT ARC rather than by rendering the field at N rotations and
// averaging. POINT SAMPLING WAS BUILT FIRST AND MEASURED TO BE STRUCTURALLY UNABLE
// TO WORK HERE: consecutive samples must land within about one star DIAMETER or the
// trail reads as a string of beads, and at the shipped exposures that needs
//   30 min -> ~107 samples,  2 h -> ~428,  8 h -> ~1701,  24 h -> ~5093
// (max arc length over a default box, at starSize 0.82) against a ceiling of 64 —
// SkSL unrolls the loop, so the trip count is a compile-time constant and cannot be
// raised to four figures. The rendered 30-minute frame showed exactly the predicted
// beading. No sample count fixes this; the sampling itself is the wrong instrument.
//
// The integral has a closed form because the star's path is a CIRCULAR ARC about the
// pole and the glow is an inverse-square of distance to the star. Over one arc the
// nearest approach dominates, so this uses the standard reduction: find the point of
// the arc closest to the shading pixel, evaluate the SAME inverse-square core there,
// and weight it by how much of the exposure is spent near that point (1/arcLength,
// the surface-brightness normalization a photograph gives). The result is CONTINUOUS
// by construction — there is no sampling rate to alias — costs ONE evaluation per
// cell instead of N, and converges to the instant star exactly as arcRad -> 0.
float3 starField(float2 pw, float cellPx, float sizePx, float amount, float twinkleAmt, float arcRad, float2 poleCell) {
  if (amount <= 0.0) return float3(0.0);
  float2 g = pw / max(cellPx, EPS);
  float2 cell = floor(g), fpos = fract(g);
  float3 acc = float3(0.0);
  float rel = max(sizePx, 0.0) / max(cellPx, EPS); // core radius in CELL units
  // ── THE SEARCH NEIGHBOURHOOD, AND THE BOUND IT PUTS ON A TRAIL ──────────────
  // A pixel can only be lit by a star this walk actually VISITS. Without trails the
  // 3x3 neighbourhood is exactly right: a star's glow reaches about a cell, so a
  // pixel's light comes from its own cell or a neighbour. A TRAIL BREAKS THAT — the
  // star that smeared over this pixel started somewhere BACK ALONG THE ARC, which at
  // the exposures a photographer would use is many cells away:
  //   30 min -> 11 cells,  2 h -> 44,  8 h -> 177,  24 h -> 530 (at the default density)
  // and covering that by widening the box walk is quadratic and hopeless — the 8-hour
  // case alone is 2.2 BILLION cell evaluations for one 1080p frame.
  //
  // So the walk is widened ONLY ALONG THE TRAIL, and only by a fixed amount: "back"
  // steps in the arc's own direction, TRAIL_LOOKBACK at most. That is a constant extra
  // cost (a band, not a square) and it is honest about what it buys — see the trailArc
  // row, whose documented range is exactly the range this reaches. Beyond it a trail
  // stops growing rather than growing wrong, which is why the row is capped there
  // instead of letting the knob promise an exposure the shader cannot draw.
  //
  // THE REAL FIX IS A POLAR LATTICE (stars indexed by ring and angle about the pole),
  // where a trail is axis-aligned and the covering star is ONE floor() per ring — O(1)
  // for any arc length. It is not done here because that lattice is the subject of two
  // pinned laws (R6-9.1: stars round at every box aspect, and byte-identical when the
  // box grows) and re-deriving both in polar form is its own workstream.
  int back = int(clamp(abs(arcRad) * length(poleCell), 0.0, float(TRAIL_LOOKBACK)));
  // The arc's local direction at this pixel: perpendicular to the pole radius, signed
  // by the sweep. Stars arrive from BEHIND, so the walk steps against the motion.
  float2 radial2 = normalize(poleCell + float2(EPS, 0.0));
  float2 tang = float2(-radial2.y, radial2.x) * (arcRad >= 0.0 ? 1.0 : -1.0);
  for (int b = 0; b <= TRAIL_LOOKBACK; b++) {
    if (b > back) break;
    float2 lag = tang * float(b);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      float2 c = cell + floor(lag) + float2(float(dx), float(dy));
      float present = hash21(c + 7.1);
      if (present < STAR_THRESHOLD) continue;
      // The star's position relative to the SHADING PIXEL, including how many cells back
      // along the trail this band step is (floor(lag) shifted the cell, so the fractional
      // remainder has to come back in here or the star would jump to a lattice point).
      float2 star = floor(lag) + float2(float(dx), float(dy)) + hash22(c) - fpos;
      float mag = pow(hash21(c + 3.7), STAR_MAG_POW);        // rare bright stars
      // DISTANCE TO THE STAR'S SWEPT ARC, not to the star. At arcRad = 0 this is
      // exactly length(star) and every line below collapses to the original point glow,
      // so an instant photograph is untouched by the trail machinery.
      //
      // Both the pixel and the star are taken relative to the POLE (poleCell is the pole
      // in this same cell frame). The star travels a circle of radius rs about it, so the
      // pixel's distance to that path splits into two independent parts:
      //   RADIAL  — |rp − rs|, how far the pixel is off the star's circle. The arc cannot
      //             help with this, so it is unchanged by the exposure.
      //   ANGULAR — how far around the circle the pixel is from the arc the star actually
      //             covered. Zero while the pixel lies WITHIN the swept sector (the star
      //             passed right over it); outside, it is the gap to the nearer END of the
      //             arc, measured as a length along the circle (rp · Δangle).
      float2 pRel = -poleCell;              // pixel, relative to the pole (fpos is the origin)
      float2 sRel = star - poleCell;        // this star, relative to the pole
      float rp = length(pRel), rs = length(sRel);
      float radial = rp - rs;
      // Signed angle from the star to the pixel, in [-PI, PI]. The star sweeps from 0 to
      // arcRad (either sign), so the pixel is "inside" the sweep when its angle lies
      // between them. atan here is safe: its branch cut is at the DIAMETRICALLY OPPOSITE
      // point of the circle, which is half a sky away from any arc this samples.
      float dAng = atan(pRel.y * sRel.x - pRel.x * sRel.y, dot(pRel, sRel));
      float lo = min(0.0, arcRad), hi = max(0.0, arcRad);
      float outside = dAng < lo ? (lo - dAng) : (dAng > hi ? (dAng - hi) : 0.0);
      float along = outside * rp;           // arc-length gap to the nearer end of the trail
      float d2 = radial * radial + along * along;
      // THE EXPOSURE NORMALIZATION, and it is the one number in this feature that is a
      // deliberate DEPARTURE from strict energy conservation. Both extremes were measured:
      //   CONSERVE ENERGY EXACTLY — divide by the full arc length in star radii (~92 at
      //     the 30-minute preset). Correct for a fixed shutter speed, and it renders an
      //     almost BLANK SKY: every trail pixel sits at ~1% of the star's peak, under any
      //     visibility threshold. Measured: 6 lit pixels in a 320x320 frame.
      //   DO NOT NORMALIZE AT ALL — every trail pixel keeps the star's full peak. That is
      //     what the first, point-sampled build effectively did, and it is ~92x
      //     overexposed: it looked right only because a night sky is mostly black.
      // NEITHER IS THE PHOTOGRAPH. A real star-trail exposure is not a normal exposure
      // with the stars smeared out — the photographer OPENS UP to compensate, which is
      // why trails in a real frame read at roughly the brightness the stars had. So the
      // falloff is the SQUARE ROOT of the arc length: it still darkens with exposure
      // (a 24-hour circle is visibly fainter than a 30-minute arc, as it should be) but
      // at a rate that keeps trails legible over the whole knob range. sqrt is the
      // standard photographic compromise — one stop per quadrupling of the arc.
      // Floored at 1 so a closed shutter is EXACTLY the old point glow.
      float arcLen = abs(arcRad) * rs / max(rel, EPS);
      float glow = mag * rel * rel / (d2 + EPS) / sqrt(max(arcLen, 1.0));
      // SEEDED, never a wall clock: the rate and the phase are hashes of the CELL, so
      // the same star twinkles the same way in the editor, the CLI and both exporters.
      float twinkle = 1.0 - twinkleAmt + twinkleAmt * sin(uTime * (1.5 + 4.0 * hash21(c + 1.3)) + hash21(c) * TWO_PI);
      acc += starTint(hash21(c + 9.2)) * glow * twinkle;
    }
  }
  }
  return acc * amount;
}

half4 main(float2 fragCoord) {
  float2 pl = rot2(fragCoord - uCenter, -uAngle);
  float cov = 1.0 - smoothstep(-EDGE_AA, EDGE_AA, sdRoundRect(pl, uHalfSize, uCornerRadius));
  if (cov <= 0.0) return half4(0.0);

  float2 fuv = pl / max(uHalfSize, float2(1.0)); // [-1,1] box frame
  float vx = fuv.x, up = -fuv.y;                 // up: +1 top, -1 bottom
  float3 dirV = domeDir(vx, up);

  // ── atmospheric single-scattering summed over the queried suns ──────────────
  float3 betaR = BETA_R * uAtmosphere;
  float  betaM = BETA_M * uAtmosphere * (uTurbidity / 3.0);
  float3 betaTot = betaR + betaM;
  float  amV = airmass(dirV.y);
  float3 viewT = exp(-betaTot * amV);
  float3 daySky = float3(0.0);
  float  maxSunUp = -10.0;
  for (int i = 0; i < MAX_SUNS; i++) {
    float active = step(float(i), uSunCount - 0.5);
    float3 dirS = domeDir(uSunPos[i].x, -uSunPos[i].y);
    maxSunUp = max(maxSunUp, mix(-10.0, dirS.y, active));
    float mu = dot(dirV, dirS);
    float amS = airmass(dirS.y);
    float3 sunT = exp(-betaTot * amS * 1.1);                 // sunlight reddening by its airmass
    float3 scatterCoef = betaR * phaseR(mu) + betaM * phaseM(mu, MIE_G);
    float3 inScatter = scatterCoef / max(betaTot, float3(BETA_FLOOR)) * (1.0 - viewT); // closed-form single scatter (guarded: see BETA_FLOOR)
    float3 sunCol = uSunColor[i].rgb;
    float  sunI = uSunColor[i].a;
    daySky += active * SUN_RADIANCE * sunI * sunCol * sunT * inScatter;
  }
  daySky *= uZenith;
  float3 dayCol = float3(1.0) - exp(-uExposure * daySky); // HDR tone-map

  // ── day ↔ night ramp (driven by the highest sun; no sun ⇒ night) ────────────
  float dayF = smoothstep(-0.10, 0.12, maxSunUp);
  float3 night = uNight + uMoonlight * float3(0.55, 0.62, 0.85);

  // ── stars + Milky Way (night, above the horizon) ────────────────────────────
  float aboveHorizon = smoothstep(uHorizon - 0.02, uHorizon + 0.04, up);
  float nightAmt = (1.0 - dayF) * aboveHorizon;
  // The star lattice lives in the box's own WORLD-px plane (y-up, centred), which is
  // what makes it isotropic and box-size independent — see starField.
  float2 pw = float2(pl.x, -pl.y) / max(uScale, EPS);
  float cellPx = STAR_SPAN_PX / max(uStarDensity, EPS);
  float3 galAxis = normalize(float3(0.35, 0.55, 0.75));

  // ── THE RIGID DOME + THE LONG EXPOSURE, in one loop (BM) ────────────────────
  // ONE ANGLE drives BOTH night layers — the same "turns" goes to skyRotatePlane for
  // the stars and to skyRotateDir for the band, so the two cannot drift apart: there
  // is one expression for the time of day and both layers read it. Each rotation acts
  // in its own layer's natural frame, which is forced by two pinned laws that point in
  // opposite directions (see SKY_POLE_AXIS for the measurements that settled it).
  //
  // A LONG EXPOSURE integrates the sky along that rotation path, and THE TWO LAYERS
  // INTEGRATE BY DIFFERENT MEANS because they are different KINDS of picture:
  //   THE STARS ARE INTEGRATED ANALYTICALLY, inside starField, by measuring each pixel's
  //     distance to the star's swept ARC instead of to the star. Point sampling was built
  //     first and MEASURED to be structurally incapable here — a continuous trail needs
  //     107 to 5093 samples at the shipped exposures against a hard ceiling of 64 (SkSL
  //     unrolls the loop), and the rendered frame beaded exactly as that predicts. See
  //     starField's own note for the arithmetic and the closed form.
  //   THE BAND IS SAMPLED, because it has no closed form (it is fbm over a direction) and
  //     needs none: it is a broad smooth field, so a handful of samples blur it without
  //     any of the aliasing that destroyed the point-sampled stars. Its cost is also the
  //     only reason uTrailSamples still exists.
  //
  // WHY IN-SHADER AND NOT THE COMPOSITOR'S MOTION BLUR. The compositor blurs a FINISHED
  // widget along ONE LINEAR velocity. A star trail is a family of CONCENTRIC ARCS whose
  // direction and length both vary across the frame (zero at the pole, longest at the
  // rim), which no single linear kernel can express — it would smear the pole as hard as
  // the rim and bend nothing. It would also drag the ATMOSPHERE, THE HORIZON AND THE
  // GROUND along with the stars, and in a real long exposure the landscape is the one
  // thing that stays sharp. Doing it here gets all three right.
  float trailTurns = uTrailArc;
  int steps = int(clamp(uTrailSamples, 1.0, float(MAX_TRAIL_SAMPLES)));
  if (trailTurns == 0.0) steps = 1; // an unopened shutter is one sample, exactly

  // THE STARS: ONE evaluation, at the shutter-open rotation, integrated over the arc.
  float2 pwR = skyRotatePlane(pw, uTimeOfDay);
  // The pole expressed in the same CELL frame starField works in, and relative to the
  // pixel — so inside that function the shading point is the origin, as "star" already is.
  float2 poleCell = (SKY_POLE_PX - pwR) / max(cellPx, EPS);
  float3 stars = starField(pwR, cellPx, uStarSize, nightAmt, uTwinkle, trailTurns * TWO_PI, poleCell);

  // THE BAND: sampled along the same arc, from the same angle.
  float mwAcc = 0.0, mottAcc = 0.0;
  for (int i = 0; i < MAX_TRAIL_SAMPLES; i++) {
    if (i >= steps) break;
    // Sub-turn offset: the shutter opened at uTimeOfDay and the sky turned trailTurns
    // while it was open. steps == 1 puts the single sample exactly at uTimeOfDay, so
    // a closed shutter is byte-identical to no trail feature at all.
    float f = steps > 1 ? float(i) / float(steps - 1) : 0.0;
    float turns = uTimeOfDay + trailTurns * f;
    // THE SAME ANGLE THE STARS TOOK — this is the rigid dome: one uTimeOfDay, one
    // trailTurns, read by both layers in their own frames.
    float3 rdN = normalize(skyRotateDir(dirV, turns));
    // gLat is the SINE OF GALACTIC LATITUDE and it is SIGNED — the band straddles its
    // own great circle, so half the sky has gLat < 0. It is SQUARED BY MULTIPLICATION,
    // never pow(): "pow(x, y)" IS UNDEFINED FOR x < 0 in SkSL, and while this read
    // pow(dot(rdN, galAxis), 2.0) the entire negative-latitude half of the sky came out
    // with NO Milky Way at all, bounded by a HARD ARC where gLat crosses zero — the
    // biggest half of R6-9.2 ("the galaxy is not seamless"). MEASURED at 720x200 with
    // the band cranked, largest luma gradient over the frame's 99th percentile: 51-63
    // with the pow, 1.8-3.1 without. ANY pow() IN A SHADER NEEDS ITS BASE PROVED
    // NON-NEGATIVE — the other pow()s in this file are (a hash in [0,1), and three
    // wrapped in max(…, EPS)).
    float gLatS = dot(rdN, galAxis);
    float bandS = exp(-(gLatS * gLatS) / (2.0 * MW_SIGMA * MW_SIGMA));
    // Noised on the DIRECTION, not on (azimuth, elevation) — see fbm3 for the branch-cut
    // seam that removes. The two offsets decorrelate the mottling from the dust lanes.
    float mottS = fbm3(rdN * MW_MOTTLE_FREQ + 4.0);
    float dustS = fbm3(rdN * MW_DUST_FREQ + 11.0);
    mwAcc += bandS * mottS * (1.0 - 0.55 * dustS);
    mottAcc += mottS;
  }
  // ── THE TWO ACCUMULATIONS ARE NOT THE SAME OPERATOR, and this is the one place
  // the long exposure could be got physically wrong without looking wrong at a glance.
  //
  // THE BAND AVERAGES. It is a continuous SURFACE BRIGHTNESS — it is already covering
  // the pixel at every instant of the exposure, so holding the shutter open longer does
  // not make it brighter, it only smears its structure. Mean over the samples.
  //
  // THE STARS INTEGRATE. A star is a POINT source sweeping ACROSS the pixel: it is only
  // over any given pixel for a fraction of the exposure, and the film collects light the
  // whole time it is there. Averaging by the SAMPLE COUNT is therefore wrong, and wrong
  // by a factor that grows with the arc: a star crossing a 20 px arc lands in a given
  // pixel for ~1 of 24 samples, so a mean leaves that pixel at ~5% of the star's peak
  // and everything but the brightest stars falls below visibility. MEASURED, that is
  // exactly what happened — a trailed frame lit 281 pixels against the instant frame's
  // 793, i.e. the trail DIMMED THE SKY instead of smearing it.
  //
  // The band's samples AVERAGE: it is a continuous surface brightness, already covering
  // the pixel at every instant, so a longer exposure smears its structure without
  // brightening it. (The stars' own normalization is analytic and lives in starField —
  // a point source crossing the pixel is a different integral, and normalizing it like
  // this one is what dimmed the first sampled version into invisibility.)
  float inv = 1.0 / float(steps);
  float mott = mottAcc * inv;
  float mw = mwAcc * inv * uMilkyWay * nightAmt;
  float3 mwCol = mix(uGalaxyTint, float3(1.0, 0.92, 0.8), mott) * mw;

  float3 col = mix(night, dayCol, dayF) + stars + mwCol;

  // ── ground below the horizon ────────────────────────────────────────────────
  float groundMask = 1.0 - smoothstep(uHorizon - 0.03, uHorizon + 0.01, up);
  float3 ground = uGround * (0.28 + 0.72 * clamp(dayF + 0.15, 0.0, 1.0));
  col = mix(col, ground, groundMask);

  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── uniform packer ──────────────────────────────────────────────────────────

/** Pure. Asserts finiteness (a NaN uniform blackens the region — fail loud). */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`sky pack: "${name}" must be a finite number, got ${v}`);
  return v;
}
/** Pure. A colour knob -> [r,g,b] via the shared node-safe parseColor (alpha dropped). */
function rgb(name, v) { const c = parseColor(v); return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])]; }

/**
 * Pure function. Packs the sky uniforms into the flat Float32Array CanvasKit
 * expects (SkSL declaration order, tight-packed). `u` is the material framework's
 * normalized input: DEVICE-px geometry {cx, cy, halfW, halfH, cornerRadius, angle}
 * + `scale` + this material's own already-evaluated knobs (spread from the op's
 * `params`). `u.suns` is the query result the plugin mapped into THIS box's
 * [-1,1] frame: [{sx, sy, color, intensity}]; it is padded to SKY_MAX_SUNS.
 *
 * @param {object} u geometry + {time, horizon, turbidity, atmosphere, exposure,
 *   starDensity, starSize, milkyWay, timeOfDay, twinkle, trailArc, trailSamples,
 *   moonlight, zenith, ground, night, galaxyTint, suns:[{sx,sy,color,intensity}]}
 * @returns {Float32Array} length 57
 *
 * @example packSky({cx:0,cy:0,halfW:640,halfH:360,cornerRadius:0,angle:0,scale:1,
 *   time:0,horizon:-0.15,turbidity:3,atmosphere:1,exposure:1.1,starDensity:40,starSize:0.82,
 *   milkyWay:1,timeOfDay:0.5,twinkle:0.3,trailArc:0,trailSamples:24,moonlight:0,
 *   zenith:"#8ab4ff",ground:"#0b0d12",
 *   night:"#05070f",galaxyTint:"#3a4a6a",suns:[{sx:0.2,sy:-0.5,color:"#fff",intensity:1}]}).length // 57
 */
export function packSky(u) {
  const suns = Array.isArray(u.suns) ? u.suns : [];
  const count = Math.min(suns.length, SKY_MAX_SUNS);
  const ze = rgb("zenith", u.zenith), gr = rgb("ground", u.ground), ni = rgb("night", u.night), ga = rgb("galaxyTint", u.galaxyTint);
  const sunPos = [], sunCol = [];
  for (let i = 0; i < SKY_MAX_SUNS; i++) {
    const s = suns[i];
    if (s) {
      const c = parseColor(s.color);
      sunPos.push(num(`suns[${i}].sx`, s.sx), num(`suns[${i}].sy`, s.sy));
      sunCol.push(c[0], c[1], c[2], num(`suns[${i}].intensity`, s.intensity));
    } else {
      sunPos.push(0, 0);
      sunCol.push(0, 0, 0, 0);
    }
  }
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius), num("angle", u.angle), num("scale", u.scale),
    num("time", u.time),
    num("horizon", u.horizon), num("turbidity", u.turbidity), num("atmosphere", u.atmosphere),
    num("exposure", u.exposure), num("starDensity", u.starDensity), num("starSize", u.starSize),
    num("milkyWay", u.milkyWay),
    // SkSL DECLARATION ORDER (the packer is tight-packed and positional): timeOfDay,
    // then BM's twinkle/trailArc/trailSamples, then moonlight and the sun count.
    num("timeOfDay", u.timeOfDay),
    num("twinkle", u.twinkle), num("trailArc", u.trailArc), num("trailSamples", u.trailSamples),
    num("moonlight", u.moonlight), count,
    ze[0], ze[1], ze[2], gr[0], gr[1], gr[2], ni[0], ni[1], ni[2], ga[0], ga[1], ga[2],
    ...sunPos, ...sunCol,
  ]);
  if (out.length !== SKY_UNIFORM_FLOATS) throw new Error(`packSky: ${out.length} floats, expected ${SKY_UNIFORM_FLOATS}`);
  return out;
}

// ── PROXY stand-in (thumbnail quality) ────────────────────────────────────────
// The sky dome is HEAVY (an analytic atmosphere summed over every sun, per pixel;
// ~1.1s per 256×144 CPU-raster thumbnail) and camera-bound (fills the frame). Its
// proxy is a dead-simple VERTICAL gradient: a representative zenith → horizon →
// ground, chosen day/night by the highest queried sun. No SkSL, no airmass, no
// stars. paint_skia.js turns this spec into a Skia linear gradient.
const PROXY_DAY_ZENITH = [0.30, 0.52, 0.85];   // representative clear-day blue (the zenith param MULTIPLIES this)
const PROXY_DAY_HORIZON = [0.80, 0.87, 0.96];  // representative pale day horizon
const PROXY_HORIZON_BAND = 0.04;               // half-width (0..1 of box height) of the sky↔ground transition
const PROXY_GROUND_NIGHT_FLOOR = 0.30;         // ground brightness with no sun up (matches the shader's night darkening)
const PROXY_GROUND_DAY_GAIN = 0.70;            // extra ground brightness at full day
const PROXY_DAY_RAMP_LO = -0.10;               // sun elevation (box up-units) where night→day begins (shader's dayF ramp)
const PROXY_DAY_RAMP_HI = 0.12;                // …and where it reaches full day

/** Pure. Clamp x into [lo,hi]. @example clampN(1.4, 0, 1) // 1 */
function clampN(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
/** Pure. smoothstep(e0,e1,x). @example sstep(0, 1, 0.5) // 0.5 */
function sstep(e0, e1, x) { const t = clampN((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); }
/** Pure. Component-wise lerp of two rgb triples. THE sky family's one copy —
 *  sky_sun_shader.js and sky_moon_shader.js import it from here (the latter had it
 *  as `moonMix3`, an identical body under a prefixed name, which is duplication a
 *  grep for "mix3" does not even reveal). Exported from this module rather than a
 *  new one because the family already treats this file as its main entry and
 *  neither sibling is imported BY it, so there is no cycle to create.
 *  @example mix3([0,0,0],[1,1,1],0.5) // [0.5,0.5,0.5] */
export function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/**
 * Pure function. The sky PROXY stand-in spec: a vertical linear gradient from a
 * representative zenith (top) through the horizon to the ground (bottom), blended
 * day↔night by the highest queried sun's elevation. Coordinates are in the region's
 * LOCAL space (paint_skia.js applies the view+world CTM); colours are [r,g,b,a] in
 * 0..1 (fully opaque — the dome fills its box).
 *
 * The horizon param is in box "up" units (+1 top, −1 bottom); it maps to the
 * gradient offset (1 − horizon)/2. Suns carry {sx, sy} in the box frame where the
 * elevation is −sy (up positive), matching the SkSL.
 *
 * @param {object} params - the sky's op params ({horizon, zenith, ground, night, suns:[{sx,sy}]})
 * @param {{cx:number, cy:number, halfW:number, halfH:number}} region - local-space geometry
 * @returns {{kind:"linear", x0:number, y0:number, x1:number, y1:number, stops:Array<{offset:number, color:[number,number,number,number]}>}}
 *
 * @example skyProxyFill({horizon: -0.15, zenith: "#ffffff", ground: "#0d1017", night: "#04060e", suns: [{sx: 0.3, sy: -0.5}]}, {cx: 128, cy: 72, halfW: 128, halfH: 72}).kind // "linear"
 * @example skyProxyFill({horizon: 0, zenith: "#ffffff", ground: "#000000", night: "#000000", suns: [{sx: 0, sy: -0.5}]}, {cx: 0, cy: 0, halfW: 100, halfH: 100}).stops.length // 4
 * @example skyProxyFill({horizon: 0, zenith: "#ffffff", ground: "#000000", night: "#000000", suns: []}, {cx: 0, cy: 0, halfW: 100, halfH: 100}).stops[0].color[2] < 0.1 // true (night: near-black zenith)
 */
export function skyProxyFill(params, region) {
  const suns = Array.isArray(params.suns) ? params.suns : [];
  let maxSunUp = -Infinity;
  for (const s of suns) maxSunUp = Math.max(maxSunUp, -(s.sy ?? 0));
  const dayF = suns.length ? sstep(PROXY_DAY_RAMP_LO, PROXY_DAY_RAMP_HI, maxSunUp) : 0;

  const zenithMul = rgb("zenith", params.zenith ?? "#ffffff");
  const night = rgb("night", params.night ?? "#04060e");
  const groundBase = rgb("ground", params.ground ?? "#0d1017");
  const dayZenith = [PROXY_DAY_ZENITH[0] * zenithMul[0], PROXY_DAY_ZENITH[1] * zenithMul[1], PROXY_DAY_ZENITH[2] * zenithMul[2]];
  const zenithColor = mix3(night, dayZenith, dayF);
  const horizonColor = mix3(night, PROXY_DAY_HORIZON, dayF);
  const gGain = PROXY_GROUND_NIGHT_FLOOR + PROXY_GROUND_DAY_GAIN * dayF;
  const ground = [groundBase[0] * gGain, groundBase[1] * gGain, groundBase[2] * gGain];

  const hT = clampN((1 - (params.horizon ?? 0)) / 2, PROXY_HORIZON_BAND, 1 - PROXY_HORIZON_BAND);
  const top = region.cy - region.halfH, bot = region.cy + region.halfH;
  return {
    kind: "linear",
    x0: region.cx, y0: top, x1: region.cx, y1: bot,
    stops: [
      { offset: 0, color: [zenithColor[0], zenithColor[1], zenithColor[2], 1] },
      { offset: hT - PROXY_HORIZON_BAND, color: [horizonColor[0], horizonColor[1], horizonColor[2], 1] },
      { offset: hT + PROXY_HORIZON_BAND, color: [ground[0], ground[1], ground[2], 1] },
      { offset: 1, color: [ground[0], ground[1], ground[2], 1] },
    ],
  };
}

// ── THE FILL-MATERIAL HALF (sky as the FILL of any shape) ─────────────────────
// The end-state ruling "demo widgets are just shapes with material; custom
// properties become material properties" (render_gpu/skia/materials.js). Sky is
// the SCENE-COUPLED member of the framework: its scattering reads the sibling
// skySun/skyMoon nodes. That coupling is the material's `sceneParams(node,
// nodesById)` hook — resolveMaterialPaint (materials.js), THE one resolution
// site, calls it once per op at scene-build time and folds its result into
// `resolvedParams`, so every sky-filled shape on a slide shares the same suns and
// the painter stays scene-blind. The `sky` WIDGET (plugins/demo/sky.js) derives
// its customProps from SKY_FILL_PARAMS and routes its OWN gather through the same
// mapSkyScene declaration — one gather, two consumers.

// ── the scrub feel of the sky rows (moved here with SKY_FILL_PARAMS) ───────────
// web/NumericField.svelte only range-scales a row that carries BOTH bounds; a
// half-open or fully open row falls back to 1 unit per drag-pixel. Every freed row
// declares an explicit `scrub` = (the span it used to have) / RANGE_DRAG_PX, which
// reproduces EXACTLY the bounded feel. Same rule and derivation as
// core/properties.js SECONDS_SCRUB / UNIT_SPAN_SCRUB (the one-unit case, imported).
// plugins/demo/sky.js imports RANGE_DRAG_PX to derive the sun disc's own span.
export const RANGE_DRAG_PX = 100; // web/NumericField.svelte's own constant (px of drag per full range)
// The ONE-UNIT span (== core/properties.js UNIT_SPAN_SCRUB, which is also 1/RANGE_DRAG_PX):
// atmosphere/timeOfDay. Re-derived from RANGE_DRAG_PX rather than imported so this shader
// entry stays OFF the core/properties.js import hub (importing it perturbs a latent
// module-init cycle through properties.js — the sky WIDGET still imports the canonical
// UNIT_SPAN_SCRUB for its sun/moon/cloud rows).
const UNIT_SPAN_SCRUB = 1 / RANGE_DRAG_PX;
// Rows that span TWO units: the [−1, +1] BOX FRAME the sky shaders work in (the
// horizon row) and the Milky-Way strength (whose old 0..2 range has the same span).
const BOX_SPAN_SCRUB = 2 / RANGE_DRAG_PX;
// Turbidity's old 1..12 haze range (span 11).
const HAZE_SPAN_SCRUB = 11 / RANGE_DRAG_PX;

/**
 * THE `sky` KNOB SCHEMA — the ONE declaration of the material's look knobs, in the
 * customProps row shape (the fill-material framework's single-declaration rule).
 * Both consumers derive from it: plugins/demo/sky.js spreads it into the widget's
 * self.* customProps (adding only the widget-side `cornerRadius` geometry knob), and
 * the FILL-material PaintField renders it as the paint's param rows, resolved sparse-
 * over-defaults by materials.resolveMaterialPaint. Geometry (`cornerRadius`) and the
 * scene-derived params (suns/moonlight) are NOT here — geometry is the shape, and the
 * suns come from sceneParams. Every bound below is GEOMETRIC or TECHNICAL and says why
 * on its row (the manifest "no arbitrary constraints" audit); a taste-only limit is
 * dropped and the row carries the `scrub` that preserves its old feel.
 */
export const SKY_FILL_PARAMS = [
  // NO FLOOR (the old min:−1 was ARBITRARY — a position in the box frame capped at the
  // box's own edges, which blocked the legitimate all-sky framing). Pushing the horizon
  // below the bottom edge only GROWS the mapping's denominator (1 − horizon), so the
  // dome stays smooth and simply compresses toward the zenith: −2 and −4 render clean,
  // distinct, sun-lit skies with no ground band. The CEILING OF +1 IS TECHNICAL and
  // stays: this shader maps box height to elevation with
  // `(up − uHorizon) / max(1 − uHorizon, EPS)`, whose denominator is exactly 0 at +1 and
  // NEGATIVE (a sign flip of the whole dome) above it. Its `max(·, EPS)` divide guard
  // already SILENTLY swallows anything past +1 — measured: horizon 1.5 and horizon 4
  // render byte-identically — and a silent clamp discards the user's value, which is
  // the same disease as a UX cap. +1 is not a taste line either: it already IS the
  // all-ground framing (the whole box is below the horizon), so nothing is lost.
  { name: "horizon", kind: "number", default: -0.15, max: 1, scrub: BOX_SPAN_SCRUB, help: "Horizon height in the box frame (−1 bottom … +1 top). Below it is ground, above it is sky. Lower = more sky, and NO lower bound — push it past −1 for an all-sky framing with no ground at all (the dome just compresses toward the zenith). +1 is the top edge: the whole box becomes ground, which is as far as the horizon can go." },
  // NO CEILING (the old max:12 was ARBITRARY — 40, 500 and 10000 render distinct,
  // progressively thicker smogs). THE FLOOR OF 0 IS TECHNICAL and 0 itself is a real,
  // useful sky (pure Rayleigh — the deepest blue there is). Turbidity scales the MIE
  // coefficient, and the dome's closed-form scatter divides by the TOTAL extinction
  // betaTot = uAtmosphere·(BETA_R + BETA_M·uTurbidity/3): a NEGATIVE turbidity walks each
  // colour channel's divisor through its own zero (red at −8.286, green at −19.3, blue at
  // −47.3) and flips that channel's transmittance exp(−betaTot·airmass) into exponential
  // GROWTH. Measured: −4 punches a black hole around the sun, −20 is neon yellow/magenta
  // channel-clipping bands, and everything at or below −1000 collapses to ONE flat white
  // frame (−1000 and −100000 are byte-identical — a silent swallow). A scattering
  // coefficient cannot be negative; this floor is where the model stops being a model.
  { name: "turbidity", kind: "number", default: 3, min: 0, scrub: HAZE_SPAN_SCRUB, help: "Atmospheric haze: scales Mie scattering. 0 = pure Rayleigh (the deepest, cleanest blue), ~2 = very clear, ~8 = hazy/washed-out with a broad sun glow, and NO upper cap — hundreds give a thick warm smog. 0 is a REAL floor, not taste: turbidity scales a scattering coefficient, and a negative one drives the sky's own divisor through zero." },
  // FLOOR NOW 0 (the old min:0.1 was ARBITRARY — 0.001, 0.02 and 0.1 render distinct,
  // ever-thinner skies). 0 ITSELF IS TECHNICAL AND IS NOW LEGAL: betaTot is the divisor of
  // the closed-form single scatter and vanishes with uAtmosphere, so 0 used to be an
  // UNGUARDED 0/0 — measured, the whole dome came out flat white (a NaN rendering as
  // backend-defined garbage). This shader now floors that divisor with BETA_FLOOR, which
  // makes 0 the exact physical limit (no scattering ⇒ a black airless sky with only the
  // ground band) and leaves every positive value byte-identical. SCRUB is UNIT_SPAN_SCRUB
  // (its twin `exposure` scrubs the same, a half-open unit-nominal multiplier).
  { name: "atmosphere", kind: "number", default: 1, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Overall atmosphere thickness — scales all scattering. Higher = denser/brighter sky (past ~100 the dome saturates into its own haze); 0 is the airless limit, a black sky with only the ground showing. 0 is a REAL floor: this is the divisor of the scattering integral." },
  // NO BOUNDS (the old min:0.05 was ARBITRARY). 0 is a black day sky and NEGATIVE values
  // are honoured, not swallowed: the tone map 1 − exp(−exposure·daySky) turns them into
  // SUBTRACTED light — measured, −1, −2 and −5 each render a distinct twilight (mean luma
  // 9.450 / 9.460 / 9.580) before −50 and below bottom out at one solid black frame.
  { name: "exposure", kind: "number", default: 1.1, help: "HDR tone-map exposure. Higher = brighter overall (past ~20 the day sky blows out to white); 0 leaves a black day sky, and there is no floor — a negative exposure SUBTRACTS light, crushing the dome through twilight to black." },
  // FLOOR NOW 0 (the old min:1 was ARBITRARY: densities 0, 0.5, 1 and 1.4 render DISTINCT
  // skies — at a star-sphere rotation where the coarse grid actually lands a star). 0 IS
  // THE TECHNICAL FLOOR: the SkSL passes max(uStarDensity, EPS) into starField, so
  // anything below silently becomes EPS — measured, −46 and −100 are byte-identical to 0.
  //
  // DEFAULT 46 → 79 WITH THE R6-9.1 STRETCH FIX, and the two numbers describe the SAME
  // sky. The lattice used to be box-relative and anisotropic; it is now a square lattice
  // of STAR_SPAN_PX/starDensity world px (starField says why). 79 is the density that
  // puts the same cell COUNT in the default 1000×620 box as 46 did — old count
  // 2·(AZ_SPAN/PI)·(2/(1−horizon))·D² = 1.827·D², new count 0.62·D², so
  // D' = 46·√(1.827/0.62) = 78.96. Every shipped preset is scaled by the same 79/46, so
  // the Bortle-class RATIOS its descriptions cite are exactly preserved.
  { name: "starDensity", kind: "number", default: 79, min: 0, help: "How many star-lattice cells fit across 1000 px of the slide — more = more, tighter-packed stars (visible at night); no upper cap. It is a density in PAGE px, not in box fractions, so stretching or resizing the sky does not restretch or rescale the stars; it just shows more or less of the same field. Below ~1 one cell is wider than the whole widget, so stars thin out to none. 0 is the floor because the shader's own guard would silently swallow anything under it." },
  // A LENGTH, NOT A MULTIPLIER, and independent of starDensity — which is the whole point
  // (R6-9.1: "they need their own scale, controllable with respect to pixel space"). The
  // old grid did both jobs with one number, so the only way to enlarge a star was to
  // delete stars. DEFAULT 0.82 = the old coupled radius at the old default box and
  // density: the glow was mag/(240·r_cell²), i.e. a core radius of pitch/√240 = 12.66/15.49
  // world px, so the default sky is unchanged by the decoupling itself. WORLD px, not
  // device px: a device-px star would be a function of zoom and dpr, so one document
  // would export differently at 1080p and 4K.
  { name: "starSize", kind: "number", default: 0.82, min: 0, help: "Star core radius in page px — the radius at which the brightest stars reach full brightness. Its inverse-square halo reaches several times further, so this reads as overall star SIZE. Independent of Star density: raise it for fat soft stars at the same count, lower it for a fine sharp dusting. 0 is the floor and switches the stars off entirely." },
  // NO BOUNDS (both were ARBITRARY). Past the old max:2 the band keeps brightening —
  // 8 and 100 are distinct, ever more blazing galaxies — and NEGATIVE values are honoured
  // too (−1 and −5 render distinct night skies, mean luma 9.46 vs 8.05): the band is
  // SUBTRACTED, carving a dark dust lane out of the night. Neither end swallows.
  { name: "milkyWay", kind: "number", default: 1, scrub: BOX_SPAN_SCRUB, help: "Milky-Way band strength (0 = off). Only visible at night. Unbounded both ways: past 2 the band keeps brightening until its core saturates white, and a negative value subtracts it, carving the band out of the sky as a dark dust lane." },
  // NO BOUNDS: the rotation is PERIODIC — the SkSL does rot2(g, uTimeOfDay·TWO_PI) — so the
  // old 0..1 cap was ARBITRARY and it blocked keyframing a multi-turn spin (0 → 3).
  // Measured byte-identical: 0 ≡ 1 ≡ 3, and 0.25 ≡ 1.25 ≡ 12.25 ≡ 100.25 (the float32
  // argument survives 10 000 turns), 0.5 ≡ 2.5 ≡ −0.5.
  { name: "timeOfDay", kind: "number", default: 0.2, scrub: UNIT_SPAN_SCRUB, help: "Rotates the whole night sky — stars and Milky Way together, as one rigid dome about the celestial pole. 0..1 is ONE full turn, and it is unbounded because the rotation is periodic: keyframe 0 → 3 to spin the sky three whole turns (2.5 renders exactly like 0.5, as a turn should), or go negative to wheel the other way. The day/night look itself is driven by the SUN widgets' elevation, not this." },
  // TWINKLE IS THE SHADER'S ONE CLOCK READER, which is why it is also the predicate
  // SKY_MATERIAL.animated is built on. DEFAULT 0.3 IS THE OLD BAKED CONSTANT: the
  // factor was written `0.7 + 0.3·sin(…)` and is now `1 − a + a·sin(…)`, so a = 0.3
  // reproduces the previous expression EXACTLY and every deck authored before this
  // knob existed renders byte-identically. 0 is not merely "very little" — it makes
  // the factor exactly 1.0, so the term drops out and the sky stops depending on `t`
  // at all, which is what lets `animated` be false and the presenter's repaint loop
  // stand down (the CRT "Rock Steady" precedent). NO CEILING: past 1 the trough goes
  // NEGATIVE and stars blink fully out and back, a harder scintillation than the
  // atmosphere really does but a legitimate stylised look; the floor is 0 because a
  // negative amount is just the same twinkle a half-cycle out of phase, i.e. it
  // reaches nothing the positive side does not already reach.
  { name: "twinkle", kind: "number", default: 0.3, min: 0, scrub: UNIT_SPAN_SCRUB, help: "How much the stars scintillate, as a fraction of each star's own brightness (0.3 = the classic ±30% shimmer). Each star gets its own seeded rate and phase, so the field never pulses in unison. 0 switches twinkling off completely — and that is a real off, not a small value: the sky then stops reading the clock at all, so a slide holding it needs no repaint loop. Above 1 the dimmest point of the cycle goes dark, so stars blink right out and back." },
  // ── THE LONG EXPOSURE (a SECOND, disjoint preset family — see plugins/demo/sky.js)
  // NO CEILING: the arc is turns of sky rotation, and a multi-turn exposure is a real
  // (if unusual) photograph — at 1 every star has closed its circle, which renders as
  // complete concentric rings, and beyond that the rings simply retrace themselves and
  // brighten. NEGATIVE IS LEGAL AND MEANINGFUL: it trails the sky the other way, i.e.
  // the shutter closed at `timeOfDay` instead of opening there, so keyframing timeOfDay
  // with a negative arc leaves the trail BEHIND the motion rather than ahead of it.
  { name: "trailArc", kind: "number", default: 0, scrub: UNIT_SPAN_SCRUB, help: "Long-exposure star trails: how far the sky turns while the shutter is open, in TURNS (0 = none, a normal instant photograph; 0.02 ≈ a 30-minute exposure; 1 = a full circle, so every star closes its own ring). Stars smear into concentric arcs about the celestial pole and the Milky Way blurs along the same arcs, exactly as it does in the real photograph — the ground and the atmosphere stay sharp, because only the sky is turning. Negative trails the other way, leaving the smear behind the motion." },
  // SAMPLES IS COST, NOT LOOK, and it is the one row here whose bounds are purely
  // TECHNICAL. The floor of 1 is the shader's own clamp (a zero-sample exposure has no
  // picture to average); the ceiling is MAX_TRAIL_SAMPLES = 64, past which the SkSL's
  // constant trip count cannot go — the loop is unrolled, so the bound is compiled in
  // rather than chosen. It is a MAX, not a fixed count: the shader runs `steps` samples
  // and a short arc needs far fewer than a long one, so raising the arc is what forces
  // this up. MEASURED at 600x600 with the arc at 0.05: 8 samples read as a visible
  // string of separate beads, 24 as a dotted arc, 48 as a continuous line; the default
  // 24 is where the shortest useful arcs are already smooth and the cost is one pass in
  // twenty-four rather than in forty-eight.
  { name: "trailSamples", kind: "number", default: 24, min: 1, max: 64, step: 1, help: "How many samples the long exposure accumulates along its arc. Only matters when Trail arc is non-zero; it is a QUALITY/COST knob, not a look. Too few and a long trail breaks into a string of beads — raise it as you lengthen the arc. 64 is the ceiling because the shader unrolls this loop, so its trip count is fixed at compile time." },
  { name: "zenith", kind: "color", default: "#ffffff", help: "Zenith colour multiplier applied to the scattered day sky. White = pure physics; tint to warm/cool the whole dome." },
  { name: "ground", kind: "color", default: "#0d1017", help: "Ground/foreground colour below the horizon (darkens at night)." },
  { name: "night", kind: "color", default: "#04060e", help: "Deep night-sky colour the dome fades to once every sun is below the horizon." },
  { name: "galaxyTint", kind: "color", default: "#46567c", help: "Milky-Way glow tint (a cool dusty blue; the bright core adds warm highlights)." },
];

// ── the SIBLING GATHER (moved out of the widget's emit; ONE declaration) ──────
const EMPTY_SCENE = { suns: [], moons: [] };
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
// The sky's night-ambient lift per fully-lit moon (a dim silvery wash, not daylight).
const MOONLIGHT_GAIN = 0.28;

/**
 * Pure function. Maps a WORLD point into a reader box's LOCAL [-1,1] frame — the
 * exact frame the shaders use (fuv = pl/uHalfSize, box centre = 0, edges = ±1). The
 * box's stored geometry is a local [0..w]×[0..h] rect centred at (w/2, h/2), so a
 * world point is inverted through `world`, re-centred, and normalized by the half
 * extent. Rotation/scale of the box are handled by the world inverse, so the sun
 * lands where it visually sits regardless of how the sky box is posed.
 *
 * @param {object} world - the reader node's local→world similarity {x,y,rotation,scale}
 * @param {number} w - box width (local units)
 * @param {number} h - box height (local units)
 * @param {number} wx - world x of the sibling
 * @param {number} wy - world y of the sibling
 * @returns {{sx: number, sy: number}} box-frame coords (fuv space; sy is y-DOWN)
 *
 * @example mapToBoxFrame({x: 0, y: 0, rotation: 0, scale: 1}, 200, 100, 100, 50) // {sx: 0, sy: 0} (centre)
 * @example mapToBoxFrame({x: 0, y: 0, rotation: 0, scale: 1}, 200, 100, 200, 50) // {sx: 1, sy: 0} (right edge)
 * @example mapToBoxFrame({x: 0, y: 0, rotation: 0, scale: 1}, 200, 100, 100, 0) // {sx: 0, sy: -1} (top edge)
 */
export function mapToBoxFrame(world, w, h, wx, wy) {
  const local = T.apply(T.invert(world), wx, wy);
  return { sx: (local.x - w / 2) / (w / 2), sy: (local.y - h / 2) / (h / 2) };
}

/**
 * Pure function. The queried suns mapped into a reader box's frame, ready for the
 * packer: each sun's world CENTRE becomes {sx, sy} in the box's [-1,1] frame, its
 * colour/intensity carried through. Shared by the `sky` fill (via mapSkyScene) and the
 * `skyClouds`/`sky` widgets' emit.
 *
 * @param {{suns?: object[]}} scene - collectSkyScene result (world coords)
 * @param {object} world - the reader node's local→world similarity
 * @param {number} w - box width
 * @param {number} h - box height
 * @returns {Array<{sx:number, sy:number, color:string, intensity:number}>}
 *
 * @example mappedSuns({suns: [{x: 200, y: 50, color: "#fff", intensity: 2}]}, {x: 0, y: 0, rotation: 0, scale: 1}, 200, 100) // [{sx: 1, sy: 0, color: "#fff", intensity: 2}]
 * @example mappedSuns({suns: []}, {x: 0, y: 0, rotation: 0, scale: 1}, 100, 100) // []
 */
export function mappedSuns(scene, world, w, h) {
  return (scene.suns ?? []).map((s) => {
    const { sx, sy } = mapToBoxFrame(world, w, h, s.x, s.y);
    return { sx, sy, color: s.color, intensity: s.intensity };
  });
}

/**
 * Pure function. A moon's illuminated fraction for its phase, f = (1 − cos ε)/2 with
 * elongation ε = 2π·phase (0 new → 0, 0.5 full → 1). The sky's night ambient is lifted
 * by how much moonlight the moon(s) provide.
 *
 * @param {number} phase - 0..1
 * @returns {number} 0..1
 *
 * @example illuminatedFraction(0)    // 0   (new moon)
 * @example illuminatedFraction(0.5)  // 1   (full moon)
 * @example illuminatedFraction(0.25) // 0.5 (first quarter)
 */
export function illuminatedFraction(phase) {
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/**
 * Pure function. THE `sky` SCENE MAPPING — the ONE declaration of how a collected
 * {suns, moons} scene becomes the sky's scene-derived params in a reader box's local
 * frame: the suns mapped into [-1,1] and the moons folded into a single moonlight lift
 * (MOONLIGHT_GAIN × Σ illuminated fraction). Both the SKY_MATERIAL.sceneParams fill
 * hook (gathering from nodesById) and the `sky` WIDGET's emit (consuming its derive-
 * attached s.skyScene) route through this, so a sky-filled shape and the sky widget
 * compute suns identically.
 *
 * @param {{suns?: object[], moons?: object[]}} scene - collectSkyScene result
 * @param {object} world - the box's local→world similarity
 * @param {number} w - box width
 * @param {number} h - box height
 * @returns {{suns: Array, moonlight: number}}
 *
 * @example mapSkyScene({suns: [{x: 200, y: 50, color: "#fff", intensity: 2}], moons: []}, {x: 0, y: 0, rotation: 0, scale: 1}, 200, 100).suns[0].sx // 1
 * @example mapSkyScene({suns: [], moons: [{phase: 0.5}]}, {x: 0, y: 0, rotation: 0, scale: 1}, 100, 100).moonlight // 0.28
 * @example mapSkyScene({suns: [], moons: []}, {x: 0, y: 0, rotation: 0, scale: 1}, 100, 100) // {suns: [], moonlight: 0}
 */
export function mapSkyScene(scene, world, w, h) {
  const moonlight = MOONLIGHT_GAIN * (scene.moons ?? []).reduce((a, m) => a + illuminatedFraction(m.phase), 0);
  return { suns: mappedSuns(scene, world, w, h), moonlight };
}

/**
 * Query. THE FILL-MATERIAL SCENE HOOK (materials.resolveMaterialPaint calls it). Gathers
 * the sibling skySun/skyMoon nodes from `nodesById` — the same collectSkyScene the derive
 * stage runs — and maps them into THIS node's own box frame, so any shape with a sky fill
 * gets the scene's suns without being a skyReader itself. A SUNLESS scene resolves to
 * `{suns: [], moonlight: 0}` (a night sky), never a throw — the empty case is the common
 * one (a lone sky-filled shape).
 *
 * @param {{world?: object, state?: object}|null} node - the emitting render node
 * @param {Map|null} nodesById - itemId → derived node (its values are the scene)
 * @returns {{suns: Array, moonlight: number}} the scene-derived resolved params
 *
 * @example skySceneParams(null, null) // {suns: [], moonlight: 0}
 * @example skySceneParams(null, null).suns.length // 0
 */
export function skySceneParams(node, nodesById) {
  const scene = nodesById ? collectSkyScene([...nodesById.values()]) : EMPTY_SCENE;
  const world = node?.world ?? IDENTITY;
  return mapSkyScene(scene, world, node?.state?.w ?? 0, node?.state?.h ?? 0);
}

/**
 * Near-pure function (reads the ambient particle clock). SCHEMA params
 * (SKY_FILL_PARAMS names + the sceneParams-derived suns/moonlight) → packSky's
 * numeric params, adding the ambient `time`. THE one mapping both consumers share:
 * the demo widget builds the same shape by hand in emit(), and the fill-material
 * regionOp synthesis (paint_skia handleMaterialPaintShape) reads it as
 * entry.toUniformParams. Names already match packSky, so this is mostly a pass-through
 * that injects `time` and defaults the scene params (a paint with no sceneParams still
 * resolves — though sky always declares one).
 *
 * @param {object} p - resolved params (every SKY_FILL_PARAMS knob + suns + moonlight)
 * @returns {object} packSky-shaped params
 *
 * @example skyUniformParams({horizon: -0.15, turbidity: 3, atmosphere: 1, exposure: 1.1, starDensity: 79, starSize: 0.82, milkyWay: 1, timeOfDay: 0.2, twinkle: 0.3, trailArc: 0, trailSamples: 24, zenith: "#ffffff", ground: "#0d1017", night: "#04060e", galaxyTint: "#46567c", suns: [], moonlight: 0}).horizon // -0.15
 * @example skyUniformParams({horizon: 0, turbidity: 3, atmosphere: 1, exposure: 1.1, starDensity: 79, starSize: 0.82, milkyWay: 1, timeOfDay: 0.2, twinkle: 0.3, trailArc: 0, trailSamples: 24, zenith: "#fff", ground: "#000", night: "#000", galaxyTint: "#000", suns: [], moonlight: 0}).suns.length // 0
 * @example skyUniformParams({horizon: 0, turbidity: 3, atmosphere: 1, exposure: 1.1, starDensity: 79, starSize: 0.82, milkyWay: 1, timeOfDay: 0.2, twinkle: 0, trailArc: 0.25, trailSamples: 48, zenith: "#fff", ground: "#000", night: "#000", galaxyTint: "#000", suns: [], moonlight: 0}).trailArc // 0.25
 */
export function skyUniformParams(p) {
  return {
    time: particleTime(),
    horizon: p.horizon, turbidity: p.turbidity, atmosphere: p.atmosphere, exposure: p.exposure,
    starDensity: p.starDensity, starSize: p.starSize, milkyWay: p.milkyWay, timeOfDay: p.timeOfDay,
    twinkle: p.twinkle, trailArc: p.trailArc, trailSamples: p.trailSamples,
    moonlight: p.moonlight ?? 0,
    zenith: p.zenith, ground: p.ground, night: p.night, galaxyTint: p.galaxyTint,
    suns: p.suns ?? [],
  };
}

/**
 * Pure function. Does this sky READ THE CLOCK? PARAM-PREDICATED `animated`, the CRT
 * precedent (crtParamsAreAnimated, commit 9a6f215) — and this entry used to declare a
 * flat `animated: true`, which was true only by accident of the twinkle amount being
 * baked in at 0.3.
 *
 * TWINKLE IS THE SHADER'S ONLY `uTime` READ. Everything else that moves in this sky is
 * DOCUMENT state, not elapsed time: `timeOfDay` rotates the dome and `trailArc` opens
 * the shutter, and both are keyframed values that a still renders from its own
 * `[[slide, alpha]]` — they animate a PRESENTATION without making the paint animated at
 * rest, which is exactly the distinction paintIsAnimated draws. So at twinkle = 0 the
 * factor `1 − a + a·sin(…)` is exactly 1.0, the picture is byte-identical at any `t`,
 * and a repaint loop would spin for nothing.
 *
 * @param {object} params - the material's resolved knobs
 * @returns {boolean}
 *
 * @example skyParamsAreAnimated({twinkle: 0.3}) // true
 * @example skyParamsAreAnimated({twinkle: 0})   // false (the exact identity — no clock read)
 * @example skyParamsAreAnimated({twinkle: 0, trailArc: 0.5}) // false (a trail is document state, not a clock)
 */
export const skyParamsAreAnimated = (params) => (params.twinkle ?? 0) !== 0;

/** FOREGROUND generative material descriptor (backdrop:false). `proxyFill` gives the
 * thumbnail/minimap (quality:"proxy") path a cheap vertical-gradient stand-in
 * instead of the full analytic-atmosphere SkSL. `fillParams`/`toUniformParams`/
 * `sceneParams` opt it into the fill-material framework: any shape can carry a sky
 * fill, and its scattering reads the scene's suns through the sibling gather. */
export const SKY_MATERIAL = {
  id: "sky",
  // PARAM-PREDICATED (see skyParamsAreAnimated): twinkle is the one clock reader.
  animated: skyParamsAreAnimated,
  sksl: SKY_SKSL,
  pack: packSky,
  uniformFloats: SKY_UNIFORM_FLOATS,
  backdrop: false,
  proxyFill: skyProxyFill,
  fillParams: SKY_FILL_PARAMS,
  toUniformParams: skyUniformParams,
  sceneParams: skySceneParams,
};
