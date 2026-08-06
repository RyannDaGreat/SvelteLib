/**
 * EXEC FLOW / TRIGGER PROPERTIES (manifest R7-8) — bare node.
 *
 * WHAT THIS FILE IS FOR. Four claims, and they are the four the feature is not
 * shippable without, because each one is a way the core invariant
 * `RenderTree = pure(document, [[slide, alpha]])` could have been lost:
 *
 *   1. AN EVENT PRODUCES THE EFFECT.        Without it the feature does nothing.
 *   2. REPLAY FROM SLIDE 0 IS IDENTICAL.    Without it a deck renders differently
 *                                           depending on how it was reached.
 *   3. THE OVERLAY DOES NOT DEPEND ON TIME. Δt = 0 must be byte-identical, and the
 *                                           overlay must not depend on alpha either
 *                                           — that second half is what keeps a
 *                                           mid-transition frame cheap AND correct.
 *   4. A NON-IDEMPOTENT EFFECT IS INEXPRESSIBLE. Not refused — absent from the
 *                                           vocabulary. Asserted by proving the
 *                                           roster has exactly one verb and that
 *                                           applying the pass twice changes nothing.
 *
 * Plus the cardinality mirror, which is the structural fact the whole design rests
 * on, and the "a deck with no triggers pays nothing" gate.
 */

import test from "node:test";
import assert from "node:assert";

import {
  EXEC_CAT, EXEC_KEY, EXEC_TYPE, compatibleExecTargets, connectionRefusal, execConnectPairs,
  execDisconnectPairs, execEdgesOf, execOutputRows, execWouldCycle, nodeInputRows, wirePairsFor,
} from "../core/nodeflow.js";
import { EXEC_KINDS, documentUsesExec, execKindProblem, execOverlayAt, nodeExecKind, withExecOverlay } from "../core/exec_flow.js";
import { outputPropertyDescriptors } from "../core/output_properties.js";
import { deriveWires } from "../core/derive.js";
import { wireDragStart, wireDrop } from "../core/wire_drag.js";
import { createRegistry } from "../core/registry.js";
import { allPlugins } from "../plugins/index.js";
import { execPlugins } from "../plugins/exec_index.js";
import { evaluateState } from "../core/expressions.js";
import { foldState } from "../core/document.js";

const registry = createRegistry();
for (const p of allPlugins) registry.register(p);

/** The app's real evaluator, minus the two inputs a bare-node deck cannot have (a
 *  project script and intrinsic content sizes). web/execOverlay.js is the binding
 *  the app ships; this is the same call with those two empty. */
const evaluate = (folded) => evaluateState(folded, registry, "").state;

/** A document from a list of per-slide item deltas. Written out rather than built
 *  through the app's helpers so a reader can see exactly what the deck says — these
 *  tests are about what a DOCUMENT means, and a helper would hide the input. */
function docOf(...slideItemDeltas) {
  return {
    meta: { name: "Exec", slideW: 1280, slideH: 720, script: "" },
    slides: slideItemDeltas.map((items, i) => ({ id: `s${i}`, name: `Slide ${i + 1}`, transition: { type: "tween", seconds: 0.5, curve: "ease", sound: null }, delta: { items } })),
  };
}

/** The state a consumer actually sees at (slide, alpha): the fold with this slide's
 *  trigger writes applied, then evaluated. The same two lines
 *  web/cameraFrame.evaluationAt runs. */
function seenAt(doc, slide, alpha = 1) {
  return evaluate(withExecOverlay(foldState(doc, slide, alpha), execOverlayAt(doc, slide, registry, evaluate)));
}

// A rectangle whose `x` an event will write, and the two trigger nodes that write
// it. `revealer` watches ITSELF (empty `watch`), which is the BeginPlay reading.
const RECT = { type: "rect", x: 10, y: 10, w: 100, h: 100, fill: "#fff", opacity: 1, active: true };
const setterAt = (target, path, value, extra = {}) => ({
  ...registry.get("node_set_property").defaults, target, path, value, ...extra,
});
const revealerAt = (extra = {}) => ({ ...registry.get("node_on_reveal").defaults, ...extra });

