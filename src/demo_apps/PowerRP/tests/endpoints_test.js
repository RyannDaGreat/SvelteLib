/**
 * core/endpoints.js tests — the shared endpoint-pair capability (bare node,
 * no framework — suite conventions). Covers the pure functions, the hooks
 * factory, and the CONTRACT that both arrow plugins consume it (the hooks
 * behave identically across plugins by construction — the one-home rule).
 */

import assert from "node:assert/strict";
import {
  SHAFT_GRAB_PAD, SHAFT_PULLBACK, endpointEditPoints, endpointMoveBy, endpointClosestToward,
  hitsShaft, endpointPairHooks, HEAD_MODES, headEnds, headTriangle, shaftPullback,
} from "../core/endpoints.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { fancyArrowPlugin } from "../plugins/fancy_arrow.js";
import { elbowArrowPlugin } from "../plugins/elbow_arrow.js";
import { curvedArrowPlugin } from "../plugins/curved_arrow.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const STATE = { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } };

// ── pure functions ─────────────────────────────────────────────────────────

test("endpointEditPoints: one handle descriptor per endpoint, in key order", () => {
  assert.deepEqual(endpointEditPoints(STATE), [
    { key: "from", x: 1, y: 2 },
    { key: "to", x: 3, y: 4 },
  ]);
});

test("endpointMoveBy: every free coordinate translates", () => {
  assert.deepEqual(endpointMoveBy({ from: { x: 0, y: 0 }, to: { x: 10, y: 20 } }, 5, 2), [
    [["from", "x"], 5], [["from", "y"], 2], [["to", "x"], 15], [["to", "y"], 22],
  ]);
});

test("endpointMoveBy: equation-bound coordinates stay anchored", () => {
  assert.deepEqual(endpointMoveBy({ from: { x: 0, y: 0 }, to: { x: 10, y: "@c1_tm.y" } }, 5, 2), [
    [["from", "x"], 5], [["from", "y"], 2], [["to", "x"], 15],
  ]);
});

test("endpointMoveBy: fully bound → no pairs (shaft drag is a no-op)", () => {
  assert.deepEqual(endpointMoveBy({ from: { x: "@a.x", y: "@a.y" }, to: { x: "@b.x", y: "@b.y" } }, 5, 2), []);
});

test("endpointClosestToward: each endpoint aims at the other; non-endpoints null", () => {
  assert.deepEqual(endpointClosestToward(STATE, ["from", "x"]), { x: 3, y: 4 });
  assert.deepEqual(endpointClosestToward(STATE, ["to", "y"]), { x: 1, y: 2 });
  assert.equal(endpointClosestToward(STATE, ["width"]), null);
});

test("hitsShaft: radius + SHAFT_GRAB_PAD around the segment, in and out", () => {
  const s = { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } };
  assert.equal(hitsShaft(s, 5, 3, 0), true); // 3 ≤ 0 + pad
  assert.equal(hitsShaft(s, 5, SHAFT_GRAB_PAD + 2, 2), true); // exactly at radius+pad
  assert.equal(hitsShaft(s, 5, 9, 0), false); // 9 > pad
});

// ── hooks factory ──────────────────────────────────────────────────────────

test("endpointPairHooks: hooks delegate to the pure functions", () => {
  const hooks = endpointPairHooks();
  assert.deepEqual(hooks.editPoints({ state: STATE }), endpointEditPoints(STATE));
  assert.deepEqual(hooks.moveBy(STATE, 1, 1), endpointMoveBy(STATE, 1, 1));
  assert.deepEqual(hooks.closestToward(STATE, ["from", "x"]), endpointClosestToward(STATE, ["from", "x"]));
});

// ── plugin wiring (the one-home contract) ──────────────────────────────────

test("arrow + fancy arrow consume the shared hooks with identical behavior", () => {
  const mixed = { from: { x: 0, y: 0 }, to: { x: 10, y: "@c1_tm.y" } };
  for (const plugin of [arrowPlugin, fancyArrowPlugin]) {
    assert.deepEqual(plugin.editPoints({ state: STATE }), endpointEditPoints(STATE), plugin.type);
    assert.deepEqual(plugin.moveBy(mixed, 5, 2), endpointMoveBy(mixed, 5, 2), plugin.type);
    assert.deepEqual(plugin.closestToward(STATE, ["to", "x"]), { x: 1, y: 2 }, plugin.type);
  }
});

