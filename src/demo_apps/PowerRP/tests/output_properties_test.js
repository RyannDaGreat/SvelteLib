/**
 * OUTPUT PROPERTIES (core/output_properties.js + the ordering fix in
 * core/expressions.js) — the system-level facts, through REGISTERED PLUGINS.
 *
 * The per-function contracts are already pinned by doctests (tests/doctest_test.js
 * runs them). This suite pins what is true of the SYSTEM and was not true before:
 *
 *   1. THE ORDERING. A node's output is readable BY AN EQUATION. Before this, node
 *      outputs were computed inside deriveRenderTree — strictly after
 *      evaluateState — so `= knob1.out` could only ever report "has no property".
 *      That re-ordering is the whole of R7-7, and this is the assertion for it.
 *   2. THE TWO TIERS. An audio output is declared and referenceable (tier 1) but
 *      reading its VALUE is refused WITH A SENTENCE — never 0, never a stale
 *      sample. A number output has a value (tier 2).
 *   3. EVALUATED, NEVER STORED. The value appears on the evaluated state and NOT
 *      in the document, and it is not keyframeable.
 *   4. ONE EVALUATOR. The lazy pull resolver and the topological sweep agree, so
 *      the equation pass and the derive pass cannot disagree about a wire.
 *   5. THE INSPECTOR SURFACE EXISTS AND IS READ-ONLY (no JSON-only properties).
 *   6. THE NAME GATE is loud, in both of its forms.
 */

import assert from "node:assert";

import {
  OUTPUTS_CAT, SIGNAL_REASON, outputPropertyAt, outputPropertyDescriptors,
  outputPropertyInjection, outputPropertyRows, outputPropertyValue, outputValueProblem,
} from "../core/output_properties.js";
import { PORT_TYPES, PORT_TYPE_NAMES, evaluateNodeGraph, nodeOutputResolver, portReadable } from "../core/nodeflow.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { evaluateState } from "../core/expressions.js";
import { foldState } from "../core/document.js";

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
}

const registry = createRegistry();
registerPlugins(registry);

/** A folded state holding a knob (a tier-2 number source) and a display sink. */
function knobAndDisplay(knobValue = 0.25) {
  return {
    vars: {},
    items: {
      knob: { type: "node_knob", name: "Knob1", x: 0, y: 0, w: 90, h: 120, value: knobValue, min: 0, max: 1 },
      disp: { type: "node_display", name: "Disp1", x: 200, y: 0, w: 120, h: 80, inputs: { in: { item: "knob", port: "out" } } },
    },
  };
}

// ── 1. THE ORDERING: AN EQUATION CAN READ A NODE'S OUTPUT ────────────────────

check("R7-7 THE ORDERING: an equation reads a node's output port — the thing that was impossible before", () => {
  const state = knobAndDisplay(0.25);
  state.items.box = { type: "rect", x: 0, y: 0, w: 10, h: 10, rotation: "= knob1.out * 360" };
  const { state: out, errors } = evaluateState(state, registry);
  assert.strictEqual(errors.get("items.box.rotation"), undefined, `expected no error, got: ${errors.get("items.box.rotation")}`);
  assert.strictEqual(out.items.box.rotation, 90, "0.25 of a turn is 90 degrees");
});

check("R7-7: `self.<port>` works too — an item reads its OWN output", () => {
  const state = knobAndDisplay(0.5);
  state.items.knob.z = "= self.out * 8";
  const { state: out, errors } = evaluateState(state, registry);
  assert.strictEqual(errors.get("items.knob.z"), undefined, `expected no error, got: ${errors.get("items.knob.z")}`);
  assert.strictEqual(out.items.knob.z, 4);
});

check("R7-7: the value CROSSES A WIRE — an equation reading a math node reads its computed result", () => {
  const state = {
    vars: {},
    items: {
      a: { type: "node_number", name: "A", x: 0, y: 0, w: 90, h: 90, value: 3 },
      b: { type: "node_number", name: "B", x: 0, y: 120, w: 90, h: 90, value: 4 },
      m: { type: "node_math", name: "M", x: 150, y: 0, w: 90, h: 110, op: "add", inputs: { a: { item: "a", port: "out" }, b: { item: "b", port: "out" } } },
      box: { type: "rect", x: 0, y: 0, w: 10, h: 10, rotation: "= m.out" },
    },
  };
  const { state: out, errors } = evaluateState(state, registry);
  assert.strictEqual(errors.get("items.box.rotation"), undefined, `expected no error, got: ${errors.get("items.box.rotation")}`);
  assert.strictEqual(out.items.box.rotation, 7, "3 + 4 arrived through two wires and one equation");
});

