/**
 * Grid-layout math tests (Arrange Selection into Grid / bento box) — plain
 * node, no framework (SvelteLib has none), mirroring the @example doctests in
 * core/grid.js plus the invariants the tool relies on:
 *   - row-major assignment with a fixed column count; overflow spills into
 *     extra rows (never clamps);
 *   - cell centers tile `bounds` and their COLLECTIVE center equals the center
 *     of `bounds` (padding is symmetric, tracks divide evenly) — this is what
 *     makes a bento sized to the selection's union AABB re-flow the items
 *     WITHIN the same footprint;
 *   - near-square seed for the picker's default highlight.
 *
 * Run: node src/demo_apps/PowerRP/tests/grid_test.js
 */
import assert from "node:assert/strict";
import { gridAssign, cellCenters, nearSquareGrid, effectiveRows } from "../core/grid.js";

let n = 0;
const test = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };
const eq = (a, b) => assert.deepEqual(a, b);
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── effectiveRows ───────────────────────────────────────────────────────────
test("effectiveRows: requested minimum, grown to fit overflow", () => {
  assert.equal(effectiveRows(5, 2, 3), 2); // 5 ≤ 6 → keep requested
  assert.equal(effectiveRows(7, 2, 3), 3); // 7 > 6 → ceil(7/3)
  assert.equal(effectiveRows(0, 2, 3), 2); // no items → keep requested shape
  assert.equal(effectiveRows(13, 3, 4), 4); // 13 > 12 → ceil(13/4)
});

// ── gridAssign ────────────────────────────────────────────────────────────────
test("gridAssign: row-major fill (doctests)", () => {
  eq(gridAssign(4, 2, 2), [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }]);
  eq(gridAssign(5, 2, 3)[4], { row: 1, col: 1 });
  eq(gridAssign(7, 2, 3)[6], { row: 2, col: 0 }); // overflow → 3rd row
});

test("gridAssign: length === itemCount, every item in-bounds column, monotone row-major", () => {
  const cols = 4;
  const a = gridAssign(10, 2, cols);
  assert.equal(a.length, 10);
  a.forEach((cell, i) => {
    assert.equal(cell.row, Math.floor(i / cols));
    assert.equal(cell.col, i % cols);
    assert.ok(cell.col >= 0 && cell.col < cols, "col within [0, cols)");
  });
  // Row index never decreases as item index grows (row-major).
  for (let i = 1; i < a.length; i++) assert.ok(a[i].row >= a[i - 1].row);
});

test("gridAssign: itemCount === effectiveRows*cols leaves no empty cell and no overflow", () => {
  const cols = 3, rows = 2;
  const rowsUsed = effectiveRows(6, rows, cols);
  const a = gridAssign(6, rows, cols);
  const maxRow = Math.max(...a.map((c) => c.row));
  assert.equal(maxRow, rowsUsed - 1); // last item lands on the last used row
});

// ── cellCenters ───────────────────────────────────────────────────────────────
test("cellCenters: single cell = center of bounds (doctest)", () => {
  eq(cellCenters({ x: 0, y: 0, w: 100, h: 100 }, 1, 1, {}), [{ row: 0, col: 0, x: 50, y: 50 }]);
});

test("cellCenters: two columns halve the width (doctest)", () => {
  const cs = cellCenters({ x: 0, y: 0, w: 100, h: 100 }, 1, 2, {});
  eq(cs[0], { row: 0, col: 0, x: 25, y: 50 });
  eq(cs[1], { row: 0, col: 1, x: 75, y: 50 });
});

test("cellCenters: padding insets symmetrically (doctest)", () => {
  eq(cellCenters({ x: 0, y: 0, w: 120, h: 120 }, 1, 1, { padding: 10 })[0], { row: 0, col: 0, x: 60, y: 60 });
});

test("cellCenters: colGap eats into cell width, stays symmetric (doctest)", () => {
  eq(cellCenters({ x: 0, y: 0, w: 110, h: 100 }, 1, 2, { colGap: 10 })[1], { row: 0, col: 1, x: 85, y: 50 });
});

test("cellCenters: row-major order, length rows*cols, cells left→right then top→bottom", () => {
  const cs = cellCenters({ x: 0, y: 0, w: 100, h: 100 }, 2, 2, {});
  assert.equal(cs.length, 4);
  eq(cs.map((c) => [c.x, c.y]), [[25, 25], [75, 25], [25, 75], [75, 75]]);
});

test("cellCenters INVARIANT: collective center equals the bounds center (any gaps/padding)", () => {
  const bounds = { x: 10, y: 20, w: 200, h: 120 };
  const cs = cellCenters(bounds, 3, 4, { rowGap: 6, colGap: 8, padding: 5 });
  const avgX = cs.reduce((s, c) => s + c.x, 0) / cs.length;
  const avgY = cs.reduce((s, c) => s + c.y, 0) / cs.length;
  approx(avgX, bounds.x + bounds.w / 2);
  approx(avgY, bounds.y + bounds.h / 2);
});

test("cellCenters + gridAssign compose: each of n items maps to a distinct cell center", () => {
  const itemCount = 5, cols = 3, rows = effectiveRows(itemCount, 2, cols);
  const bounds = { x: 0, y: 0, w: 300, h: 200 };
  const centers = cellCenters(bounds, rows, cols, { padding: 4, rowGap: 4, colGap: 4 });
  const byCell = new Map(centers.map((c) => [`${c.row},${c.col}`, c]));
  const targets = gridAssign(itemCount, 2, cols).map((a) => byCell.get(`${a.row},${a.col}`));
  assert.equal(targets.length, itemCount);
  targets.forEach((t) => assert.ok(t, "every assigned cell has a computed center"));
  assert.equal(new Set(targets.map((t) => `${t.x},${t.y}`)).size, itemCount, "each item → a unique cell center");
});

// ── nearSquareGrid ──────────────────────────────────────────────────────────
test("nearSquareGrid: near-square seed holds at least n cells (doctests)", () => {
  eq(nearSquareGrid(1), { rows: 1, cols: 1 });
  eq(nearSquareGrid(5), { rows: 2, cols: 3 });
  eq(nearSquareGrid(9), { rows: 3, cols: 3 });
  eq(nearSquareGrid(12), { rows: 3, cols: 4 });
  // Capacity never below n, and no wasted extra row.
  for (let k = 1; k <= 50; k++) {
    const { rows, cols } = nearSquareGrid(k);
    assert.ok(rows * cols >= k, `capacity ${rows}×${cols} holds ${k}`);
    assert.ok((rows - 1) * cols < k, `no fully-empty trailing row for ${k}`);
  }
});

console.log(`\n${n} tests passed`);
