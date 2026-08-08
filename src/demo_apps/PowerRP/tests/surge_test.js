/**
 * SURGE XT — bare-node tests for the node, its rig, and its DETERMINISM RULING.
 * Run: node src/demo_apps/PowerRP/tests/surge_test.js
 *
 * ── WHAT IS ACTUALLY AT RISK HERE ───────────────────────────────────────────
 * Surge is the first widget in the roster that carries a stateful DSP engine and a
 * second wasm GUI, so the tempting mistakes are all determinism mistakes and NONE of
 * them throws:
 *
 *   - a node whose `emit()` reached the live engine would make Δt = 0 produce two
 *     different pictures, quietly breaking frame-range sharding and export
 *     reproducibility for any deck containing it;
 *   - a document leaf that was secretly not property state would tween wrongly
 *     between slides and nobody would see it in a still;
 *   - a rig whose wires look right in the picture but are dropped by the engine
 *     graph is the R7-PLAYABLE defect, which shipped thirteen silent demo patches.
 *
 * So the assertions below are about the SHAPE OF THE STATE and the SHAPE OF THE
 * GRAPH, both of which are checkable without an AudioContext. What is NOT checkable
 * here is whether Surge makes a sound — that needs a browser, and is the browser
 * probe's job.
 */

import assert from "node:assert/strict";

import { SURGE_SPEC } from "../core/audio_specs_surge.js";
import { AUDIO_RIGS, SURGE_RIG, audioRigTemplateId } from "../core/audio_rigs.js";
import { buildPatchItems, patchBounds, patchColPitch } from "../core/audio_patches.js";
import { bend14bit, cc7bit, midiNoteFor } from "../synth/modules_surge.js";
import { connectionRefusal, PORT_TYPES } from "../core/nodeflow.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { diffAudioScene, engineValueDecls, initialParamOps, readAudioScene } from "../core/audio_mirror_diff.js";
import { documentIsSimulated, stridedShardRefusal } from "../core/document.js";
import { keyframed, newDocument, slideState, withNewSlide } from "../core/document.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

const registry = createRegistry();
registerPlugins(registry);
const surge = registry.get("audio_surge");

// ── THE MIDI CONVERSIONS ─────────────────────────────────────────────────────
// Pure arithmetic, and the place a silent mistake produces a WRONG SOUND rather
// than an exception — a note a semitone off, or an unbent note that is detuned.

check("a frequency becomes the nearest MIDI note, rounded and clamped", () => {
  assert.equal(midiNoteFor(440), 69, "A4");
  assert.equal(midiNoteFor(261.6255653005986), 60, "middle C");
  assert.equal(midiNoteFor(880), 81, "an octave up is +12");
  // ROUNDING, not truncation: 261.63 Hz is middle C and must not land on 59.
  assert.equal(midiNoteFor(261.4), 60);
  // An LFO wired into `pitch` may produce anything; clamp rather than hand Surge
  // a negative note number, which it would read as garbage.
  assert.equal(midiNoteFor(0), 0);
  assert.equal(midiNoteFor(-5), 0);
  assert.equal(midiNoteFor(1e9), 127);
  assert.equal(midiNoteFor(NaN), 0);
});

check("a 0..1 knob becomes a 7-bit CC, and a -1..1 knob a 14-bit bend centred on 8192", () => {
  assert.equal(cc7bit(0), 0);
  assert.equal(cc7bit(1), 127);
  assert.equal(cc7bit(0.5), 64);
  assert.equal(cc7bit(99), 127, "clamped, not wrapped");
  // THE CENTRE IS EXACTLY 8192. A bend of 0 must be NO bend; a half-rounding here
  // would detune every note that was never bent, which is inaudible as a bug and
  // very audible as a sound.
  assert.equal(bend14bit(0), 8192);
  assert.equal(bend14bit(1), 16383);
  assert.equal(bend14bit(-1), 0);
  assert.equal(bend14bit(-0.5), 4096);
  assert.equal(bend14bit(NaN), 8192, "an unresolved equation must not detune the synth");
});

// ── THE DETERMINISM RULING ───────────────────────────────────────────────────

