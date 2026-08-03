/**
 * MATCHED-PIECE TRANSFORMS — the pieces of a morph that should not morph at all.
 *
 * ── THE USER'S QUESTION, WHICH IS WHAT THIS ANSWERS (2026-08-02, verbatim) ────
 *   "Does Mannum have a specific way for Morphing Latex equations? Is there a
 *    special thing for Morphing Latex to Latex that Mannum does?"
 *
 * There is, and it is `TransformMatchingShapes`. The observation behind it: when
 * `√b²` becomes `√a²`, the radical and the `²` did not CHANGE — they MOVED. The
 * general alignment does not know that. It sees ten contours on each side, pairs
 * them by a cost function, and lerps every control point of every one, so a glyph
 * that is byte-identical on both sides still gets resampled, re-wound, re-entered
 * at a new vertex and dragged through a continuum of shapes that are not letters.
 * The eye reads that as the whole equation boiling, when the honest picture is
 * two glyphs sliding sideways and ONE glyph actually changing.
 *
 * Manim's mechanism (research note §1.7): hash each piece's NORMALIZED geometry —
 * centred, scaled to unit height, rounded — and pieces whose hashes collide are
 * the SAME SHAPE somewhere else on the canvas. Those are transformed as rigid
 * bodies; only the leftovers go through shape interpolation.
 *
 * ── WHAT WE DO WITH A MATCH, AND WHY IT IS NOT MANIM'S ANSWER ────────────────
 * Manim FADES its leftovers (`FadeOutToPoint`/`FadeInFromPoint`). We MORPH ours,
 * through the alignment that already exists, and that is a deliberate divergence
 * rather than an omission: this engine's whole premise is that a contour flowing
 * into its counterpart beats a crossfade, and we already have a crossfade mode
 * the author can pick per widget (core/morph_property.js). Fading the leftovers
 * would silently override that choice for part of a widget. Noted as the
 * Manim-faithful alternative; not shipped.
 *
 * ── A MATCH TRAVELS; IT DOES NOT MORPH ───────────────────────────────────────
 * A matched pair is congruent up to translation and scale, so its intermediate is
 * defined WITHOUT reference to the alignment: take the FROM subpath's own
 * geometry and place it by lerping the two placements (centroid and scale). The
 * shape drawn at every alpha is then the from shape, exactly — not a resampled
 * approximation of it that happens to start and end in the right place. That is
 * the property the law test pins (`matched pieces are byte-stable in shape`), and
 * it is strictly stronger than "it looks the same": it means no amount of curve
 * insertion, rotation search or winding reconciliation can touch a matched piece.
 *
 * ── WHY IT ALSO FIXES INK, NOT ONLY MOTION (workstream XX-1) ────────────────
 * Measured, not assumed. The counter-fill the user photographed happens when a
 * contour drifts through another contour's interior mid-morph and the nonzero
 * rule adds their windings. A matched piece travels along a straight line between
 * two placements it genuinely occupies, so it stops sweeping across its
 * neighbours — which removes the overlap that causes the fill, at the source,
 * instead of papering over it with a fill rule. The residual (unmatched pieces
 * that still cross) is what core/morph_align.js's role handling addresses.
 *
 * ── DUPLICATE GLYPHS MUST NOT SWAP ───────────────────────────────────────────
 * `bb` → `bb` hashes both `b`s to the same key, so the key alone cannot say which
 * goes where — and pairing them the wrong way round makes the two letters swap
 * places for no reason, which is exactly the artifact this module exists to
 * remove. Equal keys are therefore resolved by NEAREST DISPLACEMENT, greedily,
 * lowest cost first with a stated index tie-break. See `matchSubpaths`.
 *
 * ── PURITY AND DETERMINISM ───────────────────────────────────────────────────
 * Every function here is pure: no clock, no randomness, no frame-to-frame carry.
 * Every tie-break is stated (lowest index) rather than left to sort stability,
 * because two renderers disagreeing on a tie would draw two different frames for
 * one document — the same law the rest of the engine is written against.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { anchors, centroid, dist } from "./morph_geometry.js";
import { resampleAnchors } from "./morph_align.js";

/**
 * Decimal places the normalized geometry is rounded to before hashing. THREE,
 * matching Manim's `np.round(points, 3)` — and the number is not arbitrary in
 * either place: the coordinates being rounded have already been scaled to a unit
 * extent, so 3 decimals is a thousandth of the glyph's own size. Two glyphs that
 * agree to that precision are the same glyph at a different point size; two that
 * differ are visibly different letters.
 */
