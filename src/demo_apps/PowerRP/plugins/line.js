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
 * props (core/properties.js), same as every stroked shape. `cap` is the one
 * knob still local to this widget; the DASH triple is shared with the whole
 * connector family now (core/endpoints.js CONNECTOR_DASH_ROWS), because `dashed`
 * living on the one connector with NO head meant a dotted arrow had no faithful
 * expression anywhere in the app. Both are implemented purely in emit() as
 * GEOMETRY, because
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

import { polyline, path } from "../render_gpu/ir.js";
import { subpathsPathD } from "../core/shapes.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { endpointPairHooks, hitsShaft, connectorPathAnchors, dashedSpans, CONNECTOR_DASH_ROWS, CONNECTOR_DASH_DEFAULTS, ARROW_STROKE_WIDTH } from "../core/endpoints.js";

/**
 * Line end-cap kinds. "round" is the display-list `polyline`'s native cap (a
 * semicircle bulging half a stroke-width past each endpoint); "butt" ends flush
 * exactly at the endpoint; "square" ends flat but extends half a stroke-width
 * past it (SVG stroke-linecap semantics). Exported as data (like endpoints.js
 * HEAD_SHAPES) so the inspector row and tests share one list.
 *
 * @example LINE_CAPS // ["round", "butt", "square"]
 */
export const LINE_CAPS = ["round", "butt", "square"];
export const LINE_CAP_LABELS = { round: "Round", butt: "Butt", square: "Square" };

/**
 * Pure function. The 4 corner points of a rectangular stroke piece for the A→B
 * sub-segment at `width`, for a FLAT cap. "butt" ends flush at A and B; "square"
 * pushes each end outward by half the width along the axis. Only used for the flat
 * caps — a round cap uses polyline instead.
 *
 * EVERY RECT WINDS THE SAME WAY, and that is load-bearing rather than incidental:
 * emit() joins a dash run's rects into ONE `path` op, where consistent winding is
 * what makes overlapping pieces UNION under the non-zero rule. See emit() for why
 * they are one op and what happens when they are not.
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

/**
 * THE LINE'S STYLE LIBRARY.
 *
 * THE FIRST EIGHT ARE ISO 128-20's OWN ARITHMETIC, NOT TASTE. That standard gives
 * every dash element as a MULTIPLE OF THE LINE WIDTH d — gap 3d, short dash 6d,
 * dash 12d, long dash 24d, dot <= 0.5d — and its weight ladder as
 * extra-wide : wide : narrow = 4 : 2 : 1. Because the elements are ratios rather
 * than millimetres they carry into canvas units unchanged, so "Dashed Line" at
 * d = 1.5 really is the hidden-detail line: 12d = 18 drawn, 3d = 4.5 skipped.
 *
 * `cap` IS GEOMETRY, NOT A FLAG: the display list's polyline is round-cap-only, so
 * a flat-capped line is emitted as a filled rectangle instead. Every cap value
 * really does change the picture.
 *
 * A DOT NEEDS A SMALL POSITIVE DASH, NEVER ZERO: dashedSpans treats a non-positive
 * dash length as "solid", so Dotted Line uses ISO's 0.5d and lets the round caps do
 * the rest.
 *
 * THE FIVE SOLID PRESETS STILL SPELL OUT dashLength AND dashGap, because
 * application is an overlay: without them, hovering Zebra Bar and then clicking
 * Continuous Narrow would leave a "continuous" line chopped into 22-unit bars.
 */
const PRESETS = [
  { name: "Continuous Extra-Wide", description: "The heaviest of the three standard weights — a cut edge or section line, at four times the narrow width.", props: { cap: "butt", dashed: false, dashLength: 12, dashGap: 3, strokeWidth: 4 } },
  { name: "Continuous Wide", description: "The standard \"wide\" weight: the visible outline of a part, twice the narrow width.", props: { cap: "butt", dashed: false, dashLength: 12, dashGap: 3, strokeWidth: 2 } },
  { name: "Continuous Narrow", description: "The standard \"narrow\" weight — what dimension, extension and leader lines are drawn with.", props: { cap: "butt", dashed: false, dashLength: 12, dashGap: 3, strokeWidth: 1 } },
  { name: "Hairline Rule", description: "Finer than the finest technical pen: a divider that separates without competing for attention.", props: { cap: "round", dashed: false, dashLength: 12, dashGap: 3, strokeWidth: 0.5 } },
  { name: "Long-Dashed Line", description: "The long twenty-four-width dash of a centre or phantom line, over the standard three-width gap.", props: { cap: "butt", dashed: true, dashLength: 24, dashGap: 3, strokeWidth: 1 } },
  { name: "Dashed Line", description: "The hidden-detail line exactly as specified: a twelve-width dash over a three-width gap, flush-ended.", props: { cap: "butt", dashed: true, dashLength: 18, dashGap: 4.5, strokeWidth: 1.5 } },
  { name: "Short-Dashed Line", description: "The six-width dash — the tighter rhythm used where a run is too short to carry full dashes.", props: { cap: "butt", dashed: true, dashLength: 6, dashGap: 3, strokeWidth: 1 } },
  { name: "Dotted Line", description: "The dot element on a three-width gap, rounded so each mark reads as a point rather than a stub.", props: { cap: "round", dashed: true, dashLength: 1.25, dashGap: 7.5, strokeWidth: 2.5 } },
  { name: "Cut Here", description: "The scissors line: long dashes with long gaps and squared ends, meant to be followed with a blade.", props: { cap: "square", dashed: true, dashLength: 18, dashGap: 14, strokeWidth: 2 } },
  { name: "Rope Ladder", description: "Dash and gap equal and chunky at a heavy weight — read as a rhythm rather than as a rule.", props: { cap: "round", dashed: true, dashLength: 14, dashGap: 14, strokeWidth: 8 } },
  { name: "Zebra Bar", description: "Heavy square dashes separated by narrow gaps, so the whole run reads as one segmented bar.", props: { cap: "square", dashed: true, dashLength: 22, dashGap: 5, strokeWidth: 12 } },
  { name: "Marker Underline", description: "A thick flat swipe under a phrase — a chisel-tip marker stroke rather than a drawn line.", props: { cap: "butt", dashed: false, dashLength: 12, dashGap: 3, strokeWidth: 16 } },
];

