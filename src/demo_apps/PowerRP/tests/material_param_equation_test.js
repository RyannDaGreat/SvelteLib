/**
 * MATERIAL PARAM EQUATIONS (R6-7) + the `direction2` heading function (R6-16.1).
 * Bare node, DOM-free — core/expressions.js reaching the material registries is
 * itself under test here (core/material_plugins.js already imports them, so the
 * bare-node requirement holds).
 *
 * THE DEFECT THIS PINS, in the two stacked halves the diagnosis proved:
 *
 *   1. resultKindForSlot typed EVERY `<paint>.material.params.*` slot
 *      "unresolved", because a material's knob SCHEMA lives in the material
 *      registry (fillParams / strokeParams) and not in `plugin.defaults` — the
 *      plugin's default for the paint key is a bare hex string. So the universal
 *      "=" was refused on all 299 built-in knobs across 22 materials.
 *   2. fallbackFor then wrote 0 — NOT the schema default — so an equation forced
 *      into the document by hand evaluated to a SILENT ZERO rather than the
 *      value the knob would have had.
 *
 * And the half that only shows up through the editor's own commit path:
 * NumericField commits `displayToStored`, which DROPS the "=" marker (R6-25.1
 * caveat (a)). On an ordinary numeric row that is harmless because isNumericSlot
 * recognises the slot anyway. A material knob was not a numeric slot, so the
 * stripped form landed as a SILENT LITERAL STRING. isNumericSlot therefore has to
 * learn the same schema, or fixing resultKindForSlot alone would leave the UI
 * still broken while every unit test passed.
 *
 * Run: node src/demo_apps/PowerRP/tests/material_param_equation_test.js
 */

import assert from "node:assert/strict";
import {
  FUNCTIONS, equationFunctionNames, resolveOverload,
  isEquationValue, isNumericSlot, resultKindForSlot, evaluateState,
} from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { rectPlugin } from "../plugins/rect.js";
import { getMaterial } from "../render_gpu/skia/materials.js";
import { getStrokeMaterial } from "../render_gpu/skia/stroke_materials.js";
import { MATERIAL_PARAM_KINDS } from "../core/material_plugins.js";
import { EDITOR_FREEZE_TIME } from "../core/particles.js"; // the PAUSED clock `= time` reads in a bare-node pass

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registry.register(rectPlugin);

// THE REPRODUCTION FROM THE MANIFEST, verbatim: "material -> atmosphere, type
// `=time`, refused". Atmosphere is the widest single material for this purpose —
// its eight knobs cover number, angle and color in one schema.
const ATMOSPHERE = "atmosphere";
/** A rect whose FILL is an atmosphere material paint, with `params` merged in. */
const atmosphereItem = (params) => ({
  ...rectPlugin.defaults,
  fill: { type: "material", material: { id: ATMOSPHERE, params } },
});
const knobPath = (name) => ["fill", "material", "params", name];

// ── (1) THE KIND RESOLVES — the "=" is no longer refused ─────────────────────

test("resultKindForSlot: every atmosphere knob types from its SCHEMA, not 'unresolved'", () => {
  const item = atmosphereItem({});
  const expected = { number: "number", angle: "number", color: "color", boolean: "boolean", select: "select", text: "string" };
  for (const row of getMaterial(ATMOSPHERE).fillParams) {
    const kind = resultKindForSlot(rectPlugin, knobPath(row.name), "= 1", item);
    assert.equal(kind, expected[row.kind], `${ATMOSPHERE}.${row.name} (schema kind "${row.kind}")`);
  }
});

test("resultKindForSlot: EVERY knob of EVERY built-in fill material types (no 'unresolved' left)", () => {
  let knobs = 0;
  for (const id of ["comic", "crt", "glitch", "sky", "metaballs", ATMOSPHERE]) {
    const item = { ...rectPlugin.defaults, fill: { type: "material", material: { id, params: {} } } };
    for (const row of getMaterial(id).fillParams) {
      if (!MATERIAL_PARAM_KINDS.has(row.kind)) continue; // `stops` is a LIST control, not a scalar slot
      const kind = resultKindForSlot(rectPlugin, knobPath(row.name), "= 1", item);
      assert.notEqual(kind, "unresolved", `${id}.${row.name}`);
      knobs++;
    }
  }
  assert.ok(knobs > 100, `expected the sweep to cover the bulk of the knob census, saw ${knobs}`);
});

test("resultKindForSlot: a STROKE slot reads strokeParams, not fillParams", () => {
  const item = { ...rectPlugin.defaults, stroke: { type: "material", material: { id: "wavy", params: {} } } };
  const row = getStrokeMaterial("wavy").strokeParams.find((r) => r.kind === "number");
  assert.equal(resultKindForSlot(rectPlugin, ["stroke", "material", "params", row.name], "= 1", item), "number");
});

test("resultKindForSlot: an UNKNOWN knob name is still 'unresolved' — never guessed", () => {
  assert.equal(resultKindForSlot(rectPlugin, knobPath("noSuchKnob"), "= 1", atmosphereItem({})), "unresolved");
});

test("resultKindForSlot: with NO item there is nothing to resolve against, and it says so", () => {
  assert.equal(resultKindForSlot(rectPlugin, knobPath("rimStrength"), "= 1"), "unresolved");
});

// ── (2) THE MARKER-STRIPPED FORM — what the editor's own commit path writes ───

