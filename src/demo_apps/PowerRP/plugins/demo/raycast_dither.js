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

import { standardBBoxAnchors } from "../../core/derive.js";
import { UNIT_SPAN_SCRUB, bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialFill } from "../../render_gpu/ir.js";
import { particleTime } from "../../render_gpu/particle_clock.js";

// The classic top-left → bottom-right diagonal the raycast hero streaks run along.
const STREAK_DIAGONAL = Math.PI / 4;

// The look knobs, all self.* custom properties. Dimensionless field knobs (speed,
// zoom, angle, elongation, softness, warp) are resolution-independent — the pattern
// is normalized to the widget's own extent — so the look holds at any zoom/size;
// grainScale/cornerRadius are WORLD px (the backend scales to device). The default
// red-on-black palette was sampled from the live raycast.com hero.
const CUSTOM = customProps([
  // SCRUB: the unit-nominal RATE multiplier — 1 = the authored drift, 0 = frozen.
  // `default: 1.0` is written fractional, but JS stores the integer 1, so nothing in
  // the row proves it fractional and it fell back to 1 unit/px: one drag-pixel DOUBLED
  // the speed and 1.5x was unreachable. This is the SAME knob, verbatim, as
  // plugins/demo/rainy_window.js `speed` and plugins/demo/sky.js skyClouds `speed`; all
  // three take the one shared constant so the three copies cannot drift apart.
  { name: "speed", kind: "number", default: 1.0, min: 0, scrub: UNIT_SPAN_SCRUB, help: "Animation speed multiplier for the drifting streaks. 0 = a frozen still; higher = faster flow." },
  { name: "zoom", kind: "number", default: 0.58, min: 0.05, help: "Pattern zoom: bigger = fewer, larger streaks that fill more of the frame; smaller = more, tighter streaks." },
  { name: "streakAngle", kind: "angle", display: "degrees", default: STREAK_DIAGONAL, help: "Streak direction. 45° is the classic top-left → bottom-right diagonal; 0° = horizontal streaks." },
  { name: "elongation", kind: "number", default: 4.2, min: 1, help: "How far the colour blobs stretch ALONG the streak axis. 1 = round blobs; higher = long diagonal streaks (the Raycast look)." },
  { name: "softness", kind: "number", default: 0.17, min: 0.01, help: "Gaussian blob radius — the softness/overlap of the streaks. Bigger = softer, blurrier, more overlap; smaller = crisper cores." },
  { name: "warp", kind: "number", default: 0.18, min: 0, help: "Domain-warp amount: how much an animated value-noise field wobbles the streak edges, so they read as organic aurora rather than perfect ellipses. 0 = clean edges." },
  { name: "grain", kind: "number", default: 0.09, min: 0, help: "Film-grain / DITHER amount — luminance noise added just before 8-bit output. Doubles as dither: it shatters the banding a very smooth gradient would otherwise show. 0 = smooth (banding visible)." },
  { name: "grainScale", kind: "number", default: 1.0, min: 0.05, help: "Grain cell size in world px. ~1 = a fine per-pixel film grain; larger = chunkier speckle. The grain is world-locked (a texture painted on the widget), so it scales with zoom." },
  { name: "grainSpeed", kind: "number", default: 18.0, min: 0, help: "Grain re-randomize rate in Hz — how fast the grain flickers frame to frame. 0 = a static grain texture." },
  { name: "background", kind: "color", default: "#050608", help: "The base/darkest colour filling the dark gaps between the streaks (a near-black, faintly cool tone on the live hero)." },
  { name: "color0", kind: "color", default: "#ff5e73", help: "Palette spot 1 (a bright pink-red streak core). The colour's ALPHA is the spot's weight — a fully-opaque colour is full strength; drop alpha to fade it, alpha 0 disables the spot." },
  { name: "color1", kind: "color", default: "#eb1f36", help: "Palette spot 2 (crimson). Alpha = spot weight (0 disables)." },
  { name: "color2", kind: "color", default: "#990d1c", help: "Palette spot 3 (deep red). Alpha = spot weight (0 disables)." },
  { name: "color3", kind: "color", default: "#ff4257", help: "Palette spot 4 (vivid red). Alpha = spot weight (0 disables)." },
  { name: "color4", kind: "color", default: "#520814", help: "Palette spot 5 (dark maroon). Alpha = spot weight (0 disables)." },
  { name: "cornerRadius", kind: "number", default: 24, min: 0, help: "Rounded-corner radius of the filled region (world px). 0 = sharp corners." },
]);

export const raycastDitherPlugin = {
  type: "demo_raycast_dither",
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
      params: {
        time: particleTime(),
        speed: s.speed, zoom: s.zoom, streakAngle: s.streakAngle,
        elongation: s.elongation, softness: s.softness, warp: s.warp,
        grain: s.grain, grainScale: s.grainScale, grainSpeed: s.grainSpeed,
        background: s.background,
        color0: s.color0, color1: s.color1, color2: s.color2, color3: s.color3, color4: s.color4,
      },
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
