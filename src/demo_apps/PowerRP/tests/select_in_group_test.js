/**
 * SELECT INSIDE GROUP — the non-destructive way down into a group.
 *
 * User, 2026-08-02: "we need to select in group that will select all objects
 * that are in a group individually."
 *
 * The distinction this suite exists to protect is the one between this and its
 * neighbour Ungroup: Ungroup DISSOLVES the group and bakes its box into the
 * members; this touches the document not at all and only changes what is
 * selected. Everything below is about `expandGroupSelection`, the pure half in
 * core/bandselect.js, plus the invariant it shares with its inverse.
 *
 * Run: node src/demo_apps/PowerRP/tests/select_in_group_test.js
 */
import assert from "node:assert/strict";
import { expandGroupSelection, selectParentGroups, dedupeGroupSelection } from "../core/bandselect.js";
import { groupMembership } from "../core/derive.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

test("a selected group becomes its members, individually", () => {
  assert.deepEqual(expandGroupSelection(["g"], new Map([["g", ["a", "b", "c"]]])), ["a", "b", "c"]);
});

test("NON-GROUPS PASS THROUGH — a mixed selection expands only its groups", () => {
  const membersOf = new Map([["g", ["a", "b"]]]);
  assert.deepEqual(expandGroupSelection(["rect1", "g", "rect2"], membersOf), ["rect1", "a", "b", "rect2"],
    "order is preserved, and the two loose rects are untouched");
});

test("TWO groups both expand, in order", () => {
  const membersOf = new Map([["g1", ["a", "b"]], ["g2", ["c"]]]);
  assert.deepEqual(expandGroupSelection(["g1", "g2"], membersOf), ["a", "b", "c"]);
});

test("no duplicate when a member was ALREADY in the selection beside its group", () => {
  // A mixed gesture can produce this (band-catch a group, shift-add one member).
  assert.deepEqual(expandGroupSelection(["g", "a"], new Map([["g", ["a", "b"]]])), ["a", "b"]);
});

test("an EMPTY group expands to nothing rather than to itself", () => {
  // The command's `when` gate refuses this case before it can run, so this pins
  // the pure function's own honesty rather than a reachable UI state: an empty
  // group must not silently fall back to selecting the group it just opened.
  assert.deepEqual(expandGroupSelection(["g"], new Map([["g", []]])), []);
});

test("nothing to expand is a no-op, not an error", () => {
  assert.deepEqual(expandGroupSelection(["r1", "r2"], new Map()), ["r1", "r2"]);
  assert.deepEqual(expandGroupSelection([], new Map([["g", ["a"]]])), []);
});

test("ONE LEVEL: a member that is itself a group is NOT opened", () => {
  // Deliberate — see the docblock. Running it again is how you go deeper, and
  // this pins that the first call stops at the inner group rather than
  // flattening a depth nothing else in the system has agreed on.
  const membersOf = new Map([["outer", ["inner", "r"]], ["inner", ["a", "b"]]]);
  const once = expandGroupSelection(["outer"], membersOf);
  assert.deepEqual(once, ["inner", "r"], "one call reaches the inner GROUP, not its members");
  assert.deepEqual(expandGroupSelection(once, membersOf), ["a", "b", "r"], "a second call opens it");
});

test("THE ROUND-12B INVARIANT SURVIVES: the output never holds a group beside its own member", () => {
  // The rule is that a group and its members are never both selected. Expansion
  // REPLACES the group rather than adding to it, so the invariant holds by
  // construction — proven here by running the real enforcement pass over the
  // output and asserting it changes nothing.
  const nodes = [
    { itemId: "g", type: "group", state: { members: ["a", "b"] } },
    { itemId: "a", type: "rect", state: {} },
    { itemId: "b", type: "rect", state: {} },
    { itemId: "r", type: "rect", state: {} },
  ];
  const membersOf = new Map([["g", ["a", "b"]]]);
  const expanded = expandGroupSelection(["g", "r"], membersOf);
  assert.deepEqual(expanded, ["a", "b", "r"]);
  assert.deepEqual(dedupeGroupSelection(expanded, groupMembership(nodes)), expanded,
    "selectMany's enforcement pass is a no-op on this output — nothing to fix, because nothing was violated");
});

test("IT IS THE INVERSE of dedupeGroupSelection, on the case both define", () => {
  const nodes = [{ itemId: "g", type: "group", state: { members: ["a", "b"] } }];
  const membership = groupMembership(nodes);
  const membersOf = new Map([["g", ["a", "b"]]]);
  // Collapse says "the group is the handle"; expand says "the members are".
  assert.deepEqual(dedupeGroupSelection(["g", "a", "b"], membership), ["g"]);
  assert.deepEqual(expandGroupSelection(["g"], membersOf), ["a", "b"]);
});

// ── THE INVERSE TOOL: SELECT PARENT GROUP ───────────────────────────────────
// User: "'select parent group' should be a tool as well. It only applies if it's
// a child of a group."

test("UP: a selected member becomes the group that owns it", () => {
  assert.deepEqual(selectParentGroups(["a"], new Map([["a", "g"]])), ["g"]);
});

test("UP: two members of the SAME group rise to it ONCE, not twice", () => {
  assert.deepEqual(selectParentGroups(["a", "b"], new Map([["a", "g"], ["b", "g"]])), ["g"]);
});

test("UP: members of DIFFERENT groups rise to both, in order", () => {
  const m = new Map([["a", "g1"], ["c", "g2"]]);
  assert.deepEqual(selectParentGroups(["a", "c"], m), ["g1", "g2"]);
});

test("UP: an item with NO parent stays selected rather than being dropped", () => {
  // Dropping it would silently shrink a mixed selection.
  assert.deepEqual(selectParentGroups(["a", "loose"], new Map([["a", "g"]])), ["g", "loose"]);
  assert.deepEqual(selectParentGroups(["loose"], new Map()), ["loose"]);
});

test("UP: a group ALREADY selected beside its own member collapses to just the group", () => {
  // Which is exactly what dedupeGroupSelection would do to the same input — the
  // two agree instead of fighting, so selectMany's pass finds nothing to fix.
  const m = new Map([["a", "g"]]);
  assert.deepEqual(selectParentGroups(["g", "a"], m), ["g"]);
});

test("DOWN then UP is a ROUND TRIP back to the group", () => {
  const nodes = [{ itemId: "g", type: "group", state: { members: ["a", "b"] } }];
  const membersOf = new Map([["g", ["a", "b"]]]);
  const down = expandGroupSelection(["g"], membersOf);
  assert.deepEqual(down, ["a", "b"]);
  assert.deepEqual(selectParentGroups(down, groupMembership(nodes)), ["g"], "and back up again");
});

test("UP: the ROUND-12B invariant holds on the output", () => {
  const nodes = [
    { itemId: "g", type: "group", state: { members: ["a", "b"] } },
    { itemId: "a", type: "rect", state: {} },
    { itemId: "r", type: "rect", state: {} },
  ];
  const membership = groupMembership(nodes);
  const up = selectParentGroups(["a", "r"], membership);
  assert.deepEqual(dedupeGroupSelection(up, membership), up, "enforcement is a no-op — nothing was violated");
});

console.log(`\n${passed} select-in-group tests passed`);
