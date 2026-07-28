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
 * hash over a cellular grid of the (time-rotated) view direction, magnitude-
 * distributed, blackbody-tinted. Milky Way: great-circle band mask × fbm mottling.
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

// geometry 8 + scalars 9 + float3 tints 12 + float2[4] suns 8 + float4[4] sunColor 16
const SKY_UNIFORM_FLOATS = 8 + 9 + 12 + 8 + 16; // = 53

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
uniform float  uScale;         // device px per world unit (unused here; contract slot)
uniform float  uTime;          // ambient animation seconds (frozen in editor/CLI)
// ── user knobs (self.* custom props) ──────────────────────────────────────────
uniform float  uHorizon;       // horizon height in box frame (up units; 0 = middle, <0 = lower)
uniform float  uTurbidity;     // haze: scales Mie (2 = clear, 8 = hazy)
uniform float  uAtmosphere;    // overall atmosphere thickness (scales all scattering)
uniform float  uExposure;      // HDR tone-map exposure
uniform float  uStarDensity;   // star grid resolution (more = more stars)
uniform float  uMilkyWay;      // Milky-Way band strength (0 = off)
uniform float  uTimeOfDay;     // 0..1 — rotates the star sphere / Milky Way
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
// Pure. Value noise (smoothstep-interpolated hashed lattice) for fbm.
float vnoise(float2 x) {
  float2 i = floor(x), f = fract(x);
  float a = hash21(i), b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0)), d = hash21(i + float2(1.0, 1.0));
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Pure. 5-octave fbm (lacunarity 2, gain 0.5) for the Milky-Way mottling.
float fbm(float2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.0 + 19.7; a *= 0.5; }
  return v;
}
// Pure. Rotate a 2-vector by angle.
float2 rot2(float2 v, float a) { float c = cos(a), s = sin(a); return float2(c * v.x - s * v.y, s * v.x + c * v.y); }
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
// Query-like. The star-field contribution for a view direction (time-rotated grid).
float3 starField(float3 rd, float density, float amount) {
  if (amount <= 0.0) return float3(0.0);
  // project to (azimuth, elevation) and wheel by time-of-day
  float2 g = float2(atan(rd.x, rd.z) / PI, asin(clamp(rd.y, -1.0, 1.0)) / HALF_PI);
  g = rot2(g, uTimeOfDay * TWO_PI) * density;
  float2 cell = floor(g), fpos = fract(g);
  float3 acc = float3(0.0);
  // sample the 3x3 cell neighbourhood so a star's glow crosses cell borders
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      float2 c = cell + float2(float(dx), float(dy));
      float present = hash21(c + 7.1);
      if (present < STAR_THRESHOLD) continue;
      float2 star = float2(float(dx), float(dy)) + hash22(c) - fpos;
      float mag = pow(hash21(c + 3.7), STAR_MAG_POW);      // rare bright stars
      float glow = mag / (dot(star, star) * 240.0 + EPS);  // inverse-square core+halo
      float twinkle = 0.7 + 0.3 * sin(uTime * (1.5 + 4.0 * hash21(c + 1.3)) + hash21(c) * TWO_PI);
      acc += starTint(hash21(c + 9.2)) * glow * twinkle;
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
  float3 stars = starField(dirV, max(uStarDensity, EPS), nightAmt);
  float2 rdXZ = rot2(dirV.xz, uTimeOfDay * TWO_PI);      // wheel the galaxy with the stars
  float3 rdR = float3(rdXZ.x, dirV.y, rdXZ.y);
  float3 galAxis = normalize(float3(0.35, 0.55, 0.75));
  float band = exp(-pow(dot(normalize(rdR), galAxis), 2.0) / (2.0 * MW_SIGMA * MW_SIGMA));
  float mott = fbm(float2(atan(rdR.x, rdR.z) * 2.2, asin(clamp(rdR.y, -1.0, 1.0)) * 3.0) + 4.0);
  float dust = fbm(float2(atan(rdR.x, rdR.z) * 5.0, asin(clamp(rdR.y, -1.0, 1.0)) * 6.0) + 11.0);
  float mw = band * mott * (1.0 - 0.55 * dust) * uMilkyWay * nightAmt;
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
 *   starDensity, milkyWay, timeOfDay, moonlight, zenith, ground, night, galaxyTint,
 *   suns:[{sx,sy,color,intensity}]}
 * @returns {Float32Array} length 53
 *
 * @example packSky({cx:0,cy:0,halfW:640,halfH:360,cornerRadius:0,angle:0,scale:1,
 *   time:0,horizon:-0.15,turbidity:3,atmosphere:1,exposure:1.1,starDensity:40,
 *   milkyWay:1,timeOfDay:0.5,moonlight:0,zenith:"#8ab4ff",ground:"#0b0d12",
 *   night:"#05070f",galaxyTint:"#3a4a6a",suns:[{sx:0.2,sy:-0.5,color:"#fff",intensity:1}]}).length // 53
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
    num("exposure", u.exposure), num("starDensity", u.starDensity), num("milkyWay", u.milkyWay),
    num("timeOfDay", u.timeOfDay), num("moonlight", u.moonlight), count,
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
/** Pure. Component-wise lerp of two rgb triples. @example mix3([0,0,0],[1,1,1],0.5) // [0.5,0.5,0.5] */
function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

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
  { name: "starDensity", kind: "number", default: 46, min: 0, help: "Star-field grid resolution — more = more stars (visible at night); no upper cap. Below ~1 the grid is coarser than the whole sky, so stars thin out to none. 0 is the floor because the shader's own guard would silently swallow anything under it." },
  // NO BOUNDS (both were ARBITRARY). Past the old max:2 the band keeps brightening —
  // 8 and 100 are distinct, ever more blazing galaxies — and NEGATIVE values are honoured
  // too (−1 and −5 render distinct night skies, mean luma 9.46 vs 8.05): the band is
  // SUBTRACTED, carving a dark dust lane out of the night. Neither end swallows.
  { name: "milkyWay", kind: "number", default: 1, scrub: BOX_SPAN_SCRUB, help: "Milky-Way band strength (0 = off). Only visible at night. Unbounded both ways: past 2 the band keeps brightening until its core saturates white, and a negative value subtracts it, carving the band out of the sky as a dark dust lane." },
  // NO BOUNDS: the rotation is PERIODIC — the SkSL does rot2(g, uTimeOfDay·TWO_PI) — so the
  // old 0..1 cap was ARBITRARY and it blocked keyframing a multi-turn spin (0 → 3).
  // Measured byte-identical: 0 ≡ 1 ≡ 3, and 0.25 ≡ 1.25 ≡ 12.25 ≡ 100.25 (the float32
  // argument survives 10 000 turns), 0.5 ≡ 2.5 ≡ −0.5.
  { name: "timeOfDay", kind: "number", default: 0.2, scrub: UNIT_SPAN_SCRUB, help: "Rotates the star sphere + Milky Way: 0..1 is ONE full turn, and it is unbounded because the rotation is periodic — keyframe 0 → 3 to spin the night sky three whole turns (2.5 renders exactly like 0.5, as a turn should), or go negative to wheel the other way. The day/night look itself is driven by the SUN widgets' elevation, not this." },
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
 * @example skyUniformParams({horizon: -0.15, turbidity: 3, atmosphere: 1, exposure: 1.1, starDensity: 46, milkyWay: 1, timeOfDay: 0.2, zenith: "#ffffff", ground: "#0d1017", night: "#04060e", galaxyTint: "#46567c", suns: [], moonlight: 0}).horizon // -0.15
 * @example skyUniformParams({horizon: 0, turbidity: 3, atmosphere: 1, exposure: 1.1, starDensity: 46, milkyWay: 1, timeOfDay: 0.2, zenith: "#fff", ground: "#000", night: "#000", galaxyTint: "#000", suns: [], moonlight: 0}).suns.length // 0
 */
