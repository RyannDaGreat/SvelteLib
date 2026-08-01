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
 * ── THE GESTURES ARE THE CANVAS'S OWN, AND A PLAIN DRAG IS NOT ONE OF THEM ────
 * The user's correction, verbatim: "I asked for the wrong controls before. It
 * should just reuse the canvas pan zoom … where I would pinch to zoom and pan to,
 * two fingers to pan. And so that way I can still drag the element around while
 * I'm editing it."
 *
 * So the interior takes exactly the wheel vocabulary `src/lib/PanZoom.svelte`
 * already implements and core/shortcut_entries.js already announces for the
 * canvas itself — plain wheel PANS, Ctrl+wheel ZOOMS (which is what a trackpad
 * pinch sends, and what the canvas's own "Pan" / "Zoom" chips name) — and it
 * declares NO `onPan`, so a single-pointer drag falls straight through to the
 * canvas's ordinary select/drag and MOVES THE WIDGET. That is the inversion: the
 * mode owns the wheel, never the pointer. It is also why `wheelZoomFactor` is
 * gone from this file — the law is `expZoomFactor` in src/lib/panZoomMath.js,
 * imported by PanZoom and by this file, so the two feels cannot drift.
 *
 * DOM-free at import: pure math plus one descriptor object.
 */

import { fitRectView } from "../core/view.js";
import { equationBoundKeys } from "./canvas/equationBinding.js";
import { expZoomFactor } from "../../../lib/panZoomMath.js";

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
 * interior moves WITH the gesture, so the window slides the opposite way by the
 * same distance in interior units (Δlocal ÷ zoom).
 *
 * SIGN: the argument is the travel of the thing the interior should FOLLOW. A
 * two-finger scroll is the other convention — a positive scroll delta looks
 * FURTHER along, which is why the wheel handler negates its deltas, exactly as
 * src/lib/PanZoom.svelte's `pan()` subtracts a scroll delta from the canvas pan.
 *
 * @param {{x: number, y: number, w: number, h: number}} window - interior window
 * @param {{zoom: number}} view - interiorViewOf(window, w, h)
 * @param {number} dLocalX - the travel the interior should follow, local px
 * @param {number} dLocalY - the travel the interior should follow, local px
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example pannedInteriorWindow({x: 0, y: 0, w: 1, h: 1}, {zoom: 100}, 50, 0) // {x: -0.5, y: 0, w: 1, h: 1}
 * @example pannedInteriorWindow({x: 0, y: 0, w: 1, h: 1}, {zoom: 100}, 0, 0) // {x: 0, y: 0, w: 1, h: 1}
 * @example pannedInteriorWindow({x: 0, y: 0, w: 1, h: 1}, {zoom: 100}, -50, 0) // {x: 0.5, y: 0, w: 1, h: 1} (a scroll RIGHT looks further right)
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
 * Query (reads the document through `app`). The interior-view properties of
 * `node` that are bound to an `=` equation, as stored keys. Empty when none are.
 *
 * The write set is asked of the plugin at the node's CURRENT state, which is the
 * only way to know which keys navigation would touch (a widget may write a
 * different set at different zooms — the Mandelbrot's fine-centre split is
 * exactly that shape).
 *
 * WHAT IS LEFT HERE IS THE WRITE SET, WHICH IS THIS FILE'S OWN KNOWLEDGE; the
 * "which of these are equations" half is web/canvas/equationBinding.js
 * equationBoundKeys, because three other places were asking it with their own
 * copy of the same expression (see that module's header).
 *
 * @param {object} app - the app store
 * @param {object} node - a derived render node
 * @returns {string[]} bound state keys, in write-set order
 */
export function equationBoundInteriorProps(app, node) {
  const view = node.plugin.interiorView;
  const keys = Object.keys(view.writes(node.state, view.window(node.state)));
  return equationBoundKeys(app, node.itemId, node.plugin, keys);
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
    // THE VISIBLE INDICATION that the mode is live, and the answer to "there's no
    // visual indication when I'm editing it. There should be a bar just like text
    // editing or cursors on the top in the canvas … that tells me the coordinates
    // that I'm zooming into". It is the widget's OWN declared floatingToolbar, in
    // the general canvas panel every on-canvas bar uses — so entering explore mode
    // mounts it and nothing here knows what is in it. A widget with no toolbar
    // declaration simply gets no bar (showOverlayPalette is a no-op for it, since
    // web/CanvasView's floatingToolbarNode requires the declaration).
    ctx.showOverlayPalette(ctx.node.itemId);
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
    // inputs AND the HintBar's only feed). All three are display-only — the
    // host's pointer code reads them — and they are WORD-FOR-WORD the canvas's
    // own gesture chips ("Pan" on mouse_scroll, "Zoom" on Ctrl+mouse_scroll, in
    // core/shortcut_entries.js) with "inside" appended, because they ARE the same
    // gestures one frame down. mouse_left names what a plain drag still does,
    // which is the point of the correction: the widget stays movable.
    hints: [
      { keys: ["mouse_scroll"], label: "Pan inside" },
      { keys: ["Ctrl", "mouse_scroll"], label: "Zoom inside (pinch)" },
      { keys: ["mouse_left"], label: "Drag to move the widget" },
    ],
    /**
     * Command. THE WHEEL, interpreted exactly as src/lib/PanZoom.svelte's
     * handleWheel interprets it for the canvas: `ctrlKey` (what a trackpad PINCH
     * sends) zooms about the pointer, anything else pans by the scroll delta.
     * Deltas arrive already converted to the widget's LOCAL px frame, so a
     * rotated or scaled widget pans and zooms along its own axes.
     *
     * Reads the window from the node's CURRENT state (preview included), so
     * successive ticks of one gesture accumulate into ONE undo unit.
     */
    onWheel(ctx, { dLocalX, dLocalY, deltaY, ctrlKey, lx, ly }) {
      const { node } = ctx;
      const win = node.plugin.interiorView.window(node.state);
      const view = interiorViewOf(win, node.state.w, node.state.h);
      const next = ctrlKey
        ? zoomedInteriorWindow(win, view, expZoomFactor(deltaY), lx, ly)
        : pannedInteriorWindow(win, view, -dLocalX, -dLocalY);
      previewInteriorWindow(ctx.app, node, next);
    },
  },
};
