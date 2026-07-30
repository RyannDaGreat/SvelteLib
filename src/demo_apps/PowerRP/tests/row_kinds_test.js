/**
 * ROW-KIND VOCABULARY guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/row_kinds_test.js
 *
 * WHY THIS EXISTS. A property row declares its Inspector control with `kind`.
 * Nothing enforced that vocabulary, so the SAME concept grew TWO names: the V1
 * seed called an on/off row `kind: "checkbox"` (back when the Inspector really
 * did render <input type="checkbox">), and nine hours later the Inspector
 * overhaul deleted that native input, wrote BooleanField.svelte, and called the
 * same thing `kind: "boolean"`. Both names kept getting copied for a year of
 * commits. Two names for one control is how a control ends up looking like two
 * different things — the drift the user reported ("checkbox styling... should
 * always be the same").
 *
 * WHAT IT PROVES, over EVERY registered plugin (not a sample):
 *   (1) every inspector row declares a kind in core/properties.js ROW_KINDS;
 *   (2) no row uses a RETIRED spelling — the error names the replacement;
 *   (3) ROW_KINDS itself has no duplicate entries;
 *   (4) a retired name is never ALSO a current name (that would legitimise the
 *       duplicate the whole exercise removes);
 *   (5) customProps() rejects an invented kind at the call site;
 *   (6) a select row's OPTION GROUPS are the derivation source of its options —
 *       the invariant that makes the grouped dropdown drift-proof.
 *
 * The sweep is deliberately broader than the import-time guards in
 * core/properties.js: those see only rows composed through PROPS/customProps,
 * and most plugin rows are hand-written object literals that never pass through
 * this module at all. The literals are exactly where the drift lived.
 */

import assert from "node:assert/strict";
// builtinRoster(), NOT allPlugins: this file SWEEPS "every shipped widget", and
// allPlugins is only the SOURCE-MODULE half of the roster — the five batch-1 widgets
// (donut, progress_bar, number, both clocks) moved to the built-in plugin-asset
// library and silently left every such sweep. See plugins/index.js builtinRoster.
import { builtinRoster } from "../plugins/index.js";

const roster = builtinRoster();
import {
  PROPS,
  ROW_KINDS,
  RETIRED_ROW_KINDS,
  customProps,
  selectRowItems,
  BLEND_MODES,
  BLEND_MODE_GROUPS,
  BLEND_MODE_LABELS,
} from "../core/properties.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/**
 * Pure function. Flattens every registered plugin's inspector into
 * {plugin, key, kind} triples — the population under test.
 *
 * @example allRows([{type: "rect", inspector: [{key: "w", kind: "number"}]}])
 * [{"plugin":"rect","key":"w","kind":"number"}]
 * @example allRows([{type: "x", inspector: []}])
 * []
 */
function allRows(plugins) {
  return plugins.flatMap((p) => (p.inspector ?? []).map((r) => ({ plugin: p.type, key: r.key, kind: r.kind })));
}

// ── (3)+(4) the vocabulary itself is well formed ─────────────────────────────
test("ROW_KINDS has no duplicate entries", () => {
  assert.equal(new Set(ROW_KINDS).size, ROW_KINDS.length, `ROW_KINDS repeats a name: ${JSON.stringify(ROW_KINDS)}`);
});

test("no retired spelling is also a current ROW_KIND", () => {
  for (const [retired, replacement] of Object.entries(RETIRED_ROW_KINDS)) {
    assert.ok(!ROW_KINDS.includes(retired), `"${retired}" is listed as RETIRED but is still in ROW_KINDS — one concept, one name.`);
    assert.ok(ROW_KINDS.includes(replacement), `RETIRED_ROW_KINDS maps "${retired}" to "${replacement}", which is not in ROW_KINDS.`);
  }
});

// ── (1)+(2) the app-wide sweep ───────────────────────────────────────────────
test("every plugin inspector row declares a known kind", () => {
  const rows = allRows(roster);
  assert.ok(rows.length > 0, "no plugin rows found — the sweep would pass vacuously");
  const unknown = rows.filter((r) => !ROW_KINDS.includes(r.kind) && !(r.kind in RETIRED_ROW_KINDS));
  assert.deepEqual(
    unknown,
    [],
    `these rows declare a kind with no Inspector control (it would render as a plain text box). Known kinds: ${JSON.stringify(ROW_KINDS)}`
  );
});

test("no plugin inspector row uses a RETIRED kind spelling", () => {
  const stale = allRows(roster).filter((r) => r.kind in RETIRED_ROW_KINDS);
  assert.deepEqual(
    stale,
    [],
    `these rows use a retired kind name. Rewrite each as its replacement (${JSON.stringify(RETIRED_ROW_KINDS)}) — ` +
      "two names for one control is how the control drifts into looking like two different things."
  );
});

