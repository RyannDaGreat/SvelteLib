/**
 * MODE-SELECTOR ROW VISIBILITY (R6-31 / #218) + the DERIVED pattern schema (#220).
 * Bare node, DOM-free.
 *
 * ── WHAT A MODE SELECTOR IS ───────────────────────────────────────────────────
 * A property whose VALUE decides which of its SIBLINGS are applicable; the
 * inapplicable ones are HIDDEN, not shown inert. The user named three: the vector
 * pattern's `generator`, the material choice itself, and the text box rows. Only
 * the first needed work — see the CONTRAST test at the bottom for why, and it is
 * the design lesson of the whole task.
 *
 * ── WHY THIS SUITE EXISTS, IN TWO HALVES ──────────────────────────────────────
 * 1. VISIBILITY. `visibleWhen` is NOT new (born 76f968e, where the stroke
 *    material's OFF mode hid its width/trim rows; extended by e3caa3a to the text
 *    box rows). What is new is that MATERIAL KNOB rows honour it too, through the
 *    one shared filter materials.visibleKnobRows. The pattern's per-generator
 *    predicate is DERIVED from each generator's own `params`, so it cannot
 *    disagree with what patternCellFor forwards.
 * 2. THE ROWS THEMSELVES. Hiding inapplicable knobs while leaving APPLICABLE ones
 *    wired to a drifted schema would have fixed the symptom and left the disease:
 *    the flat schema was a hand-typed mirror of the roster and had diverged on 30
 *    aspects, with the flat value WINNING at resolution. Measured worst case:
 *    picking Scallop drew a degenerate pattern because `radius` meant a FRACTION
 *    (0.01–0.5, dots) on the flat row and an ABSOLUTE LENGTH (0.5–400) in the
 *    generator. The rows are now derived, which makes that unrepresentable.
 *
 * ── THE ASSERTIONS ARE DERIVED, NOT RESTATED ──────────────────────────────────
 * Every expectation below is computed from PATTERN_GENERATORS. A test that
 * re-typed "brick shows brickW, brickH, mortar" would be a THIRD copy of the
 * mirror this work removed, and would pass while the panel was wrong.
 *
 * Run: node src/demo_apps/PowerRP/tests/pattern_row_visibility_test.js
 */

import assert from "node:assert/strict";
import { PATTERN_GENERATORS, patternGeneratorIds, buildPatternCell } from "../core/vector_patterns.js";
import {
  PATTERN_FILL_PARAMS, PATTERN_PRESETS, PATTERN_MATERIAL, PATTERN_DEFAULT_GENERATOR,
  patternCellFor, generatorReadsKnob, patternSchemaProblem,
} from "../render_gpu/skia/pattern_material.js";
import { visibleKnobRows, materialFillParamDefaults, resolveMaterialPaint, getMaterial } from "../render_gpu/skia/materials.js";
import { slideState } from "../core/document.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const GENERATORS = patternGeneratorIds();
const DEFAULTS = materialFillParamDefaults(PATTERN_MATERIAL);
/** The rows the panel would draw for a pattern whose only written knob is its mode. */
const rowsFor = (generator) => visibleKnobRows(PATTERN_FILL_PARAMS, { ...DEFAULTS, generator }).map((r) => r.name);
/** The rows that carry NO predicate — the TILING knobs, derived rather than listed. */
const TILING = PATTERN_FILL_PARAMS.filter((r) => !r.visibleWhen).map((r) => r.name);

// ── (1) THE SHARED FILTER ────────────────────────────────────────────────────

test("visibleKnobRows: `hidden` drops a row, and does so with or without values", () => {
  const schema = [{ name: "gain" }, { name: "legacy", hidden: true }];
  assert.deepEqual(visibleKnobRows(schema).map((r) => r.name), ["gain"]);
  assert.deepEqual(visibleKnobRows(schema, { gain: 1 }).map((r) => r.name), ["gain"]);
});

test("visibleKnobRows: `visibleWhen` decides per VALUE, and is inert without values", () => {
  const schema = [{ name: "mode" }, { name: "brickW", visibleWhen: (p) => p.mode === "brick" }];
  assert.deepEqual(visibleKnobRows(schema, { mode: "brick" }).map((r) => r.name), ["mode", "brickW"]);
  assert.deepEqual(visibleKnobRows(schema, { mode: "stripes" }).map((r) => r.name), ["mode"]);
  // No values = a census of the schema (web/Inspector.svelte groupRows' own
  // polarity). A caller counting rows must not be forced to invent a mode.
  assert.deepEqual(visibleKnobRows(schema).map((r) => r.name), ["mode", "brickW"]);
});

