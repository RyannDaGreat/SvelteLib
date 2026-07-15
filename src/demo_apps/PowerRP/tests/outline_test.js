/**
 * core/outline.js tests — the parameterized-geometry substrate (bare node,
 * no framework — suite conventions). Covers the outline value type's math
 * (area/containment/triangulation) and generator #1, the Figures-library
 * fancy arrow (refs/Figures/arrow/arrow.py `_arrow_contours`).
 */

import assert from "node:assert/strict";
import { signedArea, pointInPolygon, distToSegment, triangulated, fancyArrowOutline, closestPointOnRoundedRect, roundedRectAnchorPoint } from "../core/outline.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}
function approxArr(a, b, eps = 1e-9) {
  assert.equal(a.length, b.length, `${a} !~ ${b}`);
  a.forEach((v, i) => approx(v, b[i], eps));
}

/** Sum of unsigned triangle areas — for the partition-of-area property. */
const totalArea = (tris) => tris.reduce((sum, t) => sum + Math.abs(signedArea(t)), 0);

// The Figures-library reference params (arrow.py defaults; tip_width 15
// per-side ≡ tipWidth 30 full) on a horizontal 100px arrow.
const REF = { x0: 0, y0: 0, x1: 100, y1: 0, tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5 };

test("signedArea: winding sign, magnitude, degenerate zero", () => {
  assert.equal(signedArea([[0, 0], [1, 0], [1, 1], [0, 1]]), 1);
  assert.equal(signedArea([[0, 0], [0, 1], [1, 1], [1, 0]]), -1);
  assert.equal(signedArea([[0, 0], [5, 0], [10, 0]]), 0);
});

test("pointInPolygon: square + concave dart (dimple notch is OUTSIDE)", () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon(square, 5, 5), true);
  assert.equal(pointInPolygon(square, 15, 5), false);
  const dart = [[0, 0], [4, 2], [0, 4], [1, 2]]; // concave at (1,2)
  assert.equal(pointInPolygon(dart, 0.6, 2.1), false); // in the notch
  assert.equal(pointInPolygon(dart, 2, 2.1), true); // in the body
});

