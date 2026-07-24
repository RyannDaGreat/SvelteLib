/**
 * Tangent Lines — a reusable CORE widget that draws the TWO outer (external)
 * tangent segments connecting two boundary shapes: the classic infographic
 * "zoom into this" / detail-loupe callout bridge. It is a pure GEOMETRY widget
 * — it owns no picture of its own beyond the two connecting strokes; it reads a
 * pair of shapes (A, B) whose centers/sizes are ordinary EQUATION-BINDABLE
 * properties, so in practice A is bound to one widget's anchor and B to
 * another's (THE UNIFICATION — anchors are just variables). By emit time the
 * derivation stage has evaluated every equation, so this plugin only ever sees
 * numbers (the line.js precedent).
 *
 * Two shape KINDS are handled with exact closed-form geometry, plus a general
 * fallback:
 *   - circle ↔ circle : the two external tangent lines (centers + radii).
 *   - box ↔ box       : the two outer connecting edges of the convex hull of
 *                       the two axis-aligned rectangles.
 *   - anything else   : each shape is replaced by its BOUNDING CIRCLE and the
 *                       circle formula is used (the general fallback).
 * When the shapes coincide or one contains the other, there is no external
 * tangent and NOTHING is drawn (a degenerate, not an error — expected control
 * flow at the identity end of a zoom-callout tween).
 *
 * This file ALSO exports the pure TELESCOPIC-MAGNIFIER rig builder: the three
 * equation-valued property OVERRIDE dicts (source marker / magnify lens /
 * tangent lines) a command spreads over the registry defaults to mint the rig.
 * The builder emits only string type-names and `=` equations — it imports NO
 * other plugin (composition is via document state + equations ONLY).
 *
 * DOM-free / bare-node-safe at import time (mirrors line.js / the demo widgets).
 */

import { polyline } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { applyEffects, paddedPointsBBox } from "../render_gpu/effects.js";

// Two shapes are "coincident" (no meaningful external tangent) when their
// centers are within this distance — the identity end of a zoom-callout tween,
// where source and lens sit on top of each other.
const COINCIDENT_EPS = 1e-6;

// Default dash pattern, in canvas units (the line.js values): a dash a few
// stroke-widths long reads clearly as "dashed", with a slightly shorter gap so
// the callout still reads as one connecting line.
const DEFAULT_DASH_LENGTH = 14;
const DEFAULT_DASH_GAP = 9;
const DEFAULT_STROKE_WIDTH = 2;

// ── Pure tangent geometry ─────────────────────────────────────────────────────

/**
 * Pure function. The bounding circle of a shape descriptor — the general
 * fallback used when a pair is not both-circle or both-box. A circle is its
 * own bounding circle; a box's bounding circle is the circumscribed one
 * (radius = the half-diagonal hypot(halfW, halfH)).
 *
 * @param {{kind:string,x:number,y:number,r?:number,halfW?:number,halfH?:number}} shape
 * @returns {{x:number,y:number,r:number}}
 *
 * @example boundingCircle({ kind: "circle", x: 0, y: 0, r: 5 }) // {x: 0, y: 0, r: 5}
 * @example boundingCircle({ kind: "box", x: 20, y: 0, halfW: 3, halfH: 4 }) // {x: 20, y: 0, r: 5}
 */
export function boundingCircle(shape) {
  if (shape.kind === "circle") return { x: shape.x, y: shape.y, r: shape.r };
  return { x: shape.x, y: shape.y, r: Math.hypot(shape.halfW, shape.halfH) };
}

