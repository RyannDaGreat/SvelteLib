/**
 * MULTI-SELECTION PROPERTY INTERSECTION — core tests, plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/multiselect_test.js
 *
 * Two halves, deliberately:
 *   SYNTHETIC — the identity relation, mixed-value semantics and the unify write
 *     against hand-built row/state pairs, so each rule is pinned in isolation.
 *   REAL REGISTRY — the same functions against the ACTUAL registered plugins, so
 *     the intersection is proved on the widgets the user really selects (the
 *     user's own example: an arrow, a box and a video sharing `opacity`) rather
 *     than on stubs that could agree with a wrong implementation.
 *
 * Plus THE DRIFT GATE (manifest "a reference cannot drift from itself"): an
 * intersected row must be the plugin's OWN row object by IDENTITY, so the day
 * someone starts synthesizing rows here, this fails.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { LIST_ROW_KIND } from "../core/lists.js";
import { ROW_KINDS } from "../core/properties.js";
import {
  MIXED_MARK,
  PRESENTATIONAL_ROW_ASPECTS,
  JOINT_EDITABLE_KINDS,
  JOINT_UNEDITABLE_KINDS,
  PAINT_JOINT_EDIT_PENDING,
  rowContract,
  sameRowContract,
  contractDifferences,
  jointEditProblem,
  intersectRows,
  defaultedValue,
  rowMixedState,
  multiSelectPanel,
  unifyPairs,
  keyframeTriState,
} from "../core/multiselect.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

/** Test helper. One `entries` element from a REAL registered plugin type. */
function entry(itemId, type, state) {
  return { itemId, plugin: registry.get(type), state };
}

// ── THE ROW-IDENTITY RELATION ────────────────────────────────────────────────

test("rowContract strips exactly the presentational aspects, keeps the rest", () => {
  const row = { key: "opacity", kind: "number", min: 0, max: 1, step: 0.01, label: "Opacity", help: "h", category: "formatting" };
  assert.deepEqual(rowContract(row), { key: "opacity", kind: "number", min: 0, max: 1 });
  // Every declared presentational aspect really is dropped...
  const all = Object.fromEntries(PRESENTATIONAL_ROW_ASPECTS.map((a) => [a, "x"]));
  assert.deepEqual(rowContract({ key: "k", ...all }), { key: "k" });
  // ...and an aspect NOT on the denylist is kept (the fail-safe polarity: a new
  // aspect defaults to CONTRACT, so it can only ever over-exclude, never
  // silently unify two rows that disagree about it).
  assert.deepEqual(rowContract({ key: "k", someFutureAspect: 7 }), { key: "k", someFutureAspect: 7 });
});

test("same row + presentational differences only = THE SAME ROW", () => {
  // A rect's X carries `help`; the magnifier's does not. Same property.
  assert.equal(sameRowContract(
    { key: "x", kind: "number", label: "X", help: "Horizontal position…", category: "positioning" },
    { key: "x", kind: "number", label: "X", category: "positioning" }
  ), true);
  // A magnifier calls `stroke` "Rim color" and files it under "lens".
  assert.equal(sameRowContract(
    { key: "stroke", kind: "color", paint: true, label: "Stroke", category: "formatting" },
    { key: "stroke", kind: "color", paint: true, label: "Rim color", category: "lens" }
  ), true);
  assert.deepEqual(contractDifferences(
    { key: "x", kind: "number", label: "X" },
    { key: "x", kind: "number", label: "Ex", help: "…" }
  ), []);
});

