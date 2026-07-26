/**
 * THE skySun material SkSL — a sun in the sky: an emissive disc + a Mie
 * forward-scatter aureole/halo. A GENERATIVE (backdrop:false) FOREGROUND material
 * (materialFill), self-contained in its own box. MULTIPLE skySun widgets are
 * allowed; each one's POSITION and COLOUR are read by the `sky` (and `skyClouds`)
 * widgets through the derive-time sibling query, so moving/recolouring a sun
 * changes the atmosphere around it. The disc itself is drawn HERE.
 *
 * The disc is round (aspect-corrected via the box's shorter half-extent); the
 * aureole is an exponential halo whose spread/strength are knobs (the Mie glow the
 * research describes). Output is TRANSPARENT outside the disc+halo so the sky shows
 * through — premultiplied alpha, self-limiting well inside the box.
 *
 * DOM-free at import. parseColor (render_gpu/ir.js) is the shared colour parser.
 */

import { parseColor } from "../ir.js";

const SKY_SUN_UNIFORM_FLOATS = 8 + 3 + 4; // geometry 8 + uColor 3 + (intensity,size,glow,glowRadius) 4 = 15

export const SKY_SUN_SKSL = `
const float EDGE_AA = 1.0;
const float EPS = 1e-3;
const float HALO_REACH = 0.99; // the aureole reaches this fraction of the box half-extent then
                               // VANISHES (compact support) — so a wide glow never leaves a hard
                               // square where it meets the box AABB (a separate-widget artefact)

uniform float2 uCenter;
uniform float2 uHalfSize;
uniform float  uCornerRadius;
uniform float  uAngle;
uniform float  uScale;
uniform float  uTime;
uniform float3 uColor;       // sun light colour
uniform float  uIntensity;   // disc radiance
uniform float  uSize;        // disc radius as a fraction of the shorter half-extent
uniform float  uGlow;        // aureole strength
uniform float  uGlowRadius;  // aureole exponential falloff (fraction of shorter half-extent)

float2 rot2(float2 v, float a) { float c = cos(a), s = sin(a); return float2(c * v.x - s * v.y, s * v.x + c * v.y); }

half4 main(float2 fragCoord) {
  float2 pl = rot2(fragCoord - uCenter, -uAngle);
  // aspect-correct radial coords: a round disc regardless of box aspect
  float minHalf = max(min(uHalfSize.x, uHalfSize.y), 1.0);
  float2 uv = pl / minHalf;
  float r = length(uv);

  float disc = 1.0 - smoothstep(uSize, uSize * 1.12 + EDGE_AA / minHalf, r);
  // compact-support envelope: exactly 0 at HALO_REACH so nothing reaches the box edge
  float support = pow(clamp(1.0 - r / HALO_REACH, 0.0, 1.0), 2.0);
  float core = exp(-max(r - uSize, 0.0) / max(uGlowRadius, EPS)); // tight Mie aureole hugging the disc
  float glow = support * (0.45 + 0.9 * core);                    // aureole + broad halo, both vanish at the edge
  float a = clamp(disc + glow * uGlow, 0.0, 1.0);
  if (a <= 0.0) return half4(0.0);

  float3 col = uColor * (uIntensity * disc + uGlow * glow);
  col = float3(1.0) - exp(-col);                                 // soft HDR tone-map (bright core, no harsh clip)
  return half4(clamp(col, 0.0, 1.0) * half(a), half(a));
}
`;

function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`skySun pack: "${name}" must be a finite number, got ${v}`);
  return v;
}

/**
 * Pure function. Packs the skySun uniforms (SkSL declaration order).
 *
 * @param {object} u geometry + {color, intensity, size, glow, glowRadius}
 * @returns {Float32Array} length 15
 *
 * @example packSkySun({cx:0,cy:0,halfW:80,halfH:80,cornerRadius:0,angle:0,scale:1,
 *   time:0,color:"#fff2cc",intensity:3,size:0.32,glow:0.9,glowRadius:0.5}).length // 15
 */
