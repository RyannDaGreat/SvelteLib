/**
 * numberStep tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/default_step_test.js
 *
 * Covers THE step/sensitivity resolution for numeric sliders (src/lib/numberStep.js):
 *   (1) the pure defaultStep / decimalPlaces helpers (the doctested cases).
 *   (2) the resolution rule DraggableNumber applies: `step ?? defaultStep(default)`
 *       — an explicit step ALWAYS wins; only a missing step falls back.
 *   (3) the row → step derivation for real inspector props from core/properties.js,
 *       so the wiring is pinned to concrete values.
 *   (4) stepAtMost / refinedStep, and resolveScrub's PRECEDENCE + its
 *       step ≤ coefficient invariant.
 *   (5) A SWEEP over every numeric row of every registered plugin: the invariant
 *       holds for all of them, the untouched buckets really are untouched, and the
 *       BLIND rows (no evidence at all — a fractional property whose default is an
 *       integer or 0, with no declared scrub/bounds) are ENUMERATED rather than
 *       silently scrubbing at a whole unit per pixel.
 *
 * WHAT (3) DID NOT CATCH, and why (5) exists. (3) asserts `defaultStep(PROPS[k].default)`
 * — the pure helper on the registry's own default. It passed for a year while the
 * value never reached a control: core/properties.js `row()` destructures `default`
 * out of the row it builds (doctest: `row("cornerRadius").default // undefined`) and
 * `customProps()` moves it into the plugin's defaults, so Inspector.svelte's
 * `defaultValue={row.default ?? null}` was null for ALL 1507 numeric rows. A green
 * unit test over a rule nothing applied. (5) reads the ACTUAL plugin rows. That
 * wiring has since been deleted rather than repaired (the row's default would then
 * mirror the plugin's), so the Inspector passes NO defaultValue at all and
 * web/NumericField.svelte resolves it from the owning plugin's `defaults` — which
 * is exactly the source (5) below reads, so this file and the app now agree by
 * construction instead of by coincidence.
 *
 * numberStep.js is DOM-free (pure math/string), so this runs in bare node.
 */

import assert from "node:assert/strict";
import {
  defaultStep, decimalPlaces, stepAtMost, refinedStep, resolveScrub, COARSEST_DERIVED_STEP,
} from "../../../lib/numberStep.js";
import { PROPS } from "../core/properties.js";
// builtinRoster(), NOT allPlugins: this file SWEEPS "every shipped widget", and
// allPlugins is only the SOURCE-MODULE half of the roster — the five batch-1 widgets
// (donut, progress_bar, number, both clocks) moved to the built-in plugin-asset
// library and silently left every such sweep. See plugins/index.js builtinRoster.
import { builtinRoster } from "../plugins/index.js";

const roster = builtinRoster();

// web/NumericField.svelte's own constant: pixels of drag that span a bounded
// row's full range. Mirrored here so the sweep computes what the field computes.
const RANGE_DRAG_PX = 100;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) pure helpers: the doctested cases ─────────────────────────────────────
test("decimalPlaces: reads the shortest decimal string (sign-stripped)", () => {
  assert.equal(decimalPlaces(0.25), 2);
  assert.equal(decimalPlaces(2.5), 1);
  assert.equal(decimalPlaces(5), 0);
  assert.equal(decimalPlaces(240), 0);
  assert.equal(decimalPlaces(-0.05), 2);
  assert.equal(decimalPlaces(1e-7), 7); // scientific notation unwound
});

test("defaultStep: 10^(-decimalPlaces) of the default value", () => {
  assert.equal(defaultStep(0.25), 0.01);
  assert.equal(defaultStep(0.3), 0.1);
  assert.equal(defaultStep(2.5), 0.1);
  assert.equal(defaultStep(5), 1);
  assert.equal(defaultStep(240), 1);
  assert.equal(defaultStep(0.005), 0.001);
  assert.equal(defaultStep(-0.05), 0.01); // magnitude's precision
});