test("visibleKnobRows returns the schema's OWN row objects, never rebuilt ones", () => {
  // core/multiselect.js's drift gate, same reasoning: a reference cannot drift
  // from itself, and the panel reads aspects (min/max/step/help) off these rows.
  const row = { name: "brickW", visibleWhen: () => true };
  assert.equal(visibleKnobRows([row], {})[0], row);
});

// ── (2) THE PATTERN PREDICATE IS DERIVED FROM THE GENERATORS ─────────────────

test("generatorReadsKnob answers from the generator's OWN params, for every generator × knob", () => {
  const everyKnob = PATTERN_FILL_PARAMS.map((r) => r.name);
  for (const id of GENERATORS)
    for (const knob of everyKnob) {
      const declared = PATTERN_GENERATORS[id].params.some((r) => r.name === knob);
      assert.equal(generatorReadsKnob(id, knob), declared, `${id} × ${knob}`);
    }
});

test("an UNRESOLVABLE mode shows every knob — an `=` equation is not a reason to hide a control", () => {
  // `generator` is equation-bindable like every other material param, so the panel
  // may be holding an expression it cannot evaluate. Hiding on a guess would take
  // controls away from exactly the author driving the mode from an equation.
  for (const knob of ["brickW", "period", "waveAmp"]) {
    assert.equal(generatorReadsKnob("= pick(n)", knob), true, knob);
    assert.equal(generatorReadsKnob("no_such_generator", knob), true, knob);
  }
  const shown = visibleKnobRows(PATTERN_FILL_PARAMS, { ...DEFAULTS, generator: "= pick(n)" });
  assert.equal(shown.length, PATTERN_FILL_PARAMS.length, "an equation-bound mode shows the whole schema");
});

test("an unwritten `generator` resolves exactly as patternCellFor resolves it", () => {
  assert.deepEqual(rowsFor(undefined), rowsFor(PATTERN_DEFAULT_GENERATOR));
  assert.equal(patternCellFor({ generator: undefined }).w, patternCellFor({ generator: PATTERN_DEFAULT_GENERATOR }).w);
});

// ── (3) THE PANEL, FOR EVERY GENERATOR, EXACTLY ──────────────────────────────

test("every generator shows the TILING knobs plus its OWN declared knobs — nothing else", () => {
  for (const id of GENERATORS) {
    const want = [...TILING, ...PATTERN_GENERATORS[id].params.map((r) => r.name)].sort();
    assert.deepEqual(rowsFor(id).sort(), want, id);
  }
});

test("hiding actually thins the panel — and plaid, which declares no knobs, shows the tiling alone", () => {
  // The falsifying half: if `visibleWhen` were dropped from the derived rows,
  // every generator would show all 34 and this fails immediately.
  assert.deepEqual(rowsFor("plaid"), TILING);
  assert.ok(TILING.length < PATTERN_FILL_PARAMS.length, "some rows must be gated at all");
  for (const id of GENERATORS)
    assert.ok(rowsFor(id).length < PATTERN_FILL_PARAMS.length, `${id} must hide something`);
  const widest = Math.max(...GENERATORS.map((id) => rowsFor(id).length));
  assert.ok(widest <= PATTERN_FILL_PARAMS.length - 20,
    `even the widest generator should hide 20+ of ${PATTERN_FILL_PARAMS.length} rows; widest showed ${widest}`);
});

test("a TILING knob is never hidden — it applies to every generator by construction", () => {
  for (const id of GENERATORS)
    for (const knob of TILING) assert.ok(rowsFor(id).includes(knob), `${id} must keep ${knob}`);
});

// ── (4) THE DRIFT GATE — the flat schema IS the roster ───────────────────────

test("DRIFT GATE: the schema's gated rows are EXACTLY the union of the generators' knobs", () => {
  const declared = new Set(GENERATORS.flatMap((id) => PATTERN_GENERATORS[id].params.map((r) => r.name)));
  const gated = new Set(PATTERN_FILL_PARAMS.filter((r) => r.visibleWhen).map((r) => r.name));
  assert.deepEqual([...gated].sort(), [...declared].sort(),
    "a generator knob with no row is an unreachable control; a gated row no generator reads can never show");
});