check("RULING: a Surge node introduces NO simulated state, so it never refuses a strided shard", () => {
  // THE CLAIM, stated as a test because the prose alone has been wrong before:
  // Surge's DSP recursion (sample N depends on N-1) is NOT the taxonomy's SIMULATED
  // state. Simulated state is a DOCUMENT VALUE reading `@`/`dt`, which feeds the
  // render tree — a strided shard would then render a wrong PICTURE. Surge's
  // recursion feeds an AudioContext and reaches no pixel, so the refusal must stay
  // silent. If this ever reds, something put a clock or an `@` into the node's
  // defaults, and the export story changed without anyone saying so.
  let doc = newDocument();
  const slide = 0;
  doc = {
    ...doc,
    slides: doc.slides.map((s, i) => (i === slide
      ? { ...s, delta: { ...s.delta, items: { ...s.delta.items, surge1: { ...surge.defaults, active: true } } } }
      : s)),
  };
  assert.equal(documentIsSimulated(doc, registry), false,
    "a deck containing a Surge node must not read as simulated — Surge's statefulness is in the engine, not in the document");
  assert.equal(stridedShardRefusal(doc, registry), null,
    "a Surge deck must remain strided-shardable; widening the refusal would slow every synth deck for a risk that does not exist");
});

check("RULING: every leaf a Surge node is born with is PROPERTY STATE — no clock, no equation", () => {
  // Property state is "computable from [[slide, alpha]] alone, with no history". The
  // mechanical form of that here: nothing in the defaults is an equation, so nothing
  // can read `time`, `@` or `dt` before the author writes one.
  for (const [key, value] of Object.entries(surge.defaults)) {
    if (typeof value !== "string") continue;
    assert.ok(!value.trimStart().startsWith("="),
      `Surge's default for "${key}" is an equation (${JSON.stringify(value)}) — a widget must be born with values, not with a computation that could read a clock`);
  }
  // The patch is a plain string leaf, which is what makes it saveable, undoable and
  // switchable between slides.
  assert.equal(typeof surge.defaults.patchData, "string");
  assert.equal(typeof surge.defaults.patchName, "string");
});

check("RULING: emit() is a pure function of state — the same state twice gives the same ops", () => {
  // Δt = 0 ⟹ a byte-identical frame. The GUI's canvas lives in the modal and must
  // NEVER reach the display list; if it ever did, these two calls would differ (the
  // GUI repaints on its own rAF loop). This is the cheap mechanical form of the
  // orthogonality law, and it is the assertion that catches a future "let's show a
  // little waveform on the card" from reading the live engine.
  const state = { ...surge.defaults, x: 0, y: 0 };
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const a = JSON.stringify(surge.emit(state, null, world));
  const b = JSON.stringify(surge.emit(state, null, world));
  assert.equal(a, b, "two emits of one state disagreed — something in the node's picture is reading live state");
  assert.ok(a.length > 2, "emit produced nothing at all");
});

check("RULING: the node card is drawn with NO display context, exactly as a headless render supplies", () => {
  // Every exporter, thumbnail and cli/render.js passes no `ctx`. A node that needed
  // one would render as a hole in a PNG while looking fine on screen.
  const state = { ...surge.defaults };
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const headless = JSON.stringify(surge.emit(state, null, world));
  const live = JSON.stringify(surge.emit(state, null, world, { liveAnalysis: null }));
  assert.equal(headless, live, "the Surge card differs between a headless surface and a live one");
});

// ── THE PORTS ────────────────────────────────────────────────────────────────

check("the midi input is a REAL PORT of a REAL TYPE, not a property naming a source", () => {
  // The user's ruling: "literally having signal as a node is important". A midi
  // connection must be a draggable cable, which means it must be a declared port —
  // that is what makes connectionsOf, deriveWires and the bead renderer see it.
  const ports = surge.ports(surge.defaults);
  const notes = ports.inputs.find((p) => p.key === "notes");
  assert.ok(notes, "Surge declares no `notes` input");
  assert.equal(notes.type, "midi");
  assert.ok(PORT_TYPES.midi, "the midi port type is not declared in core/nodeflow.js");
  // And it must NOT be a number in disguise.
  assert.notEqual(notes.type, "number");
});

