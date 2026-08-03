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

import { BEACH, DEMO_PATCHES, PATCH_COL, PLAYABLE_KEYS, SEQUENCED_DINGS, SPACEY_PAD_DRONE, WHOOSH, buildPatchItems, patchBounds, patchLayout } from "../core/audio_patches.js";
import { nodeKeyboardPlugin } from "../plugins/node_keyboard.js";
import { connectionRefusal } from "../core/nodeflow.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { readAudioScene } from "../core/audio_mirror_diff.js";
import { foldState, repairedDocument } from "../core/document.js";
import { readFileSync } from "node:fs";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

const registry = createRegistry();
registerPlugins(registry);

/** Build one patch at the origin with predictable ids, the way the app does. */
const build = (patch) => buildPatchItems(patch, registry, { x: 0, y: 0 }, (name) => `${patch.id}-${name}`);

/** Narrowest a white key may get and still be a mouse target rather than a line. */
const MIN_PLAYABLE_KEY_W = 9;

check("the four patches the brief names all exist, and the roster is free to GROW", () => {
  // STATED AS A SUBSET, NOT AS AN EXACT LIST, and the standing directive is why.
  // ADDENDUM 10 verbatim: "as you go by the way, just make demo patches. I want to
  // see demo patches." A roster that is pinned exactly turns every wave's new patch
  // into a red test — which is a test punishing the deliverable it exists to
  // protect. What is worth pinning is that the four the brief named are still here
  // and still distinct; a fifth is the feature working.
  for (const p of [SPACEY_PAD_DRONE, SEQUENCED_DINGS, WHOOSH, BEACH]) assert.ok(DEMO_PATCHES.includes(p), `${p.id} left the roster`);
  const ids = DEMO_PATCHES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate patch id in ${ids.join(", ")}`);
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
  // AUDIO NODES ONLY. A control node (knob, slider, button, keyboard) has no
  // audioSpec at all — its settings are plain item leaves, and the check that
  // they are real is the landed-key sweep below, which covers BOTH kinds by
  // asking the plugin's own defaults.
  for (const p of DEMO_PATCHES)
    for (const n of p.nodes) {
      const spec = registry.get(n.type).audioSpec;
      if (!spec) continue;
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
      if (!spec) continue;
      for (const [key, value] of Object.entries(n.knobs ?? {})) {
        const knob = spec.knobs.find((k) => k.key === key);
        if (knob.discrete) assert.ok(knob.options.includes(value), `${p.id}.${n.id}.${key} = ${value} is not among ${JSON.stringify(knob.options)}`);
        else assert.ok(value >= knob.min && value <= knob.max, `${p.id}.${n.id}.${key} = ${value} is outside [${knob.min}, ${knob.max}]`);
      }
    }
});

check("EVERY knob a blueprint names LANDS on a key the widget actually has", () => {
  // ── THE SWEEP THAT WOULD HAVE CAUGHT A REAL, SILENT BUG (BV, 2026-08-03) ──
  // buildPatchItems prefixed "audio" onto every knob name unconditionally, which
  // was right while every patchable node was an audio module. A CONTROL node
  // stores plain leaves (`value`, `label`, `baseNote`), so the prefix produced
  // `audioValue` — a key the widget does not have. Nothing throws: a state object
  // takes any key, so the node would have inserted at its defaults and the patch
  // would be quietly wrong.
  //
  // This asserts the OUTPUT rather than the rule: whatever key the builder
  // chooses must be one the plugin's own defaults declare. That holds for both
  // kinds of node and does not care how the key was derived.
  const bad = [];
  for (const p of DEMO_PATCHES) {
    const { states } = buildPatchItems(p, registry, { x: 0, y: 0 }, (id) => id);
    for (const node of p.nodes) {
      const plugin = registry.get(node.type);
      const state = states[node.id];
      for (const [key, value] of Object.entries(node.knobs ?? {})) {
        const target = plugin.audioModule ? "audio" + key.charAt(0).toUpperCase() + key.slice(1) : key;
        if (!(target in plugin.defaults)) bad.push(`${p.id}.${node.id}: "${key}" → "${target}", which ${node.type} does not declare`);
        else if (state[target] !== value) bad.push(`${p.id}.${node.id}.${target} is ${state[target]}, not the ${value} the blueprint set`);
      }
    }
  }
  assert.deepEqual(bad, [], `knob overrides that do not land:\n    ${bad.join("\n    ")}`);
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
    // THE MIRROR SEES ENGINE MODULES, NOT NODES — and since BV a patch may
    // legitimately contain neither-modules: a Keyboard, a Knob and a Button are
    // real nodes on the canvas with NO engine counterpart at all (they produce
    // document values and live events, which is core/control_nodes.js's whole
    // point). Counting them as missing modules is the same mistake the method-wire
    // note below records: asserting against a guess about the roster instead of
    // asking what a node IS. `audioModule` is the fact.
    const engineNodes = p.nodes.filter((n) => registry.get(n.type).audioModule);
    assert.equal(Object.keys(scene.modules).length, engineNodes.length,
      `${p.id}: the mirror saw ${Object.keys(scene.modules).length} modules for ${engineNodes.length} engine nodes`);
    // Method wires (the ding's gate) are carried but flagged; every other wire must
    // have survived the mirror's own reality checks.
    //
    // WHICH WIRES ARE METHOD WIRES IS ASKED OF THE REGISTRY, NOT OF THE BLUEPRINT
    // ID. This used to test `w.to.includes("ding") || w.to === "gull"` — a guess
    // about what patch authors name their nodes, which held for exactly as long as
    // every bell in the library was called "ding" or "gull". The moment a patch
    // named its bells `lead` and `answer` (GAMELAN_BELLS), two genuinely-method
    // gate wires were counted as real ones and the patch was reported as having
    // LOST two wires it never had. The port's own `method` flag is the fact; a
    // name is a correlation.
    const real = scene.connections.filter((c) => !c.method);
    const isMethodWire = (w) => {
      const target = p.nodes.find((n) => n.id === w.to);
      const port = (registry.get(target.type).ports({}).inputs ?? []).find((i) => i.key === w.toPort);
      return !!port?.method;
    };
    // ── AND BOTH ENDS MUST BE ENGINE MODULES (BV, 2026-08-03) ───────────────
    // A wire from a KNOB into a pad's `cutoff` is a real, legal, useful wire on
    // the canvas — and it has no engine counterpart, because a knob is not a
    // module. readAudioScene drops it deliberately and says so ("a number node
    // CAN legitimately be wired to a node widget — it simply has no engine
    // counterpart"). Its VALUE reaches the engine anyway, through the ordinary
    // fold: the node evaluator resolves the knob into the pad's cutoff leaf and
    // the mirror sends a setParam. So counting it as a lost wire asserts the
    // opposite of the design.
    const isEngineWire = (w) => {
      const ends = [w.from, w.to].map((id) => p.nodes.find((n) => n.id === id));
      return ends.every((n) => registry.get(n.type).audioModule);
    };
    const expectedReal = p.wires.filter((w) => !isMethodWire(w) && isEngineWire(w));
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

// ── THE DEMO DECK ───────────────────────────────────────────────────────────
// examples/audio_demo.powerrp.json is a CHECKED-IN fixture, and a fixture that has
// drifted from the code is worse than no fixture: it loads, it looks plausible, and
// it teaches a stale schema. These pins are what make regenerating it safe.

check("the demo deck loads and REPAIRS CLEAN — zero reports", () => {
  const deck = JSON.parse(readFileSync(new URL("../examples/audio_demo.powerrp.json", import.meta.url), "utf8"));
  const { reports } = repairedDocument(deck, registry);
  assert.deepEqual(reports, [], `the checked-in deck would be repaired on load: ${JSON.stringify(reports, null, 1)}`);
});

check("the deck is three slides on the current transition schema", () => {
  const deck = JSON.parse(readFileSync(new URL("../examples/audio_demo.powerrp.json", import.meta.url), "utf8"));
  assert.equal(deck.slides.length, 3);
  assert.deepEqual(deck.slides.map((s) => s.name), ["Ambience", "Rhythm", "Two Outputs"]);
  for (const s of deck.slides) {
    assert.ok(s.transition && typeof s.transition === "object", `slide "${s.name}" has no transition object`);
    assert.ok("type" in s.transition && "seconds" in s.transition, `slide "${s.name}"'s transition is not the current schema`);
    // `duration` is the LEGACY field transition supersedes; the repair pipeline
    // migrates it loudly, so a generated fixture must never contain one.
    assert.ok(!("duration" in s), `slide "${s.name}" carries the legacy \`duration\` field`);
  }
  assert.equal(typeof deck.meta.script, "string", "meta.script must be present — repairedDocument fills it, and a fixture should not need that");
});

