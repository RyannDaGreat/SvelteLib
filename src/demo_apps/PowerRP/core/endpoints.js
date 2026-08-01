/**
 * Endpoint-pair capability — ONE home (manifest rule: "things that can be
 * generic should be, and generic things need a designated place") for the
 * plumbing shared by every widget whose geometry hangs off point-valued
 * properties like an arrow's from/to: {x, y} pairs whose coordinates may be
 * EQUATIONS (anchor bindings — THE UNIFICATION). Plugins may not import each
 * other (registry rule), so before this module existed the arrow variants
 * copied these hooks verbatim (plugins/arrow.js ↔ plugins/fancy_arrow.js).
 * Every arrow-family widget (arrow, fancy arrow, future elbow/curved
 * variants — manifest Round 12B) spreads endpointPairHooks() and adds only
 * its own geometry.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { distToSegment } from "./outline.js";
import { num, polygonPathD } from "./shapes.js";
import { ellipsePathD } from "./svg_paths.js";

/**
 * Extra grab slack around a shaft segment, in world px — a hairline shaft
 * stays clickable. One home for the pad both arrow plugins carried as a
 * literal `+ 5` (same value, same screen-feel rationale).
 */
export const SHAFT_GRAB_PAD = 5;

/**
 * Fraction of a head's length the shaft stops short of the tip — the shaft
 * end sits INSIDE the head triangle, so shaft and head always overlap
 * seamlessly (and a round shaft cap never pokes past the tip). Originated in
 * arrow.js as a local constant (0.6, same value/semantics preserved here
 * verbatim) — promoted to this shared home now that elbow/curved arrows and
 * the mirrored start-head all need the identical pullback math (manifest
 * ARCHITECTURE PLAN #6: a head on ALL arrow kinds, at either end). Since the
 * per-end head SHAPES landed, the FRACTION is still this constant but the
 * DISTANCE is per shape — a hollow glyph cannot be tucked into the way a solid
 * one can — so each generator carries its own pullback (see HEAD_GENERATORS).
 */
export const SHAFT_PULLBACK = 0.6;

/**
 * Pure function. Editable-point descriptors for the editor's draggable
 * endpoint handles: the generic editable-point interface (the editor writes
 * values into state[key].x/.y — numbers when free, equation strings when
 * dropped on an anchor; the UI never special-cases arrows).
 *
 * Args:
 *     state (object): item state holding {x, y} pairs at `keys`
 *     keys (string[]): the point-valued property names, in handle order
 *
 * Returns:
 *     {key, x, y}[]
 *
 * @example endpointEditPoints({from: {x: 1, y: 2}, to: {x: 3, y: 4}}) // [{key: "from", x: 1, y: 2}, {key: "to", x: 3, y: 4}]
 */
export function endpointEditPoints(state, keys = ["from", "to"]) {
  return keys.map((key) => ({ key, x: state[key].x, y: state[key].y }));
}

/**
 * Pure function. Shaft-drag translation (manifest round 5: "dragging the
 * middle should move BOTH endpoints"). Takes the RAW stored state and
 * returns [pathWithinItem, value] pairs for every FREE (numeric) endpoint
 * coordinate; equation-bound coordinates are anchored and stay put — a
 * widget with every endpoint bound doesn't move from a shaft drag.
 *
 * @example endpointMoveBy({from: {x: 0, y: 0}, to: {x: 10, y: "@c1_tm.y"}}, 5, 2) // [[["from","x"],5],[["from","y"],2],[["to","x"],15]]
 */
export function endpointMoveBy(state, dx, dy, keys = ["from", "to"]) {
  const pairs = [];
  for (const end of keys)
    for (const coord of ["x", "y"]) {
      const v = state[end]?.[coord];
      if (typeof v === "number") pairs.push([[end, coord], v + (coord === "x" ? dx : dy)]);
    }
  return pairs;
}

/**
 * Pure function. The toward-context for "closest" anchor references in a
 * widget's equations (core/expressions.js evaluation hook): an endpoint aims
 * at the OTHER endpoint of the pair. Coordinates may still be unevaluated
 * strings mid-pass — the evaluator roughs those to 0 and fixpoints (see
 * expressions.js). Non-endpoint paths return null (no toward-context).
 *
 * @example endpointClosestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["from", "x"]) // {x: 3, y: 4}
 * @example endpointClosestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["to", "y"]) // {x: 1, y: 2}
 * @example endpointClosestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["width"]) // null
 */
export function endpointClosestToward(state, path, keys = ["from", "to"]) {
  const i = keys.indexOf(path[0]);
  if (i === -1) return null;
  return state[keys[(i + 1) % keys.length]] ?? null;
}

