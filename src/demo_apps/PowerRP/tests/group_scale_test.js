/**
 * SCALING A GROUP SCALES ITS CHILDREN (user ruling, 2026-08-01: "When the group
 * is scaled everything inside should scale with it") — the gate for todo #222.
 * Run: node src/demo_apps/PowerRP/tests/group_scale_test.js
 *
 * WHAT WAS BROKEN, measured before the fix. Only TWO of the app's scale paths
 * carried members: the group's own resize handles (groupResizeState, manifest
 * 15.7) and a direct write to the group's `scale`. The other two wrote the
 * group's w/h — which is not in any transform, so `groupInfluence` never sees it
 * — and the members did not move. The S modal was the worst of them, because it
 * ALSO writes x/y: the group's outline doubled while its contents merely slid
 * around inside it, with no error anywhere.
 *
 * HOW IT IS FIXED, and why the shape matters more than the fix. Groups are FLAT
 * MEMBERSHIP DERIVATION PARENTS, not nested object trees, so "scale the children"
 * has to be said through the DERIVATION: the gesture writes the ARMATURE's own
 * {scale, x, y} and core/derive.applyGroupParenting carries it to every member,
 * with ZERO per-member writes. Baking a scale into each child's stored state
 * would stamp literals over any equation the child holds on w/h/x/y — which is
 * the data loss the minimal-delta discipline exists to prevent, so §"equations
 * survive" below is the assertion this whole gate is really about.
 *
 * Registers only rect/camera/group so a concurrently-broken sibling plugin
 * cannot block it (the group_integration_probe precedent).
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { newDocument, foldState, keyframed, withNewItem, withNormalizedZ } from "../core/document.js";
import { deriveRenderTree, worldTransform, UNCONSTRAINED } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { rotatedBBoxAABB } from "../core/view.js";
import {
  scalePairs, scaleMemberPairs, groupResizeState, uniformFactorFor, armatureScaledState, axisPinning,
  resizedBox,
} from "../web/canvas/dragKinds.js";
import { rectPlugin } from "../plugins/rect.js";
import { cameraPlugin } from "../plugins/camera.js";
import { groupPlugin } from "../plugins/group.js";
import { builtinRoster } from "../plugins/index.js";

const registry = createRegistry();
for (const p of [rectPlugin, cameraPlugin, groupPlugin]) registry.register(p);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
function approx(a, b, eps = 1e-6) { assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`); }

// ── Scene builders ───────────────────────────────────────────────────────────

function baseRect(over = {}) {
  return {
    type: "rect", x: 100, y: 100, w: 80, h: 60, z: 1, rotation: 0, scale: 1, active: true,
    fill: "#f00", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" }, ...over,
  };
}

/** Command (builds a doc). A group over the given member states, bound at its AABB. */
function sceneWith(memberStates) {
  let doc = newDocument();
  const ids = [];
  for (const s of memberStates) { let id; [doc, id] = withNewItem(doc, 0, s); ids.push(id); }
  const nodes = deriveRenderTree(evaluateState(foldState(doc, 0, 1), registry).state, registry);
  const boxes = nodes.filter((n) => ids.includes(n.itemId)).map(rotatedBBoxAABB);
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  let gid;
  [doc, gid] = withNewItem(doc, 0, {
    ...registry.get("group").defaults,
    x: minX, y: minY, w: maxX - minX, h: maxY - minY, rotation: 0, scale: 1,
    members: ids, bind: { x: minX, y: minY, rotation: 0, scale: 1 }, active: true, z: 99,
  });
  return [withNormalizedZ(doc), gid, ids];
}

const nodesOf = (doc) => deriveRenderTree(evaluateState(foldState(doc, 0, 1), registry).state, registry);
const nodeOf = (doc, id) => nodesOf(doc).find((n) => n.itemId === id);
const inkOf = (doc, id) => rotatedBBoxAABB(nodeOf(doc, id));
const applyPairs = (doc, pairs) => pairs.reduce((d, [path, v]) => keyframed(d, 0, path, v), doc);

/** Query. CanvasView translateMembers()'s record shape, for one derived item. */
function memberRecord(doc, id) {
  const n = nodeOf(doc, id);
  const raw = foldState(doc, 0, 1).items[id];
  return {
    itemId: id, plugin: n.plugin, rawItem: raw,
    startX: n.state.x ?? 0, startY: n.state.y ?? 0, startWorld: n.world,
    startW: n.state.w ?? 0, startH: n.state.h ?? 0, startRotation: n.state.rotation ?? 0,
  };
}

