/**
 * Core smoke tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/core_test.js
 * The core being DOM-free is itself under test here: any window/document
 * reference in core/ would crash this file.
 */

import assert from "node:assert/strict";
import { NONE, applied, blendApplied, contains, setPath, deletePath, getPath, leaves, deepEqual, diffState } from "../core/deltas.js";
import { interpolate, ease, isHexColor, hexToRgb, rgbToHex } from "../core/interpolators.js";
import * as T from "../core/transform.js";
import { clipLineToRect, closestPointOnRectBorder } from "../core/geometry.js";
import { gridAssign, cellCenters, nearSquareGrid, effectiveRows } from "../core/grid.js";
import {
  newDocument, foldState, slideState, keyframed, unkeyframed, keyframeIndices,
  withNewItem, withNewSlide, withSlideDeleted, withSlideMoved,
  withSlideToggled, serialize, deserialize, allKeyframes, withNormalizedZ, bisectedZ,
  allDocumentItems,
} from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { deriveRenderTree, worldTransform, nodeFeatures, nodeAnchors, pickNode, pointInNodeBox, standardBBoxAnchors, cameraRect, collectMetaballScene, resolveMetaballScene } from "../core/derive.js";
import { evaluateState, resolveRef, slugMap, displayToStored } from "../core/expressions.js";
import { bentoPlugin, bentoAnchors } from "../plugins/bento.js";
import { solveSnap, axisLock } from "../core/snap.js";
import { createCommands } from "../core/commands.js";
import { rpFuzzyScore } from "../core/fuzzy.js";
import { createShortcuts } from "../core/shortcuts.js";
import { createUndo } from "../core/undo.js";
import { rectPlugin } from "../plugins/rect.js";
import { circlePlugin } from "../plugins/circle.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { distToSegment } from "../core/outline.js";
import { cameraPlugin } from "../plugins/camera.js"; // newDocument() always contains THE camera

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}

// ── deltas ──────────────────────────────────────────────────────────────────
test("applied: set/add/delete/recurse", () => {
  assert.deepEqual(applied({ a: 1, b: 2 }, { a: 10, b: NONE, c: 3 }), { a: 10, c: 3 });
  assert.deepEqual(applied({ o: { x: 1, y: 2 } }, { o: { x: 5 } }), { o: { x: 5, y: 2 } });
});
test("blendApplied: lerp / discrete / alpha edges", () => {
  assert.deepEqual(blendApplied({ x: 0 }, { x: 10 }, 0.5), { x: 5 });
  assert.deepEqual(blendApplied({ x: 0 }, { x: 10 }, 0), { x: 0 });
  assert.deepEqual(blendApplied({ s: "a" }, { s: "b" }, 0.01), { s: "b" });
  assert.deepEqual(blendApplied({ a: 1 }, { b: { c: 2 } }, 0.5), { a: 1, b: { c: 2 } });
  const st = { x: 0 };
  blendApplied(st, { x: 10 }, 0.5);
  assert.deepEqual(st, { x: 0 }); // purity
});
test("contains", () => {
  assert.ok(contains({ a: 1, b: { c: 2 } }, { b: { c: 2 } }));
  assert.ok(!contains({ a: 1 }, { a: 2 }));
  assert.ok(contains({ a: 1 }, { zzz: NONE }));
});
test("path helpers", () => {
  assert.deepEqual(setPath({}, ["a", "b"], 1), { a: { b: 1 } });
  assert.deepEqual(deletePath({ a: { b: 1, c: 2 } }, ["a", "b"]), { a: { c: 2 } });
  assert.deepEqual(deletePath({ a: { b: 1 } }, ["a", "b"]), {});
  assert.equal(getPath({ a: { b: 7 } }, ["a", "b"]), 7);
  assert.deepEqual(leaves({ a: { x: 1 }, b: NONE }), [[["a", "x"], 1], [["b"], NONE]]);
});
test("deepEqual: primitives, strings, arrays, trees", () => {
  assert.ok(deepEqual(5, 5));
  assert.ok(deepEqual("=100+shape_2.x", "=100+shape_2.x"));
  assert.ok(deepEqual([1, 2], [1, 2]));
  assert.ok(deepEqual({ x: 1, y: 2 }, { x: 1, y: 2 }));
  assert.ok(!deepEqual(5, "5")); // no coercion
  assert.ok(!deepEqual({ x: 1, y: 2 }, { x: 1, y: 3 }));
  assert.ok(!deepEqual([1, 2], [1, 2, 3]));
});
test("diffState: only CHANGED keys survive (unchanged ⇒ omitted, equation preserved)", () => {
  // The interaction-commit rule: an unchanged key must be ABSENT so its stored
  // raw value (literal OR "=equation") is left untouched.
  assert.deepEqual(diffState({ x: 10, y: 20 }, { x: 15, y: 20 }, ["x", "y"]), { x: 15 });
  assert.deepEqual(diffState({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 120, h: 50 }, ["x", "y", "w", "h"]), { w: 120 });
  assert.deepEqual(diffState({ x: 5 }, { x: 5 }, ["x"]), {}); // nothing changed
  // `keys` scopes the comparison — an untouched key outside `keys` is ignored.
  assert.deepEqual(diffState({ x: 1, rotation: 0 }, { x: 2, rotation: 9 }, ["x"]), { x: 2 });
});

// ── interpolators ────────────────────────────────────────────────────────────
test("interpolate types", () => {
  assert.equal(interpolate(0, 10, 0.5), 5);
  assert.equal(interpolate(1, 4, 0.5), 3); // int rounding
  assert.equal(interpolate("#000000", "#ffffff", 0.5), "#808080");
  assert.deepEqual(interpolate([0, 0], [10, 20], 0.5), [5, 10]);
  assert.equal(interpolate("a", "b", 0.5), "b");
  assert.equal(interpolate(false, true, 0.2), true);
});

