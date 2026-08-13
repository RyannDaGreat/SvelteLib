/**
 * COMPOUND PROPERTY ROWS + ASPECT LOCK (workstream COMPOUND_; backburner CY, AF, CX).
 *
 * Bare-node suite over the PURE half of the feature — core/properties.js's
 * compound declarations and the aspect-lock arithmetic — plus the two structural
 * assertions that keep the feature honest and that no rendering test can make:
 *
 *   • COMPOUNDS ARE PURE GROUPING. Folding compounds into a row array must not
 *     change what any document STORES, so the leaves a compound absorbs are the
 *     same leaves that were there before, and no compound key is ever a stored
 *     path. A regression here would be a compound that silently became a widget
 *     property.
 *   • THE DIAMOND'S PATH SET IS THE SECTION GRAMMAR'S. The compound diamond is
 *     core/section_keyframes.js reused; this pins that its paths really are the
 *     leaves' paths at ANY depth, because a tri-state over the wrong path set is
 *     a control that reports on properties it does not write.
 *
 * Run: node src/demo_apps/PowerRP/tests/compound_props_test.js
 */

import assert from "node:assert/strict";
import {
  COMPOUNDS, PROPS, BUNDLES, ASPECT_LOCK_KEY,
  compoundLeafKeys, resolveCompound, withCompoundRows, aspectLockedPair,
  bundle,
} from "../core/properties.js";
import { sectionKeyPaths, sectionTriState } from "../core/section_keyframes.js";
import {
  VAR_KINDS, VAR_KIND_LABELS, VAR_KIND_NOTES, VAR_KIND_ZEROS,
  varKind, withVarKind, withVarKindRenamed, repairedVarKinds, fontVarRowAspects,
} from "../core/var_kinds.js";
import { ROW_KINDS } from "../core/properties.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("compound_props_test");

// ── The declarations themselves ─────────────────────────────────────────────

test("COMPOUNDS declares xy and wh over the existing transform leaves", () => {
  assert.deepEqual(compoundLeafKeys(COMPOUNDS.xy), ["x", "y"]);
  assert.deepEqual(compoundLeafKeys(COMPOUNDS.wh), ["w", "h"]);
  // Every leaf a compound names must be a REAL declared property, or the
  // compound would render a row over a slot no widget has.
  for (const [key, node] of Object.entries(COMPOUNDS)) {
    for (const leaf of compoundLeafKeys(node)) {
      assert.ok(PROPS[leaf], `compound "${key}" names unknown leaf "${leaf}"`);
    }
  }
});

test("a compound id never collides with a property key", () => {
  // A compound occupies a ROW SLOT, and core/multiselect.js treats a repeated
  // row key as a plugin defect — so a compound named after a real property would
  // make every widget that has both an invalid row array.
  for (const key of Object.keys(COMPOUNDS)) {
    assert.ok(!PROPS[key], `compound id "${key}" collides with PROPS.${key}`);
  }
});

test("ARBITRARY DEPTH: compoundLeafKeys recurses with no level count", () => {
  const threeDeep = {
    children: [
      { key: "xy", children: ["x", "y"] },
      { key: "inner", children: [{ key: "deeper", children: ["w", "h"] }, "z"] },
    ],
  };
  assert.deepEqual(compoundLeafKeys(threeDeep), ["x", "y", "w", "h", "z"]);
  assert.deepEqual(compoundLeafKeys({ children: [] }), []);
  assert.deepEqual(compoundLeafKeys({}), []);
});

// ── resolveCompound: ALL leaves or none ─────────────────────────────────────

test("resolveCompound reuses the widget's OWN leaf rows", () => {
  const rows = [{ key: "x", label: "X", help: "widget's own help" }, { key: "y", label: "Y" }];
  const node = resolveCompound(COMPOUNDS.xy, new Map(rows.map((r) => [r.key, r])), "xy");
  assert.equal(node.compound, true);
  assert.equal(node.key, "xy");
  assert.equal(node.label, "Position");
  // The CHILD IS THE WIDGET'S ROW OBJECT, not a copy: a plugin that overrode a
  // label or a bound keeps that override inside the compound.
  assert.equal(node.children[0], rows[0]);
  assert.equal(node.children[0].help, "widget's own help");
});

