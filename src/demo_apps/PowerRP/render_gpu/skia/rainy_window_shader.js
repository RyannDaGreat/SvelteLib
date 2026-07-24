/**
 * The RAINY WINDOW SkSL material — a BACKDROP material on the reusable MATERIAL
 * FRAMEWORK (render_gpu/skia/materials.js), a sibling of the CRT material. It draws
 * a rain-streaked, fogged pane of GLASS over the composite-so-far: static beads,
 * running drops that slide down and carve wobbling TRAILS, a steamy fog layer the
 * drops clear, per-droplet refraction of the background, and a specular sparkle.
 *
 * ── RESEARCH / DESIGN NOTE (technique + our adaptation; sources at the end) ─────
 * The canonical reference is Martijn Steinrucken's (BigWings) "Heartfelt"
 * rain-on-glass ShaderToy (2017), the widely-praised feedback-buffer-free
 * rain-on-a-window effect. Its technique — which this file re-implements FROM
 * SCRATCH with our own coordinate frame, constants and expressions (Heartfelt is
 * CC BY-NC-SA, so its literal source is not copied) — is four procedural layers
 * summed into ONE scalar "water height" field, whose gradient is the refraction
 * normal:
 *
 *   1. STATIC DROPLETS — a fine hash-placed grid of small round beads that fade
 *      in and out over time (each cell owns a random bead + a saw() fade cycle).
 *      They read as the fine mist clinging to the glass.
 *   2. RUNNING DROPS — a coarse column grid that SCROLLS downward with time; each
 *      cell hosts a heavy drop HEAD low in the cell, following a gently snaking
 *      (sin-of-height) path so it isn't a straight line.
 *   3. TRAILS — the wake ABOVE each running head: a narrow vertical smear along
 *      the same snaking path, fading with distance above the head, speckled with
 *      small residual beads. Trails (and heads) are where the glass is WET.
 *   4. FOG / STEAM — the dry glass is a blurred, desaturated, lifted copy of the
 *      backdrop (the steamed-up pane). The WET field (drops + trails) CLEARS the
 *      fog back to a SHARP, refracted view — the signature "drops wipe the glass".
 *
 * REFRACTION: rather than screen-space derivatives (dFdx/dFdy — unavailable /
 * non-deterministic in a RuntimeEffect), the surface NORMAL is the finite-
 * difference gradient of the height field (sampled at p and p ± a few device px),
 * treated as a height map: N = normalize(vec3(-grad·bump, 1)). The background is
 * sampled displaced by N.xy (a lens), scaled by the wet mask so dry glass never
 * bends. SPECULAR is a Blinn-style pow(dot(N, L)) plus a fresnel rim, only on wet
 * pixels — the little glints on each bead.
 *
 * ── ADAPTATION TO OUR materialBackdrop FRAMEWORK ──────────────────────────────
 * This is a BACKDROP material (materials.js `backdrop: true`): its two children are
 * the STANDARD pair — `blurredBackdrop` (the fog/steam source) and `sharpBackdrop`
 * (the crisp refracted view) — the device-space image shaders paint_skia.js
 * handleMaterialBackdrop re-renders from the content below in z-order. `main(float2
 * p)` works in DEVICE px: rotate p into the widget's LOCAL frame, mask to a rounded
 * rect (the shader owns its corners; outside ⇒ premultiplied 0), and build the rain
 * field in a widget-normalized, aspect-corrected local frame so the look is
 * ZOOM-STABLE (same at any zoom/size), exactly the raycast_dither convention. Rain
 * runs down the widget's LOCAL "down", so a rotated window sheds rain down its own
 * glass.
 *
 * ── DETERMINISM (RenderTree = pure(document, [[slide, alpha]])) ────────────────
 * The only time input is uTime (seconds), from particleTime() (frozen in the
 * editor/CLI ⇒ a deterministic still; wall clock in the presenter). Every noise is
 * a PURE fract-hash of a cell id (NO sin-hash, NO Date.now, NO Math.random), so the
 * same (p, uTime, knobs) ⇒ byte-identical pixels, and two different uTime values
 * move the drops.
 *
 * DOM-free at import (only string SkSL + a pure packer), like glass_shader.js /
 * crt_shader.js / raycast_dither_shader.js. `parseColor` (render_gpu/ir.js) is the
 * shared node-safe hex/rgb() parser — the fog tint passes through as a colour
 * string and is parsed HERE.
 *
 * Sources (technique inspiration; no code copied):
 *   - Martijn Steinrucken "Heartfelt", https://www.shadertoy.com/view/ltffzl (CC BY-NC-SA 3.0)
 *   - "Rain on a Window" (Heartfelt-derived), https://www.shadertoy.com/view/WfdyRX
 *   - Dave Hoskins hash primitives, https://www.shadertoy.com/view/4djSRW
 */

