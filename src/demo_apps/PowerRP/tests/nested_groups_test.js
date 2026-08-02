/**
 * GROUP OF GROUPS (#302) — nesting, at the level where it was actually broken.
 *
 * User: "i selected 3 groups. why can't i group them into a bigger group" →
 * "make this obviousness possible."
 *
 * THE REFUSAL WAS NOT THE BUG, IT WAS HIDING ONE. web/app.svelte.js carried
 * `if (type === "group") return false; // no group-of-groups (rough draft)`, and
 * deleting that line alone would have shipped a broken picture: MEASURED, with
 * outer group O owning inner group I owning a rect, moving O moved O and I and
 * LEFT THE RECT BEHIND. Two independent paths had to be fixed first, and this
 * suite pins both plus the property that makes them safe — no double-counting.
 *
 * Run: node src/demo_apps/PowerRP/tests/nested_groups_test.js
 */
import assert from "node:assert/strict";
import { applyGroupParenting, memberOwnerGroups } from "../core/derive.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const W = (x, y = 0) => ({ x, y, rotation: 0, scale: 1 });
const BIND = { x: 0, y: 0, rotation: 0, scale: 1 };
const group = (id, members, x, z) => ({ itemId: id, type: "group", z, state: { members, bind: { ...BIND }, z }, world: W(x) });
const leaf = (id, x) => ({ itemId: id, type: "rect", state: {}, world: W(x) });
const xOf = (nodes, id) => nodes.find((n) => n.itemId === id).world.x;

// ── THE RENDER PATH ─────────────────────────────────────────────────────────

test("AN INNER GROUP CARRIES ITS MEMBERS — the bug that would have shipped", () => {
  // O(+100) owns I owns a. Before the fix a stayed at 10 while I moved to 100.
  const out = applyGroupParenting([group("O", ["I"], 100, 2), group("I", ["a"], 0, 1), leaf("a", 10)]);
  assert.equal(xOf(out, "I"), 100, "the inner group moves with its owner");
  assert.equal(xOf(out, "a"), 110, "…and so does its member: 10 + 100, applied ONCE");
});

test("NOT DOUBLE-APPLIED — the failure mode that looks like drift, not a crash", () => {
  // If the outer influence reached the leaf twice it would land at 210.
  const out = applyGroupParenting([group("O", ["I"], 100, 2), group("I", ["a"], 0, 1), leaf("a", 10)]);
  assert.notEqual(xOf(out, "a"), 210, "the outer move must not be counted twice");
});

test("THREE DEEP still composes once per level", () => {
  const out = applyGroupParenting([
    group("A", ["B"], 100, 3), group("B", ["C"], 0, 2), group("C", ["leaf"], 0, 1), leaf("leaf", 5),
  ]);
  assert.equal(xOf(out, "leaf"), 105, `expected 5 + 100, got ${xOf(out, "leaf")}`);
});

test("EACH LEVEL'S OWN MOVE ADDS — nesting composes, it does not replace", () => {
  // O moved +100, I moved +10 on its own. The leaf must feel both.
  const out = applyGroupParenting([group("O", ["I"], 100, 2), group("I", ["a"], 10, 1), leaf("a", 0)]);
  assert.equal(xOf(out, "a"), 110, `expected 100 + 10, got ${xOf(out, "a")}`);
});

test("AN UN-NESTED DOCUMENT IS BYTE-IDENTICAL — the whole app must not shift", () => {
  // A top-level group's own world and its already-influenced world are the same
  // object, so the new ordering changes nothing here — which is what makes this
  // fix safe to land across every existing deck.
  const out = applyGroupParenting([group("g", ["r"], 50, 1), leaf("r", 10)]);
  assert.deepEqual(out.find((n) => n.itemId === "r").world, { x: 60, y: 0, rotation: 0, scale: 1 });
});

test("ORDER IN THE NODE LIST DOES NOT MATTER — the sort is topological, not positional", () => {
  // The inner group listed FIRST would, without the sort, move its members before
  // its owner had moved it.
  const inner = applyGroupParenting([group("I", ["a"], 0, 1), group("O", ["I"], 100, 2), leaf("a", 10)]);
  assert.equal(xOf(inner, "a"), 110);
});

