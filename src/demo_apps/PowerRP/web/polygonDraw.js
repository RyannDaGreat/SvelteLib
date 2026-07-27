/**
 * POLYGON DRAWING — the click-click-click creation mode for plugins/polygon.js
 * (web/widget_handlers.js, phase "create"; the step-sequencing contract lives in
 * web/creationSteps.js).
 *
 * The user's request: "I click and click and click … I shift to constrain the
 * axis … I can close the loop if I click at the first point to make it filled …
 * then I hit enter to finalize or double click to finalize … each one of these
 * points that I click and drag becomes a handle … all of which can be now
 * keyframed."
 *
 * The last clause needs NO code here: `polygonFromWorldPoints` fits a bbox to the
 * clicked hull and normalizes the vertices into it, and the widget already ships
 * one draggable, keyframable `modifierPoints` handle per vertex. So this file is
 * GLUE — the geometry is the plugin's, tested there (tests/polygon_test.js), and
 * nothing new is derived.
 *
 * ── WHY IT IS A MODE AND NOT A LONGER DRAG ────────────────────────────────────
 * Every other creation is one gesture, so the host's crosshair `drag` record can
 * hold it. This one is UNBOUNDED: the number of gestures is not known until the
 * user says stop. A `drag` record ends at pointer-up by construction, so the
 * accumulation has to outlive it — which is what a sustained canvas MODE is, and
 * it was already built for interior explore.
 *
 * ── THE SHIFT RULING: 90°, NOT 45° ────────────────────────────────────────────
 * plugins/polygon.js's `angleSnappedPoint(anchor, raw, divisions)` spans both, so
 * this is one number, and the number is SHIFT_ANGLE_DIVISIONS = 4. Why:
 *   - THE USER'S OWN WORDS are "I shift to constrain the axis". "Constrain the
 *     axis" is axis-lock vocabulary — 2 directions per axis, 4 divisions — not
 *     "snap to 45°". Nothing in the request names 45°.
 *   - THE OLDER IN-HOUSE PRECEDENT AGREES, twice: core/snap.axisLock (Shift on a
 *     body drag) locks to the two axes, and web/canvas/dragKinds.creationEndpoint
 *     reads `uniform` (Shift) on a CREATION drag of a single free point — the
 *     closest existing gesture to a polygon vertex — as "axis-locks the live
 *     point to the horizontal or vertical THROUGH THE START". A vertex chain is
 *     that gesture repeated.
 *   - IT NEEDS NO NEW VOCABULARY. The HintBar chip for it already exists and is
 *     already worded: DRAG_MODIFIER_HINTS.axisLock = {Shift, "Axis lock"}. A 45°
 *     reading would have to invent a chip, and an invented word for a modifier
 *     the user described in the house's existing one is a worse outcome than a
 *     22.5° difference in reach.
 * Hysteresis is deliberately NOT used (unlike core/snap.axisLock): the live point
 * is re-derived from the raw pointer on every move, so there is no "locked so
 * far" axis to keep — the same reasoning creationEndpoint's docstring records.
 */

import {
  MIN_DRAWN_VERTICES, MIN_POLYGON_VERTICES, SHIFT_ANGLE_DIVISIONS,
  angleSnappedPoint, closeLoopIndex, polygonFromWorldPoints,
} from "../plugins/polygon.js";
import { currentStepIndex, validatedSteps } from "./creationSteps.js";

/** The declared steps: ONE repeating click. */
const POLYGON_STEPS = validatedSteps("polygon_chain", [
  {
    gesture: "point",
    repeat: true,
    hint: "Click each corner",
    // The chip for the constraint below — the EXISTING house axis-lock wording
    // (core/shortcut_entries.js DRAG_MODIFIER_HINTS), not a new one. See the
    // header's Shift ruling.
    modifiers: ["axisLock"],
  },
]);

/**
 * Pure function. Where a click would actually land: the raw (already
 * feature-snapped) pointer, or — with Shift held — that direction constrained to
 * the nearest of SHIFT_ANGLE_DIVISIONS rays out of the LAST placed vertex. With
 * no vertex yet there is no anchor to constrain against, so the pointer stands.
 *
 * @param {number[][]} points - the placed vertices, [[x, y], ...] world
 * @param {{x: number, y: number}} world - the snapped pointer, world
 * @param {{uniform: boolean}} mods - `uniform` is the Shift flag (creationRect's naming)
 * @returns {{x: number, y: number}}
 *
 * @example constrainedVertex([], {x: 10, y: 9}, {uniform: true}) // {x: 10, y: 9} (nothing to constrain against)
 * @example constrainedVertex([[0, 0]], {x: 10, y: 9}, {uniform: false}) // {x: 10, y: 9} (no Shift)
 * @example constrainedVertex([[0, 0]], {x: 100, y: 9}, {uniform: true}) // {x: 100.404..., y: 0} (axis-locked east, length kept)
 */
export function constrainedVertex(points, world, mods) {
  const anchor = points[points.length - 1];
  if (!mods.uniform || !anchor) return { x: world.x, y: world.y };
  return angleSnappedPoint({ x: anchor[0], y: anchor[1] }, world, SHIFT_ANGLE_DIVISIONS);
}

/**
 * Pure function. Would a click HERE close the loop? Only once the chain can
 * actually enclose an area: `fillsInterior` (the widget's one predicate for
 * "this fills") needs MIN_POLYGON_VERTICES, so offering to close below that
 * would promise a fill the shape cannot have. The tolerance is the caller's
 * world-space grab radius.
 *
 * @param {number[][]} points - the placed vertices, [[x, y], ...] world
 * @param {{x: number, y: number}} probe - where the click would land, world
 * @param {number} tolerance - grab radius, world units
 * @returns {boolean}
 *
 * @example closesLoop([[0, 0], [50, 0], [50, 50]], {x: 3, y: 4}, 6) // true
 * @example closesLoop([[0, 0], [50, 0], [50, 50]], {x: 25, y: 25}, 6) // false (not on the first vertex)
 * @example closesLoop([[0, 0], [50, 0]], {x: 1, y: 1}, 6) // false (2 vertices enclose no area — nothing to fill)
 */
