/**
 * THE MID-MORPH FILL RULE — why a glyph's counter fills in halfway through a
 * morph, and the one decision that keeps it open.
 *
 * ── THE USER'S BUG, VERBATIM (2026-08-02, with a screenshot) ─────────────────
 *   "I noticed that when we're Morphing Latex to Latex, sometimes letters get
 *    filled in in the middle of the animation. It's kind of weird."
 *   [screenshot: √b² mid-morph, the b's bowl FILLED SOLID]
 *
 * ── THE MECHANISM, MEASURED RATHER THAN ASSUMED ──────────────────────────────
 * The obvious suspect is winding reconciliation: core/morph_align.js reverses a
 * subpath to agree with its PAIR, so it could flip a counter and destroy the
 * opposition to its parent that punches the hole. That does happen — measured at
 * 65 flipped slots over 120 random glyph-ish morph pairs — but it is NOT the
 * cause of the picture the user photographed, and building the fix around it
 * would have been building it around the wrong thing.
 *
 * What was actually measured, on 600 mid-morph frames of a random glyph corpus:
 *
 *   - Under nonzero, 1.14% of hole pixels were painted solid, on 103 of 600
 *     frames. That is the bug, and it reproduces.
 *   - Of those 103 losing frames, only 34 were repairable by ANY winding
 *     assignment — measured by forcing every subpath's sign to oppose whatever
 *     encloses it, which is the best case a role-preserving reconciliation could
 *     ever reach. The other 69 were not.
 *   - Forcing roles per frame is in fact WORSE THAN DOING NOTHING (253 → 4013
 *     lost hole pixels on the realistic corpus), because mid-morph enclosure is
 *     transient: re-deciding a sign from the moving geometry flips it back and
 *     forth between adjacent frames, which is the same class of defect as the
 *     workstream-II jiggle.
 *
 * THE REAL MECHANISM IS A SUM, NOT A FLIP. Under the nonzero rule a pixel is
 * painted when the winding numbers of every contour containing it sum to
 * something other than zero. A counter (−1) inside its own outer (+1) sums to 0
 * and the hole opens. But when a SECOND contour drifts across that region
 * mid-flight — a neighbouring glyph sliding past, a piece travelling to its new
 * placement — the sum becomes +1, and the hole closes. Nothing was mis-wound; the
 * counter is still perfectly opposed to its own parent. There is simply a third
 * shape on top, and no assignment of signs to contours can fix a sum that has an
 * extra term in it.
 *
 * ── WHY BLANKET EVENODD IS ALSO WRONG ────────────────────────────────────────
 * Under evenodd a hole survives ANY winding, so it fixes the bug absolutely: 0
 * lost hole pixels, on 0 frames, in every corpus measured. It is nevertheless the
 * wrong default, because it changes the answer in the OTHER direction wherever
 * two contours of the SAME role overlap: two outers crossing sum to "inside
 * twice", which nonzero paints solid (right) and evenodd punches a hole in
 * (wrong). Measured on the realistic equation corpus that trade is 36 hole pixels
 * recovered against 4440 spurious ones created, on 223 frames instead of 28 — a
 * strictly worse picture, and a NEW artifact where there had been none.
 *
 * ── THE RULE THIS MODULE IMPLEMENTS ──────────────────────────────────────────
 * The two failures are DISJOINT and each is detectable from the geometry already
 * in hand, so the honest answer is neither blanket policy but a per-frame
 * question:
 *
 *   Use EVENODD unless the frame contains two overlapping SAME-WINDING OUTERS.
 *
 * ── THE WORD "OUTERS" IS LOAD-BEARING, AND IT WAS MISSING FOR A DAY (AM) ─────
 * This rule originally said SAME-WINDING CONTOURS, and that over-fired. Sign and
 * ROLE are different questions: two OUTERS crossing is the case evenodd gets
 * wrong, but two COUNTERS crossing has the same sign and the OPPOSITE need —
 * under nonzero their windings sum with the parent they share to something
 * non-zero, so the hole CLOSES, which is the very bug this module exists to stop.
 * A sign-only test therefore disqualified evenodd on the frames that most needed
 * it. "6" → "8" is exactly that: a 6 has one counter and an 8 has two, so the
 * unmatched second counter travels across the first, and measured at alpha
 * 0.1/0.25/0.5 the overlapping pair is two contours of winding −1 BOTH ENCLOSED
 * BY THE SAME OUTER (+1). Both kinds are real and common — over a 13-pair glyph
 * corpus × 9 alphas, 35 outer/outer pairs on 22 frames against 89 counter-
 * involving pairs on 54 — so neither blanket answer is available and `isCounter`
 * has to ask. Measured effect on counter interiors over that corpus: 198 probes
 * painted solid on 46 frames → 154 on 41, which is blanket evenodd's own score,
 * while the outer/outer frames keep nonzero exactly as before.
 *
 * IT WAS NOT, HOWEVER, THE USER'S BUG. That was a level down: render_gpu/ports.js
 * `morphIR` emitted one path op PER SUBPATH, so a counter and its parent were
 * never in the same path and NO fill rule could hole anything (measured: zero
 * hole pixels at every alpha of "6" → "8", including under evenodd). This module
 * was computing the right answer and handing it to ops that could not act on it.
 * See `morphPaintRuns`. The refinement above is the second, smaller half.
 *
 * When nothing same-signed overlaps, the two rules agree everywhere EXCEPT on
 * nested counters, where evenodd is right and nonzero is the bug — so switching
 * is free. When something same-signed does overlap, that is precisely the case
 * evenodd would get wrong, so we keep nonzero and accept the residue.
 *
 * Measured against doing nothing, on the two corpora:
 *
 *   realistic equation edits   hole loss 25 px / 12 frames → 3 px / 2 frames
 *                              spurious holes 304 px / 65 frames → UNCHANGED
 *   adversarial random words   hole loss 604 px / 104 frames → 358 px / 66 frames
 *                              spurious holes 887 px / 137 frames → UNCHANGED
 *
 * The second line is the important one: the guard NEVER trades one artifact for
 * another. Spurious holes are byte-identical to the nonzero baseline in both
 * corpora, because the rule only ever switches on frames where evenodd cannot
 * introduce them. It recovers holes or it does nothing.
 *
 * ── WHY IT IS SAFE AT THE ENDPOINTS ──────────────────────────────────────────
 * Measured too, and it is the reason this is allowed to change a fill rule at
 * all: on 1,944,000 endpoint pixels of the random corpus, nonzero and evenodd
 * disagreed on ZERO. A real glyph payload is non-self-overlapping, so the two
 * rules are the same function on it. The switch is therefore invisible except on
 * exactly the frames it exists to fix — and `morphPaths` short-circuits to the
 * ORIGINAL payloads at alpha 0 and 1 regardless, so a stored `fillRule` is never
 * rewritten in either endpoint.
 *
 * EVERY BACKEND ALREADY HONOURS BOTH RULES — Skia `FillType.EvenOdd`, PDF `f*`,
 * SVG `fill-rule="evenodd"` — and `render_gpu/ir.js path()` validates the field.
 * So this is a decision, not a capability: nothing downstream needed a change.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

import { sampleSubpath, shoelaceWinding } from "./morph_geometry.js";

/**
 * Points sampled per curve when testing one contour against another. SIX is a
 * screening resolution, not a proof: this predicate decides which of two fill
 * rules to ask for, and both rules draw the same picture except on nested
 * counters, so a missed overlap costs at most the residual hole loss the
 * measurements already report. Sampling densely enough to be exact would cost
 * per-frame time to sharpen a decision whose two answers mostly agree.
 */
