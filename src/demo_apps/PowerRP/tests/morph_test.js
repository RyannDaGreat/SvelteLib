/**
 * THE MORPH ENGINE — core tests, plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/morph_test.js
 *
 * This suite is not coverage bookkeeping; for a pure-math engine the LAWS ARE
 * THE DELIVERABLE'S PROOF, and each block below pins one of them:
 *
 *   IDENTITY      — A morphed into A is A at every alpha, byte-exact. If this
 *                   fails, alignment is inventing motion out of nothing.
 *   ENDPOINT      — alpha 0 draws what `from` draws and alpha 1 draws what `to`
 *                   draws, AFTER alignment. Alignment is allowed to change a
 *                   subpath's PARAMETERIZATION (insert curves, reverse it,
 *                   re-enter it at a different vertex); it is NOT allowed to
 *                   change its INK. That distinction is the whole reason
 *                   alignment is safe, so it is pinned by sampling points along
 *                   the curves before and after, not by comparing arrays.
 *   START POINT   — two identical squares whose `d` strings begin at different
 *                   corners must morph STILL. This is the artifact test: Manim
 *                   fails it visibly (the square spins 90°) and it is the single
 *                   most important thing this engine does better.
 *   WINDING       — opposite-orientation circles morph without crumpling, i.e.
 *                   every point travels a short monotone path rather than going
 *                   the long way round.
 *   SUBPATH COUNT — a 2-hole shape morphing to a 1-hole one inserts degenerate
 *                   padding, and the padding paints NOTHING at the endpoints
 *                   (no pop).
 *   DETERMINISM   — same inputs, identical output arrays, twice, cold and warm.
 *
 * All geometry here is hand-built so a failure names a rule rather than a
 * fixture. Tolerances are stated at each assertion with the reason for the
 * number, never as a bare epsilon.
 */

import assert from "node:assert/strict";
import {
  alignPayloads,
  alignedPair,
  assertMorphPaths,
  clearMorphCache,
  morphPaths,
  payloadKey,
  payloadToPathD,
  structureSignature,
} from "../core/morph.js";
import {
  anchors,
  centroid,
  curveTuple,
  dist,
  evalCubic,
  isDegenerateSubpath,
  partialCubic,
  reverseSubpath,
  rotateClosedSubpath,
  sampleSubpath,
  shoelaceWinding,
  subdivideCubic,
  subpathToPathD,
} from "../core/morph_geometry.js";
import {
  bestRotation,
  insertCurves,
  normalizePayload,
  pairSubpaths,
  resampleAnchors,
} from "../core/morph_align.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── FIXTURES ─────────────────────────────────────────────────────────────────

/** Test helper. A closed polygon as a MorphPaths subpath, with straight cubics
 * (handles at the 1/3 and 2/3 points — exactly the line→cubic elevation the
 * payload contract requires of a provider). */