test("defaultStep: 0 / missing default stays continuous (null, not 1)", () => {
  assert.equal(defaultStep(0), null);
  assert.equal(defaultStep(null), null);
  assert.equal(defaultStep(undefined), null);
  assert.equal(defaultStep(NaN), null);
  assert.equal(defaultStep(Infinity), null);
});

// ── (2) resolution rule: explicit step always wins ────────────────────────────
// DraggableNumber computes `effectiveStep = step ?? defaultStep(defaultValue)`.
// This models that rule to pin the "explicit step untouched" invariant.
const resolveStep = (step, defaultVal) => step ?? defaultStep(defaultVal);
test("resolution: an explicit step wins over the derived fallback", () => {
  assert.equal(resolveStep(2, 0.25), 2); // ExportMp4Modal-style explicit step
  assert.equal(resolveStep(0.05, 0.25), 0.05); // DraggableNumber demo default
  assert.equal(resolveStep(1, 5), 1);
  // No explicit step → the derived fallback is used.
  assert.equal(resolveStep(null, 0.25), 0.01);
  assert.equal(resolveStep(undefined, 5), 1);
  assert.equal(resolveStep(null, 0), null); // 0 default → continuous
});

// ── (3) real inspector props → the DEFAULT-PRECISION rule, per registry prop ───
// What defaultStep says about each registry default. NOTE (corrected): these are
// assertions about the PURE RULE, not about what the control receives — a row
// built by properties.js `row()`/`customProps()` carries NO `default` at all, so
// NumericField resolves it from the owning plugin's `defaults` instead (see the
// header, and section (5) for the values rows actually end up with).
const stepFor = (key) => defaultStep(PROPS[key].default ?? null);
test("props with a fractional 1-dp default → step 0.1", () => {
  assert.equal(PROPS.shapeInnerRatio.default, 0.5);
  assert.equal(stepFor("shapeInnerRatio"), 0.1); // 0..1 knob, 1 decimal place
});
test("props with an integer default → step 1", () => {
  assert.equal(PROPS.shapePoints.default, 5);
  assert.equal(stepFor("shapePoints"), 1); // star points: whole numbers
  assert.equal(PROPS.particleSeed.default, 1);
  assert.equal(stepFor("particleSeed"), 1);
});
test("props with a 0 or absent default stay continuous (null)", () => {
  assert.equal(PROPS.strokeWidth.default, 0);
  assert.equal(stepFor("strokeWidth"), null); // 0 default → continuous
  assert.ok(!("default" in PROPS.x)); // positional props: no default
  assert.equal(stepFor("x"), null);
});
test("0..1 props with integer default 1 (opacity/particleFade) carry an explicit step:0.01 so they scrub smoothly, not snap", () => {
  // Their default is the integer 1, so the precision fallback alone would give
  // step 1 — snapping a 0..1 slider to just 0/1. An explicit step:0.01 in the
  // registry wins (resolveStep) and restores smooth scrubbing. These are the ONLY
  // number props that need an explicit step; every other slider uses the fallback.
  for (const key of ["opacity", "particleFade"]) {
    assert.equal(PROPS[key].step, 0.01);
    assert.equal(resolveStep(PROPS[key].step, PROPS[key].default), 0.01);
  }
  // curl / shoulder joined 2026-08-02 for the SAME reason: both are 0..1 knobs
  // whose default is the integer 1 or 0, so the precision fallback would snap them
  // to whole numbers and destroy the smooth curly⇄square⇄chevron sweep the brace
  // exists to offer. They are checked against the same rule rather than merely
  // added to the list.
  for (const key of ["curl", "shoulder"]) {
    assert.equal(PROPS[key].step, 0.01, `${key}: a 0..1 look knob needs an explicit step`);
    assert.equal(PROPS[key].min, 0);
    assert.equal(PROPS[key].max, 1);
  }
  // rasterDensity joined 2026-08-02 for the same reason arrived at from the
  // OTHER side: it is not a 0..1 knob at all (1 is its NEUTRAL, and useful values
  // run either way from there), but its default is still the integer 1, so the
  // precision fallback would snap it to whole numbers — turning "a bit crisper"
  // into a jump from 1x to 2x pixels, i.e. 4x the memory in one click. 0.1 rather
  // than 0.01 because the scale it feeds is itself bucketed to PDF_SCALE_STEP
  // (0.1) before it reaches the cache key, so a finer step would offer
  // adjustments that round away to nothing.
  assert.equal(PROPS.rasterDensity.step, 0.1);
  assert.equal(PROPS.rasterDensity.default, 1);
  assert.equal(resolveStep(PROPS.rasterDensity.step, PROPS.rasterDensity.default), 0.1);
  const withStep = Object.entries(PROPS).filter(([, d]) => d.kind === "number" && "step" in d).map(([k]) => k).sort();
  assert.deepEqual(withStep, ["curl", "opacity", "particleFade", "rasterDensity", "shoulder"]);
});