// ── 1 · AN EVENT PRODUCES THE EFFECT ─────────────────────────────────────────

test("an event fires its chain and the effect lands on the document", () => {
  const doc = docOf({
    box: { ...RECT },
    ev: revealerAt({ [EXEC_KEY]: { then: { item: "eff", port: "run" } } }),
    eff: setterAt("box", "x", 500),
  });
  // Without the overlay the fold says what the author typed.
  assert.equal(foldState(doc, 0).items.box.x, 10);
  // With it, slide 0's reveal has already run: 500 is what the audience sees.
  assert.equal(seenAt(doc, 0).items.box.x, 500);
});

test("an effect aimed at a widget that is not on the slide writes nothing, silently", () => {
  // A per-slide patch, not an error — the rule core/nodeflow.connectionsOf states
  // for a wire whose source is off the slide, applied to the other end of a chain.
  const doc = docOf({
    box: { ...RECT, active: false },
    ev: revealerAt({ [EXEC_KEY]: { then: { item: "eff", port: "run" } } }),
    eff: setterAt("box", "x", 500),
  });
  assert.equal(seenAt(doc, 0).items.box.x, 10);
});

test("On Reveal watching ANOTHER widget fires on the boundary it appears", () => {
  const doc = docOf(
    { box: { ...RECT, active: false }, ev: revealerAt({ watch: "box", [EXEC_KEY]: { then: { item: "eff", port: "run" } } }), eff: setterAt("box", "y", 400) },
    { box: { active: true } }
  );
  assert.equal(seenAt(doc, 0).items.box.y, 10, "not yet — the box is not on slide 1");
  assert.equal(seenAt(doc, 1).items.box.y, 400, "the box appeared, so the trigger fired");
});

test("On Threshold turns an output property into an event — the user's requirement, literally", () => {
  // `level` is keyframed 0.2 → 0.8 across a 0.5 line. That is an ORDINARY property
  // becoming a pulse, which is the whole of "an output property, followed by a
  // trigger property, should trigger events".
  const doc = docOf(
    { box: { ...RECT }, t: { ...registry.get("node_on_threshold").defaults, level: 0.2, threshold: 0.5, mode: "rise", [EXEC_KEY]: { then: { item: "eff", port: "run" } } }, eff: setterAt("box", "opacity", 0.25) },
    { t: { level: 0.8 } }
  );
  assert.equal(seenAt(doc, 0).items.box.opacity, 1, "0.2 is below the line and slide 0 has nothing to compare against");
  assert.equal(seenAt(doc, 1).items.box.opacity, 0.25, "0.2 → 0.8 crossed 0.5 upward");
});

test("Sequence fires its outputs in declaration order and LAST WRITE WINS", () => {
  const doc = docOf({
    box: { ...RECT },
    ev: revealerAt({ [EXEC_KEY]: { then: { item: "seq", port: "run" } } }),
    seq: { ...registry.get("node_sequence").defaults, count: 2, [EXEC_KEY]: { then_1: { item: "a", port: "run" }, then_2: { item: "b", port: "run" } } },
    a: setterAt("box", "x", 111),
    b: setterAt("box", "x", 222),
  });
  assert.equal(seenAt(doc, 0).items.box.x, 222, "then_2 ran after then_1, so its write survived");
});

test("Gate takes exactly one arm, and an unwired arm means the chain simply ends", () => {
  const deck = (condition) => docOf({
    box: { ...RECT },
    ev: revealerAt({ [EXEC_KEY]: { then: { item: "g", port: "run" } } }),
    g: { ...registry.get("node_gate").defaults, condition, [EXEC_KEY]: { then: { item: "yes", port: "run" } } },
    yes: setterAt("box", "x", 777),
  });
  assert.equal(seenAt(deck(1), 0).items.box.x, 777);
  assert.equal(seenAt(deck(0), 0).items.box.x, 10, "the else arm is unwired: zero occurrences");
});