check("R7-7: an EQUATION-DRIVEN wire still resolves before the output is read", () => {
  // `inputs.a` is itself an equation (the node-reference grammar). The pull must
  // settle that slot before it reads the wire, or the sum is computed off an
  // unwired zero — silently, which is exactly the class of bug this seam risks.
  const state = {
    vars: {},
    items: {
      a: { type: "node_number", name: "A", x: 0, y: 0, w: 90, h: 90, value: 5 },
      m: { type: "node_math", name: "M", x: 150, y: 0, w: 90, h: 110, op: "add", inputs: { a: "= a.out", b: null } },
      box: { type: "rect", x: 0, y: 0, w: 10, h: 10, rotation: "= m.out" },
    },
  };
  const { state: out, errors } = evaluateState(state, registry);
  assert.strictEqual(errors.get("items.box.rotation"), undefined, `expected no error, got: ${errors.get("items.box.rotation")}`);
  assert.strictEqual(out.items.box.rotation, 5, "the equation-authored wire carried 5, not the unwired 0");
});

check("R7-7: the output TWEENS, because its source is ordinary keyframable state", () => {
  // The whole reason this is property state and not a new kind: a knob keyframed
  // across two slides drives an EQUATION that retweens for free.
  //
  // THE ENDPOINTS ARE FRACTIONAL ON PURPOSE, and the first draft of this test was
  // wrong for it: core/interpolators.interpolate ROUNDS a lerp between two
  // INTEGERS, so a knob keyframed 0 → 1 steps rather than sweeping and the
  // mid-tween read is 1. That is existing, deliberate behaviour about integers, not
  // anything to do with outputs — 0.25 → 0.75 measures the claim this test makes.
  const doc = {
    meta: { slideW: 1280, slideH: 720 },
    slides: [
      { id: "s0", name: "one", delta: { items: {
        cam: { type: "camera", x: 0, y: 0, w: 1280, h: 720 },
        knob: { type: "node_knob", name: "Knob1", x: 0, y: 0, w: 90, h: 120, value: 0.25, min: 0, max: 1 },
        box: { type: "rect", name: "Box", x: 0, y: 0, w: 10, h: 10, rotation: "= knob1.out * 100" },
      } } },
      { id: "s1", name: "two", delta: { items: { knob: { value: 0.75 } } } },
    ],
  };
  const at = (i, alpha) => evaluateState(foldState(doc, i, alpha), registry).state.items.box.rotation;
  assert.strictEqual(at(0, 1), 25);
  assert.strictEqual(at(1, 1), 75);
  assert.strictEqual(at(1, 0.5), 50, "half way through the transition the OUTPUT is half way too");
});

// ── 2. THE TWO TIERS ─────────────────────────────────────────────────────────

check("TIER 1: an AUDIO output is declared and referenceable, and `readable` is the derived tier", () => {
  const plugin = registry.get("audio_oscillator");
  const descriptors = outputPropertyDescriptors(plugin, plugin.defaults);
  assert.ok(descriptors.length > 0, "an oscillator publishes an output");
  const out = descriptors.find((d) => d.name === "out");
  assert.ok(out, "…named `out`");
  assert.strictEqual(out.portType, "audio");
  assert.strictEqual(out.readable, false, "tier follows from the TYPE, not from a second list");
  assert.strictEqual(portReadable("audio"), false);
});

check("TIER 1: reading an audio output's VALUE is refused WITH A SENTENCE — never 0, never a stale sample", () => {
  const state = {
    vars: {},
    items: {
      osc: { type: "audio_oscillator", name: "Osc1", x: 0, y: 0, w: 150, h: 150 },
      box: { type: "rect", x: 0, y: 0, w: 10, h: 10, rotation: "= osc1.out" },
    },
  };
  const { state: out, errors } = evaluateState(state, registry);
  const message = errors.get("items.box.rotation");
  assert.ok(message, "the read FAILED");
  assert.ok(message.includes(SIGNAL_REASON), `the refusal states the reason; got: ${message}`);
  assert.ok(/Audio output/.test(message), `and names the type; got: ${message}`);
  assert.strictEqual(out.items.box.rotation, 0, "the slot falls back to its plugin DEFAULT, through the ordinary error path");
  assert.strictEqual(out.items.osc.out, undefined, "and NOTHING was injected — absent, not zero");
});

