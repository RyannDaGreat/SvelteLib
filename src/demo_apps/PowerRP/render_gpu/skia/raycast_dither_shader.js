/**
 * THE RAYCAST DITHER material SkSL — a GENERATIVE (source) FOREGROUND material on
 * the reusable MATERIAL FRAMEWORK (render_gpu/skia/materials.js). It reproduces the
 * animated, grainy, soft-colour mesh-gradient of the raycast.com hero: diagonal
 * elongated colour STREAKS on a near-black base, with a fine per-pixel GRAIN that
 * DOUBLES AS DITHER (added pre-quantization, so the ultra-smooth gradient never
 * bands). Design + VLM-verified prototype: `.frenzy/raycast_dither/`.
 *
 * ── WHY IT IS A FOREGROUND (backdrop:false) MATERIAL, NOT A BACKDROP ──────────
 * Glass/CRT are BACKDROP samplers: their SkSL declares {blurredBackdrop,
 * sharpBackdrop} children and distorts the composite-so-far. This shader samples
 * NOTHING below it — it SYNTHESIZES every pixel from uniforms. So it rides the
 * `materialFill` op + handleMaterialFill (paint_skia.js): a plain
 * `effect.makeShader(uniforms)` fill with NO children, NO below-content re-render,
 * exactly like the corkboard family. Registered with `backdrop: false`.
 *
 * ── DEVICE-SPACE ADAPTATION vs the standalone prototype ───────────────────────
 * (`.frenzy/raycast_dither/prototype/raycast_dither.sksl.js`, the source of truth.)
 * The prototype's `main(float2 p)` took LOCAL widget px and filled an opaque rect.
 * In the app path the material's `main(float2 fragCoord)` receives DEVICE px and is
 * clipped only to the region's device AABB (the corkboard convention), so it must:
 *   • un-rotate the widget's world rotation and centre: pl = rot2(frag − uCenter, −uAngle);
 *   • synthesize its OWN rounded-rect coverage (sdRoundRect) and return PREMULTIPLIED
 *     colour — the shader owns its corners, the handler only clips the AABB;
 *   • build the mesh field in an ASPECT-CORRECT, ZOOM-STABLE normalized frame
 *     (uv = pl / minFullDim) so the pattern always fills the widget identically
 *     regardless of zoom (the design's "local space" requirement);
 *   • paint the grain in WORLD px (pl / uTexScale) so it reads as a texture on the
 *     widget (world-locked, scales with zoom) — the design's grain caveat.
 *
 * ── DETERMINISM (RenderTree = pure(document, [[slide, alpha]])) ───────────────
 * The only time input is uTime (seconds), from particleTime() (frozen in
 * editor/CLI ⇒ a deterministic still; wall clock in the presenter). Every noise is
 * a PURE hash of (pixel/cell, quantized-time) — NO Date.now / NO Math.random — so
 * same (fragCoord, uTime, knobs) ⇒ byte-identical pixels.
 *
 * ── TECHNIQUE (grounded in paper-design/shaders MeshGradient) ─────────────────
 * N colour spots on slow sin/cos trajectories, blended by a GAUSSIAN metaball
 * weight; the distance metric is STRETCHED along a rotated axis so blobs render as
 * long diagonal streaks; a value-noise domain warp gives organic edge wobble;
 * coverage SATURATES (1 − exp(−Σg·gain)) so the gaps stay dark; grain = a per-pixel
 * white-noise hash re-seeded on a quantized clock (film-grain flicker + dither).
 *
 * DOM-free at import (only string SkSL + a pure packer), like glass_shader.js /
 * crt_shader.js / corkboard_shader.js. `parseColor` (render_gpu/ir.js) is the shared
 * pure, node-safe hex/rgb() parser — palette knobs pass through the op as colour
 * strings and are parsed HERE.
 */

import { parseColor } from "../ir.js";
import { UNIT_SPAN_SCRUB } from "../../core/properties.js";
import { particleTime } from "../particle_clock.js";

/** The palette length (one colour spot per entry). */
export const MAX_COLORS = 5;

// The classic top-left → bottom-right diagonal the raycast hero streaks run along.
const STREAK_DIAGONAL = Math.PI / 4;

