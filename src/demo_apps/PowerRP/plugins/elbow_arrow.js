/**
 * Elbow Arrow widget — the SECOND arrow-family variant (manifest ARCHITECTURE
 * PLAN #6, "ELBOW (orthogonal route; `elbow` 0..1 = modifier point sliding
 * the mid-segment)"). Its shape comes from a pure ROUTE GENERATOR in
 * core/outline.js (elbowRoute — an H-V-H orthogonal route between the two
 * endpoints, "PPT default" per the manifest's screenshot description), so
 * this plugin is thin glue: state → generator params → polyline, exactly the
 * same "generator + thin plugin" relationship fancy_arrow.js has to
 * fancyArrowOutline (that plugin's own docstring: "The NEXT parametric shape
 * should be another generator + a plugin this shape").
 *
 * `elbow` (0..1): the mid-segment's position along the endpoints' x-span.
 * Controlled by ONE MODIFIER POINT at the vertical segment's midpoint
 * (core/outline.js's elbowHandle) — "the PPT yellow square on the elbow".
 *
 * headMode (none|start|end|both, default "end") and the stroke/strokeWidth
 * naming are identical in spirit to the basic arrow — this is a NEW plugin
 * (not a migrated one), so it's born with the current names directly; no
 * legacyKeys entry is needed (there is no prior "color/width" era to migrate
 * from).
 *
 * Endpoint semantics (from/to may be equations, no transform of its own,
 * shaft-drag translation) come from core/endpoints.js — the shared home,
 * since plugins may not import each other (registry rule). "Shaft" hit-
 * testing here means the whole 3-segment route, not a single straight
 * segment — hitTestWorld checks all three legs.
 */

import { polyline, polygon } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { elbowRoute, elbowHandle, closestPointOnSegment } from "../core/outline.js";
import { endpointPairHooks, headEnds, headTriangle, shaftPullback, HEAD_MODES, hitsPolylineShaft, ARROW_ENDPOINT_DEFAULTS, ARROW_STROKE_WIDTH, ARROW_HEAD_WIDTH } from "../core/endpoints.js";

/** Pure function. The route generator's params for a state.
 * @example routeParams({from: {x: 0, y: 0}, to: {x: 100, y: 50}, elbow: 0.5}) // {x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5}
 */
function routeParams(s) {
  return { x0: s.from.x, y0: s.from.y, x1: s.to.x, y1: s.to.y, elbow: s.elbow };
}

/**
 * Pure function. The LOCAL rect the elbow arrow's INK occupies: the AABB of its
 * 4-point H-V-H route, padded on every side by the widest of the shaft width and
 * the head width. World == identity for a connector, so this is also its world
 * footprint.
 *
 * ONE ink rect, THREE consumers (the plugins/polygon.js polygonInkRect
 * precedent): the effect substrate in emit() below, and — via the `localBounds`
 * declaration — culling plus rubber-band selection (core/view.js localBoundsOf).
 * The route hull, not the endpoint hull: the vertical leg bends AWAY from the
 * straight line between the endpoints for no elbow value, but the corners p1/p2
 * always share their coordinates with p0/p3 in an H-V-H route, so the two hulls
 * coincide — passing the whole route keeps that an observation rather than an
 * assumption the day the generator learns a new route shape.
 *
 * @param {object} s - evaluated item state (from / to / elbow / strokeWidth / headWidth)
 * @returns {{x: number, y: number, w: number, h: number}} local rect
 *
 * @example elbowArrowInkRect({from: {x: 0, y: 0}, to: {x: 100, y: 50}, elbow: 0.5, strokeWidth: 3, headWidth: 12}) // {x: -12, y: -12, w: 124, h: 74}
 */
export function elbowArrowInkRect(s) {
  const route = elbowRoute(routeParams(s)).map(([x, y]) => ({ x, y }));
  return paddedPointsBBox(route, Math.max(s.strokeWidth ?? ARROW_STROKE_WIDTH, s.headWidth ?? ARROW_HEAD_WIDTH));
}

