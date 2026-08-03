/**
 * CRT ("Cathode") — a DEMO WIDGET (plugins/demo/, the showcase folder) on the
 * reusable MATERIAL FRAMEWORK. A rounded-rect region rendered as a realistic
 * cathode-ray-tube screen over the content beneath it, with PHYSICALLY-MOTIVATED
 * knobs and presets keyed to real displays. See render_gpu/skia/crt_shader.js for
 * the full linear-light signal chain; this file is the plugin surface: the knob
 * set, the one `materialBackdrop` op, and the preset table.
 *
 * It is a BACKDROP material (capabilities.backdrop) and a bbox widget (standard
 * resize handles). It emits ONE `materialBackdrop` op naming the "crt" material
 * (render_gpu/skia/materials.js → crt_shader.js); it does NOT compose the effects
 * bundle (a backdrop sampler cannot be wrapped in an effectSubtree, whose
 * offscreen re-render would sample an empty surface).
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps —
 * the Blender-style mechanism): each is an equation-capable widget-state key with
 * ZERO evaluation-engine changes — the material framework carries the params
 * straight to the SkSL uniforms. Knobs are grouped into Inspector categories
 * (signal / scanlines / mask / glow / geometry / color / flicker / distress / render) that
 * render as their own accordions after the shared ones.
 *
 * ── TWO ORTHOGONAL PRESET FAMILIES ───────────────────────────────────────────
 * This widget declares `presetFamilies` (core/registry.presetFamiliesOf), not a
 * flat `presets`, because its knobs fall into two independent axes and a preset
 * should only ever rewrite its own:
 *   TUBE    — what the display IS (signal, scanlines, mask, glow, geometry, colour).
 *   FLICKER — how it MOVES over time (flicker, flickerRate, scanDrift, flickerSeed).
 * The two key sets are DISJOINT, which is what lets you pick a Sony PVM and then
 * independently pick "Tired Tube" without either undoing the other — and it is
 * enforced, not merely intended (tests/tool_groups_test.js proves disjointness over
 * every multi-family plugin, and tests/crt_flicker_test.js proves each family is
 * COMPLETE over its OWN key set, so hovering a card never leaves a stale knob from
 * the previously-hovered one).
 *
 * The flicker family is the ANIMATION class: every one of its presets is
 * RECORDABLE STATE (CLAUDE.md's taxonomy) — a pure function of elapsed time read
 * through the one seamed clock, so Δt = 0 leaves the picture unchanged and an
 * export is reproducible. Its OFF preset ("Rock Steady") is the default state and
 * an EXACT no-op.
 *
 * `persistence` remains DOCUMENTED INERT (see the shader header): phosphor decay
 * needs a previous-frame texture, and such a value is a function of HISTORY rather
 * than of time, so unlike flicker it could not be made recordable even with one.
 * It is exposed for completeness and never faked.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-
 * free / bare-node-safe at import time.
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { CRT_FILL_PARAMS, crtUniformParams } from "../../render_gpu/skia/crt_shader.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (crt_shader.CRT_FILL_PARAMS — the
// fill-material framework's single-declaration rule: "custom properties become
// material properties", comic.js is the exemplar). This widget spreads that SAME
// schema (grouped by Inspector category: signal/scanlines/mask/glow/geometry/
// color/flicker/distress/render) into its customProps and adds ONLY its widget-side
// geometry knob (cornerRadius — a fill's shape IS its geometry). cornerRadius
// carries category "geometry" so it groups back into the geometry accordion after
// bezel, exactly where it was before the split. Dimensionless knobs are
// resolution-independent; maskPitch/cornerRadius/blurRadius are WORLD px (the
// backend scales world→device by world.scale·zoom·dpr).
const CUSTOM = customProps([
  ...CRT_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 44, min: 0, category: "geometry", help: "Rounded-corner radius of the tube face (world px). Old CRTs have generously rounded corners." },
]);

/**
 * THE TUBE FAMILY — `{name, description, props}`, each `props` a flat map of the
 * APPEARANCE knobs, applied to the current frame in one undo unit by the Presets
 * pane (web/ToolsPane.svelte → app.applyPreset). Each is keyed to a REAL display,
 * with numbers following the physics: sourceTVL rises with the display's true
 * horizontal resolution (composite ~240 … BVM ~1000), consumer tubes use
 * shadow/slot masks with heavier curvature + halation, pro RGB monitors use a fine
 * aperture grille, flatter glass, tighter convergence, and phosphor terminals go
 * monochrome with maskType "none".
 *
 * These eight are UNCHANGED in look. They no longer write `flicker` — that key
 * moved to the FLICKER family below, and dropping it here is what makes the two
 * families disjoint. It changes nothing on screen: they all wrote `flicker: 0`,
 * which is the knob's default and an exact no-op, so a tube preset renders exactly
 * the pixels it did before and now simply leaves the motion axis alone.
 */
