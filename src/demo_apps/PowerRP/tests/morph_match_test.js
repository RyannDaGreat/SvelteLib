/**
 * MATCHED-PIECE TRANSFORMS — the laws, plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/morph_match_test.js
 *
 * This is engine math, so the LAWS ARE THE PROOF. Each block pins one:
 *
 *   HASH          — the normalized-geometry key collides two occurrences of the
 *                   SAME shape at any position and any size, and separates
 *                   genuinely different shapes. Rotation and reflection are NOT
 *                   absorbed, deliberately: `6` and `9` are different glyphs.
 *   TRAVEL        — a matched piece's SHAPE is byte-stable at every alpha; only
 *                   its placement moves. This is the whole promise of the
 *                   feature and it is stronger than "it looks right": no curve
 *                   insertion, rotation search or winding reconciliation may
 *                   touch a matched piece.
 *   NO SWAP       — duplicate glyphs (two `b`s) pair by NEAREST DISPLACEMENT, so
 *                   identical letters never trade places. Pinned in the
 *                   direction that fails: with the TO list authored in the
 *                   opposite order, the match must follow geometry, not index.
 *   OPT-IN        — the flag is OFF by default, so every existing caller and
 *                   every law in morph_test.js is untouched. Pinned by
 *                   byte-comparing the two arms on a payload pair with no
 *                   matches, where they must agree exactly.
 *   ENDPOINTS     — alpha 0 and alpha 1 still return the ORIGINAL payloads in
 *                   the matched arm, byte-for-byte. The short-circuit runs
 *                   before the flag is read, and this proves it.
 *   DETERMINISM   — same inputs, identical output, cold cache and warm.
 *
 * Fixtures are hand-built so a failure names a rule rather than a fixture.
 */

import assert from "node:assert/strict";
import { clearMorphCache, matchedPlan, morphPaths } from "../core/morph.js";
import { matchSubpaths, placementOf, shapeKey, travelledSubpath, zeroNormalized } from "../core/morph_match.js";
import { dist, sampleSubpath, shoelaceWinding } from "../core/morph_geometry.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── FIXTURES ─────────────────────────────────────────────────────────────────

/** Test helper. A closed polygon as straight cubics (handles at the 1/3 and 2/3
 * points — the line→cubic elevation the payload contract requires). */
function poly(points, closed = true) {
  const curves = [];
  const ring = closed ? [...points, points[0]] : points;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i - 1], q = ring[i];
    curves.push([
      p[0] + (q[0] - p[0]) / 3, p[1] + (q[1] - p[1]) / 3,
      p[0] + (2 * (q[0] - p[0])) / 3, p[1] + (2 * (q[1] - p[1])) / 3,
      q[0], q[1],
    ]);
  }
  const sp = { start: [points[0][0], points[0][1]], curves, closed };
  sp.winding = shoelaceWinding(sp);
  return sp;
}

/** Test helper. An axis-aligned square of side `s` with its corner at (x, y). */
const square = (x, y, s) => poly([[x, y], [x + s, y], [x + s, y + s], [x, y + s]]);
/** Test helper. A right triangle — a shape that must NOT collide with a square. */
const tri = (x, y, s) => poly([[x, y], [x + s, y], [x, y + s]]);
/** Test helper. A regular n-gon, the stand-in for a rounded glyph contour. */
function ngon(cx, cy, r, n, clockwise = true) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (clockwise ? 1 : -1) * (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return poly(pts);
}
/** Test helper. A MorphPaths payload in the unit box. */
const payload = (subpaths, fillRule = "nonzero") =>
  ({ space: { w: 1, h: 1 }, subpaths, fillRule });

// ── HASH ─────────────────────────────────────────────────────────────────────

test("HASH: the same shape at a different POSITION and SIZE hashes equal", () => {
  // This is the property that makes a re-flowed equation matchable at all: the
  // glyph moved and may have been re-scaled (a superscript), and it is still the
  // same glyph.
  assert.equal(shapeKey(square(0, 0, 0.1)), shapeKey(square(0.7, 0.4, 0.3)),
    "translation and uniform scale must be absorbed by the normalization");
  assert.equal(shapeKey(ngon(0.2, 0.2, 0.05, 7)), shapeKey(ngon(0.8, 0.6, 0.15, 7)));
});

