/**
 * DIGITAL GLITCH — a DEMO WIDGET (plugins/demo/, the showcase folder) and an
 * ANIMATED BACKDROP material on the reusable MATERIAL FRAMEWORK. A rounded-rect
 * region that corrupts the content beneath it into a sci-fi datamosh / broken-
 * signal look: RGB channel split, per-block horizontal displacement, a rolling
 * tear band, scanline jitter + analog wobble, block dropout / channel-swap
 * corruption, posterize, pixelate, scanlines, grain, bloom glow and a colour tint,
 * gated by intermittent BURSTS so it mostly reads clean then violently glitches.
 *
 * Like CRT / rainy-window it is a BACKDROP SAMPLER (capabilities.backdrop) and a
 * bbox widget (standard resize handles). It emits ONE `materialBackdrop` op naming
 * the "glitch" material (render_gpu/skia/materials.js → glitch_shader.js); it does
 * NOT compose the effects bundle (a backdrop sampler cannot be wrapped in an
 * effectSubtree, whose offscreen re-render would sample an empty surface).
 *
 * ANIMATION / DETERMINISM: the `animated` shared-state property (default true) makes
 * the presenter repaint every frame while the widget is visible; emit() reads the
 * ambient clock particleTime() (render_gpu/particle_clock.js) for uTime — a frozen
 * constant in the editor/CLI (same doc ⇒ byte-identical pixels) and the wall clock
 * in the presenter (the glitch runs). The shader is a pure function of (pixel,
 * uTime, uSeed, knobs) — no Date.now / no Math.random.
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps): each
 * is an equation-capable widget-state key with ZERO evaluation-engine changes — the
 * material framework carries the params straight to the SkSL uniforms. `splitMode`
 * is a `select` knob stored as a STRING; emit() maps it to the shader's numeric code
 * (the metaballs TYPE_CODE pattern).
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free
 * / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialBackdrop } from "../../render_gpu/ir.js";
import { particleTime } from "../../render_gpu/particle_clock.js";

// select ids → the shader's numeric split-mode code (glitch_shader.js).
const SPLIT_OPTIONS = ["horizontal", "radial"];
const SPLIT_LABELS = { horizontal: "Horizontal", radial: "Radial (from centre)" };
const SPLIT_CODE = { horizontal: 0, radial: 1 };

// The glitch look knobs, all self.* custom properties. Distance knobs (rgbSplitPx,
// maxShiftPx, jitterPx, wobbleAmp) are WORLD px (the packer scales to device so the
// look is size-proportional); rates/counts/fractions are dimensionless.
const CUSTOM = customProps([
  { name: "seed", kind: "number", default: 1337, help: "Random seed — decorrelates two glitch widgets so they don't corrupt in lockstep. Any number; change it for a different glitch pattern." },
  { name: "intensity", kind: "number", default: 0.9, min: 0, max: 1, help: "Master mix from the untouched backdrop (0) to fully glitched (1). A clean off-switch for the whole effect." },
  { name: "rgbSplitPx", kind: "number", default: 2.5, min: 0, help: "RGB channel-split distance (world px) at full burst — how far the red/blue fringes separate (chromatic aberration)." },
  { name: "splitMode", kind: "select", options: SPLIT_OPTIONS, optionLabels: SPLIT_LABELS, default: "horizontal", help: "Direction of the RGB split: Horizontal (a classic sideways fringe) or Radial (fringes fan outward from the centre — a lens/hologram look)." },
  { name: "blockCount", kind: "number", default: 22, min: 1, help: "Number of horizontal displacement BANDS down the height — the granularity of the block glitch and the scanline bands." },
  { name: "maxShiftPx", kind: "number", default: 12, min: 0, help: "Max per-block horizontal displacement (world px) — how far a corrupted band jumps sideways." },
  { name: "density", kind: "number", default: 0.35, min: 0, max: 1, help: "Fraction of blocks that are displaced at once (0 = none, 1 = every band). How busy the block glitch is." },
  { name: "tearRate", kind: "number", default: 8, min: 0, help: "Re-roll rate (Hz) of the blocks/jitter — how choppy the digital cadence is. Higher = faster, more frantic corruption." },
  { name: "jitterPx", kind: "number", default: 1, min: 0, help: "Fine per-scanline horizontal jitter (world px) — the shivering tape-tracking wobble on every line." },
  { name: "tearHeight", kind: "number", default: 0.12, min: 0, max: 1, help: "Height of the rolling coarse TEAR band as a fraction of the region — the wide slab that rips sideways." },
  { name: "tearSpeed", kind: "number", default: 0.6, min: 0, help: "How fast the tear band rolls down the region (cycles/sec). 0 = a static tear at the top." },
  { name: "dropout", kind: "number", default: 0.05, min: 0, max: 1, help: "Probability a block drops to greyscale (signal loss / dead colour). Higher = more washed-out corrupted bands." },
  { name: "wobbleAmp", kind: "number", default: 0, min: 0, help: "Analog horizontal WOBBLE amplitude (world px) — a smooth sinusoidal warp (the VHS/analog sway). 0 = purely digital." },
  { name: "wobbleFreq", kind: "number", default: 30, min: 0, help: "Vertical spatial frequency of the wobble — how many sway cycles fit down the region." },
  { name: "wobbleSpeed", kind: "number", default: 5, min: 0, help: "Temporal speed of the wobble sway." },
  { name: "corrupt", kind: "number", default: 0.04, min: 0, max: 1, help: "Probability a block's colour channels are cyclically swapped (RGB→GBR) — lurid colour corruption." },
  { name: "posterize", kind: "number", default: 0, min: 0, help: "Quantize each channel into this many levels (bit-crushed colour). 0 or 1 = off; e.g. 4–6 = chunky posterized colour." },
  { name: "pixelate", kind: "number", default: 0, min: 0, help: "Chunky pixelation: number of pixel CELLS across the region (0 = off). Low values = big blocky mosaic pixels." },
  { name: "scanlineDepth", kind: "number", default: 0.2, min: 0, max: 1, help: "Darkness of the scanline bands (0 = none, 1 = black gaps) — the CRT/monitor line texture." },
  { name: "grain", kind: "number", default: 0.06, min: 0, max: 1, help: "Static / noise grain amount over the whole region — signal snow." },
  { name: "glow", kind: "number", default: 0.15, min: 0, help: "Bloom: how much of a blurred copy of the content is added back as a soft glow (a lit-screen/hologram bleed)." },
  { name: "burstRate", kind: "number", default: 6, min: 0, help: "How often burst windows are rolled (Hz) — the tempo of the intermittent glitch hits." },
  { name: "burstThreshold", kind: "number", default: 0.55, min: 0, max: 1, help: "How rare the bursts are (higher = rarer, so the region reads clean more of the time between violent hits)." },
  { name: "tint", kind: "color", default: "#ffffff", help: "Colour cast blended into the glitched pixels (a cyan hologram, a warm VHS). White = no cast." },
  // ── geometry / render controls (world units + the sample resolution) ─────────
  { name: "cornerRadius", kind: "number", default: 8, min: 0, help: "Rounded-corner radius of the glitch region (world px). 0 = sharp corners (a full screen)." },
  { name: "blurRadius", kind: "number", default: 8, min: 0, help: "Gaussian blur radius (world px) of the bloom-glow source — how soft the glow is." },
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, help: "RESOLUTION FACTOR the content beneath is re-rendered at: 1 = screen resolution, 2 = supersample (crisper, slower)." },
]);

// The 6 canonical looks, surfaced by web/ToolsPane.svelte (props = a flat knob map).
const PRESETS = [
  {
    name: "HUD Flicker",
    description: "Mostly clean cyan interface that flickers with a faint chromatic split and scanlines — a sci-fi UI panel.",
    props: { intensity: 0.85, rgbSplitPx: 1.5, splitMode: "horizontal", blockCount: 20, maxShiftPx: 3, density: 0.15, tearRate: 10, jitterPx: 0.5, tearHeight: 0.05, tearSpeed: 0.3, dropout: 0.02, wobbleAmp: 0, wobbleFreq: 30, wobbleSpeed: 4, corrupt: 0.01, posterize: 0, pixelate: 0, scanlineDepth: 0.25, grain: 0.04, glow: 0.25, burstRate: 5, burstThreshold: 0.75, tint: "#8ff6ff" },
  },
  {
    name: "Heavy Datamosh",
    description: "Aggressive block displacement, channel swaps and posterized colour — a compression-artifact meltdown.",
    props: { intensity: 1.0, rgbSplitPx: 4, splitMode: "horizontal", blockCount: 30, maxShiftPx: 40, density: 0.6, tearRate: 12, jitterPx: 2, tearHeight: 0.18, tearSpeed: 0.8, dropout: 0.12, wobbleAmp: 0, wobbleFreq: 20, wobbleSpeed: 5, corrupt: 0.25, posterize: 6, pixelate: 0, scanlineDepth: 0.1, grain: 0.1, glow: 0.1, burstRate: 8, burstThreshold: 0.35, tint: "#ffffff" },
  },
  {
    name: "VHS Glitch",
    description: "Warm analog wobble, tape jitter, a rolling tear and heavy scanlines — a worn VHS transfer.",
    props: { intensity: 0.95, rgbSplitPx: 3, splitMode: "horizontal", blockCount: 16, maxShiftPx: 10, density: 0.3, tearRate: 6, jitterPx: 3, tearHeight: 0.12, tearSpeed: 0.5, dropout: 0.05, wobbleAmp: 4, wobbleFreq: 50, wobbleSpeed: 7, corrupt: 0.04, posterize: 0, pixelate: 0, scanlineDepth: 0.35, grain: 0.18, glow: 0.15, burstRate: 4, burstThreshold: 0.5, tint: "#ffd9c0" },
  },
  {
    name: "Corrupted Signal",
    description: "Frequent dropout, channel corruption, posterize and chunky pixels — a dead/garbled data feed.",
    props: { intensity: 1.0, rgbSplitPx: 5, splitMode: "horizontal", blockCount: 40, maxShiftPx: 30, density: 0.7, tearRate: 14, jitterPx: 2, tearHeight: 0.2, tearSpeed: 1.0, dropout: 0.3, wobbleAmp: 0, wobbleFreq: 10, wobbleSpeed: 3, corrupt: 0.4, posterize: 4, pixelate: 60, scanlineDepth: 0.15, grain: 0.22, glow: 0.05, burstRate: 10, burstThreshold: 0.3, tint: "#c8ffe0" },
  },
  {
    name: "Cyberpunk Hologram",
    description: "Radial chromatic split, cyan tint, strong glow and dense scanlines — a projected holographic display.",
    props: { intensity: 0.9, rgbSplitPx: 4, splitMode: "radial", blockCount: 22, maxShiftPx: 6, density: 0.2, tearRate: 8, jitterPx: 1, tearHeight: 0.06, tearSpeed: 0.4, dropout: 0.03, wobbleAmp: 2, wobbleFreq: 24, wobbleSpeed: 5, corrupt: 0.02, posterize: 0, pixelate: 0, scanlineDepth: 0.4, grain: 0.06, glow: 0.5, burstRate: 6, burstThreshold: 0.55, tint: "#66e0ff" },
  },
  {
    name: "Hard Digital Tear",
    description: "A big rolling tear slab and large block jumps with minimal colour effects — a violent horizontal rip.",
    props: { intensity: 1.0, rgbSplitPx: 2, splitMode: "horizontal", blockCount: 12, maxShiftPx: 60, density: 0.5, tearRate: 5, jitterPx: 1, tearHeight: 0.28, tearSpeed: 1.2, dropout: 0.05, wobbleAmp: 0, wobbleFreq: 10, wobbleSpeed: 2, corrupt: 0.08, posterize: 0, pixelate: 0, scanlineDepth: 0.08, grain: 0.05, glow: 0.05, burstRate: 7, burstThreshold: 0.4, tint: "#ffffff" },
  },
];

export const glitchPlugin = {
  type: "demo_glitch",
  title: "Digital Glitch",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    // 16:9, a screen/monitor aspect.
    type: "demo_glitch", x: 140, y: 140, w: 520, h: 300, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint bright hairline framing the screen (optional; strokeWidth 0 = none).
    stroke: "rgba(120,240,255,0.30)", strokeWidth: 1,
    // `animated` keeps the presenter repainting so the glitch runs; opacity:1.
    ...defaults("animated", "opacity"),
    ...CUSTOM.defaults, // the glitch.* look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "animated", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  presets: PRESETS,
  /**
   * Near-pure function (reads the AMBIENT particle clock; pure w.r.t. document
   * state). State → display-list: ONE materialBackdrop op naming the "glitch"
   * material. The bbox (w, h) IS the screen region (local space; sceneIR wraps it in
   * the node's world). uTime comes from particleTime() — frozen in the editor/CLI, the
   * wall clock in the presenter. The `splitMode` select string maps to the shader's
   * numeric code; everything else passes through and the SkSL packer clamps/parses it.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "glitch",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      params: {
        time: particleTime(),
        seed: s.seed,
        intensity: s.intensity,
        rgbSplitPx: s.rgbSplitPx,
        splitMode: SPLIT_CODE[s.splitMode] ?? 0,
        blockCount: s.blockCount,
        maxShiftPx: s.maxShiftPx,
        density: s.density,
        tearRate: s.tearRate,
        jitterPx: s.jitterPx,
        tearHeight: s.tearHeight,
        tearSpeed: s.tearSpeed,
        dropout: s.dropout,
        wobbleAmp: s.wobbleAmp,
        wobbleFreq: s.wobbleFreq,
        wobbleSpeed: s.wobbleSpeed,
        corrupt: s.corrupt,
        posterize: s.posterize,
        pixelate: s.pixelate,
        scanlineDepth: s.scanlineDepth,
        grain: s.grain,
        glow: s.glow,
        burstRate: s.burstRate,
        burstThreshold: s.burstThreshold,
        tint: s.tint,
      },
      stroke: strokeW > 0 ? s.stroke : null,
      strokeWidth: strokeW,
      opacity: s.opacity ?? 1,
    })];
  },
  hitTest(s, lx, ly) {
    return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
  },
  snapFeatures(s) {
    return [{ kind: "point", x: s.w / 2, y: s.h / 2, id: "center" }];
  },
  anchors: standardBBoxAnchors,
  // NO top-level `commands`: reached ONLY via the "Add Demo Widget" submenu.
};
