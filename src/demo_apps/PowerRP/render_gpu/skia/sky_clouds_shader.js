/**
 * THE skyClouds material SkSL — procedural fbm clouds LIT BY THE SUN(S), catching
 * warm sunset colour at the horizon. A GENERATIVE (backdrop:false) FOREGROUND
 * material (materialFill). It READS the scene's suns via the derive-time sibling
 * query (positions mapped into this box's [-1,1] frame + colours), so the sunlit
 * side of the clouds points at the sun and, when the sun is low, goes orange/red.
 *
 * ── TECHNIQUE (grounded; see .claude_sky_design.md) ──────────────────────────
 * Coverage: domain-warped 5-octave fbm → smoothstep(coverage, coverage+softness).
 * Lighting: the Inigo-Quilez directional-derivative diffuse trick — sample the
 * density a short step TOWARD the sun; if it drops (clearer path) the parcel is lit.
 * lin = ambientSky + sunColour·dif, with the sun colour warm-shifted by how LOW the
 * sun sits (automatic sunset catch even for a white sun). Base cloud colour darkens
 * with density; a Beer-powder edge term keeps thin edges from over-brightening.
 *
 * FULLY PROCEDURAL (fbm) — wraps/animates with no texture seam. DOM-free at import.
 */

import { parseColor } from "../ir.js";

export const SKY_CLOUDS_MAX_SUNS = 4;

// geometry 8 + scalars (coverage,softness,cloudScale,speed,sunCount) 5
//   + float3 ambient/base 6 + float2[4] 8 + float4[4] 16 = 43
const SKY_CLOUDS_UNIFORM_FLOATS = 8 + 5 + 6 + 8 + 16;

export const SKY_CLOUDS_SKSL = `
const int   MAX_SUNS = ${SKY_CLOUDS_MAX_SUNS};
const float EDGE_AA = 1.0;
const float EPS = 1e-3;

uniform float2 uCenter;
uniform float2 uHalfSize;
uniform float  uCornerRadius;
uniform float  uAngle;
uniform float  uScale;
uniform float  uTime;
uniform float  uCoverage;    // lower = more cloud
uniform float  uSoftness;    // coverage edge width
uniform float  uCloudScale;  // spatial frequency of the fbm
uniform float  uSpeed;       // drift speed
uniform float  uSunCount;
uniform float3 uAmbient;     // cool sky ambient (shadowed sides)
uniform float3 uBase;        // cloud base tint
uniform float2 uSunPos[${SKY_CLOUDS_MAX_SUNS}];
uniform float4 uSunColor[${SKY_CLOUDS_MAX_SUNS}];

float hash21(float2 p) { p = fract(p * float2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
float vnoise(float2 x) {
  float2 i = floor(x), f = fract(x);
  float a = hash21(i), b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0)), d = hash21(i + float2(1.0, 1.0));
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(float2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 1.97 + 13.1; a *= 0.5; } return v; }
float2 rot2(float2 v, float a) { float c = cos(a), s = sin(a); return float2(c * v.x - s * v.y, s * v.x + c * v.y); }
float sdRoundRect(float2 p, float2 h, float r) { float2 q = abs(p) - (h - r); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// Pure. Domain-warped cloud density at a field point.
float density(float2 p) { float2 w = float2(fbm(p + 0.0), fbm(p + 5.2)); return fbm(p + 1.4 * w); }

half4 main(float2 fragCoord) {
  float2 pl = rot2(fragCoord - uCenter, -uAngle);
  float boxCov = 1.0 - smoothstep(-EDGE_AA, EDGE_AA, sdRoundRect(pl, uHalfSize, uCornerRadius));
  if (boxCov <= 0.0) return half4(0.0);

  float2 fuv = pl / max(uHalfSize, float2(1.0));            // [-1,1]
  float2 p = fuv * uCloudScale + float2(uTime * uSpeed * 0.03, 0.0);
  float den = density(p);
  float cloud = smoothstep(uCoverage, uCoverage + max(uSoftness, EPS), den);
  if (cloud <= 0.0) return half4(0.0);

  // lighting: ambient sky + each sun's warm, lit-ness-weighted contribution
  float3 lin = uAmbient;
  for (int i = 0; i < MAX_SUNS; i++) {
    float active = step(float(i), uSunCount - 0.5);
    float2 toSun = uSunPos[i] - fuv;
    float2 sdir = toSun / max(length(toSun), EPS);
    // directional-derivative diffuse: density drops toward the sun ⇒ lit
    float step2 = 0.35;
    float dif = clamp((den - density(p + sdir * step2)) / step2, 0.0, 1.0);
    // sun elevation in box (up = -sy); warm-shift the light as the sun gets low
    float sunUp = -uSunPos[i].y;
    float low = smoothstep(0.45, -0.1, sunUp);
    float3 warm = mix(uSunColor[i].rgb, uSunColor[i].rgb * float3(1.35, 0.7, 0.42), low);
    lin += active * warm * uSunColor[i].a * dif;
  }

  float3 base = mix(float3(1.0, 0.96, 0.9) * uBase, uBase * 0.35, den); // lighter edges, darker cores
  float3 col = base * lin;
  // Beer-powder edge shaping so thin edges don't over-brighten
  float powder = 1.0 - exp(-2.0 * den);
  col *= mix(1.0, powder, 0.4);

  // feather the clouds away from the box AABB so a rectangular cloud band never
  // shows a hard boundary against the sky (a separate-widget artefact)
  float2 e = abs(fuv);
  float edgeFade = (1.0 - smoothstep(0.70, 1.0, e.x)) * (1.0 - smoothstep(0.70, 1.0, e.y));
  float a = cloud * boxCov * edgeFade;
  return half4(clamp(col, 0.0, 1.0) * half(a), half(a));
}
`;

