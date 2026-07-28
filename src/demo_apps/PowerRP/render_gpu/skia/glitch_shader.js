/**
 * The DIGITAL GLITCH SkSL material — an ANIMATED BACKDROP material on the reusable
 * MATERIAL FRAMEWORK (render_gpu/skia/materials.js), a sibling of the CRT /
 * rainy-window materials. It corrupts the composite-so-far inside a rounded-rect
 * region into a sci-fi datamosh / broken-signal look: RGB channel SPLIT, per-block
 * horizontal DISPLACEMENT, a rolling TEAR band, scanline jitter + analog wobble,
 * block dropout / channel-swap corruption, posterize, pixelate, scanline darkening,
 * static grain, a bloom glow and a colour tint — all gated by intermittent BURSTS
 * so the region mostly shows clean and then violently glitches.
 *
 * ── DETERMINISM (frame = pure(document, time)) ────────────────────────────────
 * The only time input is uTime (seconds) from particleTime() (render_gpu/
 * particle_clock.js): a FROZEN constant in the editor/CLI (a deterministic still —
 * same doc ⇒ byte-identical pixels) and the wall clock in the presenter (the glitch
 * animates). Every random is a PURE fract-hash (Dave Hoskins, sin-free) of a
 * (block, timeStep) id plus a uSeed — NO Date.now, NO Math.random. Two things drive
 * the animation:
 *   - STEPPED events: `stp = floor(uTime · rate)` quantizes time into discrete
 *     frames, so each block/tear holds a displacement for 1/rate s then jumps to a
 *     fresh hash — the choppy "digital" cadence.
 *   - a `burst()` = step(threshold, hash(floor(uTime · burstRate))) window that
 *     scales the split/shift up, so the corruption comes in intermittent hits.
 * So the SAME uTime ⇒ identical pixels, and ≥2 distinct uTime (that cross a step or
 * burst boundary, or via the continuous wobble/grain) ⇒ a different frame.
 *
 * ── ROTATION-SAFE ──────────────────────────────────────────────────────────────
 * `main(float2 p)` works in DEVICE px: rotate p into the widget's LOCAL frame for
 * the SDF coverage + the block grid, build all displacements as LOCAL offsets, then
 * rotate them back to device before sampling `sharpBackdrop` — so a rotated widget
 * tears along its OWN horizontal, not the screen's. `uIntensity` lerps the whole
 * effect from the untouched backdrop (0) to fully glitched (1). `blurredBackdrop`
 * is the bloom-glow source.
 *
 * DOM-free at import (string SkSL + a pure packer), like crt_shader.js. `parseColor`
 * (render_gpu/ir.js) is the shared node-safe colour parser.
 */

