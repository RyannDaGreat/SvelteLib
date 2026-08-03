/**
 * AUDIO NODES — bare-node tests for the 23 audio widget plugins and the audio mirror.
 * Run: node src/demo_apps/PowerRP/tests/audio_nodes_test.js
 *
 * ── THE ONE THING ONLY THIS FILE CAN PROVE ──────────────────────────────────
 * core/audio_specs.js DESCRIBES the engine — every module's ports, every knob and
 * its range — and core/ may not import synth/**, because core must run in bare node
 * and the engine constructs an AudioContext. So the description and the thing it
 * describes are, by design, connected only by a claim.
 *
 * THIS FILE IS WHERE THE CLAIM IS CHECKED. It imports BOTH and instantiates every
 * real module factory against a STUB AudioContext, then asserts that every declared
 * port and every declared knob is one the module actually has. A drifted spec is
 * otherwise invisible in the worst possible way: the Inspector shows a knob, the
 * author turns it, the mirror calls setParam on a param that does not exist, and
 * the result is either a thrown error mid-presentation or — far worse — nothing at
 * all. "Silent success is OK, silent failure is NEVER OK" is the project rule this
 * suite enforces mechanically.
 *
 * ── WHY A STUB CONTEXT IS LEGITIMATE HERE AND NOT A CHEAT ───────────────────
 * The stub implements the AudioNode/AudioParam SHAPE (createGain, connect, a
 * `gain` param with setTargetAtTime) and nothing about sound. That is exactly the
 * surface the module factories use to BUILD their graphs, so running them against
 * it proves the structural claim this file is about: which ports and params exist.
 * It proves nothing about what anything SOUNDS like, and does not pretend to —
 * audible correctness is proven by synth/dev.html and by listening in the editor
 * (the brief's own instruction: do not attempt audio-buffer assertions in probes).
 */

import assert from "node:assert/strict";

import { AUDIO_SPECS } from "../core/audio_specs.js";
import { audioKnobDefaults, audioKnobKey, audioKnobRows, audioKnobValues, audioNodePlugin, audioPorts, audioReadout } from "../core/audio_nodes.js";
import { NODE_FAMILIES, NODE_FAMILY_NAMES, familyCard, familyRim, nodeFamily } from "../core/node_chrome.js";
import { PORT_TYPE_NAMES } from "../core/nodeflow.js";
import { audioPlugins } from "../plugins/audio_index.js";
import { MODULE_FACTORIES } from "../synth/modules.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { REVERB_CHARACTERS } from "../synth/dsp.js";
import { audioEngineOps, diffAudioScene, readAudioScene } from "../core/audio_mirror_diff.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

// ── THE STUB AUDIO CONTEXT ──────────────────────────────────────────────────
// Structure only. Every method a module factory calls, returning objects with the
// right SHAPE — an AudioParam has `value` and the scheduling methods, an AudioNode
// has connect/disconnect. Anything a factory calls that is NOT here throws, which is
// the point: an unimplemented method means this stub is lying about the surface, and
// a loud failure is how we find that out.

const makeParam = (value = 0) => ({
  value,
  defaultValue: value,
  setValueAtTime() { return this; },
  setTargetAtTime() { return this; },
  linearRampToValueAtTime() { return this; },
  exponentialRampToValueAtTime() { return this; },
  cancelScheduledValues() { return this; },
});

function makeNode(extra = {}) {
  return { connect() { return this; }, disconnect() {}, ...extra };
}

