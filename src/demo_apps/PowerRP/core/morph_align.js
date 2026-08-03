/**
 * MORPH ALIGNMENT — the preprocessing that makes two outlines lerpable.
 *
 * The lerp itself is one line (core/morph.js). EVERYTHING interesting is here:
 * given two MorphPaths payloads that describe different shapes with different
 * subpath counts, different curve counts, different orientations and different
 * starting vertices, produce two payloads that have the SAME STRUCTURE
 * slot-for-slot while DRAWING EXACTLY WHAT THEY DREW BEFORE. That last clause is
 * the law the whole module is written against, and tests/morph_test.js pins it
 * by sampling ink before and after (`alignmentPreservesInk`).
 *
 * The algorithm is Manim's, ported per refs/manim_morph_research.md: ManimCE's
 * STRUCTURE (cubic, subdivide-to-equalize, insert null curves for missing
 * subpaths) with ManimGL's POLICIES (length-weighted greedy insertion with
 * degenerate curves scored 0, size-sorted subpaths, trace-and-return padding).
 *
 * ── WHERE WE BEAT MANIM (deliberate divergences, §3.4 of the research note) ───
 * Each of these fixes a NAMED weakness, not a stylistic preference:
 *
 *   1. WINDING RECONCILIATION. Manim's alignment is winding-blind — its
 *      `force_direction` exists but the morph never calls it. Morph a clockwise
 *      circle into a counter-clockwise one there and every point takes the long
 *      way round; the shape crumples through its own middle at alpha 0.5. We
 *      reverse the `to` subpath when the pair disagrees (`reverseSubpath` — the
 *      ink is identical, only the traversal flips), so paired points travel
 *      together.
 *
 *   2. CYCLIC START-POINT SEARCH. Manim does not address this AT ALL, and the
 *      research note calls it "the single most visible artifact in Manim
 *      morphs": two identical squares whose `d` strings begin at different
 *      corners lerp with a constant angular offset, so the square appears to
 *      SPIN 90° while morphing into itself. For closed pairs we search every
 *      cyclic rotation of the `to` subpath and take the one minimizing travel.
 *
 *   3. STRUCTURE-AWARE FAST-OUT. Manim skips alignment entirely when the two
 *      point COUNTS are equal — a real latent bug, because two shapes can share
 *      a point count and have completely different subpath structure, and it
 *      then lerps mismatched subpaths together. Our fast-out compares the full
 *      structural signature (subpath count, per-subpath curve counts, closed
 *      flags, windings), never a raw total.
 *
 *   4. SCORE-BASED SUBPATH PAIRING instead of ManimCE's authoring-order index
 *      pairing, which makes the result depend on the order the `d` string
 *      happened to be written in — arbitrary across an icon set. We keep
 *      ManimGL's descending-size ORDER as the prior (outer contour ↔ outer
 *      contour is right far more often than not) and pair greedily under a cost
 *      that also reads centroid, size agreement, winding and closedness.
 *
 * ── THE START-POINT METRIC (stated, because the note says to pick one) ───────
 * SUM OF SQUARED ANCHOR DISTANCES between the two subpaths' anchor lists, after
 * resampling both to the same anchor count. Squared rather than absolute because
 * it penalizes ONE badly-placed anchor more than several slightly-off ones,
 * which is exactly the "half the shape took the long way round" failure this
 * search exists to prevent; and because it needs no square root, so the search
 * over n rotations × n anchors is n² cheap multiplies on n ≤ ~64.
 * The metric is computed on the PRE-PADDED lists (research note §3.3.1) so the
 * search space stays small, and ties break to the LOWEST rotation index —
 * stated, not left to a sort's stability, because two renderers disagreeing on a
 * tie would produce two different frames for the same document.
 *
 * ── THE OPEN ↔ CLOSED POLICY (stated, because the note says to pick one) ─────
 * DISCRETE, resolved at alpha > 0 to the TARGET's flag. Rationale, which is the
 * codebase's own and not an invention: core/interpolators.js already rules that
 * unlike-SHAPED values snap "as soon as alpha > 0", and `closed` is exactly such
 * a value — a boolean whose two states are not on a continuum. There is no such
 * thing as a half-`Z`: in SVG a `Z` does not merely place a line back to the
 * start, it JOINS the stroke there, and a stroke join cannot appear gradually.
 * The geometry still morphs continuously; only the flag steps. So an open arc
 * becoming a closed ring looks like the arc's ends travelling toward each other
 * with the seam painted from the first frame, which is the honest reading —
 * strictly better than the alternative (step at alpha 1) where the join pops
 * into existence on the final frame.
 *
 * ── GEOMETRY LAW (asserted, not handled) ─────────────────────────────────────
 * Payloads arrive ALREADY unsignedState-normalized: `space.w`/`space.h` are
 * non-negative, because a flipped widget must hand over the same geometry an
 * unflipped one would. This engine does NOT resolve negative extents — that is
 * the job of core/geometry.js `normalizedBox` / `unsignedState`, at the ONE map
 * with two entrances the NEGATIVE EXTENTS protocol names. `assertMorphPaths`
 * refuses a negative space LOUDLY rather than quietly morphing a flipped shape
 * against an unflipped one and sending every point across the box. That exact
 * bug lived in core/expressions.js until 0570dff; it is not hypothetical.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import {
  anchors,
  centroid,
  curveLength,
  curveTuple,
  dist,
  dotSubpath,
  isDegenerateCurve,
  isDegenerateSubpath,
  reverseSubpath,
  rotateClosedSubpath,
  shoelaceWinding,
  subdivideCubic,
  subpathFromTuples,
  traceAndReturn,
} from "./morph_geometry.js";

/**
 * Pairing cost weights. Each term is already scale-free (coordinates are
 * normalized to a unit box before scoring, sizes are compared as a log ratio),
 * so these are pure relative priorities and not unit conversions.
 *
 * WINDING and CLOSED are penalties rather than weights on a continuous quantity:
 * they express "a hole should pair with a hole, and an open stroke with an open
 * stroke, unless the geometry disagrees LOUDLY". Both are set below the maximum
 * a centroid term can reach (√2 across a unit box) on purpose — a mismatched
 * winding is a strong hint, never a veto, because a legitimate morph often does
 * turn a hole into a solid.
 */