import { parseColor } from "../ir.js";

// uCenter 2 + uHalfSize 2 + uCornerRadius 1 + uAngle 1 + uTime 1 = 7 geometry/time
//   + 8 scalar knobs (speed…lightAngle) + uTint float3 (3) = 7 + 8 + 3 = 18
const RAINY_WINDOW_UNIFORM_FLOATS = 18;

export const RAINY_WINDOW_SKSL = `
// ── structural constants (WHY each; only the CHARACTER knobs are uniforms) ────
const float AA_PX        = 1.0;    // rounded-rect coverage antialias half-width (device px)
const float TWO_PI       = 6.28318530718;
const half3  REC709      = half3(0.2126, 0.7152, 0.0722); // luma weights (fog desaturation)
const float EPS          = 1e-4;   // guards divide-by-zero on degenerate knobs

// hash mixing constants (Dave Hoskins fract-hash family — backend-stable, sin-free)
const float H1_MUL = 0.1031;
const float H1_ADD = 33.33;
const float3 H3_MUL = float3(0.1031, 0.1030, 0.0973);
const float H3_ADD = 33.33;

// running-drop layer geometry (a few ROWS ⇒ many staggered drops with short trails;
// the head sits LOW in its cell so its trail fills the room above it).
const float RUN_ROWS     = 2.4;    // grid rows down the height (more ⇒ more, shorter drops)
const float COL_DESYNC   = 1.0;    // random per-column vertical phase (units of a cell) so columns don't fall in lockstep
const float HEAD_Y       = 0.82;   // head's resting height within its cell (0 top … 1 bottom)
const float HEAD_WANDER  = 0.34;   // how far (fraction of a cell width) a head sits off the column centre
const float WIGGLE_FREQ  = 7.0;    // spatial frequency of the snaking drop path
const float WIGGLE_AMP   = 0.05;   // amplitude of the snake (fraction of a cell width)
const float HEAD_R       = 0.3;    // head blob radius (cell-height units; scaled up with RUN_ROWS to hold a constant screen size)
const float HEAD_H       = 1.0;    // head contribution to the height field (the fattest, brightest lens)
const float TRAIL_W      = 0.05;   // trail half-width (cell-height units, aspect-corrected)
const float TRAIL_H      = 0.5;    // trail contribution to the height field (thinner/shallower than the head)
const float TRAIL_BEADS  = 6.0;    // residual beads per cell height along a trail
const float BEAD_R       = 0.06;   // residual-bead radius
const float BEAD_SPACING = 0.3;    // vertical spacing metric for the residual beads

// the SECOND running layer (a smaller, faster, sparser sheet for depth)
const float RUN2_SCALE   = 1.7;    // finer grid (more/smaller drops)
const float RUN2_SPEED   = 1.3;    // falls faster
const float RUN2_SIZE    = 0.65;   // smaller drops

// static-droplet layer
const float STATIC_DENS  = 17.0;   // grid cells across the SHORT axis (square cells via aspect)
const float STATIC_WANDER= 0.7;    // random bead offset within its cell
const float STATIC_R     = 0.11;   // static-bead radius (cell units)
const float STATIC_RATE  = 0.35;   // fade-cycle rate (Hz at speed 1)
const float STATIC_H     = 0.5;    // static-bead contribution to the height field
const float STATIC_FADE_PEAK = 0.5;// saw() peak (fade in→out) of a static bead's life

// rain-amount → per-layer weight ramps (Heartfelt's l0/l1/l2, our thresholds)
const float STATIC_ON_HI = 0.35;  // static beads fully present by this rain amount
const float RUN1_ON_LO   = 0.15;  // layer-1 running drops start appearing here …
const float RUN1_ON_HI   = 0.8;   //   … and are full here
const float RUN2_ON_LO   = 0.45;  // layer-2 (the extra sheet) fades in later
const float RUN2_ON_HI   = 1.0;
const float RUN_PRESENCE_LO = 0.30; // fraction of running cells that host a drop at rain=0 …
const float RUN_PRESENCE_HI = 0.95; //   … and at rain=1 (density grows with rain)
const float FALL_BASE    = 0.13;  // base scroll speed of the running layers (cell-units/sec at speed 1)

// refraction / fog / specular shaping
const float GRAD_EPS = 1.6;   // finite-difference step for the height gradient (device px)
const float BUMP     = 12.0;  // slope gain: how steep the droplet surface reads (bigger = stronger lens)
const float WET_LO   = 0.02;  // height at which a pixel starts counting as WET (clears fog, refracts) …
const float WET_HI   = 0.22;  //   … and is fully wet
const float FOG_DESAT= 0.55;  // how grey the steam gets (0 keeps colour, 1 fully grey)
const float FOG_TINT = 0.25;  // how much the fog is pulled toward the tint colour
const float FOG_LIFT = 0.06;  // brightness the steam adds (a foggy pane is lighter)
const float LIGHT_Z  = 0.7;   // z-height of the light for the droplet specular
const float SPEC_POWER = 28.0;// specular lobe tightness (bigger = tighter glint)
const float RIM_POWER  = 2.4; // fresnel rim falloff on the droplet edge
const float RIM_GAIN   = 0.7; // weight of the rim sparkle vs the specular glint (the bright wet edge on each bead)

// ── framework-set geometry (device px) + time — NOT user knobs ────────────────
uniform shader blurredBackdrop;  // child 0: Gaussian-blurred composite-so-far — the FOG / steam source
uniform shader sharpBackdrop;    // child 1: the un-blurred composite-so-far — the crisp refracted view
uniform float2 uCenter;          // widget centre (device px)
uniform float2 uHalfSize;        // widget half-extents (device px)
uniform float  uCornerRadius;    // rounded-rect radius (device px)
uniform float  uAngle;           // widget world rotation (radians) — rain runs down the LOCAL frame
uniform float  uTime;            // animation time (seconds) — frozen in editor/CLI, wall clock in presenter
// ── user-tweakable knobs (self.* custom props) ────────────────────────────────
uniform float  uSpeed;           // fall-speed multiplier (0 = frozen)
uniform float  uRain;            // rain AMOUNT (0..1): drives drop density + which layers are active
uniform float  uFog;             // fog / steam amount (0 = clear pane, 1 = fully steamed)
uniform float  uRefraction;      // droplet refraction strength (fraction of the widget's short half-size)
uniform float  uShine;           // droplet SHININESS (specular + rim sparkle strength)
uniform float  uDropSize;        // overall drop-size multiplier
uniform float  uColumns;         // number of running-drop columns across the width (density granularity)
uniform float  uLightAngle;      // direction TO the light (radians; -PI/2 = above) for the specular
uniform float3 uTint;            // fog/steam colour cast

// Pure. 1D fract-hash → [0,1). Same p ⇒ same value on a given backend.
float hash11(float p) {
  p = fract(p * H1_MUL);
  p *= p + H1_ADD;
  p *= p + p;
  return fract(p);
}

// Pure. 2D fract-hash → [0,1).
float hash21(float2 p) {
  float3 p3 = fract(float3(p.xyx) * H3_MUL);
  p3 += dot(p3, p3.yzx + H3_ADD);
  return fract((p3.x + p3.y) * p3.z);
}

// Pure. 2D → 3 randoms in [0,1) (Hoskins hash23), one seed per grid cell.
float3 hash23(float2 p) {
  float3 p3 = fract(float3(p.xyx) * H3_MUL);
  p3 += dot(p3, p3.yzx + H3_ADD);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// Pure. Smooth triangular pulse peaking at b∈(0,1): 0 → 1 (at t=b) → 0. Heartfelt's
// Saw, used for the appear/vanish life of a static bead.
float sawPulse(float b, float t) {
  return smoothstep(0.0, b, t) * smoothstep(1.0, b, t);
}

// Pure. Signed distance to a rounded rect (iq). <0 inside. p LOCAL & centred.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Near-pure (reads the character uniforms). One RUNNING-drop layer's height at
// field coord uv in [0,1]^2 (y-down), scrolled by "fall". "cols" columns across the
// width; "sizeMul" scales the drop; "presence" is the fraction of cells that host a
// drop (rain density). Returns a height in [0, ~1].
float runningLayer(float2 uv, float aspect, float fall, float cols, float sizeMul, float presence) {
  uv.y += fall;                                   // scroll the whole sheet down over time
  float col = floor(uv.x * cols);
  uv.y += hash11(col) * COL_DESYNC;               // desync each column's phase
  float row = floor(uv.y * RUN_ROWS);
  float3 rnd = hash23(float2(col, row));
  float present = step(rnd.x, presence);          // only some cells host a drop
  if (present <= 0.0) return 0.0;

  float lx = fract(uv.x * cols) - 0.5;            // cell-local, x centred
  float ly = fract(uv.y * RUN_ROWS);              // 0 top … 1 bottom of the cell
  float cellAspect = (RUN_ROWS / cols) * aspect;  // makes cell-local distances read round on screen

  // the snaking column path (same expression drives head + trail so they align)
  float pathX = (rnd.y - 0.5) * HEAD_WANDER + sin(ly * WIGGLE_FREQ + rnd.z * TWO_PI) * WIGGLE_AMP;
  float tx = (lx - pathX) * cellAspect;           // horizontal distance to the path (round metric)

  // HEAD: a round blob sitting low in the cell
  float2 hd = float2(tx, ly - HEAD_Y);
  float head = smoothstep(HEAD_R * sizeMul, 0.0, length(hd));

  // TRAIL: the wake ABOVE the head (smaller ly), fading upward
  float above = HEAD_Y - ly;                      // >0 above the head
  float trail = smoothstep(TRAIL_W * sizeMul, 0.0, abs(tx));
  trail *= smoothstep(0.0, 0.05, above);          // cut off at / below the head
  trail *= (1.0 - clamp(above / max(HEAD_Y, EPS), 0.0, 1.0)); // fade toward the top of the wake

  // residual beads speckling the trail
  float beadPhase = fract(ly * TRAIL_BEADS + rnd.z) - 0.5;
  float bead = smoothstep(BEAD_R * sizeMul, 0.0, length(float2(tx, beadPhase * BEAD_SPACING)));
  bead *= smoothstep(0.0, 0.05, above) * (1.0 - clamp(above / max(HEAD_Y, EPS), 0.0, 1.0));

  return max(head * HEAD_H, max(trail, bead) * TRAIL_H);
}

// Near-pure (reads uniforms). The STATIC-bead layer's height at field coord uv.
float staticLayer(float2 uv, float aspect, float t) {
  float2 g = float2(STATIC_DENS * aspect, STATIC_DENS); // square cells (x scaled by aspect)
  float2 id = floor(uv * g);
  float3 rnd = hash23(id + 91.7);
  float2 lc = fract(uv * g) - 0.5;
  float2 off = (rnd.xy - 0.5) * STATIC_WANDER;
  float d = length(lc - off);
  float fade = sawPulse(STATIC_FADE_PEAK, fract(t * STATIC_RATE + rnd.z));
  float present = step(0.4, rnd.z);               // ~60% of cells ever host a bead
  return smoothstep(STATIC_R * uDropSize, 0.0, d) * fade * present * STATIC_H;
}

// Near-pure (reads uniforms). The combined WATER-HEIGHT field at a LOCAL px "pl".
// Sampling this at pl and pl ± a few px gives the refraction normal.
float waterHeight(float2 pl) {
  float2 uv = (pl / uHalfSize) * 0.5 + 0.5;       // 0..1 across the widget, y-down
  float aspect = uHalfSize.x / max(uHalfSize.y, EPS);
  float rain = clamp(uRain, 0.0, 1.0);
  float staticW = smoothstep(0.0, STATIC_ON_HI, rain);
  float run1W = smoothstep(RUN1_ON_LO, RUN1_ON_HI, rain);
  float run2W = smoothstep(RUN2_ON_LO, RUN2_ON_HI, rain);
  float presence = mix(RUN_PRESENCE_LO, RUN_PRESENCE_HI, rain);
  float fall = uTime * uSpeed * FALL_BASE;

  float h = 0.0;
  h += staticLayer(uv, aspect, uTime * uSpeed) * staticW;
  h += runningLayer(uv, aspect, fall, uColumns, uDropSize, presence) * run1W;
  h += runningLayer(uv, aspect, fall * RUN2_SPEED, uColumns * RUN2_SCALE, uDropSize * RUN2_SIZE, presence) * run2W;
  return clamp(h, 0.0, 1.0);
}

half4 main(float2 p) {
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y); // device → local (centred)
  float r = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y));       // capsule-safe clamp

  float d = sdRoundRect(pl, uHalfSize, r);
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);
  if (cov <= 0.0) { return half4(0.0); }          // outside the pane ⇒ contribute nothing

  float minHalf = min(uHalfSize.x, uHalfSize.y);

  // height field + gradient (finite differences in the LOCAL frame → the normal)
  float h0 = waterHeight(pl);
  float hX = waterHeight(pl + float2(GRAD_EPS, 0.0));
  float hY = waterHeight(pl + float2(0.0, GRAD_EPS));
  float2 grad = float2(hX - h0, hY - h0) / GRAD_EPS;       // height per device px (local axes)
  float3 nrm = normalize(float3(-grad * BUMP, 1.0));
  float wet = smoothstep(WET_LO, WET_HI, h0);

  // REFRACTION: displace the sample by the surface normal (a lens), bounded by
  // uRefraction·shortHalf, only where wet; rotate the local offset back to device.
  float2 dispL = nrm.xy * (uRefraction * minHalf) * wet;
  float2 disp = float2(ca * dispL.x - sa * dispL.y, sa * dispL.x + ca * dispL.y);

  half3 sharpDry  = sharpBackdrop.eval(p).rgb;             // dry clear glass = the backdrop as-is
  half3 sharpRefr = sharpBackdrop.eval(p + disp).rgb;      // refracted through a droplet
  half3 blur      = blurredBackdrop.eval(p).rgb;           // the fog/steam source

  // FOG / STEAM: blurred, desaturated, tinted, lifted — the steamed-up dry pane.
  half lum = dot(blur, REC709);
  half3 steam = mix(blur, half3(lum), half(FOG_DESAT));
  steam = mix(steam, half3(uTint), half(FOG_TINT)) + half3(FOG_LIFT);
  half3 dry = mix(sharpDry, steam, half(clamp(uFog, 0.0, 1.0))); // clear → foggy by uFog
  half3 col = mix(dry, sharpRefr, half(wet));             // drops/trails clear the fog + refract

  // SPECULAR sparkle on the droplet surfaces (glint + fresnel rim), wet-only.
  float3 L = normalize(float3(cos(uLightAngle), sin(uLightAngle), LIGHT_Z));
  float spec = pow(max(dot(nrm, L), 0.0), SPEC_POWER);
  float rim = pow(1.0 - clamp(nrm.z, 0.0, 1.0), RIM_POWER);
  col += half3(half((spec + rim * RIM_GAIN) * uShine * wet));

  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov)); // premultiplied
}
`;

