/**
 * Arrow variants — plugin-level tests (SB1, manifest ARCHITECTURE PLAN #6):
 * elbow_arrow.js, curved_arrow.js, and fancy_arrow.js's new modifier points.
 * Bare node, no framework — suite conventions (core_test.js/outline_test.js/
 * endpoints_test.js). Complements outline_test.js's pure-generator-math tests
 * and endpoints_test.js's headMode tests with the PLUGIN wiring: emit() shape,
 * modifierPoints() → apply() round-trips (the exact math CanvasView's
 * modifierDrag performs, run here without a browser), and the stroke-naming
 * migration's plugin-declared legacyKeys tables.
 */

import assert from "node:assert/strict";
import { elbowArrowPlugin } from "../plugins/elbow_arrow.js";
import { curvedArrowPlugin } from "../plugins/curved_arrow.js";
import { fancyArrowPlugin } from "../plugins/fancy_arrow.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { modifierWrite } from "../core/derive.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}
function approx(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}

// ── stroke naming migration: legacyKeys tables (manifest ARCHITECTURE PLAN #6) ─

test("arrow.js: legacyKeys renames headSize, color, and width", () => {
  assert.deepEqual(arrowPlugin.legacyKeys, { headSize: "headLength", color: "stroke", width: "strokeWidth" });
  assert.equal("stroke" in arrowPlugin.defaults, true);
  assert.equal("strokeWidth" in arrowPlugin.defaults, true);
  assert.equal("color" in arrowPlugin.defaults, false);
  assert.equal("width" in arrowPlugin.defaults, false);
});

test("fancy_arrow.js: legacyKeys renames ONLY color (no generic width property exists to rename)", () => {
  assert.deepEqual(fancyArrowPlugin.legacyKeys, { color: "stroke" });
  assert.equal("stroke" in fancyArrowPlugin.defaults, true);
  assert.equal("color" in fancyArrowPlugin.defaults, false);
  assert.equal("width" in fancyArrowPlugin.defaults, false); // never existed — startWidth/endWidth are shape params, not renamed
});

test("elbow_arrow.js / curved_arrow.js: NEW plugins, born with current names — no legacyKeys entry needed", () => {
  for (const plugin of [elbowArrowPlugin, curvedArrowPlugin]) {
    assert.equal(plugin.legacyKeys, undefined, plugin.type);
    assert.equal("stroke" in plugin.defaults, true, plugin.type);
    assert.equal("strokeWidth" in plugin.defaults, true, plugin.type);
  }
});

// ── elbow_arrow: route + elbow modifier point ────────────────────────────────

test("elbowArrowPlugin: registration shape (type/title/capabilities/commands)", () => {
  assert.equal(elbowArrowPlugin.type, "elbow_arrow");
  assert.equal(elbowArrowPlugin.capabilities.transform, false);
  assert.equal(elbowArrowPlugin.commands[0].id, "add-elbow-arrow");
});

test("elbowArrowPlugin.emit: default state renders a shaft polyline + one head polygon (headMode 'end')", () => {
  const cmds = elbowArrowPlugin.emit(elbowArrowPlugin.defaults);
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].op, "polyline");
  assert.equal(cmds[0].points.length, 4); // H-V-H, 4 vertices
  assert.equal(cmds[1].op, "polygon");
  // Every emitted vertex is a finite [x, y] pair — catches the {x,y}-vs-[x,y]
  // convention mismatch class of bug (elbowRoute returns [x,y] arrays; a
  // plugin that mistakenly reads .x/.y off them gets silent NaN, which
  // JSON-serializes as null and only surfaces downstream in the PDF backend).
  for (const cmd of cmds)
    for (const [x, y] of cmd.points)
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `${cmd.op} point [${x}, ${y}] must be finite`);
});