test("Delay is LATENT — it schedules, returns, and its continuation lands N slides later", () => {
  const doc = docOf(
    { box: { ...RECT }, ev: revealerAt({ [EXEC_KEY]: { then: { item: "d", port: "run" } } }), d: { ...registry.get("node_delay").defaults, slides: 2, [EXEC_KEY]: { then: { item: "eff", port: "run" } } }, eff: setterAt("box", "x", 999) },
    {},
    {}
  );
  assert.equal(seenAt(doc, 0).items.box.x, 10, "scheduled, not run");
  assert.equal(seenAt(doc, 1).items.box.x, 10, "still waiting");
  assert.equal(seenAt(doc, 2).items.box.x, 999, "two boundaries later");
});

test("a wired VALUE socket beats the knob, and it reads a whole data CHAIN", () => {
  // knob-or-input duality (R7-10), and the chain proves the exec pass resolves the
  // data graph topologically rather than one level deep.
  const doc = docOf({
    box: { ...RECT },
    n: { ...registry.get("node_number").defaults, value: 3 },
    m: { ...registry.get("node_math").defaults, op: "add", inputs: { a: { item: "n", port: "out" }, b: { item: "n", port: "out" } } },
    ev: revealerAt({ [EXEC_KEY]: { then: { item: "eff", port: "run" } } }),
    eff: setterAt("box", "x", 1, { inputs: { value: { item: "m", port: "out" } } }),
  });
  assert.equal(seenAt(doc, 0).items.box.x, 6, "3 + 3 through the wire, not the knob's 1");
});

// ── 2 · REPLAY FROM SLIDE 0 IS IDENTICAL ─────────────────────────────────────

test("replaying from slide 0 gives an IDENTICAL result, however many times", () => {
  const doc = docOf(
    { box: { ...RECT }, ev: revealerAt({ [EXEC_KEY]: { then: { item: "eff", port: "run" } } }), eff: setterAt("box", "x", 42) },
    { box: { y: 77 } },
    { ev2: revealerAt({ [EXEC_KEY]: { then: { item: "eff2", port: "run" } } }), eff2: setterAt("box", "y", 1) }
  );
  const once = execOverlayAt(doc, 2, registry, evaluate);
  // A SECOND, COMPLETELY FRESH REPLAY: a structurally equal document is a different
  // object, so it misses the per-document memo and genuinely re-runs the recurrence.
  const twice = execOverlayAt(JSON.parse(JSON.stringify(doc)), 2, registry, evaluate);
  assert.deepEqual(twice, once);
  // …and the prefix a viewer passed through on the way is the same as asking for it
  // directly, which is what "replay" has to mean.
  assert.deepEqual(execOverlayAt(JSON.parse(JSON.stringify(doc)), 1, registry, evaluate), execOverlayAt(doc, 1, registry, evaluate));
});

test("the pass is IDEMPOTENT: applying the overlay twice is the same as applying it once", () => {
  const doc = docOf({ box: { ...RECT }, ev: revealerAt({ [EXEC_KEY]: { then: { item: "eff", port: "run" } } }), eff: setterAt("box", "x", 300) });
  const overlay = execOverlayAt(doc, 0, registry, evaluate);
  const once = withExecOverlay(foldState(doc, 0, 1), overlay);
  const twice = withExecOverlay(once, overlay);
  assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)));
});

// ── 3 · THE OVERLAY IS A FUNCTION OF POSITION, NOT OF TIME ───────────────────

