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

// RAYCAST DITHER PRESETS (R7-39 presets law, this widget is the material's
// declared AUTHORITY — render_gpu/skia/material_presets.js WIDGET_PRESET_SOURCES
// — so this table fixes BOTH the widget's Tools-pane cards and the
// "raycast_dither" entry of every fill's material-paint dropdown, in one edit).
// Ten named RETRO-DISPLAY / PRINT idioms rather than colour-swaps of the
// Raycast hero: each reaches for `grain` (dither strength) and `grainScale`
// (dither cell size) as the FIRST knobs, because those two together are what
// turns the smooth animated mesh gradient into a screen-door, halftone,
// duotone-riso or phosphor-scanline texture — `zoom`/`elongation`/`softness`
// then shape the underlying colour field each texture sits on top of, and
// `speed`/`warp`/`grainSpeed` decide how alive the surface looks (a printed
// medium wants them near zero; a CRT or a VHS wants them lively).
//
// EVERY ROW SETS EVERY LOOK KNOB — application is an OVERLAY (app.applyPreset),
// so a key a preset omits keeps whatever the previously HOVERED preset left
// there; the family below writes speed/zoom/streakAngle/elongation/softness/
// warp/grain/grainScale/grainSpeed/background/color0..4/cornerRadius on every
// row, matching tests/material_authority_presets_test.js's discipline check.
//
// streakAngle IS STORED IN RADIANS (display:"degrees" only bridges the dial;
// raycastDitherUniformParams passes it straight through) — each value below is
// literal radians with its degree reading in a comment, the same convention
// rainy_window's lightAngle preset table above uses.
const PRESETS = [
  {
    name: "CRT Scanline",
    description: "A cathode-ray tube up close: horizontal streaks standing in for the scanlines, a coarse loud grain reading as phosphor dither, and a cool blue-green channel triad the way an old monitor's mask splits colour.",
    props: { speed: 0.6, zoom: 0.9, streakAngle: 0 /* 0° */, elongation: 9, softness: 0.08, warp: 0.04, grain: 0.35, grainScale: 1.5, grainSpeed: 24, background: "#04070a", color0: "#00eaff", color1: "#00ffaa", color2: "#0057ff", color3: "#00c2ff", color4: "#003a66", cornerRadius: 4 },
  },
  {
    name: "Newspaper Halftone",
    description: "Black ink dots on newsprint at a 45° screen angle: a large chunky grain standing in for the halftone dot pattern, streaks flattened into round blobs, no colour at all beyond ink and paper, and everything held perfectly still like a printed page.",
    props: { speed: 0, zoom: 0.5, streakAngle: 0.7854 /* 45° */, elongation: 1, softness: 0.05, warp: 0, grain: 0.9, grainScale: 3.5, grainSpeed: 0, background: "#f2ede2", color0: "#151210", color1: "#151210", color2: "#151210", color3: "#00000000", color4: "#00000000", cornerRadius: 0 },
  },
  {
    name: "Risograph",
    description: "A two-pass riso print off-register: soft misaligned magenta and teal ink layers, a grainy paper texture that never settles, and streaks stretched long the way a riso drum smears a gradient into visible bands.",
    props: { speed: 0.2, zoom: 0.7, streakAngle: 0.5236 /* 30° */, elongation: 5, softness: 0.22, warp: 0.12, grain: 0.5, grainScale: 1.2, grainSpeed: 6, background: "#f4efe4", color0: "#ff3399", color1: "#00b5b0", color2: "#ff3399", color3: "#00b5b0", color4: "#f4efe400", cornerRadius: 2 },
  },
  {
    name: "Thermal Receipt",
    description: "A thermal till receipt curling out of the printer: a single dark heat-sensitive tone on pale paper, a fine dense grain for the printer head's dot pitch, streaks squashed nearly round, and nothing moving.",
    props: { speed: 0, zoom: 0.4, streakAngle: 1.5708 /* 90° */, elongation: 1.4, softness: 0.04, warp: 0, grain: 0.8, grainScale: 0.6, grainSpeed: 0, background: "#eeeae2", color0: "#2b2620", color1: "#2b2620", color2: "#00000000", color3: "#00000000", color4: "#00000000", cornerRadius: 0 },
  },
  {
    name: "Game Boy",
    description: "The four-shade olive-green LCD of the original handheld: streaks flattened round into blotchy dither cells, a bold ordered-dither-scale grain, and only the console's own four greens in the palette.",
    props: { speed: 0.15, zoom: 0.6, streakAngle: 0.2618 /* 15° */, elongation: 1.6, softness: 0.06, warp: 0.02, grain: 0.6, grainScale: 2.2, grainSpeed: 2, background: "#0f380f", color0: "#306230", color1: "#8bac0f", color2: "#9bbc0f", color3: "#306230", color4: "#0f380f", cornerRadius: 0 },
  },
  {
    name: "Teletext",
    description: "1970s broadcast teletext: flat saturated primaries on black in blocky vertical streaks (the character-cell grid), a light noisy grain for the analogue signal, and a fast idle flicker as if the page were still being composed.",
    props: { speed: 1.1, zoom: 1.1, streakAngle: 1.5708 /* 90° */, elongation: 2.2, softness: 0.03, warp: 0.03, grain: 0.22, grainScale: 0.9, grainSpeed: 30, background: "#000000", color0: "#ff0000", color1: "#00ff00", color2: "#ffff00", color3: "#0000ff", color4: "#ffffff", cornerRadius: 0 },
  },
  {
    name: "Microfiche",
    description: "A scanned microfilm frame: a near-monochrome sepia field, heavy soft grain standing in for decades of film grain and dust, and the whole image gently, slowly warping as if the film itself had warped in its reel.",
    props: { speed: 0.1, zoom: 0.65, streakAngle: 0.1745 /* 10° */, elongation: 3, softness: 0.3, warp: 0.3, grain: 0.55, grainScale: 1.8, grainSpeed: 4, background: "#d8cba8", color0: "#5b4c30", color1: "#4a3d26", color2: "#6e5d3c", color3: "#3a2f1c", color4: "#d8cba800", cornerRadius: 0 },
  },
  {
    name: "Blueprint Dither",
    description: "Architect's cyanotype paper: white linework colours on a deep engineering-blue field, a fine crosshatch-scale grain, and long straight streaks along the classic drafting diagonal so the field reads as construction lines rather than an illustration.",
    props: { speed: 0.05, zoom: 0.55, streakAngle: 0.7854 /* 45° */, elongation: 7, softness: 0.1, warp: 0.02, grain: 0.4, grainScale: 1, grainSpeed: 1, background: "#0b2a4a", color0: "#dce8f5", color1: "#a9c6e8", color2: "#dce8f5", color3: "#7fa8d6", color4: "#0b2a4a00", cornerRadius: 0 },
  },
  {
    name: "Phosphor Green",
    description: "A monochrome amber-free terminal: every spot collapsed to shades of the one classic phosphor green, thin bright streaks like a vector-scope trace, a fine grain for the tube's own noise floor, and a slow persistent glow rather than a flicker.",
    props: { speed: 0.3, zoom: 0.8, streakAngle: 0 /* 0° */, elongation: 6, softness: 0.12, warp: 0.05, grain: 0.28, grainScale: 1, grainSpeed: 5, background: "#001400", color0: "#33ff66", color1: "#66ff99", color2: "#1aa83d", color3: "#0d5c1f", color4: "#00140000", cornerRadius: 0 },
  },
  {
    name: "VHS Warp",
    description: "A well-worn VHS tape at the edge of tracking: streaks smeared long and shallow across the frame, a strong wobbling domain-warp so nothing sits still, a loud noisy grain for tape hiss, and the oversaturated, slightly bleeding primaries of consumer analogue video.",
    props: { speed: 2.2, zoom: 0.6, streakAngle: 0.1745 /* 10° */, elongation: 8, softness: 0.2, warp: 0.55, grain: 0.45, grainScale: 1.1, grainSpeed: 40, background: "#0a0812", color0: "#ff2d78", color1: "#2de0ff", color2: "#ffe22d", color3: "#8a2dff", color4: "#0a0812", cornerRadius: 6 },
  },
];

export const raycastDitherPlugin = {
  type: "demo_raycast_dither",
  ephemeral: EPHEMERAL.NONE,
  title: "Raycast Dither",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  presets: PRESETS,
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
    ...bundle("transform"),
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
