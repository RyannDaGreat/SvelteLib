/**
 * POLYGON — the FREEFORM shape: a VARIABLE-LENGTH vertex list, FILLED when the
 * loop is closed and drawn as an open stroked polyline when it is not. Every
 * vertex is a draggable on-canvas handle, and the whole list is one keyframable
 * leaf, so a polygon's shape TWEENS between slides.
 *
 * ── WHY IT IS NOT A SHAPESHIFTER FAMILY ───────────────────────────────────────
 * plugins/shapeshifter.js covers PARAMETRIC shapes: a fixed handful of numeric
 * knobs generates the outline (points/innerRatio/sweep…). A freeform polygon has
 * no parameters — its DATA *is* the outline, of unbounded length. That is a
 * different state shape (a list, not scalars) and a different handle contract (N
 * handles, not a hand-listed few), so it is its own plugin. Everything else is
 * deliberately the shapeshifter skeleton: one `path` IR op, even-odd containment
 * hit test, standard bbox anchors, registry-injected effects.
 *
 * ── STATE SHAPE, AND WHY THE POINTS ARE LOCAL AND NORMALIZED ──────────────────
 *   points: [[x, y], ...]   fractions of the bbox (0..1 nominal, NOT clamped)
 *   closed: boolean         closes the loop → the shape fills
 *
 * `[x, y]` PAIRS, not `{x, y}` records, for two reasons that both matter:
 *   1. It is THE point-list format everywhere else in this repo — ir.js
 *      polygon/polyline, core/shapes.js polygonPathD, every core/outline.js
 *      generator, shapeshifter's own handle math. One format, no converters.
 *   2. TWEEN CORRECTNESS. core/interpolators.js interpolate() rounds a lerp
 *      between two INTEGERS (the tweenline int rule). Normalized corners are
 *      routinely exactly 0 and 1, so a record list (`{x: 0}` → `{x: 1}`) would
 *      recurse to that integer path and SNAP at alpha 0.5. A list of numeric
 *      PAIRS takes interpolate's pure-numeric-array branch instead — a plain
 *      lerp with no rounding, the branch whose own comment says it exists "so
 *      point/coord lists stay byte-identical". Nested pairs get it per element.
 *
 * LOCAL, not world, because the transform model is a SIMILARITY transform
 * (core/transform.js — x/y/rotation/scale, no skew): a widget's geometry lives
 * in its own frame and the frame is transformed as a unit. World-space points
 * would have to be rewritten on every move/rotate/scale, would break under a
 * parent group's transform, and would make `rotation` meaningless for this one
 * widget. NORMALIZED (rather than local px) because this widget declares
 * `bbox: true` and therefore SHOWS RESIZE HANDLES: fractions make the box
 * actually govern the shape, so a resize stretches the polygon — which is both
 * the PowerPoint freeform behaviour and the invariant every core/outline.js
 * generator already obeys (they are all authored inside the w×h box).
 *
 * Handles then need NO coordinate reasoning of their own: `modifierPoints`
 * returns LOCAL points, core/derive.nodeModifierPoints wraps them through
 * node.world for display, and CanvasView.modifierDrag inverts the drag back
 * through the SAME world before calling `apply` — so rotation and scale are
 * correct BY CONSTRUCTION (see nodeModifierPoints' docstring).
 *
 * ── FILL RULE: EVEN-ODD, deliberately ─────────────────────────────────────────
 * A self-intersecting freeform (draw a 5-point pentagram with five clicks) fills
 * differently under the two rules: nonzero fills the centre solid, even-odd
 * leaves it hollow. Even-odd is chosen because:
 *   - it is WINDING-INDEPENDENT. The user clicks points; they never choose a
 *     direction. Under nonzero, clicking the same star clockwise vs
 *     anticlockwise can change the fill, which is an invisible input.
 *   - it makes THE HIT TEST EXACTLY THE PAINTED REGION. core/outline.js
 *     pointInPolygon is an even-odd ray cast (the test every shapeshifter family
 *     already hit-tests with), so under even-odd "clickable" and "painted" are
 *     the same set. Under nonzero they would disagree inside every self-overlap.
 *
 * ── DEGENERATE CASES, handled honestly (never silently) ───────────────────────
 *   0 or 1 point  — nothing to draw: emit() returns [], `isGhost` reports it, and
 *                   the hit test falls back to the BBOX so the item is still
 *                   selectable (and purgeable) instead of invisible and
 *                   unreachable.
 *   2 points      — a LINE, not a polygon. `closed` cannot fill zero area, so a
 *                   2-point polygon draws as an open stroked segment and its
 *                   path carries no `Z` regardless of the flag (fillsInterior is
 *                   the ONE predicate that decides both).
 *   zero-extent   — a perfectly horizontal chain normalizes to h = 0 with every
 *                   y at 0.5. It still RENDERS (no w/h > 0 guard here, unlike
 *                   shapeshifter): local y = 0.5 · 0 = 0, which is exactly where
 *                   the line is. `apply` cannot recover a fraction from a
 *                   zero-extent axis, so it keeps the existing coordinate rather
 *                   than returning NaN (the lens_flare precedent).
 *   self-crossing — legal, even-odd (above).
 *
 * ── THE VERTEX LIST IS A DECLARED LIST PROPERTY (core/lists.js) ───────────────
 * `points` is declared once, in core/properties.js PROPS.points: a SEQUENCE list
 * of TUPLE elements with fields x/y and the visibility companion `pointsActive`.
 * This module reads that declaration back through `props("points")` (POINTS_LIST
 * below) rather than re-typing it, so the storage form, the order flavour and the
 * companion key cannot drift from what the Inspector renders. Two consequences
 * this widget depends on:
 *
 *   PER-VERTEX VISIBILITY. `pointsActive` is an ALIGNED COMPANION flag list, not a
 *   third tuple slot — absent, short, or non-false all read as VISIBLE, so every
 *   document written before the companion existed renders byte-identically. The
 *   DRAWN shape is `visiblePoints`; the HANDLE set is `normalizedPoints` (all of
 *   them, hidden ones included, so a hidden vertex can be shown again). Hiding is
 *   therefore "draw straight past this corner without losing where it was".
 *
 *   HIDE PRESERVES INDICES; INSERT AND PURGE DO NOT. `points.3.x` still names the
 *   same vertex after any number of vertices are hidden, which is exactly why hide
 *   exists. Inserting or purging a vertex SHIFTS every later vertex's address by
 *   one, so an equation bound to a later vertex comes to mean its neighbour —
 *   core/lists.js indexAfterInsert/indexAfterPurge are the remaps a document-wide
 *   equation rewrite needs, and that rewrite is not built yet. The two operations
 *   are kept visibly distinct at every surface for that reason.
 *
 * ── WHAT IS NOT HERE ──────────────────────────────────────────────────────────
 * The click-click-click CREATION FLOW (unbounded placement, rubber band, Shift
 * constraint, close-by-clicking-the-first-point, Enter/double-click finalize) is
 * DOM work, so it lives in web/polygonDraw.js — the create-phase handler this
 * plugin names in one string (`placement: "polygon_chain"`), registered in
 * web/widget_handlers.js. The three pure functions it needs are exported here —
 * `angleSnappedPoint`, `closeLoopIndex`, `polygonFromWorldPoints` — so that flow
 * is glue, not geometry, and everything it decides is testable from bare node.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { paintModifierPoints } from "../core/paint_handles.js";
import { pointInPolygon, distToSegment, subpathsBBox } from "../core/outline.js";
import { num, polygonPathD, ellipsePoints } from "../core/shapes.js";
import { bundle, defaults, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import { elementActive, visibleElements, visibleIndices, withElementFieldValue, withElementInserted } from "../core/lists.js";
import * as T from "../core/transform.js";
import { path } from "../render_gpu/ir.js";
import { effectsCullMargin } from "../render_gpu/effects.js";

/** Fewest vertices that enclose an area — below this, `closed` cannot fill
 *  anything and the shape is a polyline (2 points) or nothing (0 or 1). */