// ── uniform packer ──────────────────────────────────────────────────────────

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens a whole
 * region — fail loudly). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packRainyWindow: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string/array) → its rgb triple [r,g,b], via the shared
 * node-safe parseColor. Alpha is dropped (the fog tint is an opaque cast). */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

/**
 * Pure function. Packs the Rainy Window uniforms into the flat Float32Array
 * CanvasKit expects (SkSL declaration order, tight-packed: float2 = 2 slots,
 * float3 = 3). `u` is the material framework's normalized input: DEVICE-px region
 * geometry {cx, cy, halfW, halfH, cornerRadius, angle} (+ `scale`, unused here —
 * the look is widget-normalized / zoom-stable) plus this material's own
 * already-evaluated knobs (the op's `params`, spread in by name). The tint passes
 * through as a colour string and is parsed here.
 *
 * @param {object} u {cx, cy, halfW, halfH, cornerRadius, angle, time, speed, rain,
 *   fog, refraction, shine, dropSize, columns, lightAngle, tint}
 * @returns {Float32Array} length 18
 *
 * @example packRainyWindow({cx:200,cy:150,halfW:200,halfH:150,cornerRadius:24,
 *   angle:0,time:2,speed:1,rain:0.7,fog:0.55,refraction:0.06,shine:0.7,
 *   dropSize:1,columns:5,lightAngle:-1.9,tint:"#dfe8f0"}).length // 18
 */