// uCenter 2 + uHalfSize 2 + uCornerRadius 1 + uAngle 1 + uTexScale 1
//   + 10 scalar knobs + uBackground 3 + uColors[5] float4 (20) = 7 + 10 + 3 + 20 = 40
const RAYCAST_DITHER_UNIFORM_FLOATS = 40;

export const RAYCAST_DITHER_SKSL = `
// ── structural constants (WHY each; only the CHARACTER knobs are uniforms) ────
const int   N_SPOTS       = ${MAX_COLORS}; // one colour spot per palette entry
const float SPREAD_ALONG  = 0.55;  // amplitude a spot drifts ALONG its streak (normalized units)
const float SPACING       = 0.42;  // gap BETWEEN adjacent streaks across the streak axis (normalized units)
const float ACROSS_WOBBLE = 0.05;  // small perpendicular wobble so streaks aren't perfectly parallel
const float DRIFT_ALONG   = 0.13;  // angular speed of the along-streak drift (rad/s at uSpeed=1)
const float DRIFT_ACROSS  = 0.09;  // angular speed of the across-streak wobble
const float PHASE_STEP    = 1.70;  // per-spot phase offset so spots don't move in lockstep
const float WOBBLE_PHASE  = 1.30;  // per-spot phase multiplier for the across-wobble term
const float COVERAGE_GAIN = 1.05;  // how fast the summed metaball field saturates to full colour (higher = less black)
const float WARP_FREQ     = 1.30;  // spatial frequency of the domain-warp value noise
const float WARP_DRIFT    = 0.10;  // how fast the warp field flows with time
const float WARP_DECORR   = 5.20;  // lattice offset decorrelating the warp's x vs y noise channels
const float GRAIN_SEED_STRIDE = 17.13; // hash-lattice stride per quantized grain frame (decorrelates flicker frames)
const float HASH_MUL_X = 123.34;   // standard shader-art value-hash mixing constants
const float HASH_MUL_Y = 456.21;
const float HASH_ADD   = 45.32;
const float SMOOTH3 = 3.0;         // cubic smoothstep coefficients for value-noise interpolation
const float SMOOTH2 = 2.0;
const float EDGE_AA = 1.0;         // rounded-rect coverage antialias half-width (device px)
const float EPS = 1e-3;            // guards against divide-by-zero on degenerate knobs

// ── framework-set geometry (device px) — NOT user knobs ───────────────────────
uniform float2 uCenter;       // widget centre (device px)
uniform float2 uHalfSize;     // widget half-extents (device px)
uniform float  uCornerRadius; // rounded-rect radius (device px)
uniform float  uAngle;        // widget world rotation (radians)
uniform float  uTexScale;     // device px per WORLD unit (grain is world-locked)
uniform float  uTime;         // ambient animation time (seconds) — frozen in editor/CLI, wall clock in presenter
// ── user-tweakable knobs (self.* custom props) ────────────────────────────────
uniform float  uSpeed;        // animation speed multiplier (0 = frozen still)
uniform float  uZoom;         // pattern zoom: bigger = fewer/larger streaks
uniform float  uStreakAngle;  // streak direction (radians); ~PI/4 = the classic diagonal
uniform float  uElongation;   // streak stretch along the axis (1 = round blobs, higher = long streaks)
uniform float  uSoftness;     // gaussian blob radius (bigger = softer, more overlap/blur)
uniform float  uWarp;         // domain-warp amount (organic streak-edge wobble)
uniform float  uGrain;        // film-grain / DITHER amount (luminance noise added pre-quantize)
uniform float  uGrainScale;   // grain cell size (WORLD px); ~1 = fine film grain
uniform float  uGrainSpeed;   // grain re-randomize rate (Hz); the flicker frequency
uniform float3 uBackground;   // base (darkest) colour filling the gaps between streaks
uniform float4 uColors[${MAX_COLORS}]; // palette: .rgb = streak colour, .a = weight (0 disables that spot)

// Pure. 2D white-noise hash -> [0,1). Same p => same value on a given backend.
float hash21(float2 p) {
  p = fract(p * float2(HASH_MUL_X, HASH_MUL_Y));
  p += dot(p, p + HASH_ADD);
  return fract(p.x * p.y);
}

// Pure. Value noise (smoothstep-interpolated hashed lattice) -> [0,1]. For the warp.
float vnoise(float2 x) {
  float2 i = floor(x); float2 f = fract(x);
  float a = hash21(i);
  float b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0));
  float d = hash21(i + float2(1.0, 1.0));
  float2 u = f * f * (SMOOTH3 - SMOOTH2 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Pure. Rotate a 2-vector by angle a (rows: [c -s; s c]).
float2 rot2(float2 v, float a) {
  float c = cos(a), s = sin(a);
  return float2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// Pure. Rounded-rect SDF (iq). <0 inside. p LOCAL & centered; h = half-extents.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

half4 main(float2 fragCoord) {
  // device -> widget-local, centered (un-rotate the widget's world rotation).
  float2 pl = rot2(fragCoord - uCenter, -uAngle);

  // The shader OWNS its rounded corners: the handler clips only the AABB, so mask
  // here and return premultiplied alpha (0 outside the rounded rect).
  float sd = sdRoundRect(pl, uHalfSize, uCornerRadius);
  float cov = 1.0 - smoothstep(-EDGE_AA, EDGE_AA, sd);
  if (cov <= 0.0) return half4(0.0);

  // Aspect-correct, centered, zoom-STABLE field coords (short axis spans ~[-0.5,0.5]).
  float minDim = max(min(uHalfSize.x, uHalfSize.y) * 2.0, 1.0);
  float2 uv = pl / minDim;
  uv /= max(uZoom, EPS);

  // Rotate into streak space (x = along the streak, y = across).
  float2 rot = rot2(uv, -uStreakAngle);

  float t = uTime * uSpeed;

  // Organic domain warp (animated value noise) so streak edges wobble.
  float2 wv = float2(
    vnoise(rot * WARP_FREQ + float2(0.0,         t * WARP_DRIFT)),
    vnoise(rot * WARP_FREQ + float2(WARP_DECORR, -t * WARP_DRIFT))
  ) - 0.5;
  rot += uWarp * wv;

  // Metaball accumulation over the palette spots.
  float3 colAcc = float3(0.0);
  float  wSum = 0.0;
  float  field = 0.0;
  float  halfN = 0.5 * float(N_SPOTS - 1);
  float  invSoft2 = 1.0 / max(uSoftness * uSoftness, EPS * EPS);
  for (int i = 0; i < N_SPOTS; i++) {
    float fi = float(i);
    float phase = fi * PHASE_STEP;
    float2 c;
    c.x = sin(t * DRIFT_ALONG + phase) * SPREAD_ALONG;                                   // drift along the streak
    c.y = (fi - halfN) * SPACING + sin(t * DRIFT_ACROSS + phase * WOBBLE_PHASE) * ACROSS_WOBBLE; // spaced across
    float2 d = rot - c;
    d.x /= max(uElongation, EPS);           // stretch along the streak axis -> elongated streak
    float g = exp(-dot(d, d) * invSoft2);   // gaussian metaball
    float w = uColors[i].a * g;             // weight = palette weight x falloff
    colAcc += uColors[i].rgb * w;
    wSum += w;
    field += w;
  }
  float3 color = colAcc / max(wSum, EPS);
  float intensity = 1.0 - exp(-field * COVERAGE_GAIN); // saturating coverage -> dark gaps stay dark
  float3 outc = mix(uBackground, color, clamp(intensity, 0.0, 1.0));

  // ── GRAIN + DITHER: per-pixel white noise re-seeded on a quantized clock ─────
  // Added to the colour BEFORE 8-bit output, so it doubles as texture-free dither
  // that shatters banding on the very smooth gradient (the Raycast signature).
  // Cells live in WORLD px (pl / uTexScale) so the grain is a texture on the widget.
  float seed = floor(uTime * uGrainSpeed);
  float2 cell = floor((pl / max(uTexScale, EPS)) / max(uGrainScale, EPS));
  float n = hash21(cell + seed * GRAIN_SEED_STRIDE) - 0.5; // white noise in [-0.5, 0.5]
  outc += n * uGrain;

  return half4(clamp(outc, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── uniform packer ──────────────────────────────────────────────────────────

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens the whole
 * region — fail loudly). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`raycastDither pack: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string/array) -> its rgb triple [r,g,b], via the shared
 * node-safe parseColor. Alpha is dropped (the background is an opaque fill). */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

