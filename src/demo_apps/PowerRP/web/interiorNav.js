/**
 * INTERIOR NAVIGATION — the general "this widget has an interior you can pan and
 * zoom inside" activation handler (web/widget_handlers.js, phase "activate").
 *
 * A widget declares an INTERIOR VIEW and gets double-click-to-explore for free.
 * The first consumer is the deep-zoom Mandelbrot, but nothing here knows about
 * fractals: the handler only ever asks the plugin two pure questions.
 *
 * ── THE PLUGIN CONTRACT (DOM-free, pure, lives in the plugin) ─────────────────
 *   interiorView: {
 *     // Pure. Folded state → the rect of the widget's own interior coordinate
 *     // system that its box currently shows. Units are the widget's (complex
 *     // units for a fractal, metres for a map, ...).
 *     window(state) → {x, y, w, h}
 *     // Pure. Folded state + a NEW window → the item-state writes that store it,
 *     // as a flat {stateKey: value} map. Every key must be a KEYFRAMABLE leaf of
 *     // the widget's own state; the handler writes them through app.setPreview /
 *     // commitPreview exactly like an Inspector row edit.
 *     writes(state, window) → {stateKey: value}
 *   }
 *
 * ── WHY THE VIEW IS THE WIDGET'S OWN STATE AND NOT A UI OBJECT ────────────────
 * RenderTree = pure(document, [[slide, alpha]]). A transient "interior camera"
 * held in the editor would make the render a function of UI state: the CLI
 * renderer and the PNG/PDF export would disagree with the screen, and a reload
 * would lose the view. So navigation writes the widget's ordinary keyframable
 * properties — which is also what makes an interior zoom ANIMATABLE (tween the
 * Mandelbrot's zoomExponent) and `=`-bindable, at no extra cost.
 *
 * ── THE VIEW MATH IS THE CAMERA'S, NOT A SECOND IMPLEMENTATION ───────────────
 * An interior view is the SAME mapping as the scene camera, one frame down:
 * `fitRectView(window, w, h)` (core/view.js — THE camera mapping, shared by
 * export, presentation, thumbnails and the CLI) fits the interior window into
 * the widget's local box exactly as the camera fits the slide rect into the
 * output. So `view.zoom` is local px per interior unit and the two gestures are
 * the camera's own: translate the window (pan) and scale it about the interior
 * point under the cursor (zoom). A window whose aspect differs from the box
 * LETTERBOXES, because that is what fitRectView does for the camera too.
 *
 * DOM-free at import: pure math plus one descriptor object.
 */

import { fitRectView } from "../core/view.js";
import { isEquationValue } from "../core/expressions.js";

/**
 * Wheel-zoom sensitivity: the exponent scale in the 2^(-deltaY·s) law. This is
 * the SvelteLib PanZoom default (`zoomSensitivity = 0.01`, the canvas's own
 * wheel-zoom feel) restated because PanZoom.svelte's pure math lives in its
 * component script and is not exported — see the report's flagged wart.
 */
const INTERIOR_ZOOM_SENSITIVITY = 0.01;

/**
 * How long the wheel must be idle before a zoom counts as FINISHED (ms). One
 * gesture = one undo unit, and a wheel has no "up" event, so the gesture ends on
 * a pause. A trackpad flick or a spun wheel delivers events tens of ms apart, so
 * this holds a continuous zoom together as ONE unit; two deliberate scrolls a
 * quarter second apart are two units, which is what a user expects from undo.
 */
export const ZOOM_GESTURE_IDLE_MS = 250;

/**
 * Pure function. The interior VIEW for a window rect shown in a `w`×`h` local
 * box: `{zoom, panX, panY}` mapping interior units → widget-local px, where
 * local = interior·zoom + pan. Delegates to fitRectView — THE camera mapping —
 * so an interior view and the scene camera can never drift apart.
 *
 * @param {{x: number, y: number, w: number, h: number}} window - interior window
 * @param {number} w - the widget's local box width
 * @param {number} h - the widget's local box height
 * @returns {{zoom: number, panX: number, panY: number, dpr: number}}
 *
 * @example interiorViewOf({x: -2, y: -1, w: 4, h: 2}, 400, 200) // {zoom: 100, panX: 200, panY: 100, dpr: 1}
 * @example interiorViewOf({x: 0, y: 0, w: 1, h: 1}, 100, 100).zoom // 100
 */
export function interiorViewOf(window, w, h) {
  return fitRectView(window, w, h, 1);
}