test("a widget missing ANY leaf gets NO compound", () => {
  assert.equal(resolveCompound(COMPOUNDS.xy, new Map([["x", { key: "x" }]]), "xy"), null);
  assert.equal(resolveCompound(COMPOUNDS.wh, new Map([["h", { key: "h" }]]), "wh"), null);
});

test("nested compounds resolve recursively, and a missing deep leaf refuses the whole tree", () => {
  const node = { key: "t", children: [{ key: "xy", children: ["x", "y"] }, "z"] };
  const full = new Map([["x", { key: "x" }], ["y", { key: "y" }], ["z", { key: "z" }]]);
  const resolved = resolveCompound(node, full, "t");
  assert.deepEqual(resolved.children.map((c) => c.key), ["xy", "z"]);
  assert.equal(resolved.children[0].compound, true);
  full.delete("y");
  assert.equal(resolveCompound(node, full, "t"), null);
});

// ── withCompoundRows: the row rewrite ───────────────────────────────────────

test("withCompoundRows mounts the compound at its FIRST leaf's position", () => {
  const rows = [{ key: "z" }, { key: "x" }, { key: "y" }, { key: "opacity" }];
  assert.deepEqual(withCompoundRows(rows).map((r) => r.key), ["z", "xy", "opacity"]);
});

test("the real transform bundle folds to Position + cx/cy + Size + rotation…", () => {
  const folded = withCompoundRows(bundle("transform"));
  assert.deepEqual(folded.map((r) => r.key),
    ["xy", "cx", "cy", "wh", "rotation", "rotationAnchor.x", "rotationAnchor.y", "z"]);
  // cx/cy SURVIVE at the top level and keep their order — they write through
  // x/y but are not the compound's children, so folding must not swallow them.
  assert.equal(folded[1].writeKey, "x");
  assert.equal(folded[2].writeKey, "y");
});

test("a widget with no compound leaves is returned UNCHANGED", () => {
  // The arrow family: endpoints, no bbox. It must keep exactly its own rows.
  const rows = bundle("endpoints");
  const folded = withCompoundRows(rows);
  assert.deepEqual(folded.map((r) => r.key), rows.map((r) => r.key));
});

test("a leaf is never claimed by two compounds", () => {
  // Two compounds over the same leaf would render it twice and keyframe it
  // twice from one click; the first declaration wins and the second is skipped.
  const table = { a: { label: "A", children: ["x", "y"] }, b: { label: "B", children: ["y", "z"] } };
  const folded = withCompoundRows([{ key: "x" }, { key: "y" }, { key: "z" }], table);
  assert.deepEqual(folded.map((r) => r.key), ["a", "z"]);
});

test("PURE GROUPING: folding preserves every leaf, exactly once, in order", () => {
  const rows = bundle("transform");
  const folded = withCompoundRows(rows);
  const flatten = (r) => (r.compound ? r.children.flatMap(flatten) : [r.key]);
  assert.deepEqual(folded.flatMap(flatten), rows.map((r) => r.key));
});

// ── The tri-state diamond really reads the leaves ───────────────────────────

test("a compound's keyframe paths ARE its leaves' paths (the section grammar)", () => {
  const node = resolveCompound(COMPOUNDS.xy,
    new Map([["x", { key: "x" }], ["y", { key: "y" }]]), "xy");
  const paths = sectionKeyPaths(node.children, () => ["item1"], (r) => r.writeKey ?? r.key);
  assert.deepEqual(paths, [["items", "item1", "x"], ["items", "item1", "y"]]);
  // NONE / SOME / ALL, the user's own words, over exactly those two paths.
  assert.equal(sectionTriState([false, false]), "none");
  assert.equal(sectionTriState([true, false]), "some");
  assert.equal(sectionTriState([true, true]), "all");
});

test("a NESTED compound's paths include every depth's leaves", () => {
  const rowsByKey = new Map(["x", "y", "w", "h"].map((k) => [k, { key: k }]));
  const node = resolveCompound(
    { children: [{ key: "xy", children: ["x", "y"] }, { key: "wh", children: ["w", "h"] }] },
    rowsByKey, "box");
  // The Inspector flattens a node to leaf ROWS for the diamond; this is that
  // flatten, and it must reach depth 2 with no special case.
  const leafRows = (n) => (n.compound ? n.children.flatMap(leafRows) : [n]);
  const paths = sectionKeyPaths(leafRows(node), () => ["i"], (r) => r.writeKey ?? r.key);
  assert.deepEqual(paths.map((p) => p[2]), ["x", "y", "w", "h"]);
});