import { parseColor } from "../ir.js";
import { particleTime } from "../particle_clock.js";

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
export const GLITCH_SKSL = `
const float AA_PX = 1.0;              // region-edge coverage antialias half-width (~1 device px)
const float TWO_PI = 6.28318530718;   // 2π — one full scanline-band period
const float3 LUMA = float3(0.2126, 0.7152, 0.0722);  // luma weights (dropout desaturation)
const float SCANLINE_HASH_ROWS = 240.0;  // rows the fine per-scanline horizontal jitter is hashed over
const float TINT_MIX = 0.35;              // how strongly the colour tint is blended into the glitched pixel
const float BURST_FLOOR = 0.35;           // base split/shift scale outside a burst (so it never fully vanishes when intensity>0)
const float SEED_SALT_DROP = 3.0;         // hash salt separating the dropout roll from the displacement roll
const float SEED_SALT_SWAP = 5.0;         // hash salt separating the channel-swap roll
const float SEED_SALT_SHIFT = 7.0;        // hash salt separating the shift-magnitude roll
// hash mixing constants (Dave Hoskins fract-hash — backend-stable, sin-free)
const float H1_MUL = 0.1031; const float H1_ADD = 33.33;
const float3 H3_MUL = float3(0.1031, 0.1030, 0.0973); const float H3_ADD = 33.33;

uniform shader blurredBackdrop;  // child 0: Gaussian-blurred composite-so-far — the bloom GLOW source
uniform shader sharpBackdrop;    // child 1: the un-blurred composite-so-far — the signal being corrupted
uniform float2 uCenter;          // region centre (device px)
uniform float2 uHalfSize;        // region half-extents (device px)
uniform float uCornerRadius;     // rounded-rect corner radius (device px)
uniform float uAngle;            // widget rotation (radians): tear/split run along the LOCAL frame
uniform float uTime;             // animation time (seconds) — frozen in editor/CLI, wall clock in presenter
uniform float uSeed;             // per-widget random seed (decorrelates two glitch widgets)
// ── user-tweakable knobs (self.* custom props) ───────────────────────────────
uniform float uIntensity;        // 0..1 master mix: 0 = untouched backdrop, 1 = fully glitched
uniform float uRgbSplitPx;       // RGB channel-split distance (device px) at full burst
uniform float uSplitMode;        // 0 = horizontal split, 1 = radial (outward from centre)
uniform float uBlockCount;       // number of horizontal displacement BANDS down the height
uniform float uMaxShiftPx;       // max per-block horizontal displacement (device px)
uniform float uDensity;          // 0..1 fraction of blocks that are displaced at once
uniform float uTearRate;         // block/jitter re-roll rate (Hz): how choppy the digital cadence is
uniform float uJitterPx;         // fine per-scanline horizontal jitter amplitude (device px)
uniform float uTearHeight;       // 0..1 height of the rolling coarse tear band (fraction of the region)
uniform float uTearSpeed;        // how fast the tear band rolls down the region (cycles/sec)
uniform float uDropout;          // 0..1 probability a block drops to greyscale (signal loss)
uniform float uWobbleAmp;        // analog horizontal wobble amplitude (device px)
uniform float uWobbleFreq;       // vertical spatial frequency of the wobble
uniform float uWobbleSpeed;      // temporal speed of the wobble
uniform float uCorrupt;          // 0..1 probability a block's channels are cyclically swapped (colour corruption)
uniform float uPosterize;        // 1 = off; >1 = quantize each channel into this many levels
uniform float uPixelate;         // 0 = off; else number of chunky pixel CELLS across the region
uniform float uScanlineDepth;    // 0..1 darkness of the scanline bands
uniform float uGrain;            // 0..1 static/noise grain amount
uniform float uGlow;             // bloom: how much of the blurred backdrop is added back
uniform float uBurstRate;        // how often burst windows are rolled (Hz)
uniform float uBurstThreshold;   // 0..1 — higher = rarer bursts (the region is clean more of the time)
uniform float3 uTint;            // colour cast blended in by TINT_MIX (a hologram cyan, a VHS warmth)

// Pure. Signed distance to a rounded rect (local, centered). <0 inside.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Pure. 1D fract-hash → [0,1).
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

// Near-pure (reads uTime/uSeed uniforms). Intermittent BURST envelope in [0,1]:
// 0 for most time steps, then a hashed spike during a burst window.
float burst() {
  float n = hash11(floor(uTime * uBurstRate) + uSeed);
  return step(uBurstThreshold, n) * n;
}

half4 main(float2 p) {
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y); // device → local (centered)
  float rr = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y));       // capsule-safe clamp
  float dRR = sdRoundRect(pl, uHalfSize, rr);
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, dRR);
  if (cov <= 0.0) { return half4(0.0); }

  float2 uv = pl / uHalfSize;             // [-1,1] over the region
  float yy = uv.y * 0.5 + 0.5;            // 0..1 down the region
  float b = burst();
  float amp = BURST_FLOOR + b;            // effect strength this frame (floor + burst spike)
  float stp = floor(uTime * uTearRate);   // discrete time step (the choppy cadence)

  // (1) BLOCK DISPLACEMENT — each horizontal band gets a hashed horizontal shift.
  float band = floor(yy * uBlockCount);
  float rb = hash21(float2(band, stp) + uSeed);
  float on = step(1.0 - uDensity, rb);                                   // only some blocks fire
  float shift = on * (hash21(float2(band, stp + SEED_SALT_SHIFT) + uSeed) - 0.5) * 2.0 * uMaxShiftPx * amp;
  // fine per-scanline jitter + smooth analog wobble
  shift += (hash21(float2(floor(yy * SCANLINE_HASH_ROWS), stp) + uSeed) - 0.5) * 2.0 * uJitterPx;
  shift += sin(uv.y * uWobbleFreq + uTime * uWobbleSpeed) * uWobbleAmp;

  // (2) rolling coarse TEAR band — a wide slab that rips sideways as it scrolls down.
  float tearY = fract(uTime * uTearSpeed);
  float inTear = step(tearY, yy) * step(yy, tearY + uTearHeight);
  shift += inTear * (hash21(float2(stp, 1.0) + uSeed) - 0.5) * 2.0 * uMaxShiftPx * amp;

  // local horizontal shift → device (rotation-safe)
  float2 soff = float2(ca * shift, sa * shift);

  // (3) PIXELATE — snap the sample base to a chunky local grid before displacing.
  float2 sampleLocal = pl;
  if (uPixelate >= 1.0) {
    float2 cellSize = (uHalfSize * 2.0) / uPixelate;
    sampleLocal = (floor(pl / cellSize) + 0.5) * cellSize;
  }
  float2 baseDev = float2(ca * sampleLocal.x - sa * sampleLocal.y, sa * sampleLocal.x + ca * sampleLocal.y) + uCenter;

  // (4) RGB SPLIT — offset R and B along the split direction (grows with the burst).
  float split = uRgbSplitPx * amp;
  float2 dir = (uSplitMode > 0.5) ? (length(uv) > 0.0 ? uv / length(uv) : float2(0.0)) : float2(1.0, 0.0);
  float2 co = float2(ca * dir.x - sa * dir.y, sa * dir.x + ca * dir.y) * split;

  half3 col = half3(
    sharpBackdrop.eval(baseDev + soff + co).r,
    sharpBackdrop.eval(baseDev + soff).g,
    sharpBackdrop.eval(baseDev + soff - co).b
  );

  // (5) per-block CORRUPTION: greyscale dropout + cyclic channel swap.
  if (hash21(float2(band, stp) + uSeed * SEED_SALT_DROP) < uDropout) { col = half3(dot(col, half3(LUMA))); }
  if (hash21(float2(band, stp) + uSeed * SEED_SALT_SWAP) < uCorrupt) { col = col.gbr; }

  // (6) POSTERIZE each channel (bit-crushed colour).
  if (uPosterize > 1.0) { col = floor(col * half(uPosterize)) / half(uPosterize); }

  // (7) scanline darkening, grain, bloom glow, colour tint.
  float bandLit = 0.5 + 0.5 * cos(yy * uBlockCount * TWO_PI);
  col *= half(mix(1.0 - uScanlineDepth, 1.0, bandLit));
  col += half3(half((hash21(uv + uTime) - 0.5) * 2.0 * uGrain));
  col += half3(blurredBackdrop.eval(baseDev).rgb) * half(uGlow);
  col = mix(col, col * half3(uTint), half(TINT_MIX));

  // (8) master mix: lerp from the untouched backdrop by uIntensity.
  half3 clean = half3(sharpBackdrop.eval(p).rgb);
  col = mix(clean, col, half(clamp(uIntensity, 0.0, 1.0)));
  return half4(col * half(cov), half(cov));
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
// geometry 6 + uTime + uSeed = 8; 22 scalar knobs; uTint 3 = 33.
const GLITCH_UNIFORM_FLOATS = 33;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens the whole
 * region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packGlitchUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string / rgba array / paint) → its rgb triple [r, g, b] via
 * the shared node-safe parseColor. Alpha is dropped (a tint has no meaningful alpha). */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

/**
 * Pure function. Packs the Digital Glitch uniforms into the flat Float32Array
 * CanvasKit expects (SkSL declaration order, tight-packed: float2 = 2 slots,
 * float3 = 3). `u` is the material framework's normalized input: DEVICE-px region
 * geometry {cx, cy, halfW, halfH, cornerRadius, angle} + `scale` (world→device
 * length) + this material's own already-evaluated knobs (the op's `params`).
 *
 * The three DISTANCE knobs (rgbSplitPx, maxShiftPx, jitterPx, wobbleAmp) arrive in
 * WORLD px and are scaled to device px HERE (× scale), so a glitch on a small
 * widget and a large one look proportional. `time` comes from particleTime().
 *
 * @param {object} u - {cx, cy, halfW, halfH, cornerRadius, angle, scale, time,
 *   seed, intensity, rgbSplitPx, splitMode, blockCount, maxShiftPx, density,
 *   tearRate, jitterPx, tearHeight, tearSpeed, dropout, wobbleAmp, wobbleFreq,
 *   wobbleSpeed, corrupt, posterize, pixelate, scanlineDepth, grain, glow,
 *   burstRate, burstThreshold, tint}
 * @returns {Float32Array} length 33, in shader-uniform order
 *
 * @example
 * packGlitchUniforms({cx:200,cy:150,halfW:200,halfH:150,cornerRadius:0,angle:0,
 *   scale:2,time:0,seed:1337,intensity:0.9,rgbSplitPx:3,splitMode:0,blockCount:24,
 *   maxShiftPx:14,density:0.4,tearRate:8,jitterPx:1,tearHeight:0.12,tearSpeed:0.6,
 *   dropout:0.06,wobbleAmp:0,wobbleFreq:40,wobbleSpeed:6,corrupt:0.05,posterize:1,
 *   pixelate:0,scanlineDepth:0.2,grain:0.06,glow:0.1,burstRate:6,burstThreshold:0.6,
 *   tint:"#ffffff"}).length // 33
 * @example
 * // a world-px split of 3 at scale 2 packs as 6 device px (slot 10, uRgbSplitPx)
 * packGlitchUniforms({cx:0,cy:0,halfW:80,halfH:60,cornerRadius:0,angle:0,scale:2,
 *   time:0,seed:1,intensity:1,rgbSplitPx:3,splitMode:0,blockCount:10,maxShiftPx:5,
 *   density:0.3,tearRate:8,jitterPx:0,tearHeight:0.1,tearSpeed:0.5,dropout:0,
 *   wobbleAmp:0,wobbleFreq:10,wobbleSpeed:1,corrupt:0,posterize:1,pixelate:0,
 *   scanlineDepth:0,grain:0,glow:0,burstRate:6,burstThreshold:0.6,tint:"#ffffff"})[10] // 6
 */
export function packGlitchUniforms(u) {
  const sd = num("scale", u.scale);
  const tint = rgb("tint", u.tint);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("time", u.time),
    num("seed", u.seed),
    num("intensity", u.intensity),
    num("rgbSplitPx", u.rgbSplitPx) * sd,
    num("splitMode", u.splitMode),
    num("blockCount", u.blockCount),
    num("maxShiftPx", u.maxShiftPx) * sd,
    num("density", u.density),
    num("tearRate", u.tearRate),
    num("jitterPx", u.jitterPx) * sd,
    num("tearHeight", u.tearHeight),
    num("tearSpeed", u.tearSpeed),
    num("dropout", u.dropout),
    num("wobbleAmp", u.wobbleAmp) * sd,
    num("wobbleFreq", u.wobbleFreq),
    num("wobbleSpeed", u.wobbleSpeed),
    num("corrupt", u.corrupt),
    num("posterize", u.posterize),
    num("pixelate", u.pixelate),
    num("scanlineDepth", u.scanlineDepth),
    num("grain", u.grain),
    num("glow", u.glow),
    num("burstRate", u.burstRate),
    num("burstThreshold", u.burstThreshold),
    tint[0], tint[1], tint[2],
  ]);
  if (out.length !== GLITCH_UNIFORM_FLOATS)
    throw new Error(`packGlitchUniforms: packed ${out.length} floats, expected ${GLITCH_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE GLITCH KNOB SCHEMA — the ONE declaration of the material's look knobs, in
 * the customProps row shape. Both consumers derive from it (the end-state ruling
 * "custom properties become material properties"):
 *   - plugins/demo/glitch.js spreads it into its customProps (self.* rows);
 *   - the FILL-material UI renders it as the paint's param rows, resolved
 *     sparse-over-defaults by materials.resolveMaterialPaint.
 * Geometry knobs (cornerRadius) stay widget-side — a fill's shape IS its geometry.
 * TIME is NOT here: uTime is the AMBIENT particle clock (particleTime()), not a
 * document knob; glitchUniformParams injects it. Distance knobs (rgbSplitPx,
 * maxShiftPx, jitterPx, wobbleAmp) are WORLD px (the packer scales to device so
 * the look is size-proportional); rates/counts/fractions are dimensionless.
 */
export const GLITCH_FILL_PARAMS = [
  { name: "seed", kind: "number", default: 1337, help: "Random seed — decorrelates two glitch widgets so they don't corrupt in lockstep. Any number; change it for a different glitch pattern." },
  { name: "intensity", kind: "number", default: 0.9, min: 0, max: 1, help: "Master mix from the untouched backdrop (0) to fully glitched (1). A clean off-switch for the whole effect." },
  { name: "rgbSplitPx", kind: "number", default: 2.5, min: 0, help: "RGB channel-split distance (world px) at full burst — how far the red/blue fringes separate (chromatic aberration)." },
  { name: "splitMode", kind: "select", options: ["horizontal", "radial"], optionLabels: { horizontal: "Horizontal", radial: "Radial (from centre)" }, default: "horizontal", help: "Direction of the RGB split: Horizontal (a classic sideways fringe) or Radial (fringes fan outward from the centre — a lens/hologram look)." },
  { name: "blockCount", kind: "number", default: 22, min: 1, help: "Number of horizontal displacement BANDS down the height — the granularity of the block glitch and the scanline bands." },
  { name: "maxShiftPx", kind: "number", default: 12, min: 0, help: "Max per-block horizontal displacement (world px) — how far a corrupted band jumps sideways." },
  { name: "density", kind: "number", default: 0.35, min: 0, max: 1, help: "Fraction of blocks that are displaced at once (0 = none, 1 = every band). How busy the block glitch is." },
  { name: "tearRate", kind: "number", default: 8, min: 0, scrub: 0.1, help: "Re-roll rate (Hz) of the blocks/jitter — how choppy the digital cadence is. Higher = faster, more frantic corruption." },
  { name: "jitterPx", kind: "number", default: 1, min: 0, scrub: 0.05, help: "Fine per-scanline horizontal jitter (world px) — the shivering tape-tracking wobble on every line." },
  { name: "tearHeight", kind: "number", default: 0.12, min: 0, max: 1, help: "Height of the rolling coarse TEAR band as a fraction of the region — the wide slab that rips sideways." },
  { name: "tearSpeed", kind: "number", default: 0.6, min: 0, help: "How fast the tear band rolls down the region (cycles/sec). 0 = a static tear at the top." },
  { name: "dropout", kind: "number", default: 0.05, min: 0, max: 1, help: "Probability a block drops to greyscale (signal loss / dead colour). Higher = more washed-out corrupted bands." },
  { name: "wobbleAmp", kind: "number", default: 0, min: 0, help: "Analog horizontal WOBBLE amplitude (world px) — a smooth sinusoidal warp (the VHS/analog sway). 0 = purely digital." },
  { name: "wobbleFreq", kind: "number", default: 30, min: 0, scrub: 0.5, help: "Vertical spatial frequency of the wobble — how many sway cycles fit down the region." },
  { name: "wobbleSpeed", kind: "number", default: 5, min: 0, scrub: 0.1, help: "Temporal speed of the wobble sway." },
  { name: "corrupt", kind: "number", default: 0.04, min: 0, max: 1, help: "Probability a block's colour channels are cyclically swapped (RGB→GBR) — lurid colour corruption." },
  { name: "posterize", kind: "number", default: 0, min: 0, help: "Quantize each channel into this many levels (bit-crushed colour). 0 or 1 = off; e.g. 4–6 = chunky posterized colour." },
  { name: "pixelate", kind: "number", default: 0, min: 0, help: "Chunky pixelation: number of pixel CELLS across the region (0 = off). Low values = big blocky mosaic pixels." },
  { name: "scanlineDepth", kind: "number", default: 0.2, min: 0, max: 1, help: "Darkness of the scanline bands (0 = none, 1 = black gaps) — the CRT/monitor line texture." },
  { name: "grain", kind: "number", default: 0.06, min: 0, max: 1, help: "Static / noise grain amount over the whole region — signal snow." },
  { name: "glow", kind: "number", default: 0.15, min: 0, help: "Bloom: how much of a blurred copy of the content is added back as a soft glow (a lit-screen/hologram bleed)." },
  { name: "burstRate", kind: "number", default: 6, min: 0, scrub: 0.1, help: "How often burst windows are rolled (Hz) — the tempo of the intermittent glitch hits." },
  { name: "burstThreshold", kind: "number", default: 0.55, min: 0, max: 1, help: "How rare the bursts are (higher = rarer, so the region reads clean more of the time between violent hits)." },
  { name: "tint", kind: "color", default: "#ffffff", help: "Colour cast blended into the glitched pixels (a cyan hologram, a warm VHS). White = no cast." },
  { name: "blurRadius", kind: "number", default: 8, min: 0, help: "Gaussian blur radius (world px) of the bloom-glow source — how soft the glow is." },
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, help: "RESOLUTION FACTOR the content beneath is re-rendered at: 1 = screen resolution, 2 = supersample (crisper, slower). The 0.25..2 bounds are a PERFORMANCE guard, not a look choice — below 0.25 the backdrop is uselessly coarse and above 2 the re-render cost balloons." },
];

