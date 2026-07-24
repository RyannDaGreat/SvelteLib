/**
 * CRT — a DEMO WIDGET (plugins/demo/, the showcase folder) and the FIRST
 * material on the reusable MATERIAL FRAMEWORK. A rounded-rect region rendered as
 * a cathode-ray-tube screen over the content beneath it: barrel/tube curvature,
 * an aperture-grille phosphor RGB mask, scanlines, chromatic (beam-convergence)
 * fringing, a corner vignette, a phosphor halation glow, and a black tube face.
 *
 * Like Liquid Glass, it is a BACKDROP SAMPLER (capabilities.backdrop) and a bbox
 * widget (standard resize handles). It emits ONE `materialBackdrop` op naming the
 * "crt" material (render_gpu/skia/materials.js → crt_shader.js); it does NOT
 * compose the effects bundle (a backdrop sampler cannot be wrapped in an
 * effectSubtree, whose offscreen re-render would sample an empty surface).
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps —
 * the Blender-style mechanism): each is an equation-capable widget-state key
 * (edit as a literal, expression, or `= …` equation, and reference elsewhere as
 * self.<name>) with ZERO evaluation-engine changes — the material framework
 * carries the params straight to the SkSL uniforms.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte),
 * keeping the core Add menus clean. DOM-free / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// The CRT look knobs, all self.* custom properties. Dimensionless knobs (counts,
// fractions, gains) are resolution-independent — expressed relative to the screen
// — so the look holds at any zoom/size; cornerRadius/blurRadius are WORLD px (the
// backend scales to device by world.scale·zoom·dpr).
const CUSTOM = customProps([
  { name: "curvature", kind: "number", default: 0.18, min: 0, help: "Tube/barrel curvature: 0 = a flat panel, higher = a fatter CRT bulge. The image compresses at the center and stretches to the edges." },
  { name: "scanlineCount", kind: "number", default: 180, min: 0, help: "Number of horizontal scanlines across the screen height. Higher = finer lines (a sharper tube); lower = chunky retro lines." },
  { name: "scanlineDepth", kind: "number", default: 0.4, min: 0, max: 1, help: "How dark the gaps between scanlines are, from 0 (no lines) to 1 (black gaps). The signature CRT texture." },
  { name: "apertureCount", kind: "number", default: 120, min: 0, help: "Number of RGB phosphor triads across the screen width — the vertical coloured stripes (aperture grille). Higher = finer phosphor." },
  { name: "maskStrength", kind: "number", default: 0.35, min: 0, max: 1, help: "Strength of the phosphor RGB mask, from 0 (off) to 1 (full colour separation). The coloured sub-pixel structure of the tube." },
  { name: "chromatic", kind: "number", default: 0.02, min: 0, help: "Chromatic aberration: how far the red/blue channels split radially at the screen edge, as a fraction of the half-size (beam convergence error). Tiny is realistic." },
  { name: "vignette", kind: "number", default: 0.4, min: 0, max: 1, help: "Corner darkening, from 0 (even) to 1 (heavy). The falloff of light toward the edges of the curved tube." },
  { name: "glow", kind: "number", default: 0.28, min: 0, help: "Phosphor halation: how much of a blurred copy of the content is added back as a soft bloom (a bright beam bleeds into its neighbours)." },
  { name: "brightness", kind: "number", default: 1.3, min: 0, help: "Overall beam gain. A CRT runs its beam hot; this also compensates the dimming from the phosphor mask and scanlines." },
  { name: "bezel", kind: "number", default: 0.05, min: 0, max: 0.5, help: "Width of the black inner tube border around the lit screen, as a fraction of the half-size. The dark frame between the glass edge and the picture." },
  // ── geometry / render controls (world units + the sample resolution) ─────────
  { name: "cornerRadius", kind: "number", default: 44, min: 0, help: "Rounded-corner radius of the tube face (world px). Old CRTs have generously rounded corners." },
  { name: "blurRadius", kind: "number", default: 6, min: 0, help: "Gaussian blur radius (world px) of the halation glow source — how soft the phosphor bloom is." },
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, help: "RESOLUTION FACTOR the content beneath is re-rendered at for the distortion: 1 = screen resolution, 2 = supersample (crisper, slower), 0.5 = half res (faster, softer)." },
]);

export const crtPlugin = {
  type: "demo_crt",
  title: "CRT",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
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
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  /**
   * Pure function. State → display-list: ONE materialBackdrop op naming the "crt"
   * material. The bbox (w, h) IS the screen region (local space; sceneIR wraps it
   * in the node's world). The look knobs pass through as the op's `params`; the
   * op validates + clamps geometry and the SkSL packer clamps the uniforms.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "crt",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      params: {
        curvature: s.curvature,
        scanlineCount: s.scanlineCount,
        scanlineDepth: s.scanlineDepth,
        apertureCount: s.apertureCount,
        maskStrength: s.maskStrength,
        chromatic: s.chromatic,
        vignette: s.vignette,
        glow: s.glow,
        brightness: s.brightness,
        bezel: s.bezel,
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
  // NO top-level `commands`: reached ONLY via the "Insert Demo Widget" submenu.
};
