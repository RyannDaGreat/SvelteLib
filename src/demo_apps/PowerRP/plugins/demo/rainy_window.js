/**
 * RAINY WINDOW — a DEMO WIDGET (plugins/demo/, the showcase folder) and a BACKDROP
 * material on the reusable MATERIAL FRAMEWORK. A rounded-rect pane of rain-streaked,
 * fogged GLASS drawn over the content beneath it: static beads, running drops that
 * slide down and carve wobbling TRAILS, a steamy fog layer the drops clear, and
 * per-droplet refraction + specular of the background.
 *
 * Like CRT / Liquid Glass, it is a BACKDROP SAMPLER (capabilities.backdrop) and a
 * bbox widget (standard resize handles). It emits ONE `materialBackdrop` op naming
 * the "rainy_window" material (render_gpu/skia/materials.js → rainy_window_shader.js);
 * it does NOT compose the effects bundle (a backdrop sampler cannot be wrapped in an
 * effectSubtree, whose offscreen re-render would sample an empty surface).
 *
 * ANIMATION / DETERMINISM: the `animated` shared-state property (default true) makes
 * the presenter repaint every frame while the widget is visible; emit() reads the
 * ambient clock particleTime() (render_gpu/particle_clock.js) for uTime — a frozen
 * constant in the editor/CLI (a deterministic still: same doc ⇒ byte-identical
 * pixels) and the wall clock in the presenter (the rain runs). The shader is a pure
 * function of (pixel, uTime, knobs) — no Date.now / no Math.random.
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps — the
 * Blender-style mechanism): each is an equation-capable widget-state key (a literal,
 * an expression, or a `= …` equation, referenceable as self.<name>) with ZERO
 * evaluation-engine changes — the material framework carries the params straight to
 * the SkSL uniforms (so e.g. `rain = = 0.5 + 0.5·sin(self.scale)` is free).
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialBackdrop } from "../../render_gpu/ir.js";
import { RAINY_WINDOW_FILL_PARAMS, rainyWindowUniformParams } from "../../render_gpu/skia/rainy_window_shader.js";

// The rain look knobs LIVE IN THE SHADER ENTRY now (rainy_window_shader.
// RAINY_WINDOW_FILL_PARAMS — the fill-material framework's single-declaration rule:
// "custom properties become material properties"). This widget spreads that SAME
// schema into its customProps and adds only its widget-side geometry knob
// (cornerRadius). All the look knobs are self.* custom properties: dimensionless
// field knobs (speed, rain, fog, refraction, shine, dropSize, columns) are
// resolution-independent — the rain field is normalized to the widget's own
// extent — so the look holds at any zoom/size; cornerRadius/blurRadius are WORLD px
// (the backend scales to device).
const CUSTOM = customProps([
  ...RAINY_WINDOW_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 26, min: 0, help: "Rounded-corner radius of the window pane (world px). 0 = sharp corners." },
]);

export const rainyWindowPlugin = {
  type: "demo_rainy_window",
  ephemeral: EPHEMERAL.NONE,
  title: "Rainy Window",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    // A tall-ish landscape pane, like a car/house window.
    type: "demo_rainy_window", x: 140, y: 140, w: 520, h: 360, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint bright hairline around the pane (optional; strokeWidth 0 = none).
    stroke: "rgba(255,255,255,0.18)", strokeWidth: 1,
    // `animated` (manifest ANIMATED WIDGET): keeps the presenter repainting every
    // frame while visible so the rain runs. Default true; turn off for a static
    // still. opacity:1.
    ...defaults("animated", "opacity"),
    ...CUSTOM.defaults, // the look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "animated", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  /**
   * Near-pure function (reads the AMBIENT particle clock via the shared mapping;
   * pure w.r.t. document state). State → display-list: ONE materialBackdrop op
   * naming the "rainy_window" material. The bbox (w, h) IS the pane region (local
   * space; sceneIR wraps it in the node's world). The SAME schema→uniform mapping
   * the fill-material path uses (rainyWindowUniformParams — one declaration) builds
   * the op's `params`, including uTime from particleTime() (the freeze constant in
   * the editor/CLI ⇒ a deterministic still, the wall clock in the presenter). The
   * SkSL packer clamps/parses the result.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "rainy_window",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      params: rainyWindowUniformParams(s),
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
