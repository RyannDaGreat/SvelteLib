/**
 * Demo-widget infrastructure tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/demo_widget_test.js
 *
 * Proves the CUSTOM per-widget property mechanism ("self.*", Blender-style) end
 * to end, WITHOUT a browser or any edit to the evaluation engine:
 *   (1) customProps / defaultLabel pure-fn behavior.
 *   (2) the Demo Showcase widget composes its custom `inset` prop into BOTH its
 *       defaults and its inspector (under the "custom" category).
 *   (3) the custom prop is equation-capable + `self.*`-referenceable
 *       (isEquationValue / numericPropertyPaths — the generic gates).
 *   (4) THE load-bearing proof: evaluateState resolves the custom prop as a
 *       literal, a bare arithmetic equation, AND a universal `= …` equation —
 *       flowing entirely through the existing expression pass.
 *
 * The bare-node import of plugins/demo/showcase.js is itself under test here
 * (the demo folder MUST stay DOM-free at import time, like the rest of plugins/).
 */

import assert from "node:assert/strict";
import { customProps, defaultLabel, CUSTOM_CATEGORY, bundle } from "../core/properties.js";
import { isEquationValue, numericPropertyPaths, evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { demoShowcasePlugin } from "../plugins/demo/showcase.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) customProps / defaultLabel ────────────────────────────────────────────
test("defaultLabel: sentence-cases camel/snake/kebab names", () => {
  assert.equal(defaultLabel("inset"), "Inset");
  assert.equal(defaultLabel("cornerCut"), "Corner cut");
  assert.equal(defaultLabel("edge_gap"), "Edge gap");
});

test("customProps: rows carry no `default`, defaults carry only values", () => {
  const { rows, defaults } = customProps([{ name: "inset", kind: "number", default: 16 }]);
  assert.deepEqual(rows[0], { key: "inset", kind: "number", label: "Inset", category: CUSTOM_CATEGORY });
  assert.equal("default" in rows[0], false); // default belongs to defaults(), not the row
  assert.deepEqual(defaults, { inset: 16 });
});

test("customProps: explicit label/category/aspects override + pass through", () => {
  const { rows } = customProps([
    { name: "gap", kind: "number", default: 8, label: "Gap", category: "formatting", min: 0, max: 40 },
  ]);
  assert.equal(rows[0].label, "Gap");
  assert.equal(rows[0].category, "formatting"); // explicit category wins over CUSTOM_CATEGORY
  assert.equal(rows[0].min, 0);
  assert.equal(rows[0].max, 40);
});

test("customProps: LOUD on a malformed def (no silent failure)", () => {
  assert.throws(() => customProps([{ name: "x", kind: "number" }]), /needs a default/); // missing default
  assert.throws(() => customProps([{ kind: "number", default: 1 }]), /string name/); // missing name
});

// ── (2) the Demo Showcase widget composition ──────────────────────────────────
test("demo_showcase: declares the custom `inset` prop in its defaults", () => {
  assert.equal(demoShowcasePlugin.type, "demo_showcase");
  assert.equal(typeof demoShowcasePlugin.defaults.inset, "number"); // a literal number default
});

test("demo_showcase: the custom prop is an Inspector row in the `custom` category", () => {
  const insetRow = demoShowcasePlugin.inspector.find((r) => r.key === "inset");
  assert.ok(insetRow, "inset row present in inspector");
  assert.equal(insetRow.kind, "number");
  assert.equal(insetRow.category, CUSTOM_CATEGORY);
  // Still composes the shared bundles alongside it (positioning is present).
  const posKeys = bundle("positioning").map((r) => r.key);
  assert.ok(posKeys.every((k) => demoShowcasePlugin.inspector.some((r) => r.key === k)));
});

// ── (3) equation-capable + self.*-referenceable ───────────────────────────────
test("demo_showcase: custom prop is equation-capable (both gates)", () => {
  // Universal `=` gate (any-type) AND legacy numeric-slot bare string (number default).
  assert.equal(isEquationValue(demoShowcasePlugin, ["inset"], "= self.w / 4"), true);
  assert.equal(isEquationValue(demoShowcasePlugin, ["inset"], "self.w / 8"), true);
  // A plain literal number is NOT an equation.
  assert.equal(isEquationValue(demoShowcasePlugin, ["inset"], 20), false);
});

test("demo_showcase: custom prop is referenceable as self.inset", () => {
  // numericPropertyPaths lists exactly what is typeable/referenceable in equations
  // + surfaced by autocomplete — the discoverability guarantee.
  assert.ok(numericPropertyPaths(demoShowcasePlugin).includes("inset"));
});

// ── (4) evaluateState: literal + bare + `=` all resolve through the eval pass ──
const registry = createRegistry();
registry.register(demoShowcasePlugin);

function evalInset(insetValue, extra = {}) {
  const state = { vars: {}, items: { d1: { type: "demo_showcase", w: 240, h: 160, inset: insetValue, ...extra } } };
  const { state: ev, errors } = evaluateState(state, registry);
  return { value: ev.items.d1.inset, errors };
}

test("evaluateState: LITERAL inset passes through unchanged", () => {
  const { value, errors } = evalInset(25);
  assert.equal(value, 25);
  assert.equal(errors.size, 0);
});

test("evaluateState: `= self.w / 4` equation resolves against self", () => {
  const { value, errors } = evalInset("= self.w / 4");
  assert.equal(value, 60); // 240 / 4
  assert.equal(errors.size, 0);
});

test("evaluateState: BARE (no `=`) numeric-slot equation resolves", () => {
  const { value, errors } = evalInset("self.w / 8");
  assert.equal(value, 30); // 240 / 8
  assert.equal(errors.size, 0);
});

test("evaluateState: a bad equation fails LOUD + falls back to the default", () => {
  const { value, errors } = evalInset("= nope_no_such_var + 1");
  assert.equal(value, demoShowcasePlugin.defaults.inset); // deterministic default, never a silent NaN
  assert.ok(errors.size >= 1);
});

console.log(`\n${passed} tests passed`);
