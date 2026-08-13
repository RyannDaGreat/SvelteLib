/**
 * THE FRAME DOMAIN'S TEST — core/exec_frame.js and the per-frame trigger nodes.
 *
 * WHAT IT PINS, and each one is a law from CLAUDE.md's "four kinds of state" rather
 * than a behaviour someone happened to implement:
 *
 *   Δt = 0 ⟹ BYTE-IDENTICAL. Three evaluations of ONE frame — the hover repaint
 *     web/CanvasView.svelte actually performs — must leave the identical state. This
 *     is the property a latch in `computeOutputs` would break, and it would break it
 *     GESTURE-DEPENDENTLY, which no eyeball catches.
 *   THE CADENCE IS FRAMERATE-INDEPENDENT. The user's chain increments once every two
 *     seconds at 24, 60 and 144 fps. A frame-counted implementation passes at one
 *     rate and fails at the others.
 *   A FROZEN PASS CANNOT ADVANCE ANYTHING. withSimulationFrozen() must be
 *     STRUCTURALLY unable to move a latch, so a thumbnail cannot corrupt the
 *     presenter's timeline.
 *   THE STRIDED-SHARD REFUSAL FIRES ON A STATEFUL NODE. This is the landmine: a
 *     Schmitt trigger has no `@` anywhere in the document, so the equation-source
 *     scan answers false and a render job would shard a trajectory by strided frame
 *     range — a plausible WRONG video on a green exit code.
 *   THE JAIL HOLDS FOR AUTHOR CODE, and a typo in a port declaration is a LOUD
 *     refusal rather than a silently deleted wire.
 *
 * Bare node, no browser: everything here is core.
 */

import assert from "node:assert";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import {
  FRAME_STEP_BUDGET, firedPortKeys, firedWireKeys, frameNodeIsSimulated, frameSlotKey,
  frameStateBytes, frameStateFrom, schmittBandProblem, schmittStep, stateUsesFrameDomain, stepFrameDomain,
} from "../core/exec_frame.js";
import { compileCustomNode, customNodePorts, customPortProblem } from "../core/custom_node.js";
import {
  beginSimulationStep, resetSimulation, setSimulationTimestepOverride, withSimulationFrozen,
} from "../core/simulation_history.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { deriveWires } from "../core/derive.js";
import { wireOps, WIRE_FLASH_INK } from "../core/node_chrome.js";
import { documentIsSimulated, newDocument, repairedDocument, stridedShardRefusal, uuid } from "../core/document.js";
import { execOverlayAt } from "../core/exec_flow.js";
import { DEMO_PRESETS, buildPresetItems } from "../plugins/demo_presets.js";
import { MATH_OPS } from "../plugins/node_math.js";

const registry = createRegistry();
registerPlugins(registry);

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The user's own chain, as a folded item map. Built here rather than taken from the
 *  preset so the two are INDEPENDENT: the preset is checked against this, and a
 *  preset that drifted from the demo it claims to be would show up as a failure
 *  rather than as two copies of one mistake agreeing. */
function userChain() {
  return {
    t: { type: "node_time", rate: 1, offset: 0, inputs: {} },
    two: { type: "node_number", value: 2, inputs: {} },
    m: { type: "node_math", op: "mod", inputs: { a: { item: "t", port: "out" }, b: { item: "two", port: "out" } } },
    c: { type: "node_compare", op: "ge", b: 1, inputs: { a: { item: "m", port: "out" } } },
    s: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 0, inputs: { in: { item: "c", port: "out" } }, exec: { then: { item: "i", port: "run" } } },
    i: { type: "node_increment", start: 0, step: 1, inputs: {}, exec: { then: { item: "v", port: "run" } } },
    v: { type: "node_set_var", initial: 0, value: 0, inputs: { value: { item: "i", port: "out" } }, exec: {} },
    d: { type: "node_display", inputs: { in: { item: "v", port: "out" } } },
  };
}

/** Walks `seconds` of presentation at `fps`, exactly as an exporter does (a DICTATED
 *  timestep and a per-frame clock override), and reports what the chain did. */