/**
 * Pure function. The interior point under a widget-LOCAL px point — the window's
 * min corner advanced by (local px ÷ px-per-interior-unit). Inverts
 * interiorViewOf without restating its pan terms: `window.x` already IS
 * `-panX/zoom` for a window that fills the box.
 *
 * @param {{x: number, y: number, w: number, h: number}} window - interior window
 * @param {{zoom: number}} view - interiorViewOf(window, w, h)
 * @param {number} lx - local x px
 * @param {number} ly - local y px
 * @returns {{x: number, y: number}}
 *
 * @example interiorPointAt({x: -2, y: -1, w: 4, h: 2}, {zoom: 100}, 200, 100) // {x: 0, y: 0} (box centre → window centre)
 * @example interiorPointAt({x: 0, y: 0, w: 1, h: 1}, {zoom: 100}, 50, 25) // {x: 0.5, y: 0.25}
 */
export function interiorPointAt(window, view, lx, ly) {
  return { x: window.x + lx / view.zoom, y: window.y + ly / view.zoom };
}

/**
 * Pure function. The window after a PAN of (dLocalX, dLocalY) local px: the
 * interior moves WITH the pointer, so the window slides the opposite way by the
 * same distance in interior units (Δlocal ÷ zoom).
 *
 * @param {{x: number, y: number, w: number, h: number}} window - interior window
 * @param {{zoom: number}} view - interiorViewOf(window, w, h)
 * @param {number} dLocalX - pointer travel, local px
 * @param {number} dLocalY - pointer travel, local px
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example pannedInteriorWindow({x: 0, y: 0, w: 1, h: 1}, {zoom: 100}, 50, 0) // {x: -0.5, y: 0, w: 1, h: 1}
 * @example pannedInteriorWindow({x: 0, y: 0, w: 1, h: 1}, {zoom: 100}, 0, 0) // {x: 0, y: 0, w: 1, h: 1}
 */
export function pannedInteriorWindow(window, view, dLocalX, dLocalY) {
  return { x: window.x - dLocalX / view.zoom, y: window.y - dLocalY / view.zoom, w: window.w, h: window.h };
}

/**
 * Pure function. The window after a ZOOM by `factor` (a multiplier on the view
 * zoom: > 1 magnifies) about the local point (lx, ly): the interior point under
 * the cursor stays exactly under the cursor, so the window shrinks by `factor`
 * about that point. This is the camera's zoom-towards-a-point identity written
 * in interior coordinates.
 *
 * @param {{x: number, y: number, w: number, h: number}} window - interior window
 * @param {{zoom: number}} view - interiorViewOf(window, w, h)
 * @param {number} factor - view-zoom multiplier (> 0)
 * @param {number} lx - local x px the zoom is anchored at
 * @param {number} ly - local y px the zoom is anchored at
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example zoomedInteriorWindow({x: 0, y: 0, w: 1, h: 1}, {zoom: 100}, 2, 50, 50) // {x: 0.25, y: 0.25, w: 0.5, h: 0.5} (about the centre)
 * @example zoomedInteriorWindow({x: 0, y: 0, w: 1, h: 1}, {zoom: 100}, 2, 0, 0) // {x: 0, y: 0, w: 0.5, h: 0.5} (top-left stays put)
 */
export function zoomedInteriorWindow(window, view, factor, lx, ly) {
  const p = interiorPointAt(window, view, lx, ly);
  return {
    x: p.x + (window.x - p.x) / factor,
    y: p.y + (window.y - p.y) / factor,
    w: window.w / factor,
    h: window.h / factor,
  };
}

/**
 * Pure function. Exponential view-zoom multiplier for a wheel delta — the SAME
 * 2^(-deltaY·sensitivity) law and default sensitivity the canvas wheel-zoom
 * uses, so the interior zooms with the identical feel.
 *
 * @param {number} deltaY - WheelEvent deltaY (positive = scroll down)
 * @param {number} [sensitivity] - exponent scale
 * @returns {number}
 *
 * @example wheelZoomFactor(0) // 1
 * @example wheelZoomFactor(-100) // 2 (scroll up magnifies)
 * @example wheelZoomFactor(100) // 0.5
 */
export function wheelZoomFactor(deltaY, sensitivity = INTERIOR_ZOOM_SENSITIVITY) {
  return Math.pow(2, -deltaY * sensitivity);
}

/**
 * Query (reads the document through `app`). The interior-view properties of
 * `node` that are bound to an `=` equation, as stored keys. Empty when none are.
 *
 * The write set is asked of the plugin at the node's CURRENT state, which is the
 * only way to know which keys navigation would touch (a widget may write a
 * different set at different zooms — the Mandelbrot's fine-centre split is
 * exactly that shape).
 *
 * @param {object} app - the app store
 * @param {object} node - a derived render node
 * @returns {string[]} bound state keys, in write-set order
 */
export function equationBoundInteriorProps(app, node) {
  const view = node.plugin.interiorView;
  const keys = Object.keys(view.writes(node.state, view.window(node.state)));
  return keys.filter((key) => isEquationValue(node.plugin, [key], app.storedItemValue(node.itemId, [key])));
}