// ── (4) stepAtMost / refinedStep / resolveScrub precedence ────────────────────
test("stepAtMost: the largest power of ten a single increment can advance", () => {
  assert.equal(stepAtMost(0.0175), 0.01);
  assert.equal(stepAtMost(0.11), 0.1);
  assert.equal(stepAtMost(110), 100);
  assert.equal(stepAtMost(1), 1);
  assert.equal(stepAtMost(1e-7), 1e-7);
  // A computed span/100 carries float noise; the MAGNITUDE is what means
  // anything (decimal-string counting would have said 1e-18 here).
  assert.equal(stepAtMost(0.9 / RANGE_DRAG_PX), 0.001);
  assert.equal(stepAtMost(0), null);
  assert.equal(stepAtMost(null), null);
  assert.equal(stepAtMost(NaN), null);
});

test("refinedStep: a grid coarser than one pixel of drag is refined, never kept", () => {
  assert.equal(refinedStep(0.1, 0.0095), 0.001); // 0.1 would need ~10px per tick
  assert.equal(refinedStep(0.01, 0.02), 0.01); // already finer than a pixel
  assert.equal(refinedStep(0.001, null), 0.001); // no increment known → unchanged
  assert.equal(refinedStep(null, 0.02), null); // no grid to refine
  assert.equal(refinedStep(1, 1), 1); // exactly one step per pixel is fine
});

