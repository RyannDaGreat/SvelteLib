/**
 * Align/mirror geometry tests (manifest 16.3 OBJECT ALIGNMENT + MIRROR
 * COMMANDS) — plain node, no framework (SvelteLib has none), mirroring the
 * doctests in core/geometry.js plus the invariants the task specifically
 * calls out: 3 items align-left → all share the min-x edge; align-center-h
 * → all centered; mirror-h → positions reflected about the selection
 * center, relative ORDER preserved along the untouched axis / reversed
 * along the mirrored axis (a reflection, not a shuffle).
 *
 * Run: node src/demo_apps/PowerRP/tests/align_mirror_test.js
 */
import assert from "node:assert/strict";
import { unionRect, alignedCoord, alignedPosition, mirroredPosition } from "../core/geometry.js";

let n = 0;
const test = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };
const eq = (a, b) => assert.deepEqual(a, b);
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── unionRect ────────────────────────────────────────────────────────────────
test("unionRect: collective AABB of a multi-selection", () => {
  eq(unionRect([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }]), { x: 0, y: 0, w: 30, h: 15 });
  eq(unionRect([{ x: 5, y: 5, w: 10, h: 10 }]), { x: 5, y: 5, w: 10, h: 10 });
});

// ── alignedCoord / alignedPosition ─────────────────────────────────────────────
test("alignedCoord: min/max/center edges of a [lo,hi] span", () => {
  assert.equal(alignedCoord(10, 40, 20, "min"), 10);
  assert.equal(alignedCoord(10, 40, 20, "max"), 20);
  assert.equal(alignedCoord(0, 30, 10, "center"), 10);
});
test("alignedPosition: untouched axis passes through unchanged", () => {
  eq(alignedPosition({ x: 5, y: 5, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 50 }, "x", "min"), { x: 0, y: 5 });
  eq(alignedPosition({ x: 5, y: 5, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 50 }, "x", "max"), { x: 90, y: 5 });
  eq(alignedPosition({ x: 5, y: 5, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 50 }, "y", "center"), { x: 5, y: 20 });
});

test("align-left: 3 items with different x/w all land on the selection's min-x edge", () => {
  const items = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 40, y: 5, w: 30, h: 10 },
    { id: "c", x: 25, y: 9, w: 5, h: 10 },
  ];
  const union = unionRect(items);
  const aligned = items.map((it) => ({ id: it.id, ...alignedPosition(it, union, "x", "min") }));
  const leftEdges = new Set(aligned.map((a) => a.x));
  assert.equal(leftEdges.size, 1, "every item's left edge (x) must be identical after align-left");
  assert.equal([...leftEdges][0], union.x);
  // y (the untouched axis) is unchanged.
  aligned.forEach((a, i) => assert.equal(a.y, items[i].y));
});

test("align-right: 3 items all land on the selection's max-x edge (x + w constant)", () => {
  const items = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 40, y: 5, w: 30, h: 10 },
    { id: "c", x: 25, y: 9, w: 5, h: 10 },
  ];
  const union = unionRect(items);
  const aligned = items.map((it) => ({ ...it, ...alignedPosition(it, union, "x", "max") }));
  const rightEdges = new Set(aligned.map((a) => a.x + a.w));
  assert.equal(rightEdges.size, 1, "every item's right edge (x+w) must be identical after align-right");
  approx([...rightEdges][0], union.x + union.w);
});

test("align-center-h: 3 items all share the same horizontal center", () => {
  const items = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 40, y: 5, w: 30, h: 10 },
    { id: "c", x: 25, y: 9, w: 5, h: 10 },
  ];
  const union = unionRect(items);
  const aligned = items.map((it) => ({ ...it, ...alignedPosition(it, union, "x", "center") }));
  const centers = aligned.map((a) => a.x + a.w / 2);
  centers.forEach((c) => approx(c, union.x + union.w / 2));
});

test("align-top / align-bottom / align-center-v: same invariants on the y axis", () => {
  const items = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 5, y: 30, w: 10, h: 40 },
    { id: "c", x: 9, y: 15, w: 10, h: 5 },
  ];
  const union = unionRect(items);
  const top = items.map((it) => ({ ...it, ...alignedPosition(it, union, "y", "min") }));
  assert.equal(new Set(top.map((a) => a.y)).size, 1);
  const bottom = items.map((it) => ({ ...it, ...alignedPosition(it, union, "y", "max") }));
  const bottomEdges = new Set(bottom.map((a) => Math.round((a.y + a.h) * 1e9) / 1e9));
  assert.equal(bottomEdges.size, 1);
  const center = items.map((it) => ({ ...it, ...alignedPosition(it, union, "y", "center") }));
  center.forEach((a) => approx(a.y + a.h / 2, union.y + union.h / 2));
});

// ── mirroredPosition ───────────────────────────────────────────────────────────
test("mirroredPosition: reflects position about the selection center, keeps size", () => {
  eq(mirroredPosition({ x: 0, y: 5, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 50 }, "x"), { x: 90, y: 5 });
  eq(mirroredPosition({ x: 45, y: 5, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 50 }, "x"), { x: 45, y: 5 }); // centered item is its own mirror
  eq(mirroredPosition({ x: 5, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 50 }, "y"), { x: 5, y: 40 });
});

test("mirror-horizontal: 3 items reflect about the selection center, ORDER REVERSES on x", () => {
  const union = { x: 0, y: 0, w: 100, h: 50 };
  const items = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 40, y: 0, w: 10, h: 10 },
    { id: "c", x: 80, y: 0, w: 10, h: 10 },
  ];
  const mirrored = items.map((it) => ({ id: it.id, ...mirroredPosition(it, union, "x") }));
  // a reflection about the center REVERSES left-to-right order: a (was
  // leftmost) is now rightmost, c (was rightmost) is now leftmost.
  assert.ok(mirrored[0].x > mirrored[1].x && mirrored[1].x > mirrored[2].x);
  eq(mirrored, [{ id: "a", x: 90, y: 0 }, { id: "b", x: 50, y: 0 }, { id: "c", x: 10, y: 0 }]);
  // y untouched by a horizontal mirror.
  mirrored.forEach((m, i) => assert.equal(m.y, items[i].y));
});

test("mirror-vertical: same reflection invariant on y, x untouched", () => {
  const union = { x: 0, y: 0, w: 50, h: 100 };
  const items = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 0, y: 40, w: 10, h: 10 },
    { id: "c", x: 0, y: 80, w: 10, h: 10 },
  ];
  const mirrored = items.map((it) => ({ id: it.id, ...mirroredPosition(it, union, "y") }));
  assert.ok(mirrored[0].y > mirrored[1].y && mirrored[1].y > mirrored[2].y);
  mirrored.forEach((m, i) => assert.equal(m.x, items[i].x));
});

test("mirror is an involution: mirroring twice returns the original position", () => {
  const union = { x: 3, y: -7, w: 120, h: 64 };
  const box = { x: 17, y: 5, w: 23, h: 9 };
  const once = mirroredPosition(box, union, "x");
  const twice = mirroredPosition({ ...box, x: once.x, y: once.y }, union, "x");
  approx(twice.x, box.x);
  approx(twice.y, box.y);
});

console.log(`\n${n} tests passed`);
