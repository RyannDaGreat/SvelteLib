/**
 * LENS FLARE — a DEMO WIDGET (plugins/demo/, the showcase folder): a physically-
 * motivated, motion-picture lens flare synthesized entirely in SkSL from a single
 * light-source position. Ghost chain + anamorphic streak + halo ring + starburst
 * spikes + chromatic fringing + bloom/veiling glare + procedural dirt — see
 * render_gpu/skia/lens_flare_shader.js for the technique/citations.
 *
 * ── HOW IT COMPOSITES (additive, via the shared effects bundle) ───────────────
 * Like raycast_dither / corkboard it is a FOREGROUND (backdrop:false) GENERATIVE
 * material: it samples NOTHING beneath it and emits ONE `materialFill` op naming
 * the "lens_flare" material (NO new IR op, NO backdrop re-render). It synthesizes on
 * a TRANSPARENT field, so to add LIGHT to the scene it composes the shared EFFECTS
 * BUNDLE (core/properties.js) with blendMode defaulted to "screen": emit() wraps the
 * materialFill in render_gpu/effects.js applyEffects, which — because the blend is
 * non-normal — builds ONE effectSubtree the backend composites additively over the
 * scene. Adjustable overall gain is the `brightness` knob; the user can switch the
 * blend to "add" (or "normal") in the Inspector's Effects region.
 *
 * ── PRESETS (the reusable PRESETS mechanism) ──────────────────────────────────
 * `presets: [{name, description?, props}]` is a plugin-declared list of built-in
 * property-sets. The generic Presets pane (web/PresetsPane.svelte) lists them for
 * any selected widget that declares them and, on click, writes `props` onto the item
 * as keyframed values on the CURRENT frame in ONE undo unit (app.applyPreset). This
 * ships five distinct, tuned looks: Cinematic / Anamorphic / Natural Sun / Sci-Fi /
 * Vintage.
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps): a
 * literal, an expression, or a `= …` equation, with ZERO evaluation-engine changes —
 * so e.g. a keyframed `starburstRotation` or `lightX = self.w/1000` is free.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, bundleNestedDefaults, customProps, defaults, props } from "../../core/properties.js";
import { materialFill } from "../../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";
import { MAX_GHOSTS } from "../../render_gpu/skia/lens_flare_shader.js";

/** Pure function. Clamps v to [lo, hi] (nullish v → lo).
 * @example clamp(1.4, 0, 1) // 1 */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v ?? lo, hi));

/**
 * Pure function. The light source in the widget's LOCAL px frame: the [0,1]
 * lightX/lightY fractions scaled by the box extent (w, h). Shared by the light
 * anchor, the snap feature, and the draggable modifier point so they never drift.
 *
 * @param {{lightX?: number, lightY?: number, w?: number, h?: number}} s - evaluated item state
 * @returns {{x: number, y: number}} local px
 *
 * @example lightLocal({lightX: 0.5, lightY: 0.5, w: 1280, h: 720}) // {x: 640, y: 360}
 * @example lightLocal({lightX: 0.72, lightY: 0.3, w: 1000, h: 500}) // {x: 720, y: 150}
 */
function lightLocal(s) {
  return { x: (s.lightX ?? 0.5) * (s.w ?? 0), y: (s.lightY ?? 0.5) * (s.h ?? 0) };
}