/** Query. The world centre of a group's own box — the S modal's collective pivot. */
function groupCentre(doc, gid) {
  const g = nodeOf(doc, gid);
  return { x: g.state.x + g.state.w / 2, y: g.state.y + g.state.h / 2 };
}

const FACTOR = 2;
const writtenLeaves = (pairs) => pairs.map(([p]) => p.slice(2).join(".")).sort();

// ── (1) THE DECLARATION: dispatch is on the capability, never on the type ────

test("only the group declares `armature`, and the seam dispatches on the DECLARATION", () => {
  const declaring = builtinRoster().filter((p) => p.capabilities?.armature).map((p) => p.type);
  assert.deepEqual(declaring, ["group"], "exactly one registered widget is an armature today");
  // The dispatch is BEHAVIOURAL, not a type string: the same state through two
  // plugin objects differing ONLY in the capability writes two different records.
  const box = { x: 10, y: 20, w: 100, h: 50, rotation: 0, scale: 1 };
  const m = (caps) => ({
    itemId: "m", plugin: { capabilities: caps }, rawItem: box,
    startX: 10, startY: 20, startWorld: box, startW: 100, startH: 50,
  });
  assert.deepEqual(writtenLeaves(scaleMemberPairs(m({ bbox: true }), 2, 2, 0, 0)), ["h", "w", "x", "y"]);
  assert.deepEqual(writtenLeaves(scaleMemberPairs(m({ bbox: true, armature: true }), 2, 2, 0, 0)), ["scale", "x", "y"]);
});

test("an armature scale NEVER writes w or h (they are not in any transform)", () => {
  let [doc, gid] = sceneWith([baseRect(), baseRect({ x: 300, y: 220, w: 40, h: 40, z: 2 })]);
  for (const pairs of [
    scalePairs(memberRecord(doc, gid), FACTOR, groupCentre(doc, gid)),
    scaleMemberPairs(memberRecord(doc, gid), FACTOR, FACTOR, 0, 0),
  ])
    for (const [path] of pairs)
      assert.ok(!["w", "h"].includes(path[path.length - 1]), `wrote ${path.join(".")} — w/h never reach groupInfluence`);
});

// ── (2) THE FEATURE: every scale path carries the members ────────────────────

/** Query. Scales the group through `gesture`, returning members' ink before/after. */
function scaleScene(memberStates, gesture) {
  const [doc, gid, ids] = sceneWith(memberStates);
  const before = ids.map((id) => inkOf(doc, id));
  const after0 = applyPairs(doc, gesture(doc, gid));
  return { gid, ids, before, after: ids.map((id) => inkOf(after0, id)), doc: after0, base: doc };
}

const S_MODAL = (doc, gid) => scalePairs(memberRecord(doc, gid), FACTOR, groupCentre(doc, gid));
const MULTI_RESIZE = (doc, gid) => {
  const g = nodeOf(doc, gid);
  return scaleMemberPairs(memberRecord(doc, gid), FACTOR, FACTOR, g.state.x, g.state.y);
};
const HANDLES = (doc, gid) => {
  const g = nodeOf(doc, gid);
  const gs = groupResizeState(
    { x: g.state.x, y: g.state.y, w: g.state.w, h: g.state.h, rotation: 0, scale: g.state.scale ?? 1 },
    g.world, { east: true, south: true }, {}, { x: g.state.w, y: g.state.h },
  );
  return [[["items", gid, "scale"], gs.scale], [["items", gid, "x"], gs.x], [["items", gid, "y"], gs.y]];
};

for (const [label, gesture, anchor] of [
  ["the S modal", S_MODAL, (doc, gid) => groupCentre(doc, gid)],
  ["a uniform multi-resize", MULTI_RESIZE, (doc, gid) => ({ x: nodeOf(doc, gid).state.x, y: nodeOf(doc, gid).state.y })],
  ["the group's own handles", HANDLES, (doc, gid) => ({ x: nodeOf(doc, gid).state.x, y: nodeOf(doc, gid).state.y })],
])
  test(`${label}: every member's INK scales x${FACTOR} about the gesture's anchor`, () => {
    const members = [baseRect(), baseRect({ x: 300, y: 220, w: 40, h: 40, z: 2 })];
    const [doc0, gid0] = sceneWith(members);
    const a = anchor(doc0, gid0);
    const r = scaleScene(members, gesture);
    r.before.forEach((b, i) => {
      const got = r.after[i];
      approx(got.w, b.w * FACTOR, 1e-4);
      approx(got.h, b.h * FACTOR, 1e-4);
      approx(got.x, a.x + FACTOR * (b.x - a.x), 1e-4);
      approx(got.y, a.y + FACTOR * (b.y - a.y), 1e-4);
    });
  });

