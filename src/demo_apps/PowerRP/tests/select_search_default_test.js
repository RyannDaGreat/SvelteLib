/**
 * SEARCHABLE SELECT BY DEFAULT (workstream DROPDOWN_, R7-40) — plain node.
 * Run: node src/demo_apps/PowerRP/tests/select_search_default_test.js
 *
 * THE RULING (user, R7-40): "We should make the default drop down that we use in
 * this app. Probably should be searchable. Shape for example, for the PowerPoint
 * shape has so many options, but Claude didn't even know or think to make it a
 * searchable drop down. So perhaps that should be the default so that Claude is
 * in the future, don't have to remember that."
 *
 * WHAT THAT MAKES THIS FILE. The ruling's operative half is the LAST CLAUSE — it
 * is about not having to remember. A test that only checked "the shape row
 * filters" would pin the example and miss the rule, and the next 187-option list
 * would ship unsearchable with this file still green. So the gate below is on
 * the SEAM: Inspector's ordinary select branch mounts a SearchableDropdown, and
 * no branch of `kind === "select"` mounts a plain Dropdown. A plugin author who
 * writes `kind: "select"` inherits search without knowing this file exists,
 * which is the only version of the ruling that stays true.
 *
 * THE GROUPED-LIST RANKER is the other half, and it is why a flat `appRankItems`
 * could not simply be pointed at every row. `selectRowItems` turns a row's
 * `optionGroups` into Dropdown `insert` captions, and the flat ranker drops
 * every caption while filtering (correctly — a flat list has no groups). Point
 * it at blendMode's six families and the captions vanish, silently merging them
 * into one list whose authored order then looks arbitrary. `appRankGrouped`
 * filters IN PLACE and keeps a caption exactly when its family survived.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { appRankGrouped, appRankItems, isCaption } from "../web/searchRank.js";
import { selectRowItems } from "../core/properties.js";
import { allPlugins } from "../plugins/index.js";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inspectorSrc = readFileSync(resolve(powerRP, "web/Inspector.svelte"), "utf8");

let failures = 0;
let ran = 0;
function test(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log("searchable select by default:");

/**
 * Pure function. Every `kind: "select"` inspector row the plugin roster declares
 * WITH its own options (an `optionsFrom` row derives an unbounded set instead and
 * is separately always-searchable). Used to measure the real option-count
 * distribution the threshold is chosen against.
 *
 * @returns {{type:string, key:string, n:number, grouped:boolean}[]}
 *
 * @example // shape of one entry
 * declaredSelectRows().find((r) => r.key === "preset")
 * // => { type: "pptx_preset", key: "preset", n: 187, grouped: false }
 */
function declaredSelectRows() {
  const out = [];
  for (const plugin of allPlugins) {
    const rows = typeof plugin.inspector === "function" ? plugin.inspector({}) : plugin.inspector;
    for (const row of rows ?? []) {
      if (row?.kind !== "select" || row.optionsFrom) continue;
      out.push({ type: plugin.type, key: row.key, n: (row.options ?? []).length, grouped: !!row.optionGroups });
    }
  }
  return out;
}

// ── 1. THE SEAM ──────────────────────────────────────────────────────────────
// The rule, not the example. Detected in the source because the claim is about
// which COMPONENT the branch mounts, which no runtime assertion on one row can
// see.

test("the ordinary select branch mounts a SearchableDropdown, not a Dropdown", () => {
  // The `kind === "select"` block runs to the next `{:else if kind ===`.
  const start = inspectorSrc.indexOf('{:else if kind === "select"}');
  assert.ok(start > 0, "could not find the select branch in Inspector.svelte");
  const rest = inspectorSrc.slice(start + 1);
  const end = rest.indexOf("{:else if kind ===");
  const block = rest.slice(0, end > 0 ? end : undefined);

  assert.ok(
    !/<Dropdown\b/.test(block),
    "a plain <Dropdown> is mounted inside the select branch — every select row must be\n" +
      "searchable by DEFAULT (R7-40). A row that opts out is a row somebody has to\n" +
      "remember to fix later, which is the exact thing the ruling forbids.");
  assert.ok(/<SearchableDropdown\b/.test(block), "the select branch mounts no SearchableDropdown at all");
});

test("the grouped rows get the caption-preserving ranker", () => {
  assert.ok(
    /rankFn=\{row\.optionGroups \? appRankGrouped : appRankItems\}/.test(inspectorSrc),
    "the default select row must choose appRankGrouped when the row declares optionGroups —\n" +
      "the flat ranker drops caption inserts, silently merging the families.");
});

// ── 2. SMALL LISTS DO NOT GET WORSE ──────────────────────────────────────────
// The threshold is a real decision and the measurement behind it is pinned here,
// so a future edit that moves it has to face the same data.

