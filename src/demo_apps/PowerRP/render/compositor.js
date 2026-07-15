/**
 * The compositor: paints a document state onto a canvas, bottom-up in
 * z-order. This one function is shared by the editor canvas, presentation
 * mode, and the headless CLI renderer — that sharing is the whole point.
 *
 * Backdrop sampling (magnifier, blur): when a node's plugin declares
 * capabilities.backdrop, the compositor snapshots the composite-so-far and
 * hands it to paint() via env.backdrop (device-pixel canvas). Compositing is
 * strictly bottom-up, so backdrop widgets stack correctly — a magnifier above
 * a blur layer magnifies the blurred result. (pimgui's snapshot-before-self,
 * owned by the compositor instead of each widget.)
 *
 * Culling (user: "the widget should just give the camera a no whether or not
 * to render itself"): before painting each node the compositor asks whether
 * the node contributes nothing to the current view rect and may be skipped.
 * See canSkipNode / defaultCanSkip. Skipping never changes the output for
 * anything actually visible.
 *
 * env passed to plugin.paint(ctx, state, env):
 *   node          — the render node (world transform, id, ...)
 *   view          — {zoom, panX, panY, dpr}: world→screen mapping
 *   deviceScale   — device px per world unit (zoom * dpr)
 *   worldToDevice(wx, wy) → {x, y} in device pixels
 *   backdrop      — composite-so-far snapshot (only for backdrop plugins)
 *   nodesById     — all render nodes keyed by id
 *   canvasW/H     — canvas size in device pixels
 *   anchorsVisible— editor toggle, lets plugins hint anchor drawing
 *   renderRegion(regionOpts) → offscreen canvas — re-render a sub-view of the
 *                   scene (used by the magnifier's supersampling path); see
 *                   paintRegion. Present only when nesting is allowed (depth 1).
 */

import { foldState } from "../core/document.js";
import { blendApplied } from "../core/deltas.js";
import { deriveRenderTree, cameraRect } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import * as T from "../core/transform.js";

/**
 * Command (draws on ctx). Renders doc at (slideIndex, alpha) through `view`.
 * Pass drawBackground=true to fill the slide rect with meta.background.
 * `stateOverride` (a delta tree) overlays the folded state at full strength —
 * the editor's live-drag preview. Returns the render tree (callers reuse it
 * for hit-testing/overlays).
 *
 * Options beyond the base:
 *   zBelow      — when a finite number, render ONLY nodes with z strictly
 *                 below it (magnifier supersampling re-renders just what sits
 *                 under the lens, i.e. below the magnifier's own z).
 *   noCulling   — TEST-ONLY escape hatch: disable the culling protocol so an
 *                 A/B can prove culling changes nothing visible. Never set in
 *                 production paths; culling is safe and on by default.
 *   allowNesting— when true, expose env.renderRegion so backdrop samplers can
 *                 re-render a region. The compositor passes true at the top
 *                 level and false for any recursive region render, capping
 *                 nesting at depth 1 (a magnifier under a magnifier falls back
 *                 to the plain backdrop-sampling path — see magnifier.js).
 */
export function paintScene(ctx, doc, opts) {
  const {
    slideIndex, alpha = 1, registry, view, drawBackground = true,
    anchorsVisible = false, stateOverride = null, editorChrome = false,
    zBelow = Infinity, noCulling = false, allowNesting = true,
  } = opts;
  let state = foldState(doc, slideIndex, alpha);
  if (stateOverride) state = blendApplied(state, stateOverride, 1);
  // Derivation-stage expression pass (THE UNIFICATION): every equation slot
  // becomes its evaluated number before anything downstream sees the state.
  state = evaluateState(state, registry).state;
  const nodes = deriveRenderTree(state, registry).filter((n) => (n.state.z ?? 0) < zBelow);
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const canvas = ctx.canvas;
  const viewRectWorld = worldViewRect(view, canvas.width, canvas.height);

  const env = {
    view,
    deviceScale: view.zoom * view.dpr,
    worldToDevice: (wx, wy) => ({
      x: (wx * view.zoom + view.panX) * view.dpr,
      y: (wy * view.zoom + view.panY) * view.dpr,
    }),
    nodesById,
    canvasW: canvas.width,
    canvasH: canvas.height,
    anchorsVisible,
    editorChrome, // editor-only chrome gate (nothing consumes it today beyond gating)
  };
  // renderRegion lets a backdrop sampler re-render a sub-view at higher
  // resolution (magnifier supersampling). Only offered at depth 1 — the
  // recursive call sets allowNesting:false so nested samplers can't recurse
  // forever; they fall back to sampling env.backdrop instead.
  if (allowNesting)
    env.renderRegion = (regionOpts) =>
      paintRegion(doc, { slideIndex, alpha, registry, stateOverride, ...regionOpts });

  if (drawBackground) {
    // The background comes from THE CAMERA (user spec) — its rect, its color.
    const cam = cameraRect(state, doc.meta);
    ctx.save();
    applyViewTransform(ctx, view);
    ctx.fillStyle = cam.background;
    ctx.fillRect(cam.x, cam.y, cam.w, cam.h);
    ctx.restore();
  }

  for (const node of nodes) {
    if (!noCulling && canSkipNode(node, viewRectWorld)) continue;
    const backdrop = node.plugin.capabilities.backdrop ? snapshotCanvas(canvas) : undefined;
    ctx.save();
    applyViewTransform(ctx, view);
    ctx.translate(node.world.x, node.world.y);
    ctx.rotate(node.world.rotation);
    ctx.scale(node.world.scale, node.world.scale);
    node.plugin.paint(ctx, node.state, { ...env, node, backdrop });
    ctx.restore();
  }
  return nodes;
}

/**
 * Command (returns an offscreen canvas). Re-renders the scene into a fresh
 * device-pixel canvas of the given size through a custom view. This is how a
 * backdrop sampler (magnifier) supersamples: it maps the lens's source world
 * rect onto a small canvas at the lens's DISPLAY resolution and re-paints only
 * the nodes below it (zBelow). Nesting is capped at depth 1 (allowNesting is
 * forced false), so a magnifier under a magnifier can't recurse.
 *
 * regionOpts: { view, width, height, zBelow, drawBackground }.
 */
function paintRegion(doc, opts) {
  const { width, height, ...rest } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  paintScene(canvas.getContext("2d"), doc, { ...rest, allowNesting: false });
  return canvas;
}

/** Command (mutates ctx transform). Sets world→device-pixel transform. */
function applyViewTransform(ctx, view) {
  ctx.setTransform(
    view.zoom * view.dpr, 0, 0,
    view.zoom * view.dpr,
    view.panX * view.dpr, view.panY * view.dpr,
  );
}

/** Query (reads canvas). Copies a canvas into a fresh one (device pixels). */
function snapshotCanvas(canvas) {
  const snap = document.createElement("canvas");
  snap.width = canvas.width;
  snap.height = canvas.height;
  snap.getContext("2d").drawImage(canvas, 0, 0);
  return snap;
}

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
 * Pure function. Should the compositor skip painting this node for the given
 * world view rect? Backdrop samplers (blur, ...) may sample pixels anywhere on
 * the canvas, so they NEVER skip — enforced here regardless of any plugin
 * hook, so a plugin can't accidentally opt its backdrop out of the scene. Then
 * a plugin's own canSkip(state, viewRectWorld) wins if present; otherwise the
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

/** Minimap thumbnail render width (slide-nav thumbnails size themselves via DirtyImage). */
export const THUMB_W = 256;

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