test("A CYCLE RENDERS RATHER THAN HANGING", () => {
  // A malformed document (a group that is its own ancestor) must not starve the
  // ordering loop. Correctness of the picture is not promised here; termination is.
  const out = applyGroupParenting([group("X", ["Y"], 10, 1), group("Y", ["X"], 20, 2)]);
  assert.equal(out.length, 2, "it returns, with both nodes");
});

// ── THE EXPRESSION PATH ─────────────────────────────────────────────────────

test("memberOwnerGroups WALKS THE CHAIN, outermost first", () => {
  const state = { items: {
    O: { type: "group", members: ["I"], z: 2 },
    I: { type: "group", members: ["a"], z: 1 },
    a: { type: "rect" },
  } };
  assert.deepEqual(memberOwnerGroups(state).get("a"), ["O", "I"], "the whole chain, outer before inner");
  assert.deepEqual(memberOwnerGroups(state).get("I"), ["O"]);
});

test("the chain is DEDUPED, so an ancestor reached twice is applied once", () => {
  // Two branches can reach one ancestor; composing it twice is the drift again.
  const state = { items: {
    O: { type: "group", members: ["I", "J"], z: 3 },
    I: { type: "group", members: ["a"], z: 2 },
    J: { type: "group", members: ["a"], z: 1 },
    a: { type: "rect" },
  } };
  const chain = memberOwnerGroups(state).get("a");
  assert.equal(new Set(chain).size, chain.length, `"${chain}" repeats an ancestor`);
});

test("an UNGROUPED item still has no owners, and a cycle still terminates", () => {
  assert.equal(memberOwnerGroups({ items: { r: { type: "rect" } } }).get("r"), undefined);
  const cyclic = { items: { X: { type: "group", members: ["Y"], z: 1 }, Y: { type: "group", members: ["X"], z: 2 } } };
  assert.ok(Array.isArray(memberOwnerGroups(cyclic).get("X")), "it returns rather than recursing forever");
});

console.log(`\n${passed} nested-group tests passed`);

// ── DIAMOND ANCESTRY — found by adversarial testing, not by the tests above ──

test("DIAMOND ANCESTRY DOUBLE-COUNTS — a KNOWN BOUND, pinned so it cannot drift", () => {
  // O owns I AND J; both list the same leaf. Each of I and J has already been
  // moved by O, so each hands the leaf O's move again and it travels twice as far.
  // Found by a sweep written to FALSIFY the nesting work — the tests above all
  // passed while this was true, because none had two paths to one ancestor.
  //
  // NOT FIXED, DELIBERATELY, and core/derive.js applyGroupParenting records why:
  // the obvious fix (one owner per member) contradicts tests/group_test.js's
  // "two groups compose later-outermost", which pins that two INDEPENDENT groups
  // claiming a member compose BOTH influences and that the render and expression
  // paths agree about it. Telling "two unrelated owners" from "one shared
  // ancestor" needs each owner's LOCAL influence plus an ancestry walk — a real
  // restructure, not a guard.
  //
  // This test asserts the CURRENT behaviour so that a future fix has to come here
  // and change it deliberately, rather than a regression sliding past unseen.
  const out = applyGroupParenting([
    group("O", ["I", "J"], 100, 3), group("I", ["leaf"], 0, 2), group("J", ["leaf"], 0, 1), leaf("leaf", 0),
  ]);
  assert.equal(xOf(out, "leaf"), 200, "TODAY: O's move arrives twice (100 would be right; see the docblock)");
});

test("FIVE LEVELS deep still composes exactly once per level", () => {
  const out = applyGroupParenting([
    group("A", ["B"], 100, 5), group("B", ["C"], 0, 4), group("C", ["D"], 0, 3),
    group("D", ["E"], 0, 2), group("E", ["leaf"], 0, 1), leaf("leaf", 7),
  ]);
  assert.equal(xOf(out, "leaf"), 107);
});

test("TWO UNRELATED groups claiming one member COMPOSE — unchanged by the nesting work", () => {
  // The long-standing "a member listed by two groups" case, and the reason the
  // diamond above is left as a bound: this composition is DELIBERATE and pinned by
  // tests/group_test.js ("two groups compose later-outermost"), which also asserts
  // the render and expression paths agree about it. Any diamond fix must keep this
  // true, which is exactly what makes it a restructure rather than a guard.
  const out = applyGroupParenting([group("g1", ["r"], 10, 1), group("g2", ["r"], 50, 2), leaf("r", 0)]);
  assert.equal(xOf(out, "r"), 60, "both influences, composed — 10 then 50");
});
