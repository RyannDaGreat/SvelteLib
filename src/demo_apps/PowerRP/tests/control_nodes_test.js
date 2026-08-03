/**
 * CONTROL NODES — bare-node tests for the widgets a hand plays.
 * Run: node src/demo_apps/PowerRP/tests/control_nodes_test.js
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────
 * The four control nodes (knob, slider, button, keyboard) and the LIVE ROUTING
 * that turns a press into an engine call. Everything here is a pure function of
 * the document, so all of it runs without a browser, an AudioContext or a
 * pointer — which is the point: a press that routes to the wrong module, or to
 * nothing, produces silence rather than an exception, and silence is what this
 * suite exists to make loud.
 *
 * The ROSTER SWEEPS are deliberately derived from the registry rather than
 * listed, so a fifth control node added tomorrow is checked by all of them
 * without editing this file.
 */

import assert from "node:assert/strict";

import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { PORT_TYPES, declaredPorts, portAt } from "../core/nodeflow.js";
import { noteFrequency, noteRoutes, triggerRoutes } from "../core/live_control.js";
import { keyAt, keyLayout, noteName } from "../core/keyboard_layout.js";
import { controlValue } from "../core/control_nodes.js";
import { knobDragValue, knobRadius } from "../core/node_knobs.js";
import { midiToFreq } from "../synth/dsp.js";

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

const registry = createRegistry();
registerPlugins(registry);

/** Every registered CONTROL node, derived — never listed. */
const CONTROLS = registry.all().filter((p) => p.controlNode);

console.log("control nodes: the roster");

check("all four control nodes are registered", () => {
  const types = CONTROLS.map((p) => p.type).sort();
  for (const want of ["node_button", "node_keyboard", "node_knob", "node_slider"])
    assert.ok(types.includes(want), `${want} is not registered (have ${types})`);
});

check("every control node declares HONEST PORTS — real types, at least one output", () => {
  for (const plugin of CONTROLS) {
    const ports = declaredPorts(plugin, plugin.defaults);
    assert.ok(ports.outputs.length > 0, `${plugin.type} produces nothing — a control source must have an output`);
    for (const p of [...ports.inputs, ...ports.outputs])
      assert.ok(PORT_TYPES[p.type], `${plugin.type} port ${p.key} declares unknown type ${p.type}`);
  }
});

check("every control node's INK BOUNDS include its port beads", () => {
  // THE BOUNDS PROTOCOL (core/registry.js): a bead straddles the card's edge, so
  // ink that stopped at the card would be culled early, missed by band select,
  // cropped from a capture and unclickable — four defects at once.
  for (const plugin of CONTROLS) {
    const s = { ...plugin.defaults };
    const bounds = plugin.localBounds(s);
    assert.ok(bounds.w >= s.w, `${plugin.type}'s ink is narrower than its own card`);
    assert.ok(bounds.h >= s.h, `${plugin.type}'s ink is shorter than its own card`);
  }
});

check("every control node PAINTS something and carries an insert command", () => {
  for (const plugin of CONTROLS) {
    const ops = plugin.emit({ ...plugin.defaults }, null, [1, 0, 0, 1, 0, 0]);
    assert.ok(ops.length > 0, `${plugin.type} paints nothing`);
    assert.equal(plugin.commands.length, 1, `${plugin.type} must be insertable from the palette`);
  }
});

check("every control node carries `inputs: {}` so a COPY remaps its wires", () => {
  // NF-CORE measured what forgetting this costs: NODE_ITEM_REFS names a wildcard
  // path through `inputs`, and a wildcard cannot expand over a slot that does not
  // exist — so a copied node stays wired to the original.
  for (const plugin of CONTROLS)
    assert.deepEqual(plugin.defaults.inputs, {}, `${plugin.type} must declare an empty-but-present inputs map`);
});

console.log("control nodes: the knob and the slider");

const knob = registry.get("node_knob");
const slider = registry.get("node_slider");

check("both declare ONE dial whose stateKey is the leaf it writes", () => {
  for (const plugin of [knob, slider]) {
    const layout = plugin.knobLayout({ ...plugin.defaults });
    assert.equal(layout.length, 1, `${plugin.type} should have exactly one control`);
    assert.equal(layout[0].stateKey, "value", `${plugin.type} writes a plain \`value\` leaf, with no prefix`);
    assert.ok("value" in plugin.defaults, `${plugin.type} must declare the leaf its dial writes`);
  }
});

check("both name the knob-focus mode, so the landed gesture applies", () => {
  for (const plugin of [knob, slider]) assert.equal(plugin.activate, "knob_focus");
});

check("a dial's grab radius is its OWN, not the shared module constant", () => {
  // A dial drawn at one size and grabbed at another is invisible in a
  // screenshot: the picture looks right and only the click misses.
  for (const plugin of [knob, slider]) {
    const k = plugin.knobLayout({ ...plugin.defaults })[0];
    assert.equal(knobRadius(k), k.r, `${plugin.type}'s hit radius must be the one it declared`);
  }
});