function walk(items, fps, seconds) {
  resetSimulation();
  setSimulationTimestepOverride(1 / fps);
  let fires = 0;
  let displayed = 0;
  const frames = Math.round(fps * seconds);
  for (let f = 0; f <= frames; f++) {
    const t = f / fps;
    setParticleTimeOverride(t);
    const dt = beginSimulationStep(t, 0.1);
    const result = stepFrameDomain(items, registry, dt);
    if (result.fired.s) fires++;
    displayed = result.outputs.v?.out ?? displayed;
  }
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
  return { fires, displayed };
}

console.log("exec_frame: the pure functions");

check("schmittStep latches, so a held-high signal fires exactly once", () => {
  assert.deepEqual(schmittStep(0.9, false), { fired: true, armed: true, released: false });
  assert.deepEqual(schmittStep(0.9, true), { fired: false, armed: true, released: false });
  // Wobbling back INTO the band must not re-arm — this is the whole point of two
  // thresholds, and a one-threshold implementation passes every other case here.
  assert.deepEqual(schmittStep(0.3, true), { fired: false, armed: true, released: false });
  assert.deepEqual(schmittStep(0.05, true), { fired: false, armed: false, released: true });
});

check("an inverted band is refused with a sentence; a zero-width one is allowed", () => {
  assert.equal(schmittBandProblem(0.1, 0.5), null);
  assert.equal(schmittBandProblem(0.5, 0.5), null, "a zero-width band is a plain comparator, which a 0/1 signal wants");
  assert.match(schmittBandProblem(0.9, 0.2), /at or below/);
  assert.match(schmittBandProblem(NaN, 0.5), /numbers/);
});

check("frame state round-trips through its serialization", () => {
  assert.equal(frameStateBytes({ armed: true }), '{"armed":true}');
  assert.deepEqual(frameStateFrom('{"armed":true}'), { armed: true });
  assert.equal(frameStateFrom("null"), undefined);
  assert.equal(frameStateFrom(undefined), undefined);
  // TWO EVALUATIONS OF ONE FRAME MUST SERIALIZE IDENTICALLY, which is what keeps
  // core/simulation_history.recordSimulationValue's `!==` safety net from crying wolf
  // on every ordinary second pass (it compares by identity, and a record is a fresh
  // object each step). Measured: without this the hover repaint reported three false
  // "advanced twice" violations naming two IDENTICAL states.
  assert.equal(frameStateBytes({ armed: true }), frameStateBytes({ armed: true }));
});

check("firedPortKeys normalizes the three spellings of `fired`", () => {
  const outs = [{ key: "then" }, { key: "else" }];
  assert.deepEqual(firedPortKeys(true, outs), ["then", "else"], "true means every declared exec out, as execNextPorts' default does");
  assert.deepEqual(firedPortKeys(["else"], outs), ["else"]);
  assert.deepEqual(firedPortKeys(false, outs), []);
  assert.deepEqual(firedPortKeys(undefined, outs), []);
  // A key the node does not declare is DROPPED rather than lighting a wire that
  // cannot exist.
  assert.deepEqual(firedPortKeys(["nope"], outs), []);
});

check("firedWireKeys names the pins that pulsed", () => {
  assert.deepEqual([...firedWireKeys({})], []);
  assert.deepEqual([...firedWireKeys({ s1: ["then"] })], ["s1.then"]);
  assert.deepEqual([...firedWireKeys({ s1: ["then", "else"] })], ["s1.then", "s1.else"]);
});

check("`mod` is EUCLIDEAN, so a negative dividend still lands in [0, b)", () => {
  assert.equal(MATH_OPS.mod.apply(7, 2), 1);
  // JS `%` answers -1 here, which would make a `== 1` downstream stop matching for
  // half the cycle with nothing to see. The node is a picture of a cycle, and a cycle
  // has no negative half.
  assert.equal(MATH_OPS.mod.apply(-1, 2), 1);
  assert.equal(MATH_OPS.mod.apply(4.5, 2), 0.5);
});

console.log("exec_frame: the declaration is what says SIMULATED");

