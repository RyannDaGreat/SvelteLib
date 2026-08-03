/**
 * WORKSTREAM UU — the SELECTION decides who a properties paste lands on, and the
 * paste button says what it is about to do.
 * Run: node src/demo_apps/PowerRP/tests/paste_targeting_test.js
 *
 * THE RULING under test (user, 2026-08-02, verbatim): "How that works is
 * determined by Whether or not I have a selection If I have no selection it will
 * just paste It will just paste the properties given the ones that I copied
 * individually object per object But if I select an object it will paste the
 * properties into that object Given the intersection of whatever is possible to
 * be pasted into it. So for example not mismatching data types"
 *
 * The first clause is a REGRESSION PIN and is treated as one: the no-selection
 * path must be untouched, and the test asserts identity rather than equality
 * because "produces the same result today" is weaker than "is the same object".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  itemPropertiesPayload, itemPropertiesDelta, retargetedState, retargetedPayload,
  retargetRefusal, retargetReport, rowsByKey, UNRETARGETABLE_KEYS,
} from "../core/item_properties_clipboard.js";
import { sameRowContract } from "../core/multiselect.js";
import { createRegistry } from "../core/registry.js";
import { allPlugins } from "../plugins/index.js";
import {
  clipboardKind, propertySubsetKind, pasteBadge, pasteIntent, subsetNoun,
  PASTE_BADGES, SUBSET_KEY_SETS,
} from "../web/pasteAffordance.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The two widgets the ruling's example is about: both boxed (so x/y are the same
// row on both — they compose the same `transform` bundle in the real registry),
// but with genuinely different shape knobs.
const RECT = {
  type: "rect",
  inspector: [
    { key: "x", kind: "number", label: "X" },
    { key: "y", kind: "number", label: "Y" },
    { key: "cornerRadius", kind: "number", min: 0, label: "Corner Radius" },
    { key: "fill", kind: "color", paint: true },
  ],
};
const CIRCLE = {
  type: "circle",
  inspector: [
    // Same contract as RECT's, different LABEL and HELP — the presentational
    // aspects the identity relation is supposed to ignore.
    { key: "x", kind: "number", label: "Left" , help: "where it sits" },
    { key: "y", kind: "number", label: "Top" },
    // Same KEY, different contract: a fraction of the box, not canvas units.
    { key: "cornerRadius", kind: "number", min: 0, max: 0.5, label: "Corner Radius" },
    { key: "fill", kind: "color", paint: true },
  ],
};

// ── THE INTERSECTION RULE ────────────────────────────────────────────────────

// WORKSTREAM VV, item 2: rotation must transfer through the intersection paste
// — "a rect's rotation onto a circle must land". This uses the REAL registered
// plugins (not the hand-built RECT/CIRCLE fixtures above) precisely because the
// claim is about the actual shared `transform` bundle (core/properties.js
// BUNDLES.transform), not about a fixture that happens to agree.
const registry = createRegistry();
for (const p of allPlugins) registry.register(p);
test("rotation is a UNIVERSAL row — a real rect's rotation onto a real circle lands", () => {
  const rectPlugin = registry.get("rect");
  const circlePlugin = registry.get("circle");
  assert.ok(rowsByKey(rectPlugin).get("rotation"), "rect declares no rotation row — the premise is false");
  assert.ok(rowsByKey(circlePlugin).get("rotation"), "circle declares no rotation row — the premise is false");
  const { state, skipped } = retargetedState({ rotation: 0.85 }, rectPlugin, circlePlugin);
  assert.deepEqual(state, { rotation: 0.85 }, "rotation did not transfer from a real rect to a real circle");
  assert.deepEqual(skipped, [], "rotation was skipped instead of landing");
});

test("copy-rotation's payload retargets end to end onto a selection of one", () => {
  const rectPlugin = registry.get("rect");
  const circlePlugin = registry.get("circle");
  const payload = itemPropertiesPayload({ items: { r: { rotation: 1.2 } } }, ["r"], ["rotation"]);
  const { payload: out, report } = retargetedPayload(payload, rectPlugin, [{ itemId: "c", plugin: circlePlugin }]);
  assert.deepEqual(out.powerrp_item_props, { c: { rotation: 1.2 } });
  assert.deepEqual(retargetReport(report), [], "a clean rotation retarget must warn about nothing");
});

test("rect Position onto a circle applies x and y — the same row under a different label", () => {
  const { state, skipped } = retargetedState({ x: 10, y: 20 }, RECT, CIRCLE);
  assert.deepEqual(state, { x: 10, y: 20 }, "x/y did not transfer between two boxed widgets");
  assert.deepEqual(skipped, [], "nothing should have been skipped");
});

test("a MISMATCHED CONTRACT is skipped, and the reason names the aspect that differs", () => {
  const { state, skipped } = retargetedState({ x: 1, cornerRadius: 12 }, RECT, CIRCLE);
  assert.deepEqual(state, { x: 1 }, "cornerRadius must not land on a widget that means a fraction by it");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].key, "cornerRadius");
  assert.match(skipped[0].reason, /means something different/, "the reason must say the meanings differ");
  assert.match(skipped[0].reason, /max/, "the reason must NAME the aspect (max) — 'skipped' alone sends the author hunting");
  // The judgement is core/multiselect's, not a parallel one invented here.
  assert.equal(sameRowContract(rowsByKey(RECT).get("cornerRadius"), rowsByKey(CIRCLE).get("cornerRadius")), false,
    "this test's premise: the two cornerRadius rows really are different rows");
});

test("a key the target's plugin never declares is skipped and NAMED, never written as junk", () => {
  const { state, skipped } = retargetedState({ x: 1, sides: 6 }, null, RECT);
  assert.deepEqual(state, { x: 1 });
  assert.deepEqual(skipped, [{ key: "sides", reason: "this widget has no “sides” property" }]);
});

test("identity keys never transfer, even when a row would allow them", () => {
  const withTypeRow = { inspector: [...RECT.inspector, { key: "type", kind: "text" }, { key: "z", kind: "number" }, { key: "active", kind: "boolean" }] };
  const { state, skipped } = retargetedState({ type: "rect", z: 3, active: true, x: 5 }, null, withTypeRow);
  assert.deepEqual(state, { x: 5 }, "type/z/active must be refused regardless of declared rows");
  assert.deepEqual(skipped.map((s) => s.key).sort(), ["active", "type", "z"]);
  for (const { key, reason } of skipped)
    assert.equal(reason, UNRETARGETABLE_KEYS[key], "the refusal must quote the declared reason, not restate it");
});

test("an EQUATION transfers verbatim — the target evaluates it, we do not rewrite it", () => {
  const { state } = retargetedState({ x: "=@missing.x + 4" }, RECT, CIRCLE);
  assert.equal(state.x, "=@missing.x + 4",
    "a dangling reference must ride across and fail through the normal equation-error path");
});

test("an UNKNOWN source plugin falls back to the target's declaration alone", () => {
  // A cross-document payload naming a type this build does not register: there is
  // no source contract to compare, so the target decides. Documented fallback.
  const { state, skipped } = retargetedState({ cornerRadius: 0.25 }, null, CIRCLE);
  assert.deepEqual(state, { cornerRadius: 0.25 });
  assert.deepEqual(skipped, []);
});

// ── CARDINALITY ──────────────────────────────────────────────────────────────

test("ONE copied widget BROADCASTS to N selected, each intersected separately", () => {
  const payload = { powerrp_item_props: { src: { x: 10, y: 20, cornerRadius: 12 } } };
  const { payload: out, report } = retargetedPayload(payload, RECT, [
    { itemId: "c1", plugin: CIRCLE },
    { itemId: "r2", plugin: RECT },
  ]);
  assert.deepEqual(out.powerrp_item_props, {
    c1: { x: 10, y: 20 },                    // cornerRadius means something else here
    r2: { x: 10, y: 20, cornerRadius: 12 },  // same widget type — everything lands
  }, "the broadcast must intersect PER TARGET, not once for the set");
  assert.deepEqual(report.map((r) => r.itemId), ["c1", "r2"]);
  assert.deepEqual(report[1].skipped, [], "a same-type target loses nothing");
});

test("the broadcast is ONE undo unit — it produces ONE delta over all targets", () => {
  const payload = { powerrp_item_props: { src: { x: 10, y: 20 } } };
  const { payload: out } = retargetedPayload(payload, RECT, [
    { itemId: "c1", plugin: CIRCLE },
    { itemId: "r2", plugin: RECT },
  ]);
  const destFold = { items: { c1: { type: "circle", x: 0, y: 0 }, r2: { type: "rect", x: 0, y: 0 } } };
  const delta = itemPropertiesDelta(out, destFold);
  // ONE delta object naming BOTH items — the app merges it into the slide with a
  // single commit, which is what makes the whole broadcast one undo step.
  assert.deepEqual(Object.keys(delta.items).sort(), ["c1", "r2"],
    "both targets must appear in the SAME delta, or the paste is two undo units");
  assert.deepEqual(delta.items.c1, { x: 10, y: 20 });
});

test("SEVERAL copied widgets + a selection is REFUSED, naming the counts and the way out", () => {
  const refusal = retargetRefusal(3, 2);
  assert.ok(refusal, "N sources onto a selection must not be silently paired");
  assert.match(refusal, /3 widgets were copied and 2 are selected/, "the refusal must name both counts");
  assert.match(refusal, /Deselect/, "the refusal must point at the per-id paste that still works");
  // And the two ways it is NOT a refusal:
  assert.equal(retargetRefusal(1, 5), null, "one source broadcasting is fine at any target count");
  assert.equal(retargetRefusal(4, 0), null, "no selection at all is the per-id path, not this one");
});

test("retargetedPayload REFUSES to guess among several sources rather than picking one", () => {
  assert.throws(
    () => retargetedPayload({ powerrp_item_props: { a: { x: 1 }, b: { x: 2 } } }, RECT, [{ itemId: "c", plugin: CIRCLE }]),
    /exactly one copied item may be broadcast/,
    "a silent choice among sources is the mapping this design exists to refuse",
  );
});

test("a target that can take NOTHING gets no payload entry, and the report says so", () => {
  const { payload: out, report } = retargetedPayload(
    { powerrp_item_props: { src: { sides: 6 } } }, null, [{ itemId: "c", plugin: { inspector: [] } }]);
  assert.deepEqual(out.powerrp_item_props, {}, "an empty entry would count as a target that received something");
  const lines = retargetReport(report);
  assert.match(lines[0], /nothing could be pasted/, "the author must be told nothing landed");
  assert.match(lines[1], /did not take “sides”/, "and told exactly which key and why");
});

test("a target that takes EVERYTHING is silent — a silent success is fine, a silent failure is not", () => {
  const { report } = retargetedPayload({ powerrp_item_props: { src: { x: 1 } } }, RECT, [{ itemId: "r", plugin: RECT }]);
  assert.deepEqual(retargetReport(report), []);
});

// ── THE REGRESSION PIN: the no-selection path is UNTOUCHED ───────────────────

test("NO SELECTION returns the payload BY IDENTITY — the per-id transport cannot have drifted", () => {
  const src = readFileSync(new URL("../web/app.svelte.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("  #retargetedForSelection(payload) {"));
  assert.match(body.slice(0, 400), /if \(!targets\.length\) return payload;/,
    "the empty-selection branch must return the payload OBJECT, not a rebuilt equivalent — " +
    "the ruling's first clause is that this path does not change");
});

test("a whole-state per-id paste still transports every key, identity keys included", () => {
  // The no-selection path does NOT go through retargetedState, so `active` coming
  // back (the documented Copy Properties feature) must still work.
  const payload = itemPropertiesPayload({ items: { a: { type: "rect", x: 1, active: true } } }, ["a"]);
  const delta = itemPropertiesDelta(payload, { items: { a: { type: "rect", x: 9, active: false } } });
  assert.deepEqual(delta.items.a, { x: 1, active: true },
    "a per-id paste must still bring a hidden item back — that is the shipped feature");
});

// ── HALF 2: THE PASTE BUTTON KNOWS ───────────────────────────────────────────

test("the badge appears ONLY for an abnormal paste — an ordinary widget paste has none", () => {
  assert.equal(pasteBadge("items"), null, "a badge on every paste distinguishes nothing");
  assert.equal(pasteBadge("empty"), null, "an empty clipboard is not abnormal, it is empty");
  assert.equal(pasteBadge("properties").id, "properties");
  assert.equal(pasteBadge("properties", "position").id, "position");
  assert.equal(pasteBadge("properties", "dimensions").id, "dimensions");
  assert.equal(pasteBadge("properties", "rotation").id, "rotation");
  assert.equal(pasteBadge("properties", "transform").id, "properties", "Transform rides the general glyph — see the vocabulary note");
  assert.equal(pasteBadge("image").id, "image");
});

test("every badge id names a declared glyph and label", () => {
  for (const kind of [["properties"], ["properties", "position"], ["properties", "dimensions"], ["properties", "rotation"], ["image"]]) {
    const badge = pasteBadge(...kind);
    assert.ok(PASTE_BADGES[badge.id], `badge id "${badge.id}" has no PASTE_BADGES entry`);
    assert.equal(badge.icon, PASTE_BADGES[badge.id].icon);
    assert.ok(badge.label.length > 0, "a badge must have an accessible name — the glyph is not an announcement");
  }
});

test("the clipboard kind ranks OURS over an observed OS image", () => {
  assert.equal(clipboardKind({ powerrp_items: { a: {} } }), "items");
  assert.equal(clipboardKind({ powerrp_item_props: { a: { x: 1 } } }), "properties");
  assert.equal(clipboardKind(null, true), "image");
  assert.equal(clipboardKind({ powerrp_items: { a: {} } }, true), "items",
    "our own copy also writes a PNG, so an image is never proof the user meant the image");
  assert.equal(clipboardKind(null), "empty");
});

test("the subset kinds are recognised from the payload's key SET, order-independently", () => {
  assert.equal(propertySubsetKind({ powerrp_item_props: { a: { y: 2, x: 1 } } }), "position");
  assert.equal(propertySubsetKind({ powerrp_item_props: { a: { h: 4, w: 8 } } }), "dimensions");
  assert.equal(propertySubsetKind({ powerrp_item_props: { a: { rotation: 0.5 } } }), "rotation");
  assert.equal(propertySubsetKind({ powerrp_item_props: { a: { w: 8, h: 4, x: 1, y: 2, rotation: 0, scale: 1 } } }), "transform");
  assert.equal(propertySubsetKind({ powerrp_item_props: { a: { x: 1, y: 2, fill: "#f00" } } }), null);
});

test("the subset key sets AGREE with the copy commands that produce them", () => {
  // A DRIFT GATE. The subset badges are a second statement of App.svelte's
  // copy-position/dimensions/rotation/box key lists; without this, adding another
  // subset verb would silently show the generic properties glyph forever.
  const src = readFileSync(new URL("../web/App.svelte", import.meta.url), "utf8");
  const declared = { position: "copy-position", dimensions: "copy-dimensions", rotation: "copy-rotation", transform: "copy-box" };
  for (const [subset, id] of Object.entries(declared)) {
    const entry = src.slice(src.indexOf(`{ id: "${id}"`));
    const keys = entry.slice(0, entry.indexOf("},")).match(/copySelectionProperties\(\[([^\]]*)\]/);
    assert.ok(keys, `${id} does not call copySelectionProperties with a key list`);
    const signature = keys[1].split(",").map((k) => k.trim().replace(/"/g, "")).sort().join(",");
    assert.equal(SUBSET_KEY_SETS[signature], subset,
      `${id} copies {${signature}}, which SUBSET_KEY_SETS does not map to "${subset}"`);
  }
});

test("the tooltip says what a click would DO, and the SELECTION is what changes it", () => {
  // The pair the whole ruling is about: same clipboard, different sentence.
  assert.equal(pasteIntent({ kind: "properties", itemCount: 1, subset: "position", selectedCount: 2 }),
    "Apply the copied Position to the 2 selected widgets");
  assert.equal(pasteIntent({ kind: "properties", itemCount: 1, subset: "position", selectedCount: 0 }),
    "Paste the copied Position onto its original widget (nothing selected)");
  assert.equal(pasteIntent({ kind: "properties", itemCount: 2, subset: null, selectedCount: 0 }),
    "Paste properties onto their original widgets (nothing selected)");
  assert.equal(pasteIntent({ kind: "items", itemCount: 3 }), "Paste 3 copied widgets");
  assert.equal(pasteIntent({ kind: "image" }), "Paste the image from your system clipboard as a new widget");
  assert.match(pasteIntent({ kind: "empty" }), /Nothing has been copied yet/);
});

test("the refusal is stated BEFORE the click, not reported after it", () => {
  const tip = pasteIntent({ kind: "properties", itemCount: 3, subset: null, selectedCount: 2 });
  assert.match(tip, /Nothing will happen/, "the one case where the button does nothing must say so up front");
  assert.match(tip, /deselect/i, "and must name the way out, as the refusal itself does");
});

test("Copy Transform's tooltip NAMES the subset its badge cannot distinguish", () => {
  // The legibility trade recorded in PASTE_BADGES: Transform shares the
  // properties glyph, so the sentence has to carry what the glyph dropped.
  assert.equal(subsetNoun("transform"), "Transform");
  assert.match(pasteIntent({ kind: "properties", itemCount: 1, subset: "transform", selectedCount: 1 }),
    /copied Transform/, "the tip must name Transform even though the badge groups it with properties");
});

test("Copy Rotation gets its own badge id and its tooltip says Rotation", () => {
  assert.equal(subsetNoun("rotation"), "Rotation");
  assert.match(pasteIntent({ kind: "properties", itemCount: 1, subset: "rotation", selectedCount: 2 }),
    /Apply the copied Rotation to the 2 selected widgets/);
});

test("Copy Size's tooltip says Size, matching the row's new title", () => {
  assert.equal(subsetNoun("dimensions"), "Size");
  assert.match(pasteIntent({ kind: "properties", itemCount: 1, subset: "dimensions", selectedCount: 1 }),
    /Apply the copied Size to the 1 selected widget/);
});

// ── THE SURFACES AGREE WITH THE DISPATCH ─────────────────────────────────────

test("both paste command entries state the selection rule", () => {
  const src = readFileSync(new URL("../web/App.svelte", import.meta.url), "utf8");
  for (const id of ["paste", "paste-properties"]) {
    const entry = src.slice(src.indexOf(`{ id: "${id}"`), src.indexOf(`{ id: "${id}"`) + 2200);
    assert.match(entry, /SELECT/i,
      `the ${id} entry's help does not mention the selection — the same clipboard does two things and the row must say which`);
  }
});

test("the Toolbar reads the badge and the tip from ONE derived affordance", () => {
  const src = readFileSync(new URL("../web/Toolbar.svelte", import.meta.url), "utf8");
  assert.match(src, /\$derived\(app\.pasteAffordance\(\)\)/,
    "one read, so the glyph and the sentence cannot describe different clipboards");
  assert.match(src, /data-paste-badge=/, "the badge must carry the id a probe can assert on");
  assert.match(src, /btn-kind-badge/, "the kind badge is its own element, not the count badge reused");
  const css = readFileSync(new URL("../web/app.css", import.meta.url), "utf8");
  assert.match(css, /\.btn-kind-badge\s*\{/, "the kind badge has no style — it would render unpositioned");
  assert.match(css, /bottom: var\(--a-paste-badge-offset\)/,
    "the user offered bottom-right or top-right; the count badge owns top-right, so this takes bottom-right");
});

console.log(`\npaste_targeting: ${passed} passed`);