export const MIN_POLYGON_VERTICES = 3;

/** Fewest vertices that draw at all: one segment needs two ends. */
export const MIN_DRAWN_VERTICES = 2;

/** Vertices in a freshly placed polygon — a regular pentagon, immediately
 *  recognizable as an editable freeform (odd-sided, so it reads as "a shape
 *  whose corners you can drag" rather than a rectangle the box already draws). */
const DEFAULT_SIDES = 5;

/** Decimals kept in the DEFAULT point list. core/shapes.num() truncates path
 *  data to the same precision, so rounding here changes nothing that renders —
 *  it only keeps a freshly created document's serialized default readable
 *  instead of a wall of 0.5000000000000001. */
const DEFAULT_POINT_PRECISION = 3;

/**
 * Evenly-spaced directions a Shift-constrained creation segment may take: 4 =
 * every 90°, an AXIS LOCK.
 *
 * THE RULING (this number was the one open question in the creation flow, and
 * `angleSnappedPoint`'s `divisions` argument spans both readings, so it is one
 * number): the user's words are "I shift to constrain the axis", which is axis-lock
 * vocabulary and names no angle; the OLDER in-house Shift convention agrees twice
 * over (core/snap.axisLock on a body drag, and web/canvas/dragKinds.creationEndpoint
 * on a creation drag of a single free point — the closest existing gesture to a
 * polygon vertex, which reads Shift as "axis-locks the live point to the horizontal
 * or vertical THROUGH THE START"); and 90° needs no new HintBar vocabulary, because
 * DRAG_MODIFIER_HINTS.axisLock ({Shift}, "Axis lock") already exists and is already
 * worded. A 45° reading (PowerPoint's freeform constraint) would have contradicted
 * the user's own word for it AND invented a chip. See web/polygonDraw.js.
 */
export const SHIFT_ANGLE_DIVISIONS = 4;

/** A freeform polygon's default fill — the family green rect/circle do not use,
 *  so a placed polygon is visibly its own widget type. */
const DEFAULT_FILL = "#9ece6a";

/**
 * THE `points` LIST DECLARATION, read back off core/properties.js PROPS.points
 * rather than re-typed here — one declaration, so the element storage form, the
 * order flavour and the visibility companion key (`pointsActive`) cannot drift
 * between the Inspector's list row and this widget's own list operations. It also
 * carries `key`, so a consumer holding only a handle knows which state key to
 * write (see `modifierPoints`).
 */
export const POINTS_LIST = props("points")[0];

/** Pure function. `[x, y]` pair → the `{x, y}` shape core/outline.js's segment
 *  math takes. The ONE adapter between this widget's storage format and that
 *  shared math (kept local: nothing else needs it).
 *  @example xy([3, 4]) // {x: 3, y: 4} */
const xy = ([x, y]) => ({ x, y });

/**
 * Pure function. A state's `points` value in the LIST-VALUE shape core/lists.js
 * operates on: the element list plus its aligned visibility companion. The ONE
 * place this widget assembles the pair, so the list and its companion can never
 * be read out of step.
 *
 * @param {object} state - evaluated item state
 * @returns {{list: number[][], active: (boolean[]|undefined)}}
 *
 * @example pointsValue({points: [[0, 0], [1, 1]]}) // {list: [[0, 0], [1, 1]], active: undefined}
 * @example pointsValue({points: [[0, 0], [1, 1]], pointsActive: [true, false]}) // {list: [[0, 0], [1, 1]], active: [true, false]}
 */
export function pointsValue(state) {
  return { list: normalizedPoints(state), active: state[POINTS_LIST.activeKey] };
}

/**
 * Pure function. A regular `sides`-gon inscribed in the UNIT box, first vertex
 * straight up — the normalized-coordinate default shape. Delegates to
 * core/shapes.ellipsePoints (whose default start angle is already "top up") on
 * a 1×1 box, so the polygon's default is generated by the same generator every
 * other inscribed shape in this repo uses, then rounded for a readable document.
 *
 * @param {number} sides - vertex count (>= MIN_POLYGON_VERTICES)
 * @returns {number[][]} [[x, y], ...] in 0..1 box fractions
 *
 * @example unitRegularPolygon(4) // [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]
 * @example unitRegularPolygon(3) // [[0.5, 0], [0.933, 0.75], [0.067, 0.75]]
 */