check("frameNodeIsSimulated asks the plugin, never a type list", () => {
  assert.equal(frameNodeIsSimulated(registry.get("node_schmitt")), true);
  assert.equal(frameNodeIsSimulated(registry.get("node_increment")), true);
  assert.equal(frameNodeIsSimulated(registry.get("node_set_var")), true);
  // The PURE nodes in the same demo must NOT claim it — a deck of only these still
  // shards by strided frame range.
  assert.equal(frameNodeIsSimulated(registry.get("node_compare")), false);
  assert.equal(frameNodeIsSimulated(registry.get("node_time")), false);
  assert.equal(frameNodeIsSimulated(registry.get("rect")), false);
  assert.equal(frameNodeIsSimulated(null), false);
});

check("stateUsesFrameDomain costs a deck without one nothing", () => {
  assert.equal(stateUsesFrameDomain({ a: { type: "rect" } }, registry), false);
  assert.equal(stateUsesFrameDomain({ s: { type: "node_schmitt" } }, registry), true);
  // An INACTIVE node is not in the program, the same rule every other walk follows.
  assert.equal(stateUsesFrameDomain({ s: { type: "node_schmitt", active: false } }, registry), false);
});

check("frameSlotKey cannot collide with a property an author can spell", () => {
  assert.equal(frameSlotKey("a1"), "items.a1.__frame");
});

console.log("exec_frame: the stepping laws");

check("the user's chain increments once every two seconds", () => {
  const { fires, displayed } = walk(userChain(), 60, 10);
  assert.equal(fires, 5, "ten seconds of a two-second cycle is five rising edges");
  assert.equal(displayed, 5, "and the published tally is what the display shows");
});

check("the cadence is IDENTICAL at 24, 60 and 144 fps", () => {
  // The defining test that this is a function of ELAPSED TIME rather than of frames.
  // A frame-counted counter passes at exactly one of these three.
  for (const fps of [24, 60, 144]) {
    const { fires, displayed } = walk(userChain(), fps, 10);
    assert.equal(fires, 5, `at ${fps} fps`);
    assert.equal(displayed, 5, `at ${fps} fps`);
  }
});

check("Δt = 0 ⟹ byte-identical: three evaluations of one frame agree", () => {
  const items = userChain();
  resetSimulation();
  setSimulationTimestepOverride(1 / 60);
  // Walk to a firing instant, then evaluate that ONE frame three times, which is what
  // a hover repaint does. A latch advanced in computeOutputs would fire three times.
  for (let f = 0; f <= 61; f++) {
    setParticleTimeOverride(f / 60);
    stepFrameDomain(items, registry, beginSimulationStep(f / 60, 0.1));
  }
  const t = 62 / 60;
  setParticleTimeOverride(t);
  const dt = beginSimulationStep(t, 0.1);
  const a = stepFrameDomain(items, registry, dt);
  const b = stepFrameDomain(items, registry, dt);
  const c = stepFrameDomain(items, registry, dt);
  assert.deepEqual(a.outputs, b.outputs);
  assert.deepEqual(b.outputs, c.outputs);
  assert.deepEqual(a.fired, c.fired);
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
});

check("a frozen pass is STRUCTURALLY unable to advance a latch", () => {
  const items = userChain();
  resetSimulation();
  setSimulationTimestepOverride(1 / 60);
  for (let f = 0; f <= 120; f++) {
    setParticleTimeOverride(f / 60);
    stepFrameDomain(items, registry, beginSimulationStep(f / 60, 0.1));
  }
  setParticleTimeOverride(3);
  const before = stepFrameDomain(items, registry, beginSimulationStep(3, 0.1)).outputs.i.out;
  // A thumbnail of another slide, running while the presenter's clock is live.
  setParticleTimeOverride(7);
  withSimulationFrozen(() => stepFrameDomain(items, registry, beginSimulationStep(7, 0.1)));
  // The presenter's own next step must be unaffected by it.
  setParticleTimeOverride(3);
  const after = stepFrameDomain(items, registry, beginSimulationStep(3, 0.1)).outputs.i.out;
  assert.equal(after, before, "a frozen consumer wrote into the presenter's timeline");
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
});