test("the group's own hull scales by the same factor, so contents never slide inside it", () => {
  const members = [baseRect(), baseRect({ x: 300, y: 220, w: 40, h: 40, z: 2 })];
  const [doc, gid] = sceneWith(members);
  const hull0 = inkOf(doc, gid);
  const hull1 = inkOf(applyPairs(doc, S_MODAL(doc, gid)), gid);
  approx(hull1.w, hull0.w * FACTOR, 1e-4);
  approx(hull1.h, hull0.h * FACTOR, 1e-4);
});

// ── (3) NOTHING CHANGES WHEN NOTHING WAS ASKED FOR ───────────────────────────

test("factor 1 writes NOTHING — an untouched group is byte-identical", () => {
  const [doc, gid] = sceneWith([baseRect(), baseRect({ x: 300, y: 220, z: 2 })]);
  assert.deepEqual(scalePairs(memberRecord(doc, gid), 1, groupCentre(doc, gid)), []);
  assert.deepEqual(scaleMemberPairs(memberRecord(doc, gid), 1, 1, 17, -4), []);
  // …and the whole derived scene is unchanged, not merely the pair list.
  const snap = (d) => JSON.stringify(nodesOf(d).map((n) => [n.itemId, n.world]));
  assert.equal(snap(applyPairs(doc, scalePairs(memberRecord(doc, gid), 1, groupCentre(doc, gid)))), snap(doc));
});

// ── (4) EQUATIONS SURVIVE — the assertion this gate exists for ───────────────

test("a member's `=` equations on w/h/x/y survive a group scale UNTOUCHED", () => {
  const [doc, gid, ids] = sceneWith([
    baseRect({ x: "= 100 + 0", y: "= 90 + 10", w: "= 40 * 2", h: "= 60" }),
    baseRect({ x: 300, y: 220, w: 40, h: 40, z: 2 }),
  ]);
  const pairs = scalePairs(memberRecord(doc, gid), FACTOR, groupCentre(doc, gid));
  // ZERO per-member writes: the gesture touches the ARMATURE and nothing else.
  for (const [path] of pairs) assert.equal(path[1], gid, `wrote to ${path[1]}, not the group`);
  const after = applyPairs(doc, pairs);
  const raw = foldState(after, 0, 1).items[ids[0]];
  assert.deepEqual(
    { x: raw.x, y: raw.y, w: raw.w, h: raw.h },
    { x: "= 100 + 0", y: "= 90 + 10", w: "= 40 * 2", h: "= 60" },
    "the stored equations are still equations");
  // And the equation-driven member still SCALED, because the influence is applied
  // to its world rather than to its state — which is the whole design.
  const b = inkOf(doc, ids[0]), a = inkOf(after, ids[0]);
  approx(a.w, b.w * FACTOR, 1e-4);
  approx(a.h, b.h * FACTOR, 1e-4);
});

test("an equation-valued group `scale` REFUSES the gesture rather than stamping a literal", () => {
  let [doc, gid] = sceneWith([baseRect(), baseRect({ x: 300, y: 220, z: 2 })]);
  doc = keyframed(doc, 0, ["items", gid, "scale"], "= 1 + 0");
  assert.deepEqual(scalePairs(memberRecord(doc, gid), FACTOR, groupCentre(doc, gid)), []);
  assert.equal(foldState(doc, 0, 1).items[gid].scale, "= 1 + 0");
});

// ── (5) THE HARD CASES: rotation, negative extents, a group inside a group ───

test("a ROTATED member scales about the anchor and keeps its own rotation", () => {
  const R = Math.PI / 5;
  const [doc, gid, ids] = sceneWith([baseRect({ rotation: R }), baseRect({ x: 300, y: 220, z: 2 })]);
  const c = groupCentre(doc, gid);
  const w0 = nodeOf(doc, ids[0]).world;
  const after = applyPairs(doc, scalePairs(memberRecord(doc, gid), FACTOR, c));
  const w1 = nodeOf(after, ids[0]).world;
  approx(w1.rotation, w0.rotation);                       // rotation untouched
  approx(w1.scale, w0.scale * FACTOR);                    // scale multiplied
  approx(w1.x, c.x + FACTOR * (w0.x - c.x), 1e-4);        // origin scaled about the pivot
  approx(w1.y, c.y + FACTOR * (w0.y - c.y), 1e-4);
});