const TUBE_PRESETS = [
  {
    name: "Composite Consumer TV",
    description: "A late-80s living-room set fed composite/RF: soft (~240 TVL), fat bulge, shadow-mask phosphor, warm-ish white, heavy halation and vignette.",
    props: {
      sourceTVL: 240, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.35, scanlineCount: 240, brightBoost: 1.35, beamBloom: 0.5,
      maskType: "shadow", maskStrength: 0.3, maskPitch: 4,
      halation: 0.18, diffusion: 0.18, blurRadius: 8,
      curvature: 0.12, convergence: 0.03, vignette: 0.42, bezel: 0.06, cornerRadius: 54,
      monochrome: 0, whiteBalance: -0.1, phosphorTint: "#ffffff",
      persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Sony PVM (RGB)",
    description: "A prosumer Trinitron RGB monitor: sharp (~600 TVL), fine aperture grille, crisp visible scanlines, flat glass, near-perfect convergence, neutral-cool white.",
    props: {
      sourceTVL: 600, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.55, scanlineCount: 240, brightBoost: 1.25, beamBloom: 0.35,
      maskType: "aperture", maskStrength: 0.4, maskPitch: 3,
      halation: 0.08, diffusion: 0.08, blurRadius: 5,
      curvature: 0.04, convergence: 0.01, vignette: 0.25, bezel: 0.04, cornerRadius: 34,
      monochrome: 0, whiteBalance: 0.1, phosphorTint: "#ffffff",
      persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Sony BVM",
    description: "The broadcast reference Trinitron: the sharpest tube (~1000 TVL), very fine aperture grille, minimal curvature, immaculate convergence, D65 white.",
    props: {
      sourceTVL: 1000, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.5, scanlineCount: 480, brightBoost: 1.2, beamBloom: 0.3,
      maskType: "aperture", maskStrength: 0.35, maskPitch: 2.5,
      halation: 0.06, diffusion: 0.06, blurRadius: 4,
      curvature: 0.02, convergence: 0.005, vignette: 0.2, bezel: 0.03, cornerRadius: 26,
      monochrome: 0, whiteBalance: 0.15, phosphorTint: "#ffffff",
      persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Arcade 240p",
    description: "A JAMMA arcade tube: 240p, punchy and hot, slot-mask phosphor, strong bloomed scanlines, moderate curvature.",
    props: {
      sourceTVL: 300, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.5, scanlineCount: 240, brightBoost: 1.4, beamBloom: 0.55,
      maskType: "slot", maskStrength: 0.35, maskPitch: 4,
      halation: 0.14, diffusion: 0.12, blurRadius: 6,
      curvature: 0.08, convergence: 0.02, vignette: 0.35, bezel: 0.05, cornerRadius: 40,
      monochrome: 0, whiteBalance: -0.05, phosphorTint: "#ffffff",
      persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "IBM VGA",
    description: "A 90s PC CRT at 640×480: shadow-mask dot pitch, ~560 TVL, near-flat glass, scanlines almost filled in, neutral-cool white.",
    props: {
      sourceTVL: 560, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.2, scanlineCount: 480, brightBoost: 1.2, beamBloom: 0.3,
      maskType: "shadow", maskStrength: 0.35, maskPitch: 3,
      halation: 0.06, diffusion: 0.08, blurRadius: 5,
      curvature: 0.05, convergence: 0.015, vignette: 0.28, bezel: 0.05, cornerRadius: 30,
      monochrome: 0, whiteBalance: 0.1, phosphorTint: "#ffffff",
      persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Green Terminal (P39)",
    description: "A monochrome P39 green-phosphor computer terminal: no colour mask, visible bloomed scanlines, green halation, gentle bulge.",
    props: {
      sourceTVL: 400, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.4, scanlineCount: 300, brightBoost: 1.3, beamBloom: 0.6,
      maskType: "none", maskStrength: 0, maskPitch: 3,
      halation: 0.18, diffusion: 0.16, blurRadius: 7,
      curvature: 0.06, convergence: 0, vignette: 0.35, bezel: 0.05, cornerRadius: 40,
      monochrome: 1, whiteBalance: 0, phosphorTint: "#00ff2b",
      persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Amber Terminal (P3)",
    description: "A monochrome P3 amber-phosphor terminal: the warm-orange counterpart to the green terminal — no colour mask, bloomed scanlines, amber halation.",
    props: {
      sourceTVL: 400, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.4, scanlineCount: 300, brightBoost: 1.3, beamBloom: 0.6,
      maskType: "none", maskStrength: 0, maskPitch: 3,
      halation: 0.18, diffusion: 0.16, blurRadius: 7,
      curvature: 0.06, convergence: 0, vignette: 0.35, bezel: 0.05, cornerRadius: 40,
      monochrome: 1, whiteBalance: 0, phosphorTint: "#ff8c00",
      persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "B&W TV",
    description: "A single-gun black-and-white television: composite-soft (~240 TVL), no phosphor triads, bluish-white P4 tone, fat bulge, heavy halation and vignette.",
    props: {
      sourceTVL: 240, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.4, scanlineCount: 240, brightBoost: 1.35, beamBloom: 0.55,
      maskType: "none", maskStrength: 0, maskPitch: 3,
      halation: 0.16, diffusion: 0.15, blurRadius: 8,
      curvature: 0.12, convergence: 0, vignette: 0.42, bezel: 0.06, cornerRadius: 54,
      monochrome: 1, whiteBalance: 0, phosphorTint: "#dce6ff",
      persistence: 0, backdropScale: 1,
    },
  },
];

/**
 * THE FLICKER FAMILY — the SECOND, ANIMATION-CLASS preset family. Its key set is
 * exactly the four temporal knobs and NOTHING else, so picking one never disturbs
 * the tube you chose; each preset writes ALL FOUR, so picking one never leaves a
 * stale value from the previous pick.
 *
 * These are RECORDABLE STATE: a pure function of elapsed time through the one
 * seamed clock (particleTime), so the editor and CLI show a deterministic freeze,
 * the presenter animates, and an export is reproducible frame by frame.
 *
 * The scale is deliberately RESTRAINED — a CRT that strobes reads as a broken
 * prop, not a tube. "Mains Hum" is the recommended everyday choice at a 3%
 * peak-to-peak swing, which is roughly what a healthy set actually does; "Rock
 * Steady" (the default state) is first because OFF is the honest default; and only
 * "Failing Flyback", explicitly a fault, goes anywhere near conspicuous.
 *
 * flickerSeed varies across the presets on purpose: two CRTs on one slide given
 * the same preset would otherwise pulse in lockstep, which reads as a global
 * brightness animation rather than as two independent tubes.
 */
const FLICKER_PRESETS = [
  {
    name: "Rock Steady",
    description: "No flicker and no drift — a well-adjusted set, or a still. This is the default state and an EXACT no-op: the picture is byte-identical to a CRT with no temporal stage at all, at any moment in the presentation.",
    props: { flicker: 0, flickerRate: 30, scanDrift: 0, flickerSeed: 1337 },
  },
  {
    name: "Barely There",
    description: "A 1% breath at mains rate. You will not consciously see it flicker; you will notice the tube looks alive rather than pasted on. The safe choice under text.",
    props: { flicker: 0.01, flickerRate: 30, scanDrift: 0, flickerSeed: 1337 },
  },
  {
    name: "Mains Hum",
    description: "The everyday recommendation: a 3% ripple at 30Hz, about what a healthy set does off a real supply, plus a tenth of a scanline per second of vertical creep so the raster shimmers instead of sitting frozen.",
    props: { flicker: 0.03, flickerRate: 30, scanDrift: 0.1, flickerSeed: 7331 },
  },
  {
    name: "PAL Set",
    description: "The same gentle 3% ripple beating at 25Hz instead of 30 — a 50Hz-mains tube. Slower and slightly more visible than Mains Hum, and the right pick if the scene is meant to read as European.",
    props: { flicker: 0.03, flickerRate: 25, scanDrift: 0.1, flickerSeed: 4242 },
  },
  {
    name: "Tired Tube",
    description: "An old set with a soft supply: a 7% swing wandering slowly at 6Hz, with a third of a line per second of roll. Clearly moving, still comfortable to look at.",
    props: { flicker: 0.07, flickerRate: 6, scanDrift: 0.35, flickerSeed: 9001 },
  },
  {
    name: "Failing Flyback",
    description: "A FAULT, not a look: an 18% lurch at 2.5Hz with the vertical lock slipping a whole line and a half per second. Use it for a set that is about to die — it is deliberately the loudest preset here and is not recommended behind anything anyone has to read.",
    props: { flicker: 0.18, flickerRate: 2.5, scanDrift: 1.5, flickerSeed: 6626 },
  },
];

export const crtPlugin = {
  type: "demo_crt",
  ephemeral: EPHEMERAL.NONE,
  title: "CRT",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  // TWO ORTHOGONAL FAMILIES over DISJOINT key sets (see the header): what the tube
  // IS, and how it MOVES. Each surfaces as its own labeled Tools-pane group
  // (core/registry.presetFamiliesOf namespaces them presets.tube / presets.flicker).
  presetFamilies: [
    { id: "tube", title: "Tube presets", presets: TUBE_PRESETS },
    { id: "flicker", title: "Flicker presets", presets: FLICKER_PRESETS },
  ],
  defaults: {
    // 4:3, the classic CRT aspect.
    type: "demo_crt", x: 140, y: 140, w: 440, h: 330, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint bright hairline around the tube face (optional; strokeWidth 0 = none).
    stroke: "rgba(255,255,255,0.20)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the crt.* look knobs (self.*)
  },
  inspector: [
    ...bundle("transform"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the grouped look knobs (signal/scanlines/mask/glow/geometry/color/flicker/distress/render)
  ],
  /**
   * QUERY (reads the ambient presentation clock through crtUniformParams; pure
   * w.r.t. `s`). State → display-list: ONE materialBackdrop op naming the "crt"
   * material. The bbox (w, h) IS the screen region (local space; sceneIR wraps it
   * in the node's world). The look knobs pass through the SAME schema→uniform
   * mapping the fill-material path uses (crtUniformParams — one declaration): it
   * maps the maskType SELECT to its numeric shader code, carries the four FLICKER
   * knobs with `time` injected from particleTime() beside them, and drops the
   * documented-inert `persistence` plus the non-uniform blurRadius / backdropScale.
   * cornerRadius / blurRadius / backdropScale are top-level op fields (consumed by
   * handleMaterialBackdrop for geometry, glow sigma, sample res), not shader
   * uniforms.
   *
   * The clock read is what makes this a Query rather than pure, and it is the ONE
   * legal source: frozen in the editor/CLI/thumbnails (so a still is deterministic),
   * live in the presenter, overridden per frame by both exporters. Δt = 0 ⟹ this
   * returns the same op.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "crt",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      // The SAME schema→uniform mapping the fill-material path uses (one declaration).
      params: crtUniformParams(s),
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