check("Surge's output is an ordinary audio port, so it wires into the rest of the roster", () => {
  const out = surge.ports(surge.defaults).outputs.find((p) => p.key === "out");
  assert.equal(out.type, "audio");
  // The compatibility claim, checked against the SAME refusal the drag gesture uses,
  // for the module the user named plus a filter and the destination.
  for (const [type, port] of [["audio_reverb", "in"], ["audio_filter", "in"], ["audio_output", "in"], ["audio_delay", "in"]]) {
    const target = registry.get(type);
    const refusal = connectionRefusal(
      { s: { ...surge.defaults, active: true }, t: { ...target.defaults, active: true } },
      registry, { item: "s", port: "out" }, { item: "t", port },
    );
    assert.equal(refusal, null, `surge.out -> ${type}.${port} was refused: ${refusal}`);
  }
});

check("a number, a trigger and an audio signal are all REFUSED at the midi input", () => {
  // The other half of "midi is a real type": if anything could land there, the type
  // would be decoration. Each of these is a category error, not a missing coercion.
  for (const [type, port] of [["audio_lfo", "out"], ["audio_oscillator", "out"], ["node_knob", "out"]]) {
    const source = registry.get(type);
    const refusal = connectionRefusal(
      { a: { ...source.defaults, active: true }, s: { ...surge.defaults, active: true } },
      registry, { item: "a", port }, { item: "s", port: "notes" },
    );
    assert.ok(refusal, `${type}.${port} -> surge.notes was ALLOWED; a midi input that accepts anything is not a type`);
  }
});

// ── THE OFF-THE-SHELF RIG ────────────────────────────────────────────────────

check("the rig is keyboard -> surge -> output, left to right in signal order", () => {
  assert.deepEqual(SURGE_RIG.nodes.map((n) => n.type),
    ["node_keyboard", "audio_surge", "audio_output"]);
  const cols = SURGE_RIG.nodes.map((n) => n.col);
  assert.deepEqual(cols, [...cols].sort((a, b) => a - b), "the rig must read left to right");
  assert.equal(SURGE_RIG.nodes[0].col, 0, "the keyboard is on the LEFT");
  assert.ok(SURGE_RIG.nodes[2].col > SURGE_RIG.nodes[1].col, "the output is on the RIGHT of the synth");
});

check("every rig node names a registered widget type", () => {
  for (const rig of AUDIO_RIGS)
    for (const node of rig.nodes)
      assert.ok(registry.get(node.type), `rig "${rig.id}" names unknown type ${node.type}`);
});

check("every rig wire is one the EDITOR would accept — the same refusal the drag uses", () => {
  for (const rig of AUDIO_RIGS) {
    const items = {};
    for (const node of rig.nodes) items[node.id] = { ...registry.get(node.type).defaults, active: true };
    for (const wire of rig.wires) {
      const refusal = connectionRefusal(items, registry,
        { item: wire.from, port: wire.fromPort }, { item: wire.to, port: wire.toPort });
      assert.equal(refusal, null,
        `rig "${rig.id}": ${wire.from}.${wire.fromPort} -> ${wire.to}.${wire.toPort} is refused: ${refusal}`);
    }
  }
});

check("no rig node overlaps the next column", () => {
  for (const rig of AUDIO_RIGS) {
    const pitch = patchColPitch(rig, registry);
    for (const node of rig.nodes) {
      const w = Number.isFinite(node.w) ? node.w : (registry.get(node.type).defaults.w ?? 0);
      assert.ok(w <= pitch, `rig "${rig.id}": ${node.type} is ${w} wide against a column pitch of ${pitch}`);
    }
  }
});

check("the built rig is ONE graph: every wire lands, and the chain reaches an output", () => {
  const { states, order } = buildPatchItems(SURGE_RIG, registry, { x: 0, y: 0 }, (id) => `rig_${id}`);
  assert.equal(order.length, 3);
  // Wires are stored on the INPUT side, which is where a connection lives.
  assert.equal(states.rig_surge.inputs.gate.item, "rig_keys");
  assert.equal(states.rig_surge.inputs.pitch.item, "rig_keys");
  assert.equal(states.rig_out.inputs.in.item, "rig_surge");
  assert.equal(states.rig_out.inputs.in.port, "out");
  // Every state carries its plugin's defaults, so nothing needs repair on load.
  assert.equal(states.rig_surge.type, "audio_surge");
  assert.equal(states.rig_surge.patchName, SURGE_SPEC.state.find((s) => s.key === "patchName").default);
  assert.ok(patchBounds(SURGE_RIG, registry, { x: 0, y: 0 }).w > 0);
});

