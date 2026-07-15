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
import { magnifyBackdrop } from "../render_gpu/ir.js";

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
  // `category` groups rows into the Inspector's collapsible accordion regions
  // (manifest Round 12 "PROPERTY CATEGORIES"). The lens's optics/rim group into
  // a "lens" category; position/z into "positioning".
  inspector: [
    { key: "x", label: "X", kind: "number", category: "positioning" },
    { key: "y", label: "Y", kind: "number", category: "positioning" },
    { key: "w", label: "Width", kind: "number", min: 0, category: "positioning" },
    { key: "h", label: "Height", kind: "number", min: 0, category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "magnification", label: "Magnification", kind: "number", min: 0.01, category: "lens" },
    { key: "supersample", label: "Supersample", kind: "checkbox", category: "lens" },
    { key: "rimColor", label: "Rim color", kind: "color", category: "lens" },
    { key: "rimWidth", label: "Rim width", kind: "number", min: 0, category: "lens" },
  ],
  /** Pure function. One lens op — the backend samples or re-renders its own backdrop per `supersample`. */
  emit(s) {
    const { cx, cy, r } = lensGeom(s);
    return [magnifyBackdrop({
      cx, cy, r,
      magnification: s.magnification,
      rimColor: (s.rimWidth ?? 0) > 0 ? s.rimColor : null, // rimWidth 0 = NO rim (manifest spec)
      rimWidth: s.rimWidth ?? 0,
      opacity: s.opacity ?? 1,
      supersample: s.supersample ?? true, // re-render below the lens at display res (sharp); false = backdrop sampling (soft)
    })];
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