test("the shared registry (PROPS) uses only current kinds", () => {
  const stale = Object.entries(PROPS)
    .filter(([, def]) => !ROW_KINDS.includes(def.kind))
    .map(([key, def]) => `${key} = ${def.kind}`);
  assert.deepEqual(stale, [], "core/properties.js PROPS must be the exemplar of the vocabulary it defines");
});

test("boolean is the ONE on/off kind, and it is actually used", () => {
  const bools = allRows(roster).filter((r) => r.kind === "boolean");
  assert.ok(bools.length > 0, "no boolean rows — the guard would be vacuous");
  // Anything on/off must be spelled "boolean": there is no second on/off kind.
  const onOffish = ROW_KINDS.filter((k) => /^(bool|check|toggle|switch|flag)/i.test(k));
  assert.deepEqual(onOffish, ["boolean"], `ROW_KINDS offers more than one on/off spelling: ${JSON.stringify(onOffish)}`);
});

// ── (6) grouped select options ───────────────────────────────────────────────
// The 26 blend modes render as six visually separated families. The ONLY way that
// can stay true through a reorder is for the group declaration to BE the option
// list, so these assert the derivation, not a copy of today's contents.
test("BLEND_MODES is DERIVED from BLEND_MODE_GROUPS (one declaration, no mirror)", () => {
  assert.deepEqual(BLEND_MODES, BLEND_MODE_GROUPS.flatMap((g) => g.options));
  assert.equal(new Set(BLEND_MODES).size, BLEND_MODES.length, "a mode appears in two families — one mode, one row");
  assert.equal(new Set(BLEND_MODE_GROUPS.map((g) => g.id)).size, BLEND_MODE_GROUPS.length, "duplicate group id");
  for (const g of BLEND_MODE_GROUPS) assert.ok(g.options.length > 0, `group "${g.id}" is empty — it would render a caption with nothing under it`);
  // The property row hands the Inspector the SAME array object, so there is no
  // third copy to drift (effects_test.js pins options === BLEND_MODES likewise).
  assert.equal(PROPS.blendMode.optionGroups, BLEND_MODE_GROUPS);
});

test("selectRowItems: a caption per family, and every option still selectable", () => {
  const items = selectRowItems(PROPS.blendMode);
  const captions = items.filter((it) => "insert" in it).map((it) => it.insert);
  assert.deepEqual(captions, BLEND_MODE_GROUPS.map((g) => g.title), "one caption per family, in family order");
  // Every mode survives the grouping as a selectable row with its human label —
  // this is what proves hover-preview can still reach all 26 (an `insert` row
  // cannot be active, so it can never be previewed or picked).
  const selectable = items.filter((it) => !("insert" in it));
  assert.deepEqual(selectable.map((it) => it.value), BLEND_MODES);
  assert.deepEqual(selectable.map((it) => it.label), BLEND_MODES.map((m) => BLEND_MODE_LABELS[m]));
  assert.equal(items.length, BLEND_MODES.length + BLEND_MODE_GROUPS.length);
  // A caption sits IMMEDIATELY before its own family's first option.
  for (const g of BLEND_MODE_GROUPS)
    assert.equal(items[items.findIndex((it) => it.insert === g.title) + 1].value, g.options[0], `caption "${g.title}" does not head its own family`);
});

test("selectRowItems: an ungrouped select row is untouched (no captions)", () => {
  const items = selectRowItems(PROPS.antialias);
  assert.ok(items.every((it) => !("insert" in it)), "a row without optionGroups must render exactly its options");
  assert.deepEqual(items.map((it) => it.value), PROPS.antialias.options);
});

test("optionGroups that disagree with options throws at declaration", () => {
  // The gate core/properties.js runs over PROPS at import, reached through the
  // same path a new grouped row would take.
  assert.throws(
    () => customProps([{ name: "mode", kind: "select", options: ["a", "b"], optionGroups: [{ id: "g", title: "G", options: ["a"] }], default: "a" }]),
    /must BE the option list/,
    "captions one family off must fail at the author's desk, not in the dropdown"
  );
});

// ── (5) the call-site guard ──────────────────────────────────────────────────
test("customProps rejects an invented kind (loud, no silent text-box fallback)", () => {
  assert.throws(
    () => customProps([{ name: "spin", kind: "toggle", default: true }]),
    /not one of/,
    "an unknown kind must throw where the widget author is standing"
  );
  // A current kind still passes, so the guard is not simply refusing everything.
  assert.equal(customProps([{ name: "spin", kind: "boolean", default: true }]).rows[0].kind, "boolean");
});

console.log(`\n${passed} row-kind tests passed`);
