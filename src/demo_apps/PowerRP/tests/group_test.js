/**
 * Groups (rough draft) core tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/group_test.js
 *
 * Covers the parenting MATH (derivation-stage armature: influence = current ∘
 * invert(bind); member.world' = influence ∘ member.world), the band-select
 * group filter + selection guard, and the ungroup world-exact bake (numeric
 * asserts that worldTransform of the baked state reproduces the member's
 * group-influenced world). Mirrors every @example doctest in core/derive.js
 * (group functions) + core/bandselect.js (group functions) plus behavioral
 * cases (45° rotation, bind re-pose invariance, ungroup bake exactness).
 *
 * The core being DOM-free is itself under test: any window/document reference
 * in the imported core modules would crash this file.
 */

import assert from "node:assert/strict";
import * as T from "../core/transform.js";
import {
  groupInfluence, groupBindWorld, applyGroupParenting, groupMembership,
  worldTransform, stateXYForCenterPivotWorld, snapExclusionSet,
} from "../core/derive.js";
import { groupFilteredSelection, dedupeGroupSelection } from "../core/bandselect.js";
import { blockZToExtreme } from "../core/document.js";
import { groupResizeState } from "../web/canvas/dragKinds.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}
function approxT(a, b, eps = 1e-6) {
  approx(a.x, b.x, eps); approx(a.y, b.y, eps);
  approx(a.rotation, b.rotation, eps); approx(a.scale, b.scale, eps);
}

// ── groupInfluence / groupBindWorld doctests ─────────────────────────────────

test("groupInfluence: pure-translate delta (doctest)", () => {
  assert.deepEqual(
    groupInfluence({ x: 150, y: 120, rotation: 0, scale: 1 }, { x: 100, y: 100, rotation: 0, scale: 1 }),
    { x: 50, y: 20, rotation: 0, scale: 1 });
});

test("groupInfluence: current === bind ⇒ identity (re-pose invariance, doctest)", () => {
  assert.deepEqual(
    groupInfluence({ x: 100, y: 100, rotation: 0, scale: 1 }, { x: 100, y: 100, rotation: 0, scale: 1 }),
    { x: 0, y: 0, rotation: 0, scale: 1 });
});

test("groupBindWorld: reads flat bind through worldTransform (doctest)", () => {
  assert.deepEqual(
    groupBindWorld({ bind: { x: 100, y: 100, rotation: 0, scale: 1 }, w: 200, h: 100 }),
    { x: 100, y: 100, rotation: 0, scale: 1 });
  assert.deepEqual(groupBindWorld({ w: 200, h: 100 }), { x: 0, y: 0, rotation: 0, scale: 1 });
});

// ── applyGroupParenting doctests + behavior ──────────────────────────────────

test("applyGroupParenting: member follows a translated group (doctest)", () => {
  const out = applyGroupParenting([
    { itemId: "g", type: "group", state: { members: ["r"], bind: { x: 100, y: 100, rotation: 0, scale: 1 } }, world: { x: 150, y: 120, rotation: 0, scale: 1 }, plugin: {} },
    { itemId: "r", type: "rect", state: {}, world: { x: 200, y: 200, rotation: 0, scale: 1 }, plugin: {} },
  ]);
  assert.deepEqual(out.find((n) => n.itemId === "r").world, { x: 250, y: 220, rotation: 0, scale: 1 });
});

test("applyGroupParenting: no groups ⇒ passthrough (doctest, purity)", () => {
  const input = [{ itemId: "r", type: "rect", state: {}, world: { x: 5, y: 5, rotation: 0, scale: 1 }, plugin: {} }];
  const out = applyGroupParenting(input);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].world, { x: 5, y: 5, rotation: 0, scale: 1 });
  assert.deepEqual(input[0].world, { x: 5, y: 5, rotation: 0, scale: 1 }); // input untouched
});

