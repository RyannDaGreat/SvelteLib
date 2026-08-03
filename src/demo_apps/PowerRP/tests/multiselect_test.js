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
  universalRowsWithInterp,
  UNIVERSAL_TYPE_ROW_PROBLEM,
} from "../core/multiselect.js";
import { MORPH_KEY } from "../core/morph_property.js";

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
    { key: "x", kind: "number", label: "X", help: "Horizontal position…", category: "transform" },
    { key: "x", kind: "number", label: "X", category: "transform" }
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
  // `mode` joined the panel object when the intersection/union toggle landed —
  // the panel now reports which of the two it was built under, so the renderer
  // does not have to ask the app a second time and disagree with what it drew.
  assert.deepEqual(multiSelectPanel([]), { rows: [], conflicts: [], skipped: [], mode: "intersection", itemIds: [] });
});

test("ONE-ITEM selection degrades to that plugin's rows EXACTLY, by identity", () => {
  const rect = registry.get("rect");
  const { rows, conflicts } = intersectRows([entry("r", "rect", {})]);
  assert.deepEqual(conflicts, []);
  // THE UNIVERSAL ROWS LEAD, and everything after them is the plugin's own list
  // in its own order. This assertion used to compare a bare COUNT against
  // rect.inspector.length; WORKSTREAM BE prepends the universal rows, so that
  // number legitimately changed (39 → 43). What it was really protecting — "a
  // lone selection loses no row", by IDENTITY and in ORDER — is asserted here
  // directly instead, which is strictly stronger than the count ever was.
  const universal = universalRowsWithInterp([entry("r", "rect", {})]);
  assert.deepEqual(rows.slice(0, universal.length).map((r) => r.key), universal.map((r) => r.key));
  const pluginRows = rows.slice(universal.length);
  assert.equal(pluginRows.length, rect.inspector.length, "a lone selection loses no plugin row");
  pluginRows.forEach((row, i) => assert.equal(row, rect.inspector[i], "the SAME object, not a copy"));
});