test("elbowArrowPlugin.modifierPoints: ONE handle at elbowHandle's position", () => {
  const mps = elbowArrowPlugin.modifierPoints(elbowArrowPlugin.defaults);
  assert.equal(mps.length, 1);
  assert.equal(mps[0].id, "elbow");
  const { from, to } = elbowArrowPlugin.defaults;
  approx(mps[0].x, from.x + (to.x - from.x) * elbowArrowPlugin.defaults.elbow);
  approx(mps[0].y, (from.y + to.y) / 2);
});

test("elbowArrowPlugin.modifierPoints: a drag round-trips — dragging the handle to a known x recovers the exact elbow proportion", () => {
  const state = elbowArrowPlugin.defaults;
  const mp = elbowArrowPlugin.modifierPoints(state)[0];
  // Drag to x = from.x + 0.75*(to.x-from.x) — expect elbow ≈ 0.75.
  const targetX = state.from.x + 0.75 * (state.to.x - state.from.x);
  // modifierWrite = the protocol's driver (core/derive.js): the handle's own
  // `constrain` removes the y offset before `apply` ever sees it.
  const result = modifierWrite(mp, state, { x: targetX, y: mp.y + 999 });
  approx(result.elbow, 0.75);
});

test("elbowArrowPlugin.modifierPoints: the CONSTRAINT clamps to [0, 1] beyond the endpoints", () => {
  const state = elbowArrowPlugin.defaults;
  const mp = elbowArrowPlugin.modifierPoints(state)[0];
  approx(modifierWrite(mp, state, { x: state.from.x - 500, y: 0 }).elbow, 0);
  approx(modifierWrite(mp, state, { x: state.to.x + 500, y: 0 }).elbow, 1);
});

test("elbowArrowPlugin: headMode 'both' mirrors a head at both ends", () => {
  const cmds = elbowArrowPlugin.emit({ ...elbowArrowPlugin.defaults, headMode: "both" });
  assert.equal(cmds.filter((c) => c.op === "polygon").length, 2);
});

// ── curved_arrow: bezier + bend modifier point ───────────────────────────────

test("curvedArrowPlugin: registration shape", () => {
  assert.equal(curvedArrowPlugin.type, "curved_arrow");
  assert.equal(curvedArrowPlugin.capabilities.transform, false);
  assert.equal(curvedArrowPlugin.commands[0].id, "add-curved-arrow");
});

test("curvedArrowPlugin.emit: sampled polyline shaft (33 points, bend != 0 leaves the straight line) + one head", () => {
  const cmds = curvedArrowPlugin.emit(curvedArrowPlugin.defaults);
  assert.equal(cmds[0].op, "polyline");
  assert.ok(cmds[0].points.length > 2, "curve is a sampled multi-point polyline, not a straight 2-point segment");
  assert.equal(cmds[1].op, "polygon");
  for (const cmd of cmds)
    for (const [x, y] of cmd.points)
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `${cmd.op} point [${x}, ${y}] must be finite`);
});

test("curvedArrowPlugin.modifierPoints: ONE handle at the bezier's t=0.5 sample", () => {
  const mps = curvedArrowPlugin.modifierPoints(curvedArrowPlugin.defaults);
  assert.equal(mps.length, 1);
  assert.equal(mps[0].id, "bend");
  const { from, to } = curvedArrowPlugin.defaults;
  // bend=0.25 (default) on a level span curves off the straight line's y.
  assert.notEqual(mps[0].y, (from.y + to.y) / 2);
});

test("curvedArrowPlugin.modifierPoints: apply() round-trips — dragging the handle recovers the exact bend proportion", () => {
  const state = { ...curvedArrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, bend: 0.4 };
  const mp = curvedArrowPlugin.modifierPoints(state)[0];
  const result = mp.apply(state, { x: mp.x, y: mp.y });
  approx(result.bend, 0.4);
});

test("curvedArrowPlugin.modifierPoints: apply() supports negative bend (signed parameter)", () => {
  const state = { ...curvedArrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, bend: -0.35 };
  const mp = curvedArrowPlugin.modifierPoints(state)[0];
  const result = mp.apply(state, { x: mp.x, y: mp.y });
  approx(result.bend, -0.35);
});

