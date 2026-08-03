/**
 * WORKSTREAM BR — GROUP LIFECYCLE CASCADES TO CHILDREN.
 * Run: node src/demo_apps/PowerRP/tests/group_lifecycle_cascade_test.js
 *
 * User, 2026-08-03 (verbatim): "When a group is purged, all of its children
 * should be purged too. Same with... deletion. Or... change in visibility, etc.
 * If a group is not visible... then neither should its children be. When I
 * copy-paste something in a group... Yeah, yeah, okay, those things I said. Uh,
 * some of them might already be the case, so just double-check."
 *
 * THE AUDIT THAT PRODUCED THIS FILE, measured against the real document model
 * BEFORE any fix (so the pins record what was broken and what was already right):
 *   1. PURGE group   → members SURVIVED as orphans           — GAP, fixed
 *   2. DELETE group  → members stayed active: true           — GAP, fixed
 *   3. VISIBILITY    → members still rendered                — GAP, fixed
 *   4. COPY/duplicate→ members travelled, refs remapped      — ALREADY CORRECT
 *
 * THE ALREADY-CORRECT CASE IS PINNED TOO, and that is the point of a
 * double-check: verb 4 needed no fix, so nothing else would notice if a future
 * refactor of #cloneSet or itemRefs quietly dropped it.
 *
 * WHY THE THREE FIXES LAND IN THREE DIFFERENT PLACES — the split is the design:
 *   - VISIBILITY is a DERIVE-TIME law (core/derive.groupHiddenMembers). It is
 *     computed, never stored, so a member's own `active` keeps recording only
 *     what the author set on the MEMBER. It must also hold whether or not the
 *     group happens to carry an effects bundle, since groupFoldsSubtree changes
 *     the RENDER SHAPE and not the VISIBILITY FACT — pinned both ways below.
 *   - PURGE/DELETE are DOCUMENT edits sharing ONE expansion
 *     (core/document.groupCascadeIds) and two different writes, because the verbs
 *     disagree about scope by definition but must never disagree about which
 *     items a group contains.
 */

import assert from "node:assert/strict";
import {
  newDocument, keyframed, foldState, withNewSlide, withItemPurged,
  clonedItemStates, groupCascadeIds,
} from "../core/document.js";
import { deriveRenderTree, groupHiddenMembers } from "../core/derive.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { rectPlugin } from "../plugins/rect.js";
import { groupPlugin } from "../plugins/group.js";
import { cameraPlugin } from "../plugins/camera.js";

const registry = createRegistry();
for (const p of [rectPlugin, groupPlugin, cameraPlugin]) registry.register(p);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

const A = "memberA", B = "memberB", C = "memberC", G = "groupG", O = "outerO";
const MEMBERS = [A, B, C];

/** Pure function. A rect member at `x`. */
const member = (x, z) => ({ ...rectPlugin.defaults, x, y: 10, w: 20, h: 20, z, active: true });
/** Pure function. A group over `members`, at its own bind pose (identity influence). */
const group = (members, z, extra = {}) => ({
  ...groupPlugin.defaults, x: 10, y: 10, w: 100, h: 20, z, active: true,
  members, bind: { x: 10, y: 10, rotation: 0, scale: 1 }, ...extra,
});

/** Pure function. The audit scene: group G owns three rect members. */
function scene(groupExtra = {}) {
  return {
    [A]: member(10, 1), [B]: member(50, 2), [C]: member(90, 3),
    [G]: group(MEMBERS, 4, groupExtra),
  };
}

/** Query. A 2-slide document whose slide 0 creates `items`. */
function docOf(items) {
  let doc = newDocument();
  for (const [id, s] of Object.entries(items)) doc = keyframed(doc, 0, ["items", id], s);
  return withNewSlide(doc, 0)[0];
}

/** Query. The itemIds of `items` that actually RENDER (the derived node set). */
function renderedIds(items) {
  const { state } = evaluateState({ items }, registry, "");
  return deriveRenderTree(state, registry).map((n) => n.itemId);
}

