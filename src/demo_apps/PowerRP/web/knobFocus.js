/**
 * KNOB FOCUS — double-click a module and start playing with the knobs in it
 * (web/widget_handlers.js, phase "activate").
 *
 * ── THE FOUNDING ASK (user, 2026-08-02, verbatim) ───────────────────────────
 * "we'll have knobs on them that I can... If I double click the module, I can
 * start playing with the knobs in it"
 *
 * ── THE GESTURE GRAMMAR ─────────────────────────────────────────────────────
 *   DOUBLE-CLICK a node      enter knob focus on THAT node
 *   PRESS + DRAG a dial      turn it; UP is more, down is less
 *   hold the FINE modifier   the same travel moves an eighth as far
 *   PRESS the node's body    nothing (the node does not move: see below)
 *   PRESS a port BEAD        the wire gesture, exactly as outside the mode
 *   PRESS empty canvas       leave
 *   ESCAPE                   leave
 *
 * A release commits ONE undo unit, through setPreview/commitPreview — the house
 * seam — so a turn is keyframed on the current slide like any other property
 * edit, undone in one Cmd+Z, and picked up by web/audioMirror.svelte.js as an
 * ordinary state change (its diff turns it into a `setParam` with the engine's
 * own ramp, which is why an audible parameter glides rather than steps).
 *
 * ── WHY THE MODE DECLARES `onPick` AND NOT ONLY `onPan` ─────────────────────
 * `onPan` alone would give the mode every press as a drag, and CanvasView's own
 * select/move machinery would never see one. That is right for the DIAL and
 * wrong for everything else: a press on empty canvas has to be able to end the
 * mode, and — the part that is a user ruling rather than a preference — a press
 * on a PORT BEAD has to remain a wire gesture. The founding message: a bead is
 * drag-active "even if it's not selected", and wave 2's delete-gesture incident
 * is the recorded cost of a selection-only affordance covering one
 * ("a selection-only affordance may not cover an always-active bead"). So the
 * mode takes `onPick`, decides what the press LANDED on, and only then opens a
 * drag on its own terms.
 *
 * THE ORDER OF THAT DECISION IS THE WHOLE CONTRACT, and it is stated once in
 * `knobPressKind` so it can be tested in bare node without a browser:
 *     BEAD  >  DIAL  >  ELSEWHERE
 * The bead wins first because it is the always-active layer. The dial wins next
 * because it is why you are in the mode. Everything else exits.
 *
 * ── WHY THE NODE DOES NOT MOVE INSIDE THE MODE ──────────────────────────────
 * Outside knob focus, dragging a node's body moves it — that is ADDENDUM 6's "I
 * want to be able to grab nodes and move them". Inside it, a body press does
 * nothing but exit. The reason is that the two gestures are the same press over
 * the same pixels, and a mode that sometimes moved the node and sometimes turned
 * a knob depending on a 13px radius would make both feel unreliable. Knob focus
 * is a short, deliberate state you enter to turn something and leave; moving is
 * what the canvas does the rest of the time. Escape or a click on empty canvas
 * gets you back in one gesture.
 *
 * ── A BOUND KNOB IS REFUSED, NOT SILENTLY OVERWRITTEN ───────────────────────
 * If a knob holds an `=` equation, turning it would replace the equation with
 * the number it currently evaluates to and destroy the binding. That is the
 * ruling web/interiorNav.js already made for exactly this situation, applied
 * verbatim rather than reinvented: the dial still SHOWS where the bound value
 * sits (core/node_knobs.knobLayout marks it `bound`), and the press reports why
 * it will not turn.
 *
 * DOM-free at import: pure functions plus one descriptor, so the decision table
 * and the write are covered in bare node by tests/knob_focus_test.js.
 */

import { portAt } from "../core/nodeflow.js";
import { knobAt, knobDragValue, knobReadout } from "../core/node_knobs.js";
import { reportAction } from "../core/report.js";