function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`skyClouds pack: "${name}" must be a finite number, got ${v}`);
  return v;
}
function rgb(name, v) { const c = parseColor(v); return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])]; }

/**
 * Pure function. Packs the skyClouds uniforms (SkSL declaration order). `u.suns` is
 * the sibling-query result mapped into THIS box's [-1,1] frame:
 * [{sx, sy, color, intensity}], padded to SKY_CLOUDS_MAX_SUNS.
 *
 * @param {object} u geometry + {time, coverage, softness, cloudScale, speed, ambient,
 *   base, suns:[{sx,sy,color,intensity}]}
 * @returns {Float32Array} length 44
 *
 * @example packSkyClouds({cx:0,cy:0,halfW:450,halfH:200,cornerRadius:0,angle:0,scale:1,
 *   time:0,coverage:0.45,softness:0.28,cloudScale:2.4,speed:1,ambient:"#8fa6c8",
 *   base:"#f2efe9",suns:[{sx:0.2,sy:-0.4,color:"#ffddaa",intensity:1}]}).length // 44
 */
export function packSkyClouds(u) {
  const suns = Array.isArray(u.suns) ? u.suns : [];
  const count = Math.min(suns.length, SKY_CLOUDS_MAX_SUNS);
  const am = rgb("ambient", u.ambient), ba = rgb("base", u.base);
  const sunPos = [], sunCol = [];
  for (let i = 0; i < SKY_CLOUDS_MAX_SUNS; i++) {
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
    num("cx", u.cx), num("cy", u.cy), num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius), num("angle", u.angle), num("scale", u.scale), num("time", u.time),
    num("coverage", u.coverage), num("softness", u.softness), num("cloudScale", u.cloudScale),
    num("speed", u.speed), count,
    am[0], am[1], am[2], ba[0], ba[1], ba[2],
    ...sunPos, ...sunCol,
  ]);
  if (out.length !== SKY_CLOUDS_UNIFORM_FLOATS) throw new Error(`packSkyClouds: ${out.length} floats, expected ${SKY_CLOUDS_UNIFORM_FLOATS}`);
  return out;
}

export const SKY_CLOUDS_MATERIAL = {
  id: "skyClouds",
  sksl: SKY_CLOUDS_SKSL,
  pack: packSkyClouds,
  uniformFloats: SKY_CLOUDS_UNIFORM_FLOATS,
  backdrop: false,
};