/** Pure. A palette colour knob -> [r, g, b, weight]: parseColor's ALPHA channel IS
 * the spot's metaball weight (a fully-opaque colour = weight 1; alpha 0 disables
 * that spot). One knob carries both the streak colour and its strength. */
function rgbaWeight(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2]), num(name + ".a", c[3])];
}

/**
 * Pure function. Packs the Raycast Dither uniforms into the flat Float32Array
 * CanvasKit expects (SkSL declaration order, tight-packed: float2=2, float3=3,
 * float4=4, float4[5]=20). `u` is the material framework's normalized input:
 * DEVICE-px region geometry {cx, cy, halfW, halfH, cornerRadius, angle} + `scale`
 * (device px per world unit) + this material's own already-evaluated knobs (the
 * op's `params`, spread in by name). Colours pass through as strings/arrays and are
 * parsed here; palette alpha becomes the per-spot weight.
 *
 * @param {object} u {cx, cy, halfW, halfH, cornerRadius, angle, scale, time, speed,
 *   zoom, streakAngle, elongation, softness, warp, grain, grainScale, grainSpeed,
 *   background, color0..color4}
 * @returns {Float32Array} length 40
 *
 * @example packRaycastDither({cx:0,cy:0,halfW:280,halfH:180,cornerRadius:24,angle:0,
 *   scale:1,time:2,speed:1,zoom:0.58,streakAngle:0.785,elongation:4.2,softness:0.17,
 *   warp:0.18,grain:0.09,grainScale:1,grainSpeed:18,background:"#050608",
 *   color0:"#ff5e73",color1:"#eb1f36",color2:"#990d1c",color3:"#ff4257",
 *   color4:"#520814"}).length // 40
 */