check("EVERY SLIDE SHOWS A DIFFERENT PATCH — the fold is used, not fought", () => {
  // The bug this pins: slide 0's delta CREATES everything and later slides INHERIT.
  // A generator that wrote each slide's items into its own delta produced a third
  // slide showing all three scenes stacked on top of each other. What must be true
  // is that each slide's ACTIVE audio modules are a different set.
  const deck = JSON.parse(readFileSync(new URL("../examples/audio_demo.powerrp.json", import.meta.url), "utf8"));
  const activeSets = deck.slides.map((_, i) => {
    const state = foldState(deck, i, 1);
    return new Set(Object.entries(state.items)
      .filter(([, s]) => s.active !== false && registry.get(s.type)?.audioModule)
      .map(([id]) => id));
  });
  for (const set of activeSets) assert.ok(set.size > 0, "a slide shows no audio modules at all");
  for (let i = 1; i < activeSets.length; i++)
    for (const id of activeSets[i])
      assert.ok(!activeSets[i - 1].has(id),
        `slide ${i + 1} shows module ${id}, which slide ${i} also showed — the scenes are not switching`);
});

check("every slide's patch REACHES an output, folded — the deck plays on every slide", () => {
  const deck = JSON.parse(readFileSync(new URL("../examples/audio_demo.powerrp.json", import.meta.url), "utf8"));
  for (let i = 0; i < deck.slides.length; i++) {
    const scene = readAudioScene(foldState(deck, i, 1).items, registry);
    const outputs = Object.entries(scene.modules).filter(([, m]) => m.module === "output").map(([id]) => id);
    assert.ok(outputs.length >= 1, `slide ${i + 1} has no active output module — it is silent`);
    // Every active module must reach one of them.
    const feeding = new Map();
    for (const c of scene.connections) feeding.set(c.targetId, [...(feeding.get(c.targetId) ?? []), c.sourceId]);
    const reached = new Set(outputs);
    const stack = [...outputs];
    while (stack.length) for (const src of feeding.get(stack.pop()) ?? []) if (!reached.has(src)) { reached.add(src); stack.push(src); }
    for (const id of Object.keys(scene.modules))
      assert.ok(reached.has(id), `slide ${i + 1}: module ${id} (${scene.modules[id].module}) reaches no output`);
  }
});