function stubContext() {
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    destination: makeNode(),
    createGain: () => makeNode({ gain: makeParam(1) }),
    createOscillator: () => makeNode({ frequency: makeParam(440), detune: makeParam(0), type: "sine", start() {}, stop() {} }),
    createBiquadFilter: () => makeNode({ frequency: makeParam(350), Q: makeParam(1), gain: makeParam(0), type: "lowpass" }),
    createDelay: () => makeNode({ delayTime: makeParam(0) }),
    createConvolver: () => makeNode({ buffer: null, normalize: true }),
    createWaveShaper: () => makeNode({ curve: null, oversample: "none" }),
    createDynamicsCompressor: () => makeNode({ threshold: makeParam(-24), knee: makeParam(30), ratio: makeParam(12), attack: makeParam(0.003), release: makeParam(0.25) }),
    createAnalyser: () => makeNode({ fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0.8, getByteFrequencyData() {}, getFloatTimeDomainData() {} }),
    createBufferSource: () => makeNode({ buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: makeParam(1), start() {}, stop() {} }),
    createConstantSource: () => makeNode({ offset: makeParam(1), start() {}, stop() {} }),
    createStereoPanner: () => makeNode({ pan: makeParam(0) }),
    createChannelMerger: () => makeNode(),
    createChannelSplitter: () => makeNode(),
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels, length, sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
  };
  return ctx;
}

/** An AudioWorkletNode stand-in: the five worklet modules build one of these. */
function stubWorkletNode(paramNames) {
  const map = new Map(paramNames.map((n) => [n, makeParam(0)]));
  return makeNode({
    parameters: { get: (n) => map.get(n) ?? map.set(n, makeParam(0)).get(n) },
    port: { postMessage() {}, onmessage: null },
  });
}

/** The `resources` bag the engine hands every factory. */
function stubResources() {
  return {
    impulseResponse: (character) => {
      assert.ok(REVERB_CHARACTERS[character], `impulseResponse asked for unknown character ${character}`);
      return { numberOfChannels: 2, length: 1000, sampleRate: 48000, getChannelData: () => new Float32Array(1000) };
    },
    createWorkletNode: (name, options = {}) => stubWorkletNode(Object.keys(options.parameterData ?? {})),
    workletNode: (name, options = {}) => stubWorkletNode(Object.keys(options.parameterData ?? {})),
  };
}

/**
 * Query. Instantiate a real module factory against the stub, returning its
 * {inputs, outputs, params} — or null with the reason, when the stub's surface is
 * not enough to build it. A null is REPORTED, never swallowed: a module this suite
 * cannot instantiate is a module this suite is not checking, and that fact must be
 * visible rather than counted as a pass.
 */
function instantiate(moduleType) {
  const factory = MODULE_FACTORIES[moduleType];
  if (!factory) return { error: `no engine factory named "${moduleType}"` };
  const ctx = stubContext();
  // AudioWorkletNode is a global the worklet modules construct directly.
  const priorWorklet = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = function (context, name, options = {}) {
    return stubWorkletNode(Object.keys(options.parameterData ?? {}));
  };
  try {
    const instance = factory(ctx, {}, stubResources());
    return { instance };
  } catch (e) {
    return { error: e.message };
  } finally {
    globalThis.AudioWorkletNode = priorWorklet;
  }
}

// ── ROSTER ──────────────────────────────────────────────────────────────────

check("the roster and the specs are the SAME modules", () => {
  // ── WHY THIS NO LONGER PINS A NUMBER (BV, 2026-08-03) ─────────────────────
  // It asserted `=== 23` and went red the moment the poly pad landed, which is
  // wave 3's recorded lesson repeating in a second file: "an exactly-pinned
  // roster turns every wave's new patch into a red test — a test punishing the
  // deliverable it exists to protect." The count was never what this check is
  // FOR. What it is for is the CORRESPONDENCE: a module registered in one list
  // and not the other is half-registered, appears in the palette but has no
  // spec (or vice versa), and fails somewhere far from here. That assertion is
  // exact, unchanged, and does not need to know how many modules there are.
  assert.ok(AUDIO_SPECS.length > 0, "AUDIO_SPECS is empty — the roster would vacuously agree with it");
  assert.deepEqual(audioPlugins.map((p) => p.type).sort(), AUDIO_SPECS.map((s) => s.type).sort(),
    "plugins/audio_index.js must cover AUDIO_SPECS exactly — a module in one and not the other is half-registered");
});

