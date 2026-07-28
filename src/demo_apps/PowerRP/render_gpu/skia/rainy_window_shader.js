/**
 * The RAINY WINDOW SkSL material — a BACKDROP material on the reusable MATERIAL
 * FRAMEWORK (render_gpu/skia/materials.js), a sibling of the CRT/glass materials.
 * It draws a rain-streaked, fogged pane of GLASS over the composite-so-far: a mist
 * of static condensation beads, RUNNER drops whose heads slide DOWN the glass,
 * ACCELERATE as they grow, and leave a fading refractive STREAK behind them, all
 * refracting the background through each drop's lens with a specular sparkle.
 *
 * ── RESEARCH / DESIGN (technique + our adaptation; sources at the end) ─────────
 * The canonical reference is Martijn Steinrucken's (BigWings) "Heartfelt"
 * rain-on-glass ShaderToy (2017) — the feedback-buffer-free rain-on-a-window
 * effect. Its idea (re-implemented FROM SCRATCH here with our own frame, constants
 * and expressions — Heartfelt is CC BY-NC-SA, so no source is copied) is to sum a
 * few PROCEDURAL layers into ONE scalar "water height" field whose GRADIENT is the
 * refraction normal. FULLY PROCEDURAL: every value is a hash of a grid-cell id — NO
 * image textures (so there is no tiling seam to hit) and NO Date/Math.random.
 *
 *   1. STATIC beads — a fine hash-placed grid of small round condensation beads
 *      that fade in/out over time (each cell owns a random bead + a saw() life).
 *      Sampled over a 3×3 CELL NEIGHBOURHOOD so a bead whose centre wanders into a
 *      neighbour cell is still drawn whole — it is NEVER clipped at a cell edge
 *      (that clipping was the old build's visible seam).
 *   2. RUNNER drops — a column×row grid where EACH CELL hosts ONE drop that runs
 *      down its OWN cell over time. The head's height in the cell is yh = ph²
 *      (ph = the drop's time phase) so the fall ACCELERATES (velocity ∝ ph), and
 *      the drop GROWS as it descends. It FADES IN near the cell top and OUT near
 *      the bottom, so the periodic phase wrap is invisible (no "pop"). Sampled over
 *      the 3 horizontal NEIGHBOUR columns so a wandering head never clips a column
 *      edge. Two such layers (a coarse near sheet + a finer/faster far sheet).
 *   3. TRAIL — the wake ABOVE each running head: a narrowing vertical smear plus a
 *      chain of residual beads along the head's path, fading to EXACTLY ZERO at the
 *      cell top. That zero-at-the-top is what makes the layer SEAMLESS across row
 *      boundaries (both sides of every row edge are 0). `uStreakiness` sets how far
 *      up the streak persists.
 *   4. FOG / STEAM — the dry glass is a blurred, desaturated, lifted copy of the
 *      backdrop (the steamed pane). The WET field (drops + trails) CLEARS the fog
 *      back to a SHARP, refracted view — the signature "drops wipe the glass".
 *
 * MERGING: layers, neighbour drops, a head and its trail-beads are combined with a
 * smooth UNION `uni(a,b)=a+b-a·b` (a "screen"/probabilistic-OR that is exactly 0
 * when both are 0 — so empty glass stays flat — and BULGES where two blobs overlap,
 * forming the connecting neck that reads as drops merging). A head connects to the
 * chain of trail beads above it and swells where drops overlap → believable merge.
 *
 * REFRACTION: the surface NORMAL is the finite-difference gradient of the height
 * field (sampled at p and p ± a few device px), treated as a height map: N =
 * normalize(vec3(-grad·bump, 1)). The SHARP backdrop is sampled displaced by N.xy
 * (a lens), scaled by the wet mask so dry glass never bends. SPECULAR is a
 * Blinn-style pow(dot(N,L)) plus a fresnel rim, only on wet pixels — the glints.
 *
 * ── ADAPTATION TO OUR materialBackdrop FRAMEWORK ──────────────────────────────
 * A BACKDROP material (materials.js `backdrop: true`): its two children are the
 * STANDARD pair — `blurredBackdrop` (the fog/steam source) and `sharpBackdrop` (the
 * crisp refracted view), device-space image shaders paint_skia.js re-renders from
 * the content below in z-order. `main(float2 p)` works in DEVICE px: rotate p into
 * the widget's LOCAL frame, mask to a rounded rect (outside ⇒ premultiplied 0), and
 * build the rain field in a widget-normalized, aspect-corrected local frame so the
 * look is ZOOM-STABLE (same at any zoom/size). Rain runs down the widget's LOCAL
 * "down", so a rotated window sheds rain down its own glass.
 *
 * ── DETERMINISM (RenderTree = pure(document, [[slide, alpha]])) ────────────────
 * The only time input is uTime (seconds), from particleTime() (frozen in the
 * editor/CLI ⇒ a deterministic still; wall clock in the presenter). Every noise is
 * a PURE fract-hash of a cell id (NO sin-hash, NO Date.now, NO Math.random), so the
 * same (p, uTime, knobs) ⇒ byte-identical pixels, and two uTime values move drops.
 *
 * DOM-free at import (string SkSL + a pure packer + a small node-safe param
 * schema/mapping), like glass_shader.js / crt_shader.js. `parseColor`
 * (render_gpu/ir.js) is the shared node-safe parser. `particleTime`
 * (render_gpu/particle_clock.js — DOM-free at import, reads the wall clock only
 * when CALLED) is the ambient animation clock the fill-material mapping reads for
 * uTime, exactly as the demo widget's emit() does.
 *
 * Sources (technique inspiration; no code copied):
 *   - Martijn Steinrucken "Heartfelt", https://www.shadertoy.com/view/ltffzl (CC BY-NC-SA 3.0)
 *   - Dave Hoskins hash primitives, https://www.shadertoy.com/view/4djSRW
 */