test("Δt = 0 is byte-identical, and so is every alpha within one slide", () => {
  const doc = docOf(
    { box: { ...RECT }, ev: revealerAt({ [EXEC_KEY]: { then: { item: "eff", port: "run" } } }), eff: setterAt("box", "x", 55) },
    { box: { x: 900 } }
  );
  const overlay = execOverlayAt(doc, 1, registry, evaluate);
  // Δt = 0: the same question twice, no clock in between.
  assert.strictEqual(execOverlayAt(doc, 1, registry, evaluate), overlay);
  // AND THE STRONGER HALF: the overlay does not take alpha at all, so a
  // mid-transition frame applies the same writes a settled one does. That is what
  // makes one replay serve a whole tween — see core/exec_flow.js's schedule section.
  for (const alpha of [0, 0.25, 0.5, 1]) {
    assert.strictEqual(execOverlayAt(doc, 1, registry, evaluate), overlay, `alpha ${alpha} must not change the overlay`);
  }
});

test("a deck with NO exec wires pays nothing — no evaluation at all", () => {
  const doc = docOf({ box: { ...RECT } });
  let calls = 0;
  const counted = (s) => { calls++; return evaluate(s); };
  assert.equal(execOverlayAt(doc, 0, registry, counted), null);
  assert.equal(calls, 0, "documentUsesExec answered before anything was folded or evaluated");
  assert.equal(documentUsesExec(doc), false);
});

// ── 4 · A NON-IDEMPOTENT EFFECT IS INEXPRESSIBLE ─────────────────────────────

test("the effect vocabulary has ONE verb, and `add 1 to <anything>` is still unspellable", () => {
  // THE CLAIM, restated precisely when the Counter landed — because the naive version
  // of it ("only one plugin can write") stopped being true and the sharper one is
  // what the manifest's rule was actually protecting:
  //
  //   (a) every effect returns [path, value] SET pairs — no verb slot, no read-back;
  //   (b) exactly ONE plugin can write to a target it does not own, and that one has
  //       no accumulation affordance at all;
  //   (c) the accumulating plugin can ONLY write its own leaf.
  //
  // So there is still no way for an author to point an increment at an arbitrary
  // property, which is the thing that would have made a document's meaning depend on
  // how it was traversed rather than on where it is. See plugins/node_counter.js.
  const effectful = allPlugins.filter((p) => typeof p.execEffect === "function");
  assert.deepEqual(effectful.map((p) => p.type).sort(), ["node_counter", "node_set_property"]);
  for (const p of effectful) {
    const pairs = p.execEffect({ id: "SELF", self: { ...p.defaults, target: "OTHER", path: "x", value: 5 }, inputs: {}, runIndex: 0 });
    for (const pair of pairs) {
      assert.equal(pair.length, 2, `${p.type}: a pair is a path and a value — there is no third slot for a verb`);
      assert.ok(Array.isArray(pair[0]));
    }
    // (b) and (c): who each one is allowed to touch.
    const targets = pairs.map((pair) => pair[0][1]);
    if (p.type === "node_counter") assert.deepEqual(targets, ["SELF"], "a counter accumulates its OWN leaf and nothing else");
    else assert.deepEqual(targets, ["OTHER"], "the general effect writes where it is pointed — and only ever sets");
  }
  // The general effect has no way to express an accumulation: its value comes from a
  // number socket or a plain knob, and neither is the target's current value.
  const setter = allPlugins.find((p) => p.type === "node_set_property");
  assert.deepEqual(setter.execEffect({ id: "s", self: { target: "b", path: "x", value: 5 }, inputs: {} }), [[["items", "b", "x"], 5]]);
  assert.deepEqual(setter.execEffect({ id: "s", self: { target: "b", path: "x", value: 5 }, inputs: {} }), setter.execEffect({ id: "s", self: { target: "b", path: "x", value: 5 }, inputs: {} }), "the same input twice is the same write — idempotent by construction");
});

