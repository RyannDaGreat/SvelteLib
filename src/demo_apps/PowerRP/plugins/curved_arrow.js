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
import { bezierControlFromBend, quadraticBezierPoint, curvedArrowPolyline, distToSegment } from "../core/outline.js";
import { endpointPairHooks, headEnds, headTriangle, shaftPullback, HEAD_MODES, SHAFT_GRAB_PAD } from "../core/endpoints.js";

/** Pure function. The bezier generator's params for a state.
 * @example bendParams({from: {x: 0, y: 0}, to: {x: 100, y: 0}, bend: 0.3}) // {x0: 0, y0: 0, x1: 100, y1: 0, bend: 0.3}
 */
function bendParams(s) {
  return { x0: s.from.x, y0: s.from.y, x1: s.to.x, y1: s.to.y, bend: s.bend ?? 0 };
}

export const curvedArrowPlugin = {
  type: "curved_arrow",
  title: "Curved Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "curved_arrow", z: 1,
    from: { x: 200, y: 440 }, to: { x: 420, y: 440 },
    bend: 0.25,
    stroke: "#1a1a2e", strokeWidth: 3, headLength: 14, headWidth: 12, headMode: "end", opacity: 1,
  },
  inspector: [
    { key: "from.x", label: "From X", kind: "number", category: "positioning" },
    { key: "from.y", label: "From Y", kind: "number", category: "positioning" },
    { key: "to.x", label: "To X", kind: "number", category: "positioning" },
    { key: "to.y", label: "To Y", kind: "number", category: "positioning" },
    { key: "z", label: "Z order", kind: "number", category: "positioning" },
    { key: "stroke", label: "Stroke", kind: "color", category: "formatting" },
    { key: "strokeWidth", label: "Stroke width", kind: "number", min: 0, category: "formatting" },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
    { key: "headLength", label: "Head length", kind: "number", min: 0, category: "arrow" },
    { key: "headWidth", label: "Head width", kind: "number", min: 0, category: "arrow" },
    { key: "headMode", label: "Head", kind: "select", options: HEAD_MODES, category: "arrow" },
    { key: "bend", label: "Bend", kind: "number", category: "arrow" },
  ],
  /**
   * Pure function. State → display-list commands. The sampled bezier polyline
   * is trimmed at its own ends by the pullback distance (walked along the
   * polyline's actual sample points, since a curve has no single "axis" to
   * pull back along the way a straight shaft does) so the shaft still tucks
   * inside the head triangle exactly like the basic arrow.
   */
  emit(s) {
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
    return cmds;
  },
  hitTestWorld(node, wx, wy) {
    const s = node.state;
    const pts = curvedArrowPolyline(bendParams(s));
    const radius = (s.strokeWidth ?? 3) / 2;
    for (let i = 0; i < pts.length - 1; i++)
      if (distToSegment(wx, wy, pts[i], pts[i + 1]) <= radius + SHAFT_GRAB_PAD) return true;
    return false;
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js), identical semantics to the basic arrow.
  ...endpointPairHooks(),
  /**
   * Pure function. ONE modifier point at the curve's midpoint (t=0.5 on the
   * bezier, the visible point a user would grab to bend the arc — NOT the
   * off-curve control point), dragged to scrub `bend`. `apply` projects the
   * dragged point onto the PERPENDICULAR-to-span axis (the handle's ONE
   * constrained trajectory — bend only ever moves the curve sideways off the
   * straight line, matching bezierControlFromBend's own perpendicular-offset
   * parameterization) via the same axisNormalFrame decomposition
   * fancy_arrow.js's modifier points use.
   */
  modifierPoints(s) {
    const params = bendParams(s);
    const c = bezierControlFromBend(params);
    const mid = quadraticBezierPoint({ x: s.from.x, y: s.from.y }, c, { x: s.to.x, y: s.to.y }, 0.5);
    return [{
      id: "bend", x: mid.x, y: mid.y,
      apply(state, localPoint) {
        const dx = state.to.x - state.from.x, dy = state.to.y - state.from.y;
        const span = Math.hypot(dx, dy);
        if (span === 0) return { bend: state.bend ?? 0 }; // no axis to project onto — leave unchanged
        const nx = -dy / span, ny = dx / span; // right normal, same convention as core/outline.js
        const mx = (state.from.x + state.to.x) / 2, my = (state.from.y + state.to.y) / 2;
        // Midpoint of a t=0.5 quadratic bezier sits HALFWAY between the
        // straight midpoint and the control point (De Casteljau at t=0.5),
        // so its perpendicular offset from the straight midpoint is
        // (bend*span)/2 — invert that factor to recover bend from the drag.
        const offset = (localPoint.x - mx) * nx + (localPoint.y - my) * ny;
        return { bend: (offset * 2) / span };
      },
    }];
  },
  commands: [
    { id: "add-curved-arrow", title: "Add Curved Arrow", icon: "mdi:vector-curve", run: (app) => app.addItem(curvedArrowPlugin.defaults) },
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
