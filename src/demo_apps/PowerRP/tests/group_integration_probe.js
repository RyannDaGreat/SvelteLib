/**
 * Groups INTEGRATION probe — drives a real document + registry through
 * deriveRenderTree (the whole derivation stage: sort → group parenting →
 * crop resolution) and asserts the manifest's group behaviors end-to-end.
 * Run: node src/demo_apps/PowerRP/tests/group_integration_probe.js
 *
 * NOTE: this probe folds the document itself and calls deriveRenderTree
 * DIRECTLY on the folded state (a group scene has only numeric properties, so
 * the expression pass would be an identity for it). It deliberately does NOT
 * call core/expressions.evaluateState — at the time of writing that module is
 * a WORK-IN-PROGRESS by another agent (a ReferenceError: MAX_CLOSEST_SWEEPS is
 * not defined makes it throw for every document). This probe therefore proves
 * the GROUP logic in full without depending on that in-flight file; once
 * expressions.js is fixed the same flow runs through the normal app path.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import {
  newDocument, foldState, keyframed, withNewItem, withItemPurged, withNormalizedZ,
} from "../core/document.js";
import {
  deriveRenderTree, worldTransform, stateXYForCenterPivotWorld, groupMembership,
} from "../core/derive.js";
import { rotatedBBoxAABB } from "../core/view.js";
import { selectInBox, groupFilteredSelection, rectFromCorners } from "../core/bandselect.js";
import { sceneIR } from "../render_gpu/ports.js";
import { rectPlugin } from "../plugins/rect.js";
import { cameraPlugin } from "../plugins/camera.js"; // newDocument() always contains THE camera
import { groupPlugin } from "../plugins/group.js";
import * as T from "../core/transform.js";

// Register only the plugins this probe uses (rect + camera + group) rather than
// the full roster via plugins/index.js — that keeps the probe independent of
// OTHER agents' in-flight plugins (a concurrently-broken codeblock/shaders file
// must not block verifying GROUP logic). The group behavior under test is
// registry-agnostic; any bbox member exercises it identically.
const registry = createRegistry();
for (const p of [rectPlugin, cameraPlugin, groupPlugin]) registry.register(p);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
function approx(a, b, eps = 1e-6) { assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`); }

// Build a doc with two rects on slide 0, then group them (mirrors the app's
// groupSelection: AABB bbox, members, bind = creation transform).
function docWithTwoRects() {
  // No numeric rotationAnchor: real items carry the `self.anchors.center`
  // equation default, which evaluateState resolves to the geometric center —
  // EXACTLY what worldTransform's absent-anchor fallback computes. Omitting it
  // here reproduces that evaluated state and the app's ungroup bake precedent
  // (the rotated-resize commit likewise relies on the clean center pivot;
  // custom NUMERIC pivots are the flagged rough-draft limitation — see report).
  let doc = newDocument();
  let id1, id2;
  [doc, id1] = withNewItem(doc, 0, { type: "rect", x: 100, y: 100, w: 80, h: 60, z: 1, rotation: 0, scale: 1, active: true, fill: "#f00", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1 });
  [doc, id2] = withNewItem(doc, 0, { type: "rect", x: 300, y: 220, w: 40, h: 40, z: 2, rotation: 0, scale: 1, active: true, fill: "#0f0", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1 });
  return [doc, id1, id2];
}

// The app's groupSelection, reproduced here against a raw doc (numeric AABB).
function groupTwo(doc, id1, id2) {
  const state = foldState(doc, 0, 1);
  const nodes = deriveRenderTree(state, registry);
  const boxes = nodes.filter((n) => n.itemId === id1 || n.itemId === id2).map(rotatedBBoxAABB);
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const gState = {
    ...registry.get("group").defaults,
    x: minX, y: minY, w: maxX - minX, h: maxY - minY, rotation: 0, scale: 1,
    members: [id1, id2], bind: { x: minX, y: minY, rotation: 0, scale: 1 },
    active: true, z: 3,
  };
  let gid;
  [doc, gid] = withNewItem(doc, 0, gState);
  return [withNormalizedZ(doc), gid, { minX, minY }];
}

const nodesAt = (doc, slide = 0) => deriveRenderTree(foldState(doc, slide, 1), registry);
const worldOf = (doc, id) => nodesAt(doc).find((n) => n.itemId === id).world;

test("group creation: group node is a ghost, renders nothing to IR", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  const nodes = nodesAt(doc);
  const g = nodes.find((n) => n.itemId === gid);
  assert.equal(g.type, "group");
  assert.equal(g.plugin.capabilities.ghost, true);
  assert.deepEqual(g.plugin.emit(g.state), []); // ghost: no rendered volume
  // sceneIR skips zero-command nodes, so the group emits NO ops.
  const ir = sceneIR(nodes.filter((n) => n.itemId === gid));
  assert.equal(ir.length, 0);
});

test("group at bind pose moves nothing (re-pose invariance, real derive)", () => {
  let [doc, id1, id2] = docWithTwoRects();
  const w1before = worldOf(doc, id1), w2before = worldOf(doc, id2);
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  const w1after = worldOf(doc, id1), w2after = worldOf(doc, id2);
  approx(w1after.x, w1before.x); approx(w1after.y, w1before.y);
  approx(w2after.x, w2before.x); approx(w2after.y, w2before.y);
});

test("moving the GROUP moves every member exactly (real derive)", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid, origin; [doc, gid, origin] = groupTwo(doc, id1, id2);
  const w1before = worldOf(doc, id1), w2before = worldOf(doc, id2);
  // Move the group +50 / +30 (writes the group's own x/y — bind stays put).
  doc = keyframed(doc, 0, ["items", gid, "x"], origin.minX + 50);
  doc = keyframed(doc, 0, ["items", gid, "y"], origin.minY + 30);
  const w1 = worldOf(doc, id1), w2 = worldOf(doc, id2);
  approx(w1.x, w1before.x + 50); approx(w1.y, w1before.y + 30);
  approx(w2.x, w2before.x + 50); approx(w2.y, w2before.y + 30);
});

test("rotating the GROUP 45° rotates members and orbits them about the group center", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid, origin; [doc, gid] = groupTwo(doc, id1, id2);
  const gNode = nodesAt(doc).find((n) => n.itemId === gid);
  const cx = gNode.state.x + gNode.state.w / 2, cy = gNode.state.y + gNode.state.h / 2;
  const m1before = worldOf(doc, id1);
  doc = keyframed(doc, 0, ["items", gid, "rotation"], Math.PI / 4);
  const m1 = worldOf(doc, id1);
  approx(m1.rotation, Math.PI / 4); // member picked up the group's rotation
  // The member's origin orbited the group center by 45° (manual check).
  const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
  const dx = m1before.x - cx, dy = m1before.y - cy;
  approx(m1.x, cx + (c * dx - s * dy), 1e-4);
  approx(m1.y, cy + (s * dx + c * dy), 1e-4);
});

test("individual member move still composes on top of the group influence", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid, origin; [doc, gid, origin] = groupTwo(doc, id1, id2);
  // Move the group +50/+30 AND move member 1 individually +10/+5.
  doc = keyframed(doc, 0, ["items", gid, "x"], origin.minX + 50);
  doc = keyframed(doc, 0, ["items", gid, "y"], origin.minY + 30);
  doc = keyframed(doc, 0, ["items", id1, "x"], 110); // was 100
  doc = keyframed(doc, 0, ["items", id1, "y"], 105); // was 100
  const w1 = worldOf(doc, id1);
  // Own move (+10/+5) then group influence (+50/+30) both apply.
  approx(w1.x, 100 + 10 + 50); approx(w1.y, 100 + 5 + 30);
});

test("UNGROUP bakes members world-exact then purges the group (one flow)", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid, origin; [doc, gid, origin] = groupTwo(doc, id1, id2);
  // Pose the group: move +40/+20 and rotate 30°.
  doc = keyframed(doc, 0, ["items", gid, "x"], origin.minX + 40);
  doc = keyframed(doc, 0, ["items", gid, "y"], origin.minY + 20);
  doc = keyframed(doc, 0, ["items", gid, "rotation"], Math.PI / 6);
  // Capture members' influenced worlds BEFORE ungroup.
  const before = new Map(nodesAt(doc).filter((n) => n.itemId === id1 || n.itemId === id2).map((n) => [n.itemId, n.world]));
  // Reproduce ungroupSelection's bake:
  const nodes = nodesAt(doc);
  const byId = new Map(nodes.map((n) => [n.itemId, n]));
  const g = byId.get(gid);
  for (const memberId of g.state.members) {
    const m = byId.get(memberId);
    const xy = stateXYForCenterPivotWorld(m.world, m.state.w, m.state.h);
    doc = keyframed(doc, 0, ["items", memberId, "x"], xy.x);
    doc = keyframed(doc, 0, ["items", memberId, "y"], xy.y);
    doc = keyframed(doc, 0, ["items", memberId, "rotation"], m.world.rotation);
    doc = keyframed(doc, 0, ["items", memberId, "scale"], m.world.scale);
  }
  doc = withItemPurged(doc, gid);
  // Group is gone; members stay world-exact.
  const after = nodesAt(doc);
  assert.equal(after.find((n) => n.itemId === gid), undefined); // purged
  for (const id of [id1, id2]) {
    const w = after.find((n) => n.itemId === id).world, b = before.get(id);
    approx(w.x, b.x, 1e-4); approx(w.y, b.y, 1e-4);
    approx(w.rotation, b.rotation, 1e-9); approx(w.scale, b.scale, 1e-9);
  }
});

test("band select grabs the GROUP, not its members (real selectInBox + filter)", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  const nodes = nodesAt(doc);
  // A box enclosing everything.
  const box = rectFromCorners({ x: 0, y: 0 }, { x: 1000, y: 1000 });
  const caught = selectInBox(nodes, box, "outer");
  // Raw selectInBox catches the members (they have bbox) AND the group.
  assert.ok(caught.includes(id1) && caught.includes(id2));
  // The group filter collapses members → the group; no member survives.
  const membership = groupMembership(nodes);
  const filtered = groupFilteredSelection(caught, membership);
  assert.ok(filtered.includes(gid), "group is selected");
  assert.ok(!filtered.includes(id1) && !filtered.includes(id2), "members are NOT band-selected while grouped");
});

test("Show-Ghosts outline: group is a ghost with a bbox (rides the ghost outline path)", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  const g = nodesAt(doc).find((n) => n.itemId === gid);
  // CanvasView's ghostOutlines filter is: isGhostNode(n) && bbox && (cropbox || showGhosts).
  // Verify the group qualifies when showGhosts is ON.
  assert.equal(g.plugin.capabilities.ghost, true);
  assert.equal(g.plugin.capabilities.bbox, true);
  // Border-only hitTest: interior misses, border hits (clicking the outline selects the group).
  assert.equal(g.plugin.hitTest(g.state, g.state.w / 2, g.state.h / 2, 6), false); // interior → falls through
  assert.equal(g.plugin.hitTest(g.state, 0, 0, 6), true); // corner/border → group
});

console.log(`\n${passed} group integration checks passed.`);
