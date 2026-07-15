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
  inspector: [
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "w", label: "Width", kind: "number", min: 0 },
    { key: "h", label: "Height", kind: "number", min: 0 },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees" }, // core stores radians; field shows degrees (round-10 ruling)
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number" }, // world pivot; default self.anchors.center
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number" },
    { key: "z", label: "Z order", kind: "number" },
    { key: "fill", label: "Fill", kind: "color" },
    { key: "stroke", label: "Stroke", kind: "color" },
    { key: "strokeWidth", label: "Stroke width", kind: "number", min: 0 },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1 },
  ],
  paint(ctx, s) {
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.beginPath();
    ctx.ellipse(s.w / 2, s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = s.fill;
    ctx.fill();
    if ((s.strokeWidth ?? 0) > 0) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.strokeWidth;
      ctx.stroke();
    }
  },
  /** Pure function. paint()'s IR twin: state → display-list commands (local space). */
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