check("every spec names a module the engine actually has", () => {
  for (const spec of AUDIO_SPECS)
    assert.ok(MODULE_FACTORIES[spec.module], `${spec.type} names engine module "${spec.module}", which does not exist`);
});

check("the specs cover the engine modules exactly, with none left over", () => {
  assert.deepEqual(AUDIO_SPECS.map((s) => s.module).sort(), Object.keys(MODULE_FACTORIES).sort(),
    "every engine module should have exactly one node widget");
});

check("every plugin registers into a real registry", () => {
  const registry = createRegistry();
  registerPlugins(registry);
  for (const spec of AUDIO_SPECS) assert.ok(registry.get(spec.type), `${spec.type} did not register`);
});

// ── THE CROSS-CHECK: SPEC vs ENGINE ─────────────────────────────────────────

check("every declared PORT is a port the engine module really exposes", () => {
  const unbuildable = [];
  for (const spec of AUDIO_SPECS) {
    const { instance, error } = instantiate(spec.module);
    if (!instance) { unbuildable.push(`${spec.module}: ${error}`); continue; }
    for (const p of spec.inputs ?? []) {
      // A `method: true` port is deliberately NOT an AudioNode input — it is routed
      // to engine.trigger() by the mirror. The ding's `gate` is the only one.
      if (p.method) continue;
      assert.ok(p.key in instance.inputs,
        `${spec.type} declares input "${p.key}" but engine module ${spec.module} has [${Object.keys(instance.inputs)}]`);
    }
    for (const p of spec.outputs ?? [])
      assert.ok(p.key in instance.outputs,
        `${spec.type} declares output "${p.key}" but engine module ${spec.module} has [${Object.keys(instance.outputs)}]`);
  }
  assert.equal(unbuildable.length, 0, `modules the stub context could not build (so were NOT checked): ${unbuildable.join("; ")}`);
});

check("every declared LIVE knob is a param the engine module really exposes", () => {
  for (const spec of AUDIO_SPECS) {
    const { instance } = instantiate(spec.module);
    if (!instance) continue; // already reported loudly by the check above
    for (const k of spec.knobs ?? []) {
      // A CONSTRUCT-TIME knob is one the engine has no setter for — it is passed at
      // addModule() and a change rebuilds the module. Asserting it is NOT a param is
      // as important as asserting the live ones are: if the engine ever grows a real
      // setter, this fails and the spec should drop `construct` and get live ramping.
      if (k.construct) {
        assert.ok(!(k.key in instance.params),
          `${spec.type}.${k.key} is marked construct:true but engine module ${spec.module} DOES expose it as a param — drop the flag and let it ramp`);
        continue;
      }
      assert.ok(k.key in instance.params,
        `${spec.type} declares knob "${k.key}" but engine module ${spec.module} has params [${Object.keys(instance.params)}]`);
    }
  }
});

check("every construct-time knob is passed at addModule so a rebuild carries it", () => {
  for (const spec of AUDIO_SPECS) {
    for (const k of (spec.knobs ?? []).filter((x) => x.construct)) {
      // constructParams takes the ENGINE-key knob map readAudioScene produces, not
      // the audio-prefixed ITEM-STATE map — going through audioKnobValues is how the
      // mirror gets from one to the other, so the test goes the same way.
      const knobs = Object.fromEntries(audioKnobValues(spec, audioKnobDefaults(spec)).map((k) => [k.key, k.value]));
      const params = audioEngineOps.constructParams(spec, knobs);
      assert.ok(k.key in params,
        `${spec.type}.${k.key} is construct-time but constructParams omits it — a rebuilt module would silently revert to the engine default`);
    }
  }
});

// ── SPEC WELL-FORMEDNESS ────────────────────────────────────────────────────

check("every port type is a declared PORT_TYPE", () => {
  for (const spec of AUDIO_SPECS)
    for (const p of [...(spec.inputs ?? []), ...(spec.outputs ?? [])])
      assert.ok(PORT_TYPE_NAMES.includes(p.type), `${spec.type}.${p.key} has undeclared port type "${p.type}"`);
});

