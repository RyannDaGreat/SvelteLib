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
 * ── TWO ON-CANVAS HANDLES: WHERE the light is, and HOW BIG its features are ───
 * Every size knob here is normalized to the widget's own height, which is what makes
 * a look hold at any zoom — but it also means the BOX SIZE alone decides how big the
 * rings are. Scale the widget up and the flare scales with it, with no way to say
 * otherwise. `flareScale` is the knob that decouples them: a master multiplier on
 * every feature SIZE (see render_gpu/skia/lens_flare_shader.js "THE FEATURE SCALE"
 * for exactly what is scaled and what is deliberately not). So the box sets the
 * flare's REACH and the scale sets its ring size, independently — a full-frame flare
 * with small tight rings is now just two drags. It gets the SECOND yellow modifier
 * point, radial about the optical centre, alongside the light's.
 *
 * ── PRESETS (the reusable PRESETS mechanism) ──────────────────────────────────
 * `presets: [{name, description?, props}]` is a plugin-declared list of built-in
 * property-sets. The generic Presets pane (web/ToolsPane.svelte) lists them for
 * any selected widget that declares them and, hovering, previews one with the
 * document UNCHANGED (app.setPreview) and, on click, writes `props` onto the item as
 * keyframed values on the CURRENT frame in ONE undo unit (app.applyPreset). This
 * ships TWELVE looks, ONE FLAT family, in a deliberate order — see the PRESETS table
 * below for both the order's meaning and why it is not split into families.
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps): a
 * literal, an expression, or a `= …` equation, with ZERO evaluation-engine changes —
 * so e.g. a keyframed `starburstRotation` or `lightWorldX = someItem.x` (see below,
 * light-position section) is free.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { standardBBoxAnchors, worldTransform } from "../../core/derive.js";
import { closestPointOnAxisRange } from "../../core/outline.js";
import { bundle, bundleNestedDefaults, CUSTOM_CATEGORY, customProps, defaults, props } from "../../core/properties.js";
import * as T from "../../core/transform.js";
import { materialFill } from "../../render_gpu/ir.js";
import { applyEffects, effectsCullMargin, finiteGuardedParams } from "../../render_gpu/effects.js";
// THE LOOK KNOBS AND THEIR schema→uniform MAPPING live in the shader entry now
// (LENS_FLARE_FILL_PARAMS + lensFlareUniformParams — the fill-material framework's
// single-declaration rule: "custom properties become material properties"). This
// widget spreads that SAME schema into its customProps and emit() shares that SAME
// mapping, so the widget and the fill-material shape path can never drift.
import { LENS_FLARE_FILL_PARAMS, lensFlareUniformParams } from "../../render_gpu/skia/lens_flare_shader.js";

/**
 * The reference radius the FEATURE-SCALE handle rides, in the shader's HEIGHT-
 * normalized frame (render_gpu/skia/lens_flare_shader.js normalizes by the half-
 * height, so a normalized radius R is R·h/2 LOCAL px). At flareScale 1 the handle
 * therefore sits exactly on the DEFAULT halo ring (haloRadius 0.45) — so on a
 * default flare the yellow square lands ON a ring it scales, and dragging it
 * literally resizes that ring.
 *
 * It is a CONSTANT, deliberately NOT a live read of `haloRadius`: a handle whose
 * arm came from another knob would collapse onto the widget centre — and its
 * inverse divide would go degenerate — the moment the user set that knob to 0
 * (a legal, documented "halo off" value). A handle must not stop working because
 * an unrelated knob is switched off.
 */
const SCALE_HANDLE_REF_RADIUS = 0.45;

