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
 * material framework carries the params straight to the SkSL uniforms.
 *
 * THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (glitch_shader.GLITCH_FILL_PARAMS —
 * the fill-material framework's single-declaration rule: "custom properties become
 * material properties"). This widget spreads that SAME schema into its customProps
 * and adds only its widget-side geometry knob (cornerRadius). `splitMode` is a
 * `select` stored as a STRING; glitchUniformParams maps it to the shader's numeric
 * code and injects the ambient `time` — the SAME mapping the fill-material path uses.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free
 * / bare-node-safe at import time.
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { GLITCH_FILL_PARAMS, glitchUniformParams } from "../../render_gpu/skia/glitch_shader.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// The glitch look knobs live in the shader entry (GLITCH_FILL_PARAMS) so the widget
// AND the fill-material paint UI derive from one declaration. This widget spreads
// that schema into its customProps and adds only the widget-side geometry knob.
const CUSTOM = customProps([
  ...GLITCH_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 8, min: 0, help: "Rounded-corner radius of the glitch region (world px). 0 = sharp corners (a full screen)." },
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
  {
    name: "VHS Tracking",
    description: "The picture rolling out of tracking on a worn tape deck: strong analog wobble low down the frame, a slow rolling tear where the head switch shows, and heavy scanlines — closer to a mistracking VCR than VHS Glitch's steadier warm transfer.",
    props: { intensity: 0.9, rgbSplitPx: 2, splitMode: "horizontal", blockCount: 10, maxShiftPx: 4, density: 0.15, tearRate: 3, jitterPx: 5, tearHeight: 0.09, tearSpeed: 0.25, dropout: 0.02, wobbleAmp: 9, wobbleFreq: 8, wobbleSpeed: 3, corrupt: 0.01, posterize: 0, pixelate: 0, scanlineDepth: 0.45, grain: 0.14, glow: 0.08, burstRate: 2, burstThreshold: 0.6, tint: "#f0ead6" },
  },
  {
    name: "RGB Split",
    description: "The chromatic-aberration extreme, isolated: the widest colour-channel separation in the set at full intensity, with almost none of the other failure modes running — a pure red/blue fringe rather than a busy composite of effects.",
    props: { intensity: 1.0, rgbSplitPx: 9, splitMode: "horizontal", blockCount: 6, maxShiftPx: 0, density: 0, tearRate: 1, jitterPx: 0, tearHeight: 0.01, tearSpeed: 0.1, dropout: 0, wobbleAmp: 0, wobbleFreq: 10, wobbleSpeed: 1, corrupt: 0, posterize: 0, pixelate: 0, scanlineDepth: 0, grain: 0.02, glow: 0, burstRate: 1, burstThreshold: 0.9, tint: "#ffffff" },
  },
  {
    name: "Sync Loss",
    description: "The picture tearing loose from its own sync pulse: a huge slab-height tear rolling fast and continuously (no burst gating — burstThreshold near 0 keeps it running), the whole frame shuddering rather than intermittently glitching.",
    props: { intensity: 1.0, rgbSplitPx: 3, splitMode: "horizontal", blockCount: 8, maxShiftPx: 20, density: 0.4, tearRate: 4, jitterPx: 4, tearHeight: 0.45, tearSpeed: 2.2, dropout: 0.04, wobbleAmp: 6, wobbleFreq: 6, wobbleSpeed: 8, corrupt: 0.02, posterize: 0, pixelate: 0, scanlineDepth: 0.2, grain: 0.08, glow: 0.05, burstRate: 3, burstThreshold: 0.05, tint: "#ffffff" },
  },
  {
    name: "Compression Artifacts",
    description: "Blocky macroblock breakdown from an over-compressed stream: heavy pixelation, coarse posterized colour steps and a fine grid-aligned block glitch, but no tearing or wobble — a codec falling apart, not a cable coming loose.",
    props: { intensity: 0.85, rgbSplitPx: 1, splitMode: "horizontal", blockCount: 24, maxShiftPx: 5, density: 0.35, tearRate: 6, jitterPx: 0, tearHeight: 0.02, tearSpeed: 0.1, dropout: 0.02, wobbleAmp: 0, wobbleFreq: 10, wobbleSpeed: 1, corrupt: 0.05, posterize: 5, pixelate: 24, scanlineDepth: 0, grain: 0.03, glow: 0, burstRate: 4, burstThreshold: 0.7, tint: "#ffffff" },
  },
  {
    name: "Dead Pixel Rain",
    description: "A near-dead panel: maximum dropout and channel corruption spraying blank and swapped-colour blocks continuously across a mostly-static frame, with the split/tear/wobble knobs left at zero so the failure reads as pixels, not motion.",
    props: { intensity: 1.0, rgbSplitPx: 0, splitMode: "horizontal", blockCount: 40, maxShiftPx: 0, density: 0.85, tearRate: 16, jitterPx: 0, tearHeight: 0.01, tearSpeed: 0, dropout: 0.55, wobbleAmp: 0, wobbleFreq: 10, wobbleSpeed: 1, corrupt: 0.5, posterize: 0, pixelate: 0, scanlineDepth: 0, grain: 0.3, glow: 0, burstRate: 12, burstThreshold: 0.1, tint: "#ffffff" },
  },
  {
    name: "Interlace Ghosting",
    description: "A dense fine-pitch scanline structure with a soft glow bleeding between the lines — an interlaced CRT field mismatch, thin and textural rather than a violent corruption event.",
    props: { intensity: 0.6, rgbSplitPx: 1.2, splitMode: "horizontal", blockCount: 60, maxShiftPx: 1, density: 0.05, tearRate: 2, jitterPx: 0.3, tearHeight: 0.02, tearSpeed: 0.15, dropout: 0.01, wobbleAmp: 1, wobbleFreq: 60, wobbleSpeed: 2, corrupt: 0, posterize: 0, pixelate: 0, scanlineDepth: 0.6, grain: 0.05, glow: 0.35, burstRate: 1, burstThreshold: 0.85, tint: "#d9e8ff" },
  },
];

export const glitchPlugin = {
  type: "demo_glitch",
  ephemeral: EPHEMERAL.NONE,
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
    ...bundle("transform"),
    ...props("stroke", "strokeWidth", "animated", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  presets: PRESETS,
  /**
   * Near-pure function (glitchUniformParams reads the AMBIENT particle clock; pure
   * w.r.t. document state). State → display-list: ONE materialBackdrop op naming the
   * "glitch" material. The bbox (w, h) IS the screen region (local space; sceneIR
   * wraps it in the node's world). The SAME schema→uniform mapping the fill-material
   * path uses (one declaration): glitchUniformParams maps the `splitMode` select
   * string to the shader's numeric code and injects `time` from particleTime() —
   * frozen in the editor/CLI, the wall clock in the presenter.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "glitch",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      params: glitchUniformParams(s),
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