/**
 * Pure function. Padded-shaft hit test: is world point (wx, wy) within
 * `radius` + SHAFT_GRAB_PAD of the keys[0]→keys[1] segment? `radius` is the
 * widget's own half-thickness contribution (the basic arrow passes its
 * stroke width, the fancy arrow its widest half-shaft).
 *
 * @example hitsShaft({from: {x: 0, y: 0}, to: {x: 10, y: 0}}, 5, 3, 0) // true (3 ≤ 0 + 5 pad)
 * @example hitsShaft({from: {x: 0, y: 0}, to: {x: 10, y: 0}}, 5, 9, 0) // false (9 > 5)
 */
export function hitsShaft(state, wx, wy, radius, keys = ["from", "to"]) {
  return distToSegment(wx, wy, state[keys[0]], state[keys[1]]) <= radius + SHAFT_GRAB_PAD;
}

/**
 * Pure function. Padded multi-segment-shaft hit test: is world point (wx, wy)
 * within `radius` + SHAFT_GRAB_PAD of ANY segment of the polyline `points`?
 * The multi-segment generalization of hitsShaft — the elbow route and the
 * sampled curved-arrow polyline both grab exactly like a straight shaft (same
 * pad, same half-thickness), so the loop lives here ONCE rather than copied
 * into elbow_arrow.js / curved_arrow.js.
 *
 * @example hitsPolylineShaft([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}], 10, 3, 0) // true (on the second segment, within pad)
 * @example hitsPolylineShaft([{x: 0, y: 0}, {x: 10, y: 0}], 5, 20, 0) // false (20 > 5 + pad)
 */
export function hitsPolylineShaft(points, wx, wy, radius) {
  for (let i = 0; i < points.length - 1; i++)
    if (distToSegment(wx, wy, points[i], points[i + 1]) <= radius + SHAFT_GRAB_PAD) return true;
  return false;
}

/**
 * Pure function. The total arc length of a polyline, in world units.
 *
 * @example polylineLength([{x: 0, y: 0}, {x: 3, y: 4}]) // 5
 * @example polylineLength([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}]) // 20
 * @example polylineLength([{x: 5, y: 5}]) // 0 (a single point has no extent)
 */
export function polylineLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  return total;
}

/**
 * Pure function. Walk `dist` along a polyline's arc length from its first point.
 * Returns the point reached AND the index of the segment it fell in, so a caller
 * that needs the remaining VERTICES (a trim) and one that needs only the POINT
 * (a path anchor) share one traversal instead of writing it twice.
 *
 * Walking past the end clamps to the last vertex — an over-long trim collapses
 * rather than running off the array.
 *
 * Args:
 *   points ({x,y}[]): at least one vertex
 *   dist (number): arc length from points[0]
 *
 * Returns:
 *   {point: {x, y}, index: number} — `index` is the segment the point lies on
 *     (its start vertex), or points.length - 1 when clamped to the end
 *
 * @example walkPolyline([{x: 0, y: 0}, {x: 10, y: 0}], 4) // {point: {x: 4, y: 0}, index: 0}
 * @example walkPolyline([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}], 15) // {point: {x: 10, y: 5}, index: 1}
 * @example walkPolyline([{x: 0, y: 0}, {x: 10, y: 0}], 99) // {point: {x: 10, y: 0}, index: 1}
 */
export function walkPolyline(points, dist) {
  let remaining = dist;
  for (let i = 0; i < points.length - 1; i++) {
    const segLen = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (remaining <= segLen) {
      const t = segLen === 0 ? 0 : remaining / segLen; // a zero-length segment has no direction to walk along
      return { point: { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t }, index: i };
    }
    remaining -= segLen;
  }
  return { point: points[points.length - 1], index: points.length - 1 };
}

/**
 * Pure function. The point at fraction `t` of a polyline's ARC LENGTH — not of
 * its parameter, which is a different point on anything but a straight line.
 * t=0 is the first vertex, t=1 the last, t=0.5 the halfway point BY DISTANCE.
 *
 * This is the primitive behind the connector path anchors, and arc length is the
 * whole reason it exists: a curved arrow's bezier is sampled uniformly in the
 * bezier PARAMETER, so its middle sample is not its middle point, and an elbow
 * route's three legs have three different lengths.
 *
 * @example pointAtPolylineFraction([{x: 0, y: 0}, {x: 10, y: 0}], 0.5) // {x: 5, y: 0}
 * @example pointAtPolylineFraction([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}], 0.5) // {x: 10, y: 0} (the corner: 10 of the 20 total)
 * @example pointAtPolylineFraction([{x: 4, y: 7}, {x: 4, y: 7}], 0.5) // {x: 4, y: 7} (zero length: every fraction is the same point)
 */
export function pointAtPolylineFraction(points, t) {
  return walkPolyline(points, polylineLength(points) * t).point;
}

/**
 * The three path anchor ids a connector publishes, and the arc-length fraction
 * each sits at. Exported so a test names them from here rather than restating
 * three string literals (and so a fourth is added in ONE place).
 *
 * @example CONNECTOR_PATH_ANCHORS.map((a) => a.id) // ["start", "mid", "end"]
 */
export const CONNECTOR_PATH_ANCHORS = [{ id: "start", t: 0 }, { id: "mid", t: 0.5 }, { id: "end", t: 1 }];

