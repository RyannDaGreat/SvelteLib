/**
 * core/outline.js tests — the parameterized-geometry substrate (bare node,
 * no framework — suite conventions). Covers the outline value type's math
 * (area/containment/triangulation) and generator #1, the Figures-library
 * fancy arrow (refs/Figures/arrow/arrow.py `_arrow_contours`).
 */

import assert from "node:assert/strict";
import {
  signedArea, pointInPolygon, distToSegment, triangulated, fancyArrowOutline,
  closestPointOnRoundedRect, donutOutline,
  elbowRoute, elbowHandle, bezierControlFromBend, quadraticBezierPoint, curvedArrowPolyline,
  axisNormalFrame, projectOntoAxis, projectOntoNormal,
  closestPointOnCircle, nearestPairCircleCircle, nearestRimPair, NEAREST_PAIR_MAX_ITERS,
} from "../core/outline.js";

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
// roundedRectAnchorPoint's block lived here. The helper is GONE (W4-L, todo
// #253): rect / cropbox / codeblock each called it to slide their corner anchors
// onto a rounded rim, and all three retired those copies when THE INK RULE made
// the projection universal (core/derive.js withInkAnchors). What it asserted is
// not lost — tests/anchor_ink_test.js section 4 pins that a rounded rect's
// corners still slide, through the general rule, at the same coordinates.

// ── donutOutline (GENERATOR #2: the DONUT widget's annulus) ──────────────────

test("donutOutline: area matches the annulus formula π(R²−r²) within tessellation error", () => {
  const pts = donutOutline({ cx: 0, cy: 0, outerR: 10, inner: 0.5 });
  const expected = Math.PI * (100 - 25); // R=10, r=5
  // 64-gon approximation of a circle underestimates area slightly (inscribed
  // polygon) — 1% tolerance comfortably covers the discretization error.
  approx(Math.abs(signedArea(pts)), expected, expected * 0.01);
});

test("donutOutline: triangulates cleanly (simple polygon via the winding-reversed slit) and area partitions exactly", () => {
  const pts = donutOutline({ cx: 0, cy: 0, outerR: 10, inner: 0.5 });
  const tris = triangulated(pts);
  approx(totalArea(tris), Math.abs(signedArea(pts)));
});

test("donutOutline: the hole is really empty (center outside) and the ring band is filled", () => {
  const pts = donutOutline({ cx: 0, cy: 0, outerR: 10, inner: 0.5 });
  // Off-axis (45°) query points avoid the zero-width slit lying on angle 0,
  // which is a ray-casting edge case for any point exactly on the seam axis.
  const at = (r) => [r * Math.SQRT1_2, r * Math.SQRT1_2];
  assert.equal(pointInPolygon(pts, ...at(0)), false, "center is the hole");
  assert.equal(pointInPolygon(pts, ...at(2)), false, "inside the hole (r=2 < inner 5)");
  assert.equal(pointInPolygon(pts, ...at(7.5)), true, "in the ring band (5 < r=7.5 < 10)");
  assert.equal(pointInPolygon(pts, ...at(12)), false, "outside the outer rim");
});

test("donutOutline: inner=0 degenerates to a filled disk (full area, no hole)", () => {
  const pts = donutOutline({ cx: 0, cy: 0, outerR: 10, inner: 0 });
  approx(Math.abs(signedArea(pts)), Math.PI * 100, Math.PI * 100 * 0.01);
  const tris = triangulated(pts);
  approx(totalArea(tris), Math.abs(signedArea(pts)));
});

test("donutOutline: inner clamps below 1 (near-zero ring band, never a zero-area polygon)", () => {
  const pts = donutOutline({ cx: 0, cy: 0, outerR: 10, inner: 1 });
  assert.ok(Math.abs(signedArea(pts)) > 0, "still has SOME fill area (clamped strictly below 1)");
  assert.ok(Math.abs(signedArea(pts)) < Math.PI * 5, "but a thin band (clamped very close to 1)");
});

test("donutOutline: zero outer radius → [] (no geometry, matches fancyArrowOutline's zero-length convention)", () => {
  assert.deepEqual(donutOutline({ cx: 5, cy: 5, outerR: 0, inner: 0.5 }), []);
});