/**
 * Near-pure function (reads the AMBIENT particle clock particleTime(); pure w.r.t.
 * its argument). SCHEMA params (GLITCH_FILL_PARAMS names/kinds — the splitMode
 * string, numbers, a colour) → the PACKER's numeric params (splitMode code, the
 * packer's own key names), and it INJECTS `time` from particleTime() — frozen in
 * the editor/CLI (deterministic still), the wall clock in the presenter (the glitch
 * runs). THE one mapping both consumers share: the demo widget's emit() and the
 * fill-material regionOp synthesis (paint_skia handleMaterialPaintShape reads it as
 * entry.toUniformParams), so a glitch FILL animates the same way the widget does.
 * `blurRadius` / `backdropScale` are region-op fields (not packer uniforms), so they
 * are NOT emitted here — the caller reads them off the resolved params directly.
 *
 * @param {object} p - schema-shaped params (resolved: every knob present)
 * @returns {object} packGlitchUniforms-shaped params (with `time` injected)
 *
 * @example glitchUniformParams({seed: 1, intensity: 0.9, rgbSplitPx: 2, splitMode: "radial", blockCount: 20, maxShiftPx: 10, density: 0.3, tearRate: 8, jitterPx: 1, tearHeight: 0.1, tearSpeed: 0.5, dropout: 0.05, wobbleAmp: 0, wobbleFreq: 30, wobbleSpeed: 5, corrupt: 0.04, posterize: 0, pixelate: 0, scanlineDepth: 0.2, grain: 0.06, glow: 0.15, burstRate: 6, burstThreshold: 0.55, tint: "#fff"}).splitMode // 1
 * @example glitchUniformParams({seed: 1, intensity: 1, rgbSplitPx: 2, splitMode: "horizontal", blockCount: 20, maxShiftPx: 10, density: 0.3, tearRate: 8, jitterPx: 1, tearHeight: 0.1, tearSpeed: 0.5, dropout: 0, wobbleAmp: 0, wobbleFreq: 30, wobbleSpeed: 5, corrupt: 0, posterize: 0, pixelate: 0, scanlineDepth: 0.2, grain: 0.06, glow: 0.15, burstRate: 6, burstThreshold: 0.55, tint: "#fff"}).time // 2  (the paused editor freeze time)
 */
