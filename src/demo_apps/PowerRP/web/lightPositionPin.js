/**
 * LIGHT-POSITION EYEDROPPER — pins a widget's world-space light position (lens
 * flare's / god rays' `lightWorldX`/`lightWorldY`, core/properties.js's "light
 * position" row pair) to ANOTHER item's CENTER, live (web/widget_handlers.js,
 * phase "activate"). User's verbatim ask: "click it and then click the sun, and
 * it will set the light position to that object's center."
 *
 * ── A LIVE PIN, NOT A SNAPSHOT ────────────────────────────────────────────────
 * The write is two EQUATIONS — `@<id>.cx` / `@<id>.cy` (core/expressions.js's
 * `cx`/`cy`, the DERIVED box-center shortcut; core/geometry.js boxCenter) — not
 * the target's current coordinates copied once. So the flare tracks the target
 * for as long as the equation stands, exactly like bind-to-camera and the
 * bento-cell binding (web/bentoBind.js) already do for x/y; this is the same
 * mechanism aimed at a DIFFERENT pair of properties. Clearing either equation in
 * the Inspector un-pins that axis, same as any other bound property.
 *
 * ── WHY `@id.cx`, NOT A SLUG STRING ───────────────────────────────────────────
 * The user's phrasing was "= <slug>.cx", but the STORED form is always the
 * rename-proof `@itemId` reference (core/expressions.js displayToStored) — the
 * Inspector still SHOWS it as "= sun.cx" (storedToDisplay resolves the live
 * slug), so nothing about the visible behavior differs; only the on-disk
 * representation survives a rename. No leading "=" marker either: lightWorldX/Y
 * default to a bare `self.anchors...` expression, which makes them "legacy
 * numeric slots" in core/expressions.js's isNumericSlot (any string is already
 * an equation there) — the same convention x/y and bind-to-camera use.
 *
 * ── THE DECLARATIVE ROW ASPECT ────────────────────────────────────────────────
 * A widget opts a light-position PAIR into the eyedropper by adding one field to
 * its X row: `pinLight: {xKey, yKey}` (see plugins/demo/lens_flare.js /
 * god_rays.js). web/Inspector.svelte reads it to render the eyedropper button
 * beside the pair — one declaration, so the next world-position pair a widget
 * adds gets the affordance for free rather than being hand-wired.
 *
 * ── SELF-PICK AND THE CAMERA ──────────────────────────────────────────────────
 * Picking the widget itself is refused (self.cx / self.cx would cycle: the
 * light's own position would depend on the light's own box, which depends on
 * nothing meaningful — and world/local math aside, a widget lighting itself from
 * its own center is not a coherent request). Picking the CAMERA is ALLOWED: it
 * is an ordinary item with x/y/w/h (only `purgeable:false`), so `camera.cx`
 * resolves exactly like any bbox item's, and a screen-centered flare is a
 * sensible thing to want. No special case is coded for it — the refusal below
 * is the one and only gate, and the camera simply does not trip it.
 *
 * ── WHAT ELSE IS REFUSED ──────────────────────────────────────────────────────
 * A target with no CENTER to bind to — a widget with no `w`/`h` (an endpoint-pair
 * arrow/line: core/expressions.js numericPropertyPaths only offers cx/cy to a
 * BBOX plugin). Mirrors bento's bindRefusal precedent: read straight off the
 * plugin's OWN declared shape, never a type list, so a future bbox widget needs
 * no edit here to become pinnable.
 *
 * DOM-free at import: pure functions + one descriptor, so tests/light_pin_test.js
 * covers the whole write in bare node.
 */

import { reportAction } from "../core/report.js";
import * as T from "../core/transform.js";

/**
 * Pure function. The stored equation for one axis of a center-pin: the DERIVED
 * `cx`/`cy` shortcut on the target item, in the `@id` reference form every other
 * equation writer in this codebase uses (core/expressions.js displayToStored;
 * web/bentoBind.js centreOnAnchorExpr is the sibling precedent for `x`/`y`).
 *
 * @param {string} targetId - the item whose center the light should track
 * @param {"cx"|"cy"} axis - which derived center shortcut
 * @returns {string} the stored equation, e.g. "@ab12cd34.cx"
 *
 * @example centerPinExpr("ab12cd34", "cx") // "@ab12cd34.cx"
 * @example centerPinExpr("ab12cd34", "cy") // "@ab12cd34.cy"
 */
export function centerPinExpr(targetId, axis) {
  return `@${targetId}.${axis}`;
}