test("alpha hex colors: parse, compose, tween (Round 10 'colors support ALPHA')", () => {
  // 8-digit and shorthand-with-alpha forms are hex colors; junk is not.
  assert.equal(isHexColor("#7aa2f780"), true);
  assert.equal(isHexColor("#f08c"), true);
  assert.equal(isHexColor("#7aa2f7"), true);
  assert.equal(isHexColor("#7aa2f7801"), false); // 9 digits is nothing
  // Channel round-trip keeps the alpha byte.
  assert.deepEqual(hexToRgb("#7aa2f780"), [122, 162, 247, 128]);
  assert.equal(rgbToHex([122, 162, 247, 128]), "#7aa2f780");
  assert.deepEqual(hexToRgb("#f08c"), [255, 0, 136, 204]); // shorthand digits double
  // Alpha tweens per-channel like r/g/b…
  assert.equal(interpolate("#ff000000", "#ff0000ff", 0.5), "#ff000080");
  // …and a plain #rrggbb endpoint reads as opaque (255) in a mixed pair.
  assert.equal(interpolate("#ff0000", "#ff000000", 0.5), "#ff000080");
  assert.equal(interpolate("#00000080", "#ffffff80", 0.5), "#80808080"); // rgb tweens, alpha holds
  // Endpoints are exact (alpha 0 / 1 return a / b verbatim).
  assert.equal(interpolate("#ff0000", "#ff000000", 0), "#ff0000");
  assert.equal(interpolate("#ff0000", "#ff000000", 1), "#ff000000");
  // Doc-level: a fill keyframed opaque → translucent tweens through the fold
  // (blendApplied routes leaves through interpolate — the behavior the
  // presenter/editor actually exercise mid-slide).
  const base = { items: { r: { type: "rect", fill: "#7aa2f7" } } };
  const mid = blendApplied(base, { items: { r: { fill: "#7aa2f700" } } }, 0.5);
  assert.equal(mid.items.r.fill, "#7aa2f780");
});
test("ease is loud on unknown names", () => {
  assert.throws(() => ease("bogus"), /Unknown ease/);
  approx(ease("cubic")(1), 1);
});

// ── transform ────────────────────────────────────────────────────────────────
test("similarity transform apply/compose/invert roundtrip", () => {
  const t = { x: 10, y: -3, rotation: 0.7, scale: 2.5 };
  const p = T.apply(t, 4, 5);
  const back = T.apply(T.invert(t), p.x, p.y);
  approx(back.x, 4);
  approx(back.y, 5);
  const o = { x: 1, y: 2, rotation: 0.3, scale: 0.5 };
  const both = T.apply(T.compose(o, t), 4, 5);
  const seq = T.apply(o, p.x, p.y);
  approx(both.x, seq.x);
  approx(both.y, seq.y);
});
test("worldTransform commutes with translation (drag/snap probe geometry)", () => {
  // Opus1 review finding #2's fix relies on this: a rotated item translated
  // by (dx,dy) must have its whole world geometry translate by (dx,dy) —
  // the default center pivot moves WITH the item. The old snap probe patched
  // world.x directly (wrong for rotated items, ~80px off); the fix re-derives
  // via worldTransform, which this property guarantees is a pure translation.
  const state = { x: 100, y: 100, w: 240, h: 140, rotation: 0.7, scale: 1.25 };
  const [dx, dy] = [37, -18];
  const before = worldTransform(state);
  const after = worldTransform({ ...state, x: state.x + dx, y: state.y + dy });
  for (const [lx, ly] of [[0, 0], [240, 0], [0, 140], [240, 140], [120, 70]]) {
    const p0 = T.apply(before, lx, ly);
    const p1 = T.apply(after, lx, ly);
    approx(p1.x, p0.x + dx);
    approx(p1.y, p0.y + dy);
  }
});
test("aboutPivot: rotation 0 is identity; pivot is the fixed point under rotation", () => {
  // rotation 0 → byte-identical to the input (unrotated content is untouched).
  assert.deepEqual(T.aboutPivot({ x: 100, y: 100, rotation: 0, scale: 1 }, 220, 170),
    { x: 100, y: 100, rotation: 0, scale: 1 });
  // The world anchor stays fixed under ANY rotation (incl. >2π spins) and scale.
  const t = { x: 100, y: 100, rotation: 0, scale: 1.5 };
  const A = { x: 220, y: 170 };
  const ref = T.apply(T.aboutPivot(t, A.x, A.y), (A.x - t.x) / t.scale, (A.y - t.y) / t.scale);
  for (const rot of [0.1, 1, Math.PI / 2, Math.PI, 7.0]) {
    const w = T.aboutPivot({ ...t, rotation: rot }, A.x, A.y);
    const p = T.apply(w, (A.x - t.x) / t.scale, (A.y - t.y) / t.scale);
    approx(p.x, ref.x);
    approx(p.y, ref.y);
    approx(w.rotation, rot); // rotation/scale are preserved (parametric form intact)
    approx(w.scale, t.scale);
  }
  // Concrete 90° about a 240×140 box center: top-left orbits to (290, 50).
  const tl = T.apply(T.aboutPivot({ x: 100, y: 100, rotation: Math.PI / 2, scale: 1 }, 220, 170), 0, 0);
  approx(tl.x, 290);
  approx(tl.y, 50);
});
test("scale:0 degenerate transforms stay FINITE (registry #3 — fade-by-shrink)", () => {
  // aboutPivot and invert both divide by scale; a rotated item scaled through 0
  // (a plausible authoring value) produced NaN → requireFinite threw → the paint
  // loop halted. The degenerate result must be finite: the shape collapses to a
  // single point AT the pivot, and hit-tests (via invert) then miss cleanly.
  const w = T.aboutPivot({ x: 100, y: 100, rotation: Math.PI / 4, scale: 0 }, 220, 170);
  assert.deepEqual(w, { x: 220, y: 170, rotation: Math.PI / 4, scale: 0 }); // collapsed to the pivot
  assert.ok(Number.isFinite(w.x) && Number.isFinite(w.y));
  const inv = T.invert(w);
  assert.ok(Number.isFinite(inv.x) && Number.isFinite(inv.y) && inv.scale === 0);
  // apply(invert) maps every world point to a single finite point (zero-area
  // shape ⇒ nothing to hit) — never NaN.
  const p = T.apply(inv, 999, -999);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

// ── geometry ─────────────────────────────────────────────────────────────────
test("clipLineToRect", () => {
  assert.deepEqual(clipLineToRect(5, 5, 1, 0, { x: 0, y: 0, w: 10, h: 10 }), [0, 5, 10, 5]);
  assert.equal(clipLineToRect(50, 50, 1, 0, { x: 0, y: 0, w: 10, h: 10 }), null);
  const diag = clipLineToRect(5, 5, 1, 1, { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(diag, [0, 0, 10, 10]);
});
test("closest points", () => {
  assert.deepEqual(closestPointOnRectBorder({ x: 0, y: 0, w: 10, h: 10 }, 25, 5), { x: 10, y: 5 });
  assert.deepEqual(closestPointOnRectBorder({ x: 0, y: 0, w: 10, h: 10 }, 5, 4), { x: 5, y: 0 });
});

// ── document ─────────────────────────────────────────────────────────────────
test("document fold + keyframes + symlink semantics", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, z: 0 });
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["items", id, "x"], 100);
  assert.equal(foldState(doc, 0).items[id].x, 0);
  assert.equal(foldState(doc, 1).items[id].x, 100);
  assert.equal(foldState(doc, 1, 0.5).items[id].x, 50); // tween mid-transition
  assert.equal(foldState(doc, 1, 0.5).items[id].w, 10); // untouched props inherited (symlink)
  assert.deepEqual(keyframeIndices(doc, ["items", id, "x"]), [0, 1]);
  doc = unkeyframed(doc, 1, ["items", id, "x"]);
  assert.equal(foldState(doc, 1).items[id].x, 0);
});
test("slide insert shifts numbers, UUIDs stable; move/delete", () => {
  let doc = newDocument();
  const firstId = doc.slides[0].id;
  [doc] = withNewSlide(doc, 0);
  assert.equal(doc.slides[0].id, firstId);
  assert.equal(doc.slides.length, 2);
  doc = withSlideMoved(doc, 1, -1);
  assert.equal(doc.slides[1].id, firstId);
  doc = withSlideDeleted(doc, 0);
  assert.equal(doc.slides.length, 1);
  assert.throws(() => withSlideDeleted(doc, 0), /only slide/);
});
test("disabled slide's delta is skipped in the fold and restored on re-enable", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { type: "rect", x: 0, z: 0 });
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["items", id, "x"], 100);
  [doc] = withNewSlide(doc, 1);
  doc = keyframed(doc, 2, ["items", id, "x"], 200);
  const toggled = withSlideToggled(doc, 1);
  assert.equal(foldState(toggled, 1).items[id].x, 0); // slide 2's delta skipped
  assert.equal(foldState(toggled, 2).items[id].x, 200); // slide 3 unaffected
  assert.equal(foldState(toggled, 2, 0.5).items[id].x, 100); // tween from slide-1 state
  assert.equal(foldState(withSlideToggled(toggled, 1), 1).items[id].x, 100); // re-enabled
});

