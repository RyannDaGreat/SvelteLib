/**
 * View math + the culling protocol — DOM-free pure JS.
 *
 * Moved verbatim from render/compositor.js when the canvas2D painter was deleted
 * (manifest RENDER MODES DECISION). These are backend-agnostic: the runtime
 * painter, the vector backends, hit-testing, and the minimap all consume the same
 * view mapping, and the culling rule is the widget-tells-the-camera protocol from
 * the manifest.
 *
 * SUPERSEDED — HISTORICAL: this header used to gloss that decision as "WebGPU is
 * the only runtime raster mode". It is not, and citing the manifest for it made
 * the claim look settled. The runtime raster path is Skia/CanvasKit on a WebGL2
 * context (render_gpu/skia/browser_surface.js: GetWebGLContext majorVersion 2 →
 * MakeWebGLContext → MakeOnScreenGLSurface), chosen deliberately because WebGL2
 * has no secure-context requirement and the editor must render over plain HTTP;
 * bare node paints the same display list on a software surface. navigator.gpu is
 * touched ONLY by the videoV6/V7/V8 overlay experiments. Nothing in this file
 * depends on which it is — that is the point of the mapping being backend-agnostic.
 */

import * as T from "./transform.js";
import { effectsCullMargin } from "../render_gpu/effects.js";

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
 * Pure function. A node's LOCAL render bounds — the rect its own INK occupies in
 * its own pre-transform coordinates — or null when the widget is genuinely
 * unboundable. THE ONE geometry question the whole app asks about a widget's
 * extent; everything below (the world AABB, the effect-inclusive AABB, the
 * default cull rule) and core/bandselect.js are consumers of exactly this.
 *
 * WHY IT EXISTS — the defect it removes. `capabilities.bbox` used to answer this
 * question, but that flag means "state has x, y, w, h": a UI affordance (resize
 * handles, the transform box). TWO-POINT WIDGETS — line, arrow, elbow / curved /
 * fancy arrow, tangent lines, corkboard yarn — have no w/h and so answered
 * "unboundable", even though every one of them already computes its own drawn
 * hull for its effect substrate. All three symptoms were downstream of that ONE
 * conflation: they could not be caught by a rubber band (bandSelectable), they
 * NEVER culled however far off-screen they sat (defaultCanSkip), and the
 * copy/export capture rect could not include them (effectInclusiveAABB). Bounds
 * are now a geometry question, and `capabilities.bbox` is left meaning only what
 * it says.
 *
 * THE PROTOCOL. A plugin declares `localBounds(state) → {x, y, w, h}`, RESOLVED
 * HERE at the seam rather than injected at registration — the same shape as the
 * two older per-widget geometry hooks this module already resolves this way,
 * `canSkip` (canSkipNode) and `cullMargin` (effectInclusiveAABB). No hook plus
 * `capabilities.bbox` → {0, 0, w, h}, the box a bbox widget has always been
 * bounded by, so every box widget's bounds are unchanged to the bit.
 *
 * NULL MEANS GENUINELY UNBOUNDED, and plugins/blur.js is the only widget that
 * honestly qualifies: a full-canvas backdrop sampler has no geometry at all and
 * may read any pixel on the canvas. Null propagates as "cannot prove it
 * invisible" (never culled) and "nothing to enclose" (not band-selectable).
 *
 * ORTHOGONAL TO cullMargin, deliberately: this is the widget's OWN ink, while
 * `cullMargin` is the halo its EFFECTS throw around that ink. A widget needing
 * room for a shadow declares the margin; a widget whose ink is not its box
 * declares its bounds. Neither is a substitute for the other, and a widget may
 * need both.
 *
 * @example localBoundsOf({state: {w: 10, h: 20}, plugin: {capabilities: {bbox: true}}}) // {x: 0, y: 0, w: 10, h: 20}
 * @example localBoundsOf({state: {}, plugin: {capabilities: {bbox: false}}}) // null (no hook, no box: genuinely unbounded)
 * @example // a two-point widget's hook wins, and may report a rect around anything it draws:
 * @example localBoundsOf({state: {from: {x: 5, y: 5}, to: {x: 15, y: 25}}, plugin: {capabilities: {bbox: false}, localBounds: (s) => ({x: s.from.x, y: s.from.y, w: s.to.x - s.from.x, h: s.to.y - s.from.y})}}) // {x: 5, y: 5, w: 10, h: 20}
 */