/**
 * Pure function. The setPreview path/value pairs that pin `itemId`'s light
 * position to `targetId`'s center — BOTH axes, written together as the caller's
 * ONE undo unit (half a pin, X bound and Y loose, is not a state this feature
 * should ever leave behind).
 *
 * @param {string} itemId - the lens-flare/god-rays item being pinned
 * @param {{xKey: string, yKey: string}} pin - the row aspect naming the two state keys
 * @param {string} targetId - the item to pin onto
 * @returns {[string[], string][]} setPreview pairs
 *
 * @example centerPinPairs("flare1", {xKey: "lightWorldX", yKey: "lightWorldY"}, "sun1")
 * // [[["items", "flare1", "lightWorldX"], "@sun1.cx"], [["items", "flare1", "lightWorldY"], "@sun1.cy"]]
 */
export function centerPinPairs(itemId, pin, targetId) {
  return [
    [["items", itemId, pin.xKey], centerPinExpr(targetId, "cx")],
    [["items", itemId, pin.yKey], centerPinExpr(targetId, "cy")],
  ];
}

/**
 * Pure function. The `pinLight: {xKey, yKey}` row aspect declared on one of a
 * plugin's inspector rows (plugins/demo/lens_flare.js / god_rays.js's Light X
 * row), or null when the plugin declares none. A QUERY over the plugin's own
 * shape rather than a hardcoded key list, so a future widget's light-position
 * pair is found the same way its Inspector row already is.
 *
 * @param {{inspector?: object[]}} plugin
 * @returns {{xKey: string, yKey: string}|null}
 *
 * @example pinLightAspect({inspector: [{key: "lightWorldX", pinLight: {xKey: "lightWorldX", yKey: "lightWorldY"}}]})
 * // {xKey: "lightWorldX", yKey: "lightWorldY"}
 * @example pinLightAspect({inspector: [{key: "x"}]}) // null
 */
export function pinLightAspect(plugin) {
  return plugin.inspector?.find((row) => row.pinLight)?.pinLight ?? null;
}

/**
 * Pure function. Why `targetId` cannot be pinned as `pinnerId`'s light source —
 * or null when it can. Split out from the write so the refusal is testable in
 * bare node and reads as one list of reasons (the bindRefusal precedent).
 *
 * @param {object} targetNode - the picked render node ({itemId, plugin, ...})
 * @param {string} pinnerId - the light-owning widget's own item id
 * @param {string} pinnerName - the light-owning widget's display name (for the message)
 * @returns {string|null}
 *
 * @example lightPinRefusal({itemId: "f1", plugin: {defaults: {}}}, "f1", "Lens Flare") // 'Lens Flare cannot pin its own light to itself — that would make its light position depend on itself.'
 * @example lightPinRefusal({itemId: "sun1", plugin: {defaults: {x: 0, y: 0, w: 10, h: 10}}}, "f1", "Lens Flare") // null
 * @example // lightPinRefusal({itemId: "a1", plugin: {type: "arrow", defaults: {from: {}}}}, "f1", "Lens Flare")
 * @example //   → 'Arrow has no box — it is positioned by its own endpoints, so it has no center to pin to.'
 */
export function lightPinRefusal(targetNode, pinnerId, pinnerName) {
  if (targetNode.itemId === pinnerId)
    return `${pinnerName} cannot pin its own light to itself — that would make its light position depend on itself.`;
  const d = targetNode.plugin.defaults;
  if (typeof d.w !== "number" || typeof d.h !== "number")
    return `${targetNode.plugin.title ?? targetNode.plugin.type} has no box — it is positioned by its own endpoints, so it has no center to pin to.`;
  return null;
}

/**
 * Pure function. A picked node's own WORLD-space box corners, closed, in the
 * `{chains, rects, dots}` overlay shape CanvasView paints (web/bentoBind.js
 * cellMarks' sibling for a plain bbox rather than a cell): rotation-safe,
 * unlike the `rects` overlay primitive, which is axis-aligned in WORLD space and
 * would misdraw a rotated target — exactly why cellMarks maps corners through
 * `T.apply(world, …)` instead of using `rects`.
 *
 * @param {(x: number, y: number) => {x: number, y: number}} toWorld - node.world's T.apply, bound
 * @param {{w?: number, h?: number}} state - the node's local state (box size)
 * @param {boolean} hot - true = the committed pick, false = a hover candidate
 * @returns {{chains: object[], rects: object[], dots: object[]}}
 *
 * @example // with toWorld = identity: nodeBoxMarks((x, y) => ({x, y}), {w: 10, h: 20}, true).chains[0].points
 * @example // → [[0, 0], [10, 0], [10, 20], [0, 20]]
 */
export function nodeBoxMarks(toWorld, state, hot) {
  const w = state.w ?? 0, h = state.h ?? 0;
  const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => {
    const p = toWorld(x, y);
    return [p.x, p.y];
  });
  return { chains: [{ points: corners, closed: true }], rects: [], dots: [] };
}

