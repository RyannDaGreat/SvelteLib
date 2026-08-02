/**
 * MULTI-SELECTION: UNION MODE — every property ANY selected item has.
 *
 * User, 2026-08-02: "when I have a selection of multiple objects, on the very top
 * it should let me say intersection or union — if I select the intersection of
 * properties then I see what I have now, but if I toggle that to union then it
 * will show me the union of all properties. Same behaviour for both."
 *
 * "SAME BEHAVIOUR FOR BOTH" IS THE LOAD-BEARING PHRASE and most of this file is
 * about it: a union row is not a read-only listing, it edits, keyframes, reports
 * MIXED and unifies exactly as an intersection row does. The single difference is
 * WHO it applies to — the items that declare it — and that difference has to be
 * carried honestly, because the alternatives are both bad:
 *   · write the key onto every selected item → stores a property a plugin never
 *     declared, which its widget silently ignores. Invisible junk in the document.
 *   · read mixedness over every selected item → an item with no such row answers
 *     `undefined`, the row reads MIXED against a participant with a definite
 *     value, and unifying can never clear it. A permanently-wrong panel.
 *
 * The separation from #300 is deliberate and pinned below: UNION is about a row
 * being ABSENT from some items. A row PRESENT everywhere but meaning different
 * things is a CONTRACT CONFLICT, and union mode must not smuggle those in — that
 * is its own feature (warn-and-unify) and doing it here would silently write a
 * value the other item cannot mean.
 *
 * Run: node src/demo_apps/PowerRP/tests/multiselect_union_test.js
 */
import assert from "node:assert/strict";
import { intersectRows, multiSelectPanel, MULTISELECT_MODE } from "../core/multiselect.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const OPACITY = { key: "opacity", kind: "number", min: 0, max: 1 };
const FRACTION = { key: "fraction", kind: "number", min: 0, max: 1 };
const TEXT = { key: "text", kind: "text" };

/** One selected item: a fake plugin with the given rows + defaults, and state. */
const entry = (itemId, rows, state = {}, defaults = {}) =>
  ({ itemId, plugin: { inspector: rows, defaults }, state });

/** intersectRows returns RAW rows; multiSelectPanel returns WRAPPERS ({row, …}).
 *  One helper for both, so a test cannot silently read `undefined` off the wrong
 *  shape — which is exactly what it did on the first run of this file. */
const keysOf = (r) => r.rows.map((row) => (row.row ?? row).key);

// ── WHAT UNION ADDS ─────────────────────────────────────────────────────────

test("INTERSECTION is unchanged: only rows every item declares", () => {
  const r = intersectRows([entry("a", [OPACITY, FRACTION]), entry("b", [OPACITY, TEXT])]);
  assert.deepEqual(keysOf(r), ["opacity"]);
  assert.deepEqual(r.conflicts, []);
});

test("UNION shows every row ANY item declares", () => {
  const r = intersectRows([entry("a", [OPACITY, FRACTION]), entry("b", [OPACITY, TEXT])], MULTISELECT_MODE.UNION);
  assert.deepEqual(keysOf(r), ["opacity", "fraction", "text"]);
});

test("UNION keeps the PRIMARY's rows first, so the panel does not reshuffle", () => {
  // The primary's framing is a shipped property of this panel; union appends
  // rather than reorders, so toggling the mode does not move what was already there.
  const r = intersectRows([entry("a", [OPACITY, FRACTION]), entry("b", [TEXT])], MULTISELECT_MODE.UNION);
  assert.deepEqual(keysOf(r), ["opacity", "fraction", "text"]);
});

test("UNION does not duplicate a key two items both declare", () => {
  const r = intersectRows([entry("a", [OPACITY]), entry("b", [OPACITY])], MULTISELECT_MODE.UNION);
  assert.deepEqual(keysOf(r), ["opacity"]);
});

// ── WHO A ROW APPLIES TO ────────────────────────────────────────────────────

test("appliesTo names exactly the items that DECLARE the row", () => {
  const r = intersectRows([entry("a", [OPACITY, FRACTION]), entry("b", [OPACITY])], MULTISELECT_MODE.UNION);
  assert.deepEqual(r.appliesTo.get("opacity"), ["a", "b"], "shared → both");
  assert.deepEqual(r.appliesTo.get("fraction"), ["a"], "only a declares it → only a");
});

test("in INTERSECTION mode appliesTo is always the whole selection", () => {
  const r = intersectRows([entry("a", [OPACITY]), entry("b", [OPACITY])]);
  assert.deepEqual(r.appliesTo.get("opacity"), ["a", "b"]);
});

test("THE DRIFT GATE HOLDS IN UNION MODE TOO: rows are the plugins' OWN objects", () => {
  // The first union implementation carried appliesTo ON the row via a spread, and
  // this gate is what caught it. Participation lives in a side table precisely so
  // that a row can never be a copy that drifts from the plugin's declaration.
  const aRows = [OPACITY, FRACTION];
  const bRows = [TEXT];
  const r = intersectRows([entry("a", aRows), entry("b", bRows)], MULTISELECT_MODE.UNION);
  assert.equal(r.rows[0], OPACITY, "the SAME object, not a copy");
  assert.equal(r.rows[1], FRACTION, "the SAME object, not a copy");
  assert.equal(r.rows[2], TEXT, "…including a row contributed by a non-primary item");
  assert.ok(!("appliesTo" in OPACITY), "and nothing was mutated onto the plugin's row");
});