test("the COUNTER increments once per pulse, twice for two pulses at one boundary", () => {
  // The user's second demo, and the case the design said was forbidden — see
  // plugins/node_counter.js for why it is not. Two events into ONE counter at the
  // same boundary must tick it TWICE; that is what ctx.runIndex is for, and reading
  // the value back instead would have collapsed them into one, silently.
  const doc = docOf(
    {
      c: { ...registry.get("node_counter").defaults, count: 0, step: 1 },
      a: revealerAt({ [EXEC_KEY]: { then: { item: "c", port: "run" } } }),
      b: revealerAt({ [EXEC_KEY]: { then: { item: "c", port: "run" } } }),
    },
    { a: { active: false }, b: { active: false } },
    { a: { active: true } }
  );
  assert.equal(seenAt(doc, 0).items.c.count, 2, "two events, one boundary, two ticks");
  assert.equal(seenAt(doc, 1).items.c.count, 2, "nothing appeared on slide 2, so nothing fired");
  assert.equal(seenAt(doc, 2).items.c.count, 3, "one of them came back");
  // …and it PUBLISHES the tally, so anything downstream can read it.
  assert.equal(seenAt(doc, 2).items.c.out, 3, "the count is an output property, readable as \"= <name>.out\"");
});

test("the counter is still a pure function of (document, slide) — replay and Δt = 0 hold", () => {
  const doc = docOf(
    { c: { ...registry.get("node_counter").defaults }, a: revealerAt({ [EXEC_KEY]: { then: { item: "c", port: "run" } } }) },
    { a: { active: false } },
    { a: { active: true } },
    { a: { active: false } },
    { a: { active: true } }
  );
  // The tally at each slide is decided by the deck, not by how it was reached.
  assert.deepEqual([0, 1, 2, 3, 4].map((k) => seenAt(doc, k).items.c.count), [1, 1, 2, 2, 3]);
  // A FRESH replay of a structurally equal deck (a different object, so a memo miss)
  // agrees — which is the "identical every time" half of the manifest's rule, kept
  // even though the effect accumulates.
  const fresh = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(execOverlayAt(fresh, 4, registry, evaluate), execOverlayAt(doc, 4, registry, evaluate));
  // And asking twice with no clock in between is byte-identical.
  assert.strictEqual(execOverlayAt(doc, 4, registry, evaluate), execOverlayAt(doc, 4, registry, evaluate));
});

test("AN EVENT OWNS THE PROPERTY IT WRITES — a keyframe on that leaf loses, and that is the known gap", () => {
  // PINNED AS A BOUNDARY, NOT CELEBRATED AS A FEATURE. The overlay is applied ON TOP
  // OF the fold, so a keyframe an author writes on a leaf that an event also sets is
  // overridden — and because web/app.svelte.js `rawState()` blends the overlay too,
  // DRAGGING such a widget in the editor commits a value the next evaluation
  // discards, so it appears not to move.
  //
  // That is the correct precedence (an event that could be silently outvoted by a
  // keyframe would be worse), and it is what every driver/constraint system does.
  // What is MISSING is the affordance: the house rule says an unavailable-by-state
  // control is shown DISABLED WITH A REASON, and this row is neither. Recorded here
  // so the gap is a named decision with a test on it rather than a surprise.
  const doc = docOf({
    box: { ...RECT, x: 300 },
    ev: revealerAt({ [EXEC_KEY]: { then: { item: "eff", port: "run" } } }),
    eff: setterAt("box", "x", 900),
  });
  assert.equal(foldState(doc, 0).items.box.x, 300, "the document says 300 …");
  assert.equal(seenAt(doc, 0).items.box.x, 900, "… and the event wins, on every surface including the editor");
});

// ── THE CARDINALITY MIRROR, AND THE WIRE ─────────────────────────────────────

test("exec OUT is ≤ 1 STRUCTURALLY: a second wire from one pin is the same key", () => {
  const first = execConnectPairs({ item: "a", port: "then" }, { item: "b", port: "run" });
  const second = execConnectPairs({ item: "a", port: "then" }, { item: "c", port: "run" });
  assert.deepEqual(first[0][0], second[0][0], "one pin, one storage slot — the new wire replaces the old with no rule to enforce");
  // …and the mirror: a DATA wire's slot is keyed by the INPUT, which is fan-in-1.
  assert.deepEqual(wirePairsFor({ a: { type: "node_number" } }, registry, { item: "a", port: "out" }, { item: "b", port: "i" })[0][0], ["items", "b", "inputs", "i"]);
  assert.deepEqual(wirePairsFor({ a: { type: "node_on_reveal" } }, registry, { item: "a", port: "then" }, { item: "b", port: "run" })[0][0], ["items", "a", EXEC_KEY, "then"]);
});