/**
 * Pure function. The light source in the widget's LOCAL px frame: the stored WORLD
 * point (lightWorldX/lightWorldY) brought into local space through the INVERSE of
 * this item's own local→world similarity transform (core/derive.worldTransform —
 * the SAME map every other local-space hook in this widget already lives in:
 * anchors, snapFeatures, modifierPoints). This is the ONE seam that makes the
 * light genuinely pinned in world/document space rather than in the widget's own
 * box: move or rotate the widget and this function returns a DIFFERENT local
 * point for the SAME stored world coordinates, so the flare's glow stays put
 * on the canvas. Shared by the light anchor, the snap feature, and the draggable
 * modifier point so they never drift. NOT clamped — a light outside the box is
 * the whole point of an off-frame sun, so this returns local px outside
 * [0,w]×[0,h] just as happily; a world point behind a rotated/scaled widget maps
 * to whatever local point invert(world) says, which may also lie outside the box.
 *
 * The `?? 0` fallback is a TECHNICAL guard for a state missing the properties
 * entirely (e.g. a hand-built test fixture) — the real defaults live in the
 * plugin's `defaults` block below (equations resolving to the box's own frame
 * at insert time), so a document loaded through the ordinary fold never hits it.
 *
 * @param {object} s - evaluated item state ({lightWorldX?, lightWorldY?, x, y, w, h, rotation?, scale?, rotationAnchor?})
 * @returns {{x: number, y: number}} local px
 *
 * @example // A widget at the origin, unrotated, unit scale: world == local.
 * @example lightLocal({lightWorldX: 640, lightWorldY: 360, x: 0, y: 0, w: 1280, h: 720}) // {x: 640, y: 360}
 * @example // The SAME world light, widget moved 200px right: local shifts left by 200 to compensate.
 * @example lightLocal({lightWorldX: 640, lightWorldY: 360, x: 200, y: 0, w: 1280, h: 720}) // {x: 440, y: 360}
 * @example // Off-box sun: a world point outside the widget's world-space footprint.
 * @example lightLocal({lightWorldX: -400, lightWorldY: 900, x: 0, y: 0, w: 1000, h: 500}) // {x: -400, y: 900}
 */
function lightLocal(s) {
  const inv = T.invert(worldTransform(s));
  return T.apply(inv, s.lightWorldX ?? 0, s.lightWorldY ?? 0);
}

/**
 * Pure function. The light source as the [0,1]-of-the-box FRACTION the SHADER
 * uniform expects (render_gpu/skia/lens_flare_shader.js LENS_FLARE_FILL_PARAMS'
 * lightX/lightY — a fraction of WHATEVER region a material paints into, shared
 * with the generic fill-material path). This widget's own light position is
 * WORLD-space (lightWorldX/lightWorldY); this is the one place that fraction is
 * reconstructed, immediately before packing the shader's params, so the shader's
 * contract stays exactly what it always was and only this widget's document-facing
 * schema changed. Division guard mirrors the rest of this file's `w/h > 0` guards:
 * a zero-extent box has no fraction to compute.
 *
 * @param {object} s - evaluated item state
 * @returns {{x: number, y: number}} shader-space fraction (UNCLAMPED — see lightLocal)
 *
 * @example lightFraction({lightWorldX: 640, lightWorldY: 360, x: 0, y: 0, w: 1280, h: 720}) // {x: 0.5, y: 0.5}
 * @example lightFraction({lightWorldX: 0, lightWorldY: 0, x: 0, y: 0, w: 0, h: 0}) // {x: 0, y: 0} (degenerate box)
 */
function lightFraction(s) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const l = lightLocal(s);
  return { x: w > 0 ? l.x / w : 0, y: h > 0 ? l.y / h : 0 };
}

/**
 * Pure function. The FEATURE-SCALE handle's arm in the widget's LOCAL px frame: the
 * reference radius above, de-normalized by the widget's HALF-HEIGHT (the shader's own
 * normalization). This is the distance the handle sits from the widget centre when
 * flareScale is 1, so the forward map (where the handle goes) and its inverse (what a
 * drag means) both read it and can never drift.
 *
 * @param {{h?: number}} s - evaluated item state
 * @returns {number} local px per unit of flareScale
 *
 * @example scaleHandleArm({h: 720}) // 162 (0.45 × 360)
 * @example scaleHandleArm({h: 0}) // 0 (degenerate box — the caller guards)
 */
function scaleHandleArm(s) {
  return SCALE_HANDLE_REF_RADIUS * (s.h ?? 0) / 2;
}

