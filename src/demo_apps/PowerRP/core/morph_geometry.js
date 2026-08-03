/**
 * MORPH GEOMETRY — the pure cubic-Bézier and subpath primitives the morph
 * engine (core/morph.js) is built out of. DOM-free, bare-node, no imports from
 * anywhere but core/shapes.js's number formatter.
 *
 * This file deliberately holds ONLY mathematically general operations on a
 * single subpath: subdivide a curve, measure it, reverse it, rotate its start,
 * serialize it. Nothing here knows that two shapes are being morphed — that
 * decision layer is core/morph_align.js, and the public API is core/morph.js.
 * The split is the same one core/shapes.js (a `d`-string generator) already
 * makes against plugins/shape.js: general math down here, policy above.
 *
 * ── THE SUBPATH SHAPE (one half of the MorphPaths payload) ────────────────────
 * A Subpath is `{start: [x, y], curves: [[c1x,c1y,c2x,c2y,ex,ey], …], closed,
 * winding, paint?}` — CUBICS ONLY, start point implied, exactly the segment
 * shape `core/svg_paths.js arcToCubics` already returns and `transformPathD`
 * already emits (`C x1 y1 x2 y2 ex ey`). The shared anchor between consecutive
 * curves is stored ONCE (curve i's `e` IS curve i+1's start), unlike ManimCE's
 * flat `[a1,h1,h2,a2]` packing which stores it twice and relies on the two
 * copies staying numerically equal through the lerp. Removing that duplication
 * removes a whole class of bug (the research note's §2.3), and it costs nothing:
 * every operation below reconstructs the four-point tuple on demand via
 * `curveTuple`.
 *
 * ── COORDINATE FRAME ─────────────────────────────────────────────────────────
 * BOX-LOCAL, y-DOWN — frame 3 of core/svg_paths.js's header, the frame every
 * render_gpu/ir.js op uses. Winding is therefore stated IN SCREEN SPACE: a
 * positive shoelace sum in y-down is CLOCKWISE on screen. Manim's y-UP world
 * calls the same sum CCW; copying its docstring without the flip is wrong, so
 * the sense is named once, here, in `shoelaceWinding`, and tested.
 *
 * ── PRECISION ────────────────────────────────────────────────────────────────
 * Nothing here rounds. Rounding happens exactly once, at serialization
 * (`subpathToPathD` → `num`, PATH_DECIMALS), because an alignment that rounded
 * would not round-trip and the endpoint law (alpha 1 draws what `to` draws)
 * would fail by a hair for no reason.
 */

import { num } from "./shapes.js";

/**
 * A curve is DEGENERATE when its four control points all sit within this
 * distance of its start, RELATIVE to the subpath's own extent. Scaling to the
 * shape's own size (rather than an absolute 1e-6) is the same choice
 * core/svg_paths.js's DEGENERATE_EXTENT_FRACTION makes against stroke width:
 * "zero-length" is only meaningful next to something. The research note calls
 * out Manim's three different absolute tolerances (1e-6, 1e-8, 1e-4, the last
 * with its own `# TODO, this is too unsystematic`) as a thing not to inherit.
 */
export const DEGENERATE_FRACTION = 1e-6;

/** Below this absolute extent a subpath is a DOT no matter what it is next to —
 * the floor for the relative test above, so a shape that is entirely a single
 * point (extent 0) does not divide by zero when asked if it is degenerate. */
export const DOT_EXTENT_EPSILON = 1e-12;

/**
 * Pure function. The four control points of curve `i` of a subpath, as
 * [[x0,y0], [x1,y1], [x2,y2], [x3,y3]] — the anchor/handle/handle/anchor tuple
 * ManimCE stores explicitly and we reconstruct, since the start anchor is
 * whatever the previous curve ended at (or the subpath's own `start` for i = 0).
 *
 * @param {object} sp - a Subpath
 * @param {number} i - curve index
 * @returns {number[][]} four [x, y] points
 *
 * @example
 * >>> const sp = {start: [0, 0], curves: [[0, 1, 1, 2, 3, 3], [4, 4, 5, 5, 6, 6]], closed: false};
 * >>> curveTuple(sp, 0)
 * [[0, 0], [0, 1], [1, 2], [3, 3]]
 * >>> curveTuple(sp, 1)  // starts where curve 0 ended
 * [[3, 3], [4, 4], [5, 5], [6, 6]]
 */
