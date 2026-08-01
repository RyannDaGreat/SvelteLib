/**
 * RAYCAST DITHER — a DEMO WIDGET (plugins/demo/, the showcase folder) and the FIRST
 * GENERATIVE (source) material on the reusable MATERIAL FRAMEWORK. A rounded-rect
 * region filled with the animated, grainy, soft-colour mesh-gradient of the
 * raycast.com hero: diagonal elongated colour STREAKS on a near-black base, with a
 * fine per-pixel GRAIN that doubles as DITHER (so the ultra-smooth gradient never
 * bands). Design + VLM-verified prototype: `.frenzy/raycast_dither/`.
 *
 * Unlike the CRT (a BACKDROP sampler that distorts the content beneath it), this is
 * a FOREGROUND material: it samples NOTHING below it and synthesizes every pixel
 * from uniforms. So it emits ONE `materialFill` op naming the "raycast_dither"
 * material (render_gpu/skia/materials.js → raycast_dither_shader.js), the exact op
 * the corkboard family uses — NO new IR op, NO backdrop re-render.
 *
 * ANIMATION / DETERMINISM: the `animated` shared state property (default true) makes
 * the presenter repaint every frame while the widget is visible; emit() reads the
 * ambient clock particleTime() (render_gpu/particle_clock.js) for uTime — a frozen
 * constant in the editor/CLI (a deterministic still: same doc ⇒ byte-identical
 * pixels) and the wall clock in the presenter (the streaks flow). The shader is a
 * pure function of (pixel, uTime, knobs) — no Date.now / Math.random.
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps — the
 * Blender-style mechanism): a literal, an expression, or a `= …` equation, with ZERO
 * evaluation-engine changes — the material framework carries the params straight to
 * the SkSL uniforms (so e.g. `uSpeed = self.scale·0.5` or a keyframed streakAngle is
 * free). The palette is five colour knobs whose ALPHA channel is the spot's weight
 * (a fully-opaque colour = full-strength spot; alpha 0 disables that spot).
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialFill } from "../../render_gpu/ir.js";
import { RAYCAST_DITHER_FILL_PARAMS, raycastDitherUniformParams } from "../../render_gpu/skia/raycast_dither_shader.js";

// The look knobs, all self.* custom properties. Dimensionless field knobs (speed,
// zoom, angle, elongation, softness, warp) are resolution-independent — the pattern
// is normalized to the widget's own extent — so the look holds at any zoom/size;
// grainScale/cornerRadius are WORLD px (the backend scales to device).
// THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (raycast_dither_shader.
// RAYCAST_DITHER_FILL_PARAMS — the fill-material framework's single-declaration rule:
// "custom properties become material properties"). This widget spreads that SAME
// schema into its customProps and adds only its widget-side geometry knob
// (cornerRadius — a fill's shape IS its geometry).
const CUSTOM = customProps([
  ...RAYCAST_DITHER_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 24, min: 0, help: "Rounded-corner radius of the filled region (world px). 0 = sharp corners." },
]);

export const raycastDitherPlugin = {
  type: "demo_raycast_dither",
  ephemeral: EPHEMERAL.NONE,
  title: "Raycast Dither",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    // A wide landscape card, echoing the raycast hero's aspect.
    type: "demo_raycast_dither", x: 140, y: 140, w: 560, h: 360, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // `animated` (manifest ANIMATED WIDGET): keeps the presenter repainting every
    // frame while the widget is visible so the streaks + grain flow. Default true;
    // turn off for a static still. opacity:1.
    ...defaults("animated", "opacity"),
    ...CUSTOM.defaults, // the look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("animated", "opacity"),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  /**
   * Near-pure function (reads the AMBIENT particle clock; pure w.r.t. document
   * state). State → ONE materialFill op naming the "raycast_dither" material. The
   * bbox (w, h) IS the region (local space; sceneIR wraps it in the node's world).
   * uTime comes from particleTime() — the freeze constant in the editor/CLI (a
   * deterministic still) and the wall clock in the presenter (animated). The look
   * knobs pass through as the op's `params`; the SkSL packer clamps/parses them.
   */
  emit(s) {
    return [materialFill({
      material: "raycast_dither",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      // The SAME schema→uniform mapping the fill-material path uses (one declaration).
      // uTime is injected inside it from particleTime() — frozen in editor/CLI, the
      // wall clock in the presenter.
      params: raycastDitherUniformParams(s),
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