test("curvedArrowPlugin: headMode 'none' emits only the shaft, zero heads", () => {
  const cmds = curvedArrowPlugin.emit({ ...curvedArrowPlugin.defaults, headMode: "none" });
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].op, "polyline");
});

// ── fancy_arrow: five modifier points hit analytic outline values ───────────

test("fancyArrowPlugin.modifierPoints: five handles, one per parametric-geometry parameter", () => {
  const mps = fancyArrowPlugin.modifierPoints(fancyArrowPlugin.defaults);
  assert.deepEqual(mps.map((m) => m.id), ["tipLength", "tipWidth", "tipDimple", "startWidth", "endWidth"]);
});

test("fancyArrowPlugin.modifierPoints: handle positions land EXACTLY on fancyArrowOutline's own vertices", () => {
  // Default state: from (200,340), to (420,340) — a horizontal arrow, so the
  // outline's exact vertex values (hand-verified against fancyArrowOutline
  // directly) give exact expected handle positions.
  const mps = fancyArrowPlugin.modifierPoints(fancyArrowPlugin.defaults);
  const byId = Object.fromEntries(mps.map((m) => [m.id, m]));
  approx(byId.tipLength.x, 405); approx(byId.tipLength.y, 340); // barb base line, on-axis
  approx(byId.tipWidth.x, 405); approx(byId.tipWidth.y, 355); // barbR
  approx(byId.tipDimple.x, 410); approx(byId.tipDimple.y, 340); // dimple, on-axis
  approx(byId.startWidth.x, 200); approx(byId.startWidth.y, 341.5); // startR
  approx(byId.endWidth.x, 410); approx(byId.endWidth.y, 342.5); // dimpleR
});

test("fancyArrowPlugin.modifierPoints: each apply() round-trips — dragging a handle recovers its own parameter exactly", () => {
  const state = fancyArrowPlugin.defaults;
  const mps = fancyArrowPlugin.modifierPoints(state);
  const byId = Object.fromEntries(mps.map((m) => [m.id, m]));

  // tipLength: drag the handle 20 world units further back from `to` (along -x, since the arrow is horizontal).
  approx(byId.tipLength.apply(state, { x: byId.tipLength.x - 20, y: byId.tipLength.y }).tipLength, state.tipLength + 20);

  // tipWidth: drag the barbR handle to double its normal offset.
  const newHalfTip = (byId.tipWidth.y - 340) * 2; // offset from the axis (y=340), doubled
  approx(byId.tipWidth.apply(state, { x: byId.tipWidth.x, y: 340 + newHalfTip }).tipWidth, state.tipWidth * 2);

  // startWidth: drag the startR handle to 3x its normal offset.
  approx(byId.startWidth.apply(state, { x: state.from.x, y: 340 + (byId.startWidth.y - 340) * 3 }).startWidth, state.startWidth * 3);

  // endWidth: drag the dimpleR handle to half its normal offset.
  approx(byId.endWidth.apply(state, { x: byId.endWidth.x, y: 340 + (byId.endWidth.y - 340) * 0.5 }).endWidth, state.endWidth * 0.5);

  // tipDimple: drag the dimple handle 2 units closer to the tip (smaller "back of tip" distance = larger dimple).
  const result = byId.tipDimple.apply(state, { x: byId.tipDimple.x + 2, y: 340 });
  approx(result.tipDimple, state.tipDimple + 2);
});

test("fancyArrowPlugin.modifierPoints: degenerate (coincident from/to) emits zero handles — no defined axis", () => {
  const state = { ...fancyArrowPlugin.defaults, from: { x: 7, y: 7 }, to: { x: 7, y: 7 } };
  assert.deepEqual(fancyArrowPlugin.modifierPoints(state), []);
});

console.log(`\n${passed} arrow-variants tests passed`);