export const linePlugin = {
  type: "line",
  title: "Line",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  presets: PRESETS,
  defaults: {
    type: "line", z: 1,
    from: { x: 200, y: 300 }, to: { x: 420, y: 300 },
    // stroke color + width reuse the shared registry props (single-sourced);
    // ARROW_STROKE_WIDTH (core/endpoints.js) is the arrow-family default shaft.
    stroke: "#000000", strokeWidth: ARROW_STROKE_WIDTH, opacity: 1,
    cap: "round", ...CONNECTOR_DASH_DEFAULTS,
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
    ...CONNECTOR_DASH_ROWS,
  ],
  /**
   * Pure function. State → display-list commands. Endpoints are evaluated
   * numbers and the line's world transform is IDENTITY (no x/y/rotation/scale
   * state), so these local commands are already world coordinates. Each drawn
   * dash span (one span when not dashed) becomes a round-capped polyline OR, for
   * a flat cap, a filled rectangle (capRect) — the display-list polyline is
   * round-only, so flat caps are drawn as geometry.
   *
   * THE FLAT-CAP DASHES ARE ONE `path` OP, NOT ONE PER DASH, and this was measured
   * (R6-11's generalization: a shape split across N ops composites N times). A
   * "square" cap pushes each dash outward by half the stroke width, so whenever
   * `dashGap` is under the stroke width consecutive dashes OVERLAP — and one op per
   * dash composited that overlap TWICE. On a translucent line the overlaps read as
   * bright bands: measured along the centre of a 40-wide, opacity-0.5 line with
   * dashLength 30 / dashGap 14, the row carried TWO levels, 128 and 192, where it
   * should carry one. Widen the gap past the cap extension and the second level
   * disappears — which is what identifies the cause as the op split rather than the
   * geometry. One op composites once: 128 everywhere, at every gap.
   *
   * NON-ZERO, AND THE WINDING IS WHY. capRect winds every rect the same way, so
   * overlapping pieces UNION under non-zero. Even-odd was rendered too and does the
   * opposite — it punches a HOLE through each overlap, turning the bright bands into
   * gaps. So the rule is read off the geometry, not defaulted to.
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
    // The shared arc-length dasher (core/endpoints.js dashedSpans) — this plugin's
    // own dashSpans WAS that function, per-segment; it moved so the three headed
    // arrows could dash too, and generalized to cross a vertex on the way.
    // A line is always TWO points, so every run here is a 2-point run and capRect
    // reads run[0]/run[1] exactly as it always did.
    const spans = (s.dashed ? dashedSpans([from, to], s.dashLength, s.dashGap) : [[from, to]]).map((run) => [run[0], run[run.length - 1]]);
    const cmds = cap === "round"
      ? spans.map(([p, q]) => polyline({ points: [[p.x, p.y], [q.x, q.y]], width, color: s.stroke, opacity }))
      // fillRule is spelled out even though "nonzero" is the op's default: here it is a
      // LOAD-BEARING claim about capRect's consistent winding, not a shrug (donut.js and
      // fancy_arrow.js state theirs for the same reason).
      : [path({ d: subpathsPathD(spans.map(([p, q]) => capRect(p, q, width, cap))), fill: s.stroke, fillRule: "nonzero", opacity })];
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
  // THE ANCHOR PROTOCOL: start / mid / end on the drawn segment (core/endpoints.js
  // connectorPathAnchors — the whole connector family publishes the same three).
  anchors: (s) => connectorPathAnchors([s.from, s.to]),
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
