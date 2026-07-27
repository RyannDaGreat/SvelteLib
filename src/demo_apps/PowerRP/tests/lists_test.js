/**
 * LIST PROPERTY tests — the variable-length-element-list substrate
 * (core/lists.js) and its equation wiring (core/properties.js declarations +
 * core/expressions.js typing/evaluation). Plain node, no framework (suite
 * convention). Run from the SvelteLib repo root or here:
 *   node src/demo_apps/PowerRP/tests/lists_test.js
 *
 * WHY THIS SUITE EXISTS. Manifest Tier 0 says EVERY property accepts an `=`
 * equation, no exceptions, and a LIST was the largest remaining exception:
 * `leaves()` keeps arrays opaque so `points.3.x` was not a leaf path, so
 * `isNumericSlot` never saw it, so nothing offered it; and binding the WHOLE list
 * failed separately because `resultKindForSlot` found no kind for an array-valued
 * slot and returned UNRESOLVED. Gradient stops sidestepped all of it by being
 * bespoke UI. This suite pins the general mechanism that replaces that.
 *
 * Covers:
 *   (1) EVERY doctest in core/lists.js, run for real (the suites transcribe
 *       doctests by hand — there is no runner).
 *   (2) The two FLAVOURS: a SORTED list's order is derived from its key field (so
 *       reordering is free), a SEQUENCE list's order IS its data.
 *   (3) INSERT-BETWEEN, including the INTEGER TRAP: interpolate() rounds a lerp
 *       between two integers (the tweenline int rule), so a naive midpoint between
 *       gradient offsets 0 and 1 would snap to 1 — a duplicate, not an in-between.
 *   (4) PER-ELEMENT VISIBILITY (hide) vs PURGE: hide never renumbers, purge does;
 *       "acts like it's not there" means the consumer sees the hand-authored
 *       surviving list, proven against parsePaint for a gradient.
 *   (5) The EQUATION wiring end to end through the real document pipeline:
 *       per-element `=`, a named-field cross reference, whole-list binding by
 *       reference, and the loud failures (wrong shape, whole element).
 *   (6) KEYFRAMING is untouched: a whole-list keyframe still tweens ELEMENT-WISE
 *       with no integer snapping, and a length change is still discrete.
 *
 * DOM-free (core/), so it runs in bare node.
 */

import assert from "node:assert/strict";
import {
  LIST_ORDERS, ELEMENT_STORAGE, LIST_ROW_KIND, ACTIVE_FIELD,
  checkListDeclaration, elementFields, elementFieldKind, elementStorageKey,
  elementFieldNameAt, elementFieldValue, withElementFieldValue, copiedElement,
  betweenFieldValue, extrapolatedFieldValue, insertedElement, canonicalOrder,
  elementActive, withElementActive, visibleElements, visibleIndices,
  withElementInserted, withElementPurged, indexAfterPurge, indexAfterInsert,
  listStoragePath, listLogicalPath, listPathKind, activeListPath, listSlotPaths,
} from "../core/lists.js";
import { PROPS, ROW_KINDS, NUMERIC_ROW_KINDS, GRADIENT_STOPS_LIST, MIN_GRADIENT_STOPS } from "../core/properties.js";
import {
  listDeclAt, listSlotKind, storedListPath, listResultProblem, listPropertyPaths,
  resultKindForSlot, resultMatchesKind, isNumericSlot, numericPropertyPaths, evaluateState,
} from "../core/expressions.js";
import { interpolate } from "../core/interpolators.js";
import { leaves } from "../core/deltas.js";
import { createRegistry } from "../core/registry.js";
import { allPlugins } from "../plugins/index.js";
import { keyframed, foldState, repairedDocument } from "../core/document.js";
import { parsePaint } from "../render_gpu/ir.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The two element shapes used throughout: a positional PAIR (polygon vertex) and
// a named RECORD (gradient stop). Taken from the REAL declarations wherever
// possible so the tests cannot pass against a shape the app does not ship.
const POINT_DECL = PROPS.points;
const POINT_EL = POINT_DECL.element;
const STOP_DECL = GRADIENT_STOPS_LIST;
const STOP_EL = STOP_DECL.element;
// A minimal ONE-FIELD tuple list, for the cases where a second coordinate would
// only add noise (the docstrings' own smallest examples).
const X_DECL = { kind: LIST_ROW_KIND, order: "sequence", activeKey: "xsActive", element: { storage: "tuple", fields: [{ name: "x", kind: "number" }] } };

const registry = createRegistry();
for (const p of allPlugins) registry.register(p);

// ── (1) THE DECLARATIONS + their guard ───────────────────────────────────────

test("vocabulary: LIST_ORDERS / ELEMENT_STORAGE / ACTIVE_FIELD (doctests)", () => {
  assert.equal(LIST_ORDERS.includes("sorted"), true);
  assert.equal(LIST_ORDERS.includes("keyed"), false);
  assert.deepEqual(ELEMENT_STORAGE, ["record", "tuple"]);
  assert.equal(ACTIVE_FIELD.name, "active");
  assert.equal(ACTIVE_FIELD.kind, "boolean");
  // The list kind joined the CLOSED control vocabulary rather than sitting beside it.
  assert.equal(ROW_KINDS.includes(LIST_ROW_KIND), true);
  assert.deepEqual(NUMERIC_ROW_KINDS, ["number", "angle"]);
});

