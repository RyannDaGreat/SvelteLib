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
  // backdrop:true also makes this widget uncullable — the compositor never
  // skips a backdrop sampler (it may read pixels anywhere on the canvas), so
  // blur needs no canSkip hook of its own (see compositor.js canSkipNode).
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: true },
  defaults: { type: "blur", z: 50, blur: 6, opacity: 1 },
  inspector: [
    { key: "blur", label: "Blur (world px)", kind: "number", min: 0 },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1 },
    { key: "z", label: "Z order", kind: "number" },
  ],
  paint(ctx, s, env) {
    if (!env.backdrop || (s.blur ?? 0) <= 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // device pixels
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.filter = `blur(${s.blur * env.deviceScale}px)`;
    ctx.drawImage(env.backdrop, 0, 0);
    ctx.restore();
  },
  /** Pure function. paint()'s IR twin: a backdrop-blur op (no geometry — blurs the composite below this z). */
  emit(s) {
    if ((s.blur ?? 0) <= 0) return [];
    return [blurBackdrop({ radius: s.blur, opacity: s.opacity ?? 1 })];
  },
  commands: [
    { id: "add-blur", title: "Add Blur Layer", icon: "mdi:blur", run: (app) => app.addItem(blurPlugin.defaults) },
  ],
};