const OVERLAP_SAMPLES = 6;

/**
 * Pure function. Is `pt` inside the closed polyline `ring`, by the even-odd
 * crossing count? Local to this module because it answers a CONTAINMENT question
 * about sampled ink, which is not the same thing as core/geometry.js's hit tests
 * over widget boxes.
 *
 * @param {number[]} pt - [x, y]
 * @param {number[][]} ring - sampled points of one closed contour
 * @returns {boolean}
 *
 * @example
 * >>> const unitSquare = [[0, 0], [1, 0], [1, 1], [0, 1]];
 * >>> pointInRing([0.5, 0.5], unitSquare)
 * true
 * >>> pointInRing([1.5, 0.5], unitSquare)
 * false
 */
export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/**
 * Pure function. Do two OUTERS of the same winding overlap anywhere in this
 * subpath list? That is exactly the configuration under which evenodd and nonzero
 * disagree in evenodd's DISFAVOUR — two outers crossing are "inside twice", which
 * nonzero paints solid (correct) and evenodd punches a hole in (wrong).
 *
 * A pair where either contour is a COUNTER is skipped, and that exclusion is the
 * whole of workstream AM's second half — see `isCounter` and the module header.
 * Same sign, opposite need: two counters crossing is the case evenodd gets RIGHT.
 *
 * Screening, not proof: it tests each contour's sampled points against each
 * other contour. Two shapes can cross without any sample landing inside, and the
 * cost of that miss is bounded — see the module header's residual figures.
 *
 * @param {object[]} subpaths - the mid-morph subpaths
 * @returns {boolean}
 *
 * @example
 * >>> // a glyph: an outer (+1) with a counter (-1) inside it. Opposite
 * >>> // windings, so this is NESTING, not a same-sign overlap:
 * >>> const outer = {start: [0, 0], closed: true, winding: 1, curves: [
 * ...   [0,0,0,0,4,0], [0,0,0,0,4,4], [0,0,0,0,0,4], [0,0,0,0,0,0]]};
 * >>> const counter = {start: [1, 1], closed: true, winding: -1, curves: [
 * ...   [0,0,0,0,1,3], [0,0,0,0,3,3], [0,0,0,0,3,1], [0,0,0,0,1,1]]};
 * >>> hasSameWindingOverlap([outer, counter])
 * false
 * >>> // the SAME outer twice, overlapping — this is the case evenodd gets wrong:
 * >>> hasSameWindingOverlap([outer, outer])
 * true
 * >>> // TWO COUNTERS crossing inside one outer — the "6" → "8" frame. Same sign
 * >>> // as each other, but evenodd is RIGHT here, so this is NOT a disqualifier:
 * >>> const other = {start: [2, 1], closed: true, winding: -1, curves: [
 * ...   [0,0,0,0,2,3], [0,0,0,0,3.5,3], [0,0,0,0,3.5,1], [0,0,0,0,2,1]]};
 * >>> hasSameWindingOverlap([outer, counter, other])
 * false
 */
