/**
 * Blur layer — backdrop sampler with NO bbox and NO transform: it blurs
 * everything painted below its z. Exists partly to prove the architecture
 * holds for non-bbox widgets (select it via the inspector's item list; a
 * magnifier above it magnifies the blurred result).
 */

import { blurBackdrop } from "../render_gpu/ir.js";

export const blurPlugin = {
  type: "blur",
  title: "Blur Layer",
  // backdrop:true also makes this widget uncullable — the renderer never
  // skips a backdrop sampler (it may read pixels anywhere on the canvas), so
  // blur needs no canSkip hook of its own (see core/view.js canSkipNode).
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: true },
  defaults: { type: "blur", z: 50, blur: 6, opacity: 1 },
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES").
  inspector: [
    { key: "blur", label: "Blur (world px)", kind: "number", min: 0, category: "blur" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
  ],
  /** Pure function. A backdrop-blur op (no geometry — blurs the composite below this z). */
  emit(s) {
    if ((s.blur ?? 0) <= 0) return [];
    return [blurBackdrop({ radius: s.blur, opacity: s.opacity ?? 1 })];
  },
  commands: [
    { id: "add-blur", title: "Add Blur Layer", icon: "mdi:blur", run: (app) => app.addItem(blurPlugin.defaults) },
  ],
};