test("resolveScrub precedence: step > scrub > range > fractional default > null", () => {
  const at = (row) => resolveScrub({ dragPx: RANGE_DRAG_PX, ...row });
  // 1. an explicit step is the author's word — never second-guessed.
  assert.deepEqual(at({ step: 0.01, min: 0, max: 1, defaultValue: 1 }), { step: 0.01, coefficient: 0.01 });
  assert.equal(at({ step: 1, min: 0, max: 16, defaultValue: 0 }).step, 1); // mandelbrot fineExponent
  // 2. an explicit scrub outranks the range AND the default.
  assert.deepEqual(at({ scrub: 0.11, min: 0, max: 1000, defaultValue: 3 }), { step: 0.1, coefficient: 0.11 });
  // 3. the RANGE outranks the default — a 0..1 knob is fractional however its
  //    default is written, which is what an integer default cannot express.
  assert.deepEqual(at({ min: 0, max: 1, defaultValue: 1 }), { step: 0.01, coefficient: 0.01 });
  // 4. FRACTIONAL evidence: its own magnitude across one drag run.
  assert.deepEqual(at({ defaultValue: 0.8 }), { step: 0.001, coefficient: 0.008 });
  assert.deepEqual(at({ defaultValue: 0.001 }), { step: 1e-5, coefficient: 1e-5 });
  // …and a non-integer BOUND is proof too, even under an integral-looking
  // default (demo_comic.gamma {default: 1, min: 0.1}, demo_mandelbrot.glowWidth).
  assert.deepEqual(at({ min: 0.1, defaultValue: 1 }), { step: 0.01, coefficient: 0.01 });
  assert.deepEqual(at({ max: 0.5, defaultValue: 18 }), { step: 0.1, coefficient: 0.18 });
  // 5. nothing knowable → null/null, NEVER a fabricated whole-unit step.
  assert.deepEqual(at({ defaultValue: 0 }), { step: null, coefficient: null });
  assert.deepEqual(at({ defaultValue: 5 }), { step: null, coefficient: null });
  assert.deepEqual(at({}), { step: null, coefficient: null });
  // A half-open row with INTEGER bounds is not bounded and not proven fractional.
  assert.deepEqual(at({ min: 0, defaultValue: 900 }), { step: null, coefficient: null });
  // Proven fractional but ZERO magnitude: there is no scale to spread, so the row
  // still needs a declared scrub — proof alone must not invent a coefficient.
  assert.deepEqual(at({ min: 0.05, defaultValue: 0 }), { step: null, coefficient: null });
  // A derived grid is never coarser than one whole unit, however wide the range.
  assert.equal(at({ min: 1000, max: 12000, defaultValue: 5200 }).step, COARSEST_DERIVED_STEP);
  // dragPx is REQUIRED — a missing pixel run must fail loudly, not assume one.
  assert.throws(() => resolveScrub({ defaultValue: 0.5 }), /dragPx/);
  assert.throws(() => resolveScrub({ defaultValue: 0.5, dragPx: 0 }), /dragPx/);
});

test("resolveScrub: an INTEGER default never coarsens (the 437-row hazard)", () => {
  // text.lineSpacing = 1, sky.atmosphere = 1, demo_comic.gamma = 1 are all
  // fractional-in-use properties whose default is the integer 1. Quantizing them
  // to whole units would recreate the "opacity flicks between 0 and 1" bug, so an
  // integer default yields NO grid and NO sensitivity change at all.
  for (const d of [1, 2, 3, 5, 240, 1337, -4]) {
    assert.deepEqual(resolveScrub({ defaultValue: d, dragPx: RANGE_DRAG_PX }), { step: null, coefficient: null },
      `an integer default (${d}) must not quantize or re-scale a row`);
  }
});

// ── (5) THE SWEEP: every numeric row of every registered plugin ────────────────
// The row aspects a plugin actually declares, paired with the default the plugin
// actually stores (which is where properties.js keeps it — see the header).
const numericRows = roster.flatMap((p) =>
  (p.inspector ?? [])
    .filter((r) => r.kind === "number")
    .map((r) => ({
      plugin: p.type, key: r.key, label: r.label,
      // Inspector resolves a FUNCTION max against state; a dynamic bound is not a
      // static span, so the sweep treats it as unbounded (as the field does when
      // it resolves to null).
      min: typeof r.min === "number" ? r.min : null,
      max: typeof r.max === "number" ? r.max : null,
      scrub: r.scrub ?? null, step: r.step ?? null,
      defaultValue: typeof p.defaults?.[r.key] === "number" ? p.defaults[r.key] : null,
    })),
);
// `declaredStep` is kept because resolveScrub's own `step` shadows the row's.
const resolvedRows = numericRows.map((r) => ({ ...r, declaredStep: r.step, ...resolveScrub({ ...r, dragPx: RANGE_DRAG_PX }) }));

test("sweep: every plugin declares numeric rows for the sweep to see", () => {
  assert.ok(numericRows.length > 1400, `expected the full row population, got ${numericRows.length}`);
});

