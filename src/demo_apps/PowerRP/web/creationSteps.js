/**
 * CREATION MODES — the step-sequencing half of the widget-handler registry's
 * "create" phase (web/widget_handlers.js).
 *
 * The create phase already covered creations that finish in ONE gesture: drag a
 * box ("bbox"), drag a segment ("endpoints"), drag a box and then prompt for an
 * asset ("bbox_then_asset"). Two requests need creations that finish in SEVERAL:
 *
 *   POLYGON     — click, click, click … then Enter or a double-click.
 *   TELESCOPIC  — drag the region to magnify, then drag where it appears.
 *
 * Those are the SAME shape (a sequence of gestures collected outside the
 * document, committed as ONE undo unit at the end) so they are ONE capability,
 * not two bespoke flows. What differs between them is declared, not coded: the
 * step list, and what each handler does with a finished gesture.
 *
 * ── WHY IT RIDES THE EXISTING `mode` MECHANISM ────────────────────────────────
 * A sustained canvas takeover with context-scoped HintBar hints and an Escape
 * exit is ALREADY built and proven (web/interiorNav.js, the "activate" phase's
 * explore mode): `canvasModes()` enumerates every handler that declares a `mode`,
 * core/shortcut_entries.js turns each one's `hints` into registry entries scoped
 * by `inCanvasMode(handlerId)` and generates its Escape entry, and
 * CanvasView.svelte routes gestures to it while `app.canvasMode` names it. A
 * creation mode is that mechanism with the phase generalized from "activate" to
 * "whatever phase declares it" — no second pathway, and a new creation flow ships
 * with its shortcuts already registered.
 *
 * ── THE MODE CONTRACT (what a create handler declares) ────────────────────────
 *   label            names the mode; the generated Escape entry reads
 *                    "Exit <label.toLowerCase()>" (the interiorNav wording).
 *   steps            [{gesture, hint, modifiers?, repeat?, clickSize?}] — the
 *                    SEQUENCE. `hint` is the mouse_left chip shown WHILE that
 *                    step is current, which is what makes the bar narrate a
 *                    multi-step placement instead of going quiet.
 *   hints            mode-wide display-only inputs (an activate mode's `hints`,
 *                    unchanged in shape) — e.g. "Double-click to finish".
 *   finish           {keys, label} — the DISPATCHABLE finalize key. The generator
 *                    wires it to app.finishCanvasMode(); a flow with no key (none
 *                    today) simply omits it.
 *   begin(params)    → the SESSION: the handler's own scratch record for the
 *                    in-flight creation. The host treats it as OPAQUE.
 *   step(session)    → the current step index (drives the HintBar).
 *   onHover(session, p)      the pointer moved — update the live preview.
 *   onStep(ctx, session, p)  ONE gesture completed. May call ctx.finish().
 *   finalize(ctx, session)   commit as ONE undo unit, or ABANDON (do nothing).
 *   overlay(session) → {chains, rects, dots} in WORLD units, drawn by the host.
 *
 * `p` (the pointer payload, one shape for every hook — see creationPointer).
 * `ctx` = {app, params, finish()}.
 *
 * ── WHY THE SESSION IS NOT DOCUMENT STATE ─────────────────────────────────────
 * Mid-flow NOTHING exists yet: no item, no keyframe, no undo entry, not even a
 * preview (setPreview needs an item to write onto). RenderTree = pure(document,
 * …), so a half-drawn polygon must not be in the document — Escape has to leave
 * the document byte-identical, and it does, because the session never touched it.
 * The chain is drawn by the editor's SVG overlay, exactly like the single-gesture
 * placement rect (`placeRect`) it generalizes.
 *
 * DOM-free at import (pure functions + validation), so tests/creation_modes_test.js
 * covers it in bare node.
 */

/**
 * The gesture kinds a step may collect. A step's kind decides which pointer
 * grammar the host runs and therefore which modifiers are even readable:
 *   "point" — one CLICK. Lands on pointer-DOWN (a vertex should appear under the
 *             finger, not on release), so there is no drag to modify; the only
 *             live modifier is the handler's own constraint against the PREVIOUS
 *             point.
 *   "box"   — one DRAG, through the SAME creationRect math (and therefore the
 *             same Shift/Cmd reading) every single-gesture box placement uses. A
 *             press that never crosses the click slop is a CLICK, and the step's
 *             `clickSize` places that default extent centred on the point — the
 *             "endpoints" precedent of taking the fallback extent from the
 *             widget's own shipped default rather than an invented constant.
 */
export const CREATION_GESTURES = Object.freeze(["point", "box"]);