export function curveTuple(sp, i) {
  const c = sp.curves[i];
  const p0 = i === 0 ? sp.start : [sp.curves[i - 1][4], sp.curves[i - 1][5]];
  return [[p0[0], p0[1]], [c[0], c[1]], [c[2], c[3]], [c[4], c[5]]];
}

/**
 * Pure function. Every anchor the subpath passes THROUGH, in order: its start
 * followed by each curve's end point. `n` curves → `n + 1` anchors. Handles are
 * excluded on purpose — winding, centroid and the start-point search are all
 * defined over the curve the eye follows, not its control polygon (Manim's
 * `get_direction` makes the same choice, over `get_start_anchors`).
 *
 * @example
 * >>> anchors({start: [0, 0], curves: [[0, 0, 1, 1, 2, 0], [2, 0, 0, 2, 0, 0]], closed: true})
 * [[0, 0], [2, 0], [0, 0]]
 */
export function anchors(sp) {
  const out = [[sp.start[0], sp.start[1]]];
  for (const c of sp.curves) out.push([c[4], c[5]]);
  return out;
}

/**
 * Pure function. Signed shoelace area over the subpath's anchors — POSITIVE is
 * CLOCKWISE on screen, because this frame is y-DOWN (see the module header).
 * Magnitude is the polygonal area of the anchor hull, which is a coarse
 * under-estimate of the true Bézier area but is monotone in it and costs one
 * pass; it is used only for comparing two subpaths, never as a real area.
 *
 * @returns {number} twice the signed polygon area (the factor of 2 is dropped —
 *   only the sign and relative magnitude are ever read)
 *
 * @example
 * >>> // a unit square traced right→down→left→up, i.e. clockwise on screen:
 * >>> signedArea({start: [0, 0], curves: [[0,0,0,0,1,0],[0,0,0,0,1,1],[0,0,0,0,0,1],[0,0,0,0,0,0]], closed: true})
 * 1
 */
export function signedArea(sp) {
  const pts = anchors(sp);
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++)
    sum += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  // A closed subpath's anchor list may not repeat its start; close it explicitly.
  const first = pts[0], last = pts[pts.length - 1];
  sum += last[0] * first[1] - first[0] * last[1];
  return sum / 2;
}

/**
 * Pure function. The subpath's orientation as +1 (clockwise on screen) or -1
 * (counter-clockwise). A subpath with no enclosed area (a straight open stroke,
 * a degenerate dot) has no orientation and reports +1 — it is arbitrary but it
 * must be TOTAL, because the alignment step compares windings unconditionally
 * and a `null` would mean every caller needs a branch.
 *
 * @example
 * >>> const cw = {start: [0, 0], curves: [[0,0,0,0,1,0],[0,0,0,0,1,1],[0,0,0,0,0,1],[0,0,0,0,0,0]], closed: true};
 * >>> shoelaceWinding(cw)   // y-down: right, down, left, up = clockwise on screen
 * 1
 * >>> shoelaceWinding(reverseSubpath(cw))
 * -1
 */
export function shoelaceWinding(sp) {
  return signedArea(sp) < 0 ? -1 : 1;
}

/**
 * Pure function. The subpath's anchor centroid — the point an empty counterpart
 * blossoms from (research note §3.5: "grow from the target's own centroid, not
 * from the origin").
 *
 * @example
 * >>> centroid({start: [0, 0], curves: [[0,0,0,0,4,0],[0,0,0,0,4,4],[0,0,0,0,0,4]], closed: true})
 * [2, 2]
 */
export function centroid(sp) {
  const pts = anchors(sp);
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}

/**
 * Pure function. The straight-line distance between two [x, y] points.
 *
 * @example
 * >>> dist([0, 0], [3, 4])
 * 5
 */
export function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * Pure function. Approximate arc length of ONE cubic, by evaluating the curve at
 * `samples + 1` uniform parameters and summing the chords.
 *
 * WHY NOT THE CHORD PROXY: ManimGL scores a curve by `|p2 - p0|`, its control
 * polygon's span. The research note (§3.3.3) says to do better here, and the
 * reason is that our single most common curve IS the KAPPA quarter-arc every
 * `ellipsePathD` is built from — a case where the chord badly under-measures the
 * arc, so a circle would be starved of insertions relative to a straight edge of
 * the same span. Eight samples is enough for a monotone ranking (that is all the
 * greedy insertion loop reads it for) and costs 8 evaluations on ≤ ~64 curves.
 *
 * @example
 * >>> // a "curve" that is really a straight line from (0,0) to (9,0):
 * >>> curveLength([[0, 0], [3, 0], [6, 0], [9, 0]])
 * 9
 * >>> curveLength([[0, 0], [0, 0], [0, 0], [0, 0]])  // degenerate: no length
 * 0
 */