test("DRIFT GATE: every merged row's bounds CONTAIN every declarer's, and its step is the finest", () => {
  for (const row of PATTERN_FILL_PARAMS.filter((r) => r.visibleWhen)) {
    for (const id of GENERATORS) {
      const own = PATTERN_GENERATORS[id].params.find((r) => r.name === row.name);
      if (!own) continue;
      if (own.min !== undefined) assert.ok(row.min <= own.min, `${row.name}: ${id} accepts down to ${own.min}, the row stops at ${row.min}`);
      if (own.max !== undefined) assert.ok(row.max >= own.max, `${row.name}: ${id} accepts up to ${own.max}, the row stops at ${row.max}`);
      if (own.step !== undefined) assert.ok(row.step <= own.step, `${row.name}: ${id} steps by ${own.step}, the row by ${row.step}`);
      assert.equal(row.kind, own.kind, `${row.name}: ${id} declares kind ${own.kind}`);
    }
  }
});

test("DRIFT GATE: every merged default is a LEGAL value for every generator that reads the knob", () => {
  // This is the assertion `radius @ scallop` failed: the flat default was 0.2
  // while scallop accepted 0.5..400, so a fresh scallop rendered degenerate AND
  // its slider could not reach a usable value.
  for (const row of PATTERN_FILL_PARAMS.filter((r) => r.visibleWhen)) {
    if (typeof row.default !== "number") continue;
    for (const id of GENERATORS) {
      const own = PATTERN_GENERATORS[id].params.find((r) => r.name === row.name);
      if (!own) continue;
      assert.ok(row.default >= (own.min ?? -Infinity) && row.default <= (own.max ?? Infinity),
        `${row.name} defaults to ${row.default}, outside ${id}'s ${own.min}..${own.max}`);
    }
  }
});

test("patternSchemaProblem: null for the shipped roster, and it REFUSES each of the three defects", () => {
  assert.equal(patternSchemaProblem(), null);
  // (a) a generator shadowing a TILING knob's leaf
  assert.match(patternSchemaProblem({ a: { params: [{ name: "scale", kind: "number", default: 1 }] } }) ?? "",
    /also a TILING knob/);
  // (b) two declarers, two kinds, one control
  assert.match(patternSchemaProblem({
    a: { params: [{ name: "k", kind: "number", default: 1 }] },
    b: { params: [{ name: "k", kind: "boolean", default: true }] },
  }) ?? "", /one leaf renders one control/);
  // (c) THE COLLISION THAT WAS REALLY THERE — one name, two units
  assert.match(patternSchemaProblem({
    dots: { params: [{ name: "radius", kind: "number", default: 0.2, min: 0.01, max: 0.5 }] },
    scallop: { params: [{ name: "radius", kind: "number", default: 10, min: 0.5, max: 400 }] },
  }) ?? "", /two different quantities/);
});

// ── (5) HIDING IS A PANEL DECISION, NEVER A DOCUMENT ONE ─────────────────────

test("RESOLUTION IS BLIND TO VISIBILITY: every schema row still has a default, hidden or not", () => {
  assert.deepEqual(Object.keys(DEFAULTS).sort(), PATTERN_FILL_PARAMS.map((r) => r.name).sort());
});

test("a HIDDEN knob's stored value and its `=` EQUATION survive a mode switch, and switch back", () => {
  // The data-loss risk this feature could have introduced. brickW is read only by
  // `brick`; carry it while the mode is `stripes` (so its row is not on screen).
  const stored = { generator: "stripes", brickW: 33, mortar: "= 0.05 + 0.01" };
  assert.ok(!rowsFor("stripes").includes("brickW"), "precondition: brickW is HIDDEN under stripes");
  const paint = { type: "material", material: { id: PATTERN_MATERIAL.id, params: stored } };
  const reports = [];
  const resolved = resolveMaterialPaint(paint, null, {}, (k, m) => reports.push(m));
  assert.deepEqual(reports, [], "a knob the mode does not read is not 'unknown' — nothing may be dropped");
  assert.equal(resolved.resolvedParams.brickW, 33);
  assert.equal(resolved.resolvedParams.mortar, "= 0.05 + 0.01", "the equation is carried verbatim, not evaluated away");
  // Switch to brick: the row appears with the value intact. Switch back: still there.
  for (const generator of ["brick", "stripes", "brick"]) {
    const back = resolveMaterialPaint({ ...paint, material: { ...paint.material, params: { ...stored, generator } } }, null, {}, () => {});
    assert.equal(back.resolvedParams.brickW, 33, generator);
    assert.equal(back.resolvedParams.mortar, "= 0.05 + 0.01", generator);
  }
  assert.ok(rowsFor("brick").includes("brickW"), "and it is on screen again under brick");
});