function polySubpath(points, closed = true) {
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

/** Test helper. A MorphPaths payload wrapping some subpaths in a unit-ish box. */
function payload(subpaths, space = { w: 100, h: 100 }, fillRule = "nonzero") {
  return { space, subpaths, fillRule };
}

/** Test helper. A square as four straight cubics, entered at corner `startAt`.
 * The SAME square drawn four ways is the start-point artifact fixture. */
function square(x, y, size, startAt = 0) {
  const corners = [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
  const rotated = [...corners.slice(startAt), ...corners.slice(0, startAt)];
  return polySubpath(rotated, true);
}

/** Test helper. A circle as the standard 4-arc KAPPA cubic approximation —
 * the curve our ellipses are ACTUALLY made of, so the length-weighted insertion
 * is exercised on its real common case rather than on straight lines. */
function circle(cx, cy, r, clockwise = true) {
  const K = (4 / 3) * (Math.SQRT2 - 1) * r;
  const pts = [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
  const tang = [[K, 0], [0, K], [-K, 0], [0, -K]];
  const order = clockwise ? [0, 1, 2, 3] : [0, 3, 2, 1];
  const curves = [];
  for (let i = 0; i < 4; i++) {
    const a = order[i], b = order[(i + 1) % 4];
    const sgn = clockwise ? 1 : -1;
    curves.push([
      pts[a][0] + sgn * tang[a][0], pts[a][1] + sgn * tang[a][1],
      pts[b][0] - sgn * tang[b][0], pts[b][1] - sgn * tang[b][1],
      pts[b][0], pts[b][1],
    ]);
  }
  const sp = { start: [pts[order[0]][0], pts[order[0]][1]], curves, closed: true };
  sp.winding = shoelaceWinding(sp);
  return sp;
}

/** Test helper. Every sampled point of a whole payload, subpath by subpath. */
function inkOf(p, samplesPerCurve = 8) {
  return p.subpaths.map((sp) => sampleSubpath(sp, samplesPerCurve));
}

/**
 * Test helper. The greatest distance from any point of `ink` to the CURVE
 * described by `reference` — i.e. "does this draw the same picture?", measured
 * as a one-sided Hausdorff distance against a dense sampling of the reference.
 * Dense (64/curve) because the reference is the thing being matched against; the
 * candidate can be sparse.
 */
function inkDeviation(candidateSubpath, referenceSubpath) {
  const ref = sampleSubpath(referenceSubpath, 64);
  let worst = 0;
  for (const p of sampleSubpath(candidateSubpath, 16)) {
    let best = Infinity;
    for (const q of ref) best = Math.min(best, dist(p, q));
    worst = Math.max(worst, best);
  }
  return worst;
}

// ── PRIMITIVES: subdivision is visually inert ────────────────────────────────

test("subdividing a cubic does not move its ink (the whole basis of alignment)", () => {
  const tuple = [[0, 0], [30, 0], [30, 40], [0, 40]];
  for (const n of [2, 3, 5, 7]) {
    const pieces = subdivideCubic(tuple, n);
    assert.equal(pieces.length, n);
    // Each piece's sampled points must lie ON the original curve. 1e-9 because
    // partialCubic is EXACT algebra — the only error is float rounding over a
    // handful of multiplies, which lands ~1e-13 here; 1e-9 is four decades of
    // headroom and would still catch any real geometric drift.
    for (let i = 0; i < n; i++)
      for (let s = 0; s <= 4; s++) {
        const t = (i + s / 4) / n;
        assert.ok(dist(evalCubic(pieces[i], s / 4), evalCubic(tuple, t)) < 1e-9,
          `subdivision piece ${i} at s=${s} left the original curve`);
      }
  }
});

test("partialCubic's degenerate borders collapse to a single point (the null-curve source)", () => {
  const tuple = [[1, 2], [3, 4], [5, 6], [7, 8]];
  assert.deepEqual(partialCubic(tuple, 1, 1), [[7, 8], [7, 8], [7, 8], [7, 8]]);
  assert.deepEqual(partialCubic(tuple, 0, 0), [[1, 2], [1, 2], [1, 2], [1, 2]]);
});

test("winding is stated in SCREEN space: +1 is clockwise in this y-DOWN frame", () => {
  // right → down → left → up is clockwise as seen on screen when y grows downward.
  const cw = polySubpath([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(cw.winding, 1, "a y-down right/down/left/up square must read as CLOCKWISE (+1)");
  assert.equal(shoelaceWinding(reverseSubpath(cw)), -1);
  // Manim's y-UP world calls this same traversal CCW; the flip is the point.
  assert.equal(circle(0, 0, 5, true).winding, 1);
  assert.equal(circle(0, 0, 5, false).winding, -1);
});

test("reverseSubpath is an involution and preserves ink exactly", () => {
  const c = circle(50, 50, 20, true);
  const back = reverseSubpath(c);
  assert.ok(inkDeviation(back, c) < 1e-9, "reversing a subpath must not move its ink");
  const there = reverseSubpath(back);
  assert.deepEqual(there.curves, c.curves);
  assert.deepEqual(there.start, c.start);
});

test("rotateClosedSubpath preserves ink and REFUSES an open subpath", () => {
  const sq = square(0, 0, 10, 0);
  for (let k = 1; k < 4; k++) {
    const rot = rotateClosedSubpath(sq, k);
    assert.equal(rot.curves.length, sq.curves.length);
    assert.ok(inkDeviation(rot, sq) < 1e-9, `rotation by ${k} moved the ink`);
  }
  const open = polySubpath([[0, 0], [10, 0], [10, 10]], false);
  assert.throws(() => rotateClosedSubpath(open, 1), /refusing to rotate an OPEN subpath/);
});

// ── THE GEOMETRY LAW ─────────────────────────────────────────────────────────

test("a negative space is REFUSED loudly, never silently unsigned here", () => {
  const good = payload([square(0, 0, 10)], { w: 10, h: 10 });
  assert.equal(assertMorphPaths(good, "from"), undefined);
  for (const bad of [{ w: -10, h: 10 }, { w: 10, h: -10 }]) {
    assert.throws(
      () => assertMorphPaths(payload([square(0, 0, 10)], bad), "from"),
      /unsignedState-normalized/,
      "a negative extent must name the NEGATIVE EXTENTS protocol, not be quietly absorbed");
  }
});

test("a non-cubic segment is refused with a message naming the elevation the provider owes", () => {
  const bad = payload([{ start: [0, 0], curves: [[1, 2, 3, 4]], closed: false, winding: 1 }], { w: 10, h: 10 });
  assert.throws(() => assertMorphPaths(bad, "to"), /CUBIC sextuple/);
  const nan = payload([{ start: [0, 0], curves: [[1, 2, 3, 4, NaN, 6]], closed: false, winding: 1 }], { w: 10, h: 10 });
  assert.throws(() => assertMorphPaths(nan, "to"), /finite/,
    "a NaN coordinate must fail HERE, not paint an invisible path many frames later");
});

// ── IDENTITY ─────────────────────────────────────────────────────────────────

test("IDENTITY: A → A is A at every alpha, byte-exact", () => {
  const shapes = [
    payload([square(10, 10, 40)], { w: 100, h: 100 }),
    payload([circle(50, 50, 25, true)], { w: 100, h: 100 }),
    payload([circle(50, 50, 40, true), circle(50, 50, 15, false)], { w: 100, h: 100 }),
    payload([polySubpath([[0, 0], [30, 5], [10, 40]], false)], { w: 100, h: 100 }),
  ];
  for (const p of shapes) {
    const expected = normalizePayload(p);
    for (const alpha of [0.001, 0.25, 0.5, 0.75, 0.999]) {
      const out = morphPaths(p, p, alpha);
      assert.equal(out.subpaths.length, expected.subpaths.length);
      out.subpaths.forEach((sp, i) => {
        // Byte-exact: an identity morph must not perturb a single coordinate,
        // because alignment on an identical pair has nothing to do and a lerp
        // between two equal numbers is that number.
        assert.deepEqual(sp.start, expected.subpaths[i].start, `identity moved start at alpha ${alpha}`);
        assert.deepEqual(sp.curves, expected.subpaths[i].curves, `identity moved curves at alpha ${alpha}`);
        assert.equal(sp.closed, expected.subpaths[i].closed);
      });
    }
  }
});

test("IDENTITY: the alignment of A with itself is structurally A (no padding invented)", () => {
  const p = payload([circle(50, 50, 40, true), circle(50, 50, 15, false)], { w: 100, h: 100 });
  const { from, to } = alignPayloads(p, p);
  assert.equal(structureSignature(from), structureSignature(to));
  assert.equal(from.subpaths.length, 2, "aligning a shape with itself must not add subpaths");
  from.subpaths.forEach((sp, i) => {
    assert.equal(sp.curves.length, 4, "aligning a shape with itself must not add curves");
    assert.deepEqual(sp.curves, to.subpaths[i].curves);
  });
});

// ── THE ENDPOINT LAW ─────────────────────────────────────────────────────────

test("ENDPOINT: alpha 0 and alpha 1 return the endpoint payloads untouched", () => {
  const a = payload([square(0, 0, 50)], { w: 100, h: 100 });
  const b = payload([circle(50, 50, 30, true)], { w: 100, h: 100 });
  // Identity, not equality: the short-circuit means a deck that never scrubs is
  // untouched by this feature — the degenerateCapSplit identity precedent.
  assert.equal(morphPaths(a, b, 0), a);
  assert.equal(morphPaths(a, b, 1), b);
  assert.equal(morphPaths(a, b, -0.5), a, "alpha below 0 clamps to the from payload");
  assert.equal(morphPaths(a, b, 1.5), b, "alpha above 1 clamps to the to payload");
});

test("ENDPOINT: alignment changes PARAMETERIZATION but never INK", () => {
  // Every pair here differs in curve count, orientation, start vertex or subpath
  // count — i.e. every stage of alignment runs on at least one of them.
  const cases = [
    [payload([square(0, 0, 50)]), payload([circle(50, 50, 30, true)])],
    [payload([circle(50, 50, 30, true)]), payload([circle(50, 50, 30, false)])],
    [payload([square(10, 10, 30, 0)]), payload([square(10, 10, 30, 2)])],
    [payload([polySubpath([[0, 0], [60, 0], [60, 60], [0, 60]])]),
      payload([polySubpath([[10, 10], [40, 20], [30, 50]])])],
    [payload([circle(50, 50, 40, true), circle(50, 50, 20, false)]),
      payload([circle(50, 50, 35, true)])],
  ];
  for (const [a, b] of cases) {
    const { from, to } = alignPayloads(a, b);
    // Same structure slot-for-slot — that is what alignment is FOR.
    assert.equal(from.subpaths.length, to.subpaths.length);
    from.subpaths.forEach((sp, i) =>
      assert.equal(sp.curves.length, to.subpaths[i].curves.length,
        `subpath ${i} was not equalized`));

    // And each aligned subpath still draws what its source drew. Padding is
    // EXCLUDED — a degenerate stand-in has no source ink by construction, which
    // is the entire point of it. Tolerance 1e-6 of the unit box: subdivision and
    // rotation are exact algebra, so this is float noise headroom, not slack.
    for (const [src, aligned] of [[a, from], [b, to]]) {
      const srcNorm = normalizePayload(src);
      for (const sp of aligned.subpaths) {
        if (isDegenerateSubpath(sp, Math.SQRT2)) continue;
        const best = Math.min(...srcNorm.subpaths.map((o) => inkDeviation(sp, o)));
        assert.ok(best < 1e-6,
          `an aligned subpath drifted ${best} from every source subpath — alignment changed the INK`);
      }
    }
  }
});

test("ENDPOINT: a mid-morph frame lies BETWEEN the endpoints, and reaches them continuously", () => {
  const a = payload([square(0, 0, 50)]);
  const b = payload([circle(50, 50, 30, true)]);
  const near0 = morphPaths(a, b, 1e-6);
  const near1 = morphPaths(a, b, 1 - 1e-6);
  const A = normalizePayload(a), B = normalizePayload(b);
  // Continuity at the seam: the open-interval result must approach the
  // short-circuited endpoint, or the morph would VISIBLY POP on the first and
  // last frame of every transition. 1e-4 of a unit box is a sub-pixel distance
  // at any sane render size and is dominated by the 1e-6 alpha step itself.
  assert.ok(Math.min(...A.subpaths.map((o) => inkDeviation(near0.subpaths[0], o))) < 1e-4,
    "alpha→0 must approach the FROM shape, or the transition pops on its first frame");
  assert.ok(Math.min(...B.subpaths.map((o) => inkDeviation(near1.subpaths[0], o))) < 1e-4,
    "alpha→1 must approach the TO shape, or the transition pops on its last frame");
});

// ── THE START-POINT ARTIFACT (the thing Manim gets visibly wrong) ────────────

test("START POINT: a square morphing into the SAME square with a rotated start list stays STILL", () => {
  const base = square(20, 20, 60, 0);
  for (let startAt = 1; startAt < 4; startAt++) {
    const shifted = square(20, 20, 60, startAt);
    // Same ink, different parameterization — the exact situation two independently
    // authored `d` strings land in.
    assert.ok(inkDeviation(shifted, base) < 1e-9, "fixture error: the two squares must draw the same ink");
    assert.notDeepEqual(shifted.start, base.start, "fixture error: the start points must differ");

    const a = payload([base]), b = payload([shifted]);
    for (const alpha of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const mid = morphPaths(a, b, alpha).subpaths[0];
      // THE ARTIFACT: without the cyclic start search every anchor travels to the
      // corner one quarter-turn away, so at alpha 0.5 the square has shrunk into
      // a 45°-rotated diamond — a deviation of ~0.15 of the unit box. With the
      // search it is float noise. 1e-9 separates those by eight decades.
      assert.ok(inkDeviation(mid, normalizePayload(a).subpaths[0]) < 1e-9,
        `a square morphing into itself MOVED at alpha ${alpha} (start offset ${startAt}) — ` +
        `this is Manim's "the square spins 90°" artifact`);
    }
  }
});

test("START POINT: bestRotation finds the shift that re-enters the loop at the matching vertex", () => {
  const base = square(0, 0, 10, 0);
  for (let startAt = 0; startAt < 4; startAt++) {
    const shifted = square(0, 0, 10, startAt);
    const k = bestRotation(base, shifted);
    const rot = rotateClosedSubpath(shifted, k);
    assert.ok(dist(rot.start, base.start) < 1e-9,
      `rotating by ${k} did not land start on the base's start (offset ${startAt})`);
  }
  assert.equal(bestRotation(base, base), 0, "an already-aligned pair must not rotate (ties → lowest index)");
});

test("START POINT: the search is skipped for OPEN subpaths (rotating one would move its free ends)", () => {
  const open = polySubpath([[0, 0], [10, 0], [10, 10]], false);
  assert.equal(bestRotation(open, open), 0);
  const other = polySubpath([[5, 5], [20, 5], [20, 20]], false);
  assert.equal(bestRotation(other, open), 0);
});

// ── WINDING ──────────────────────────────────────────────────────────────────

test("WINDING: opposite-orientation circles morph without crumpling", () => {
  const cw = payload([circle(50, 50, 30, true)]);
  const ccw = payload([circle(50, 50, 30, false)]);
  assert.equal(cw.subpaths[0].winding, 1);
  assert.equal(ccw.subpaths[0].winding, -1);

  // These two draw the SAME circle, traversed opposite ways. A winding-blind
  // morph (Manim's) sends each point half a revolution round the rim, so the
  // circle collapses through its own centre at alpha 0.5. A reconciled morph
  // does not move at all.
  for (const alpha of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const mid = morphPaths(cw, ccw, alpha).subpaths[0];
    const dev = inkDeviation(mid, normalizePayload(cw).subpaths[0]);
    // 1e-3 of a unit box, not 1e-9: reconciliation fixes the ORIENTATION, and
    // the cyclic search then lines the start vertices up, but the two traversals
    // still sample the KAPPA arcs at mirrored parameters, so a few thousandths of
    // wobble is real and expected. The crumple it rules out is ~0.3 — two orders
    // of magnitude away, so this tolerance cannot hide the failure it exists for.
    assert.ok(dev < 1e-3,
      `a CW→CCW circle morph deviated ${dev} at alpha ${alpha} — the shape is crumpling`);
  }
});

test("WINDING: point travel is short and monotone, never the long way round", () => {
  const cw = payload([circle(50, 50, 30, true)]);
  const ccw = payload([circle(50, 50, 30, false)]);
  const start = inkOf(morphPaths(cw, ccw, 1e-9))[0];
  const end = inkOf(morphPaths(cw, ccw, 1 - 1e-9))[0];

  // THE SANITY METRIC: total travel of corresponding sample points. Under a
  // reconciled morph each point ends essentially where it began, so the total is
  // ~0. Under Manim's winding-blind morph each point walks halfway around a rim
  // of radius 0.3 (unit space), so the total is order 1. Asserting < 0.05
  // sits an order of magnitude below the failure and an order above the noise.
  let travel = 0;
  for (let i = 0; i < start.length; i++) travel += dist(start[i], end[i]);
  assert.ok(travel < 0.05,
    `corresponding points travelled ${travel} in total on a same-circle morph — ` +
    `each point is taking the long way round the rim`);

  // MONOTONE: no point may wander further from its destination than it started.
  // A crumpling morph fails this — it detours through the centre.
  for (const alpha of [0.25, 0.5, 0.75]) {
    const mid = inkOf(morphPaths(cw, ccw, alpha))[0];
    for (let i = 0; i < mid.length; i++)
      assert.ok(dist(mid[i], end[i]) <= dist(start[i], end[i]) + 1e-6,
        `sample ${i} moved AWAY from its destination at alpha ${alpha}`);
  }
});

test("WINDING: a genuine shape change still morphs, with the pair's orientations reconciled", () => {
  // Not the same shape this time — a CCW square becoming a CW circle. The point
  // is that reconciliation applies to REAL morphs, not just to the degenerate
  // same-shape case above.
  const sqCcw = payload([reverseSubpath(square(20, 20, 60, 0))]);
  const circCw = payload([circle(50, 50, 30, true)]);
  assert.equal(sqCcw.subpaths[0].winding, -1);
  const { from, to } = alignPayloads(sqCcw, circCw);
  assert.equal(from.subpaths[0].winding, to.subpaths[0].winding,
    "alignment must leave the paired subpaths agreeing on orientation");
  const mid = morphPaths(sqCcw, circCw, 0.5).subpaths[0];
  // A reconciled intermediate stays a convex-ish blob between the two: every
  // sample sits inside the square's own bounds (0.2..0.8 of the unit box) with a
  // little slack. A crumpled one shoots points across the middle and outside.
  for (const [x, y] of sampleSubpath(mid, 8)) {
    assert.ok(x > 0.15 && x < 0.85 && y > 0.15 && y < 0.85,
      `an intermediate point (${x}, ${y}) left the region both endpoints occupy`);
  }
});

// ── SUBPATH COUNT MISMATCH ───────────────────────────────────────────────────

test("SUBPATH COUNT: 2 holes → 1 hole pads with degenerates and pops at neither endpoint", () => {
  const twoHoles = payload([
    circle(50, 50, 45, true),
    circle(30, 50, 10, false),
    circle(70, 50, 10, false),
  ]);
  const oneHole = payload([
    circle(50, 50, 45, true),
    circle(50, 50, 12, false),
  ]);

  const { from, to } = alignPayloads(twoHoles, oneHole);
  assert.equal(from.subpaths.length, 3, "the padded side must gain a slot, not lose one");
  assert.equal(to.subpaths.length, 3);
  assert.equal(structureSignature(from).split("|")[0], structureSignature(to).split("|")[0]);
  from.subpaths.forEach((sp, i) =>
    assert.equal(sp.curves.length, to.subpaths[i].curves.length, `slot ${i} was not equalized`));

  // Exactly one slot on the TO side must be padding — the vanishing hole.
  const padded = to.subpaths.filter((sp) => isDegenerateSubpath(sp, Math.SQRT2) || isZeroArea(sp));
  assert.equal(padded.length, 1,
    "exactly one TO slot should be a degenerate stand-in for the hole that disappears");

  // NO POP: the padding paints nothing, so the endpoint frames draw exactly the
  // endpoints' own ink. Measured as area — a trace-and-return ribbon encloses
  // zero area by construction, which is what makes it invisible under a fill.
  assert.ok(isZeroArea(padded[0]) || isDegenerateSubpath(padded[0], Math.SQRT2),
    "padding must enclose no area, or the vanishing hole would flash a filled blob");

  // And the endpoints themselves are still the untouched payloads.
  assert.equal(morphPaths(twoHoles, oneHole, 0), twoHoles);
  assert.equal(morphPaths(twoHoles, oneHole, 1), oneHole);
});

/** Test helper. True when a subpath encloses (numerically) no area — the property
 * that makes a trace-and-return ribbon invisible under a fill. */
function isZeroArea(sp) {
  const pts = anchors(sp);
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) sum += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return Math.abs(sum / 2) < 1e-9;
}

test("SUBPATH COUNT: padding RIDES the paired contour, it does not shoot out of a dot", () => {
  // ManimCE pads with a dot at the last point of the last subpath, so a new hole
  // appears to fly in from an unrelated corner. ManimGL (and we) pad with a
  // trace-and-return on the contour, so the hole emerges from where it will live.
  const solid = payload([circle(50, 50, 40, true)]);
  const holed = payload([circle(50, 50, 40, true), circle(50, 50, 15, false)]);
  const { from } = alignPayloads(solid, holed);
  assert.equal(from.subpaths.length, 2);
  const pad = from.subpaths[1];
  // The padding sits ON the outer contour it rides, i.e. its centroid is near
  // the contour's own centre — NOT at some arbitrary last point.
  const c = centroid(pad);
  assert.ok(dist(c, [0.5, 0.5]) < 0.2,
    `padding centroid ${JSON.stringify(c)} is nowhere near the contour it should ride`);
  assert.ok(isZeroArea(pad), "trace-and-return padding must enclose no area");
});

test("SUBPATH COUNT: empty → shape blossoms from the target's OWN centroid, not the origin", () => {
  const empty = payload([], { w: 100, h: 100 });
  const shape = payload([circle(80, 20, 10, true)], { w: 100, h: 100 });
  const { from } = alignPayloads(empty, shape);
  assert.equal(from.subpaths.length, 1, "the empty side must gain a stand-in slot");
  const c = centroid(from.subpaths[0]);
  const target = centroid(normalizePayload(shape).subpaths[0]);
  assert.ok(dist(c, target) < 1e-9,
    `an empty→shape morph must grow from the target's own centroid ${JSON.stringify(target)}, got ${JSON.stringify(c)}`);
  assert.ok(dist(c, [0, 0]) > 0.5, "and specifically NOT from the origin");
});

test("SUBPATH COUNT: both sides empty is not an error and draws nothing", () => {
  const empty = payload([], { w: 100, h: 100 });
  const { from, to } = alignPayloads(empty, empty);
  assert.deepEqual(from.subpaths, []);
  assert.deepEqual(to.subpaths, []);
  assert.equal(payloadToPathD(morphPaths(empty, empty, 0.5)), "");
});

// ── OPEN ↔ CLOSED (the stated policy) ────────────────────────────────────────

test("OPEN↔CLOSED: the flag is DISCRETE at alpha > 0 while the geometry still flows", () => {
  const open = payload([polySubpath([[10, 10], [90, 10], [90, 90]], false)]);
  const closed = payload([square(10, 10, 80, 0)]);
  // The whole open interval carries the TARGET's flag — core/interpolators.js's
  // unlike-value rule, and the reason is that a `Z` JOINS the stroke and a join
  // cannot appear gradually.
  for (const alpha of [0.001, 0.5, 0.999])
    assert.equal(morphPaths(open, closed, alpha).subpaths[0].closed, true,
      `closed must snap to the target at alpha ${alpha}`);
  for (const alpha of [0.001, 0.5, 0.999])
    assert.equal(morphPaths(closed, open, alpha).subpaths[0].closed, false);
  // …and the endpoints still return their own payloads, so alpha 0 is genuinely open.
  assert.equal(morphPaths(open, closed, 0).subpaths[0].closed, false);
  // The serialized `d` reflects it — a Z is present iff the flag is.
  assert.ok(payloadToPathD(morphPaths(open, closed, 0.5)).endsWith("Z"));
  assert.ok(!payloadToPathD(morphPaths(closed, open, 0.5)).endsWith("Z"));
});

test("OPEN↔CLOSED: fillRule is discrete on the same rule and for the same reason", () => {
  const nz = payload([square(0, 0, 50)], { w: 100, h: 100 }, "nonzero");
  const eo = payload([square(0, 0, 50)], { w: 100, h: 100 }, "evenodd");
  assert.equal(morphPaths(nz, eo, 0.5).fillRule, "evenodd");
  assert.equal(morphPaths(nz, eo, 0).fillRule, "nonzero");
});

// ── DEGENERATE INPUTS ────────────────────────────────────────────────────────

test("DEGENERATE: a dot morphing into a shape replicates into one null curve per slot", () => {
  const dot = payload([{ start: [50, 50], curves: [[50, 50, 50, 50, 50, 50]], closed: true, winding: 1 }]);
  const shape = payload([circle(50, 50, 30, true)]);
  const { from, to } = alignPayloads(dot, shape);
  assert.equal(from.subpaths[0].curves.length, to.subpaths[0].curves.length);
  assert.equal(from.subpaths[0].curves.length, 4, "the dot must gain a slot per target curve");
  assert.ok(isDegenerateSubpath(from.subpaths[0], Math.SQRT2),
    "the replicated dot must still paint nothing");
  // And it BLOSSOMS: the intermediate is a shrunken target sitting on the dot,
  // not a shape that jumped somewhere else. Pinned as "halfway between the two
  // centroids", which is what an elementwise lerp of a dot and a shape must
  // give. (The target's ANCHOR centroid is not its geometric centre — the anchor
  // list starts and ends on the same vertex, so that vertex counts twice — which
  // is why this compares against the lerped value rather than against [0.5, 0.5].)
  const mid = morphPaths(dot, shape, 0.5).subpaths[0];
  const dotC = centroid(from.subpaths[0]), shapeC = centroid(to.subpaths[0]);
  const expected = [(dotC[0] + shapeC[0]) / 2, (dotC[1] + shapeC[1]) / 2];
  assert.ok(dist(centroid(mid), expected) < 1e-9,
    `the blossom must sit halfway between the dot and the target, expected ${JSON.stringify(expected)}`);
  // …and it must still be ON the dot's side of the target, i.e. shrunken toward it.
  const extentAt = (sp) => Math.max(...sampleSubpath(sp, 8).map((p) => dist(p, centroid(sp))));
  assert.ok(extentAt(mid) < extentAt(to.subpaths[0]),
    "a half-blossomed shape must be smaller than the fully-grown target");
});

test("DEGENERATE: a zero-curve subpath is padded rather than crashing", () => {
  const bare = payload([{ start: [25, 25], curves: [], closed: false, winding: 1 }]);
  const shape = payload([square(0, 0, 50)]);
  const { from, to } = alignPayloads(bare, shape);
  assert.equal(from.subpaths[0].curves.length, to.subpaths[0].curves.length);
  assert.ok(from.subpaths[0].curves.length > 0, "a zero-curve subpath must gain slots, not stay empty");
  assert.ok(Number.isFinite(morphPaths(bare, shape, 0.5).subpaths[0].curves[0][0]));
});

test("DEGENERATE: padding is never chosen for subdivision (the ManimGL zero-score guard)", () => {
  // One real curve and three null ones. Every insertion must land on the real
  // curve — splitting a null curve wastes the slot and starves the real one.
  const sp = {
    start: [0, 0], closed: false, winding: 1,
    curves: [[10, 0, 20, 0, 30, 0], [30, 0, 30, 0, 30, 0], [30, 0, 30, 0, 30, 0]],
  };
  const grown = insertCurves(sp, 3, 100);
  assert.equal(grown.curves.length, 6);
  // The real curve became four pieces; the two nulls stayed one each.
  const realPieces = grown.curves.filter((c) => Math.abs(c[4] - 30) > 1e-9 || Math.abs(c[5]) > 1e-9);
  assert.equal(realPieces.length, 3,
    "all three insertions should have subdivided the ONE curve that has length");
});

// ── STRUCTURE-AWARE FAST-OUT (the Manim bug we do not reproduce) ─────────────

test("FAST-OUT: equal point count is NOT equivalence — structure is compared, never a raw count", () => {
  // Two payloads with the SAME total curve count (4) and completely different
  // subpath structure. Manim's `align_points` would return early here and lerp
  // mismatched subpaths together; our signature catches it.
  const oneQuad = payload([square(0, 0, 50, 0)]);                       // 1 subpath, 4 curves
  const twoPairs = payload([                                            // 2 subpaths, 2 curves each
    polySubpath([[0, 0], [50, 0]], true),
    polySubpath([[0, 50], [50, 50]], true),
  ]);
  const countOf = (p) => p.subpaths.reduce((n, sp) => n + sp.curves.length, 0);
  assert.equal(countOf(oneQuad), 4);
  assert.equal(countOf(twoPairs), 4, "fixture error: the point counts must MATCH for this test to mean anything");
  assert.notEqual(structureSignature(normalizePayload(oneQuad)), structureSignature(normalizePayload(twoPairs)),
    "identical curve counts with different subpath structure must NOT signature-match");

  const { from, to } = alignPayloads(oneQuad, twoPairs);
  assert.equal(from.subpaths.length, to.subpaths.length, "alignment must reconcile the structure, not skip");
  assert.equal(from.subpaths.length, 2);
  from.subpaths.forEach((sp, i) =>
    assert.equal(sp.curves.length, to.subpaths[i].curves.length));
});

// ── PAIRING ──────────────────────────────────────────────────────────────────

test("PAIRING: biggest goes to biggest, independent of authoring order", () => {
  const big = circle(50, 50, 40, true);
  const small = circle(50, 50, 10, false);
  // The SAME two contours, authored in both orders. The pairing must not care.
  const forward = pairSubpaths([big, small], [big, small]);
  const reversed = pairSubpaths([big, small], [small, big]);
  const bigPairForward = forward.find((p) => p[0] === 0);
  const bigPairReversed = reversed.find((p) => p[0] === 0);
  assert.equal(bigPairForward[1], 0, "big should pair with big when authored first");
  assert.equal(bigPairReversed[1], 1, "big should STILL pair with big when authored second");
});

test("PAIRING: a hole prefers a hole (winding is a strong hint, not a veto)", () => {
  const outer = circle(50, 50, 40, true);
  const hole = circle(50, 50, 15, false);
  const otherOuter = circle(50, 50, 38, true);
  const otherHole = circle(50, 50, 17, false);
  const pairs = pairSubpaths([outer, hole], [otherOuter, otherHole]);
  assert.deepEqual(pairs.sort((a, b) => a[0] - b[0]), [[0, 0], [1, 1]],
    "the outer contour and the hole must each find their own kind");
});

test("PAIRING: unequal counts leave exactly the surplus unmatched", () => {
  const a = [circle(50, 50, 40, true), circle(30, 50, 8, false), circle(70, 50, 8, false)];
  const b = [circle(50, 50, 40, true)];
  const pairs = pairSubpaths(a, b);
  assert.equal(pairs.length, 3);
  assert.equal(pairs.filter((p) => p[1] === null).length, 2, "two FROM subpaths should be unmatched");
  assert.equal(pairs.filter((p) => p[0] === null).length, 0);
});

// ── DETERMINISM AND THE CACHE ────────────────────────────────────────────────

test("DETERMINISM: the same inputs produce identical output arrays, twice", () => {
  const a = payload([circle(50, 50, 40, true), circle(50, 50, 15, false)]);
  const b = payload([square(10, 10, 70, 2), polySubpath([[40, 40], [60, 40], [50, 60]])]);
  for (const alpha of [0.13, 0.5, 0.87]) {
    const first = morphPaths(a, b, alpha);
    const second = morphPaths(a, b, alpha);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  }
});

test("DETERMINISM: the cache is an OPTIMIZATION — cold and warm results are identical", () => {
  const a = payload([circle(50, 50, 40, true), circle(50, 50, 15, false)]);
  const b = payload([square(10, 10, 70, 1)]);
  clearMorphCache();
  const cold = JSON.stringify(morphPaths(a, b, 0.42));
  const warm = JSON.stringify(morphPaths(a, b, 0.42));
  clearMorphCache();
  const coldAgain = JSON.stringify(morphPaths(a, b, 0.42));
  assert.equal(cold, warm, "a warm cache must not change a single coordinate");
  assert.equal(cold, coldAgain, "clearing the cache must be a performance event, never a visual one");
});

test("DETERMINISM: the cache key is CONTENT, not identity — an equal-valued copy hits", () => {
  clearMorphCache();
  const a = payload([square(0, 0, 50)]);
  const b = payload([circle(50, 50, 30, true)]);
  const copyA = JSON.parse(JSON.stringify(a));
  const copyB = JSON.parse(JSON.stringify(b));
  assert.notEqual(a, copyA, "fixture error: these must be different objects");
  assert.equal(payloadKey(a), payloadKey(copyA));
  // A distinct object with equal content must reuse the alignment — the whole
  // reason the memo can exist at all without breaking the shuffle-of-time law.
  assert.equal(alignedPair(a, b), alignedPair(copyA, copyB));
});

test("DETERMINISM: alignment reads nothing but its two payloads (no item, slide or time)", () => {
  // The property-state proof, mechanically: render the same pair in a scrambled
  // alpha order and against an unrelated interleaved morph. Every frame must
  // match the frame computed in isolation.
  const a = payload([circle(50, 50, 30, true)]);
  const b = payload([square(0, 0, 60, 3)]);
  const noise = [payload([polySubpath([[0, 0], [9, 1], [4, 8]])]), payload([circle(10, 10, 4, false)])];

  const alphas = [0.9, 0.1, 0.55, 0.33, 0.77, 0.02];
  const isolated = alphas.map((t) => { clearMorphCache(); return JSON.stringify(morphPaths(a, b, t)); });

  const interleaved = alphas.map((t, i) => {
    morphPaths(noise[0], noise[1], (i + 1) / 10); // unrelated work between frames
    return JSON.stringify(morphPaths(a, b, t));
  });
  assert.deepEqual(interleaved, isolated,
    "a frame changed depending on what was rendered before it — the morph is not property state");
});

// ── SERIALIZATION ────────────────────────────────────────────────────────────

test("SERIALIZATION: a morphed payload becomes a `d` string the existing path op takes", () => {
  const a = payload([square(0, 0, 50)]);
  const b = payload([circle(50, 50, 30, true)]);
  const d = payloadToPathD(morphPaths(a, b, 0.5));
  assert.match(d, /^M[-\d.]+ [-\d.]+C/, "must start with a moveto followed by cubics");
  assert.ok(d.endsWith("Z"), "a closed morph must serialize its Z");
  assert.ok(!/[AQLHVS]/.test(d), "the output must be CUBICS ONLY — every backend requires it");
  assert.ok(!/NaN|undefined|Infinity/.test(d), "a coordinate must never serialize as a non-number");
});

test("SERIALIZATION: multi-subpath output concatenates, one M per subpath", () => {
  const a = payload([circle(50, 50, 40, true), circle(50, 50, 15, false)]);
  const d = payloadToPathD(morphPaths(a, a, 0.5));
  assert.equal((d.match(/M/g) || []).length, 2);
});

// ── HELPERS THE ABOVE LEAN ON (pinned so a failure above is never their fault) ─

test("HELPERS: resampleAnchors returns the requested count for any curve count", () => {
  for (const n of [1, 2, 4, 7]) {
    const sp = polySubpath(Array.from({ length: n + 1 }, (_, i) => [i * 3, i * i]), false);
    for (const count of [4, 16, 32])
      assert.equal(resampleAnchors(sp, count).length, count);
  }
  // A zero-curve subpath still answers, with its own start repeated.
  assert.deepEqual(resampleAnchors({ start: [2, 3], curves: [], closed: false }, 3), [[2, 3], [2, 3], [2, 3]]);
});

test("HELPERS: curveTuple reconstructs the shared anchor from the previous curve", () => {
  const sp = polySubpath([[0, 0], [10, 0], [10, 10]], false);
  assert.deepEqual(curveTuple(sp, 0)[0], [0, 0]);
  assert.deepEqual(curveTuple(sp, 1)[0], curveTuple(sp, 0)[3],
    "curve i must begin exactly where curve i-1 ended — the un-duplicated shared anchor");
});

test("HELPERS: subpathToPathD round-trips through the number formatter without NaN", () => {
  const d = subpathToPathD(circle(50, 50, 30, true));
  assert.match(d, /^M/);
  assert.ok(d.endsWith("Z"));
  assert.ok(!/NaN/.test(d));
});

console.log(`\n${passed} morph tests passed`);
