/**
 * Arrow widget — endpoints are plain {x, y} pairs whose coordinates, like any
 * numeric property, may be EQUATIONS (THE UNIFICATION): binding an endpoint
 * to an anchor just writes equation strings ("@<itemId>_tm.x") into from/to.
 * By emit time the derivation stage has evaluated every equation, so this
 * plugin only ever sees numbers. Legacy {item, anchor} binding objects are
 * migrated to equation pairs on load (core/expressions.withBindingsMigrated).
 *
 * The arrow has no transform of its own (world == local); shaft drags
 * translate the endpoints directly via the moveBy hook — equation-bound
 * coordinates stay put (they're anchored), free ones translate. The endpoint
 * plumbing (editPoints/moveBy/closestToward + the padded shaft grab) comes
 * from core/endpoints.js — the ONE home shared by all arrow-family widgets.
 *
 * Head parameters (manifest Round 11, "Arrow head parameters"): headLength
 * (tip to base, along the shaft axis) and headWidth (across the base) are
 * INDEPENDENT. The old single `headSize` — really a barb radius at a fixed
 * 0.44 rad flare — was renamed/split; legacy docs migrate via the
 * `legacyKeys` declaration (core/document.withLegacyKeysRenamed applies it
 * at the load boundary; values move verbatim — numbers AND equations).
 *
 * headMode (manifest ARCHITECTURE PLAN #6): none|start|end|both, default
 * "end" (byte-identical to the pre-headMode behavior — no migration needed,
 * a document without the key gets the same rendering via the plugin default).
 * headEnds()/headTriangle()/shaftPullback() are the shared head-geometry
 * helpers (core/endpoints.js) every arrow-family plugin now calls, so the
 * mirrored start-head triangle math is written ONCE, not per plugin.
 *
 * STROKE NAMING MIGRATION (manifest ARCHITECTURE PLAN #6): arrows are
 * line-objects, so color/width become stroke/strokeWidth — aligning with
 * every other stroked shape (rect, circle, donut all use stroke/
 * strokeWidth). Migrated via `legacyKeys`, same declarative mechanism as the
 * headSize rename above; loud per-item console.error comes from the existing
 * withLegacyKeysRenamed call sites (web/main.js, web/app.svelte.js) —
 * nothing in this plugin needs to report anything itself.
 */

import { polyline, polygon } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { endpointPairHooks, hitsShaft, headEnds, headTriangle, shaftPullback, HEAD_MODES, ARROW_ENDPOINT_DEFAULTS, ARROW_STROKE_WIDTH, ARROW_HEAD_WIDTH } from "../core/endpoints.js";

/**
 * Pure function. The LOCAL rect the arrow's INK occupies: the AABB of its two
 * endpoints, padded on every side by the widest of the shaft width and the head
 * width. The arrow has no transform of its own (world == identity), so this is
 * also its world footprint.
 *
 * ONE ink rect, THREE consumers (the plugins/polygon.js polygonInkRect
 * precedent): the effect substrate in emit() below, and — via the `localBounds`
 * declaration — culling plus rubber-band selection (core/view.js localBoundsOf).
 * Before that hook existed the arrow reported NO bounds at all, so it could never
 * be band-selected and never culled however far off-screen it sat, even though
 * this very rect was already being computed for its effects.
 *
 * CONSERVATIVE BY CONSTRUCTION: a head triangle's tip sits ON an endpoint and its
 * base corners sit half a head-width to either side of the shaft axis, while the
 * round-capped shaft reaches half a stroke-width past each endpoint — so a pad of
 * the FULL larger width covers both with room to spare. Over-padding only paints
 * a widget that need not have been painted; under-padding would pop a visible
 * arrow out of view at the canvas edge.
 *
 * @param {object} s - evaluated item state (from / to / strokeWidth / headWidth)
 * @returns {{x: number, y: number, w: number, h: number}} local rect
 *
 * @example arrowInkRect({from: {x: 10, y: 20}, to: {x: 110, y: 60}, strokeWidth: 3, headWidth: 12}) // {x: -2, y: 8, w: 124, h: 64}
 * @example arrowInkRect({from: {x: 0, y: 0}, to: {x: 100, y: 0}, strokeWidth: 40, headWidth: 12}) // {x: -40, y: -40, w: 180, h: 80} (a fat shaft dominates the pad)
 */
export function arrowInkRect(s) {
  return paddedPointsBBox([s.from, s.to], Math.max(s.strokeWidth ?? ARROW_STROKE_WIDTH, s.headWidth ?? ARROW_HEAD_WIDTH));
}