// ── MIXEDNESS IS READ OVER THE PARTICIPANTS ONLY ────────────────────────────

test("A UNION ROW IS NOT MIXED just because a non-participant lacks the property", () => {
  // The bug this prevents: reading `fraction` off item b (which has no such row)
  // yields undefined, which differs from a's 0.5, so the row would show "…"
  // forever and no unify could clear it.
  const panel = multiSelectPanel(
    [entry("a", [OPACITY, FRACTION], { fraction: 0.5 }), entry("b", [OPACITY], {})],
    MULTISELECT_MODE.UNION,
  );
  const fraction = panel.rows.find((r) => r.row.key === "fraction");
  assert.equal(fraction.mixed, false, "one participant, one value — nothing is mixed");
  assert.equal(fraction.value, 0.5, "and its value is that participant's");
  assert.deepEqual(fraction.appliesTo, ["a"], "the wrapper carries who it applies to");
});

test("a union row IS mixed when its actual participants disagree", () => {
  const panel = multiSelectPanel(
    [entry("a", [FRACTION], { fraction: 0.5 }), entry("b", [FRACTION], { fraction: 0.9 }), entry("c", [OPACITY], {})],
    MULTISELECT_MODE.UNION,
  );
  const fraction = panel.rows.find((r) => r.row.key === "fraction");
  assert.equal(fraction.mixed, true, "a and b genuinely differ");
  assert.deepEqual(fraction.appliesTo, ["a", "b"], "c is not a participant and did not make it mixed");
});

test("defaults still count: absent MEANS the default, in union mode too", () => {
  const panel = multiSelectPanel(
    [entry("a", [OPACITY], { opacity: 1 }, { opacity: 1 }), entry("b", [OPACITY], {}, { opacity: 1 })],
    MULTISELECT_MODE.UNION,
  );
  assert.equal(panel.rows[0].mixed, false, "an explicit 1 and an absent-meaning-1 are the same value");
});

// ── UNION IS NOT AN ESCAPE HATCH FROM CONTRACT CONFLICTS ────────────────────

test("A CONTRACT CONFLICT IS STILL A CONFLICT IN UNION MODE, not a row", () => {
  // Same key, different options → the two items cannot mean one value. Union is
  // about ABSENCE, not about disagreement in meaning; getting past this is #300's
  // warn-and-unify, and doing it here would write a value one item cannot mean.
  const a = entry("a", [{ key: "shape", kind: "select", options: ["star"] }]);
  const b = entry("b", [{ key: "shape", kind: "select", options: ["box"] }]);
  for (const mode of [MULTISELECT_MODE.INTERSECTION, MULTISELECT_MODE.UNION]) {
    const r = intersectRows([a, b], mode);
    assert.deepEqual(keysOf(r), [], `${mode}: the conflicting row is not offered`);
    assert.deepEqual(r.conflicts.map((c) => c.key), ["shape"], `${mode}: and it IS reported as a conflict`);
  }
});

test("a conflict on ONE key does not suppress the union of the others", () => {
  const a = entry("a", [OPACITY, { key: "shape", kind: "select", options: ["star"] }, FRACTION]);
  const b = entry("b", [OPACITY, { key: "shape", kind: "select", options: ["box"] }]);
  const r = intersectRows([a, b], MULTISELECT_MODE.UNION);
  assert.deepEqual(keysOf(r), ["opacity", "fraction"]);
  assert.deepEqual(r.conflicts.map((c) => c.key), ["shape"]);
});

// ── THE PANEL REPORTS ITS MODE ──────────────────────────────────────────────

test("the panel says which mode built it, so the renderer cannot disagree with what it drew", () => {
  assert.equal(multiSelectPanel([entry("a", [OPACITY])]).mode, "intersection", "default");
  assert.equal(multiSelectPanel([entry("a", [OPACITY])], MULTISELECT_MODE.UNION).mode, "union");
});

test("a ONE-ITEM selection is identical in both modes", () => {
  // There is nothing to union with, so the two must not diverge — this is what
  // keeps the single-selection panel unaffected by the toggle existing.
  const one = [entry("a", [OPACITY, FRACTION], { opacity: 1 })];
  assert.deepEqual(keysOf(intersectRows(one)), keysOf(intersectRows(one, MULTISELECT_MODE.UNION)));
});

test("an item NOT ON THIS SLIDE is still skipped in union mode, never written", () => {
  const panel = multiSelectPanel(
    [entry("a", [OPACITY], { opacity: 1 }), { itemId: "ghost", plugin: { inspector: [FRACTION] }, state: null }],
    MULTISELECT_MODE.UNION,
  );
  assert.deepEqual(panel.skipped, ["ghost"]);
  assert.deepEqual(keysOf(panel), ["opacity"], "the ghost's rows do NOT join the union — it is not being edited");
});

console.log(`\n${passed} multiselect union tests passed`);