test("serialize roundtrip + loud on garbage", () => {
  const doc = newDocument();
  assert.deepEqual(deserialize(serialize(doc)), doc);
  assert.throws(() => deserialize("{}"), /Invalid PowerRP document/);
});
test("fold cache: same doc object → same state object", () => {
  const doc = newDocument();
  assert.equal(slideState(doc, 0), slideState(doc, 0));
});
test("allDocumentItems: union across slides, creation order, first-write type/name", () => {
  const doc = {
    slides: [
      { delta: { items: { a: { type: "rect", name: "Box" } } } },
      { delta: { items: { b: { type: "circle" }, a: { x: 5 } } } }, // a's later keyframe adds nothing new
      { delta: { items: { b: { name: "Moon" } } } }, // late name still found (first write of the field)
    ],
  };
  assert.deepEqual(allDocumentItems(doc), [
    { id: "a", type: "rect", name: "Box" },
    { id: "b", type: "circle", name: "Moon" },
  ]);
  assert.deepEqual(allDocumentItems({ slides: [{ delta: {} }] }), []);
  // Delete-sentinel (null) item entries are not identities.
  assert.deepEqual(allDocumentItems({ slides: [{ delta: { items: { a: null } } }] }), []);
});

// ── z-order helpers ──────────────────────────────────────────────────────────
test("bisectedZ + withNormalizedZ", () => {
  assert.equal(bisectedZ([["a", 1], ["b", 2], ["c", 3]], "a", +1), 2.5);
  assert.equal(bisectedZ([["a", 1], ["b", 2]], "b", +1), 3);
  assert.equal(bisectedZ([["a", 1], ["b", 2], ["c", 3]], "c", -1), 1.5);
  let doc = newDocument();
  let a, b;
  [doc, a] = withNewItem(doc, 0, { type: "rect", z: 0.1 });
  [doc, b] = withNewItem(doc, 0, { type: "rect", z: 0.17 });
  doc = withNormalizedZ(doc);
  assert.equal(foldState(doc, 0).items[a].z, 1);
  assert.equal(foldState(doc, 0).items[b].z, 2);
});