test("distToSegment (moved from plugins/arrow.js)", () => {
  assert.equal(distToSegment(0, 5, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(distToSegment(-3, 0, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(distToSegment(5, 0, { x: 2, y: 0 }, { x: 2, y: 0 }), 3); // degenerate segment = point
});

test("triangulated: convex square → 2 triangles, area preserved", () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const tris = triangulated(square);
  assert.equal(tris.length, 2);
  approx(totalArea(tris), 100);
});

test("triangulated: concave dart (the arrowhead case) → 2 triangles, area preserved", () => {
  const dart = [[0, 0], [4, 2], [0, 4], [1, 2]];
  const tris = triangulated(dart);
  assert.equal(tris.length, 2);
  approx(totalArea(tris), Math.abs(signedArea(dart))); // == 6
  approx(totalArea(tris), 6);
});

test("triangulated: concave L-shape → 4 triangles, area preserved, winding-independent", () => {
  const L = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
  const tris = triangulated(L);
  assert.equal(tris.length, 4);
  approx(totalArea(tris), 75);
  const reversed = triangulated([...L].reverse());
  assert.equal(reversed.length, 4);
  approx(totalArea(reversed), 75);
});

test("triangulated: degenerate zero-area input → [] (nothing to fill, no throw)", () => {
  assert.deepEqual(triangulated([[0, 0], [5, 0], [10, 0]]), []);
  assert.deepEqual(triangulated([[0, 0], [5, 0]]), []);
  assert.deepEqual(triangulated([]), []);
});

test("fancyArrowOutline: exact port of arrow.py _arrow_contours `full`", () => {
  const pts = fancyArrowOutline(REF);
  // [dimpleL, startL, startR, dimpleR, barbR, tip, barbL] — hand-derived from
  // the Python formulas (axis +x, right normal +y):
  approxArr(pts[0], [90, -2.5]); // dimpleL: tip - axis·(L-D), - normal·endWidth/2
  approxArr(pts[1], [0, -1.5]); // startL
  approxArr(pts[2], [0, 1.5]); // startR
  approxArr(pts[3], [90, 2.5]); // dimpleR
  approxArr(pts[4], [85, 15]); // barbR: tip - axis·L + normal·tipWidth/2
  approxArr(pts[5], [100, 0]); // tip
  approxArr(pts[6], [85, -15]); // barbL
});

test("fancyArrowOutline: rotation-covariant (same shape pointing +y)", () => {
  const pts = fancyArrowOutline({ ...REF, x1: 0, y1: 100 });
  approxArr(pts[5], [0, 100]); // tip
  approxArr(pts[4], [-15, 85]); // barbR (right normal now -x)
  approxArr(pts[6], [15, 85]); // barbL
  approxArr(pts[1], [1.5, 0]); // startL
});

test("fancyArrowOutline: outline area matches the shaft+head decomposition (497.5)", () => {
  // Shaft trapezoid (widths 3→5 over 90px) = 360; head pentagon = 137.5.
  const pts = fancyArrowOutline(REF);
  approx(Math.abs(signedArea(pts)), 497.5);
  const tris = triangulated(pts);
  assert.equal(tris.length, 5); // 7 vertices, simple → n-2
  approx(totalArea(tris), 497.5); // triangulation partitions the outline exactly
});

test("fancyArrowOutline: zero-length arrow → null (the skia_draw_arrow precedent)", () => {
  assert.equal(fancyArrowOutline({ ...REF, x1: 0, y1: 0 }), null);
});

test("fancyArrowOutline domain clamps keep the outline simple + triangulatable", () => {
  // Dimple scrubbed past its bound: clamps to L·(1 − halfEnd/halfTip) = 12.5,
  // putting the shaft junction exactly ON the head's back edges.
  const deep = fancyArrowOutline({ ...REF, tipDimple: 999 });
  approxArr(deep[3], [97.5, 2.5]); // dimpleR on the barbR→tip edge (x+y=100)
  const deepTris = triangulated(deep);
  approx(totalArea(deepTris), Math.abs(signedArea(deep)));
  // Head scrubbed past the arrow length: clamps to the arrow length.
  const long = fancyArrowOutline({ ...REF, tipLength: 999 });
  approxArr(long[4], [0, 15]); // barbR at the tail
  approx(totalArea(triangulated(long)), Math.abs(signedArea(long)));
  // Negative params floor at 0.
  const floored = fancyArrowOutline({ ...REF, tipDimple: -5, startWidth: -1 });
  approxArr(floored[1], [0, 0]); // startL == start (width 0)
  approx(totalArea(triangulated(floored)), Math.abs(signedArea(floored)));
});

test("fancyArrowOutline: zero-width degenerates triangulate cleanly (duplicate vertices dropped)", () => {
  // startWidth 0 duplicates the tail vertex — the collinear/zero-area ear
  // rule absorbs it; area is still exactly the outline's.
  const pts = fancyArrowOutline({ ...REF, startWidth: 0 });
  const tris = triangulated(pts);
  approx(totalArea(tris), Math.abs(signedArea(pts)));
  assert.ok(tris.length >= 4);
  // All widths 0: a pure line — nothing to fill, no throw.
  const line = fancyArrowOutline({ ...REF, tipWidth: 0, startWidth: 0, endWidth: 0 });
  assert.deepEqual(triangulated(line), []);
});

// ── Rounded-rect rim (Round 12 bug: anchors on the rounded rim, not the
//    square bbox corner) ───────────────────────────────────────────────────────
const ON_RIM_R = 30, RW = 200, RH = 120;
/** Distance of a point from the rounded-rect rim (arcs at the corners). */
function distFromRoundedRim(w, h, r, px, py) {
  const c = closestPointOnRoundedRect(w, h, r, px, py);
  return Math.hypot(px - c.x, py - c.y);
}
test("closestPointOnRoundedRect: corner query lands on the 45° arc rim, not the square corner", () => {
  const c = closestPointOnRoundedRect(RW, RH, ON_RIM_R, RW, 0); // square tr corner
  const cx = RW - ON_RIM_R, cy = ON_RIM_R; // tr arc center
  approx(c.x, cx + ON_RIM_R / Math.SQRT2);
  approx(c.y, cy - ON_RIM_R / Math.SQRT2);
  // It really is ON the arc (radius r from the arc center).
  approx(Math.hypot(c.x - cx, c.y - cy), ON_RIM_R);
});
test("closestPointOnRoundedRect: edge midpoints and external points", () => {
  assert.deepEqual(closestPointOnRoundedRect(RW, RH, ON_RIM_R, 100, 0), { x: 100, y: 0 }); // top edge
  assert.deepEqual(closestPointOnRoundedRect(RW, RH, ON_RIM_R, 0, 60), { x: 0, y: 60 }); // left edge
  // External point past the tr corner → on the tr arc (radius r from center).
  const ext = closestPointOnRoundedRect(RW, RH, ON_RIM_R, 400, -100);
  approx(Math.hypot(ext.x - (RW - ON_RIM_R), ext.y - ON_RIM_R), ON_RIM_R);
});
test("closestPointOnRoundedRect: r=0 equals the square border; r clamps to min/2", () => {
  assert.deepEqual(closestPointOnRoundedRect(RW, RH, 0, 250, 60), { x: RW, y: 60 });
  assert.deepEqual(closestPointOnRoundedRect(10, 10, 0, 25, 5), { x: 10, y: 5 }); // matches closestPointOnRectBorder
  // Huge radius clamps to a stadium/circle (min(w,h)/2 = 5): corner query on the arc.
  const c = closestPointOnRoundedRect(10, 10, 999, 10, 0);
  approx(Math.hypot(c.x - 5, c.y - 5), 5); // radius 5 from center (5,5)
});
test("closestPointOnRoundedRect: INTERIOR point projects to the nearest straight edge", () => {
  // (100,60) is the rect center-ish; nearest edge is top (y=0) at 60 vs sides.
  const c = closestPointOnRoundedRect(RW, RH, ON_RIM_R, 100, 50);
  assert.deepEqual(c, { x: 100, y: 0 }); // 50 to top edge (nearest), stays on straight edge
});
test("roundedRectAnchorPoint: corners slide to the rim, edges/center stay, r=0 is square", () => {
  // Corner tr → arc rim; the square corner is 12.43px (r·(√2−1)) away.
  const tr = roundedRectAnchorPoint(RW, RH, ON_RIM_R, "tr", RW, 0);
  approx(distFromRoundedRim(RW, RH, ON_RIM_R, tr.x, tr.y), 0); // ON the rim
  approx(Math.hypot(tr.x - RW, tr.y - 0), ON_RIM_R * (Math.SQRT2 - 1)); // pulled in
  // Edge midpoint unchanged.
  assert.deepEqual(roundedRectAnchorPoint(RW, RH, ON_RIM_R, "tm", 100, 0), { x: 100, y: 0 });
  assert.deepEqual(roundedRectAnchorPoint(RW, RH, ON_RIM_R, "cm", 100, 60), { x: 100, y: 60 });
  // r=0 → the square corner verbatim.
  assert.deepEqual(roundedRectAnchorPoint(RW, RH, 0, "tr", RW, 0), { x: RW, y: 0 });
});

console.log(`\n${passed} outline tests passed`);
