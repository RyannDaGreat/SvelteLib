/**
 * View math + the culling protocol — DOM-free pure JS.
 *
 * Moved verbatim from render/compositor.js when the canvas2D painter was
 * deleted (manifest RENDER MODES DECISION: WebGPU is the only runtime raster
 * mode). These are backend-agnostic: the GPU compositor, the vector backends,
 * hit-testing, and the minimap all consume the same view mapping, and the
 * culling rule is the widget-tells-the-camera protocol from the manifest.
 */

import * as T from "./transform.js";

/**
 * Pure function. The world-space AABB currently visible in a device canvas of
 * `canvasW × canvasH` device pixels under `view`. Inverts the view mapping
 * device = (world*zoom + pan)*dpr at the two canvas corners (zoom, dpr > 0, so
 * device 0 maps to the min world coord and the far corner to the max).
 *
 * The lens of a magnifier only ever samples the on-canvas pixels, which cover
 * exactly this rect — so culling a widget whose bounds miss this rect is
 * consistent with backdrop sampling: a widget outside the viewport contributed
 * nothing to the canvas the lens reads either.
 *
 * @example worldViewRect({zoom: 1, panX: 0, panY: 0, dpr: 1}, 100, 50) // {x: 0, y: 0, w: 100, h: 50}
 * @example worldViewRect({zoom: 2, panX: -20, panY: 0, dpr: 1}, 100, 50) // {x: 10, y: 0, w: 50, h: 25}
 */
export function worldViewRect(view, canvasW, canvasH) {
  const wx = (dx) => (dx / view.dpr - view.panX) / view.zoom;
  const wy = (dy) => (dy / view.dpr - view.panY) / view.zoom;
  const x0 = wx(0), y0 = wy(0), x1 = wx(canvasW), y1 = wy(canvasH);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * Pure function. The axis-aligned world bounding box of a bbox node's box,
 * conservatively accounting for rotation/scale: transforms the four local
 * corners to world and takes their AABB. Returns null when the node has no
 * bbox (nothing to bound). Conservative = never smaller than the true bounds,
 * so it can only ever OVER-estimate what's visible (safe for culling).
 *
 * @example rotatedBBoxAABB({state: {w: 10, h: 20}, world: {x: 5, y: 5, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}) // {x: 5, y: 5, w: 10, h: 20}
 * @example rotatedBBoxAABB({state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: false}}}) // null
 */
export function rotatedBBoxAABB(node) {
  if (!node.plugin.capabilities.bbox) return null;
  const w = node.state.w ?? 0, h = node.state.h ?? 0;
  const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([lx, ly]) => T.apply(node.world, lx, ly));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * Pure function. Do two axis-aligned rects (x,y,w,h) overlap? Touching edges
 * count as overlap (>=), so a widget flush against the viewport edge is kept.
 *
 * @example rectsIntersect({x: 0, y: 0, w: 10, h: 10}, {x: 5, y: 5, w: 10, h: 10}) // true
 * @example rectsIntersect({x: 0, y: 0, w: 10, h: 10}, {x: 20, y: 0, w: 5, h: 5}) // false
 */
export function rectsIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/**
 * Pure function. The DEFAULT culling rule when a plugin declares no canSkip:
 * a bbox widget may be skipped when its (rotation-conservative) world AABB
 * doesn't intersect the view rect; a non-bbox widget never skips (we can't
 * bound its contribution, so we can't prove it invisible). Backdrop widgets
 * are handled separately in canSkipNode and never reach this via the default.
 *
 * @example defaultCanSkip({state: {w: 10, h: 10}, world: {x: 500, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}, {x: 0, y: 0, w: 100, h: 100}) // true
 * @example defaultCanSkip({state: {w: 10, h: 10}, world: {x: 50, y: 50, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}, {x: 0, y: 0, w: 100, h: 100}) // false
 * @example defaultCanSkip({state: {}, world: {x: 9999, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: false}}}, {x: 0, y: 0, w: 100, h: 100}) // false
 */
export function defaultCanSkip(node, viewRectWorld) {
  const aabb = rotatedBBoxAABB(node);
  if (!aabb) return false; // non-bbox: unbounded contribution, never skip
  return !rectsIntersect(aabb, viewRectWorld);
}

/**
 * Pure function. Should the renderer skip this node for the given world view
 * rect? Backdrop samplers (blur, ...) may sample pixels anywhere on the
 * canvas, so they NEVER skip — enforced here regardless of any plugin hook,
 * so a plugin can't accidentally opt its backdrop out of the scene. Then a
 * plugin's own canSkip(state, viewRectWorld) wins if present; otherwise the
 * default bbox-intersection rule applies.
 *
 * @example canSkipNode({state: {}, plugin: {capabilities: {backdrop: true}}}, {x: 0, y: 0, w: 1, h: 1}) // false
 * @example canSkipNode({state: {w: 10, h: 10}, world: {x: 500, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}, {x: 0, y: 0, w: 100, h: 100}) // true
 * @example canSkipNode({state: {w: 10, h: 10}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}, canSkip: () => true}}, {x: 0, y: 0, w: 100, h: 100}) // true
 */
export function canSkipNode(node, viewRectWorld) {
  if (node.plugin.capabilities.backdrop) return false;
  if (node.plugin.canSkip) return node.plugin.canSkip(node.state, viewRectWorld);
  return defaultCanSkip(node, viewRectWorld);
}

/**
 * Pure function. The view that fits a world rect into a w×h output —
 * THE camera mapping, used by export, presentation, thumbnails, and CLI.
 *
 * @example fitRectView({x: 0, y: 0, w: 1280, h: 720}, 640, 360, 1) // {zoom: 0.5, panX: 0, panY: 0, dpr: 1}
 * @example fitRectView({x: 100, y: 0, w: 100, h: 100}, 200, 100, 1) // {zoom: 1, panX: -50, panY: 0, dpr: 1}
 */
export function fitRectView(rect, w, h, dpr = 1) {
  const zoom = Math.min(w / rect.w, h / rect.h);
  return {
    zoom,
    panX: (w - rect.w * zoom) / 2 - rect.x * zoom,
    panY: (h - rect.h * zoom) / 2 - rect.y * zoom,
    dpr,
  };
}