/**
 * Pure function. WHAT A PRESS INSIDE KNOB FOCUS LANDED ON — the mode's whole
 * decision, in one place, over LOCAL coordinates.
 *
 * Returns one of:
 *   {kind: "bead", port}   a port bead: the caller must leave the press alone so
 *                          the always-active wire layer gets it
 *   {kind: "knob", knob}   a dial: open a turn gesture
 *   {kind: "exit"}         anywhere else, including the node's own body
 *
 * `tol` is the caller's screen slop converted to local units, exactly as
 * core/nodeflow.portAt takes it — only the caller knows the zoom.
 *
 * @param {object} plugin - the node's plugin (its ports and its knobLayout)
 * @param {object} state - the folded item state
 * @param {number} lx - LOCAL x of the press
 * @param {number} ly - LOCAL y of the press
 * @param {number} [tol] - extra grab radius in LOCAL units
 * @returns {{kind: string, port?: object, knob?: object}}
 *
 * @example // P is a node with one input bead at (0, 34) and one dial at (75, 73)
 * @example knobPressKind({ports: () => ({inputs: [{key: "in", type: "audio"}]})}, {w: 150, h: 160}, 0, 34, 0).kind // "bead"
 * @example // the BEAD WINS even when a dial is also in range — the always-active layer
 * @example knobPressKind({ports: () => ({inputs: [{key: "in", type: "audio"}]}), knobLayout: () => [{key: "q", cx: 2, cy: 34, min: 0, max: 1, value: 0, fraction: 0}]}, {w: 150, h: 160}, 0, 34, 0).kind // "bead"
 * @example // with no bead in range the dial takes it
 * @example knobPressKind({knobLayout: () => [{key: "q", cx: 75, cy: 73, min: 0, max: 1, value: 0, fraction: 0}]}, {w: 150, h: 160}, 75, 73, 0).kind // "knob"
 * @example // and the node's own body is an EXIT, not a move
 * @example knobPressKind({knobLayout: () => [{key: "q", cx: 75, cy: 73, min: 0, max: 1, value: 0, fraction: 0}]}, {w: 150, h: 160}, 20, 130, 0).kind // "exit"
 */
export function knobPressKind(plugin, state, lx, ly, tol = 0) {
  const port = portAt(plugin, state, lx, ly, tol);
  if (port) return { kind: "bead", port };
  const knob = knobAt(plugin.knobLayout?.(state) ?? [], lx, ly, tol);
  if (knob) return { kind: "knob", knob };
  return { kind: "exit" };
}

/**
 * Pure function. Why a knob cannot be turned, or null when it can.
 *
 * @param {object} knob - a knobLayout record
 * @param {string} nodeName - the node's display name, for the sentence
 * @returns {string|null}
 *
 * @example knobTurnRefusal({key: "cutoff", label: "Cutoff", bound: false}, "Filter") // null
 * @example // knobTurnRefusal({label: "Cutoff", bound: true}, "Filter")
 * @example //   → 'Filter\'s Cutoff is an = equation — turning the knob would overwrite it with the value it currently evaluates to. Clear the equation in the Inspector to turn this knob, or animate it through the equation instead.'
 * @example knobTurnRefusal({label: "Cutoff", bound: true}, "Filter").includes("= equation") // true
 */
export function knobTurnRefusal(knob, nodeName) {
  if (!knob.bound) return null;
  return `${nodeName}'s ${knob.label} is an = equation — turning the knob would overwrite it with the value it currently evaluates to. Clear the equation in the Inspector to turn this knob, or animate it through the equation instead.`;
}

/**
 * Pure function. The setPreview pair a knob turn writes — ONE property, on the
 * item, at its flat state key.
 *
 * `stateKey` rather than the knob's engine name is what makes this an ORDINARY
 * property write: `audioCutoff` is a plain numeric leaf, so the write is
 * keyframed, undoable, equation-compatible and mirror-visible with no
 * audio-specific code anywhere on the path (core/audio_nodes.audioKnobKey states
 * why knobs are stored flat).
 *
 * @param {string} itemId - the node's item id
 * @param {string} stateKey - the flat item-state key (e.g. "audioCutoff")
 * @param {number} value - the new value
 * @returns {[string[], number][]} setPreview pairs
 *
 * @example knobWritePairs("n1", "audioCutoff", 820) // [[["items", "n1", "audioCutoff"], 820]]
 */
export function knobWritePairs(itemId, stateKey, value) {
  return [[["items", itemId, stateKey], value]];
}