test("the threshold sits in the measured valley of the option-count distribution", () => {
  const rows = declaredSelectRows();
  assert.ok(rows.length > 100, `expected the roster to declare many select rows, got ${rows.length}`);

  const band = (lo, hi) => rows.filter((r) => r.n >= lo && r.n <= hi).length;
  const small = band(1, 4);
  const valley = band(5, 12);
  const large = rows.filter((r) => r.n >= 13).length;

  // BIMODAL, with a near-empty span between the modes. That is what makes the
  // exact cut cheap: any threshold inside the valley separates the same two
  // populations, so the constant does not need re-tuning as plugins add options.
  assert.ok(small > 200, `expected a large 1-4 option mode, got ${small}`);
  assert.ok(large > 200, `expected a large 13+ option mode, got ${large}`);
  assert.ok(
    valley * 4 < small && valley * 4 < large,
    `the 5-12 valley (${valley}) is not small against the modes (${small} / ${large}) — the\n` +
      "distribution this threshold was chosen from has changed shape; re-derive it.");
});

test("SELECT_SEARCH_THRESHOLD keeps short enums plain and opens the big lists", () => {
  const m = inspectorSrc.match(/const SELECT_SEARCH_THRESHOLD = (\d+);/);
  assert.ok(m, "SELECT_SEARCH_THRESHOLD is not declared in Inspector.svelte");
  const threshold = Number(m[1]);

  // The component shows the box on a strict `>`, so this is the predicate the
  // user actually meets.
  const searches = (n) => n > threshold;

  assert.equal(searches(187), true, "the pptx shape row (187 options) must search — it IS the reported case");
  assert.equal(searches(26), true, "blendMode (26 options) must search");
  assert.equal(searches(2), false, "a 2-option enum must stay plain");
  assert.equal(searches(4), false, "a 4-option enum (curve) must stay plain — the box would be taller than the list");

  // And it must fall inside the valley the previous check measured, in BOTH
  // directions: below the large mode's floor, above the small mode's ceiling.
  assert.ok(threshold >= 4 && threshold < 13, `threshold ${threshold} is outside the measured valley (5-12)`);
});

// ── 3. THE GROUPED RANKER ────────────────────────────────────────────────────

test("a caption survives exactly when its own family does", () => {
  const items = [
    { insert: "Lightening" }, { value: "screen", label: "Screen" }, { value: "lighten", label: "Lighten" },
    { insert: "Darkening" }, { value: "multiply", label: "Multiply" },
  ];

  // A query hitting one family keeps that caption and drops the other entirely.
  const scr = appRankGrouped("scr", items);
  assert.deepEqual(scr.map((it) => it.label ?? `[${it.insert}]`), ["[Lightening]", "Screen"]);

  const mul = appRankGrouped("mul", items);
  assert.deepEqual(mul.map((it) => it.label ?? `[${it.insert}]`), ["[Darkening]", "Multiply"]);

  // Nothing matched ⇒ NO captions either. A menu of headers over nothing is the
  // orphan case that made this function necessary.
  assert.deepEqual(appRankGrouped("zzz", items), []);
});

test("a blank query is the identity — the authored groups, untouched", () => {
  const items = [{ insert: "G" }, { value: 1, label: "A" }, { value: 2, label: "B" }];
  // Same objects, same order, and no _spans stamped on anything.
  assert.equal(appRankGrouped("", items), items);
  assert.equal(appRankGrouped("   ", items), items);
});

test("survivors keep AUTHORED order, never score order", () => {
  // "e" matches all three. The flat ranker is free to reorder by score; the
  // grouped one must not, because the caption above a row would then be
  // describing a different family than the one the row belongs to.
  const items = [
    { insert: "First" }, { value: "zeta", label: "Zeta" },
    { insert: "Second" }, { value: "ae", label: "Ae" }, { value: "e", label: "E" },
  ];
  const out = appRankGrouped("e", items).map((it) => it.label ?? `[${it.insert}]`);
  assert.deepEqual(out, ["[First]", "Zeta", "[Second]", "Ae", "E"]);

  // The flat ranker over the same labels DOES reorder — which is the point of
  // having two functions, and proof this test is measuring order not luck.
  const flat = appRankItems("e", items.filter((it) => !isCaption(it))).map((it) => it.label);
  assert.notDeepEqual(flat, ["Zeta", "Ae", "E"]);
});

test("matching is delegated — the two rankers agree on WHAT survives", () => {
  // appRankGrouped owns order and captions; it must never own matching, or the
  // app would have a third scorer (the one-ranking ban's whole subject).
  const labelled = [
    { value: "a", label: "Screen" }, { value: "b", label: "Multiply" },
    { value: "c", label: "Color Dodge" }, { value: "d", label: "Soft Light" },
  ];
  const withCaptions = [{ insert: "Family" }, ...labelled];
  for (const q of ["s", "li", "dodge", "co", "xyz", "olo"]) {
    const flat = new Set(appRankItems(q, labelled).map((it) => it.value));
    const grouped = new Set(appRankGrouped(q, withCaptions).filter((it) => !isCaption(it)).map((it) => it.value));
    assert.deepEqual(grouped, flat, `the two rankers disagree about what matches "${q}"`);
  }
});