const PAIR_WEIGHTS = { centroid: 1.0, size: 0.5, area: 0.5, winding: 0.35, closed: 0.25 };

/** Anchor samples used when comparing two subpaths for the start-point search
 * and for pairing. Both sides are resampled to this many anchors so the metric
 * is defined between subpaths of different curve counts. 32 is comfortably above
 * the ~4-16 curves a glyph or icon contour actually has, so the resampling
 * rarely loses a real vertex, and the n² search stays under 1024 operations. */
const COMPARE_SAMPLES = 32;

/**
 * Pure function. Throws unless `payload` is a well-formed MorphPaths — the LOUD
 * gate this codebase's no-silent-fallback rule requires at an engine boundary. A
 * malformed payload would otherwise surface many frames later as NaN
 * coordinates in a `d` string, which paints nothing and reports nothing.
 *
 * Checks the geometry law too: `space.w`/`space.h` must be non-negative (see the
 * module header — negative extents are resolved BEFORE the engine, never in it).
 *
 * @param {object} payload - the MorphPaths to validate
 * @param {string} label - which side this is, for the error message ("from"/"to")
 *
 * @example
 * >>> assertMorphPaths({space: {w: 10, h: 10}, subpaths: [], fillRule: "nonzero"}, "from")
 * undefined
 * >>> // a negative extent is REFUSED, not silently unsigned:
 * >>> assertMorphPaths({space: {w: -10, h: 10}, subpaths: [], fillRule: "nonzero"}, "from")
 * Error: morph "from": space.w is -10 ...
 */