test("donutOutline: triangulates at an off-origin center with a thick ring (regression — a symmetric 64-gon annulus centered away from the origin used to hit an EXACT-collinearity knife-edge in triangulated()'s ear-clipping that a mathematically-identical origin-centered construction did not; fixed by donutOutline's own per-vertex angular jitter, not by weakening triangulated())", () => {
  // The exact reproduction: cx=cy=55, outerR=55, inner=0.15 (a small hole)
  // used to throw "no ear found" at 69 vertices remaining, while the
  // byte-different-but-mathematically-identical cx=cy=0 construction
  // triangulated fine — a pure floating-point-path artifact, not a real
  // self-intersection (independently verified: zero segment crossings).
  for (const [cx, cy] of [[0, 0], [55, 55], [460, 200], [-300, 5000]]) {
    const pts = donutOutline({ cx, cy, outerR: 55, inner: 0.15 });
    const tris = triangulated(pts);
    approx(totalArea(tris), Math.abs(signedArea(pts)), Math.abs(signedArea(pts)) * 1e-6);
  }
});

// ── axisNormalFrame / projectOntoAxis / projectOntoNormal (GENERATOR #3/#4
//    shared decomposition) ───────────────────────────────────────────────────

test("axisNormalFrame: unit axis + right normal + length, for axis-aligned segments", () => {
  // nx is IEEE -0 for a horizontal axis (-uy where uy is +0) — mathematically
  // 0 (-0 === 0 is true in JS), just not Object.is-identical to +0, so this
  // compares values with == rather than assert.deepEqual's stricter Object.is.
  const h = axisNormalFrame({ x: 0, y: 0 }, { x: 100, y: 0 });
  approx(h.ux, 1); approx(h.uy, 0); approx(h.nx, 0); approx(h.ny, 1); approx(h.length, 100);
  assert.deepEqual(axisNormalFrame({ x: 0, y: 0 }, { x: 0, y: 100 }), { ux: 0, uy: 1, nx: -1, ny: 0, length: 100 });
});

test("axisNormalFrame: degenerate (coincident points) falls back to +x, length 0", () => {
  assert.deepEqual(axisNormalFrame({ x: 5, y: 5 }, { x: 5, y: 5 }), { ux: 1, uy: 0, nx: 0, ny: 1, length: 0 });
});

test("projectOntoAxis / projectOntoNormal: decompose a point into (axial, normal) coordinates", () => {
  const a = { x: 0, y: 0 };
  const frame = axisNormalFrame(a, { x: 100, y: 0 });
  assert.equal(projectOntoAxis(a, frame, { x: 30, y: 5 }), 30);
  assert.equal(projectOntoNormal(a, frame, { x: 30, y: 5 }), 5);
});

// ── elbowRoute / elbowHandle (GENERATOR #3: the ELBOW arrow's H-V-H route) ──

test("elbowRoute: H-V-H 4-point polyline, mid-segment at the elbow proportion", () => {
  assert.deepEqual(elbowRoute({ x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5 }), [[0, 0], [50, 0], [50, 50], [100, 50]]);
});

test("elbowRoute: elbow 0/1 degenerate to a flush L, still a valid 4-point polyline", () => {
  assert.deepEqual(elbowRoute({ x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0 }), [[0, 0], [0, 0], [0, 50], [100, 50]]);
  assert.deepEqual(elbowRoute({ x0: 0, y0: 0, x1: 100, y1: 50, elbow: 1 }), [[0, 0], [100, 0], [100, 50], [100, 50]]);
});

test("elbowRoute: out-of-range elbow clamps to [0, 1]", () => {
  assert.deepEqual(elbowRoute({ x0: 0, y0: 0, x1: 100, y1: 50, elbow: -1 }), elbowRoute({ x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0 }));
  assert.deepEqual(elbowRoute({ x0: 0, y0: 0, x1: 100, y1: 50, elbow: 2 }), elbowRoute({ x0: 0, y0: 0, x1: 100, y1: 50, elbow: 1 }));
});

