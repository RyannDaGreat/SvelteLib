/**
 * Line widget — the SIMPLEST arrow-family member: a straight stroke between two
 * endpoints, with NO arrowhead (arrow.js minus the head geometry). Endpoints are
 * plain {x, y} pairs whose coordinates may be EQUATIONS (anchor bindings — THE
 * UNIFICATION), exactly like the arrow; by emit time the derivation stage has
 * evaluated every equation, so this plugin only ever sees numbers.
 *
 * Like the arrow, the line has no transform of its own (world == local); shaft
 * drags translate the endpoints directly via the moveBy hook — equation-bound
 * coordinates stay put, free ones translate. The endpoint plumbing
 * (editPoints/moveBy/closestToward + the padded shaft grab) comes from
 * core/endpoints.js — the ONE home shared by all arrow-family widgets.
 *
 * STROKE STYLE — color/width reuse the shared `stroke`/`strokeWidth` registry
 * props (core/properties.js), same as every stroked shape. Two line-specific
 * knobs live in a "line" extras category (the arrow's "arrow"-category
 * precedent): a `cap` end shape and a `dashed` on/off with a `dashLength`/
 * `dashGap` pattern. Both are implemented purely in emit() as GEOMETRY, because
 * the display-list `polyline` op is round-cap-only with no dash support (a
 * deliberate "COMING" gap in render_gpu — see the dash/cap notes in
 * core/properties.js): a dash chops the segment into drawn sub-spans, and a flat
 * cap (butt/square) is emitted as a filled rectangle instead of a round-capped
 * polyline. So every cap value renders a visibly distinct shape (no fake option).
 *
 * Add-command: registered in web/App.svelte (NOT here), matching the demo/
 * shapeshifter precedent where App.svelte owns the insert command — the command
 * registry throws on a duplicate id, so a single owner is mandatory.
 */

import { polyline, polygon } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { endpointPairHooks, hitsShaft, ARROW_STROKE_WIDTH } from "../core/endpoints.js";

/**
 * Line end-cap kinds. "round" is the display-list `polyline`'s native cap (a
 * semicircle bulging half a stroke-width past each endpoint); "butt" ends flush
 * exactly at the endpoint; "square" ends flat but extends half a stroke-width
 * past it (SVG stroke-linecap semantics). Exported as data (like endpoints.js
 * HEAD_MODES) so the inspector row and tests share one list.
 *
 * @example LINE_CAPS // ["round", "butt", "square"]
 */
export const LINE_CAPS = ["round", "butt", "square"];
export const LINE_CAP_LABELS = { round: "Round", butt: "Butt", square: "Square" };

// Default dash pattern, in canvas units. A dash a few multiples of the default
// stroke width (ARROW_STROKE_WIDTH = 3) reads clearly as "dashed", with a gap
// a touch shorter than the dash so the line still reads as one line.
const DEFAULT_DASH_LENGTH = 12;
const DEFAULT_DASH_GAP = 8;

/**
 * Pure function. The DRAWN spans of a (possibly) dashed segment A→B: walks the
 * A→B axis in alternating dashLength (drawn) / dashGap (skipped) steps, returning
 * each drawn span as a [P, Q] pair of {x, y} points. A non-positive dashLength or
 * dashGap (or a zero-length segment) means "not dashed" — the whole segment is a
 * single span, so a solid line is just the degenerate case (and there is no way
 * to loop forever on a zero step).
 *
 * @param {{x:number,y:number}} a - segment start
 * @param {{x:number,y:number}} b - segment end
 * @param {number} dashLength - drawn dash length (canvas units)
 * @param {number} dashGap - skipped gap length (canvas units)
 * @returns {Array<[{x:number,y:number},{x:number,y:number}]>} drawn spans
 *
 * @example dashSpans({x:0,y:0}, {x:10,y:0}, 4, 4).length // 2  (0..4 and 8..10)
 * @example dashSpans({x:0,y:0}, {x:10,y:0}, 0, 4) // [[{x:0,y:0},{x:10,y:0}]] (solid)
 */
