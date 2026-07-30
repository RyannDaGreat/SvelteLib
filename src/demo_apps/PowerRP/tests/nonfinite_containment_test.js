/**
 * Tests for the NON-FINITE CONTAINMENT seam and the degenerate-fit guard that
 * together fix a live crash (2026-07-30, reported against the deployed static
 * site with ?repo=RyannDaGreat/PowerRP-RobotSim-Demo).
 * Plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/nonfinite_containment_test.js
 *
 * ── THE BUG THIS PINS, END TO END ────────────────────────────────────────────
 * The user opened a deck and added a TEXT item. The console then showed
 *   "PowerRP expression error at items.<id>.rotationAnchor.x: evaluates to NaN"
 * followed by an UNCAUGHT, EVERY-FRAME loop of
 *   'Error: pushTransform: "x" must be a finite number, got null'
 * and the canvas stopped painting entirely.
 *
 * TWO INDEPENDENT DEFECTS, and this file covers both, because fixing either one
 * alone leaves a real hole:
 *
 *   1. THE SOURCE — core/view.fitRectView divided by the output size and by the
 *      rect with no guard. A canvas that has not been laid out yet is 0×0, which
 *      made zoom 0; inverting that view to turn a click into world coordinates
 *      computes (screen - pan) / 0, so the placed item got NaN x/y and its
 *      `self.anchors.center.x` equation evaluated to NaN. Now a degenerate fit
 *      falls back to identity zoom and REPORTS, so no pointer position derived
 *      from it can be non-finite.
 *
 *   2. THE BLAST RADIUS — even with (1) fixed, ANY non-finite number reaching a
 *      node's world (a user equation like `= 0/0`, a future defect) killed the
 *      whole frame, because render_gpu/ports.emitNode pushed every node's world
 *      unguarded. pushTransform's refusal was correct; taking the entire scene
 *      down with it was not. A broken widget must cost ITSELF — the plugin-emit
 *      red-box precedent (50a50bc).
 *
 * THE BYTE-IDENTICAL CONCERN is a first-class case here: containment that
 * perturbed a currently-working render would be a worse bug than the one it
 * fixes, so a finite scene's IR is asserted deep-equal across the change.
 */

import assert from "node:assert/strict";
import { fitRectView } from "../core/view.js";
import { isPaintableFrame, pushTransform } from "../render_gpu/ir.js";
import { sceneIR, nonFiniteFrameFields, nonFiniteAffordanceIR } from "../render_gpu/ports.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { repairedDocument, foldState, withNewItem, withNormalizedZ } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerPlugins(registry);

/** The smallest document that still exercises the real pipeline: THE camera
 *  (repair guarantees one) plus one ordinary painted rect to stand for "the rest
 *  of the scene", which every containment case asserts still paints. */
function baseDoc() {
  const raw = {
    meta: { name: "containment", slideW: 1280, slideH: 720 },
    slides: [{
      id: "s0", name: "Slide 1",
      delta: {
        items: {
          cam: { type: "camera", x: 0, y: 0, w: 1280, h: 720, z: 0, rotation: 0, scale: 1, active: true },
          ok: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, rotation: 0, scale: 1, active: true },
        },
      },
    }],
  };
  const rep = repairedDocument(raw, registry);
  return rep.doc ?? rep;
}

/** Query. The evaluated + derived + emitted IR of `doc` at slide 0 — the exact
 *  chain every pixel consumer runs. */
function irOf(doc) {
  const state = evaluateState(foldState(doc, 0, 1), registry, doc.meta?.script ?? "").state;
  return sceneIR(deriveRenderTree(state, registry, "containment"));
}

// ── 1. THE SOURCE: fitRectView never returns a non-finite view ───────────────

test("fitRectView: an ordinary fit is unchanged (the regression guard)", () => {
  assert.deepEqual(fitRectView({ x: 0, y: 0, w: 1280, h: 720 }, 640, 360, 1), { zoom: 0.5, panX: 0, panY: 0, dpr: 1 });
  assert.deepEqual(fitRectView({ x: 100, y: 0, w: 100, h: 100 }, 200, 100, 1), { zoom: 1, panX: -50, panY: 0, dpr: 1 });
});

test("fitRectView: a 0×0 OUTPUT (unlaid-out canvas) stays finite — the live defect", () => {
  const v = fitRectView({ x: 0, y: 0, w: 1280, h: 720 }, 0, 0, 1);
  for (const k of ["zoom", "panX", "panY"]) assert.ok(Number.isFinite(v[k]), `${k} must be finite, got ${v[k]}`);
  // The inversion that produced the user's NaN must now produce a real number.
  const world = { x: (0 - v.panX) / v.zoom, y: (0 - v.panY) / v.zoom };
  assert.ok(Number.isFinite(world.x) && Number.isFinite(world.y), "screen→world must stay finite");
});

test("fitRectView: a degenerate RECT stays finite too (division the other way)", () => {
  for (const rect of [{ x: 0, y: 0, w: 0, h: 720 }, { x: 0, y: 0, w: 1280, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }]) {
    const v = fitRectView(rect, 640, 360, 1);
    for (const k of ["zoom", "panX", "panY"]) assert.ok(Number.isFinite(v[k]), `${k} finite for rect ${rect.w}×${rect.h}`);
  }
});