check("every numeric knob's default is inside its own declared range", () => {
  for (const spec of AUDIO_SPECS)
    for (const k of (spec.knobs ?? []).filter((x) => !x.discrete)) {
      assert.equal(typeof k.min, "number", `${spec.type}.${k.key} has no min`);
      assert.equal(typeof k.max, "number", `${spec.type}.${k.key} has no max`);
      assert.ok(k.default >= k.min && k.default <= k.max,
        `${spec.type}.${k.key} default ${k.default} is outside [${k.min}, ${k.max}] — the Inspector would open on an invalid value`);
    }
});

check("every discrete knob's default is one of its own options", () => {
  for (const spec of AUDIO_SPECS)
    for (const k of (spec.knobs ?? []).filter((x) => x.discrete)) {
      assert.ok(Array.isArray(k.options) && k.options.length, `${spec.type}.${k.key} is discrete with no options`);
      assert.ok(k.options.includes(k.default), `${spec.type}.${k.key} default "${k.default}" is not among ${JSON.stringify(k.options)}`);
    }
});

check("every knob and port carries help/label text — a knob with no sentence is a knob nobody can use", () => {
  for (const spec of AUDIO_SPECS) {
    assert.ok(spec.help && spec.help.length > 20, `${spec.type} has no module help`);
    for (const k of spec.knobs ?? []) {
      assert.ok(k.label, `${spec.type}.${k.key} has no label`);
      assert.ok(k.help && k.help.length > 10, `${spec.type}.${k.key} has no help sentence`);
    }
  }
});

check("a reverb's characters are exactly the engine's impulse responses", () => {
  const spec = AUDIO_SPECS.find((s) => s.module === "reverb");
  const knob = spec.knobs.find((k) => k.key === "character");
  assert.deepEqual(knob.options.sort(), Object.keys(REVERB_CHARACTERS).sort(),
    "the Character dropdown must offer exactly the impulse responses that exist — an option the engine refuses would throw on select");
});

check("feedbackSafe is declared on the delay's input and NOWHERE else", () => {
  // NF-CORE reserved this as the escape hatch for a MEANINGFUL audio cycle. It is a
  // licence to bypass the cycle refusal, so its blast radius is pinned: a future
  // module that declares it on a zero-delay path would create a real feedback
  // explosion, and that decision must be deliberate rather than copied.
  const declared = [];
  for (const spec of AUDIO_SPECS)
    for (const p of [...(spec.inputs ?? []), ...(spec.outputs ?? [])])
      if (p.feedbackSafe) declared.push(`${spec.type}.${p.key}`);
  assert.deepEqual(declared, ["audio_delay.in"],
    "only the delay's input may bypass the cycle refusal — see DELAY_SPEC for the bar a new one must clear");
});

// ── THE PLUGIN SHAPE ────────────────────────────────────────────────────────

check("every audio plugin's defaults carry inputs:{} so a copied patch remaps", () => {
  // NF-CORE measured what forgetting this costs: itemRefs names a WILDCARD path
  // through `inputs`, and a wildcard cannot expand over a slot that does not exist,
  // so copies stayed wired to the originals.
  for (const p of audioPlugins) {
    assert.deepEqual(p.defaults.inputs, {}, `${p.type} defaults must include an empty inputs map`);
    assert.ok(p.itemRefs?.length, `${p.type} must declare itemRefs so clones remap their wires`);
  }
});

check("every audio plugin is tall enough to paint its own ports inside its card", () => {
  for (const p of audioPlugins) {
    const ports = p.ports({});
    const rows = Math.max(ports.inputs.length, ports.outputs.length);
    assert.ok(p.defaults.h > 0, `${p.type} has no default height`);
    // The beads are laid out from PORT_TOP_INSET at PORT_PITCH apart; the default
    // height comes from minimumNodeHeight over this same declaration, so this is a
    // consistency check that a spec with many ports did not get a stub height.
    if (rows > 2) assert.ok(p.defaults.h > 60, `${p.type} has ${rows} port rows but is only ${p.defaults.h} tall`);
  }
});