// ── ASPECT LOCK (backburner AF) ─────────────────────────────────────────────

test("aspectLockedPair scales the other axis by the driver's factor", () => {
  assert.deepEqual(aspectLockedPair("w", 200, { w: 100, h: 50 }), { w: 200, h: 100 });
  assert.deepEqual(aspectLockedPair("h", 25, { w: 100, h: 50 }), { w: 50, h: 25 });
  assert.deepEqual(aspectLockedPair("w", 100, { w: 100, h: 50 }), { w: 100, h: 50 });
});

test("a FLIP keeps the DRIVEN axis's own sign (locking does not propagate a flip)", () => {
  assert.deepEqual(aspectLockedPair("w", -200, { w: 100, h: 50 }), { w: -200, h: 100 });
  assert.deepEqual(aspectLockedPair("h", -25, { w: 100, h: 50 }), { w: 50, h: -25 });
  // …and an already-flipped widget stays flipped when the other axis drives it.
  assert.deepEqual(aspectLockedPair("w", 200, { w: 100, h: -50 }), { w: 200, h: -100 });
});

test("a ZERO driver leaves the other axis alone rather than collapsing it", () => {
  assert.deepEqual(aspectLockedPair("w", 200, { w: 0, h: 50 }), { w: 200, h: 50 });
  assert.deepEqual(aspectLockedPair("h", 200, { w: 80, h: 0 }), { w: 80, h: 200 });
});

test("a non-finite before-value is not an error and writes only the edited axis", () => {
  // w can legitimately be absent (undefined) on a widget that has not been sized
  // yet; the lock must not turn that into NaN geometry.
  assert.deepEqual(aspectLockedPair("w", 200, { w: undefined, h: 50 }), { w: 200, h: 50 });
  assert.deepEqual(aspectLockedPair("w", 200, { w: 100, h: undefined }), { w: 200, h: undefined });
});

test("ASPECT_LOCK_KEY is a declared, NON-keyframeable boolean that no bundle composes", () => {
  assert.equal(ASPECT_LOCK_KEY, "aspectLocked");
  assert.equal(PROPS[ASPECT_LOCK_KEY].kind, "boolean");
  // NOT keyframeable — a ratio constraint that tweened would rewrite w/h
  // keyframes the author set by hand.
  assert.equal(PROPS[ASPECT_LOCK_KEY].keyframes, false);
  // ABSENT IS OFF: no `default`, and no bundle composes it, so every existing
  // document is byte-identical and no widget's stored state grows.
  assert.equal(PROPS[ASPECT_LOCK_KEY].default, undefined);
  for (const [name, keys] of Object.entries(BUNDLES)) {
    assert.ok(!keys.includes(ASPECT_LOCK_KEY), `bundle "${name}" must not compose ${ASPECT_LOCK_KEY}`);
  }
});

test("only the compound declaring aspectLock gets the chain (Size, not Position)", () => {
  assert.equal(COMPOUNDS.wh.aspectLock, true);
  assert.ok(!COMPOUNDS.xy.aspectLock, "a chain on Position would tie x to y, which is not a ratio");
});

// ── GLOBAL VARIABLE KINDS (backburner CX) ───────────────────────────────────

