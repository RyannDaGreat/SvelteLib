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

import { EPHEMERAL } from "../core/ephemeral.js";
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

/**
 * THE SIMPLE ARROW'S PRESET LIBRARY — the head at each end, its proportions, the
 * shaft weight, and whether the shaft is dashed. Nothing else: no colour and no
 * opacity, because the shape is the model and the colour is the user's
 * (plugins/shapeshifter.js's shape presets set neither, and that is the oldest
 * preset table in the app).
 *
 * TWO CLUSTERS IN ONE FLAT LIST, and flat is FORCED rather than chosen: a
 * `presetFamilies` split must write DISJOINT key sets (tests/tool_groups_test.js),
 * and "which relation" and "how heavy" both write the head keys, so any split
 * would overlap and the second pick would silently erase the first.
 *
 *   THE PROPORTION LADDER (rows 1-10) is drafting and presentation. A triangular
 *   head of length L and base width W has included angle 2*atan((W/2)/L), so W/L
 *   is the one number deciding whether a head reads as a technical needle or a
 *   poster chevron: 0.33 is the ASME three-to-one leader, 0.54 is thirty degrees,
 *   1.0 is about fifty-three, and past 1.0 the head is wider than it is long and
 *   stops reading as a point at all.
 *
 *   THE RELATIONS (rows 11-19) became expressible only when heads became per-end
 *   SHAPES and the shaft learned to dash. Every one of them is a fill-and-dash
 *   distinction the single filled triangle structurally could not make: hollow vs
 *   filled triangle is generalization vs a plain arrow, hollow vs filled diamond
 *   is aggregation vs composition, and solid vs dashed separates an association
 *   from a dependency. Before that the ONE diagram relation this widget could draw
 *   honestly was the synchronous call it draws by default.
 *
 * WHY `dashed` IS ON EVERY ROW INCLUDING THE SOLID ONES: application is an
 * OVERLAY, so a key a preset omits keeps whatever the previously HOVERED preset
 * left there. Without it, hovering Realization and then clicking Drafting Leader
 * would give a dashed "drafting" leader. `dashLength`/`dashGap` are deliberately
 * NOT here — no preset in this family varies the rhythm, so leaving them alone
 * preserves a rhythm the user chose rather than overwriting it.
 */
const PRESETS = [
  { name: "Drafting Leader", description: "A leader line's head at the three-to-one length-to-width proportion: compact, unambiguous, and light enough to sit over a drawing.", props: { headLength: 18, headWidth: 6, headStart: "none", headEnd: "triangle", strokeWidth: 1, dashed: false } },
  { name: "Thirty Degree Barb", description: "The wider thirty-degree head — the same technical shaft, but a barb that reads from across a room.", props: { headLength: 16, headWidth: 8.6, headStart: "none", headEnd: "triangle", strokeWidth: 1.5, dashed: false } },
  { name: "Dimension Line", description: "A dimension run between two extension lines: a small head at BOTH ends over a hairline shaft.", props: { headLength: 15, headWidth: 5, headStart: "triangle", headEnd: "triangle", strokeWidth: 1, dashed: false } },
  { name: "Extension Line", description: "The headless rule that carries a dimension out from the feature it measures — no terminator at either end.", props: { headLength: 14, headWidth: 12, headStart: "none", headEnd: "none", strokeWidth: 0.75, dashed: false } },
  { name: "Return Arrow", description: "The head sits at the TAIL, so the edge reads backwards — a \"comes from\" rather than a \"goes to\".", props: { headLength: 15, headWidth: 13, headStart: "triangle", headEnd: "none", strokeWidth: 3, dashed: false } },
  { name: "Presentation Callout", description: "The polite slide leader: a small tidy head on a light shaft that points without shouting.", props: { headLength: 12, headWidth: 9, headStart: "none", headEnd: "triangle", strokeWidth: 2, dashed: false } },
  { name: "Emphasis Arrow", description: "The thick \"look at this\": a big head over a heavy shaft, sized to be the loudest thing on the slide.", props: { headLength: 40, headWidth: 38, headStart: "none", headEnd: "triangle", strokeWidth: 12, dashed: false } },
  { name: "Poster Chevron", description: "A head far wider than it is long, over a heavy shaft — blunt, loud, and unmistakably directional.", props: { headLength: 16, headWidth: 40, headStart: "none", headEnd: "triangle", strokeWidth: 8, dashed: false } },
  { name: "Trade-off Bar", description: "A heavy double-headed span for \"this versus that\": two big heads and a shaft thick enough to carry them.", props: { headLength: 26, headWidth: 24, headStart: "triangle", headEnd: "triangle", strokeWidth: 6, dashed: false } },
  { name: "Signage Arrow", description: "A shaft nearly as thick as the head is wide, so the whole arrow reads as one solid wayfinding glyph.", props: { headLength: 34, headWidth: 34, headStart: "none", headEnd: "triangle", strokeWidth: 20, dashed: false } },
  { name: "Generalization", description: "UML inheritance — a solid shaft closed by a HOLLOW triangle, read as \"is a kind of\".", props: { headLength: 20, headWidth: 18, headStart: "none", headEnd: "triangleOpen", strokeWidth: 1.5, dashed: false } },
  { name: "Realization", description: "UML realization — the same hollow triangle over a DASHED shaft: \"implements this interface\".", props: { headLength: 20, headWidth: 18, headStart: "none", headEnd: "triangleOpen", strokeWidth: 1.5, dashed: true } },
  { name: "Composition", description: "UML composition — a FILLED diamond at the owning end, for a part that cannot outlive its whole.", props: { headLength: 18, headWidth: 12, headStart: "diamond", headEnd: "none", strokeWidth: 1.5, dashed: false } },
  { name: "Aggregation", description: "UML aggregation — a HOLLOW diamond at the owning end, for a part that can exist on its own.", props: { headLength: 18, headWidth: 12, headStart: "diamondOpen", headEnd: "none", strokeWidth: 1.5, dashed: false } },
  { name: "Association", description: "A bare open V: a navigable association, and the same glyph a sequence diagram gives an asynchronous message.", props: { headLength: 16, headWidth: 14, headStart: "none", headEnd: "open", strokeWidth: 1.5, dashed: false } },
  { name: "Dependency", description: "The open V over a DASHED shaft — a dependency, and the shape a sequence diagram's reply message takes.", props: { headLength: 16, headWidth: 14, headStart: "none", headEnd: "open", strokeWidth: 1.5, dashed: true } },
  { name: "State Transition", description: "The notched dart every state-diagram transition is drawn with, on a light technical shaft.", props: { headLength: 18, headWidth: 14, headStart: "none", headEnd: "dart", strokeWidth: 1.5, dashed: false } },
  { name: "One To Many", description: "Crow's-foot entity notation: exactly one at the tail, one or more at the head.", props: { headLength: 40, headWidth: 20, headStart: "onlyOne", headEnd: "oneOrMore", strokeWidth: 1.5, dashed: false } },
  { name: "Optional To Many", description: "Crow's-foot entity notation with both ends optional: zero or one at the tail, zero or more at the head.", props: { headLength: 40, headWidth: 20, headStart: "zeroOrOne", headEnd: "zeroOrMore", strokeWidth: 1.5, dashed: false } },
];

export const arrowPlugin = {
  type: "arrow",
  ephemeral: EPHEMERAL.NONE,
  title: "Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  presets: PRESETS,
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