test("applyGroupParenting: purity — input node worlds never mutated", () => {
  const input = [
    { itemId: "g", type: "group", state: { members: ["r"], bind: { x: 0, y: 0, rotation: 0, scale: 1 } }, world: { x: 30, y: 40, rotation: 0, scale: 1 }, plugin: {} },
    { itemId: "r", type: "rect", state: {}, world: { x: 10, y: 10, rotation: 0, scale: 1 }, plugin: {} },
  ];
  applyGroupParenting(input);
  assert.deepEqual(input[1].world, { x: 10, y: 10, rotation: 0, scale: 1 });
});

test("applyGroupParenting: 45° group rotation orbits members about the group pivot", () => {
  // Group bind at (100,100) rotation 0; now rotated 45° about ITS OWN rotation
  // anchor. Build the group's CURRENT world exactly as worldTransform would
  // (center pivot of a 200×100 box), so the test mirrors the real pipeline.
  const groupState = { members: ["r"], w: 200, h: 100, x: 100, y: 100, rotation: Math.PI / 4, scale: 1,
    bind: { x: 100, y: 100, rotation: 0, scale: 1 } };
  const gWorld = worldTransform(groupState);
  const member = { itemId: "r", type: "rect", state: { w: 40, h: 40 }, world: { x: 100, y: 100, rotation: 0, scale: 1 }, plugin: {} };
  const out = applyGroupParenting([
    { itemId: "g", type: "group", state: groupState, world: gWorld, plugin: {} },
    member,
  ]);
  const mw = out.find((n) => n.itemId === "r").world;
  // A member picks up the group's rotation exactly.
  approx(mw.rotation, Math.PI / 4);
  approx(mw.scale, 1);
  // And a member sitting exactly at the group's rotation pivot (its center) is
  // NOT translated by the rotation — verify by placing a member there.
  const pivot = worldTransform(groupState); // group world's fixed point is the center
  const center = T.apply({ ...T.fromState(groupState), rotation: 0 }, groupState.w / 2, groupState.h / 2);
  const memberAtPivot = { itemId: "p", type: "rect", state: { w: 0, h: 0 }, world: { x: center.x, y: center.y, rotation: 0, scale: 1 }, plugin: {} };
  const out2 = applyGroupParenting([
    { itemId: "g", type: "group", state: groupState, world: pivot, plugin: {} },
    memberAtPivot,
  ]);
  const pw = out2.find((n) => n.itemId === "p").world;
  approx(pw.x, center.x, 1e-6);
  approx(pw.y, center.y, 1e-6);
});

test("applyGroupParenting: bind RE-POSE — moving bind AND current together is a no-op relative delta", () => {
  // If a group is authored at a different bind pose but currently sits AT that
  // bind, members are untouched (identity influence) regardless of where the
  // bind is. This is the armature bind-pose property.
  const bind = { x: 300, y: 250, rotation: Math.PI / 6, scale: 1.5 };
  const groupState = { members: ["r"], w: 200, h: 100, x: 300, y: 250, rotation: Math.PI / 6, scale: 1.5, bind };
  const gWorld = worldTransform(groupState);
  const member = { itemId: "r", type: "rect", state: { w: 10, h: 10 }, world: { x: 42, y: 43, rotation: 0.2, scale: 2 }, plugin: {} };
  const out = applyGroupParenting([
    { itemId: "g", type: "group", state: groupState, world: gWorld, plugin: {} },
    member,
  ]);
  approxT(out.find((n) => n.itemId === "r").world, member.world);
});

test("applyGroupParenting: individual member move still composes on top of group influence", () => {
  // The group translates +50/+20. A member moved individually (its OWN world
  // differs) still ends up group-shifted — the group's influence composes onto
  // whatever the member's own transform is (members stay STORED/derivable).
  const out = applyGroupParenting([
    { itemId: "g", type: "group", state: { members: ["r"], bind: { x: 0, y: 0, rotation: 0, scale: 1 } }, world: { x: 50, y: 20, rotation: 0, scale: 1 }, plugin: {} },
    { itemId: "r", type: "rect", state: {}, world: { x: 500, y: 600, rotation: 0, scale: 1 }, plugin: {} }, // moved individually
  ]);
  assert.deepEqual(out.find((n) => n.itemId === "r").world, { x: 550, y: 620, rotation: 0, scale: 1 });
});

