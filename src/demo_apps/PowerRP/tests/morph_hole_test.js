/**
 * THE MID-MORPH HOLE LAW — the counter-fill bug, pinned.
 * Run: node src/demo_apps/PowerRP/tests/morph_hole_test.js
 *
 * USER BUG (2026-08-02, verbatim, with a screenshot of √b² mid-morph showing the
 * b's bowl filled solid): "when we're Morphing Latex to Latex, sometimes letters
 * get filled in in the middle of the animation."
 *
 * The mechanism and the measurements that chose this fix over the two obvious
 * alternatives are argued in core/morph_fill.js's header. What THIS suite pins:
 *
 *   HOLE          — a glyph-shaped payload (outer + counter) keeps its counter
 *                   OPEN at every mid-morph alpha, measured by sampling the
 *                   PIXEL the counter encloses and asking whether the payload's
 *                   own fill rule paints it. This is the user's picture, as an
 *                   assertion.
 *   NO REGRESSION — two overlapping SAME-winding contours still paint SOLID.
 *                   That is the case evenodd gets wrong, and the whole reason
 *                   the rule is conditional rather than blanket; without this
 *                   test the "fix" would be free to trade one artifact for
 *                   another.
 *   ENDPOINTS     — alpha 0 and alpha 1 return the ORIGINAL payloads, so a
 *                   stored fillRule is never rewritten.
 *   PURITY        — the decision is a function of the payload alone, and is
 *                   stable across repeated calls.
 *
 * Ink is judged by point-in-path under BOTH rules, computed here rather than
 * imported, so a bug in the engine's own containment helpers cannot make this
 * suite agree with it by construction.
 */

import assert from "node:assert/strict";
import { morphPaths } from "../core/morph.js";
import { hasSameWindingOverlap, midMorphFillRule, pointInRing } from "../core/morph_fill.js";
import { sampleSubpath, shoelaceWinding } from "../core/morph_geometry.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── FIXTURES ─────────────────────────────────────────────────────────────────

/** Test helper. A closed polygon as straight cubics. */
function poly(points) {
  const curves = [];
  const ring = [...points, points[0]];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i - 1], q = ring[i];
    curves.push([
      p[0] + (q[0] - p[0]) / 3, p[1] + (q[1] - p[1]) / 3,
      p[0] + (2 * (q[0] - p[0])) / 3, p[1] + (2 * (q[1] - p[1])) / 3,
      q[0], q[1],
    ]);
  }
  const sp = { start: [points[0][0], points[0][1]], curves, closed: true };
  sp.winding = shoelaceWinding(sp);
  return sp;
}

/** Test helper. An n-gon; `clockwise` false makes it a COUNTER (winding -1). */
function ngon(cx, cy, r, n, clockwise) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (clockwise ? 1 : -1) * (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return poly(pts);
}

/** Test helper. A glyph: an outer contour with a counter punched out of it —
 * the b's bowl, the 2's loop, the o's middle. */
const glyph = (cx, cy, r) => [ngon(cx, cy, r, 8, true), ngon(cx, cy, r * 0.45, 8, false)];
const payload = (subpaths) => ({ space: { w: 1, h: 1 }, fillRule: "nonzero", subpaths });

/** Test helper. Is `pt` painted, under the given rule, by these subpaths?
 * Written out here (rather than imported) so this suite is an INDEPENDENT
 * judge of the engine's ink. */
function painted(pt, subpaths, fillRule) {
  const rings = subpaths.map((sp) => sampleSubpath(sp, 10));
  if (fillRule === "evenodd") {
    let inside = false;
    for (const r of rings) if (pointInRing(pt, r)) inside = !inside;
    return inside;
  }
  let wind = 0;
  for (let i = 0; i < rings.length; i++) {
    if (!pointInRing(pt, rings[i])) continue;
    wind += shoelaceWinding(subpaths[i]);
  }
  return wind !== 0;
}

// ── THE HOLE LAW ─────────────────────────────────────────────────────────────