export function unitRegularPolygon(sides) {
  if (!(sides >= MIN_POLYGON_VERTICES)) throw new Error(`unitRegularPolygon: need >= ${MIN_POLYGON_VERTICES} sides, got ${sides}`);
  const round = (v) => +v.toFixed(DEFAULT_POINT_PRECISION);
  return ellipsePoints(1, 1, sides).map(([x, y]) => [round(x), round(y)]);
}

/**
 * Pure function. A state's NORMALIZED vertex list. Absent → an empty list (the
 * degenerate "nothing drawn" case, which every consumer here already handles);
 * a document that reaches this without the key has been self-healed by
 * core/document.missingDefaults, which reports every fill loudly.
 *
 * @param {object} state - evaluated item state
 * @returns {number[][]} [[x, y], ...] box fractions
 *
 * @example normalizedPoints({points: [[0, 0], [1, 1]]}) // [[0, 0], [1, 1]]
 * @example normalizedPoints({}) // []
 */
export function normalizedPoints(state) {
  return state.points ?? [];
}

/**
 * Pure function. A state's VISIBLE normalized vertices — the ones the outline is
 * actually drawn through, with hidden ones simply absent so the chain closes
 * straight over them. Delegates the filtering to core/lists.visibleElements (the
 * shared "acts like it's not there" primitive), which returns the stored list BY
 * IDENTITY when nothing is hidden, so the common path allocates nothing.
 *
 * @param {object} state - evaluated item state
 * @returns {number[][]} [[x, y], ...] box fractions, hidden vertices removed
 *
 * @example visiblePoints({points: [[0, 0], [1, 0], [1, 1]]}) // [[0, 0], [1, 0], [1, 1]]
 * @example visiblePoints({points: [[0, 0], [1, 0], [1, 1]], pointsActive: [true, false, true]}) // [[0, 0], [1, 1]]
 */
export function visiblePoints(state) {
  return visibleElements(POINTS_LIST, pointsValue(state));
}

/**
 * Pure function. A state's VISIBLE vertices in LOCAL units: each normalized
 * coordinate scaled by the box extent. THE mapping the renderer, the hit test and
 * the anchors all go through, so none of them can disagree about where the outline
 * is. HANDLES deliberately do NOT come through here — they are drawn for every
 * STORED vertex (`modifierPoints`), hidden ones included, or a hidden vertex could
 * never be shown again.
 *
 * @param {object} state - evaluated item state ({points, pointsActive, w, h})
 * @returns {number[][]} [[x, y], ...] in local units
 *
 * @example localPoints({points: [[0, 0], [1, 0.5]], w: 200, h: 100}) // [[0, 0], [200, 50]]
 * @example localPoints({points: [[0, 0], [1, 0.5]], pointsActive: [true, false], w: 200, h: 100}) // [[0, 0]] (the hidden vertex is not on the outline)
 * @example localPoints({points: [[0.5, 0.5]], w: 0, h: 0}) // [[0, 0]] (zero-extent box: every vertex collapses to the origin)
 */
export function localPoints(state) {
  const w = state.w ?? 0, h = state.h ?? 0;
  return visiblePoints(state).map(([x, y]) => [x * w, y * h]);
}

/**
 * Pure function. Does this polygon FILL? Only a closed loop of at least
 * MIN_POLYGON_VERTICES encloses an area, so this ONE predicate decides both the
 * fill paint and whether the emitted path carries a closing `Z` — a 2-point
 * "closed" polygon can never disagree with itself about being a line.
 * An absent `closed` reads as OPEN (the conservative render); the plugin default
 * ships `closed: true`.
 *
 * Counts VISIBLE vertices, because a hidden vertex is not on the outline: hiding
 * one of three corners leaves two, which enclose no area and therefore draw as a
 * line — the same answer as deleting it, which is the point of hiding.
 *
 * @param {object} state - evaluated item state ({points, pointsActive, closed})
 * @returns {boolean}
 *
 * @example fillsInterior({closed: true, points: [[0, 0], [1, 0], [1, 1]]}) // true
 * @example fillsInterior({closed: false, points: [[0, 0], [1, 0], [1, 1]]}) // false (open polyline)
 * @example fillsInterior({closed: true, points: [[0, 0], [1, 1]]}) // false (2 points enclose no area — a line)
 * @example fillsInterior({closed: true, points: [[0, 0], [1, 0], [1, 1]], pointsActive: [true, false, true]}) // false (only 2 vertices remain visible)
 * @example fillsInterior({points: [[0, 0], [1, 0], [1, 1]]}) // false (absent flag reads as open)
 */
export function fillsInterior(state) {
  return state.closed === true && visiblePoints(state).length >= MIN_POLYGON_VERTICES;
}

/**
 * Pure function. An OPEN SVG path `d` through a vertex chain: M to the first
 * vertex, L to each of the rest, and NO `Z` — the polyline sibling of
 * core/shapes.polygonPathD (which always closes). All M/L, so it round-trips
 * through the raster, SVG and PDF backends identically and carries no `A`.
 *
 * @param {number[][]} points - [[x, y], ...], at least MIN_DRAWN_VERTICES
 * @returns {string} SVG path data
 *
 * @example openPathD([[0, 0], [10, 0], [10, 10]]) // "M0 0 L10 0 L10 10"
 * @example openPathD([[0, 0], [5, 8]]) // "M0 0 L5 8"
 */
export function openPathD(points) {
  if (!Array.isArray(points) || points.length < MIN_DRAWN_VERTICES)
    throw new Error(`openPathD: need >= ${MIN_DRAWN_VERTICES} points, got ${JSON.stringify(points)}`);
  const [first, ...rest] = points;
  return `M${num(first[0])} ${num(first[1])} ` + rest.map(([x, y]) => `L${num(x)} ${num(y)}`).join(" ");
}

