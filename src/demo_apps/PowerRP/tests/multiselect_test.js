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
  retypeSkips,
  retypeSkipReason,
} from "../core/multiselect.js";
import { MORPH_KEY } from "../core/morph_property.js";
import {
  sectionKeyPaths,
  sectionTriState,
  sectionBubbleApplies,
  sectionToggleAction,
  sectionToggleTip,
  sectionJumpTarget,
} from "../core/section_keyframes.js";
import { newDocument, repairedDocument, foldState, keyframed, unkeyframed, hasKeyframe, keyframeIndices } from "../core/document.js";
import { setPath, getPath } from "../core/deltas.js";

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
  // `retypeSkips` joined it with WORKSTREAM BT — the type row became editable
  // over a set, so the panel must also carry which selected items a type change
  // would NOT touch (and why). Empty selection, nothing to skip.
  assert.deepEqual(multiSelectPanel([]), { rows: [], conflicts: [], skipped: [], retypeSkips: [], mode: "intersection", itemIds: [] });
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

// ── THE REFUSAL PIN, UPDATED TO THE RULING THAT REPLACED IT (WORKSTREAM BT) ──
// THIS TEST USED TO ASSERT THE OPPOSITE. It read:
//   test("BE: widget type is SHOWN but refuses a joint write, with its reason")
//   assert.equal(type.problem, UNIVERSAL_TYPE_ROW_PROBLEM, …)
// and it pinned a refusal that was a CLAUDE CHOICE, never a user ruling. The
// user overruled it (2026-08-03, verbatim, looking at that tooltip): "Hey, why
// won't it let me edit widget type? No, that's a stupid error. Just do it to
// everyone individually. … Just do it to them all individually, then change
// what we see in the properties. It's not that hard."
//
// The manifest's own lesson is why this rewrite lives in the same commit as the
// code: "When a commit reverts a design, the same commit must revert its
// doctrine" — a pin left standing on an overruled design is the same confident
// lie as a doctrine paragraph left standing, and it is worse, because a green
// suite is evidence.
test("BT: widget type is SHOWN and JOINTLY EDITABLE — the refusal is gone", () => {
  const panel = multiSelectPanel([entry("a", "rect", { type: "rect" }), entry("b", "circle", { type: "circle" })]);
  const type = panel.rows.find((r) => r.row.key === "type");
  assert.ok(type, "the row is displayed — BE's half of the ask, unchanged");
  assert.equal(type.problem, null,
    "…and it no longer refuses: each item runs its OWN coercion plan (app.retypeSelection), so there is nothing for one shared value to fail to describe");
  assert.equal(type.mixed, true, "two different types still read as MIXED — that part was always honest");
  // There is no per-ROW refusal left at all; `select` was and remains a jointly
  // editable KIND, and `type` is now just one of them.
  assert.equal(jointEditProblem({ key: "type", kind: "select" }), null);
  assert.equal(jointEditProblem({ key: "blendMode", kind: "select" }), null);
});

test("BT: an ineligible item is named with its own reason, and does not block the rest", () => {
  const panel = multiSelectPanel([
    entry("a", "rect", { type: "rect" }),
    entry("cam", "camera", { type: "camera" }),
    entry("b", "circle", { type: "circle" }),
  ]);
  assert.deepEqual(panel.retypeSkips.map((s) => s.itemId), ["cam"],
    "only the camera is skipped — the eligible rest is untouched by its presence");
  assert.ok(/mandatory/.test(panel.retypeSkips[0].reason),
    "and the reason NAMES why, rather than saying 'structural' (which answers nothing)");
  const type = panel.rows.find((r) => r.row.key === "type");
  assert.ok(type, "the type row is still offered — an ineligible item never removes the control");
  assert.equal(type.problem, null, "…nor re-installs the refusal");
});