check("a counter fired by TWO triggers on one frame advances ONCE", () => {
  // A frame covers dt seconds rather than being instantaneous, so a tally must not
  // depend on how many upstream branches happened to converge (a graph-shape fact).
  const items = {
    a: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 1, inputs: {}, exec: { then: { item: "i", port: "run" } } },
    b: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 1, inputs: {}, exec: { then: { item: "i", port: "run" } } },
    i: { type: "node_increment", start: 0, step: 1, inputs: {}, exec: {} },
  };
  resetSimulation();
  setSimulationTimestepOverride(1 / 60);
  // Frame 1 arms both at their initial condition (no fire); drive them low then high.
  setParticleTimeOverride(0);
  stepFrameDomain(items, registry, beginSimulationStep(0, 0.1));
  items.a.level = 0; items.b.level = 0;
  setParticleTimeOverride(1 / 60);
  stepFrameDomain(items, registry, beginSimulationStep(1 / 60, 0.1));
  items.a.level = 1; items.b.level = 1;
  setParticleTimeOverride(2 / 60);
  const r = stepFrameDomain(items, registry, beginSimulationStep(2 / 60, 0.1));
  assert.deepEqual(r.fired.a, ["then"]);
  assert.deepEqual(r.fired.b, ["then"]);
  assert.equal(r.outputs.i.out, 1, "two pulses on one frame advanced the tally twice");
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
});

check("a latch the chain never reaches still OBSERVES the frame", () => {
  // Phase 2 of the driver. Without it an unpulsed node would freeze at whatever it
  // last saw rather than holding — and a Schmitt trigger that never observes a low
  // sample never re-arms, so it fires once and is dead forever.
  const items = {
    s: { type: "node_schmitt", low: 0.5, high: 0.5, mode: "rise", level: 1, inputs: {}, exec: {} },
  };
  resetSimulation();
  setSimulationTimestepOverride(1 / 60);
  setParticleTimeOverride(0);
  stepFrameDomain(items, registry, beginSimulationStep(0, 0.1)); // arms at its initial condition
  items.s.level = 0;
  setParticleTimeOverride(1 / 60);
  const low = stepFrameDomain(items, registry, beginSimulationStep(1 / 60, 0.1));
  assert.equal(low.outputs.s.state, 0, "the trigger never observed the falling signal, so it could not re-arm");
  items.s.level = 1;
  setParticleTimeOverride(2 / 60);
  const high = stepFrameDomain(items, registry, beginSimulationStep(2 / 60, 0.1));
  assert.deepEqual(high.fired.s, ["then"], "and therefore could never fire again");
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
});

check("the step budget is a real ceiling", () => {
  assert.equal(typeof FRAME_STEP_BUDGET, "number");
  assert.ok(FRAME_STEP_BUDGET > 0);
});

console.log("exec_frame: THE STRIDED-SHARD LANDMINE");

check("a deck whose ONLY simulation is a trigger node refuses strided sharding", () => {
  // THE LANDMINE. `documentIsSimulated` used to scan equation SOURCE for `@`/`dt`,
  // and a stateful NODE has neither — so this document answered "not simulated",
  // `stridedShardRefusal` returned null, and cli/render_job.js would have sharded a
  // trajectory by strided frame range: a plausible WRONG video, on a green exit code,
  // that no existing test could catch because every simulated deck until now reached
  // the table through an equation.
  const doc = newDocument();
  const id = uuid();
  doc.slides[0].delta.items[id] = {
    type: "node_schmitt", x: 100, y: 100, w: 170, h: 120,
    low: 0.1, high: 0.5, level: 0, mode: "rise", inputs: {}, exec: {},
  };
  const repair = repairedDocument(doc, registry);
  assert.equal(documentIsSimulated(repair.doc, registry), true, "a stateful node IS simulated state");
  assert.match(stridedShardRefusal(repair.doc, registry), /SIMULATED STATE/);
});

check("a deck of only PURE trigger-family nodes still shards", () => {
  // The other direction, and it matters just as much: a refusal that fired on every
  // deck containing any node would cost every render its parallelism.
  const doc = newDocument();
  const id = uuid();
  doc.slides[0].delta.items[id] = {
    type: "node_compare", x: 100, y: 100, w: 150, h: 120, op: "eq", b: 0, inputs: {},
  };
  const repair = repairedDocument(doc, registry);
  assert.equal(documentIsSimulated(repair.doc, registry), false);
  assert.equal(stridedShardRefusal(repair.doc, registry), null);
});