test("applyGroupParenting: purged/absent member is skipped, not an error", () => {
  const out = applyGroupParenting([
    { itemId: "g", type: "group", state: { members: ["gone"], bind: { x: 0, y: 0, rotation: 0, scale: 1 } }, world: { x: 9, y: 9, rotation: 0, scale: 1 }, plugin: {} },
  ]);
  assert.equal(out.length, 1); // no throw; group passes through
});

// ── groupMembership doctests ─────────────────────────────────────────────────

test("groupMembership: member → its group id (doctest)", () => {
  assert.equal(groupMembership([{ itemId: "g", type: "group", state: { members: ["a", "b"] } }, { itemId: "a", type: "rect", state: {} }]).get("a"), "g");
  assert.equal(groupMembership([{ itemId: "r", type: "rect", state: {} }]).size, 0);
});

// ── band-select group filter + selection guard doctests + behavior ───────────

test("groupFilteredSelection: caught members collapse to their group (doctest)", () => {
  assert.deepEqual(groupFilteredSelection(["a", "b"], new Map([["a", "g"], ["b", "g"]])), ["g"]);
  assert.deepEqual(groupFilteredSelection(["r", "a"], new Map([["a", "g"]])), ["r", "g"]);
  assert.deepEqual(groupFilteredSelection(["g", "a"], new Map([["a", "g"]])), ["g"]);
});

test("groupFilteredSelection: a lone member is NEVER band-caught while grouped", () => {
  // Band catches member "a" (grouped) → the result is the GROUP, never "a".
  assert.deepEqual(groupFilteredSelection(["a"], new Map([["a", "g"]])), ["g"]);
});

test("dedupeGroupSelection: group present ⇒ its members dropped (doctest)", () => {
  assert.deepEqual(dedupeGroupSelection(["g", "a"], new Map([["a", "g"]])), ["g"]);
  assert.deepEqual(dedupeGroupSelection(["a"], new Map([["a", "g"]])), ["a"]); // lone member survives
  assert.deepEqual(dedupeGroupSelection(["g", "r"], new Map([["a", "g"]])), ["g", "r"]);
});

test("dedupeGroupSelection: group and members can never coexist", () => {
  const membership = new Map([["a", "g"], ["b", "g"]]);
  const out = dedupeGroupSelection(["g", "a", "b", "r"], membership);
  assert.deepEqual(out, ["g", "r"]); // both members dropped, group + ungrouped r kept
});

// ── UNGROUP world-exact bake ─────────────────────────────────────────────────
// The app's ungroupSelection bakes each member's group-influenced node.world
// into stored x/y (via stateXYForCenterPivotWorld) + rotation/scale, so
// worldTransform(baked) reproduces node.world EXACTLY. Test the math directly.

function bakeMemberWorld(memberState, groupInfluenceT, ownWorld) {
  // Mirror the app: member's derived world = influence ∘ own world.
  const derivedWorld = T.compose(groupInfluenceT, ownWorld);
  const { w, h } = memberState;
  const xy = (typeof w === "number" && typeof h === "number")
    ? stateXYForCenterPivotWorld(derivedWorld, w, h)
    : { x: derivedWorld.x, y: derivedWorld.y };
  return { ...memberState, x: xy.x, y: xy.y, rotation: derivedWorld.rotation, scale: derivedWorld.scale };
}

test("ungroup bake: baked bbox member reproduces its group-influenced world exactly (translate)", () => {
  const influence = groupInfluence({ x: 150, y: 120, rotation: 0, scale: 1 }, { x: 100, y: 100, rotation: 0, scale: 1 }); // +50,+20
  const memberState = { w: 80, h: 60 };
  const ownWorld = worldTransform({ ...memberState, x: 200, y: 210, rotation: 0, scale: 1 });
  const baked = bakeMemberWorld(memberState, influence, ownWorld);
  const derived = T.compose(influence, ownWorld);
  approxT(worldTransform(baked), derived);
});