/**
 * Pure function. The path `d` for a vertex chain: closed (`… Z`, fillable) or
 * open, chosen by `closed`. Throws below MIN_DRAWN_VERTICES — a caller with
 * nothing to draw must not reach here (emit() returns [] first), matching
 * core/shapes.subpathsPathD's own contract.
 *
 * @param {number[][]} points - [[x, y], ...] in local units
 * @param {boolean} closed - close the loop (only meaningful at >= 3 points)
 * @returns {string} SVG path data
 *
 * @example polygonChainPathD([[0, 0], [10, 0], [5, 8]], true) // "M0 0 L10 0 L5 8 Z"
 * @example polygonChainPathD([[0, 0], [10, 0], [5, 8]], false) // "M0 0 L10 0 L5 8"
 * @example polygonChainPathD([[0, 0], [10, 0]], true) // "M0 0 L10 0" (2 points: a line, never closed)
 */
export function polygonChainPathD(points, closed) {
  return closed && points.length >= MIN_POLYGON_VERTICES ? polygonPathD(points) : openPathD(points);
}

/**
 * Pure function. A vertex list with element `index` replaced — the write a
 * handle drag makes. Returns a NEW list (deltas share arrays as immutable
 * leaves, so mutating one would corrupt the cached slide state that produced
 * it). An out-of-range index throws: a handle whose vertex has vanished is a
 * bug in the caller, not a value to silently drop.
 *
 * @param {number[][]} points - [[x, y], ...]
 * @param {number} index - which vertex to replace
 * @param {number[]} point - the replacement [x, y]
 * @returns {number[][]} a new list
 *
 * @example withPointAt([[0, 0], [1, 0], [1, 1]], 1, [0.5, 0.25]) // [[0, 0], [0.5, 0.25], [1, 1]]
 * @example withPointAt([[0, 0]], 0, [2, 3]) // [[2, 3]]
 */
export function withPointAt(points, index, point) {
  if (!(index >= 0 && index < points.length))
    throw new Error(`withPointAt: index ${index} is outside a ${points.length}-vertex list`);
  return points.map((p, i) => (i === index ? point : p));
}

/**
 * Pure function. Shortest distance from a query point to a vertex chain — the
 * minimum over its segments (plus the closing segment when `closed`). A
 * single-vertex chain has no segment, so the distance is to that vertex; an
 * empty chain has no geometry at all and returns Infinity (never a fake 0).
 *
 * @param {number[][]} points - [[x, y], ...]
 * @param {number} px - query x
 * @param {number} py - query y
 * @param {boolean} closed - include the last→first segment
 * @returns {number} distance, or Infinity for an empty chain
 *
 * @example distToChain([[0, 0], [10, 0]], 5, 4, false) // 4
 * @example distToChain([[0, 0], [10, 0], [10, 10]], 5, 5, false) // 5 (open: 5 from either drawn leg)
 * @example distToChain([[0, 0], [10, 0], [10, 10]], 5, 5, true) // 0 (closed: exactly on the 10,10 → 0,0 edge)
 * @example distToChain([[3, 4]], 0, 0, true) // 5 (a lone vertex has no segment)
 * @example distToChain([], 0, 0, true) // Infinity
 */
export function distToChain(points, px, py, closed) {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(px - points[0][0], py - points[0][1]);
  let best = Infinity;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++)
    best = Math.min(best, distToSegment(px, py, xy(points[i]), xy(points[(i + 1) % points.length])));
  return best;
}

/**
 * Pure function. THE closest-point-on-the-chain walk, reported as the SEGMENT it
 * landed on plus the clamped projection onto it: `{segment, x, y}`, or null for a
 * chain with no segment (0 or 1 vertex). `segment` i is the leg from vertex i to
 * vertex i+1 (the last leg of a closed chain runs from the final vertex back to
 * vertex 0), which is what makes this the substrate for BOTH consumers — the
 * `closest` dynamic anchor wants only the point, and add-vertex wants the leg so
 * it knows WHERE in the sequence the new vertex belongs. One walk, so the anchor
 * and the insertion can never disagree about which leg is nearest.
 *
 * @param {number[][]} points - [[x, y], ...]
 * @param {number} px - query x
 * @param {number} py - query y
 * @param {boolean} closed - include the last→first segment
 * @returns {{segment: number, x: number, y: number}|null}
 *
 * @example closestChainProjection([[0, 0], [10, 0]], 4, 7, false) // {segment: 0, x: 4, y: 0}
 * @example closestChainProjection([[0, 0], [10, 0], [10, 10]], 11, 6, false) // {segment: 1, x: 10, y: 6} (nearest to the SECOND leg)
 * @example closestChainProjection([[0, 0], [10, 0], [10, 10]], -1, 6, true) // {segment: 2, x: 2.5, y: 2.5} (the closing leg back to vertex 0)
 * @example closestChainProjection([[0, 0], [10, 0]], -6, 0, false) // {segment: 0, x: 0, y: 0} (clamped to the segment start)
 * @example closestChainProjection([[3, 4]], 0, 0, false) // null (a lone vertex has no segment)
 * @example closestChainProjection([], 1, 2, false) // null
 */
export function closestChainProjection(points, px, py, closed) {
  if (points.length < MIN_DRAWN_VERTICES) return null;
  let best = null, bestD = Infinity;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * abx + (py - a[1]) * aby) / len2));
    const qx = a[0] + abx * t, qy = a[1] + aby * t;
    const d = Math.hypot(px - qx, py - qy);
    if (d < bestD) { bestD = d; best = { segment: i, x: qx, y: qy }; }
  }
  return best;
}

/**
 * Pure function. The point ON a vertex chain closest to a query point — the
 * `closestAnchor` substrate (the polygon's answer to
 * core/outline.closestPointOnRoundedRect). A thin reading of
 * closestChainProjection: a chain with no segment has no projection, so a lone
 * vertex IS the answer and an empty chain falls back to the caller's `fallback`
 * (the box centre).
 *
 * @param {number[][]} points - [[x, y], ...]
 * @param {number} px - query x
 * @param {number} py - query y
 * @param {boolean} closed - include the last→first segment
 * @param {{x: number, y: number}} fallback - result for an empty chain
 * @returns {{x: number, y: number}}
 *
 * @example closestPointOnChain([[0, 0], [10, 0]], 4, 7, false, {x: 0, y: 0}) // {x: 4, y: 0}
 * @example closestPointOnChain([[0, 0], [10, 0]], -6, 0, false, {x: 0, y: 0}) // {x: 0, y: 0} (clamped to the segment start)
 * @example closestPointOnChain([[3, 4]], 0, 0, false, {x: 9, y: 9}) // {x: 3, y: 4} (a lone vertex IS the closest point)
 * @example closestPointOnChain([], 1, 2, false, {x: 9, y: 9}) // {x: 9, y: 9}
 */