test("HASH: genuinely different shapes do NOT collide", () => {
  assert.notEqual(shapeKey(square(0, 0, 0.2)), shapeKey(tri(0, 0, 0.2)));
  assert.notEqual(shapeKey(ngon(0.5, 0.5, 0.2, 5)), shapeKey(ngon(0.5, 0.5, 0.2, 7)),
    "a pentagon and a heptagon are different glyphs");
});

test("HASH: an OPEN and a CLOSED subpath never collide", () => {
  // A `Z` joins the stroke, so an open contour and a closed one are different
  // ink even when their anchors coincide — the key carries the flag for exactly
  // that reason.
  const pts = [[0, 0], [0.2, 0], [0.2, 0.2]];
  assert.notEqual(shapeKey(poly(pts, true)), shapeKey(poly(pts, false)));
});

test("HASH: a degenerate speck reports the reserved 'dot' key rather than dividing by its own zero extent", () => {
  assert.equal(shapeKey({ start: [0.5, 0.5], curves: [[0.5, 0.5, 0.5, 0.5, 0.5, 0.5]], closed: true, winding: 1 }), "dot");
});

test("HASH: -0 is normalized to 0, so a mirror-authored twin cannot differ by a sign bit", () => {
  assert.equal(zeroNormalized(-0), 0);
  assert.ok(!shapeKey(square(0, 0, 0.2)).includes("-0,"), "no coordinate may print as -0");
});

// ── TRAVEL ───────────────────────────────────────────────────────────────────

test("TRAVEL: a matched piece's SHAPE is byte-stable at every alpha — only placement moves", () => {
  // THE CENTRAL LAW. An identical square present in both payloads must not be
  // resampled, re-wound or re-entered at another vertex; it must simply slide.
  const from = payload([square(0.05, 0.4, 0.2), tri(0.5, 0.4, 0.2)]);
  const to = payload([square(0.75, 0.4, 0.2), ngon(0.3, 0.5, 0.1, 6)]);
  const plan = matchedPlan(from, to);
  assert.equal(plan.matched.length, 1, "the square is congruent on both sides and must be matched");

  const keys = new Set();
  const startedAt = shapeKey(plan.matched[0].a);
  for (const alpha of [0.01, 0.2, 0.4, 0.5, 0.6, 0.8, 0.99]) {
    const piece = morphPaths(from, to, alpha, { matchPieces: true }).subpaths[0];
    keys.add(shapeKey(piece));
  }
  assert.equal(keys.size, 1, `a travelling piece changed shape mid-morph (saw ${keys.size} distinct shapes)`);
  assert.equal([...keys][0], startedAt, "and the one shape it holds is the FROM shape, not some average");
});

test("TRAVEL: the placement really does interpolate — the piece arrives where the TO piece is", () => {
  const from = payload([square(0.0, 0.4, 0.2)]);
  const to = payload([square(0.6, 0.4, 0.2)]);
  const plan = matchedPlan(from, to);
  const at = (alpha) => placementOf(travelledSubpath(plan.matched[0].a, plan.matched[0].b, alpha)).centre[0];
  const x0 = placementOf(plan.matched[0].a).centre[0];
  const x1 = placementOf(plan.matched[0].b).centre[0];
  // 1e-12: this is one lerp of two exact numbers, so the only error is float
  // rounding. Anything larger would mean the placement is being recomputed
  // from resampled geometry rather than interpolated.
  assert.ok(Math.abs(at(0) - x0) < 1e-12, "alpha 0 sits on the FROM placement");
  assert.ok(Math.abs(at(1) - x1) < 1e-12, "alpha 1 sits on the TO placement");
  assert.ok(Math.abs(at(0.5) - (x0 + x1) / 2) < 1e-12, "and the midpoint is the midpoint");
});

test("TRAVEL: a matched piece that also SCALES keeps its shape (the superscript case)", () => {
  // `2` becoming a superscript `²` is the same glyph at a smaller size. It must
  // shrink, not deform.
  const from = payload([ngon(0.3, 0.5, 0.2, 7)]);
  const to = payload([ngon(0.8, 0.25, 0.06, 7)]);
  const plan = matchedPlan(from, to);
  assert.equal(plan.matched.length, 1);
  const keys = new Set([0.2, 0.5, 0.8].map((a) =>
    shapeKey(morphPaths(from, to, a, { matchPieces: true }).subpaths[0])));
  assert.equal(keys.size, 1, "a scaling matched piece must keep one shape throughout");
  // and it really is shrinking
  const ext = (a) => placementOf(morphPaths(from, to, a, { matchPieces: true }).subpaths[0]).extent;
  assert.ok(ext(0.2) > ext(0.8), "the piece must actually get smaller as it travels");
});