// ── registry + derive ────────────────────────────────────────────────────────
const registry = createRegistry();
registry.register(rectPlugin);
registry.register(circlePlugin);
registry.register(arrowPlugin);
registry.register(cameraPlugin);
registry.register(bentoPlugin);
test("registry is loud", () => {
  assert.throws(() => registry.register(rectPlugin), /Duplicate/);
  assert.throws(() => registry.get("nope"), /Unknown widget type/);
});
test("derive: z-sort, anchors, features, pick", () => {
  const state = {
    items: {
      r1: { ...rectPlugin.defaults, x: 0, y: 0, w: 10, h: 10, z: 2 },
      c1: { ...circlePlugin.defaults, x: 0, y: 0, w: 10, h: 10, z: 1 },
    },
  };
  const nodes = deriveRenderTree(state, registry);
  assert.deepEqual(nodes.map((n) => n.id), ["c1", "r1"]);
  const anchors = nodeAnchors(nodes[1]);
  assert.deepEqual(anchors.find((a) => a.id === "cm"), { id: "cm", x: 5, y: 5 });
  assert.ok(nodeFeatures(nodes[1]).some((f) => f.kind === "line"));
  assert.equal(pickNode(nodes, 5, 5).id, "r1"); // topmost wins
  assert.equal(pickNode(nodes, 500, 500), null);
});
// ── pointInNodeBox: rotation-aware point-in-OBB (selected-object drag priority
// grabs a selection anywhere in its bounding box, not just its silhouette) ────
test("pointInNodeBox: axis-aligned box — inside true, outside false", () => {
  const s = { x: 100, y: 100, w: 200, h: 120, rotation: 0, scale: 1 };
  assert.ok(pointInNodeBox(s, 150, 160)); // interior
  assert.ok(pointInNodeBox(s, 100, 100)); // top-left corner (inclusive)
  assert.ok(pointInNodeBox(s, 300, 220)); // bottom-right corner (inclusive)
  assert.ok(!pointInNodeBox(s, 350, 160)); // right of the box
  assert.ok(!pointInNodeBox(s, 150, 99)); // above the box
});
test("pointInNodeBox: THIN LINE — the empty sliver of its box is grabbable (the fix)", () => {
  // A near-1D horizontal bar (h tiny): its silhouette is a hairline, but the
  // WHOLE 200×4 box counts — pressing the empty box interior grabs it.
  const line = { x: 100, y: 100, w: 200, h: 4, rotation: 0, scale: 1 };
  assert.ok(pointInNodeBox(line, 250, 102)); // mid-box, off the hairline center
  assert.ok(!pointInNodeBox(line, 250, 110)); // just below the thin box
});
test("pointInNodeBox: CIRCLE bbox corner — box hits where the ellipse hitTest misses", () => {
  // The real gap the fix closes: circle.hitTest is the ellipse, so pickNode
  // MISSES a bbox corner; pointInNodeBox (whole box) catches it.
  const state = { items: { c1: { ...circlePlugin.defaults, x: 0, y: 0, w: 100, h: 100, z: 0 } } };
  const node = deriveRenderTree(evaluateState(state, registry).state, registry)[0];
  const cornerX = 4, cornerY = 4; // deep in the TL bbox corner, outside the ellipse
  assert.equal(pickNode([node], cornerX, cornerY), null); // ellipse silhouette misses it
  assert.ok(pointInNodeBox(node.state, cornerX, cornerY)); // but the OBB catches it
});
test("pointInNodeBox: rotation-anchor-aware (90° box pivots to its world center)", () => {
  // A 200×120 box rotated 90° pivots about its center → world center (200,160),
  // NOT its stored (100,100). The test must follow that pivot.
  const s = { x: 100, y: 100, w: 200, h: 120, rotation: Math.PI / 2, scale: 1 };
  assert.ok(pointInNodeBox(s, 200, 160)); // the pivoted world center is inside
  assert.ok(!pointInNodeBox(s, 110, 110)); // near the STORED xy — outside the pivoted OBB
});
test("pointInNodeBox: no-w/h widget (arrow-like) has no box → always false", () => {
  assert.ok(!pointInNodeBox({ x: 10, y: 10, rotation: 0, scale: 1 }, 10, 10));
  assert.ok(!pointInNodeBox({ x: 10, y: 10, w: 50, rotation: 0, scale: 1 }, 20, 20)); // h missing
});
// ── interaction commit preserves untouched-axis equations (the move/resize
// equation-clobber bug) ──────────────────────────────────────────────────────
test("commit round-trip: a move changing ONLY x leaves y's EQUATION intact", () => {
  // End-to-end mirror of the fix: an item whose y is an equation. The FIXED
  // move-only-x commit is a delta with x alone (diffState omits y), so
  // commitPreview's keyframed walk touches only x — y's stored equation string
  // must survive fold + evaluate, not be overwritten with a literal.
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { ...rectPlugin.defaults, x: 40, y: "=100+7", w: 100, h: 50, z: 0 });
  doc = keyframed(doc, 0, ["items", id, "x"], 75); // the sole leaf a move-only-x preview commits
  const rawState = foldState(doc, 0);
  assert.equal(rawState.items[id].x, 75); // grabbed axis: literal committed
  assert.equal(rawState.items[id].y, "=100+7"); // untouched axis: EQUATION SURVIVES (bug clobbered it to a number)
  assert.equal(evaluateState(rawState, registry).state.items[id].y, 107); // still resolves
});

