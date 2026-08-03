/**
 * Curved Arrow widget — the THIRD arrow-family variant (manifest ARCHITECTURE
 * PLAN #6, "CURVED (quadratic bezier; `bend` = modifier point)"). Its shape
 * comes from pure functions in core/outline.js (bezierControlFromBend +
 * curvedArrowPolyline), so this plugin is thin glue: state → control point →
 * sampled polyline — the same "generator + thin plugin" relationship
 * fancy_arrow.js and elbow_arrow.js have to their own core/outline.js
 * generators.
 *
 * `bend` (signed): the control point's perpendicular offset as a PROPORTION
 * of the endpoints' span length (core/outline.js's bezierControlFromBend) —
 * resolution-independent, so scaling the whole arrow scales the curve with
 * it. Controlled by ONE MODIFIER POINT at the curve's midpoint (t=0.5 on the
 * bezier — NOT the control point itself, which sits off the visible curve;
 * the manifest: "a modifier point controls curvature", and the midpoint is
 * where a user would naturally grab the visible arc).
 *
 * STROKE RENDERING (manifest ARCHITECTURE PLAN #6, "the polyline/capsule-
 * chain path handles curves as a sampled polyline"): neither backend has a
 * native bezier stroke primitive (same "no native primitive" situation
 * fancyArrowOutline/donutOutline already accept for their own curves), so
 * curvedArrowPolyline samples the bezier into CURVE_SEGMENTS+1 points and the
 * shaft renders as an ordinary multi-point polyline — verified against
 * render_gpu/ir.js's polyline(), which accepts any point count >= 2.
 *
 * headStart/headEnd/stroke/strokeWidth follow the same shared conventions as
 * elbow_arrow.js (a NEW plugin, so no legacyKeys entry — no prior naming era
 * to migrate from; the head-shape split IS migrated, but document-wide from
 * core/document.js, not per plugin).
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { polyline, polygon, path } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { bezierControlFromBend, quadraticBezierPoint, curvedArrowPolyline, axisNormalFrame, projectOntoNormal, closestPointOnAxisRange } from "../core/outline.js";
import { endpointPairHooks, arrowHeads, headedConnectorMorphSources, connectorPathAnchors, walkPolyline, dashedSpans, ARROW_HEAD_ROWS, CONNECTOR_DASH_ROWS, CONNECTOR_DASH_DEFAULTS, hitsPolylineShaft, ARROW_ENDPOINT_DEFAULTS, ARROW_STROKE_WIDTH, ARROW_HEAD_WIDTH } from "../core/endpoints.js";
import { morphPayloadFromConnector } from "../core/morph_payload.js";

/** Pure function. The bezier generator's params for a state.
 * @example bendParams({from: {x: 0, y: 0}, to: {x: 100, y: 0}, bend: 0.3}) // {x0: 0, y0: 0, x1: 100, y1: 0, bend: 0.3}
 */
function bendParams(s) {
  return { x0: s.from.x, y0: s.from.y, x1: s.to.x, y1: s.to.y, bend: s.bend ?? 0 };
}

/**
 * Pure function. The straight span's midpoint and its (axis, right-normal) frame
 * — the two things BOTH halves of the bend handle's constraint protocol need, so
 * they are derived once here instead of twice inline. `frame.length` is the span
 * (0 for coincident endpoints: no axis, so no defined bend direction).
 *
 * @example bendFrame({from: {x: 0, y: 0}, to: {x: 100, y: 0}}).mid // {x: 50, y: 0}
 * @example bendFrame({from: {x: 0, y: 0}, to: {x: 100, y: 0}}).frame.ny // 1 (right normal points +y for a rightward axis)
 */
function bendFrame(s) {
  return {
    mid: { x: (s.from.x + s.to.x) / 2, y: (s.from.y + s.to.y) / 2 },
    frame: axisNormalFrame(s.from, s.to),
  };
}