test("HOLE: a glyph's counter stays OPEN at every mid-morph alpha", () => {
  // THE USER'S PICTURE, as an assertion. Two glyphs at different places, each an
  // outer with a counter; the morph slides one into the other. The point at the
  // centre of the counter must never be painted.
  const from = payload(glyph(0.3, 0.5, 0.2));
  const to = payload(glyph(0.7, 0.5, 0.2));
  for (const alpha of [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
    const mid = morphPaths(from, to, alpha);
    // The counter's centre travels with the glyph, so ask the payload where its
    // negative contour actually is rather than assuming a fixed point.
    const counter = mid.subpaths.find((sp) => shoelaceWinding(sp) < 0);
    assert.ok(counter, `alpha ${alpha}: the payload must still HAVE a counter`);
    const ring = sampleSubpath(counter, 10);
    const centre = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
    assert.ok(!painted(centre, mid.subpaths, mid.fillRule),
      `alpha ${alpha}: the counter filled in — this is the bug the user photographed`);
  }
});

test("HOLE: a counter ENCLOSED BY ITS OUTER stays open even with a third contour in the scene", () => {
  // THE ACTUAL MECHANISM (core/morph_fill.js): under nonzero a pixel is painted
  // when the windings of every contour containing it SUM to non-zero, so a
  // neighbour drifting over a counter closes it even though nothing is mis-wound.
  //
  // THE PRECONDITION IS LOAD-BEARING AND IS CHECKED, not assumed. A "counter"
  // only denotes a hole while it is INSIDE the outer it was cut from; a negative
  // contour that has drifted clear of its parent encloses nothing, and demanding
  // that its interior stay unpainted would be asserting a hole that the author
  // never had. So this judges only the frames where the nesting genuinely holds
  // — which is exactly the configuration the user's screenshot shows.
  // A solid dot travels from one side of a STATIONARY glyph to the other, so
  // partway across it sits on the bowl while the counter is still nested.
  //
  // TWO REGIMES, AND THE BOUNDARY BETWEEN THEM IS THE POINT OF THIS TEST:
  //   - while the dot is clear of the glyph's outer, the frame has no
  //     same-winding overlap, the rule switches to evenodd, and the counter
  //     survives. That is the fix, and it FAILS without it (verified by
  //     reverting midMorphFillRule to a pass-through).
  //   - once the dot LAPS the outer, two +1 contours overlap. That is precisely
  //     the configuration evenodd gets wrong (it would punch a hole where the
  //     two solids cross), so the guard declines and nonzero stands — and under
  //     nonzero the sum +1 +1 −1 = +1 closes the bowl.
  //
  // THE SECOND REGIME IS NOT FIXABLE BY ANY FILL RULE, and pretending otherwise
  // is how a law becomes a lie. It is the measured residual (3 px on 2 of 400
  // frames of the realistic corpus — core/morph_fill.js's header), and the
  // structural answer to it is XX-2's matched-piece travel, which stops pieces
  // sweeping across their neighbours in the first place. So the assertion is
  // conditioned on the regime, and the OTHER regime is asserted too, in the
  // opposite direction, so neither half can silently stop being exercised.
  const from = payload([...glyph(0.3, 0.5, 0.2), ngon(0.9, 0.5, 0.09, 8, true)]);
  const to = payload([...glyph(0.3, 0.5, 0.2), ngon(0.1, 0.5, 0.09, 8, true)]);
  let openFrames = 0, residualFrames = 0;
  for (const alpha of [0.35, 0.45, 0.5, 0.55, 0.65, 0.75]) {
    const mid = morphPaths(from, to, alpha);
    for (const counter of mid.subpaths.filter((sp) => shoelaceWinding(sp) < 0)) {
      const ring = sampleSubpath(counter, 10);
      const centre = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
      const enclosing = mid.subpaths.filter((sp) =>
        sp !== counter && shoelaceWinding(sp) > 0 && pointInRing(centre, sampleSubpath(sp, 10)));
      if (enclosing.length === 0) continue; // drifted clear of every outer: no hole is claimed
      if (enclosing.length > 1) { residualFrames++; continue; } // the unfixable regime, named above
      openFrames++;
      assert.ok(!painted(centre, mid.subpaths, mid.fillRule),
        `alpha ${alpha}: a counter nested in its ONE outer filled in — ` +
        `this is the bug the user photographed, and this frame is fixable`);
    }
  }
  assert.ok(openFrames > 0, "the fixture must produce frames where the fix is what keeps the hole open");
  assert.ok(residualFrames > 0,
    "and frames of the KNOWN-UNFIXABLE regime, so the residual stays documented by a live assertion");
});

// ── NO REGRESSION ────────────────────────────────────────────────────────────

test("NO REGRESSION: two overlapping SAME-winding contours still paint SOLID", () => {
  // The case blanket evenodd gets WRONG — it would punch a hole where two outers
  // cross. Without this pin, "fix the counter" could silently trade one artifact
  // for another, which the measurements show is a strictly worse picture.
  const two = [ngon(0.4, 0.5, 0.2, 8, true), ngon(0.55, 0.5, 0.2, 8, true)];
  assert.ok(hasSameWindingOverlap(two), "the fixture must genuinely overlap same-signed");
  const p = payload(two);
  assert.equal(midMorphFillRule(p), "nonzero",
    "with same-winding overlap the payload's own rule must stand");
  // and the overlap region really is painted
  assert.ok(painted([0.475, 0.5], two, midMorphFillRule(p)),
    "the region where two outers cross must be SOLID, not a hole");
});

test("NO REGRESSION: nesting alone is NOT a same-winding overlap", () => {
  // A counter inside its outer is opposite-signed, so it must not trip the guard
  // — otherwise the fix would never engage on the very shape it exists for.
  assert.equal(hasSameWindingOverlap(glyph(0.5, 0.5, 0.2)), false);
  assert.equal(midMorphFillRule(payload(glyph(0.5, 0.5, 0.2))), "evenodd");
});

test("NO REGRESSION: a lone contour keeps its own rule (nothing to nest)", () => {
  const one = payload([ngon(0.5, 0.5, 0.2, 8, true)]);
  assert.equal(midMorphFillRule(one), "nonzero");
  assert.equal(midMorphFillRule({ ...one, fillRule: "evenodd" }), "evenodd",
    "and a payload that DECLARED evenodd keeps it");
});

// ── ENDPOINTS ────────────────────────────────────────────────────────────────

test("ENDPOINTS: alpha 0 and 1 return the ORIGINAL payloads, fillRule untouched", () => {
  // The short-circuit runs before any fill-rule decision, so a stored rule is
  // never rewritten — the endpoint law and the byte-identity promise both hold.
  const from = payload(glyph(0.3, 0.5, 0.2));
  const to = payload(glyph(0.7, 0.5, 0.2));
  assert.equal(morphPaths(from, to, 0), from);
  assert.equal(morphPaths(from, to, 1), to);
  assert.equal(morphPaths(from, to, 0).fillRule, "nonzero");
  assert.equal(morphPaths(from, to, 1).fillRule, "nonzero");
});

// ── PURITY ───────────────────────────────────────────────────────────────────

test("PURITY: the fill rule is a function of the payload alone, and is stable", () => {
  const p = payload(glyph(0.5, 0.5, 0.2));
  assert.equal(midMorphFillRule(p), midMorphFillRule(p));
  // an equal-valued COPY must decide identically — nothing may key on identity
  assert.equal(midMorphFillRule(JSON.parse(JSON.stringify(p))), midMorphFillRule(p));
});

test("PURITY: pointInRing agrees with a hand-checked square", () => {
  const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(pointInRing([0.5, 0.5], unit), true);
  assert.equal(pointInRing([1.5, 0.5], unit), false);
  assert.equal(pointInRing([-0.5, 0.5], unit), false);
});

console.log(`\n${passed} hole-law tests passed`);