export function skyUniformParams(p) {
  return {
    time: particleTime(),
    horizon: p.horizon, turbidity: p.turbidity, atmosphere: p.atmosphere, exposure: p.exposure,
    starDensity: p.starDensity, milkyWay: p.milkyWay, timeOfDay: p.timeOfDay,
    moonlight: p.moonlight ?? 0,
    zenith: p.zenith, ground: p.ground, night: p.night, galaxyTint: p.galaxyTint,
    suns: p.suns ?? [],
  };
}

/** FOREGROUND generative material descriptor (backdrop:false). `proxyFill` gives the
 * thumbnail/minimap (quality:"proxy") path a cheap vertical-gradient stand-in
 * instead of the full analytic-atmosphere SkSL. `fillParams`/`toUniformParams`/
 * `sceneParams` opt it into the fill-material framework: any shape can carry a sky
 * fill, and its scattering reads the scene's suns through the sibling gather. */
export const SKY_MATERIAL = {
  id: "sky",
  animated: true, // reads particleTime — the presenter must keep repainting (paintIsAnimated)
  sksl: SKY_SKSL,
  pack: packSky,
  uniformFloats: SKY_UNIFORM_FLOATS,
  backdrop: false,
  proxyFill: skyProxyFill,
  fillParams: SKY_FILL_PARAMS,
  toUniformParams: skyUniformParams,
  sceneParams: skySceneParams,
};