export function curveLength(tuple, samples = ARC_LENGTH_SAMPLES) {
  let total = 0, prev = tuple[0];
  for (let i = 1; i <= samples; i++) {
    const p = evalCubic(tuple, i / samples);
    total += dist(prev, p);
    prev = p;
  }
  return total;
}

/** Chord samples per curve for `curveLength`. Eight is enough to rank curves by
 * length (its only consumer), and a quarter-circle's 8-chord estimate is within
 * ~0.02% of its true arc length. */
const ARC_LENGTH_SAMPLES = 8;

/**
 * Pure function. de Casteljau evaluation of a cubic at parameter t.
 *
 * @param {number[][]} tuple - [[x0,y0], [x1,y1], [x2,y2], [x3,y3]]
 * @param {number} t - in [0, 1]
 * @returns {number[]} the [x, y] point on the curve
 *
 * @example
 * >>> evalCubic([[0, 0], [0, 0], [10, 0], [10, 0]], 0.5)
 * [5, 0]
 * >>> evalCubic([[0, 0], [1, 1], [2, 2], [3, 3]], 0)
 * [0, 0]
 * >>> evalCubic([[0, 0], [1, 1], [2, 2], [3, 3]], 1)
 * [3, 3]
 */
export function evalCubic(tuple, t) {
  const u = 1 - t;
  const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
  return [
    b0 * tuple[0][0] + b1 * tuple[1][0] + b2 * tuple[2][0] + b3 * tuple[3][0],
    b0 * tuple[0][1] + b1 * tuple[1][1] + b2 * tuple[2][1] + b3 * tuple[3][1],
  ];
}

/**
 * Pure function. The sub-curve of a cubic over the parameter interval [a, b],
 * as its own cubic — EXACT, not an approximation. This is Manim's
 * `partial_bezier_points`, ported as the explicit 4×4 matrix from the research
 * note §1.3 rather than as its cached `SUBDIVISION_MATRICES` (which is that
 * matrix precomputed; the matrix IS the semantics, the cache is the speed).
 *
 * The two border guards are Manim's and matter: at `a === 1` every returned
 * point collapses to p3 and at `b === 0` to p0, which is exactly how a
 * subdivision at a degenerate interval produces the NULL curves the alignment
 * step wants, instead of dividing by zero.
 *
 * @param {number[][]} tuple - the source cubic's four control points
 * @param {number} a - interval start in [0, 1]
 * @param {number} b - interval end in [0, 1]
 * @returns {number[][]} four control points of the sub-curve
 *
 * @example
 * >>> // the first half of a straight line 0→10 is a straight line 0→5:
 * >>> partialCubic([[0, 0], [10 / 3, 0], [20 / 3, 0], [10, 0]], 0, 0.5).map(p => [Math.round(p[0] * 1e6) / 1e6, p[1]])
 * [[0, 0], [1.666667, 0], [3.333333, 0], [5, 0]]
 * >>> partialCubic([[0, 0], [1, 1], [2, 2], [3, 3]], 1, 1)  // a === 1 → collapses to the end
 * [[3, 3], [3, 3], [3, 3], [3, 3]]
 */
export function partialCubic(tuple, a, b) {
  if (a >= 1) return [tuple[3], tuple[3], tuple[3], tuple[3]].map((p) => [p[0], p[1]]);
  if (b <= 0) return [tuple[0], tuple[0], tuple[0], tuple[0]].map((p) => [p[0], p[1]]);
  const ua = 1 - a, ub = 1 - b;
  const rows = [
    [ua * ua * ua, 3 * ua * ua * a, 3 * ua * a * a, a * a * a],
    [ua * ua * ub, 2 * ua * a * ub + ua * ua * b, a * a * ub + 2 * ua * a * b, a * a * b],
    [ua * ub * ub, a * ub * ub + 2 * ua * ub * b, 2 * a * ub * b + ua * b * b, a * b * b],
    [ub * ub * ub, 3 * ub * ub * b, 3 * ub * b * b, b * b * b],
  ];
  return rows.map((r) => [
    r[0] * tuple[0][0] + r[1] * tuple[1][0] + r[2] * tuple[2][0] + r[3] * tuple[3][0],
    r[0] * tuple[0][1] + r[1] * tuple[1][1] + r[2] * tuple[2][1] + r[3] * tuple[3][1],
  ]);
}