export function dashSpans(a, b, dashLength, dashGap) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(dashLength > 0) || !(dashGap > 0) || len === 0) return [[a, b]];
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const spans = [];
  for (let d = 0; d < len; d += dashLength + dashGap) {
    const end = Math.min(d + dashLength, len);
    spans.push([{ x: a.x + ux * d, y: a.y + uy * d }, { x: a.x + ux * end, y: a.y + uy * end }]);
  }
  return spans;
}

/**
 * Pure function. The 4 corner points of a rectangular stroke piece for the A→B
 * sub-segment at `width`, for a FLAT cap. "butt" ends flush at A and B; "square"
 * pushes each end outward by half the width along the axis. Corners wind around
 * the rectangle so polygon() (which fan-triangulates a convex polygon) fills it
 * solid. Only used for the flat caps — a round cap uses polyline instead.
 *
 * @param {{x:number,y:number}} a - sub-segment start
 * @param {{x:number,y:number}} b - sub-segment end
 * @param {number} width - stroke width (canvas units)
 * @param {"butt"|"square"} cap - flat cap kind (square extends the ends)
 * @returns {number[][]} four [x, y] corner points, convex, in winding order
 *
 * @example capRect({x:0,y:0}, {x:10,y:0}, 4, "butt") // [[0,2],[10,2],[10,-2],[0,-2]]
 * @example capRect({x:0,y:0}, {x:10,y:0}, 4, "square")[0] // [-2, 2]
 */
export function capRect(a, b, width, cap) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1; // degenerate span: axis is arbitrary, rect collapses anyway
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const half = width / 2;
  const ext = cap === "square" ? half : 0;
  const ax = a.x - ux * ext, ay = a.y - uy * ext;
  const bx = b.x + ux * ext, by = b.y + uy * ext;
  const nx = -uy * half, ny = ux * half; // half-width offset along the normal
  return [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
}

/**
 * Pure function. The LOCAL rect the line's INK occupies: the AABB of its two
 * endpoints, padded on every side by the full stroke width. The line has no
 * transform of its own (world == identity), so this is also its world footprint.
 *
 * ONE ink rect, THREE consumers (the plugins/polygon.js polygonInkRect
 * precedent): the effect substrate in emit() below (an under-sized substrate
 * CLIPS the widget, not just its halo), and — via the `localBounds` declaration
 * — culling plus rubber-band selection (core/view.js localBoundsOf). Before that
 * hook existed a line reported NO bounds at all, so it could never be
 * band-selected and never culled however far off-screen it sat.
 *
 * A FULL-width pad is deliberately conservative rather than exact: the widest
 * true overhang is a square cap's corner at strokeWidth/2·√2 ≈ 0.71·strokeWidth,
 * so the ink can never escape this rect. Bounds may over-estimate (a widget is
 * merely painted when it need not have been); under-estimating would pop a
 * visible line out of view at the canvas edge.
 *
 * @param {object} s - evaluated item state (from / to / strokeWidth)
 * @returns {{x: number, y: number, w: number, h: number}} local rect
 *
 * @example lineInkRect({from: {x: 10, y: 20}, to: {x: 110, y: 60}, strokeWidth: 5}) // {x: 5, y: 15, w: 110, h: 50}
 * @example lineInkRect({from: {x: 0, y: 0}, to: {x: 0, y: 0}}) // {x: -3, y: -3, w: 6, h: 6} (zero-length: still a round dot of ink)
 */
export function lineInkRect(s) {
  return paddedPointsBBox([s.from, s.to], s.strokeWidth ?? ARROW_STROKE_WIDTH);
}