test("THE DRIFT GATE: an intersected row is the plugin's OWN row object", () => {
  // manifest: "a reference cannot drift from itself; a lookup needs a table that
  // can be missing". If a future refactor starts BUILDING rows here, this fails.
  const primary = registry.get("rect");
  const { rows } = intersectRows([entry("r", "rect", {}), entry("v", "video", {})]);
  assert.ok(rows.length > 0, "rect + video must share something to make this meaningful");
  // The universal rows are core's own shared objects (their own drift gate is
  // the BE test at the bottom); every OTHER row must be the primary plugin's.
  const universalKeys = new Set(universalRowsWithInterp([entry("r", "rect", {})]).map((r) => r.key));
  for (const row of rows.filter((r) => !universalKeys.has(r.key)))
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

test("REAL row-kind conflict is REPORTED, and now also OFFERED", () => {
  // Both the shape widget and the magnifier declare `shape`, with different
  // option sets — the exact "same key, different property" case.
  //
  // THIS ASSERTION FLIPPED, ON A USER RULING (#300), and the old form is worth
  // stating so nobody restores it by instinct: it used to require that the row was
  // NOT offered. The user overruled the refusal — "I realise they may mean
  // different things… but don't actually BLOCK me from doing it. There should be a
  // way to get around that." So the row IS offered, marked, and unifiable in one
  // click, while `conflicts` still carries the warning. Informing and allowing are
  // not alternatives; the refusal was the half with no escape hatch.
  const { rows, conflicts } = intersectRows([entry("s", "shape", {}), entry("m", "magnifier", {})]);
  assert.ok(rows.some((r) => r.key === "shape"), "the conflicting row is offered, so the author can get past it");
  const reported = conflicts.find((c) => c.key === "shape");
  assert.ok(reported, "an excluded row present on BOTH items must be reported by key");
  assert.ok(reported.aspects.includes("options"), `the report names the differing aspect: ${JSON.stringify(reported.aspects)}`);
});

test("`visibleWhen` is PRESENTATIONAL — text + plaintext still share their style rows", () => {
  // THE REGRESSION THIS PINS (e3caa3a, found and reported by W2-G against its own
  // change): plugins/text.js gave its eight box-level style rows a `visibleWhen`
  // (they hide once per-run/per-paragraph twins exist); plugins/plaintext.js's
  // identical rows have none. With `visibleWhen` treated as CONTRACT, font / size
  // / bold / align became CONFLICTS on a text+plaintext selection — four rows that
  // are the same property in every way that decides what a written value MEANS.
  //
  // Note what the denylist's polarity bought here, because that is the design
  // claim and not just a bug story: a brand-new row aspect defaulted to CONTRACT
  // and surfaced a NAMED, diagnosable conflict, rather than silently unifying two
  // rows that might have disagreed. The failure mode was over-exclusion, which is
  // visible; the alternative polarity's failure mode is data loss, which is not.
  const { rows, conflicts } = intersectRows([entry("t", "text", { type: "text" }), entry("p", "plaintext", { type: "plaintext" })]);
  const shared = rows.map((r) => r.key);
  for (const key of ["font", "size", "bold", "align"])
    assert.ok(shared.includes(key), `${key} must stay jointly editable across text + plaintext (shared: ${JSON.stringify(shared)})`);
  assert.deepEqual(conflicts.filter((c) => c.aspects.includes("visibleWhen")), [],
    "no row may be excluded for differing on `visibleWhen` alone");

  // DERIVED, not restated: read the two REAL rows and assert that `visibleWhen` is
  // the only thing between them. If a future edit makes them genuinely differ,
  // this says so precisely instead of the blanket check above quietly passing for
  // the wrong reason — and if text.js drops `visibleWhen`, it fails as vacuous.
  const fontRow = (type) => registry.get(type).inspector.find((r) => r.key === "font");
  assert.ok(typeof fontRow("text").visibleWhen === "function",
    "precondition: text's font row still declares visibleWhen — without it this test gates nothing");
  assert.equal(fontRow("plaintext").visibleWhen, undefined, "precondition: plaintext's does not");
  assert.deepEqual(contractDifferences(fontRow("text"), fontRow("plaintext")), [],
    "`visibleWhen` is the ONLY difference, and it is presentational");
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
  // The universal rows lead (WORKSTREAM BE) and the camera's own exclusion shows
  // up right here: it is purgeable:false, so the set offers NO Visible row and
  // therefore no visibility-interp row either. The PLUGIN half of the
  // intersection is unchanged — x/y/w/h and nothing else, as before.
  assert.deepEqual(keys, ["type", "morph", "x", "y", "w", "h"]);
});

test("intersection is ORDER-STABLE and follows the PRIMARY's row order", () => {
  const primaryFirst = intersectRows([entry("r", "rect", {}), entry("c", "circle", {})]).rows.map((r) => r.key);
  // The expected order is the universal prefix (WORKSTREAM BE) followed by the
  // primary plugin's own declared order — the invariant this test has always
  // protected, now stated over both halves rather than over the plugin's alone.
  const universalOrder = universalRowsWithInterp([entry("r", "rect", {})]).map((r) => r.key);
  const rectOrder = registry.get("rect").inspector.map((r) => r.key).filter((k) => primaryFirst.includes(k));
  assert.deepEqual(primaryFirst, [...universalOrder, ...rectOrder], "rows keep the primary plugin's declared order");
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
  // A PAINT row is jointly editable now — PaintField threads `paths` (the
  // former PAINT_JOINT_EDIT_PENDING handback landed).
  assert.equal(jointEditProblem({ key: "fill", kind: "color", paint: true }), null);
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
  // The intersection is over the LIVE items only — so it is rect's own rows,
  // behind the universal prefix every selection now carries (WORKSTREAM BE).
  // Pinned as a difference rather than a bare count so it keeps meaning what it
  // says if either list grows.
  const universalCount = universalRowsWithInterp([entry("r", "rect", {})]).length;
  assert.equal(panel.rows.length - universalCount, registry.get("rect").inspector.length,
    "the ghost contributed nothing — the plugin half is rect's alone");
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

// ── THE UNIVERSAL SECTION OVER A SET (WORKSTREAM BE) ─────────────────────────
// User, 2026-08-02 night: "the universal drop-down menu should still be there,
// or at least some subset of it. In particular, perhaps name shouldn't be there.
// But widget type, visible, and morph all should be. The reason why? I just
// duplicated three objects and there was no way to change their visibility
// interpolation all at once."

test("BE: a multi-selection offers type, visible and morph — and NOT name", () => {
  const panel = multiSelectPanel([entry("a", "rect", { type: "rect", active: true }), entry("b", "rect", { type: "rect", active: true })]);
  const keys = panel.rows.map((r) => r.row.key);
  for (const key of ["type", "active", MORPH_KEY])
    assert.ok(keys.includes(key), `${key} is offered over a set (the user named it)`);
  assert.ok(!keys.includes("name"), "NAME is the row the user volunteered to drop, and it stays dropped");
});

test("BE: the universal rows LEAD the panel, in the ruled order", () => {
  const panel = multiSelectPanel([entry("a", "rect", { type: "rect", active: true }), entry("b", "circle", { type: "circle", active: true })]);
  const keys = panel.rows.map((r) => r.row.key);
  assert.deepEqual(keys.slice(0, 4), ["type", "active", "active~interp", MORPH_KEY],
    "universal first — they are the properties every widget has");
});

test("BE: widget type is SHOWN but refuses a joint write, with its reason", () => {
  const panel = multiSelectPanel([entry("a", "rect", { type: "rect" }), entry("b", "circle", { type: "circle" })]);
  const type = panel.rows.find((r) => r.row.key === "type");
  assert.ok(type, "the row is displayed — that is the ask");
  assert.equal(type.problem, UNIVERSAL_TYPE_ROW_PROBLEM,
    "…and it explains itself rather than vanishing or lying about what a click does");
  assert.equal(type.mixed, true, "two different types read as MIXED");
  // The refusal is per-ROW, not per-KIND: `select` stays jointly editable.
  assert.equal(jointEditProblem({ key: "blendMode", kind: "select" }), null);
});

test("BE: visible unifies across the set as ONE write, mixed reported honestly", () => {
  const entries = [entry("a", "rect", { active: true }), entry("b", "rect", { active: false }), entry("c", "rect", { active: false })];
  const row = multiSelectPanel(entries).rows.find((r) => r.row.key === "active");
  assert.equal(row.mixed, true, "they disagree, so the panel says so");
  assert.equal(row.problem, null, "visibility DOES unify — the set-actions ruling is about a guessing TOGGLE");
  assert.equal(row.seed, true, "the seed is the primary's value");
  const pairs = unifyPairs(entries, "active", row.seed);
  assert.deepEqual(pairs, [[["items", "b", "active"], true], [["items", "c", "active"], true]],
    "the primary already holds it (minimal delta); the other two are written in one staged batch");
});

test("BE THE DRIVING ACCEPTANCE: one interp edit reaches every selected item", () => {
  // "there was no way to change their visibility interpolation all at once."
  const entries = [entry("a", "rect", { active: true }), entry("b", "rect", { active: true }), entry("c", "rect", { active: true })];
  const panel = multiSelectPanel(entries);
  const interp = panel.rows.find((r) => r.row.key === "active~interp");
  assert.ok(interp, "the visibility INTERP row is reachable over a set — the whole report");
  assert.equal(interp.problem, null, "and it is jointly editable");
  assert.ok(interp.row.options.includes("blurFade") && interp.row.options.includes("fade"),
    `and it offers the fade modes: ${JSON.stringify(interp.row.options)}`);
  // ONE edit → THREE writes, staged together, so commitPreview walks them into
  // ONE undo unit (the behavioural half is pinned in the browser probe).
  const pairs = unifyPairs(entries, "active~interp", "blurFade");
  assert.equal(pairs.length, 3, "all three change from one edit");
  assert.deepEqual(pairs.map(([p]) => p[1]), ["a", "b", "c"]);
});

test("BE: only `active` gets an interp row — the others would double the panel to say tween/step", () => {
  const keys = multiSelectPanel([entry("a", "rect", { active: true }), entry("b", "rect", { active: true })])
    .rows.map((r) => r.row.key);
  assert.equal(keys.filter((k) => k.endsWith("~interp")).length, 1);
  assert.ok(!keys.includes("opacity~interp"), "opacity offers tween/step only; it does not earn a permanent row");
});

test("BE: the CAMERA cannot be hidden, so a set containing it offers no Visible row", () => {
  const withCamera = multiSelectPanel([entry("r", "rect", { type: "rect", active: true }), entry("c", "camera", { type: "camera" })]);
  const keys = withCamera.rows.map((r) => r.row.key);
  assert.ok(!keys.includes("active"), "offering it would promise a write the document refuses");
  assert.ok(!keys.includes("active~interp"), "and no interp row for a row that is not there");
  assert.ok(keys.includes("type") && keys.includes(MORPH_KEY), "the rest of the universal section survives");
});

test("BE DRIFT GATE: the universal rows come from ONE definition, not a second copy", () => {
  // The single-select panel and the set panel must read the SAME row objects.
  // If someone re-synthesizes them per call, these stop being identical.
  const a = universalRowsWithInterp([{ plugin: registry.get("rect"), state: { active: true } }]);
  const b = universalRowsWithInterp([{ plugin: registry.get("circle"), state: { active: true } }]);
  assert.equal(a[0], b[0], "the type row is one shared object, by IDENTITY");
  assert.equal(a[1], b[1], "so is the visible row");
  assert.deepEqual(a.map((r) => r.key), ["type", "active", "active~interp", MORPH_KEY]);
});

console.log(`\n  ${passed} multiselect core tests passed`);