export function assertMorphPaths(payload, label) {
  if (!payload || typeof payload !== "object")
    throw new Error(`morph "${label}": expected a MorphPaths object, got ${JSON.stringify(payload)}`);
  const { space, subpaths } = payload;
  if (!space || typeof space.w !== "number" || typeof space.h !== "number")
    throw new Error(`morph "${label}": space must be {w, h} numbers, got ${JSON.stringify(space)}`);
  if (space.w < 0 || space.h < 0)
    throw new Error(
      `morph "${label}": space.w is ${space.w} and space.h is ${space.h}, but a MorphPaths payload must arrive ` +
      `ALREADY unsignedState-normalized — a negative extent is a REFLECTION and is resolved by core/geometry.js ` +
      `normalizedBox/unsignedState BEFORE the morph engine, never inside it (the NEGATIVE EXTENTS protocol).`);
  if (!Array.isArray(subpaths))
    throw new Error(`morph "${label}": subpaths must be an array, got ${JSON.stringify(subpaths)}`);
  subpaths.forEach((sp, i) => {
    if (!Array.isArray(sp.start) || sp.start.length !== 2 || !sp.start.every(Number.isFinite))
      throw new Error(`morph "${label}" subpath ${i}: start must be two finite numbers, got ${JSON.stringify(sp.start)}`);
    if (!Array.isArray(sp.curves))
      throw new Error(`morph "${label}" subpath ${i}: curves must be an array, got ${JSON.stringify(sp.curves)}`);
    sp.curves.forEach((c, j) => {
      if (!Array.isArray(c) || c.length !== 6 || !c.every(Number.isFinite))
        throw new Error(
          `morph "${label}" subpath ${i} curve ${j}: expected a CUBIC sextuple [c1x,c1y,c2x,c2y,ex,ey] of finite ` +
          `numbers, got ${JSON.stringify(c)} — lines and quadratics must be elevated to cubics by the provider.`);
    });
  });
}

/**
 * Pure function. The payload's reference extent — the diagonal of its space, the
 * scale "degenerate" is measured against. A zero-size space (an empty widget)
 * reports 1 so downstream tolerance math never divides by zero.
 *
 * @example
 * >>> referenceExtent({space: {w: 3, h: 4}, subpaths: []})
 * 5
 * >>> referenceExtent({space: {w: 0, h: 0}, subpaths: []})
 * 1
 */
export function referenceExtent(payload) {
  const r = Math.hypot(payload.space.w, payload.space.h);
  return r > 0 ? r : 1;
}

/**
 * Pure function. A subpath's coordinates mapped into the UNIT box, given the
 * space it was authored in — so two widgets with different box sizes can be
 * compared and paired on shape rather than on absolute size.
 *
 * WHY NORMALIZE FOR PAIRING BUT NOT FOR THE LERP (research note §2.5): the two
 * widgets' boxes/transforms are ordinary property state and already tween
 * through core/interpolators.js. If the outline ALSO interpolated in absolute
 * coordinates, the box change would be counted twice. So pairing and scoring run
 * in unit space, and the returned aligned payloads keep unit space too — the
 * consumer maps back out through the (separately tweened) box.
 *
 * @example
 * >>> normalizeSubpath({start: [5, 10], curves: [[0, 0, 0, 0, 10, 20]], closed: false}, {w: 10, h: 20})
 * {start: [0.5, 0.5], curves: [[0, 0, 0, 0, 1, 1]], closed: false, winding: 1}
 */
export function normalizeSubpath(sp, space) {
  const sx = space.w > 0 ? space.w : 1;
  const sy = space.h > 0 ? space.h : 1;
  const out = {
    start: [sp.start[0] / sx, sp.start[1] / sy],
    curves: sp.curves.map((c) => [c[0] / sx, c[1] / sy, c[2] / sx, c[3] / sy, c[4] / sx, c[5] / sy]),
    closed: !!sp.closed,
  };
  out.winding = shoelaceWinding(out);
  if (sp.paint) out.paint = sp.paint;
  return out;
}

/**
 * Pure function. The whole payload in unit space, with every subpath's `winding`
 * re-derived rather than trusted. A provider is asked to supply `winding`
 * (research note §3.1 — so the engine never has to guess a frame convention),
 * but a provider that computes it in the WRONG frame would silently reverse
 * every pairing decision. Re-deriving costs one shoelace pass per subpath and
 * makes the field advisory, so a provider bug cannot corrupt a morph.
 *
 * @example
 * >>> normalizePayload({space: {w: 2, h: 2}, subpaths: [{start: [1, 1], curves: [[0,0,0,0,2,2]], closed: false}], fillRule: "evenodd"}).subpaths[0].start
 * [0.5, 0.5]
 */
export function normalizePayload(payload) {
  return {
    space: { w: 1, h: 1 },
    subpaths: payload.subpaths.map((sp) => normalizeSubpath(sp, payload.space)),
    fillRule: payload.fillRule,
  };
}

