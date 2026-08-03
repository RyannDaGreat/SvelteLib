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
 *   Use EVENODD unless the frame contains two overlapping SAME-WINDING contours.
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
 * Pure function. Do two contours of the SAME winding overlap anywhere in this
 * subpath list? That is exactly the configuration under which evenodd and nonzero
 * disagree in evenodd's DISFAVOUR — two outers crossing are "inside twice", which
 * nonzero paints solid (correct) and evenodd punches a hole in (wrong).
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
 */
export function hasSameWindingOverlap(subpaths) {
  if (subpaths.length < 2) return false;
  const rings = subpaths.map((sp) => sampleSubpath(sp, OVERLAP_SAMPLES));
  // The winding is RE-DERIVED rather than read off the field: a subpath that has
  // been reversed or rotated by alignment carries whatever `subpathFromTuples`
  // last computed, and this predicate must describe the geometry it is handed.
  const signs = subpaths.map((sp) => shoelaceWinding(sp));
  for (let i = 0; i < rings.length; i++)
    for (let j = 0; j < rings.length; j++) {
      if (i === j || signs[i] !== signs[j]) continue;
      for (const p of rings[i]) if (pointInRing(p, rings[j])) return true;
    }
  return false;
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