export const elbowArrowPlugin = {
  type: "elbow_arrow",
  title: "Elbow Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "elbow_arrow", z: 1,
    from: { x: 200, y: 260 }, to: { x: 420, y: 380 },
    elbow: 0.5,
    stroke: "#000000", ...ARROW_ENDPOINT_DEFAULTS, opacity: 1,
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY: the `endpoints` bundle +
  // shared stroke/strokeWidth/opacity. Head geometry + the elbow position are
  // plugin-specific (an "arrow" extras category).
  inspector: [
    ...bundle("endpoints"),
    ...props("stroke", "strokeWidth"),
    ...props("opacity"),
    ...bundle("effects"),
    { key: "headLength", label: "Head length", kind: "number", min: 0, category: "arrow", help: "How far the arrowhead extends back from the tip along the shaft, in canvas units." },
    { key: "headWidth", label: "Head width", kind: "number", min: 0, category: "arrow", help: "How wide the arrowhead is across its base, in canvas units." },
    { key: "headMode", label: "Head", kind: "select", options: HEAD_MODES, category: "arrow", help: "Which ends get an arrowhead: none, just the start, just the end, or both." },
    { key: "elbow", label: "Elbow", kind: "number", min: 0, max: 1, category: "arrow", help: "Where the vertical bend sits along the horizontal span, from 0 (flush at the start) to 1 (flush at the end). Drag the yellow handle on canvas." },
  ],
  /**
   * Pure function. State → display-list commands. The route is a 4-point
   * polyline (H-V-H); heads sit on the FINAL leg into each active end (the
   * last segment before `to` for the end head, the first segment out of
   * `from` for the start head — both horizontal by construction, since H-V-H
   * always starts and ends with a horizontal leg), pulled back exactly like
   * the basic arrow's shaft.
   */
  emit(s, _targetWorldIR, world) {
    // elbowRoute returns [x,y] pairs (render_gpu/ir.js's points convention);
    // convert to {x,y} objects here since every other function in this file
    // (headTriangle, the pullback helper) uses the {x,y} convention.
    const [p0, p1, p2, p3] = elbowRoute(routeParams(s)).map(([x, y]) => ({ x, y }));
    const ends = headEnds(s.headMode);
    const opacity = s.opacity ?? 1;
    // Shorten the route's own end segments by the pullback distance, along
    // each segment's own direction — mirrors the basic arrow's shaftPullback,
    // generalized to "the last/first leg of a multi-segment route" instead of
    // "the only segment".
    const pullback = (a, b, dist) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = Math.min(dist / len, 1);
      return { x: b.x - (b.x - a.x) * t, y: b.y - (b.y - a.y) * t };
    };
    const endPt = ends.end ? pullback(p2, p3, shaftPullback(true, s.headLength)) : p3;
    const startPt = ends.start ? pullback(p1, p0, shaftPullback(true, s.headLength)) : p0;
    const shaftPts = [startPt, p1, p2, endPt];
    const cmds = [polyline({ points: shaftPts.map((p) => [p.x, p.y]), width: s.strokeWidth, color: s.stroke, opacity })];
    if (ends.end) cmds.push(polygon({ points: headTriangle(p3, p2, s.headLength, s.headWidth), fill: s.stroke, opacity }));
    if (ends.start) cmds.push(polygon({ points: headTriangle(p0, p1, s.headLength, s.headWidth), fill: s.stroke, opacity }));
    // Effects wrap the finished op list (shared EFFECTS BUNDLE, render_gpu/
    // effects.js; all-off = pass-through). Effect region = its ink rect, the
    // SAME rect `localBounds` reports, so the substrate and the cull/band bounds
    // can never disagree about where this widget is.
    return applyEffects(cmds, s, world, elbowArrowInkRect(s));
  },
  // THE BOUNDS PROTOCOL (core/view.js localBoundsOf): the route's min/max IS this
  // widget's width and height, so it band-selects and culls like any box widget
  // despite having no w/h state and no resize handles.
  localBounds: elbowArrowInkRect,
  // Effects halo (shadow/bloom spill) extends the cull AABB — core/view.js
  // defaultCanSkip's cullMargin hook. MANDATORY now that this widget HAS an AABB
  // to be culled by: without it a shadowed route just off-view loses its halo.
  cullMargin: effectsCullMargin,
  hitTestWorld(node, wx, wy) {
    const s = node.state;
    const route = elbowRoute(routeParams(s)).map(([x, y]) => ({ x, y }));
    return hitsPolylineShaft(route, wx, wy, (s.strokeWidth ?? ARROW_STROKE_WIDTH) / 2);
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js), identical semantics to the basic arrow.
  ...endpointPairHooks(),
  /**
   * Pure function. ONE modifier point at the elbow's mid-segment midpoint
   * (core/outline.js's elbowHandle — "the PPT yellow square on the elbow"),
   * dragged to scrub `elbow` (0..1).
   *
   * THE HANDLE-CONSTRAINT PROTOCOL (core/derive.js):
   *   `constrain` — the allowed set is the SEGMENT the elbow slides along:
   *     y is pinned to the vertical run's midpoint (where elbowHandle always
   *     puts it) and x spans from.x → to.x, matching the generator's own
   *     `t = (x1−x0)`-relative parameterization. Ignoring the drag's
   *     y-component IS that segment's y; clamping t to [0, 1] IS its extent.
   *   `apply` — reads the already-allowed x back as the fraction t.
   *
   * Both hooks re-derive from the LIVE state they are handed (not the state
   * modifierPoints was called with): the drag handler re-reads them on every
   * move against the current node, so each must be self-contained.
   */
  modifierPoints(s) {
    const h = elbowHandle(routeParams(s));
    return [{
      id: "elbow", x: h.x, y: h.y,
      constrain(state, desired) {
        const midY = (state.from.y + state.to.y) / 2;
        return closestPointOnSegment({ x: state.from.x, y: midY }, { x: state.to.x, y: midY }, desired);
      },
      apply(state, allowed) {
        const span = state.to.x - state.from.x;
        // A zero x-span has no fraction to read (the allowed set collapsed to a
        // point) — a technical division guard, not a bound on `elbow`.
        if (span === 0) return { elbow: state.elbow ?? 0.5 };
        return { elbow: (allowed.x - state.from.x) / span };
      },
    }];
  },
  // CROSSHAIR PLACEMENT (manifest UNDEFERRAL SWEEP): places by from→to endpoints.
  placement: "endpoints",
  commands: [
    { id: "add-elbow-arrow", title: "Add Elbow Arrow", icon: "mdi:arrow-top-right-bottom-left", run: (app) => app.armCrosshairPlacement(elbowArrowPlugin) },
  ],
};