export const linePlugin = {
  type: "line",
  title: "Line",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "line", z: 1,
    from: { x: 200, y: 300 }, to: { x: 420, y: 300 },
    // stroke color + width reuse the shared registry props (single-sourced);
    // ARROW_STROKE_WIDTH (core/endpoints.js) is the arrow-family default shaft.
    stroke: "#000000", strokeWidth: ARROW_STROKE_WIDTH, opacity: 1,
    cap: "round", dashed: false, dashLength: DEFAULT_DASH_LENGTH, dashGap: DEFAULT_DASH_GAP,
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY: the `endpoints` bundle
  // (from/to/z — equation-aware) + shared stroke/strokeWidth/opacity + effects.
  // The cap + dash rows are line-specific (a "line" extras category).
  inspector: [
    ...bundle("endpoints"),
    ...props("stroke", "strokeWidth"),
    ...props("opacity"),
    ...bundle("effects"),
    { key: "cap", label: "Cap", kind: "select", options: LINE_CAPS, optionLabels: LINE_CAP_LABELS, category: "line", help: "How the line's ends are shaped: round (a semicircle past each end), butt (a flat end exactly at the point), or square (a flat end reaching half the width past the point)." },
    { key: "dashed", label: "Dashed", kind: "boolean", category: "line", help: "Draw the line as a dashed pattern instead of one solid stroke." },
    { key: "dashLength", label: "Dash length", kind: "number", min: 0, category: "line", help: "Length of each drawn dash, in canvas units. Only applies when Dashed is on." },
    { key: "dashGap", label: "Dash gap", kind: "number", min: 0, category: "line", help: "Length of the empty gap between dashes, in canvas units. Only applies when Dashed is on." },
  ],
  /**
   * Pure function. State → display-list commands. Endpoints are evaluated
   * numbers and the line's world transform is IDENTITY (no x/y/rotation/scale
   * state), so these local commands are already world coordinates. Each drawn
   * dash span (one span when not dashed) becomes a round-capped polyline OR, for
   * a flat cap, a filled rectangle (capRect) — the display-list polyline is
   * round-only, so flat caps are drawn as geometry.
   *
   * @param {object} s - evaluated item state
   * @param {object} _targetWorldIR - unused (bbox widgets' resolved target)
   * @param {object} world - world transform (for the effects pass)
   * @returns {object[]} display-list commands (effects-wrapped)
   */
  emit(s, _targetWorldIR, world) {
    const { from, to } = s;
    const opacity = s.opacity ?? 1;
    const width = s.strokeWidth ?? ARROW_STROKE_WIDTH;
    const cap = s.cap ?? "round";
    const spans = s.dashed ? dashSpans(from, to, s.dashLength, s.dashGap) : [[from, to]];
    const cmds = spans.map(([p, q]) =>
      cap === "round"
        ? polyline({ points: [[p.x, p.y], [q.x, q.y]], width, color: s.stroke, opacity })
        : polygon({ points: capRect(p, q, width, cap), fill: s.stroke, opacity }));
    // Effects (shadow/bloom/blend — the shared EFFECTS BUNDLE) wrap the finished
    // op list; all-off = pass-through. The line has no bbox state (world ==
    // identity), so the effect region is its ink rect — the SAME rect
    // `localBounds` reports, so the substrate and the cull/band bounds can never
    // disagree about where this widget is.
    return applyEffects(cmds, s, world, lineInkRect(s));
  },
  // THE BOUNDS PROTOCOL (core/view.js localBoundsOf): a line's width and height
  // are just the min/max of its endpoints, so it band-selects and culls like any
  // box widget despite having no w/h state and no resize handles.
  localBounds: lineInkRect,
  // Effects halo (shadow/bloom spill) extends the cull AABB — core/view.js
  // defaultCanSkip's cullMargin hook. MANDATORY now that a line HAS an AABB to
  // be culled by: without it a shadowed line just off-view loses its halo.
  cullMargin: effectsCullMargin,
  hitTestWorld(node, wx, wy) {
    return hitsShaft(node.state, wx, wy, node.state.strokeWidth ?? ARROW_STROKE_WIDTH);
  },
  // editPoints / moveBy / closestToward — the shared endpoint-pair capability
  // (core/endpoints.js: draggable endpoint handles, free-coordinate shaft
  // translation, closest-anchor toward-context).
  ...endpointPairHooks(),
  // CROSSHAIR PLACEMENT (manifest UNDEFERRAL SWEEP): a line places by its
  // ENDPOINTS — a click-drag lays from→to; a plain click places a default-length
  // line rightward from the point (CanvasView.placementUp, shared with arrows).
  placement: "endpoints",
};