test("exec IN accepts MANY — the other half of the mirror", () => {
  const items = {
    a: { type: "node_on_reveal", [EXEC_KEY]: { then: { item: "c", port: "run" } } },
    b: { type: "node_on_reveal", [EXEC_KEY]: { then: { item: "c", port: "run" } } },
    c: { type: "node_set_property" },
  };
  assert.equal(execEdgesOf(items).length, 2, "two events into one exec input is legal and both edges exist");
});

test("an exec loop is refused, and a mixed data/exec pair between the same two nodes is NOT", () => {
  // x already fires y, so wiring y's `then` back into x's exec input closes a loop.
  const chain = { x: { type: "node_set_property", [EXEC_KEY]: { then: { item: "y", port: "run" } } }, y: { type: "node_set_property" } };
  assert.equal(execWouldCycle(chain, { item: "y", port: "then" }, { item: "x", port: "run" }), true);
  assert.match(connectionRefusal(chain, registry, { item: "y", port: "then" }, { item: "x", port: "run" }), /loop/);
  // …and with no such edge in place there is no loop to close.
  assert.equal(execWouldCycle({ x: { type: "node_set_property" }, y: { type: "node_set_property" } }, { item: "y", port: "then" }, { item: "x", port: "run" }), false);

  // THE ONE THAT MUST STAY LEGAL, and it is the reason the two graphs get two walks
  // (core/nodeflow.execWouldCycle says so in its docblock): `eff` READS the number
  // node's output while ALSO being the thing `ev` fires. A single combined graph
  // would call that a cycle; it is an ordinary read-then-do patch.
  const mixed = {
    n: { type: "node_number" },
    ev: { type: "node_on_reveal" },
    eff: { type: "node_set_property", inputs: { value: { item: "n", port: "out" } } },
  };
  assert.equal(connectionRefusal(mixed, registry, { item: "ev", port: "then" }, { item: "eff", port: "run" }), null);
  // And the data wire in the other direction stays legal too, checked by ITS walk.
  assert.equal(connectionRefusal(mixed, registry, { item: "n", port: "out" }, { item: "eff", port: "value" }), null);
});

test("exec never crosses into a data pin, and says why in its own words", () => {
  const items = { e: { type: "node_on_reveal" }, d: { type: "node_display" } };
  const refusal = connectionRefusal(items, registry, { item: "e", port: "then" }, { item: "d", port: "in" });
  assert.match(refusal, /carries control, not a value/);
  assert.doesNotMatch(refusal, /no conversion between them/, "the generic sentence would send the reader looking for a missing coercion");
});

test("an exec wire draws, and its type is what colours it", () => {
  const nodes = [
    { itemId: "a", world: { x: 0, y: 0, rotation: 0, scale: 1 }, state: { w: 100, h: 80, [EXEC_KEY]: { then: { item: "b", port: "run" } } }, plugin: { ports: () => ({ outputs: [{ key: "then", type: EXEC_TYPE }] }) } },
    { itemId: "b", world: { x: 300, y: 0, rotation: 0, scale: 1 }, state: { w: 100, h: 80 }, plugin: { ports: () => ({ inputs: [{ key: "run", type: EXEC_TYPE }] }) } },
  ];
  const wires = deriveWires(nodes);
  assert.equal(wires.length, 1);
  assert.equal(wires[0].type, EXEC_TYPE);
  assert.deepEqual([wires[0].from.item, wires[0].to.item], ["a", "b"], "it leaves the FIRING node even though that is where it is stored");
});