/**
 * Pure function. Splits one cubic into `n` consecutive sub-curves at uniform
 * parameter values t = i/n — visually INERT (the union of the pieces draws the
 * same ink as the original).
 *
 * UNIFORM `t`, NOT UNIFORM ARC LENGTH, and this is a deliberate v1 choice the
 * research note (§3.3.5) recommends: arc-length-uniform splitting is available
 * (bisect on the length estimate above) and distributes intermediate points
 * better, but uniform `t` is what Manim does, is exactly reversible, and the
 * seam is here — replacing the `i / n` below with a length-solved parameter
 * changes nothing outside this function.
 *
 * @returns {number[][][]} `n` control-point tuples, in order
 *
 * @example
 * >>> subdivideCubic([[0, 0], [1, 0], [2, 0], [3, 0]], 1).length
 * 1
 * >>> const halves = subdivideCubic([[0, 0], [1, 0], [2, 0], [3, 0]], 2);
 * >>> [halves.length, halves[0][3], halves[1][0]]  // the pieces meet
 * [2, [1.5, 0], [1.5, 0]]
 */
export function subdivideCubic(tuple, n) {
  if (n <= 1) return [tuple.map((p) => [p[0], p[1]])];
  const out = [];
  for (let i = 0; i < n; i++) out.push(partialCubic(tuple, i / n, (i + 1) / n));
  return out;
}

/**
 * Pure function. Rebuilds a Subpath from its four-point tuples, dropping each
 * tuple's start anchor (it is the previous tuple's end) — the inverse of
 * mapping `curveTuple` over a subpath. Flags ride along unchanged.
 *
 * @param {number[][][]} tuples - consecutive cubics; each tuple[0] must equal
 *   the previous tuple[3] (they do, by construction, everywhere this is called)
 * @param {object} like - a Subpath whose `closed`/`paint` are copied
 * @returns {object} a Subpath (with `winding` RE-DERIVED, since a rebuild may
 *   have reversed or rotated the geometry)
 *
 * @example
 * >>> subpathFromTuples([[[0, 0], [1, 0], [2, 0], [3, 0]]], {closed: false})
 * {start: [0, 0], curves: [[1, 0, 2, 0, 3, 0]], closed: false, winding: 1}
 */
export function subpathFromTuples(tuples, like) {
  const sp = {
    start: [tuples[0][0][0], tuples[0][0][1]],
    curves: tuples.map((t) => [t[1][0], t[1][1], t[2][0], t[2][1], t[3][0], t[3][1]]),
    closed: !!like.closed,
  };
  sp.winding = shoelaceWinding(sp);
  if (like.paint) sp.paint = like.paint;
  return sp;
}

/**
 * Pure function. The subpath traversed backwards — the same ink, the opposite
 * winding. Each curve's two handles swap (c1 ↔ c2) and the curve order reverses;
 * the new start is the old last end point. This is the reconciliation Manim
 * declines to run inside its alignment (research note §1.5: "Morph a CW-wound
 * circle into a CCW-wound circle and every point takes the long way around; the
 * shape crumples through the middle").
 *
 * @example
 * >>> const sp = {start: [0, 0], curves: [[1, 0, 2, 0, 3, 0]], closed: false, winding: 1};
 * >>> reverseSubpath(sp)
 * {start: [3, 0], curves: [[2, 0, 1, 0, 0, 0]], closed: false, winding: 1}
 * >>> reverseSubpath(reverseSubpath(sp)).curves  // an involution
 * [[1, 0, 2, 0, 3, 0]]
 */
export function reverseSubpath(sp) {
  const tuples = sp.curves.map((_, i) => curveTuple(sp, i));
  const flipped = tuples.reverse().map((t) => [t[3], t[2], t[1], t[0]]);
  if (!flipped.length) return { ...sp, start: [sp.start[0], sp.start[1]], curves: [] };
  return subpathFromTuples(flipped, sp);
}