import { parseColor } from "../ir.js";
import { particleTime } from "../particle_clock.js";
import { UNIT_SPAN_SCRUB } from "../../core/properties.js";

// Direction TO the light: just left of straight-up, so drops catch a top-left glint.
// (Stored in RADIANS with display:"degrees" — the `rotation` convention, NOT the
// comic screen-angle convention of raw degrees; the mapping passes it straight
// through with no conversion, so byte-compat with the demo widget holds.)
export const LIGHT_ANGLE_DEFAULT = -Math.PI * 0.6;

// uCenter 2 + uHalfSize 2 + uCornerRadius 1 + uAngle 1 + uTime 1 = 7 geometry/time
//   + 9 scalar knobs (speed…lightAngle, incl. streakiness) + uTint float3 (3) = 19
const RAINY_WINDOW_UNIFORM_FLOATS = 19;

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

// ── runner-drop layer geometry ────────────────────────────────────────────────
// Cells are TALLER than wide (screen w/h < 1) so a drop has vertical room to run
// and streak. rows are derived from cols so cells keep this shape at any aspect.
const float CELL_WH      = 0.55;   // a runner cell's screen width/height (<1 ⇒ tall)
const float FALL_BASE    = 0.18;   // base drop cycles/sec (at speed 1, rate 1) — one top→bottom run per ~1/this sec
const float RUN_SPEED_LO = 0.60;   // per-drop fall-rate spread LO … (hashed; faster drops catch slower → merges)
const float RUN_SPEED_HI = 1.55;   //   … HI (so columns never fall in lockstep)
const float DROP_FADE_IN = 0.12;   // fraction of the cycle the head fades IN over (hides the top wrap)
const float DROP_FADE_OUT= 0.24;   // fraction it fades OUT over near the bottom (drop lingers then leaves)
const float DROP_GROW_LO = 0.55;   // head size at the START of a run …
const float DROP_GROW_HI = 1.15;   //   … and near the END (the drop accretes water as it slides)
const float HEAD_R       = 0.26;   // head blob radius (cell-WIDTH units; ×grow×dropSize)
const float HEAD_H       = 1.0;    // head contribution to the height field (the fattest, brightest lens)
const float X_SPREAD     = 0.5;    // how far (cell widths) a head sits off the column centre (±X_SPREAD/2)
const float WIGGLE_FREQ  = 5.0;    // spatial frequency of the snaking drop path
const float WIGGLE_AMP   = 0.06;   // amplitude of the snake (cell widths)
const float TRAIL_W      = 0.06;   // trail half-width at the head (cell-width units)
const float TRAIL_TAPER  = 0.35;   // trail width fraction remaining at the top of the wake (narrows upward)
const float TRAIL_H      = 0.55;   // trail contribution to the height field (thinner/shallower than the head)
const float TRAIL_FADE_EXP = 1.6;  // base streak fade exponent (divided by uStreakiness: bigger streakiness ⇒ longer streak)
const float TRAIL_BEADS  = 5.0;    // residual-bead slots per cell height along a trail
const float BEAD_R       = 0.05;   // residual-bead radius (cell-width units)

