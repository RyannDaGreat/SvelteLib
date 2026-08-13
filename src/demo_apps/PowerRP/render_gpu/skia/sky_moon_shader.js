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
 *
 * NO uCornerRadius, DELIBERATELY — same reason as sky_sun_shader.js, whose header
 * carries the measurements: this material's silhouette is its own disc SDF, not its
 * region, so there is no corner to round. It used to declare the uniform (and the
 * plugin published a row for it) while `main()` never read it — byte-identical at
 * cornerRadius 0 vs 140 at every disc size. Do not "restore symmetry" with `sky`.
 */

import { parseColor } from "../ir.js";
import { mix3 } from "./sky_shader.js";

const SKY_MOON_UNIFORM_FLOATS = 7 + 3 + 5; // geometry 7 (no cornerRadius — see above) + uColor 3 + (phase,limbAngle,earthshine,maria,size) 5 = 15

export const SKY_MOON_SKSL = `
const float TWO_PI = 6.28318531;
const float EDGE_AA = 1.0;
const float EPS = 1e-3;

uniform float2 uCenter;
uniform float2 uHalfSize;
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
 * @param {object} u geometry + {color, phase, limbAngle, earthshine, maria, size}. A
 *   `cornerRadius` the framework supplies is IGNORED — this material has no such
 *   uniform (see the file header).
 * @returns {Float32Array} length 15
 *
 * @example packSkyMoon({cx:0,cy:0,halfW:110,halfH:110,angle:0,scale:1,
 *   time:0,color:"#e8e6de",phase:0.3,limbAngle:0,earthshine:0.5,maria:0.6,size:0.72}).length // 15
 */
export function packSkyMoon(u) {
  const c = parseColor(u.color);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy), num("halfW", u.halfW), num("halfH", u.halfH),
    num("angle", u.angle), num("scale", u.scale), num("time", u.time),
    c[0], c[1], c[2],
    num("phase", u.phase), num("limbAngle", u.limbAngle), num("earthshine", u.earthshine),
    num("maria", u.maria), num("size", u.size),
  ]);
  if (out.length !== SKY_MOON_UNIFORM_FLOATS) throw new Error(`packSkyMoon: ${out.length} floats, expected ${SKY_MOON_UNIFORM_FLOATS}`);
  return out;
}

// ── PROXY stand-in (thumbnail quality) ────────────────────────────────────────
// skyMoon runs a 5-octave fbm (the maria) per pixel — ~0.17s per 256×144 CPU-raster
// thumbnail. Like skySun it is a DISC on a transparent field, so its proxy is a
// RADIAL (not the family's vertical gradient): a soft-edged albedo disc fading to
// transparent, so the sky shows through and it reads as a moon. Phase / earthshine /
// maria are dropped (invisible at thumbnail size). No SkSL; paint_skia.js draws it.
const PROXY_MOON_SOLID_FRAC = 0.85;  // fraction of the disc radius that stays fully opaque before the soft edge


/**
 * Pure function. The skyMoon PROXY stand-in spec: a soft-edged disc of the moon's
 * albedo tint, fading to transparent at the disc rim so the sky shows through.
 * Coordinates are in the region's LOCAL space; colours are [r,g,b,a] in 0..1.
 *
 * @param {object} params - the moon's op params ({color, size})
 * @param {{cx:number, cy:number, halfW:number, halfH:number}} region - local-space geometry
 * @returns {{kind:"radial", cx:number, cy:number, radius:number, stops:Array<{offset:number, color:[number,number,number,number]}>}}
 *
 * @example skyMoonProxyFill({color: "#e8e6de", size: 0.74}, {cx: 110, cy: 110, halfW: 110, halfH: 110}).kind // "radial"
 * @example skyMoonProxyFill({color: "#e8e6de", size: 0.5}, {cx: 0, cy: 0, halfW: 100, halfH: 100}).radius // 50
 * @example skyMoonProxyFill({color: "#ffffff", size: 0.5}, {cx: 0, cy: 0, halfW: 100, halfH: 100}).stops[2].color[3] // 0 (transparent rim)
 */
export function skyMoonProxyFill(params, region) {
  const c = parseColor(params.color ?? "#e8e6de");
  const albedo = [c[0], c[1], c[2]];
  const minHalf = Math.max(Math.min(region.halfW, region.halfH), 1);
  const radius = Math.max((params.size ?? 0.74) * minHalf, 1);
  // A hint of limb darkening: the rim of the solid disc is slightly dimmer.
  const rim = mix3(albedo, [0, 0, 0], 0.25);
  return {
    kind: "radial",
    cx: region.cx, cy: region.cy, radius,
    stops: [
      { offset: 0, color: [albedo[0], albedo[1], albedo[2], 1] },
      { offset: PROXY_MOON_SOLID_FRAC, color: [rim[0], rim[1], rim[2], 1] },
      { offset: 1, color: [rim[0], rim[1], rim[2], 0] },
    ],
  };
}

/** `proxyFill` gives the thumbnail/minimap (quality:"proxy") path a cheap radial-disc
 * stand-in instead of the phase-lit, maria-fbm SkSL. */
export const SKY_MOON_MATERIAL = {
  id: "skyMoon",
  sksl: SKY_MOON_SKSL,
  pack: packSkyMoon,
  uniformFloats: SKY_MOON_UNIFORM_FLOATS,
  backdrop: false,
  proxyFill: skyMoonProxyFill,
};