check("every audio plugin emits a picture without throwing, for defaults AND for empty state", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  for (const p of audioPlugins) {
    const full = p.emit({ ...p.defaults }, null, world);
    assert.ok(full.length >= 4, `${p.type} emitted only ${full.length} ops`);
    // An item whose state has been stripped to nothing must still paint — a widget
    // that throws on a sparse state takes the whole render down with it.
    assert.doesNotThrow(() => p.emit({ w: 100, h: 60 }, null, world), `${p.type} threw on a minimal state`);
  }
});

check("knob rows are ordinary Inspector rows on flat, prefixed keys", () => {
  for (const spec of AUDIO_SPECS) {
    const rows = audioKnobRows(spec);
    assert.equal(rows.length, (spec.knobs ?? []).length);
    for (const r of rows) {
      assert.ok(r.key.startsWith("audio"), `${spec.type} row ${r.key} is not namespaced`);
      assert.ok(!r.key.includes("."), `${spec.type} row ${r.key} must be a FLAT key — a dotted key is not an equation slot`);
      assert.ok(["number", "select"].includes(r.kind));
    }
  }
});

check("the audio prefix prevents the collisions it exists for", () => {
  // A filter's `type` is its lowpass/highpass mode; an ITEM's `type` is its widget
  // type. A module with a `scale` knob would collide with the similarity transform.
  assert.equal(audioKnobKey("type"), "audioType");
  assert.equal(audioKnobKey("scale"), "audioScale");
  const reserved = new Set(["type", "x", "y", "w", "h", "z", "rotation", "scale", "opacity", "active", "visible", "name", "inputs"]);
  for (const spec of AUDIO_SPECS)
    for (const k of spec.knobs ?? [])
      assert.ok(!reserved.has(audioKnobKey(k.key)), `${spec.type}.${k.key} collides with universal item state`);
});

check("a knob whose equation broke falls back to its default instead of NaN-ing the engine", () => {
  // A NaN'd AudioParam stays NaN per the Web Audio spec — one bad equation would
  // silence that module for the rest of the session with no way back.
  const spec = { knobs: [{ key: "cutoff", default: 800 }] };
  assert.equal(audioKnobValues(spec, { audioCutoff: "= broken" })[0].value, 800);
  assert.equal(audioKnobValues(spec, { audioCutoff: NaN })[0].value, 800);
  assert.equal(audioKnobValues(spec, { audioCutoff: Infinity })[0].value, 800);
  assert.equal(audioKnobValues(spec, { audioCutoff: 1200 })[0].value, 1200);
  // and a real 0 is NOT treated as missing
  assert.equal(audioKnobValues(spec, { audioCutoff: 0 })[0].value, 0);
});

// ── FAMILIES ────────────────────────────────────────────────────────────────