/**
 * Pure function. A connector's preset anchors: three points ON ITS DRAWN PATH,
 * at arc-length fractions 0 / 0.5 / 1. World == identity for every connector, so
 * these local coordinates are also its world ones.
 *
 * ── WHY THESE THREE AND NOT THE STANDARD NINE ────────────────────────────────
 * plugins/tangent_lines.js — the one other `bbox: false` widget with anchors —
 * publishes the nine standardBBoxAnchors over its ink rect, and this deliberately
 * does not follow it. For a CONNECTOR the ink rect is an artifact of the route
 * rather than a feature of it: an elbow route hugs two sides of its own AABB, so
 * that box's `cm` sits in empty space the connector never passes through, and a
 * label bound there is placed by a point the user cannot see. A curved arrow is
 * worse — its bbox centre misses the visible curve by bend·span/2 along the
 * normal. Every anchor here is ON the ink, which is the property that makes
 * binding a mid-edge label to one of them mean what it looks like it means.
 *
 * ── WHY MID IS BY ARC LENGTH ─────────────────────────────────────────────────
 * "Halfway along" is a distance, not a parameter. The chord midpoint
 * (from + to) / 2 is the workaround this replaces, and it is simply wrong for
 * both curved widgets.
 *
 * Anchor ids contain NO underscore, as the equation reference grammar requires
 * (plugins/bento.js's docblock explains why: the head splits on an underscore).
 *
 * Args:
 *   points ({x,y}[]): the connector's DRAWN path, as its emit() computes it
 *
 * Returns:
 *   {id, x, y}[] — the registry's anchors() contract
 *
 * @example connectorPathAnchors([{x: 0, y: 0}, {x: 100, y: 0}]) // [{id: "start", x: 0, y: 0}, {id: "mid", x: 50, y: 0}, {id: "end", x: 100, y: 0}]
 * @example connectorPathAnchors([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}])[1] // {id: "mid", x: 10, y: 0}
 */
export function connectorPathAnchors(points) {
  const total = polylineLength(points);
  return CONNECTOR_PATH_ANCHORS.map(({ id, t }) => {
    const p = walkPolyline(points, total * t).point;
    return { id, x: p.x, y: p.y };
  });
}

/**
 * Pure function (factory returning pure hooks). The three plugin hooks an
 * endpoint-pair widget spreads into its definition — editPoints(node),
 * moveBy(state, dx, dy), closestToward(state, path) — all delegating to the
 * pure functions above with the same `keys`.
 *
 * @example // export const arrowPlugin = { type: "arrow", ...endpointPairHooks(), emit(s) {...} };
 * @example endpointPairHooks().closestToward({from: {x: 1, y: 2}, to: {x: 3, y: 4}}, ["from", "x"]) // {x: 3, y: 4}
 */
export function endpointPairHooks(keys = ["from", "to"]) {
  return {
    editPoints: (node) => endpointEditPoints(node.state, keys),
    moveBy: (state, dx, dy) => endpointMoveBy(state, dx, dy, keys),
    closestToward: (state, path) => endpointClosestToward(state, path, keys),
  };
}

/**
 * Shared defaults for the simple endpoint arrows (basic / elbow / curved — NOT
 * the fancy arrow, which uses the property registry). These were copied verbatim
 * into all three plugins' `defaults`; the numbers also recur as `?? N` fallbacks
 * in their emit/hit-test code, so each is exported on its own to single-source
 * both. headWidth 12 ≈ the pre-reparameterization fixed-flare head's width
 * (2·14·sin(0.44) = 11.93), so the default arrow renders visually unchanged.
 */
export const ARROW_STROKE_WIDTH = 3; // px — a visible-but-slim default shaft
export const ARROW_HEAD_LENGTH = 14; // px — tip-to-base length along the shaft
export const ARROW_HEAD_WIDTH = 12; // px — full base width across the shaft axis

/**
 * The per-end head defaults. `headEnd: "triangle"` + `headStart: "none"` IS the
 * retired `headMode: "end"`, so an untouched arrow renders byte-identical to
 * every version before the split (core/document.js withHeadModeSplit migrates
 * a stored `headMode` onto this pair, loudly).
 */
export const HEAD_START_DEFAULT = "none";
export const HEAD_END_DEFAULT = "triangle";
export const ARROW_ENDPOINT_DEFAULTS = { strokeWidth: ARROW_STROKE_WIDTH, headLength: ARROW_HEAD_LENGTH, headWidth: ARROW_HEAD_WIDTH, headStart: HEAD_START_DEFAULT, headEnd: HEAD_END_DEFAULT };