/**
 * Pure function. Concatenates `{chains, rects, dots}` overlays into one — the
 * mergedOverlay precedent (web/bentoBind.js), duplicated rather than imported
 * because importing bento's copy for an unrelated mode would couple two
 * independent activate handlers for a four-line function.
 *
 * @param {{chains: object[], rects: object[], dots: object[]}[]} parts
 * @returns {{chains: object[], rects: object[], dots: object[]}}
 *
 * @example mergedOverlay([]) // {chains: [], rects: [], dots: []}
 * @example mergedOverlay([{chains: [1], rects: [], dots: []}, {chains: [2], rects: [], dots: [3]}]) // {chains: [1, 2], rects: [], dots: [3]}
 */
export function mergedOverlay(parts) {
  return {
    chains: parts.flatMap((p) => p.chains),
    rects: parts.flatMap((p) => p.rects),
    dots: parts.flatMap((p) => p.dots),
  };
}

/**
 * THE LIVE HOVER — the itemId a press would pin onto right now, or null. Module
 * scratch exactly like web/bentoBind.js's `hover`: at most one lives at a time
 * (there is at most one `app.canvasMode`), reassigned on every entry, and never
 * written to the document — a hover is a question.
 */
let hoverId = null;

/** Query. The live hover candidate's itemId, or null. Read by the tests. */
export function currentHoverId() {
  return hoverId;
}

export const LIGHT_POSITION_PIN_HANDLER = {
  id: "pin_light_position",
  phase: "activate",
  label: "Pin light to object",
  // No `claims`: this mode is never entered through the double-click dispatch
  // (web/widget_handlers.js activationContext.enterMode) — the Inspector's
  // eyedropper button calls app.enterCanvasMode(id, itemId) directly, since the
  // gesture starts on a PROPERTY ROW, not on the widget itself. So there is
  // nothing for widget_handlers.migrationPlan to ever flag here, correctly:
  // lens_flare/god_rays declare no `activate` string and need none.
  mode: {
    label: "Pin light to object",
    hints: [{ keys: ["mouse_left"], label: "Click the object to pin the light to" }],
    cursors: ["cell"], // CSS's own "select a target" cursor — the AIM half of bentoBind's vocabulary; there is no second step to need "alias"
    /**
     * Query (mutates the module hover; writes NOTHING). Stages the hovered
     * widget as the pin candidate — null over empty canvas or the pinner
     * itself, matching what a press there would do (nothing). Returns whether
     * the candidate CHANGED, so the host repaints only on a widget crossing.
     */
    onHover(ctx, pick) {
      const next = (pick.node && pick.node.itemId !== ctx.node.itemId) ? pick.node.itemId : null;
      if (next === hoverId) return false;
      hoverId = next;
      return true;
    },
    /** Command (mutates the module hover). Pointer left the canvas. */
    onHoverLeave() {
      if (hoverId === null) return false;
      hoverId = null;
      return true;
    },
    /** Query (reads the module hover). The committed pinner's own box, plus the
     *  hovered target's box when one is live — both rotation-safe world outlines. */
    overlay(ctx) {
      const { node } = ctx;
      const parts = [nodeBoxMarks((x, y) => T.apply(node.world, x, y), node.state, true)];
      if (hoverId) {
        const targetNode = ctx.app.nodes().find((n) => n.itemId === hoverId);
        if (targetNode) parts.push(nodeBoxMarks((x, y) => T.apply(targetNode.world, x, y), targetNode.state, false));
      }
      return mergedOverlay(parts);
    },
    /**
     * Command (ONE undo unit, or NOTHING — and always exits). A press on empty
     * canvas exits quietly (the file docstring's "quiet hint", via the console
     * report rather than a modal); a refused target reports why and exits
     * without writing; a valid target writes both equations as one undo unit.
     * Exiting unconditionally (rather than staying live for another try) mirrors
     * an eyedropper's own one-shot convention and matches the brief's "a second
     * eyedropper click cancels" — a completed pick and a cancel both end the mode.
     */
    onPick(ctx, pick) {
      const { app, node } = ctx;
      hoverId = null;
      if (!pick.node) {
        reportAction(`PowerRP: Pin light to object cancelled — clicked empty canvas. ${app.displayName(node.itemId)}'s light position is unchanged.`);
        app.exitCanvasMode();
        return;
      }
      const refusal = lightPinRefusal(pick.node, node.itemId, app.displayName(node.itemId));
      if (refusal) {
        reportAction(`PowerRP: Pin light to object refused — ${refusal} Nothing was changed.`);
        app.exitCanvasMode();
        return;
      }
      app.setPreview(centerPinPairs(node.itemId, pinLightAspect(node.plugin), pick.node.itemId));
      app.commitPreview();
      app.exitCanvasMode();
    },
  },
};
