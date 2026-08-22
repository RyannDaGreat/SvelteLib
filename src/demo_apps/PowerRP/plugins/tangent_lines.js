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
 * ONE general "sandwich" handles EVERY convex shape — no shape-specific closed
 * forms, so a STRETCHED circle (a true ellipse) or a rotated box is exact, not
 * a bounding-circle approximation:
 *   1. Represent each shape by its ACTUAL boundary as a world-space polygon
 *      (a circle/ellipse → N points from its real halfW/halfH + rotation; a box
 *      → its 4 rotated corners; an explicit `polygon` → ANY outline, incl.
 *      concave stars / notched pies; anything else → its bounding box polygon).
 *   2. Convex-hull BOTH shapes' boundary points together.
 *   3. The exactly-two hull edges that bridge a vertex of shape A to a vertex of
 *      shape B are the two outer tangent ("sandwich bread") lines.
 * Because the outer tangents are SUPPORTING lines, they touch only each shape's
 * CONVEX HULL — so a star's lines graze its tips and a notched pie's graze its
 * outer arc (correct for a callout; a concavity matters only to an inner tangent,
 * which this never uses). When the shapes coincide there is no bridge and
 * NOTHING is drawn (a degenerate, not an error — the identity end of a tween).
 *
 * This file ALSO exports the pure TELESCOPIC-MAGNIFIER rig builder: the three
 * equation-valued property OVERRIDE dicts (source marker / magnify lens /
 * tangent lines) a command spreads over the registry defaults to mint the rig.
 * The builder emits only string type-names and `=` equations — it imports NO
 * other plugin (composition is via document state + equations ONLY).
 *
 * DOM-free / bare-node-safe at import time (mirrors line.js / the demo widgets).
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { CONNECTOR_DASH_ROWS } from "../core/endpoints.js";
import { polyline } from "../render_gpu/ir.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { applyEffects, effectsCullMargin, paddedPointsBBox } from "../render_gpu/effects.js";
import { morphPayloadFromConnector, polylinePathD, statePaint } from "../core/morph_payload.js";

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
// Boundary samples for a circle/ellipse hull. 64 keeps the tangent points within
// a fraction of a pixel of the true tangent at any realistic on-canvas size,
// while staying cheap (the hull is O(n log n) over 2·n points).
const CIRCLE_SAMPLES = 64;

// ── Pure tangent geometry (the general "sandwich") ────────────────────────────

/**
 * Pure function. N points sampled counter-clockwise around an ELLIPSE
 * (half-axes halfW, halfH) centered at (x, y) and rotated by `rotation` radians.
 * A non-uniformly scaled circle IS an ellipse, so this honors the real
 * halfW ≠ halfH (and rotation) — no bounding-circle approximation. i=0 is the
 * +x axis endpoint (before rotation).
 *
 * @param {{x:number,y:number,halfW:number,halfH:number,rotation?:number}} shape
 * @param {number} n - sample count
 * @param {number} tag - shape identity carried onto each point (hull bridging)
 * @returns {Array<{x:number,y:number,tag:number}>}
 *
 * @example ellipseBoundaryPoints({ x: 0, y: 0, halfW: 4, halfH: 2 }, 4, 0).map((p) => [Math.round(p.x), Math.round(p.y)]) // [[4,0],[0,2],[-4,0],[0,-2]]
 * @example ellipseBoundaryPoints({ x: 0, y: 0, halfW: 4, halfH: 2 }, 4, 7)[0].tag // 7
 */
export function ellipseBoundaryPoints(shape, n, tag) {
  const { x, y, halfW, halfH, rotation = 0 } = shape;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const ex = halfW * Math.cos(a), ey = halfH * Math.sin(a);
    pts.push({ x: x + ex * cos - ey * sin, y: y + ex * sin + ey * cos, tag });
  }
  return pts;
}

/**
 * Pure function. The four corners of a box (half-extents halfW, halfH) centered
 * at (x, y) and rotated by `rotation` radians — clockwise from the top-left.
 *
 * @param {{x:number,y:number,halfW:number,halfH:number,rotation?:number}} shape
 * @param {number} tag - shape identity carried onto each point
 * @returns {Array<{x:number,y:number,tag:number}>}
 *
 * @example boxBoundaryPoints({ x: 0, y: 0, halfW: 2, halfH: 1 }, 0)[0] // {x: -2, y: -1, tag: 0}
 * @example boxBoundaryPoints({ x: 10, y: 0, halfW: 1, halfH: 1 }, 3)[2] // {x: 11, y: 1, tag: 3}
 */
export function boxBoundaryPoints(shape, tag) {
  const { x, y, halfW, halfH, rotation = 0 } = shape;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].map(([ex, ey]) => ({
    x: x + ex * cos - ey * sin, y: y + ex * sin + ey * cos, tag,
  }));
}

/**
 * Pure function. Places a LOCAL outline polygon into world space: each
 * [ex, ey] (relative to the shape center, unrotated) rotated by `rotation` and
 * translated to (x, y). This is how ARBITRARY / WEIRD shapes flow in — a star,
 * a pie with a slice removed, any concave outline: the caller passes the real
 * local vertices as `shape.polygon` and they are positioned exactly like the
 * box corners. (See shapeBoundaryPoints / the convex-hull note below.)
 *
 * @param {{x:number,y:number,rotation?:number,polygon:Array<[number,number]>}} shape
 * @param {number} tag
 * @returns {Array<{x:number,y:number,tag:number}>}
 *
 * @example polygonBoundaryPoints({ x: 10, y: 5, polygon: [[0,-4],[1,-1],[4,0]] }, 0)[2] // {x: 14, y: 5, tag: 0}
 */