/**
 * Pure function. The LOCAL rect the curved arrow's INK occupies: the AABB of the
 * SAMPLED bezier polyline, padded on every side by the widest of the shaft width
 * and the head width. World == identity for a connector, so this is also its
 * world footprint.
 *
 * ONE ink rect, THREE consumers (the plugins/polygon.js polygonInkRect
 * precedent): the effect substrate in emit() below, and — via the `localBounds`
 * declaration — culling plus rubber-band selection (core/view.js localBoundsOf).
 * The SAMPLED polyline (not the {from, control, to} hull) is what is actually
 * drawn, and it is the tighter of the two: a quadratic never leaves its control
 * hull, so sampling the curve bounds the ink and the pad — several times the
 * largest between-sample sagitta — absorbs the sampling error.
 *
 * @param {object} s - evaluated item state (from / to / bend / strokeWidth / headWidth)
 * @returns {{x: number, y: number, w: number, h: number}} local rect
 *
 * @example // a straight (bend 0) curved arrow bounds like a plain arrow:
 * @example curvedArrowInkRect({from: {x: 0, y: 0}, to: {x: 100, y: 0}, bend: 0, strokeWidth: 3, headWidth: 12}) // {x: -12, y: -12, w: 124, h: 24}
 */
export function curvedArrowInkRect(s) {
  return paddedPointsBBox(curvedArrowPolyline(bendParams(s)), Math.max(s.strokeWidth ?? ARROW_STROKE_WIDTH, s.headWidth ?? ARROW_HEAD_WIDTH));
}

/**
 * THE CURVED ARROW'S ARC LIBRARY — one knob swept, and the heads that suit it.
 *
 * ORDER IS CONTENT: `bend` from 0 up the positive side, then the negative mirror
 * side, then the two extremes that hook right around. Reading down the list is
 * watching one arc open.
 *
 * `bend` IS A PROPORTION OF THE SPAN, not a pixel offset, so every value here holds
 * its look at any arrow length — the only knob in the whole arrow family of which
 * that is true. The visible midpoint sits at bend * span / 2 off the straight
 * chord, which is the number to reason with: 0.45 lifts the arc about a quarter of
 * the span, 2.4 throws it clear past the endpoints.
 *
 * NO DIAGRAM RELATIONS HERE, deliberately. The UML and entity relations live on the
 * straight `arrow` and the BPMN flows on `elbow_arrow`; repeating them across three
 * connectors would triple the picker without adding a picture.
 */
