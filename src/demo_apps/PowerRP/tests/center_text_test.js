/**
 * ADD CENTER TEXT — the equation binding, in plain node.
 * Run: node src/demo_apps/PowerRP/tests/center_text_test.js
 *
 * User request (2026-08-02): "a tool that is 'add center text' which adds text to
 * the center of a widget(s) and binds it to cy and cx of that widget, with
 * centered vertical and horz for that text."
 *
 * WHAT THIS PROVES, and why it is worth a suite. The acceptance test for the
 * feature is not "the right strings were written" — it is "the label is still
 * centered on the target after the target MOVES or RESIZES". A test that only
 * compared equation text would pass on a binding that never re-evaluates, which is
 * exactly the failure mode worth catching. So every case below runs the real
 * evaluator (core/expressions.evaluateState) over a real folded state and checks
 * the resulting CENTER (core/geometry.boxCenter) against the target's, which is
 * the property the user actually asked for.
 *
 * The move/resize cases mutate ONLY the target and re-evaluate. Nothing writes to
 * the label, so if the binding were a snapshot rather than an equation the centers
 * would diverge and the assertion would fail.
 */

import assert from "node:assert";
import { centerTextOverrides, plaintextPlugin } from "../plugins/plaintext.js";
import { evaluateState } from "../core/expressions.js";
import { boxCenter } from "../core/geometry.js";
import { rectPlugin } from "../plugins/rect.js";
import { createRegistry } from "../core/registry.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registry.register(rectPlugin);
registry.register(plaintextPlugin);

/** Query→value. The label's center and the target's center, after a real evaluate
 *  of a two-item state. The one seam every case below measures through. */
function centersFor(targetState) {
  const raw = {
    items: {
      t1: { ...rectPlugin.defaults, ...targetState, z: 0 },
      lbl: { ...plaintextPlugin.defaults, ...centerTextOverrides("t1"), z: 1 },
    },
  };
  const out = evaluateState(raw, registry).state;
  return { label: boxCenter(out.items.lbl), target: boxCenter(out.items.t1) };
}

// ── the equations themselves ────────────────────────────────────────────────
test("binds x/y/w/h to the target by its STORED @id (rename-proof), not by slug", () => {
  const ov = centerTextOverrides("ab12cd34");
  assert.equal(ov.x, "= @ab12cd34.x");
  assert.equal(ov.y, "= @ab12cd34.y");
  assert.equal(ov.w, "= @ab12cd34.w");
  assert.equal(ov.h, "= @ab12cd34.h");
});

test("centers the TYPE both ways — align center, valign middle", () => {
  const ov = centerTextOverrides("ab12cd34");
  assert.equal(ov.align, "center");
  assert.equal(ov.valign, "middle");
});

test("starts EMPTY so the user can type immediately (no placeholder to delete)", () => {
  assert.equal(centerTextOverrides("ab12cd34").text, "");
});

test("REFUSES an id that would resolve to a different item (the stored-id invariant)", () => {
  assert.throws(() => centerTextOverrides("Do_it"), /cannot be referenced/);
});

// ── the acceptance test: still centered after a move AND after a resize ──────
test("the label's center EQUALS the target's center when placed", () => {
  const { label, target } = centersFor({ x: 100, y: 60, w: 240, h: 120 });
  assert.deepEqual(label, target);
  assert.deepEqual(label, { x: 220, y: 120 }); // 100+240/2, 60+120/2
});

test("target MOVES → the label follows (the binding re-evaluates)", () => {
  const { label, target } = centersFor({ x: 900, y: -400, w: 240, h: 120 });
  assert.deepEqual(label, target);
  assert.deepEqual(label, { x: 1020, y: -340 });
});

test("target RESIZES → the label re-centers (what an x-only binding would miss)", () => {
  // The case that separates "bound to the box" from "bound to a point": w/h change
  // with x/y fixed, so the CENTER moves even though the origin did not.
  const { label, target } = centersFor({ x: 100, y: 60, w: 800, h: 400 });
  assert.deepEqual(label, target);
  assert.deepEqual(label, { x: 500, y: 260 });
});

test("the label COVERS the target — so wrap width and valign room track it too", () => {
  const raw = {
    items: {
      t1: { ...rectPlugin.defaults, x: 12, y: 34, w: 260, h: 90, z: 0 },
      lbl: { ...plaintextPlugin.defaults, ...centerTextOverrides("t1"), z: 1 },
    },
  };
  const lbl = evaluateState(raw, registry).state.items.lbl;
  assert.deepEqual(
    { x: lbl.x, y: lbl.y, w: lbl.w, h: lbl.h },
    { x: 12, y: 34, w: 260, h: 90 },
  );
});

test("a FLIPPED target (negative w — THE FLIP) still centers, sign and all", () => {
  // boxCenter is sign-independent by construction, and the label reads w RAW, so
  // the two agree without the binding knowing anything about flips.
  const { label, target } = centersFor({ x: 340, y: 60, w: -240, h: 120 });
  assert.deepEqual(label, target);
  assert.deepEqual(label, { x: 220, y: 120 });
});

console.log(`\n${passed} center-text tests passed`);