// The look knobs, all self.* custom properties. Dimensionless field knobs are
// normalized to the widget's own extent, so the look holds at any zoom/size; light
// position is a [0,1] fraction of the widget. The defaults are a tasteful warm
// cinematic flare (the Presets pane offers four more distinct looks).
const CUSTOM = customProps([
  { name: "lightX", kind: "number", default: 0.72, min: 0, max: 1, help: "Light-source horizontal position as a fraction of the widget: 0 = left edge, 0.5 = centre, 1 = right edge. The ghost chain marches from here through the widget centre." },
  { name: "lightY", kind: "number", default: 0.3, min: 0, max: 1, help: "Light-source vertical position as a fraction of the widget: 0 = top, 0.5 = centre, 1 = bottom." },
  { name: "brightness", kind: "number", default: 1.2, min: 0, help: "Overall gain on the whole flare — the adjustable master intensity of the additive light added to the scene." },
  { name: "ghostCount", kind: "number", default: 6, min: 0, max: MAX_GHOSTS, help: `Number of aperture "ghosts" (iris reflections) marching along the axis through the centre. 0 = none; up to ${MAX_GHOSTS}.` },
  { name: "ghostSpacing", kind: "number", default: 0.33, min: 0, help: "How far apart the ghosts are spaced along the axis: ghost i sits at light·(1 − spacing·i), so ~0.3 puts one near the centre. Higher = more spread out." },
  { name: "ghostSize", kind: "number", default: 0.11, min: 0.001, help: "Base radius of the ghost discs (normalized to widget height). Ghosts grow along the chain from this base." },
  { name: "ghostIntensity", kind: "number", default: 0.4, min: 0, help: "Brightness of the ghost chain." },
  { name: "anamorphic", kind: "number", default: 0.5, min: 0, help: "Intensity of the horizontal anamorphic streak (the blue JJ-Abrams light bar). 0 = off." },
  { name: "streakLength", kind: "number", default: 0.4, min: 0.01, help: "Horizontal length (σx) of the anamorphic streak, in normalized units. Longer = a wider light bar." },
  { name: "streakColor", kind: "color", default: "#6fa8ff", help: "Colour of the anamorphic streak — classically a coating blue." },
  { name: "halo", kind: "number", default: 0.45, min: 0, help: "Intensity of the halo ring around the optical centre. 0 = off." },
  { name: "haloRadius", kind: "number", default: 0.45, min: 0.01, help: "Radius of the halo ring (normalized to widget height, measured from the centre)." },
  { name: "starburst", kind: "number", default: 0.4, min: 0, help: "Intensity of the diffraction starburst (the radial spikes from the aperture blades). 0 = off." },
  { name: "blades", kind: "number", default: 8, min: 3, help: "Aperture blade count. Diffraction physics: an EVEN count gives that many spikes; an ODD count gives twice as many (e.g. 9 blades → 18 spikes). Also shapes the ghost iris polygon." },
  { name: "starburstSharp", kind: "number", default: 18, min: 1, help: "Spike thinness (exponent). Higher = razor-thin spikes; lower = soft, fat rays." },
  { name: "starburstRotation", kind: "number", default: 0.2, help: "Rotation of the starburst spikes in radians — keyframe it (or bind an equation) to make the spikes swim as a camera turns." },
  { name: "chromatic", kind: "number", default: 0.02, min: 0, help: "Chromatic dispersion amount: how far the red/blue channels split at each iris/halo edge (spectral fringing). Tiny is realistic." },
  // Named "glow" (NOT "bloom") deliberately: the effects bundle already owns a
  // nested `bloom` object (bloom.radius/strength, a vector-glow substrate), so a
  // scalar self.bloom would collide with it. This is the flare's OWN in-shader glow.
  { name: "glow", kind: "number", default: 1.0, min: 0, help: "Bloom / veiling glare intensity — the tight hot core at the light plus a broad soft haze that washes the frame." },
  { name: "dirt", kind: "number", default: 0.18, min: 0, max: 1, help: "Procedural lens-dirt/grunge modulation: 0 = clean glass; 1 = the whole flare is broken up by a dusty grime field (all procedural — no texture asset)." },
  { name: "colorTemp", kind: "number", default: 5200, min: 1000, max: 12000, help: "Colour temperature in Kelvin of the light's cast on the flare: ~3200 K = warm amber, 6500 K = neutral white, ~9000 K+ = cool blue." },
  { name: "tint", kind: "color", default: "#fff2e6", help: "Explicit colour multiply over the whole flare, on top of the temperature cast." },
]);

/**
 * A PRESET: `{name, description?, props}`. `props` is a flat map of item-state keys
 * (the self.* look knobs above + the shared `blendMode`) applied to the current
 * frame in one undo unit by the Presets pane. Five distinct motion-picture looks;
 * values follow the design-note per-look table.
 */