const HASH_DECIMALS = 3;

/**
 * Points sampled per subpath for the hash. The hash must be independent of
 * PARAMETERIZATION (curve count, start vertex) and depend only on INK, because
 * the same glyph typeset twice can arrive with different curve counts — so it is
 * computed on a fixed-length resampling rather than on the control points.
 * 24 is comfortably above the ~4-16 curves a glyph contour has.
 */
const HASH_SAMPLES = 24;

/**
 * A subpath whose extent is below this fraction of the payload's own extent is
 * too small for its normalized shape to mean anything — normalizing it would
 * amplify float noise into the hash and collide unrelated specks. Such subpaths
 * are never matched; they go through the ordinary alignment.
 */
const MIN_MATCH_EXTENT_FRACTION = 0.01;

/**
 * Pure function. `-0` normalized to `0`, so the hash of a shape and the hash of
 * its mirror-authored twin cannot differ by a sign bit that prints identically.
 * This is Manim's `+ 0.0` and this codebase's own `core/shapes.js num()` trick,
 * for the same reason in all three places.
 *
 * @example
 * >>> zeroNormalized(-0)
 * 0
 * >>> zeroNormalized(1.5)
 * 1.5
 */
export function zeroNormalized(v) {
  return v === 0 ? 0 : v;
}

/**
 * Pure function. A subpath's PLACEMENT — where it sits and how big it is, as the
 * pair (centre, extent). This is the part a matched piece is allowed to change;
 * everything else about it must not.
 *
 * `centre` is the anchor centroid and `extent` is the greatest anchor distance
 * from that centroid (a radius, not a bounding box, so it is rotation-stable and
 * has no axis to disagree about).
 *
 * @param {object} sp - a Subpath
 * @returns {{centre: number[], extent: number}}
 *
 * @example
 * >>> // A CLOSED square's anchor list repeats its start (5 anchors for 4
 * >>> // corners), so the centroid is weighted toward that corner — this reads
 * >>> // core/morph_geometry.js `centroid` rather than re-deriving one, because a
 * >>> // second definition of "centre" is a second thing to keep in agreement.
 * >>> const sq = {start: [0, 0], closed: true, winding: 1, curves: [
 * ...   [0,0,0,0,1,0], [0,0,0,0,1,1], [0,0,0,0,0,1], [0,0,0,0,0,0]]};
 * >>> placementOf(sq).centre
 * [0.4, 0.4]
 * >>> Math.round(placementOf(sq).extent * 1000) / 1000
 * 0.849
 */
export function placementOf(sp) {
  const centre = centroid(sp);
  let extent = 0;
  for (const p of anchors(sp)) extent = Math.max(extent, dist(centre, p));
  return { centre, extent };
}