check("the SLIDE domain does not mistake a frame node for one of its events", () => {
  // MEASURED BY THE BROWSER PROBE, and it threw on every derive of any deck
  // containing a Schmitt trigger: `nodeExecKind` reads PORTS, and a frame node's
  // (an exec OUT, no exec IN) are indistinguishable from an On Reveal's — so
  // core/exec_flow.js's boundary walk classified it as an event and called the
  // `execEvent` it does not have. The node suites drive stepFrameDomain directly and
  // never reach that walk, which is why this check exists in the shape it does:
  // it runs the SLIDE-domain overlay over a frame-domain deck.
  const doc = newDocument();
  const trigger = uuid();
  const target = uuid();
  doc.slides[0].delta.items[target] = { type: "rect", x: 0, y: 0, w: 10, h: 10 };
  doc.slides[0].delta.items[trigger] = {
    type: "node_schmitt", x: 100, y: 100, w: 170, h: 120,
    low: 0.1, high: 0.5, level: 0, mode: "rise", inputs: {},
    // A REAL EXEC WIRE, because `documentUsesExec` is a structural scan and an
    // empty `exec` map would make the whole walk cost nothing — which is exactly
    // the case that did NOT throw, and would have passed a weaker test.
    exec: { then: { item: target, port: "run" } },
  };
  const repair = repairedDocument(doc, registry);
  assert.doesNotThrow(
    () => execOverlayAt(repair.doc, 0, registry, (s) => s),
    "the slide-domain walk called execEvent on a frame-domain node",
  );
});

console.log("exec_frame: the wire flash");

check("a fired wire paints in the flash colour and thicker; a resting one is untouched", () => {
  const rest = wireOps({ from: { x: 0, y: 0 }, to: { x: 9, y: 0 }, type: "exec" });
  const lit = wireOps({ from: { x: 0, y: 0 }, to: { x: 9, y: 0 }, type: "exec", fired: true });
  // `path()` has already parsed the colour to RGBA (core/node_chrome.wireOps' own
  // doctest notes it), so the comparison is against the parsed flash ink rather than
  // the hex string — comparing to the constant's text would fail on a working flash.
  const flash = wireOps({ from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, type: "number", fired: true })[1].stroke;
  assert.deepEqual(lit[1].stroke, flash);
  assert.notDeepEqual(rest[1].stroke, flash, "a resting wire must keep its port TYPE's colour");
  assert.ok(typeof WIRE_FLASH_INK === "string" && WIRE_FLASH_INK.startsWith("#"), "the flash ink is a declared constant, not a literal in wireOps");
  assert.ok(lit[1].strokeWidth > rest[1].strokeWidth, "colour alone is not an accessible signal");
  assert.ok(lit[0].strokeWidth > rest[0].strokeWidth, "the halo widens with the wire");
});

check("deriveWires stamps `fired` from the frame domain, and nothing without it", () => {
  const nodes = [
    { itemId: "a", world: { x: 0, y: 0, rotation: 0, scale: 1 }, state: { w: 100, h: 80, exec: { then: { item: "b", port: "run" } } }, plugin: { ports: () => ({ outputs: [{ key: "then", type: "exec" }] }) } },
    { itemId: "b", world: { x: 200, y: 0, rotation: 0, scale: 1 }, state: { w: 100, h: 80 }, plugin: { ports: () => ({ inputs: [{ key: "run", type: "exec" }] }) } },
  ];
  // NO ARGUMENT defaults to the LAST DERIVE's fired set (that is how render_gpu's
  // scene walker gets the flash without its signature changing), and on a deck with
  // no frame nodes that set is empty — so this is byte-identical to what every caller
  // predating the frame domain got: no `fired` key at all, not `fired: false`.
  const resting = deriveWires(nodes);
  assert.equal(resting.length, 1);
  assert.equal("fired" in resting[0], false);
  const lit = deriveWires(nodes, firedWireKeys({ a: ["then"] }));
  assert.equal(lit[0].fired, true);
  // A pin that did NOT fire leaves its wire alone.
  assert.equal("fired" in deriveWires(nodes, firedWireKeys({ a: ["other"] }))[0], false);
});