/**
 * Pure function. `count` anchors spread evenly (by curve index and parameter)
 * along the subpath — the common ground the pairing and start-point metrics are
 * computed on, since two subpaths rarely have the same curve count.
 *
 * @example
 * >>> resampleAnchors({start: [0, 0], curves: [[0, 0, 10, 0, 10, 0]], closed: false}, 3).length
 * 3
 * >>> // uniform in t, NOT in arc length — this curve's handles both sit on its
 * >>> // start, so the midpoint parameter is only 1/8 of the way along:
 * >>> resampleAnchors({start: [0, 0], curves: [[0, 0, 0, 0, 4, 0]], closed: false}, 2)
 * [[0, 0], [0.5, 0]]
 */
export function resampleAnchors(sp, count) {
  if (!sp.curves.length) return Array.from({ length: count }, () => [sp.start[0], sp.start[1]]);
  const out = [];
  for (let i = 0; i < count; i++) {
    const u = (i / count) * sp.curves.length;
    const ci = Math.min(sp.curves.length - 1, Math.floor(u));
    const t = u - ci;
    const tuple = curveTuple(sp, ci);
    const uu = 1 - t;
    out.push([
      uu * uu * uu * tuple[0][0] + 3 * uu * uu * t * tuple[1][0] + 3 * uu * t * t * tuple[2][0] + t * t * t * tuple[3][0],
      uu * uu * uu * tuple[0][1] + 3 * uu * uu * t * tuple[1][1] + 3 * uu * t * t * tuple[2][1] + t * t * t * tuple[3][1],
    ]);
  }
  return out;
}

/**
 * Pure function. Total polyline length of a subpath's anchors — the cheap size
 * proxy ManimGL sorts subpaths by (descending), and the "outer contour ↔ outer
 * contour" prior.
 *
 * @example
 * >>> // anchors (0,0) → (3,0) → (3,4): legs of 3 and 4
 * >>> subpathSize({start: [0, 0], curves: [[0, 0, 0, 0, 3, 0], [0, 0, 0, 0, 3, 4]], closed: false})
 * 7
 */
export function subpathSize(sp) {
  const pts = anchors(sp);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/**
 * Pure function. The cost of pairing subpath `a` with subpath `b`, in unit
 * space. Lower is better. Every term is scale-free so the weights are pure
 * priorities (see PAIR_WEIGHTS).
 *
 * Terms, per research note §3.2:
 *   - centroid distance (where the subpath sits),
 *   - |log(size_a / size_b)| (scale-invariant size agreement — a log ratio so
 *     "twice as big" costs the same as "half as big"),
 *   - |area_a - area_b| normalized (fill vs. hollow),
 *   - a winding-disagreement penalty (a hole should pair with a hole),
 *   - a closedness-disagreement penalty.
 *
 * @example
 * >>> const a = {start: [0, 0], curves: [[0,0,0,0,1,0],[0,0,0,0,1,1],[0,0,0,0,0,1],[0,0,0,0,0,0]], closed: true, winding: 1};
 * >>> pairCost(a, a)   // a subpath pairs with itself at zero cost
 * 0
 * >>> const far = {start: [9, 9], curves: [[9,9,9,9,9,9]], closed: false, winding: 1};
 * >>> pairCost(a, far) > pairCost(a, a)
 * true
 */
export function pairCost(a, b) {
  const ca = centroid(a), cb = centroid(b);
  const sizeA = subpathSize(a), sizeB = subpathSize(b);
  const areaA = Math.abs(signedAreaOf(a)), areaB = Math.abs(signedAreaOf(b));
  // A zero-size subpath (a dot) has no meaningful log ratio; treat it as a full
  // size disagreement with anything that has extent, and as agreement with
  // another dot, rather than producing Infinity.
  const sizeTerm = sizeA > 0 && sizeB > 0
    ? Math.abs(Math.log(sizeA / sizeB))
    : (sizeA === sizeB ? 0 : 1);
  return (
    PAIR_WEIGHTS.centroid * dist(ca, cb) +
    PAIR_WEIGHTS.size * sizeTerm +
    PAIR_WEIGHTS.area * Math.abs(areaA - areaB) +
    PAIR_WEIGHTS.winding * (a.winding === b.winding ? 0 : 1) +
    PAIR_WEIGHTS.closed * (!!a.closed === !!b.closed ? 0 : 1)
  );
}

/** Local alias so pairCost reads as prose; signedArea lives in morph_geometry. */
function signedAreaOf(sp) {
  const pts = anchors(sp);
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) sum += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  const first = pts[0], last = pts[pts.length - 1];
  sum += last[0] * first[1] - first[0] * last[1];
  return sum / 2;
}