/**
 * Pure function. The two EXTERNAL tangent segments of two circles a, b (each
 * {x, y, r}). Both circles lie on the same side of each external tangent line.
 *
 * Derivation: an external tangent has unit normal n with n·a - c = r_a and
 * n·b - c = r_b (SAME side), so n·(a-b) = r_a - r_b. With u = (a-b)/|a-b| and
 * d = |a-b|, this fixes the angle between n and u to ±φ where cos φ =
 * (r_a - r_b)/d — the two signs give the two tangents. The tangent point on
 * each circle is Cᵢ - rᵢ·n. Returns [] (degenerate) when the circles coincide
 * (d ≈ 0) or one contains the other (d ≤ |r_a - r_b|), where no external
 * tangent exists.
 *
 * @param {{x:number,y:number,r:number}} a
 * @param {{x:number,y:number,r:number}} b
 * @returns {Array<[{x:number,y:number},{x:number,y:number}]>} up to two [A-point, B-point] segments
 *
 * @example
 * // Equal circles → two parallel tangents offset by the radius:
 * circleExternalTangents({ x: 0, y: 0, r: 2 }, { x: 10, y: 0, r: 2 })
 * // [[{x:0,y:2},{x:10,y:2}],[{x:0,y:-2},{x:10,y:-2}]]
 * @example
 * // 3-4-5 case, first tangent:
 * circleExternalTangents({ x: 0, y: 0, r: 4 }, { x: 5, y: 0, r: 1 })[0]
 * // [{x:2.4,y:3.2},{x:5.6,y:0.8}]
 * @example circleExternalTangents({ x: 0, y: 0, r: 5 }, { x: 1, y: 0, r: 1 }) // [] (contained)
 */
export function circleExternalTangents(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  const d = Math.hypot(dx, dy);
  const dr = a.r - b.r;
  if (d < COINCIDENT_EPS || d <= Math.abs(dr)) return [];
  const ux = dx / d, uy = dy / d;
  const cos = dr / d;
  const sin = Math.sqrt(1 - cos * cos);
  const out = [];
  for (const s of [1, -1]) {
    const nx = ux * cos - s * uy * sin; // n = u rotated by s·φ
    const ny = uy * cos + s * ux * sin;
    out.push([
      { x: a.x - a.r * nx, y: a.y - a.r * ny },
      { x: b.x - b.r * nx, y: b.y - b.r * ny },
    ]);
  }
  return out;
}

/**
 * Pure function. The four corners of an axis-aligned box, clockwise from the
 * top-left. `tag` marks which box a corner came from (for hull bridge finding).
 *
 * @param {{x:number,y:number,halfW:number,halfH:number}} box
 * @param {number} tag - box identity (0 or 1)
 * @returns {Array<{x:number,y:number,tag:number}>}
 *
 * @example boxCorners({ x: 0, y: 0, halfW: 1, halfH: 1 }, 0)[0] // {x: -1, y: -1, tag: 0}
 */
export function boxCorners(box, tag) {
  const { x, y, halfW, halfH } = box;
  return [
    { x: x - halfW, y: y - halfH, tag },
    { x: x + halfW, y: y - halfH, tag },
    { x: x + halfW, y: y + halfH, tag },
    { x: x - halfW, y: y + halfH, tag },
  ];
}

/**
 * Pure function. The convex hull (counter-clockwise) of a point set, by
 * Andrew's monotone chain. Collinear points are dropped (strict `<= 0` turn
 * test), so a hull edge spanning several input points is ONE edge. Each
 * returned point is an input object (its extra fields, e.g. `tag`, survive).
 *
 * @param {Array<{x:number,y:number}>} points
 * @returns {Array<{x:number,y:number}>} hull vertices, CCW
 *
 * @example convexHull([{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2},{x:1,y:1}]).length // 4 (interior point dropped)
 * @example convexHull([{x:0,y:0},{x:1,y:0}]).length // 2 (degenerate: returned as-is)
 */
export function convexHull(points) {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (seq) => {
    const h = [];
    for (const p of seq) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop(); // drop the endpoint (it is the start of the other half)
    return h;
  };
  return half(pts).concat(half([...pts].reverse()));
}

/**
 * Pure function. The two outer connecting edges between two axis-aligned boxes
 * (each {x, y, halfW, halfH}): the hull edges of the eight corners that BRIDGE
 * a corner of A to a corner of B. For two disjoint boxes there are exactly two.
 * Returns [] when the box centers coincide (the degenerate identity end).
 *
 * @param {{x:number,y:number,halfW:number,halfH:number}} a
 * @param {{x:number,y:number,halfW:number,halfH:number}} b
 * @returns {Array<[{x:number,y:number},{x:number,y:number}]>} the bridge segments
 *
 * @example
 * // Equal unit squares 10 apart → the top and bottom outer tangents:
 * boxExternalTangents({ x: 0, y: 0, halfW: 1, halfH: 1 }, { x: 10, y: 0, halfW: 1, halfH: 1 })
 * // [[{x:-1,y:-1},{x:11,y:-1}],[{x:11,y:1},{x:-1,y:1}]]
 * @example
 * // Small → big square: the fan connects the small corners to the big box's near face:
 * boxExternalTangents({ x: 0, y: 0, halfW: 1, halfH: 1 }, { x: 10, y: 0, halfW: 3, halfH: 3 })
 * // [[{x:-1,y:-1},{x:7,y:-3}],[{x:7,y:3},{x:-1,y:1}]]
 */
