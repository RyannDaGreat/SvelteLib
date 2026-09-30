/** In-canvas Multipoint editing — the pure rules behind the island, double-click
 * colour, click-to-place and split (core/multipoint_edit.js, the new helpers in
 * core/multipoint.js and the handle-id grammar in core/paint_handles.js).
 * Run: node src/demo_apps/PowerRP/tests/multipoint_edit_test.js */
import assert from "node:assert/strict";
import { MULTIPOINT_TYPE, multipointFeature, multipointFeatureAt, newSourceColor, insertFeatureNode, reverseFeature, reversedNodeOrder, featurePolyline, nodeCubic } from "../core/multipoint.js";
import { evalCubic } from "../core/morph_geometry.js";
import { multipointModifierPoints, multipointHandleId, parseMultipointHandleId, isMultipointColorHandleId } from "../core/paint_handles.js";
import {
  featureSegments, nearestOnCubic, multipointPathHit, splitAtHit, featureNodeOffset, polylineLength, stopIndexNear,
  stopColorAt, featureEditRefusal, handleColorTargets, targetColor, colorWritePairs, selectedPathFeatures,
  reversedHandleIds, multipointEditKey, NODE_STOP_TOLERANCE,
} from "../core/multipoint_edit.js";
import { setPath, blendApplied } from "../core/deltas.js";
import { parsePaint } from "../render_gpu/ir.js";

let passed = 0;
/** Command. Runs one assertion group and reports it. */
function test(name, check) { check(); passed++; console.log(`  ok  ${name}`); }
/** Pure function. Stored Multipoint paint around `features`. @example paint([]).type // "multipointGradient" */
function paint(features, extra = {}) { return { type: MULTIPOINT_TYPE, multipoint: { features, ...extra } }; }
/** Pure function. An item state with a Multipoint fill on a W×H box. */
function item(features, w = 200, h = 100) { return { w, h, fill: paint(features) }; }
/** Pure function. Applies setPreview-style pairs to a state, the way a preview fold does. */
function applyPairs(state, pairs) { let d = {}; for (const [p, v] of pairs) d = setPath(d, p, v); return blendApplied(state, d, 1); }

const spiralish = { nodes: [[0.1, 0.5, 0, 0, 0, -0.3], [0.5, 0.2, -0.2, 0, 0.2, 0], [0.9, 0.5, 0, -0.3, 0, 0.3]],
  stops: [{ offset: 0, color: "#ff0000", rightColor: "#00ff00" }, { offset: 1, color: "#0000ff", rightColor: "#ffff00" }], weight: 1, twoSided: false, closed: false };

test("handle id grammar round-trips and matches the minted handles", () => {
  for (const h of [{ key: "fill", feature: 3, role: "anchor", index: 7 }, { key: "pupilFill", feature: 0, role: "control", index: 2, control: "incoming" },
    { key: "stroke", feature: 1, role: "stop", index: 0, side: "rightColor" }, { key: "fill", feature: 1, role: "stop", index: 4, side: "color" }])
    assert.deepEqual(parseMultipointHandleId(multipointHandleId(h)), h);
  const minted = multipointModifierPoints(item([{ ...spiralish, twoSided: true }]), "fill").map((m) => m.id);
  for (const id of minted) assert.equal(multipointHandleId(parseMultipointHandleId(id)), id, id);
  assert.ok(minted.includes("fill-mp-0-stop-1-right"));
  assert.deepEqual(minted.filter(isMultipointColorHandleId), ["fill-mp-0-node-0", "fill-mp-0-node-1", "fill-mp-0-node-2",
    "fill-mp-0-stop-0", "fill-mp-0-stop-0-right", "fill-mp-0-stop-1", "fill-mp-0-stop-1-right"], "Bézier controls carry no colour");
  assert.equal(parseMultipointHandleId("fill-grad-center"), null);
  assert.equal(parseMultipointHandleId("fill-mp-0-node-0-right"), null, "only colour beads carry a side");
});

test("click-to-place centres every kind on the click, keeps shape and cycles colours", () => {
  for (const kind of ["point", "line", "curve"]) {
    const base = multipointFeature(kind, "#123456"), placed = multipointFeatureAt(kind, "#123456", 0.1, 0.8);
    const centroid = (f) => [0, 1].map((a) => f.nodes.reduce((s, n) => s + n[a], 0) / f.nodes.length);
    centroid(placed).forEach((v, a) => assert.ok(Math.abs(v - [0.1, 0.8][a]) < 1e-12, `${kind} centroid`));
    placed.nodes.forEach((n, i) => { assert.deepEqual(n.slice(2), base.nodes[i].slice(2), "handles are offsets: unchanged"); });
    assert.deepEqual(placed.stops, base.stops);
  }
  assert.throws(() => multipointFeatureAt("point", "#fff", NaN, 0), /finite/);
  assert.notEqual(newSourceColor(0), newSourceColor(1));
  assert.equal(newSourceColor(5), newSourceColor(0));
});