const PRESETS = [
  {
    name: "Cinematic",
    description: "Warm, restrained JJ-Abrams-tasteful flare — gentle blue streak, soft ghosts, a single subtle starburst.",
    props: {
      lightX: 0.7, lightY: 0.3, brightness: 0.9, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.35, ghostSize: 0.09, ghostIntensity: 0.24,
      anamorphic: 0.38, streakLength: 0.3, streakColor: "#8fb0ff",
      halo: 0.3, haloRadius: 0.45, starburst: 0.22, blades: 8, starburstSharp: 24, starburstRotation: 0.2,
      chromatic: 0.012, glow: 0.55, dirt: 0.2, colorTemp: 5200, tint: "#fff2e6",
    },
  },
  {
    name: "Anamorphic",
    description: "The signature blue horizontal light bar dominates; ghosts recede, starburst nearly off — the classic sci-fi-blockbuster streak.",
    props: {
      lightX: 0.5, lightY: 0.42, brightness: 1.0, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.3, ghostSize: 0.07, ghostIntensity: 0.22,
      anamorphic: 1.0, streakLength: 0.72, streakColor: "#4d7bff",
      halo: 0.14, haloRadius: 0.3, starburst: 0.05, blades: 8, starburstSharp: 24, starburstRotation: 0.0,
      chromatic: 0.01, glow: 0.6, dirt: 0.18, colorTemp: 8500, tint: "#dbe6ff",
    },
  },
  {
    name: "Natural Sun",
    description: "A warm daylight sun-star: prominent halo and many-pointed starburst, warm ghosts, no anamorphic streak.",
    props: {
      lightX: 0.76, lightY: 0.22, brightness: 0.85, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.3, ghostSize: 0.1, ghostIntensity: 0.2,
      anamorphic: 0.0, streakLength: 0.3, streakColor: "#ffd9a0",
      halo: 0.5, haloRadius: 0.5, starburst: 0.42, blades: 9, starburstSharp: 12, starburstRotation: 0.1,
      chromatic: 0.008, glow: 0.72, dirt: 0.15, colorTemp: 5500, tint: "#fff4e0",
    },
  },
  {
    name: "Sci-Fi",
    description: "Cool cyan, hot and punchy (additive blend): strong streak, sharp spikes, heavy chromatic split.",
    props: {
      lightX: 0.6, lightY: 0.35, brightness: 1.15, blendMode: "add",
      ghostCount: 6, ghostSpacing: 0.42, ghostSize: 0.1, ghostIntensity: 0.5,
      anamorphic: 0.8, streakLength: 0.6, streakColor: "#66ccff",
      halo: 0.5, haloRadius: 0.45, starburst: 0.5, blades: 6, starburstSharp: 40, starburstRotation: 0.4,
      chromatic: 0.03, glow: 0.8, dirt: 0.1, colorTemp: 9500, tint: "#cfe6ff",
    },
  },
  {
    name: "Vintage",
    description: "Old uncoated glass: amber, hazy and low-contrast — big soft ghosts, wide soft halo, heavy dirt and chroma, no streak.",
    props: {
      lightX: 0.68, lightY: 0.32, brightness: 1.0, blendMode: "screen",
      ghostCount: 3, ghostSpacing: 0.25, ghostSize: 0.15, ghostIntensity: 0.32,
      anamorphic: 0.0, streakLength: 0.3, streakColor: "#ffcf9e",
      halo: 0.35, haloRadius: 0.55, starburst: 0.18, blades: 6, starburstSharp: 6, starburstRotation: 0.3,
      chromatic: 0.024, glow: 1.9, dirt: 0.45, colorTemp: 3200, tint: "#ffddb0",
    },
  },
];