/**
 * Pure function. The flat item-state key a knob writes to.
 *
 * Duplicated from core/audio_nodes.audioKnobKey ON PURPOSE, in three lines,
 * rather than imported: this file is in web/ and must stay usable by a future
 * NON-AUDIO node family that declares `knobLayout` (materials and shapes are
 * coming — ADDENDUM 1), which would have its own prefix. When that happens the
 * key belongs ON the layout record and this function goes away; until then a
 * dependency from the general mode onto the audio module would be exactly the
 * coupling ADDENDUM 1 asks us not to build.
 *
 * @param {string} key - the knob's own name
 * @returns {string} the item-state key
 *
 * @example knobStateKey("cutoff") // "audioCutoff"
 * @example knobStateKey("Q") // "audioQ"
 */
export function knobStateKey(key) {
  return "audio" + key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * THE LIVE TURN, or null. Module scratch exactly like web/lightPositionPin.js's
 * `hoverId`: at most one can exist (there is at most one `app.canvasMode`), it
 * is reassigned on every entry and cleared on every exit, and it is never
 * written to the document — a gesture in flight is not state.
 *
 * `{key, stateKey, startValue, startLocal, knob, value}`.
 */
let turning = null;

/** The knob the pointer is hovering, or null — what wears the focus ring when
 *  nothing is being turned. Same scratch discipline as `turning`. */
let hoverKey = null;

/** Query. The live turn record, or null. Read by the overlay and the tests. */
export function currentTurn() {
  return turning;
}

/** Query. The hovered knob's key, or null. Read by the overlay and the tests. */
export function currentHoverKey() {
  return hoverKey;
}

/** Command. Drop all transient knob state — called on entry and on exit so a
 *  mode never inherits the previous one's pointer. */
export function resetKnobFocus() {
  turning = null;
  hoverKey = null;
}

/**
 * Query. The `{focusKey, activeKey}` the overlay paints with — the transient
 * half of core/node_chrome.knobOps's `ui` argument, for the node the mode is
 * live on.
 *
 * Returns `{}` for any OTHER node, which is what keeps the ring on the one node
 * you are editing rather than on every module in the patch.
 *
 * @param {string|null} itemId - the node being painted
 * @param {string|null} modeItemId - the node knob focus is live on
 * @returns {{focusKey?: string|null, activeKey?: string|null}}
 *
 * @example knobFocusUi("a", "b") // {}
 * @example knobFocusUi(null, null) // {}
 */
export function knobFocusUi(itemId, modeItemId) {
  if (!itemId || itemId !== modeItemId) return {};
  return { focusKey: hoverKey, activeKey: turning?.key ?? null };
}

export const KNOB_FOCUS_HANDLER = {
  id: "knob_focus",
  phase: "activate",
  label: "Turn knobs",
  /** Pure function. `knobLayout` is this handler's CONTENT declaration: a widget
   *  that has dials wants this trigger. Read ONLY by widget_handlers.migrationPlan,
   *  so a widget shipping the declaration and forgetting `activate: "knob_focus"`
   *  fails the suite rather than silently losing the mode.
   *  @example KNOB_FOCUS_HANDLER.claims({knobLayout: () => []}) // true
   *  @example KNOB_FOCUS_HANDLER.claims({type: "rect"}) // false */
  claims(plugin) {
    return !!plugin.knobLayout;
  },
  /** Command. Enters knob focus on the double-clicked module. */
  run(ctx) {
    resetKnobFocus();
    ctx.app.selection = ctx.node.itemId;
    ctx.enterMode();
  },
  mode: {
    label: "Turn knobs",
    hints: [
      { keys: ["mouse_left"], label: "Drag a knob to turn it — up is more" },
      { keys: ["shift", "mouse_left"], label: "Fine control" },
    ],
    /**
     * Query (mutates the module hover; writes NOTHING). Stages the dial under
     * the pointer so it can wear the focus ring BEFORE the press, which is what
     * makes "this is grabbable" visible. Returns whether the ring moved, so the
     * host repaints only on a crossing rather than per pixel.
     *
     * Suppressed while a turn is live: during a drag the ring belongs to the
     * knob being turned, and the pointer has usually travelled off it.
     */
    onHover(ctx, pick) {
      if (turning) return false;
      const kind = knobPressKind(ctx.plugin, ctx.node.state, pick.local.x, pick.local.y, 0);
      const next = kind.kind === "knob" ? kind.knob.key : null;
      if (next === hoverKey) return false;
      hoverKey = next;
      return true;
    },
    /** Command (mutates the module hover). The pointer left the canvas; a ring
     *  must not outlive the pointer that asked for it. */
    onHoverLeave() {
      if (hoverKey === null) return false;
      hoverKey = null;
      return true;
    },
    /**
     * Command. THE PRESS. Routes by knobPressKind and does exactly one of three
     * things — open a turn, refuse a bound knob, or leave.
     *
     * A BEAD PRESS RETURNS "release", the verdict that hands the press back to
     * the canvas untouched, and that is the interesting case: knob focus does
     * NOT exit, so the always-active wire layer runs inside the mode exactly as
     * it does outside it. That is what the founding message's "even if it's not
     * selected" requires, and it is the lesson wave 2's delete-gesture incident
     * recorded — a selection-only (or here, a mode-only) affordance may not
     * cover the bead.
     *
     * Returns the host verdict: "drag" opens the turn, "release" declines the
     * press, and undefined consumes it with nothing further.
     */
    onPick(ctx, pick) {
      const { app, node, plugin } = ctx;
      const kind = knobPressKind(plugin, node.state, pick.local.x, pick.local.y, 0);
      if (kind.kind === "bead") return "release";
      if (kind.kind === "exit") {
        resetKnobFocus();
        app.exitCanvasMode();
        return;
      }
      const refusal = knobTurnRefusal(kind.knob, app.displayName(node.itemId));
      if (refusal) {
        reportAction(`PowerRP: ${refusal}`);
        return;
      }
      hoverKey = kind.knob.key;
      turning = {
        key: kind.knob.key,
        stateKey: knobStateKey(kind.knob.key),
        startValue: kind.knob.value,
        startLocal: { x: pick.local.x, y: pick.local.y },
        knob: kind.knob,
        value: kind.knob.value,
      };
      return "drag";
    },
    /**
     * Command. THE TURN. Stages one property write per move; the host commits
     * once on release, so the whole gesture is ONE undo unit.
     *
     * The travel is measured from the GRAB rather than accumulated per event
     * (core/node_knobs.knobDragValue states why: an accumulating gesture that
     * clamps at an end stop feels stuck when it reverses). That is why this
     * takes the CURRENT local point rather than the frame's delta.
     */
    onPan(ctx, pan) {
      if (!turning) return;
      const value = knobDragValue(turning.knob, turning.startValue, pan.localY - turning.startLocal.y, pan.fine);
      // NOTHING IS WRITTEN WHEN NOTHING CHANGED. A knob with a coarse step sits
      // on the same value across many pointermoves, and re-staging an identical
      // preview per move is the per-pixel invalidation the hover hook is
      // careful to avoid, one gesture over.
      if (value === turning.value) return;
      turning.value = value;
      ctx.app.setPreview(knobWritePairs(ctx.node.itemId, turning.stateKey, value));
    },
    /**
     * Command. Release ends the turn. The host has already called
     * commitPreview (endModeGesture does it for every mode), so this only drops
     * the gesture record — and REPORTS the landing value, because a dial is a
     * coarse readout and the number is worth having said once.
     */
    onPanEnd(ctx) {
      if (!turning) return;
      const { knob, value, startValue } = turning;
      turning = null;
      if (value === startValue) return;
      reportAction(`PowerRP: ${ctx.app.displayName(ctx.node.itemId)} ${knob.label} = ${knobReadout(knob, value)}`);
    },
    // NO `onExit` HOOK, DELIBERATELY. A mode can be left by Escape, by a slide
    // change, by the item being purged, and by entering the presenter — four
    // paths through app.exitCanvasMode(), which is in the store and has no way
    // to reach a handler descriptor. Rather than grow a fifth mechanism for it,
    // the transients are cleared on ENTRY (`run` calls resetKnobFocus) and the
    // overlay reads them through knobFocusUi, which returns {} for any node the
    // mode is not live on. So a stale hover cannot paint: there is no node it
    // would paint on. Clearing on entry is idempotent and covers every exit path
    // including the ones that do not run any code of ours.
  },
};