check("R7-PLAYABLE: the ENGINE graph is the one audio wire, and the keyboard's two are live routes", () => {
  // THE LESSON THIS PINS: `readAudioScene` wires only nodes that HAVE an
  // `audioModule`, so a keyboard's cables are DROPPED from the engine graph. That is
  // correct and is not silence — they are read from the document at press time by
  // core/live_control.noteRoutes. What would be silence is the AUDIO wire going
  // missing, so that is what is asserted positively.
  const { states } = buildPatchItems(SURGE_RIG, registry, { x: 0, y: 0 }, (id) => `rig_${id}`);
  const items = Object.fromEntries(Object.entries(states).map(([id, s]) => [id, { ...s, active: true }]));
  const scene = readAudioScene(items, registry);
  assert.ok(scene.modules.rig_surge, "Surge is not in the engine scene at all");
  // `.module` is the ENGINE module name; `.type` is the WIDGET type. Asserting the
  // engine name is the point — it is what addModule dispatches on.
  assert.equal(scene.modules.rig_surge.module, "surge");
  assert.equal(scene.modules.rig_surge.type, "audio_surge");
  assert.ok(!scene.modules.rig_keys, "a keyboard must NOT be an engine module");
  const audioWire = scene.connections.find((c) => c.sourceId === "rig_surge" && c.targetId === "rig_out");
  assert.ok(audioWire, `surge -> output is missing from the engine scene: ${JSON.stringify(scene.connections)}`);
});

check("the spec names its rig, and the rig answers to that id", () => {
  assert.equal(SURGE_SPEC.rig, audioRigTemplateId(SURGE_RIG.id),
    "the spec's `rig` id and the rig's own template id have drifted — the Add command would refuse");
});

check("Surge routes double-click to its own GUI, not to knob focus", () => {
  assert.equal(surge.activate, "surge_gui");
  // And the roster's default is untouched by the override existing.
  assert.equal(registry.get("audio_poly_pad").activate, "knob_focus");
});


// ── THE PATCH SURVIVES: RELOAD, SLIDES, UNDO ─────────────────────────────────
//
// THE BUG THESE PIN (user, 2026-08-08): "surge's presets dont even survive a page
// reload lol" … "we should be able to have a preset every slide lol". `patchData`
// was stored correctly and NOTHING EVER READ IT BACK, so the engine booted Surge's
// Init patch every time. The assertions below are deliberately about what reaches
// the ENGINE, not about what the document holds — the document was always right,
// which is exactly why nothing caught this.

/** A document with one Surge node, and `patchData` keyframed per slide. */
function deckWithPatches(perSlide) {
  const surgePlugin = registry.get("audio_surge");
  let doc = newDocument();
  doc = keyframed(doc, 0, ["items", "s1"], { ...surgePlugin.defaults, active: true });
  for (let i = 0; i < perSlide.length; i++) {
    if (i > 0) [doc] = withNewSlide(doc, i - 1);
    doc = keyframed(doc, i, ["items", "s1", "patchData"], perSlide[i]);
  }
  return doc;
}

/** The engine ops a scene transition produces, as the mirror would compute them. */
const sceneOf = (doc, slide) => readAudioScene(slideState(doc, slide).items, registry);

check("RELOAD: a freshly-built module is told the SAVED patch, not Surge's Init", () => {
  // On boot every module is BORN, and `initialParamOps` is what the mirror sends
  // right after `addModule`. If patchData is not in that burst, a reloaded deck
  // plays Init — which is the reported bug, exactly.
  const doc = deckWithPatches(["SAVEDPATCHBYTES"]);
  const scene = sceneOf(doc, 0);
  const ops = initialParamOps(scene.modules.s1, "s1");
  const patchOp = ops.find((o) => o.key === "patchData");
  assert.ok(patchOp, `no patchData in the birth burst — a reloaded deck would play Init. Got: ${ops.map((o) => o.key).join(", ")}`);
  assert.equal(patchOp.value, "SAVEDPATCHBYTES");
  assert.equal(patchOp.rampSeconds, 0, "a patch load cannot be glided into");
});