test("plugins keep their own hit tests but share the shaft pad", () => {
  // Basic arrow: strokeWidth 3 shaft on y=0; a point 7px off is inside 3+pad, 9px is out.
  const node = { state: { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, strokeWidth: 3 } };
  assert.equal(arrowPlugin.hitTestWorld(node, 50, 7), true);
  assert.equal(arrowPlugin.hitTestWorld(node, 50, 9), false);
  // Fancy arrow: hairline shaft (widths ~0) still grabbable within the pad.
  const fs = {
    from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 1, endWidth: 1,
  };
  assert.equal(fancyArrowPlugin.hitTestWorld({ state: fs }, 50, 5), true);
  assert.equal(fancyArrowPlugin.hitTestWorld({ state: fs }, 50, 20), false);
});

// ── headMode / head geometry (manifest ARCHITECTURE PLAN #6) ────────────────

test("HEAD_MODES: the four enum values, in the manifest's stated order", () => {
  assert.deepEqual(HEAD_MODES, ["none", "start", "end", "both"]);
});

test("headEnds: legacy default (end); every enum value covered", () => {
  assert.deepEqual(headEnds(), { start: false, end: true });
  assert.deepEqual(headEnds("none"), { start: false, end: false });
  assert.deepEqual(headEnds("start"), { start: true, end: false });
  assert.deepEqual(headEnds("end"), { start: false, end: true });
  assert.deepEqual(headEnds("both"), { start: true, end: true });
});

test("headTriangle: tip + two base corners, axis-covariant (rotating the axis rotates the triangle)", () => {
  const tri = headTriangle({ x: 100, y: 0 }, { x: 0, y: 0 }, 14, 12);
  assert.deepEqual(tri[0], [100, 0]); // tip
  assert.equal(tri.length, 3);
  // Base corners sit `len` back along the axis, ±width/2 across it.
  const [, baseA, baseB] = tri;
  assert.ok(Math.abs(baseA[0] - 86) < 1e-9 && Math.abs(baseB[0] - 86) < 1e-9);
  assert.ok(Math.abs(baseA[1] - 6) < 1e-9 && Math.abs(baseB[1] + 6) < 1e-9);
});

test("headTriangle: degenerate coincident tip/from doesn't throw (collapses to a point)", () => {
  const tri = headTriangle({ x: 5, y: 5 }, { x: 5, y: 5 }, 14, 12);
  assert.deepEqual(tri[0], [5, 5]);
});

test("shaftPullback: SHAFT_PULLBACK fraction when active, 0 when inactive", () => {
  assert.equal(shaftPullback(true, 14), 14 * SHAFT_PULLBACK);
  assert.equal(shaftPullback(false, 14), 0);
});

// ── elbow_arrow / curved_arrow: same shared-hooks contract as arrow/fancy_arrow ─

test("elbow arrow + curved arrow also consume the shared endpoint hooks", () => {
  const mixed = { from: { x: 0, y: 0 }, to: { x: 10, y: "@c1_tm.y" } };
  for (const plugin of [elbowArrowPlugin, curvedArrowPlugin]) {
    assert.deepEqual(plugin.editPoints({ state: STATE }), endpointEditPoints(STATE), plugin.type);
    assert.deepEqual(plugin.moveBy(mixed, 5, 2), endpointMoveBy(mixed, 5, 2), plugin.type);
    assert.deepEqual(plugin.closestToward(STATE, ["to", "x"]), { x: 1, y: 2 }, plugin.type);
  }
});

test("elbow arrow + curved arrow: headMode default is legacy 'end', both defaults render a shaft + one head", () => {
  for (const plugin of [elbowArrowPlugin, curvedArrowPlugin]) {
    assert.equal(plugin.defaults.headMode, "end", plugin.type);
    const cmds = plugin.emit(plugin.defaults);
    assert.equal(cmds.filter((c) => c.op === "polyline").length, 1, plugin.type);
    assert.equal(cmds.filter((c) => c.op === "polygon").length, 1, plugin.type);
  }
});

test("elbow arrow + curved arrow: headMode 'both' emits two head polygons; 'none' emits zero", () => {
  for (const plugin of [elbowArrowPlugin, curvedArrowPlugin]) {
    const both = plugin.emit({ ...plugin.defaults, headMode: "both" });
    assert.equal(both.filter((c) => c.op === "polygon").length, 2, plugin.type);
    const none = plugin.emit({ ...plugin.defaults, headMode: "none" });
    assert.equal(none.filter((c) => c.op === "polygon").length, 0, plugin.type);
  }
});

console.log(`\n${passed} endpoints tests passed`);