export function polygonBoundaryPoints(shape, tag) {
  const { x, y, rotation = 0, polygon } = shape;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return polygon.map(([ex, ey]) => ({ x: x + ex * cos - ey * sin, y: y + ex * sin + ey * cos, tag }));
}

/**
 * Pure function. A shape's ACTUAL boundary polygon (tagged): an explicit
 * `shape.polygon` (local vertices) → ANY outline (star, notched pie, arbitrary
 * concave shape); else kind "circle" → an ellipse sampled at n points; kind
 * "box" → its 4 rotated corners; anything else → its bounding box polygon.
 * Descriptor: {kind, x, y, halfW, halfH, rotation?, polygon?}.
 *
 * CONCAVE SHAPES: the two outer tangents are SUPPORTING lines, which (by
 * definition) only ever touch a shape's CONVEX HULL — so for a star they graze
 * the outer TIPS, and for a pie-with-a-slice-removed they graze the outer arc;
 * they never dive into a concave notch. Feeding the real outline here is enough
 * to get the correct outer callout lines for those shapes — the hull in
 * externalTangents does the rest. (A concavity would only matter to an INNER
 * tangent, which a zoom callout never uses.)
 *
 * @example shapeBoundaryPoints({ kind: "box", x: 0, y: 0, halfW: 1, halfH: 1 }, 8, 0).length // 4
 * @example shapeBoundaryPoints({ kind: "circle", x: 0, y: 0, halfW: 5, halfH: 5 }, 16, 0).length // 16
 * @example shapeBoundaryPoints({ kind: "blob", x: 0, y: 0, halfW: 2, halfH: 3 }, 8, 0).length // 4 (fallback: bounding box)
 * @example shapeBoundaryPoints({ kind: "star", x: 0, y: 0, polygon: [[0,-10],[3,-3],[10,0],[3,3],[0,10],[-3,3],[-10,0],[-3,-3]] }, 8, 0).length // 8 (explicit outline wins)
 */
export function shapeBoundaryPoints(shape, n, tag) {
  if (Array.isArray(shape.polygon)) return polygonBoundaryPoints(shape, tag);
  if (shape.kind === "circle") return ellipseBoundaryPoints(shape, n, tag);
  return boxBoundaryPoints(shape, tag); // "box" and the general bounding-box fallback
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
 * Pure function. The hull edges that BRIDGE a vertex tagged 0 to a vertex tagged
 * 1 — the outer tangent "sandwich bread" between two convex shapes. For two
 * disjoint convex shapes there are exactly two.
 *
 * @param {Array<{x:number,y:number,tag:number}>} hull - a convex hull (CCW)
 * @returns {Array<[{x:number,y:number},{x:number,y:number}]>} bridge segments
 *
 * @example hullBridges([{x:0,y:0,tag:0},{x:10,y:0,tag:1},{x:10,y:5,tag:1},{x:0,y:5,tag:0}]) // [[{x:0,y:0},{x:10,y:0}],[{x:10,y:5},{x:0,y:5}]]
 */
export function hullBridges(hull) {
  const out = [];
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    if (p.tag !== q.tag) out.push([{ x: p.x, y: p.y }, { x: q.x, y: q.y }]);
  }
  return out;
}

/**
 * Pure function. The two outer tangent segments connecting convex shapes a and b
 * — the general sandwich: hull the two shapes' boundary polygons together, take
 * the two A→B bridge edges. Works for ANY convex boundary (stretched ellipse,
 * rotated box, mixed pair) with no closed form. Descriptor:
 * {kind:"circle"|"box"|…, x, y, halfW, halfH, rotation?}. Returns [] when the
 * centers coincide (the degenerate identity end). `n` = ellipse sample count.
 *
 * @param {object} a - shape descriptor
 * @param {object} b - shape descriptor
 * @param {number} [n] - ellipse boundary samples (default 64)
 * @returns {Array<[{x:number,y:number},{x:number,y:number}]>} up to two segments
 *
 * @example
 * // Equal boxes 10 apart → the top + bottom outer tangents (exact, N-independent):
 * externalTangents({kind:"box",x:0,y:0,halfW:1,halfH:1},{kind:"box",x:10,y:0,halfW:1,halfH:1})
 * // [[{x:-1,y:-1},{x:11,y:-1}],[{x:11,y:1},{x:-1,y:1}]]
 * @example
 * // Small → big box: the fan connects the small corners to the big box's near face:
 * externalTangents({kind:"box",x:0,y:0,halfW:1,halfH:1},{kind:"box",x:10,y:0,halfW:3,halfH:3})
 * // [[{x:-1,y:-1},{x:7,y:-3}],[{x:7,y:3},{x:-1,y:1}]]
 * @example externalTangents({kind:"circle",x:0,y:0,halfW:40,halfH:20},{kind:"circle",x:300,y:0,halfW:120,halfH:60}).length // 2 (stretched ellipses)
 * @example externalTangents({kind:"circle",x:5,y:5,halfW:40,halfH:20},{kind:"circle",x:5,y:5,halfW:120,halfH:60}) // [] (coincident)
 */
