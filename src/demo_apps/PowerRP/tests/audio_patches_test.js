/**
 * DEMO PATCHES — bare-node tests for the patch blueprints.
 * Run: node src/demo_apps/PowerRP/tests/audio_patches_test.js
 *
 * ── WHY THESE ARE WORTH PINNING ─────────────────────────────────────────────
 * A demo patch is the FIRST thing a user meets: the standing directive (ADDENDUM 10)
 * makes them a permanent, growing deliverable, and every one of them is a hand-authored
 * graph. Hand-authored graphs go wrong quietly — a wire naming a port that was
 * renamed, a knob the module does not have, a node nothing is connected to, a chain
 * that never reaches an output. None of those throws. All of them produce a patch
 * that inserts cleanly and makes no sound, which is the single worst outcome for a
 * feature whose purpose is to be impressive on first contact.
 *
 * So every patch is checked STRUCTURALLY here: types exist, ports exist, wires
 * typecheck through the SAME core/nodeflow refusal the drag gesture uses, every node
 * is reachable, and every patch ends at an output.
 *
 * What this cannot check is whether a patch sounds GOOD. That is proven by listening
 * (synth/dev.html and the editor), per the brief.
 */

import assert from "node:assert/strict";

import { BEACH, DEMO_PATCHES, PATCH_COL, SEQUENCED_DINGS, SPACEY_PAD_DRONE, WHOOSH, buildPatchItems, patchBounds, patchLayout } from "../core/audio_patches.js";
import { connectionRefusal } from "../core/nodeflow.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { readAudioScene } from "../core/audio_mirror_diff.js";
import { repairedDocument } from "../core/document.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

const registry = createRegistry();
registerPlugins(registry);

/** Build one patch at the origin with predictable ids, the way the app does. */
const build = (patch) => buildPatchItems(patch, registry, { x: 0, y: 0 }, (name) => `${patch.id}-${name}`);

check("the four patches the brief names all exist", () => {
  assert.deepEqual(DEMO_PATCHES.map((p) => p.id), ["spacey-pad-drone", "sequenced-dings", "whoosh", "beach"]);
  for (const p of [SPACEY_PAD_DRONE, SEQUENCED_DINGS, WHOOSH, BEACH]) assert.ok(DEMO_PATCHES.includes(p));
});

check("every patch has a title and a real explanation", () => {
  for (const p of DEMO_PATCHES) {
    assert.ok(p.title, `${p.id} has no title`);
    assert.ok(p.help && p.help.length > 40, `${p.id}'s help is too thin to explain what you are about to hear`);
    assert.ok(p.nodes.length >= 3, `${p.id} has only ${p.nodes.length} nodes`);
    assert.ok(p.wires.length >= 2, `${p.id} has only ${p.wires.length} wires`);
  }
});

check("every node names a REGISTERED widget type", () => {
  for (const p of DEMO_PATCHES)
    for (const n of p.nodes)
      assert.doesNotThrow(() => registry.get(n.type), `${p.id}.${n.id} names unregistered type "${n.type}"`);
});

check("node ids are unique within a patch", () => {
  for (const p of DEMO_PATCHES) {
    const ids = p.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, `${p.id} has duplicate node ids`);
  }
});

check("every wire names ports that EXIST on the modules it joins", () => {
  for (const p of DEMO_PATCHES) {
    const byId = new Map(p.nodes.map((n) => [n.id, registry.get(n.type)]));
    for (const w of p.wires) {
      const from = byId.get(w.from), to = byId.get(w.to);
      assert.ok(from, `${p.id}: wire from unknown node "${w.from}"`);
      assert.ok(to, `${p.id}: wire to unknown node "${w.to}"`);
      assert.ok(from.ports({}).outputs.some((q) => q.key === w.fromPort),
        `${p.id}: ${w.from} has no output "${w.fromPort}" (has ${from.ports({}).outputs.map((q) => q.key)})`);
      assert.ok(to.ports({}).inputs.some((q) => q.key === w.toPort),
        `${p.id}: ${w.to} has no input "${w.toPort}" (has ${to.ports({}).inputs.map((q) => q.key)})`);
    }
  }
});

