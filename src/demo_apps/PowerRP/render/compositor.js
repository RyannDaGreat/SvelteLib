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
 * env passed to plugin.paint(ctx, state, env):
 *   node          — the render node (world transform, id, ...)
 *   view          — {zoom, panX, panY, dpr}: world→screen mapping
 *   deviceScale   — device px per world unit (zoom * dpr)
 *   worldToDevice(wx, wy) → {x, y} in device pixels
 *   backdrop      — composite-so-far snapshot (only for backdrop plugins)
 *   nodesById     — all render nodes keyed by id (for bindings)
 *   resolveBinding(binding, towardX, towardY) → world point or null
 *   canvasW/H     — canvas size in device pixels
 *   anchorsVisible— editor toggle, lets plugins hint anchor drawing
 */

import { foldState } from "../core/document.js";
import { blendApplied } from "../core/deltas.js";
import { deriveRenderTree, resolveBinding } from "../core/derive.js";

/**
 * Command (draws on ctx). Renders doc at (slideIndex, alpha) through `view`.
 * Pass drawBackground=true to fill the slide rect with meta.background.
 * `stateOverride` (a delta tree) overlays the folded state at full strength —
 * the editor's live-drag preview. Returns the render tree (callers reuse it
 * for hit-testing/overlays).
 */
export function paintScene(ctx, doc, opts) {
  const { slideIndex, alpha = 1, registry, view, drawBackground = true, anchorsVisible = false, stateOverride = null, editorChrome = false } = opts;
  let state = foldState(doc, slideIndex, alpha);
  if (stateOverride) state = blendApplied(state, stateOverride, 1);
  const nodes = deriveRenderTree(state, registry);
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const canvas = ctx.canvas;

  const env = {
    view,
    deviceScale: view.zoom * view.dpr,
    worldToDevice: (wx, wy) => ({
      x: (wx * view.zoom + view.panX) * view.dpr,
      y: (wy * view.zoom + view.panY) * view.dpr,
    }),
    nodesById,
    resolveBinding: (binding, tx, ty) => resolveBinding(binding, nodesById, tx, ty),
    canvasW: canvas.width,
    canvasH: canvas.height,
    anchorsVisible,
    editorChrome, // editor-only widgets (the camera's dashed bbox) check this
  };

  if (drawBackground) {
    ctx.save();
    applyViewTransform(ctx, view);
    ctx.fillStyle = doc.meta.background ?? "#ffffff";
    ctx.fillRect(0, 0, doc.meta.slideW, doc.meta.slideH);
    ctx.restore();
  }

  for (const node of nodes) {
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

/** Thumbnail render width shared by the minimap and slide-nav thumbnails. */
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

/**
 * Pure function. fitRectView for the meta slide rect (the no-camera fallback).
 *
 * @example fitSlideView({slideW: 1280, slideH: 720}, 640, 360, 1) // {zoom: 0.5, panX: 0, panY: 0, dpr: 1}
 */
export function fitSlideView(meta, w, h, dpr = 1) {
  return fitRectView({ x: 0, y: 0, w: meta.slideW, h: meta.slideH }, w, h, dpr);
}