export function externalTangents(a, b, n = CIRCLE_SAMPLES) {
  if (Math.hypot(a.x - b.x, a.y - b.y) < COINCIDENT_EPS) return [];
  const hull = convexHull([...shapeBoundaryPoints(a, n, 0), ...shapeBoundaryPoints(b, n, 1)]);
  return hullBridges(hull);
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
 * — each shape is a center (x, y) + half-extents (halfW, halfH) + rotation, so
 * a non-uniform pair is a true ellipse / rotated box (NOT a bounding circle).
 * `shapeKind` picks the boundary both shapes use ("circle" | "box").
 *
 * @param {object} s - folded state {a:{x,y,halfW,halfH,rotation}, b:{…}, shapeKind}
 * @returns {[object, object]} descriptors for externalTangents
 *
 * A shape may also carry an explicit `polygon` (local outline vertices) — a
 * star, a notched pie, any weird shape — which is passed through and WINS over
 * the ellipse/box boundary (see shapeBoundaryPoints).
 *
 * @example shapeDescriptors({ a: {x:0,y:0,halfW:4,halfH:2,rotation:0}, b: {x:5,y:0,halfW:1,halfH:1,rotation:0}, shapeKind: "circle" })[0] // {kind:"circle",x:0,y:0,halfW:4,halfH:2,rotation:0,polygon:undefined}
 * @example shapeDescriptors({ a: {x:0,y:0,halfW:2,halfH:3,rotation:0}, b: {x:9,y:0,halfW:2,halfH:2,rotation:0}, shapeKind: "box" })[0].kind // "box"
 */
export function shapeDescriptors(s) {
  const kind = s.shapeKind === "box" ? "box" : "circle";
  const desc = (shape) => ({ kind, x: shape.x, y: shape.y, halfW: shape.halfW, halfH: shape.halfH, rotation: shape.rotation ?? 0, polygon: shape.polygon });
  return [desc(s.a), desc(s.b)];
}

/**
 * Pure function. The min and max corner of the axis-aligned square that
 * circumscribes one shape at ANY rotation: its center ± hypot(halfW, halfH). The
 * rotation-free bound — a rotated ellipse and a rotated box both fit inside the
 * circle of that radius — so no trigonometry is needed to stay conservative.
 *
 * @param {{x: number, y: number, halfW: number, halfH: number}} shape - a shapeDescriptors entry
 * @returns {Array<{x: number, y: number}>} the two opposite corners
 *
 * @example shapeCircumscribedCorners({x: 100, y: 100, halfW: 4, halfH: 3}) // [{x: 95, y: 95}, {x: 105, y: 105}]
 */
function shapeCircumscribedCorners(shape) {
  const r = Math.hypot(shape.halfW, shape.halfH);
  return [{ x: shape.x - r, y: shape.y - r }, { x: shape.x + r, y: shape.y + r }];
}

/**
 * Pure function. The LOCAL rect this widget's INK occupies: the AABB of every
 * tangent endpoint, padded on every side by the stroke width. World == identity
 * (a connector), so this is also its world footprint.
 *
 * ONE ink rect, THREE consumers (the plugins/polygon.js polygonInkRect
 * precedent): the effect substrate in emit() below, and — via the `localBounds`
 * declaration — culling plus rubber-band selection (core/view.js localBoundsOf).
 * A tangent endpoint always sits ON a shape's boundary, so the endpoint hull is
 * the tight bound on the drawn segments and a full-width pad covers the round
 * caps with room to spare.
 *
 * NO TANGENT PAIR (coincident shapes, or one containing the other — the identity
 * end of a zoom-callout tween): nothing is drawn, so the true ink is EMPTY, and
 * the two shapes' own circumscribed extents are used instead. Empty ink fits
 * inside any rect, so that stays conservative, and it says WHERE the widget is
 * rather than parking its bounds at the world origin.
 *
 * @param {object} s - evaluated item state (shapes a/b, shapeKind, strokeWidth)
 * @returns {{x: number, y: number, w: number, h: number}} local rect
 *
 * @example // two equal circles side by side: the two horizontal tangents run from
 * @example // (0, ±10) to (100, ±10), so the hull is that box padded by the stroke.
 * @example // (x lands on -2 to floating-point precision — the tangent points come
 * @example // off a SAMPLED boundary, the same approximation emit() draws with.)
 * @example tangentLinesInkRect({a: {x: 0, y: 0, halfW: 10, halfH: 10, rotation: 0}, b: {x: 100, y: 0, halfW: 10, halfH: 10, rotation: 0}, shapeKind: "circle", strokeWidth: 2}) // {x: -2, y: -12, w: 104, h: 24}
 * @example // B swallows A → no tangents → the circumscribed hull of both shapes:
 * @example // hypot(50, 50) = 70.71 circumscribes B, plus the 2-unit stroke pad.
 * @example tangentLinesInkRect({a: {x: 0, y: 0, halfW: 1, halfH: 1, rotation: 0}, b: {x: 0, y: 0, halfW: 50, halfH: 50, rotation: 0}, shapeKind: "circle", strokeWidth: 2}) // {x: -72.71, y: -72.71, w: 145.42, h: 145.42}
 */
export function tangentLinesInkRect(s) {
  const [a, b] = shapeDescriptors(s);
  const ends = externalTangents(a, b).flatMap(([p, q]) => [p, q]);
  const points = ends.length ? ends : [a, b].flatMap(shapeCircumscribedCorners);
  return paddedPointsBBox(points, s.strokeWidth ?? DEFAULT_STROKE_WIDTH);
}

/**
 * Pure function. THE ANCHORS PROTOCOL (core/registry.js) for a widget with NO w/h:
 * the nine standard bbox anchors placed over the INK RECT, which is where this
 * widget actually is. The ids and their positions WITHIN the rect come from the one
 * home (core/derive.standardBBoxAnchors, offset by the rect origin — the
 * bento.bentoGridAnchors idiom for a sub-rect anchor set), so a tenth standard
 * anchor would appear here for free.
 *
 * WHY IT IS NOT `standardBBoxAnchors` DIRECTLY, which is what it used to be: that
 * helper reads `state.w ?? 0, state.h ?? 0`, and this widget has neither (it is a
 * CONNECTOR — `capabilities.bbox: false`, no resize handles, its geometry is the two
 * shape descriptors). So all nine anchors collapsed onto (0, 0) — the world origin,
 * nowhere near the drawn tangents — and the `?? 0` made it silent: the equation
 * grammar, the anchor overlay dots and anchor snapping all consumed nine anchors
 * that were a lie, with zero errors reported. The ink rect is the SAME rect
 * `localBounds` already publishes, so the anchors, the cull AABB and band select
 * now agree about where this widget is.
 *
 * @param {object} s - evaluated item state (shapes a/b, shapeKind, strokeWidth)
 * @returns {{id: string, x: number, y: number}[]} nine anchors in LOCAL coords
 *
 * @example // two equal circles side by side (the tangentLinesInkRect doctest's
 * @example // rect {x: -2, y: -12, w: 104, h: 24}) put the center anchor mid-bridge:
 * @example tangentLinesAnchors({a: {x: 0, y: 0, halfW: 10, halfH: 10, rotation: 0}, b: {x: 100, y: 0, halfW: 10, halfH: 10, rotation: 0}, shapeKind: "circle", strokeWidth: 2}).find((q) => q.id === "cm") // {id: "cm", x: 50, y: 0}
 * @example tangentLinesAnchors({a: {x: 0, y: 0, halfW: 10, halfH: 10, rotation: 0}, b: {x: 100, y: 0, halfW: 10, halfH: 10, rotation: 0}, shapeKind: "circle", strokeWidth: 2}).find((q) => q.id === "tl") // {id: "tl", x: -2, y: -12}
 */
export function tangentLinesAnchors(s) {
  const r = tangentLinesInkRect(s);
  return standardBBoxAnchors({ w: r.w, h: r.h }).map((a) => ({ id: a.id, x: r.x + a.x, y: r.y + a.y }));
}

// ── STROKE IDIOMS (R7-39 presets law) ────────────────────────────────────────
// STROKE-ONLY, NEVER THE GEOMETRY: `a`/`b` are meant to be EQUATION-BOUND to
// two other widgets' anchors/sizes (THE UNIFICATION — this file's header), so
// no row here may write them — a preset that repositioned the shapes would be
// the content violation SPEC.md §5 forbids, the same reason no preset here
// writes `shapeKind` (which boundary a bound widget presents is that widget's
// own business, not this connector's).
//
// EVERY ROW SETS EVERY EFFECTS KEY, IDENTITIES INCLUDED, AND THE FULL DASH
// STATE (dashed/dashLength/dashGap) — the image.js/paint_path.js overlay
// argument, verbatim: app.applyPreset writes exactly the keys in `props`, so a
// knob a row omits keeps whatever the PREVIOUSLY HOVERED row left there (a
// "Laser Sight" applied after "Dotted Trace" must not leave the dots on).
//
// TEN DASH/STROKE IDIOMS, THE arrow.js/paint_path.js RESTRAINT: geometry and
// paint only, nothing shape-specific to invent, so this table is exactly the
// same kind of narrow, sparse family — stroke colour, width, dash rhythm and
// (for one row) a screen-space glow.
const SHADOW_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLOOM_OFF = { radius: 10, strength: 0 };
const INNER_OFF = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const BLUR_OFF = 0;
const DASH_OFF = { dashed: false, dashLength: DEFAULT_DASH_LENGTH, dashGap: DEFAULT_DASH_GAP };

const TANGENT_LINES_PRESETS = [
  {
    name: "Construction Lines",
    description: "A thin, pale dashed line — the quiet reference geometry a technical drawing uses to show where something WOULD line up, not the thing itself.",
    props: {
      stroke: "#9a9a9a", strokeWidth: 1, opacity: 0.8,
      dashed: true, dashLength: 6, dashGap: 5,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Blueprint Guides",
    description: "A crisp light-blue dashed line on the blueprint-sheet family's own hue, for tangents that read as part of a technical drawing rather than an annotation over one.",
    props: {
      stroke: "#8ecbff", strokeWidth: 1.5, opacity: 1,
      dashed: true, dashLength: 10, dashGap: 6,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Chalk Guide",
    description: "A soft, slightly translucent off-white dashed stroke — the same dusty chalk-on-slate idiom paint_path's Chalk preset draws, sized for a thin guiding line rather than a drawn mark.",
    props: {
      stroke: "#e8e4d8cc", strokeWidth: 2, opacity: 1,
      dashed: true, dashLength: 8, dashGap: 6,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Laser Sight",
    description: "A slim, saturated red line held solid with a tight bloom, so it reads as a beam of light rather than a drawn stroke.",
    props: {
      stroke: "#ff1a1a", strokeWidth: 3, opacity: 1,
      ...DASH_OFF,
      shadow: SHADOW_OFF, bloom: { radius: 22, strength: 0.85 }, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Technical Dash",
    description: "A precise, evenly-spaced dark dash pattern with a fine stroke — drafting-standard hidden-line notation, not a decorative rhythm.",
    props: {
      stroke: "#1a1a1a", strokeWidth: 1.5, opacity: 1,
      dashed: true, dashLength: 12, dashGap: 8,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Faint Reference",
    description: "A very thin, very low-opacity solid line — present enough to trace by eye, quiet enough to never compete with what it connects.",
    props: {
      stroke: "#404040", strokeWidth: 1, opacity: 0.2,
      ...DASH_OFF,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Bold Connector",
    description: "A thick, fully opaque solid stroke in ink black — the tangent drawn as a deliberate, confident connecting line rather than a subtle guide.",
    props: {
      stroke: "#000000", strokeWidth: 5, opacity: 1,
      ...DASH_OFF,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Dotted Trace",
    description: "A short dash equal to the stroke width paired with a wide gap — the closest a stroked polyline gets to a true dotted line, tracing rather than connecting.",
    props: {
      stroke: "#3a3a3a", strokeWidth: 3, opacity: 1,
      dashed: true, dashLength: 3, dashGap: 10,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Highlight Beam",
    description: "A wide, translucent, saturated-yellow band with a soft glow — a beam of emphasis meant to draw the eye along the connection rather than describe geometry precisely.",
    props: {
      stroke: "#ffe14dcc", strokeWidth: 10, opacity: 1,
      ...DASH_OFF,
      shadow: SHADOW_OFF, bloom: { radius: 20, strength: 0.4 }, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
  {
    name: "Survey Line",
    description: "A long-dash, short-gap rhythm in a muted surveyor's orange — the taut string-line idiom a site plan or a land survey draws between two markers.",
    props: {
      stroke: "#d97a3a", strokeWidth: 2, opacity: 1,
      dashed: true, dashLength: 20, dashGap: 4,
      shadow: SHADOW_OFF, bloom: BLOOM_OFF, blendMode: "normal", innerShadow: INNER_OFF, softEdges: 0, gaussianBlur: BLUR_OFF,
    },
  },
];

/**
 * Pure function. The five Inspector rows for ONE of the two shapes — the slot
 * letter is the only thing that varies between them.
 *
 * WRITTEN ONCE FOR BOTH SLOTS. The A and B blocks were the same five declarations
 * typed twice, and they had drifted in the way two hand-kept copies always do:
 * A's `x` explained that these are equation slots ("bind to a widget's anchor with
 * an = equation") and B's did not, so THE WIDGET'S WHOLE POINT — that every number
 * here binds to another widget (the "UNIFICATION" the defaults block names) — was
 * documented on one shape and hidden on the other. A reader who opened Shape B
 * first saw five inert-looking numbers.
 *
 * So the `=` hint is on BOTH slots now, and it is on the row where it is actionable
 * rather than only the first: binding halfW/halfH to a widget's size is the same
 * gesture as binding x/y to its anchor.
 *
 * @param {"a"|"b"} slot - which shape (also the stored key prefix)
 * @returns {object[]} the slot's five inspector rows
 *
 * @example shapeRows("a").map((r) => r.key) // ["a.x", "a.y", "a.halfW", "a.halfH", "a.rotation"]
 * @example shapeRows("b")[0].label // "B center X"
 * @example shapeRows("b")[0].category // "shape_b"
 */
function shapeRows(slot) {
  const S = slot.toUpperCase();
  const category = `shape_${slot}`;
  const bind = "bind to a widget's anchor with an = equation";
  return [
    { key: `${slot}.x`, label: `${S} center X`, kind: "number", category, help: `World X of shape ${S}'s center (${bind}).` },
    { key: `${slot}.y`, label: `${S} center Y`, kind: "number", category, help: `World Y of shape ${S}'s center (${bind}).` },
    { key: `${slot}.halfW`, label: `${S} half-width`, kind: "number", min: 0, category, help: `Shape ${S}'s half-width (ellipse x-radius / box half-width) — bind it to a widget's size with an = equation.` },
    { key: `${slot}.halfH`, label: `${S} half-height`, kind: "number", min: 0, category, help: `Shape ${S}'s half-height (ellipse y-radius / box half-height) — bind it to a widget's size with an = equation.` },
    { key: `${slot}.rotation`, label: `${S} rotation`, kind: "angle", display: "degrees", category, help: `Shape ${S}'s rotation — the dial shows degrees, storage is radians like every widget's rotation, so \`= <widget>.rotation\` binds straight across.` },
  ];
}

export const tangentLinesPlugin = {
  type: "tangent_lines",
  ephemeral: EPHEMERAL.NONE,
  title: "Tangent Lines",
  capabilities: { bbox: false, transform: false, resizable: false, backdrop: false },
  defaults: {
    type: "tangent_lines", z: 1,
    // Shape A and shape B: each a center (x, y) + half-extents (halfW, halfH) +
    // rotation. Every number is an ordinary equation slot (bind them to two
    // widgets' size/anchor — THE UNIFICATION), so a stretched/rotated widget
    // makes a true ellipse/box, not a bounding circle. Standalone defaults show
    // a visible pair (small round A → larger wide-ellipse B).
    a: { x: 400, y: 380, halfW: 60, halfH: 60, rotation: 0 },
    b: { x: 820, y: 380, halfW: 150, halfH: 100, rotation: 0 },
    shapeKind: "circle",
    stroke: "#e0af68", strokeWidth: DEFAULT_STROKE_WIDTH, opacity: 1,
    dashed: false, dashLength: DEFAULT_DASH_LENGTH, dashGap: DEFAULT_DASH_GAP,
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    { key: "shapeKind", label: "Shape kind", kind: "select", options: ["circle", "box"], optionLabels: { circle: "Circle", box: "Box" }, category: "tangent", help: "The boundary both shapes use: Circle (an ellipse from halfW/halfH) or Box (a rotated rectangle). The two outer tangent lines are computed from the real boundary." },
    ...shapeRows("a"),
    ...shapeRows("b"),
    ...props("stroke", "strokeWidth"),
    ...props("opacity"),
    // THE SHARED DASH ROWS, filed under this widget's own category. These three
    // were hand-written here — a fifth copy of core/endpoints.js's declaration,
    // and it had ALREADY DRIFTED: the dashGap help had lost "in canvas units", so
    // the same control documented its own units on four connectors and not on this
    // one. The `category` is the ONLY thing that differs (tangent_lines files them
    // beside its own knobs rather than under "line"), which is exactly what a map
    // over the shared constant expresses — and it is now the one thing a reader has
    // to check, instead of three help strings.
    ...CONNECTOR_DASH_ROWS.map((row) => ({ ...row, category: "tangent" })),
    ...bundle("effects"),
  ],
  presets: TANGENT_LINES_PRESETS,
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
    // Effect region = its ink rect, the SAME rect `localBounds` reports, so the
    // substrate and the cull/band bounds can never disagree about where this
    // widget is (with no tangents there are no ops either, so applyEffects has an
    // empty list to pass through).
    return applyEffects(cmds, s, world, tangentLinesInkRect(s));
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * the two external tangent segments as TWO open centerline subpaths, in the ink
   * rect's frame.
   *
   * INCLUDED, THOUGH IT IS THE FAMILY'S ODD MEMBER, and the deciding question was
   * whether its payload has a STABLE STRUCTURE. It does: `externalTangents`
   * returns the two hull bridges or NOTHING — never a count that drifts with a
   * styling knob. That is what separates this from the dash pattern every
   * connector here deliberately omits, where the fragment count is a function of
   * length. Two subpaths in, two subpaths out, so the aligner pairs contours that
   * mean the same thing at both ends of a morph.
   *
   * CENTERLINES for the usual reason (emit() draws stroked polylines; there is no
   * silhouette in this file to reuse), from the SAME `shapeDescriptors` +
   * `externalTangents` pair emit() draws with. The DASHES are omitted exactly as
   * plugins/line.js omits them.
   *
   * THE TWO SHAPES THEMSELVES ARE NOT INK. This widget draws only the bridging
   * tangents — the circles/boxes are its PARAMETERS, usually other widgets — so
   * reporting their outlines would morph geometry this item never paints.
   */
  morphPaths(s) {
    const [a, b] = shapeDescriptors(s);
    const paint = statePaint({ ...s, fill: null, strokeWidth: s.strokeWidth ?? DEFAULT_STROKE_WIDTH });
    return morphPayloadFromConnector(
      externalTangents(a, b).map(([p, q]) => ({ d: polylinePathD([p, q]), paint })),
      tangentLinesInkRect(s),
    );
  },
  /** Pure function. Why this pair cannot morph YET, or null. Coincident shapes (or
   * one containing the other) have NO external tangent, which is the same
   * condition emit() draws nothing on — one predicate, not two. */
  morphNotReady(s) {
    const [a, b] = shapeDescriptors(s);
    return externalTangents(a, b).length ? null : "two shapes with a real external tangent (these have none, so nothing is drawn)";
  },
  // THE BOUNDS PROTOCOL (core/view.js localBoundsOf): the tangent endpoints'
  // min/max IS this widget's width and height, so it band-selects and culls like
  // any box widget despite having no w/h state and no resize handles.
  localBounds: tangentLinesInkRect,
  // Effects halo (shadow/bloom spill) extends the cull AABB — core/view.js
  // defaultCanSkip's cullMargin hook. MANDATORY now that this widget HAS an AABB
  // to be culled by: without it a shadowed tangent just off-view loses its halo.
  cullMargin: effectsCullMargin,
  hitTestWorld(node, wx, wy) {
    const [a, b] = shapeDescriptors(node.state);
    const grab = (node.state.strokeWidth ?? DEFAULT_STROKE_WIDTH) / 2 + DEFAULT_STROKE_WIDTH;
    return externalTangents(a, b).some(([p, q]) => pointSegmentDistance(wx, wy, p, q) <= grab);
  },
  // THE ANCHORS PROTOCOL over the INK RECT, not over a w/h this widget does not have
  // (tangentLinesAnchors states what the plain standardBBoxAnchors hook silently did).
  anchors: tangentLinesAnchors,
};

// ── Telescopic-magnifier rig (pure builder) ───────────────────────────────────

/**
 * Telescopic-magnifier rig constants (world units) — the DEFAULT geometry, for
 * the drop-in-place entry point that has no gesture to read a box from.
 * telescopicDefaultRects() turns them into the two rects the builders take, so
 * they cannot drift across the builder's three items.
 *
 * The rig is a function of a shared tween VARIABLE `t` (a document var, default
 * 0): at t=0 the lens coincides with the source at magnification 1 (identity —
 * "nothing happened"); at t=1 the lens IS the second placed box (by default, the
 * source pulled out by (PULL_X, PULL_Y) and grown to LENS_SIZE). The ZOOM is NOT
 * a constant — it EMERGES from the sizes (magX = lens.w/source.w, magY =
 * lens.h/source.h), so a non-proportional source/lens pair squishes correctly.
 */
export const TELESCOPIC = {
  TWEEN_VAR: "t",   // shared tween parameter (document variable), default 0
  SOURCE_SIZE: 96,  // source-marker + lens diameter at t=0 (the identity size)
  LENS_SIZE: 340,   // lens diameter at t=1 (zoom = LENS_SIZE/SOURCE_SIZE emerges)
  PULL_X: 440,      // lens-center x displacement from the origin at t=1
  PULL_Y: -250,     // lens-center y displacement from the origin at t=1 (up-right)
  ORIGIN_X: 430,    // default world origin (the region being magnified) — the drop point
  ORIGIN_Y: 500,    // chosen so the up-right pull-out stays inside a 1280×720 camera
  RIM_COLOR: "#000000",
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
 * Pure function. The rig's DEFAULT geometry as the two world rects the builders
 * below take: the source at (ORIGIN_X, ORIGIN_Y) sized SOURCE_SIZE, and the lens
 * where t=1 puts it — pulled by (PULL_X, PULL_Y) and grown to LENS_SIZE.
 *
 * THE BUILDERS ARE PARAMETERIZED BY RECTS, NOT BY THE CONSTANTS, because the
 * rig is now placeable by gesture ("drag the region to magnify, then drag where
 * it appears" — web/telescopicRig.js). The constants remain THE drop-in-place
 * default, expressed here as the rects that gesture would have produced, so both
 * entry points go through ONE builder and cannot drift.
 *
 * @returns {{source: {x,y,w,h}, lens: {x,y,w,h}}} world rects
 *
 * @example telescopicDefaultRects().source // {x: 382, y: 452, w: 96, h: 96}
 * @example telescopicDefaultRects().lens // {x: 700, y: 80, w: 340, h: 340}
 */
export function telescopicDefaultRects() {
  const half = TELESCOPIC.SOURCE_SIZE / 2;
  const lensHalf = TELESCOPIC.LENS_SIZE / 2;
  return {
    source: {
      x: TELESCOPIC.ORIGIN_X - half, y: TELESCOPIC.ORIGIN_Y - half,
      w: TELESCOPIC.SOURCE_SIZE, h: TELESCOPIC.SOURCE_SIZE,
    },
    lens: {
      x: TELESCOPIC.ORIGIN_X + TELESCOPIC.PULL_X - lensHalf,
      y: TELESCOPIC.ORIGIN_Y + TELESCOPIC.PULL_Y - lensHalf,
      w: TELESCOPIC.LENS_SIZE, h: TELESCOPIC.LENS_SIZE,
    },
  };
}

/**
 * Pure function. The centre of a rect — the ONE place the rig converts a placed
 * box into the point its equations reference, so the pull vector and the marker
 * position can never disagree about where a shape is.
 *
 * @param {{x:number, y:number, w:number, h:number}} r
 * @returns {{x: number, y: number}}
 *
 * @example rectCenter({x: 10, y: 20, w: 100, h: 40}) // {x: 60, y: 40}
 */
export function rectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Pure function. The SOURCE-MARKER override dict — an outline (no fill) filling
 * the placed `source` rect. type is a circle or a rect (spread over that
 * plugin's registry defaults by the command). It has no equations: it is the
 * fixed anchor the lens magnifies from and the tangents fan out of.
 *
 * @param {{shapeKind:string, source:{x,y,w,h}}} opts
 * @returns {object} property overrides
 *
 * @example telescopicSourceOverrides({ shapeKind: "circle", source: {x: 382, y: 422, w: 96, h: 96} }).type // "circle"
 * @example telescopicSourceOverrides({ shapeKind: "box", source: {x: 0, y: 0, w: 200, h: 80} }) // {type: "rect", x: 0, y: 0, w: 200, h: 80, rotation: 0, scale: 1, fill: "#00000000", stroke: "#000000", strokeWidth: 4}
 */
export function telescopicSourceOverrides({ shapeKind, source }) {
  return {
    type: shapeWidgetType(shapeKind),
    x: source.x, y: source.y, w: source.w, h: source.h,
    rotation: 0, scale: 1,
    fill: TELESCOPIC.NO_FILL, stroke: TELESCOPIC.RIM_COLOR, strokeWidth: TELESCOPIC.RIM_WIDTH,
  };
}

/**
 * Pure function. The LENS override dict — a demo_magnify wired by `=` equations
 * to the source marker and the shared tween var. The lens SAMPLES from the
 * source center (`origin`) at every t, but its DISPLAY center travels from the
 * source centre to the LENS rect's centre and its size grows from the source
 * box to the lens box, both linearly in t.
 * The ZOOM is DERIVED, per-axis, from the box sizes: magnificationX = self.w /
 * source.w, magnificationY = self.h / source.h — so it is redundant-free (never
 * a separate constant) and squishes correctly when the aspect ratios differ. At
 * t=0 the sizes are equal → mag 1 (identity). `sourceId` is the raw source id.
 *
 * BOTH AXES GET THEIR OWN SIZE EQUATION (`h` is no longer `= self.w`): the two
 * rects a gesture places have independent aspect ratios, and a lens locked square
 * could not land on the box the user dragged. For the square default rects the
 * two equations evaluate identically at every t, so the drop-in-place rig is
 * unchanged; only an anisotropic pair can tell the difference, and for that pair
 * the per-axis form is the correct one (the per-axis magnification below already
 * assumed it).
 *
 * @param {{sourceId:string, shapeKind:string, source:{x,y,w,h}, lens:{x,y,w,h}}} opts
 * @returns {object} property overrides (equation strings)
 *
 * @example telescopicLensOverrides({ sourceId: "ab12cd34", shapeKind: "circle", source: {x: 0, y: 0, w: 96, h: 96}, lens: {x: 400, y: -300, w: 340, h: 340} }).magnificationX // "= self.w / @ab12cd34.w"
 * @example telescopicLensOverrides({ sourceId: "ab12cd34", shapeKind: "circle", source: {x: 0, y: 0, w: 96, h: 96}, lens: {x: 400, y: -300, w: 340, h: 340} }).w // "= 96 + (244) * t"
 * @example telescopicLensOverrides({ sourceId: "ab12cd34", shapeKind: "circle", source: {x: 0, y: 0, w: 96, h: 96}, lens: {x: 400, y: -300, w: 340, h: 340} }).x // "= @ab12cd34_cm.x + (522) * t - self.w / 2" (pull = lens centre − source centre)
 * @example telescopicLensOverrides({ sourceId: "ab12cd34", shapeKind: "circle", source: {x: 0, y: 0, w: 96, h: 96}, lens: {x: 400, y: -300, w: 340, h: 340} }).origin.x // "@ab12cd34_cm.x" (bare ref — see below)
 */
export function telescopicLensOverrides({ sourceId, shapeKind, source, lens }) {
  const t = TELESCOPIC.TWEEN_VAR;
  const from = rectCenter(source), to = rectCenter(lens);
  return {
    type: "demo_magnify",
    shape: lensShapeFor(shapeKind),
    rotation: 0, scale: 1,
    stroke: TELESCOPIC.RIM_COLOR, strokeWidth: TELESCOPIC.RIM_WIDTH,
    // Parenthesized deltas: a lens SMALLER than its source, or pulled left/up,
    // contributes a negative literal, and `+ -244 * t` is not an expression the
    // evaluator should have to forgive.
    w: `= ${source.w} + (${lens.w - source.w}) * ${t}`,
    h: `= ${source.h} + (${lens.h - source.h}) * ${t}`,
    x: `= @${sourceId}_cm.x + (${to.x - from.x}) * ${t} - self.w / 2`,
    y: `= @${sourceId}_cm.y + (${to.y - from.y}) * ${t} - self.h / 2`,
    // origin is a demo_magnify COMPUTED-DEFAULT slot (its default is the bare
    // self-anchor "self.anchors.center.x"), so it takes a BARE reference — NOT a
    // leading `=` (a `=` slot would infer its result kind as the default's
    // string type and reject a numeric result). Bare = the same form the plugin
    // default uses; it evaluates as a numeric slot (isNumericSlot / self.-prefix).
    origin: { x: `@${sourceId}_cm.x`, y: `@${sourceId}_cm.y` },
    // Zoom EMERGES from the sizes — per axis, so a squished pair squishes.
    magnificationX: `= self.w / @${sourceId}.w`,
    magnificationY: `= self.h / @${sourceId}.h`,
  };
}

/**
 * Pure function. The TANGENT-LINES override dict — a tangent_lines widget whose
 * A tracks the source marker and B tracks the lens: centers bound to each
 * item's center anchor (`@id_cm`), half-extents bound to each item's half-width
 * / half-height (`@id.w / 2`, `@id.h / 2`), rotation to `@id.rotation`, shapeKind
 * matched literally. So the two tangents hug the real (possibly stretched)
 * boundary of both and fan open exactly as the lens pulls out. `sourceId` /
 * `lensId` are raw item ids.
 *
 * @param {{sourceId:string, lensId:string, shapeKind:string}} opts
 * @returns {object} property overrides (equation strings)
 *
 * @example telescopicTangentOverrides({ sourceId: "s1", lensId: "l1", shapeKind: "box" }).a.x // "= @s1_cm.x"
 * @example telescopicTangentOverrides({ sourceId: "s1", lensId: "l1", shapeKind: "box" }).b.halfH // "= @l1.h / 2"
 */
export function telescopicTangentOverrides({ sourceId, lensId, shapeKind }) {
  const shapeRefs = (id) => ({
    x: `= @${id}_cm.x`, y: `= @${id}_cm.y`,
    halfW: `= @${id}.w / 2`, halfH: `= @${id}.h / 2`, rotation: `= @${id}.rotation`,
  });
  return {
    type: "tangent_lines",
    shapeKind,
    a: shapeRefs(sourceId),
    b: shapeRefs(lensId),
    stroke: TELESCOPIC.RIM_COLOR, strokeWidth: TELESCOPIC.RIM_WIDTH,
  };
}
