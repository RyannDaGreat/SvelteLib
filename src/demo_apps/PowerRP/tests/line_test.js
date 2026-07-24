/**
 * Line-widget node test — mirrors the arrow endpoint tests in core_test.js
 * (editPoints / moveBy / distToSegment) and adds the line-specific dash + cap
 * geometry. Bare-node runnable (like the rest of the pure-core suites): no DOM,
 * no Svelte. Run: node tests/line_test.js
 */
import assert from "node:assert/strict";
import { linePlugin, dashSpans, capRect, LINE_CAPS } from "../plugins/line.js";
import { distToSegment } from "../core/outline.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 }; // identity; effects-off emit ignores it

test("line: editPoints on evaluated state; distToSegment (mirrors arrow)", () => {
  const node = { state: { ...linePlugin.defaults, from: { x: 0, y: 0 }, to: { x: 10, y: 0 } } };
  assert.deepEqual(linePlugin.editPoints(node), [
    { key: "from", x: 0, y: 0 },
    { key: "to", x: 10, y: 0 },
  ]);
  assert.equal(distToSegment(5, 3, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
});

test("line: moveBy translates both free endpoints", () => {
  const s = { ...linePlugin.defaults, from: { x: 0, y: 0 }, to: { x: 10, y: 0 } };
  assert.deepEqual(linePlugin.moveBy(s, 5, 7), [
    [["from", "x"], 5], [["from", "y"], 7],
    [["to", "x"], 15], [["to", "y"], 7],
  ]);
});

test("line: emit solid round cap → one round-capped polyline shaft (no head)", () => {
  const s = { ...linePlugin.defaults, from: { x: 200, y: 300 }, to: { x: 420, y: 300 } };
  const cmds = linePlugin.emit(s, null, WORLD);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].op, "polyline");
  assert.deepEqual(cmds[0].points, [[200, 300], [420, 300]]);
  assert.equal(cmds.filter((c) => c.op === "polygon").length, 0); // NO arrowhead
});

test("line: emit dashed → several polyline sub-segments", () => {
  // 220px span, dash 12 + gap 8 = 20px step → ceil(220/20) = 11 drawn dashes.
  const s = { ...linePlugin.defaults, from: { x: 0, y: 0 }, to: { x: 220, y: 0 }, dashed: true, dashLength: 12, dashGap: 8 };
  const cmds = linePlugin.emit(s, null, WORLD);
  assert.equal(cmds.length, 11);
  assert.ok(cmds.every((c) => c.op === "polyline"));
  assert.deepEqual(cmds[0].points, [[0, 0], [12, 0]]); // first dash: 0..12
});

test("line: emit flat caps → filled rectangles (butt flush, square extended)", () => {
  const butt = linePlugin.emit({ ...linePlugin.defaults, from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, strokeWidth: 10, cap: "butt" }, null, WORLD);
  assert.equal(butt.length, 1);
  assert.equal(butt[0].op, "polygon");
  assert.equal(butt[0].points.length, 4);
  assert.equal(butt[0].points[0][0], 0); // butt: flush at x=0
  const square = linePlugin.emit({ ...linePlugin.defaults, from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, strokeWidth: 10, cap: "square" }, null, WORLD);
  assert.equal(square[0].points[0][0], -5); // square: extended half-width (10/2) past x=0
});

test("dashSpans: dashed count + solid fallback", () => {
  assert.equal(dashSpans({ x: 0, y: 0 }, { x: 10, y: 0 }, 4, 4).length, 2); // 0..4, 8..10
  assert.deepEqual(dashSpans({ x: 0, y: 0 }, { x: 10, y: 0 }, 0, 4), [[{ x: 0, y: 0 }, { x: 10, y: 0 }]]); // solid
  assert.deepEqual(dashSpans({ x: 0, y: 0 }, { x: 0, y: 0 }, 4, 4), [[{ x: 0, y: 0 }, { x: 0, y: 0 }]]); // zero-length: no infinite loop
});

test("capRect: butt flush, square extended; convex 4-gon", () => {
  assert.deepEqual(capRect({ x: 0, y: 0 }, { x: 10, y: 0 }, 4, "butt"), [[0, 2], [10, 2], [10, -2], [0, -2]]);
  assert.deepEqual(capRect({ x: 0, y: 0 }, { x: 10, y: 0 }, 4, "square")[0], [-2, 2]);
});

test("line: plugin shape — endpoints placement, no head, cap enum", () => {
  assert.equal(linePlugin.type, "line");
  assert.equal(linePlugin.placement, "endpoints");
  assert.equal(linePlugin.defaults.cap, "round");
  assert.deepEqual(LINE_CAPS, ["round", "butt", "square"]);
  // No arrowhead knobs (this is the arrow minus the head).
  assert.equal("headMode" in linePlugin.defaults, false);
  assert.equal(linePlugin.inspector.some((r) => r.key === "headLength"), false);
});

console.log(`\n${passed} tests passed`);