const PRESETS = [
  { name: "Chord Rule", description: "The straight construction chord an arc is measured against — no bend and no head, just the line between the two points.", props: { bend: 0, headLength: 10, headWidth: 8, headStart: "none", headEnd: "none", strokeWidth: 1 } },
  { name: "Gentle Nudge", description: "A bow so slight it reads as deliberate rather than accidental — the least curve worth drawing.", props: { bend: 0.1, headLength: 12, headWidth: 8, headStart: "none", headEnd: "triangle", strokeWidth: 1.5 } },
  { name: "Flow Current", description: "A long shallow curve on a broad shaft with a slim head: a current or a drift rather than a pointer.", props: { bend: 0.2, headLength: 22, headWidth: 8, headStart: "none", headEnd: "triangle", strokeWidth: 4 } },
  { name: "Hairline Arc", description: "The most delicate curve in the set — the thinnest shaft and the smallest head that still reads.", props: { bend: 0.3, headLength: 8, headWidth: 5, headStart: "none", headEnd: "triangle", strokeWidth: 0.75 } },
  { name: "Exchange Arc", description: "A bowed span headed at both ends: two things trading places rather than one pointing at the other.", props: { bend: 0.35, headLength: 14, headWidth: 11, headStart: "triangle", headEnd: "triangle", strokeWidth: 2 } },
  { name: "Presentation Swoosh", description: "The generous \"look over here\" arc: enough curve to feel gestural, on a shaft light enough to stay polite.", props: { bend: 0.45, headLength: 16, headWidth: 10, headStart: "none", headEnd: "triangle", strokeWidth: 2.5 } },
  { name: "Counter Swoosh", description: "Presentation Swoosh mirrored, so a pair of them can bracket a subject from both sides.", props: { bend: -0.45, headLength: 16, headWidth: 10, headStart: "none", headEnd: "triangle", strokeWidth: 2.5 } },
  { name: "Banner Arc", description: "A wide shallow bow the other way, carrying a heavy shaft and a head to match — an arc with weight.", props: { bend: -0.25, headLength: 26, headWidth: 26, headStart: "none", headEnd: "triangle", strokeWidth: 10 } },
  { name: "Comic Whip", description: "A hard arc with an oversized head on a fat shaft: the arrow drawn in one fast stroke.", props: { bend: 0.85, headLength: 34, headWidth: 30, headStart: "none", headEnd: "triangle", strokeWidth: 8 } },
  { name: "Rebound", description: "A strong reverse arc headed at the TAIL, so it reads as something coming back rather than going out.", props: { bend: -1.1, headLength: 18, headWidth: 15, headStart: "triangle", headEnd: "none", strokeWidth: 3 } },
  { name: "Undo Hook", description: "The tight hook that reads as \"go back one step\": curved far enough that the two ends nearly face each other.", props: { bend: 1.4, headLength: 14, headWidth: 12, headStart: "none", headEnd: "triangle", strokeWidth: 3 } },
  { name: "Orbit Return", description: "An extreme bend that throws the curve clear of both endpoints and brings it back — a detour drawn as an arc.", props: { bend: 2.4, headLength: 16, headWidth: 13, headStart: "none", headEnd: "triangle", strokeWidth: 2.5 } },
];