test("sweep: no DERIVED grid is coarser than one pixel of drag (step ≤ coefficient)", () => {
  // THE invariant. A violation means one pixel of drag cannot move the value at
  // all — the control looks frozen. Explicit `step` rows are the author's call
  // and are exempt (they opt into a coarse grid deliberately).
  const violations = resolvedRows.filter(
    (r) => r.declaredStep == null && r.step != null && r.coefficient != null && r.step > Math.abs(r.coefficient),
  );
  assert.deepEqual(violations.map((r) => `${r.plugin}.${r.key} step=${r.step} coeff=${r.coefficient}`), []);
});

test("sweep: rows with NO fractional evidence keep 1 unit/px and no grid", () => {
  // The no-regression bucket: positional rows (x/y/w/h), counts, and every row
  // whose default AND bounds are integral. A null coefficient is how NumericField
  // keeps DraggableNumber's own 1 unit/px, and a null step keeps it continuous.
  const integral = (v) => v == null || Number.isInteger(v);
  const untouched = resolvedRows.filter((r) => r.scrub == null && r.step == null && (r.min == null || r.max == null)
    && integral(r.defaultValue) && integral(r.min) && integral(r.max));
  for (const r of untouched) {
    assert.equal(r.coefficient, null, `${r.plugin}.${r.key} must keep 1 unit/px`);
    assert.equal(r.step, null, `${r.plugin}.${r.key} must stay continuous`);
  }
  // x/y/w/h specifically — a sensitivity regression here would be far worse than
  // the bug this rule fixes, so they are named.
  for (const key of ["x", "y", "w", "h"]) {
    for (const r of resolvedRows.filter((row) => row.key === key)) {
      assert.equal(r.coefficient, null, `${r.plugin}.${key} sensitivity must be untouched`);
      assert.equal(r.step, null, `${r.plugin}.${key} must stay continuous`);
    }
  }
});

test("sweep: the reported rows are FIXED — a fractional default now scrubs its own scale", () => {
  const of = (plugin, key) => resolvedRows.find((r) => r.plugin === plugin && r.key === key);
  // demo_mandelbrot.interiorThreshold (default 1e-3): the user's report — "the
  // default is 0.001 but it's incrementing and decrementing by one".
  const it = of("demo_mandelbrot", "interiorThreshold");
  assert.equal(it.defaultValue, 1e-3);
  assert.equal(it.coefficient, 1e-5); // was 1 unit/px, i.e. 1000× the value per pixel
  assert.equal(it.step, 1e-5);
  // demo_mandelbrot.rampPhase (default 0): NOT fixable by inference — a 0 default
  // and no bounds is zero evidence, so inference correctly declines and ONLY an
  // explicit `scrub` can rescue the row. That scrub is declared (UNIT_SPAN_SCRUB:
  // a looping ramp's phase has period exactly 1, so one full rotation per
  // RANGE_DRAG_PX is the right feel), which is why the coefficient below is 0.01
  // rather than null. The assertion is kept — inverted — because the POINT still
  // holds and is the reason the blind-row census exists: inference cannot reach a
  // zero-default unbounded row, so the fix has to be a declaration.
  // FORMERLY demo_mandelbrot.paletteOffset, which became the SHARED ramp property
  // `rampPhase` when the palette became a colour ramp (core/ramps.js) — the same
  // knob, the same declared scrub, migrated by the plugin's `legacyKeys`.
  const po = of("demo_mandelbrot", "rampPhase");
  assert.equal(po.defaultValue, 0);
  assert.equal(po.coefficient, 0.01, "rampPhase must scrub one ramp cycle per 100px — if this is null again, its declared `scrub` was dropped");
  // The wider class, one row per shape of default.
  assert.equal(of("demo_glass", "lightIntensity").coefficient, 0.008); // 0.8
  assert.equal(of("demo_lens_flare", "ghostSpacing").coefficient, 0.0033); // 0.33
  assert.equal(of("corkboard", "mottleScale").coefficient, 0.0002); // 0.02
  assert.equal(of("metaball", "specular").coefficient, 0.0175); // 1.75
});

