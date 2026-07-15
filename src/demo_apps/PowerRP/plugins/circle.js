/**
 * Ellipse/circle widget. Its "closest" computed anchor is the requirements'
 * showcase case: an arrow bound to {item, anchor: "closest"} touches the
 * perimeter at the point nearest the arrow's other end (exact for circles,
 * radial approximation for ellipses).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import * as T from "../core/transform.js";
import { ellipse } from "../render_gpu/ir.js";

export const circlePlugin = {
  type: "circle",
  title: "Circle",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "circle", x: 200, y: 200, w: 140, h: 140, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#f7768e", stroke: "#1a1a2e", strokeWidth: 2, opacity: 1,
  },
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES").
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees", category: "positioning" }, // core stores radians; field shows degrees (round-10 ruling)
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number", category: "positioning" }, // world pivot; default self.anchors.center
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "fill", label: "Fill", kind: "color", category: "formatting" },
    { key: "stroke", label: "Stroke", kind: "color", category: "formatting" },
    { key: "strokeWidth", label: "Stroke width", kind: "number", min: 0, category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
  ],
  /** Pure function. State → display-list commands (local space) — THE render API. */
  emit(s) {
    return [ellipse({
      cx: s.w / 2, cy: s.h / 2, rx: s.w / 2, ry: s.h / 2,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })];
  },
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
  commands: [
    { id: "add-circle", title: "Add Circle", icon: "mdi:circle-outline", run: (app) => app.addItem(circlePlugin.defaults) },
  ],
};
