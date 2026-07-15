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
import { elbowRoute, elbowHandle, distToSegment } from "../core/outline.js";
import { endpointPairHooks, hitsShaft, headEnds, headTriangle, shaftPullback, HEAD_MODES, SHAFT_GRAB_PAD } from "../core/endpoints.js";

/** Pure function. The route generator's params for a state.
 * @example routeParams({from: {x: 0, y: 0}, to: {x: 100, y: 50}, elbow: 0.5}) // {x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5}
 */
function routeParams(s) {
  return { x0: s.from.x, y0: s.from.y, x1: s.to.x, y1: s.to.y, elbow: s.elbow };
}

export const elbowArrowPlugin = {
  type: "elbow_arrow",
  title: "Elbow Arrow",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "elbow_arrow", z: 1,
    from: { x: 200, y: 260 }, to: { x: 420, y: 380 },
    elbow: 0.5,
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
    { key: "elbow", label: "Elbow", kind: "number", min: 0, max: 1, category: "arrow" },
  ],
  /**
   * Pure function. State → display-list commands. The route is a 4-point
   * polyline (H-V-H); heads sit on the FINAL leg into each active end (the
   * last segment before `to` for the end head, the first segment out of
   * `from` for the start head — both horizontal by construction, since H-V-H
   * always starts and ends with a horizontal leg), pulled back exactly like
   * the basic arrow's shaft.
   */
  emit(s) {
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
    return cmds;
  },
  hitTestWorld(node, wx, wy) {
    const s = node.state;
    const route = elbowRoute(routeParams(s)).map(([x, y]) => ({ x, y }));
    const radius = (s.strokeWidth ?? 3) / 2;
    for (let i = 0; i < route.length - 1; i++)
      if (distToSegment(wx, wy, route[i], route[i + 1]) <= radius + SHAFT_GRAB_PAD)
        return true;
    return false;
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js), identical semantics to the basic arrow.
  ...endpointPairHooks(),
  /**
   * Pure function. ONE modifier point at the elbow's mid-segment midpoint
   * (core/outline.js's elbowHandle — "the PPT yellow square on the elbow"),
   * dragged to scrub `elbow` (0..1). `apply` projects the dragged point onto
   * the x-span (the handle's ONE constrained trajectory, matching the
   * generator's own `t = (x1−x0)`-relative parameterization) — the y-drag
   * component is intentionally ignored, same "highly-constrained... often
   * parameterized by ONE number" rule donut's inner-radius handle follows.
   */
  modifierPoints(s) {
    const h = elbowHandle(routeParams(s));
    return [{
      id: "elbow", x: h.x, y: h.y,
      apply(state, localPoint) {
        // Re-derive the span from the LIVE state passed at drag time (not
        // the state modifierPoints was originally called with) — the drag
        // handler re-reads apply() on every move against the current node,
        // so this must be self-contained (same discipline donut's apply
        // follows: "apply operates entirely in the item's own local frame").
        const span = state.to.x - state.from.x;
        if (span === 0) return { elbow: state.elbow ?? 0.5 }; // no x-span to project onto — leave unchanged
        const t = (localPoint.x - state.from.x) / span;
        return { elbow: Math.max(0, Math.min(t, 1)) };
      },
    }];
  },
  commands: [
    { id: "add-elbow-arrow", title: "Add Elbow Arrow", icon: "mdi:arrow-top-right-bottom-left", run: (app) => app.addItem(elbowArrowPlugin.defaults) },
  ],
};