check("every wire is one the EDITOR would accept — same refusal the drag uses", () => {
  // THE POINT: a patch must not contain a connection a user could not have made by
  // dragging. If one did, the patch would be inserting a state the gesture refuses,
  // and the two halves of the feature would disagree about what is legal.
  for (const p of DEMO_PATCHES) {
    const { states } = build(p);
    const id = (n) => `${p.id}-${n}`;
    for (const w of p.wires) {
      // Check each wire against the graph WITHOUT it, exactly as a drop would be.
      const items = Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { ...v, inputs: { ...v.inputs } }]));
      delete items[id(w.to)].inputs[w.toPort];
      const refusal = connectionRefusal(items, registry,
        { item: id(w.from), port: w.fromPort }, { item: id(w.to), port: w.toPort });
      assert.equal(refusal, null, `${p.id}: the wire ${w.from}.${w.fromPort} → ${w.to}.${w.toPort} would be REFUSED — ${refusal}`);
    }
  }
});

check("every knob override is a knob the module really has", () => {
  for (const p of DEMO_PATCHES)
    for (const n of p.nodes) {
      const spec = registry.get(n.type).audioSpec;
      for (const key of Object.keys(n.knobs ?? {}))
        assert.ok((spec.knobs ?? []).some((k) => k.key === key),
          `${p.id}.${n.id} sets "${key}", which ${n.type} does not have (has ${(spec.knobs ?? []).map((k) => k.key)})`);
    }
});

check("every knob override is INSIDE that knob's declared range", () => {
  // A value outside the range is one the engine clamps, so the document would say
  // one thing and the sound would do another — silently.
  for (const p of DEMO_PATCHES)
    for (const n of p.nodes) {
      const spec = registry.get(n.type).audioSpec;
      for (const [key, value] of Object.entries(n.knobs ?? {})) {
        const knob = spec.knobs.find((k) => k.key === key);
        if (knob.discrete) assert.ok(knob.options.includes(value), `${p.id}.${n.id}.${key} = ${value} is not among ${JSON.stringify(knob.options)}`);
        else assert.ok(value >= knob.min && value <= knob.max, `${p.id}.${n.id}.${key} = ${value} is outside [${knob.min}, ${knob.max}]`);
      }
    }
});

check("NO NODE IS ORPHANED — every node is joined to the graph", () => {
  // A node nothing connects to is a card the user sees, correctly wired in their
  // mind, contributing nothing. It is the most common hand-authoring mistake and it
  // is completely invisible.
  for (const p of DEMO_PATCHES) {
    const joined = new Set();
    for (const w of p.wires) { joined.add(w.from); joined.add(w.to); }
    for (const n of p.nodes) assert.ok(joined.has(n.id), `${p.id}.${n.id} is wired to NOTHING`);
  }
});

check("every patch REACHES an output — otherwise it is silent by construction", () => {
  for (const p of DEMO_PATCHES) {
    const outputs = p.nodes.filter((n) => n.type === "audio_output").map((n) => n.id);
    assert.ok(outputs.length >= 1, `${p.id} has no output module`);
    // Walk backwards from each output; every SOURCE-family node must be reachable.
    const feeding = new Map();
    for (const w of p.wires) feeding.set(w.to, [...(feeding.get(w.to) ?? []), w.from]);
    const reached = new Set(outputs);
    const stack = [...outputs];
    while (stack.length) for (const src of feeding.get(stack.pop()) ?? []) if (!reached.has(src)) { reached.add(src); stack.push(src); }
    for (const n of p.nodes)
      assert.ok(reached.has(n.id), `${p.id}.${n.id} does not reach an output — it can never be heard`);
  }
});

check("every patch carries a METER and a SPECTRUM so the canvas is alive", () => {
  // The brief's requirement. Both are pass-through, so they change nothing about the
  // sound — they only make it visible, and a patch that plays but shows nothing is
  // indistinguishable from one that is silent.
  for (const p of DEMO_PATCHES) {
    assert.ok(p.nodes.some((n) => n.type === "audio_meter"), `${p.id} has no level meter`);
    assert.ok(p.nodes.some((n) => n.type === "audio_spectrum"), `${p.id} has no spectrum node`);
  }
});

check("no two nodes of a patch land on the same spot", () => {
  for (const p of DEMO_PATCHES) {
    const cells = p.nodes.map((n) => `${n.col},${n.row}`);
    assert.equal(new Set(cells).size, cells.length, `${p.id} places two nodes in one grid cell`);
  }
});

check("the layout runs LEFT TO RIGHT in signal order (the Reaktor ruling)", () => {
  // ADDENDUM 1: "I'm looking for like reactor type left to right flows." A wire that
  // ran backwards would make the patch read as a tangle rather than as a chain.
  // Modulation wires (an LFO into a filter's param) are exempt: they legitimately
  // come from a node in the SAME column, one row down, which is how a control signal
  // is drawn in every modular editor.
  for (const p of DEMO_PATCHES) {
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    for (const w of p.wires) {
      const from = byId.get(w.from), to = byId.get(w.to);
      assert.ok(from.col <= to.col,
        `${p.id}: the wire ${w.from} → ${w.to} runs BACKWARDS (col ${from.col} → ${to.col})`);
    }
  }
});

