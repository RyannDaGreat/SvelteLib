/**
 * Ellipse/circle widget. Its "closest" computed anchor is the requirements'
 * showcase case: an arrow bound to {item, anchor: "closest"} touches the
 * perimeter at the point nearest the arrow's other end (exact for circles,
 * radial approximation for ellipses).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { paintModifierPoints } from "../core/paint_handles.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { ellipse } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

export const circlePlugin = {
  type: "circle",
  title: "Circle",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "circle", x: 200, y: 200, w: 140, h: 140, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#f7768e", stroke: "#000000", strokeWidth: 2,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY: positioning + fill/stroke/
  // strokeWidth + opacity. NO cornerRadius — an ellipse has no square corners to
  // round (that's why circle composes the individual fill/stroke/strokeWidth
  // props, not the whole strokedBox bundle). strokeWidth default 2 (a visible
  // 2px border) overrides the registry's 0.
  inspector: [
    ...bundle("positioning"),
    ...props("fill", "stroke", "strokeWidth"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /** Pure function. State → display-list commands (local space) — THE render
   * API. Effects (shadow/bloom/blend — the shared EFFECTS BUNDLE,
   * render_gpu/effects.js) wrap the emitted ops; all-off = pass-through. */
  emit(s, _targetWorldIR, world) {
    return applyEffects([ellipse({
      cx: s.w / 2, cy: s.h / 2, rx: s.w / 2, ry: s.h / 2,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    const nx = (lx - s.w / 2) / (s.w / 2), ny = (ly - s.h / 2) / (s.h / 2);
    return nx * nx + ny * ny <= 1;
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    // Radial point on the ellipse toward the target (exact when w === h).
    const local = T.apply(T.invert(world), wx, wy);
    const rx = state.w / 2, ry = state.h / 2;
    const theta = Math.atan2((local.y - ry) / ry, (local.x - rx) / rx);
    return { x: rx + rx * Math.cos(theta), y: ry + ry * Math.sin(theta) };
  },
  // GRADIENT HANDLES (core/paint_handles.js): center/direction beads for a
  // gradient FILL; none for a solid/material fill (byte-identical otherwise).
  modifierPoints: (s) => paintModifierPoints(s, "fill"),
  commands: [
    { id: "add-circle", title: "Add Circle", icon: "mdi:circle-outline", run: (app) => app.armCrosshairPlacement(circlePlugin) }, // crosshair bbox placement (manifest UNDEFERRAL SWEEP: crosshair placement for ALL Add buttons)
  ],
};