test("split at t is exact: the drawn curve and every stop position are unchanged", () => {
  const before = featurePolyline(spiralish.nodes);
  for (const t of [0.1, 0.37, 0.5, 0.93]) {
    const split = insertFeatureNode(spiralish, 1, t);
    assert.equal(split.nodes.length, 4);
    const original = nodeCubic(spiralish.nodes[0], spiralish.nodes[1]);
    const [x, y] = evalCubic(original, t);
    assert.ok(Math.hypot(split.nodes[1][0] - x, split.nodes[1][1] - y) < 1e-12, "node lands at the parameter");
    for (const s of [0.2, 0.6, 0.9]) { // each half reproduces its piece of the original
      const [ax, ay] = evalCubic(nodeCubic(split.nodes[0], split.nodes[1]), s), [bx, by] = evalCubic(original, s * t);
      assert.ok(Math.hypot(ax - bx, ay - by) < 1e-12);
      const [cx, cy] = evalCubic(nodeCubic(split.nodes[1], split.nodes[2]), s), [dx, dy] = evalCubic(original, t + s * (1 - t));
      assert.ok(Math.hypot(cx - dx, cy - dy) < 1e-12);
    }
    const length = polylineLength(featurePolyline(split.nodes)), original_length = polylineLength(before);
    assert.ok(Math.abs(length - original_length) < 1e-3 * original_length, "arc length (so stop placement) preserved");
    assert.deepEqual(split.stops, spiralish.stops, "colours stay independent of shaping nodes");
  }
  assert.throws(() => insertFeatureNode(spiralish, 1, 0), /strictly inside/);
  assert.throws(() => insertFeatureNode(spiralish, 1, 1), /strictly inside/);
  assert.deepEqual(insertFeatureNode(spiralish, 1).nodes, insertFeatureNode(spiralish, 1, 0.5).nodes, "Inspector midpoint default unchanged");
});

test("a path hit finds the exact segment/parameter, including a closed seam and hidden nodes", () => {
  const state = item([spiralish]);
  const [x, y] = evalCubic(nodeCubic(spiralish.nodes[1], spiralish.nodes[2]), 0.3);
  const hit = multipointPathHit(state, ["fill"], { x: x * 200, y: y * 100 + 3 }, 8);
  assert.equal(hit.insertIndex, 2);
  assert.ok(Math.abs(hit.t - 0.3) < 0.05 && hit.distance <= 3 + 1e-9);
  const exact = multipointPathHit(state, ["fill"], { x: x * 200, y: y * 100 }, 8);
  assert.ok(Math.abs(exact.t - 0.3) < 1e-6 && exact.distance < 1e-6, "an on-curve click recovers its parameter");
  const split = splitAtHit(spiralish, exact);
  assert.equal(split.node, 2);
  assert.ok(Math.abs(split.feature.nodes[2][0] - x) < 1e-6 && Math.abs(split.feature.nodes[2][1] - y) < 1e-6);
  assert.equal(multipointPathHit(state, ["fill"], { x: 100, y: 99 }, 8), null, "too far");
  assert.equal(multipointPathHit(item([multipointFeature("point", "#fff")]), ["fill"], { x: 100, y: 50 }, 8), null, "points are not paths");
  const hiddenSource = { ...item([spiralish]), fill: paint([spiralish], { featuresActive: [false] }) };
  assert.equal(multipointPathHit(hiddenSource, ["fill"], { x: x * 200, y: y * 100 }, 8), null, "hidden sources are not hit");
  const square = { nodes: [[0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0]], stops: [{ offset: 0, color: "#fff" }], closed: true };
  assert.deepEqual(featureSegments(square).map((s) => s.insertIndex), [1, 2, 3, 4]);
  const seam = multipointPathHit(item([square], 100, 100), ["fill"], { x: 1, y: 50 }, 8);
  assert.equal(seam.insertIndex, 4, "the closing segment splits at the seam");
  const seamSplit = splitAtHit(square, seam).feature;
  assert.ok(Math.abs(seamSplit.nodes[4][1] - 0.5) < 1e-6 && Math.abs(seamSplit.nodes[4][0]) < 1e-6);
  const withHidden = { ...square, closed: false, nodesActive: [true, false, true, true] };
  assert.deepEqual(featureSegments(withHidden).map((s) => s.insertIndex), [1, 3], "a hidden node is bypassed like the renderer");
  assert.match(splitAtHit(square, { insertIndex: 1, t: 0 }).refusal, /existing node/);
  assert.match(splitAtHit({ ...square, nodes: "= other" }, seam).refusal, /equation-driven/);
});