// the SECOND runner layer (a smaller, faster, sparser sheet for depth)
const float RUN2_SCALE   = 1.6;    // finer grid (more/smaller drops)
const float RUN2_SPEED   = 1.35;   // falls faster
const float RUN2_SIZE    = 0.70;   // smaller drops
const float RUN2_SALT    = 137.0;  // hash offset so the two layers never coincide

// ── static-bead (condensation) layer ──────────────────────────────────────────
const float STATIC_DENS  = 17.0;   // grid cells across the SHORT axis (square cells via aspect)
const float STATIC_WANDER= 0.80;   // random bead offset within its cell (3×3 sampling keeps it seamless)
const float STATIC_R     = 0.10;   // static-bead radius (cell units)
const float STATIC_RATE  = 0.25;   // fade-cycle rate (Hz at speed 1)
const float STATIC_H     = 0.5;    // static-bead contribution to the height field
const float STATIC_FADE_PEAK = 0.5;// saw() peak (fade in→out) of a static bead's life
const float STATIC_PRESENT = 0.4;  // rnd.z threshold — ~60% of cells ever host a bead

// rain-amount → per-layer weight ramps (Heartfelt's l0/l1/l2, our thresholds)
const float STATIC_ON_HI = 0.35;  // static beads fully present by this rain amount
const float RUN1_ON_LO   = 0.10;  // layer-1 runner drops start appearing here …
const float RUN1_ON_HI   = 0.75;  //   … and are full here
const float RUN2_ON_LO   = 0.45;  // layer-2 (the extra sheet) fades in later
const float RUN2_ON_HI   = 1.0;
const float RUN_PRESENCE_LO = 0.35; // fraction of runner cells that host a drop at rain=0 …
const float RUN_PRESENCE_HI = 0.95; //   … and at rain=1 (density grows with rain)

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
uniform float  uColumns;         // number of runner-drop columns across the width (density granularity)
uniform float  uStreakiness;     // trail LENGTH / persistence — how far up the streak behind a head survives
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

// Pure. Smooth UNION of two heights (probabilistic OR / "screen"): exactly 0 when
// both are 0 (so empty glass stays flat — no spurious background refraction) and
// BULGES where they overlap, forming the connecting neck that reads as a MERGE.
// a, b assumed in [0,1]. uni(0.6,0.5)=0.8 (a bulge above either input).
float uni(float a, float b) { return a + b - a * b; }