export function hasSameWindingOverlap(subpaths) {
  if (subpaths.length < 2) return false;
  const rings = subpaths.map((sp) => sampleSubpath(sp, OVERLAP_SAMPLES));
  // The winding is RE-DERIVED rather than read off the field: a subpath that has
  // been reversed or rotated by alignment carries whatever `subpathFromTuples`
  // last computed, and this predicate must describe the geometry it is handed.
  const signs = subpaths.map((sp) => shoelaceWinding(sp));
  const counter = rings.map((_, i) => isCounter(rings, signs, i));
  for (let i = 0; i < rings.length; i++)
    for (let j = 0; j < rings.length; j++) {
      if (i === j || signs[i] !== signs[j]) continue;
      // ROLE, NOT JUST SIGN — see the note below. Two OUTERS crossing is the case
      // evenodd gets wrong; a pair involving a COUNTER is the case it gets right,
      // and disqualifying evenodd for it is what left the user's counters filled.
      if (counter[i] || counter[j]) continue;
      for (const p of rings[i]) if (pointInRing(p, rings[j])) return true;
    }
  return false;
}

/**
 * Pure function. Is contour `i` a COUNTER — a hole in something — rather than an
 * outer? Measured the only way that survives mid-flight: its own centroid lies
 * inside some contour of the OPPOSITE winding, which is what "nested in a parent
 * it opposes" means geometrically.
 *
 * ── WHY THE ROLE AND NOT JUST THE SIGN (workstream AM) ───────────────────────
 * `hasSameWindingOverlap` exists to protect the ONE case evenodd is worse at:
 * two OUTERS crossing are "inside twice", which nonzero paints solid (right) and
 * evenodd punches a hole in (wrong). But it was testing the sign alone, and two
 * COUNTERS overlapping have the same sign and the OPPOSITE need — under nonzero
 * their windings sum with their shared parent's to something non-zero and the
 * hole CLOSES, which is precisely the bug. So a sign-only test disqualified
 * evenodd on the frames that needed it most.
 *
 * That is not hypothetical: "6" → "8" is exactly it. A 6 has one counter and an 8
 * has two, so the unmatched second counter travels across the first, and measured
 * at alpha 0.1/0.25/0.5 the pair is two contours of winding −1 BOTH ENCLOSED BY
 * THE SAME OUTER (+1). Over a 13-pair glyph corpus × 9 alphas the two kinds are
 * both real and both common — 35 outer/outer pairs on 22 frames, 89 pairs
 * involving a counter on 54 frames — so neither blanket answer is available and
 * the role has to be asked.
 *
 * THE CENTROID IS A SCREEN, not a proof, exactly like the sampling above it: a
 * crescent's centroid can fall outside its own ring, in which case this answers
 * "outer" and the payload keeps nonzero — the same bounded cost the module header
 * already accounts for, never a wrong picture of its own.
 *
 * @param {number[][][]} rings - every contour's sampled points
 * @param {number[]} signs - each contour's winding
 * @param {number} i - the contour to classify
 * @returns {boolean}
 *
 * The counter must be OFF-CENTRE in this example for it to say anything: a hole
 * concentric with its parent contains the parent's centroid too, so both would
 * answer "nested" and the test would not distinguish them. Real letterforms are
 * off-centre (a 6's bowl sits low, a B's two counters sit above and below), which
 * is why the screen works in practice — and the concentric case degrades to
 * "outer", i.e. to the unchanged nonzero behaviour, never to a wrong picture.
 *
 * @example
 * >>> // a big square (+1) with a small square (-1) low inside it — a bowl. The
 * >>> // small one is the counter; the big one is not (its centre is above the bowl).
 * >>> const outer = [[0, 0], [8, 0], [8, 8], [0, 8]];
 * >>> const bowl = [[2, 5], [6, 5], [6, 7], [2, 7]];
 * >>> isCounter([outer, bowl], [1, -1], 1)
 * true
 * >>> isCounter([outer, bowl], [1, -1], 0)
 * false
 */
