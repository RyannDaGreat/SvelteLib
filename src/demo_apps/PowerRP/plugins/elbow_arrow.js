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
 * `elbow` (0..1): the mid-segment's position along the endpoints' span.
 * Controlled by ONE MODIFIER POINT at the middle segment's midpoint
 * (core/outline.js's elbowHandle) — "the PPT yellow square on the elbow".
 *
 * `orient` ("hvh" default | "vhv"): leg order. "vhv" starts and ends VERTICAL
 * — the flowchart TREE-BRANCH route (trunk down from a box's bm, rail across,
 * drop into the target's tm), which H-V-H structurally cannot draw (it exits
 * sideways from a bottom anchor).
 *
 * `bulge` (signed px, default 0, Inspector-only): absolute offset of the
 * middle leg beyond the span-relative `elbow` position. THE LOOP ENABLER: a
 * feedback loop between two stacked boxes anchors mr→mr (or ml→ml) with a
 * ZERO span, where every `elbow` value collapses the route to a straight
 * line down the box edges — only an absolute offset can push the leg out.
 * The canvas handle scrubs `elbow` only (its constraint segment rides the
 * bulged leg); `bulge` is set in the Inspector or by an equation.
 *
 * headStart/headEnd (the per-end head SHAPE selects, core/endpoints.js
 * HEAD_SHAPES) and the stroke/strokeWidth naming are identical in spirit to the
 * basic arrow — this is a NEW plugin (not a migrated one), so it's born with the
 * current names directly; no legacyKeys entry is needed (there is no prior
 * "color/width" era to migrate from).
 *
 * Endpoint semantics (from/to may be equations, no transform of its own,
 * shaft-drag translation) come from core/endpoints.js — the shared home,
 * since plugins may not import each other (registry rule). "Shaft" hit-
 * testing here means the whole 3-segment route, not a single straight
 * segment — hitTestWorld checks all three legs.
 */

import { polyline, polygon, path } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { elbowRoute, elbowHandle, closestPointOnSegment } from "../core/outline.js";
import { endpointPairHooks, arrowHeads, connectorPathAnchors, dashedSpans, ARROW_HEAD_ROWS, CONNECTOR_DASH_ROWS, CONNECTOR_DASH_DEFAULTS, hitsPolylineShaft, ARROW_ENDPOINT_DEFAULTS, ARROW_STROKE_WIDTH, ARROW_HEAD_WIDTH } from "../core/endpoints.js";

/** Pure function. The route generator's params for a state.
 * @example routeParams({from: {x: 0, y: 0}, to: {x: 100, y: 50}, elbow: 0.5}) // {x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5, orient: undefined, bulge: undefined}
 */
function routeParams(s) {
  return { x0: s.from.x, y0: s.from.y, x1: s.to.x, y1: s.to.y, elbow: s.elbow, orient: s.orient, bulge: s.bulge };
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
 * The route hull, not the endpoint hull — and since `bulge` landed this is a
 * REQUIREMENT, not an observation: a bulged middle leg sits OUTSIDE the
 * endpoints' own AABB (that is its whole point — the rectangular loop), so
 * only the full 4-point route hull covers the ink.
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
    orient: "hvh", // "vhv" = vertical-first (tree branches); see the docblock
    bulge: 0, // signed px offset of the middle leg (loops); Inspector-only
    stroke: "#000000", ...ARROW_ENDPOINT_DEFAULTS, ...CONNECTOR_DASH_DEFAULTS, opacity: 1,
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
    ...ARROW_HEAD_ROWS,
    ...CONNECTOR_DASH_ROWS,
    { key: "elbow", label: "Elbow", kind: "number", min: 0, max: 1, category: "arrow", help: "Where the middle bend sits along the endpoint span, from 0 (flush at the start) to 1 (flush at the end). Drag the yellow handle on canvas." },
    { key: "orient", label: "Route", kind: "select", options: ["hvh", "vhv"], optionLabels: { hvh: "Horizontal first", vhv: "Vertical first" }, category: "arrow", help: "Leg order. Horizontal-first is the classic side-to-side elbow; vertical-first starts and ends vertically — the flowchart tree branch (out of a box's bottom, across, into the next box's top)." },
    { key: "bulge", label: "Bulge", kind: "number", scrub: 1, category: "arrow", help: "Pushes the middle leg sideways by this many canvas units beyond its span position (signed). What makes a rectangular feedback LOOP between two same-edge anchors possible — with both endpoints on one vertical line, only an absolute offset can bow the route out of the boxes." },
  ],
  /**
   * Pure function. State → display-list commands. The route is a 4-point
   * polyline (H-V-H, or V-H-V when `orient` is "vhv"); heads sit on the FINAL
   * leg into each active end (the last segment before `to` for the end head,
   * the first segment out of `from` for the start head — the pullback and the
   * head triangle are direction-generic, so both orients work unchanged),
   * pulled back exactly like the basic arrow's shaft.
   */
  emit(s, _targetWorldIR, world) {
    // elbowRoute returns [x,y] pairs (render_gpu/ir.js's points convention);
    // convert to {x,y} objects here since every other function in this file
    // (headTriangle, the pullback helper) uses the {x,y} convention.
    const [p0, p1, p2, p3] = elbowRoute(routeParams(s)).map(([x, y]) => ({ x, y }));
    const opacity = s.opacity ?? 1;
    const heads = arrowHeads(s, { tip: p3, from: p2 }, { tip: p0, from: p1 });
    // Shorten the route's own end segments by each head's pullback, along that
    // segment's own direction — the basic arrow's shaft pullback generalized to
    // "the last/first leg of a multi-segment route" instead of "the only
    // segment". A zero pullback (no head, or a glyph the line runs into) leaves
    // the leg exactly where the route put it.
    const pullback = (a, b, dist) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = Math.min(dist / len, 1);
      return { x: b.x - (b.x - a.x) * t, y: b.y - (b.y - a.y) * t };
    };
    const shaftPts = [pullback(p1, p0, heads.pullback.start), p1, p2, pullback(p2, p3, heads.pullback.end)];
    // THE DASHED SHAFT: one polyline per DRAWN run (core/endpoints.js dashedSpans;
    // a solid shaft is the one-run degenerate case, byte-identical to before).
    // Geometry rather than the `dashes` stroke material, and that is measured, not
    // taste: a material stroke is refused by both vector exporters and rasterized,
    // so a dashed arrow would export as a bitmap. See dashedSpans' docblock.
    const runs = s.dashed ? dashedSpans(shaftPts, s.dashLength, s.dashGap) : [shaftPts];
    const cmds = runs.map((run) => polyline({ points: run.map((p) => [p.x, p.y]), width: s.strokeWidth, color: s.stroke, opacity }));
    // THE LAYERING SEAM — see core/endpoints.js arrowHeads (and arrow.js's twin).
    cmds.push(...heads.ops.map((h) => (h.d ? path(h) : polygon(h))));
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
  // THE ANCHOR PROTOCOL: start / mid / end along the 4-point ROUTE, by arc length
  // — so `mid` lands on the middle leg (where a flowchart label belongs) rather
  // than at the centre of a bounding box the route only ever hugs two sides of.
  anchors: (s) => connectorPathAnchors(elbowRoute(routeParams(s)).map(([x, y]) => ({ x, y }))),
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
      // The allowed set is the SEGMENT the elbow slides along — offset by
      // `bulge` so it always lies ON the (possibly bulged) middle leg, and
      // orient-mirrored: hvh slides in x at the vertical run's midpoint,
      // vhv slides in y at the horizontal run's midpoint. The handle scrubs
      // `elbow` ONLY; `bulge` stays an Inspector knob (see the docblock).
      constrain(state, desired) {
        const b = state.bulge ?? 0;
        if (state.orient === "vhv") {
          const midX = (state.from.x + state.to.x) / 2;
          return closestPointOnSegment({ x: midX, y: state.from.y + b }, { x: midX, y: state.to.y + b }, desired);
        }
        const midY = (state.from.y + state.to.y) / 2;
        return closestPointOnSegment({ x: state.from.x + b, y: midY }, { x: state.to.x + b, y: midY }, desired);
      },
      apply(state, allowed) {
        const b = state.bulge ?? 0;
        const vhv = state.orient === "vhv";
        const span = vhv ? state.to.y - state.from.y : state.to.x - state.from.x;
        // A zero span has no fraction to read (the allowed set collapsed to a
        // point) — a technical division guard, not a bound on `elbow`.
        if (span === 0) return { elbow: state.elbow ?? 0.5 };
        const along = vhv ? allowed.y - b - state.from.y : allowed.x - b - state.from.x;
        return { elbow: along / span };
      },
    }];
  },
  // CROSSHAIR PLACEMENT (manifest UNDEFERRAL SWEEP): places by from→to endpoints.
  placement: "endpoints",
  commands: [
    { id: "add-elbow-arrow", title: "Add Elbow Arrow", icon: "mdi:arrow-top-right-bottom-left", run: (app) => app.armCrosshairPlacement(elbowArrowPlugin) },
  ],
};
