/**
 * Liquid Glass — the flagship DEMO WIDGET (plugins/demo/, the showcase folder).
 * A macOS-26 "Liquid Glass" panel: a rounded-rect region that REFRACTS, blurs,
 * tints (luminance-adaptively) and specular-lights the content beneath it — the
 * real backdrop-shader effect (NOT a CSS blur), drawn by the first live SkSL
 * RuntimeEffect in the renderer (render_gpu/skia/glass_shader.js via
 * paint_skia.js handleGlassBackdrop).
 *
 * Like the magnifier, it is a BACKDROP SAMPLER (capabilities.backdrop) and a
 * bbox widget (so it gets the standard resize handles). It emits ONE
 * `glassBackdrop` op — it does NOT compose the effects bundle (a backdrop
 * sampler cannot be wrapped in an effectSubtree, whose offscreen re-render would
 * sample an empty surface; the shader supplies its own specular + drop shadow).
 *
 * It declares its material knobs as CUSTOM self.* properties (core/properties.js
 * customProps — the same Blender-style mechanism the Demo Showcase proves): each
 * is an equation-capable widget-state key (edit as a literal, an expression, or
 * a `= …` equation, and reference elsewhere as self.<name>) with ZERO evaluation-
 * engine changes. `tint` is a PAINT row (solid or gradient); `materialize` is a
 * plain keyframable 0..1 appear ramp (v1: NOT wired to the presenter — hand-
 * animate it, or leave it at 1 for the settled glass).
 *
 * Surfaced ONLY through the "Insert Demo Widget" → "Liquid Glass" submenu
 * (web/App.svelte), keeping the core Add menus clean. DOM-free / bare-node-safe
 * at import time (mirrors showcase.js's import set).
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { glassBackdrop } from "../../render_gpu/ir.js";

// The material knobs, all self.* custom properties (design.md Part 3 table). WORLD
// units for lengths (the backend scales to device px by world.scale·zoom·dpr).
const LIGHT_ANGLE_DEFAULT = -Math.PI * 0.62; // direction TO the light: just left of straight-up (top-left), the macOS sheen
const CUSTOM = customProps([
  { name: "blurRadius", kind: "number", default: 8, min: 0, help: "Gaussian blur radius (world px) of the backdrop seen through the glass. Moderate keeps it readable — Liquid Glass is a frost, not an opaque blur." },
  { name: "refractionStrength", kind: "number", default: 14, min: 0, help: "Maximum edge displacement (world px). The defining Liquid Glass trait: surrounding content bends inward at the rim (strong at the border, ~0 in the interior)." },
  { name: "edgeFalloff", kind: "number", default: 22, min: 0, help: "How far inward (world px) the refraction + specular band decays. Larger = a wider bevelled rim." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: LIGHT_ANGLE_DEFAULT, help: "Direction TO the light (screen space; -90° is straight above, 0° is from the right). The lit edge catches the thin bright highlight." },
  { name: "lightIntensity", kind: "number", default: 0.8, min: 0, help: "Strength of the top-light specular (the thin rim hairline + the broad soft sheen)." },
  { name: "tint", kind: "color", default: "rgba(255,255,255,0.14)", paint: true, help: "The glass skin's color CAST (rgb) and STRENGTH (alpha). The neutral is luminance-adaptive — pale over dark content, smoky over light — and this tints it; keep the alpha low for clarity." },
  { name: "saturation", kind: "number", default: 0.92, min: 0, max: 1, help: "How much backdrop color is kept (1 = unchanged, 0 = gray). Slightly below 1 for the subtle frosted desaturation." },
  { name: "cornerRadius", kind: "number", default: 48, min: 0, help: "Rounded-corner radius (world px). Corners are continuous (squircle) curvature; a capsule when this reaches half the shorter side." },
  { name: "materialize", kind: "number", default: 1, min: 0, max: 1, help: "The Spotlight appear ramp: 0 = gone (backdrop merely bulges), 1 = fully settled glass. Keyframe it to animate an appear (v1: not driven by the presenter)." },
  // ── material-character knobs (the values that used to be baked shader
  // constants — now equation-capable self.* props feeding the material) ────────
  { name: "squircle", kind: "number", default: 4, min: 2, help: "Corner curvature exponent: 2 = a plain circular arc, higher = continuous Apple-style squircle corners (4 ≈ macOS). Superellipse Lp-norm." },
  { name: "chromatic", kind: "number", default: 0.08, min: 0, help: "Chromatic aberration at the refracting rim: the R/B channels sample slightly off the G. A TINY value gives a faint colored edge fringe like real glass; large = a rainbow smear." },
  { name: "sheen", kind: "number", default: 0.1, min: 0, help: "Strength of the broad surface sheen (the soft gradient of light across the face). Kept low so the interior stays clear." },
  { name: "specularPower", kind: "number", default: 8, min: 1, help: "Tightness of the edge specular lobe: higher = a thinner, crisper bright hairline on the lit edge." },
  { name: "contactShadow", kind: "number", default: 0.26, min: 0, help: "Darkness of the faint contact shadow on the edge OPPOSITE the light (the glass sitting on the surface)." },
  { name: "caustic", kind: "number", default: 0.12, min: 0, help: "How much SHARP (unblurred) backdrop bleeds into the very rim — the bright refracted streaks. Low to avoid ghosting." },
  { name: "edgeLight", kind: "number", default: 0.14, min: 0, help: "Brightness of the crisp perimeter outline (the glass edge catching light all the way around)." },
  { name: "tintAdaptivity", kind: "number", default: 1, min: 0, max: 1, help: "0 = a fixed frosted tint; 1 = fully luminance-adaptive (pale skin over dark content, smoky over light — the macOS content-adaptive look)." },
  { name: "shadowStrength", kind: "number", default: 0.3, min: 0, help: "Darkness of the soft drop shadow cast beneath the panel (0 = no shadow)." },
  // ── render control: the resolution the below-content is sampled at ───────────
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, help: "RESOLUTION FACTOR the content beneath is re-rendered at for the distortion: 1 = screen (zoom) resolution, 2 = supersample (crisper refraction, slower), 0.5 = half res (faster, softer), higher = sharper still. Any GL-style backdrop effect must pick this trade-off." },
]);

export const glassPlugin = {
  type: "demo_glass",
  title: "Liquid Glass",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "demo_glass", x: 120, y: 160, w: 420, h: 150, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint bright hairline border (the glass edge catch-light). The shader
    // already draws a subtle perimeter outline; this optional stroke reinforces
    // the shape on busy backdrops. strokeWidth 0 ⇒ shader-only edge.
    stroke: "rgba(255,255,255,0.35)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the glass.* material knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the material knobs (Inspector "Custom" region)
  ],
  /**
   * Pure function. State → display-list: ONE glassBackdrop op. The bbox (w, h)
   * IS the glass region — cx/cy/halfW/halfH are the local box, emitted in local
   * space (sceneIR wraps them in the node's world). The material knobs pass
   * straight through to the op (which validates + clamps).
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [glassBackdrop({
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      refractionStrength: s.refractionStrength,
      edgeFalloff: s.edgeFalloff,
      lightAngle: s.lightAngle,
      lightIntensity: s.lightIntensity,
      tint: s.tint,
      saturation: s.saturation,
      materialize: s.materialize,
      squircle: s.squircle,
      chromatic: s.chromatic,
      sheen: s.sheen,
      specularPower: s.specularPower,
      contactShadow: s.contactShadow,
      caustic: s.caustic,
      edgeLight: s.edgeLight,
      tintAdaptivity: s.tintAdaptivity,
      shadowStrength: s.shadowStrength,
      backdropScale: s.backdropScale,
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