/**
 * Pure function. Which subpath of `from` becomes which subpath of `to`, as a
 * list of `[fromIndex | null, toIndex | null]` pairs. Exactly one side may be
 * null, meaning that side needs padding.
 *
 * The policy, per the research note §3.2, and the reason for each half:
 *   - Both sides are first ordered by DESCENDING SIZE (ManimGL's sort). This is
 *     the correct prior — the biggest contour is the outer one on both sides —
 *     and it is what makes the pairing independent of `d`-string authoring
 *     order, which ManimCE's raw index pairing is not.
 *   - Pairs are then taken GREEDILY, lowest global cost first, under `pairCost`.
 *     Subpath counts are small (an icon rarely exceeds ~30, a glyph ~5), so the
 *     O(n² log n) greedy is affordable and a full Hungarian solve is a drop-in
 *     later if a real case demands it.
 *   - TIES BREAK TO THE LOWEST (fromIndex, toIndex), stated explicitly rather
 *     than left to sort stability, because two renderers disagreeing on a tie
 *     would draw two different frames for one document — the determinism law.
 *   - Leftovers on either side pair with null, in descending-size order, so the
 *     LARGEST unmatched subpath is padded first.
 *
 * @example
 * >>> // two subpaths each, paired big-to-big and small-to-small:
 * >>> const big = {start: [0, 0], curves: [[0,0,0,0,10,0],[0,0,0,0,10,10],[0,0,0,0,0,10],[0,0,0,0,0,0]], closed: true, winding: 1};
 * >>> const small = {start: [4, 4], curves: [[0,0,0,0,5,4],[0,0,0,0,5,5],[0,0,0,0,4,5],[0,0,0,0,4,4]], closed: true, winding: 1};
 * >>> pairSubpaths([big, small], [big, small])
 * [[0, 0], [1, 1]]
 * >>> // an unequal count leaves one side null (that side gets padded):
 * >>> pairSubpaths([big, small], [big])
 * [[0, 0], [1, null]]
 */
export function pairSubpaths(fromSubpaths, toSubpaths) {
  const order = (list) => list
    .map((sp, i) => ({ i, size: subpathSize(sp) }))
    .sort((p, q) => (q.size - p.size) || (p.i - q.i))
    .map((p) => p.i);
  const fromOrder = order(fromSubpaths);
  const toOrder = order(toSubpaths);

  const candidates = [];
  for (const fi of fromOrder)
    for (const ti of toOrder)
      candidates.push({ fi, ti, cost: pairCost(fromSubpaths[fi], toSubpaths[ti]) });
  // Deterministic total order: cost, then fromIndex, then toIndex. No two
  // candidates compare equal, so the sort's own stability is never load-bearing.
  candidates.sort((p, q) => (p.cost - q.cost) || (p.fi - q.fi) || (p.ti - q.ti));

  const usedFrom = new Set(), usedTo = new Set(), pairs = [];
  for (const c of candidates) {
    if (usedFrom.has(c.fi) || usedTo.has(c.ti)) continue;
    usedFrom.add(c.fi); usedTo.add(c.ti);
    pairs.push([c.fi, c.ti]);
  }
  for (const fi of fromOrder) if (!usedFrom.has(fi)) pairs.push([fi, null]);
  for (const ti of toOrder) if (!usedTo.has(ti)) pairs.push([null, ti]);
  // Present pairs in the FROM shape's own subpath order (nulls last, in
  // descending size), so paint order is preserved for the side that has one.
  pairs.sort((p, q) => {
    const pa = p[0] === null ? Infinity : p[0];
    const qa = q[0] === null ? Infinity : q[0];
    return (pa - qa) || ((p[1] ?? Infinity) - (q[1] ?? Infinity));
  });
  return pairs;
}

