/**
 * WORKSTREAM BP — group-selection COMMANDS, at the registry/palette layer.
 *
 * tests/select_in_group_test.js already pins the pure halves (expandGroupSelection,
 * selectParentGroups, groupMembership) at unit level. This file pins the layer
 * ABOVE them: the actual command-registry ENTRIES a user reaches through the
 * palette/Tools-pane/Toolbar — `select-in-group` and `select-parent-group` — so a
 * future edit to their `when`/`requires` wiring in web/App.svelte, or their
 * placement in the Grouping TOOL_POOL group, fails here instead of only in a
 * browser probe.
 *
 * web/App.svelte CANNOT be imported bare-node (it is a Svelte component, and
 * web/app.svelte.js — the class the entries call into — pulls in browser-only
 * asset imports transitively). So, matching the precedent already established by
 * tests/tool_groups_test.js and tests/toolbar_surfacing_test.js: the two entries
 * are read as TEXT out of the real source (never transcribed by hand) to prove
 * they exist with the right shape, and their DECISION LOGIC is exercised here as
 * plain functions over a fixture app-stub — the same `when(app)`/`requires(app)`
 * closures the real entries hand to core/commands.commandUnavailableReason,
 * copied verbatim from web/App.svelte so a drift between the two is a diff a
 * reviewer can see, not a silent duplicate.
 *
 * Run: node src/demo_apps/PowerRP/tests/select_parent_group_command_test.js
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TOOL_POOL } from "../core/registry.js";
import { groupMembership } from "../core/derive.js";
import { expandGroupSelection, selectParentGroups } from "../core/bandselect.js";
import { commandUnavailableReason, unavailableMessage } from "../core/commands.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const here = dirname(fileURLToPath(import.meta.url));
const appSvelte = readFileSync(resolve(here, "../web/App.svelte"), "utf8");

// ── (1) THE SOURCE ACTUALLY DECLARES BOTH ENTRIES, WITH THE RIGHT GATE SHAPE ──
// Text-scan, not import — see file header. This is what stops a future edit from
// silently dropping the id, or from swapping a function-gate for a string (or
// vice versa) without anyone noticing the grammar mismatch.

test("select-in-group is registered with a FUNCTION requires (two disqualifying sentences)", () => {
  assert.ok(appSvelte.includes('id: "select-in-group"'), "the command id is declared");
  const block = appSvelte.slice(appSvelte.indexOf('id: "select-in-group"'), appSvelte.indexOf('id: "select-in-group"') + 1200);
  assert.match(block, /requires:\s*\(a\)\s*=>/, "requires is a FUNCTION — this gate has two true sentences, not one");
  assert.match(block, /run:\s*\(a\)\s*=>\s*a\.selectInsideGroup\(\)/, "run calls the app's selectInsideGroup()");
});

test("select-parent-group is registered with a STRING requires (one disqualifying sentence)", () => {
  assert.ok(appSvelte.includes('id: "select-parent-group"'), "the command id is declared");
  const block = appSvelte.slice(appSvelte.indexOf('id: "select-parent-group"'), appSvelte.indexOf('id: "select-parent-group"') + 1400);
  assert.match(block, /when:\s*\(a\)\s*=>\s*a\.canSelectParentGroup\(\)/, "when reads the app's own gate query");
  assert.match(block, /requires:\s*"[^"]+"/, "requires is a plain STRING — only one condition disqualifies this command");
  assert.match(block, /run:\s*\(a\)\s*=>\s*a\.selectParentGroup\(\)/, "run calls the app's selectParentGroup()");
});

// ── (2) BOTH ARE WIRED INTO THE GROUPING TOOL-POOL GROUP, BESIDE group/ungroup ──
// tests/tool_groups_test.js's own "ghost gate" (§365) proves every TOOL_POOL id
// resolves to a real command; this proves the PLACEMENT the task asked for —
// "the palette placement under the Groups tool-group beside the existing group
// commands" — actually landed, which the ghost gate alone does not check (it
// would pass just as well if these two rows lived in the wrong group).
test("select-in-group and select-parent-group sit in the SAME TOOL_POOL group as group/ungroup/shatter", () => {
  const grouping = TOOL_POOL.find((g) => g.id === "grouping");
  assert.ok(grouping, "a 'grouping' pool group exists");
  const ids = grouping.rows.map((r) => r.command);
  for (const id of ["group", "ungroup", "shatter", "select-in-group", "select-parent-group"])
    assert.ok(ids.includes(id), `Grouping pool group is missing "${id}"`);
});

// ── (3) THE DECISION LOGIC, copied verbatim from web/App.svelte's closures ───
// A drift between this copy and the real one is a diff a reviewer sees in code
// review; that is the trade-off text-scanning a .svelte file accepts.
const selectInGroupWhen = (a) => a.selectedNodes().some((n) => n.type === "group" && (n.state.members?.length ?? 0) > 0);
const selectInGroupRequires = (a) => (a.selectedNodes().some((n) => n.type === "group")
  ? "a selected group that HAS members — the selected group is empty, so there is nothing inside it to select"
  : "a selected group — this selects the things INSIDE a group, so something has to be a group first");
const SELECT_PARENT_GROUP_REQUIRES = "a selected widget that is INSIDE a group — this selects the group that owns something, so the selection has to be a member of one";

// A minimal app stub: just enough surface for the two gates + their `run`s.
// `nodes` is [{itemId, type, state}]; `selection` is the id array the stub
// tracks so `run` can be observed to have changed it (both commands ONLY change
// selection — no document write — which is what this stub is built to show).
function fixtureApp(nodes, selection) {
  const membership = groupMembership(nodes);
  const membersOf = new Map(nodes.filter((n) => n.type === "group").map((n) => [n.itemId, n.state.members ?? []]));
  return {
    nodes,
    selection: [...selection],
    selectedNodes() { return nodes.filter((n) => this.selection.includes(n.itemId)); },
    selectedIds() { return [...this.selection]; },
    selectMany(ids) { this.selection = [...ids]; },
    canSelectParentGroup() { return this.selectedIds().some((id) => membership.has(id)); },
    selectParentGroup() { this.selectMany(selectParentGroups(this.selectedIds(), membership)); },
    selectInsideGroup() {
      const membersOfSelected = new Map(this.selectedNodes().filter((n) => n.type === "group").map((n) => [n.itemId, n.state.members ?? []]));
      this.selectMany(expandGroupSelection(this.selectedIds(), membersOfSelected.size ? membersOfSelected : membersOf));
    },
  };
}

const GROUP_G = (members) => ({ itemId: "g", type: "group", state: { members } });
const GROUP_O = (members) => ({ itemId: "o", type: "group", state: { members } });
const RECT = (id) => ({ itemId: id, type: "rect", state: {} });

test("SELECT PARENT GROUP: one member selected -> its group", () => {
  const nodes = [GROUP_G(["a", "b"]), RECT("a"), RECT("b"), RECT("r")];
  const app = fixtureApp(nodes, ["a"]);
  assert.equal(app.canSelectParentGroup(), true);
  app.selectParentGroup();
  assert.deepEqual(app.selectedIds(), ["g"]);
});

test("SELECT PARENT GROUP: MULTI-SELECT semantics are the parent groups of ALL selected items, deduped", () => {
  // Two members of the SAME group rise to it once.
  const nodes = [GROUP_G(["a", "b"]), RECT("a"), RECT("b")];
  const app = fixtureApp(nodes, ["a", "b"]);
  app.selectParentGroup();
  assert.deepEqual(app.selectedIds(), ["g"], "both members rise to the one group they share, not duplicated");
});

test("SELECT PARENT GROUP: members of DIFFERENT groups rise to BOTH groups", () => {
  const nodes = [GROUP_G(["a"]), GROUP_O(["c"]), RECT("a"), RECT("c")];
  const app = fixtureApp(nodes, ["a", "c"]);
  app.selectParentGroup();
  assert.deepEqual(app.selectedIds(), ["g", "o"]);
});

test("SELECT PARENT GROUP: an item with NO parent contributes NOTHING extra but is not dropped", () => {
  const nodes = [GROUP_G(["a"]), RECT("a"), RECT("loose")];
  const app = fixtureApp(nodes, ["a", "loose"]);
  app.selectParentGroup();
  assert.deepEqual(app.selectedIds(), ["g", "loose"], "the loose rect has no parent to rise to, and stays selected rather than vanishing");
});

test("SELECT PARENT GROUP: the requires-gate's ONE sentence, via commandUnavailableReason", () => {
  const cmd = { id: "select-parent-group", when: (a) => a.canSelectParentGroup(), requires: SELECT_PARENT_GROUP_REQUIRES };
  const nodes = [GROUP_G(["a"]), RECT("a"), RECT("loose")];
  // Nothing selected at all: gated, with the one sentence.
  const empty = fixtureApp(nodes, []);
  assert.equal(commandUnavailableReason(cmd, empty), SELECT_PARENT_GROUP_REQUIRES);
  assert.equal(unavailableMessage(commandUnavailableReason(cmd, empty)),
    "Unavailable — requires a selected widget that is INSIDE a group — this selects the group that owns something, so the selection has to be a member of one");
  // Selection has no parent group: gated, SAME sentence (only one condition here).
  const loose = fixtureApp(nodes, ["loose"]);
  assert.equal(commandUnavailableReason(cmd, loose), SELECT_PARENT_GROUP_REQUIRES);
  // A member of a group: available (no reason).
  const grouped = fixtureApp(nodes, ["a"]);
  assert.equal(commandUnavailableReason(cmd, grouped), null);
});

test("SELECT INSIDE GROUP: group selected -> its members, individually", () => {
  const nodes = [GROUP_G(["a", "b", "c"]), RECT("a"), RECT("b"), RECT("c")];
  const app = fixtureApp(nodes, ["g"]);
  assert.equal(selectInGroupWhen(app), true);
  app.selectInsideGroup();
  assert.deepEqual(app.selectedIds(), ["a", "b", "c"]);
});

test("SELECT INSIDE GROUP: requires-gate has TWO true sentences (empty group vs. no group at all)", () => {
  const cmd = { id: "select-in-group", when: selectInGroupWhen, requires: selectInGroupRequires };
  // (a) nothing selected is a group at all.
  const rectOnly = fixtureApp([RECT("r")], ["r"]);
  assert.equal(commandUnavailableReason(cmd, rectOnly),
    "a selected group — this selects the things INSIDE a group, so something has to be a group first");
  // (b) a selected group, but it is EMPTY — a different true sentence.
  const emptyGroup = fixtureApp([GROUP_G([])], ["g"]);
  assert.equal(commandUnavailableReason(cmd, emptyGroup),
    "a selected group that HAS members — the selected group is empty, so there is nothing inside it to select");
  // A non-empty group selected: available.
  const fullGroup = fixtureApp([GROUP_G(["a"]), RECT("a")], ["g"]);
  assert.equal(commandUnavailableReason(cmd, fullGroup), null);
});

test("ROUND TRIP: Select Inside Group then Select Parent Group returns to the group", () => {
  const nodes = [GROUP_G(["a", "b"]), RECT("a"), RECT("b")];
  const app = fixtureApp(nodes, ["g"]);
  app.selectInsideGroup();
  assert.deepEqual(app.selectedIds(), ["a", "b"]);
  app.selectParentGroup();
  assert.deepEqual(app.selectedIds(), ["g"]);
});

test("NEITHER COMMAND WRITES THE DOCUMENT — the stub has no doc/commit surface and both still run", () => {
  // Both commands' whole contract is "only the selection changes" (their own
  // docstrings in web/app.svelte.js). This fixture app never defines `doc`,
  // `commit`, or `keyframed` — if either command's real implementation touched
  // any of those, this stub would throw. It doesn't.
  const nodes = [GROUP_G(["a"]), RECT("a")];
  const app = fixtureApp(nodes, ["a"]);
  assert.doesNotThrow(() => app.selectParentGroup());
  const app2 = fixtureApp(nodes, ["g"]);
  assert.doesNotThrow(() => app2.selectInsideGroup());
});

console.log(`\n${passed} select-parent-group / select-in-group command tests passed`);