test("ungroup bake: baked ROTATED bbox member reproduces its group-influenced world exactly", () => {
  // Member already rotated 30°; group rotates 45° about its bind. The baked
  // state (clean self-center pivot) must paint the SAME world the influenced
  // node did — no opposite-edge drift (the rotated-resize inverse guarantees it).
  const influence = groupInfluence(
    { x: 100, y: 100, rotation: Math.PI / 4, scale: 1 },
    { x: 100, y: 100, rotation: 0, scale: 1 });
  const memberState = { w: 120, h: 90 };
  const ownWorld = worldTransform({ ...memberState, x: 260, y: 180, rotation: Math.PI / 6, scale: 1.25 });
  const baked = bakeMemberWorld(memberState, influence, ownWorld);
  const derived = T.compose(influence, ownWorld);
  approxT(worldTransform(baked), derived);
});

test("ungroup bake: non-bbox member (no w/h) bakes x/y/rotation/scale directly", () => {
  const influence = groupInfluence({ x: 10, y: 10, rotation: 0, scale: 2 }, { x: 0, y: 0, rotation: 0, scale: 1 });
  const memberState = {}; // no w/h
  const ownWorld = { x: 5, y: 5, rotation: 0.1, scale: 1 };
  const baked = bakeMemberWorld(memberState, influence, ownWorld);
  const derived = T.compose(influence, ownWorld);
  approxT({ x: baked.x, y: baked.y, rotation: baked.rotation, scale: baked.scale }, derived);
});

// ── 15.7 GROUP RESIZE: members scale about the fixed anchor (real derive) ─────
// groupResizeState maps a handle drag → the group's own uniform scale + x/y;
// members then follow through applyGroupParenting with NO per-member writes.

// A group at bind (100,100,scale1,rot0), box 200x100, with two members at its
// corners. Resizing must scale members about the grabbed handle's FIXED corner.
function groupWithTwoMembers() {
  const bind = { x: 100, y: 100, rotation: 0, scale: 1 };
  const gState = { members: ["a", "b"], w: 200, h: 100, x: 100, y: 100, rotation: 0, scale: 1, bind };
  const a = { itemId: "a", type: "rect", state: { w: 40, h: 40 }, world: worldTransform({ x: 100, y: 100, w: 40, h: 40, rotation: 0, scale: 1 }), plugin: {} };
  const b = { itemId: "b", type: "rect", state: { w: 40, h: 40 }, world: worldTransform({ x: 260, y: 160, w: 40, h: 40, rotation: 0, scale: 1 }), plugin: {} };
  return { gState, a, b };
}
function deriveWithGroup(gState, ...members) {
  return applyGroupParenting([{ itemId: "g", type: "group", state: gState, world: worldTransform(gState), plugin: {} }, ...members]);
}

test("groupResizeState doctest: BR corner ×2 about the fixed top-left", () => {
  assert.deepEqual(
    groupResizeState({ x: 100, y: 100, w: 200, h: 100, rotation: 0, scale: 1 }, { x: 100, y: 100, rotation: 0, scale: 1 }, { east: true, south: true }, {}, { x: 200, y: 100 }),
    { scale: 2, x: 100, y: 100 });
});

test("group resize: BR handle scales members ×2 about the fixed TOP-LEFT corner", () => {
  const { gState, a, b } = groupWithTwoMembers();
  // Grab bottom-right (east+south); fixed corner = top-left world (100,100).
  // A drag that doubles the box (local delta +200/+100 on a 200x100 box, uniform).
  const gs = groupResizeState({ ...gState, rotation: 0, scale: 1 }, worldTransform(gState), { east: true, south: true }, {}, { x: 200, y: 100 });
  const g2 = { ...gState, scale: gs.scale, x: gs.x, y: gs.y }; // w/h UNCHANGED
  const out = deriveWithGroup(g2, { ...a }, { ...b });
  const wa = out.find((n) => n.itemId === "a").world, wb = out.find((n) => n.itemId === "b").world;
  approx(gs.scale, 2);
  approx(wa.x, 100); approx(wa.y, 100); approx(wa.scale, 2); // member AT the fixed corner stays
  approx(wb.x, 100 + 2 * (260 - 100)); approx(wb.y, 100 + 2 * (160 - 100)); approx(wb.scale, 2);
});