export const arrowPlugin = {
  type: "arrow",
  title: "Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "arrow", z: 1,
    from: { x: 200, y: 300 }, to: { x: 420, y: 300 },
    // stroke width + head geometry: the shared simple-arrow defaults
    // (core/endpoints.js ARROW_ENDPOINT_DEFAULTS — one home for basic/elbow/curved).
    stroke: "#000000", ...ARROW_ENDPOINT_DEFAULTS, opacity: 1,
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // Legacy top-level state keys → their current names. headSize was really
  // the head LENGTH (manifest Round 11); color/width → stroke/strokeWidth
  // (manifest ARCHITECTURE PLAN #6, "arrows are line-objects"). Applied
  // document-wide at the load boundary by core/document.withLegacyKeysRenamed;
  // reported loudly there.
  legacyKeys: { headSize: "headLength", color: "stroke", width: "strokeWidth" },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js): the
  // `endpoints` bundle (from/to/z — equation-aware number fields, dotted keys =
  // nested paths, so the Property Panel shows "@…" bindings as editable
  // equations) + shared stroke/strokeWidth/opacity. Head geometry rows are
  // plugin-specific (an "arrow" extras category), declared here with their help.
  inspector: [
    ...bundle("endpoints"),
    ...props("stroke", "strokeWidth"),
    ...props("opacity"),
    ...bundle("effects"),
    { key: "headLength", label: "Head length", kind: "number", min: 0, category: "arrow", help: "How far the arrowhead extends back from the tip along the shaft, in canvas units." },
    { key: "headWidth", label: "Head width", kind: "number", min: 0, category: "arrow", help: "How wide the arrowhead is across its base, in canvas units." },
    { key: "headMode", label: "Head", kind: "select", options: HEAD_MODES, category: "arrow", help: "Which ends get an arrowhead: none, just the start (tail), just the end (tip), or both." },
  ],
  /**
   * Pure function. State → display-list commands. Endpoints are evaluated
   * numbers, and the arrow's world transform is IDENTITY (no
   * x/y/rotation/scale state), so these local commands are world coordinates.
   * A head triangle is emitted per ACTIVE end (headMode); the shaft's own
   * endpoints pull back only on the ends that have one (shaftPullback).
   */
  emit(s, _targetWorldIR, world) {
    const { from, to } = s;
    const ends = headEnds(s.headMode);
    const opacity = s.opacity ?? 1;
    const pbEnd = shaftPullback(ends.end, s.headLength);
    const pbStart = shaftPullback(ends.start, s.headLength);
    const axisLen = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const ux = (to.x - from.x) / axisLen, uy = (to.y - from.y) / axisLen;
    const shaftFrom = { x: from.x + ux * pbStart, y: from.y + uy * pbStart };
    const shaftTo = { x: to.x - ux * pbEnd, y: to.y - uy * pbEnd };
    const cmds = [polyline({ points: [[shaftFrom.x, shaftFrom.y], [shaftTo.x, shaftTo.y]], width: s.strokeWidth, color: s.stroke, opacity })];
    if (ends.end) cmds.push(polygon({ points: headTriangle(to, from, s.headLength, s.headWidth), fill: s.stroke, opacity }));
    if (ends.start) cmds.push(polygon({ points: headTriangle(from, to, s.headLength, s.headWidth), fill: s.stroke, opacity }));
    // Effects (shadow/bloom/blend — the shared EFFECTS BUNDLE, render_gpu/
    // effects.js) wrap the finished op list; all-off = pass-through. Arrows
    // have no bbox state (world == identity), so the effect region is its ink
    // rect — the SAME rect `localBounds` reports, so the substrate and the
    // cull/band bounds can never disagree about where this widget is.
    return applyEffects(cmds, s, world, arrowInkRect(s));
  },
  // THE BOUNDS PROTOCOL (core/view.js localBoundsOf): an arrow's width and height
  // are just the min/max of its endpoints, so it band-selects and culls like any
  // box widget despite having no w/h state and no resize handles.
  localBounds: arrowInkRect,
  // Effects halo (shadow/bloom spill) extends the cull AABB — core/view.js
  // defaultCanSkip's cullMargin hook. MANDATORY now that an arrow HAS an AABB to
  // be culled by: without it a shadowed arrow just off-view loses its halo.
  cullMargin: effectsCullMargin,
  hitTestWorld(node, wx, wy) {
    return hitsShaft(node.state, wx, wy, node.state.strokeWidth ?? ARROW_STROKE_WIDTH);
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js: draggable endpoint handles, free-coordinate shaft
  // translation, closest-anchor toward-context).
  ...endpointPairHooks(),
  // CROSSHAIR PLACEMENT (manifest UNDEFERRAL SWEEP): an arrow places by its
  // ENDPOINTS — a click-drag lays from→to; a plain click places a
  // default-length arrow rightward from the point (CanvasView.placementUp).
  placement: "endpoints",
  commands: [
    { id: "add-arrow", title: "Add Arrow", icon: "mdi:arrow-top-right", run: (app) => app.armCrosshairPlacement(arrowPlugin) },
  ],
};