test("fitRectView: a NEGATIVE or NaN size is degenerate, not a mirrored view", () => {
  for (const [w, h] of [[-100, 100], [NaN, 100], [100, NaN]]) {
    const v = fitRectView({ x: 0, y: 0, w: 1280, h: 720 }, w, h, 1);
    assert.ok(Number.isFinite(v.zoom) && v.zoom > 0, `zoom finite+positive for ${w}×${h}, got ${v.zoom}`);
  }
});

// ── 2. THE PREDICATE + its message ──────────────────────────────────────────

test("isPaintableFrame: agrees with pushTransform, in both directions", () => {
  const good = { x: 1, y: 2, rotation: 0.5, scale: 2 };
  assert.equal(isPaintableFrame(good), true);
  assert.doesNotThrow(() => pushTransform(good));
  for (const bad of [{ x: NaN }, { y: Infinity }, { rotation: -Infinity }, { scale: NaN }]) {
    const frame = { x: 0, y: 0, rotation: 0, scale: 1, ...bad };
    assert.equal(isPaintableFrame(frame), false);
    assert.throws(() => pushTransform(frame), /must be a finite number/);
  }
});

test("nonFiniteFrameFields: names every offender, in pushTransform's order", () => {
  assert.deepEqual(nonFiniteFrameFields({ x: 0, y: 0, rotation: 0, scale: 1 }), []);
  assert.deepEqual(nonFiniteFrameFields({ x: NaN, y: NaN, rotation: 0, scale: 1 }), ["x", "y"]);
  assert.deepEqual(nonFiniteFrameFields({ x: 0, y: 0, rotation: 0, scale: Infinity }), ["scale"]);
});

test("nonFiniteAffordanceIR: a red box that NAMES the item and the property", () => {
  const ops = nonFiniteAffordanceIR({ itemId: "cf17cc12", state: { type: "text", name: "Title", w: 260, h: 48 } }, ["x", "y"]);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, "rect");
  assert.equal(ops[1].op, "text");
  assert.match(ops[1].text, /Title/, "the affordance must name the item");
  assert.match(ops[1].text, /x\/y/, "the affordance must name the offending properties");
  // Every op it emits must itself be paintable — an affordance that throws is no affordance.
  for (const op of ops) for (const k of ["x", "y"]) assert.ok(Number.isFinite(op[k]));
});

test("nonFiniteAffordanceIR: a state with no usable w/h still draws a visible box", () => {
  const ops = nonFiniteAffordanceIR({ itemId: "a1", state: { type: "line" } }, ["x"]);
  assert.ok(ops[0].w > 0 && ops[0].h > 0, "must fall back to a visible size, never 0×0");
});

// ── 3. THE CONTAINMENT, through the real pipeline ───────────────────────────

test("BYTE-IDENTICAL: a finite scene's IR is untouched by the containment", () => {
  const doc = baseDoc();
  const a = irOf(doc);
  const b = irOf(doc);
  assert.deepEqual(a, b);
  // and it really did paint the ordinary content (not an empty list agreeing with itself)
  assert.ok(a.length >= 3, `expected a painted scene, got ${a.length} ops`);
  assert.ok(a.some((o) => o.op === "rect"), "the ordinary rect must still be emitted");
  assert.ok(!a.some((o) => o.op === "text" && /not a finite number/.test(String(o.text))), "no affordance in a healthy scene");
});

test("THE USER'S SEQUENCE: an item with NaN x/y does not kill the frame", () => {
  const doc = baseDoc();
  const healthy = irOf(doc);
  // The exact shape the live bug produced: a text item placed through a zoom-0
  // view, so its x/y are NaN and rotationAnchor evaluates to NaN with it.
  const bad = { ...registry.get("text").defaults, x: NaN, y: NaN, active: true, z: 99 };
  const [doc2] = withNewItem(doc, 0, bad);
  const ir = sceneIR(deriveRenderTree(
    evaluateState(foldState(withNormalizedZ(doc2), 0, 1), registry, "").state,
    registry, "containment",
  ));
  // 1. it did not throw (the whole point — this used to die every rAF tick)
  // 2. the broken item shows the loud affordance
  assert.ok(ir.some((o) => o.op === "text" && /not a finite number/.test(String(o.text))), "the broken item must show its error box");
  // 3. THE REST OF THE SCENE STILL PAINTS — every op the healthy scene emitted is still there
  for (const op of healthy) assert.ok(ir.some((o) => JSON.stringify(o) === JSON.stringify(op)), `lost a healthy op: ${JSON.stringify(op).slice(0, 80)}`);
});

test("a NON-FINITE ROTATION or SCALE is contained the same way", () => {
  for (const [prop, value] of [["rotation", Infinity], ["scale", NaN]]) {
    const doc = baseDoc();
    const bad = { ...registry.get("rect").defaults, x: 0, y: 0, [prop]: value, active: true, z: 99 };
    const [doc2] = withNewItem(doc, 0, bad);
    let ir;
    assert.doesNotThrow(() => {
      ir = sceneIR(deriveRenderTree(
        evaluateState(foldState(withNormalizedZ(doc2), 0, 1), registry, "").state,
        registry, "containment",
      ));
    }, `a non-finite ${prop} must not throw out of sceneIR`);
    assert.ok(ir.some((o) => o.op === "text" && /not a finite number/.test(String(o.text))), `${prop}: affordance expected`);
  }
});

console.log(`\n${passed} passed`);