export function closestPointOnChain(points, px, py, closed, fallback) {
  if (points.length === 0) return fallback;
  if (points.length === 1) return { x: points[0][0], y: points[0][1] };
  const p = closestChainProjection(points, px, py, closed);
  return { x: p.x, y: p.y };
}

/**
 * Pure function. THE add-vertex write: the `points` LIST VALUE with one new vertex
 * inserted ON the outline at the point nearest `(lx, ly)` — a LOCAL-space query
 * point, which is what an activation gesture hands over.
 *
 * WHY THE SHAPE DOES NOT JUMP: the new vertex lands exactly on the clamped
 * projection onto the nearest leg, so the outline through it is the outline that
 * was already there. Structure (the splice, the renumbering, the companion flag)
 * goes through core/lists.withElementInserted — which seeds the new element by
 * interpolating its neighbours, i.e. the leg's MIDPOINT — and only the two
 * coordinates are then overwritten with the exact projection, through
 * withElementFieldValue. Nothing about list surgery is re-implemented here.
 *
 * THE INSERT INDEX is the projection's segment + 1: a vertex on the leg from
 * vertex i to i+1 belongs between them, and a `sequence` list's order IS its data,
 * so "between" is the whole specification. The segment indexes the VISIBLE chain
 * (the outline the user clicked), so it is mapped back through `visibleIndices` to
 * land immediately after the earlier visible vertex IN STORAGE. When that leg spans
 * hidden vertices the new one goes BEFORE them, which draws identically (they are
 * not on the outline) and keeps the visible order the user sees.
 *
 * RENUMBERS every later vertex (insert is one of the two renumbering operations —
 * see the module header). A zero-extent axis has no fraction to compute, so the
 * normalized coordinate on that axis is 0.5, matching polygonFromWorldPoints'
 * answer for the same degeneracy.
 *
 * @param {object} state - evaluated item state ({points, pointsActive, w, h, closed})
 * @param {number} lx - query x in LOCAL units
 * @param {number} ly - query y in LOCAL units
 * @returns {{list: number[][], active: (boolean[]|undefined)}|null} the new list value, or null when the chain has no leg to insert on
 *
 * @example withVertexInsertedNear({points: [[0, 0], [1, 0], [1, 1]], closed: false, w: 100, h: 100}, 50, 8)
 * // {list: [[0, 0], [0.5, 0], [1, 0], [1, 1]], active: undefined}
 * @example withVertexInsertedNear({points: [[0, 0], [1, 0], [1, 1]], closed: true, w: 100, h: 100}, 20, 90).list
 * // [[0, 0], [1, 0], [1, 1], [0.55, 0.55]] (the closing leg: the new vertex lands LAST)
 * @example withVertexInsertedNear({points: [[0, 0]], closed: false, w: 100, h: 100}, 5, 5) // null (one vertex has no leg)
 */
export function withVertexInsertedNear(state, lx, ly) {
  const visible = localPoints(state);
  const hit = closestChainProjection(visible, lx, ly, fillsInterior(state));
  if (!hit) return null;
  const value = pointsValue(state);
  // The clicked leg runs between two VISIBLE vertices; the new one belongs after
  // the earlier of the two IN STORAGE. The closing leg of a closed chain (segment
  // === visible.length - 1) runs back to the first vertex, so its insertion goes
  // at the very end rather than after vertex 0.
  const storageOf = visibleIndices(value);
  const index = hit.segment === visible.length - 1 && fillsInterior(state)
    ? value.list.length
    : storageOf[hit.segment] + 1;
  const w = state.w ?? 0, h = state.h ?? 0;
  const inserted = withElementInserted(POINTS_LIST, value, index);
  const nx = w === 0 ? 0.5 : hit.x / w, ny = h === 0 ? 0.5 : hit.y / h;
  const el = withElementFieldValue(
    POINTS_LIST.element,
    withElementFieldValue(POINTS_LIST.element, inserted.list[index], "x", nx),
    "y", ny,
  );
  return { list: withPointAt(inserted.list, index, el), active: inserted.active };
}

/**
 * Pure function. `raw` projected onto the nearest of `divisions` evenly-spaced
 * rays out of `anchor`, preserving its distance — the SHIFT constraint for a
 * creation segment (and for a future Shift-held vertex drag). `divisions` 4 snaps
 * to the pure axes, which is what core/snap.axisLock does and what the creation
 * flow uses (SHIFT_ANGLE_DIVISIONS — see the ruling recorded there); 8 would snap
 * to 45°. A `raw` coincident with `anchor` has no direction, so it is returned
 * unchanged.
 *
 * @param {{x: number, y: number}} anchor - the segment's fixed end (the last placed vertex)
 * @param {{x: number, y: number}} raw - the free end (the live pointer)
 * @param {number} divisions - how many evenly-spaced directions are allowed
 *   (SHIFT_ANGLE_DIVISIONS is what the creation flow passes)
 * @returns {{x: number, y: number}} the constrained free end
 *
 * @example angleSnappedPoint({x: 0, y: 0}, {x: 100, y: 8}, 4) // {x: 100.319..., y: 0} (snapped to due east, length kept)
 * @example angleSnappedPoint({x: 0, y: 0}, {x: 10, y: 9}, 8).x === angleSnappedPoint({x: 0, y: 0}, {x: 10, y: 9}, 8).y // true (8 divisions: snapped to the 45° diagonal)
 * @example angleSnappedPoint({x: 0, y: 0}, {x: 10, y: 9}, 4) // {x: 13.453..., y: 0} (4 divisions = axes only — SHIFT_ANGLE_DIVISIONS)
 * @example angleSnappedPoint({x: 5, y: 5}, {x: 5, y: 5}, 8) // {x: 5, y: 5} (no direction to snap)
 */