/**
 * Pure function. A CLOSED subpath re-cut so it begins at curve index `k` — the
 * same closed loop, entered at a different vertex. This is the operation Manim
 * has no analogue of at all, and whose absence causes its most visible artifact:
 * two identically-shaped squares whose `d` strings start at different corners
 * lerp with a constant angular offset, so the square visibly spins 90° while
 * morphing into itself (research note §1.5, §3.3.1).
 *
 * The subpath must be closed (its last curve must end where `start` begins) —
 * rotating an OPEN subpath would move its two free ends, which changes the ink.
 * Callers check `closed`; this asserts it rather than silently producing a
 * different shape.
 *
 * @example
 * >>> const square = {start: [0, 0], closed: true, winding: 1, curves: [
 * ...   [0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 1, 1], [0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0]]};
 * >>> rotateClosedSubpath(square, 1).start   // now entered at the second corner
 * [1, 0]
 * >>> rotateClosedSubpath(square, 0) === square  // a no-op returns the input
 * true
 */
export function rotateClosedSubpath(sp, k) {
  if (k === 0) return sp;
  if (!sp.closed) throw new Error("rotateClosedSubpath: refusing to rotate an OPEN subpath (it would move its free ends and change the ink)");
  const n = sp.curves.length;
  const shift = ((k % n) + n) % n;
  const tuples = [];
  for (let i = 0; i < n; i++) tuples.push(curveTuple(sp, (i + shift) % n));
  // The loop is closed, so tuple i's start anchor equals tuple i-1's end for
  // every i INCLUDING the wrap — except for float drift in the source data, which
  // we heal by snapping each start to the previous end (the shape is unchanged;
  // only the redundant copy of the shared anchor is).
  for (let i = 1; i < tuples.length; i++) tuples[i][0] = tuples[i - 1][3];
  return subpathFromTuples(tuples, sp);
}

/**
 * Pure function. The subpath's greatest anchor distance from its own start — the
 * "is this a dot?" measure, the same quantity core/svg_paths.js's
 * `subpathExtent` computes for the degenerate-cap split.
 *
 * @example
 * >>> subpathExtentFromStart({start: [0, 0], curves: [[0, 0, 0, 0, 3, 4]], closed: false})
 * 5
 * >>> subpathExtentFromStart({start: [7, 7], curves: [[7, 7, 7, 7, 7, 7]], closed: false})
 * 0
 */
export function subpathExtentFromStart(sp) {
  let max = 0;
  for (const p of anchors(sp)) max = Math.max(max, dist(sp.start, p));
  return max;
}

/**
 * Pure function. True when the subpath paints nothing — it has no curves, or
 * every control point sits on its start within `DEGENERATE_FRACTION` of the
 * reference extent. A degenerate subpath is what padding is MADE of, so this is
 * the predicate that keeps padding from being subdivided (the ManimGL
 * zero-score guard, research note §1.3).
 *
 * @param {object} sp - a Subpath
 * @param {number} reference - the extent to measure against (the whole payload's
 *   diagonal, so "zero-length" means zero relative to the SHAPE, not to 1.0)
 *
 * @example
 * >>> isDegenerateSubpath({start: [5, 5], curves: [[5, 5, 5, 5, 5, 5]], closed: false}, 100)
 * true
 * >>> isDegenerateSubpath({start: [0, 0], curves: [[0, 0, 1, 1, 2, 2]], closed: false}, 100)
 * false
 * >>> isDegenerateSubpath({start: [0, 0], curves: [], closed: false}, 100)
 * true
 */
export function isDegenerateSubpath(sp, reference) {
  if (!sp.curves.length) return true;
  const tol = Math.max(reference, DOT_EXTENT_EPSILON) * DEGENERATE_FRACTION;
  for (const c of sp.curves) {
    if (dist(sp.start, [c[0], c[1]]) > tol) return false;
    if (dist(sp.start, [c[2], c[3]]) > tol) return false;
    if (dist(sp.start, [c[4], c[5]]) > tol) return false;
  }
  return true;
}

/**
 * Pure function. True when one CURVE has no length — all four control points
 * coincide within tolerance. Scored 0 by the insertion loop so padding is never
 * chosen for subdivision.
 *
 * @example
 * >>> isDegenerateCurve([[1, 1], [1, 1], [1, 1], [1, 1]], 10)
 * true
 * >>> isDegenerateCurve([[0, 0], [0, 0], [0, 0], [5, 0]], 10)
 * false
 */
export function isDegenerateCurve(tuple, reference) {
  const tol = Math.max(reference, DOT_EXTENT_EPSILON) * DEGENERATE_FRACTION;
  return dist(tuple[0], tuple[1]) <= tol && dist(tuple[0], tuple[2]) <= tol && dist(tuple[0], tuple[3]) <= tol;
}