check("THE SLIDER'S HANDLE TRACKS THE CURSOR across its whole track", () => {
  // The measured defect: with the shared 150-unit drag span against a track ~86
  // tall, dragging the handle to the top of its own track reached 0.79 of the
  // range and the handle visibly lagged the pointer.
  const s = { ...slider.defaults };
  const rec = slider.knobLayout(s)[0];
  const track = slider.knobLayout(s)[0].span;
  assert.ok(track > 0, "the slider must declare its track length as the drag span");
  const toTop = knobDragValue(rec, rec.value, -track / 2, false);
  const toBottom = knobDragValue(rec, rec.value, track / 2, false);
  assert.equal(toTop, rec.max, "dragging the handle to the track's top must reach the maximum");
  assert.equal(toBottom, rec.min, "and to its bottom, the minimum");
});

check("both output their value, CLAMPED to their own declared range", () => {
  for (const plugin of [knob, slider]) {
    const base = { ...plugin.defaults, min: 0, max: 1 };
    assert.equal(plugin.computeOutputs({ ...base, value: 0.25 }).out, 0.25);
    assert.equal(plugin.computeOutputs({ ...base, value: 9 }).out, 1, `${plugin.type} must not report past its own maximum`);
    assert.equal(plugin.computeOutputs({ ...base, value: -9 }).out, 0);
  }
});

check("a BOUND (equation) value is flagged so the drag can refuse it", () => {
  for (const plugin of [knob, slider]) {
    const layout = plugin.knobLayout({ ...plugin.defaults, value: "= ease(time)" });
    assert.equal(layout[0].bound, true, `${plugin.type} must mark an equation-held value as bound`);
  }
});

check("controlValue substitutes the default for a non-number rather than emitting NaN", () => {
  // A NaN would propagate through every downstream node's arithmetic, turning one
  // visible equation error into a graph-wide silent one.
  assert.equal(controlValue("= nope", 0.25, 0, 1), 0.25);
  assert.equal(controlValue(undefined, 0.25, 0, 1), 0.25);
  assert.equal(controlValue(0.5, 0.25, 0, 1), 0.5);
});

console.log("control nodes: the button");

const button = registry.get("node_button");

check("the button's one output is a TRIGGER", () => {
  const ports = declaredPorts(button, button.defaults);
  assert.equal(ports.outputs.length, 1);
  assert.equal(ports.outputs[0].type, "trigger");
});

check("its face is pressable and its header is NOT (a press there drags the node)", () => {
  const s = { ...button.defaults };
  assert.equal(button.livePress.hit(s, s.w / 2, s.h / 2), true, "the middle of the card is the face");
  assert.equal(button.livePress.hit(s, s.w / 2, 4), false, "the title bar is not the button");
  assert.equal(button.livePress.hit(s, -20, s.h / 2), false, "outside the card is not the button");
});

check("its graph-visible output is a RESTING gate — an event is not a value", () => {
  assert.equal(button.computeOutputs({}).out, 0);
});

console.log("control nodes: the keyboard");

const keyboard = registry.get("node_keyboard");

check("the keyboard outputs pitch (number) AND gate (trigger)", () => {
  const outs = declaredPorts(keyboard, keyboard.defaults).outputs;
  assert.equal(outs.find((p) => p.key === "pitch")?.type, "number");
  assert.equal(outs.find((p) => p.key === "gate")?.type, "trigger");
});

check("every key of the default keyboard is REACHABLE — none is covered", () => {
  // The overlap bug in miniature: a black key painted over a white one must not
  // make either unhittable. A miss here is a keyboard that plays the note next
  // to the one you clicked — audible, wrong, and with nothing to explain it.
  const s = { ...keyboard.defaults };
  const keys = keyboard.keyboardKeys(s);
  const unreachable = keys.filter((k) => {
    // A black key is probed at its own middle; a white one BELOW the black keys'
    // shorter bodies, which is the part of it that is actually exposed.
    const hit = keyboard.livePlay.noteAt(s, k.x + k.w / 2, k.black ? k.y + k.h / 2 : k.y + k.h * 0.9);
    return hit?.note !== k.note;
  });
  assert.deepEqual(unreachable.map((k) => noteName(k.note)), [], "keys that cannot be played");
});

check("two octaves is 24 keys: 14 white, 10 black", () => {
  const keys = keyboard.keyboardKeys({ ...keyboard.defaults });
  assert.equal(keys.length, 24);
  assert.equal(keys.filter((k) => !k.black).length, 14);
  assert.equal(keys.filter((k) => k.black).length, 10);
});

check("the black keys fall on the right semitones — no key between E-F or B-C", () => {
  const keys = keyLayout({ w: 140, h: 40 }, 60, 1);
  assert.deepEqual(keys.filter((k) => k.black).map((k) => k.note - 60).sort((a, b) => a - b), [1, 3, 6, 8, 10]);
});