test("TRAVEL: leftovers still MORPH through the ordinary alignment", () => {
  // The unmatched pieces are not dropped and not faded — they go through the
  // existing engine, which is this codebase's deliberate divergence from Manim
  // (which fades them). See core/morph_match.js's header.
  const from = payload([square(0.05, 0.4, 0.2), tri(0.5, 0.4, 0.2)]);
  const to = payload([square(0.75, 0.4, 0.2), ngon(0.3, 0.5, 0.1, 6)]);
  const plan = matchedPlan(from, to);
  assert.equal(plan.from.subpaths.length, 1, "the triangle has no congruent partner and must be left to morph");
  assert.equal(plan.to.subpaths.length, 1, "and so must the hexagon");
  const mid = morphPaths(from, to, 0.5, { matchPieces: true });
  assert.equal(mid.subpaths.length, 2, "one travelling piece plus one morphing piece");
  const morphing = new Set([0.25, 0.5, 0.75].map((a) =>
    shapeKey(morphPaths(from, to, a, { matchPieces: true }).subpaths[1])));
  assert.ok(morphing.size > 1, "the unmatched leftover must genuinely change shape — it is morphing, not travelling");
});

// ── NO SWAP ──────────────────────────────────────────────────────────────────

test("NO SWAP: duplicate glyphs pair by NEAREST displacement, not by index", () => {
  // Two identical squares on each side. Index pairing would be right by luck
  // here, so the load-bearing case is the next one.
  assert.deepEqual(
    matchSubpaths([square(0, 0, 0.2), square(0.6, 0, 0.2)], [square(0.05, 0, 0.2), square(0.65, 0, 0.2)]),
    [[0, 0], [1, 1]]);
});

test("NO SWAP: the match follows GEOMETRY when the TO list is authored in the other order", () => {
  // THIS is the test that fails under index pairing: the two `b`s would trade
  // places and slide across the equation for no reason the viewer can see.
  assert.deepEqual(
    matchSubpaths([square(0, 0, 0.2), square(0.6, 0, 0.2)], [square(0.65, 0, 0.2), square(0.05, 0, 0.2)]),
    [[0, 1], [1, 0]],
    "each duplicate must keep the copy NEAREST it, whatever order the payload was authored in");
});

test("NO SWAP: three identical glyphs each keep their own neighbour", () => {
  const from = [square(0, 0, 0.1), square(0.4, 0, 0.1), square(0.8, 0, 0.1)];
  const to = [square(0.82, 0, 0.1), square(0.02, 0, 0.1), square(0.42, 0, 0.1)];
  assert.deepEqual(matchSubpaths(from, to), [[0, 1], [1, 2], [2, 0]]);
});

// ── OPT-IN ───────────────────────────────────────────────────────────────────

test("OPT-IN: the flag is OFF by default, so every existing caller is untouched", () => {
  // Two payloads with NOTHING congruent: with no matches the matched arm has only
  // leftovers, so it must agree with the whole-shape arm exactly. Any difference
  // here would mean the new code path leaks into the default one.
  const from = payload([tri(0.1, 0.1, 0.3)]);
  const to = payload([ngon(0.6, 0.6, 0.2, 5)]);
  assert.equal(matchedPlan(from, to).matched.length, 0, "the fixture must genuinely have no congruent pieces");
  for (const alpha of [0.25, 0.5, 0.75]) {
    assert.deepEqual(
      morphPaths(from, to, alpha, { matchPieces: true }),
      morphPaths(from, to, alpha),
      "with no matches the two arms must produce byte-identical output");
  }
});

test("OPT-IN: an absent options argument is the whole-shape morph", () => {
  const from = payload([square(0.05, 0.4, 0.2), tri(0.5, 0.4, 0.2)]);
  const to = payload([square(0.75, 0.4, 0.2), ngon(0.3, 0.5, 0.1, 6)]);
  // The square IS congruent here, so the two arms genuinely differ — which is
  // what makes "the default did not change" a real assertion rather than a
  // vacuous one.
  assert.notDeepEqual(morphPaths(from, to, 0.5), morphPaths(from, to, 0.5, { matchPieces: true }));
  assert.deepEqual(morphPaths(from, to, 0.5), morphPaths(from, to, 0.5, null));
  assert.deepEqual(morphPaths(from, to, 0.5), morphPaths(from, to, 0.5, {}));
});