test("a contract difference makes two rows DIFFERENT properties", () => {
  // A select with different OPTIONS (the briefing's case): magnifier `shape` is
  // circle/box, the shape widget's is 20 preset silhouettes.
  assert.equal(sameRowContract(
    { key: "shape", kind: "select", options: ["star", "heart"] },
    { key: "shape", kind: "select", options: ["circle", "box"] }
  ), false);
  assert.deepEqual(contractDifferences(
    { key: "shape", kind: "select", options: ["star"] },
    { key: "shape", kind: "select", options: ["circle"] }
  ), ["options"]);
  // Different KIND under one key: metaball's `ambient` is a number, skyClouds'
  // is a colour. Key-only identity would unify a number into a colour slot.
  assert.equal(sameRowContract({ key: "ambient", kind: "number" }, { key: "ambient", kind: "color" }), false);
  // Different BOUNDS: rect cornerRadius is a length, ss_polygonStar's a 0..0.5
  // fraction. Writing 12 to both is meaningless for one of them.
  assert.deepEqual(contractDifferences(
    { key: "cornerRadius", kind: "number", min: 0 },
    { key: "cornerRadius", kind: "number", min: 0, max: 0.5 }
  ), ["max"]);
  // Different UNIT: `display` bridges storage→shown, so one row storing radians
  // and one storing degrees would take a typed "45" to mean two different angles.
  assert.equal(sameRowContract(
    { key: "a", kind: "angle", display: "degrees" },
    { key: "a", kind: "angle" }
  ), false);
  // Different asset acceptance: image `src` vs video `src`.
  assert.deepEqual(contractDifferences(
    { key: "src", kind: "asset", assetKinds: ["image"] },
    { key: "src", kind: "asset", assetKinds: ["video"] }
  ), ["assetKinds"]);
});

test("a FUNCTION aspect (dynamic max) compares by reference", () => {
  const cap = (state) => state.pageCount;
  assert.equal(sameRowContract({ key: "page", kind: "number", max: cap }, { key: "page", kind: "number", max: cap }), true);
  assert.equal(sameRowContract(
    { key: "page", kind: "number", max: cap },
    { key: "page", kind: "number", max: (state) => state.pageCount }
  ), false, "two distinct closures may compute anything — reference identity is the only honest answer");
});

// ── THE INTERSECTION ─────────────────────────────────────────────────────────

test("empty selection intersects to nothing (no crash, no rows)", () => {
  assert.deepEqual(intersectRows([]), { rows: [], conflicts: [] });
  assert.deepEqual(multiSelectPanel([]), { rows: [], conflicts: [], skipped: [], itemIds: [] });
});

test("ONE-ITEM selection degrades to that plugin's rows EXACTLY, by identity", () => {
  const rect = registry.get("rect");
  const { rows, conflicts } = intersectRows([entry("r", "rect", {})]);
  assert.deepEqual(conflicts, []);
  assert.equal(rows.length, rect.inspector.length, "a lone selection loses no row");
  rows.forEach((row, i) => assert.equal(row, rect.inspector[i], "the SAME object, not a copy"));
});

test("THE DRIFT GATE: an intersected row is the plugin's OWN row object", () => {
  // manifest: "a reference cannot drift from itself; a lookup needs a table that
  // can be missing". If a future refactor starts BUILDING rows here, this fails.
  const primary = registry.get("rect");
  const { rows } = intersectRows([entry("r", "rect", {}), entry("v", "video", {})]);
  assert.ok(rows.length > 0, "rect + video must share something to make this meaningful");
  for (const row of rows)
    assert.ok(primary.inspector.includes(row), `row "${row.key}" is not the primary plugin's own object`);
});

test("REAL heterogeneous case — the user's own example: arrow + box + video", () => {
  const { rows, conflicts } = intersectRows([
    entry("a", "arrow", {}), entry("r", "rect", {}), entry("v", "video", {}),
  ]);
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes("opacity"), "opacity is THE motivating property and must be shared");
  assert.ok(keys.includes("z"), "z order is shared");
  // The whole universal effects bundle rides along, because core/registry.js
  // injects it from ONE core/properties.js declaration — so a rich intersection
  // is a CONSEQUENCE of the shared property registry, not a coincidence.
  for (const key of ["shadow.dx", "shadow.blur", "shadow.color", "bloom.strength", "blendMode", "innerShadow.dx", "softEdges"])
    assert.ok(keys.includes(key), `effects row "${key}" should be shared`);
  // An arrow has from/to, not a box — so the box frame must NOT appear.
  for (const key of ["x", "y", "w", "h"])
    assert.ok(!keys.includes(key), `"${key}" is not shared with an arrow (it has from/to)`);
  assert.deepEqual(conflicts, [], "none of these declare one key with two contracts");
});