check("every spec's family is a declared family", () => {
  for (const spec of AUDIO_SPECS)
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type} has unknown family "${spec.family}"`);
});

check("all six families are actually used — an unused family is a colour nobody sees", () => {
  const used = new Set(AUDIO_SPECS.map((s) => s.family));
  assert.deepEqual([...used].sort(), NODE_FAMILY_NAMES.slice().sort());
});

check("a family-less node renders byte-identically to the pre-family look", () => {
  // The proof trio (plugins/node_*.js) declares no family, and its picture must not
  // have changed when families landed.
  const s = { w: 140, h: 90 };
  assert.equal(nodeFamily().header, "#262b3d");
  assert.equal(familyCard(s, "Plain").length, 4, "no mark op for a family-less card");
  assert.equal(familyCard(s, "Reverb", "effect").length, 5, "a family card adds exactly its mark");
  // A family-less card's TITLE keeps the unbounded width it had before the mark
  // existed — the box that clears the emblem is added only when there is one.
  assert.equal(familyCard(s, "Plain")[3].boxW, Infinity);
  assert.deepEqual(familyRim(s)[0].stroke, familyRim(s, "nonsense")[0].stroke);
});

check("the family accents differ from each other but never touch the shared body", () => {
  const headers = NODE_FAMILY_NAMES.map((n) => NODE_FAMILIES[n].header);
  assert.equal(new Set(headers).size, headers.length, "two families share a header tint — they would not sort");
  const rims = NODE_FAMILY_NAMES.map((n) => NODE_FAMILIES[n].rim);
  assert.equal(new Set(rims).size, rims.length);
  const marks = NODE_FAMILY_NAMES.map((n) => NODE_FAMILIES[n].mark);
  assert.equal(new Set(marks).size, marks.length, "the mark is the colour-blind-safe channel; duplicates defeat it");
  // The BODY is the shared value that keeps a patch one family of objects. Every
  // card's first op is the body, and it must be the same fill for every family.
  const bodies = NODE_FAMILY_NAMES.map((n) => JSON.stringify(familyCard({ w: 10, h: 10 }, "x", n)[0].fill));
  assert.equal(new Set(bodies).size, 1, "a family tinted its BODY — that is the gaudy failure the ruling forbids");
});

check("the analysis family is exactly the two nodes with live overlays", () => {
  const analysis = AUDIO_SPECS.filter((s) => s.family === "analysis").map((s) => s.type);
  const overlaid = AUDIO_SPECS.filter((s) => s.overlay).map((s) => s.type);
  assert.deepEqual(analysis.sort(), overlaid.sort());
  assert.deepEqual(overlaid.sort(), ["audio_meter", "audio_spectrum"]);
});

// ── READOUT ─────────────────────────────────────────────────────────────────

check("a readout names a knob the spec really has, or nothing at all", () => {
  for (const spec of AUDIO_SPECS) {
    if (!spec.readout) continue;
    assert.ok((spec.knobs ?? []).some((k) => k.key === spec.readout),
      `${spec.type} reads out "${spec.readout}", which is not one of its knobs`);
  }
});

check("the readout formats with its unit and tracks the state", () => {
  const clock = AUDIO_SPECS.find((s) => s.module === "clock");
  assert.equal(audioReadout(clock, {}), "90 BPM");
  assert.equal(audioReadout(clock, { audioBpm: 128 }), "128 BPM");
  const reverb = AUDIO_SPECS.find((s) => s.module === "reverb");
  assert.equal(audioReadout(reverb, { audioCharacter: "deepSpace" }), "deepSpace");
  const meter = AUDIO_SPECS.find((s) => s.module === "meter");
  assert.equal(audioReadout(meter, {}), "", "a spec with no readout shows nothing rather than a padded number");
});

// ── THE MIRROR'S DIFF (pure — the engine is a transcript, not a sound) ───────
// The mirror's DECISIONS live in core/audio_mirror_diff.js precisely so they can be
// checked here: given two scenes, which engine calls happen? That is the half where
// a mistake is silent (a missing disconnect leaves a ghost wire; a missed setParam
// leaves a knob that visibly moved and audibly did not).

const registry = createRegistry();
registerPlugins(registry);

/** A tiny patch: noise → filter → output, with the LFO unpatched. */
const SCENE_A = {
  n1: { type: "audio_noise", audioLevel: 0.5, audioColor: "pink", inputs: {} },
  f1: { type: "audio_filter", audioFrequency: 800, audioQ: 1, audioType: "lowpass", inputs: { in: { item: "n1", port: "out" } } },
  o1: { type: "audio_output", audioVolume: 0.7, inputs: { in: { item: "f1", port: "out" } } },
};

check("an empty → populated diff adds every module and every wire, modules first", () => {
  const ops = diffAudioScene(readAudioScene({}, registry), readAudioScene(SCENE_A, registry));
  const adds = ops.filter((o) => o.op === "addModule").map((o) => o.id);
  assert.deepEqual(adds.sort(), ["f1", "n1", "o1"]);
  const connects = ops.filter((o) => o.op === "connect");
  assert.equal(connects.length, 2);
  // ORDER MATTERS AND IS PART OF THE CONTRACT: connecting to a module that does not
  // exist yet is an error in the engine, so every addModule must precede every
  // connect in one batch.
  const lastAdd = ops.findLastIndex((o) => o.op === "addModule");
  const firstConnect = ops.findIndex((o) => o.op === "connect");
  assert.ok(lastAdd < firstConnect, "modules must be added before wires are connected");
});

check("an unchanged scene produces NO engine calls at all", () => {
  // The whole point of a diff. A mirror that re-sent its scene every frame would
  // rewire the graph continuously — and a rewire costs a 40 ms guarded ramp, so the
  // patch would be permanently ducked and stuttering.
  const scene = readAudioScene(SCENE_A, registry);
  assert.deepEqual(diffAudioScene(scene, scene), []);
  assert.deepEqual(diffAudioScene(readAudioScene(SCENE_A, registry), readAudioScene({ ...SCENE_A }, registry)), []);
});

check("a knob change is ONE setParam, and touches nothing else", () => {
  const next = { ...SCENE_A, f1: { ...SCENE_A.f1, audioFrequency: 2400 } };
  const ops = diffAudioScene(readAudioScene(SCENE_A, registry), readAudioScene(next, registry));
  assert.equal(ops.length, 1, `expected one op, got ${JSON.stringify(ops)}`);
  assert.deepEqual({ op: ops[0].op, id: ops[0].id, key: ops[0].key, value: ops[0].value },
    { op: "setParam", id: "f1", key: "frequency", value: 2400 });
  assert.ok(ops[0].rampSeconds > 0, "a knob change must RAMP — a stepped AudioParam is an audible click");
});

check("a DISCRETE param change ramps with nothing, because a waveform cannot crossfade", () => {
  const next = { ...SCENE_A, f1: { ...SCENE_A.f1, audioType: "highpass" } };
  const ops = diffAudioScene(readAudioScene(SCENE_A, registry), readAudioScene(next, registry));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].value, "highpass");
  assert.equal(ops[0].rampSeconds, 0, "the engine ignores rampSeconds for a setter; asking for one would be a lie in the transcript");
});

check("a CONSTRUCT-TIME knob change REBUILDS the module and re-establishes its wires", () => {
  const next = { ...SCENE_A, n1: { ...SCENE_A.n1, audioColor: "white" } };
  const ops = diffAudioScene(readAudioScene(SCENE_A, registry), readAudioScene(next, registry));
  const kinds = ops.map((o) => o.op);
  assert.ok(kinds.includes("removeModule") && kinds.includes("addModule"),
    `a construct-time change must rebuild, got ${JSON.stringify(kinds)}`);
  // AND THE WIRE MUST COME BACK. Removing a module drops its connections inside the
  // engine, so a rebuild that forgot to reconnect would leave a patch that looks
  // wired on the canvas and is silent in the speakers — the exact divergence between
  // picture and sound this whole file exists to prevent.
  const reconnects = ops.filter((o) => o.op === "connect" && (o.sourceId === "n1" || o.targetId === "n1"));
  assert.equal(reconnects.length, 1, `the rebuilt module's wire must be re-established, got ${JSON.stringify(ops)}`);
  const addAt = ops.findIndex((o) => o.op === "addModule" && o.id === "n1");
  assert.ok(addAt < ops.indexOf(reconnects[0]), "the rebuilt module must exist before its wire is reconnected");
  // The rebuild must carry the NEW value, or the module would rebuild back to pink.
  assert.equal(ops[addAt].params.color, "white");
});