test("BT: retypeSkipReason reads the plugin's OWN declared marks, one sentence each", () => {
  // The four structural marks retypeEligible excludes on — each already declared
  // for another purpose, so this is a fact about the widget, not a hand list.
  assert.equal(retypeSkipReason({ type: "rect", capabilities: {} }), null);
  assert.ok(retypeSkipReason({ title: "Camera", capabilities: { purgeable: false } }).includes("mandatory"));
  assert.ok(retypeSkipReason({ title: "Group", capabilities: { ghost: true }, foldsSubtree: () => true }).includes("members"));
  assert.ok(retypeSkipReason({ title: "Crop Box", capabilities: { ghost: true } }).includes("no volume"));
  assert.ok(retypeSkipReason({ title: "Metaball", capabilities: { metaball: true } }).includes("siblings"));
  // An all-eligible selection reports nothing — no note, no noise.
  assert.deepEqual(retypeSkips([entry("a", "rect", {}), entry("b", "circle", {})]), []);
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

// ── THE SECTION-HEADER KEYFRAME BUBBLE (WORKSTREAM BH) ───────────────────────
// User, 2026-08-02 night: "In each drop-down… a slightly different-looking, maybe
// a bit smaller keyframe bubble on it too, that would be half-filled if some of
// them are keyframed, completely unfilled if none of them are keyframed, and fully
// filled if all of them are keyframed. And upon clicking it, we'll toggle between
// all or none… Maybe just 30% smaller than the normal one… we can get the left and
// right parts for it."
//
// THE BUBBLE'S TRI-STATE IS THE ROW DIAMOND'S, over a different axis, so it is
// pinned HERE beside keyframeTriState rather than in a parallel suite — the two
// readings must never drift, and a shared home is what makes that structural.
// core/section_keyframes.js holds the reasoning; these are its consequences.

test("BH: the section bubble's paths are its KEYFRAMEABLE rows, crossed with the items", () => {
  const rows = [{ key: "x" }, { key: "y" }];
  assert.deepEqual(sectionKeyPaths(rows, () => ["a"], (r) => r.key),
    [["items", "a", "x"], ["items", "a", "y"]]);
  // A row that cannot be keyed is not offered by the bubble either — a bubble
  // promising to key Name would advertise a write the document refuses.
  assert.deepEqual(sectionKeyPaths([{ key: "name", keyframes: false }, { key: "x" }], () => ["a"], (r) => r.key),
    [["items", "a", "x"]], "keyframes:false rows are excluded");
  // …and the WRITE key is what lands, so a cx row keys x exactly as its own
  // diamond does (Inspector's writeKey; core/properties.js PROPS.cx).
  assert.deepEqual(sectionKeyPaths([{ key: "cx", writeKey: "x" }], () => ["a"], (r) => r.writeKey ?? r.key),
    [["items", "a", "x"]]);
  // cx and x in ONE section are ONE path, not two — otherwise a count would lie.
  assert.deepEqual(sectionKeyPaths([{ key: "cx", writeKey: "x" }, { key: "x" }], () => ["a"], (r) => r.writeKey ?? r.key),
    [["items", "a", "x"]], "the same leaf twice is deduplicated");
});

test("BH: a section with nothing keyframeable renders NO bubble, not a dead one", () => {
  assert.equal(sectionBubbleApplies(sectionKeyPaths([{ key: "name", keyframes: false }], () => ["a"], (r) => r.key)), false);
  assert.equal(sectionBubbleApplies([["items", "a", "x"]]), true);
});

test("BH TRI-STATE: none / some / all, exactly the row diamond's reading", () => {
  assert.equal(sectionTriState([false, false, false]), "none", "nothing in the section is keyed here");
  assert.equal(sectionTriState([true, false, false]), "some", "one of three is the half fill");
  assert.equal(sectionTriState([true, true, true]), "all");
  // THE DRIFT GATE for the two bubbles' shared reading: same function, so the
  // section header and the row can never disagree about what "half" means.
  for (const flags of [[], [true], [false, true], [true, true]])
    assert.equal(sectionTriState(flags), keyframeTriState(flags),
      "the section bubble reuses the row's triad rather than restating it");
});

test("BH: the HALF state goes to ALL — the click always completes before it clears", () => {
  assert.equal(sectionToggleAction("none"), "insert");
  assert.equal(sectionToggleAction("some"), "insert",
    "half → all: insert is an UPSERT, remove would destroy the very keyframes that made it half");
  assert.equal(sectionToggleAction("all"), "remove", "only a uniformly-keyed section clears");
  // The tooltip SAYS what the click will do, from the same decision, so a
  // state-dependent click is never something the user has to discover.
  assert.match(sectionToggleTip("none", "Transform"), /^Keyframe every property in Transform/);
  assert.match(sectionToggleTip("some", "Transform"), /click to keyframe all of it$/);
  assert.match(sectionToggleTip("all", "Transform"), /^Remove every Transform keyframe/);
});

test("BH: ‹ › walk the UNION — the nearest slide keyframing ANY of the section", () => {
  // x keys on slides 0 and 5; opacity on slide 2. Standing on slide 1:
  const perPath = [[0, 5], [2]];
  assert.equal(sectionJumpTarget(perPath, 1, +1), 2, "opacity's slide 2 is nearer than x's slide 5");
  assert.equal(sectionJumpTarget(perPath, 1, -1), 0);
  assert.equal(sectionJumpTarget(perPath, 5, +1), null, "nothing ahead — stay put");
  // NEAREST, not the first path's answer: the union is walked, not row order.
  assert.equal(sectionJumpTarget([[9], [3]], 1, +1), 3);
  assert.equal(sectionJumpTarget([[0], [4]], 5, -1), 4);
  // The current slide is never its own jump target in either direction.
  assert.equal(sectionJumpTarget([[3]], 3, +1), null);
  assert.equal(sectionJumpTarget([[3]], 3, -1), null);
});

// ── THE TOGGLE AGAINST A REAL DOCUMENT ───────────────────────────────────────
// web/app.svelte.js `toggleSectionKeyframes` folds ONE document and commits ONCE.
// The fold is what makes it one undo unit, so it is modelled here leaf-for-leaf
// (the app method is three lines of exactly this over `this.doc`) — a bare-node
// pin that a browser probe could only observe indirectly by counting undos.

/** Test helper. The app's toggle, over a document: the SAME branch and the SAME
 *  fold, returning the single document a commit would receive. */
function sectionToggled(doc, slideIndex, paths) {
  const tri = sectionTriState(paths.map((p) => hasKeyframe(doc, slideIndex, p)));
  let out = doc;
  if (sectionToggleAction(tri) === "remove")
    for (const p of paths) out = unkeyframed(out, slideIndex, p);
  else
    for (const p of paths) out = keyframed(out, slideIndex, p, getPath(foldState(doc, slideIndex, 1), p));
  return out;
}

/** Test helper. A three-slide document holding one rect, so slide 1 can be keyed
 *  and cleared without touching the creating delta on slide 0.
 *
 *  Built ONCE and structurally cloned per call: newDocument() mints a fresh uuid
 *  for the camera and the slide, so two calls are not deep-equal and could not be
 *  compared to prove the toggle left its input alone. */
const TWO_SLIDE_SEED = (() => {
  const doc = repairedDocument(newDocument(), registry).doc;
  return {
    ...doc,
    slides: [
      { ...doc.slides[0], delta: setPath(setPath(setPath(doc.slides[0].delta, ["items", "r", "type"], "rect"), ["items", "r", "x"], 10), ["items", "r", "y"], 20) },
      { ...doc.slides[0], id: "s2", delta: {} },
      { ...doc.slides[0], id: "s3", delta: {} },
    ],
  };
})();

function twoSlideDoc() {
  return structuredClone(TWO_SLIDE_SEED);
}

const TRANSFORM_PATHS = [["items", "r", "x"], ["items", "r", "y"]];

test("BH ACCEPTANCE: none → ALL in ONE document, and ALL → none in one more", () => {
  const doc = twoSlideDoc();
  const SLIDE = 1;
  assert.equal(sectionTriState(TRANSFORM_PATHS.map((p) => hasKeyframe(doc, SLIDE, p))), "none",
    "slide 1 inherits everything to begin with");

  // ONE CLICK → every path in the section is keyed on this slide.
  const keyed = sectionToggled(doc, SLIDE, TRANSFORM_PATHS);
  assert.equal(sectionTriState(TRANSFORM_PATHS.map((p) => hasKeyframe(keyed, SLIDE, p))), "all");
  // ONE UNDO UNIT is exactly this: ONE document is produced, so ONE commit takes
  // it and one undo takes it back. Not "two writes that happen to be adjacent".
  assert.notEqual(keyed, doc, "the toggle produced a new document");
  assert.deepEqual(doc, twoSlideDoc(), "…and did not mutate the old one (one undo restores it verbatim)");

  // THE UPSERT COPIES EACH PATH'S OWN VALUE, not one shared value.
  assert.equal(getPath(keyed.slides[SLIDE].delta, ["items", "r", "x"]), 10);
  assert.equal(getPath(keyed.slides[SLIDE].delta, ["items", "r", "y"]), 20);
  // Nothing VISIBLE changed: keying an inherited value is a no-op on screen.
  assert.deepEqual(foldState(keyed, SLIDE, 1).items.r, foldState(doc, SLIDE, 1).items.r);

  // ONE MORE CLICK → back to none, again in one document.
  const cleared = sectionToggled(keyed, SLIDE, TRANSFORM_PATHS);
  assert.equal(sectionTriState(TRANSFORM_PATHS.map((p) => hasKeyframe(cleared, SLIDE, p))), "none");
  assert.deepEqual(cleared.slides[SLIDE].delta, {}, "the slide inherits again, exactly as before the first click");
  assert.deepEqual(foldState(cleared, SLIDE, 1).items.r, foldState(doc, SLIDE, 1).items.r);
});

test("BH: from HALF, one click completes the section — it never clears from half", () => {
  const doc = twoSlideDoc();
  const SLIDE = 1;
  const half = keyframed(doc, SLIDE, ["items", "r", "x"], 99);
  assert.equal(sectionTriState(TRANSFORM_PATHS.map((p) => hasKeyframe(half, SLIDE, p))), "some");

  const after = sectionToggled(half, SLIDE, TRANSFORM_PATHS);
  assert.equal(sectionTriState(TRANSFORM_PATHS.map((p) => hasKeyframe(after, SLIDE, p))), "all",
    "half → ALL (the ruling): the destructive branch is never taken on the least-certain state");
  // AND THE KEYFRAME THAT MADE IT HALF SURVIVES ITS OWN VALUE. Had half gone to
  // `none`, this 99 — a real edit the user made — would be gone.
  assert.equal(getPath(after.slides[SLIDE].delta, ["items", "r", "x"]), 99,
    "the existing keyframe is not overwritten by the fold's value");
  assert.equal(getPath(after.slides[SLIDE].delta, ["items", "r", "y"]), 20, "and the missing one is filled in");
});

test("BH: an EQUATION keyframes as the equation, and each path keeps its own value", () => {
  const doc = twoSlideDoc();
  const withEq = keyframed(doc, 0, ["items", "r", "x"], "=100+1");
  const keyed = sectionToggled(withEq, 1, TRANSFORM_PATHS);
  assert.equal(getPath(keyed.slides[1].delta, ["items", "r", "x"]), "=100+1",
    "an equation is copied VERBATIM — not the number it evaluates to");
  assert.equal(getPath(keyed.slides[1].delta, ["items", "r", "y"]), 20,
    "and no path is given another path's value");
});

test("BH MULTI-SELECTION: the bubble reads the UNION and the toggle fans out, still one document", () => {
  // Two rects; ONE of them is already keyed on slide 1. The union is half.
  const base = twoSlideDoc();
  const doc = {
    ...base,
    slides: base.slides.map((s, i) => i !== 0 ? s
      : { ...s, delta: setPath(setPath(setPath(s.delta, ["items", "q", "type"], "rect"), ["items", "q", "x"], 30), ["items", "q", "y"], 40) }),
  };
  // The section's paths over a SET: every row crossed with every item that has it.
  const paths = sectionKeyPaths([{ key: "x" }, { key: "y" }], () => ["r", "q"], (row) => row.key);
  assert.deepEqual(paths, [["items", "r", "x"], ["items", "q", "x"], ["items", "r", "y"], ["items", "q", "y"]],
    "row-major over the union of the selected items");

  const half = keyframed(doc, 1, ["items", "q", "x"], 30);
  assert.equal(sectionTriState(paths.map((p) => hasKeyframe(half, 1, p))), "some",
    "half means 'somewhere in this section, on some item' — both axes at once");

  const all = sectionToggled(half, 1, paths);
  assert.equal(sectionTriState(paths.map((p) => hasKeyframe(all, 1, p))), "all", "the fan-out reaches every item");
  assert.deepEqual(all.slides[1].delta.items.r, { x: 10, y: 20 });
  assert.deepEqual(all.slides[1].delta.items.q, { x: 30, y: 40 }, "each item keeps its OWN values");
  // ONE document for FOUR writes across TWO items — one undo takes all of it.
  assert.deepEqual(half, keyframed(doc, 1, ["items", "q", "x"], 30), "the source document is untouched");

  const none = sectionToggled(all, 1, paths);
  assert.deepEqual(none.slides[1].delta, {}, "and one more click clears the whole set's section");
});

// ── WORKSTREAM BJ: THE ROW DIAMOND/ARROWS OVER A MULTI-SELECTION ────────────
// web/KeyframeControls.svelte's diamond and ‹ › now call the SAME two app
// methods the section bubble uses (`toggleSectionKeyframes`/`jumpSectionKeyframes`),
// with the ROW's own per-item path list instead of a section's row×item union.
// `sectionToggled` above already models `toggleSectionKeyframes` leaf-for-leaf, so
// it is reused verbatim here — a row's path set is just ONE key crossed with N
// selected items, which is exactly what sectionKeyPaths already produces.

test("BJ: N-item diamond click is ONE document, not a loop of N", () => {
  // Three rects created on slide 0 (r: x=10, q: x=30, n: x=50), NONE keyed on
  // slide 1 yet — mirrors the manifest's "one click keys N items, one undo
  // reverts all of it" acceptance, now proven for the ROW diamond specifically.
  const base = twoSlideDoc();
  const doc = {
    ...base,
    slides: base.slides.map((s, i) => i !== 0 ? s
      : {
          ...s,
          delta: setPath(setPath(setPath(setPath(
            s.delta,
            ["items", "q", "type"], "rect"), ["items", "q", "x"], 30),
            ["items", "n", "type"], "rect"), ["items", "n", "x"], 50),
        }),
  };
  // The ROW's own path set: ONE key ("x"), crossed with every selected item —
  // exactly sectionKeyPaths with a single-row rows array.
  const rowPaths = sectionKeyPaths([{ key: "x" }], () => ["r", "q", "n"], (row) => row.key);
  assert.deepEqual(rowPaths, [["items", "r", "x"], ["items", "q", "x"], ["items", "n", "x"]]);

  assert.equal(sectionTriState(rowPaths.map((p) => hasKeyframe(doc, 1, p))), "none",
    "nothing is keyed on slide 1 for any of the three yet");
  assert.deepEqual(doc.slides[1].delta, {}, "slide 1 starts empty — all three inherit from slide 0");

  // ONE CLICK.
  const keyed = sectionToggled(doc, 1, rowPaths);
  assert.equal(sectionTriState(rowPaths.map((p) => hasKeyframe(keyed, 1, p))), "all",
    "the diamond's one click reaches all three selected items");
  assert.equal(getPath(keyed.slides[1].delta, ["items", "r", "x"]), 10, "r keeps its own inherited value");
  assert.equal(getPath(keyed.slides[1].delta, ["items", "q", "x"]), 30, "q keeps its own inherited value");
  assert.equal(getPath(keyed.slides[1].delta, ["items", "n", "x"]), 50, "n keeps its own inherited value");
  // ONE UNDO UNIT is exactly this: one document, produced without mutating the
  // input, so one commit takes it and one undo (re-applying `doc`) reverts all
  // three writes at once — never three separate undo steps.
  assert.notEqual(keyed, doc);
  assert.deepEqual(doc.slides[1].delta, {}, "the source document is untouched by the fold");

  // ONE MORE CLICK reverts all three in the same single document.
  const cleared = sectionToggled(keyed, 1, rowPaths);
  assert.deepEqual(cleared.slides[1].delta, {},
    "back to exactly the pre-click slide — one undo's worth of change, not three");
});

test("BJ: the ‹ › arrows walk the UNION of a set's paths, not the primary item alone", () => {
  // "r" is the PRIMARY item (first in the selection) and is NEVER keyed on x in
  // this document; "q" (a NON-primary selected item) is keyed on slide 2 only.
  // The old primary-only jump could never reach slide 2 from slide 0 — this is
  // the defect the file's own header flagged and BH's section jump then fixed
  // for sections. The row arrows must now agree.
  const base = repairedDocument(newDocument(), registry).doc;
  const doc = {
    ...base,
    slides: [
      { ...base.slides[0], delta: setPath(setPath(base.slides[0].delta, ["items", "r", "type"], "rect"), ["items", "q", "type"], "rect") },
      { ...base.slides[0], id: "s2", delta: {} },
      { ...base.slides[0], id: "s3", delta: setPath({}, ["items", "q", "x"], 77) },
    ],
  };
  const rowPaths = [["items", "r", "x"], ["items", "q", "x"]]; // primary "r" first, "q" second

  // From slide 0, jumping forward with the OLD primary-only logic (path = r's
  // alone) would find nothing, because "r" is never keyed on x anywhere.
  assert.deepEqual(keyframeIndices(doc, ["items", "r", "x"]), [], "the primary alone has no keyframe to jump to");

  // The UNION jump (sectionJumpTarget, now what the row arrows call) reaches
  // slide 2 — q's keyframe — even though q is not the primary selected item.
  const target = sectionJumpTarget(rowPaths.map((p) => keyframeIndices(doc, p)), 0, +1);
  assert.equal(target, 2, "the union reaches the non-primary item's keyframe");
});

console.log(`\n  ${passed} multiselect core tests passed`);