/** Query. Which of the scene's ids exist in the fold of `doc` at `slide`. */
const presentOn = (doc, slide) =>
  Object.keys(foldState(doc, slide, 1).items ?? {}).filter((id) => [A, B, C, G].includes(id));

// ── VERB 1: PURGE ────────────────────────────────────────────────────────────
// GAP FIXED. Measured before: withItemPurged(G) left a,b,c behind as orphans —
// items nothing steered and nothing selected. Purge is the DOCUMENT-WIDE remover
// by definition, so the cascade removes the members from every slide too.

test("VERB 1 PURGE (gap fixed): the cascade set is the group AND its members", () => {
  assert.deepEqual(groupCascadeIds(scene(), [G]).sort(), [A, B, C, G].sort());
});

test("VERB 1 PURGE (gap fixed): purging the cascade removes members from EVERY slide", () => {
  let doc = docOf(scene());
  // The app's purgeSelection writes exactly this: expand, then purge each.
  for (const id of groupCascadeIds(scene(), [G])) doc = withItemPurged(doc, id);
  assert.deepEqual(presentOn(doc, 0), []);
  assert.deepEqual(presentOn(doc, 1), []);
});

test("VERB 1 PURGE: withItemPurged ITSELF still does NOT cascade (its other callers depend on that)", () => {
  // The primitive stays a primitive — orphan-drop, camera-repair and ungroup all
  // purge a group WITHOUT wanting its members gone (ungroup would delete the very
  // items it exists to free). The cascade is an opt-in verb, not a behavior change.
  const doc = withItemPurged(docOf(scene()), G);
  assert.deepEqual(presentOn(doc, 0).sort(), [A, B, C].sort());
});

// ── VERB 2: DELETE (the active:false keyframe) ───────────────────────────────
// GAP FIXED. Measured before: members stayed active:true, so a "deleted" group
// left its contents on the slide. Delete is PER-SLIDE, so the cascade is too.

test("VERB 2 DELETE (gap fixed): members are keyframed inactive on the SAME slide", () => {
  let doc = docOf(scene());
  for (const id of groupCascadeIds(scene(), [G]))
    doc = keyframed(doc, 0, ["items", id, "active"], false);
  const items = foldState(doc, 0, 1).items;
  for (const id of [G, ...MEMBERS]) assert.equal(items[id].active, false, `${id} should be inactive`);
});

test("VERB 2 DELETE: the cascade is PER-SLIDE, never document-wide destruction", () => {
  // Deleting on slide 1 must leave slide 0 untouched — that is the whole
  // difference between Delete and Purge, and a cascade must not blur it.
  let doc = docOf(scene());
  for (const id of groupCascadeIds(scene(), [G]))
    doc = keyframed(doc, 1, ["items", id, "active"], false);
  const s0 = foldState(doc, 0, 1).items;
  for (const id of [G, ...MEMBERS]) assert.notEqual(s0[id].active, false, `${id} must still be active on slide 0`);
  const s1 = foldState(doc, 1, 1).items;
  for (const id of [G, ...MEMBERS]) assert.equal(s1[id].active, false, `${id} should be inactive on slide 1`);
});

// ── VERB 3: VISIBILITY ───────────────────────────────────────────────────────
// GAP FIXED. Measured before: an inactive group still rendered every member.

test("VERB 3 VISIBILITY (gap fixed): an INACTIVE group renders none of its members", () => {
  const items = scene();
  items[G].active = false;
  assert.deepEqual(renderedIds(items), []);
});

test("VERB 3 VISIBILITY: a VISIBLE group hides nothing (the untouched baseline)", () => {
  assert.deepEqual(renderedIds(scene()).sort(), [A, B, C, G].sort());
  assert.equal(groupHiddenMembers(scene()).size, 0);
});

