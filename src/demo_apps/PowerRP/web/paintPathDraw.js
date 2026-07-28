/**
 * PAINT-PATH DRAWING — the click-click-click creation mode for plugins/paint_path.js
 * (web/widget_handlers.js, phase "create"; the step-sequencing contract lives in
 * web/creationSteps.js).
 *
 * The user's ask: "a paintable path widget that when I double click it, lets me
 * draw … a path that has curves that will be editable because it's all beziers".
 *
 * This is the POLYGON'S creation flow verbatim — one repeating "point" step, Shift
 * to axis-lock, click the first anchor to close, Enter/double-click to finish —
 * reusing web/polygonDraw.js's OWN pure helpers (constrainedVertex / closesLoop /
 * repeatsLastVertex) rather than re-deriving the same geometry. Only the
 * FINALIZER differs: it builds a paint_path (via paintPathFromWorldPoints) instead
 * of a polygon, so each clicked point becomes a CORNER anchor of the bezier path.
 *
 * ── THE STATED BOUND (see plugins/paint_path.js's header) ─────────────────────
 * Creation lays CORNER anchors by CLICKING. The smooth bezier HANDLES and the
 * subpath BREAKS are edited AFTER placement — each anchor exposes an on-canvas
 * handle (`h<i>` in modifierPoints) and the Inspector list row edits every field.
 * A click-DRAG "pen" gesture that lays a handle DURING creation would require a new
 * creation-gesture kind in web/creationSteps.js (only "point" and "box" exist) plus
 * host support in CanvasView — deferred. The state shape already carries the handle,
 * so it is a UI addition, not a redesign.
 *
 * ── WHY IT IS A MODE (unchanged from the polygon) ─────────────────────────────
 * The gesture count is UNBOUNDED — unknown until the user says stop — and a
 * crosshair `drag` record ends at pointer-up, so the accumulation must outlive it,
 * which is exactly what a sustained canvas MODE is.
 */

import {
  MIN_DRAWN_ANCHORS, paintPathFromWorldPoints,
} from "../plugins/paint_path.js";
import { constrainedVertex, closesLoop, repeatsLastVertex } from "./polygonDraw.js";
import { MOUSE_DOUBLE_TOKEN } from "../core/shortcuts.js";
import { currentStepIndex, validatedSteps } from "./creationSteps.js";

/** The declared steps: ONE repeating click, axis-lock on Shift (the polygon's
 *  existing DRAG_MODIFIER_HINTS.axisLock chip — no new vocabulary). */
const PAINT_PATH_STEPS = validatedSteps("paint_path_chain", [
  {
    gesture: "point",
    repeat: true,
    hint: "Click to place path points",
    modifiers: ["axisLock"],
  },
]);

/**
 * THE HANDLER. Registered in web/widget_handlers.js; plugins/paint_path.js opts in
 * with `placement: "paint_path_chain"`.
 */
export const PAINT_PATH_CHAIN_HANDLER = {
  id: "paint_path_chain",
  phase: "create",
  label: "Draw path",
  /** Command. The crosshair's first press enters the mode; the create phase
   *  resolves every widget through `place`, so a mode-declaring handler still
   *  declares one (the POLYGON_CHAIN_HANDLER note applies verbatim). */
  place(ctx) {
    ctx.enterMode();
  },
  mode: {
    label: "Draw path",
    steps: PAINT_PATH_STEPS,
    hints: [],
    // The DISPATCHABLE finalize key + the double-click finalize GESTURE — the two
    // halves of "Enter to finish or double-click to finish", exactly as the polygon
    // declares them (web/polygonDraw.js documents why both, and why both are shown).
    finish: { keys: ["Enter"], label: "Finish path" },
    finishGesture: { keys: [MOUSE_DOUBLE_TOKEN], label: "Finish path" },
    /** Command (allocates). A fresh session: no anchors, no live point, OPEN until
     *  a click on the first anchor closes it. */
    begin() {
      return { points: [], live: null, closed: false, closing: false };
    },
    /** Pure function. One repeating step, so the bar narrates the same chip for
     *  every click.
     *  @example PAINT_PATH_CHAIN_HANDLER.mode.step({points: [[0, 0]]}) // 0 */
    step(session) {
      return currentStepIndex(PAINT_PATH_STEPS, session.points.length);
    },
    /** Command (mutates the session's live fields only — the document is
     *  untouched). Recomputes the rubber-band's free end and whether a click here
     *  would close the loop. */
    onHover(session, p) {
      session.live = constrainedVertex(session.points, p.world, p.mods);
      session.closing = closesLoop(session.points, session.live, p.tolerance);
    },
    /** Command (mutates the session; may request finalize). One click: close the
     *  loop, or land an anchor. A click on the last anchor lands nothing (which is
     *  what makes double-click-to-finish work — see repeatsLastVertex). */
    onStep(ctx, session, p) {
      const at = constrainedVertex(session.points, p.world, p.mods);
      session.live = at;
      if (closesLoop(session.points, at, p.tolerance)) {
        session.closed = true;
        session.closing = false;
        ctx.finish();
        return;
      }
      if (repeatsLastVertex(session.points, at, p.tolerance)) return;
      session.points = [...session.points, [at.x, at.y]];
    },
    /**
     * Command (ONE undo unit, or nothing at all). Enter / double-click / a closing
     * click: one `addItem` of one paint_path whose box is fitted to the clicked
     * hull, every clicked point a CORNER anchor. Fewer than MIN_DRAWN_ANCHORS
     * ABANDONS — a stray single click must not leave a ghost behind (the widget's
     * own isGhost agrees on the same threshold).
     */
    finalize(ctx, session) {
      if (session.points.length < MIN_DRAWN_ANCHORS) return;
      ctx.app.addItem({ ...ctx.plugin.defaults, ...paintPathFromWorldPoints(session.points, session.closed) });
    },
    /**
     * Pure function. The overlay: the committed chain PLUS the in-progress segment
     * to the pointer, a dot on every landed anchor, and the first anchor HOT while
     * a click would close the loop — the polygon's overlay shape (drawn as straight
     * guide segments; the curves appear once the item exists).
     *
     * @example PAINT_PATH_CHAIN_HANDLER.mode.overlay({points: [[0, 0], [10, 0]], live: {x: 10, y: 10}, closed: false, closing: false}).chains[0].points.length // 3
     * @example PAINT_PATH_CHAIN_HANDLER.mode.overlay({points: [[0, 0]], live: null, closed: false, closing: false}).dots // [{x: 0, y: 0, hot: false}]
     */
    overlay(session) {
      const live = session.live ? [[session.live.x, session.live.y]] : [];
      return {
        chains: [{ points: [...session.points, ...live], closed: session.closed }],
        rects: [],
        dots: session.points.map(([x, y], i) => ({ x, y, hot: i === 0 && session.closing })),
      };
    },
  },
};
