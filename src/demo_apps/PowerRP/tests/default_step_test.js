/**
 * defaultStep tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/default_step_test.js
 *
 * Covers THE intelligent fallback step for numeric sliders (src/lib/numberStep.js):
 *   (1) the pure defaultStep / decimalPlaces helpers (the doctested cases).
 *   (2) the resolution rule DraggableNumber applies: `step ?? defaultStep(default)`
 *       — an explicit step ALWAYS wins; only a missing step falls back.
 *   (3) the row → step derivation for real inspector props from core/properties.js,
 *       so the wiring (row.default → NumericField/Inspector → DraggableNumber) is
 *       pinned to concrete values.
 *
 * numberStep.js is DOM-free (pure math/string), so this runs in bare node.
 */

import assert from "node:assert/strict";
import { defaultStep, decimalPlaces } from "../../../lib/numberStep.js";
import { PROPS } from "../core/properties.js";

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

// ── (3) real inspector props → derived step (the wiring, end value) ───────────
// Inspector/NumericField thread `row.default` into DraggableNumber's defaultValue,
// which (absent an explicit step — no registry number prop sets one) becomes the
// effective step. These are the three requested buckets + the fall-through cases.
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
  const withStep = Object.entries(PROPS).filter(([, d]) => d.kind === "number" && "step" in d).map(([k]) => k).sort();
  assert.deepEqual(withStep, ["opacity", "particleFade"]);
});

console.log(`\n${passed} default-step tests passed.`);