// ── rotation about an anchor (manifest Round 11) ─────────────────────────────
test("rotation anchor: default self-center pivot; box rotates IN PLACE", () => {
  // New item carries the equation default rotationAnchor = self.anchors.center.
  const raw = { items: { r1: { ...rectPlugin.defaults, x: 100, y: 100, w: 240, h: 140, rotation: Math.PI / 2 } } };
  const { state, errors } = evaluateState(raw, registry);
  assert.equal(errors.size, 0);
  assert.deepEqual(state.items.r1.rotationAnchor, { x: 220, y: 170 }); // equation → world center
  const node = deriveRenderTree(state, registry)[0];
  const center = T.apply(node.world, 240 / 2, 140 / 2);
  approx(center.x, 220); // the visible center is unmoved by the rotation
  approx(center.y, 170);
});
test("rotation anchor: rotation 0 world equals T.fromState (unrotated content byte-identical)", () => {
  const raw = { items: { r1: { ...rectPlugin.defaults, x: 55, y: 66, w: 240, h: 140, rotation: 0 } } };
  const node = deriveRenderTree(evaluateState(raw, registry).state, registry)[0];
  assert.deepEqual(node.world, T.fromState({ x: 55, y: 66 }));
  // worldTransform is the pure kernel; same result directly.
  assert.deepEqual(worldTransform({ x: 55, y: 66, rotation: 0, scale: 1, w: 240, h: 140 }), T.fromState({ x: 55, y: 66 }));
});
test("rotation anchor: OLD doc without rotationAnchor falls back to center (no migration)", () => {
  // An item predating rotation anchors — no rotationAnchor key at all.
  const legacy = { items: { r1: { type: "rect", x: 100, y: 100, w: 240, h: 140, rotation: Math.PI / 2 } } };
  const node = deriveRenderTree(evaluateState(legacy, registry).state, registry)[0];
  const center = T.apply(node.world, 120, 70);
  approx(center.x, 220); // pivots about center exactly like a fresh item
  approx(center.y, 170);
});
test("rotation anchor: mid-tween rotation orbits the anchor (center fixed at every alpha)", () => {
  let doc = newDocument();
  let r1;
  [doc, r1] = withNewItem(doc, 0, { ...rectPlugin.defaults, x: 100, y: 100, w: 240, h: 140, rotation: 0 });
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["items", r1, "rotation"], Math.PI);
  for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    const st = evaluateState(foldState(doc, 1, a), registry).state;
    const node = deriveRenderTree(st, registry).find((n) => n.id === r1);
    const center = T.apply(node.world, 120, 70);
    approx(center.x, 220); // the center never leaves (220,170) as the box spins
    approx(center.y, 170);
  }
});
test("rotation anchor: custom / equation-valued pivot orbits an external point", () => {
  // Numeric custom pivot at world (0,0): the whole box orbits the origin.
  const numeric = { items: { r1: { ...rectPlugin.defaults, x: 100, y: 100, w: 240, h: 140, rotation: Math.PI / 2, rotationAnchor: { x: 0, y: 0 } } } };
  const tl = T.apply(deriveRenderTree(evaluateState(numeric, registry).state, registry)[0].world, 0, 0);
  approx(tl.x, -100); // (100,100) rotated 90° about the origin
  approx(tl.y, 100);
  // Equation-valued pivot referencing a variable: resolves, then pivots there.
  const eqn = { vars: { px: 50, py: 50 }, items: { r1: { ...rectPlugin.defaults, x: 100, y: 100, w: 240, h: 140, rotation: Math.PI / 2, rotationAnchor: { x: "px", y: "py" } } } };
  const ev = evaluateState(eqn, registry);
  assert.equal(ev.errors.size, 0);
  assert.deepEqual(ev.state.items.r1.rotationAnchor, { x: 50, y: 50 });
  const node = deriveRenderTree(ev.state, registry)[0];
  const pivot = T.apply(node.world, 50 - 100, 50 - 100); // pivot's local coords in the base frame
  approx(pivot.x, 50); // the referenced point is the fixed point
  approx(pivot.y, 50);
});
// ADAPTATION (THE UNIFICATION): {item, anchor} binding objects and
// resolveBinding/resolveEndpoints no longer exist — anchor bindings are now
// equation strings evaluated in the derivation stage (core/expressions.js,
// where the full behavior is tested). This test keeps the same scenario
// (free point, preset anchor, circle closest-point, missing item) through
// the new mechanism.
test("arrow endpoints as equations: free, preset, closest, missing item", () => {
  const state = {
    items: {
      c1: { ...circlePlugin.defaults, x: 100, y: 100, w: 20, h: 20, z: 0 },
      a1: { ...arrowPlugin.defaults, from: { x: 110, y: 0 }, to: { x: "@c1_closest.x", y: "@c1_closest.y" } },
      a2: { ...arrowPlugin.defaults, from: { x: 3, y: 4 }, to: { x: "@c1_cm.x", y: "@c1_cm.y" } },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.deepEqual(s.items.a2.from, { x: 3, y: 4 }); // free point untouched
  assert.deepEqual(s.items.a2.to, { x: 110, y: 110 }); // preset anchor (center)
  approx(s.items.a1.to.x, 110);
  approx(s.items.a1.to.y, 100); // closest: top of the circle, toward the point above
  // Missing item: loud error + plugin-default fallback (never a silent NaN).
  const ghost = { items: { a1: { ...arrowPlugin.defaults, to: { x: "@dead0000_cm.x", y: 5 } } } };
  const originalError = console.error;
  console.error = () => {}; // the loud report is asserted in expressions_test.js
  const r = evaluateState(ghost, registry);
  console.error = originalError;
  assert.match(r.errors.get("items.a1.to.x"), /Unknown item/);
  assert.equal(r.state.items.a1.to.x, arrowPlugin.defaults.to.x);
});
test("arrow: editPoints on evaluated state; distToSegment", () => {
  const node = { state: { ...arrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: 10, y: 0 } } };
  assert.deepEqual(arrowPlugin.editPoints(node), [
    { key: "from", x: 0, y: 0 },
    { key: "to", x: 10, y: 0 },
  ]);
  assert.equal(distToSegment(5, 3, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
});

test("cameraRect: default camera in new docs, tweens, meta fallback", () => {
  const doc = newDocument();
  const rect = cameraRect(foldState(doc, 0), doc.meta);
  assert.deepEqual(rect, { x: 0, y: 0, w: 1280, h: 720, background: "#ffffff" });
  const camId = Object.entries(foldState(doc, 0).items).find(([, s]) => s.type === "camera")[0];
  let doc2;
  [doc2] = withNewSlide(doc, 0);
  doc2 = keyframed(doc2, 1, ["items", camId, "w"], 640);
  assert.equal(cameraRect(foldState(doc2, 1, 0.5), doc2.meta).w, 960); // camera tweens
  assert.deepEqual(cameraRect({ items: {} }, { slideW: 10, slideH: 5 }), { x: 0, y: 0, w: 10, h: 5, background: "#ffffff" });
});

// ── metaball archetype sibling query (cross-widget fusion) ────────────────────
// The metaball twin of the sky sibling query: every metaball widget's balls are
// collected in WORLD space, and ONE leader gets flagged to render the fused field.
const mbPlugin = (localBalls) => ({ capabilities: { metaball: true }, localBalls });
const mbNode = (itemId, world, balls) => ({ itemId, state: {}, world, plugin: mbPlugin(() => balls) });
test("collectMetaballScene: lifts each widget's local balls into world (scale/rotation baked in)", () => {
  assert.deepEqual(collectMetaballScene([]), { balls: [] });
  // identity world: local ball passes through unchanged
  assert.deepEqual(
    collectMetaballScene([mbNode("m", { x: 0, y: 0, rotation: 0, scale: 1 }, [{ type: "sphere", cx: 100, cy: 100, r: 50, len: 0, ang: 0 }])]),
    { balls: [{ type: "sphere", x: 100, y: 100, r: 50, len: 0, ang: 0 }] },
  );
  // world scale 2 + offset: centre translates+scales, radius scales, angle unchanged (no rotation)
  assert.deepEqual(
    collectMetaballScene([mbNode("m", { x: 10, y: 0, rotation: 0, scale: 2 }, [{ type: "sphere", cx: 5, cy: 0, r: 3, len: 0, ang: 0 }])]),
    { balls: [{ type: "sphere", x: 20, y: 0, r: 6, len: 0, ang: 0 }] },
  );
});
test("collectMetaballScene: sorted by source itemId (deterministic pure fn)", () => {
  const w = { x: 0, y: 0, rotation: 0, scale: 1 };
  const scene = collectMetaballScene([
    mbNode("z", w, [{ type: "sphere", cx: 9, cy: 0, r: 1, len: 0, ang: 0 }]),
    mbNode("a", w, [{ type: "sphere", cx: 1, cy: 0, r: 1, len: 0, ang: 0 }]),
  ]);
  assert.deepEqual(scene.balls.map((b) => b.x), [1, 9]); // "a" before "z"
});
test("resolveMetaballScene: first metaball is leader, rest false; non-metaball untouched", () => {
  const w = { x: 0, y: 0, rotation: 0, scale: 1 };
  const passthrough = resolveMetaballScene([{ itemId: "r", type: "rect", state: {}, plugin: { capabilities: {} } }]);
  assert.equal(passthrough.length, 1);
  assert.equal(passthrough[0].state.metaballScene, undefined); // non-participant unaffected
  const nodes = resolveMetaballScene([mbNode("a", w, []), mbNode("b", w, [])]);
  assert.deepEqual(nodes.map((n) => n.state.metaballLeader), [true, false]);
  assert.ok(nodes.every((n) => n.state.metaballScene)); // every metaball carries the shared summary
});

// ── snap ─────────────────────────────────────────────────────────────────────
test("snap: line align, point wins, axis hysteresis", () => {
  const line = { kind: "line", x: 100, y: 0, dx: 0, dy: 1, id: "e" };
  const near = solveSnap([{ kind: "point", x: 97, y: 50, id: "p" }], [line], 5);
  approx(near.dx, 3);
  approx(near.dy, 0);
  assert.equal(near.guides.length, 1);
  const far = solveSnap([{ kind: "point", x: 80, y: 50, id: "p" }], [line], 5);
  assert.deepEqual([far.dx, far.dy, far.guides.length], [0, 0, 0]);
  const point = { kind: "point", x: 99, y: 49, id: "q" };
  const both = solveSnap([{ kind: "point", x: 97, y: 50, id: "p" }], [line, point], 5);
  approx(both.dx, 2);
  approx(both.dy, -1); // point snap beat the line snap
  assert.equal(axisLock(10, 2, null), "x");
  assert.equal(axisLock(10, 12, "x"), "x");
  assert.equal(axisLock(10, 20, "x"), "y");
});

// ── commands / shortcuts / undo ──────────────────────────────────────────────
test("rp fuzzy + command registry + MRU + submenus", () => {
  // rp semantics: LOWER = better, null = no match, prefix beats non-prefix.
  assert.ok(rpFuzzyScore("dh", "Distribute Horizontally") !== null);
  assert.equal(rpFuzzyScore("xyz", "Distribute"), null);
  assert.ok(rpFuzzyScore("d", "dict") < rpFuzzyScore("d", "add"));
  const cmds = createCommands();
  cmds.add({ id: "a", title: "Distribute Horizontally", run: () => {} });
  cmds.add({ id: "b", title: "Distribute Vertically", run: () => {} });
  cmds.add({ id: "menu", title: "Sub Menu", children: [{ id: "child", title: "Child Thing", run: () => {} }] });
  assert.equal(cmds.search("dis h", null)[0].id, "a");
  assert.equal(cmds.search("", null, cmds.get("menu"))[0].id, "child"); // submenu pool
  cmds.markUsed("b");
  assert.equal(cmds.search("", null)[0].id, "b"); // MRU first on empty query
  const mru = cmds.usageList();
  const cmds2 = createCommands();
  cmds2.add({ id: "a", title: "A", run: () => {} });
  cmds2.add({ id: "b", title: "B", run: () => {} });
  cmds2.loadUsage(mru);
  assert.equal(cmds2.search("", null)[0].id, "b"); // MRU survives persistence
  assert.throws(() => cmds.add({ id: "a", title: "dupe", run: () => {} }), /Duplicate/);
});
test("shortcuts: dispatch + context filtering + hints", () => {
  const sc = createShortcuts();
  let ran = 0;
  sc.add({ keys: ["Ctrl", "Z"], label: "Undo", when: (c) => c.mode === "edit", run: () => ran++ });
  sc.add({ keys: ["mouse_left"], label: "Select", when: () => true });
  assert.equal(sc.hints({ mode: "edit" }).length, 2);
  assert.equal(sc.hints({ mode: "present" }).length, 1);
  const ev = { key: "z", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
  assert.ok(sc.dispatch(ev, { mode: "edit" }));
  assert.ok(!sc.dispatch(ev, { mode: "present" }));
  assert.equal(ran, 1);
});
test("undo/redo", () => {
  const u = createUndo("v1");
  u.commit("v2");
  u.commit("v3");
  assert.equal(u.undo(), "v2");
  assert.equal(u.redo(), "v3");
  u.undo();
  u.commit("v4"); // clears future
  assert.equal(u.redo(), "v4");
  assert.deepEqual([u.canUndo, u.canRedo], [true, false]);
});

test("structural keyframing: a gradient stop's offset+color tweens across 2 slides", () => {
  // Slide 0 creates a rect with a linear-gradient fill (2 stops); slide 1
  // SPARSE-keyframes stop[0]'s offset AND color by INDEX path. The tween must
  // blend that stop element-wise (lazy start from the folded value) while the
  // untouched sibling stop is preserved — and the shared/cached slide-0 array
  // must NOT be corrupted (copy-on-write in mutBlendApply).
  let doc = { meta: {}, slides: [
    { id: "s0", name: "s0", delta: { items: { r1: { type: "rect", x: 0,
      fill: { type: "linearGradient", linear: {
        stops: [{ offset: 0.2, color: "#ff0000" }, { offset: 0.8, color: "#0000ff" }],
        from: { x: 0, y: 0 }, to: { x: 1, y: 0 } } } } } } },
    { id: "s1", name: "s1", delta: {} },
  ] };
  doc = keyframed(doc, 1, ["items", "r1", "fill", "linear", "stops", 0, "offset"], 0.6);
  doc = keyframed(doc, 1, ["items", "r1", "fill", "linear", "stops", 0, "color"], "#00ff00");
  const half = foldState(doc, 1, 0.5).items.r1.fill.linear.stops;
  approx(half[0].offset, 0.4); // lerp(0.2, 0.6, 0.5)
  assert.equal(half[0].color, "#808000"); // #ff0000 → #00ff00 midpoint
  approx(half[1].offset, 0.8); // untouched sibling
  assert.equal(half[1].color, "#0000ff");
  const s0 = slideState(doc, 0).items.r1.fill.linear.stops;
  assert.equal(s0[0].offset, 0.2, "cached slide-0 array uncorrupted");
  assert.equal(s0[0].color, "#ff0000", "cached slide-0 array uncorrupted");
  assert.equal(foldState(doc, 1, 1).items.r1.fill.linear.stops[0].offset, 0.6);
  // hasKeyframe / getPath reach the sparse index leaf.
  assert.ok(getPath(doc.slides[1].delta, ["items", "r1", "fill", "linear", "stops", 0, "offset"]) === 0.6);
});
test("structural keyframing: a WHOLE-list leaf keyframe tweens element-wise; length change is discrete", () => {
  // Keyframing the ENTIRE stops array as one leaf (the coarse path) tweens
  // per element when lengths match, and snaps discretely when they differ.
  const A = [{ offset: 0.2, color: "#000000" }, { offset: 0.8, color: "#000000" }];
  const B = [{ offset: 0.6, color: "#ffffff" }, { offset: 0.8, color: "#000000" }];
  const mid = blendApplied({ stops: A }, { stops: B }, 0.5).stops;
  approx(mid[0].offset, 0.4); // lerp(0.2, 0.6)
  assert.equal(mid[0].color, "#808080");
  // Length change (2 → 3 stops) is a STRUCTURAL switch: discrete at alpha > 0.
  const grown = blendApplied({ stops: A }, { stops: [...B, { offset: 1, color: "#ff0000" }] }, 0.5).stops;
  assert.equal(grown.length, 3, "length change snaps to target list");
  assert.equal(grown[2].color, "#ff0000");
});

test("REGRESSION: keyframing a SINGLE gradient stop never yields a numeric-keyed object (array-aware setPath)", () => {
  // The live crash: a per-index stop keyframe written into a slide delta that
  // already holds the WHOLE stops array turned the ARRAY into {"2":{offset:…}}
  // (setPath rebuilt the array as an object), dropping every other stop + the
  // color → parsePaint "a gradient needs >= 2 stops". Both writes must keep an
  // ARRAY of COMPLETE {offset,color} stops.
  const mkfill = () => ({ type: "linearGradient", solid: "#111111", linear: {
    stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#0000ff" }],
    from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }, radial: { stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } });
  const complete = (stops) => Array.isArray(stops) && stops.every((s) => typeof s.offset === "number" && typeof s.color === "string");

  // A) SAME-SLIDE per-index edit, where the delta already holds the whole array.
  let a = { meta: {}, slides: [{ id: "s0", name: "s0", delta: { items: { r1: { type: "rect", fill: mkfill() } } } }] };
  a = keyframed(a, 0, ["items", "r1", "fill", "linear", "stops", 2, "offset"], 0.74);
  const same = a.slides[0].delta.items.r1.fill.linear.stops;
  assert.ok(complete(same) && same.length === 3, "same-slide: stops stays a complete ARRAY (not a numeric-keyed object)");
  assert.equal(same[2].offset, 0.74);
  assert.equal(same[2].color, "#0000ff", "edited stop keeps its base COLOR");
  assert.equal(same[0].color, "#ff0000", "sibling stop preserved");

  // B) CROSS-SLIDE sparse keyframe (slide 1 empty) tweens offset+color, base
  //    color of untouched stops preserved.
  let b = { meta: {}, slides: [
    { id: "s0", name: "s0", delta: { items: { r1: { type: "rect", fill: mkfill() } } } },
    { id: "s1", name: "s1", delta: {} },
  ] };
  b = keyframed(b, 1, ["items", "r1", "fill", "linear", "stops", 1, "offset"], 0.9);
  b = keyframed(b, 1, ["items", "r1", "fill", "linear", "stops", 1, "color"], "#ffffff");
  const half = foldState(b, 1, 0.5).items.r1.fill.linear.stops;
  assert.ok(complete(half) && half.length === 3, "cross-slide: folded stops is a complete ARRAY");
  approx(half[1].offset, 0.7); // lerp(0.5, 0.9)
  assert.equal(half[1].color, "#80ff80"); // #00ff00 → #ffffff midpoint
  assert.equal(half[0].color, "#ff0000", "untouched stop's base color preserved");
  // addStop's core op ([...stops, newStop]) must work on a folded gradient.
  const grown = [...foldState(b, 1, 1).items.r1.fill.linear.stops, { offset: 1, color: "#ffffff" }];
  assert.equal(grown.length, 4, "addStop-style spread of a folded gradient yields a valid array");
});

// ── BENTO GRID: grid-derived anchors + equation-ref round-trip ───────────────
test("bento: 3x2 cell anchors (center/corners/edge-mids) at grid positions", () => {
  // 200x300 bbox, 3 rows x 2 cols, no gap/pad -> 100x100 cells at (c*100, r*100).
  const s = { w: 200, h: 300, rows: 3, cols: 2, padding: 0, rowGap: 0, colGap: 0 };
  const A = bentoAnchors(s);
  const at = (id) => A.find((a) => a.id === id);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) {
    assert.deepEqual(at(`c${r}x${c}cm`), { id: `c${r}x${c}cm`, x: c * 100 + 50, y: r * 100 + 50 }); // CENTER
    assert.deepEqual(at(`c${r}x${c}tl`), { id: `c${r}x${c}tl`, x: c * 100, y: r * 100 }); // top-left CORNER
    assert.deepEqual(at(`c${r}x${c}br`), { id: `c${r}x${c}br`, x: c * 100 + 100, y: r * 100 + 100 }); // bottom-right CORNER
    assert.deepEqual(at(`c${r}x${c}tm`), { id: `c${r}x${c}tm`, x: c * 100 + 50, y: r * 100 }); // top EDGE-MID
    assert.deepEqual(at(`c${r}x${c}mr`), { id: `c${r}x${c}mr`, x: c * 100 + 100, y: r * 100 + 50 }); // right EDGE-MID
  }
  // Grid-line INTERSECTION lattice: (rows+1) x (cols+1) junctions.
  assert.equal(A.filter((a) => /^j\d+x\d+$/.test(a.id)).length, 4 * 3);
  assert.deepEqual(at("j0x0"), { id: "j0x0", x: 0, y: 0 }); // top-left junction
  assert.deepEqual(at("j3x2"), { id: "j3x2", x: 200, y: 300 }); // bottom-right junction
  // The widget's own bbox 9 are present too (bento composes them).
  assert.deepEqual(at("cm"), { id: "cm", x: 100, y: 150 });
});
test("bento: anchor id round-trips through the equation ref grammar (resolveRef + evaluate)", () => {
  // The bento's DEFAULT slug is `bento_<id[0:4]>` — it itself contains an "_",
  // so this proves the last-"_" split peels the underscore-free anchor id while
  // leaving the underscore-bearing slug intact.
  const bento = { ...bentoPlugin.defaults, x: 100, y: 100, w: 200, h: 300, rows: 3, cols: 2, padding: 0, rowGap: 0, colGap: 0 };
  const state0 = { items: { ab12cd34: bento } };
  const slugs = slugMap(state0);
  assert.equal(slugs.toSlug.get("ab12cd34"), "bento_ab12");
  assert.deepEqual(resolveRef("bento_ab12_c2x0cm.x", slugs), { kind: "anchor", itemId: "ab12cd34", anchorId: "c2x0cm", coord: "x" });
  // Full pipeline: a rect whose x/y bind to bento cell (2,0)'s center must
  // evaluate to that cell's WORLD center — cell (2,0) center local (50,250) with
  // the bento at world (100,100) -> world (150,350).
  const state = { items: {
    ab12cd34: bento,
    r1: { ...rectPlugin.defaults, x: displayToStored("bento_ab12_c2x0cm.x", state0), y: displayToStored("bento_ab12_c2x0cm.y", state0), w: 20, h: 20, z: 1 },
  } };
  const ev = evaluateState(state, registry);
  assert.equal(ev.errors.size, 0);
  assert.equal(ev.state.items.r1.x, 150);
  assert.equal(ev.state.items.r1.y, 350);
  // nodeAnchors reports the SAME world coordinate the equation resolved to.
  const bnode = deriveRenderTree(ev.state, registry).find((n) => n.id === "ab12cd34");
  const wc = nodeAnchors(bnode).find((a) => a.id === "c2x0cm");
  assert.deepEqual({ x: wc.x, y: wc.y }, { x: 150, y: 350 });
});
test("bento: merged span drops covered cells and exposes anchors on the merged rect", () => {
  // A 2x2 grid with a span covering the whole left column (rows 0-1, col 0).
  const s = { w: 100, h: 100, rows: 2, cols: 2, padding: 0, rowGap: 0, colGap: 0, spans: [{ r: 0, c: 0, rowSpan: 2, colSpan: 1 }] };
  const A = bentoAnchors(s);
  const at = (id) => A.find((a) => a.id === id);
  // The merged cell keyed at its origin (0,0) spans 50x100 -> center (25,50).
  assert.deepEqual(at("c0x0cm"), { id: "c0x0cm", x: 25, y: 50 });
  // The covered non-origin cell (1,0) no longer exists.
  assert.equal(at("c1x0cm"), undefined);
  // The right column cells are untouched.
  assert.deepEqual(at("c0x1cm"), { id: "c0x1cm", x: 75, y: 25 });
});

// ── grid layout (Arrange Selection into Grid / bento) ─────────────────────────
// Mirrors core/grid.js @example doctests; grid_test.js has the full invariants.
test("grid: gridAssign row-major + overflow, cellCenters tile bounds, nearSquare seed", () => {
  assert.deepEqual(gridAssign(4, 2, 2), [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }]);
  assert.deepEqual(gridAssign(7, 2, 3)[6], { row: 2, col: 0 }); // overflow → 3rd row
  assert.equal(effectiveRows(7, 2, 3), 3);
  assert.deepEqual(cellCenters({ x: 0, y: 0, w: 100, h: 100 }, 1, 2, {}), [
    { row: 0, col: 0, x: 25, y: 50 }, { row: 0, col: 1, x: 75, y: 50 },
  ]);
  // Collective center of the cells == center of bounds (the re-flow-in-place property).
  const cs = cellCenters({ x: 10, y: 20, w: 200, h: 120 }, 3, 4, { rowGap: 6, colGap: 8, padding: 5 });
  approx(cs.reduce((s, c) => s + c.x, 0) / cs.length, 10 + 200 / 2);
  approx(cs.reduce((s, c) => s + c.y, 0) / cs.length, 20 + 120 / 2);
  assert.deepEqual(nearSquareGrid(9), { rows: 3, cols: 3 });
});

console.log(`\n${passed} tests passed`);