export const lensFlarePlugin = {
  type: "demo_lens_flare",
  title: "Lens Flare",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  presets: PRESETS,
  defaults: {
    // DEFAULT SIZE BOUND TO THE CAMERA: a freshly-inserted flare FILLS the view.
    // THE CAMERA is the singleton purgeable:false item named "Camera" ⇒ stable slug
    // "camera" (slugMap), so these `=` equations resolve to its rect through the
    // ordinary prop-reference path AND track it if the camera later moves/zooms. A
    // wide box never squishes the flare — the shader is aspect-correct (isotropic).
    // (Inserted via app.addItem, NOT crosshair placement: the click-places-default
    // path does arithmetic on defaults.w, which is an equation here — App.svelte.)
    type: "demo_lens_flare",
    x: "= camera.x", y: "= camera.y", w: "= camera.w", h: "= camera.h",
    z: 200, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    ...defaults("opacity"), // opacity:1
    // The EFFECTS BUNDLE gives the additive composite: default blendMode "screen"
    // (overrides the registry's "normal") so the flare adds light to the scene; the
    // rest of the bundle stays effect-off (shadow/bloom/innerShadow) — that bloom is
    // a vector-glow substrate, distinct from this flare's own in-shader bloom knob.
    ...bundleNestedDefaults("effects"),
    blendMode: "screen",
    ...CUSTOM.defaults, // the look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("opacity"),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
    ...bundle("effects"), // blend mode + (unused-by-default) shadow/bloom/inner-shadow
  ],
  /**
   * Pure function. State → display-list: ONE materialFill op naming the "lens_flare"
   * material, WRAPPED in the effects bundle (render_gpu/effects.js applyEffects) so
   * the default blendMode "screen" composites the flare additively over the scene.
   * The bbox (w, h) IS the region (local space; sceneIR wraps it in the node's
   * world). The look knobs pass through as the op's `params`; the SkSL packer
   * clamps/parses them. `world` (emit's 3rd arg) is required by applyEffects.
   */
  emit(s, _targetWorldIR, world) {
    const op = materialFill({
      material: "lens_flare",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: 0,
      params: {
        lightX: s.lightX, lightY: s.lightY, brightness: s.brightness,
        ghostCount: s.ghostCount, ghostSpacing: s.ghostSpacing, ghostSize: s.ghostSize, ghostIntensity: s.ghostIntensity,
        anamorphic: s.anamorphic, streakLength: s.streakLength, streakColor: s.streakColor,
        halo: s.halo, haloRadius: s.haloRadius,
        starburst: s.starburst, blades: s.blades, starburstSharp: s.starburstSharp, starburstRotation: s.starburstRotation,
        chromatic: s.chromatic, bloom: s.glow, dirt: s.dirt,
        colorTemp: s.colorTemp, tint: s.tint,
      },
      opacity: s.opacity ?? 1,
    });
    return applyEffects([op], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
  },
  snapFeatures(s) {
    return [
      { kind: "point", x: s.w / 2, y: s.h / 2, id: "center" },
      { kind: "point", x: lightLocal(s).x, y: lightLocal(s).y, id: "light" },
    ];
  },
  /**
   * Pure function. Standard bbox anchors PLUS a live "light" anchor at the light
   * source (lightX/lightY → local px). The id is underscore-free so the reference
   * grammar (`@item_anchor.x`, split at the LAST underscore) parses it — other
   * widgets can bind to where the flare's light is via `@<slug>_light.x/.y`.
   */
  anchors(state) {
    const l = lightLocal(state);
    return [...standardBBoxAnchors(state), { id: "light", x: l.x, y: l.y }];
  },
  /**
   * Pure function. ONE yellow-square MODIFIER POINT (the "PPT yellow squares",
   * core/derive.js nodeModifierPoints) at the light source. Dragging it writes
   * lightX/lightY (the drag's LOCAL point ÷ the box extent, clamped to [0,1]) — so
   * the light is repositioned directly on the canvas, mirroring the analog clock's
   * hand-tip handles. CanvasView draws/hit-tests it in world space and inverts the
   * drag back through node.world, so rotation is handled for us.
   */
  modifierPoints(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const l = lightLocal(s);
    return [{
      id: "light",
      x: l.x, y: l.y,
      apply(state, localPoint) {
        const ww = state.w ?? 0, hh = state.h ?? 0;
        return {
          lightX: ww > 0 ? clamp(localPoint.x / ww, 0, 1) : (state.lightX ?? 0.5),
          lightY: hh > 0 ? clamp(localPoint.y / hh, 0, 1) : (state.lightY ?? 0.5),
        };
      },
    }];
  },
  // NO top-level `commands`: reached ONLY via the "Insert Demo Widget" submenu.
};
