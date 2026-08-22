/**
 * THE METAL STAMP MATERIAL (id "metalStamp") — a BACKDROP material that ENGRAVES (or
 * embosses) its OWN SILHOUETTE into whatever is painted behind it, re-lighting the
 * sharp backdrop through an engrave height-field derived from the silhouette SDF.
 * Stamp a metalStamp-filled logo/text/gear over a metal fill and the metal reads as
 * struck: sunk grooves with beveled walls, a raking key light, a specular pinch at
 * the bevel edge, a darker groove floor with inner AO — and aging that collects IN
 * the grooves.
 *
 * ── THE CREVICE COUPLING (user, verbatim, manifest item 55) ───────────────────
 * "when we stamp, we create crevices — take the derivative of this material to
 * figure out where the crevices would be when we emboss, because that would result
 * in more rust or less rust." So the SAME depth field that shapes the engrave also
 * drives a patina/rust mask: the low areas of the height field (the groove floor for
 * an engrave; the recessed surround for an emboss) age FIRST. Engraved lines patina
 * before the flat faces around them — exactly what a real stamped, weathered plate
 * looks like. patinaAmount / patinaColor / rustCoverage are knobs on the stamp
 * itself, masked by its own depth field (deeper groove ⇒ more aging).
 *
 * ── ARCHITECTURE (frenzy 4: stamped/engraved metal) ───────────────────────────
 * Height h(d) from the silhouette distance d (neg inside), bevel width b, profile
 * ∈ {chamfer, round, V}. The perturbed normal is N = normalize(vec3(uEmboss·grad·
 * z'(d)·depth, 1)) — z'(d) analytic (SkSL ES2 has no dFdx), grad from the SDF child's
 * central difference (the approved 5-tap idiom). The backdrop is sampled SHARP (no
 * blur — usesBlurredBackdrop:false) at the fragment (no displacement, so the declared
 * sample reach is 0) and MULTIPLIED by the relight factor, so a rasterization wobble
 * passes through at its own size (it never divides by alpha — the brightness_contrast
 * hazard the manifest warns of).
 *
 * A BACKDROP material (the {blurredBackdrop, sharpBackdrop} child pair, blurred
 * declared-but-unused), SHAPE-CONFORMING (the fill variant appends `shapeSdf` as
 * child 2). DOM-free at import (string SkSL + pure packers).
 */

import { parseColor } from "../ir.js";
import { schemaAngleRadians } from "../../core/properties.js";

// ── shared prelude (pure SkSL; no uniforms) ───────────────────────────────────
const PRELUDE = `
const int   FBM_OCTAVES = 3;
const float FBM_GAIN = 0.5;
const float FBM_LAC  = 2.0;
const float HASH_X = 127.1;
const float HASH_Y = 311.7;
const float HASH_MUL = 43758.5453;
const float PI = 3.14159265;

float hash21(float2 p) { return fract(sin(dot(p, float2(HASH_X, HASH_Y))) * HASH_MUL); }
float vnoise(float2 x) {
  float2 i = floor(x), f = fract(x);
  float2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0)), d = hash21(i + float2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(float2 x) {
  float s = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  for (int o = 0; o < FBM_OCTAVES; o++) { s += amp * vnoise(x * freq); norm += amp; freq *= FBM_LAC; amp *= FBM_GAIN; }
  return s / norm;
}
float2 rot2(float2 v, float a) { float c = cos(a), s = sin(a); return float2(c * v.x - s * v.y, s * v.x + c * v.y); }
float sdRoundRect(float2 p, float2 h, float r) { float2 q = abs(p) - (h - r); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float ign(float2 p) { return fract(52.9829189 * fract(dot(p, float2(0.06711056, 0.00583715)))); }
`;

