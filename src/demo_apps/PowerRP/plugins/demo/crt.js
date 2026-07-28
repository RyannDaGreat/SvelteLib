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
 * (signal / scanlines / mask / glow / geometry / color / distress / render) that
 * render as their own accordions after the shared ones.
 *
 * TWO knobs are DOCUMENTED INERT (see the shader header): `persistence` (phosphor
 * decay — needs a previous-frame texture) and `flicker` (needs a time uniform).
 * A still-frame render has neither, so they are exposed for completeness but NOT
 * passed into `params` — they do nothing here, honestly, rather than being faked.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-
 * free / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { CRT_FILL_PARAMS, crtUniformParams } from "../../render_gpu/skia/crt_shader.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (crt_shader.CRT_FILL_PARAMS — the
// fill-material framework's single-declaration rule: "custom properties become
// material properties", comic.js is the exemplar). This widget spreads that SAME
// schema (grouped by Inspector category: signal/scanlines/mask/glow/geometry/
// color/distress/render) into its customProps and adds ONLY its widget-side
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
 * The PRESETS: `{name, description, props}` — each `props` is a flat map of the
 * self.* look knobs above, applied to the current frame in one undo unit by the
 * Presets pane (web/ToolsPane.svelte → app.applyPreset). Each is keyed to a
 * REAL display, with numbers following the physics: sourceTVL rises with the
 * display's true horizontal resolution (composite ~240 … BVM ~1000), consumer
 * tubes use shadow/slot masks with heavier curvature + halation, pro RGB monitors
 * use a fine aperture grille, flatter glass, tighter convergence, and phosphor
 * terminals go monochrome with maskType "none".
 */
const PRESETS = [
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
      flicker: 0, persistence: 0, backdropScale: 1,
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
      flicker: 0, persistence: 0, backdropScale: 1,
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
      flicker: 0, persistence: 0, backdropScale: 1,
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
      flicker: 0, persistence: 0, backdropScale: 1,
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
      flicker: 0, persistence: 0, backdropScale: 1,
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
      flicker: 0, persistence: 0, backdropScale: 1,
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
      flicker: 0, persistence: 0, backdropScale: 1,
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
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
];

export const crtPlugin = {
  type: "demo_crt",
  title: "CRT",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  presets: PRESETS,
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
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the grouped look knobs (signal/scanlines/mask/glow/geometry/color/distress/render)
  ],
  /**
   * Pure function. State → display-list: ONE materialBackdrop op naming the "crt"
   * material. The bbox (w, h) IS the screen region (local space; sceneIR wraps it
   * in the node's world). The look knobs pass through the SAME schema→uniform
   * mapping the fill-material path uses (crtUniformParams — one declaration): it
   * maps the maskType SELECT to its numeric shader code and drops the documented-
   * inert temporal knobs (flicker, persistence) plus the non-uniform blurRadius /
   * backdropScale. cornerRadius / blurRadius / backdropScale are top-level op
   * fields (consumed by handleMaterialBackdrop for geometry, glow sigma, sample
   * res), not shader uniforms.
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