test("the two shipped declarations are the two FLAVOURS, and say why", () => {
  // Gradient stops: SORTED on an absolute key → reordering is free.
  assert.equal(STOP_DECL.order, "sorted");
  assert.equal(STOP_DECL.orderKey, "offset");
  assert.equal(STOP_EL.storage, "record");
  assert.equal(STOP_DECL.minLength, MIN_GRADIENT_STOPS);
  // Polygon points: a SEQUENCE (order IS the outline) stored as PAIRS (the
  // int-rounding reason — see (6)), with no minimum (degenerate counts are legal).
  assert.equal(POINT_DECL.order, "sequence");
  assert.equal(POINT_DECL.orderKey, undefined);
  assert.equal(POINT_EL.storage, "tuple");
  assert.equal("minLength" in POINT_DECL, false);
  // Both carry the UNIVERSAL visibility companion, named after the list itself.
  assert.equal(POINT_DECL.activeKey, "pointsActive");
  assert.equal(STOP_DECL.activeKey, "stopsActive");
});

test("checkListDeclaration: accepts a good declaration, rejects each malformation (doctests)", () => {
  const ok = { kind: "list", order: "sequence", activeKey: "pointsActive", element: { storage: "tuple", fields: [{ name: "x", kind: "number" }] } };
  assert.equal(checkListDeclaration("points", ok, ["number"], ["number"]), undefined);
  const bad = (def, re) => assert.throws(() => checkListDeclaration("k", def, ["number", "color"], ["number"]), re);
  bad({ kind: "number" }, /is not a list declaration/);
  bad({ kind: "list", order: "sequence", activeKey: "kActive" }, /no `element` shape/);
  bad({ kind: "list", order: "sequence", activeKey: "kActive", element: { storage: "map", fields: [{ name: "x", kind: "number" }] } }, /element storage "map"/);
  bad({ kind: "list", order: "sequence", activeKey: "kActive", element: { storage: "tuple", fields: [] } }, /no fields/);
  bad({ kind: "list", order: "sequence", activeKey: "kActive", element: { storage: "tuple", fields: [{ name: "x", kind: "number" }, { name: "x", kind: "number" }] } }, /"x" twice/);
  bad({ kind: "list", order: "sequence", activeKey: "kActive", element: { storage: "tuple", fields: [{ name: "x", kind: "vector" }] } }, /kind "vector"/);
  // A HAND-DECLARED `active` field is rejected: visibility is universal + injected.
  bad({ kind: "list", order: "sequence", activeKey: "kActive", element: { storage: "record", fields: [{ name: "active", kind: "number" }] } }, /per-element visibility is UNIVERSAL/);
  bad({ kind: "list", order: "spiral", activeKey: "kActive", element: { storage: "tuple", fields: [{ name: "x", kind: "number" }] } }, /order "spiral"/);
  // SORTED needs an orderKey, it must name a real field, and that field must have an ordering.
  bad({ kind: "list", order: "sorted", activeKey: "kActive", element: { storage: "record", fields: [{ name: "offset", kind: "number" }] } }, /no orderKey/);
  bad({ kind: "list", order: "sorted", orderKey: "nope", activeKey: "kActive", element: { storage: "record", fields: [{ name: "offset", kind: "number" }] } }, /not one of its element fields/);
  bad({ kind: "list", order: "sorted", orderKey: "color", activeKey: "kActive", element: { storage: "record", fields: [{ name: "color", kind: "color" }] } }, /has no ordering/);
  bad({ kind: "list", order: "sequence", orderKey: "x", activeKey: "kActive", element: { storage: "tuple", fields: [{ name: "x", kind: "number" }] } }, /only a sorted list/);
  bad({ kind: "list", order: "sequence", activeKey: "kActive", minLength: -1, element: { storage: "tuple", fields: [{ name: "x", kind: "number" }] } }, /minLength/);
  bad({ kind: "list", order: "sequence", element: { storage: "tuple", fields: [{ name: "x", kind: "number" }] } }, /no `activeKey`/);
});

test("the import-time guard runs over EVERY registered plugin row, not a sample", () => {
  // A list row anywhere in the app must satisfy checkListDeclaration — the same
  // breadth tests/row_kinds_test.js applies to the kind vocabulary.
  let listRows = 0;
  for (const plugin of allPlugins)
    for (const row of plugin.inspector ?? [])
      if (row.kind === LIST_ROW_KIND) {
        checkListDeclaration(`${plugin.type}."${row.key}"`, row, ROW_KINDS, NUMERIC_ROW_KINDS);
        assert.equal(row.activeKey, `${row.key}Active`, `${plugin.type}."${row.key}" companion must be named after the list`);
        listRows++;
      }
  // Zero is a legitimate count while the Inspector list CONTROL is unbuilt; the
  // point is that any row that appears is validated the moment it does.
  assert.ok(listRows >= 0);
});

// ── (2) ELEMENT SHAPE accessors (doctests) ───────────────────────────────────

test("element accessors: fields / kinds / storage keys, both storage forms (doctests)", () => {
  assert.deepEqual(elementFields(POINT_EL).map((f) => f.name), ["x", "y"]);
  assert.deepEqual(elementFields(STOP_EL).map((f) => f.name), ["offset", "color"]);
  assert.equal(elementFieldKind(STOP_EL, "color"), "color");
  assert.equal(elementFieldKind(STOP_EL, "nope"), null);
  assert.equal(elementFieldKind(POINT_EL, "y"), "number");
  // A RECORD field's storage key IS its name; a TUPLE field's is its position.
  assert.equal(elementStorageKey(STOP_EL, "color"), "color");
  assert.equal(elementStorageKey(POINT_EL, "y"), 1);
  assert.equal(elementStorageKey(POINT_EL, "x"), 0);
  assert.throws(() => elementStorageKey(POINT_EL, "z"), /no element field named "z"/);
  // The inverse accepts the numeric-STRING a path walked out of a document carries.
  assert.equal(elementFieldNameAt(POINT_EL, 1), "y");
  assert.equal(elementFieldNameAt(POINT_EL, "0"), "x");
  assert.equal(elementFieldNameAt(STOP_EL, "offset"), "offset");
  assert.equal(elementFieldNameAt(POINT_EL, 7), null);
  assert.equal(elementFieldNameAt(STOP_EL, "nope"), null);
});

