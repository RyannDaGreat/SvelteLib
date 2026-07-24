/**
 * THE skyMoon material SkSL — a realistic moon with correct WAXING/WANING PHASES.
 * A GENERATIVE (backdrop:false) FOREGROUND material (materialFill), self-contained
 * in its own box. The disc's sphere normal is reconstructed (z = √(1−x²−y²)); a sun
 * direction derived from the `phase` prop (ε = 2π·phase, sunDir = (sin ε, 0, −cos ε))
 * lights it with a Lambert term — so the terminator is the CORRECT curved ellipse
 * (semi-minor axis R·|cos ε|) and the lit LIMB is on the right for waxing / left for
 * waning, exactly as in the real northern-hemisphere sky. `limbAngle` tilts the
 * terminator; the plugin can point it at the nearest queried sun (a sibling
 * interaction) or leave it upright. Surface maria (fbm), limb darkening, and a faint
 * earthshine on the dark side complete it.
 *
 * FULLY PROCEDURAL — the maria are fbm on the reconstructed normal (a single
 * placement, no tiling, so no seam concern). DOM-free at import.
 */

import { parseColor } from "../ir.js";

const SKY_MOON_UNIFORM_FLOATS = 8 + 3 + 5; // geometry 8 + uColor 3 + (phase,limbAngle,earthshine,maria,size) 5 = 16

export const SKY_MOON_SKSL = `
const float TWO_PI = 6.28318531;
const float EDGE_AA = 1.0;
const float EPS = 1e-3;

uniform float2 uCenter;
uniform float2 uHalfSize;
uniform float  uCornerRadius;
uniform float  uAngle;
uniform float  uScale;
uniform float  uTime;
uniform float3 uColor;       // moon albedo tint
uniform float  uPhase;       // 0=new .25=first-qtr .5=full .75=last-qtr
uniform float  uLimbAngle;   // terminator tilt (radians); orients the bright limb
uniform float  uEarthshine;  // dark-side glow strength
uniform float  uMaria;       // dark-mare contrast
uniform float  uSize;        // disc radius as a fraction of the shorter half-extent

float hash21(float2 p) { p = fract(p * float2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
float vnoise(float2 x) {
  float2 i = floor(x), f = fract(x);
  float a = hash21(i), b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0)), d = hash21(i + float2(1.0, 1.0));
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(float2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.0 + 11.3; a *= 0.5; } return v; }
float2 rot2(float2 v, float a) { float c = cos(a), s = sin(a); return float2(c * v.x - s * v.y, s * v.x + c * v.y); }

half4 main(float2 fragCoord) {
  float2 pl = rot2(fragCoord - uCenter, -uAngle);
  float minHalf = max(min(uHalfSize.x, uHalfSize.y), 1.0);
  float2 d = (pl / minHalf) / max(uSize, EPS);   // [-1,1] across the disc
  float dd = dot(d, d);
  float disc = 1.0 - smoothstep(1.0, 1.0 + EDGE_AA / (minHalf * max(uSize, EPS)), sqrt(dd));
  if (disc <= 0.0) return half4(0.0);

  // reconstruct the front-hemisphere sphere normal (z toward the viewer)
  float z = sqrt(max(1.0 - dd, 0.0));
  float3 n = float3(d, z);

  // sun direction from the phase; tilt by the limb angle (rotate in the view plane)
  float eps = TWO_PI * uPhase;
  float3 sunDir = float3(sin(eps), 0.0, -cos(eps));
  sunDir = float3(rot2(sunDir.xy, uLimbAngle), sunDir.z);

  float ndl = dot(n, sunDir);
  float lit = smoothstep(-0.09, 0.09, ndl);      // soft (curved-ellipse) terminator
  float limb = pow(clamp(z, 0.0, 1.0), 0.45);    // limb darkening

  // maria: low-frequency darker patches on the surface (fbm on the normal)
  float mare = fbm(n.xy * 2.6 + 5.0);
  float albedoMod = 1.0 - uMaria * 0.55 * smoothstep(0.35, 0.75, mare);
  float3 albedo = uColor * albedoMod;

  float3 col = albedo * (lit * limb) + albedo * uEarthshine * (1.0 - lit) * 0.14;

  float a = disc;
  return half4(clamp(col, 0.0, 1.0) * half(a), half(a));
}
`;

function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`skyMoon pack: "${name}" must be a finite number, got ${v}`);
  return v;
}

/**
 * Pure function. Packs the skyMoon uniforms (SkSL declaration order).
 *
 * @param {object} u geometry + {color, phase, limbAngle, earthshine, maria, size}
 * @returns {Float32Array} length 16
 *
 * @example packSkyMoon({cx:0,cy:0,halfW:110,halfH:110,cornerRadius:0,angle:0,scale:1,
 *   time:0,color:"#e8e6de",phase:0.3,limbAngle:0,earthshine:0.5,maria:0.6,size:0.72}).length // 16
 */
export function packSkyMoon(u) {
  const c = parseColor(u.color);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy), num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius), num("angle", u.angle), num("scale", u.scale), num("time", u.time),
    c[0], c[1], c[2],
    num("phase", u.phase), num("limbAngle", u.limbAngle), num("earthshine", u.earthshine),
    num("maria", u.maria), num("size", u.size),
  ]);
  if (out.length !== SKY_MOON_UNIFORM_FLOATS) throw new Error(`packSkyMoon: ${out.length} floats, expected ${SKY_MOON_UNIFORM_FLOATS}`);
  return out;
}

export const SKY_MOON_MATERIAL = {
  id: "skyMoon",
  sksl: SKY_MOON_SKSL,
  pack: packSkyMoon,
  uniformFloats: SKY_MOON_UNIFORM_FLOATS,
  backdrop: false,
};