export function packRaycastDither(u) {
  const bg = rgb("background", u.background);
  const cols = [u.color0, u.color1, u.color2, u.color3, u.color4].map((c, i) => rgbaWeight("color" + i, c));
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("scale", u.scale),
    num("time", u.time),
    num("speed", u.speed),
    num("zoom", u.zoom),
    num("streakAngle", u.streakAngle),
    num("elongation", u.elongation),
    num("softness", u.softness),
    num("warp", u.warp),
    num("grain", u.grain),
    num("grainScale", u.grainScale),
    num("grainSpeed", u.grainSpeed),
    bg[0], bg[1], bg[2],
    ...cols.flat(),
  ]);
  if (out.length !== RAYCAST_DITHER_UNIFORM_FLOATS) throw new Error(`packRaycastDither: ${out.length} floats, expected ${RAYCAST_DITHER_UNIFORM_FLOATS}`);
  return out;
}

// ── PROXY stand-in (thumbnail quality) ────────────────────────────────────────
// raycast_dither is a per-pixel animated mesh gradient (5 gaussian metaballs +
// domain-warp value noise + grain, every pixel) — heavy over a whole thumbnail. Its
// look is diagonal colour STREAKS over a dark base, so the proxy is a linear gradient
// along the streak axis: the dark background at both ends with the strongest palette
// streaks as the middle stops. No SkSL, no metaballs. paint_skia.js draws the spec.
const PROXY_MIN_WEIGHT = 0.05;   // ignore palette spots weaker than this (weight = the colour's alpha)
const PROXY_MAX_STREAKS = 3;     // at most this many palette colours become mid stops (keep it a simple gradient)

/**
 * Pure function. The raycast_dither PROXY spec: a linear gradient along the streak
 * axis — the dark background at both ends, the strongest palette colours as evenly
 * spaced mid stops (so it reads as diagonal streaks over black). Falls back to a
 * solid background fill when the palette is empty. Coordinates are in the region's
 * LOCAL space; colours are [r,g,b,a] in 0..1 (opaque).
 *
 * @param {object} params - the op params ({background, color0..color4, streakAngle})
 * @param {{cx:number, cy:number, halfW:number, halfH:number}} region - local-space geometry
 * @returns {{kind:"linear"|"solid", ...}}
 *
 * @example raycastDitherProxyFill({background:"#050608", color0:"#ff5e73", color1:"#eb1f36", streakAngle:0.785}, {cx:0,cy:0,halfW:280,halfH:180}).kind // "linear"
 * @example raycastDitherProxyFill({background:"#050608"}, {cx:0,cy:0,halfW:100,halfH:100}).kind // "solid" (empty palette)
 */
