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

// RAINY WINDOW PRESETS (R7-39 presets law, this widget is the material's
// declared AUTHORITY — render_gpu/skia/material_presets.js WIDGET_PRESET_SOURCES
// — so this table fixes BOTH the widget's own Tools-pane cards and the
// "rainy_window" entry of every fill's material-paint dropdown, in one edit).
// Ten named WEATHER × GLASS pairings, each a coherent point in the knob space
// rather than an arbitrary dial spin: how much water is on the pane (rain),
// how steamed it is (fog), how fast it runs (speed/streakiness), how big the
// drops are (dropSize/columns), how much they bend the view (refraction/shine),
// where the key light sits (lightAngle), what tints the steam (tint), and how
// soft the fog source is (blurRadius). `backdropScale` is a PERFORMANCE knob,
// not a look one (its own row says so), so every preset leaves it at the
// widget's default (1) rather than pretending it is part of the weather.
//
// EVERY ROW SETS EVERY LOOK KNOB — application is an OVERLAY (app.applyPreset),
// so a key a preset omits keeps whatever the previously HOVERED preset left
// there; the family below writes rain/fog/speed/dropSize/columns/streakiness/
// refraction/shine/lightAngle/tint/blurRadius/cornerRadius on every row (NOT
// backdropScale — see above), matching tests/material_authority_presets_test.js's
// discipline check.
//
// lightAngle IS STORED IN RADIANS: its row declares display:"degrees", and that
// flag means the DIAL shows degrees while the DOCUMENT holds radians
// (core/properties.angleStorageUnit, pinned by tests/angle_units_test.js), so
// rainyWindowUniformParams passes it straight through. Each value below is
// therefore literal radians with its degree reading in a `/* -75° */` comment —
// a convention this table STARTED and raycast_dither's streakAngle rows copied
// (they cite this one). NOT god_rays or sky: god_rays declares no angle row at
// all, and sky's presets deliberately EXCLUDE lightAngle (sky.js states why), so
// neither family has an angle row to have set a precedent with.
const PRESETS = [
  {
    name: "Drizzle on a Car Window",
    description: "A light shower caught through a car's side glass at speed: a fine scatter of static beads, a handful of quick-running streaks, and just enough forward blur that the world outside still reads through the drops.",
    props: { rain: 0.35, fog: 0.1, speed: 1.6, dropSize: 0.8, columns: 8, streakiness: 0.7, refraction: 0.07, shine: 0.85, lightAngle: -1.309 /* -75° */, tint: "#dfe8f0", blurRadius: 3, cornerRadius: 18 },
  },
  {
    name: "Storm Sheet",
    description: "A downpour hammering the glass hard enough that it stops being transparent and starts being a moving sheet: maximum rain load, big fast columns, long trails, and a hard glassy glint off every drop as if headlights were sweeping past.",
    props: { rain: 1, fog: 0.15, speed: 2.4, dropSize: 1.3, columns: 10, streakiness: 1.6, refraction: 0.12, shine: 1.3, lightAngle: -1.0472 /* -60° */, tint: "#c9d6e6", blurRadius: 2, cornerRadius: 10 },
  },
  {
    name: "Condensation",
    description: "A cold glass of water on a warm day, not a raincloud in sight: no running rain at all, just a field of small static beads sweating out of thin air, dim and matte because the surface tension makes each bead a poor lens.",
    props: { rain: 0.55, fog: 0.02, speed: 0, dropSize: 0.55, columns: 14, streakiness: 0, refraction: 0.03, shine: 0.35, lightAngle: -1.5708 /* -90° */, tint: "#eef6fb", blurRadius: 1, cornerRadius: 30 },
  },
  {
    name: "Morning Mist",
    description: "First light through a fully steamed-up bathroom pane: the highest fog in the set and a wide soft blur on it, one or two drops just starting to bead where the steam has begun to give way, everything read through milk.",
    props: { rain: 0.12, fog: 0.9, speed: 0.3, dropSize: 0.7, columns: 5, streakiness: 0.2, refraction: 0.02, shine: 0.2, lightAngle: -0.7854 /* -45° */, tint: "#fdf3e6", blurRadius: 16, cornerRadius: 22 },
  },
  {
    name: "Tropical Downpour",
    description: "A sudden monsoon burst on a greenhouse skylight: heavy warm rain running in wide, fast, densely packed columns with a bright wet shine, the fog burned off by the humidity rather than clinging to the glass.",
    props: { rain: 0.9, fog: 0.05, speed: 2, dropSize: 1.1, columns: 12, streakiness: 1.2, refraction: 0.1, shine: 1.1, lightAngle: -0.5236 /* -30° */, tint: "#eaf2e6", blurRadius: 2, cornerRadius: 6 },
  },
  {
    name: "Freezing Sleet",
    description: "Half-frozen rain that can't decide whether to run: small stiff drops, glacially slow columns, almost no trail behind each one, and a hard cold specular that reads more like ice than water.",
    props: { rain: 0.4, fog: 0.08, speed: 0.35, dropSize: 0.5, columns: 9, streakiness: 0.15, refraction: 0.04, shine: 1.4, lightAngle: -1.9199 /* -110° */, tint: "#eef4fb", blurRadius: 2, cornerRadius: 8 },
  },
  {
    name: "Night Neon Rain",
    description: "A city window at night with a sign glowing somewhere off to the side: fast, glossy, high-refraction drops built to catch and bend coloured light rather than daylight, the fog kept low so the neon stays legible through the glass.",
    props: { rain: 0.7, fog: 0.04, speed: 1.8, dropSize: 1, columns: 9, streakiness: 1.3, refraction: 0.16, shine: 1.5, lightAngle: -0.3491 /* -20° */, tint: "#dfe8f0", blurRadius: 2, cornerRadius: 14 },
  },
  {
    name: "Shower Door",
    description: "A frosted glass shower mid-use: thick static condensation packed almost edge to edge, one or two rivulets breaking free and running, and a soft wide blur standing in for the pane's own obscured texture.",
    props: { rain: 0.85, fog: 0.6, speed: 0.5, dropSize: 0.9, columns: 6, streakiness: 0.4, refraction: 0.05, shine: 0.5, lightAngle: -1.5708 /* -90° */, tint: "#f4f9fc", blurRadius: 10, cornerRadius: 24 },
  },
  {
    name: "Greenhouse Pane",
    description: "The warm, wet, glass-roofed climate of a working greenhouse: heavy static bead coverage, a lifted fog, and a warm tint from the foliage and grow-light colour bouncing back through the condensation.",
    props: { rain: 0.75, fog: 0.35, speed: 0.2, dropSize: 0.85, columns: 7, streakiness: 0.1, refraction: 0.04, shine: 0.4, lightAngle: -0.8727 /* -50° */, tint: "#eef2df", blurRadius: 8, cornerRadius: 4 },
  },
  {
    name: "After the Rain",
    description: "The shower has passed and the glass is drying out: a handful of static leftover beads, no running drops or fog left at all, and a bright clean specular off each one as the sun comes back out.",
    props: { rain: 0.18, fog: 0, speed: 0, dropSize: 0.7, columns: 5, streakiness: 0, refraction: 0.05, shine: 1.2, lightAngle: -0.5236 /* -30° */, tint: "#fff7e6", blurRadius: 1, cornerRadius: 16 },
  },
];

export const rainyWindowPlugin = {
  type: "demo_rainy_window",
  ephemeral: EPHEMERAL.NONE,
  title: "Rainy Window",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  presets: PRESETS,
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
    ...bundle("transform"),
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
