/**
 * Snap round 2 core tests — the NEW pure functions in core/snap.js:
 * solveEdgeSnap (1D resize edge→line snapping) and sizeMatches (Figma-style
 * matching-dimension query). Plain node, no framework (SvelteLib has none),
 * same shape as core_test.js. The core being DOM-free is itself under test:
 * any window/document reference in core/ would crash this file.
 * Run: node src/demo_apps/PowerRP/tests/snap2_test.js
 */
import assert from "node:assert/strict";
import { solveEdgeSnap, sizeMatches, solveSnap } from "../core/snap.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}

// A vertical infinite line at x=X (direction dy=1) and horizontal at y=Y.
const vline = (x, id) => ({ kind: "line", x, y: 0, dx: 0, dy: 1, id });
const hline = (y, id) => ({ kind: "line", x: 0, y, dx: 1, dy: 0, id });

// ── solveEdgeSnap ─────────────────────────────────────────────────────────────
test("solveEdgeSnap: x-edge snaps onto a vertical line within tol", () => {
  const r = solveEdgeSnap([{ axis: "x", pos: 97 }], [vline(100, "e")], 5);
  approx(r.dx, 3); // 97 → 100
  approx(r.dy, 0);
  assert.equal(r.guides.length, 1);
  assert.equal(r.guides[0].kind, "line");
  approx(r.guides[0].x, 100);
});

test("solveEdgeSnap: y-edge snaps onto a horizontal line", () => {
  const r = solveEdgeSnap([{ axis: "y", pos: 204 }], [hline(200, "e")], 8);
  approx(r.dx, 0);
  approx(r.dy, -4); // 204 → 200
  assert.equal(r.guides.length, 1);
});

test("solveEdgeSnap: out of tolerance → no correction, no guides", () => {
  const r = solveEdgeSnap([{ axis: "x", pos: 80 }], [vline(100, "e")], 5);
  approx(r.dx, 0);
  approx(r.dy, 0);
  assert.equal(r.guides.length, 0);
});

test("solveEdgeSnap: an x-edge ignores horizontal lines (perpendicularity)", () => {
  // A horizontal line near an x-edge's position must NOT snap it in x.
  const r = solveEdgeSnap([{ axis: "x", pos: 100 }], [hline(100, "h")], 5);
  approx(r.dx, 0);
  assert.equal(r.guides.length, 0);
});

test("solveEdgeSnap: nearest vertical line wins among several", () => {
  const r = solveEdgeSnap([{ axis: "x", pos: 98 }], [vline(100, "a"), vline(95, "b")], 5);
  approx(r.dx, 2); // 100 (dist 2) beats 95 (dist 3)
});

test("solveEdgeSnap: snap-to-BOTH lights every aligned line as a guide", () => {
  // Two coincident vertical lines at x=100 (e.g. another node's left edge and
  // a third node's center) both light up once the edge lands on 100.
  const r = solveEdgeSnap([{ axis: "x", pos: 97 }], [vline(100, "a"), vline(100, "b")], 5);
  approx(r.dx, 3);
  assert.equal(r.guides.length, 2); // both aligned lines rendered
});

test("solveEdgeSnap: independent x and y edges each snap on their own axis", () => {
  const r = solveEdgeSnap(
    [{ axis: "x", pos: 102 }, { axis: "y", pos: 199 }],
    [vline(100, "vx"), hline(200, "hy")], 5,
  );
  approx(r.dx, -2); // 102 → 100
  approx(r.dy, 1); //  199 → 200
  assert.equal(r.guides.length, 2);
});

test("solveEdgeSnap: purity — inputs untouched", () => {
  const edges = [{ axis: "x", pos: 97 }];
  const feats = [vline(100, "e")];
  const edgesCopy = JSON.parse(JSON.stringify(edges));
  const featsCopy = JSON.parse(JSON.stringify(feats));
  solveEdgeSnap(edges, feats, 5);
  assert.deepEqual(edges, edgesCopy);
  assert.deepEqual(feats, featsCopy);
});

// ── sizeMatches ───────────────────────────────────────────────────────────────
test("sizeMatches: in-progress size near a candidate snaps to it", () => {
  const m = sizeMatches(178, [{ id: "a", size: 180 }, { id: "c", size: 90 }], 5);
  assert.deepEqual(m, { value: 180, ids: ["a"] });
});

test("sizeMatches: every item sharing the matched value is reported", () => {
  const m = sizeMatches(178, [{ id: "a", size: 180 }, { id: "b", size: 180 }, { id: "c", size: 90 }], 5);
  assert.equal(m.value, 180);
  assert.deepEqual(m.ids.sort(), ["a", "b"]);
});

test("sizeMatches: nothing within tolerance → null", () => {
  assert.equal(sizeMatches(150, [{ id: "a", size: 180 }], 5), null);
});

test("sizeMatches: exact match snaps to the same value (idempotent)", () => {
  const m = sizeMatches(180, [{ id: "a", size: 180 }], 5);
  assert.deepEqual(m, { value: 180, ids: ["a"] });
});

test("sizeMatches: nearest candidate wins (strictly closer)", () => {
  const m = sizeMatches(182, [{ id: "a", size: 180 }, { id: "b", size: 186 }], 5);
  assert.equal(m.value, 180); // dist 2 beats dist 4
  assert.deepEqual(m.ids, ["a"]);
});

test("sizeMatches: deterministic lowest-size tiebreak on equal distance", () => {
  const m = sizeMatches(185, [{ id: "hi", size: 190 }, { id: "lo", size: 180 }], 5);
  assert.equal(m.value, 180); // both dist 5; smaller value wins
  assert.deepEqual(m.ids, ["lo"]);
});

// ── integration sanity: the two solvers stay independent ──────────────────────
test("solveSnap (move) still behaves — regression guard", () => {
  const line = { kind: "line", x: 100, y: 0, dx: 0, dy: 1, id: "e" };
  const near = solveSnap([{ kind: "point", x: 97, y: 50, id: "p" }], [line], 5);
  approx(near.dx, 3);
});

console.log(`\n${passed} snap2 tests passed`);