test("element read/write is copy-on-write in both storage forms (doctests)", () => {
  assert.equal(elementFieldValue(POINT_EL, [0.25, 0.75], "y"), 0.75);
  assert.equal(elementFieldValue(STOP_EL, { offset: 0.4, color: "#000000" }, "offset"), 0.4);
  const pair = [0.25, 0.75];
  assert.deepEqual(withElementFieldValue(POINT_EL, pair, "x", 0.5), [0.5, 0.75]);
  assert.deepEqual(pair, [0.25, 0.75], "the source element must not be mutated");
  const stop = { offset: 0, color: "#ff0000" };
  assert.deepEqual(withElementFieldValue(STOP_EL, stop, "offset", 0.3), { offset: 0.3, color: "#ff0000" });
  assert.deepEqual(stop, { offset: 0, color: "#ff0000" });
  const copiedPair = copiedElement(POINT_EL, pair);
  assert.deepEqual(copiedPair, pair);
  assert.notEqual(copiedPair, pair, "copiedElement must return a NEW array");
  const copiedStop = copiedElement(STOP_EL, stop);
  assert.deepEqual(copiedStop, stop);
  assert.notEqual(copiedStop, stop);
});

// ── (3) INSERT-BETWEEN, and the INTEGER TRAP ─────────────────────────────────

test("THE INTEGER TRAP: interpolate() rounds an int pair, so insert-between must NOT use it", () => {
  // The trap, demonstrated on the real interpolator: a gradient's DEFAULT stops
  // are offsets 0 and 1 — both integers — so interpolate's tweenline int rule
  // rounds their midpoint to 1, i.e. a DUPLICATE of the neighbour.
  assert.equal(interpolate(0, 1, 0.5), 1);
  assert.deepEqual(interpolate({ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }, 0.5), { offset: 1, color: "#808080" });
  // betweenFieldValue lerps numbers CONTINUOUSLY instead, so the midpoint lands
  // strictly between — which is the entire point of the gesture.
  assert.equal(betweenFieldValue(0, 1), 0.5);
  assert.equal(betweenFieldValue(0.25, 0.75), 0.5);
  // Non-numbers still go through interpolate: a colour blends per-channel, and
  // any unlike pair is discrete (snaps to the target at alpha > 0).
  assert.equal(betweenFieldValue("#000000", "#ffffff"), "#808080");
  assert.equal(betweenFieldValue("a", "b"), "b");
  assert.equal(betweenFieldValue(true, false), false);
  // A TUPLE of coordinates never hit the trap even before this, because
  // interpolate's pure-numeric-array branch does not round — insert-between
  // agrees with it exactly, so the two paths cannot disagree about a midpoint.
  assert.deepEqual(interpolate([0, 0], [1, 1], 0.5), [0.5, 0.5]);
});

test("extrapolatedFieldValue: numbers reflect and CLAMP, other kinds copy the edge (doctests)", () => {
  assert.equal(extrapolatedFieldValue(1, 0.5, {}), 1.5);
  assert.equal(extrapolatedFieldValue(1, 0.5, { min: 0, max: 1 }), 1);
  assert.equal(extrapolatedFieldValue(0, 0.5, { min: 0, max: 1 }), 0);
  assert.equal(extrapolatedFieldValue("#ff0000", "#00ff00", {}), "#ff0000");
});

test("insertedElement: between / at either end / lone element / empty (doctests)", () => {
  const stops = [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }];
  assert.deepEqual(insertedElement(STOP_DECL, stops, 1), { offset: 0.5, color: "#808080" });
  // The user's own analogy: an in-between, exactly like a slide tween's midpoint.
  const pts = [[0, 0], [1, 0], [1, 1]];
  assert.deepEqual(insertedElement(POINT_DECL, pts, 2), [1, 0.5], "splits the edge it was inserted into, at its midpoint");
  assert.deepEqual(insertedElement(POINT_DECL, pts, 1), [0.5, 0]);
  // AT AN END: numbers reflect the outermost step, clamped to declared bounds; a
  // colour copies the edge (there is no "beyond" for a colour).
  const half = [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ffffff" }];
  assert.deepEqual(insertedElement(STOP_DECL, half, 2), { offset: 1, color: "#ffffff" });
  assert.deepEqual(insertedElement(STOP_DECL, half, 0), { offset: 0, color: "#000000" });
  // A polygon's unbounded coordinates really do continue the last edge.
  assert.deepEqual(insertedElement(POINT_DECL, [[0, 0], [0.25, 0]], 2), [0.5, 0]);
  // A LONE element is copied (nothing to extrapolate from); an EMPTY list throws.
  assert.deepEqual(insertedElement(POINT_DECL, [[7, 8]], 1), [7, 8]);
  assert.notEqual(insertedElement(POINT_DECL, [[7, 8]], 1), undefined);
  assert.throws(() => insertedElement(POINT_DECL, [], 0), /empty list has no element to interpolate from/);
  assert.throws(() => insertedElement(POINT_DECL, pts, 9), /outside 0\.\.3/);
});

// ── (4) THE TWO FLAVOURS: canonical order ────────────────────────────────────