check("TIER 1: an audio node's `out` is not offered as a numeric autocomplete path", async () => {
  const { numericPropertyPaths } = await import("../core/expressions.js");
  assert.ok(!numericPropertyPaths(registry.get("audio_oscillator")).includes("out"), "a signal has no number to offer");
  assert.ok(numericPropertyPaths(registry.get("node_knob")).includes("out"), "a knob's does — referenceable implies discoverable");
});

check("TIER 2 vs TIER 1 is NOT decided by the type alone where the type cannot decide it", () => {
  // audio_trigger's output is typed `trigger` (readable), but its pulse train is
  // produced in the engine — the plugin has no computeOutputs, so there is no
  // value. The honest answer is a DIFFERENT sentence, not a 0 and not the audio one.
  const plugin = registry.get("audio_trigger");
  const d = outputPropertyAt(plugin, plugin.defaults, ["out"]);
  assert.strictEqual(d.readable, true, "the TYPE is one the document could hold");
  assert.strictEqual(outputPropertyValue(plugin, plugin.defaults, d, null), undefined, "but nothing produced a value");
  const problem = outputValueProblem(d, undefined);
  assert.ok(/publishes no value/.test(problem), `its own sentence; got: ${problem}`);
  assert.ok(!problem.includes(SIGNAL_REASON), "and NOT the audio-signal one, which would be a wrong reason");
});

// ── 3. EVALUATED, NEVER STORED ───────────────────────────────────────────────

check("EVALUATED, NEVER STORED: the value is on the evaluated state and nowhere in the document", () => {
  const doc = {
    meta: { slideW: 1280, slideH: 720 },
    slides: [{ id: "s0", name: "one", delta: { items: {
      cam: { type: "camera", x: 0, y: 0, w: 1280, h: 720 },
      knob: { type: "node_knob", name: "Knob1", x: 0, y: 0, w: 90, h: 120, value: 0.75, min: 0, max: 1 },
    } } }],
  };
  const folded = foldState(doc, 0, 1);
  assert.strictEqual(folded.items.knob.out, undefined, "the FOLD carries no output — it is not document state");
  assert.strictEqual(JSON.stringify(doc).includes('"out"'), false, "and no output key was written into the document");
  assert.strictEqual(evaluateState(folded, registry).state.items.knob.out, 0.75, "the EVALUATED state carries it");
});

check("EVALUATED, NEVER STORED: the row refuses keyframes and refuses editing", () => {
  const plugin = registry.get("node_knob");
  const row = outputPropertyRows(plugin, { ...plugin.defaults, out: 0.5 }).find((r) => r.key === "out");
  assert.ok(row, "there IS a row (no JSON-only properties)");
  assert.strictEqual(row.readOnly, true, "a read-only value that could be typed into would lie about its affordance");
  assert.strictEqual(row.keyframes, false, "…and one that could be keyframed would lie twice");
  assert.strictEqual(row.category, OUTPUTS_CAT);
  assert.strictEqual(row.unreadable, null, "it has a value, so it shows one rather than a reason");
});

check("EVALUATED, NEVER STORED: an unreadable row shows a REASON rather than a blank", () => {
  const plugin = registry.get("audio_oscillator");
  const row = outputPropertyRows(plugin, plugin.defaults).find((r) => r.key === "out");
  assert.ok(row, "a signal port still gets a row — it names something the author can WIRE");
  assert.ok(row.unreadable && row.unreadable.includes(SIGNAL_REASON), `and carries the reason; got: ${row.unreadable}`);
});

check("A DOCUMENT WITH NO NODES IS UNTOUCHED — no output key appears on any ordinary widget", () => {
  const state = { vars: {}, items: { r: { type: "rect", x: 0, y: 0, w: 10, h: 10 } } };
  const before = JSON.stringify(state.items.r);
  assert.strictEqual(JSON.stringify(evaluateState(state, registry).state.items.r), before);
});

// ── 4. ONE EVALUATOR, TWO DRIVERS ────────────────────────────────────────────

check("ONE EVALUATOR: the lazy pull resolver and the topological sweep agree", () => {
  const items = {
    a: { type: "node_number", name: "A", value: 3 },
    b: { type: "node_number", name: "B", value: 4 },
    m: { type: "node_math", name: "M", op: "multiply", inputs: { a: { item: "a", port: "out" }, b: { item: "b", port: "out" } } },
  };
  const swept = evaluateNodeGraph(items, registry).values;
  const pull = nodeOutputResolver(items, registry);
  for (const id of Object.keys(items))
    assert.deepStrictEqual(pull(id), swept[id], `the two drivers disagree about ${id}`);
  assert.strictEqual(swept.m.outputs.out, 12);
});

