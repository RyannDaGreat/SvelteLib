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
 * HEAD SHAPES, PER END. `headStart` and `headEnd` each name a glyph from
 * core/endpoints.js HEAD_SHAPES — filled or hollow triangle, dart, filled or
 * hollow diamond, circle, cross, open V, crossed circle, and the four ER
 * cardinality marks. They REPLACE the retired `headMode` enum, which named ONE
 * decoration and chose which ends wore it and so structurally could not say
 * "hollow triangle here, filled diamond there" — what UML and ER notation are
 * made of. `headEnd: "triangle"` + `headStart: "none"` IS the old `headMode:
 * "end"`, and core/document.js withHeadModeSplit migrates a stored headMode onto
 * the pair, loudly. arrowHeads() is the shared seam every arrow-family plugin
 * calls, so the glyph geometry and the mirrored start-head math are written
 * ONCE, not per plugin.
 *
 * STROKE NAMING MIGRATION (manifest ARCHITECTURE PLAN #6): arrows are
 * line-objects, so color/width become stroke/strokeWidth — aligning with
 * every other stroked shape (rect, circle, donut all use stroke/
 * strokeWidth). Migrated via `legacyKeys`, same declarative mechanism as the
 * headSize rename above; loud per-item console.error comes from the existing
 * withLegacyKeysRenamed call sites (web/main.js, web/app.svelte.js) —
 * nothing in this plugin needs to report anything itself.
 */

import { polyline, polygon, path } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { endpointPairHooks, hitsShaft, arrowHeads, connectorPathAnchors, dashedSpans, ARROW_HEAD_ROWS, CONNECTOR_DASH_ROWS, CONNECTOR_DASH_DEFAULTS, ARROW_ENDPOINT_DEFAULTS, ARROW_STROKE_WIDTH, ARROW_HEAD_WIDTH } from "../core/endpoints.js";

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
    stroke: "#000000", ...ARROW_ENDPOINT_DEFAULTS, ...CONNECTOR_DASH_DEFAULTS, opacity: 1,
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
    ...ARROW_HEAD_ROWS,
    ...CONNECTOR_DASH_ROWS,
  ],
  /**
   * Pure function. State → display-list commands. Endpoints are evaluated
   * numbers, and the arrow's world transform is IDENTITY (no
   * x/y/rotation/scale state), so these local commands are world coordinates.
   * A head glyph is emitted per decorated end (headStart / headEnd); the shaft's
   * own endpoints pull back only as far as each end's glyph asks (core/endpoints
   * arrowHeads — the pullback is a property of the SHAPE, since a hollow head
   * cannot be tucked into the way a solid one can).
   */
  emit(s, _targetWorldIR, world) {
    const { from, to } = s;
    const opacity = s.opacity ?? 1;
    const heads = arrowHeads(s, { tip: to, from }, { tip: from, from: to });
    const axisLen = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const ux = (to.x - from.x) / axisLen, uy = (to.y - from.y) / axisLen;
    const shaftFrom = { x: from.x + ux * heads.pullback.start, y: from.y + uy * heads.pullback.start };
    const shaftTo = { x: to.x - ux * heads.pullback.end, y: to.y - uy * heads.pullback.end };
    // THE DASHED SHAFT: one polyline per DRAWN run (core/endpoints.js dashedSpans;
    // a solid shaft is the one-run degenerate case, byte-identical to before).
    // Geometry rather than the `dashes` stroke material, and that is measured, not
    // taste: a material stroke is refused by both vector exporters and rasterized,
    // so a dashed arrow would export as a bitmap. See dashedSpans' docblock.
    const runs = s.dashed ? dashedSpans([shaftFrom, shaftTo], s.dashLength, s.dashGap) : [[shaftFrom, shaftTo]];
    const cmds = runs.map((run) => polyline({ points: run.map((p) => [p.x, p.y]), width: s.strokeWidth, color: s.stroke, opacity }));
    // THE LAYERING SEAM (core/endpoints.js arrowHeads): core returns op ARGUMENTS
    // and the plugin builds the op, as plugins/shape.js does with core/shapes.js.
    cmds.push(...heads.ops.map((h) => (h.d ? path(h) : polygon(h))));
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
  // THE ANCHOR PROTOCOL (core/registry.js): start / mid / end ON the drawn shaft,
  // so a mid-edge label has something to bind to. Connectors published NO anchors
  // at all until this — see core/endpoints.js connectorPathAnchors for why they
  // are path points rather than the standard nine over a bounding box.
  anchors: (s) => connectorPathAnchors([s.from, s.to]),
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