export function raycastDitherProxyFill(params, region) {
  const bg = parseColor(params.background ?? "#050608");
  const streaks = [params.color0, params.color1, params.color2, params.color3, params.color4]
    .filter((v) => v != null)
    .map((v) => parseColor(v))
    .filter((c) => c[3] > PROXY_MIN_WEIGHT)
    .sort((a, b) => b[3] - a[3])
    .slice(0, PROXY_MAX_STREAKS);
  if (streaks.length === 0) return { kind: "solid", color: [bg[0], bg[1], bg[2], 1] };
  const a = params.streakAngle ?? 0.785;
  const ext = Math.hypot(region.halfW, region.halfH);
  const dx = Math.cos(a) * ext, dy = Math.sin(a) * ext;
  // background at 0 and 1, streaks evenly spaced across the interior.
  const stops = [{ offset: 0, color: [bg[0], bg[1], bg[2], 1] }];
  streaks.forEach((c, i) => stops.push({ offset: (i + 1) / (streaks.length + 1), color: [c[0], c[1], c[2], 1] }));
  stops.push({ offset: 1, color: [bg[0], bg[1], bg[2], 1] });
  return { kind: "linear", x0: region.cx - dx, y0: region.cy - dy, x1: region.cx + dx, y1: region.cy + dy, stops };
}

/**
 * THE RAYCAST DITHER KNOB SCHEMA — the ONE declaration of the material's look knobs,
 * in the customProps row shape. Both consumers derive from it (the end-state ruling
 * "custom properties become material properties"):
 *   - plugins/demo/raycast_dither.js spreads it into its customProps (self.* rows),
 *     ADDING only its widget-side `cornerRadius` (a fill's shape IS its geometry);
 *   - the FILL-material UI renders it as the paint's param rows, resolved
 *     sparse-over-defaults by materials.resolveMaterialPaint.
 * `time` is NOT a knob — it is the ambient animation clock, injected by
 * raycastDitherUniformParams (below). The default red-on-black palette was sampled
 * from the live raycast.com hero; each palette colour's ALPHA is its spot weight.
 */