// ── shared uniform block (packStamp order) ────────────────────────────────────
const STAMP_UNIFORMS = `
uniform float2 uCenter;      // region center (device px)
uniform float2 uHalfSize;    // region half-extents (device px)
uniform float  uCornerRadius;// analytic radius (device px; base variant only)
uniform float  uAngle;       // widget world rotation (radians)
uniform float  uScale;       // device px per WORLD unit (world-locked aging texture)
uniform float  uDepth;       // 0..1 engrave strength (normal perturbation)
uniform float  uBevelWidth;  // bevel band width (device px)
uniform float  uProfile;     // 0 chamfer / 1 round / 2 V
uniform float  uEmboss;      // +1 emboss (raised) / -1 engrave (sunk)
uniform float2 uLightDir;    // direction TO the key light (cos,sin)
uniform float  uPatinaAmount;// 0..1 patina in the groove (crevice coupling)
uniform float3 uPatinaColor; // patina tone (sRGB 0..1)
uniform float  uRustCoverage;// 0..1 rust in the groove
uniform float  uSeed;        // aging seed (deterministic; NOT time)
`;

// ── shared relight function (reads uniforms + the sharp backdrop child) ───────
const STAMP_SHADE = `
const float LIGHT_Z = 0.45;        // raking key light (low angle exaggerates the relief)
const float NORMAL_GAIN = 2.2;     // height-field -> normal perturbation
const float GROOVE_DARK = 0.55;    // AO: how dark the low areas (groove floor) go
const float SPEC = 0.55;           // specular pinch strength at the bevel wall
const float PINCH_W = 1.6;         // pinch catch-line half-width (device px)
const float PATINA_FREQ = 3.4;     // patina patch frequency (cycles per world unit)
const float RUST_FREQ = 2.8;
const float3 RUST_PRIMARY = float3(0.717, 0.255, 0.055); // #B7410E
const float3 RUST_RECESS  = float3(0.353, 0.141, 0.063); // #5A2410

// Pure. The engrave DEPRESSION profile zNeg(td) in [0,1] (0 at the surface edge, 1 at
// the groove floor) AND its slope dz/d(td), packed as float2(zNeg, slope). profile:
// 0 chamfer (linear wall), 1 round (steep lip, sin), 2 V (steep valley, 1-cos).
float2 engraveProfile(float td, float profile) {
  td = clamp(td, 0.0, 1.0);
  if (profile < 0.5)       return float2(td, 1.0);                               // chamfer
  else if (profile < 1.5)  return float2(sin(td * PI * 0.5), cos(td * PI * 0.5) * PI * 0.5); // round
  else                     return float2(1.0 - cos(td * PI * 0.5), sin(td * PI * 0.5) * PI * 0.5); // V
}

// Given the sharp backdrop colour (premultiplied), the interior distance (device px,
// >0 inside), the OUTWARD unit gradient, and the widget-local position, returns the
// relit premultiplied colour. cov is applied by the caller.
half4 stampShade(half4 back, float distIn, float2 grad, float2 p) {
  float bw = max(uBevelWidth, 1.0);
  float td = clamp(distIn / bw, 0.0, 1.0);      // 0 at the edge -> 1 at the floor
  float2 prof = engraveProfile(td, uProfile);
  float slope = prof.y * step(distIn, bw);      // nonzero only across the bevel band

  // perturbed normal: emboss tilts the wall OUTWARD (+grad), engrave INWARD (-grad).
  float2 nxy = uEmboss * grad * slope * uDepth * NORMAL_GAIN;
  float nz = sqrt(max(1e-3, 1.0 - dot(nxy, nxy)));
  float3 N = float3(nxy, nz);

  float3 L = normalize(float3(normalize(uLightDir), LIGHT_Z));
  float3 H = normalize(L + float3(0.0, 0.0, 1.0));
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 40.0);

  // lowness of the height field: engrave -> the floor (deep interior) is low; emboss
  // -> the recessed surround (near the edge) is low. The aging + AO both key on it.
  float lowness = uEmboss > 0.0 ? (1.0 - td) : td;
  float ao = mix(1.0, GROOVE_DARK, lowness);    // low areas sit in shadow

  // relight the (premultiplied) backdrop: multiply keeps premult valid; spec/pinch
  // are additive, scaled by alpha so they stay premultiplied.
  float raking = mix(0.55, 1.15, diff);         // raking key: lit walls bright, shaded walls dim
  half3 lit = back.rgb * half(raking * ao);
  lit += half3(half(spec * SPEC)) * back.a;
  // specular pinch: a thin bright catch-line where the wall is steepest.
  float pinch = (1.0 - smoothstep(0.0, PINCH_W, abs(distIn - bw * 0.5))) * slope * bw;
  lit += half3(half(pinch * 0.4)) * back.a;

  // ── CREVICE COUPLING: aging collects in the LOW areas of the depth field ──────
  float2 tc = p / uScale + uSeed * 13.0;
  if (uPatinaAmount > 0.0) {
    float2 warp = float2(fbm(tc * PATINA_FREQ * 1.3), fbm(tc * PATINA_FREQ * 1.3 + 5.0));
    float patch = smoothstep(0.3, 0.7, fbm(tc * PATINA_FREQ + 0.4 * warp));
    float mask = clamp(uPatinaAmount * lowness * patch * 1.3, 0.0, 1.0);
    float pd = 0.5 + 0.5 * diff;
    lit = mix(lit, half3(uPatinaColor) * half(pd) * back.a, half(mask));
  }
  if (uRustCoverage > 0.0) {
    float rn = fbm(tc * RUST_FREQ + 23.0);
    float rustField = smoothstep(1.0 - uRustCoverage, 1.0 - uRustCoverage * 0.35, rn);
    float mask = clamp(rustField * lowness, 0.0, 1.0);
    float3 rcol = mix(RUST_PRIMARY, RUST_RECESS, lowness) * (0.8 + 0.4 * fbm(tc * RUST_FREQ * 3.0));
    lit = mix(lit, half3(rcol) * half(0.6 + 0.4 * diff) * back.a, half(mask));
  }

  lit = clamp(lit, half3(0.0), half3(back.a));  // keep premultiplied (rgb <= alpha)
  return half4(lit, back.a);
}
`;