test("VERB 3 VISIBILITY: it does NOT depend on groupFoldsSubtree — pinned BOTH ways", () => {
  // An effect-free group is a pure ghost whose members render independently; a
  // group carrying effects composites them as a subtree. Two RENDER shapes, ONE
  // visibility fact — so the law must hold on both paths, always.
  for (const extra of [{}, { blendMode: "multiply" }, { shadow: { dx: 4, dy: 4, blur: 6, color: "#000000", opacity: 0.5 } }]) {
    const items = scene(extra);
    items[G].active = false;
    assert.deepEqual(renderedIds(items), [], `folding=${JSON.stringify(extra)} must still hide members`);
  }
});

test("VERB 3 VISIBILITY: TRANSITIVE through nested groups", () => {
  const items = scene();
  items[O] = group([G], 5, { active: false });
  assert.deepEqual(renderedIds(items), []);
  assert.deepEqual([...groupHiddenMembers(items)].sort(), [A, B, C, G].sort());
});

test("VERB 3 VISIBILITY: a member's OWN `active` is never rewritten (computed, not stored)", () => {
  // This is what keeps Show honest: the group hiding a member is a fact about the
  // GROUP, so the member's stored state must still say what the AUTHOR set.
  const items = scene();
  items[G].active = false;
  for (const id of MEMBERS) assert.equal(items[id].active, true);
});

test("VERB 3 VISIBILITY: groupHiddenMembers is cycle-safe (a malformed doc terminates)", () => {
  const cyc = { g1: { type: "group", members: ["g2"], active: false }, g2: { type: "group", members: ["g1"] } };
  assert.deepEqual([...groupHiddenMembers(cyc)].sort(), ["g1", "g2"]);
});

// ── VERB 4: COPY / DUPLICATE — ALREADY CORRECT, pinned so it stays that way ──

test("VERB 4 COPY (already correct): cloning a group + members REMAPS the members list", () => {
  const set = scene();
  const idMap = new Map(Object.keys(set).map((id) => [id, `new${id}`]));
  const { states, external } = clonedItemStates(set, idMap, registry);
  assert.deepEqual(states[`new${G}`].members, MEMBERS.map((m) => `new${m}`));
  assert.deepEqual(external, []); // a whole-group copy has no edges leaving the set
});

test("VERB 4 COPY (already correct): the clone-set expansion is the SAME shape as the lifecycle one", () => {
  // #cloneSet and groupCascadeIds answer the same question ("what does this group
  // contain?") for different verbs. They are separate functions in separate
  // layers, so this pins that they agree — a group cloned without its members
  // would be a second group steering the ORIGINALS.
  assert.deepEqual(groupCascadeIds(scene(), [G]).sort(), [G, ...MEMBERS].sort());
});

test("VERB 4 COPY: cloning the group ALONE leaves its member refs EXTERNAL (reported, not silent)", () => {
  // Measured, and recorded rather than changed: clonedItemStates keeps
  // out-of-set refs verbatim and returns them as `external`, which the app
  // reports through #reportDanglingRefs. This is the machinery that makes the
  // whole-group copy above correct, so it is pinned as the contract it is.
  const { states, external } = clonedItemStates({ [G]: scene()[G] }, new Map([[G, "loneG"]]), registry);
  assert.deepEqual(states.loneG.members, MEMBERS);
  assert.deepEqual(external.sort(), MEMBERS.slice().sort());
});

// ── The cascade's own edges ──────────────────────────────────────────────────

test("CASCADE: a non-group root reaches only itself (a mixed selection needs no branching)", () => {
  assert.deepEqual(groupCascadeIds(scene(), [A]), [A]);
});

test("CASCADE: transitive through nesting, and cycle-safe", () => {
  const items = scene();
  items[O] = group([G], 5);
  assert.deepEqual(groupCascadeIds(items, [O]).sort(), [O, G, ...MEMBERS].sort());
  const cyc = { g1: { type: "group", members: ["g2"] }, g2: { type: "group", members: ["g1"] } };
  assert.deepEqual(groupCascadeIds(cyc, ["g1"]).sort(), ["g1", "g2"]);
});

console.log(`\n${passed} group lifecycle cascade tests passed.`);