/**
 * Pure function. Throws unless every step of a creation mode is well-formed:
 * a known gesture, a hint to narrate it with, and (for a repeating step) the
 * LAST position — a step after a repeating one could never be reached, which is
 * the dead-hint class core/shortcut_entries.js's satisfiability guard exists to
 * kill, one layer up.
 *
 * @param {string} handlerId - the declaring handler (named in the throw)
 * @param {object[]} steps - the mode's step list
 * @returns {object[]} the same steps (so callers may validate inline)
 *
 * @example validatedSteps("x", [{gesture: "box", hint: "Drag it", clickSize: {w: 10, h: 10}}]).length // 1
 * @example validatedSteps("x", [{gesture: "point", hint: "Click", repeat: true}])[0].repeat // true
 * @example // validatedSteps("x", [{gesture: "blob", hint: "?"}]) → throws (unknown gesture)
 * @example // validatedSteps("x", [{gesture: "point", hint: "a", repeat: true}, {gesture: "box", hint: "b"}]) → throws (unreachable step)
 * @example // validatedSteps("x", [{gesture: "box", hint: "a"}]) → throws (a box step needs a clickSize)
 */
export function validatedSteps(handlerId, steps) {
  if (!Array.isArray(steps) || steps.length === 0)
    throw new Error(`creation mode "${handlerId}": \`steps\` must be a non-empty array of {gesture, hint} — a creation mode with no step has no gesture to collect.`);
  steps.forEach((s, i) => {
    if (!CREATION_GESTURES.includes(s.gesture))
      throw new Error(`creation mode "${handlerId}" step ${i}: unknown gesture "${s.gesture}" (known: ${CREATION_GESTURES.join(", ")}).`);
    if (!s.hint)
      throw new Error(`creation mode "${handlerId}" step ${i}: no \`hint\` — the HintBar would go silent for this step, which is exactly the defect the step list exists to fix.`);
    if (s.repeat && i !== steps.length - 1)
      throw new Error(`creation mode "${handlerId}" step ${i} repeats but is not the last step — everything after it is unreachable.`);
    // REQUIRED, not defaulted: a press that never crosses the click slop IS a
    // legal gesture (every single-gesture placement accepts one), so a box step
    // that declared no extent for it would place a zero-size box. Making the host
    // invent a size instead would be a silent fallback for a case the widget is the
    // only honest source for — the "endpoints" precedent of reading the fallback
    // extent off the widget's own shipped default.
    if (s.gesture === "box" && !(s.clickSize?.w > 0 && s.clickSize?.h > 0))
      throw new Error(`creation mode "${handlerId}" step ${i}: a "box" step must declare \`clickSize: {w, h}\` (both > 0) — the extent a plain CLICK places, centred on the point. Got ${JSON.stringify(s.clickSize)}.`);
  });
  return steps;
}

/**
 * Pure function. The step a session is on, CLAMPED into the declared list: a
 * repeating final step keeps returning its own index once the sequence runs out,
 * so the bar keeps narrating "click each corner" for the fifth click as it did
 * for the first.
 *
 * @param {object[]} steps - the mode's step list
 * @param {number} index - how many gestures the session has collected
 * @returns {number} a valid index into `steps`
 *
 * @example currentStepIndex([{gesture: "box", hint: "a"}, {gesture: "box", hint: "b"}], 0) // 0
 * @example currentStepIndex([{gesture: "box", hint: "a"}, {gesture: "box", hint: "b"}], 1) // 1
 * @example currentStepIndex([{gesture: "point", hint: "a", repeat: true}], 7) // 0 (a repeating step never runs out)
 * @example currentStepIndex([{gesture: "box", hint: "a"}, {gesture: "box", hint: "b"}], 5) // 1 (clamped — the last gesture is still in flight)
 */
export function currentStepIndex(steps, index) {
  return Math.min(index, steps.length - 1);
}

/**
 * Pure function. The ONE pointer payload every creation-mode hook receives, so a
 * handler never has to know which hook it is in:
 *   world      the SNAPPED world point under the cursor (the host snaps through
 *              the same solveSnap creation placement already uses, so a vertex
 *              COINCIDES with another widget's anchor like every other placement
 *              does — GEOMETRICALLY. It is a corrected NUMBER, not a binding: the
 *              vertex does not follow the anchor if the anchor later moves. This
 *              line used to say "lands on another widget's anchor", which read as
 *              the binding and was not one. Multi-step modes have no bound
 *              placement today; the SEGMENT placement does (CanvasView
 *              placementAnchorBind writes the `@<id>_<anchor>` equation pair when
 *              anchors are visible), and a mode that wants the same must ask for
 *              it through that seam rather than assume this payload carries it)
 *   mods       {uniform, symmetric} — the Shift/Cmd record creationRect and
 *              creationEndpoint are already written against, re-read from the
 *              event EVERY move (never frozen at grab time)
 *   tolerance  the grab radius in WORLD units (screen px ÷ zoom) — what "clicked
 *              the same point" and "clicked the first vertex" mean at this zoom
 *   rect       the live box of a "box" step's in-flight drag, else null
 *
 * @example creationPointer({x: 4, y: 5}, {uniform: false, symmetric: false}, 6, null).tolerance // 6
 * @example creationPointer({x: 0, y: 0}, {uniform: true, symmetric: false}, 6, null).mods.uniform // true
 */
export function creationPointer(world, mods, tolerance, rect) {
  return { world, mods, tolerance, rect };
}