/**
 * Pure function. `n` extra curves inserted into a subpath WITHOUT changing the
 * ink — each insertion goes to the currently-longest curve, whose score is then
 * scaled by k/(k+1) to model "it is now k+1 pieces, so each is that much
 * shorter" (ManimGL's greedy, research note §1.3).
 *
 * TWO POLICIES WORTH NAMING:
 *   - DEGENERATE CURVES SCORE 0 and are therefore never chosen. This is the
 *     ManimGL guard, and it is what keeps PADDING from being subdivided: a
 *     null curve split in half is two null curves, which wastes the slot and
 *     starves a real curve of the sampling it needed.
 *   - LENGTH, NOT CHORD. ManimGL scores by the control-polygon span; we use the
 *     sampled arc length (morph_geometry.curveLength), because our single most
 *     common curve is the KAPPA quarter-arc every ellipse is built from, and a
 *     chord under-measures it badly — the research note §3.3.3 calls that out as
 *     our common case, not an edge case.
 *   - TIES break to the LOWEST index (as np.argmax does), stated for determinism.
 *
 * @example
 * >>> // one long curve and one short one: the insertion lands on the long one
 * >>> const sp = {start: [0, 0], closed: false, winding: 1, curves: [[0,0,10,0,10,0], [10,0,10,1,10,1]]};
 * >>> insertCurves(sp, 1, 10).curves.length
 * 3
 * >>> insertCurves(sp, 0, 10) === sp   // nothing to do returns the input
 * true
 */
export function insertCurves(sp, n, reference) {
  if (n <= 0) return sp;
  const tuples = sp.curves.map((_, i) => curveTuple(sp, i));
  if (!tuples.length) return dotSubpath(sp.start, n, sp);

  const scores = tuples.map((t) => (isDegenerateCurve(t, reference) ? 0 : curveLength(t)));
  const splits = tuples.map(() => 1);
  for (let k = 0; k < n; k++) {
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i; // ties → lowest index
    // Every curve degenerate (an all-padding subpath): spread insertions round
    // robin instead of piling them all on index 0, so the padding stays evenly
    // parameterized against whatever it is paired with.
    if (scores[best] === 0) best = k % tuples.length;
    splits[best] += 1;
    scores[best] *= splits[best] / (splits[best] + 1);
  }

  const out = [];
  for (let i = 0; i < tuples.length; i++) out.push(...subdivideCubic(tuples[i], splits[i]));
  for (let i = 1; i < out.length; i++) out[i][0] = out[i - 1][3];
  return subpathFromTuples(out, sp);
}

/**
 * Pure function. The cyclic rotation of CLOSED subpath `b` that best lines up
 * with `a`, as a curve index — THE fix for Manim's most visible artifact (a
 * square visibly spinning 90° while morphing into a square, because the two `d`
 * strings happened to start at different corners).
 *
 * The metric is the SUM OF SQUARED DISTANCES between correspondingly-indexed
 * resampled anchors; ties break to the LOWEST rotation index. See the module
 * header for why squared and why that tie-break.
 *
 * Returns 0 (no rotation) for open subpaths and for subpaths with fewer than two
 * curves — rotating either is meaningless or would move a free end.
 *
 * @example
 * >>> const sq = (start) => ({start, closed: true, winding: 1, curves: []});
 * >>> // a square starting at (0,0) vs. the SAME square starting at (1,0):
 * >>> const a = {start: [0, 0], closed: true, winding: 1, curves: [[0,0,0,0,1,0],[0,0,0,0,1,1],[0,0,0,0,0,1],[0,0,0,0,0,0]]};
 * >>> const b = {start: [1, 0], closed: true, winding: 1, curves: [[0,0,0,0,1,1],[0,0,0,0,0,1],[0,0,0,0,0,0],[0,0,0,0,1,0]]};
 * >>> bestRotation(a, b)   // rotate b by 3 to re-enter it at (0,0)
 * 3
 * >>> bestRotation(a, a)
 * 0
 */
export function bestRotation(a, b) {
  if (!b.closed || b.curves.length < 2) return 0;
  const target = resampleAnchors(a, COMPARE_SAMPLES);
  let bestK = 0, bestCost = Infinity;
  for (let k = 0; k < b.curves.length; k++) {
    const rotated = k === 0 ? b : rotateClosedSubpath(b, k);
    const pts = resampleAnchors(rotated, COMPARE_SAMPLES);
    let cost = 0;
    for (let i = 0; i < COMPARE_SAMPLES; i++) {
      const dx = pts[i][0] - target[i][0], dy = pts[i][1] - target[i][1];
      cost += dx * dx + dy * dy;
    }
    if (cost < bestCost) { bestCost = cost; bestK = k; } // strict < → ties keep the lowest k
  }
  return bestK;
}