// Pure. Signed distance to a rounded rect (iq). <0 inside. p LOCAL & centred.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Near-pure (reads uniforms). ONE runner drop's height for the cell (colF,rowF).
// lxc = the sample's x in CELL-WIDTH units, centred on the cell (∈ ~[-1.5,1.5] when
// a neighbour column is probed); ly = the sample's y within the row (0 top…1 bottom);
// cellRatio = the cell's screen width/height (for the round distance metric); salt
// desyncs stacked layers; sizeMul scales the drop; presence = P(cell hosts a drop).
float runDrop(float colF, float rowF, float lxc, float ly, float cellRatio, float rate, float salt, float sizeMul, float presence) {
  float2 id = float2(colF, rowF) + salt;
  float here = hash21(id + 17.0);
  if (here > presence) return 0.0;               // only some cells host a drop
  float3 rnd = hash23(id);

  // per-drop descent: ACCELERATING (yh = ph², velocity ∝ ph) with a hashed rate +
  // phase; FADE IN near the top and OUT near the bottom so the fract wrap is unseen.
  float speedVar = mix(RUN_SPEED_LO, RUN_SPEED_HI, rnd.z);
  float ph = fract(uTime * uSpeed * rate * FALL_BASE * speedVar + rnd.y);
  float yh = ph * ph;
  float life = smoothstep(0.0, DROP_FADE_IN, ph) * smoothstep(1.0, 1.0 - DROP_FADE_OUT, ph);
  if (life <= 0.0) return 0.0;

  // drop GROWS as it descends (accretes water) → a fatter lens lower down
  float grow = mix(DROP_GROW_LO, DROP_GROW_HI, ph);
  float R = HEAD_R * sizeMul * grow * max(uDropSize, EPS);

  // snaking column path (SAME expression drives head + trail so they line up)
  float px = (rnd.x - 0.5) * X_SPREAD + sin(ly * WIGGLE_FREQ + rnd.z * TWO_PI) * WIGGLE_AMP;
  float dxh = lxc - px;                           // horizontal distance to the path (cell widths)

  // HEAD: a round blob at (px, yh); y delta divided by cellRatio → a round metric
  float dyh = (ly - yh) / max(cellRatio, EPS);
  float head = smoothstep(R, 0.0, length(float2(dxh, dyh))) * HEAD_H;

  // TRAIL: the wake ABOVE the head. t01 = 0 at the cell TOP … 1 at the head, so the
  // streak fades to EXACTLY 0 at the top edge (this is the seamless-across-rows key).
  float above = yh - ly;                          // >0 above the head
  float t01 = clamp(ly / max(yh, EPS), 0.0, 1.0);
  float streak = pow(t01, TRAIL_FADE_EXP / max(uStreakiness, EPS));
  float twdt = TRAIL_W * sizeMul * mix(TRAIL_TAPER, 1.0, t01); // narrows toward the top
  float onTrail = step(0.0, above) * streak;
  float trail = smoothstep(twdt, 0.0, abs(dxh)) * onTrail * TRAIL_H;

  // residual BEADS speckling the trail — the head connects to the chain above it (merge)
  float beadY = fract(ly * TRAIL_BEADS + rnd.z);  // repeating bead slots up the trail
  float bdy = (beadY - 0.5) / (TRAIL_BEADS * max(cellRatio, EPS));
  float bead = smoothstep(BEAD_R * sizeMul, 0.0, length(float2(dxh, bdy))) * onTrail * TRAIL_H;

  return uni(head, uni(trail, bead)) * life;
}

// Near-pure (reads uniforms). One RUNNER layer's height at field uv∈[0,1]^2 (y-down).
// Samples the 3 horizontal NEIGHBOUR columns so a head that wandered toward a column
// edge is drawn whole from both sides — the layer is SEAMLESS across column edges.
float runningLayer(float2 uv, float aspect, float cols, float rate, float salt, float sizeMul, float presence) {
  float rows = max(1.0, cols * CELL_WH / max(aspect, EPS)); // tall cells at any aspect
  float cellRatio = CELL_WH;
  float gx = uv.x * cols;
  float rowF = floor(uv.y * rows);
  float ly = fract(uv.y * rows);
  float h = 0.0;
  for (float dc = -1.0; dc <= 1.0; dc += 1.0) {
    float colF = floor(gx) + dc;
    float lxc = gx - (colF + 0.5);                // sample x relative to this column's centre
    h = uni(h, runDrop(colF, rowF, lxc, ly, cellRatio, rate, salt, sizeMul, presence));
  }
  return h;
}