// ── ARROWHEAD SHAPES ─────────────────────────────────────────────────────────
//
// WHY THERE ARE MANY. Until this library there was exactly ONE head — a filled
// triangle — and `headMode` chose WHICH ends got it, never WHAT. That is one
// glyph against the 16 a diagram vocabulary actually needs: UML inheritance is a
// HOLLOW triangle, composition a FILLED diamond, aggregation a HOLLOW one, a state
// transition a notched DART, and ER cardinality four crow's-foot glyphs. The
// vocabulary below is derived from that measured need rather than invented (see
// the audit in .frenzy/round6/W3-N.md §2.1, read out of the pinned mermaid build).
//
// ── THE HEAD FRAME ───────────────────────────────────────────────────────────
// Every glyph is authored in ONE local frame and mapped to world by a single
// point function, so a shape author writes flat 2-D numbers and never touches a
// rotation:
//
//   back   — distance BEHIND the tip, along the shaft axis (0 = at the tip)
//   across — signed offset perpendicular to it, along the axis's RIGHT normal
//
// so `P(0, 0)` is the tip and `P(len, ±width/2)` are the classic triangle's base
// corners. A glyph is symmetric about the shaft exactly when its `across` values
// come in ± pairs. `len` is headLength and `width` is headWidth, which is what
// makes every shape here scale with the SAME two knobs the triangle always had.
//
// ── BACKEND CONTRACT (why no glyph uses an elliptical arc) ───────────────────
// The same contract core/shapes.js declares: pdf_backend's svgPathToPdfOps accepts
// only M L H V C Q T Z and THROWS on `A` (render_gpu/ir.js's `path` docblock says
// so verbatim). Circles therefore come from core/svg_paths.js ellipsePathD — the
// KAPPA four-cubic approximation written for exactly this reason — rather than a
// second one written here.
//
// ── WHY SOME GLYPHS ARE A `polygon` OP AND SOME A `path` ─────────────────────
// render_gpu/ir.js's `polygon` is FILL-ONLY: it has no stroke slot at all, so a
// HOLLOW glyph structurally cannot be one. The three solid straight-edged glyphs
// stay `polygon` because that keeps every existing document's display list
// byte-identical; everything needing an outline, a curve or an open contour is a
// `path`. The discriminator a caller reads is the presence of `d` — see
// headDrawings() and the one-line map in each arrow plugin's emit().

/**
 * The concave notch of a DART, as a fraction of the head length. Measured off
 * mermaid's `arrow_barb` marker (`M 19,7 L9,13 L14,7 L9,1 Z`): a 10-long head
 * whose rear vertex sits 5 back from the tip. It is the one number that makes a
 * dart read as a dart rather than as a slightly odd triangle.
 */
const DART_NOTCH = 0.5;

/**
 * A diamond's widest point, as a fraction of the head length — the same halfway
 * measurement mermaid's `composition` / `aggregation` markers use.
 */
const DIAMOND_WAIST = 0.5;

// ── THE FOUR ER CARDINALITY GLYPHS ARE A 2×2, NOT FOUR DRAWINGS ──────────────
//
// Entity-relationship notation says two INDEPENDENT things at one end: how many
// (one = a tick across the line, many = a crow's foot) and whether zero is allowed
// (a ring). So `onlyOne` / `zeroOrOne` / `oneOrMore` / `zeroOrMore` are the four
// cells of {tick, crow} × {tick, ring}, and erHead() DERIVES them from that pair
// instead of drawing four glyphs that must be kept consistent by hand (the ledger's
// "derive the list; do not top up a drifted mirror" rule).
//
// They remain FOUR FLAT enum values to the user, deliberately. A user-facing
// composition axis would be a second property that is meaningless for every
// non-ER shape — a dead control on eleven of fifteen glyphs — and mermaid itself
// ships them as four flat marker ids.
const ER_NEAR = 1 / 3;  // the near mark's position, as a fraction of len behind the tip
const ER_FAR = 2 / 3;   // the far mark's; at this spacing `onlyOne`'s two ticks read as parallel
const ER_CROW_SPAN = 0.5; // how far back the crow's-foot lens reaches, clearing the far mark
const ER_RING_RADIUS = ER_FAR - ER_CROW_SPAN; // DERIVED: a ring on the far mark just touching the lens ahead of it

/**
 * Pure function. Open (unclosed) subpaths as one SVG path `d` — the stroke-only
 * sibling of core/shapes.js subpathsPathD, which closes every subpath with `Z`.
 * A cross, a bare V and the ER ticks are strokes with two loose ends, so closing
 * them would draw a line back along itself.
 *
 * Kept local rather than exported beside subpathsPathD: it has exactly one
 * consumer (the generators below), and the ledger's shared-module rule asks for
 * two before a thing becomes public API.
 *
 * @example openSubpathsPathD([[[0, 0], [10, 5]]]) // "M0 0 L10 5"
 * @example openSubpathsPathD([[[0, 0], [10, 10]], [[10, 0], [0, 10]]]) // "M0 0 L10 10 M10 0 L0 10"
 */
function openSubpathsPathD(subpaths) {
  return subpaths.map(([first, ...rest]) =>
    `M${num(first[0])} ${num(first[1])} ` + rest.map(([x, y]) => `L${num(x)} ${num(y)}`).join(" ")).join(" ");
}