test("group resize: TL handle scales members about the fixed BOTTOM-RIGHT corner", () => {
  const { gState, a, b } = groupWithTwoMembers();
  // Grab top-left (west+north); fixed corner = bottom-right world (300,200).
  const gs = groupResizeState({ ...gState, rotation: 0, scale: 1 }, worldTransform(gState), { west: true, north: true }, {}, { x: 100, y: 50 });
  const g2 = { ...gState, scale: gs.scale, x: gs.x, y: gs.y };
  const out = deriveWithGroup(g2, { ...a }, { ...b });
  const wa = out.find((n) => n.itemId === "a").world, wb = out.find((n) => n.itemId === "b").world;
  approx(gs.scale, 0.5);
  // Members scale ×0.5 about the fixed BR corner (300,200).
  approx(wa.x, 300 + 0.5 * (100 - 300)); approx(wa.y, 200 + 0.5 * (100 - 200)); // (200,150)
  approx(wb.x, 300 + 0.5 * (260 - 300)); approx(wb.y, 200 + 0.5 * (160 - 200)); // (280,180)
});

test("group resize: ROTATED group — fixed corner stays put, members scale about it", () => {
  const bind = { x: 100, y: 100, rotation: 0, scale: 1 };
  const gState = { members: ["a"], w: 200, h: 100, x: 100, y: 100, rotation: Math.PI / 6, scale: 1, bind };
  const gWorld = worldTransform(gState);
  const fixedTL = T.apply(gWorld, 0, 0); // BR grab → fixed = local top-left corner
  const a = { itemId: "a", type: "rect", state: { w: 40, h: 40 }, world: worldTransform({ x: 150, y: 130, w: 40, h: 40, rotation: 0, scale: 1 }), plugin: {} };
  const before = deriveWithGroup(gState, { ...a }).find((n) => n.itemId === "a").world;
  const gs = groupResizeState(gState, gWorld, { east: true, south: true }, {}, { x: 200, y: 100 });
  const g2 = { ...gState, scale: gs.scale, x: gs.x, y: gs.y };
  const after = deriveWithGroup(g2, { ...a }).find((n) => n.itemId === "a").world;
  approx(gs.scale, 2);
  // The fixed top-left corner is unmoved in world after the resize.
  const newTL = T.apply(worldTransform(g2), 0, 0);
  approx(newTL.x, fixedTL.x, 1e-4); approx(newTL.y, fixedTL.y, 1e-4);
  // The member's distance from the fixed corner scales ×2.
  const d0 = Math.hypot(before.x - fixedTL.x, before.y - fixedTL.y);
  const d1 = Math.hypot(after.x - fixedTL.x, after.y - fixedTL.y);
  approx(d1 / d0, 2, 1e-4);
  approx(after.scale, 2);
});

test("group resize: Cmd-symmetric scales members about the group CENTER", () => {
  const { gState, a, b } = groupWithTwoMembers();
  const cx = gState.x + gState.w / 2, cy = gState.y + gState.h / 2; // (200,150)
  const gs = groupResizeState({ ...gState, rotation: 0, scale: 1 }, worldTransform(gState), { east: true, south: true }, { symmetric: true }, { x: 100, y: 50 });
  const g2 = { ...gState, scale: gs.scale, x: gs.x, y: gs.y };
  const out = deriveWithGroup(g2, { ...a }, { ...b });
  const wa = out.find((n) => n.itemId === "a").world;
  const K = gs.scale;
  // Symmetric ⇒ members scale about the CENTER, not a corner.
  approx(wa.x, cx + K * (100 - cx), 1e-4); approx(wa.y, cy + K * (100 - cy), 1e-4);
});