// Near-pure (reads uniforms). The STATIC condensation layer at field coord uv.
// 3×3 cell neighbourhood + smooth union so a bead whose centre wanders into a
// neighbour cell is drawn WHOLE — never clipped at a cell edge (was the old seam).
float staticLayer(float2 uv, float aspect, float t) {
  float2 g = float2(STATIC_DENS * aspect, STATIC_DENS); // square cells (x scaled by aspect)
  float2 gp = uv * g;
  float2 base = floor(gp);
  float h = 0.0;
  for (float dy = -1.0; dy <= 1.0; dy += 1.0) {
    for (float dx = -1.0; dx <= 1.0; dx += 1.0) {
      float2 id = base + float2(dx, dy);
      float3 rnd = hash23(id + 91.7);
      float2 center = id + 0.5 + (rnd.xy - 0.5) * STATIC_WANDER;
      float d = length(gp - center);              // grid units — square cells ⇒ round beads
      float fade = sawPulse(STATIC_FADE_PEAK, fract(t * STATIC_RATE + rnd.z));
      float present = step(STATIC_PRESENT, rnd.z);
      float bead = smoothstep(STATIC_R * max(uDropSize, EPS), 0.0, d) * fade * present * STATIC_H;
      h = uni(h, bead);
    }
  }
  return h;
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

  float s  = staticLayer(uv, aspect, uTime * uSpeed) * staticW;
  float r1 = runningLayer(uv, aspect, uColumns, 1.0, 0.0, uDropSize, presence) * run1W;
  float r2 = runningLayer(uv, aspect, uColumns * RUN2_SCALE, RUN2_SPEED, RUN2_SALT, uDropSize * RUN2_SIZE, presence) * run2W;
  // smooth-union everything: a runner head passing a static bead MERGES with it.
  return clamp(uni(s, uni(r1, r2)), 0.0, 1.0);
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

  half3 sharpDry  = sharpBackdrop.eval(p).rgb;            // dry clear glass = the backdrop as-is
  half3 sharpRefr = sharpBackdrop.eval(p + disp).rgb;     // refracted through a droplet
  half3 blur      = blurredBackdrop.eval(p).rgb;          // the fog/steam source

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
 *   fog, refraction, shine, dropSize, columns, streakiness, lightAngle, tint}
 * @returns {Float32Array} length 19
 *
 * @example packRainyWindow({cx:200,cy:150,halfW:200,halfH:150,cornerRadius:24,
 *   angle:0,time:2,speed:1,rain:0.7,fog:0.55,refraction:0.06,shine:0.7,
 *   dropSize:1,columns:5,streakiness:1,lightAngle:-1.9,tint:"#dfe8f0"}).length // 19
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
    num("streakiness", u.streakiness),
    num("lightAngle", u.lightAngle),
    tint[0], tint[1], tint[2],
  ]);
  if (out.length !== RAINY_WINDOW_UNIFORM_FLOATS)
    throw new Error(`packRainyWindow: packed ${out.length} floats, expected ${RAINY_WINDOW_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE RAINY WINDOW LOOK-KNOB SCHEMA — the ONE declaration of the material's look
 * knobs, in the customProps row shape. Both consumers derive from it (the fill-
 * material framework's single-declaration rule, "custom properties become material
 * properties"):
 *   - plugins/demo/rainy_window.js spreads it into its customProps (self.* rows),
 *     adding only its widget-side geometry knob (cornerRadius);
 *   - the FILL-material UI (PaintField) renders it as the paint's param rows,
 *     resolved sparse-over-defaults by materials.resolveMaterialPaint.
 * Geometry knobs (cornerRadius) stay widget-side — a fill's shape IS its geometry.
 * `blurRadius`/`backdropScale` are render controls the fill path reads straight off
 * resolvedParams (paint_skia handleMaterialPaintShape), so they live HERE, not in
 * the uniform mapping. `time` is NOT a knob: it is the ambient particle clock,
 * injected by the mapping below.
 */
export const RAINY_WINDOW_FILL_PARAMS = [
  { name: "rain", kind: "number", default: 0.8, min: 0, max: 1, help: "Rain AMOUNT (0..1): how much water is on the glass. Drives drop density/rate — low = a fine mist of static beads, high = heavy running drops with trails." },
  { name: "fog", kind: "number", default: 0.5, min: 0, max: 1, help: "Fog / steam amount (0..1): how steamed-up the dry pane is (a blurred, lifted, desaturated view). Running drops and trails wipe the fog clear." },
  { name: "speed", kind: "number", default: 1.0, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Fall-speed multiplier for the running drops. 0 = a frozen still; higher = faster running rain." },
  { name: "dropSize", kind: "number", default: 1.0, min: 0.1, help: "Overall drop-size multiplier — scales both the running-drop heads and the static beads." },
  { name: "columns", kind: "number", default: 6, min: 1, help: "Number of running-drop columns across the width — the density granularity. More = finer, more-numerous streaks." },
  { name: "streakiness", kind: "number", default: 1.0, min: 0.1, max: 4, help: "Trail LENGTH / persistence behind each running drop's head: how far up the fading refractive streak survives. Low = drops with barely a tail; high = long, slow-fading dribble streaks." },
  { name: "refraction", kind: "number", default: 0.06, min: 0, help: "Droplet refraction strength, as a fraction of the widget's short half-size: how strongly each drop bends the background behind it (the lens). 0 = flat wet patches." },
  { name: "shine", kind: "number", default: 0.9, min: 0, help: "Droplet SHININESS — the strength of the specular glint + fresnel rim on each drop's curved surface. 0 = matte water." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: LIGHT_ANGLE_DEFAULT, help: "Direction TO the light (screen space; -90° = straight above, 0° = from the right). Sets where the specular glints sit on each drop." },
  { name: "tint", kind: "color", default: "#dfe8f0", help: "The fog/steam colour cast — the tone the steamed-up glass is pulled toward (a cool near-white reads as cold-window condensation)." },
  { name: "blurRadius", kind: "number", default: 8, min: 0, help: "Gaussian blur radius (world px) of the fog/steam source — how soft the steamed-up glass is." },
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, help: "RESOLUTION FACTOR the content beneath is re-rendered at for the distortion: 1 = screen resolution, 2 = supersample (crisper, slower), 0.5 = half res (faster, softer)." },
];

/**
 * Near-pure function (reads the AMBIENT particle clock; pure w.r.t. its argument).
 * SCHEMA params (RAINY_WINDOW_FILL_PARAMS names — the look knobs) → the PACKER's
 * params, injecting `time` from particleTime() (the freeze constant in the
 * editor/CLI ⇒ a deterministic still, the wall clock in the presenter ⇒ running
 * rain). THE one mapping both consumers share: the demo widget's emit() and the
 * fill-material regionOp synthesis (paint_skia handleMaterialPaintShape reads it as
 * entry.toUniformParams). Unlike comic's screen-angle knobs (raw degrees →
 * radians), `lightAngle` is already stored in radians (display:"degrees"), so it
 * passes straight through. `blurRadius`/`backdropScale` are NOT packer uniforms —
 * they are region-op fields the fill path reads directly — so they are dropped here.
 *
 * @param {object} p - schema-shaped look params (resolved: every knob present)
 * @returns {object} packRainyWindow-shaped params (with `time`)
 *
 * @example rainyWindowUniformParams({rain: 0.8, fog: 0.5, speed: 1, dropSize: 1, columns: 6, streakiness: 1, refraction: 0.06, shine: 0.9, lightAngle: -1.88, tint: "#dfe8f0"}).rain // 0.8
 * @example rainyWindowUniformParams({rain: 0.5, fog: 0, speed: 2, dropSize: 1, columns: 8, streakiness: 2, refraction: 0.1, shine: 1, lightAngle: -1.88, tint: "#fff"}).columns // 8
 */
export function rainyWindowUniformParams(p) {
  return {
    time: particleTime(),
    speed: p.speed, rain: p.rain, fog: p.fog,
    refraction: p.refraction, shine: p.shine, dropSize: p.dropSize,
    columns: p.columns, streakiness: p.streakiness, lightAngle: p.lightAngle, tint: p.tint,
  };
}

/**
 * THE RAINY WINDOW MATERIAL DESCRIPTOR — the registry entry (materials.js). `id`
 * matches the plugin's `material` op field; `sksl` is the shader; `pack` maps the
 * framework's normalized `u` (device geometry + the material's own knobs) to the
 * uniform Float32Array. `backdrop: true` binds the standard {blurred, sharp}
 * children and re-renders the content beneath (the same machinery CRT/glass use).
 *
 * `fillParams` + `toUniformParams` OPT THIS MATERIAL INTO BEING A FILL (the comic
 * exemplar's contract): any shape can carry it as its fill paint, and the same
 * knob schema feeds both the demo widget and the paint UI. This is the FIRST
 * time-driven material to opt in — the mapping reads particleTime() so a filled
 * shape's rain runs (presenter) / freezes deterministically (editor/CLI) exactly
 * as the widget's does.
 */
export const RAINY_WINDOW_MATERIAL = {
  id: "rainy_window",
  sksl: RAINY_WINDOW_SKSL,
  pack: packRainyWindow,
  uniformFloats: RAINY_WINDOW_UNIFORM_FLOATS,
  backdrop: true,
  fillParams: RAINY_WINDOW_FILL_PARAMS,
  toUniformParams: rainyWindowUniformParams,
};
