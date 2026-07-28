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
 * headMode/stroke/strokeWidth follow the same shared conventions as
 * elbow_arrow.js (a NEW plugin, so no legacyKeys entry — no prior naming era
 * to migrate from).
 */

import { polyline, polygon } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { bezierControlFromBend, quadraticBezierPoint, curvedArrowPolyline, axisNormalFrame, projectOntoNormal, closestPointOnAxisRange } from "../core/outline.js";
import { endpointPairHooks, headEnds, headTriangle, shaftPullback, HEAD_MODES, hitsPolylineShaft, ARROW_ENDPOINT_DEFAULTS, ARROW_STROKE_WIDTH, ARROW_HEAD_WIDTH } from "../core/endpoints.js";

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

export const curvedArrowPlugin = {
  type: "curved_arrow",
  title: "Curved Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "curved_arrow", z: 1,
    from: { x: 200, y: 440 }, to: { x: 420, y: 440 },
    bend: 0.25,
    stroke: "#000000", ...ARROW_ENDPOINT_DEFAULTS, opacity: 1,
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
    { key: "headLength", label: "Head length", kind: "number", min: 0, category: "arrow", help: "How far the arrowhead extends back from the tip along the shaft, in canvas units." },
    { key: "headWidth", label: "Head width", kind: "number", min: 0, category: "arrow", help: "How wide the arrowhead is across its base, in canvas units." },
    { key: "headMode", label: "Head", kind: "select", options: HEAD_MODES, category: "arrow", help: "Which ends get an arrowhead: none, just the start, just the end, or both." },
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
    const ends = headEnds(s.headMode);
    const opacity = s.opacity ?? 1;
    // Head triangles point along the tangent at each end: the LAST sampled
    // segment into `to` (or the first, reversed, out of `from`) — the
    // closest available approximation of the true bezier tangent at t=0/1,
    // consistent with how sampling already approximates the curve elsewhere.
    const n = pts.length;
    const cmds = [];
    const trimmed = trimPolylineEnds(pts, shaftPullback(ends.start, s.headLength), shaftPullback(ends.end, s.headLength));
    cmds.push(polyline({ points: trimmed.map((p) => [p.x, p.y]), width: s.strokeWidth, color: s.stroke, opacity }));
    if (ends.end) cmds.push(polygon({ points: headTriangle(pts[n - 1], pts[n - 2], s.headLength, s.headWidth), fill: s.stroke, opacity }));
    if (ends.start) cmds.push(polygon({ points: headTriangle(pts[0], pts[1], s.headLength, s.headWidth), fill: s.stroke, opacity }));
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
  localBounds: curvedArrowInkRect,
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
 * shaftPullback), generalized to a sampled multi-point path. Returns at
 * least 2 points (collapses to the two innermost samples if the trims meet
 * or overlap, rather than producing a degenerate 0/1-point polyline).
 *
 * @example trimPolylineEnds([{x: 0, y: 0}, {x: 10, y: 0}, {x: 20, y: 0}], 5, 0).map((p) => p.x) // [5, 10, 20]
 * @example trimPolylineEnds([{x: 0, y: 0}, {x: 10, y: 0}], 0, 0).map((p) => p.x) // [0, 10]
 */
function trimPolylineEnds(pts, startDist, endDist) {
  const walk = (arr, dist) => {
    let remaining = dist;
    for (let i = 0; i < arr.length - 1; i++) {
      const segLen = Math.hypot(arr[i + 1].x - arr[i].x, arr[i + 1].y - arr[i].y);
      if (remaining <= segLen) {
        const t = segLen === 0 ? 0 : remaining / segLen;
        return [{ x: arr[i].x + (arr[i + 1].x - arr[i].x) * t, y: arr[i].y + (arr[i + 1].y - arr[i].y) * t }, ...arr.slice(i + 1)];
      }
      remaining -= segLen;
    }
    return [arr[arr.length - 1]]; // trimmed past the whole polyline
  };
  const fromStart = startDist > 0 ? walk(pts, startDist) : pts;
  const reversed = [...fromStart].reverse();
  const fromBoth = endDist > 0 ? walk(reversed, endDist).reverse() : fromStart;
  return fromBoth.length >= 2 ? fromBoth : pts.slice(-2);
}