export function closesLoop(points, probe, tolerance) {
  return points.length >= MIN_POLYGON_VERTICES && closeLoopIndex(points, probe, tolerance) === 0;
}

/**
 * Pure function. Is `probe` on top of the vertex just placed? Two presses at one
 * spot are ONE vertex, which is what makes DOUBLE-CLICK-to-finish work without a
 * special case: the double-click's second press coincides with the first's
 * vertex, so it adds nothing and the dblclick that follows finalizes a chain
 * whose last vertex is exactly where the user double-clicked. It also absorbs
 * pointer jitter, which would otherwise leave invisible zero-length edges.
 *
 * @param {number[][]} points - the placed vertices, [[x, y], ...] world
 * @param {{x: number, y: number}} probe - where the click would land, world
 * @param {number} tolerance - grab radius, world units
 * @returns {boolean}
 *
 * @example repeatsLastVertex([[0, 0], [50, 0]], {x: 51, y: 1}, 6) // true
 * @example repeatsLastVertex([[0, 0], [50, 0]], {x: 90, y: 0}, 6) // false
 * @example repeatsLastVertex([], {x: 0, y: 0}, 6) // false (no vertex to repeat)
 */
export function repeatsLastVertex(points, probe, tolerance) {
  const last = points[points.length - 1];
  return !!last && Math.hypot(probe.x - last[0], probe.y - last[1]) <= tolerance;
}

/**
 * THE HANDLER. Registered in web/widget_handlers.js; plugins/polygon.js opts in
 * with `placement: "polygon_chain"`.
 */
export const POLYGON_CHAIN_HANDLER = {
  id: "polygon_chain",
  phase: "create",
  label: "Draw polygon",
  /**
   * Command. The crosshair's FIRST press hands the gesture here, and the host
   * enters the mode instead of running a one-gesture placement — so `place` has
   * nothing of its own to do. It exists because the create phase resolves every
   * widget through `place`, and a mode-declaring handler that omitted it would
   * make the host branch on "does it have a mode" in two places instead of one.
   */
  place(ctx) {
    ctx.enterMode();
  },
  mode: {
    label: "Draw polygon",
    steps: POLYGON_STEPS,
    // Registered inputs beyond the per-step click chip (which the generator emits
    // from `steps`). Display-only: CanvasView's dblclick handler dispatches this
    // one, exactly like the canvas's own pointer hints.
    hints: [
      { keys: ["mouse_left"], label: "Double-click to finish", hidden: true },
    ],
    // The DISPATCHABLE finalize key. Registered (through the generator) so it
    // both fires and reaches the HintBar — an unregistered Enter would not exist.
    finish: { keys: ["Enter"], label: "Finish shape" },
    /** Command (allocates). A fresh drawing session: no vertices, no live point,
     *  an OPEN loop until a click on the first vertex closes it. */
    begin() {
      return { points: [], live: null, closed: false, closing: false };
    },
    /** Pure function. One repeating step, so the bar narrates the same chip for
     *  every click (currentStepIndex clamps it).
     *  @example POLYGON_CHAIN_HANDLER.mode.step({points: [[0, 0], [1, 1]]}) // 0 */
    step(session) {
      return currentStepIndex(POLYGON_STEPS, session.points.length);
    },
    /** Command (mutates the session's live fields only — the document is
     *  untouched). Recomputes the rubber band's free end and whether a click here
     *  would close the loop, so the first vertex highlights BEFORE the click. */
    onHover(session, p) {
      session.live = constrainedVertex(session.points, p.world, p.mods);
      session.closing = closesLoop(session.points, session.live, p.tolerance);
    },
    /**
     * Command (mutates the session; may request finalize). One click: close the
     * loop, or land a vertex. A click on top of the last vertex lands nothing
     * (see repeatsLastVertex — this is what makes double-click-to-finish work).
     */
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
     * Command (ONE undo unit, or nothing at all). Enter / double-click / a
     * closing click: one `addItem` of one polygon whose box is fitted to the
     * clicked hull.
     *
     * Fewer than MIN_DRAWN_VERTICES ABANDONS — a single click that armed the
     * crosshair and then thought better of it must not leave a ghost item behind.
     * The widget's own `isGhost` says the same thing about the same threshold, so
     * this is that rule applied at the door rather than a second opinion.
     */
    finalize(ctx, session) {
      if (session.points.length < MIN_DRAWN_VERTICES) return;
      ctx.app.addItem({ ...ctx.plugin.defaults, ...polygonFromWorldPoints(session.points, session.closed) });
    },
    /**
     * Pure function. The overlay: the committed chain PLUS the in-progress
     * segment to the pointer (one polyline — `placeLine` covers a single segment,
     * a chain needs the list), a dot on every landed vertex so the count is
     * visible, and the first vertex HOT while a click would close the loop.
     *
     * @example POLYGON_CHAIN_HANDLER.mode.overlay({points: [[0, 0], [10, 0]], live: {x: 10, y: 10}, closed: false, closing: false}).chains[0].points.length // 3
     * @example POLYGON_CHAIN_HANDLER.mode.overlay({points: [[0, 0]], live: null, closed: false, closing: false}).dots // [{x: 0, y: 0, hot: false}]
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
