/** Rectangle widget — the canonical bbox plugin. */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect, roundedRectAnchorPoint } from "../core/outline.js";
import * as T from "../core/transform.js";
import { rect } from "../render_gpu/ir.js";

export const rectPlugin = {
  type: "rect",
  title: "Rectangle",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "rect", x: 100, y: 100, w: 240, h: 140, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#7aa2f7", stroke: "#1a1a2e", strokeWidth: 2, cornerRadius: 0, // square by default (user ruling, round 12B); old docs keep their creation-slide value opacity: 1,
  },
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES"). Uncategorized rows fall into the
  // Inspector's default group.
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees", category: "positioning" }, // core stores radians; field edits/shows degrees (round-10 ruling)
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number", category: "positioning" }, // world pivot; default self.anchors.center
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "fill", label: "Fill", kind: "color", category: "formatting" },
    { key: "stroke", label: "Stroke", kind: "color", category: "formatting" },
    { key: "strokeWidth", label: "Stroke width", kind: "number", min: 0, category: "formatting" },
    { key: "cornerRadius", label: "Corner radius", kind: "number", min: 0, category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
  ],
  /** Pure function. State → display-list commands (local space) — THE render API. */
  emit(s) {
    return [rect({
      x: 0, y: 0, w: s.w, h: s.h,
      cornerRadius: s.cornerRadius ?? 0,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })];
  },
  // Anchors sit on the VISIBLE rim: for a rounded rect the four corner anchors
  // slide onto their arcs (the 45° rim point), so arrows meet the painted
  // rounded corner instead of the empty square corner (Round 12 bug). Edge
  // midpoints/center are on straight edges/interior — unchanged by rounding.
  // r=0 → byte-identical to standardBBoxAnchors.
  anchors(state) {
    const r = state.cornerRadius ?? 0;
    return standardBBoxAnchors(state).map((a) =>
      ({ id: a.id, ...roundedRectAnchorPoint(state.w ?? 0, state.h ?? 0, r, a.id, a.x, a.y) }));
  },
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    // Closest point on the ROUNDED rim (arcs at the corners) — not the square
    // bbox border — so a closest-rim arrow lands on the visible rounded edge.
    return closestPointOnRoundedRect(state.w ?? 0, state.h ?? 0, state.cornerRadius ?? 0, local.x, local.y);
  },
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