export function angleSnappedPoint(anchor, raw, divisions) {
  const dx = raw.x - anchor.x, dy = raw.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: raw.x, y: raw.y };
  const step = (2 * Math.PI) / divisions;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: anchor.x + Math.cos(snapped) * length, y: anchor.y + Math.sin(snapped) * length };
}

/**
 * Pure function. Index of the first vertex within `tolerance` of `probe`, or -1
 * — how the creation flow detects "the user clicked the FIRST point, close the
 * loop" (`closeLoopIndex(placed, pointer, tol) === 0`). Generalized to any
 * vertex so the same call can also answer "did they click an existing vertex"
 * for a future insert/remove gesture.
 *
 * @param {number[][]} points - placed vertices, in WORLD units
 * @param {{x: number, y: number}} probe - the click point, in WORLD units
 * @param {number} tolerance - grab radius in WORLD units (screen px / zoom)
 * @returns {number} vertex index, or -1
 *
 * @example closeLoopIndex([[0, 0], [50, 0], [50, 50]], {x: 3, y: 4}, 6) // 0 (within 6 of the FIRST vertex — close the loop)
 * @example closeLoopIndex([[0, 0], [50, 0]], {x: 25, y: 0}, 6) // -1 (mid-segment, not on a vertex)
 * @example closeLoopIndex([], {x: 0, y: 0}, 6) // -1
 */
export function closeLoopIndex(points, probe, tolerance) {
  for (let i = 0; i < points.length; i++)
    if (Math.hypot(probe.x - points[i][0], probe.y - points[i][1]) <= tolerance) return i;
  return -1;
}

/**
 * Pure function. The polygon item state for a list of WORLD-space vertices —
 * THE constructor the click-click-click creation flow finalizes through. Fits
 * the box to the vertices' AABB and stores each vertex as its fraction of that
 * box, so the result is a normal bbox widget: resizable, rotatable, and with
 * one handle per click.
 *
 * A ZERO-EXTENT axis (every vertex collinear, or a single vertex) has no
 * fraction to compute — 0/0 — so every coordinate on that axis becomes 0.5, the
 * only truthful answer when the points are coincident there. That renders
 * correctly: local = 0.5 · 0 = 0, exactly where the degenerate box's single row
 * or column of pixels is.
 *
 * @param {number[][]} worldPoints - [[x, y], ...] clicked in world units
 * @param {boolean} closed - did the user close the loop
 * @returns {{x: number, y: number, w: number, h: number, points: number[][], closed: boolean}}
 *
 * @example polygonFromWorldPoints([[10, 20], [110, 20], [110, 120]], true)
 * // {x: 10, y: 20, w: 100, h: 100, points: [[0, 0], [1, 0], [1, 1]], closed: true}
 * @example polygonFromWorldPoints([[0, 50], [100, 50]], false)
 * // {x: 0, y: 50, w: 100, h: 0, points: [[0, 0.5], [1, 0.5]], closed: false} (a flat chain: zero height, every y at the midline)
 * @example polygonFromWorldPoints([], false)
 * // {x: 0, y: 0, w: 0, h: 0, points: [], closed: false}
 */
export function polygonFromWorldPoints(worldPoints, closed) {
  const { minX, minY, maxX, maxY } = subpathsBBox([worldPoints]);
  const w = maxX - minX, h = maxY - minY;
  const frac = (v, lo, extent) => (extent === 0 ? 0.5 : (v - lo) / extent);
  return {
    x: minX, y: minY, w, h,
    points: worldPoints.map(([x, y]) => [frac(x, minX, w), frac(y, minY, h)]),
    closed,
  };
}

/**
 * Pure function. The LOCAL rect the polygon's INK occupies: the union of its
 * declared box and its vertex hull, inflated by half the stroke width. The hull
 * matters because a vertex may be dragged OUTSIDE the box (normalized
 * coordinates are not clamped — clamping would make the handles refuse to go
 * where the pointer went), and the box alone would then under-report the drawn
 * extent. This is the polygon's `localBounds` declaration — THE BOUNDS PROTOCOL
 * (core/view.js localBoundsOf), which is the ONE rect culling, rubber-band
 * selection, the copy/export capture rect AND the effect substrate
 * (render_gpu/effects.effectBoundsOf) all read. An under-sized rect would cull a
 * visible polygon at the view edge and CLIP the widget inside its own effect
 * substrate; the halo that spills beyond this ink is `cullMargin`'s separate job.
 *
 * @param {object} state - evaluated item state
 * @returns {{x: number, y: number, w: number, h: number}} local rect
 *
 * @example polygonInkRect({points: [[0, 0], [1, 1]], w: 100, h: 100, strokeWidth: 0}) // {x: 0, y: 0, w: 100, h: 100}
 * @example polygonInkRect({points: [[-0.2, 0], [1, 1]], w: 100, h: 100, strokeWidth: 0}) // {x: -20, y: 0, w: 120, h: 100} (a vertex dragged left of the box)
 * @example polygonInkRect({points: [[0, 0], [1, 0]], w: 100, h: 0, strokeWidth: 4}) // {x: -2, y: -2, w: 104, h: 4} (a flat chain is still a real, strokeable region)
 */