test("elbowRoute: level span (y0 === y1) is still a valid route — the vertical run has zero length", () => {
  const route = elbowRoute({ x0: 0, y0: 20, x1: 100, y1: 20, elbow: 0.5 });
  assert.deepEqual(route, [[0, 20], [50, 20], [50, 20], [100, 20]]);
  assert.equal(triangulated([...route, route[0]]).length, 0); // zero-area — confirms it's genuinely a flat line, not a real ear
});

test("elbowHandle: sits at the mid-segment's x, at the vertical run's own midpoint y", () => {
  assert.deepEqual(elbowHandle({ x0: 0, y0: 0, x1: 100, y1: 50, elbow: 0.5 }), { x: 50, y: 25 });
  assert.deepEqual(elbowHandle({ x0: 0, y0: 10, x1: 100, y1: 90, elbow: 0.25 }), { x: 25, y: 50 });
});

// ── bezierControlFromBend / quadraticBezierPoint / curvedArrowPolyline
//    (GENERATOR #4: the CURVED arrow's quadratic bezier) ────────────────────

test("bezierControlFromBend: perpendicular offset proportional to span, right-normal sign convention", () => {
  assert.deepEqual(bezierControlFromBend({ x0: 0, y0: 0, x1: 100, y1: 0, bend: 0.3 }), { x: 50, y: 30 });
  assert.deepEqual(bezierControlFromBend({ x0: 0, y0: 0, x1: 100, y1: 0, bend: -0.3 }), { x: 50, y: -30 });
  assert.deepEqual(bezierControlFromBend({ x0: 0, y0: 0, x1: 100, y1: 0, bend: 0 }), { x: 50, y: 0 });
});

test("bezierControlFromBend: coincident endpoints fall back to the shared point (no defined axis)", () => {
  assert.deepEqual(bezierControlFromBend({ x0: 5, y0: 5, x1: 5, y1: 5, bend: 0.5 }), { x: 5, y: 5 });
});

test("quadraticBezierPoint: endpoints at t=0/1, De Casteljau midpoint at t=0.5", () => {
  const p0 = { x: 0, y: 0 }, c = { x: 50, y: 100 }, p1 = { x: 100, y: 0 };
  assert.deepEqual(quadraticBezierPoint(p0, c, p1, 0), p0);
  assert.deepEqual(quadraticBezierPoint(p0, c, p1, 1), p1);
  assert.deepEqual(quadraticBezierPoint(p0, c, p1, 0.5), { x: 50, y: 50 });
});

test("curvedArrowPolyline: CURVE_SEGMENTS+1 samples, straight (bend=0) midpoint sample is the geometric midpoint", () => {
  const pts = curvedArrowPolyline({ x0: 0, y0: 0, x1: 100, y1: 0, bend: 0 });
  assert.equal(pts.length, 33);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[32], { x: 100, y: 0 });
  assert.deepEqual(pts[16], { x: 50, y: 0 });
});

test("curvedArrowPolyline: bent curve's samples actually leave the straight line (not a degenerate straight polyline)", () => {
  const pts = curvedArrowPolyline({ x0: 0, y0: 0, x1: 100, y1: 0, bend: 0.3 });
  assert.ok(Math.abs(pts[16].y) > 1, `midpoint sample should be well off the straight line, got y=${pts[16].y}`);
  // Monotonically increases then decreases toward the control-point side (single bump, no wiggle) —
  // a sanity check that sampling a quadratic bezier produces a smooth single-lobe curve.
  const ys = pts.map((p) => p.y);
  const maxIdx = ys.indexOf(Math.max(...ys));
  assert.ok(maxIdx > 0 && maxIdx < ys.length - 1, "peak is strictly interior, not at an endpoint");
});

