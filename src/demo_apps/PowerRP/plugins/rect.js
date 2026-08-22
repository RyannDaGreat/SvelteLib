/** Rectangle widget — the canonical bbox plugin. */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect } from "../core/outline.js";
import { BUNDLES, bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { rect } from "../render_gpu/ir.js";
import { morphPayloadFromPaths, statePaint } from "../core/morph_payload.js";
import { rectPathD } from "../core/svg_paths.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

// RECT MATERIAL & CARD PRESETS (R7-39 presets law) — the box is the app's
// most-inserted widget, so this family is not a colour-swap set but a table of
// named, physically-real CARD AND MATERIAL idioms: a thing you would recognise
// on sight (a sticky note, a terminal window, a neon sign) rather than "Blue
// Rect" / "Red Rect". Every row is an OVERLAY over the same universal keys
// (fill/stroke/strokeWidth/cornerRadius/opacity + the six-key effects bundle +
// the five-key stroke-trim group), so a look is fully specified by its props —
// hovering any row after any other leaves nothing behind.
//
// THE IDENTITY LAW (plugins/group.js's rule, restated for a single-family
// widget): EVERY row sets EVERY effects key, including the OFF identities, so
// hovering "Neon Sign" after "Letterpress Plate" cannot leave the bloom lit.
// The six-key set is DERIVED from BUNDLES.effects rather than transcribed, so
// the day a seventh effect lands this file fails loudly with the missing key
// named instead of silently leaking the previous row's value on hover.
const EFFECT_HEADS = [...new Set(BUNDLES.effects.map((k) => k.split(".")[0]))];
if (EFFECT_HEADS.length !== 6)
  throw new Error(`rect presets: BUNDLES.effects grew a new head (${EFFECT_HEADS.join(", ")}) — add its OFF identity below and extend every preset row`);
const SHADOW_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLOOM_OFF = { radius: 10, strength: 0 };
const INNER_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLUR_OFF = 0; // gaussianBlur's identity: 0 = no blur
const EFFECTS_OFF = { shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF };

// THE STROKE-TRIM IDENTITY, for the same overlay reason: strokeStart/End/Phase
// and the two caps carry no DEFAULT (absent-is-legacy, core/properties.js),
// but this family writes them explicitly on every row that touches ANY of
// them, because "Dashed Placeholder" trims the outline and a hover away from
// it must put the full stroke back rather than leave a gap behind.
const TRIM_OFF = { strokeStart: 0, strokeEnd: 1, strokePhase: 0, strokeCapStart: "flat", strokeCapEnd: "flat" };

const PRESETS = [
  { name: "Cut Paper Card", description: "A rounded card cut from warm stock and laid on the page: a soft close shadow under a thin ink edge.",
    props: { fill: "#faf6ee", stroke: "#2b2620", strokeWidth: 1.5, cornerRadius: 14, opacity: 1, ...TRIM_OFF, shadow: { dx: 0, dy: 4, blur: 10, color: "#000000", opacity: 0.28 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Glass Panel", description: "A pane of frosted glass over whatever sits behind it: a milky translucent fill, a bright hairline rim, and a touch of softened edge so the border reads as glass rather than plastic.",
    props: { fill: "#eaf3ff88", stroke: "#ffffffcc", strokeWidth: 1.5, cornerRadius: 18, opacity: 1, ...TRIM_OFF, shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 6, gaussianBlur: BLUR_OFF } },
  { name: "Neon Sign", description: "A glowing tube outline with no face at all: a bright magenta stroke over a screen blend and a wide bloom, so the box emits light rather than reflecting it.",
    props: { fill: "#00000000", stroke: "#ff2ec4", strokeWidth: 4, cornerRadius: 20, opacity: 1, ...TRIM_OFF, shadow: SHADOW_OFF, bloom: { radius: 28, strength: 0.75 }, blendMode: "screen", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Blueprint Outline", description: "A drafted rectangle on tracing paper: no fill, a thin cyan line, sharp square corners — construction geometry, not a finished shape.",
    props: { fill: "#00000000", stroke: "#6fb7e0", strokeWidth: 1, cornerRadius: 0, opacity: 1, ...TRIM_OFF, ...EFFECTS_OFF } },
  { name: "Letterpress Plate", description: "A debossed impression stamped INTO cream card stock: a tight inner shadow all round the rim and no outer shadow at all, so the box reads as pressed down rather than resting on top.",
    props: { fill: "#f3ead9", stroke: "#00000000", strokeWidth: 0, cornerRadius: 6, opacity: 1, ...TRIM_OFF, shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: { dx: 0, dy: 2, blur: 6, color: "#5c4a2e", opacity: 0.5 }, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Sticky Note", description: "A square of yellow paper with no border of its own, curling slightly off the page under a soft low shadow.",
    props: { fill: "#fff275", stroke: "#00000000", strokeWidth: 0, cornerRadius: 2, opacity: 1, ...TRIM_OFF, shadow: { dx: 3, dy: 8, blur: 12, color: "#000000", opacity: 0.3 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Terminal Window", description: "Dark app chrome: a near-black rounded panel with a faint grey frame and a long low shadow, the way a floating window sits above its desktop.",
    props: { fill: "#12151aee", stroke: "#3a4048", strokeWidth: 1, cornerRadius: 10, opacity: 1, ...TRIM_OFF, shadow: { dx: 0, dy: 14, blur: 30, color: "#000000", opacity: 0.45 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Embossed Plate", description: "A raised metal plate stamped OUT of the surface: a brushed steel fill under a crisp offset shadow, the opposite read of the letterpress deboss above.",
    props: { fill: "#c7cdd4", stroke: "#8b939c", strokeWidth: 1, cornerRadius: 8, opacity: 1, ...TRIM_OFF, shadow: { dx: 2, dy: 3, blur: 4, color: "#000000", opacity: 0.5 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Dashed Placeholder", description: "An unfilled box drawn as a broken outline — the stroke trimmed to a gapped loop the way a wireframe marks a slot that has not been filled in yet.",
    props: { fill: "#00000000", stroke: "#8a8a8a", strokeWidth: 2, cornerRadius: 4, opacity: 1, strokeStart: 0.06, strokeEnd: 0.94, strokePhase: 0, strokeCapStart: "flat", strokeCapEnd: "flat", ...EFFECTS_OFF } },
  { name: "Pill Button", description: "A fully rounded call-to-action: a saturated fill capped at the corner radius' maximum useful value for this box, with a light contact shadow underneath.",
    props: { fill: "#3fa9f5", stroke: "#00000000", strokeWidth: 0, cornerRadius: 999, opacity: 1, ...TRIM_OFF, shadow: { dx: 0, dy: 3, blur: 8, color: "#0a4a7a", opacity: 0.4 }, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF } },
  { name: "Chalkboard Slate", description: "A dark slate panel with a chalky desaturated green fill and a soft-edged fade at the rim, as if the board's frame had worn away.",
    props: { fill: "#2e3b2e", stroke: "#00000000", strokeWidth: 0, cornerRadius: 4, opacity: 1, ...TRIM_OFF, shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 22, gaussianBlur: BLUR_OFF } },
  { name: "Frosted Overlay", description: "A soft translucent wash meant to sit OVER other slide content: a wide gaussian blur on the box itself plus reduced opacity, the fill blurred rather than the backdrop.",
    props: { fill: "#ffffff", stroke: "#00000000", strokeWidth: 0, cornerRadius: 0, opacity: 0.55, ...TRIM_OFF, shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: 18 } },
];

export const rectPlugin = {
  type: "rect",
  ephemeral: EPHEMERAL.NONE,
  title: "Rectangle",
  presets: PRESETS,
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js):
  // rect is the canonical filled+stroked box, so it composes the transform
  // bundle + the full strokedBox bundle (fill/stroke/strokeWidth/cornerRadius) +
  // opacity. strokeWidth default 2 overrides the registry's 0 (rect ships with a
  // visible 2px border, its long-standing default); cornerRadius 0 (square by
  // default — user ruling, round 12B). FIX: `opacity: 1` was previously lost —
  // it had been swallowed into a trailing line comment on the old cornerRadius
  // line, so rect's defaults silently lacked opacity while every sibling had it;
  // composing from the registry restores it (deliberate correctness fix).
  defaults: {
    type: "rect", x: 100, y: 100, w: 240, h: 140, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#7aa2f7", stroke: "#000000", strokeWidth: 2,
    ...defaults("cornerRadius", "opacity"), // cornerRadius:0 (square), opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // Rows organized into the Inspector's collapsible accordion regions via each
  // registry row's `category` (manifest Round 12 "PROPERTY CATEGORIES").
  inspector: [
    ...bundle("transform"),
    ...bundle("strokedBox"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /** Pure function. State → display-list commands (local space) — THE render
   * API. Effects (shadow/bloom/blend — the shared EFFECTS BUNDLE,
   * render_gpu/effects.js) wrap the emitted ops; all-off = pass-through. */
  emit(s, _targetWorldIR, world) {
    return applyEffects([rect({
      x: 0, y: 0, w: s.w, h: s.h,
      cornerRadius: s.cornerRadius ?? 0,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * this widget's ink as cubic contours in its own box space, so a keyframed
   * `type` change can FLOW into another shape instead of snapping.
   *
   * THE CORNER RADIUS IS PART OF THE OUTLINE, and that is the whole reason this
   * is `rectPathD` and not four hand-written corners: a rounded rect morphing to
   * a circle should start from the rounded silhouette the widget actually paints,
   * not from a square one. `rectPathD` is the same generator core/svg_paths.js
   * uses to flatten an SVG `<rect>`, so the two spellings of "a rect's outline"
   * in this codebase stay one spelling.
   */
  morphPaths(s) {
    return morphPayloadFromPaths(
      [{ d: rectPathD(0, 0, s.w ?? 0, s.h ?? 0, s.cornerRadius ?? 0, s.cornerRadius ?? 0), paint: statePaint(s) }],
      { w: s.w ?? 0, h: s.h ?? 0 },
    );
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB — core/view.js
  // defaultCanSkip's cullMargin hook.
  cullMargin: effectsCullMargin,
  // Anchors sit on the VISIBLE rim: for a rounded rect the corner anchors slide
  // onto their arcs, so arrows meet the painted rounded corner instead of the
  // empty square corner (Round 12 bug). That is no longer written here — it is
  // THE INK RULE, applied to EVERY widget with a rim at registration
  // (core/derive.js withInkAnchors), by projecting the standard rim anchors
  // through the plugin's own closestAnchor below. This file's private version of
  // it was the general rule's only instance for a whole round; a second spelling
  // of a rule that now has a general one is how the general one dies.
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    // Closest point on the ROUNDED rim (arcs at the corners) — not the square
    // bbox border — so a closest-rim arrow lands on the visible rounded edge.
    return closestPointOnRoundedRect(state.w ?? 0, state.h ?? 0, state.cornerRadius ?? 0, local.x, local.y);
  },
  // NO `modifierPoints`: a rect has no shape handles of its own, and its GRADIENT
  // beads are no longer declared here — core/derive.js nodeModifierPoints appends
  // them for every paint-capable widget off the `paint: true` rows above. This
  // file used to spread them, which is what made the feature an OPT-IN: seven of
  // some seventy-four paint-capable plugins took it up and the rest silently had
  // no gradient handles at all.
  commands: [
    // CROSSHAIR PLACEMENT (manifest ARCHITECTURE PLAN #5 / Round 12B "Boxes":
    // "right now it just places a box wherever the hell it wants") — arms
    // place mode instead of spawning at defaults; CanvasView (web/CanvasView.
    // svelte, out of this plugin's fence) drives the click-drag-places-rect /
    // click-places-default-size gesture generically off `rectPlugin` (type +
    // .defaults is the entire per-plugin surface it needs).
    { id: "add-rect", title: "Add Rectangle", icon: "mdi:rectangle-outline", run: (app) => app.armCrosshairPlacement(rectPlugin) },
  ],
};