// ── the BASE variant: analytic rounded-rect SDF over the bbox (SDF-less fallback) ──
export const STAMP_SKSL = PRELUDE + `
uniform shader blurredBackdrop;  // child 0: UNUSED (usesBlurredBackdrop:false) — declared to satisfy the fixed pair
uniform shader sharpBackdrop;    // child 1: the sharp composite-so-far
` + STAMP_UNIFORMS + STAMP_SHADE + `
const float ANALYTIC_EPS = 1.0;
half4 main(float2 fragCoord) {
  float2 pl = rot2(fragCoord - uCenter, -uAngle);
  float d = sdRoundRect(pl, uHalfSize, uCornerRadius);
  float cov = 1.0 - smoothstep(-1.0, 1.0, d);
  if (cov <= 0.0) return half4(0.0);
  float e = ANALYTIC_EPS;
  float2 g = float2(
    sdRoundRect(pl + float2(e, 0.0), uHalfSize, uCornerRadius) - sdRoundRect(pl - float2(e, 0.0), uHalfSize, uCornerRadius),
    sdRoundRect(pl + float2(0.0, e), uHalfSize, uCornerRadius) - sdRoundRect(pl - float2(0.0, e), uHalfSize, uCornerRadius));
  float glen = length(g);
  float2 grad = glen > 1e-4 ? g / glen : float2(0.0, 1.0);
  half4 back = sharpBackdrop.eval(fragCoord);
  half4 lit = stampShade(back, -d, grad, pl);
  lit.rgb += half3(half((ign(fragCoord) - 0.5) / 255.0)) * lit.a;
  return lit * half(cov);
}
`;

// ── the SHAPE-CONFORMING variant: silhouette SDF child (child 2) drives the relief ──
export const STAMP_FILL_SKSL = PRELUDE + `
uniform shader blurredBackdrop;  // child 0: UNUSED
uniform shader sharpBackdrop;    // child 1: sharp composite-so-far
uniform shader shapeSdf;         // child 2: silhouette signed distance (device px, <0 inside)
` + STAMP_UNIFORMS + STAMP_SHADE + `
const float SDF_EPS = 1.5;
half4 main(float2 fragCoord) {
  float d = shapeSdf.eval(fragCoord).r;
  float cov = 1.0 - smoothstep(-1.0, 1.0, d);
  if (cov <= 0.0) return half4(0.0);
  float e = SDF_EPS;
  float2 g = float2(
    shapeSdf.eval(fragCoord + float2(e, 0.0)).r - shapeSdf.eval(fragCoord - float2(e, 0.0)).r,
    shapeSdf.eval(fragCoord + float2(0.0, e)).r - shapeSdf.eval(fragCoord - float2(0.0, e)).r);
  float glen = length(g);
  float2 grad = glen > 1e-4 ? g / glen : float2(0.0, 1.0);
  float2 pl = rot2(fragCoord - uCenter, -uAngle);
  half4 back = sharpBackdrop.eval(fragCoord);
  half4 lit = stampShade(back, -d, grad, pl);
  lit.rgb += half3(half((ign(fragCoord) - 0.5) / 255.0)) * lit.a;
  return lit * half(cov);
}
`;

