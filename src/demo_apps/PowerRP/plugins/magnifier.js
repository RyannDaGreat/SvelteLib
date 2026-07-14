/**
 * Magnifying glass — the "PowerPoint can't do this" demo widget, and the
 * proof of the backdrop-sampling capability. Ported concept from pimgui's
 * MagnifyingGlass (mask_animator/pimgui_skia.py): sample the composite
 * beneath, upscale about the lens center, composite through a circular clip.
 * No bbox — it's a circle; dragging works via hitTest + transform capability.
 */

export const magnifierPlugin = {
  type: "magnifier",
  title: "Magnifier",
  capabilities: { bbox: false, transform: true, resizable: false, backdrop: true },
  defaults: {
    type: "magnifier", x: 350, y: 250, z: 100,
    radius: 80, magnification: 2.5, rimColor: "#1a1a2e", rimWidth: 4,
  },
  inspector: [
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "radius", label: "Radius", kind: "number" },
    { key: "magnification", label: "Magnification", kind: "number" },
    { key: "rimColor", label: "Rim color", kind: "color" },
    { key: "rimWidth", label: "Rim width", kind: "number" },
    { key: "z", label: "Z order", kind: "number" },
  ],
  paint(ctx, s, env) {
    if (!env.backdrop) return;
    const c = env.worldToDevice(env.node.world.x, env.node.world.y);
    const rDev = s.radius * env.deviceScale;
    const srcR = rDev / Math.max(s.magnification, 0.01);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // device pixels
    ctx.beginPath();
    ctx.arc(c.x, c.y, rDev, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(
      env.backdrop,
      c.x - srcR, c.y - srcR, srcR * 2, srcR * 2,
      c.x - rDev, c.y - rDev, rDev * 2, rDev * 2,
    );
    ctx.restore();
    // Rim (in local coords — ctx transform was restored by save/restore).
    ctx.beginPath();
    ctx.arc(0, 0, s.radius, 0, Math.PI * 2);
    ctx.strokeStyle = s.rimColor;
    ctx.lineWidth = s.rimWidth;
    ctx.stroke();
  },
  hitTest(s, lx, ly) {
    return lx * lx + ly * ly <= s.radius * s.radius;
  },
  snapFeatures(s) {
    return [{ kind: "point", x: 0, y: 0, id: "center" }];
  },
  anchors() {
    return [{ id: "cm", x: 0, y: 0 }];
  },
  commands: [
    { id: "add-magnifier", title: "Add Magnifier", run: (app) => app.addItem(magnifierPlugin.defaults) },
  ],
};