test("a ROTATED group scales its members about the anchor without adding rotation", () => {
  const R = Math.PI / 7;
  let [doc, gid, ids] = sceneWith([baseRect(), baseRect({ x: 300, y: 220, z: 2 })]);
  doc = keyframed(doc, 0, ["items", gid, "rotation"], R);
  const c = groupCentre(doc, gid);
  const before = ids.map((id) => nodeOf(doc, id).world);
  const pairs = scalePairs(memberRecord(doc, gid), FACTOR, c);
  assert.ok(!pairs.some(([p]) => p[p.length - 1] === "rotation"), "a scale never writes rotation");
  const after = applyPairs(doc, pairs);
  ids.forEach((id, i) => {
    const w = nodeOf(after, id).world;
    approx(w.rotation, before[i].rotation, 1e-9);
    approx(w.scale, before[i].scale * FACTOR, 1e-6);
    approx(w.x, c.x + FACTOR * (before[i].x - c.x), 1e-4);
    approx(w.y, c.y + FACTOR * (before[i].y - c.y), 1e-4);
  });
});

test("a member stored with NEGATIVE extents (a flip) scales like any other", () => {
  // THE FLIP: a stored w/h may be negative; the sign is a reflection resolved at
  // core/geometry.normalizedBox, so the influence must not care about it.
  const [doc, gid, ids] = sceneWith([
    baseRect({ x: 180, w: -80 }), baseRect({ x: 300, y: 260, h: -40, z: 2 }),
  ]);
  const c = groupCentre(doc, gid);
  const before = ids.map((id) => inkOf(doc, id));
  const after = applyPairs(doc, scalePairs(memberRecord(doc, gid), FACTOR, c));
  ids.forEach((id, i) => {
    const a = inkOf(after, id), b = before[i];
    approx(a.w, b.w * FACTOR, 1e-4);
    approx(a.h, b.h * FACTOR, 1e-4);
    approx(a.x, c.x + FACTOR * (b.x - c.x), 1e-4);
  });
  // The stored signs are untouched — nothing per-member was written at all.
  const raw = foldState(after, 0, 1).items;
  assert.equal(raw[ids[0]].w, -80);
  assert.equal(raw[ids[1]].h, -40);
});

test("a member that is ITSELF a group scales with the outer group", () => {
  // Nested membership is not created by groupSelection (it forbids grouping
  // groups) but IS reachable — retyping an item to `group` and writing `members`
  // makes one. The single-pass ordering caveat is applyGroupParenting's own; what
  // is asserted here is the part that must hold regardless: the inner group's own
  // node, being a member, picks up the outer influence on its world.
  const [doc, inner, leaves] = sceneWith([baseRect(), baseRect({ x: 300, y: 220, z: 2 })]);
  const innerNode = nodeOf(doc, inner);
  let outer, doc2 = doc;
  [doc2, outer] = withNewItem(doc2, 0, {
    ...registry.get("group").defaults,
    x: innerNode.state.x, y: innerNode.state.y, w: innerNode.state.w, h: innerNode.state.h,
    rotation: 0, scale: 1, members: [inner],
    bind: { x: innerNode.state.x, y: innerNode.state.y, rotation: 0, scale: 1 },
    active: true, z: 200,
  });
  doc2 = withNormalizedZ(doc2);
  const c = groupCentre(doc2, outer);
  const w0 = nodeOf(doc2, inner).world;
  const after = applyPairs(doc2, scalePairs(memberRecord(doc2, outer), FACTOR, c));
  const w1 = nodeOf(after, inner).world;
  approx(w1.scale, w0.scale * FACTOR, 1e-6);
  approx(w1.x, c.x + FACTOR * (w0.x - c.x), 1e-4);
  assert.equal(leaves.length, 2);
});

// ── (6) THE AXIS CONSTRAINT: an armature refuses what it cannot do ───────────

test("an axis-CONSTRAINED S modal refuses an armature but still scales a plain box", () => {
  const [doc, gid, ids] = sceneWith([baseRect(), baseRect({ x: 300, y: 220, z: 2 })]);
  const c = groupCentre(doc, gid);
  for (const axis of ["x", "y"]) {
    assert.deepEqual(scalePairs(memberRecord(doc, gid), FACTOR, c, axis), [],
      `S ${axis.toUpperCase()} asks for anisotropy a similarity cannot express — the two allowed sets meet only at the identity`);
    // The refusal is the ARMATURE's, not a broken test: the same call on a rect writes.
    assert.deepEqual(writtenLeaves(scalePairs(memberRecord(doc, ids[0]), FACTOR, c, axis)),
      axis === "x" ? ["w", "x"] : ["h", "y"]);
  }
});