test("pressing a wired exec OUT picks that wire up; dropping it on empty space deletes it", () => {
  const items = { a: { type: "node_on_reveal", [EXEC_KEY]: { then: { item: "b", port: "run" } } } };
  const drag = wireDragStart(items, { item: "a", key: "then", side: "output", type: EXEC_TYPE });
  assert.deepEqual(drag.detach, { item: "a", port: "then", exec: true });
  const drop = wireDrop(items, registry, drag, null);
  assert.equal(drop.kind, "disconnect");
  assert.deepEqual(drop.pairs, execDisconnectPairs({ item: "a", port: "then" }));
  // …and a DATA output still starts a fresh wire, because it stores none.
  assert.equal(wireDragStart({ n: { type: "node_number" } }, { item: "n", key: "out", side: "output", type: "number" }).detach, null);
});

// ── THE SURFACES: NO JSON-ONLY PROPERTIES ────────────────────────────────────

test("every exec OUT has an Inspector row and every exec IN deliberately has none", () => {
  for (const plugin of execPlugins) {
    const rows = plugin.inspector;
    const ports = plugin.ports(plugin.defaults);
    for (const p of ports.outputs.filter((o) => o.type === EXEC_TYPE))
      assert.ok(rows.some((r) => r.key === `${EXEC_KEY}.${p.key}` && r.execOut === true), `${plugin.type} must offer a row for its "${p.key}" exec output`);
    for (const p of ports.inputs.filter((o) => o.type === EXEC_TYPE))
      assert.equal(rows.filter((r) => r.key === `inputs.${p.key}`).length, 0, `${plugin.type}'s exec input stores nothing, so a row would edit a leaf nothing reads`);
    for (const p of ports.inputs.filter((o) => o.type !== EXEC_TYPE))
      assert.ok(rows.some((r) => r.key === `inputs.${p.key}`), `${plugin.type}'s data input "${p.key}" is a property and must be visible`);
  }
  assert.equal(execOutputRows({ ports: () => ({ outputs: [{ key: "then", type: EXEC_TYPE }] }) })[0].category, EXEC_CAT);
  assert.equal(nodeInputRows({ ports: () => ({ inputs: [{ key: "run", type: EXEC_TYPE }] }) }).length, 0);
});

test("an exec output is NOT an output property — it has no value in any domain", () => {
  const ev = registry.get("node_on_reveal");
  assert.deepEqual(outputPropertyDescriptors(ev, ev.defaults), [], "listing it with the audio refusal sentence would be a true statement about the wrong thing");
});

test("the picker offers exactly the exec inputs the drag would accept", () => {
  const items = { ev: { type: "node_on_reveal" }, eff: { type: "node_set_property" }, num: { type: "node_number" } };
  const options = compatibleExecTargets(items, registry, { item: "ev", port: "then" });
  assert.deepEqual(options.map((o) => `${o.item}.${o.port}`), ["eff.run"]);
  for (const o of options)
    assert.equal(connectionRefusal(items, registry, { item: "ev", port: "then" }, { item: o.item, port: o.port }), null, "an option the drag would refuse must not be spellable here");
});

// ── THE ROSTER IS DERIVED ────────────────────────────────────────────────────

test("every registered plugin's exec declaration is sound, and the four kinds are covered", () => {
  const kinds = new Set();
  for (const p of allPlugins) {
    assert.equal(execKindProblem(p), null, `${p.type}: ${execKindProblem(p)}`);
    kinds.add(nodeExecKind(p));
  }
  assert.deepEqual([...EXEC_KINDS].filter((k) => kinds.has(k)).sort(), [...EXEC_KINDS].sort(), "the roster must exercise all four kinds, or one of them is untested doctrine");
  // …and the overwhelming majority are PURE, which is the point of the taxonomy:
  // every widget that existed before this feature still declares nothing.
  assert.ok(allPlugins.filter((p) => nodeExecKind(p) === "pure").length > allPlugins.length - 10);
});