// ── uniform packer ────────────────────────────────────────────────────────────
const STAMP_UNIFORM_FLOATS = 19;

function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`metalStamp pack: "${name}" must be a finite number, got ${v}`);
  return v;
}
function rgb(name, v) { const c = parseColor(v); return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])]; }

/**
 * Pure function. Packs the metal-stamp uniforms (STAMP_UNIFORMS declaration order).
 * `u` is device geometry + `scale` merged with the stampToUniformParams output
 * ({depth, bevelWidthPct, profile[0/1/2], emboss[±1], lightAngle[rad], patinaAmount,
 * patinaColor, rustCoverage, seed}). bevelWidthPct is a % of the shortest half-extent.
 *
 * @param {object} u - device geometry + stampToUniformParams output
 * @returns {Float32Array} length 19
 *
 * @example packStamp({cx:0,cy:0,halfW:90,halfH:90,cornerRadius:0,angle:0,scale:1,
 *   depth:0.7,bevelWidthPct:10,profile:0,emboss:-1,lightAngle:-2.2,patinaAmount:0,
 *   patinaColor:"#43b3ae",rustCoverage:0,seed:3}).length // 19
 */
export function packStamp(u) {
  const patina = rgb("patinaColor", u.patinaColor);
  const a = num("lightAngle", u.lightAngle);
  const bevelDev = Math.max(Math.min(num("halfW", u.halfW), num("halfH", u.halfH)) * (num("bevelWidthPct", u.bevelWidthPct) / 100), 1);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("scale", u.scale),
    num("depth", u.depth),
    bevelDev,
    num("profile", u.profile),
    num("emboss", u.emboss),
    Math.cos(a), Math.sin(a),
    num("patinaAmount", u.patinaAmount),
    patina[0], patina[1], patina[2],
    num("rustCoverage", u.rustCoverage),
    num("seed", u.seed),
  ]);
  if (out.length !== STAMP_UNIFORM_FLOATS) throw new Error(`packStamp: ${out.length} floats, expected ${STAMP_UNIFORM_FLOATS}`);
  return out;
}

// ── the fill-param SCHEMA ─────────────────────────────────────────────────────
export const STAMP_FILL_PARAMS = [
  { name: "depth", kind: "number", default: 0.7, min: 0, max: 1, help: "How deep the stamp bites — the strength of the engraved/embossed relief lit into the metal behind." },
  { name: "bevelWidth", kind: "number", default: 10, min: 0, max: 40, help: "Wall width of the groove as a percentage of the shortest side. Wider = a gentler slope; narrower = a sharper cut." },
  { name: "profile", kind: "select", options: ["chamfer", "round", "V"], optionLabels: { chamfer: "Chamfer (straight wall)", round: "Round (soft lip)", V: "V (sharp valley)" },
    default: "chamfer", help: "The cross-section of the cut wall: a straight chamfer, a rounded lip, or a sharp V valley." },
  { name: "emboss", kind: "boolean", default: false, help: "Off: ENGRAVE — the shape is sunk INTO the metal (grooves age first). On: EMBOSS — the shape is raised OUT of the metal (the recessed surround ages first)." },
  { name: "lightAngle", kind: "angle", default: -126, help: "Direction (degrees) TO the raking key light. A low, oblique light exaggerates the relief. Match the metal fill's light angle." },
  { name: "patinaAmount", kind: "number", default: 0, min: 0, max: 1, help: "Patina that collects IN the groove (the crevice coupling): the engraved lines tarnish before the flat metal around them." },
  { name: "patinaColor", kind: "color", default: "rgb(67,179,174)", help: "The patina tone accumulating in the groove." },
  { name: "rustCoverage", kind: "number", default: 0, min: 0, max: 1, help: "Rust collecting in the groove — the crevices rust before the faces." },
  { name: "seed", kind: "number", default: 3, help: "Aging seed — changes the patina/rust pattern in the groove deterministically." },
];

