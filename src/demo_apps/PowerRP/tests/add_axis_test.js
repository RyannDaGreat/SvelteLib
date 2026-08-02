/**
 * ADD AXIS — the equation binding, in plain node.
 * Run: node src/demo_apps/PowerRP/tests/add_axis_test.js
 *
 * User request (2026-08-02): "for that widget perhaps a Add Axis tool would be
 * nice, to create and bind height/width/x/y of some grid + axis directly behind
 * it." ("that widget" = the graph line.)
 *
 * WHAT THIS PROVES, and why it is worth a suite (the center_text_test precedent).
 * The acceptance test is not "the right strings were written" — it is "the grid
 * and the axis STILL line up with the curve after the curve moves, resizes, or has
 * its data range retuned". A test comparing equation text would pass on a binding
 * that never re-evaluates, which is exactly the failure worth catching. So every
 * geometry case below runs the real evaluator (core/expressions.evaluateState) over
 * a real folded state and reads the RESULT.
 *
 * The move/resize/retune cases mutate ONLY the graph line and re-evaluate. Nothing
 * writes to the grid or the axis, so if the binding were a snapshot rather than an
 * equation the boxes would diverge and the assertions would fail.
 *
 * THE RANGE HALF IS THE INTERESTING ONE. `xRange`/`yRange` are STRINGS
 * ("[min, max, step]"), and whether the equation grammar carries a string through a
 * reference was the open question this feature turned on. The retune case pins that
 * it does — and pins it through parseRange, so what is asserted is that the grid's
 * DATA WINDOW equals the curve's, not merely that two strings match.
 */

import assert from "node:assert";
import { axisGridOverrides, axisTicksOverrides, graphAxisBindingOverrides } from "../core/graph_axis_binding.js";
import { evaluateState } from "../core/expressions.js";
import { parseRange } from "../core/graph_scale.js";
import { graphLinePlugin } from "../plugins/graph_line.js";
import { graphGridPlugin } from "../plugins/graph_grid.js";
import { graphTickMarksPlugin } from "../plugins/graph_tick_marks.js";
import { createRegistry } from "../core/registry.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
for (const p of [graphLinePlugin, graphGridPlugin, graphTickMarksPlugin]) registry.register(p);

/** Query→value. The evaluated grid, axis and curve of a real three-item state —
 *  the one seam every acceptance case below measures through. */
function evaluatedTrio(targetState) {
  const raw = {
    items: {
      gl: { ...graphLinePlugin.defaults, ...targetState, z: 3 },
      gg: { ...graphGridPlugin.defaults, ...axisGridOverrides("gl"), z: 1 },
      gt: { ...graphTickMarksPlugin.defaults, ...axisTicksOverrides("gl"), z: 2 },
    },
  };
  const out = evaluateState(raw, registry);
  // `errors` is a MAP keyed by item id, not a plain object — an object-shaped
  // assertion here would compare {} to Map(0) and fail, or worse, pass vacuously
  // against a populated Map once one appeared. Spread it so a real error PRINTS.
  assert.deepEqual([...(out.errors ?? new Map())], [], "the binding must evaluate with NO errors");
  return { grid: out.state.items.gg, axis: out.state.items.gt, curve: out.state.items.gl };
}

const box = (s) => ({ x: s.x, y: s.y, w: s.w, h: s.h });
const window = (s) => ({ x: parseRange(s.xRange), y: parseRange(s.yRange) });

// ── the equations themselves ────────────────────────────────────────────────
test("binds x/y/w/h to the target by its STORED @id (rename-proof), not by slug", () => {
  const ov = graphAxisBindingOverrides("ab12cd34");
  assert.equal(ov.x, "= @ab12cd34.x");
  assert.equal(ov.y, "= @ab12cd34.y");
  assert.equal(ov.w, "= @ab12cd34.w");
  assert.equal(ov.h, "= @ab12cd34.h");
});

test("binds the DATA WINDOW too — xRange/yRange, the half that makes it a graph tool", () => {
  const ov = graphAxisBindingOverrides("ab12cd34");
  assert.equal(ov.xRange, "= @ab12cd34.xRange");
  assert.equal(ov.yRange, "= @ab12cd34.yRange");
});