export function boxExternalTangents(a, b) {
  if (Math.hypot(a.x - b.x, a.y - b.y) < COINCIDENT_EPS) return [];
  const hull = convexHull([...boxCorners(a, 0), ...boxCorners(b, 1)]);
  const out = [];
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    if (p.tag !== q.tag) out.push([{ x: p.x, y: p.y }, { x: q.x, y: q.y }]);
  }
  return out;
}

/**
 * Pure function. The two outer tangent segments connecting shapes a and b.
 * Dispatches: both circle → circleExternalTangents; both box →
 * boxExternalTangents; otherwise each shape's BOUNDING CIRCLE feeds the circle
 * formula (the general fallback). Descriptors: circle {kind:"circle",x,y,r},
 * box {kind:"box",x,y,halfW,halfH}.
 *
 * @param {object} a - shape descriptor
 * @param {object} b - shape descriptor
 * @returns {Array<[{x:number,y:number},{x:number,y:number}]>} up to two segments
 *
 * @example externalTangents({kind:"circle",x:0,y:0,r:4},{kind:"circle",x:5,y:0,r:1})[0] // [{x:2.4,y:3.2},{x:5.6,y:0.8}]
 * @example externalTangents({kind:"box",x:0,y:0,halfW:1,halfH:1},{kind:"box",x:10,y:0,halfW:1,halfH:1}).length // 2
 * @example
 * // Mixed kinds → bounding-circle fallback (box half 3,4 → r 5):
 * externalTangents({kind:"circle",x:0,y:0,r:5},{kind:"box",x:20,y:0,halfW:3,halfH:4})
 * // [[{x:0,y:5},{x:20,y:5}],[{x:0,y:-5},{x:20,y:-5}]]
 */
export function externalTangents(a, b) {
  if (a.kind === "circle" && b.kind === "circle") return circleExternalTangents(a, b);
  if (a.kind === "box" && b.kind === "box") return boxExternalTangents(a, b);
  return circleExternalTangents(boundingCircle(a), boundingCircle(b));
}

/**
 * Pure function. The DRAWN spans of a (possibly) dashed segment P→Q: walks the
 * axis in alternating dashLength (drawn) / dashGap (skipped) steps, each drawn
 * span a [start, end] pair of {x, y}. A non-positive dashLength/dashGap (or a
 * zero-length segment) means "solid" — one span — so a solid line is the
 * degenerate case (and no zero step can loop forever). Mirrors line.js dashSpans.
 *
 * @param {{x:number,y:number}} p
 * @param {{x:number,y:number}} q
 * @param {number} dashLength
 * @param {number} dashGap
 * @returns {Array<[{x:number,y:number},{x:number,y:number}]>}
 *
 * @example dashSpans({x:0,y:0}, {x:10,y:0}, 4, 4).length // 2  (0..4 and 8..10)
 * @example dashSpans({x:0,y:0}, {x:10,y:0}, 0, 4) // [[{x:0,y:0},{x:10,y:0}]] (solid)
 */
export function dashSpans(p, q, dashLength, dashGap) {
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  if (!(dashLength > 0) || !(dashGap > 0) || len === 0) return [[p, q]];
  const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
  const spans = [];
  for (let d = 0; d < len; d += dashLength + dashGap) {
    const end = Math.min(d + dashLength, len);
    spans.push([{ x: p.x + ux * d, y: p.y + uy * d }, { x: p.x + ux * end, y: p.y + uy * end }]);
  }
  return spans;
}

/**
 * Pure function. Distance from point (px, py) to segment P→Q — the hit test for
 * a drawn tangent line. Projects the point onto the segment, clamped to [0, 1].
 *
 * @example Math.round(pointSegmentDistance(5, 3, {x:0,y:0}, {x:10,y:0})) // 3
 * @example pointSegmentDistance(-5, 0, {x:0,y:0}, {x:10,y:0}) // 5 (past the P end)
 */
export function pointSegmentDistance(px, py, p, q) {
  const vx = q.x - p.x, vy = q.y - p.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - p.x) * vx + (py - p.y) * vy) / len2));
  return Math.hypot(px - (p.x + t * vx), py - (p.y + t * vy));
}

