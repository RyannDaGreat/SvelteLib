/**
 * Tests for the preset shape adjust-handle machinery
 * (core/pptx/preset_handles.js): parsing `ahLst`, computing handle positions,
 * and inverting a drag back into adjustment value(s). Bare node, no
 * framework (SvelteLib has none), same style as tests/pptx_geometry_test.js.
 * Run:
 *   node src/demo_apps/PowerRP/tests/pptx_preset_handles_test.js
 *
 * Requires the vendored preset table to exist first:
 *   node src/demo_apps/PowerRP/tests/pptx_dev/vendor_preset_shapes.mjs
 *
 * Assertions are NUMERIC (hand-computed against the shape's own gdLst
 * formulas, not just "the call didn't throw") — the mission brief's own
 * standard, restated in tests/pptx_geometry_test.js's header and applied here
 * to the inverse problem: a handle whose position LOOKS right but whose drag
 * inverts to the wrong adjustment is a worse failure than a visible crash,
 * because it would silently mis-edit an imported PowerPoint shape.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installPresetDefs, foldGuides, resolveArg } from "../core/pptx/preset_geometry.js";
import {
  parseAhLst, handlePosition, handlePositions, adjFromHandleDrag,
  resolveHandleBound, adjustableGuideNames, solveAdjForGuide, solveAngleForGuide,
  angularDelta, normalizeAngle60000,
} from "../core/pptx/preset_handles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defsPath = path.join(__dirname, "..", "core", "pptx", "preset_shape_defs.json");
const raw = JSON.parse(readFileSync(defsPath, "utf8"));
const DEFS = raw.shapes;
installPresetDefs(DEFS);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-4, msg = "") {
  assert.ok(Math.abs(a - b) < eps, `${msg} ${a} !~ ${b} (eps ${eps})`.trim());
}

// ─────────────────────────────────────────────────────────────────────────
// parseAhLst — structural parsing, including the two data shapes that broke
// a naive first pass: min/max as GUIDE NAMES (not always numeric literals),
// and a shape with NO ahLst at all.
// ─────────────────────────────────────────────────────────────────────────

test("parseAhLst: null/empty -> []", () => {
  assert.deepEqual(parseAhLst(null), []);
  assert.deepEqual(parseAhLst(undefined), []);
  assert.deepEqual(parseAhLst(""), []);
  assert.deepEqual(parseAhLst("   "), []);
});

test("parseAhLst: rect (no adjust handles) -> []", () => {
  assert.deepEqual(parseAhLst(DEFS.rect.ahLst), []);
});

test("parseAhLst: roundRect -> one ahXY, numeric-literal bounds as strings", () => {
  const hs = parseAhLst(DEFS.roundRect.ahLst);
  assert.equal(hs.length, 1);
  assert.deepEqual(hs[0], { kind: "xy", posX: "x1", posY: "t", gdRefX: "adj", minX: "0", maxX: "50000" });
});

test("parseAhLst: rightArrow -> two ahXY, one gdRefY-only + one gdRefX-only, GUIDE-NAME bound (maxAdj2)", () => {
  const hs = parseAhLst(DEFS.rightArrow.ahLst);
  assert.equal(hs.length, 2);
  assert.equal(hs[0].gdRefY, "adj1");
  assert.equal(hs[0].gdRefX, undefined);
  assert.equal(hs[1].gdRefX, "adj2");
  assert.equal(hs[1].maxX, "maxAdj2"); // a GUIDE NAME, not a literal — the module's first bug
});

test("parseAhLst: pie -> two ahPolar, gdRefAng only", () => {
  const hs = parseAhLst(DEFS.pie.ahLst);
  assert.equal(hs.length, 2);
  assert.equal(hs[0].kind, "polar");
  assert.equal(hs[0].gdRefAng, "adj1");
  assert.equal(hs[0].gdRefR, undefined);
});

test("parseAhLst: blockArc -> second handle carries BOTH gdRefR and gdRefAng", () => {
  const hs = parseAhLst(DEFS.blockArc.ahLst);
  assert.equal(hs.length, 2);
  assert.equal(hs[1].gdRefR, "adj3");
  assert.equal(hs[1].gdRefAng, "adj2");
  assert.equal(hs[1].maxR, "50000");
});

test("parseAhLst: malformed <ahXY> with neither gdRefX nor gdRefY throws", () => {
  assert.throws(() => parseAhLst('<ahXY><pos x="a" y="b"/></ahXY>'), /neither gdRefX nor gdRefY/);
});

test("parseAhLst: <pos> missing throws", () => {
  assert.throws(() => parseAhLst('<ahXY gdRefX="adj" minX="0" maxX="1"/>'), /no <pos> child/);
});

test("parseAhLst: unknown handle element throws", () => {
  assert.throws(() => parseAhLst('<ahWat gdRefX="adj"><pos x="a" y="b"/></ahWat>'), /unknown adjust-handle element/);
});

// ─────────────────────────────────────────────────────────────────────────
// CATALOG SWEEP — every one of the 187 vendored shapes, every one of their
// handle instances. This is the module's own honesty check: it must parse
// every shape with no error, compute a position for every handle, and
// (grab-then-release) invert a drag to the handle's OWN CURRENT position
// with negligible round-trip error. Real counts are asserted, not estimated.
// ─────────────────────────────────────────────────────────────────────────

test("catalog sweep: 187 shapes total, coverage counts match the vendored table", () => {
  const names = Object.keys(DEFS);
  assert.equal(names.length, 187);
  let shapesWithHandles = 0, totalHandleInstances = 0;
  for (const name of names) {
    const hs = parseAhLst(DEFS[name].ahLst);
    if (hs.length > 0) { shapesWithHandles++; totalHandleInstances += hs.length; }
  }
  // These are the REAL, MEASURED counts (not estimates) — 120 of 187 preset
  // shapes carry at least one adjust handle, 243 handle instances total
  // (220 ahXY + 23 ahPolar). A change to the vendored table that adds or
  // removes a handle should change these numbers deliberately, not silently.
  assert.equal(shapesWithHandles, 120);
  assert.equal(totalHandleInstances, 243);
});

test("catalog sweep: every shape parses, positions, and round-trips a self-drag with negligible error", () => {
  const W = 240, H = 180; // a non-square box on purpose — catches any hc/vc vs hd2/wd2 axis mixup
  let checked = 0;
  for (const name of Object.keys(DEFS)) {
    const handles = parseAhLst(DEFS[name].ahLst);
    if (handles.length === 0) continue;
    const positions = handlePositions(name, {}, W, H, DEFS);
    for (const p of positions) {
      const newAdj = adjFromHandleDrag(name, p.id, p.x, p.y, {}, W, H, DEFS);
      const newPos = handlePositions(name, newAdj, W, H, DEFS).find((q) => q.id === p.id);
      const dist = Math.hypot(newPos.x - p.x, newPos.y - p.y);
      assert.ok(dist < 0.01, `${name}/${p.id}: drag-to-self round-trip error ${dist} (orig ${JSON.stringify(p)}, new ${JSON.stringify(newPos)})`);
      checked++;
    }
  }
  assert.equal(checked, 243, "every handle instance was exercised");
});

// ─────────────────────────────────────────────────────────────────────────
// roundRect — 1 handle, corner radius (ahXY, single axis, literal bounds).
// Hand-computed against roundRect's own gdLst: a = pin(0,adj,50000),
// x1 = ss*a/100000, pos = (x1, t=0). ss = min(w,h).
// ─────────────────────────────────────────────────────────────────────────

test("roundRect: handle position at default adj=16667, box 200x100 (ss=100)", () => {
  const pos = handlePositions("roundRect", {}, 200, 100, DEFS);
  assert.equal(pos.length, 1);
  approx(pos[0].x, (100 * 16667) / 100000); // 16.667
  approx(pos[0].y, 0);
});

test("roundRect: drag to x=50 (half the short side) solves adj=50000 (the declared max)", () => {
  // x1 = ss*adj/100000 = 100*adj/100000 = 50  =>  adj = 50000
  const adj = adjFromHandleDrag("roundRect", "h0", 50, 0, {}, 200, 100, DEFS);
  assert.equal(adj.adj, 50000);
});

test("roundRect: drag to x=25 solves adj=25000 (midpoint, exact affine check)", () => {
  const adj = adjFromHandleDrag("roundRect", "h0", 25, 0, {}, 200, 100, DEFS);
  approx(adj.adj, 25000, 0.01);
  const pos = handlePositions("roundRect", adj, 200, 100, DEFS);
  approx(pos[0].x, 25, 0.001);
});

test("roundRect: CLAMPING — drag far beyond the box clamps to max declared adj, never throws", () => {
  assert.deepEqual(adjFromHandleDrag("roundRect", "h0", 9999, 0, {}, 200, 100, DEFS), { adj: 50000 });
});

test("roundRect: CLAMPING — drag to a large negative x clamps to min declared adj (0)", () => {
  assert.deepEqual(adjFromHandleDrag("roundRect", "h0", -9999, 0, {}, 200, 100, DEFS), { adj: 0 });
});

test("roundRect: unknown handle id throws", () => {
  assert.throws(() => adjFromHandleDrag("roundRect", "h5", 0, 0, {}, 200, 100, DEFS), /unknown handle id/);
  assert.throws(() => adjFromHandleDrag("roundRect", "bogus", 0, 0, {}, 200, 100, DEFS), /unknown handle id/);
});

test("unknown preset shape name throws (handlePositions and adjFromHandleDrag)", () => {
  assert.throws(() => handlePositions("not_a_real_shape", {}, 100, 100, DEFS), /unknown preset shape/);
  assert.throws(() => adjFromHandleDrag("not_a_real_shape", "h0", 0, 0, {}, 100, 100, DEFS), /unknown preset shape/);
});

// ─────────────────────────────────────────────────────────────────────────
// pie / arc — 2 polar handles, start/sweep angle (via adj1=start, adj2=end,
// both ahPolar gdRefAng-only, full-turn declared range). Hand-computed: pos
// = center + (ss/2)*(cos ang, sin ang) at the shape's OWN start/end angle
// guides (x1,y1 / x2,y2), which for `pie` reduce to angle = adj DIRECTLY.
// ─────────────────────────────────────────────────────────────────────────

test("pie: default handle positions (adj1=0 -> 3 o'clock, adj2=16200000=270deg -> 12 o'clock)", () => {
  const pos = handlePositions("pie", {}, 200, 200, DEFS);
  assert.equal(pos.length, 2);
  approx(pos[0].x, 200); approx(pos[0].y, 100); // adj1=0deg: rightmost point
  approx(pos[1].x, 100); approx(pos[1].y, 0);   // adj2=270deg: topmost point
});

test("pie: drag start handle to 3 o'clock is a no-op (adj1 stays 0)", () => {
  const adj = adjFromHandleDrag("pie", "h0", 200, 100, {}, 200, 200, DEFS);
  approx(adj.adj1, 0, 1);
});

test("pie: drag start handle to 45deg direction solves adj1=2700000 (45deg in 60,000ths)", () => {
  const adj = adjFromHandleDrag("pie", "h0", 100 + 50 * Math.cos(Math.PI / 4), 100 + 50 * Math.sin(Math.PI / 4), {}, 200, 200, DEFS);
  approx(adj.adj1, 2700000, 10);
});

test("pie: drag end handle to 12 o'clock solves adj2=16200000 (270deg)", () => {
  const adj = adjFromHandleDrag("pie", "h1", 100, 0, {}, 200, 200, DEFS);
  approx(adj.adj2, 16200000, 10);
});

test("pie: drag end handle to 6 o'clock solves adj2=5400000 (90deg)", () => {
  const adj = adjFromHandleDrag("pie", "h1", 100, 200, {}, 200, 200, DEFS);
  approx(adj.adj2, 5400000, 10);
});

test("blockArc: default second handle (radius+angle) matches hand-computed dx/dy=cat2/sat2(radius,cos,sin)", () => {
  // adj1=stAng=10800000(180deg), adj2=istAng=0, adj3=25000(thickness ratio).
  // Second handle: gdRefR=adj3 (0..50000), gdRefAng=adj2 (0..21599999), pos=(x2,y2).
  // x2 = hc + dx2, dx2 = cat2(iwd2, cos(istAng), sin(istAng)) with istAng=adj2=0 -> dx2=iwd2, dy2=0.
  // iwd2 = wd2 - ss*a3/100000 = 100 - 200*25000/100000 = 100-50 = 50 (box 200x200, wd2=100, ss=200).
  const pos = handlePositions("blockArc", {}, 200, 200, DEFS);
  approx(pos[1].x, 100 + 50); // hc + iwd2
  approx(pos[1].y, 100);
});

test("blockArc: drag second handle to a known 45deg/40-unit point solves BOTH adj2 (angle) and adj3 (radius)", () => {
  const cx = 100, cy = 100, r = 40, ang = Math.PI / 4;
  const target = { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) };
  const adj = adjFromHandleDrag("blockArc", "h1", target.x, target.y, {}, 200, 200, DEFS);
  approx(adj.adj2, 2700000, 10); // 45deg in 60,000ths
  // iwd2 = wd2 - ss*a3/100000 = 40  =>  ss*a3/100000 = wd2-40 = 100-40 = 60  =>  a3 = 60*100000/200 = 30000
  approx(adj.adj3, 30000, 5);
  const pos = handlePositions("blockArc", adj, 200, 200, DEFS);
  approx(pos[1].x, target.x, 0.01);
  approx(pos[1].y, target.y, 0.01);
});

// ─────────────────────────────────────────────────────────────────────────
// rightArrow — a "block arrow" family member: 2 ahXY handles, shaft
// thickness (adj1, gdRefY-only) and head length (adj2, gdRefX-only, GUIDE-
// NAME bound maxAdj2). Hand-computed against rightArrow's own gdLst.
// ─────────────────────────────────────────────────────────────────────────

test("rightArrow: default handle positions, box 200x100", () => {
  // maxAdj2 = 100000*w/ss = 100000*200/100 = 200000; a2=pin(0,50000,200000)=50000
  // dx1 = ss*a2/100000 = 100*50000/100000 = 50; x1 = r - dx1 = 200-50 = 150
  // dy1 = h*a1/200000 = 100*50000/200000 = 25; y1 = vc-dy1 = 50-25 = 25
  const pos = handlePositions("rightArrow", {}, 200, 100, DEFS);
  assert.equal(pos.length, 2);
  approx(pos[0].x, 0); approx(pos[0].y, 25);   // shaft-thickness handle: pos=(l, y1)
  approx(pos[1].x, 150); approx(pos[1].y, 0);  // head-length handle: pos=(x1, t)
});

test("rightArrow: drag shaft-thickness handle solves adj1 (gdRefY-only, other axis ignored)", () => {
  // y1 = vc - h*adj1/200000 = 0  =>  adj1 = 200000*vc/h = 200000*50/100 = 100000 (declared max)
  const adj = adjFromHandleDrag("rightArrow", "h0", 999 /* x ignored: no gdRefX on this handle */, 0, {}, 200, 100, DEFS);
  approx(adj.adj1, 100000, 1);
  assert.equal(adj.adj2, undefined, "the OTHER handle's guide is untouched by this drag");
});

