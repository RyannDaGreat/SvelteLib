/**
 * Preset-shape widget (Wave 2 — unified path shapes). A bbox widget whose render
 * is ONE `path` IR op: the preset generator (core/shapes.js) turns the widget's
 * {shape, w, h, points, innerRatio} into an SVG path `d` in bbox-local space,
 * which paint_skia rasterizes and svg_backend/pdf_backend export as real vector.
 * Shadow / glow / border ride the SHARED effects bundle exactly like rect — the
 * whole point of the path op is that effects operate on the rendered silhouette,
 * so every one of the ~17 presets is shadow/bloom/blend-complete for free.
 *
 * This is the additive Wave 2 deliverable: it does NOT touch rect/circle/arrow —
 * they keep their own ops. It just adds "many more shapes" on one path system.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect } from "../core/outline.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { shapePath } from "../core/shapes.js";
import * as T from "../core/transform.js";
import { path } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

export const shapePlugin = {
  type: "shape",
  title: "Shape",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // Composes the SHARED PROPERTY REGISTRY like rect/circle: positioning + the
  // shape selector/knobs + fill/stroke/strokeWidth (NO cornerRadius — a path has
  // no square corners to round) + opacity + the effects bundle. strokeWidth
  // default 2 (a visible border); shape default "star".
  defaults: {
    type: "shape", x: 100, y: 100, w: 200, h: 200, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (the shared
    // equation — manifest Round 11). Absent on old docs → derive falls to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#bb9af7", stroke: "#1a1a2e", strokeWidth: 2,
    shape: "star", shapePoints: 5, shapeInnerRatio: 0.5,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  // Shape selector + knobs FIRST (the widget's identity), then the paint props.
  inspector: [
    ...bundle("positioning"),
    ...bundle("shape"),
    ...props("fill", "stroke", "strokeWidth"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /** Pure function. State → display-list commands (local space) — THE render
   * API. The preset generator makes the path `d` for the widget's bbox; effects
   * (the shared EFFECTS BUNDLE) wrap the single path op, all-off = pass-through. */
  emit(s, _targetWorldIR, world) {
    const d = shapePath(s.shape ?? "star", s.w ?? 0, s.h ?? 0, {
      points: s.shapePoints,
      innerRatio: s.shapeInnerRatio,
    });
    return applyEffects([path({
      d,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — a shape's tight
  // silhouette varies per preset, so binding arrows to the bounding rim is the
  // sensible, predictable target (same choice circle makes for its bbox).
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    // Closest point on the bbox border (cornerRadius 0), like a plain rect.
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRoundedRect(state.w ?? 0, state.h ?? 0, 0, local.x, local.y);
  },
  commands: [
    // Arms crosshair placement at the DEFAULT preset (star). The visual Shape
    // grid (web/ShapePicker.svelte) arms specific presets; this single command
    // keeps the palette/keyboard surfacing (command-architecture invariant).
    { id: "add-shape", title: "Add Shape", icon: "mdi:shape-outline", run: (app) => app.armCrosshairPlacement(shapePlugin) },
  ],
};