test("curvedArrowPolyline round-trips through bezierControlFromBend's own inversion (the modifier point's apply() math)", () => {
  // Same derivation fancy_arrow.js's modifier points use: recover `bend` from
  // the curve's t=0.5 sample by projecting it onto the perpendicular axis.
  const params = { x0: 10, y0: 20, x1: 210, y1: 20, bend: 0.4 };
  const pts = curvedArrowPolyline(params);
  const mid = pts[16]; // t=0.5 sample (index CURVE_SEGMENTS/2 for CURVE_SEGMENTS=32)
  const { nx, ny, length } = axisNormalFrame({ x: params.x0, y: params.y0 }, { x: params.x1, y: params.y1 });
  const mx = (params.x0 + params.x1) / 2, my = (params.y0 + params.y1) / 2;
  const offset = (mid.x - mx) * nx + (mid.y - my) * ny;
  approx((offset * 2) / length, 0.4);
});

// ── Dynamic-anchor rim solvers (Opus24) ──────────────────────────────────────
test("closestPointOnCircle: radial projection + center degeneracy", () => {
  assert.deepEqual(closestPointOnCircle({ x: 0, y: 0 }, 10, 100, 0), { x: 10, y: 0 });
  assert.deepEqual(closestPointOnCircle({ x: 0, y: 0 }, 5, 3, 4), { x: 3, y: 4 }); // point already at radius 5
  assert.deepEqual(closestPointOnCircle({ x: 2, y: 3 }, 7, 2, 3), { x: 9, y: 3 }); // query AT center → +x rim
});
test("nearestPairCircleCircle: closed-form facing points on the center line", () => {
  assert.deepEqual(nearestPairCircleCircle({ x: 0, y: 0 }, 10, { x: 100, y: 0 }, 20), { a: { x: 10, y: 0 }, b: { x: 80, y: 0 } });
  assert.deepEqual(nearestPairCircleCircle({ x: 0, y: 0 }, 10, { x: 0, y: 50 }, 10), { a: { x: 0, y: 10 }, b: { x: 0, y: 40 } });
  assert.deepEqual(nearestPairCircleCircle({ x: 5, y: 5 }, 3, { x: 5, y: 5 }, 4), { a: { x: 8, y: 5 }, b: { x: 1, y: 5 } }); // concentric → +x fallback
  // The pair are the two points minimizing inter-rim distance (both on the line
  // through the centers); verify each sits at its own radius from its center.
  const p = nearestPairCircleCircle({ x: 10, y: 20 }, 15, { x: 200, y: 90 }, 40);
  approx(Math.hypot(p.a.x - 10, p.a.y - 20), 15);
  approx(Math.hypot(p.b.x - 200, p.b.y - 90), 40);
});
test("nearestRimPair: generic solver matches the circle/circle closed form", () => {
  const cA = { x: 0, y: 0 }, rA = 50, cB = { x: 200, y: 0 }, rB = 50;
  const g = nearestRimPair((x, y) => closestPointOnCircle(cA, rA, x, y), (x, y) => closestPointOnCircle(cB, rB, x, y),
    { seedA: { x: rA, y: 0 }, seedB: { x: cB.x - rB, y: 0 } });
  const closed = nearestPairCircleCircle(cA, rA, cB, rB);
  approx(g.a.x, closed.a.x, 1e-6); approx(g.a.y, closed.a.y, 1e-6);
  approx(g.b.x, closed.b.x, 1e-6); approx(g.b.y, closed.b.y, 1e-6);
  assert.ok(g.converged);
  assert.ok(g.iters <= NEAREST_PAIR_MAX_ITERS);
});
test("nearestRimPair: NEAR-TANGENT converges fast (the old fixpoint's worst case)", () => {
  // 1px gap between two 50-radius circles — the geometry the OLD Gauss-Seidel
  // fixpoint needed ~82 sweeps for. Alternating projection onto the true rim
  // converges in a handful of iterations (projects to the boundary each step).
  const g = nearestRimPair(
    (x, y) => closestPointOnCircle({ x: 0, y: 0 }, 50, x, y),
    (x, y) => closestPointOnCircle({ x: 101, y: 0 }, 50, x, y),
    { seedA: { x: 50, y: 0 }, seedB: { x: 51, y: 0 } });
  assert.ok(g.converged, "converged under the cap");
  assert.ok(g.iters < 10, `fast convergence (got ${g.iters} iters)`);
  approx(g.a.x, 50, 1e-3); approx(g.b.x, 51, 1e-3);
});

console.log(`\n${passed} outline tests passed`);