/**
 * Pure function. THE NORMALIZED-GEOMETRY HASH — a subpath → a string that is
 * equal for two subpaths drawing the SAME SHAPE at any position and any size,
 * and different otherwise.
 *
 * ── THE DESIGN, STATED HONESTLY RATHER THAN COPIED ───────────────────────────
 * Manim hashes `mobject.points` after centring and setting height to 1. We cannot
 * hash control points: our providers may hand the same glyph over with different
 * curve counts or a different start vertex (a re-typeset equation genuinely
 * does), and control points would call those different shapes. So the hash is
 * computed on INK:
 *
 *   1. RESAMPLE to a fixed HASH_SAMPLES points, so curve count cannot matter.
 *   2. TRANSLATE by the centroid, so position cannot matter.
 *   3. SCALE by the extent, so size cannot matter (this is what makes a
 *      superscript `²` match a full-size `2`).
 *   4. ROUND to HASH_DECIMALS and normalize `-0`, so float noise cannot matter.
 *
 * WHAT IT DELIBERATELY DOES NOT ABSORB: rotation and reflection. Two glyphs that
 * differ by a rotation are different glyphs (`6` and `9`, `b` and `q`), and a
 * hash that collided them would make the engine "recognize" a letter as its
 * rotation and slide it into place upside down. Translation and scale are the
 * only freedoms a text re-flow actually uses.
 *
 * START-VERTEX DEPENDENCE IS REAL AND IS HANDLED BY THE CALLER: the resampling
 * begins at the subpath's own start point, so the same closed contour entered at
 * a different vertex hashes differently. That is a MISSED match (the piece falls
 * through to the ordinary alignment and morphs), never a WRONG one — the failure
 * is safe in the direction that matters, and it is why a miss costs quality
 * rather than correctness.
 *
 * @param {object} sp - a Subpath
 * @returns {string} the shape key
 *
 * @example
 * >>> // `sq` builds a square as four STRAIGHT cubics (handles at the 1/3 and 2/3
 * >>> // points — the line→cubic elevation the payload contract requires):
 * >>> const seg = (p, q) => [p[0]+(q[0]-p[0])/3, p[1]+(q[1]-p[1])/3,
 * ...                        p[0]+2*(q[0]-p[0])/3, p[1]+2*(q[1]-p[1])/3, q[0], q[1]];
 * >>> const sq = (x, y, s) => { const c = [[x,y],[x+s,y],[x+s,y+s],[x,y+s],[x,y]];
 * ...   return {start: [x, y], closed: true, winding: 1,
 * ...           curves: [seg(c[0],c[1]), seg(c[1],c[2]), seg(c[2],c[3]), seg(c[3],c[4])]}; };
 * >>> // the SAME square at a different place and a different size hashes equal:
 * >>> shapeKey(sq(0, 0, 1)) === shapeKey(sq(10, 4, 3))
 * true
 * >>> // a triangle does not collide with it:
 * >>> shapeKey(sq(0, 0, 1)) === shapeKey({start: [0, 0], closed: true, winding: 1,
 * ...   curves: [seg([0,0],[1,0]), seg([1,0],[0,1]), seg([0,1],[0,0])]})
 * false
 */
export function shapeKey(sp) {
  const { centre, extent } = placementOf(sp);
  if (!(extent > 0)) return "dot";
  // EXACTLY HASH_SAMPLES points, by uniform parameter over the whole subpath —
  // `resampleAnchors` is the same resampling the pairing and start-point metrics
  // already use, so "the ink at fixed parameters" means ONE thing in this engine
  // rather than two that could drift apart. Striding a `sampleSubpath` list
  // instead would make the sample COUNT depend on the curve count, which is the
  // very thing this hash must be independent of.
  const pts = resampleAnchors(sp, HASH_SAMPLES);
  const out = pts.map(([x, y]) =>
    `${zeroNormalized(round((x - centre[0]) / extent))},${zeroNormalized(round((y - centre[1]) / extent))}`);
  return `${sp.closed ? "z" : "o"}|${out.join(";")}`;
}

/** Pure helper. Round to HASH_DECIMALS. Named so the constant is read once. */
function round(v) {
  const f = 10 ** HASH_DECIMALS;
  return Math.round(v * f) / f;
}