/**
 * Pure function. Padding for a subpath that has NO counterpart — a stand-in that
 * occupies the same number of slots while painting nothing, so the pair can be
 * lerped and the missing side appears to grow out of (or collapse into) somewhere
 * sensible.
 *
 * Three cases, all from the research note §3.5, and the visual each buys:
 *   - THE PAIR HAS A PARTNER SUBPATH → TRACE-AND-RETURN on that partner
 *     (ManimGL's padding, not ManimCE's dot). A hole that is about to appear
 *     emerges FROM the contour it will live inside, rather than shooting out of
 *     a single point somewhere else in the shape. This is the usual case for
 *     "2-hole shape → 1-hole shape".
 *   - NO PARTNER, BUT THE OTHER SIDE HAS SUBPATHS → a dot at the ORPHAN's OWN
 *     centroid, so the shape blossoms from its own middle.
 *   - THE OTHER SIDE IS ENTIRELY EMPTY → a dot at the orphan's centroid too,
 *     which is the "empty → shape" case the note insists must NOT collapse to
 *     the origin (ManimCE's `start_new_path(mob.get_center())`).
 *
 * @param {object} orphan - the subpath that has no counterpart
 * @param {object|null} anchorSubpath - a subpath on the PADDED side to ride, or
 *   null when that side has nothing to ride
 *
 * @example
 * >>> const ring = {start: [0, 0], closed: true, winding: 1, curves: [[0,0,0,0,4,0],[0,0,0,0,0,0]]};
 * >>> // with a partner to ride, the padding traces that partner and returns:
 * >>> paddingFor(ring, ring).curves.length
 * 4
 * >>> // with nothing to ride, it is a dot at the orphan's own centroid:
 * >>> paddingFor(ring, null).start
 * [1.3333333333333333, 0]
 */
export function paddingFor(orphan, anchorSubpath) {
  if (anchorSubpath && anchorSubpath.curves.length) return traceAndReturn(anchorSubpath);
  return dotSubpath(centroid(orphan), Math.max(1, orphan.curves.length), orphan);
}

/**
 * Pure function. The structural signature of a payload — subpath count, and per
 * subpath its curve count, closed flag and winding. Two payloads with equal
 * signatures are already alignable slot-for-slot.
 *
 * THIS IS THE FAST-OUT MANIM GETS WRONG. `align_points` skips alignment when the
 * two total POINT COUNTS are equal, which is not equivalence: two shapes can
 * share a point count and have completely different subpath structure, and Manim
 * then lerps mismatched subpaths together. Comparing the full signature costs one
 * pass and cannot be fooled that way.
 *
 * @example
 * >>> const p = {space: {w: 1, h: 1}, subpaths: [{start: [0, 0], curves: [[0,0,0,0,1,1]], closed: true, winding: 1}], fillRule: "nonzero"};
 * >>> structureSignature(p)
 * '1|1,1,1'
 * >>> structureSignature(p) === structureSignature(p)
 * true
 */
export function structureSignature(payload) {
  return payload.subpaths.length + "|" +
    payload.subpaths.map((sp) => `${sp.curves.length},${sp.closed ? 1 : 0},${sp.winding}`).join(";");
}