/**
 * Pure function. The [A, B] shape descriptors for a folded tangent-lines state
 * — the widget stores each shape as a center (x, y) + a single size `r`
 * (radius for a circle, half-side for a square box). `shapeKind` picks the
 * geometry both shapes use ("circle" | "box"); any other value falls back to
 * circles (bounding-circle treatment).
 *
 * @param {object} s - folded item state {a:{x,y,r}, b:{x,y,r}, shapeKind}
 * @returns {[object, object]} descriptors for externalTangents
 *
 * @example shapeDescriptors({ a: {x:0,y:0,r:4}, b: {x:5,y:0,r:1}, shapeKind: "circle" }) // [{kind:"circle",x:0,y:0,r:4},{kind:"circle",x:5,y:0,r:1}]
 * @example shapeDescriptors({ a: {x:0,y:0,r:2}, b: {x:9,y:0,r:2}, shapeKind: "box" })[0] // {kind:"box",x:0,y:0,halfW:2,halfH:2}
 */
export function shapeDescriptors(s) {
  const desc = (shape) =>
    s.shapeKind === "box"
      ? { kind: "box", x: shape.x, y: shape.y, halfW: shape.r, halfH: shape.r }
      : { kind: "circle", x: shape.x, y: shape.y, r: shape.r };
  return [desc(s.a), desc(s.b)];
}

export const tangentLinesPlugin = {
  type: "tangent_lines",
  title: "Tangent Lines",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "tangent_lines", z: 1,
    // Shape A and shape B: each a center (x, y) + size r. All four numbers are
    // ordinary equation slots (bind them to two widgets' anchors — THE
    // UNIFICATION). Standalone defaults show a visible pair (small → large).
    a: { x: 400, y: 380, r: 60 },
    b: { x: 820, y: 380, r: 150 },
    shapeKind: "circle",
    stroke: "#e0af68", strokeWidth: DEFAULT_STROKE_WIDTH, opacity: 1,
    dashed: false, dashLength: DEFAULT_DASH_LENGTH, dashGap: DEFAULT_DASH_GAP,
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    { key: "shapeKind", label: "Shape kind", kind: "select", options: ["circle", "box"], optionLabels: { circle: "Circle", box: "Box" }, category: "tangent", help: "The boundary geometry both shapes use: Circle (external tangent lines) or Box (outer hull edges). Any other pairing falls back to bounding circles." },
    { key: "a.x", label: "A center X", kind: "number", category: "shape_a", help: "World X of shape A's center (bind to a widget's anchor with an = equation)." },
    { key: "a.y", label: "A center Y", kind: "number", category: "shape_a", help: "World Y of shape A's center." },
    { key: "a.r", label: "A size", kind: "number", min: 0, category: "shape_a", help: "Shape A's radius (circle) or half-side (box)." },
    { key: "b.x", label: "B center X", kind: "number", category: "shape_b", help: "World X of shape B's center." },
    { key: "b.y", label: "B center Y", kind: "number", category: "shape_b", help: "World Y of shape B's center." },
    { key: "b.r", label: "B size", kind: "number", min: 0, category: "shape_b", help: "Shape B's radius (circle) or half-side (box)." },
    ...props("stroke", "strokeWidth"),
    ...props("opacity"),
    { key: "dashed", label: "Dashed", kind: "boolean", category: "tangent", help: "Draw the tangent lines dashed instead of solid." },
    { key: "dashLength", label: "Dash length", kind: "number", min: 0, category: "tangent", help: "Length of each drawn dash, in canvas units. Only applies when Dashed is on." },
    { key: "dashGap", label: "Dash gap", kind: "number", min: 0, category: "tangent", help: "Length of the empty gap between dashes. Only applies when Dashed is on." },
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands. Reads the two evaluated shapes
   * (numbers by emit time), computes the two external tangent segments, and
   * draws each as a round-capped polyline (chopped into dashes when `dashed`).
   * When the shapes coincide / one contains the other there is no tangent and
   * nothing is drawn (identity end of a zoom-callout tween). The widget has no
   * transform (world == identity), so these world-space segments are emitted
   * directly, exactly like line.js.
   *
   * @param {object} s - evaluated item state
   * @param {object} _targetWorldIR - unused
   * @param {object} world - world transform (for the effects pass)
   * @returns {object[]} display-list commands (effects-wrapped)
   */
  emit(s, _targetWorldIR, world) {
    const [a, b] = shapeDescriptors(s);
    const segments = externalTangents(a, b);
    const width = s.strokeWidth ?? DEFAULT_STROKE_WIDTH;
    const opacity = s.opacity ?? 1;
    const spans = segments.flatMap(([p, q]) => (s.dashed ? dashSpans(p, q, s.dashLength, s.dashGap) : [[p, q]]));
    const cmds = spans.map(([p, q]) => polyline({ points: [[p.x, p.y], [q.x, q.y]], width, color: s.stroke, opacity }));
    // Effect region = padded AABB of every tangent endpoint (empty when there
    // are no tangents → applyEffects passes the empty op list through). No
    // cullMargin: non-bbox widgets never cull-skip (core/view.js defaultCanSkip).
    const endpoints = segments.flatMap(([p, q]) => [p, q]);
    return applyEffects(cmds, s, world, paddedPointsBBox(endpoints.length ? endpoints : [{ x: 0, y: 0 }], width));
  },
  hitTestWorld(node, wx, wy) {
    const [a, b] = shapeDescriptors(node.state);
    const grab = (node.state.strokeWidth ?? DEFAULT_STROKE_WIDTH) / 2 + DEFAULT_STROKE_WIDTH;
    return externalTangents(a, b).some(([p, q]) => pointSegmentDistance(wx, wy, p, q) <= grab);
  },
  anchors: standardBBoxAnchors,
};