export function localBoundsOf(node) {
  if (node.plugin.localBounds) return node.plugin.localBounds(node.state);
  if (!node.plugin.capabilities.bbox) return null;
  return { x: 0, y: 0, w: node.state.w ?? 0, h: node.state.h ?? 0 };
}

/**
 * Pure function. The axis-aligned WORLD bounding box of a node's local bounds
 * (localBoundsOf), conservatively accounting for rotation/scale: transforms the
 * four local corners to world and takes their AABB. Returns null exactly when
 * the node is unboundable. Conservative = never smaller than the true bounds, so
 * it can only ever OVER-estimate what's visible (safe for culling).
 *
 * The name is historical — it bounds whatever LOCAL rect the widget reports, not
 * only a `bbox` widget's box; a two-point widget's rect goes through the very
 * same corner math (its world is identity, so the transform is a no-op there,
 * which is precisely why there is no second code path).
 *
 * @example rotatedBBoxAABB({state: {w: 10, h: 20}, world: {x: 5, y: 5, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}) // {x: 5, y: 5, w: 10, h: 20}
 * @example rotatedBBoxAABB({state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: false}}}) // null
 * @example // a line from (10,20) to (110,60) with a 5-wide stroke, world identity:
 * @example rotatedBBoxAABB({state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: false}, localBounds: () => ({x: 5, y: 15, w: 110, h: 50})}}) // {x: 5, y: 15, w: 110, h: 50}
 */
export function rotatedBBoxAABB(node) {
  const local = localBoundsOf(node);
  if (!local) return null;
  const { x, y, w, h } = local;
  const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([lx, ly]) => T.apply(node.world, lx, ly));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * Pure function. `rotatedBBoxAABB` inflated by the node's effect halo (shadow
 * blur spill + offset, bloom spill — the SAME reach a plugin declares via its
 * `cullMargin` hook, defaulting to `effectsCullMargin` when the plugin has
 * none declared). THE shared effect-reach seam: culling (defaultCanSkip, this
 * file) and the 15.8 copy/export capture rect both call through here so a
 * captured PNG's bounds and the renderer's "is this on screen" bounds can
 * never disagree. If a future effects pipeline changes how shadow/bloom reach
 * is computed, update the reach function passed in here (or its default,
 * effectsCullMargin) — not the callers.
 *
 * Returns null exactly when rotatedBBoxAABB does (unboundable = nothing to bound
 * or inflate). A two-point widget IS boundable (localBoundsOf), so its shadow
 * halo now rides into the capture rect like any other widget's.
 *
 * @example effectInclusiveAABB({state: {w: 10, h: 20}, world: {x: 5, y: 5, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}) // {x: 5, y: 5, w: 10, h: 20} (no effects: same as rotatedBBoxAABB)
 * @example effectInclusiveAABB({state: {w: 10, h: 20, shadow: {dx: 3, dy: 4, blur: 2, color: "#000", opacity: 0.5}}, world: {x: 5, y: 5, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}, cullMargin: () => 11}}) // {x: -6, y: -6, w: 32, h: 42} (11-unit halo on every side)
 */
