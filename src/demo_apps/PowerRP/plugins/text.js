/** Text widget. V1: single line, no wrap; bbox w/h stored (not measured). */

import { standardBBoxAnchors } from "../core/derive.js";
import { text } from "../render_gpu/ir.js";

export const textPlugin = {
  type: "text",
  title: "Text",
  capabilities: { bbox: true, transform: true, resizable: false, backdrop: false },
  defaults: {
    type: "text", x: 120, y: 80, w: 260, h: 48, z: 0, rotation: 0, scale: 1,
    text: "Text", size: 36, color: "#1a1a2e", bold: false, opacity: 1,
  },
  inspector: [
    { key: "text", label: "Text", kind: "text" },
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "size", label: "Size", kind: "number", min: 0 },
    { key: "color", label: "Color", kind: "color" },
    { key: "bold", label: "Bold", kind: "checkbox" },
    { key: "z", label: "Z order", kind: "number" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1 },
  ],
  paint(ctx, s) {
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.font = `${s.bold ? "bold " : ""}${s.size}px system-ui, sans-serif`;
    ctx.fillStyle = s.color;
    ctx.textBaseline = "top";
    ctx.fillText(s.text, 0, 0);
  },
  /** Pure function. paint()'s IR twin (top-left origin, like textBaseline="top"). */
  emit(s) {
    return [text({ text: s.text, x: 0, y: 0, size: s.size, color: s.color, bold: s.bold ?? false, opacity: s.opacity ?? 1 })];
  },
  anchors: standardBBoxAnchors,
  commands: [
    { id: "add-text", title: "Add Text", icon: "mdi:format-text", run: (app) => app.addItem(textPlugin.defaults) },
  ],
};