test("canonicalOrder: a SORTED list re-sorts (stably); a SEQUENCE is identity (doctests)", () => {
  const unsorted = [{ offset: 0.8, color: "#ffffff" }, { offset: 0.2, color: "#000000" }];
  assert.deepEqual(canonicalOrder(STOP_DECL, unsorted), [{ offset: 0.2, color: "#000000" }, { offset: 0.8, color: "#ffffff" }]);
  // STABLE: equal keys keep their relative order, so the result is deterministic.
  const tied = [{ offset: 0.5, color: "#111111" }, { offset: 0.5, color: "#222222" }];
  assert.deepEqual(canonicalOrder(STOP_DECL, tied).map((s) => s.color), ["#111111", "#222222"]);
  // An already-canonical list is returned BY IDENTITY (no copy).
  const sorted = [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }];
  assert.equal(canonicalOrder(STOP_DECL, sorted), sorted);
  // A SEQUENCE is never reordered — its order IS the polygon.
  const seq = [[3, 0], [1, 0]];
  assert.equal(canonicalOrder(POINT_DECL, seq), seq);
  assert.deepEqual(canonicalOrder(POINT_DECL, seq), [[3, 0], [1, 0]]);
});

test("SORTED means 'they just swap': editing one key past another trades places", () => {
  // The user's request, mechanized: stop 0's offset is dragged past stop 1's.
  const stops = [{ offset: 0.2, color: "#ff0000" }, { offset: 0.8, color: "#0000ff" }];
  const moved = stops.map((s, i) => (i === 0 ? { ...s, offset: 0.9 } : s));
  assert.deepEqual(canonicalOrder(STOP_DECL, moved), [{ offset: 0.8, color: "#0000ff" }, { offset: 0.9, color: "#ff0000" }]);
});

test("SORTED is CANONICALIZED ON WRITE because the render path consumes ORDER", () => {
  // MEASURED (see .frenzy/list_kind/gradient_order_mechanism.js): Skia pins each
  // stop position to >= the previous one, so an out-of-order array COLLAPSES a
  // stop instead of swapping it. parsePaint is where the stored order reaches the
  // backends, and it does NOT sort — proving the canonicalization must happen on
  // write, not in the renderer.
  const outOfOrder = [{ offset: 0.5, color: "#00ff00" }, { offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }];
  const asRendered = parsePaint({ type: "linearGradient", linear: { stops: outOfOrder, angle: 0 } });
  assert.deepEqual(asRendered.stops.map((s) => s.offset), [0.5, 0, 1], "parsePaint preserves array order verbatim (it does not sort)");
  const canonical = parsePaint({ type: "linearGradient", linear: { stops: canonicalOrder(STOP_DECL, outOfOrder), angle: 0 } });
  assert.deepEqual(canonical.stops.map((s) => s.offset), [0, 0.5, 1]);
  assert.notDeepEqual(asRendered.stops, canonical.stops, "so the two render differently — order is load-bearing");
});

// ── (5) HIDE vs PURGE ────────────────────────────────────────────────────────

test("elementActive: absent / short / non-false all read VISIBLE (doctests)", () => {
  assert.equal(elementActive(undefined, 3), true);
  assert.equal(elementActive([true, false], 1), false);
  assert.equal(elementActive([true, false], 5), true);
  assert.equal(elementActive([null], 0), true);
  // The sparse-keyframe encoding (a numeric-keyed object) reads identically.
  assert.equal(elementActive({ 1: false }, 1), false);
  assert.equal(elementActive({ 1: false }, 0), true);
});

test("withElementActive HIDES without renumbering, and canonicalizes the companion (doctests)", () => {
  const value = { list: [[0, 0], [1, 0], [1, 1]] };
  const hidden = withElementActive(POINT_DECL, value, 1, false);
  assert.deepEqual(hidden.active, [true, false, true]);
  // THE INVARIANT: the element list is returned BY IDENTITY — nothing moved, so
  // every equation bound to `points.2.x` still names the same vertex.
  assert.equal(hidden.list, value.list);
  assert.deepEqual(withElementActive(POINT_DECL, { list: [[0, 0], [1, 0]], active: [true, false] }, 1, true).active, [true, true]);
  // A sparse-object companion is normalized to a full array on any write.
  assert.deepEqual(withElementActive(POINT_DECL, { list: [[0], [1], [2]], active: { 2: false } }, 0, false).active, [false, true, false]);
  assert.throws(() => withElementActive(POINT_DECL, value, 9, false), /outside a 3-element list/);
});

test("visibleElements / visibleIndices: 'acts like it's not there' (doctests)", () => {
  const pts = { list: [[0, 0], [1, 0], [1, 1]], active: [true, false, true] };
  assert.deepEqual(visibleElements(POINT_DECL, pts), [[0, 0], [1, 1]]);
  assert.deepEqual(visibleIndices(pts), [0, 2]);
  const stops = { list: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#0000ff" }], active: [true, false, true] };
  assert.deepEqual(visibleElements(STOP_DECL, stops), [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }]);
  // Nothing hidden → the input list BY IDENTITY (allocates nothing).
  const allOn = { list: [[0], [1]] };
  assert.equal(visibleElements(POINT_DECL, allOn), allOn.list);
  assert.deepEqual(visibleIndices(allOn), [0, 1]);
  // The sparse encoding works here too.
  assert.deepEqual(visibleElements(POINT_DECL, { list: [[0], [1], [2]], active: { 1: false } }), [[0], [2]]);
});

test("RENDER PROOF: a hidden gradient stop is byte-identical to never authoring it", () => {
  const three = { list: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#0000ff" }], active: [true, false, true] };
  const handAuthored = [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }];
  // The consumer's INPUT is identical…
  assert.deepEqual(visibleElements(STOP_DECL, three), handAuthored);
  // …so what reaches the backends is identical: the ramp interpolates between the
  // SURVIVING NEIGHBOURS, with no transparent hole (the hidden stop never reaches
  // normalizeStops at all).
  const filtered = parsePaint({ type: "linearGradient", linear: { stops: visibleElements(STOP_DECL, three), angle: 0 } });
  const authored = parsePaint({ type: "linearGradient", linear: { stops: handAuthored, angle: 0 } });
  assert.deepEqual(filtered, authored);
  // And the hidden stop's stored value is UNTOUCHED, so unhiding restores it exactly.
  assert.deepEqual(three.list[1], { offset: 0.5, color: "#00ff00" });
});