check("keyAt walks BACK TO FRONT, so a black key beats the white beneath it", () => {
  const keys = keyLayout({ w: 140, h: 40 }, 60, 1);
  assert.equal(keyAt(keys, 20, 8).note, 61, "high up, the black key wins");
  assert.equal(keyAt(keys, 20, 35).note, 62, "below its shorter body, the white key does");
});

check("its resting `pitch` output is its BASE NOTE — defined and reproducible", () => {
  // Reporting "the last note played" would leak live state into the value
  // evaluator and make an export non-deterministic.
  assert.equal(keyboard.computeOutputs({ baseNote: 69 }).pitch, 440);
  assert.equal(keyboard.computeOutputs({}).gate, 0);
});

check("core's noteFrequency AGREES with the engine's midiToFreq", () => {
  // core/ may not import synth/**, so the conversion is restated there. This is
  // the assertion that stops the duplicate drifting into two different tunings.
  for (const note of [21, 48, 60, 69, 81, 108])
    assert.ok(Math.abs(noteFrequency(note) - midiToFreq(note)) < 1e-9,
      `note ${note}: core says ${noteFrequency(note)}, the engine says ${midiToFreq(note)}`);
});

console.log("control nodes: live routing");

/** A small patch: a button into a bell, a keyboard into a poly pad AND a bell. */
const items = {
  btn: { type: "node_button" },
  kbd: { type: "node_keyboard" },
  bell: { type: "audio_ding", inputs: { gate: { item: "btn", port: "out" } } },
  poly: { type: "audio_poly_pad", inputs: { gate: { item: "kbd", port: "gate" } } },
  chime: { type: "audio_ding", inputs: { gate: { item: "kbd", port: "gate" } } },
};

check("ONE BUTTON PRESS PRODUCES EXACTLY ONE TRIGGER EDGE", () => {
  const routes = triggerRoutes(items, registry, "btn");
  assert.equal(routes.length, 1, "one press, one edge — not zero and not two");
  assert.deepEqual(routes[0], { op: "trigger", id: "bell", port: "gate" });
});

check("a button wired to NOTHING fires nothing, quietly", () => {
  assert.deepEqual(triggerRoutes({ btn: { type: "node_button" } }, registry, "btn"), []);
});

check("a button wired to an ORDINARY (non-method) input fires nothing", () => {
  // An AudioParam input is driven by the mirror's connect, not by an event.
  // Firing at one would be a call the engine refuses.
  const wrong = { btn: { type: "node_button" }, f: { type: "audio_filter", inputs: { frequency: { item: "btn", port: "out" } } } };
  assert.deepEqual(triggerRoutes(wrong, registry, "btn"), []);
});

check("a press does not reach a module that is OFF THIS SLIDE", () => {
  const off = { ...items, bell: { ...items.bell, active: false } };
  assert.deepEqual(triggerRoutes(off, registry, "btn"), []);
});

check("A KEY PRESS ALLOCATES ON THE POLY TARGET and strikes the mono one", () => {
  const on = noteRoutes(items, registry, "kbd", "on", 60, noteFrequency(60));
  const poly = on.find((r) => r.id === "poly");
  const chime = on.find((r) => r.id === "chime");
  assert.equal(poly.op, "noteOn", "a poly module takes NOTES");
  assert.equal(poly.note, 60);
  assert.equal(chime.op, "trigger", "a mono method port takes a pitched strike");
  assert.ok(Math.abs(chime.frequency - noteFrequency(60)) < 1e-9, "…at the key's own pitch");
});

check("a key RELEASE releases the poly voice and does nothing to the bell", () => {
  // A struck bell rings out on its own — that is what a one-shot voice means.
  const off = noteRoutes(items, registry, "kbd", "off", 60, 0);
  assert.equal(off.length, 1);
  assert.deepEqual(off[0], { op: "noteOff", id: "poly", note: 60 });
});

check("AN N-KEY CHORD PRODUCES N DISTINCT NOTE EVENTS", () => {
  // The headline: what the user means by "polyphonic demos are important",
  // checked at the routing layer. The ALLOCATION (which voice, who is stolen)
  // is tests/poly_voices_test.js; this is that every key gets its own event.
  const chord = [60, 64, 67, 71];
  const events = chord.map((n) => noteRoutes(items, registry, "kbd", "on", n, noteFrequency(n)).find((r) => r.op === "noteOn"));
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.note), chord, "each key must carry its OWN note identity");
  assert.equal(new Set(events.map((e) => e.note)).size, 4);
});

check("a keyboard's PITCH wire is not a note event — only the GATE plays", () => {
  // `pitch` is an ordinary control wire the mirror connects; routing notes off it
  // too would double every note.
  const pitched = { kbd: { type: "node_keyboard" }, poly: { type: "audio_poly_pad", inputs: { pitch: { item: "kbd", port: "pitch" } } } };
  assert.deepEqual(noteRoutes(pitched, registry, "kbd", "on", 60, 262), []);
});

console.log(`\n${passed} control-node assertions passed.`);
