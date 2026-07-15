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
  newDocument, foldState, keyframed, withNewItem, withItemPurged, withNormalizedZ, blockZToExtreme,
} from "../core/document.js";
import {
  deriveRenderTree, worldTransform, stateXYForCenterPivotWorld, groupMembership, snapExclusionSet,
} from "../core/derive.js";
import { rotatedBBoxAABB } from "../core/view.js";
import { selectInBox, groupFilteredSelection, rectFromCorners } from "../core/bandselect.js";
import { nodeFeatures } from "../core/derive.js";
import { groupResizeState } from "../web/canvas/dragKinds.js";
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

// ── 15.7 GROUP RESIZE end-to-end (commit group scale/x/y → members follow) ────
// Reproduces CanvasView's groupResizeDrag → commitPreview: a handle drag writes
// the GROUP's own scale + x/y (via groupResizeState); members scale+move through
// the derivation stage with ZERO per-member writes.

test("group resize commit: members scale ×2 about the fixed corner (real derive)", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid, origin; [doc, gid] = groupTwo(doc, id1, id2);
  const g = nodesAt(doc).find((n) => n.itemId === gid);
  const w1before = worldOf(doc, id1), w2before = worldOf(doc, id2);
  // Grab bottom-right (east+south); fixed corner = the group box's top-left world.
  const gWorld = worldTransform(g.state);
  const fixedTL = T.apply(gWorld, 0, 0);
  const gs = groupResizeState(
    { x: g.state.x, y: g.state.y, w: g.state.w, h: g.state.h, rotation: 0, scale: 1 },
    gWorld, { east: true, south: true }, {}, { x: g.state.w, y: g.state.h }, // double the box
  );
  // Commit the group's own scale/x/y (w/h untouched) — the actual write set.
  doc = keyframed(doc, 0, ["items", gid, "scale"], gs.scale);
  doc = keyframed(doc, 0, ["items", gid, "x"], gs.x);
  doc = keyframed(doc, 0, ["items", gid, "y"], gs.y);
  approx(gs.scale, 2);
  const w1 = worldOf(doc, id1), w2 = worldOf(doc, id2);
  // Both members' scale doubled.
  approx(w1.scale, w1before.scale * 2); approx(w2.scale, w2before.scale * 2);
  // Member 1 sits AT the fixed top-left corner (100,100) — it stays put.
  approx(w1.x, fixedTL.x, 1e-4); approx(w1.y, fixedTL.y, 1e-4);
  // Member 2 (offset) — its distance from the fixed corner doubled.
  const d2b = Math.hypot(w2before.x - fixedTL.x, w2before.y - fixedTL.y);
  const d2a = Math.hypot(w2.x - fixedTL.x, w2.y - fixedTL.y);
  assert.ok(d2b > 1e-6, "member 2 must be offset from the fixed corner");
  approx(d2a / d2b, 2, 1e-4);
});

test("group resize commit writes NO member keyframes (members follow purely via parenting)", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  const g = nodesAt(doc).find((n) => n.itemId === gid);
  const gs = groupResizeState({ x: g.state.x, y: g.state.y, w: g.state.w, h: g.state.h, rotation: 0, scale: 1 }, worldTransform(g.state), { east: true, south: true }, {}, { x: 40, y: 20 });
  const memberXBefore = foldState(doc, 0, 1).items[id1].x;
  doc = keyframed(doc, 0, ["items", gid, "scale"], gs.scale);
  doc = keyframed(doc, 0, ["items", gid, "x"], gs.x);
  doc = keyframed(doc, 0, ["items", gid, "y"], gs.y);
  // The member's STORED x is unchanged — only its DERIVED world moved.
  assert.equal(foldState(doc, 0, 1).items[id1].x, memberXBefore);
});

// ── 15.7 SNAP EXCLUSION end-to-end (candidate feature lists) ──────────────────

test("snap candidates: dragging a MEMBER excludes its own group's features", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  const nodes = nodesAt(doc);
  const membership = groupMembership(nodes);
  // Dragging member id1: excluded = {id1, gid}. The group's outline/anchor
  // features must NOT appear among the snap candidates.
  const excluded = snapExclusionSet(id1, membership, nodes);
  assert.ok(excluded.has(id1) && excluded.has(gid));
  const candidateFeatures = nodes.filter((n) => !excluded.has(n.itemId)).flatMap(nodeFeatures);
  assert.ok(!candidateFeatures.some((f) => f.id.startsWith(`${gid}:`)), "group's own features excluded");
  assert.ok(!candidateFeatures.some((f) => f.id.startsWith(`${id1}:`)), "the member's own features excluded");
  // The OTHER member (id2) is a foreign item to id1 (both grouped, but exclusion
  // is only self+own-group+own-members for the DRAGGED id; id2 is neither).
  assert.ok(candidateFeatures.some((f) => f.id.startsWith(`${id2}:`)), "sibling member still a candidate");
});