check("PER-SLIDE: navigating to a slide with a different patch loads it", () => {
  // The user's "a preset every slide". Slide 0 and slide 1 hold different blobs;
  // the diff between the two scenes must carry the second one.
  const doc = deckWithPatches(["PATCH_ONE", "PATCH_TWO"]);
  assert.equal(slideState(doc, 0).items.s1.patchData, "PATCH_ONE");
  assert.equal(slideState(doc, 1).items.s1.patchData, "PATCH_TWO");
  const ops = diffAudioScene(sceneOf(doc, 0), sceneOf(doc, 1));
  const patchOp = ops.find((o) => o.op === "setParam" && o.key === "patchData");
  assert.ok(patchOp, `navigating slides produced no patch load: ${JSON.stringify(ops)}`);
  assert.equal(patchOp.value, "PATCH_TWO");
  // AND IT MUST NOT RAMP. This is the assertion the `discrete` flag exists for, and
  // it belongs on the DIFF path rather than the birth path — `initialParamOps` sends
  // everything at ramp 0 anyway, so a reload test could never catch a lost flag.
  // Without it the mirror would hand a 40 KB blob a 33 ms glide, which for a setter
  // param means the ramp argument is simply a lie in the transcript.
  assert.equal(patchOp.rampSeconds, 0,
    "a patch load was given a ramp — a patch cannot be interpolated into");
});

check("PER-SLIDE: a slide that does NOT change the patch inherits it and reloads nothing", () => {
  // The other half, and the one that keeps this cheap: an unchanged fold must
  // produce NO op at all. A 40 KB blob re-sent on every navigation would stutter
  // the voice it interrupts.
  const doc = deckWithPatches(["PATCH_ONE", "PATCH_TWO"]);
  const [withThird] = withNewSlide(doc, 1);
  assert.equal(slideState(withThird, 2).items.s1.patchData, "PATCH_TWO", "slide 3 must INHERIT the folded patch");
  const ops = diffAudioScene(sceneOf(withThird, 1), sceneOf(withThird, 2));
  assert.equal(ops.filter((o) => o.key === "patchData").length, 0,
    `an unchanged patch was re-sent: ${JSON.stringify(ops)}`);
});

check("NO RELOAD ON EVERY FRAME: diffing a scene against ITSELF sends nothing", () => {
  // The mirror runs per frame. This is the cheapest possible statement of "load
  // only on change", and it is the assertion that catches a future refactor that
  // rebuilds the value object each pass.
  const doc = deckWithPatches(["PATCH_ONE"]);
  const ops = diffAudioScene(sceneOf(doc, 0), sceneOf(doc, 0));
  assert.deepEqual(ops, [], `a steady scene produced engine calls: ${JSON.stringify(ops)}`);
});

check("the patch is carried as an ENGINE VALUE, and patchName is NOT", () => {
  // `patchName` is a LABEL; pushing it at the engine would be a call that means
  // nothing. Only the leaf that declares `engineParam` travels.
  const keys = engineValueDecls(SURGE_SPEC).map((k) => k.key);
  assert.ok(keys.includes("patchData"), "patchData is not an engine value — it would be write-only again");
  assert.ok(!keys.includes("patchName"), "patchName must not be pushed to the engine");
  // And it must not have become a KNOB — that would put a 40 KB blob in an
  // Inspector dial and red the engine-param sweep.
  assert.ok(!(SURGE_SPEC.knobs ?? []).some((k) => k.key === "patchData"));
});

check("the DELTA COST is per DISTINCT PATCH, not per slide", () => {
  // The user's "deltas between slides" concern, measured rather than assumed. A
  // slide that changes nothing must carry no patch bytes at all.
  const doc = deckWithPatches(["AAAA_one", "BBBB_two"]);
  const [three] = withNewSlide(doc, 1);
  const deltas = three.slides.map((sl) => JSON.stringify(sl.delta));
  assert.ok(deltas[0].includes("AAAA_one"));
  assert.ok(deltas[1].includes("BBBB_two"));
  assert.ok(!deltas[1].includes("AAAA_one"), "slide 1's delta duplicated slide 0's patch");
  assert.ok(!deltas[2].includes("patchData"),
    `a slide that changes nothing carries patch bytes: ${deltas[2].slice(0, 120)}`);
});

console.log(process.exitCode ? `surge_test: ${passed} checks passed (WITH FAILURES)` : `surge_test: ${passed} checks passed`);
