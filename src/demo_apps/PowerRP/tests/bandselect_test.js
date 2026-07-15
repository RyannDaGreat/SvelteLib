/**
 * Band-select (rubber-band) core tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/bandselect_test.js
 *
 * Verifies the pure band-hit predicates against REAL derived render nodes
 * (fold → evaluate → derive), so the world-AABB path (rotatedBBoxAABB) and the
 * inner/outer/camera/non-bbox rules are exercised end-to-end, not on hand-built
 * node stubs.
 */

import assert from "node:assert/strict";
import { newDocument, foldState, withNewItem } from "../core/document.js";
import { deriveRenderTree } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { rectContains, bandSelectable, selectInBox, rectFromCorners } from "../core/bandselect.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

/** Build the derived nodes for a doc's current slide (real pipeline). */
function nodesOf(doc) {
  return deriveRenderTree(evaluateState(foldState(doc, doc.slides.length - 1, 1), registry).state, registry);
}

/** A doc with a rect + circle placed at known world positions/sizes. */
function scene() {
  let doc = newDocument();
  // rect at (100,100) 50x50; circle at (300,300) 40x40 (defaults give w/h/rotation/scale).
  [doc] = withNewItem(doc, 0, { type: "rect", active: true, x: 100, y: 100, w: 50, h: 50, rotation: 0, scale: 1, z: 1 });
  [doc] = withNewItem(doc, 0, { type: "circle", active: true, x: 300, y: 300, w: 40, h: 40, rotation: 0, scale: 1, z: 2 });
  return doc;
}

test("rectContains: edge-flush counts, partial does not", () => {
  assert.ok(rectContains({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 })); // flush = contained
  assert.ok(rectContains({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 20, h: 20 }));
  assert.ok(!rectContains({ x: 0, y: 0, w: 100, h: 100 }, { x: 90, y: 0, w: 20, h: 10 })); // spills right
});

test("bandSelectable: bbox non-camera yes; camera + non-bbox no", () => {
  const nodes = nodesOf(scene());
  const rect = nodes.find((n) => n.type === "rect");
  const camera = nodes.find((n) => n.type === "camera");
  assert.ok(bandSelectable(rect));
  assert.ok(!bandSelectable(camera)); // camera excluded (border-hit-only, mandatory)
  // A non-bbox node (arrow) is not band-selectable.
  assert.ok(!bandSelectable({ type: "arrow", plugin: { capabilities: { bbox: false } } }));
  assert.ok(!bandSelectable({ type: "blur", plugin: { capabilities: { bbox: false } } }));
});

test("selectInBox INNER: only fully-enclosed items", () => {
  const nodes = nodesOf(scene());
  // A box enclosing ONLY the rect (100..150) but clipping the circle (300..340).
  const box = { x: 90, y: 90, w: 80, h: 80 }; // 90..170 — encloses rect, misses circle
  const ids = selectInBox(nodes, box, "inner");
  const rectId = nodes.find((n) => n.type === "rect").itemId;
  assert.deepEqual(ids, [rectId]);
  // Box straddling both centers but enclosing NEITHER fully → nothing (inner).
  const straddle = { x: 120, y: 120, w: 200, h: 200 }; // 120..320: clips rect's right/bottom AND circle's right/bottom
  assert.deepEqual(selectInBox(nodes, straddle, "inner"), []);
});

test("selectInBox OUTER: touching/partial counts", () => {
  const nodes = nodesOf(scene());
  const rectId = nodes.find((n) => n.type === "rect").itemId;
  const circleId = nodes.find((n) => n.type === "circle").itemId;
  // Box overlapping the rect partially and the circle partially.
  const box = { x: 120, y: 120, w: 200, h: 200 }; // 120..320
  const ids = selectInBox(nodes, box, "outer");
  assert.deepEqual([...ids].sort(), [rectId, circleId].sort());
  // Box touching only the rect's far corner edge still counts (edge inclusive).
  const touch = { x: 50, y: 50, w: 50, h: 50 }; // 50..100 — touches rect's top-left corner at (100,100)
  assert.deepEqual(selectInBox(nodes, touch, "outer"), [rectId]);
});

test("selectInBox never selects the camera in either mode", () => {
  const nodes = nodesOf(scene());
  // A huge box covering the whole world — camera (0,0,1280,720) is fully inside,
  // yet must NOT be selected in inner OR outer.
  const big = { x: -100, y: -100, w: 5000, h: 5000 };
  for (const mode of ["inner", "outer"]) {
    const ids = selectInBox(nodes, big, mode);
    assert.ok(!ids.some((id) => nodes.find((n) => n.itemId === id)?.type === "camera"), `camera excluded in ${mode}`);
  }
});

test("selectInBox: rotated item uses the CONSERVATIVE world AABB", () => {
  // A rect rotated 45° about its center: its axis-aligned bounds grow. INNER
  // requires the enclosing box to cover the whole rotated AABB, not just the
  // unrotated footprint.
  let doc = newDocument();
  [doc] = withNewItem(doc, 0, {
    type: "rect", active: true, x: 100, y: 100, w: 100, h: 100,
    rotation: Math.PI / 4, scale: 1, z: 1,
    // default rotationAnchor = self.anchors.center → pivots about the center.
  });
  const nodes = nodesOf(doc);
  const rectId = nodes.find((n) => n.type === "rect").itemId;
  // The unrotated footprint (100..200) does NOT enclose the rotated AABB (which
  // extends ~±20px past the corners), so inner with the tight box selects nothing…
  assert.deepEqual(selectInBox(nodes, { x: 100, y: 100, w: 100, h: 100 }, "inner"), []);
  // …but a box padded to cover the diagonal span does enclose it.
  assert.deepEqual(selectInBox(nodes, { x: 60, y: 60, w: 180, h: 180 }, "inner"), [rectId]);
  // Outer selects it from the tight box too (they overlap).
  assert.deepEqual(selectInBox(nodes, { x: 100, y: 100, w: 100, h: 100 }, "outer"), [rectId]);
});

test("rectFromCorners: normalizes any drag direction to a positive rect", () => {
  assert.deepEqual(rectFromCorners({ x: 100, y: 50 }, { x: 20, y: 80 }), { x: 20, y: 50, w: 80, h: 30 });
  assert.deepEqual(rectFromCorners({ x: 0, y: 0 }, { x: 10, y: 10 }), { x: 0, y: 0, w: 10, h: 10 });
});

console.log(`\n${passed} tests passed`);