test("a KEYFRAMED hidden knob survives the fold — a slide delta is not a panel row", () => {
  // Slide 0 creates the pattern with brickW keyframed; slide 1 switches the mode
  // to stripes, which does not read brickW. The fold must still carry it.
  const doc = { meta: {}, slides: [
    { id: "s0", name: "one", delta: { items: { p: {
      type: "rect", x: 0, y: 0, w: 10, h: 10,
      fill: { type: "material", material: { id: PATTERN_MATERIAL.id, params: { generator: "brick", brickW: 20 } } },
    } } } },
    { id: "s1", name: "two", delta: { items: { p: { fill: { material: { params: { brickW: 40 } } } } } } },
    { id: "s2", name: "three", delta: { items: { p: { fill: { material: { params: { generator: "stripes" } } } } } } },
  ] };
  const at = (i) => slideState(doc, i).items.p.fill.material.params;
  assert.equal(at(0).brickW, 20);
  assert.equal(at(1).brickW, 40, "the keyframe applied");
  assert.equal(at(2).brickW, 40, "and it is still there once the mode stopped reading it");
  assert.equal(at(2).generator, "stripes");
  assert.ok(!rowsFor("stripes").includes("brickW"), "…while its row is off screen");
});

// ── (6) THE PICTURE DOES NOT MOVE ────────────────────────────────────────────

test("hiding a row cannot change the CELL — the generator only ever saw its own knobs", () => {
  for (const id of GENERATORS) {
    const all = patternCellFor({ ...DEFAULTS, generator: id });
    const onlyVisible = Object.fromEntries(rowsFor(id).map((n) => [n, DEFAULTS[n]]));
    assert.deepEqual(patternCellFor({ ...onlyVisible, generator: id }), all, id);
    // …and stuffing every hidden knob with nonsense still cannot move it.
    const poisoned = { ...all && DEFAULTS, generator: id };
    for (const row of PATTERN_FILL_PARAMS) if (!rowsFor(id).includes(row.name)) poisoned[row.name] = 999;
    assert.deepEqual(patternCellFor(poisoned), all, `${id} (hidden knobs poisoned)`);
  }
});

test("every PRESET writes only knobs its generator reads, and none render through a hidden row", () => {
  const universal = new Set(TILING);
  for (const preset of PATTERN_PRESETS) {
    const id = preset.params.generator ?? PATTERN_DEFAULT_GENERATOR;
    const own = new Set(PATTERN_GENERATORS[id].params.map((r) => r.name));
    for (const knob of Object.keys(preset.params))
      assert.ok(own.has(knob) || universal.has(knob),
        `preset "${preset.id}" writes "${knob}", which ${id} never reads — now-invisible dead data`);
  }
});

test("a knob only ONE generator reads always defaults to that generator's own value", () => {
  // The half of the merge that is lossless: mostCommon of a single declaration is
  // that declaration. This is what fixes cobble's `stoneSize` (0.85 → its own
  // 0.28, which was outside cobble's own 0.05..0.6 and drew blobs) and scallop's
  // `overlap`, and it holds for 16 of the 26 gated rows.
  let sole = 0;
  for (const row of PATTERN_FILL_PARAMS.filter((r) => r.visibleWhen)) {
    const declarers = GENERATORS.filter((id) => PATTERN_GENERATORS[id].params.some((r) => r.name === row.name));
    if (declarers.length !== 1) continue;
    const own = PATTERN_GENERATORS[declarers[0]].params.find((r) => r.name === row.name);
    assert.equal(row.default, own.default, `${row.name} is ${declarers[0]}'s alone`);
    sole++;
  }
  assert.ok(sole >= 10, `expected the sole-declarer case to be the common one, saw ${sole}`);
});