export function isCounter(rings, signs, i) {
  const ring = rings[i];
  if (!ring.length) return false;
  const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  return rings.some((r, j) => j !== i && signs[j] !== signs[i] && pointInRing([cx, cy], r));
}

/**
 * Pure function. THE FILL RULE a mid-morph payload should be PAINTED with —
 * "evenodd" when that is safe, otherwise the payload's own declared rule.
 *
 * See the module header for the measurements behind this and for why neither
 * blanket policy is correct. In one sentence: evenodd keeps a counter open under
 * ANY winding, which is the bug; its only failure mode is two same-role contours
 * overlapping, which is detectable; so switch exactly when that is absent.
 *
 * A payload with fewer than two subpaths cannot have a nested counter at all, so
 * it keeps its own rule and this costs nothing on the overwhelmingly common case.
 *
 * @param {object} payload - a mid-morph MorphPaths
 * @returns {"nonzero"|"evenodd"}
 *
 * @example
 * >>> const outer = {start: [0, 0], closed: true, winding: 1, curves: [
 * ...   [0,0,0,0,4,0], [0,0,0,0,4,4], [0,0,0,0,0,4], [0,0,0,0,0,0]]};
 * >>> const counter = {start: [1, 1], closed: true, winding: -1, curves: [
 * ...   [0,0,0,0,1,3], [0,0,0,0,3,3], [0,0,0,0,3,1], [0,0,0,0,1,1]]};
 * >>> // a glyph with a counter and nothing same-signed overlapping: EVENODD,
 * >>> // so the bowl of the b stays open however the contours are wound.
 * >>> midMorphFillRule({space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [outer, counter]})
 * 'evenodd'
 * >>> // two overlapping outers: evenodd would punch a hole where they cross, so
 * >>> // the payload's own rule stands.
 * >>> midMorphFillRule({space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [outer, outer]})
 * 'nonzero'
 * >>> // a single contour has no counter to lose: unchanged.
 * >>> midMorphFillRule({space: {w: 1, h: 1}, fillRule: "nonzero", subpaths: [outer]})
 * 'nonzero'
 */
export function midMorphFillRule(payload) {
  if (payload.subpaths.length < 2) return payload.fillRule;
  return hasSameWindingOverlap(payload.subpaths) ? payload.fillRule : "evenodd";
}