export function effectInclusiveAABB(node) {
  const aabb = rotatedBBoxAABB(node);
  if (!aabb) return null;
  const margin = (node.plugin.cullMargin?.(node.state) ?? effectsCullMargin(node.state)) * node.world.scale;
  if (margin <= 0) return aabb;
  return { x: aabb.x - margin, y: aabb.y - margin, w: aabb.w + 2 * margin, h: aabb.h + 2 * margin };
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
 * Pure function. The DEFAULT culling rule when a plugin declares no canSkip: a
 * BOUNDABLE widget may be skipped when its (rotation-conservative) world AABB
 * doesn't intersect the view rect; an UNBOUNDABLE one never skips (we can't
 * bound its contribution, so we can't prove it invisible). "Boundable" is
 * localBoundsOf, NOT `capabilities.bbox` — so a line or arrow parked off-screen
 * culls exactly like a rect there, instead of being painted forever because it
 * has no resize handles. Backdrop widgets are handled separately in canSkipNode
 * and never reach this via the default.
 *
 * CULL-MARGIN HOOK (manifest Round 12D: "an effect enlarges the node's
 * effective AABB by blur radius + offset — extend the cull bounds"): a plugin
 * may declare `cullMargin(state) → local-unit halo`; the AABB inflates by
 * margin × world.scale on every side before the intersection test. Zero /
 * absent → the plain AABB, unchanged. First user: the effects bundle
 * (render_gpu/effects.js effectsCullMargin — a shadow/bloom halo must not be
 * clipped away when the widget's box is just offscreen); generic so any
 * future halo-drawing widget reuses it.
 *
 * @example defaultCanSkip({state: {w: 10, h: 10}, world: {x: 500, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}, {x: 0, y: 0, w: 100, h: 100}) // true
 * @example defaultCanSkip({state: {w: 10, h: 10}, world: {x: 50, y: 50, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}, {x: 0, y: 0, w: 100, h: 100}) // false
 * @example defaultCanSkip({state: {}, world: {x: 9999, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: false}}}, {x: 0, y: 0, w: 100, h: 100}) // false (unboundable: no box AND no localBounds)
 * @example defaultCanSkip({state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: false}, localBounds: () => ({x: 9999, y: 0, w: 10, h: 10})}}, {x: 0, y: 0, w: 100, h: 100}) // true (a two-point widget off-view DOES skip)
 * @example defaultCanSkip({state: {w: 10, h: 10}, world: {x: 105, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}, cullMargin: () => 20}}, {x: 0, y: 0, w: 100, h: 100}) // false (20-unit halo reaches back into view)
 * @example defaultCanSkip({state: {w: 10, h: 10}, world: {x: 105, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}, cullMargin: () => 0}}, {x: 0, y: 0, w: 100, h: 100}) // true (zero margin = plain AABB)
 */
export function defaultCanSkip(node, viewRectWorld) {
  const aabb = rotatedBBoxAABB(node);
  if (!aabb) return false; // unboundable contribution (blur): can't prove it invisible, never skip
  const margin = (node.plugin.cullMargin?.(node.state) ?? 0) * node.world.scale;
  const inflated = margin > 0
    ? { x: aabb.x - margin, y: aabb.y - margin, w: aabb.w + 2 * margin, h: aabb.h + 2 * margin }
    : aabb;
  return !rectsIntersect(inflated, viewRectWorld);
}

/**
 * Pure function. Should the renderer skip this node for the given world view
 * rect? Backdrop samplers (blur, ...) may sample pixels anywhere on the
 * canvas, so they NEVER skip — enforced here regardless of any plugin hook,
 * so a plugin can't accidentally opt its backdrop out of the scene. Then a
 * plugin's own canSkip(state, viewRectWorld) wins if present; otherwise the
 * default bounds-intersection rule applies (defaultCanSkip).
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

/**
 * Pure function. The effective device-pixel-ratio for raster rendering, given
 * THE camera's "Retina (HiDPI)" toggle (the scene-global render setting,
 * plugins/camera.js) and the display's real device pixel ratio: `retina` ON
 * renders at the display's density (crisp on HiDPI); OFF pins to 1:1 CSS pixels
 * (softer on Retina, faster). This is the toggle math the `dpr` view parameter
 * (fitRectView / worldViewRect) consumes — factored into the pure core so the
 * live consumer (app.dpr(), which supplies window.devicePixelRatio) is a thin
 * read of the camera prop, not a home for the branch.
 *
 * @param {boolean} retina The camera's retina toggle (true = use device density).
 * @param {number} deviceDpr The display's device pixel ratio (window.devicePixelRatio, > 0).
 * @returns {number} The dpr to pass as fitRectView's 4th arg / view.dpr.
 *
 * @example effectiveDpr(true, 2) // 2
 * @example effectiveDpr(false, 2) // 1
 * @example effectiveDpr(true, 1) // 1
 */
export function effectiveDpr(retina, deviceDpr) {
  return retina ? deviceDpr : 1;
}