test("SCALLOP picked from the dropdown now draws exactly what its own declaration says", () => {
  // The user-visible defect that started #220. Before derivation `radius` was one
  // leaf meaning two things, and the flat row was the DOT fraction: scallop got
  // 0.2 where its own declaration says 10, with a slider capped at 1.5 so the
  // value could not even be typed back. Renaming it to `period` joined the family
  // whose 0.5..400 step 0.5 it already had.
  assert.deepEqual(patternCellFor({ ...DEFAULTS, generator: "scallop" }), buildPatternCell("scallop", {}));
});

test("COBBLE's stone size is its own again; its ONE residual is `count`, and that is flattening's price", () => {
  // stoneSize was the degeneracy and it is fixed. `count` is genuinely shared with
  // random_dots (same quantity, same 1..200 bounds) and one leaf cannot hold both
  // 14 and 10, so the merge takes the more common. Recorded as an assertion rather
  // than prose so it cannot quietly grow into a second residual.
  const params = { ...DEFAULTS, generator: "cobble" };
  assert.equal(params.stoneSize, PATTERN_GENERATORS.cobble.params.find((r) => r.name === "stoneSize").default);
  const differing = PATTERN_GENERATORS.cobble.params.filter((own) => DEFAULTS[own.name] !== own.default).map((r) => r.name);
  assert.deepEqual(differing, ["count"], `cobble's defaults that are not its own: ${differing.join(", ")}`);
  assert.deepEqual(patternCellFor({ ...params, count: PATTERN_GENERATORS.cobble.params.find((r) => r.name === "count").default }),
    buildPatternCell("cobble", {}), "with count at its own value the cell is exactly the generator's");
});

/**
 * How many (generator, knob) pairs may resolve to a default that is not that
 * generator's own — the irreducible price of one flat leaf per knob name.
 *
 * MEASURED, both sides: the hand-written schema this replaced had 23, INCLUDING
 * the two degenerate ones (`scallop.radius`, `cobble.size`) where the value was
 * outside the generator's own bounds. Deriving with `mostCommon` leaves 21, all
 * of them ordinary within-range differences (a stripe period of 10 where the
 * author wrote 12). It cannot reach 0: `period` cannot be both 10 and 14 at one
 * leaf. Only un-flattening — a nested per-generator param — would, and that needs
 * an Inspector row kind that does not exist.
 */
const FLATTENING_RESIDUE_CAP = 21;

test("the residual cost of flattening is BOUNDED, named, and never a sole-declarer knob", () => {
  const offenders = GENERATORS.flatMap((id) =>
    PATTERN_GENERATORS[id].params.filter((own) => DEFAULTS[own.name] !== own.default).map((own) => `${id}.${own.name}`));
  assert.ok(offenders.length <= FLATTENING_RESIDUE_CAP,
    `flattening residue grew past ${FLATTENING_RESIDUE_CAP}: ${offenders.length} — ${offenders.join(", ")}`);
  // Every one must be a SHARED name. A knob only one generator reads has no
  // competing default, so if it appears here the merge has a bug.
  for (const entry of offenders) {
    const knob = entry.split(".")[1];
    const declarers = GENERATORS.filter((id) => PATTERN_GENERATORS[id].params.some((r) => r.name === knob));
    assert.ok(declarers.length > 1, `${entry} has one declarer, so its default had no reason to move`);
  }
});

// ── (7) THE CONTRAST THAT EXPLAINS THE WHOLE BUG ─────────────────────────────

test("the MATERIAL selector needed no work: registry DISPATCH preserves a sub-schema, flattening destroys it", () => {
  // The user named "vector pattern versus CRT versus metaballs" as the precedent
  // for hiding inapplicable options — and it already worked, because the panel
  // renders the CHOSEN material's fillParams and nobody flattened the registry
  // into one table. `generator` is the same relation one level down, flattened.
  // That is the design lesson, and it is worth more than the fix.
  const crt = getMaterial("crt").fillParams.map((r) => r.name);
  const pattern = getMaterial(PATTERN_MATERIAL.id).fillParams.map((r) => r.name);
  assert.ok(crt.length > 0 && pattern.length > 0);
  assert.deepEqual(crt.filter((n) => pattern.includes(n)), [],
    "two materials' knob schemas do not leak into each other — dispatch keeps them apart for free");
});

console.log(`\n${passed} pattern row-visibility tests passed`);