/** Stored angle → radians, reading each row's DECLARED storage unit from the
 *  schema above rather than restating it here (core/properties.schemaAngleRadians). */
const toRadians = schemaAngleRadians(STAMP_FILL_PARAMS);

const PROFILE_CODE = { chamfer: 0, round: 1, V: 2 };

/**
 * Pure function. Maps schema-shaped resolved params to the packer's params: the
 * profile select -> its code, the emboss boolean -> ±1, lightAngle degrees -> radians,
 * bevelWidth passed through as a percentage.
 *
 * @param {object} p - resolved schema params
 * @returns {object} packStamp-shaped params
 *
 * @example stampToUniformParams({depth:0.7,bevelWidth:10,profile:"round",emboss:true,lightAngle:-126,patinaAmount:0,patinaColor:"#43b3ae",rustCoverage:0,seed:3}).emboss // 1
 * @example stampToUniformParams({depth:0.5,bevelWidth:8,profile:"V",emboss:false,lightAngle:0,patinaAmount:0,patinaColor:"#000",rustCoverage:0,seed:1}).profile // 2
 */
export function stampToUniformParams(p) {
  return {
    depth: p.depth,
    bevelWidthPct: p.bevelWidth,
    profile: PROFILE_CODE[p.profile] ?? 0,
    emboss: p.emboss ? 1 : -1,
    lightAngle: toRadians("lightAngle", p.lightAngle),
    patinaAmount: p.patinaAmount,
    patinaColor: p.patinaColor,
    rustCoverage: p.rustCoverage,
    seed: p.seed,
  };
}

/**
 * Pure function. The stamp PROXY overlay (backdrop stand-in): a faint dark tint, so
 * a thumbnail reads as "something is stamped here" over the content beneath. A
 * backdrop stand-in is ONE overlay colour (materials.resolveProxyBackdrop shape).
 *
 * @param {object} _params - op params (unused; the stamp darkens regardless of knobs)
 * @returns {{tint:[number,number,number,number]}}
 *
 * @example stampProxyBackdrop({}).tint[3] // 0.16
 */
export function stampProxyBackdrop(_params) {
  return { tint: [0, 0, 0, 0.16] };
}

/**
 * Pure function. The stamp's outward backdrop-sample reach: ZERO — it samples straight
 * down at the fragment and only RE-LIGHTS (no displacement), so its region can be bounded
 * tight to the panel (the frosted precedent).
 *
 * @param {object} _u - the normalized uniform input (unused; the reach is constant)
 * @returns {number} 0
 *
 * @example maxStampSampleReach({halfW: 100, halfH: 80}) // 0
 */
export function maxStampSampleReach(_u) { return 0; }

// ── the material descriptor (registry entry) ──────────────────────────────────
export const METAL_STAMP_MATERIAL = {
  id: "metalStamp",
  sksl: STAMP_SKSL,
  pack: packStamp,
  uniformFloats: STAMP_UNIFORM_FLOATS,
  backdrop: true,
  usesBlurredBackdrop: false,
  usesShapeSdf: true,
  fillSksl: STAMP_FILL_SKSL,
  fillParams: STAMP_FILL_PARAMS,
  toUniformParams: stampToUniformParams,
  proxyBackdrop: stampProxyBackdrop,
  maxSampleReach: maxStampSampleReach,
};

// LOUD IMPORT-TIME GUARD (the comic_shader precedent): a material declaring it does
// not sample the blurred child, whose SkSL then evals it, would render WRONG.
for (const [label, src] of [["STAMP_SKSL", STAMP_SKSL], ["STAMP_FILL_SKSL", STAMP_FILL_SKSL]])
  if (METAL_STAMP_MATERIAL.usesBlurredBackdrop === false && /\bblurredBackdrop\s*\.\s*eval\b/.test(src))
    throw new Error(`metal_stamp_shader: METAL_STAMP_MATERIAL declares usesBlurredBackdrop:false but ${label} evals blurredBackdrop — the handler skips building that child. Remove the flag or stop evaluating the child.`);