// The LOOK knobs come from the shader entry (LENS_FLARE_FILL_PARAMS) — the ONE
// declaration the widget and the generic fill-material UI share (paint_skia's
// handleMaterialPaintShape resolves that SAME schema against an arbitrary shape's
// own local bbox, entirely independent of this widget). `lightX`/`lightY` in that
// shared schema are — and remain — a [0,1] fraction of WHATEVER region the material
// is painting into: for a generic shape-fill that region is the shape's own bbox, and
// there is no "document" for a fill paint to be absolute IN. This WIDGET's light
// position is document-facing and therefore excluded from the spread below and
// declared separately as `lightWorldX`/`lightWorldY` (world/document units) — emit()
// converts world → the widget's local box → the shared schema's fraction right before
// calling lensFlareUniformParams, so the shader-facing contract above is untouched.
//
// All 20 REMAINING knobs are dimensionless field values normalized to the widget's own
// extent (so the look holds at any zoom/size). The defaults are a tasteful warm
// cinematic flare; the Presets pane offers twelve further looks.
const LOOK_PARAMS = LENS_FLARE_FILL_PARAMS.filter((def) => def.name !== "lightX" && def.name !== "lightY");
const CUSTOM = customProps(LOOK_PARAMS);

/**
 * A PRESET: `{name, description?, props}`. `props` is a flat map of item-state keys
 * (the self.* look knobs above + the shared `blendMode`) applied to the current
 * frame in one undo unit by the Presets pane. `description` is the row's hover tip,
 * which makes it the one place a look can say WHICH GLASS it is imitating.
 *
 * EVERY PRESET SETS EVERY LOOK KNOB. app.applyPreset writes exactly the keys in
 * `props`, as an OVERLAY on the current state, so a knob a preset omits keeps
 * whatever the PREVIOUSLY hovered preset left there — presets that disagree about
 * which knobs they mention are order-dependent, and comparing looks by running down
 * the list is the entire point of the pane. So all 19 look knobs are spelled out in
 * all twelve maps below, including where a value is inert (streakColor while
 * `anamorphic` is 0; blades while `starburst` is 0).
 *
 * ONE FLAT FAMILY, NOT `presetFamilies`. core/registry.js will give a widget several
 * named preset families, and it requires them to write DISJOINT key sets so that
 * picking one from each COMPOSES rather than clobbers (the Mandelbrot
 * location/colour/performance split; enforced over every plugin by
 * tests/tool_groups_test.js). These twelve are alternative WHOLE looks over the same
 * 19 knobs, so ANY split of them overlaps on all 19 and the second pick would
 * silently erase the first — precisely what that rule exists to forbid. The ORDER
 * below is also information a split would destroy: see the coating-era run at its head.
 *
 * NO PRESET CARRIES `lightWorldX`/`lightWorldY` (user request, complained about
 * directly): a preset changes the LOOK, it never teleports a light the user already
 * positioned. The light position is COMPOSITION — it is placed on the canvas by
 * dragging the yellow handle, or keyframed, or driven by an equation (now bindable
 * to another item, since it is a WORLD coordinate) — while the ~20 other knobs are
 * all look. Nothing is lost by leaving it out: the shader is aspect-correct and
 * every knob here is normalized to the widget, so each look holds identically at any
 * light position, on-box or off. (Before this, applying a preset to a flare whose sun
 * had been dragged off-frame yanked it back inside the box.)
 *
 * NO PRESET CARRIES `flareScale` EITHER, by exactly that same test: it is the OTHER
 * knob a user sets by dragging a yellow handle, and it says how the flare FITS its
 * box, not what the flare looks like. Someone who sized a full-frame box and then
 * dialled the rings back down would lose that fit the instant they tried a preset —
 * the same complaint as the teleported sun. Nothing is lost: every size a preset
 * names below is relative, so each look holds identically at any feature scale.
 */