// ── 15.7 SNAP EXCLUSION (snapExclusionSet doctests + behavior) ────────────────

test("snapExclusionSet doctest: a member excludes itself + its group", () => {
  const nodes = [{ itemId: "g", type: "group", state: { members: ["a", "b"] } }];
  assert.deepEqual([...snapExclusionSet("a", new Map([["a", "g"]]), nodes)].sort(), ["a", "g"]);
});

test("snapExclusionSet doctest: a group excludes itself + ALL members", () => {
  const nodes = [{ itemId: "g", type: "group", state: { members: ["a", "b"] } }];
  assert.deepEqual([...snapExclusionSet("g", new Map([["a", "g"], ["b", "g"]]), nodes)].sort(), ["a", "b", "g"]);
});

test("snapExclusionSet: an UNGROUPED item excludes only itself (plain self-exclusion)", () => {
  assert.deepEqual([...snapExclusionSet("r", new Map(), [{ itemId: "r", type: "rect", state: {} }])], ["r"]);
});

test("snapExclusionSet: snapping to OTHER groups/items is NOT excluded", () => {
  // Two groups g1{a}, g2{c}. Dragging member "a" excludes a + g1, but NOT g2 or c.
  const nodes = [
    { itemId: "g1", type: "group", state: { members: ["a"] } },
    { itemId: "g2", type: "group", state: { members: ["c"] } },
  ];
  const membership = groupMembership(nodes);
  const ex = snapExclusionSet("a", membership, nodes);
  assert.ok(ex.has("a") && ex.has("g1"));
  assert.ok(!ex.has("g2") && !ex.has("c")); // foreign group + its member remain snap candidates
});

// ── 15.7 Z-ORDER BLOCK (blockZToExtreme doctests + behavior) ──────────────────

test("blockZToExtreme doctest: front puts the whole block above everything else", () => {
  assert.deepEqual(blockZToExtreme([["g", 3], ["a", 1], ["b", 2], ["x", 5]], ["g", "a", "b"], +1), [["a", 6], ["b", 7], ["g", 8]]);
});

test("blockZToExtreme doctest: back puts the whole block below everything else", () => {
  assert.deepEqual(blockZToExtreme([["g", 3], ["a", 1], ["b", 2], ["x", 5]], ["g", "a", "b"], -1), [["a", 2], ["b", 3], ["g", 4]]);
});

test("blockZToExtreme: block lands ABOVE a foreign item interleaved with it, order preserved", () => {
  // z: a=1, x1=2, b=3, g=4, x2=5. Block = {g,a,b}, foreign = {x1,x2}.
  const pairs = [["a", 1], ["x1", 2], ["b", 3], ["g", 4], ["x2", 5]];
  const out = blockZToExtreme(pairs, ["g", "a", "b"], +1);
  const zById = new Map(out);
  // All three block members now exceed the max foreign z (5).
  for (const id of ["g", "a", "b"]) assert.ok(zById.get(id) > 5, `${id} should be above foreign max`);
  // Relative order within the block preserved: a(1) < b(3) < g(4) ⇒ a < b < g.
  assert.ok(zById.get("a") < zById.get("b") && zById.get("b") < zById.get("g"));
});

test("blockZToExtreme: back is symmetric — block below foreign min, order preserved", () => {
  const pairs = [["a", 1], ["x1", 2], ["b", 3], ["g", 4], ["x2", 5]];
  const foreignMin = 2; // min of x1=2, x2=5
  const out = blockZToExtreme(pairs, ["g", "a", "b"], -1);
  const zById = new Map(out);
  for (const id of ["g", "a", "b"]) assert.ok(zById.get(id) < foreignMin, `${id} should be below foreign min`);
  assert.ok(zById.get("a") < zById.get("b") && zById.get("b") < zById.get("g")); // relative order kept
});

console.log(`\n${passed} group tests passed.`);