test("every kind has a label, a note, a zero — and a zero of its OWN kind", () => {
  for (const k of VAR_KINDS) {
    assert.ok(VAR_KIND_LABELS[k], `kind "${k}" has no label`);
    assert.ok(VAR_KIND_NOTES[k], `kind "${k}" has no note`);
    assert.ok(k in VAR_KIND_ZEROS, `kind "${k}" has no zero`);
  }
  // THE ZERO MUST BE A LEGAL VALUE OF ITS KIND. A variable is created already
  // keyframed at its zero, so a zero of the wrong type is a slot that reads as
  // broken the moment it is made.
  assert.equal(typeof VAR_KIND_ZEROS.number, "number");
  assert.equal(typeof VAR_KIND_ZEROS.boolean, "boolean");
  assert.equal(typeof VAR_KIND_ZEROS.text, "string");
  assert.match(VAR_KIND_ZEROS.color, /^#[0-9a-f]{6}$/i);
  // The font zero is the REGISTRY'S OWN default, not a restated literal.
  assert.equal(VAR_KIND_ZEROS.font, DEFAULT_FONT);
  assert.ok(fontOptions().some((o) => o.value === VAR_KIND_ZEROS.font),
    "the font zero must be a real registered face");
});

test("every kind names a REAL row kind, so the panel mounts the Property Panel's own control", () => {
  // "font" is the one that is not literally in ROW_KINDS: it is a `select` over
  // the font roster, which is exactly how plugins/text.js declares its Font row.
  for (const k of VAR_KINDS) {
    if (k === "font") continue;
    assert.ok(ROW_KINDS.includes(k), `variable kind "${k}" is not a row kind`);
  }
  assert.ok(ROW_KINDS.includes("select"), "the font kind renders as a select");
});

test("the font kind reads the ONE font registry, and reads it LIVE", () => {
  const aspects = fontVarRowAspects();
  assert.deepEqual(aspects.options, fontOptions().map((o) => o.value));
  assert.equal(aspects.optionLabels[DEFAULT_FONT], fontOptions().find((o) => o.value === DEFAULT_FONT).label);
  // A FUNCTION, not a frozen constant: registerFontFamily can add faces at
  // runtime, and a snapshot would show a picker missing what was just loaded.
  assert.equal(typeof fontVarRowAspects, "function");
});

test("ABSENT IS number — which is what makes this a non-migration", () => {
  assert.equal(varKind(undefined, "speed"), "number");
  assert.equal(varKind({}, "speed"), "number");
  assert.equal(varKind({other: "color"}, "speed"), "number");
  // An unknown kind DEGRADES rather than throwing: the value is still there and
  // still editable as what it literally is. The loud half is repairedVarKinds'.
  assert.equal(varKind({speed: "quaternion"}, "speed"), "number");
});

test("withVarKind REMOVES a default entry rather than storing it", () => {
  assert.deepEqual(withVarKind({}, "brand", "color"), {brand: "color"});
  // Storing {x: "number"} would be a diff in every file describing no change,
  // and would make absent vs present-but-default two spellings of one fact.
  assert.deepEqual(withVarKind({brand: "color"}, "brand", "number"), {});
  assert.deepEqual(withVarKind({a: "color"}, "b", "text"), {a: "color", b: "text"});
  // The input is never mutated.
  const before = {a: "color"};
  withVarKind(before, "b", "text");
  assert.deepEqual(before, {a: "color"});
});

test("A RENAME CARRIES THE KIND, and a delete drops it", () => {
  // Without this a renamed colour variable reads as a Number — retyped by a
  // rename — and a stale entry retypes the NEXT variable to reuse the name.
  assert.deepEqual(withVarKindRenamed({brand: "color"}, "brand", "accent"), {accent: "color"});
  assert.deepEqual(withVarKindRenamed({brand: "color"}, "brand", null), {});
  assert.deepEqual(withVarKindRenamed({a: "color"}, "speed", "rate"), {a: "color"});
  // A plain-number variable has no entry, so renaming it must not INVENT one.
  assert.deepEqual(withVarKindRenamed({}, "speed", "rate"), {});
});

test("repairedVarKinds: absent is QUIET, damaged is LOUD, and no VALUE is touched", () => {
  assert.deepEqual(repairedVarKinds(undefined), {varKinds: {}, dropped: []});
  assert.deepEqual(repairedVarKinds({}), {varKinds: {}, dropped: []});
  assert.deepEqual(repairedVarKinds({brand: "color"}), {varKinds: {brand: "color"}, dropped: []});

  const bad = repairedVarKinds({brand: "quaternion", keep: "text"});
  assert.deepEqual(bad.varKinds, {keep: "text"}, "a good entry beside a bad one survives");
  assert.equal(bad.dropped.length, 1);
  assert.equal(bad.dropped[0].name, "brand");
  assert.match(bad.dropped[0].reason, /not one of/);

  // A map that is not an object at all is discarded WHOLE, and says so.
  for (const junk of ["nonsense", 42, ["color"]]) {
    const r = repairedVarKinds(junk);
    assert.deepEqual(r.varKinds, {});
    assert.equal(r.dropped.length, 1);
    assert.equal(r.dropped[0].name, null);
  }
});

console.log(`\ncompound_props_test: ${passed} passed`);