export const RAYCAST_DITHER_FILL_PARAMS = [
  // SCRUB: the unit-nominal RATE multiplier — 1 = the authored drift, 0 = frozen.
  // The SAME shared constant as rainy_window/sky `speed` so the copies can't drift.
  { name: "speed", kind: "number", default: 1.0, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Animation speed multiplier for the drifting streaks. 0 = a frozen still; higher = faster flow." },
  { name: "zoom", kind: "number", default: 0.58, min: 0.05, help: "Pattern zoom: bigger = fewer, larger streaks that fill more of the frame; smaller = more, tighter streaks." },
  { name: "streakAngle", kind: "angle", display: "degrees", default: STREAK_DIAGONAL, help: "Streak direction. 45° is the classic top-left → bottom-right diagonal; 0° = horizontal streaks." },
  { name: "elongation", kind: "number", default: 4.2, min: 1, help: "How far the colour blobs stretch ALONG the streak axis. 1 = round blobs; higher = long diagonal streaks (the Raycast look)." },
  { name: "softness", kind: "number", default: 0.17, min: 0.01, help: "Gaussian blob radius — the softness/overlap of the streaks. Bigger = softer, blurrier, more overlap; smaller = crisper cores." },
  { name: "warp", kind: "number", default: 0.18, min: 0, help: "Domain-warp amount: how much an animated value-noise field wobbles the streak edges, so they read as organic aurora rather than perfect ellipses. 0 = clean edges." },
  { name: "grain", kind: "number", default: 0.09, min: 0, help: "Film-grain / DITHER amount — luminance noise added just before 8-bit output. Doubles as dither: it shatters the banding a very smooth gradient would otherwise show. 0 = smooth (banding visible)." },
  { name: "grainScale", kind: "number", default: 1.0, min: 0.05, help: "Grain cell size in world px. ~1 = a fine per-pixel film grain; larger = chunkier speckle. The grain is world-locked (a texture painted on the widget), so it scales with zoom." },
  { name: "grainSpeed", kind: "number", default: 18.0, min: 0, help: "Grain re-randomize rate in Hz — how fast the grain flickers frame to frame. 0 = a static grain texture." },
  { name: "background", kind: "color", default: "#050608", help: "The base/darkest colour filling the dark gaps between the streaks (a near-black, faintly cool tone on the live hero)." },
  { name: "color0", kind: "color", default: "#ff5e73", help: "Palette spot 1 (a bright pink-red streak core). The colour's ALPHA is the spot's weight — a fully-opaque colour is full strength; drop alpha to fade it, alpha 0 disables the spot." },
  { name: "color1", kind: "color", default: "#eb1f36", help: "Palette spot 2 (crimson). Alpha = spot weight (0 disables)." },
  { name: "color2", kind: "color", default: "#990d1c", help: "Palette spot 3 (deep red). Alpha = spot weight (0 disables)." },
  { name: "color3", kind: "color", default: "#ff4257", help: "Palette spot 4 (vivid red). Alpha = spot weight (0 disables)." },
  { name: "color4", kind: "color", default: "#520814", help: "Palette spot 5 (dark maroon). Alpha = spot weight (0 disables)." },
];

/**
 * Near-pure function (reads the AMBIENT particle clock; pure w.r.t. document state).
 * SCHEMA params (RAYCAST_DITHER_FILL_PARAMS names) → the PACKER's params. THE one
 * mapping both consumers share: the demo widget's emit() and the fill-material
 * regionOp synthesis (paint_skia handleMaterialPaintShape reads it as
 * entry.toUniformParams). The look knobs pass straight through by name (streakAngle
 * is already radians via the display:"degrees" bridge — no conversion); `time` is
 * INJECTED from particleTime() (the freeze constant in editor/CLI, the wall clock in
 * the presenter), which is why a raycast_dither FILL animates exactly like the widget
 * and how time reaches the fill path (the schema carries no time knob).
 *
 * @param {object} p - resolved schema-shaped params (every look knob present)
 * @returns {object} packRaycastDither-shaped params (+ `time` from the clock)
 *
 * @example raycastDitherUniformParams({speed: 1, zoom: 0.58, streakAngle: 0.785, elongation: 4.2, softness: 0.17, warp: 0.18, grain: 0.09, grainScale: 1, grainSpeed: 18, background: "#050608", color0: "#ff5e73", color1: "#eb1f36", color2: "#990d1c", color3: "#ff4257", color4: "#520814"}).zoom // 0.58
 * @example raycastDitherUniformParams({speed: 0, zoom: 1, streakAngle: 0, elongation: 1, softness: 0.2, warp: 0, grain: 0, grainScale: 1, grainSpeed: 0, background: "#000", color0: "#fff", color1: "#fff", color2: "#fff", color3: "#fff", color4: "#fff"}).time // 2 (EDITOR_FREEZE_TIME, the paused default)
 */
export function raycastDitherUniformParams(p) {
  return {
    time: particleTime(),
    speed: p.speed, zoom: p.zoom, streakAngle: p.streakAngle,
    elongation: p.elongation, softness: p.softness, warp: p.warp,
    grain: p.grain, grainScale: p.grainScale, grainSpeed: p.grainSpeed,
    background: p.background,
    color0: p.color0, color1: p.color1, color2: p.color2, color3: p.color3, color4: p.color4,
  };
}

// ── material descriptor (registry entry) ──────────────────────────────────────
// FOREGROUND, GENERATIVE material: `backdrop: false` binds NO children and skips
// the below-content re-render — handleMaterialFill just makeShader+fill. `id`
// matches the plugin's `material` op field. `proxyFill` gives the thumbnail/minimap
// (quality:"proxy") path a cheap streak-gradient stand-in instead of the SkSL.
// `fillParams` + `toUniformParams` opt it into being a FILL on any shape (the
// animated mesh-gradient clipped to the shape — materials.isFillCapableMaterial).
export const RAYCAST_DITHER_MATERIAL = {
  id: "raycast_dither",
  sksl: RAYCAST_DITHER_SKSL,
  pack: packRaycastDither,
  uniformFloats: RAYCAST_DITHER_UNIFORM_FLOATS,
  backdrop: false,
  proxyFill: raycastDitherProxyFill,
  fillParams: RAYCAST_DITHER_FILL_PARAMS,
  toUniformParams: raycastDitherUniformParams,
};