const PRESETS = [
  // ── THE COATING ERA (the first five, IN ORDER) ──────────────────────────────
  // The order IS the content: modern multicoated → many-group zoom → seventies fast
  // prime → single-layer coating → uncoated glass. Three knobs move with that
  // progression, which is what makes these five differ by cause rather than by taste:
  //   tint  = the COATING's residual reflection colour (multi-layer ≈ a faint green,
  //     single-layer = purple, uncoated = broadband white). A DIFFERENT physical cause
  //     from colorTemp, which carries the LIGHT SOURCE's temperature — one knob each,
  //     and conflating them double-warms a look (the defect that turned an earlier
  //     "Sodium Street Lamp" into a dark orange smudge).
  //   glow = veiling glare, on the measured flare-factor ladder ~4 : ~2 : ~1 for
  //     uncoated : single-coated : top multicoated.
  //   ghostIntensity = the same three eras in ORDER ONLY. The true ghost-brightness
  //     ratio is a factor of ~25 per coating step, which would sink the coated ghosts
  //     below the display's noise floor; this knob is a display gain, not a
  //     reflectance, so the ladder is compressed deliberately.
  // ghostCount is independent of ghost BRIGHTNESS and follows the SURFACE-PAIR count:
  // n air-glass surfaces admit n(n−1)/2 two-surface reflection paths and n = 2 × the
  // group count. That is why the many-group zoom shows the longest chain in the set
  // while each of its ghosts is far fainter than an uncoated prime's.
  {
    name: "Modern Prime",
    description: "Modern multicoated cine prime — the cleanest era: faint veiling glare, a short tight ghost chain, and the crisp 18-point star of a nine-leaf iris.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.28, ghostSize: 0.075, ghostIntensity: 0.2,
      anamorphic: 0, streakLength: 0.4, streakColor: "#8fb0ff",
      halo: 0.2, haloRadius: 0.34,
      starburst: 0.26, blades: 9, starburstSharp: 26, starburstRotation: 0,
      chromatic: 0.006, glow: 0.45, dirt: 0.05, colorTemp: 5600, tint: "#f2f7f2",
    },
  },
  {
    name: "Zoom Ghost Chain",
    description: "A many-group zoom: twice a prime's air-glass surfaces, so the longest ghost chain in the set — each ghost closer, fainter and sitting in more veiling haze.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 8, ghostSpacing: 0.15, ghostSize: 0.075, ghostIntensity: 0.36,
      anamorphic: 0, streakLength: 0.4, streakColor: "#8fb0ff",
      halo: 0.1, haloRadius: 0.55,
      starburst: 0.22, blades: 9, starburstSharp: 28, starburstRotation: 0,
      chromatic: 0.02, glow: 0.6, dirt: 0.12, colorTemp: 5600, tint: "#f0f6f1",
    },
  },
  {
    name: "Seventies Fast Prime",
    description: "A fast seventies prime on a six-blade iris: the hard six-point star of that era, fat close ghosts, and the milkier glare of pre-modern coatings.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.3, ghostSize: 0.14, ghostIntensity: 0.3,
      anamorphic: 0, streakLength: 0.4, streakColor: "#f0f6f2",
      halo: 0.22, haloRadius: 0.45,
      starburst: 0.45, blades: 6, starburstSharp: 35, starburstRotation: 0,
      chromatic: 0.025, glow: 0.9, dirt: 0.2, colorTemp: 5600, tint: "#f0f6f2",
    },
  },
  {
    name: "Single-Coated Classic",
    description: "Single-layer coating: the purple residual reflection that era is known for, over roughly twice a modern lens's veiling glare. The only violet-cast look in the set.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.3, ghostSize: 0.12, ghostIntensity: 0.26,
      anamorphic: 0, streakLength: 0.4, streakColor: "#e2cdee",
      halo: 0.3, haloRadius: 0.5,
      starburst: 0.2, blades: 13, starburstSharp: 8, starburstRotation: 0,
      chromatic: 0.035, glow: 1.1, dirt: 0.25, colorTemp: 5600, tint: "#e2cdee",
    },
  },
  {
    name: "Uncoated Vintage",
    description: "Uncoated glass on a tungsten source: a broadband white residual, the biggest and brightest ghosts here, and about four times a modern lens's glare washing the frame.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 3, ghostSpacing: 0.26, ghostSize: 0.2, ghostIntensity: 0.38,
      anamorphic: 0, streakLength: 0.4, streakColor: "#ffffff",
      halo: 0.4, haloRadius: 0.62,
      starburst: 0.16, blades: 15, starburstSharp: 5, starburstRotation: 0,
      chromatic: 0.07, glow: 2.2, dirt: 0.4, colorTemp: 3200, tint: "#ffffff",
    },
  },
  // ── THE ANAMORPHIC PAIR ─────────────────────────────────────────────────────
  // Both hold `starburst` near ZERO, and that value is right for TWO INDEPENDENT
  // reasons: a real anamorphic iris is round and high-blade-count, so it barely stars
  // at all; AND our starburst is angularly ISOTROPIC, so a desqueezed star would be
  // rendered wrong if they did star (render_gpu/skia/lens_flare_shader.js, "KNOWN
  // BOUND: THE STARBURST IS ANGULARLY ISOTROPIC"). Whichever reason a future editor
  // discards, the other still holds the value down.
  {
    name: "Anamorphic Blue",
    description: "The signature blue horizontal bar of a front anamorphic: a long cool streak over a round high-blade-count iris that barely stars at all.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.3, ghostSize: 0.07, ghostIntensity: 0.2,
      anamorphic: 1.2, streakLength: 1.2, streakColor: "#3d6cff",
      halo: 0.12, haloRadius: 0.3,
      starburst: 0.05, blades: 14, starburstSharp: 24, starburstRotation: 0,
      chromatic: 0.01, glow: 0.6, dirt: 0.18, colorTemp: 6500, tint: "#eef2f8",
    },
  },
  {
    name: "Anamorphic Gold",
    description: "The warm-streak rehousing look: the same bar in gold, with larger ghosts and more haze than the blue — older, dirtier anamorphic glass.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.28, ghostSize: 0.1, ghostIntensity: 0.26,
      anamorphic: 1.2, streakLength: 1.1, streakColor: "#ff9e3d",
      halo: 0.2, haloRadius: 0.5,
      starburst: 0.1, blades: 14, starburstSharp: 14, starburstRotation: 0,
      chromatic: 0.03, glow: 0.9, dirt: 0.28, colorTemp: 5600, tint: "#ffe9c8",
    },
  },
  // ── SOURCES AND FRONT-ELEMENT STATES (the rest) ─────────────────────────────
  // Past the anamorphic pair the ordering axis changes: these five vary the LIGHT
  // (its temperature, its aperture) and the state of the FRONT ELEMENT, not the
  // coating, so they carry no ladder and no order of their own.
  {
    name: "Sodium Street Lamp",
    description: "A low-pressure sodium street lamp: a near-monochromatic ~1800 K source, so a deep amber flare with no dispersion at all to split at the iris edges.",
    props: {
      brightness: 0.9, blendMode: "screen",
      ghostCount: 4, ghostSpacing: 0.2, ghostSize: 0.065, ghostIntensity: 0.3,
      anamorphic: 0, streakLength: 0.4, streakColor: "#fff3e6",
      halo: 0.14, haloRadius: 0.22,
      starburst: 0.4, blades: 7, starburstSharp: 20, starburstRotation: 0,
      chromatic: 0, glow: 0.85, dirt: 0.3, colorTemp: 1800, tint: "#fdf6ee",
    },
  },
  {
    name: "Stopped-Down Sunstar",
    description: "The sun stopped well down: a hairline ten-point star takes over the frame while the ghosts, halo and glare all pull back.",
    props: {
      brightness: 1.0, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.34, ghostSize: 0.07, ghostIntensity: 0.14,
      anamorphic: 0, streakLength: 0.4, streakColor: "#f7f9f5",
      halo: 0.06, haloRadius: 0.28,
      starburst: 0.7, blades: 10, starburstSharp: 80, starburstRotation: 0,
      chromatic: 0.01, glow: 0.4, dirt: 0.1, colorTemp: 5600, tint: "#f7f9f5",
    },
  },
  {
    name: "Sun Through Windshield",
    description: "Sun through a dirty windshield: grime breaking up a wide soft veil, and fat unfocused rays instead of spikes — scatter off the glass, not diffraction at the iris.",
    props: {
      brightness: 1.1, blendMode: "screen",
      ghostCount: 3, ghostSpacing: 0.3, ghostSize: 0.13, ghostIntensity: 0.25,
      anamorphic: 0, streakLength: 0.4, streakColor: "#eef6ea",
      halo: 0.35, haloRadius: 0.8,
      starburst: 0.4, blades: 8, starburstSharp: 1.5, starburstRotation: 0,
      chromatic: 0.04, glow: 2.4, dirt: 1.0, colorTemp: 5600, tint: "#eef6ea",
    },
  },
  {
    name: "Stage Followspot",
    description: "A tungsten followspot, additively blended: a hot punchy source with a tight halo and a clean eight-point star.",
    props: {
      brightness: 1.1, blendMode: "add",
      ghostCount: 3, ghostSpacing: 0.24, ghostSize: 0.06, ghostIntensity: 0.2,
      anamorphic: 0, streakLength: 0.4, streakColor: "#f4f8f4",
      halo: 0.16, haloRadius: 0.3,
      starburst: 0.55, blades: 8, starburstSharp: 30, starburstRotation: 0,
      chromatic: 0.015, glow: 1.1, dirt: 0.15, colorTemp: 3200, tint: "#f4f8f4",
    },
  },
  {
    name: "Security IR Camera",
    description: "A small-sensor security camera: no star at all, a large soft halo, grubby glass and a cool cast — the look of footage nobody cleaned the lens for.",
    props: {
      brightness: 1.1, blendMode: "screen",
      ghostCount: 5, ghostSpacing: 0.22, ghostSize: 0.09, ghostIntensity: 0.34,
      anamorphic: 0, streakLength: 0.4, streakColor: "#dfe8e2",
      halo: 0.3, haloRadius: 0.45,
      starburst: 0, blades: 8, starburstSharp: 18, starburstRotation: 0,
      chromatic: 0, glow: 1.1, dirt: 0.5, colorTemp: 6500, tint: "#dfe8e2",
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
    // LIGHT POSITION IN WORLD/DOCUMENT COORDINATES (user ruling: absolute-only, so
    // "= someItem.x" binding works directly — a relative fraction cannot be bound to
    // another item's position without a widget-specific unbinding step). These
    // equations reproduce the OLD lightX:0.72/lightY:0.3 defaults' exact on-canvas
    // position at insert time (rotation 0, scale 1: local == world), expressed in
    // this item's own frame so a freshly-inserted flare looks identical to before.
    //
    // BARE "self."-prefixed form (no leading "="), matching rotationAnchor's own
    // default two lines up: isNumericSlot's self.-prefix branch is what makes the
    // evaluator expect a NUMBER result here — a leading "=" is the UNIVERSAL
    // any-type marker (core/expressions.js EQ_PREFIX_RE) and would make
    // resultKindForSlot fall through to inspecting this literal default STRING's
    // own shape (not a hex color, so "string") instead of the row's declared
    // numeric kind, rejecting the equation's own numeric result at evaluation.
    //
    // BUILT FROM self.anchors.tl/br, NOT self.x/self.w DIRECTLY: a raw self.w/self.h
    // PROP read (core/expressions.js refValue) hands back the STORED, possibly
    // NEGATIVE extent (a Flip) with no unsigning — only an ANCHOR read
    // (core/expressions.js anchorValue) enters THE FLIP SEAM (unsignedState) before
    // computing a world point, which is exactly the negative-size CONTRACT
    // (core/registry.js, tests/negative_size_test.js): every sign spelling of the
    // same footprint must derive identically. tl/br span the box corner-to-corner in
    // WORLD units, so (br − tl) is the unsigned w/h and tl is the unsigned origin —
    // this default is therefore flip-safe by construction, the same way rotationAnchor's
    // self.anchors.center default is.
    lightWorldX: "self.anchors.tl.x + 0.72 * (self.anchors.br.x - self.anchors.tl.x)",
    lightWorldY: "self.anchors.tl.y + 0.3 * (self.anchors.br.y - self.anchors.tl.y)",
    ...defaults("opacity"), // opacity:1
    // The EFFECTS BUNDLE gives the additive composite: default blendMode "screen"
    // (overrides the registry's "normal") so the flare adds light to the scene; the
    // rest of the bundle stays effect-off (shadow/bloom/innerShadow) — that bloom is
    // a vector-glow substrate, distinct from this flare's own in-shader bloom knob.
    ...bundleNestedDefaults("effects"),
    blendMode: "screen",
    ...CUSTOM.defaults, // the look knobs (self.*), lightX/lightY EXCLUDED (see LOOK_PARAMS)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("opacity"),
    {
      key: "lightWorldX", label: "Light X", kind: "number", category: CUSTOM_CATEGORY,
      // NO `pinLight` ROW ASPECT ANY MORE (manifest R6-4.5). This row used to
      // carry one, which put a MODE-ENTERING eyedropper in the property gutter —
      // a tool wearing a property's clothes. The pin is now the "Pin Light
      // Position to an Object" tool in the Tools pane, gated by
      // core/registry.js's `lightPinnable` over LIGHT_KEYS, so this widget
      // declares nothing to get it and neither does the next lit widget.
      help: "Light-source horizontal position in WORLD (document) coordinates — the same units as the widget's own X. Absolute, not a fraction of the box, so it can be bound to another item's position (e.g. \"= someItem.x\") to pin the flare's source to it. Move or rotate the widget and the light stays put in the document; drag the yellow handle, keyframe it, type an equation, or use the Tools pane's Pin Light Position to an Object to pin it to an item's centre.",
    },
    {
      key: "lightWorldY", label: "Light Y", kind: "number", category: CUSTOM_CATEGORY,
      help: "Light-source vertical position in WORLD (document) coordinates — the same units as the widget's own Y. Absolute, exactly like Light X: bindable to another item, unaffected by this widget's own position/rotation/scale.",
    },
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
    ...bundle("effects"), // blend mode + (unused-by-default) shadow/bloom/inner-shadow
  ],
  /**
   * Pure function (see render_gpu/effects.js finiteGuardedParams — logs on a
   * genuinely broken input, never on an ordinary one). State → display-list: ONE
   * materialFill op naming the "lens_flare" material, WRAPPED in the effects
   * bundle (render_gpu/effects.js applyEffects) so the default blendMode "screen"
   * composites the flare additively over the scene. The bbox (w, h) IS the region
   * (local space; sceneIR wraps it in the node's world). The look knobs pass
   * through as the op's `params`; the SkSL packer clamps/parses them. `world`
   * (emit's 3rd arg) is required by applyEffects AND is THE WORLD→LOCAL SEAM for
   * the light: this widget's stored light position is a WORLD point
   * (lightWorldX/lightWorldY), so it is brought into the widget's own local box
   * (lightFraction, via lightLocal's invert(worldTransform(s))) right here,
   * immediately before packing — the shader/generic-fill-material params object
   * still only ever sees a [0,1] box fraction, unchanged. This is also the whole
   * point of the feature: moving/rotating the WIDGET changes `world`, which changes
   * the RECOVERED fraction, which is exactly what keeps a fixed lightWorldX/Y
   * pinned to the same point in the document while the widget moves under it.
   *
   * THE LANDING BAR (the god_rays sibling's own fix, applied here too since this
   * widget shares the same structural hole: a NaN lightWorldX/Y — from a stale
   * item, a hand-edited document, or any future regression — reaches
   * materialFill's own strict validator as `lightX`/`lightY` NaN and throws,
   * measured directly against this file's OWN emit()). An unresolvable light
   * falls back to fraction (0.5, 0.5) — the box's own centre, the same "no
   * position is a worse guess than the middle of the box" reasoning god_rays
   * uses — and any other broken knob falls back to its own plugin default, each
   * logged once by name.
   */
  emit(s, _targetWorldIR, world) {
    const frac = lightFraction(s);
    const rawParams = lensFlareUniformParams({ ...s, lightX: frac.x, lightY: frac.y });
    const fallback = lensFlareUniformParams({ ...lensFlarePlugin.defaults, lightX: 0.5, lightY: 0.5 });
    const params = finiteGuardedParams(rawParams, fallback, `demo_lens_flare ${s.id ?? "?"}`);
    const op = materialFill({
      material: "lens_flare",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: 0,
      // The SAME schema→uniform mapping the fill-material path uses (one declaration):
      // renames the schema's `glow` to the shader's `bloom`, everything else identity;
      // lightX/lightY are overlaid here since CUSTOM/`s` no longer carries them (they
      // live in `s` as lightWorldX/lightWorldY, in world units).
      params,
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
   * source (lightWorldX/lightWorldY brought into LOCAL px via lightLocal — this hook's
   * contract, like every other in this file, is local space; core/derive.nodeAnchors
   * wraps it back to world for consumers). The id is underscore-free so the reference
   * grammar (`@item_anchor.x`, split at the LAST underscore) parses it — other
   * widgets can bind to where the flare's light is via `@<slug>_light.x/.y`.
   */
  anchors(state) {
    const l = lightLocal(state);
    return [...standardBBoxAnchors(state), { id: "light", x: l.x, y: l.y }];
  },
  /**
   * Pure function. TWO yellow-square MODIFIER POINTS (the "PPT yellow squares",
   * core/derive.js nodeModifierPoints) — the flare's two on-canvas gestures, one for
   * WHERE the light is and one for HOW BIG its features are.
   *
   * These two are the protocol's (core/derive.js) contrast case: one handle is
   * genuinely UNCONSTRAINED and one is genuinely constrained, in the same widget.
   *
   * "light" — at the light source. CanvasView drags/hit-tests in WORLD space and
   * inverts through node.world before calling `apply` (THE HANDLE-CONSTRAINT
   * PROTOCOL, core/derive.js), so `apply` here receives a LOCAL point; it maps that
   * BACK to world through this item's OWN worldTransform (the exact inverse of
   * lightLocal) and writes lightWorldX/lightWorldY — the stored WORLD point,
   * UNCLAMPED: the handle follows the cursor anywhere, including far outside the
   * widget, because an off-box light source is the entire point of an off-frame sun.
   * (It used to clamp the fractions to [0,1], which pinned the handle to the border
   * and silently discarded the drag.) It mirrors the analog clock's hand-tip handles.
   * It therefore declares NO `constrain` — the whole plane is allowed, so the
   * identity default is the truthful declaration, not an omission.
   *
   * "scale" — the FEATURE SCALE, a RADIAL control on the optical centre (the widget
   * centre, which is what every scaled feature is measured from). It sits at 3
   * o'clock, `scaleHandleArm × flareScale` local px out — the DONUT's inner-rim
   * convention exactly, matching the east resize handle — and its DISTANCE from the
   * centre IS the value, so at flareScale 1 it lands on the default halo ring and
   * dragging it literally resizes the rings. Its allowed set is the horizontal RAY
   * running +x from the centre: a ray, not a segment, because flareScale has a floor
   * (a size cannot be negative) and NO upper cap. Dropping the drag's y-component IS
   * that ray's y, and the old `Math.max(0, …)` IS its origin.
   *
   * The scale handle is listed SECOND so the overlay draws it ON TOP: the two only
   * coincide at flareScale 0 with the light dead-centre, and there the one that must
   * stay grabbable is the scale (otherwise a collapsed flare could never be dragged
   * back open on canvas, while the light is always still reachable in the Inspector).
   *
   * The `w/h > 0` guards are TECHNICAL (division by the box extent / by the handle's
   * arm), not a bound on any value: a zero-extent box has no fraction to compute, so
   * each `apply` keeps the existing value rather than returning NaN.
   * CanvasView draws/hit-tests both in world space and inverts the drag back through
   * node.world, so rotation is handled for us.
   */
  modifierPoints(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    if (w <= 0 || h <= 0) return [];
    const l = lightLocal(s);
    return [{
      id: "light",
      x: l.x, y: l.y,
      apply(state, localPoint) {
        const p = T.apply(worldTransform(state), localPoint.x, localPoint.y);
        return { lightWorldX: p.x, lightWorldY: p.y };
      },
    }, {
      id: "scale",
      x: w / 2 + scaleHandleArm(s) * (s.flareScale ?? 1),
      y: h / 2,
      constrain(state, desired) {
        const centre = { x: (state.w ?? 0) / 2, y: (state.h ?? 0) / 2 };
        return closestPointOnAxisRange(centre, { x: 1, y: 0 }, desired, 0);
      },
      apply(state, allowed) {
        const arm = scaleHandleArm(state);
        if (arm <= 0) return { flareScale: state.flareScale ?? 1 };
        return { flareScale: (allowed.x - (state.w ?? 0) / 2) / arm };
      },
    }];
  },
  // NO top-level `commands`: reached ONLY via the "Add Demo Widget" submenu.
};