export function glitchUniformParams(p) {
  const SPLIT_CODE = { horizontal: 0, radial: 1 };
  return {
    time: particleTime(),
    seed: p.seed,
    intensity: p.intensity,
    rgbSplitPx: p.rgbSplitPx,
    splitMode: SPLIT_CODE[p.splitMode] ?? 0,
    blockCount: p.blockCount,
    maxShiftPx: p.maxShiftPx,
    density: p.density,
    tearRate: p.tearRate,
    jitterPx: p.jitterPx,
    tearHeight: p.tearHeight,
    tearSpeed: p.tearSpeed,
    dropout: p.dropout,
    wobbleAmp: p.wobbleAmp,
    wobbleFreq: p.wobbleFreq,
    wobbleSpeed: p.wobbleSpeed,
    corrupt: p.corrupt,
    posterize: p.posterize,
    pixelate: p.pixelate,
    scanlineDepth: p.scanlineDepth,
    grain: p.grain,
    glow: p.glow,
    burstRate: p.burstRate,
    burstThreshold: p.burstThreshold,
    tint: p.tint,
  };
}

/**
 * THE DIGITAL GLITCH MATERIAL DESCRIPTOR — the registry entry (materials.js). `id`
 * matches the plugin's `material` op field; `sksl` is the shader; `pack` maps the
 * framework's normalized `u` to the uniform Float32Array. `backdrop: true` binds
 * the standard {blurred, sharp} children and re-renders the content beneath (the
 * same machinery CRT / rainy-window use). `fillParams` + `toUniformParams` opt the
 * material into being ANY shape's FILL (the fill-material framework, f151f84):
 * their knobs and mapping live HERE, and plugins/demo/glitch.js derives both.
 */
export const GLITCH_MATERIAL = {
  id: "glitch",
  sksl: GLITCH_SKSL,
  pack: packGlitchUniforms,
  uniformFloats: GLITCH_UNIFORM_FLOATS,
  backdrop: true,
  fillParams: GLITCH_FILL_PARAMS,
  toUniformParams: glitchUniformParams,
};