// ── PRESETS (exported as data; the integrator merges into material_presets.js) ──
export const METAL_STAMP_PRESETS = [
  { id: "engrave_deep", title: "Deep Engrave", description: "A deep chamfered cut sunk into the metal behind.",
    params: { depth: 0.9, bevelWidth: 12, profile: "chamfer", emboss: false } },
  { id: "engrave_round", title: "Round Engrave", description: "A soft rounded groove, as if pressed by a die.",
    params: { depth: 0.7, bevelWidth: 14, profile: "round", emboss: false } },
  { id: "emboss_raised", title: "Raised Emboss", description: "The shape stamped OUT of the metal, standing proud.",
    params: { depth: 0.8, bevelWidth: 12, profile: "round", emboss: true } },
  { id: "engrave_aged", title: "Aged Engraving", description: "An old engraving gone to verdigris in the grooves — the crevice coupling.",
    params: { depth: 0.75, bevelWidth: 11, profile: "V", emboss: false, patinaAmount: 0.85, patinaColor: "rgb(67,179,174)" } },
  { id: "engrave_rusted", title: "Rusted Stamp", description: "A struck mark where rust has settled into the cut lines first.",
    params: { depth: 0.8, bevelWidth: 10, profile: "chamfer", emboss: false, rustCoverage: 0.7 } },
  // ── mini-frenzy top-up (presets mantra, manifest item 70) — each models a
  // named real-world finish; numbers chosen to stay clearly apart from the
  // five above AND each other (depth/bevel/light/tint/seed deltas). ─────────
  { id: "etch_acid", title: "Acid Etch", description: "A chemical bite: shallow, wide, softly chamfered — a surface etch, not a cut groove.",
    params: { depth: 0.18, bevelWidth: 30, profile: "chamfer", emboss: false } },
  { id: "deboss_letterpress", title: "Letterpress Deboss", description: "A blunt even press into the metal — rounded walls, no sharp edges anywhere.",
    params: { depth: 0.22, bevelWidth: 26, profile: "round", emboss: false } },
  { id: "punch_hallmark", title: "Hallmark Punch", description: "A jeweler's maker's-mark strike: tiny, deep, sharp V with almost no bevel.",
    params: { depth: 0.95, bevelWidth: 4, profile: "V", emboss: false } },
  { id: "engrave_trophy", title: "Trophy Plate", description: "Clean precise brass-plate engraving under bright bench light from the upper right.",
    params: { depth: 0.55, bevelWidth: 9, profile: "chamfer", emboss: false, lightAngle: -55 } },
  { id: "stamp_dogtag", title: "Dog Tag Stamp", description: "Hard flat-die character stamping read under harsh near-overhead light.",
    params: { depth: 0.85, bevelWidth: 8, profile: "chamfer", emboss: false, lightAngle: -95 } },
  { id: "emboss_coin", title: "Coin Relief", description: "Struck-coin relief: deliberately low, wide and rounded so it survives wear.",
    params: { depth: 0.35, bevelWidth: 34, profile: "round", emboss: true } },
  { id: "emboss_cast_iron", title: "Cast Iron Lettering", description: "Sand-cast raised lettering, rough wide edges already going to rust.",
    params: { depth: 0.8, bevelWidth: 24, profile: "chamfer", emboss: true, rustCoverage: 0.35 } },
  { id: "emboss_hammered_coin", title: "Hammered Coin", description: "Hand-hammered low relief with a faint dusty-tan circulation tarnish.",
    params: { depth: 0.4, bevelWidth: 22, profile: "round", emboss: true, patinaAmount: 0.3, patinaColor: "rgb(120,110,90)", seed: 11 } },
  { id: "emboss_verdigris", title: "Verdigris Plaque", description: "Cast bronze plaque, raised lettering over an olive-green weathered surround.",
    params: { depth: 0.5, bevelWidth: 18, profile: "round", emboss: true, patinaAmount: 0.8, patinaColor: "rgb(88,138,102)" } },
  { id: "engrave_blackened", title: "Blackened Jewelry", description: "Antiqued silver: engraved lines deliberately blackened so the design pops.",
    params: { depth: 0.45, bevelWidth: 9, profile: "V", emboss: false, patinaAmount: 0.9, patinaColor: "rgb(18,18,20)" } },
];