check("every exec wire in the user's chain lights on a firing frame", () => {
  const items = userChain();
  resetSimulation();
  setSimulationTimestepOverride(1 / 60);
  let litOnFire = null;
  for (let f = 0; f <= 60 * 3; f++) {
    const t = f / 60;
    setParticleTimeOverride(t);
    const r = stepFrameDomain(items, registry, beginSimulationStep(t, 0.1));
    if (r.pulses > 0 && litOnFire === null) litOnFire = [...firedWireKeys(r.fired)].sort();
  }
  assert.deepEqual(litOnFire, ["i.then", "s.then", "v.then"], "the pulse must light the whole chain, not just its first hop");
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
});

console.log("custom node: the jail and the declared ports");

const HOST = { random: () => 0.5, time: () => 0, pointer: () => null };

check("a spec declares its ports, and they reach the widget", () => {
  const src = "ports.inputs=[{key:'a',type:'number'}]; ports.outputs=[{key:'out',type:'number'}]; exports.compute=(i)=>({out:i.a*2});";
  const spec = compileCustomNode(src, HOST);
  assert.equal(spec.error, null);
  assert.deepEqual(spec.ports.inputs, [{ key: "a", type: "number", label: "a" }]);
  assert.deepEqual(spec.compute({ a: 3 }), { out: 6 });
  // The cache read `declaredPorts` uses must answer the same thing.
  assert.deepEqual(customNodePorts(src).outputs[0].key, "out");
});

check("a TYPO in a port declaration is a LOUD refusal, never a deleted wire", () => {
  // This is the whole reason ports are DECLARED (Axoloti) rather than INFERRED from
  // the body (Max/MSP gen~): under inference a typo silently removes a port, and with
  // it the connection an author drew, with no error.
  assert.match(compileCustomNode("ports.inputs=[{key:'2a',type:'number'}];", HOST).error, /identifier/);
  assert.match(compileCustomNode("ports.inputs=[{key:'a',type:'banana'}];", HOST).error, /banana/);
  assert.match(compileCustomNode("ports.outputs=[{key:'o',type:'number'},{key:'o',type:'number'}]; exports.compute=()=>({});", HOST).error, /twice/);
  assert.equal(customPortProblem({ key: "a", type: "number" }, "inputs", new Set()), null);
});

check("FAILURE IS TOTAL: a broken spec declares NO ports, not half of them", () => {
  const spec = compileCustomNode("ports.outputs=[{key:'out',type:'number'}]; throw new Error('boom');", HOST);
  assert.match(spec.error, /boom/);
  assert.deepEqual(spec.ports.outputs, [], "half a node is worse than none — a vanished bead looks like a wire never drawn");
});

check("ports with no behaviour is refused rather than shipped inert", () => {
  assert.match(compileCustomNode("ports.outputs=[{key:'o',type:'number'}];", HOST).error, /compute|step/);
});

check("THE JAIL HOLDS: a spec cannot reach a wall clock", () => {
  // It COMPILES — the jail's `has` trap makes every free identifier undefined rather
  // than a syntax error — and then throws loudly on use, which is exactly what an
  // equation does. What must never happen is a working `Date.now()`.
  const spec = compileCustomNode("ports.outputs=[{key:'o',type:'number'}]; exports.compute=()=>({o: Date.now()});", HOST);
  assert.equal(spec.error, null);
  assert.throws(() => spec.compute({}), /Cannot read properties of undefined/);
  // Math.random is excised by SAFE_MATH; the seeded `random` is what a spec gets.
  const rnd = compileCustomNode("ports.outputs=[{key:'o',type:'number'}]; exports.compute=()=>({o: Math.random()});", HOST);
  assert.throws(() => rnd.compute({}), /not a function/);
});

check("declaring `exports.step` is what makes a custom node simulated", () => {
  const pure = "ports.outputs=[{key:'o',type:'number'}]; exports.compute=()=>({o:1});";
  const stateful = "ports.outputs=[{key:'then',type:'exec'}]; exports.step=(c)=>({fired:['then']});";
  assert.equal(compileCustomNode(pure, HOST).step, null);
  assert.equal(typeof compileCustomNode(stateful, HOST).step, "function");
});

