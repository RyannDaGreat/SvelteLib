/**
 * Frosted Glass — a DEMO WIDGET (plugins/demo/, the showcase folder) and a
 * BACKDROP material on the reusable MATERIAL FRAMEWORK. A rounded-rect panel that
 * BLURS the content behind it and veils it with a subtle translucent frost tint —
 * a plain iOS/macOS "frosted material" card.
 *
 * It is deliberately the BASIC cousin of Liquid Glass (plugins/demo/glass.js):
 * same backdrop-blur groundwork, but NONE of the liquid-glass character — no
 * refraction / edge distortion, no specular / sheen, no chromatic aberration,
 * no luminance-adaptive tint. Just clean backdrop blur + frost.
 *
 * Like CRT and Liquid Glass it is a BACKDROP SAMPLER (capabilities.backdrop) and
 * a bbox widget (standard resize handles). It emits ONE `materialBackdrop` op
 * naming the "frosted" material (render_gpu/skia/materials.js -> frosted_shader.js);
 * it does NOT compose the effects bundle (a backdrop sampler cannot be wrapped in
 * an effectSubtree, whose offscreen re-render would sample an empty surface).
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps —
 * the Blender-style mechanism): each is an equation-capable widget-state key (edit
 * as a literal, an expression, or a `= …` equation, and reference elsewhere as
 * self.<name>) with ZERO evaluation-engine changes — the material framework
 * carries the params straight to the SkSL uniforms. The bright hairline BORDER is
 * the op's stroke/strokeWidth (drawn by the shared material border helper), same
 * as CRT / glass — not a self.* knob.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte), keeping
 * the core Add menus clean. DOM-free / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// The frosted look knobs, all self.* custom properties. `blurRadius` / `cornerRadius`
// are WORLD px (the backend scales to device by world.scale·zoom·dpr); `frost` is a
// resolution-independent 0..1 opacity; `tint` is a plain solid colour.
const CUSTOM = customProps([
  { name: "blurRadius", kind: "number", default: 12, min: 0, help: "Gaussian blur radius (world px) of the content seen through the panel — the defining frosted-glass blur. Higher = a softer, more obscured backdrop." },
  { name: "frost", kind: "number", default: 0.2, min: 0, max: 1, help: "Frost/tint opacity, from 0 (a clear blur, no veil) to 1 (a solid tinted panel). A subtle value (~0.2) gives the milky frosted-material look while the backdrop still reads through." },
  { name: "tint", kind: "color", default: "rgb(255,255,255)", help: "The frost tint COLOUR. White is the classic frosted material; a faint hue tints the frost. Its strength is the Frost knob (this colour's own alpha is ignored)." },
  { name: "cornerRadius", kind: "number", default: 32, min: 0, help: "Rounded-corner radius of the panel (world px). A capsule when it reaches half the shorter side." },
]);

export const frostedGlassPlugin = {
  type: "demo_frosted_glass",
  title: "Frosted Glass",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "demo_frosted_glass", x: 130, y: 150, w: 420, h: 280, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint bright hairline border (the frosted panel's edge). strokeWidth 0 = none.
    stroke: "rgba(255,255,255,0.35)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the frosted.* look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Border color" },
      strokeWidth: { label: "Border width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  /**
   * Pure function. State -> display-list: ONE materialBackdrop op naming the
   * "frosted" material. The bbox (w, h) IS the panel region (local space; sceneIR
   * wraps it in the node's world). The look knobs pass through as the op's
   * `params`; the op validates + clamps geometry and the SkSL packer clamps/parses
   * the uniforms.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "frosted",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      params: {
        frost: s.frost,
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
  // NO top-level `commands`: reached ONLY via the "Insert Demo Widget" submenu.
};