export const curvedArrowPlugin = {
  type: "curved_arrow",
  ephemeral: EPHEMERAL.NONE,
  title: "Curved Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  presets: PRESETS,
  defaults: {
    type: "curved_arrow", z: 1,
    from: { x: 200, y: 440 }, to: { x: 420, y: 440 },
    bend: 0.25,
    stroke: "#000000", ...ARROW_ENDPOINT_DEFAULTS, ...CONNECTOR_DASH_DEFAULTS, opacity: 1,
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY: the `endpoints` bundle +
  // shared stroke/strokeWidth/opacity. Head geometry + the bend amount are
  // plugin-specific (an "arrow" extras category).
  inspector: [
    ...bundle("endpoints"),
    ...props("stroke", "strokeWidth"),
    ...props("opacity"),
    ...bundle("effects"),
    ...ARROW_HEAD_ROWS,
    ...CONNECTOR_DASH_ROWS,
    { key: "bend", label: "Bend", kind: "number", category: "arrow", help: "How much the arrow curves, as a signed fraction of its length. 0 is straight; positive and negative bow it to opposite sides." },
  ],
  /**
   * Pure function. State → display-list commands. The sampled bezier polyline
   * is trimmed at its own ends by the pullback distance (walked along the
   * polyline's actual sample points, since a curve has no single "axis" to
   * pull back along the way a straight shaft does) so the shaft still tucks
   * inside the head triangle exactly like the basic arrow.
   */
  emit(s, _targetWorldIR, world) {
    const pts = curvedArrowPolyline(bendParams(s));
    const opacity = s.opacity ?? 1;
    // Head glyphs point along the tangent at each end: the LAST sampled
    // segment into `to` (or the first, reversed, out of `from`) — the
    // closest available approximation of the true bezier tangent at t=0/1,
    // consistent with how sampling already approximates the curve elsewhere.
    const n = pts.length;
    const heads = arrowHeads(s, { tip: pts[n - 1], from: pts[n - 2] }, { tip: pts[0], from: pts[1] });
    const cmds = [];
    const trimmed = trimPolylineEnds(pts, heads.pullback.start, heads.pullback.end);
    // THE DASHED SHAFT: one polyline per DRAWN run (core/endpoints.js dashedSpans;
    // a solid shaft is the one-run degenerate case, byte-identical to before).
    // Geometry rather than the `dashes` stroke material, and that is measured, not
    // taste: a material stroke is refused by both vector exporters and rasterized,
    // so a dashed arrow would export as a bitmap. See dashedSpans' docblock.
    const runs = s.dashed ? dashedSpans(trimmed, s.dashLength, s.dashGap) : [trimmed];
    cmds.push(...runs.map((run) => polyline({ points: run.map((p) => [p.x, p.y]), width: s.strokeWidth, color: s.stroke, opacity })));
    // THE LAYERING SEAM — see core/endpoints.js arrowHeads (and arrow.js's twin).
    cmds.push(...heads.ops.map((h) => (h.d ? path(h) : polygon(h))));
    // Effects wrap the finished op list (shared EFFECTS BUNDLE, render_gpu/
    // effects.js; all-off = pass-through). Effect region = its ink rect (the AABB
    // of the SAMPLED bezier), the SAME rect `localBounds` reports, so the
    // substrate and the cull/band bounds can never disagree about where this
    // widget is.
    return applyEffects(cmds, s, world, curvedArrowInkRect(s));
  },
  // THE BOUNDS PROTOCOL (core/view.js localBoundsOf): the sampled curve's min/max
  // IS this widget's width and height, so it band-selects and culls like any box
  // widget despite having no w/h state and no resize handles.
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * the SAMPLED curve as one open centerline subpath, plus a closed contour per
   * head glyph, in the ink rect's frame.
   *
   * SAMPLED, NOT THE ANALYTIC QUADRATIC, and deliberately so: `curvedArrowPolyline`
   * is what emit(), `localBounds`, the anchors and the hit test all already read,
   * so morphing the same samples keeps the payload equal to the ink. Elevating the
   * true bezier instead would be more exact than the widget itself draws and would
   * put the morph and the picture on two different curves. The samples elevate to
   * cubics exactly (a straight segment IS a cubic with collinear controls), so
   * nothing is approximated a second time.
   *
   * See core/endpoints.js `headedConnectorMorphSources` for the centerline and
   * heads argument; the curve is reported whole rather than trimmed by the head
   * pullback emit() applies.
   */
  morphPaths(s) {
    const pts = curvedArrowPolyline(bendParams(s));
    const n = pts.length;
    return morphPayloadFromConnector(
      headedConnectorMorphSources(s, pts, arrowHeads(s, { tip: pts[n - 1], from: pts[n - 2] }, { tip: pts[0], from: pts[1] })),
      curvedArrowInkRect(s),
    );
  },
  localBounds: curvedArrowInkRect,
  // THE ANCHOR PROTOCOL: start / mid / end on the SAMPLED curve, by ARC LENGTH.
  // This widget is exactly why that qualifier matters — the chord midpoint the
  // old workaround used misses the visible arc by bend*span/2 along the normal.
  anchors: (s) => connectorPathAnchors(curvedArrowPolyline(bendParams(s))),
  // Effects halo (shadow/bloom spill) extends the cull AABB — core/view.js
  // defaultCanSkip's cullMargin hook. MANDATORY now that this widget HAS an AABB
  // to be culled by: without it a shadowed curve just off-view loses its halo.
  cullMargin: effectsCullMargin,
  hitTestWorld(node, wx, wy) {
    const s = node.state;
    const pts = curvedArrowPolyline(bendParams(s));
    return hitsPolylineShaft(pts, wx, wy, (s.strokeWidth ?? ARROW_STROKE_WIDTH) / 2);
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js), identical semantics to the basic arrow.
  ...endpointPairHooks(),
  /**
   * Pure function. ONE modifier point at the curve's midpoint (t=0.5 on the
   * bezier, the visible point a user would grab to bend the arc — NOT the
   * off-curve control point), dragged to scrub `bend`.
   *
   * THE HANDLE-CONSTRAINT PROTOCOL (core/derive.js):
   *   `constrain` — the allowed set is the full LINE through the straight
   *     midpoint along the span's RIGHT NORMAL: bend only ever moves the curve
   *     sideways off the straight line (bezierControlFromBend's own
   *     perpendicular-offset parameterization), so the drag's AXIAL component is
   *     what the projection removes. Unbounded, because `bend` is unbounded —
   *     the one handle here whose allowed set is a line rather than a segment.
   *   `apply` — reads the already-allowed point's signed normal offset back as
   *     bend. A t=0.5 quadratic bezier's midpoint sits HALFWAY between the
   *     straight midpoint and the control point (De Casteljau at t=0.5), so that
   *     offset is (bend·span)/2 — invert the factor to recover bend.
   */
  modifierPoints(s) {
    const params = bendParams(s);
    const c = bezierControlFromBend(params);
    const mid = quadraticBezierPoint({ x: s.from.x, y: s.from.y }, c, { x: s.to.x, y: s.to.y }, 0.5);
    return [{
      id: "bend", x: mid.x, y: mid.y,
      constrain(state, desired) {
        const { mid: m, frame } = bendFrame(state);
        return closestPointOnAxisRange(m, { x: frame.nx, y: frame.ny }, desired);
      },
      apply(state, allowed) {
        const { mid: m, frame } = bendFrame(state);
        // Coincident endpoints have no axis, so no bend direction exists to read
        // an offset against — leave the value alone (the same "no geometry"
        // territory bezierControlFromBend's degenerate case covers).
        if (frame.length === 0) return { bend: state.bend ?? 0 };
        return { bend: (projectOntoNormal(m, frame, allowed) * 2) / frame.length };
      },
    }];
  },
  // CROSSHAIR PLACEMENT (manifest UNDEFERRAL SWEEP): places by from→to endpoints.
  placement: "endpoints",
  commands: [
    { id: "add-curved-arrow", title: "Add Curved Arrow", icon: "mdi:vector-curve", run: (app) => app.armCrosshairPlacement(curvedArrowPlugin) },
  ],
};

/** Pure function. Walk a polyline's arc length from each end and trim off
 * `startDist`/`endDist`, inserting an interpolated point at each cut — the
 * curve analog of arrow.js's straight-shaft pullback (core/endpoints.js
 * arrowHeads' per-shape pullback), generalized to a sampled multi-point path.
 * Returns at
 * least 2 points (collapses to the two innermost samples if the trims meet
 * or overlap, rather than producing a degenerate 0/1-point polyline).
 *
 * @example trimPolylineEnds([{x: 0, y: 0}, {x: 10, y: 0}, {x: 20, y: 0}], 5, 0).map((p) => p.x) // [5, 10, 20]
 * @example trimPolylineEnds([{x: 0, y: 0}, {x: 10, y: 0}], 0, 0).map((p) => p.x) // [0, 10]
 */
function trimPolylineEnds(pts, startDist, endDist) {
  // ONE arc-length traversal for the whole codebase (core/endpoints.js
  // walkPolyline). This function used to carry its own copy of the walk — the
  // only one that existed — so the path anchors would have made it the second.
  const walk = (arr, dist) => {
    const { point, index } = walkPolyline(arr, dist);
    return index >= arr.length - 1 ? [point] : [point, ...arr.slice(index + 1)];
  };
  const fromStart = startDist > 0 ? walk(pts, startDist) : pts;
  const reversed = [...fromStart].reverse();
  const fromBoth = endDist > 0 ? walk(reversed, endDist).reverse() : fromStart;
  return fromBoth.length >= 2 ? fromBoth : pts.slice(-2);
}