/**
 * Command. Stages `window` as a live preview of the item's interior-view
 * properties — DOCUMENT UNCHANGED, no undo entry (the house live-preview rule;
 * the Inspector-row commit path). Every key of the plugin's write set is written
 * on every call because setPreview REPLACES previewDelta wholesale — a narrower
 * call would silently drop the keys a previous frame staged.
 *
 * @param {object} app - the app store
 * @param {object} node - a derived render node (its plugin declares interiorView)
 * @param {{x: number, y: number, w: number, h: number}} window - the new interior window
 */
export function previewInteriorWindow(app, node, window) {
  const writes = node.plugin.interiorView.writes(node.state, window);
  app.setPreview(Object.entries(writes).map(([key, value]) => [["items", node.itemId, key], value]));
}

/**
 * THE HANDLER. Registered in web/widget_handlers.js; a widget opts in with
 * `activate: "navigate_interior"` plus its `interiorView` descriptor.
 */
export const NAVIGATE_INTERIOR_HANDLER = {
  id: "navigate_interior",
  phase: "activate",
  label: "Explore interior",
  /** Pure function. `interiorView` is this handler's CONTENT descriptor, so a
   * widget declaring one wants this trigger. Read ONLY by
   * widget_handlers.migrationPlan — a widget that ships the descriptor but forgets
   * `activate: "navigate_interior"` fails the suite rather than losing the mode.
   * @example NAVIGATE_INTERIOR_HANDLER.claims({interiorView: {}}) // true
   * @example NAVIGATE_INTERIOR_HANDLER.claims({type: "rect"}) // false */
  claims(plugin) {
    return !!plugin.interiorView;
  },
  /**
   * Command. Enters EXPLORE MODE on the double-clicked widget.
   *
   * REFUSES (loudly, no state change) when any interior-view property is bound
   * to an `=` equation: a drag would overwrite the equation with the number it
   * currently evaluates to, destroying the user's binding. This is the ruling
   * beginTextEdit already made for the same situation ("`x` is an = equation —
   * edit it in the Inspector; in-place editing would overwrite the equation with
   * its value"), applied verbatim rather than invented here. Unbind the property
   * in the Inspector to explore, or keep the binding and drive the view from the
   * equation — both are coherent; silently clobbering it is not.
   */
  run(ctx) {
    const bound = equationBoundInteriorProps(ctx.app, ctx.node);
    if (bound.length) {
      console.warn(`Explore interior: ${bound.map((k) => `"${k}"`).join(", ")} ${bound.length === 1 ? "is an" : "are"} = equation${bound.length === 1 ? "" : "s"} — panning or zooming would overwrite ${bound.length === 1 ? "it" : "them"} with the current value. Clear the equation in the Inspector to explore this widget, or animate the view through the equation instead.`);
      return;
    }
    ctx.app.selection = ctx.node.itemId;
    ctx.enterMode();
  },
  /**
   * THE SUSTAINED MODE: while it is active the widget owns canvas input. The
   * host (web/CanvasView.svelte) routes gestures here and App.svelte surfaces
   * `hints` in the HintBar, scoped to this mode's id.
   */
  mode: {
    label: "Explore interior",
    // Registered inputs (core/shortcuts.js is the single source of truth for
    // inputs AND the HintBar's only feed). The pointer/wheel entries are
    // display-only — the host's pointer code reads them, exactly like the
    // canvas's own "Pan"/"Zoom"/"Select / drag" gesture hints.
    hints: [
      { keys: ["mouse_left"], label: "Drag to pan inside" },
      { keys: ["mouse_scroll"], label: "Zoom inside" },
    ],
    /**
     * Command. Pans the interior by a pointer delta expressed in the widget's
     * LOCAL px frame. Reads the window from the node's CURRENT state (preview
     * included), so successive moves accumulate.
     */
    onPan(ctx, { dLocalX, dLocalY }) {
      const { node } = ctx;
      const win = node.plugin.interiorView.window(node.state);
      const view = interiorViewOf(win, node.state.w, node.state.h);
      previewInteriorWindow(ctx.app, node, pannedInteriorWindow(win, view, dLocalX, dLocalY));
    },
    /**
     * Command. Zooms the interior about a widget-LOCAL point by a wheel delta.
     */
    onZoom(ctx, { deltaY, lx, ly }) {
      const { node } = ctx;
      const win = node.plugin.interiorView.window(node.state);
      const view = interiorViewOf(win, node.state.w, node.state.h);
      previewInteriorWindow(ctx.app, node, zoomedInteriorWindow(win, view, wheelZoomFactor(deltaY), lx, ly));
    },
  },
};
