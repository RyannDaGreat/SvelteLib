/**
 * core/endpoints.js tests — the shared endpoint-pair capability (bare node,
 * no framework — suite conventions). Covers the pure functions, the hooks
 * factory, and the CONTRACT that both arrow plugins consume it (the hooks
 * behave identically across plugins by construction — the one-home rule).
 */

import assert from "node:assert/strict";
import {
  SHAFT_GRAB_PAD, endpointEditPoints, endpointMoveBy, endpointClosestToward,
  hitsShaft, endpointPairHooks,
} from "../core/endpoints.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { fancyArrowPlugin } from "../plugins/fancy_arrow.js";

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
  // Basic arrow: width 3 shaft on y=0; a point 7px off is inside 3+pad, 9px is out.
  const node = { state: { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, width: 3 } };
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

console.log(`\n${passed} endpoints tests passed`);