test("REAL homogeneous case — rect + circle shares the full common surface", () => {
  const keys = intersectRows([entry("a", "rect", {}), entry("b", "circle", {})]).rows.map((r) => r.key);
  for (const key of ["x", "y", "w", "h", "rotation", "z", "fill", "stroke", "strokeWidth", "opacity"])
    assert.ok(keys.includes(key), `"${key}" should be shared by two boxes`);
});

test("REAL row-kind conflict is REPORTED, not silently dropped", () => {
  // Both the shape widget and the magnifier declare `shape`, with different
  // option sets — the exact "same key, different property" case.
  const { rows, conflicts } = intersectRows([entry("s", "shape", {}), entry("m", "magnifier", {})]);
  assert.ok(!rows.some((r) => r.key === "shape"), "the two `shape` selects must not unify");
  const reported = conflicts.find((c) => c.key === "shape");
  assert.ok(reported, "an excluded row present on BOTH items must be reported by key");
  assert.ok(reported.aspects.includes("options"), `the report names the differing aspect: ${JSON.stringify(reported.aspects)}`);
});

test("a key merely ABSENT on some item is not shared and not a conflict", () => {
  // `fill` exists on rect, not on video. That is not a conflict — reporting every
  // unshared property would bury the real conflicts.
  const { rows, conflicts } = intersectRows([entry("r", "rect", {}), entry("v", "video", {})]);
  assert.ok(!rows.some((r) => r.key === "fill"));
  assert.ok(!conflicts.some((c) => c.key === "fill"), "absent-on-one is not a conflict");
});

test("THE CAMERA participates and honestly thins the intersection", () => {
  // Included on purpose (core/registry.js `keyframable` reasoning): excluding it
  // would make "select all, set X" skip an item in silence. It declares no
  // opacity row and takes no effects bundle, so the intersection is genuinely
  // small — that is the feature working.
  const keys = intersectRows([entry("c", "camera", {}), entry("r", "rect", {})]).rows.map((r) => r.key);
  assert.deepEqual(keys, ["x", "y", "w", "h"]);
});

test("intersection is ORDER-STABLE and follows the PRIMARY's row order", () => {
  const primaryFirst = intersectRows([entry("r", "rect", {}), entry("c", "circle", {})]).rows.map((r) => r.key);
  const rectOrder = registry.get("rect").inspector.map((r) => r.key).filter((k) => primaryFirst.includes(k));
  assert.deepEqual(primaryFirst, rectOrder, "rows keep the primary plugin's declared order");
});

// ── MIXED-VALUE SEMANTICS ────────────────────────────────────────────────────

test("all-same reads as agreed; any difference reads as MIXED", () => {
  const same = [entry("a", "rect", { opacity: 0.5 }), entry("b", "circle", { opacity: 0.5 })];
  assert.deepEqual(rowMixedState(same, "opacity"), { mixed: false, value: 0.5, seed: 0.5 });
  const differ = [entry("a", "rect", { opacity: 1 }), entry("b", "circle", { opacity: 0.2 })];
  assert.deepEqual(rowMixedState(differ, "opacity"), { mixed: true, value: undefined, seed: 1 });
});

test("EQUATION vs LITERAL is MIXED even when the equation would evaluate equal", () => {
  const entries = [entry("a", "rect", { opacity: 1 }), entry("b", "circle", { opacity: "=1" })];
  const got = rowMixedState(entries, "opacity");
  assert.equal(got.mixed, true, "a stored equation is not the literal it evaluates to");
  assert.equal(got.seed, 1);
  // ...and two items holding the SAME equation are NOT mixed.
  const bound = [entry("a", "rect", { opacity: "=cam.opacity" }), entry("b", "circle", { opacity: "=cam.opacity" })];
  assert.deepEqual(rowMixedState(bound, "opacity"), { mixed: false, value: "=cam.opacity", seed: "=cam.opacity" });
});