check("A CYCLE THROUGH OUTPUTS IS LOUD — the equation error names the chain, and the frame survives", () => {
  // Reachable only from a hand-edited document (connectionRefusal refuses one at
  // the gesture), which is exactly why it must not loop forever or answer 0.
  const items = {
    x: { type: "node_math", name: "X", op: "add", inputs: { a: { item: "y", port: "out" }, b: null } },
    y: { type: "node_math", name: "Y", op: "add", inputs: { a: { item: "x", port: "out" }, b: null } },
  };
  assert.throws(() => nodeOutputResolver(items, registry)("x"), /Cyclic node outputs/);
  const { errors } = evaluateState({ vars: {}, items: { ...items, box: { type: "rect", x: 0, y: 0, w: 10, h: 10, rotation: "= x.out" } } }, registry);
  assert.ok(/Cyclic node outputs/.test(errors.get("items.box.rotation") ?? ""), "the reading equation reports it");
});

// ── 5. DERIVED FACTS (the second producer — manifest R7-21's mechanism) ──────

check("A DERIVED FACT is read the same way, and asking for one does NOT compute the others", () => {
  // The shape that makes R7-21 possible: `w = "= self.node_width"` while
  // `node_height` legitimately reads the resolved `w`. An eager producer would
  // report that legitimate DAG as a cycle.
  let heightCalls = 0;
  const plugin = {
    type: "t_natural", title: "Natural", capabilities: {}, ephemeral: "none",
    defaults: { type: "t_natural", x: 0, y: 0, w: "= self.node_width", h: "= self.node_height" },
    inspector: [],
    outputProps: {
      node_width: { label: "Natural width", value: () => 120 },
      node_height: { label: "Natural height", value: (s) => { heightCalls++; return s.w / 2; } },
    },
    emit: () => [],
  };
  const reg = createRegistry();
  registerPlugins(reg);
  reg.register(plugin);
  const { state: out, errors } = evaluateState({ vars: {}, items: { n: { ...plugin.defaults } } }, reg);
  assert.strictEqual(errors.get("items.n.w"), undefined, `w failed: ${errors.get("items.n.w")}`);
  assert.strictEqual(errors.get("items.n.h"), undefined, `h failed: ${errors.get("items.n.h")}`);
  assert.strictEqual(out.items.n.w, 120);
  assert.strictEqual(out.items.n.h, 60, "the height followed the RESOLVED width — a DAG, not a cycle");
  assert.ok(heightCalls > 0 && heightCalls <= 2, `the height producer ran on demand, not per read (${heightCalls} calls)`);
});

// ── 6. THE NAME GATE ─────────────────────────────────────────────────────────

check("THE NAME GATE is loud: an output colliding with a STORED key is refused", () => {
  const plugin = { type: "t_collide", defaults: { value: 1 }, outputProps: { value: { value: () => 2 } } };
  assert.throws(() => outputPropertyDescriptors(plugin, {}), /also STORES a property of that name/);
});

check("THE NAME GATE is loud: a camelCase output name is refused, because no equation could spell it", () => {
  const plugin = { type: "t_camel", defaults: {}, outputProps: { nodeWidth: { value: () => 2 } } };
  assert.throws(() => outputPropertyDescriptors(plugin, {}), /not canonical snake_case/);
});

check("EVERY REGISTERED PLUGIN PASSES THE NAME GATE — the sweep, so a new widget cannot ship a collision", () => {
  for (const plugin of registry.all()) {
    const state = plugin.defaults ?? {};
    assert.doesNotThrow(() => outputPropertyDescriptors(plugin, state), `plugin "${plugin.type}"`);
    // …and the injection is a pure function of the declaration, so it runs too.
    assert.doesNotThrow(() => outputPropertyInjection(plugin, state, null), `plugin "${plugin.type}" injection`);
  }
});

check("EVERY PORT TYPE DECLARES ITS TIER — a new type cannot be added without deciding", () => {
  for (const name of PORT_TYPE_NAMES)
    assert.strictEqual(typeof PORT_TYPES[name].readable, "boolean", `port type "${name}" declares no tier`);
});

// ── SUMMARY ──────────────────────────────────────────────────────────────────

console.log(`output_properties: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
