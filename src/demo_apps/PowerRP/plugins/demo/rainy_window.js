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
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialBackdrop } from "../../render_gpu/ir.js";
import { particleTime } from "../../render_gpu/particle_clock.js";

// Direction TO the light: just left of straight-up, so drops catch a top-left glint.
const LIGHT_ANGLE_DEFAULT = -Math.PI * 0.6;

// The rain look knobs, all self.* custom properties. Dimensionless field knobs
// (speed, rain, fog, refraction, shine, dropSize, columns) are resolution-
// independent — the rain field is normalized to the widget's own extent — so the
// look holds at any zoom/size; cornerRadius/blurRadius are WORLD px (the backend
// scales to device).
const CUSTOM = customProps([
  { name: "rain", kind: "number", default: 0.8, min: 0, max: 1, help: "Rain AMOUNT (0..1): how much water is on the glass. Drives drop density/rate — low = a fine mist of static beads, high = heavy running drops with trails." },
  { name: "fog", kind: "number", default: 0.5, min: 0, max: 1, help: "Fog / steam amount (0..1): how steamed-up the dry pane is (a blurred, lifted, desaturated view). Running drops and trails wipe the fog clear." },
  { name: "speed", kind: "number", default: 1.0, min: 0, help: "Fall-speed multiplier for the running drops. 0 = a frozen still; higher = faster running rain." },
  { name: "dropSize", kind: "number", default: 1.0, min: 0.1, help: "Overall drop-size multiplier — scales both the running-drop heads and the static beads." },
  { name: "columns", kind: "number", default: 6, min: 1, help: "Number of running-drop columns across the width — the density granularity. More = finer, more-numerous streaks." },
  { name: "streakiness", kind: "number", default: 1.0, min: 0.1, max: 4, help: "Trail LENGTH / persistence behind each running drop's head: how far up the fading refractive streak survives. Low = drops with barely a tail; high = long, slow-fading dribble streaks." },
  { name: "refraction", kind: "number", default: 0.06, min: 0, help: "Droplet refraction strength, as a fraction of the widget's short half-size: how strongly each drop bends the background behind it (the lens). 0 = flat wet patches." },
  { name: "shine", kind: "number", default: 0.9, min: 0, help: "Droplet SHININESS — the strength of the specular glint + fresnel rim on each drop's curved surface. 0 = matte water." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: LIGHT_ANGLE_DEFAULT, help: "Direction TO the light (screen space; -90° = straight above, 0° = from the right). Sets where the specular glints sit on each drop." },
  { name: "tint", kind: "color", default: "#dfe8f0", help: "The fog/steam colour cast — the tone the steamed-up glass is pulled toward (a cool near-white reads as cold-window condensation)." },
  // ── geometry / render controls (world units + the sample resolution) ─────────
  { name: "cornerRadius", kind: "number", default: 26, min: 0, help: "Rounded-corner radius of the window pane (world px). 0 = sharp corners." },
  { name: "blurRadius", kind: "number", default: 8, min: 0, help: "Gaussian blur radius (world px) of the fog/steam source — how soft the steamed-up glass is." },
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, help: "RESOLUTION FACTOR the content beneath is re-rendered at for the distortion: 1 = screen resolution, 2 = supersample (crisper, slower), 0.5 = half res (faster, softer)." },
]);

export const rainyWindowPlugin = {
  type: "demo_rainy_window",
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
   * Near-pure function (reads the AMBIENT particle clock; pure w.r.t. document
   * state). State → display-list: ONE materialBackdrop op naming the "rainy_window"
   * material. The bbox (w, h) IS the pane region (local space; sceneIR wraps it in
   * the node's world). uTime comes from particleTime() — the freeze constant in the
   * editor/CLI (a deterministic still) and the wall clock in the presenter. The look
   * knobs pass through as the op's `params`; the SkSL packer clamps/parses them.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "rainy_window",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      params: {
        time: particleTime(),
        rain: s.rain, fog: s.fog, speed: s.speed,
        refraction: s.refraction, shine: s.shine, dropSize: s.dropSize,
        columns: s.columns, streakiness: s.streakiness, lightAngle: s.lightAngle, tint: s.tint,
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