test("nearestOnCubic returns endpoints when the true nearest point is an end", () => {
  const c = [[0, 0], [3, 0], [7, 0], [10, 0]];
  assert.equal(nearestOnCubic(c, { x: -5, y: 1 }).t, 0);
  assert.equal(nearestOnCubic(c, { x: 15, y: 1 }).t, 1);
});

test("node offsets are the arc length the colour beads use", () => {
  assert.equal(featureNodeOffset(spiralish, 0), 0);
  assert.equal(featureNodeOffset(spiralish, 2), 1);
  const mid = featureNodeOffset(spiralish, 1);
  const lengths = featureSegments(spiralish).map((s) => polylineLength(featurePolyline([s.from, s.to])));
  assert.ok(Math.abs(mid - lengths[0] / (lengths[0] + lengths[1])) < 1e-12);
  assert.equal(featureNodeOffset(multipointFeature("point", "#fff"), 0), null);
  assert.equal(featureNodeOffset({ ...spiralish, nodesActive: [true, false, true] }, 1), null, "hidden node: no place on the path");
});

test("interpolated stop colours follow the solver's premultiplied, last-wins, clamped rule", () => {
  // Offsets chosen so every blend weight is an exact binary fraction.
  const f = { stops: [{ offset: 0.25, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 0.5, color: "#0000ff" }, { offset: 1, color: "#ffffff00" }] };
  assert.equal(stopColorAt(f, 0, "color"), "#ff0000");
  assert.equal(stopColorAt(f, 0.375, "color"), "#808000");
  assert.equal(stopColorAt(f, 0.5, "color"), "#0000ff", "coincident offsets: the last wins at and after");
  assert.equal(stopColorAt(f, 0.75, "color"), "#0000ff80", "premultiplied fade keeps the hue");
  assert.equal(stopColorAt({ ...f, stopsActive: [false] }, 0.25, "color"), "#00ff00", "hidden stops are skipped");
  assert.throws(() => stopColorAt({ stops: [{ offset: 0, color: "#fff" }], stopsActive: [false] }, 0, "color"), /at least one visible/);
});

test("colour targets: point, bead, node-with-stop, node-without-stop, controls, equations", () => {
  const point = multipointFeature("point", "#abcdef");
  const two = { ...spiralish, twoSided: true };
  const state = item([point, spiralish, two, { ...spiralish, stops: [{ offset: 0, color: "= a.fill" }] }]);
  const t = (ids) => handleColorTargets(state, ids);
  assert.deepEqual(t(["fill-mp-0-node-0"]).targets, [{ side: "color", path: ["fill", "multipoint", "features", 0, "stops", 0, "color"] }]);
  assert.deepEqual(t(["fill-mp-1-stop-1"]).targets, [{ side: "color", path: ["fill", "multipoint", "features", 1, "stops", 1, "color"] }]);
  assert.deepEqual(t(["fill-mp-1-node-2"]).targets, [{ side: "color", path: ["fill", "multipoint", "features", 1, "stops", 1, "color"] }], "the stop at the end node");
  assert.deepEqual(t(["fill-mp-2-node-0"]).targets.map((x) => x.side), ["color", "rightColor"], "two-sided: both sides at the node");
  const pending = t(["fill-mp-1-node-1"]).targets;
  assert.equal(pending.length, 1);
  assert.ok(Math.abs(pending[0].offset - featureNodeOffset(spiralish, 1)) < 1e-15 && pending[0].featurePath.at(-1) === 1, "no stop at the middle node: pending");
  assert.deepEqual(t(["fill-mp-1-node-1-outgoing"]).targets, [], "a Bézier control carries no colour");
  assert.deepEqual(t(["fill-mp-3-stop-0"]).targets, []);
  assert.match(t(["fill-mp-3-stop-0"]).skipped[0], /equation/);
  assert.deepEqual(t(["fill-mp-0-node-0", "fill-mp-0-node-0"]).targets.length, 1, "deduplicated");
  assert.equal(targetColor(state, pending[0]), stopColorAt(spiralish, pending[0].offset, "color"));
  assert.match(t(["fill-mp-1-node-1"]).skipped.join("") + handleColorTargets(item([{ ...spiralish, nodesActive: [true, false, true] }]), ["fill-mp-0-node-1"]).skipped[0], /hidden/);
});

