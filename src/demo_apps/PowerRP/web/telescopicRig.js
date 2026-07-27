/**
 * TELESCOPIC MAGNIFIER PLACEMENT — the two-drag creation mode for the zoom-callout
 * rig (web/widget_handlers.js, phase "create"; the step-sequencing contract lives
 * in web/creationSteps.js).
 *
 * The user's request (#189): "Why does telescopic magnifier not let me click and
 * drag where I want to create it? … I first click and drag to create the first one
 * and then I click and drag again to create the second one. And of course the tools
 * on the bottom should tell me that's what's going on."
 *
 * So: TWO box drags — the region to magnify, then where the magnified view appears
 * — and a HintBar that names which one you are on. Both halves are the same step
 * mechanism the polygon's click-click-click uses; only the step list differs (two
 * fixed "box" steps instead of one repeating "point" step), which is the whole
 * reason that mechanism exists rather than two bespoke flows.
 *
 * ── WHY A RIG NEEDS ITS OWN ARM ───────────────────────────────────────────────
 * Every other creation places ONE widget, so `app.armCrosshairPlacement(plugin)`
 * carries the plugin and the create phase resolves the handler the plugin
 * DECLARES. This rig is THREE items of three different types wired by `=`
 * equations (an outline marker, a demo_magnify lens, a tangent_lines bridge), so
 * it has no plugin of its own to declare anything — no widget type means "a
 * telescopic magnifier". The command that mints it therefore names the flow
 * itself: `app.armCrosshairRig("telescopic_rig", {shapeKind})`. The plugin
 * declaration stays THE rule for widgets; this is the rig exception, and it is
 * one method rather than an override channel on the widget path so no existing
 * caller changes shape.
 *
 * ── WHAT THE TWO BOXES MEAN ───────────────────────────────────────────────────
 * The rig is a function of the shared tween variable `t`: at t=0 the lens sits on
 * the source at magnification 1 (identity), at t=1 it IS the second box. So box 1
 * is the source marker exactly, and box 2 is the lens AT FULL PULL-OUT — which is
 * what "drag where the magnified view goes" means, and it is why the builders now
 * take rects (plugins/tangent_lines.js telescopicLensOverrides).
 */

import { telescopicDefaultRects } from "../plugins/tangent_lines.js";
import { currentStepIndex, validatedSteps } from "./creationSteps.js";

/** How many boxes the rig needs before it can be built. */
const RIG_BOXES = 2;

/**
 * The declared steps. Each is a box DRAG, and each carries the fallback extent a
 * plain CLICK places (centred on the click point) — taken from the rig's OWN
 * shipped default rects rather than an invented constant, the same
 * linked-precedent rule the "endpoints" handler follows for a clicked arrow's
 * length. Both read Shift/Cmd, because a box step runs the shared creationRect
 * math; the chips come from that declaration.
 */
const RIG_STEPS = validatedSteps("telescopic_rig", [
  {
    gesture: "box",
    hint: "Drag the region to magnify",
    modifiers: ["uniform", "symmetric"],
    clickSize: { w: telescopicDefaultRects().source.w, h: telescopicDefaultRects().source.h },
  },
  {
    gesture: "box",
    hint: "Now drag where the magnified view goes",
    modifiers: ["uniform", "symmetric"],
    clickSize: { w: telescopicDefaultRects().lens.w, h: telescopicDefaultRects().lens.h },
  },
]);

/**
 * THE HANDLER. Registered in web/widget_handlers.js; the two "Telescopic
 * Magnifier" commands arm it with their shapeKind.
 */
export const TELESCOPIC_RIG_HANDLER = {
  id: "telescopic_rig",
  phase: "create",
  label: "Place telescopic magnifier",
  /** Command. The crosshair's first press hands the gesture here and the host
   *  enters the mode (the POLYGON_CHAIN_HANDLER note applies verbatim). */
  place(ctx) {
    ctx.enterMode();
  },
  mode: {
    label: "Place telescopic magnifier",
    steps: RIG_STEPS,
    hints: [],
    // No `finish` key: the sequence is a FIXED length, so it finalizes itself on
    // the second release. Enter would have nothing left to confirm, and offering
    // it would put a chip on the bar for a key that does nothing.
    /** Command (allocates). A fresh session: no boxes yet, no live box. */
    begin() {
      return { rects: [], live: null };
    },
    /** Pure function. Which box is being dragged.
     *  @example TELESCOPIC_RIG_HANDLER.mode.step({rects: []}) // 0
     *  @example TELESCOPIC_RIG_HANDLER.mode.step({rects: [{x: 0, y: 0, w: 1, h: 1}]}) // 1 */
    step(session) {
      return currentStepIndex(RIG_STEPS, session.rects.length);
    },
    /** Command (mutates the session's live field only). The host hands over the
     *  live box of an in-flight drag (null while the pointer is merely hovering,
     *  which draws nothing extra — the crosshair is the hover affordance). */
    onHover(session, p) {
      session.live = p.rect;
    },
    /** Command (mutates the session; may request finalize). One finished box.
     *  The rig is complete at RIG_BOXES, so the second release builds it. */
    onStep(ctx, session, p) {
      session.rects = [...session.rects, p.rect];
      session.live = null;
      if (session.rects.length >= RIG_BOXES) ctx.finish();
    },
    /** Command (ONE undo unit, or nothing at all). Builds the rig from the two
     *  placed boxes. Fewer than RIG_BOXES ABANDONS: a rig is only meaningful with
     *  both ends, and half of one would be a stray outline the user did not ask
     *  for (the polygon's under-2-vertices rule, same reasoning). */
    finalize(ctx, session) {
      if (session.rects.length < RIG_BOXES) return;
      ctx.app.insertTelescopicMagnifier(ctx.params.shapeKind, session.rects[0], session.rects[1]);
    },
    /** Pure function. The overlay: every placed box plus the live one, in the
     *  same gray placement skin a single-gesture box placement draws — so the
     *  first box stays on screen as a reference while the second is dragged.
     *  @example TELESCOPIC_RIG_HANDLER.mode.overlay({rects: [{x: 0, y: 0, w: 10, h: 10}], live: null}).rects.length // 1
     *  @example TELESCOPIC_RIG_HANDLER.mode.overlay({rects: [], live: {x: 1, y: 2, w: 3, h: 4}}).rects // [{x: 1, y: 2, w: 3, h: 4}] */
    overlay(session) {
      return {
        chains: [],
        rects: session.live ? [...session.rects, session.live] : [...session.rects],
        dots: [],
      };
    },
  },
};
