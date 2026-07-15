/** Rectangle widget — the canonical bbox plugin. */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
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
    fill: "#7aa2f7", stroke: "#1a1a2e", strokeWidth: 2, cornerRadius: 8, opacity: 1,
  },
  inspector: [
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "w", label: "Width", kind: "number", min: 0 },
    { key: "h", label: "Height", kind: "number", min: 0 },
    { key: "rotation", label: "Rotation", kind: "number", display: "degrees" }, // core stores radians; field edits/shows degrees (round-10 ruling)
    { key: "rotationAnchor.x", label: "Rot anchor X", kind: "number" }, // world pivot; default self.anchors.center
    { key: "rotationAnchor.y", label: "Rot anchor Y", kind: "number" },
    { key: "z", label: "Z order", kind: "number" },
    { key: "fill", label: "Fill", kind: "color" },
    { key: "stroke", label: "Stroke", kind: "color" },
    { key: "strokeWidth", label: "Stroke width", kind: "number", min: 0 },
    { key: "cornerRadius", label: "Corner radius", kind: "number", min: 0 },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1 },
  ],
  paint(ctx, s) {
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.beginPath();
    ctx.roundRect(0, 0, s.w, s.h, Math.max(0, s.cornerRadius ?? 0)); // negative radii throw — domain clamp, not a style choice
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
    return [rect({
      x: 0, y: 0, w: s.w, h: s.h,
      cornerRadius: s.cornerRadius ?? 0,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })];
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  commands: [
    { id: "add-rect", title: "Add Rectangle", icon: "mdi:rectangle-outline", run: (app) => app.addItem(rectPlugin.defaults) },
  ],
};