test("mints the PAIR: a graph_grid and a graph_tick_marks, same binding on both", () => {
  assert.equal(axisGridOverrides("ab12cd34").type, "graph_grid");
  assert.equal(axisTicksOverrides("ab12cd34").type, "graph_tick_marks");
  const { type: _g, ...gridBinding } = axisGridOverrides("ab12cd34");
  const { type: _t, ...axisBinding } = axisTicksOverrides("ab12cd34");
  assert.deepEqual(gridBinding, axisBinding);
});

test("REFUSES an id that would resolve to a different item (the stored-id invariant)", () => {
  assert.throws(() => graphAxisBindingOverrides("Do_it"), /cannot be referenced/);
  assert.throws(() => axisGridOverrides("Do_it"), /cannot be referenced/);
});

// ── the acceptance test: box AND window still agree after a change ───────────
test("grid and axis COVER the curve when placed", () => {
  const { grid, axis, curve } = evaluatedTrio({ x: 120, y: 80, w: 400, h: 300 });
  assert.deepEqual(box(grid), box(curve));
  assert.deepEqual(box(axis), box(curve));
  assert.deepEqual(box(grid), { x: 120, y: 80, w: 400, h: 300 });
});

test("curve MOVES → grid and axis follow (the binding re-evaluates)", () => {
  const { grid, axis, curve } = evaluatedTrio({ x: -640, y: 915, w: 400, h: 300 });
  assert.deepEqual(box(grid), box(curve));
  assert.deepEqual(box(axis), box(curve));
  assert.deepEqual(box(grid), { x: -640, y: 915, w: 400, h: 300 });
});

test("curve RESIZES → grid and axis resize with it (what an x/y-only binding would miss)", () => {
  const { grid, axis, curve } = evaluatedTrio({ x: 120, y: 80, w: 1280, h: 720 });
  assert.deepEqual(box(grid), box(curve));
  assert.deepEqual(box(axis), box(curve));
  assert.deepEqual(box(grid), { x: 120, y: 80, w: 1280, h: 720 });
});

test("the DEFAULT data window arrives on both, as a parseable 3-tuple STRING", () => {
  // Pins the open question this feature turned on: a bare `= @id.xRange` reference
  // carries a STRING through the evaluator verbatim, so parseRange sees exactly
  // what it would have seen had the author typed the tuple by hand.
  const { grid, axis, curve } = evaluatedTrio({ x: 0, y: 0, w: 400, h: 300 });
  assert.equal(typeof grid.xRange, "string");
  assert.equal(grid.xRange, curve.xRange);
  assert.deepEqual(window(grid), window(curve));
  assert.deepEqual(window(axis), window(curve));
  assert.deepEqual(window(grid).x, { min: -6.2832, max: 6.2832, step: 1.5708 });
});

test("curve's RANGE is RETUNED → the grid re-spaces to match (the whole point)", () => {
  // The case a geometry-only binding would miss entirely: the box does not change,
  // only the data window — and the ruling behind the curve must follow it.
  const { grid, axis, curve } = evaluatedTrio({
    x: 120, y: 80, w: 400, h: 300,
    xRange: "[0, 20, 2.5]", yRange: "[-100, 100, 25]",
  });
  assert.deepEqual(window(grid), window(curve));
  assert.deepEqual(window(axis), window(curve));
  assert.deepEqual(window(grid), {
    x: { min: 0, max: 20, step: 2.5 },
    y: { min: -100, max: 100, step: 25 },
  });
});

test("a FLIPPED curve (negative w — THE FLIP) is covered sign and all, read RAW", () => {
  const { grid, axis, curve } = evaluatedTrio({ x: 520, y: 80, w: -400, h: 300 });
  assert.deepEqual(box(grid), box(curve));
  assert.deepEqual(box(axis), box(curve));
  assert.equal(grid.w, -400);
});

console.log(`\n${passed} add-axis tests passed`);