check("deleting a wire is one disconnect and nothing else", () => {
  const next = { ...SCENE_A, o1: { ...SCENE_A.o1, inputs: {} } };
  const ops = diffAudioScene(readAudioScene(SCENE_A, registry), readAudioScene(next, registry));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "disconnect");
  assert.equal(ops[0].targetId, "o1");
});

check("removing a module disconnects its wires BEFORE removing it", () => {
  const next = { ...SCENE_A };
  delete next.f1;
  const ops = diffAudioScene(readAudioScene(SCENE_A, registry), readAudioScene(next, registry));
  const rm = ops.findIndex((o) => o.op === "removeModule" && o.id === "f1");
  assert.ok(rm >= 0, "the module must be removed");
  for (const [i, o] of ops.entries())
    if (o.op === "disconnect" && (o.sourceId === "f1" || o.targetId === "f1"))
      assert.ok(i < rm, "a wire touching a module must be cut before the module is removed");
});

check("a non-audio widget in the document is INVISIBLE to the mirror", () => {
  // The whole document goes past this. A deck is mostly rectangles and text, and a
  // mirror that treated an unknown widget as a module would try to addModule("rect").
  const scene = readAudioScene({
    ...SCENE_A,
    r1: { type: "rect", x: 0, y: 0, w: 10, h: 10 },
    t1: { type: "text", text: "hello" },
    nd: { type: "node_number", value: 3, inputs: {} },
  }, registry);
  assert.deepEqual(Object.keys(scene.modules).sort(), ["f1", "n1", "o1"],
    "only widgets whose plugin declares audioModule are modules");
});