test("sweep: bounded rows keep their range-scaled sensitivity EXACTLY", () => {
  // The range rule predates this change and must be untouched; only the grid is
  // new, and it is always finer than a pixel (asserted by the invariant above).
  for (const r of resolvedRows.filter((row) => row.scrub == null && row.min != null && row.max != null)) {
    assert.equal(r.coefficient, (r.max - r.min) / RANGE_DRAG_PX, `${r.plugin}.${r.key} range scaling changed`);
  }
  // Two named examples, including the drift where a hand-written row lost the
  // registry's step:0.01 (plugins/text.js opacity) — the range now covers it.
  const textOpacity = resolvedRows.find((r) => r.plugin === "text" && r.key === "opacity");
  assert.equal(textOpacity.step, 0.01);
  assert.equal(textOpacity.coefficient, 0.01);
});

test("sweep: rows with an explicit scrub keep it, and gain a grid finer than a pixel", () => {
  for (const r of resolvedRows.filter((row) => row.scrub != null)) {
    assert.equal(r.coefficient, r.scrub, `${r.plugin}.${r.key} declared scrub must win`);
    if (r.step != null) assert.ok(r.step <= r.scrub, `${r.plugin}.${r.key} grid coarser than its own scrub`);
  }
});

test("sweep: BLIND rows are REPORTED, not silently scrubbing at 1/px", () => {
  // NO SILENT FALLBACK. A row with no evidence at all keeps 1 unit/px, which is
  // useless when the property is in fact fractional — that IS the paletteOffset
  // report (`{name: "paletteOffset", kind: "number", default: 0}`: a fractional
  // palette rotation, no bounds, no scrub, so nothing in the row says so).
  // Inference CANNOT fix these; only a declared `scrub` on the row can. So the
  // census is PRINTED on every run, with the plugins that carry a calibrated
  // sibling called out first — a plugin that scrubbed some rows and left others
  // blind is where the next paletteOffset is hiding.
  //
  // Deliberately NOT pinned to an exact count: rows land in this repo constantly
  // (this assertion caught a +12-row change from another branch mid-run), and a
  // tripwire that fires for unrelated growth trains people to bump the number.
  // What IS asserted is the structural promise — blind means UNTOUCHED.
  const blind = resolvedRows.filter((r) => r.coefficient == null);
  const zeroDefault = blind.filter((r) => r.defaultValue === 0);
  // A plugin's OWN rows — not the shared transform/box/effect bundles, whose
  // keys live in PROPS (dotted keys, "shadow.dx", come from those bundles too).
  // Only an own row can be a widget-specific fractional knob, so those are the
  // ones a human should read; the 1000-odd bundle rows would bury them.
  const ownBlind = blind.filter((r) => r.declaredStep == null && !(r.key in PROPS) && !r.key.includes("."));
  const calibrated = new Set(resolvedRows.filter((r) => r.scrub != null).map((r) => r.plugin));
  const suspicious = ownBlind.filter((r) => calibrated.has(r.plugin));
  console.log(`      blind rows: ${blind.length} of ${resolvedRows.length}; ${zeroDefault.length} have a 0 default (the paletteOffset shape)`);
  console.log(`      blind WIDGET-OWN rows: ${ownBlind.length} — candidates for a declared \`scrub\``);
  console.log(`      …of those, in plugins that DO calibrate siblings (read these first): ${suspicious.map((r) => `${r.plugin}.${r.key}=${r.defaultValue}`).join(", ") || "none"}`);
  // Continuous unless the AUTHOR declared a grid (demo_mandelbrot.stripeDensity
  // declares step:1 with no bounds — an explicit choice, not an inference).
  assert.deepEqual(
    blind.filter((r) => r.declaredStep == null && r.step != null).map((r) => `${r.plugin}.${r.key}`), [],
    "a blind row must stay continuous, never land on a fabricated grid",
  );
  assert.ok(blind.length > 0, "the census query itself must still select rows");
});

console.log(`\n${passed} numberStep tests passed.`);