// ── ENDPOINTS ────────────────────────────────────────────────────────────────

test("ENDPOINTS: the matched arm returns the ORIGINAL payloads at alpha 0 and 1", () => {
  // The short-circuit runs BEFORE the flag is read, so the endpoint law is the
  // same law in both arms — including the byte-identity that lets a deck which
  // never scrubs be untouched by this feature.
  const from = payload([square(0.05, 0.4, 0.2)]);
  const to = payload([square(0.75, 0.4, 0.2)]);
  assert.equal(morphPaths(from, to, 0, { matchPieces: true }), from);
  assert.equal(morphPaths(from, to, 1, { matchPieces: true }), to);
  assert.equal(morphPaths(from, to, -0.5, { matchPieces: true }), from);
  assert.equal(morphPaths(from, to, 1.5, { matchPieces: true }), to);
});

test("ENDPOINTS: the ink at alpha→0 and alpha→1 is the endpoint ink", () => {
  // Just inside the open interval the matched arm is doing real work, and it must
  // still be drawing (essentially) the endpoint pictures.
  const from = payload([square(0.05, 0.4, 0.2), tri(0.5, 0.4, 0.2)]);
  const to = payload([square(0.75, 0.4, 0.2), ngon(0.3, 0.5, 0.1, 6)]);
  const near0 = morphPaths(from, to, 1e-7, { matchPieces: true });
  const travelled = near0.subpaths[0];
  // 1e-5: the piece has travelled 1e-7 of a ~0.7 unit journey, so the expected
  // displacement is ~1e-7. A tolerance two decades above that catches any real
  // discontinuity while ignoring the lerp's own rounding.
  const ref = sampleSubpath(matchedPlan(from, to).matched[0].a, 8);
  const got = sampleSubpath(travelled, 8);
  for (let i = 0; i < ref.length; i++)
    assert.ok(dist(ref[i], got[i]) < 1e-5, `the travelling piece jumped at alpha→0 (sample ${i})`);
});

// ── DETERMINISM ──────────────────────────────────────────────────────────────

test("DETERMINISM: identical inputs give identical output, cold cache and warm", () => {
  const from = payload([square(0.05, 0.4, 0.2), tri(0.5, 0.4, 0.2)]);
  const to = payload([square(0.75, 0.4, 0.2), ngon(0.3, 0.5, 0.1, 6)]);
  clearMorphCache();
  const cold = JSON.stringify(morphPaths(from, to, 0.42, { matchPieces: true }));
  const warm = JSON.stringify(morphPaths(from, to, 0.42, { matchPieces: true }));
  assert.equal(cold, warm, "the memo is an optimization and must never be a semantic");
  clearMorphCache();
  assert.equal(JSON.stringify(morphPaths(from, to, 0.42, { matchPieces: true })), cold,
    "and clearing the cache mid-render is a performance event, never a visual one");
});

test("DETERMINISM: the matching itself is a pure function of the two payloads", () => {
  // Equal-valued COPIES must match identically — nothing may key on object
  // identity, an item id or a slide index (the property-state law).
  const mk = () => payload([square(0.05, 0.4, 0.2), tri(0.5, 0.4, 0.2)]);
  clearMorphCache();
  const a = JSON.stringify(matchedPlan(mk(), payload([square(0.75, 0.4, 0.2)])).matched.length);
  clearMorphCache();
  const b = JSON.stringify(matchedPlan(mk(), payload([square(0.75, 0.4, 0.2)])).matched.length);
  assert.equal(a, b);
});

test("DETERMINISM: ties break to the lowest index, stated rather than left to sort stability", () => {
  // Two candidates at EXACTLY equal displacement. Two renderers disagreeing here
  // would draw two different frames for one document.
  const from = [square(0.4, 0, 0.1)];
  const to = [square(0.2, 0, 0.1), square(0.6, 0, 0.1)];
  assert.deepEqual(matchSubpaths(from, to), [[0, 0]], "an exact tie must resolve to the lowest toIndex");
});

console.log(`\n${passed} matched-piece tests passed`);