/**
 * Pure function. One ER cardinality glyph, from the two INDEPENDENT marks its
 * notation is made of (see the 2×2 note above): a `near` mark at the tip end
 * saying HOW MANY, and a `far` mark behind it saying whether ZERO is allowed.
 *
 * Args:
 *   P (function): the head frame's (back, across) → [x, y] mapper
 *   len (number): head length; width (number): head width
 *   near ("tick"|"crow"): one, or many
 *   far ("tick"|"ring"): mandatory, or optional
 *
 * Returns:
 *   {d, filled, pullback}: a stroke-only head drawing
 *
 * @example erHead((b, a) => [b, a], 30, 12, "tick", "tick").d // "M10 6 L10 -6 M20 6 L20 -6"
 * @example erHead((b, a) => [b, a], 30, 12, "tick", "tick").filled // false
 */
function erHead(P, len, width, near, far) {
  const half = width / 2;
  const tick = (back) => [P(back, half), P(back, -half)];
  // The crow's foot is a closed LENS along the axis: two quadratics from the tip
  // back to ER_CROW_SPAN, bowing to ±half at the waist. A quadratic's midpoint is
  // (A + 2C + B) / 4, so a control at ±width puts the waist at exactly ±half.
  const span = len * ER_CROW_SPAN;
  const [tipX, tipY] = P(0, 0), [tailX, tailY] = P(span, 0);
  const [c1x, c1y] = P(span / 2, width), [c2x, c2y] = P(span / 2, -width);
  const crow = `M${num(tipX)} ${num(tipY)} Q${num(c1x)} ${num(c1y)} ${num(tailX)} ${num(tailY)} Q${num(c2x)} ${num(c2y)} ${num(tipX)} ${num(tipY)}`;
  const [ringX, ringY] = P(len * ER_FAR, 0);
  const strokes = [];
  if (near === "tick") strokes.push(tick(len * ER_NEAR));
  if (far === "tick") strokes.push(tick(len * ER_FAR));
  const d = [
    strokes.length ? openSubpathsPathD(strokes) : "",
    near === "crow" ? crow : "",
    far === "ring" ? ellipsePathD(ringX, ringY, len * ER_RING_RADIUS, len * ER_RING_RADIUS) : "",
  ].filter(Boolean).join(" ");
  return { d, filled: false, pullback: 0 }; // ER glyphs sit ON the line: it runs through them
}

/**
 * THE HEAD-SHAPE LIBRARY: shape id → generator (P, len, width) → drawing.
 *
 * A generator returns `null` (nothing to draw) or a DRAWING:
 *   {points, pullback}         a filled straight-edged polygon (an ir.js `polygon`)
 *   {d, filled, pullback}      an SVG path (an ir.js `path`); `filled` picks fill vs outline
 *
 * `pullback` — how far the SHAFT must stop short of the tip so the two meet
 * cleanly — is carried BY the drawing rather than by a parallel lookup table,
 * because a per-shape pullback map would be a hand-maintained mirror of this one
 * and would drift the first time a glyph's proportions changed (ledger C-8).
 * Each value is justified where it is written.
 *
 * Ordered tip-first: the plain heads, then the UML pair-with-a-hollow-twin, then
 * the open decorations, then the four ER cardinality glyphs.
 */
const HEAD_GENERATORS = {
  none: () => null,
  // SHAFT_PULLBACK of the head length ends the shaft INSIDE the solid glyph, so
  // shaft and head overlap seamlessly and a round cap never pokes past the tip.
  triangle: (P, len, width) => ({ points: [P(0, 0), P(len, width / 2), P(len, -width / 2)], pullback: len * SHAFT_PULLBACK }),
  // A hollow glyph is see-through, so the shaft may not tuck inside it: it stops
  // at the glyph's rear edge instead. Same rule for every `*Open` shape below.
  triangleOpen: (P, len, width) => ({ d: polygonPathD([P(0, 0), P(len, width / 2), P(len, -width / 2)]), filled: false, pullback: len }),
  // The dart is solid only AHEAD of its notch, so the shaft must reach past the
  // notch to be covered — hence the pullback is a fraction of the NOTCH depth,
  // not of the full length.
  dart: (P, len, width) => ({ points: [P(0, 0), P(len, width / 2), P(len * DART_NOTCH, 0), P(len, -width / 2)], pullback: len * DART_NOTCH * SHAFT_PULLBACK }),
  diamond: (P, len, width) => ({ points: [P(0, 0), P(len * DIAMOND_WAIST, width / 2), P(len, 0), P(len * DIAMOND_WAIST, -width / 2)], pullback: len * SHAFT_PULLBACK }),
  diamondOpen: (P, len, width) => ({ d: polygonPathD([P(0, 0), P(len * DIAMOND_WAIST, width / 2), P(len, 0), P(len * DIAMOND_WAIST, -width / 2)]), filled: false, pullback: len }),
  // A disc of DIAMETER width, sitting just behind the tip. Its pullback is the
  // radius — the shaft ends at the centre, buried under the fill.
  circle: (P, len, width) => circleHead(P, width, true),
  // The hollow ring is also how a UML lollipop draws: a full-diameter pullback
  // stops the shaft at the ring's far edge instead of crossing the hole.
  circleOpen: (P, len, width) => circleHead(P, width, false),
  // An X spanning the head box. The line runs right into it (mermaid's `--x`), so
  // there is nothing to pull back from.
  cross: (P, len, width) => ({ d: openSubpathsPathD([[P(0, width / 2), P(len, -width / 2)], [P(0, -width / 2), P(len, width / 2)]]), filled: false, pullback: 0 }),
  // A bare V whose vertex IS the tip — two strokes, no closing edge — so the
  // shaft runs the whole way and meets it at the point.
  open: (P, len, width) => ({ d: openSubpathsPathD([[P(len, width / 2), P(0, 0), P(len, -width / 2)]]), filled: false, pullback: 0 }),
  crossedCircle: (P, len, width) => crossedCircleHead(P, width),
  onlyOne: (P, len, width) => erHead(P, len, width, "tick", "tick"),
  zeroOrOne: (P, len, width) => erHead(P, len, width, "tick", "ring"),
  oneOrMore: (P, len, width) => erHead(P, len, width, "crow", "tick"),
  zeroOrMore: (P, len, width) => erHead(P, len, width, "crow", "ring"),
};

