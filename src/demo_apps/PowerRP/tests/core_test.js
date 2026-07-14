/**
 * Core smoke tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/core_test.js
 * The core being DOM-free is itself under test here: any window/document
 * reference in core/ would crash this file.
 */

import assert from "node:assert/strict";
import { NONE, applied, blendApplied, contains, setPath, deletePath, getPath, leaves } from "../core/deltas.js";
import { interpolate, ease } from "../core/interpolators.js";
import * as T from "../core/transform.js";
import { clipLineToRect, closestPointOnCircle, closestPointOnRectBorder } from "../core/geometry.js";
import {
  newDocument, foldState, slideState, keyframed, unkeyframed, keyframeIndices,
  withNewItem, withItemDeleted, withNewSlide, withSlideDeleted, withSlideMoved,
  withSlideToggled, serialize, deserialize, allKeyframes, withNormalizedZ, bisectedZ,
} from "../core/document.js";
import { createRegistry } from "../core/registry.js";
import { deriveRenderTree, nodeFeatures, nodeAnchors, resolveBinding, pickNode, standardBBoxAnchors, cameraRect } from "../core/derive.js";
import { solveSnap, axisLock } from "../core/snap.js";
import { createCommands } from "../core/commands.js";
import { rpFuzzyScore } from "../core/fuzzy.js";
import { createShortcuts } from "../core/shortcuts.js";
import { createUndo } from "../core/undo.js";
import { rectPlugin } from "../plugins/rect.js";
import { circlePlugin } from "../plugins/circle.js";
import { arrowPlugin, distToSegment, resolveEndpoints } from "../plugins/arrow.js";

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

// ── interpolators ────────────────────────────────────────────────────────────
test("interpolate types", () => {
  assert.equal(interpolate(0, 10, 0.5), 5);
  assert.equal(interpolate(1, 4, 0.5), 3); // int rounding
  assert.equal(interpolate("#000000", "#ffffff", 0.5), "#808080");
  assert.deepEqual(interpolate([0, 0], [10, 20], 0.5), [5, 10]);
  assert.equal(interpolate("a", "b", 0.5), "b");
  assert.equal(interpolate(false, true, 0.2), true);
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

// ── geometry ─────────────────────────────────────────────────────────────────
test("clipLineToRect", () => {
  assert.deepEqual(clipLineToRect(5, 5, 1, 0, { x: 0, y: 0, w: 10, h: 10 }), [0, 5, 10, 5]);
  assert.equal(clipLineToRect(50, 50, 1, 0, { x: 0, y: 0, w: 10, h: 10 }), null);
  const diag = clipLineToRect(5, 5, 1, 1, { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(diag, [0, 0, 10, 10]);
});
test("closest points", () => {
  assert.deepEqual(closestPointOnCircle(0, 0, 10, 20, 0), { x: 10, y: 0 });
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
test("item deletion prunes later keyframes", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { type: "rect", x: 0, z: 0 });
  [doc] = withNewSlide(doc, 0);
  [doc] = withNewSlide(doc, 1);
  doc = keyframed(doc, 2, ["items", id, "x"], 5);
  doc = withItemDeleted(doc, 1, id);
  assert.ok(foldState(doc, 0).items[id]);
  assert.equal(foldState(doc, 1).items[id], undefined);
  assert.deepEqual(allKeyframes(doc).filter((k) => k.slideIndex === 2), []);
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
test("resolveBinding: free, preset, circle-closest, missing item", () => {
  const state = { items: { c1: { ...circlePlugin.defaults, x: 100, y: 100, w: 20, h: 20, z: 0 } } };
  const nodes = deriveRenderTree(state, registry);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  assert.deepEqual(resolveBinding({ x: 3, y: 4 }, byId, 0, 0), { x: 3, y: 4 });
  assert.deepEqual(resolveBinding({ item: "c1", anchor: "cm" }, byId, 0, 0), { x: 110, y: 110 });
  const closest = resolveBinding({ item: "c1", anchor: "closest" }, byId, 110, 0);
  approx(closest.x, 110);
  approx(closest.y, 100); // top of the circle, toward the target above
  assert.equal(resolveBinding({ item: "ghost", anchor: "cm" }, byId, 0, 0), null);
});
test("arrow: endpoints resolve; distToSegment", () => {
  const pts = resolveEndpoints(
    { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
    (b) => ({ x: b.x, y: b.y }),
  );
  assert.deepEqual(pts, { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } });
  assert.equal(distToSegment(5, 3, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
});

test("cameraRect: default camera in new docs, tweens, meta fallback", () => {
  const doc = newDocument();
  const rect = cameraRect(foldState(doc, 0), doc.meta);
  assert.deepEqual(rect, { x: 0, y: 0, w: 1280, h: 720 });
  const camId = Object.entries(foldState(doc, 0).items).find(([, s]) => s.type === "camera")[0];
  let doc2 = newDocument();
  [doc2] = withNewSlide(doc, 0);
  doc2 = keyframed(doc2, 1, ["items", camId, "w"], 640);
  assert.equal(cameraRect(foldState(doc2, 1, 0.5), doc2.meta).w, 960); // camera tweens
  assert.deepEqual(cameraRect({ items: {} }, { slideW: 10, slideH: 5 }), { x: 0, y: 0, w: 10, h: 5 });
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

console.log(`\n${passed} tests passed`);