/**
 * Pure function. THE ALIGNMENT. Two MorphPaths payloads in, two structurally
 * identical MorphPaths payloads out — same subpath count, same per-subpath curve
 * count, matched orientations and matched start vertices — each drawing exactly
 * what its input drew.
 *
 * The stages, in the order the research note §3.3 requires (winding BEFORE
 * rotation, rotation BEFORE curve-count equalization, so the rotation search runs
 * on the small pre-padded lists):
 *
 *   1. NORMALIZE both payloads to the unit box (§2.5 — the box tween is separate
 *      property state and must not be double-counted).
 *   2. PAIR subpaths by score, descending size first (§3.2).
 *   3. PAD an unmatched side with a trace-and-return ribbon or a centroid dot
 *      (§3.5).
 *   4. RECONCILE WINDING — reverse the `to` subpath when the pair disagrees, so
 *      paired points travel together instead of crumpling through the middle.
 *   5. ROTATE the `to` subpath's cyclic start to minimize travel (closed pairs
 *      only).
 *   6. EQUALIZE CURVE COUNTS by length-weighted subdivision of the shorter side.
 *
 * `closed` and `fillRule` do NOT blend — see the module header's open↔closed
 * policy. The aligned pair carries the FROM side's flags on the from payload and
 * the TO side's on the to payload; the discrete switch is applied by the lerp.
 *
 * @param {object} fromPayload - MorphPaths, already unsigned-normalized
 * @param {object} toPayload - MorphPaths, already unsigned-normalized
 * @returns {{from: object, to: object}} two structurally identical payloads
 *
 * @example
 * >>> const tri = {space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [
 * ...   {start: [0, 0], closed: true, winding: 1, curves: [[0,0,0,0,1,0],[0,0,0,0,0,1],[0,0,0,0,0,0]]}]};
 * >>> const sq = {space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [
 * ...   {start: [0, 0], closed: true, winding: 1, curves: [[0,0,0,0,1,0],[0,0,0,0,1,1],[0,0,0,0,0,1],[0,0,0,0,0,0]]}]};
 * >>> const {from, to} = alignPayloads(tri, sq);
 * >>> [from.subpaths[0].curves.length, to.subpaths[0].curves.length]  // equalized
 * [4, 4]
 */
export function alignPayloads(fromPayload, toPayload) {
  assertMorphPaths(fromPayload, "from");
  assertMorphPaths(toPayload, "to");

  const A = normalizePayload(fromPayload);
  const B = normalizePayload(toPayload);
  const reference = Math.SQRT2; // the unit box's diagonal — both sides are unit-normalized now

  // BOTH SIDES EMPTY is not an error (research note §3.5) — it is a morph
  // between two things that draw nothing, and it draws nothing.
  if (!A.subpaths.length && !B.subpaths.length)
    return { from: { ...A, subpaths: [] }, to: { ...B, subpaths: [] } };

  const pairs = pairSubpaths(A.subpaths, B.subpaths);
  const outFrom = [], outTo = [];

  for (const [fi, ti] of pairs) {
    // Resolve each side, padding whichever is missing. The padding rides the
    // OTHER side's paired subpath when there is one to ride (see paddingFor).
    let a = fi === null ? null : A.subpaths[fi];
    let b = ti === null ? null : B.subpaths[ti];
    if (a === null) a = paddingFor(b, nearestRideable(A.subpaths, b));
    if (b === null) b = paddingFor(a, nearestRideable(B.subpaths, a));

    // 4. WINDING. Reverse the TO side (never the FROM side, so the from payload
    // keeps its authored traversal and an identity morph is byte-stable).
    if (a.winding !== b.winding && b.curves.length > 1 && !isDegenerateSubpath(b, reference))
      b = reverseSubpath(b);

    // 5. CYCLIC START. Only meaningful when BOTH are closed — rotating a closed
    // subpath against an open one would chase a start point that has no freedom.
    if (a.closed && b.closed && b.curves.length > 1) b = rotateClosedSubpath(b, bestRotation(a, b));

    // 6. EQUALIZE CURVE COUNTS.
    const n = Math.max(a.curves.length, b.curves.length);
    a = insertCurves(a, n - a.curves.length, reference);
    b = insertCurves(b, n - b.curves.length, reference);

    outFrom.push(a);
    outTo.push(b);
  }

  return {
    from: { space: { w: 1, h: 1 }, subpaths: outFrom, fillRule: A.fillRule },
    to: { space: { w: 1, h: 1 }, subpaths: outTo, fillRule: B.fillRule },
  };
}

/**
 * Pure helper (near-pure: reads only its arguments). The subpath on `side` that
 * padding should RIDE when the orphan `target` has no counterpart there — the
 * closest one by pairing cost, or null when that side is empty. Riding the
 * closest contour is what makes a new hole emerge from the shape it will live
 * inside rather than from an unrelated corner.
 *
 * @example
 * >>> // nothing to ride when the side is empty:
 * >>> nearestRideable([], {start: [0, 0], curves: [], closed: true, winding: 1})
 * null
 */
function nearestRideable(side, target) {
  if (!side.length || !target) return null;
  let best = null, bestCost = Infinity;
  for (let i = 0; i < side.length; i++) {
    if (!side[i].curves.length) continue;
    const c = pairCost(target, side[i]);
    if (c < bestCost) { bestCost = c; best = side[i]; } // ties → lowest index
  }
  return best;
}