test("ABSENT means the plugin DEFAULT, so it does not read as mixed (the sameStyle rule)", () => {
  const rect = registry.get("rect");
  assert.equal(rect.defaults.opacity, 1, "precondition: rect defaults opacity to 1");
  assert.equal(defaultedValue(entry("a", "rect", {}), ["opacity"]), 1);
  const entries = [entry("a", "rect", {}), entry("b", "rect", { opacity: 1 })];
  assert.equal(rowMixedState(entries, "opacity").mixed, false,
    "a rect that never had opacity written must not read as differing from one storing an explicit 1");
});

test("mixed detection handles DOTTED (nested) keys and structural values", () => {
  const same = [entry("a", "rect", { shadow: { dx: 4 } }), entry("b", "circle", { shadow: { dx: 4 } })];
  assert.equal(rowMixedState(same, "shadow.dx").mixed, false);
  const differ = [entry("a", "rect", { shadow: { dx: 4 } }), entry("b", "circle", { shadow: { dx: 5 } })];
  assert.equal(rowMixedState(differ, "shadow.dx").mixed, true);
  // A structural (gradient paint) value compares deeply, not by identity.
  const paintA = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }] };
  const paintB = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }] };
  assert.equal(rowMixedState([entry("a", "rect", { fill: paintA }), entry("b", "circle", { fill: paintB })], "fill").mixed,
    false, "equal-by-structure paints are the same value");
});

test("comparison is EXACT — no epsilon (a near-miss really is mixed)", () => {
  const entries = [entry("a", "rect", { opacity: 0.5 }), entry("b", "circle", { opacity: 0.5000001 })];
  assert.equal(rowMixedState(entries, "opacity").mixed, true,
    "an epsilon would show one unified number while the document held two");
});

test("MIXED_MARK is one character, so it cannot read as a typed literal", () => {
  assert.equal(MIXED_MARK.length, 1);
  assert.equal(MIXED_MARK, "…");
  assert.equal(Number.isNaN(Number(MIXED_MARK)), true, "it must never parse as a number");
});

// ── JOINT-EDIT CLASSIFICATION ────────────────────────────────────────────────

test("every ROW_KIND is classified, exactly once (the import gate proved live)", () => {
  const classified = [...JOINT_EDITABLE_KINDS, ...Object.keys(JOINT_UNEDITABLE_KINDS)];
  assert.deepEqual([...classified].sort(), [...ROW_KINDS].sort());
  assert.equal(new Set(classified).size, classified.length, "no kind classified twice");
});

test("an uneditable kind is LISTED with a reason, never hidden", () => {
  assert.equal(jointEditProblem({ key: "opacity", kind: "number" }), null);
  assert.equal(jointEditProblem({ key: "points", kind: LIST_ROW_KIND }), JOINT_UNEDITABLE_KINDS[LIST_ROW_KIND]);
  assert.equal(jointEditProblem({ key: "fill", kind: "color", paint: true }), PAINT_JOINT_EDIT_PENDING);
  // A plain (non-paint) colour row IS jointly editable.
  assert.equal(jointEditProblem({ key: "shadow.color", kind: "color" }), null);
  // Two REAL polygons share `points`, and the panel keeps the row + the reason —
  // the "grayed, not clickable, never omitted" rule for a row it cannot drive.
  const shared = multiSelectPanel([entry("p", "polygon", {}), entry("q", "polygon", {})]);
  const points = shared.rows.find((r) => r.row.key === "points");
  assert.ok(points, "a shared list row is still LISTED");
  assert.equal(points.problem, JOINT_UNEDITABLE_KINDS[LIST_ROW_KIND], "…and explains itself");
});

// ── THE PANEL + THE WRITE ────────────────────────────────────────────────────

test("panel skips items not on this slide, and SAYS SO", () => {
  const panel = multiSelectPanel([
    entry("r", "rect", { opacity: 1 }),
    { itemId: "ghost", plugin: registry.get("video"), state: null },
  ]);
  assert.deepEqual(panel.skipped, ["ghost"], "reported, never silently edited");
  assert.deepEqual(panel.itemIds, ["r"]);
  // The intersection is over the LIVE items only — so it is rect's own rows.
  assert.equal(panel.rows.length, registry.get("rect").inspector.length);
});