check("the LAST slide carries TWO outputs — the ADDENDUM 10 ruling, on screen", () => {
  const deck = JSON.parse(readFileSync(new URL("../examples/audio_demo.powerrp.json", import.meta.url), "utf8"));
  const scene = readAudioScene(foldState(deck, deck.slides.length - 1, 1).items, registry);
  const outputs = Object.values(scene.modules).filter((m) => m.module === "output");
  assert.equal(outputs.length, 2, "the two-outputs slide must actually have two — they sum, never conflict");
});

check("every slide fits inside the deck's own frame", () => {
  const deck = JSON.parse(readFileSync(new URL("../examples/audio_demo.powerrp.json", import.meta.url), "utf8"));
  const { slideW, slideH } = deck.meta;
  for (let i = 0; i < deck.slides.length; i++) {
    const items = foldState(deck, i, 1).items;
    for (const [id, s] of Object.entries(items)) {
      if (s.active === false || s.type === "camera" || typeof s.w !== "number") continue;
      assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= slideW && s.y + s.h <= slideH,
        `slide ${i + 1}: ${id} (${s.type}) at ${s.x},${s.y} ${s.w}x${s.h} sticks out of the ${slideW}x${slideH} frame`);
    }
  }
});

// ── NO PATCH NODE MAY OVERLAP THE COLUMN TO ITS RIGHT (BV, 2026-08-03) ────────
// Column pitch is the ONLY thing laying a patch out, so a node wider than
// PATCH_COL silently lands on top of its neighbour. This went unnoticed because
// every audio module's default width happens to be under the pitch; the keyboard
// (252 default, deliberately wide for hand play) was the first that wasn't, and
// it took a rendered still to see. A blueprint fixes it with `w`. This sweeps
// EVERY patch rather than pinning the one known node, so the next wide widget
// dropped into a blueprint fails here instead of in a picture.
check("no patch node is wider than the column pitch", () => {
  for (const p of DEMO_PATCHES) {
    const { states } = buildPatchItems(p, registry, { x: 0, y: 0 }, (n) => `${p.id}-${n}`);
    for (const [id, s] of Object.entries(states)) {
      if (typeof s.w !== "number") continue;
      assert.ok(s.w <= PATCH_COL,
        `${p.id}: ${id} is ${s.w} wide against a PATCH_COL of ${PATCH_COL} — it overlaps the next column; set \`w\` on the blueprint node`);
    }
  }
});

// The companion half: the fix must not have been bought by gutting the widget.
// A narrowed keyboard that dropped to one octave would pass the check above and
// still be the wrong repair (it was the FIRST attempt at this bug), so the
// playable patch is pinned to keep enough keys to hold the chord that
// demonstrates voice stealing — which is what the patch exists to show.
check("Playable Keys keeps two octaves, and its keys stay wide enough to hit", () => {
  const { states } = buildPatchItems(PLAYABLE_KEYS, registry, { x: 0, y: 0 }, (n) => n);
  const keys = nodeKeyboardPlugin.keyboardKeys(states.keys);
  assert.equal(states.keys.octaves, 2, "a poly demo needs range enough for a five-note chord");
  assert.equal(keys.length, 24, "two octaves is 24 keys");
  const whiteWidth = keys.find((k) => !k.black).w;
  assert.ok(whiteWidth >= MIN_PLAYABLE_KEY_W,
    `white keys are ${whiteWidth.toFixed(1)} wide — too thin to hit with a mouse`);
});

console.log(`\naudio_patches_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