test("RENDER PROOF: a hidden polygon vertex makes the chain close over it", () => {
  // A square with vertex 1 hidden is exactly the TRIANGLE through the survivors —
  // the edge runs from the previous surviving vertex straight to the next.
  const square = { list: [[0, 0], [1, 0], [1, 1], [0, 1]], active: [true, false, true, true] };
  assert.deepEqual(visibleElements(POINT_DECL, square), [[0, 0], [1, 1], [0, 1]]);
  // The stored coordinates of the hidden vertex survive untouched.
  assert.deepEqual(square.list[1], [1, 0]);
});

test("HIDING respects both flavours: no order key touched, no index shifted", () => {
  // SORTED: hiding writes only the companion, so the order key is untouched and
  // the canonical order cannot move.
  const stops = { list: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#888888" }, { offset: 1, color: "#ffffff" }] };
  const hidden = withElementActive(STOP_DECL, stops, 1, false);
  assert.deepEqual(hidden.list, stops.list);
  assert.equal(canonicalOrder(STOP_DECL, hidden.list), hidden.list, "still canonical: nothing was reordered");
  // SEQUENCE: index stability is the load-bearing part for equations.
  const pts = { list: [[0, 0], [1, 0], [1, 1], [0, 1]] };
  assert.equal(withElementActive(POINT_DECL, pts, 0, false).list, pts.list);
});

test("PURGE is the destructive one: it splices, renumbers, and honours minLength (doctests)", () => {
  assert.deepEqual(withElementPurged(POINT_DECL, { list: [[0], [1], [2]] }, 1), { list: [[0], [2]], active: undefined });
  assert.deepEqual(withElementPurged(POINT_DECL, { list: [[0], [1], [2]], active: [true, false, true] }, 0), { list: [[1], [2]], active: [false, true] });
  assert.throws(() => withElementPurged(POINT_DECL, { list: [[0]] }, 5), /outside a 1-element list/);
  // A gradient may not go below two stops — normalizeStops throws there, so the
  // X affordance refuses instead of producing a document the renderer rejects.
  assert.throws(
    () => withElementPurged(STOP_DECL, { list: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, 0),
    /below the declared minimum of 2/,
  );
  assert.throws(() => parsePaint({ type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000000" }], angle: 0 } }), /needs >= 2 stops/);
});

test("insert/purge RENUMBER; the index remaps are pure and say where an element went (doctests)", () => {
  assert.deepEqual(withElementInserted(POINT_DECL, { list: [[0, 0], [1, 1]] }, 1), { list: [[0, 0], [0.5, 0.5], [1, 1]], active: undefined });
  assert.deepEqual(withElementInserted(X_DECL, { list: [[0], [2]], active: [false, true] }, 1), { list: [[0], [1], [2]], active: [false, true, true] });
  const insertedStops = withElementInserted(STOP_DECL, { list: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, 1);
  assert.deepEqual(insertedStops.list, [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#808080" }, { offset: 1, color: "#ffffff" }]);
  // A sorted insert is already canonical by construction (the new key is between
  // its neighbours), so canonicalOrder does not move it.
  assert.equal(canonicalOrder(STOP_DECL, insertedStops.list), insertedStops.list);
  assert.equal(indexAfterPurge(5, 2), 4);
  assert.equal(indexAfterPurge(1, 2), 1);
  assert.equal(indexAfterPurge(2, 2), null);
  assert.equal(indexAfterInsert(5, 2), 6);
  assert.equal(indexAfterInsert(1, 2), 1);
  assert.equal(indexAfterInsert(2, 2), 3);
});

// ── (6) ADDRESSING: named fields over positional storage ─────────────────────

test("listStoragePath / listLogicalPath are inverse, and the ONE conversion point (doctests)", () => {
  assert.deepEqual(listStoragePath(POINT_DECL, [3, "y"]), [3, 1]);
  assert.deepEqual(listStoragePath(STOP_DECL, [2, "offset"]), [2, "offset"]);
  assert.deepEqual(listStoragePath(POINT_DECL, [3]), [3]);
  assert.deepEqual(listStoragePath(POINT_DECL, []), []);
  assert.deepEqual(listLogicalPath(POINT_DECL, [3, 1]), [3, "y"]);
  assert.deepEqual(listLogicalPath(STOP_DECL, [2, "offset"]), [2, "offset"]);
  assert.deepEqual(listLogicalPath(POINT_DECL, [3, 9]), [3, 9]);
  // Round-trip over every declared field of both shapes.
  for (const [decl, el] of [[POINT_DECL, POINT_EL], [STOP_DECL, STOP_EL]])
    for (const field of el.fields)
      assert.deepEqual(listLogicalPath(decl, listStoragePath(decl, [4, field.name])), [4, field.name]);
});

test("listPathKind: list / element field (either spelling) / whole element (doctests)", () => {
  assert.equal(listPathKind(POINT_DECL, []), "list");
  assert.equal(listPathKind(POINT_DECL, [3, "y"]), "number");
  assert.equal(listPathKind(POINT_DECL, [3, 1]), "number");
  assert.equal(listPathKind(STOP_DECL, [0, "color"]), "color");
  assert.equal(listPathKind(POINT_DECL, [3]), null);
  assert.equal(listPathKind(STOP_DECL, [0, "nope"]), null);
});

test("activeListPath / listSlotPaths: visibility leads each element's slots (doctests)", () => {
  assert.deepEqual(activeListPath(POINT_DECL, ["points"]), ["pointsActive"]);
  assert.deepEqual(activeListPath(STOP_DECL, ["fill", "linear", "stops"]), ["fill", "linear", "stopsActive"]);
  assert.deepEqual(listSlotPaths(POINT_DECL, [[0, 1]], ["points"]), [
    { index: 0, field: "active", kind: "boolean", path: ["pointsActive", 0], address: "pointsActive.0" },
    { index: 0, field: "x", kind: "number", path: ["points", 0, 0], address: "points.0.x" },
    { index: 0, field: "y", kind: "number", path: ["points", 0, 1], address: "points.0.y" },
  ]);
  assert.deepEqual(
    listSlotPaths(STOP_DECL, [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], ["fill", "linear", "stops"]).map((s) => s.address),
    [
      "fill.linear.stopsActive.0", "fill.linear.stops.0.offset", "fill.linear.stops.0.color",
      "fill.linear.stopsActive.1", "fill.linear.stops.1.offset", "fill.linear.stops.1.color",
    ],
  );
  // Every slot's `path` is a plain state path, which is what makes per-element
  // visibility KEYFRAMABLE like any other leaf (proved end to end below).
  for (const slot of listSlotPaths(POINT_DECL, [[0, 0], [1, 1]], ["points"]))
    assert.ok(Array.isArray(slot.path) && slot.path.length >= 2);
});

// ── (7) THE EQUATION WIRING (core/expressions.js) ────────────────────────────

test("listDeclAt: resolves both sources and both companions (doctests)", () => {
  assert.deepEqual(listDeclAt(["points"]).rel, []);
  assert.equal(listDeclAt(["points"]).companion, false);
  assert.deepEqual(listDeclAt(["points", 3, "x"]).rel, [3, "x"]);
  assert.equal(listDeclAt(["pointsActive", 2]).companion, true);
  assert.deepEqual(listDeclAt(["fill", "linear", "stops", 1, "offset"]).rel, [1, "offset"]);
  assert.equal(listDeclAt(["fill", "linear", "stops"]).decl, GRADIENT_STOPS_LIST);
  assert.equal(listDeclAt(["fill", "linear", "stopsActive", 1]).companion, true);
  // The LEGACY inline gradient form (no linear/radial wrapper) resolves too.
  assert.deepEqual(listDeclAt(["background", "stops", 0, "color"]).rel, [0, "color"]);
  assert.equal(listDeclAt(["stroke", "radial", "stops"]).decl, GRADIENT_STOPS_LIST);
  assert.equal(listDeclAt(["w"]), null);
  assert.equal(listDeclAt(["shadow", "color"]), null);
});

test("listSlotKind: every level types as what it IS (doctests)", () => {
  assert.equal(listSlotKind(["points"]), "list");
  assert.equal(listSlotKind(["points", 3, "x"]), "number");
  assert.equal(listSlotKind(["points", 3, 0]), "number");
  assert.equal(listSlotKind(["points", 3]), null);
  assert.equal(listSlotKind(["pointsActive", 2]), "boolean");
  assert.equal(listSlotKind(["pointsActive"]), "list");
  assert.equal(listSlotKind(["fill", "linear", "stops", 0, "color"]), "color");
  assert.equal(listSlotKind(["opacity"]), null);
});

test("resultKindForSlot: the whole list, an element field, a whole element, a flag (doctests)", () => {
  const p = { defaults: {} };
  assert.equal(resultKindForSlot(p, ["points"], "= other_poly.points"), "list");
  assert.equal(resultKindForSlot(p, ["points", 9, "x"], "= self.w / 2"), "number");
  assert.equal(resultKindForSlot(p, ["points", 9, 1], "= 1"), "number");
  assert.equal(resultKindForSlot(p, ["pointsActive", 2], "= false"), "boolean");
  assert.equal(resultKindForSlot(p, ["fill", "linear", "stops", 4, "offset"], "= 0.5"), "number");
  assert.equal(resultKindForSlot(p, ["fill", "linear", "stops", 4, "color"], "= #ff0000"), "color");
  // A whole ELEMENT is the ONE rejection, and it is loud with a pointer (below).
  assert.equal(resultKindForSlot(p, ["points", 9], "= 1"), "unresolved");
});

test("INDEX-INDEPENDENCE: element 9 of a five-element default types like element 0", () => {
  // This is the whole reason the ELEMENT SHAPE is declared. Reading the kind off
  // the plugin's DEFAULT list (the old accidental typing) runs out of elements:
  const polygon = registry.get("polygon");
  assert.equal(polygon.defaults.points.length, 5, "the default is a pentagon");
  for (const index of [0, 4, 9, 137])
    for (const field of ["x", "y"]) {
      assert.equal(resultKindForSlot(polygon, ["points", index, field], "= 1"), "number", `points.${index}.${field}`);
      assert.equal(isNumericSlot(polygon, ["points", index, field]), true);
    }
  assert.equal(isNumericSlot(polygon, ["points"]), false, "the list itself is not a number slot");
});

test("resultMatchesKind + listResultProblem: two-part LOUD validation (doctests)", () => {
  assert.equal(resultMatchesKind([[0, 0], [1, 1]], "list"), true);
  assert.equal(resultMatchesKind(5, "list"), false);
  assert.equal(listResultProblem(POINT_DECL, [[0, 0], [1, 1]]), null);
  assert.equal(listResultProblem(POINT_DECL, 5), "is not a list");
  assert.equal(listResultProblem(POINT_DECL, [[0, 0], ["nope", 1]]), 'element 1\'s "x" is "nope", not a valid number');
  assert.equal(listResultProblem(POINT_DECL, [[0, 0], { x: 1, y: 1 }]), 'element 1 is {"x":1,"y":1}, not a tuple');
  assert.equal(listResultProblem(STOP_DECL, [{ offset: 0, color: "#000000" }]), "has 1 element, below the declared minimum of 2");
  assert.equal(listResultProblem(STOP_DECL, [{ offset: 0, color: "nope" }, { offset: 1, color: "#ffffff" }]), 'element 0\'s "color" is "nope", not a valid color');
});

test("storedListPath: the named form converts, the raw index passes through (doctests)", () => {
  assert.deepEqual(storedListPath(["points", "3", "x"]), ["points", "3", 0]);
  assert.deepEqual(storedListPath(["points", "3", "0"]), ["points", "3", "0"]);
  assert.deepEqual(storedListPath(["fill", "linear", "stops", "1", "offset"]), ["fill", "linear", "stops", "1", "offset"]);
  assert.deepEqual(storedListPath(["w"]), ["w"]);
});

test("listPropertyPaths offers the list ROOT; numericPropertyPaths is UNCHANGED (doctests)", () => {
  assert.deepEqual(listPropertyPaths({ defaults: { points: [[0, 0]], w: 10 } }), ["points"]);
  assert.deepEqual(listPropertyPaths({ defaults: { w: 10 } }), []);
  assert.deepEqual(listPropertyPaths(registry.get("polygon")), ["points"]);
  // The type-level autocomplete deliberately does NOT gain per-element paths: a
  // `points.4.x` suggestion would be wrong for a 3-vertex polygon, and a
  // reference to a missing element fails loudly. The Inspector enumerates the real
  // ones from the VALUE (listSlotPaths).
  const offered = numericPropertyPaths(registry.get("polygon"));
  assert.equal(offered.some((path) => path.startsWith("points")), false);
});

test("leaves() STILL keeps arrays opaque — the blast-radius decision, pinned", () => {
  // The descent into declared lists is a SEPARATE walk, NOT a change to leaves(),
  // because three other consumers depend on arrays staying opaque. The worst is
  // core/document.js missingDefaults: with an array-descending leaves() a
  // 3-vertex polygon would look like it were "missing" the 4th and 5th vertices of
  // the plugin's 5-vertex DEFAULT and have them filled in — silently appending
  // vertices to the user's shape.
  const paths = leaves({ points: [[0, 0], [1, 1]], w: 10 }).map(([path]) => path.join("."));
  assert.deepEqual(paths, ["points", "w"], "an array is ONE leaf");
  const polygon = registry.get("polygon");
  const defaultLeaves = leaves(polygon.defaults).map(([path]) => path.join("."));
  assert.equal(defaultLeaves.includes("points"), true);
  assert.equal(defaultLeaves.some((path) => path.startsWith("points.")), false);
});

// ── (8) END TO END through the real document pipeline ────────────────────────

const oneSlideDoc = (items) => repairedDocument({
  meta: { version: 1 },
  slides: [{ id: "s0", name: "One", transition: { type: "cut", seconds: 0, curve: "linear" }, delta: { items } }],
}, registry).doc;

const poly = (extra) => ({ type: "polygon", x: 0, y: 0, w: 200, h: 100, closed: true, points: [[0, 0], [1, 0], [1, 1], [0, 1]], ...extra });

const evaluated = (items) => evaluateState(foldState(oneSlideDoc(items), 0, 1), registry);

test("E2E: a per-element `=` evaluates, and the LIST KEEPS ITS ARRAY SHAPE", () => {
  const ev = evaluated({ p: poly({ points: [[0, 0], [1, 0], ["= self.h / self.w", 1], [0, 1]] }) });
  assert.deepEqual([...ev.errors.keys()], []);
  const points = ev.state.items.p.points;
  assert.ok(Array.isArray(points), "the evaluated list must still be an ARRAY");
  assert.deepEqual(points, [[0, 0], [1, 0], [0.5, 1], [0, 1]]);
});

test("E2E: a per-element equation may REFERENCE another element by its named field", () => {
  const ev = evaluated({ p: poly({ points: [[0.25, 0], [1, 0], ["= self.points.0.x * 2", 1], [0, 1]] }) });
  assert.deepEqual([...ev.errors.values()], []);
  assert.deepEqual(ev.state.items.p.points[2], [0.5, 1]);
});

test("E2E: a WHOLE LIST binds by reference (the only list-valued expression there is)", () => {
  const ev = evaluated({
    a: poly({ name: "Source", points: [[0.1, 0.2], [0.9, 0.2], [0.5, 0.8]] }),
    b: poly({ name: "Mirror", points: "= source.points" }),
  });
  assert.deepEqual([...ev.errors.values()], []);
  assert.deepEqual(ev.state.items.b.points, [[0.1, 0.2], [0.9, 0.2], [0.5, 0.8]]);
});

test("E2E: a whole-list read SETTLES the equations inside the list first", () => {
  const ev = evaluated({
    a: poly({ name: "Source", points: [["= 0.25 + 0.25", 0.2], [0.9, 0.2], [0.5, 0.8]] }),
    b: poly({ name: "Mirror", points: "= source.points" }),
  });
  assert.deepEqual([...ev.errors.values()], []);
  assert.deepEqual(ev.state.items.b.points, [[0.5, 0.2], [0.9, 0.2], [0.5, 0.8]]);
});

test("E2E: a wrong-shaped whole-list result is REPORTED and falls back (never rendered)", () => {
  const ev = evaluated({ p: poly({ points: "= self.w" }) });
  assert.match([...ev.errors.values()][0], /is not a list/);
  // The fallback is the plugin default — a real list, so nothing downstream breaks.
  assert.deepEqual(ev.state.items.p.points, registry.get("polygon").defaults.points);
});

test("E2E: a whole ELEMENT `=` is the ONE rejection, and it points at the fields", () => {
  const ev = evaluated({ p: poly({ points: [[0, 0], "= 1", [1, 1]] }) });
  const message = [...ev.errors.values()][0];
  assert.match(message, /whole list ELEMENT/);
  assert.match(message, /bind one of its fields instead \(x, y\)/);
});

test("E2E: per-element VISIBILITY is an equation slot AND a keyframable leaf", () => {
  const ev = evaluated({ p: poly({ pointsActive: [true, "= false", true, true] }) });
  assert.deepEqual([...ev.errors.values()], []);
  assert.deepEqual(ev.state.items.p.pointsActive, [true, false, true, true]);
  // KEYFRAMED: visible on slide 0, hidden on slide 1 — a boolean keyframe on the
  // companion path, needing no machinery beyond listSlotPaths' plain state paths.
  let doc = oneSlideDoc({ p: poly({ pointsActive: [true, true, true, true] }) });
  doc = { ...doc, slides: [...doc.slides, { id: "s1", name: "Two", transition: { type: "cut", seconds: 0, curve: "linear" }, delta: {} }] };
  doc = keyframed(doc, 1, ["items", "p", "pointsActive", 1], false);
  assert.deepEqual(foldState(doc, 0, 1).items.p.pointsActive, [true, true, true, true]);
  assert.deepEqual(foldState(doc, 1, 1).items.p.pointsActive, [true, false, true, true]);
  // A visibility change is DISCRETE mid-tween (a boolean thresholds), never half-hidden.
  assert.equal(foldState(doc, 1, 0.5).items.p.pointsActive[1], false);
});

test("E2E: HIDING does not disturb a per-element equation bound to a LATER element", () => {
  const ev = evaluated({ p: poly({ points: [[0, 0], [1, 0], ["= 0.75", 1], [0, 1]], pointsActive: [true, false, true, true] }) });
  assert.deepEqual([...ev.errors.values()], []);
  assert.deepEqual(ev.state.items.p.points[2], [0.75, 1], "points.2.x still names the same vertex");
});

test("E2E: a GRADIENT STOP's offset and colour are equation slots", () => {
  const ev = evaluated({
    r: {
      type: "rect", x: 0, y: 0, w: 100, h: 100,
      fill: { type: "linearGradient", solid: "#ff0000", linear: { stops: [{ offset: 0, color: "#000000" }, { offset: "= 0.25 * 2", color: "= #00ff00" }], angle: 0 } },
    },
  });
  assert.deepEqual([...ev.errors.values()], []);
  assert.deepEqual(ev.state.items.r.fill.linear.stops, [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#00ff00" }]);
  // …and the result really does reach the renderer as a valid gradient.
  assert.equal(parsePaint(ev.state.items.r.fill).stops.length, 2);
});

// ── (9) KEYFRAMING IS UNTOUCHED ──────────────────────────────────────────────

test("KEYFRAMING: a whole-list keyframe still tweens ELEMENT-WISE with no int snapping", () => {
  let doc = oneSlideDoc({ p: poly({ points: [[0, 0], [1, 0], [1, 1], [0, 1]] }) });
  doc = { ...doc, slides: [...doc.slides, { id: "s1", name: "Two", transition: { type: "cut", seconds: 1, curve: "linear" }, delta: {} }] };
  doc = keyframed(doc, 1, ["items", "p", "points"], [[0, 0], [1, 0], [1, 1], [0.5, 1]]);
  // The 0 → 0.5 coordinate lerps continuously; the 0 and 1 corners do NOT snap
  // (the pure-numeric-array branch, which is why points are PAIRS).
  assert.deepEqual(foldState(doc, 1, 0.5).items.p.points, [[0, 0], [1, 0], [1, 1], [0.25, 1]]);
  assert.deepEqual(foldState(doc, 1, 0.25).items.p.points[3], [0.125, 1]);
  assert.deepEqual(foldState(doc, 1, 1).items.p.points[3], [0.5, 1]);
});

test("KEYFRAMING: a LENGTH change is still DISCRETE (structural keyframing)", () => {
  let doc = oneSlideDoc({ p: poly({ points: [[0, 0], [1, 0], [1, 1]] }) });
  doc = { ...doc, slides: [...doc.slides, { id: "s1", name: "Two", transition: { type: "cut", seconds: 1, curve: "linear" }, delta: {} }] };
  doc = keyframed(doc, 1, ["items", "p", "points"], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  assert.equal(foldState(doc, 1, 0.5).items.p.points.length, 4, "no half-built intermediate list");
  assert.deepEqual(foldState(doc, 1, 0.5).items.p.points, [[0, 0], [1, 0], [1, 1], [0, 1]]);
});

test("KEYFRAMING: a SPARSE per-element keyframe merges into the array (never over it)", () => {
  let doc = oneSlideDoc({ p: poly({ points: [[0, 0], [1, 0], [1, 1], [0, 1]] }) });
  doc = { ...doc, slides: [...doc.slides, { id: "s1", name: "Two", transition: { type: "cut", seconds: 1, curve: "linear" }, delta: {} }] };
  doc = keyframed(doc, 1, ["items", "p", "points", 2, 0], 0.5);
  const folded = foldState(doc, 1, 1).items.p.points;
  assert.ok(Array.isArray(folded));
  assert.deepEqual(folded, [[0, 0], [1, 0], [0.5, 1], [0, 1]], "the other vertices survive");
});

console.log(`\n${passed} list tests passed`);