export function packSkySun(u) {
  const c = parseColor(u.color);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy), num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius), num("angle", u.angle), num("scale", u.scale), num("time", u.time),
    c[0], c[1], c[2],
    num("intensity", u.intensity), num("size", u.size), num("glow", u.glow), num("glowRadius", u.glowRadius),
  ]);
  if (out.length !== SKY_SUN_UNIFORM_FLOATS) throw new Error(`packSkySun: ${out.length} floats, expected ${SKY_SUN_UNIFORM_FLOATS}`);
  return out;
}

// ── PROXY stand-in (thumbnail quality) ────────────────────────────────────────
// skySun is the lightest of the sky family (no fbm — a disc + an exp aureole), but
// it is a sky-family GENERATIVE material and its size is camera-scale, so it takes a
// proxy for consistency. RADIAL (not the family's usual vertical gradient) BECAUSE a
// sun is a DISC on a transparent field: a box-filling linear gradient would occlude
// the sky dome behind it, whereas a radial glow (hot centre → transparent rim) keeps
// the transparency and reads as a sun. No SkSL. paint_skia.js draws the radial.
const PROXY_SUN_REACH_FRAC = 0.95;   // aureole radius as a fraction of the shorter half-extent (mirrors the shader's compact-support halo)
const PROXY_SUN_CORE_WHITEN = 0.5;   // how far the hot centre is pushed toward white (the shader's HDR core bloom)
const PROXY_SUN_DISC_EDGE_ALPHA = 0.85; // alpha at the disc edge before the aureole falloff

/** Pure. Clamp x into [lo,hi]. @example clampN(1.4, 0, 1) // 1 */
function clampN(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
/** Pure. Component-wise lerp of two rgb triples. @example mix3([0,0,0],[1,1,1],0.5) // [0.5,0.5,0.5] */
function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/**
 * Pure function. The skySun PROXY stand-in spec: a radial glow at the box centre —
 * a white-hot warm core (the sun colour pushed toward white), the disc body in the
 * sun colour, fading to transparent at the aureole rim so the sky shows through.
 * Coordinates are in the region's LOCAL space; colours are [r,g,b,a] in 0..1.
 *
 * @param {object} params - the sun's op params ({color, size})
 * @param {{cx:number, cy:number, halfW:number, halfH:number}} region - local-space geometry
 * @returns {{kind:"radial", cx:number, cy:number, radius:number, stops:Array<{offset:number, color:[number,number,number,number]}>}}
 *
 * @example skySunProxyFill({color: "#fff4d6", size: 0.26}, {cx: 80, cy: 80, halfW: 80, halfH: 80}).kind // "radial"
 * @example skySunProxyFill({color: "#fff4d6", size: 0.26}, {cx: 80, cy: 80, halfW: 80, halfH: 80}).stops[2].color[3] // 0 (transparent rim)
 * @example skySunProxyFill({color: "#ffffff", size: 0.26}, {cx: 0, cy: 0, halfW: 100, halfH: 100}).radius // 95
 */
export function skySunProxyFill(params, region) {
  const pc = parseColor(params.color ?? "#fff4d6");
  const color = [pc[0], pc[1], pc[2]];
  const minHalf = Math.max(Math.min(region.halfW, region.halfH), 1);
  const radius = PROXY_SUN_REACH_FRAC * minHalf;
  const size = params.size ?? 0.26;
  const discEdge = clampN(size / PROXY_SUN_REACH_FRAC, 0.05, 0.9);
  const core = mix3(color, [1, 1, 1], PROXY_SUN_CORE_WHITEN);
  return {
    kind: "radial",
    cx: region.cx, cy: region.cy, radius,
    stops: [
      { offset: 0, color: [core[0], core[1], core[2], 1] },
      { offset: discEdge, color: [color[0], color[1], color[2], PROXY_SUN_DISC_EDGE_ALPHA] },
      { offset: 1, color: [color[0], color[1], color[2], 0] },
    ],
  };
}

/** `proxyFill` gives the thumbnail/minimap (quality:"proxy") path a cheap radial-disc
 * stand-in instead of the disc+aureole SkSL. */
export const SKY_SUN_MATERIAL = {
  id: "skySun",
  sksl: SKY_SUN_SKSL,
  pack: packSkySun,
  uniformFloats: SKY_SUN_UNIFORM_FLOATS,
  backdrop: false,
  proxyFill: skySunProxyFill,
};
