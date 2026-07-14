/**
 * Magnifying glass — the "PowerPoint can't do this" demo widget, and the
 * proof of the backdrop-sampling capability. Ported concept from pimgui's
 * MagnifyingGlass (mask_animator/pimgui_skia.py): sample the composite
 * beneath, upscale about the lens center, composite through a circular clip.
 *
 * Bbox widget (x,y,w,h) so it gets the STANDARD resize handles (manifest
 * rule); the circular lens has radius min(w,h)/2 centered in the box.
 *
 * Two lens-fill paths, chosen by the `supersample` state prop:
 *   supersample:false — sample the composite-so-far backdrop and drawImage-
 *     upscale it by `magnification`. The lens content is therefore an already-
 *     rasterized backdrop upscaled, i.e. effectively 1/M of screen resolution —
 *     soft by nature (the manifest's known physics note).
 *   supersample:true (default) — RE-RENDER just the world square under the lens
 *     (only nodes with z strictly below the magnifier) into an offscreen canvas
 *     sized to the lens's device diameter, then composite that through the clip.
 *     A true re-render at display resolution, so it's sharp. Cheap because the
 *     region is small. Falls back to the sampling path when re-render isn't
 *     available (env.renderRegion absent — happens for a nested magnifier, the
 *     depth-1 recursion guard in the compositor).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { fitRectView } from "../render/compositor.js";

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

/**
 * Pure function. The WORLD-space source square a lens of world-radius `r`
 * centered at (cwx, cwy) samples at magnification `m`: a square of side 2r/m
 * (magnifying by m shows a 1/m-sized region). Returned as {x, y, w, h}.
 *
 * @example lensSourceRect(100, 100, 50, 2) // {x: 75, y: 75, w: 50, h: 50}
 * @example lensSourceRect(0, 0, 10, 1) // {x: -10, y: -10, w: 20, h: 20}
 */
export function lensSourceRect(cwx, cwy, r, m) {
  const half = r / Math.max(m, 0.01);
  return { x: cwx - half, y: cwy - half, w: half * 2, h: half * 2 };
}

export const magnifierPlugin = {
  type: "magnifier",
  title: "Magnifier",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "magnifier", x: 270, y: 170, w: 160, h: 160, z: 100,
    magnification: 2.5, rimColor: "#1a1a2e", rimWidth: 4, supersample: true,
  },
  inspector: [
    { key: "x", label: "X", kind: "number" },
    { key: "y", label: "Y", kind: "number" },
    { key: "w", label: "Width", kind: "number" },
    { key: "h", label: "Height", kind: "number" },
    { key: "magnification", label: "Magnification", kind: "number" },
    { key: "supersample", label: "Supersample", kind: "checkbox" },
    { key: "rimColor", label: "Rim color", kind: "color" },
    { key: "rimWidth", label: "Rim width", kind: "number" },
    { key: "z", label: "Z order", kind: "number" },
  ],
  paint(ctx, s, env) {
    const { cx, cy, r } = lensGeom(s);
    // Lens center in device px: local center through the widget's world
    // transform (world.x/y is the box's top-left, cx/cy are local offsets).
    const c = env.worldToDevice(env.node.world.x + cx, env.node.world.y + cy);
    const rDev = r * env.deviceScale;

    // Supersample when enabled AND a region re-render is available. renderRegion
    // is absent for a nested magnifier (compositor caps nesting at depth 1), so
    // a magnifier-under-a-magnifier gracefully falls back to sampling.
    const useSupersample = (s.supersample ?? true) && env.renderRegion;
    if (useSupersample) {
      const cwx = env.node.world.x + cx, cwy = env.node.world.y + cy;
      const src = lensSourceRect(cwx, cwy, r, s.magnification);
      // Offscreen at the lens's DISPLAY diameter (2*rDev device px): rendering
      // the source square at exactly the resolution it will be shown at caps
      // the supersample at the current view's device scale (dpr already baked
      // into env.deviceScale) — sharp but never finer than the screen shows.
      const diam = Math.max(1, Math.round(rDev * 2));
      const region = env.renderRegion({
        view: fitRectView(src, diam, diam, 1),
        width: diam, height: diam,
        zBelow: s.z ?? 0, // only what sits below this magnifier's z
        drawBackground: true, // camera background fills the region
      });
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // device pixels
      ctx.beginPath();
      ctx.arc(c.x, c.y, rDev, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(region, c.x - rDev, c.y - rDev, diam, diam);
      ctx.restore();
    } else {
      if (!env.backdrop) return;
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
    }
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
