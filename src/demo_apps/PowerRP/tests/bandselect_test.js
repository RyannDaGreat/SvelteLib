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
import { rotatedBBoxAABB } from "../core/view.js";

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

test("bandSelectable: boundable non-camera yes; camera + unboundable no", () => {
  const nodes = nodesOf(twoPointScene());
  const rect = nodes.find((n) => n.type === "rect");
  const camera = nodes.find((n) => n.type === "camera");
  assert.ok(bandSelectable(rect));
  assert.ok(!bandSelectable(camera)); // camera excluded (border-hit-only, mandatory)
  // TWO-POINT widgets ARE band-selectable (#194): they have no w/h and no resize
  // handles, but their width and height are the min/max of their endpoints, which
  // they now declare through localBounds.
  for (const type of ["line", "arrow", "elbow_arrow", "curved_arrow", "fancy_arrow", "tangent_lines"])
    assert.ok(bandSelectable(nodes.find((n) => n.type === type)), `${type} must be band-selectable`);
  // blur is NOT — honestly this time: a full-canvas backdrop sampler has no
  // geometry at all, so localBoundsOf reports null (nothing to enclose).
  assert.ok(!bandSelectable(nodes.find((n) => n.type === "blur")));
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

// ── TWO-POINT widgets (#194: "why does box select not work on lines?") ────────
//
// A line/arrow/elbow/curved/fancy arrow/tangent-lines widget has no w/h state and
// no resize handles, and used to be excluded from band select for that reason
// alone. Its height and width are just the min/max of its endpoints, so it now
// band-selects in BOTH modes like anything else. These run the REAL pipeline.

/**
 * A doc with a rect, one of every two-point widget, and a blur layer. Each item
 * carries its plugin's full defaults (what a real insert writes — app.addItem
 * passes plugin.defaults), then the overrides this suite pins positions with.
 */
function twoPointScene() {
  let doc = newDocument();
  const insert = (d, type, over) => withNewItem(d, 0, { ...registry.get(type).defaults, active: true, ...over })[0];
  doc = insert(doc, "rect", { x: 100, y: 100, w: 50, h: 50, rotation: 0, scale: 1, z: 1 });
  // line: (200,200)→(300,260), strokeWidth 3 (the arrow-family default) → the ink
  // rect pads a full stroke width per side, so the AABB is 197..303 x 197..263.
  doc = insert(doc, "line", { from: { x: 200, y: 200 }, to: { x: 300, y: 260 }, z: 2 });
  // arrow: (400,200)→(500,260), pad = max(strokeWidth 3, headWidth 12) = 12.
  doc = insert(doc, "arrow", { from: { x: 400, y: 200 }, to: { x: 500, y: 260 }, z: 3 });
  for (const type of ["elbow_arrow", "curved_arrow", "fancy_arrow"])
    doc = insert(doc, type, { from: { x: 700, y: 200 }, to: { x: 800, y: 260 }, z: 4 });
  // tangent_lines is parked far out of the way: its default shape pair spans
  // ~400..810 x 280..480, which would overlap the bands the tests above aim at
  // the line and the arrow.
  doc = insert(doc, "tangent_lines", {
    a: { x: 2000, y: 2000, halfW: 60, halfH: 60, rotation: 0 },
    b: { x: 2400, y: 2000, halfW: 150, halfH: 100, rotation: 0 },
    z: 5,
  });
  doc = insert(doc, "blur", { z: 6 });
  return doc;
}

test("selectInBox: a LINE and an ARROW have the AABB their endpoints imply", () => {
  const nodes = nodesOf(twoPointScene());
  assert.deepEqual(rotatedBBoxAABB(nodes.find((n) => n.type === "line")), { x: 197, y: 197, w: 106, h: 66 });
  assert.deepEqual(rotatedBBoxAABB(nodes.find((n) => n.type === "arrow")), { x: 388, y: 188, w: 124, h: 84 });
});

test("selectInBox INNER: a band enclosing a line's bounds catches the line", () => {
  const nodes = nodesOf(twoPointScene());
  const lineId = nodes.find((n) => n.type === "line").itemId;
  // 190..320 x 190..290 encloses the line's 197..303 x 197..263 and reaches no
  // other widget.
  assert.deepEqual(selectInBox(nodes, { x: 190, y: 190, w: 130, h: 100 }, "inner"), [lineId]);
  // The TIGHT endpoint box does NOT enclose it: the stroke pad spills past the
  // endpoints, and INNER means completely enclosed — the same conservative rule a
  // rotated rect obeys above.
  assert.deepEqual(selectInBox(nodes, { x: 200, y: 200, w: 100, h: 60 }, "inner"), []);
});

test("selectInBox OUTER: a band merely touching a line catches the line", () => {
  const nodes = nodesOf(twoPointScene());
  const lineId = nodes.find((n) => n.type === "line").itemId;
  // 250..350 x 250..350 clips the line's bottom-right and reaches nothing else.
  assert.deepEqual(selectInBox(nodes, { x: 250, y: 250, w: 100, h: 100 }, "outer"), [lineId]);
  // …and the same band in INNER mode catches nothing (partial overlap only).
  assert.deepEqual(selectInBox(nodes, { x: 250, y: 250, w: 100, h: 100 }, "inner"), []);
});

test("selectInBox: an ARROW band-selects in both modes, independently of the line", () => {
  const nodes = nodesOf(twoPointScene());
  const arrowId = nodes.find((n) => n.type === "arrow").itemId;
  assert.deepEqual(selectInBox(nodes, { x: 380, y: 180, w: 140, h: 100 }, "inner"), [arrowId]);
  assert.deepEqual(selectInBox(nodes, { x: 500, y: 250, w: 100, h: 100 }, "outer"), [arrowId]);
});

test("selectInBox: a 45deg diagonal line bounds by its endpoint hull, not a zero-height box", () => {
  // The user's point: "Lines also have a height with xw, even if they don't show
  // the handles for it." A 45deg line's bounds are a square, and a horizontal
  // line's are a flat-but-real band — never nothing.
  let doc = newDocument();
  [doc] = withNewItem(doc, 0, { type: "line", active: true, from: { x: 100, y: 100 }, to: { x: 200, y: 200 }, strokeWidth: 4, z: 1 });
  [doc] = withNewItem(doc, 0, { type: "line", active: true, from: { x: 400, y: 400 }, to: { x: 500, y: 400 }, strokeWidth: 4, z: 2 });
  const nodes = nodesOf(doc);
  const [diagonal, flat] = nodes.filter((n) => n.type === "line");
  assert.deepEqual(rotatedBBoxAABB(diagonal), { x: 96, y: 96, w: 108, h: 108 }); // a square
  assert.deepEqual(rotatedBBoxAABB(flat), { x: 396, y: 396, w: 108, h: 8 });     // flat, but 8 tall — the stroke
  // Both band-select in inner mode from a box covering their own bounds.
  assert.deepEqual(selectInBox(nodes, { x: 90, y: 90, w: 120, h: 120 }, "inner"), [diagonal.itemId]);
  assert.deepEqual(selectInBox(nodes, { x: 390, y: 390, w: 120, h: 20 }, "inner"), [flat.itemId]);
});

test("selectInBox: a world-covering band catches every two-point widget, never blur or the camera", () => {
  const nodes = nodesOf(twoPointScene());
  const caught = selectInBox(nodes, { x: -5000, y: -5000, w: 20000, h: 20000 }, "outer");
  const types = caught.map((id) => nodes.find((n) => n.itemId === id).type).sort();
  assert.deepEqual(types, ["arrow", "curved_arrow", "elbow_arrow", "fancy_arrow", "line", "rect", "tangent_lines"]);
});

test("rectFromCorners: normalizes any drag direction to a positive rect", () => {
  assert.deepEqual(rectFromCorners({ x: 100, y: 50 }, { x: 20, y: 80 }), { x: 20, y: 50, w: 80, h: 30 });
  assert.deepEqual(rectFromCorners({ x: 0, y: 0 }, { x: 10, y: 10 }), { x: 0, y: 0, w: 10, h: 10 });
});

console.log(`\n${passed} tests passed`);