check("the custom node widget carries its double-click handler AND its editor", () => {
  // core/exec_nodes.execNodePlugin is a WHITELIST, so both of these had to be added
  // to it in the same commit as this widget. A dropped declaration here is silent:
  // the build is green and double-clicking simply does nothing.
  const plugin = registry.get("node_custom");
  assert.equal(plugin.activate, "code_modal");
  assert.equal(plugin.codeEditor.property, "definition");
  assert.equal(plugin.codeEditor.language, "javascript");
  assert.equal(typeof plugin.frameStep, "function");
});

console.log("the demo preset");

check("the preset builds, and every type it names is registered", () => {
  const preset = DEMO_PRESETS.find((p) => p.id === "trigger-chain");
  assert.ok(preset, "TRIGGER_CHAIN is not in DEMO_PRESETS — a preset nobody can insert is not a feature");
  const memo = new Map();
  const idFor = (name) => (memo.has(name) ? memo.get(name) : (memo.set(name, `x-${name}`), memo.get(name)));
  const { states, order } = buildPresetItems(preset, registry, { x: 640, y: 360 }, idFor);
  assert.equal(order.length, 8);
  for (const id of order) assert.ok(registry.get(states[id].type), `${states[id].type} is not registered`);
});

check("the preset's wiring names ports that exist, in both maps", () => {
  const preset = DEMO_PRESETS.find((p) => p.id === "trigger-chain");
  const memo = new Map();
  const idFor = (name) => (memo.has(name) ? memo.get(name) : (memo.set(name, `x-${name}`), memo.get(name)));
  const { states } = buildPresetItems(preset, registry, { x: 640, y: 360 }, idFor);
  for (const [id, state] of Object.entries(states)) {
    const declared = registry.get(state.type).ports(state);
    for (const [port, conn] of Object.entries(state.inputs ?? {})) {
      assert.ok(declared.inputs.some((p) => p.key === port), `${state.type} has no input "${port}"`);
      assert.ok(states[conn.item], `a wire on ${id} names a missing item`);
      const srcPorts = registry.get(states[conn.item].type).ports(states[conn.item]);
      assert.ok(srcPorts.outputs.some((p) => p.key === conn.port), `${states[conn.item].type} has no output "${conn.port}"`);
    }
    for (const [port, conn] of Object.entries(state.exec ?? {})) {
      assert.ok(declared.outputs.some((p) => p.key === port), `${state.type} has no exec output "${port}"`);
      const dstPorts = registry.get(states[conn.item].type).ports(states[conn.item]);
      assert.ok(dstPorts.inputs.some((p) => p.key === conn.port), `${states[conn.item].type} has no exec input "${conn.port}"`);
    }
  }
});

check("the preset RUNS, and increments once every two seconds like the hand-built chain", () => {
  // The preset and `userChain()` are built independently on purpose: this is what
  // catches a preset that drifted from the demo it claims to be.
  const preset = DEMO_PRESETS.find((p) => p.id === "trigger-chain");
  const memo = new Map();
  const idFor = (name) => (memo.has(name) ? memo.get(name) : (memo.set(name, `x-${name}`), memo.get(name)));
  const { states } = buildPresetItems(preset, registry, { x: 640, y: 360 }, idFor);
  resetSimulation();
  setSimulationTimestepOverride(1 / 60);
  let fires = 0;
  let displayed = 0;
  for (let f = 0; f <= 60 * 10; f++) {
    const t = f / 60;
    setParticleTimeOverride(t);
    const r = stepFrameDomain(states, registry, beginSimulationStep(t, 0.1));
    if (r.fired["x-trigger"]) fires++;
    displayed = r.outputs["x-publish"]?.out ?? displayed;
  }
  assert.equal(fires, 5, "the preset does not do what its help text says");
  assert.equal(displayed, 5);
  setSimulationTimestepOverride(null);
  setParticleTimeOverride(null);
});

console.log(`\nexec_frame: ${passed} checks passed`);