/**
 * Pure function. THE MATCHING. Two subpath lists → the pairs that are CONGRUENT
 * (same shape up to translation and scale), as `[fromIndex, toIndex]`.
 *
 * ── THE DUPLICATE-GLYPH RULE, WHICH IS THE WHOLE SUBTLETY ────────────────────
 * A key with one candidate on each side is unambiguous. A key with SEVERAL — the
 * two `b`s in `bb`, the three `x`s in a polynomial — is not, and choosing wrongly
 * makes two identical letters trade places, an artifact with no cause the viewer
 * can see. Equal-key candidates are therefore resolved by NEAREST DISPLACEMENT:
 * every (from, to) pair sharing a key is scored by the distance its centre would
 * travel, all candidates are sorted by that distance, and pairs are taken
 * greedily. Ties break to the lowest (fromIndex, toIndex), stated rather than
 * left to sort stability, for the determinism law.
 *
 * Subpaths too small to normalize meaningfully (see MIN_MATCH_EXTENT_FRACTION)
 * are excluded — they fall through to the ordinary alignment.
 *
 * @param {object[]} fromSubpaths - unit-space subpaths
 * @param {object[]} toSubpaths - unit-space subpaths
 * @returns {number[][]} matched `[fi, ti]` pairs, ascending by `fi`
 *
 * @example
 * >>> // `sq` as in shapeKey above — four straight cubics.
 * >>> const seg = (p, q) => [p[0]+(q[0]-p[0])/3, p[1]+(q[1]-p[1])/3,
 * ...                        p[0]+2*(q[0]-p[0])/3, p[1]+2*(q[1]-p[1])/3, q[0], q[1]];
 * >>> const sq = (x, y, s) => { const c = [[x,y],[x+s,y],[x+s,y+s],[x,y+s],[x,y]];
 * ...   return {start: [x, y], closed: true, winding: 1,
 * ...           curves: [seg(c[0],c[1]), seg(c[1],c[2]), seg(c[2],c[3]), seg(c[3],c[4])]}; };
 * >>> // one square on each side, same shape, moved: matched
 * >>> matchSubpaths([sq(0, 0, 0.2)], [sq(0.5, 0, 0.2)])
 * [[0, 0]]
 * >>> // TWO identical squares per side — the duplicate-glyph case. Nearest
 * >>> // displacement wins, so each stays with the copy beside it:
 * >>> matchSubpaths([sq(0, 0, 0.2), sq(0.6, 0, 0.2)], [sq(0.05, 0, 0.2), sq(0.65, 0, 0.2)])
 * [[0, 0], [1, 1]]
 * >>> // and when the TO list is authored in the other order, the match follows
 * >>> // the GEOMETRY rather than the index — the pieces still do not swap places:
 * >>> matchSubpaths([sq(0, 0, 0.2), sq(0.6, 0, 0.2)], [sq(0.65, 0, 0.2), sq(0.05, 0, 0.2)])
 * [[0, 1], [1, 0]]
 */
export function matchSubpaths(fromSubpaths, toSubpaths) {
  const extentOf = (list) => {
    let m = 0;
    for (const sp of list) m = Math.max(m, placementOf(sp).extent);
    return m;
  };
  const floor = Math.max(extentOf(fromSubpaths), extentOf(toSubpaths)) * MIN_MATCH_EXTENT_FRACTION;
  const keyed = (list) => list.map((sp) => {
    const pl = placementOf(sp);
    return pl.extent > floor ? { key: shapeKey(sp), centre: pl.centre } : null;
  });
  const A = keyed(fromSubpaths), B = keyed(toSubpaths);

  const candidates = [];
  for (let fi = 0; fi < A.length; fi++) {
    if (!A[fi]) continue;
    for (let ti = 0; ti < B.length; ti++) {
      if (!B[ti] || B[ti].key !== A[fi].key) continue;
      candidates.push({ fi, ti, travel: dist(A[fi].centre, B[ti].centre) });
    }
  }
  // Deterministic total order: travel, then fromIndex, then toIndex — no two
  // candidates compare equal, so sort stability is never load-bearing.
  candidates.sort((p, q) => (p.travel - q.travel) || (p.fi - q.fi) || (p.ti - q.ti));

  const usedFrom = new Set(), usedTo = new Set(), pairs = [];
  for (const c of candidates) {
    if (usedFrom.has(c.fi) || usedTo.has(c.ti)) continue;
    usedFrom.add(c.fi); usedTo.add(c.ti);
    pairs.push([c.fi, c.ti]);
  }
  return pairs.sort((p, q) => p[0] - q[0]);
}