test("colour writes: leaves stay leaves; a pending stop inserts once, in order, picture-preserving on the other side", () => {
  const state = item([multipointFeature("point", "#abcdef"), { ...spiralish, twoSided: true, stopsActive: [true, true] }]);
  const leaf = colorWritePairs(state, handleColorTargets(state, ["fill-mp-0-node-0"]).targets, "#010203");
  assert.deepEqual(leaf, [[["fill", "multipoint", "features", 0, "stops", 0, "color"], "#010203"]]);
  const offset = featureNodeOffset(spiralish, 1);
  const pendingLeft = [{ side: "color", featurePath: ["fill", "multipoint", "features", 1], offset }];
  const pairs = colorWritePairs(state, [...pendingLeft, { side: "color", path: ["fill", "multipoint", "features", 1, "stops", 0, "color"] }], "#123456");
  assert.equal(pairs.length, 2, "one whole-stops write plus its aligned companion; the leaf folded in");
  const next = applyPairs(state, pairs).fill.multipoint.features[1];
  assert.deepEqual(next.stops.map((s) => s.offset), [0, offset, 1]);
  assert.equal(next.stops[0].color, "#123456", "leaf target folded into the list write");
  assert.equal(next.stops[1].color, "#123456");
  assert.equal(next.stops[1].rightColor, stopColorAt(spiralish, offset, "rightColor"), "unpicked side keeps its interpolated colour");
  assert.deepEqual(next.stopsActive, [true, true, true]);
  const rendered = parsePaint(applyPairs(state, pairs).fill).features[1];
  assert.equal(rendered.stops.length, 3);
  assert.throws(() => colorWritePairs(item([{ ...spiralish, stopsActive: "= x" }]), pendingLeft.map((p) => ({ ...p, featurePath: ["fill", "multipoint", "features", 0] })), "#fff"), /equation-driven/);
});

test("path-source selection, refusals and reverse remapping", () => {
  const state = item([multipointFeature("point", "#fff"), spiralish, { ...spiralish, closed: true }]);
  assert.deepEqual(selectedPathFeatures(state, ["fill-mp-0-node-0", "fill-mp-1-node-2", "fill-mp-1-stop-0", "fill-mp-2-node-0-outgoing"]).map((f) => f.index), [1, 2]);
  assert.equal(featureEditRefusal(spiralish, "reverse"), null);
  assert.match(featureEditRefusal({ ...spiralish, twoSided: "= true" }, "twoSided"), /Two sides flag is an equation/);
  assert.match(featureEditRefusal({ ...spiralish, nodesActive: [true, "= t > 1", true] }, "split"), /equation-driven/);
  assert.throws(() => featureEditRefusal(spiralish, "explode"), /unknown operation/);
  for (const f of [spiralish, { ...spiralish, closed: true, twoSided: true }]) {
    const ids = ["fill-mp-0-node-0", "fill-mp-0-node-1-outgoing", "fill-mp-0-stop-0", "fill-mp-0-stop-1-right"];
    const handlesBefore = Object.fromEntries(multipointModifierPoints(item([{ ...f, twoSided: true }]), "fill").map((m) => [m.id, m]));
    const reversed = reverseFeature({ ...f, twoSided: true });
    const handlesAfter = Object.fromEntries(multipointModifierPoints(item([reversed]), "fill").map((m) => [m.id, m]));
    const mapped = reversedHandleIds(ids, "fill", 0, { ...f, twoSided: true });
    ids.forEach((id, i) => {
      const a = handlesBefore[id], b = handlesAfter[mapped[i]];
      assert.ok(b, `${mapped[i]} exists after reverse`);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, `${id} → ${mapped[i]} stays on the same physical handle`);
      if (a.color) assert.equal(b.color, a.color, "a colour bead keeps its colour");
    });
    assert.deepEqual(reversedNodeOrder(reverseFeature(f)).map((i) => reversedNodeOrder(f)[i]), f.nodes.map((_, i) => i), "reverse twice is identity");
  }
  assert.deepEqual(reversedHandleIds(["stroke-mp-0-node-0", "fill-mp-1-node-0"], "fill", 0, spiralish), ["stroke-mp-0-node-0", "fill-mp-1-node-0"]);
});

test("the island edits the selected handle's paint key, else the first Multipoint key", () => {
  const state = { fill: paint([]), stroke: paint([]), background: "#000" };
  assert.equal(multipointEditKey(state, ["background", "fill", "stroke"], []), "fill");
  assert.equal(multipointEditKey(state, ["fill", "stroke"], ["stroke-mp-0-stop-0"]), "stroke");
  assert.equal(multipointEditKey(state, ["fill", "stroke"], ["fill-grad-center"]), "fill");
  assert.ok(stopIndexNear({ stops: [{ offset: 0.5 }] }, 0.5 + NODE_STOP_TOLERANCE / 2) === 0);
});

console.log(`\n${passed} multipoint editing tests passed`);
