/**
 * Blur layer — backdrop sampler with NO bbox and NO transform: it blurs
 * everything painted below its z. Exists partly to prove the architecture
 * holds for non-bbox widgets (select it via the inspector's item list; a
 * magnifier above it magnifies the blurred result).
 */

export const blurPlugin = {
  type: "blur",
  title: "Blur Layer",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: true },
  defaults: { type: "blur", z: 50, blur: 6, opacity: 1 },
  inspector: [
    { key: "blur", label: "Blur (world px)", kind: "number" },
    { key: "opacity", label: "Opacity", kind: "number" },
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
  commands: [
    { id: "add-blur", title: "Add Blur Layer", run: (app) => app.addItem(blurPlugin.defaults) },
  ],
};