/**
 * Pure function. A matched piece AT alpha — the FROM subpath's own geometry,
 * placed by lerping the two placements. Translation and uniform scale only, which
 * is exactly the freedom the hash absorbed.
 *
 * THE SHAPE IS THE FROM SHAPE, EXACTLY. Every control point is the from point
 * mapped through one similarity, so the piece cannot resample, cannot re-wind and
 * cannot re-enter itself at a different vertex. That is what "travels rather than
 * morphs" means operationally, and it is what the law test asserts by comparing
 * the piece's own normalized shape key across alphas.
 *
 * @param {object} a - the FROM subpath (unit space)
 * @param {object} b - the TO subpath (unit space, congruent to `a`)
 * @param {number} alpha - transition progress in [0, 1]
 * @returns {object} a Subpath
 *
 * @example
 * >>> const seg = (p, q) => [p[0]+(q[0]-p[0])/3, p[1]+(q[1]-p[1])/3,
 * ...                        p[0]+2*(q[0]-p[0])/3, p[1]+2*(q[1]-p[1])/3, q[0], q[1]];
 * >>> const sq = (x, s) => { const c = [[x,0],[x+s,0],[x+s,s],[x,s],[x,0]];
 * ...   return {start: [x, 0], closed: true, winding: 1,
 * ...           curves: [seg(c[0],c[1]), seg(c[1],c[2]), seg(c[2],c[3]), seg(c[3],c[4])]}; };
 * >>> // halfway between x=0 and x=1 the SAME square sits at x=0.5 (float exact
 * >>> // to within one ulp — the lerp is not associative, so this rounds):
 * >>> travelledSubpath(sq(0, 1), sq(1, 1), 0.5).start.map((v) => Math.round(v * 1e9) / 1e9)
 * [0.5, 0]
 * >>> // and its SHAPE is unchanged at every alpha — that is the whole contract:
 * >>> const A = sq(0, 1), B = sq(1, 1);
 * >>> new Set([0, 0.25, 0.5, 0.75, 1].map((t) => shapeKey(travelledSubpath(A, B, t)))).size
 * 1
 */
export function travelledSubpath(a, b, alpha) {
  const pa = placementOf(a), pb = placementOf(b);
  // A zero-extent FROM piece has no scale to lerp; keeping scale at 1 is the only
  // finite answer and the piece is a dot either way.
  const scale = pa.extent > 0 ? lerp(1, pb.extent / pa.extent, alpha) : 1;
  const cx = lerp(pa.centre[0], pb.centre[0], alpha);
  const cy = lerp(pa.centre[1], pb.centre[1], alpha);
  const map = (x, y) => [cx + (x - pa.centre[0]) * scale, cy + (y - pa.centre[1]) * scale];
  const sp = {
    start: map(a.start[0], a.start[1]),
    curves: a.curves.map((c) => [...map(c[0], c[1]), ...map(c[2], c[3]), ...map(c[4], c[5])]),
    closed: !!a.closed,
    // The traversal is untouched by a positive-scale similarity, so the winding
    // is the from winding by construction rather than by re-derivation.
    winding: a.winding,
  };
  if (b.paint) sp.paint = b.paint;
  else if (a.paint) sp.paint = a.paint;
  return sp;
}

/** Pure helper. Linear interpolation, local for the same no-import-cycle reason
 * core/morph.js keeps its own.
 *
 * @example
 * >>> lerp(0, 10, 0.25)
 * 2.5
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}
