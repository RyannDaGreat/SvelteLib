/** Text widget. V1: single line, no wrap; bbox w/h stored (not measured). */

import { standardBBoxAnchors } from "../core/derive.js";
import { text } from "../render_gpu/ir.js";

export const textPlugin = {
  type: "text",
  title: "Text",
  capabilities: { bbox: true, transform: true, resizable: false, backdrop: false },
  defaults: {
    type: "text", x: 120, y: 80, w: 260, h: 48, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    text: "Text", size: 36, color: "#1a1a2e", bold: false, opacity: 1,
  },
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES"). The "text" category holds the
  // content/typography; position lives in "positioning", the rest in "formatting".
  inspector: [
    { key: "text", label: "Text", kind: "text", category: "text" },
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text" },
    { key: "bold", label: "Bold", kind: "checkbox", category: "text" },
    { key: "color", label: "Color", kind: "color", category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
  ],
  /** Pure function. State → display-list commands (local space, top-left text origin). */
  emit(s) {
    return [text({ text: s.text, x: 0, y: 0, size: s.size, color: s.color, bold: s.bold ?? false, opacity: s.opacity ?? 1 })];
  },
  anchors: standardBBoxAnchors,
  commands: [
    { id: "add-text", title: "Add Text", icon: "mdi:format-text", run: (app) => app.addItem(textPlugin.defaults) },
  ],
};