/**
 * Pure function. A round head of DIAMETER `width` centred one radius behind the
 * tip, so its forward extreme touches the endpoint exactly like a triangle's
 * point does. Filled buries the shaft to the centre; hollow stops it at the far
 * edge (which is also what draws a UML lollipop).
 *
 * @example circleHead((b, a) => [b, a], 12, true).pullback // 6
 * @example circleHead((b, a) => [b, a], 12, false).pullback // 12
 */
function circleHead(P, width, filled) {
  const r = width / 2;
  const [cx, cy] = P(r, 0);
  return { d: ellipsePathD(cx, cy, r, r), filled, pullback: filled ? r : width };
}

/**
 * Pure function. Mermaid's `requirement_contains` glyph: a ring of DIAMETER
 * `width` with a cross through it (⊕). Stroke-only; the shaft stops at the far
 * edge, and the ring's own axial bar carries the line visually through it.
 *
 * @example crossedCircleHead((b, a) => [b, a], 12).pullback // 12
 * @example crossedCircleHead((b, a) => [b, a], 12).filled // false
 */
function crossedCircleHead(P, width) {
  const r = width / 2;
  const [cx, cy] = P(r, 0);
  const bars = openSubpathsPathD([[P(0, 0), P(width, 0)], [P(r, r), P(r, -r)]]);
  return { d: `${ellipsePathD(cx, cy, r, r)} ${bars}`, filled: false, pullback: width };
}

/**
 * Every head-shape id, in Inspector order. DERIVED from the generator table so a
 * glyph cannot exist without appearing in the picker, or appear in the picker
 * without a generator (ledger C-8 — the same relationship core/shapes.js
 * SHAPE_NAMES has to SHAPE_GENERATORS).
 *
 * @example HEAD_SHAPES[0] // "none"
 * @example HEAD_SHAPES.includes("triangle") // true
 * @example HEAD_SHAPES.length // 15
 */
export const HEAD_SHAPES = Object.keys(HEAD_GENERATORS);

/** Human labels for the two head selects (the STROKE_CAP_LABELS convention). */
export const HEAD_SHAPE_LABELS = {
  none: "None", triangle: "Triangle", triangleOpen: "Hollow triangle",
  dart: "Dart", diamond: "Diamond", diamondOpen: "Hollow diamond",
  circle: "Circle", circleOpen: "Hollow circle", cross: "Cross",
  crossedCircle: "Crossed circle", open: "Open V",
  onlyOne: "ER: one", zeroOrOne: "ER: zero or one",
  oneOrMore: "ER: one or more", zeroOrMore: "ER: zero or more",
};

// IMPORT-TIME LABEL GATE (the core/properties.js BLEND_MODE_LABELS precedent,
// same reasoning): with fifteen shapes, one added without a label would show its
// raw camelCase id in the Inspector, and a label left behind by a removed shape
// would sit there forever. Both are silent, so both fail at boot instead.
for (const shape of HEAD_SHAPES)
  if (!(shape in HEAD_SHAPE_LABELS))
    throw new Error(`core/endpoints: head shape "${shape}" has no HEAD_SHAPE_LABELS entry — it would show its raw id in the Inspector`);
for (const label of Object.keys(HEAD_SHAPE_LABELS))
  if (!HEAD_SHAPES.includes(label))
    throw new Error(`core/endpoints: HEAD_SHAPE_LABELS has a stale entry "${label}" — no such head shape (known: ${HEAD_SHAPES.join(", ")})`);