export function polygonInkRect(state) {
  const pad = (state.strokeWidth ?? 0) / 2;
  const hull = subpathsBBox([localPoints(state)]);
  const minX = Math.min(0, hull.minX) - pad, minY = Math.min(0, hull.minY) - pad;
  const maxX = Math.max(state.w ?? 0, hull.maxX) + pad, maxY = Math.max(state.h ?? 0, hull.maxY) + pad;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export const polygonPlugin = {
  type: "polygon",
  title: "Polygon",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // THE CREATION GESTURE, declared exactly like every other widget's (the create
  // phase of web/widget_handlers.js): click each corner, Shift to axis-lock the
  // next one, click the first vertex to close, Enter or double-click to finish.
  // The whole flow is that ONE string — see web/polygonDraw.js.
  placement: "polygon_chain",
  // DOUBLE-CLICK ACTIVATION (the activate phase of web/widget_handlers.js): add a
  // vertex ON the outline where you clicked. One string, and the gesture's local
  // pointer position is already part of the activate context — the geometry is
  // `withVertexInsertedNear` above.
  activate: "insert_point",
  defaults: {
    type: "polygon", x: 140, y: 140, w: 240, h: 240, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    points: unitRegularPolygon(DEFAULT_SIDES),
    closed: true,
    fill: DEFAULT_FILL, stroke: "#000000", strokeWidth: 2,
    ...defaults("opacity"), // opacity:1
    // NO effects fragment: core/registry.withUniversalEffects injects the whole
    // bundle (rows + effect-OFF defaults + the render half in ports.js) at
    // REGISTRATION. Hand-adding it here would make this plugin "self-composing"
    // and switch the injection OFF (composesEffects), which is the drift
    // tests/universal_effects_test.js exists to catch.
  },
  inspector: [
    ...bundle("positioning"),
    // THE VERTEX LIST as a property row — ONE declaration, not N vertex rows:
    // `points` is kind "list" (core/properties.js), so the row IS its list
    // declaration and web/ListField.svelte renders every element from it (x/y
    // NumericFields with per-element `=`, a visibility eye, insert-between, purge).
    // This row could not exist until that control did: before it, a list row fell
    // through the Inspector's catch-all TEXT input, which would have committed a
    // string over the vertex array. The canvas handles still edit the same
    // vertices — same state, two surfaces.
    ...props("points"),
    { key: "closed", label: "Closed", kind: "boolean", category: "formatting", help: "Join the last point back to the first, which encloses an area so the shape can be filled. Off draws an open line through the points with no fill. A two-point shape encloses nothing, so it stays a line either way." },
    ...props("fill", "stroke", "strokeWidth"),
    // THE UNIVERSAL STROKE-TRIM ROWS (Tier C adoption — this widget always HAD
    // render support at the ports seam; it just never declared the rows, which
    // is why a gear with a texture-brush stroke showed no phase/draw-on knobs).
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
  ],
  /**
   * Pure function. Is this a GHOST (no geometry to draw)? Fewer than two VISIBLE
   * vertices is not a shape at all — the svg.js isGhost precedent, so the
   * editor still gives the item an outline and it stays selectable. Counted over
   * the visible set, so hiding every corner leaves a reachable ghost rather than
   * an invisible, unclickable item.
   *
   * @example polygonPlugin.isGhost({points: []}) // true
   * @example polygonPlugin.isGhost({points: [[0, 0], [1, 1]]}) // false
   * @example polygonPlugin.isGhost({points: [[0, 0], [1, 1]], pointsActive: [true, false]}) // true (one visible vertex is not a shape)
   */
  isGhost(state) {
    return visiblePoints(state).length < MIN_DRAWN_VERTICES;
  },
  /**
   * Pure function. State → ONE `path` display-list op in LOCAL coordinates: the
   * vertex chain, filled with fillRule "evenodd" when the loop encloses an area
   * and stroked whenever strokeWidth > 0. Nothing to draw (< 2 vertices) emits
   * nothing. There is deliberately NO `w/h > 0` guard: a zero-extent box is how
   * a perfectly straight chain is stored, and it must still render.
   *
   * The effects wrap is NOT applied here — render_gpu/ports.js owns the render
   * half for a registry-injected plugin (exactly one wrap, ever).
   */
  emit(s) {
    const pts = localPoints(s);
    if (pts.length < MIN_DRAWN_VERTICES) return [];
    const filled = fillsInterior(s);
    return [path({
      d: polygonChainPathD(pts, filled),
      fill: filled ? s.fill : null,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      fillRule: "evenodd",
      opacity: s.opacity ?? 1,
    })];
  },
  // THE BOUNDS PROTOCOL (core/view.js localBoundsOf): the ink rect, not the box —
  // a vertex may be dragged outside the box, and the box alone would under-report
  // the drawn extent. This ONE declaration now answers every bounds consumer:
  // culling, rubber-band selection, the copy/export capture rect, and the effect
  // substrate (render_gpu/effects.effectBoundsOf defaults to it, which is why
  // there is no `effectBounds` hook here any more — it returned this same rect).
  //
  // It REPLACES an inflated cullMargin. That hook used to return
  // effectsCullMargin + the vertex hull's MAX escape, using the halo hook to fake
  // bounds: one number applied to all four sides, so a vertex 40px past the LEFT
  // edge also grew the right, top and bottom by 40. Declaring the rect is tighter
  // (per-side) and keeps the two quantities orthogonal.
  localBounds: polygonInkRect,
  // Effects halo (shadow/bloom spill) only — the halo that reaches BEYOND the ink
  // above, exactly as every other widget declares it (core/view.js
  // effectInclusiveAABB / defaultCanSkip).
  cullMargin: effectsCullMargin,
  /**
   * Pure function. Hit test in LOCAL units. A filled polygon is hit anywhere
   * inside it (even-odd — the SAME rule its fill uses, so clickable == painted)
   * or within a grab band of its outline; an open polyline only by the band.
   * The band is half the stroke width plus `tol` (the caller's screen-space
   * grab tolerance, already divided by the node's scale by core/derive), so a
   * hairline chain stays grabbable at any zoom.
   *
   * Below MIN_DRAWN_VERTICES there is no geometry, so it falls back to the BBOX
   * — a degenerate polygon must stay selectable and purgeable rather than
   * becoming invisible AND unreachable.
   */
  hitTest(s, lx, ly, tol = 0) {
    const pts = localPoints(s);
    if (pts.length < MIN_DRAWN_VERTICES)
      return lx >= 0 && lx <= (s.w ?? 0) && ly >= 0 && ly <= (s.h ?? 0);
    const closed = fillsInterior(s);
    if (closed && pointInPolygon(pts, lx, ly)) return true;
    return distToChain(pts, lx, ly, closed) <= (s.strokeWidth ?? 0) / 2 + tol;
  },
  // The 9 standard bbox anchors. Deliberately NOT one anchor per vertex:
  // anchors are STORED references ("@<itemId>_<anchorId>.x"), so index-keyed
  // vertex anchors would silently REBIND every arrow attached to them the
  // moment a vertex is inserted or removed. Vertices are offered as SNAP
  // features instead (below), which are transient and carry no such hazard.
  anchors: standardBBoxAnchors,
  /** Pure function. Closest point on the polygon's own outline to a WORLD point
   *  (returned in LOCAL coords) — the `closest` dynamic anchor, the polygon's
   *  analogue of rect's closestPointOnRoundedRect. With no vertices there is no
   *  outline, so the box centre is the only defined answer. */
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    const centre = { x: (state.w ?? 0) / 2, y: (state.h ?? 0) / 2 };
    return closestPointOnChain(localPoints(state), local.x, local.y, fillsInterior(state), centre);
  },
  /**
   * Pure function. THE add-vertex hook the "insert_point" activation calls
   * (web/widget_handlers.js): the state key to write plus the new LIST VALUE, or
   * null when there is no outline to insert on. The geometry is
   * `withVertexInsertedNear`; this is the two-line declaration that names WHICH
   * keys the host writes, so the handler stays widget-agnostic.
   *
   * @example polygonPlugin.insertPointAt({points: [[0, 0], [1, 0], [1, 1]], closed: false, w: 100, h: 100}, 50, 8) // {key: "points", activeKey: "pointsActive", value: {list: [[0, 0], [0.5, 0], [1, 0], [1, 1]], active: undefined}}
   * @example polygonPlugin.insertPointAt({points: [[0, 0]], closed: false, w: 100, h: 100}, 5, 5) // null
   */
  insertPointAt(state, localX, localY) {
    const value = withVertexInsertedNear(state, localX, localY);
    return value ? { key: POINTS_LIST.key, activeKey: POINTS_LIST.activeKey, value } : null;
  },
  /** Pure function. Every vertex is a snap POINT (local units), so dragging
   *  another widget aligns to a polygon's corners the way it aligns to a box's.
   *  Index-keyed ids are safe here: a snap feature is consumed within the drag
   *  that produced it and never stored (core/snap.provenanceAnchorId returns
   *  null for a non-standard id, so a vertex snap commits plain numbers). */
  snapFeatures(state) {
    return localPoints(state).map(([x, y], i) => ({ kind: "point", x, y, id: `v${i}` }));
  },
  /**
   * Pure function. ONE draggable handle per STORED vertex — the variable-arity
   * modifier-point set. Each `apply` writes the WHOLE list back (the coarse
   * path core/interpolators.js tweens element-wise and app.commitPreview
   * keyframes as one leaf), with only its own vertex changed.
   *
   * EVERY stored vertex gets a handle, hidden ones included — a hidden vertex
   * that lost its handle could never be shown again, and it is still a real,
   * addressable, draggable element (hide takes it off the OUTLINE, not out of the
   * list). `element` declares WHICH list element the handle is — the LIST
   * DECLARATION itself, by reference, plus the index — so the universal handle
   * actions (hide/show, purge) can operate on it without knowing anything about
   * polygons: they read the storage form, the order flavour and the visibility
   * companion key straight off the one declaration core/properties.js owns, with no
   * lookup that could resolve to a second copy. A handle that is not a list element
   * simply omits it (a donut's inner-radius handle has nothing to hide). `active` is
   * the flag those actions toggle, read through core/lists.elementActive so absent
   * means visible.
   *
   * The handle is placed in LOCAL units and `apply` receives the drag in LOCAL
   * units (CanvasView inverts through node.world first), so this never reasons
   * about rotation or scale. A zero-extent axis cannot yield a fraction, so
   * that coordinate is KEPT rather than returned as NaN (the lens_flare
   * precedent — a technical guard on division, not a bound on any value).
   *
   * @example polygonPlugin.modifierPoints({points: [[0, 0], [1, 1]], w: 100, h: 50}).map((m) => m.id) // ["p0", "p1"]
   * @example polygonPlugin.modifierPoints({points: [[0, 0], [1, 1]], w: 100, h: 50})[1].x // 100
   * @example polygonPlugin.modifierPoints({points: [[0, 0], [1, 1]], w: 100, h: 50})[1].element.index // 1
   * @example polygonPlugin.modifierPoints({points: [[0, 0], [1, 1]], w: 100, h: 50})[1].element.list === POINTS_LIST // true
   * @example polygonPlugin.modifierPoints({points: [[0, 0], [1, 1]], pointsActive: [true, false], w: 100, h: 50}).map((m) => m.active) // [true, false]
   */
  modifierPoints(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const active = s[POINTS_LIST.activeKey];
    const vertexHandles = normalizedPoints(s).map(([nx, ny], i) => ({
      id: `p${i}`,
      x: nx * w, y: ny * h,
      element: { list: POINTS_LIST, index: i },
      active: elementActive(active, i),
      apply(state, localPoint) {
        const pts = normalizedPoints(state);
        const ww = state.w ?? 0, hh = state.h ?? 0;
        return {
          points: withPointAt(pts, i, [
            ww === 0 ? pts[i][0] : localPoint.x / ww,
            hh === 0 ? pts[i][1] : localPoint.y / hh,
          ]),
        };
      },
    }));
    // Plus the gradient FILL beads (core/paint_handles.js) when the fill is a
    // gradient — additive, its ids ("fill-grad-*") never collide with "pN".
    return [...vertexHandles, ...paintModifierPoints(s, "fill")];
  },
  commands: [
    // ONE entry point, and its `run` is UNCHANGED by the click-click-click flow —
    // which is the point of the create-phase registry. Arming the crosshair is what
    // every Add command does; WHAT the armed gesture then is comes from the
    // `placement` declaration above, so the flow changed by declaration and this
    // line did not have to be replaced (and no second command id was added — the
    // command registry throws on a duplicate, and two ids for one action is what
    // the one-owner convention forbids).
    { id: "add-polygon", title: "Add Polygon", icon: "mdi:vector-polygon", run: (app) => app.armCrosshairPlacement(polygonPlugin) },
  ],
};
