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
  worldTransform, stateXYForCenterPivotWorld,
} from "../core/derive.js";
import { groupFilteredSelection, dedupeGroupSelection } from "../core/bandselect.js";

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

console.log(`\n${passed} group tests passed.`);