// ── Telescopic-magnifier rig (pure builder) ───────────────────────────────────

/**
 * Telescopic-magnifier rig constants (world units). The ONE place the rig
 * geometry is defined, so it cannot drift across the builder's three items.
 * The rig is a function of a shared tween VARIABLE `t` (a document var,
 * default 0): at t=0 the lens coincides with the source at the origin at
 * magnification 1 (identity — "nothing happened"); at t=1 the lens has pulled
 * out by (PULL_X, PULL_Y), grown to LENS_SIZE, and zoomed to ZOOM×.
 */
export const TELESCOPIC = {
  TWEEN_VAR: "t",   // shared tween parameter (document variable), default 0
  SOURCE_SIZE: 96,  // source-marker + lens diameter at t=0 (the identity size)
  LENS_SIZE: 340,   // lens diameter at t=1
  ZOOM: 3,          // lens magnification at t=1 (1 at t=0)
  PULL_X: 440,      // lens-center x displacement from the origin at t=1
  PULL_Y: -250,     // lens-center y displacement from the origin at t=1 (up-right)
  ORIGIN_X: 430,    // default world origin (the region being magnified) — the drop point
  ORIGIN_Y: 500,    // chosen so the up-right pull-out stays inside a 1280×720 camera
  RIM_COLOR: "#1a1a2e",
  RIM_WIDTH: 4,     // lens rim + source-marker outline stroke width
  // Fully-transparent fill (#rrggbbaa, alpha 0): a real color value so the
  // load-boundary missing-default repair leaves it alone (a null fill would be
  // back-filled with the shape's solid default), yet it paints nothing — the
  // source marker reads as a pure OUTLINE.
  NO_FILL: "#00000000",
};

/** Pure function. The widget TYPE for a rig shape kind: "box" → rect, else circle. */
function shapeWidgetType(shapeKind) {
  return shapeKind === "box" ? "rect" : "circle";
}

/** Pure function. The demo_magnify `shape` value for a rig shape kind. */
function lensShapeFor(shapeKind) {
  return shapeKind === "box" ? "square" : "circle";
}

/**
 * Pure function. The SOURCE-MARKER override dict — a small outline (no fill) at
 * the world origin (ORIGIN_X, ORIGIN_Y). type is a circle or a rect (spread
 * over that plugin's registry defaults by the command). It has no equations: it
 * is the fixed anchor the lens magnifies from and the tangents fan out of.
 *
 * @param {{shapeKind:string, originX:number, originY:number}} opts
 * @returns {object} property overrides
 *
 * @example telescopicSourceOverrides({ shapeKind: "circle", originX: 430, originY: 470 }).type // "circle"
 * @example telescopicSourceOverrides({ shapeKind: "circle", originX: 430, originY: 470 }).w // 96
 */