test("rightArrow: drag head-length handle solves adj2 against the GUIDE-NAME bound maxAdj2", () => {
  // x1 = r - ss*adj2/100000 = 100  =>  ss*adj2/100000 = 100  =>  adj2 = 100*100000/100 = 100000
  // declared maxX is "maxAdj2" = 100000*w/ss = 200000, so 100000 is within range, not clamped.
  const adj = adjFromHandleDrag("rightArrow", "h1", 100, 0, {}, 200, 100, DEFS);
  approx(adj.adj2, 100000, 1);
});

test("rightArrow: CLAMPING against the guide-name bound maxAdj2 (not a literal)", () => {
  // Dragging the head handle to x=-500 (deep negative) should clamp adj2 at its
  // GUIDE-NAME-declared max (maxAdj2=200000 for this box), proving the bound
  // was actually resolved through the guide table rather than read as NaN.
  const adj = adjFromHandleDrag("rightArrow", "h1", -500, 0, {}, 200, 100, DEFS);
  approx(adj.adj2, 200000, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// star5 — 1 handle, point/inner-notch depth (ahXY, gdRefY-only, x pinned at hc).
// ─────────────────────────────────────────────────────────────────────────

test("star5: default handle position, box 200x200", () => {
  const pos = handlePositions("star5", {}, 200, 200, DEFS);
  assert.equal(pos.length, 1);
  approx(pos[0].x, 100); // pinned at hc regardless of adj — no gdRefX on this handle
});

test("star5: drag handle DOWN (toward the rim) DECREASES adj, matching its own gdLst (yAdj = svc - ihd2, ihd2 grows with adj)", () => {
  // star5's gdLst: yAdj = svc - ihd2, and ihd2 = shd2*a/50000 grows with adj — so
  // a LARGER y (the handle dragged further down/toward the rim) means yAdj rose,
  // which means ihd2 FELL, which means adj FELL. This is the inverse of what a
  // naive "handle position increases with adj" guess would assume, and is
  // exactly the kind of per-shape sign this module must get right by reading the
  // real formula rather than assuming a direction.
  const defaultY = handlePositions("star5", {}, 200, 200, DEFS)[0].y;
  const before = adjFromHandleDrag("star5", "h0", 100, defaultY, {}, 200, 200, DEFS).adj;
  const adj = adjFromHandleDrag("star5", "h0", 100, 90, {}, 200, 200, DEFS);
  assert.ok(Number.isFinite(adj.adj));
  assert.ok(adj.adj < before, `dragging DOWN (y=90 > default y=${defaultY.toFixed(2)}) should LOWER adj below its default reading (${before}), got ${adj.adj}`);
  const after = handlePositions("star5", adj, 200, 200, DEFS)[0];
  approx(after.y, 90, 0.01);
});

test("star5: unknown handle id throws (only h0 exists)", () => {
  assert.throws(() => adjFromHandleDrag("star5", "h1", 0, 0, {}, 200, 200, DEFS), /unknown handle id/);
});

// ─────────────────────────────────────────────────────────────────────────
// solveAdjForGuide / solveAngleForGuide — the primitives directly, including
// the flat-guide throw and the periodic full-turn robustness (the module's
// second measured bug: a naive per-sample angularDelta bracket check false-
// positives at the +-180deg branch cut on a full-turn range).
// ─────────────────────────────────────────────────────────────────────────

test("solveAdjForGuide: exact affine solve", () => {
  assert.equal(solveAdjForGuide("adj", 0, 50000, 25, (a) => a / 1000, 16667), 25000);
});

test("solveAdjForGuide: zero-width range KEEPS the held value, no solve attempted", () => {
  assert.equal(solveAdjForGuide("adj", 10, 10, 999, (a) => a, 10), 10);
});

test("solveAdjForGuide: target past the reachable range CLAMPS, never throws", () => {
  assert.equal(solveAdjForGuide("adj", 0, 50000, 999999, (a) => a / 1000, 16667), 50000);
  assert.equal(solveAdjForGuide("adj", 0, 50000, -999999, (a) => a / 1000, 16667), 0);
});

test("solveAdjForGuide: a FLAT guide (pos does not depend on this adj) throws loudly", () => {
  assert.throws(() => solveAdjForGuide("adj", 0, 100, 5, () => 42, 10), /FLAT across its declared range/);
});

test("solveAdjForGuide: a decreasing (negatively-sloped) guide still solves correctly", () => {
  // readGuide(a) = 100 - a/1000; at a=50000, guide=50. Solve for guide=75 -> a=25000.
  const result = solveAdjForGuide("adj", 0, 100000, 75, (a) => 100 - a / 1000, 50000);
  approx(result, 25000, 0.01);
});

test("angularDelta: shortest signed turn, wraparound-safe", () => {
  assert.equal(angularDelta(0, 5400000), 5400000); // 0deg -> 90deg
  assert.equal(angularDelta(21000000, 1200000), 1800000); // 350deg -> 20deg the SHORT way is +30deg
  assert.equal(angularDelta(16200000, 16200000), 0);
});

test("normalizeAngle60000: wraps into [0, 360deg)", () => {
  assert.equal(normalizeAngle60000(-5400000), 16200000); // -90deg -> 270deg
  assert.equal(normalizeAngle60000(27000000), 5400000);  // 390deg -> 30deg
});

test("solveAngleForGuide: direct angle-is-the-adj case (pie-like)", () => {
  const center = { x: 100, y: 100 };
  const readPoint = (a) => ({ x: 100 + 100 * Math.cos((a * Math.PI) / 10800000), y: 100 + 100 * Math.sin((a * Math.PI) / 10800000) });
  const result = solveAngleForGuide("adj1", 0, 21599999, 0, readPoint, center, 0);
  approx(result, 0, 1);
});

test("solveAngleForGuide: FULL-TURN range with target at the range's MIDPOINT heading (the branch-cut regression)", () => {
  // Regression for the module's second measured bug: bisecting per-sample
  // angularDelta independently found a spurious sign flip at the +-180deg
  // seam and solved this to ~90deg instead of 270deg. The fix (unwrapping
  // before bisecting) must land exactly on 270deg (16200000).
  const center = { x: 100, y: 100 };
  const readPoint = (a) => ({ x: 100 + 100 * Math.cos((a * Math.PI) / 10800000), y: 100 + 100 * Math.sin((a * Math.PI) / 10800000) });
  const targetAngle = 16200000; // 270deg = 12 o'clock in this y-down frame (sin(270deg)=-1... see readPoint's own convention)
  const result = solveAngleForGuide("adj1", 0, 21599999, targetAngle, readPoint, center, 0);
  approx(result, targetAngle, 1);
  const p = readPoint(result);
  approx(p.x, 100, 0.01);
  approx(p.y, 0, 0.01);
});

test("solveAngleForGuide: an OFFSET angle guide (circularArrow-shaped: adj is added to a fixed base, not the raw heading)", () => {
  // Models circularArrow's ptAng = enAng + adj2 pattern directly: the point's
  // heading is (baseAngle + a), so solving for a given a target heading must
  // subtract the base, not equate a to the heading.
  const center = { x: 0, y: 0 };
  const baseAngleDeg = 40;
  const readPoint = (a) => {
    const totalDeg = baseAngleDeg + a / 60000;
    return { x: 50 * Math.cos((totalDeg * Math.PI) / 180), y: 50 * Math.sin((totalDeg * Math.PI) / 180) };
  };
  // Want the point at heading 100deg -> a should be (100-40)*60000 = 3600000
  const targetAngle = Math.round(100 * 60000);
  const result = solveAngleForGuide("adj2", 0, 21599999, targetAngle, readPoint, center, 0);
  approx(result, 3600000, 10);
});

test("solveAngleForGuide: zero-width range KEEPS the held value", () => {
  assert.equal(solveAngleForGuide("adj", 5, 5, 999, () => ({ x: 1, y: 1 }), { x: 0, y: 0 }, 5), 5);
});

test("solveAngleForGuide: a FLAT heading (pos does not depend on this adj) throws loudly", () => {
  assert.throws(
    () => solveAngleForGuide("adj", 0, 21599999, 5400000, () => ({ x: 10, y: 0 }), { x: 0, y: 0 }, 0),
    /FLAT across its declared range/
  );
});

// ─────────────────────────────────────────────────────────────────────────
// resolveHandleBound / adjustableGuideNames — the small pure helpers.
// ─────────────────────────────────────────────────────────────────────────

test("resolveHandleBound: literal, guide-name, and absent tokens", () => {
  assert.equal(resolveHandleBound(undefined, new Map()), undefined);
  assert.equal(resolveHandleBound("50000", new Map()), 50000);
  assert.equal(resolveHandleBound("maxAdj2", new Map([["maxAdj2", 33333]])), 33333);
});

test("adjustableGuideNames: dedupes across handles, preserves first-seen order", () => {
  const hs = [
    { kind: "xy", gdRefX: "adj1" },
    { kind: "xy", gdRefY: "adj1" },
    { kind: "polar", gdRefAng: "adj2" },
  ];
  assert.deepEqual(adjustableGuideNames(hs), ["adj1", "adj2"]);
});

test("adjustableGuideNames: real shape (rightArrow) -> [adj1, adj2] in declaration order", () => {
  assert.deepEqual(adjustableGuideNames(parseAhLst(DEFS.rightArrow.ahLst)), ["adj1", "adj2"]);
});

// ─────────────────────────────────────────────────────────────────────────
// handlePosition — the single-handle primitive `handlePositions` is built on.
// ─────────────────────────────────────────────────────────────────────────

test("handlePosition: matches the shape's own foldGuides/resolveArg reading directly", () => {
  const handle = parseAhLst(DEFS.roundRect.ahLst)[0];
  const p = handlePosition(handle, DEFS.roundRect, {}, 200, 100);
  const guides = foldGuides(DEFS.roundRect.avLst, {}, DEFS.roundRect.gdLst, 200, 100);
  approx(p.x, resolveArg("x1", guides));
  approx(p.y, resolveArg("t", guides));
});

console.log(`\n${passed} passed`);