/**
 * Pure function. The head frame's point mapper for one end: (back, across) →
 * world [x, y], where `back` runs from the tip toward `from` and `across` runs
 * along that axis's right normal. Every glyph in HEAD_GENERATORS is written
 * against this, which is why none of them contains a rotation.
 *
 * Args:
 *   tip ({x,y}): where the glyph's point sits (an endpoint)
 *   from ({x,y}): a point BEHIND it on the shaft (defines the axis)
 *
 * Returns:
 *   function: (back, across) → [x, y]
 *
 * @example headFrame({x: 100, y: 0}, {x: 0, y: 0})(14, 6) // [86, 6]
 * @example headFrame({x: 0, y: 100}, {x: 0, y: 0})(14, 6) // [-6, 86]
 */
export function headFrame(tip, from) {
  const dx = tip.x - from.x, dy = tip.y - from.y;
  const axisLen = Math.hypot(dx, dy) || 1; // degenerate (coincident points): the axis is arbitrary and the glyph collapses anyway
  const ux = dx / axisLen, uy = dy / axisLen; // unit axis, from → tip
  return (back, across) => [tip.x - ux * back - uy * across, tip.y - uy * back + ux * across];
}

/**
 * Pure function. A triangular arrowhead's 3 world-space vertices — the ONE head
 * this codebase had before the shape library, kept because it is the shape most
 * callers and tests mean by "a head" and because HEAD_GENERATORS.triangle is
 * literally it.
 *
 * @example headTriangle({x: 100, y: 0}, {x: 0, y: 0}, 14, 12) // [[100, 0], [86, 6], [86, -6]]
 * @example headTriangle({x: 0, y: 100}, {x: 0, y: 0}, 14, 12) // [[0, 100], [-6, 86], [6, 86]]
 */
export function headTriangle(tip, from, len, width) {
  return HEAD_GENERATORS.triangle(headFrame(tip, from), len, width).points;
}

/**
 * Pure function. One end's head drawing, or null when that end has none.
 * THROWS on an unknown shape id — a typo must not silently draw nothing (the
 * core/shapes.js shapePath precedent).
 *
 * Args:
 *   shape (string): a HEAD_SHAPES id
 *   tip ({x,y}): the endpoint the glyph points at
 *   from ({x,y}): a point behind it on the shaft (the axis)
 *   len, width (number): headLength / headWidth
 *
 * Returns:
 *   null | {points, pullback} | {d, filled, pullback} — world coordinates
 *
 * @example headDrawing("none", {x: 0, y: 0}, {x: 1, y: 0}, 14, 12) // null
 * @example headDrawing("triangle", {x: 100, y: 0}, {x: 0, y: 0}, 14, 12).points // [[100, 0], [86, 6], [86, -6]]
 * @example headDrawing("triangleOpen", {x: 100, y: 0}, {x: 0, y: 0}, 14, 12).d // "M100 0 L86 6 L86 -6 Z"
 * @example headDrawing("open", {x: 100, y: 0}, {x: 0, y: 0}, 14, 12).pullback // 0 (the V's vertex IS the tip)
 */
export function headDrawing(shape, tip, from, len, width) {
  const gen = HEAD_GENERATORS[shape];
  if (!gen) throw new Error(`headDrawing: unknown head shape "${shape}" (known: ${HEAD_SHAPES.join(", ")})`);
  return gen(headFrame(tip, from), len, width);
}

/**
 * Pure function. The RETIRED `headMode` enum's four values → the per-end shape
 * pair that means the same picture. Returns null for anything else, which the
 * caller must report LOUDLY rather than guess at (core/document.js
 * withHeadModeSplit) — an equation-valued headMode is the realistic case, and a
 * formula that chose between "start" and "both" has no split.
 *
 * WHY THE SPLIT AT ALL: `headMode` was ONE enum over BOTH ends, so it could name
 * WHICH ends wore a decoration but never WHAT each wore — and "hollow triangle at
 * one end, filled diamond at the other" is what UML and ER notation are made of.
 * A combined enum cannot express that at any size, so it is superseded rather
 * than extended, and it does not survive alongside its replacement: a `headMode`
 * derivable from the pair would be a hand-maintained mirror of it (ledger C-8).
 *
 * @example headModeSplit("end") // {headStart: "none", headEnd: "triangle"}
 * @example headModeSplit("both") // {headStart: "triangle", headEnd: "triangle"}
 * @example headModeSplit("none") // {headStart: "none", headEnd: "none"}
 * @example headModeSplit("start") // {headStart: "triangle", headEnd: "none"}
 * @example headModeSplit("= t > 0.5 ? 'both' : 'end'") // null (an equation has no split)
 */
export function headModeSplit(headMode) {
  const wore = { none: [false, false], start: [true, false], end: [false, true], both: [true, true] }[headMode];
  if (!wore) return null;
  return { headStart: wore[0] ? "triangle" : "none", headEnd: wore[1] ? "triangle" : "none" };
}