export function telescopicSourceOverrides({ shapeKind, originX, originY }) {
  const half = TELESCOPIC.SOURCE_SIZE / 2;
  return {
    type: shapeWidgetType(shapeKind),
    x: originX - half, y: originY - half,
    w: TELESCOPIC.SOURCE_SIZE, h: TELESCOPIC.SOURCE_SIZE,
    rotation: 0, scale: 1,
    fill: TELESCOPIC.NO_FILL, stroke: TELESCOPIC.RIM_COLOR, strokeWidth: TELESCOPIC.RIM_WIDTH,
  };
}

/**
 * Pure function. The LENS override dict — a demo_magnify wired by `=` equations
 * to the source marker and the shared tween var. The lens SAMPLES from the
 * source center (`origin`) at every t, but its DISPLAY center travels from the
 * source out to (source + PULL)·t, its size grows SOURCE_SIZE → LENS_SIZE, and
 * its magnification grows 1 → ZOOM. At t=0 all three collapse to identity.
 * `sourceId` is the raw item id of the source marker (referenced as `@id…`).
 *
 * @param {{sourceId:string, shapeKind:string}} opts
 * @returns {object} property overrides (equation strings)
 *
 * @example telescopicLensOverrides({ sourceId: "ab12cd34", shapeKind: "circle" }).magnification // "= 1 + (3 - 1) * t"
 * @example telescopicLensOverrides({ sourceId: "ab12cd34", shapeKind: "circle" }).origin.x // "@ab12cd34_cm.x" (bare ref — see below)
 */
export function telescopicLensOverrides({ sourceId, shapeKind }) {
  const t = TELESCOPIC.TWEEN_VAR;
  const grow = TELESCOPIC.LENS_SIZE - TELESCOPIC.SOURCE_SIZE;
  return {
    type: "demo_magnify",
    shape: lensShapeFor(shapeKind),
    rotation: 0, scale: 1,
    stroke: TELESCOPIC.RIM_COLOR, strokeWidth: TELESCOPIC.RIM_WIDTH,
    w: `= ${TELESCOPIC.SOURCE_SIZE} + ${grow} * ${t}`,
    h: "= self.w",
    x: `= @${sourceId}_cm.x + ${TELESCOPIC.PULL_X} * ${t} - self.w / 2`,
    y: `= @${sourceId}_cm.y + (${TELESCOPIC.PULL_Y}) * ${t} - self.h / 2`,
    // origin is a demo_magnify COMPUTED-DEFAULT slot (its default is the bare
    // self-anchor "self.anchors.center.x"), so it takes a BARE reference — NOT a
    // leading `=` (a `=` slot would infer its result kind as the default's
    // string type and reject a numeric result). Bare = the same form the plugin
    // default uses; it evaluates as a numeric slot (isNumericSlot / self.-prefix).
    origin: { x: `@${sourceId}_cm.x`, y: `@${sourceId}_cm.y` },
    magnification: `= 1 + (${TELESCOPIC.ZOOM} - 1) * ${t}`,
  };
}

/**
 * Pure function. The TANGENT-LINES override dict — a tangent_lines widget whose
 * A tracks the source marker and B tracks the lens: centers bound to each
 * item's center anchor (`@id_cm`), sizes bound to each item's half-width
 * (`@id.w / 2`), shapeKind matched literally. So the two tangents fan open
 * exactly as the lens pulls out. `sourceId` / `lensId` are raw item ids.
 *
 * @param {{sourceId:string, lensId:string, shapeKind:string}} opts
 * @returns {object} property overrides (equation strings)
 *
 * @example telescopicTangentOverrides({ sourceId: "s1", lensId: "l1", shapeKind: "box" }).a.x // "= @s1_cm.x"
 * @example telescopicTangentOverrides({ sourceId: "s1", lensId: "l1", shapeKind: "box" }).b.r // "= @l1.w / 2"
 */
export function telescopicTangentOverrides({ sourceId, lensId, shapeKind }) {
  return {
    type: "tangent_lines",
    shapeKind,
    a: { x: `= @${sourceId}_cm.x`, y: `= @${sourceId}_cm.y`, r: `= @${sourceId}.w / 2` },
    b: { x: `= @${lensId}_cm.x`, y: `= @${lensId}_cm.y`, r: `= @${lensId}.w / 2` },
    stroke: TELESCOPIC.RIM_COLOR, strokeWidth: TELESCOPIC.RIM_WIDTH,
  };
}