// ── CONSTRUCTION ────────────────────────────────────────────────────────────

check("buildPatchItems produces states that carry defaults, position, knobs and wires", () => {
  const { states, order } = build(WHOOSH);
  assert.equal(order.length, WHOOSH.nodes.length);
  const noise = states["whoosh-noise"];
  assert.equal(noise.type, "audio_noise");
  assert.equal(noise.audioColor, "pink");
  assert.equal(noise.x, 0);
  assert.deepEqual(noise.inputs, {}, "a source node has no inputs");
  const filter = states["whoosh-filter"];
  assert.deepEqual(filter.inputs.in, { item: "whoosh-noise", port: "out" });
  assert.deepEqual(filter.inputs.frequency, { item: "whoosh-lfo", port: "out" });
  assert.equal(filter.x, PATCH_COL, "column 1 sits one column pitch right of the origin");
});

check("every built state carries the plugin's defaults, so nothing needs repair", () => {
  for (const p of DEMO_PATCHES) {
    const { states } = build(p);
    for (const [id, state] of Object.entries(states)) {
      const defaults = registry.get(state.type).defaults;
      for (const key of Object.keys(defaults))
        assert.ok(key in state, `${p.id}: ${id} is missing default "${key}" — it would be filled by a repair report`);
    }
  }
});

check("a built patch is a valid AUDIO SCENE — the mirror sees every module and wire", () => {
  // The end-to-end structural claim: what the palette inserts is what the engine gets.
  for (const p of DEMO_PATCHES) {
    const { states } = build(p);
    const scene = readAudioScene(states, registry);
    assert.equal(Object.keys(scene.modules).length, p.nodes.length,
      `${p.id}: the mirror saw ${Object.keys(scene.modules).length} modules for ${p.nodes.length} nodes`);
    // Method wires (the ding's gate) are carried but flagged; every other wire must
    // have survived the mirror's own reality checks.
    const real = scene.connections.filter((c) => !c.method);
    const expectedReal = p.wires.filter((w) => !(w.to.includes("ding") || w.to === "gull") || w.toPort !== "gate");
    assert.equal(real.length, expectedReal.length,
      `${p.id}: the mirror kept ${real.length} wires; the blueprint declares ${expectedReal.length} non-method ones`);
  }
});

check("patchBounds covers every node the patch places", () => {
  for (const p of DEMO_PATCHES) {
    const bounds = patchBounds(p, registry, { x: 0, y: 0 });
    assert.ok(bounds.w > 0 && bounds.h > 0, `${p.id} has an empty bounding box`);
    for (const n of p.nodes) {
      const at = patchLayout(n, { x: 0, y: 0 });
      const plugin = registry.get(n.type);
      assert.ok(at.x >= bounds.x && at.x + plugin.defaults.w <= bounds.x + bounds.w + 1e-9,
        `${p.id}.${n.id} sticks out of the patch's own bounds horizontally`);
      assert.ok(at.y >= bounds.y && at.y + plugin.defaults.h <= bounds.y + bounds.h + 1e-9,
        `${p.id}.${n.id} sticks out of the patch's own bounds vertically`);
    }
  }
});

check("a document containing every patch REPAIRS CLEAN — zero reports", () => {
  // The gate a fixture must pass (CLAUDE.md: "Any regenerated fixture must pass
  // repairedDocument() with zero repair reports"). Applied to the patches themselves
  // so a knob or default that would be repaired is caught HERE, rather than in the
  // deck where the cause is one step further away.
  const items = {};
  let x = 0;
  for (const p of DEMO_PATCHES) {
    const { states } = buildPatchItems(p, registry, { x, y: 0 }, (n) => `${p.id}-${n}`);
    Object.assign(items, states);
    x += patchBounds(p, registry, { x: 0, y: 0 }).w + PATCH_COL;
  }
  const doc = {
    meta: { name: "patch repair probe", script: "" },
    slides: [{ id: "s0", name: "1", transition: { type: "cut", seconds: 0 }, delta: { items } }],
  };
  const { reports } = repairedDocument(doc, registry);
  assert.deepEqual(reports, [], `demo patches would be REPAIRED on load: ${JSON.stringify(reports, null, 1)}`);
});

console.log(`\naudio_patches_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