export function packRainyWindow(u) {
  const tint = rgb("tint", u.tint);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("time", u.time),
    num("speed", u.speed),
    num("rain", u.rain),
    num("fog", u.fog),
    num("refraction", u.refraction),
    num("shine", u.shine),
    num("dropSize", u.dropSize),
    num("columns", u.columns),
    num("lightAngle", u.lightAngle),
    tint[0], tint[1], tint[2],
  ]);
  if (out.length !== RAINY_WINDOW_UNIFORM_FLOATS)
    throw new Error(`packRainyWindow: packed ${out.length} floats, expected ${RAINY_WINDOW_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE RAINY WINDOW MATERIAL DESCRIPTOR — the registry entry (materials.js). `id`
 * matches the plugin's `material` op field; `sksl` is the shader; `pack` maps the
 * framework's normalized `u` (device geometry + the material's own knobs) to the
 * uniform Float32Array. `backdrop: true` binds the standard {blurred, sharp}
 * children and re-renders the content beneath (the same machinery CRT/glass use).
 */
export const RAINY_WINDOW_MATERIAL = {
  id: "rainy_window",
  sksl: RAINY_WINDOW_SKSL,
  pack: packRainyWindow,
  uniformFloats: RAINY_WINDOW_UNIFORM_FLOATS,
  backdrop: true,
};
