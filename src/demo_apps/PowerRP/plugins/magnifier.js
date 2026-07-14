/**
 * Magnifying glass — the "PowerPoint can't do this" demo widget, and the
 * proof of the backdrop-sampling capability. Ported concept from pimgui's
 * MagnifyingGlass (mask_animator/pimgui_skia.py): sample the composite
 * beneath, upscale about the lens center, composite through a circular clip.
 *
 * Bbox widget (x,y,w,h) so it gets the STANDARD resize handles (manifest
 * rule); the circular lens has radius min(w,h)/2 centered in the box.
 * Note: lens content is the sampled backdrop raster upscaled by
 * `magnification`, so it is inherently 1/M of screen resolution.
 */

import { standardBBoxAnchors } from "../core/derive.js";

/**
 * Pure function. Normalizes state to the bbox model, accepting legacy
 * center+radius magnifier states from older saves.
 *
 * @example lensGeom({x: 10, y: 20, w: 100, h: 60}) // {cx: 60, cy: 50, r: 30}
 * @example lensGeom({x: 50, y: 50, radius: 40}) // {cx: 50, cy: 50, r: 40} (legacy center-based)
 */
export function lensGeom(s) {
  if (s.w === undefined && s.radius !== undefined)
    return { cx: s.x, cy: s.y, r: s.radius };
  return { cx: s.w / 2, cy: s.h / 2, r: Math.min(s.w, s.h) / 2 };
}

export const magnifierPlugin = {
  type: "magnifier",
  title: "Magnifier",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "magnifier", x: 270, y: 170, w: 160, h: 160, z: 100,
    magnification: 2.5, rimColor: "#1a1a2e", rimWidth: 4,
  },
  inspector: [
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "w", label: "Width", kind: "number" },
    { key: "h", label: "Height", kind: "number" },
    { key: "magnification", label: "Magnification", kind: "number" },
    { key: "rimColor", label: "Rim color", kind: "color" },
    { key: "rimWidth", label: "Rim width", kind: "number" },
    { key: "z", label: "Z order", kind: "number" },
  ],
  paint(ctx, s, env) {
    if (!env.backdrop) return;
    const { cx, cy, r } = lensGeom(s);
    // Lens center in device px: local center through the widget's world
    // transform (world.x/y is the box's top-left, cx/cy are local offsets).
    const c = env.worldToDevice(env.node.world.x + cx, env.node.world.y + cy);
    const rDev = r * env.deviceScale;
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
    // Rim (local coords — save/restore put the widget transform back).
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = s.rimColor;
    ctx.lineWidth = s.rimWidth;
    ctx.stroke();
  },
  hitTest(s, lx, ly) {
    const { cx, cy, r } = lensGeom(s);
    return (lx - cx) ** 2 + (ly - cy) ** 2 <= r * r;
  },
  snapFeatures(s) {
    const { cx, cy } = lensGeom(s);
    return [{ kind: "point", x: cx, y: cy, id: "center" }];
  },
  anchors: standardBBoxAnchors,
  commands: [
    { id: "add-magnifier", title: "Add Magnifier", icon: "mdi:magnify", run: (app) => app.addItem(magnifierPlugin.defaults) },
  ],
};