/**
 * Pure function. A subpath of `n` zero-length curves all sitting on one point —
 * the padding a missing subpath becomes. It paints nothing, but it occupies `n`
 * slots, which is the entire trick that lets two shapes with different subpath
 * counts be lerped (research note §1.2's `np.tile(…, (nppcc, 1))`).
 *
 * @example
 * >>> dotSubpath([4, 5], 2, {closed: true})
 * {start: [4, 5], curves: [[4, 5, 4, 5, 4, 5], [4, 5, 4, 5, 4, 5]], closed: true, winding: 1}
 */
export function dotSubpath(point, n, like = {}) {
  const [x, y] = point;
  const sp = {
    start: [x, y],
    curves: Array.from({ length: Math.max(1, n) }, () => [x, y, x, y, x, y]),
    closed: !!like.closed,
    winding: 1,
  };
  if (like.paint) sp.paint = like.paint;
  return sp;
}

/**
 * Pure function. `sp` traced FORWARD then immediately BACK to its start — a
 * zero-area "there and back" ribbon that paints no fill but rides the existing
 * outline. This is ManimGL's padding (research note §1.5, §3.5), and it beats
 * ManimCE's dot-at-the-last-point: a hole that is about to appear emerges FROM
 * the contour it will live inside rather than shooting out of a single point.
 *
 * The result has 2n curves for an n-curve input, so a caller pads to a target
 * count by trimming/inserting afterwards; `traceAndReturn` is about WHERE the
 * padding sits, not how long it is.
 *
 * @example
 * >>> const t = traceAndReturn({start: [0, 0], curves: [[1, 0, 2, 0, 3, 0]], closed: true, winding: 1});
 * >>> [t.curves.length, t.start, t.curves[t.curves.length - 1].slice(4)]
 * [2, [0, 0], [0, 0]]
 */
export function traceAndReturn(sp) {
  const back = reverseSubpath(sp);
  const tuples = [
    ...sp.curves.map((_, i) => curveTuple(sp, i)),
    ...back.curves.map((_, i) => curveTuple(back, i)),
  ];
  for (let i = 1; i < tuples.length; i++) tuples[i][0] = tuples[i - 1][3];
  return subpathFromTuples(tuples, sp);
}

/**
 * Pure function. A Subpath → an SVG path `d` string: one `M`, one `C` per curve,
 * and a trailing `Z` when closed. Rounds to PATH_DECIMALS exactly once, here —
 * see the module header's precision note.
 *
 * @example
 * >>> subpathToPathD({start: [0, 0], curves: [[1, 2, 3, 4, 5, 6]], closed: false})
 * 'M0 0C1 2 3 4 5 6'
 * >>> subpathToPathD({start: [0, 0], curves: [[1, 2, 3, 4, 5, 6]], closed: true})
 * 'M0 0C1 2 3 4 5 6Z'
 */
export function subpathToPathD(sp) {
  let d = `M${num(sp.start[0])} ${num(sp.start[1])}`;
  for (const c of sp.curves)
    d += `C${num(c[0])} ${num(c[1])} ${num(c[2])} ${num(c[3])} ${num(c[4])} ${num(c[5])}`;
  return sp.closed ? d + "Z" : d;
}

/**
 * Pure function. `samples` points spread along the subpath at uniform parameter
 * per curve — the ink the subpath actually draws, as a point list. This exists
 * for the ENDPOINT LAW: alignment is allowed to change a subpath's
 * parameterization (insert curves, rotate the start, reverse it) but is NOT
 * allowed to change what it DRAWS, and comparing sampled ink is how a test says
 * that. Not used by the morph itself.
 *
 * @param {object} sp - a Subpath
 * @param {number} samples - points per curve (the endpoints of each curve are
 *   included, so an n-curve subpath yields n*samples + 1 points)
 *
 * @example
 * >>> sampleSubpath({start: [0, 0], curves: [[0, 0, 10, 0, 10, 0]], closed: false}, 2)
 * [[0, 0], [5, 0], [10, 0]]
 */
export function sampleSubpath(sp, samples = 16) {
  const out = [[sp.start[0], sp.start[1]]];
  for (let i = 0; i < sp.curves.length; i++) {
    const t = curveTuple(sp, i);
    for (let s = 1; s <= samples; s++) out.push(evalCubic(t, s / samples));
  }
  return out;
}