test("unifyPairs writes ONE key on EVERY item — the whole joint write", () => {
  const entries = [entry("a", "arrow", { opacity: 1 }), entry("r", "rect", { opacity: 0.2 }), entry("v", "video", { opacity: 0.7 })];
  assert.deepEqual(unifyPairs(entries, "opacity", 0.5), [
    [["items", "a", "opacity"], 0.5],
    [["items", "r", "opacity"], 0.5],
    [["items", "v", "opacity"], 0.5],
  ]);
});

test("MINIMAL DELTA: an item already holding the value is not rewritten", () => {
  const entries = [entry("a", "rect", { opacity: 0.5 }), entry("b", "circle", { opacity: 0.2 })];
  assert.deepEqual(unifyPairs(entries, "opacity", 0.5), [[["items", "b", "opacity"], 0.5]]);
  // Every item already holds it → NOTHING to write, so the caller must not
  // commit (an empty commit would still push an undo entry).
  assert.deepEqual(unifyPairs([entry("a", "rect", { opacity: 0.5 })], "opacity", 0.5), []);
  // Absent-means-default counts as already holding it.
  assert.deepEqual(unifyPairs([entry("a", "rect", {})], "opacity", 1), []);
});

test("unify touches ONLY the edited key — an equation on another axis survives", () => {
  const entries = [entry("a", "rect", { x: "=cam.x + 10", y: 5, opacity: 1 }), entry("b", "circle", { x: 0, opacity: 0.3 })];
  const pairs = unifyPairs(entries, "opacity", 0.5);
  const touched = pairs.map(([path]) => path[path.length - 1]);
  assert.deepEqual([...new Set(touched)], ["opacity"], "no other property is collateral");
  assert.equal(entries[0].state.x, "=cam.x + 10", "the pure function mutated nothing");
});

test("unifying TO an equation works, and REPLACES a literal", () => {
  const entries = [entry("a", "rect", { opacity: 1 }), entry("b", "circle", { opacity: 0.2 })];
  assert.deepEqual(unifyPairs(entries, "opacity", "=cam.opacity"), [
    [["items", "a", "opacity"], "=cam.opacity"],
    [["items", "b", "opacity"], "=cam.opacity"],
  ]);
});

test("unifying a DOTTED key writes the nested path", () => {
  assert.deepEqual(unifyPairs([entry("a", "rect", { shadow: { dx: 0 } })], "shadow.dx", 8),
    [[["items", "a", "shadow", "dx"], 8]]);
});

test("keyframe diamond tri-state: FILLED / HALF-FILLED / HOLLOW", () => {
  assert.equal(keyframeTriState([true, true, true]), "all");
  assert.equal(keyframeTriState([true, false, true]), "some");
  assert.equal(keyframeTriState([false, false]), "none");
  assert.equal(keyframeTriState([true]), "all");
  assert.equal(keyframeTriState([]), "none", "nothing selected keys nothing");
});

// ── THE WHOLE FLOW, on real plugins ──────────────────────────────────────────

test("END TO END: mixed opacity on arrow + rect + video unifies in one write", () => {
  const entries = [entry("a", "arrow", { opacity: 1 }), entry("r", "rect", { opacity: 0.2 }), entry("v", "video", { opacity: 0.7 })];
  const panel = multiSelectPanel(entries);
  const row = panel.rows.find((r) => r.row.key === "opacity");
  assert.ok(row, "opacity is in the intersection");
  assert.equal(row.mixed, true);
  assert.equal(row.value, undefined, "a mixed row has no single value to show");
  assert.equal(row.seed, 1, "the seed is the PRIMARY's value");
  assert.equal(row.problem, null, "a number row is jointly editable");
  // Unify to the seed → the primary is skipped, the other two are written.
  const pairs = unifyPairs(entries, "opacity", row.seed);
  assert.equal(pairs.length, 2);
  // ...and after that write every item agrees, so the row is no longer mixed.
  const after = entries.map((e) => ({ ...e, state: { ...e.state, opacity: row.seed } }));
  assert.equal(rowMixedState(after, "opacity").mixed, false);
  assert.deepEqual(unifyPairs(after, "opacity", row.seed), [], "and there is nothing left to write");
});

console.log(`\n  ${passed} multiselect core tests passed`);