check("an INACTIVE audio item is not in the patch — Delete keyframes, and silence follows the picture", () => {
  // `active: false` is how an item exists on some slides and not others. A module
  // that kept playing after its widget vanished would be a sound with no source on
  // the slide, which is precisely the un-debuggable case.
  const scene = readAudioScene({ ...SCENE_A, n1: { ...SCENE_A.n1, active: false } }, registry);
  assert.ok(!("n1" in scene.modules));
  // And its dangling wire must not survive into the connection list either.
  for (const c of scene.connections) assert.notEqual(c.sourceId, "n1");
});

check("MULTIPLE OUTPUTS COEXIST — they are summed, never an error (ADDENDUM 10)", () => {
  const twoOuts = { ...SCENE_A, o2: { type: "audio_output", audioVolume: 0.4, inputs: { in: { item: "f1", port: "out" } } } };
  const scene = readAudioScene(twoOuts, registry);
  const outputs = Object.values(scene.modules).filter((m) => m.module === "output");
  assert.equal(outputs.length, 2);
  const ops = diffAudioScene(readAudioScene({}, registry), scene);
  assert.equal(ops.filter((o) => o.op === "addModule" && o.type === "audio_output").length, 2,
    "both outputs must be instantiated — the user ruled they sum, not that one wins");
});

check("a wire to a port that no longer exists is dropped rather than sent to the engine", () => {
  // A retyped or edited widget can leave a connection naming a port its plugin no
  // longer declares. Sending that to the engine is a throw mid-presentation.
  const scene = readAudioScene({
    ...SCENE_A,
    o1: { ...SCENE_A.o1, inputs: { nonsense: { item: "f1", port: "out" } } },
  }, registry);
  assert.equal(scene.connections.filter((c) => c.targetPort === "nonsense").length, 0);
});

check("a wire from a MISSING item is dropped rather than sent to the engine", () => {
  const scene = readAudioScene({
    ...SCENE_A,
    o1: { ...SCENE_A.o1, inputs: { in: { item: "ghost", port: "out" } } },
  }, registry);
  assert.equal(scene.connections.filter((c) => c.sourceId === "ghost").length, 0);
});

check("a wire between an audio node and a NON-audio node is dropped — the engine has no such module", () => {
  const scene = readAudioScene({
    ...SCENE_A,
    nd: { type: "node_number", value: 3, inputs: {} },
    f1: { ...SCENE_A.f1, inputs: { ...SCENE_A.f1.inputs, frequency: { item: "nd", port: "out" } } },
  }, registry);
  assert.equal(scene.connections.filter((c) => c.sourceId === "nd").length, 0,
    "a number node drives document state, not an AudioParam — the mirror must not invent a wire for it");
});

console.log(`\naudio_nodes_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