test("isNumericSlot: a numeric knob IS a numeric slot, so a bare equation binds", () => {
  const item = atmosphereItem({});
  assert.equal(isNumericSlot(rectPlugin, knobPath("rimStrength"), item), true);
  assert.equal(isNumericSlot(rectPlugin, knobPath("lightAngle"), item), true, "an `angle` knob stores raw degrees — a number");
  assert.equal(isNumericSlot(rectPlugin, knobPath("glowColor"), item), false, "a colour knob is not a NUMBER slot");
  assert.equal(isNumericSlot(rectPlugin, knobPath("rimStrength")), false, "without the item nothing declares it");
});

test("isEquationValue: the marker-stripped form NumericField commits is an equation", () => {
  const item = atmosphereItem({});
  assert.equal(isEquationValue(rectPlugin, knobPath("rimStrength"), "time", item), true);
  assert.equal(isEquationValue(rectPlugin, knobPath("rimStrength"), "= time", item), true);
  assert.equal(isEquationValue(rectPlugin, knobPath("glowColor"), "= #ff0000", item), true, "the universal marker needs no numeric slot");
  assert.equal(isEquationValue(rectPlugin, knobPath("glowColor"), "#ff0000", item), false, "a literal colour is not an equation");
});

// ── (3) EVALUATION — the reproduction, end to end ────────────────────────────

test("evaluateState: `= time` on a material knob evaluates to the clock (the R6-7 repro)", () => {
  const state = { items: { r1: atmosphereItem({ rimStrength: "= time" }) } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.r1.fill.material.params.rimStrength, EDITOR_FREEZE_TIME);
});

test("evaluateState: a COLOUR knob takes a colour-valued equation", () => {
  const state = { items: { r1: atmosphereItem({ glowColor: "= #ff8800" }) } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.equal(s.items.r1.fill.material.params.glowColor, "#ff8800");
});

test("evaluateState: a knob equation reads a SIBLING widget, so a material can track one", () => {
  const state = {
    items: {
      r1: { ...atmosphereItem({ lightAngle: "= @r2.x / 10" }), x: 0, y: 0 },
      r2: { ...rectPlugin.defaults, x: 350, y: 0 },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.r1.fill.material.params.lightAngle, 35);
});

// ── (4) THE FALLBACK IS THE SCHEMA DEFAULT, NOT 0 ────────────────────────────

test("fallbackFor: a BROKEN knob equation falls back to the SCHEMA default, never a silent 0", () => {
  const state = { items: { r1: atmosphereItem({ rimStrength: "= no_such_variable" }) } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 1, "the failure must be REPORTED, not swallowed");
  const declared = getMaterial(ATMOSPHERE).fillParams.find((r) => r.name === "rimStrength").default;
  assert.equal(declared, 0.85);
  assert.equal(s.items.r1.fill.material.params.rimStrength, declared,
    "a zero here is the silent-fallback defect: the knob would render as if the author had asked for 0");
});

test("fallbackFor: a WRONG-KIND result falls back to the declared colour, not 0", () => {
  const state = { items: { r1: atmosphereItem({ glowColor: "= 5" }) } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 1);
  assert.equal(s.items.r1.fill.material.params.glowColor, getMaterial(ATMOSPHERE).fillParams.find((r) => r.name === "glowColor").default);
});

// ── (5) NO REGRESSION — a literal knob is untouched ──────────────────────────

test("literal knobs are byte-identical: nothing is collected, nothing is rewritten", () => {
  const params = { rimStrength: 0.4, glowColor: "#123456", lightAngle: -10 };
  const state = { items: { r1: atmosphereItem(params) } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.deepEqual(s.items.r1.fill.material.params, params);
});

test("a NON-material paint is untouched — the material step never fires on a solid/gradient", () => {
  const state = { items: { r1: { ...rectPlugin.defaults, fill: "#7aa2f7" } } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.equal(s.items.r1.fill, "#7aa2f7");
  assert.equal(resultKindForSlot(rectPlugin, ["fill"], "= #f00", state.items.r1), "color", "PROPS still wins for the paint itself");
});

// ── (6) direction2 (R6-16.1) ─────────────────────────────────────────────────

test("direction2 is in the ONE function registry, with a 4-number overload", () => {
  assert.ok(equationFunctionNames().includes("direction2"));
  assert.deepEqual(resolveOverload("direction2", 4).params, ["number", "number", "number", "number"]);
  assert.throws(() => resolveOverload("direction2", 3), /no 3-argument form/);
  assert.equal(typeof FUNCTIONS.direction2.impl, "function");
});

test("direction2: the heading convention matches the app's — degrees, y-down, [0, 360)", () => {
  const d = FUNCTIONS.direction2.impl;
  assert.equal(d(0, 0, 1, 0), 0);    // +x is 0°
  assert.equal(d(0, 0, 0, 1), 90);   // +y (screen DOWN) is 90°
  assert.equal(d(0, 0, -1, 0), 180);
  assert.equal(d(0, 0, 0, -1), 270); // wrapped, never -90
  assert.equal(d(10, 10, 20, 20), 45);
  assert.equal(d(0, 0, 0, 0), 0);    // a degenerate zero-length direction is 0°, not NaN
});

test("direction2: aiming a material's light knob at another widget (the user's case)", () => {
  const state = {
    items: {
      r1: { ...atmosphereItem({ lightAngle: "= direction2(self.x, self.y, @flare.x, @flare.y)" }), x: 100, y: 100 },
      flare: { ...rectPlugin.defaults, x: 200, y: 200, name: "Flare" },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.r1.fill.material.params.lightAngle, 45);
});

console.log(`\n${passed} material-param equation tests passed`);