/**
 * The four head Inspector rows every head-bearing arrow declares, in one place.
 *
 * WHY THIS EXISTS RATHER THAN THREE COPIES: arrow.js, elbow_arrow.js and
 * curved_arrow.js each carried a verbatim copy of the headLength / headWidth /
 * head rows, and the copies had ALREADY drifted — arrow.js's head help said
 * "just the start (tail)" where its two siblings said "just the start". That is
 * the one-condition-one-voice rule failing in miniature, and the head shape split
 * would have turned three drifting copies into six. The rows live beside the enum
 * they select over, exactly as the defaults live beside the geometry.
 *
 * @example ARROW_HEAD_ROWS.map((r) => r.key) // ["headLength", "headWidth", "headStart", "headEnd"]
 * @example ARROW_HEAD_ROWS[2].options.length // 15
 */
export const ARROW_HEAD_ROWS = [
  { key: "headLength", label: "Head length", kind: "number", min: 0, category: "arrow", help: "How far the arrowhead extends back from the tip along the shaft, in canvas units." },
  { key: "headWidth", label: "Head width", kind: "number", min: 0, category: "arrow", help: "How wide the arrowhead is across its base, in canvas units." },
  { key: "headStart", label: "Start head", kind: "select", options: HEAD_SHAPES, optionLabels: HEAD_SHAPE_LABELS, category: "arrow", help: "The decoration drawn at the START (tail) of this connector. None leaves it bare; the hollow shapes and the ER cardinality marks are drawn in the shaft's own colour and weight." },
  { key: "headEnd", label: "End head", kind: "select", options: HEAD_SHAPES, optionLabels: HEAD_SHAPE_LABELS, category: "arrow", help: "The decoration drawn at the END (tip) of this connector. A filled triangle is the classic arrow; a hollow triangle reads as UML inheritance, a diamond as composition, a dart as a state transition." },
];

/**
 * Pure function. THE seam all three head-bearing arrow plugins call: both ends'
 * head op-arguments plus the distance each end of the shaft must stop short.
 *
 * Returned `ops` are ARGUMENT OBJECTS, not display-list commands — core/ returns
 * `d` strings and paint values and the PLUGIN builds the op, which is the split
 * core/shapes.js ↔ plugins/shape.js established. A caller distinguishes the two
 * kinds by the presence of `d`: `h.d ? path(h) : polygon(h)`.
 *
 * Ops come out END first then START, which is the order the single-triangle code
 * emitted them in, so a two-headed arrow's display list is unchanged.
 *
 * Args:
 *   s (object): evaluated item state (headStart / headEnd / headLength /
 *     headWidth / stroke / strokeWidth / opacity)
 *   endAxis ({tip, from}): the `to` endpoint and a point behind it on the drawn
 *     path — for a curve or a route, the previous sample, so the glyph aims
 *     along the real tangent rather than along the straight chord
 *   startAxis ({tip, from}): the same for the `from` endpoint
 *
 * Returns:
 *   {ops: object[], pullback: {start: number, end: number}}
 *
 * @example arrowHeads({headStart: "none", headEnd: "none"}, {tip: {x: 1, y: 0}, from: {x: 0, y: 0}}, {tip: {x: 0, y: 0}, from: {x: 1, y: 0}}) // {ops: [], pullback: {start: 0, end: 0}}
 * @example arrowHeads({headEnd: "triangle", headLength: 14, headWidth: 12, stroke: "#000000"}, {tip: {x: 100, y: 0}, from: {x: 0, y: 0}}, {tip: {x: 0, y: 0}, from: {x: 100, y: 0}}).pullback // {start: 0, end: 8.4}
 * @example arrowHeads({headEnd: "circleOpen", headLength: 14, headWidth: 12, stroke: "#000000"}, {tip: {x: 100, y: 0}, from: {x: 0, y: 0}}, {tip: {x: 0, y: 0}, from: {x: 100, y: 0}}).ops[0].fill // null
 */
export function arrowHeads(s, endAxis, startAxis) {
  const len = s.headLength ?? ARROW_HEAD_LENGTH, width = s.headWidth ?? ARROW_HEAD_WIDTH;
  const opacity = s.opacity ?? 1;
  // A hollow or open glyph is drawn with the SHAFT's own weight, so a head always
  // reads as part of the line it terminates and needs no knob of its own.
  const strokeWidth = s.strokeWidth ?? ARROW_STROKE_WIDTH;
  const ops = [];
  const pullback = { start: 0, end: 0 };
  for (const [end, axis, shape] of [
    ["end", endAxis, s.headEnd ?? HEAD_END_DEFAULT],
    ["start", startAxis, s.headStart ?? HEAD_START_DEFAULT],
  ]) {
    const drawing = headDrawing(shape, axis.tip, axis.from, len, width);
    if (!drawing) continue;
    pullback[end] = drawing.pullback;
    if (drawing.points) ops.push({ points: drawing.points, fill: s.stroke, opacity });
    else if (drawing.filled) ops.push({ d: drawing.d, fill: s.stroke, opacity });
    else ops.push({ d: drawing.d, fill: null, stroke: s.stroke, strokeWidth, opacity });
  }
  return { ops, pullback };
}