test("snap candidates: dragging a GROUP excludes all its members' features", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  const nodes = nodesAt(doc);
  const excluded = snapExclusionSet(gid, groupMembership(nodes), nodes);
  assert.ok(excluded.has(gid) && excluded.has(id1) && excluded.has(id2));
  const candidateFeatures = nodes.filter((n) => !excluded.has(n.itemId)).flatMap(nodeFeatures);
  for (const id of [gid, id1, id2])
    assert.ok(!candidateFeatures.some((f) => f.id.startsWith(`${id}:`)), `${id} features excluded when dragging the group`);
});

test("snap candidates: a FOREIGN item stays a candidate when dragging a group", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let foreignId; [doc, foreignId] = withNewItem(doc, 0, { type: "rect", x: 500, y: 500, w: 30, h: 30, z: 1, rotation: 0, scale: 1, active: true, fill: "#00f", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1 });
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  const nodes = nodesAt(doc);
  const excluded = snapExclusionSet(gid, groupMembership(nodes), nodes);
  assert.ok(!excluded.has(foreignId));
  const candidateFeatures = nodes.filter((n) => !excluded.has(n.itemId)).flatMap(nodeFeatures);
  assert.ok(candidateFeatures.some((f) => f.id.startsWith(`${foreignId}:`)), "foreign item snaps as before");
});

// ── 15.7 Z-ORDER BLOCK end-to-end (group + members to front/back as a block) ──

test("z-order block: To Front lifts the group AND its members above foreign items", () => {
  // Two rects grouped (z become normalized), plus two foreign rects interleaved.
  let [doc, id1, id2] = docWithTwoRects();
  let fA, fB;
  [doc, fA] = withNewItem(doc, 0, { type: "rect", x: 400, y: 400, w: 20, h: 20, z: 10, rotation: 0, scale: 1, active: true, fill: "#111", stroke: "#000", strokeWidth: 1, cornerRadius: 0, opacity: 1 });
  [doc, fB] = withNewItem(doc, 0, { type: "rect", x: 450, y: 450, w: 20, h: 20, z: 11, rotation: 0, scale: 1, active: true, fill: "#222", stroke: "#000", strokeWidth: 1, cornerRadius: 0, opacity: 1 });
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  doc = withNormalizedZ(doc);
  // Reproduce app.svelte.js #zOrderBlock + #commitBlockZ for the selected group.
  const zPairs = () => nodesAt(doc).map((n) => [n.itemId, n.state.z ?? 0]);
  const block = [gid, id1, id2];
  // Capture the members' relative z ordering BEFORE the block move.
  const zBefore = new Map(nodesAt(doc).map((n) => [n.itemId, n.state.z]));
  const member1WasBelow2 = zBefore.get(id1) < zBefore.get(id2);
  for (const [id, z] of blockZToExtreme(zPairs(), block, +1))
    doc = keyframed(doc, 0, ["items", id, "z"], z);
  doc = withNormalizedZ(doc);
  const zById = new Map(nodesAt(doc).map((n) => [n.itemId, n.state.z]));
  // Every block id above both foreign items.
  for (const id of block) {
    assert.ok(zById.get(id) > zById.get(fA), `${id} above foreign A`);
    assert.ok(zById.get(id) > zById.get(fB), `${id} above foreign B`);
  }
  // Members' relative z order within the block preserved.
  assert.equal(zById.get(id1) < zById.get(id2), member1WasBelow2, "member relative order preserved");
});

test("z-order block: To Back drops the group AND its members below foreign items", () => {
  let [doc, id1, id2] = docWithTwoRects();
  let fA;
  [doc, fA] = withNewItem(doc, 0, { type: "rect", x: 400, y: 400, w: 20, h: 20, z: 10, rotation: 0, scale: 1, active: true, fill: "#111", stroke: "#000", strokeWidth: 1, cornerRadius: 0, opacity: 1 });
  let gid; [doc, gid] = groupTwo(doc, id1, id2);
  doc = withNormalizedZ(doc);
  const zPairs = () => nodesAt(doc).map((n) => [n.itemId, n.state.z ?? 0]);
  const block = [gid, id1, id2];
  for (const [id, z] of blockZToExtreme(zPairs(), block, -1))
    doc = keyframed(doc, 0, ["items", id, "z"], z);
  doc = withNormalizedZ(doc);
  const zById = new Map(nodesAt(doc).map((n) => [n.itemId, n.state.z]));
  for (const id of block) assert.ok(zById.get(id) < zById.get(fA), `${id} below foreign A`);
});

console.log(`\n${passed} group integration checks passed.`);