test("an ungrouped leading run passes through", () => {
  // selectRowItems only emits captions for an optionGroups row, but nothing
  // forbids rows ahead of the first caption — dropping them would lose options.
  const items = [{ value: "x", label: "Xylo" }, { insert: "G" }, { value: "y", label: "Xeno" }];
  const out = appRankGrouped("x", items).map((it) => it.label ?? `[${it.insert}]`);
  assert.deepEqual(out, ["Xylo", "[G]", "Xeno"]);
});

// ── 4. THE REAL ROWS ─────────────────────────────────────────────────────────
// Against the actual declarations, not hand-written fixtures.

test("the pptx shape row filters to the arrow family on \"arrow\"", () => {
  const shapeRow = declaredSelectRows().find((r) => r.key === "preset" && r.n > 100);
  assert.ok(shapeRow, "the pptx_preset shape row was not found in the roster");
  assert.equal(shapeRow.n, 187, `the shape row should declare 187 presets, got ${shapeRow.n}`);

  const plugin = allPlugins.find((p) => p.type === shapeRow.type);
  const rows = typeof plugin.inspector === "function" ? plugin.inspector({}) : plugin.inspector;
  const items = selectRowItems(rows.find((r) => r.key === "preset"));
  assert.equal(items.length, 187);

  const hits = appRankItems("arrow", items).map((it) => it.value);
  // It really narrows — the reported defect was 187 rows with no way to cut them.
  assert.ok(hits.length > 5, `"arrow" should match the arrow family, got ${hits.length}`);
  assert.ok(hits.length < 60, `"arrow" should NARROW the list, got ${hits.length} of 187`);
  for (const name of hits) {
    assert.match(name.toLowerCase(), /a.*r.*r.*o.*w/, `"${name}" is not an arrow-family match`);
  }
  // The canonical members are all reachable.
  for (const want of ["rightArrow", "leftArrow", "upArrow", "bentArrow", "curvedRightArrow"]) {
    assert.ok(hits.includes(want), `"arrow" should reach ${want}`);
  }
});

test("blendMode's six families survive a real filter through selectRowItems", () => {
  const plugin = allPlugins.find((p) => {
    const rows = typeof p.inspector === "function" ? p.inspector({}) : p.inspector;
    return (rows ?? []).some((r) => r?.key === "blendMode" && r.optionGroups);
  });
  assert.ok(plugin, "no plugin declares a grouped blendMode row");
  const rows = typeof plugin.inspector === "function" ? plugin.inspector({}) : plugin.inspector;
  const items = selectRowItems(rows.find((r) => r.key === "blendMode"));

  const captions = items.filter(isCaption).length;
  assert.ok(captions >= 5, `expected the blend families' captions, got ${captions}`);

  // Unfiltered: byte-identical to today's plain Dropdown list.
  assert.equal(appRankGrouped("", items), items);

  // Filtered: every surviving caption is followed by at least one real row.
  const out = appRankGrouped("light", items);
  assert.ok(out.length > 0, '"light" matched nothing in the blend modes');
  for (let i = 0; i < out.length; i += 1) {
    if (!isCaption(out[i])) continue;
    assert.ok(
      out[i + 1] && !isCaption(out[i + 1]),
      `caption "${out[i].insert}" is orphaned — no option follows it`);
  }
});

// ── 5. THE DETECTOR'S OWN SELF-CHECK ─────────────────────────────────────────
// A source-scanning gate that has never been shown to go red is indistinguishable
// from one that cannot. Both directions, on synthetic source.

test("self-check: the seam detector finds a reverted branch and clears the fixed one", () => {
  /**
   * Pure function. True if the `kind === "select"` branch of some Inspector
   * source mounts a plain Dropdown — the regression check 1 gates on, lifted out
   * so it can be run against synthetic source too.
   *
   * @param {string} src - Inspector.svelte source text
   * @returns {boolean}
   *
   * @example selectBranchHasPlainDropdown('{:else if kind === "select"}<Dropdown />') // => true
   * @example selectBranchHasPlainDropdown('{:else if kind === "select"}<SearchableDropdown />') // => false
   */
  function selectBranchHasPlainDropdown(src) {
    const start = src.indexOf('{:else if kind === "select"}');
    if (start < 0) return false;
    const rest = src.slice(start + 1);
    const end = rest.indexOf("{:else if kind ===");
    return /<Dropdown\b/.test(rest.slice(0, end > 0 ? end : undefined));
  }

  assert.equal(selectBranchHasPlainDropdown('{:else if kind === "select"}\n<Dropdown items={x} />\n'), true);
  assert.equal(selectBranchHasPlainDropdown('{:else if kind === "select"}\n<SearchableDropdown items={x} />\n'), false);
  // A plain Dropdown in a LATER branch is not this branch's problem (the file
  // legitimately mounts one elsewhere), so the scan must stop at the next kind.
  assert.equal(
    selectBranchHasPlainDropdown('{:else if kind === "select"}\n<SearchableDropdown />\n{:else if kind === "asset"}\n<Dropdown />\n'),
    false);
  // And the live file agrees with check 1.
  assert.equal(selectBranchHasPlainDropdown(inspectorSrc), false);
});

console.log(failures === 0 ? `\n${ran} checks passed` : `\n${failures} of ${ran} FAILED`);
process.exit(failures === 0 ? 0 : 1);