test("a per-item projection that pins an axis refuses the armature the same way", () => {
  // Asked of the PROJECTION, not of the modal — so a lock the gesture knows
  // nothing about counts identically. UNCONSTRAINED must still let it through.
  const [doc, gid] = sceneWith([baseRect(), baseRect({ x: 300, y: 220, z: 2 })]);
  const m = memberRecord(doc, gid);
  assert.deepEqual(scaleMemberPairs(m, FACTOR, FACTOR, 0, 0, axisPinning("x")), []);
  assert.ok(scaleMemberPairs(m, FACTOR, FACTOR, 0, 0, UNCONSTRAINED).length > 0);
});

// ── (7) THE TWO SEAMS ARE ONE ────────────────────────────────────────────────

test("uniformFactorFor: position space and factor space are the same projection", () => {
  // The corner-grab K resizedBox computes, and the box-weighted mean the armature
  // branch computes, are one function called with two drive vectors. Asserting the
  // equality is what stops the two READINGS drifting even though the code cannot.
  for (const [w, h] of [[200, 100], [1, 400], [37, 37]])
    for (const [dx, dy] of [[200, 100], [400, 0], [-100, 300], [0, 0]]) {
      // POSITION space: what resizedBox's `uniform` branch actually produces for a
      // bottom-right corner grab (fixed top-left), read back as a width ratio.
      const box = resizedBox([0, 0, w, h], { x: dx, y: dy }, { east: true, south: true }, { uniform: true });
      const positionSpace = (box[2] - box[0]) / w;
      // FACTOR space: the same drag stated as the per-axis pair the armature sees.
      const factorSpace = uniformFactorFor({ x: (w + dx), y: (h + dy) }, { x: w, y: h });
      approx(positionSpace, factorSpace, 1e-12);
      approx(factorSpace, (((w + dx) / w) * w * w + ((h + dy) / h) * h * h) / (w * w + h * h), 1e-9);
    }
  assert.equal(uniformFactorFor({ x: 5, y: 5 }, { x: 0, y: 0 }), null);
  approx(uniformFactorFor({ x: 200, y: 100 }, { x: 100, y: 50 }), 2);
  approx(uniformFactorFor({ x: 180, y: 999 }, { x: 100, y: 0 }), 1.8);
});

test("armatureScaledState doctests, including the non-negative clamp", () => {
  assert.deepEqual(
    armatureScaledState({ w: 200, h: 100, scale: 1 }, { x: 100, y: 100, rotation: 0, scale: 1 }, 2, { x: 100, y: 100 }),
    { scale: 2, x: 100, y: 100 });
  assert.deepEqual(
    armatureScaledState({ w: 200, h: 100, scale: 1 }, { x: 100, y: 100, rotation: 0, scale: 1 }, 2, { x: 200, y: 200 }),
    { scale: 2, x: 200, y: 200 });
  // A scalar has no handedness: a negative factor is clamped, never reflected.
  assert.equal(
    armatureScaledState({ w: 200, h: 100, scale: 1 }, { x: 0, y: 0, rotation: 0, scale: 1 }, -2, { x: 0, y: 0 }).scale, 0);
});

test("the handle path and the modal path agree for the same uniform factor + anchor", () => {
  // groupResizeState is the handle half of ONE feature; scaleMemberPairs is the
  // other. Same armature, same K, same anchor ⇒ the same stored {scale, x, y}.
  const gState = { x: 100, y: 100, w: 200, h: 100, rotation: 0, scale: 1 };
  const gWorld = worldTransform(gState);
  const viaHandles = groupResizeState(gState, gWorld, { east: true, south: true }, {}, { x: 200, y: 100 });
  const viaModal = scaleMemberPairs(
    { itemId: "g", plugin: { capabilities: { armature: true } }, rawItem: gState,
      startX: gState.x, startY: gState.y, startWorld: gWorld, startW: gState.w, startH: gState.h },
    2, 2, gState.x, gState.y);
  // The modal path is a MINIMAL DELTA and the handle path a whole record, so the
  // delta is merged onto the start pose before comparing — an unwritten key means
  // "unchanged", which is exactly what makes the two agree here (scaling about the
  // armature's own top-left moves its origin nowhere, so x/y are correctly absent).
  assert.deepEqual(
    { scale: gState.scale, x: gState.x, y: gState.y, ...Object.fromEntries(viaModal.map(([p, v]) => [p[2], v])) },
    { scale: viaHandles.scale, x: viaHandles.x, y: viaHandles.y });
});

console.log(`${passed} group-scale tests passed.`);
