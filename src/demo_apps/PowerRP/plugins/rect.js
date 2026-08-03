/** Rectangle widget — the canonical bbox plugin. */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect } from "../core/outline.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { rect } from "../render_gpu/ir.js";
import { morphPayloadFromPaths, statePaint } from "../core/morph_payload.js";
import { rectPathD } from "../core/svg_paths.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

export const rectPlugin = {
  type: "rect",
  ephemeral: EPHEMERAL.NONE,
  title: "Rectangle",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js):
  // rect is the canonical filled+stroked box, so it composes the positioning
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
    ...bundle("positioning"),
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
