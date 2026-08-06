/**
 * THE NOTE LATCH and THE PIANO ROLL — bare-node tests for R7-13 and R7-14.
 * Run: node src/demo_apps/PowerRP/tests/note_latch_test.js
 *
 * ── WHAT THIS PINS, AND WHY EACH HALF IS SILENT WITHOUT IT ──────────────────
 * Both features are a chain from a document leaf to an engine call, and every
 * link in that chain fails QUIETLY when it breaks:
 *   - a latch that does not fold produces a chord that vanishes at a slide change;
 *   - a `derived` knob that does not reach `readAudioScene` produces a piano roll
 *     that draws notes and plays a bar of rests — which is EXACTLY the state the
 *     Sequencer node shipped in for the whole of its existence, undetected;
 *   - a paint that reads the wrong kind of state produces a determinism violation
 *     nobody sees until an export disagrees with the screen.
 * None of those throws. All of them are ordinary assertions here.
 *
 * The ENGINE CROSS-CHECK at the end is `tests/audio_nodes_test.js`'s, applied to
 * the one spec that file cannot sweep: PIANO_ROLL_SPEC is not in AUDIO_SPECS,
 * because it is not built by `audioNodePlugin` (its face is a grid, not a knob
 * band). Without this it would be the only module description in the app whose
 * ports and params nothing proves the engine actually has.
 */

import assert from "node:assert/strict";

import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { latchedChordDelta, latchedChords } from "../core/live_control.js";
import { diffAudioScene, readAudioScene, transportOf } from "../core/audio_mirror_diff.js";
import { foldState } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { setPath } from "../core/deltas.js";
import {
  keyboardLocked, latchedNotes, lockBadgeOps, toggleLatchedNote,
} from "../plugins/node_keyboard.js";
import {
  PIANO_ROLL_SPEC, cellAt, patternLength, patternNotes, pitchRows, sequencerSteps, toggleNote,
} from "../plugins/node_piano_roll.js";
import { MODULE_FACTORIES } from "../synth/modules.js";

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

const registry = createRegistry();
registerPlugins(registry);
/** The identity world transform every emit() in this file is measured under. */
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const keyboard = registry.get("node_keyboard");
const roll = registry.get("node_piano_roll");

console.log("R7-13: the keyboard's lock");

check("the lock is OFF by default, and an unlatched keyboard holds nothing", () => {
  assert.equal(keyboardLocked(keyboard.defaults), false);
  assert.deepEqual(latchedNotes(keyboard.defaults), []);
});

check("BOTH latch leaves ship in `defaults` — a wildcard cannot expand over an absent slot", () => {
  // The reason core/control_nodes.controlDefaults ships `inputs: {}`, one property
  // along: core/deltas.js reaches a leaf through a path, and a path cannot name a
  // key the item does not have. A `heldNotes` that appeared only once a note was
  // latched would be unkeyframable on the slide before that.
  assert.ok("keyLock" in keyboard.defaults, "keyLock must exist at birth");
  assert.ok("heldNotes" in keyboard.defaults, "heldNotes must exist at birth");
});

check("BOTH the switch and the chord have an Inspector row — no JSON-only properties", () => {
  const rows = Object.fromEntries(keyboard.inspector.map((r) => [r.key, r]));
  assert.equal(rows.keyLock?.kind, "boolean", "the lock's row is the square TOGGLE");
  assert.equal(rows.heldNotes?.kind, "list", "the chord's row is the element list control");
  assert.equal(rows.heldNotes?.activeKey, "heldNotesActive");
});

check("a press TOGGLES: absent latches, present releases", () => {
  assert.deepEqual(toggleLatchedNote({}, { note: 60 }), [[60]]);
  assert.deepEqual(toggleLatchedNote({ heldNotes: [[60]] }, { note: 64 }), [[60], [64]]);
  assert.deepEqual(toggleLatchedNote({ heldNotes: [[60], [64]] }, { note: 60 }), [[64]]);
});

check("HIDING an entry silences it and KEEPS its index (core/lists.js's bargain)", () => {
  const s = { heldNotes: [[60], [64], [67]], heldNotesActive: [true, false, true] };
  assert.deepEqual(latchedNotes(s), [60, 67], "a hidden note does not sound");
  assert.equal(s.heldNotes[2][0], 67, "…and nothing moved, so heldNotes.2 still names it");
});

check("THE LATCH IS PAINTED AND A PRESS IS NOT — the two kinds of state, on one widget", () => {
  // The determinism law binds the RENDER: hold the document fixed and the frame is
  // byte-identical. A latched chord is part of the document, so it MUST be in the
  // display list; a press is not, so it must not be. This is the assertion that
  // keeps the distinction from collapsing in either direction.
  const rest = keyboard.emit({ ...keyboard.defaults }, null, IDENTITY);
  const held = keyboard.emit({ ...keyboard.defaults, heldNotes: [[48]] }, null, IDENTITY);
  assert.notDeepEqual(rest, held, "a latched key must change the picture");
  assert.equal(rest.length, held.length, "…by its INK, not by adding ops");
  // …and it is a pure function of the state: the same state twice is the same frame.
  assert.deepEqual(held, keyboard.emit({ ...keyboard.defaults, heldNotes: [[48]] }, null, IDENTITY));
});

check("the LOCK BADGE says which mode the widget is in, and only then", () => {
  assert.deepEqual(lockBadgeOps(keyboard.defaults), []);
  assert.equal(lockBadgeOps({ ...keyboard.defaults, keyLock: true }).length, 2);
});

check("THE LATCH DECLARATION is complete — the canvas gesture needs all five keys", () => {
  // web/CanvasView.svelte startLivePlay reads exactly these and nothing else. A
  // widget shipping four of them would fail at the pointer rather than here.
  for (const key of ["locked", "cellAt", "toggle", "notesKey", "notes"])
    assert.ok(keyboard.noteLatch[key], `the keyboard's noteLatch is missing ${key}`);
});

console.log("R7-13: a latched chord SURVIVES A SLIDE CHANGE");

check("the chord FOLDS — slide 2 holds a different chord from slide 1", () => {
  // The user's own requirement, verbatim: "to let me play different chords and
  // different slides." This is the whole of it, expressed as the document model
  // already expresses everything else.
  const doc = {
    meta: {}, slides: [
      { id: "s0", name: "1", delta: { items: { k: { ...keyboard.defaults, heldNotes: [[48], [52]] } } } },
      { id: "s1", name: "2", delta: setPath({}, ["items", "k", "heldNotes"], [[55], [59]]) },
    ],
  };
  const first = latchedNotes(foldState(doc, 0).items.k);
  const second = latchedNotes(foldState(doc, 1).items.k);
  assert.deepEqual(first, [48, 52]);
  assert.deepEqual(second, [55, 59]);
});

check("a latched note is an ORDINARY EQUATION SLOT, like every other leaf", () => {
  const state = evaluateState({ items: { k: { ...keyboard.defaults, heldNotes: [[48], ["= 48 + 7"]] } }, vars: {} }, registry, "").state;
  assert.deepEqual(latchedNotes(state.items.k), [48, 55], "a per-element equation must resolve");
});

check("THE MIRROR'S DELTA sounds what changed and re-sends nothing else", () => {
  const items = { k: { ...keyboard.defaults, heldNotes: [[48], [52]] } };
  assert.deepEqual(latchedChords(items, registry), { k: [48, 52] });
  // An unchanged chord issues NOTHING: a second noteOn restarts an envelope, so a
  // per-frame re-send would be a stutter rather than a held chord.
  assert.deepEqual(latchedChordDelta({ k: [48, 52] }, { k: [48, 52] }), []);
  // …and a changed one RELEASES BEFORE IT PRESSES, so a finite voice pool never
  // briefly holds more notes than the document asks for and steals one it needs.
  const delta = latchedChordDelta({ k: [48, 52] }, { k: [48, 55] });
  assert.deepEqual(delta.map((d) => d.phase), ["off", "on"]);
  assert.deepEqual(delta.map((d) => d.note), [52, 55]);
});

check("a keyboard that is NOT ON THIS SLIDE holds nothing", () => {
  // The same rule readAudioScene applies to modules: a chord sounding from a widget
  // that is not on the slide is a drone with no visible source.
  assert.deepEqual(latchedChords({ k: { ...keyboard.defaults, active: false, heldNotes: [[48]] } }, registry), {});
});

console.log("R7-14: the piano roll");

check("it is registered, it binds the SEQUENCER, and it wears BOTH title rules", () => {
  assert.equal(roll.audioModule, "sequencer");
  // "Audio " from audioDisplayTitle (the audio-widget prefix) and " Node" from
  // core/registry.withNodeTitle (user, 2026-08-06: "All nodes should have Node in the
  // name"). BOTH halves are asserted here rather than the whole string being loosened,
  // because each is a separate rule that could regress on its own.
  assert.equal(roll.title, "Audio Piano Roll Node");
  assert.deepEqual(roll.ports().outputs.map((p) => p.key), ["pitch", "gate"]);
});

check("the pattern has an Inspector row AND a canvas affordance", () => {
  // "NO JSON-ONLY PROPERTIES", and for a spatial property the canvas half is the
  // point rather than a bonus — a piano roll you can only edit as numbered rows is
  // not a piano roll.
  const rows = Object.fromEntries(roll.inspector.map((r) => [r.key, r]));
  assert.equal(rows.notes?.kind, "list");
  assert.equal(rows.notes?.activeKey, "notesActive");
  assert.equal(rows.audioStepCount?.kind, "number");
  assert.ok(cellAt(roll.defaults, 10, 210), "the grid must be hit-testable");
});

check("THE GRID READS AS PITCH × TIME: low notes at the bottom, step 0 at the left", () => {
  const rows = pitchRows({ baseNote: 60, octaves: 1 });
  assert.equal(rows.length, 12);
  assert.equal(rows[0], 71, "the TOP row is the highest note");
  assert.equal(rows[rows.length - 1], 60);
  const bottomLeft = cellAt(roll.defaults, 10, 210);
  assert.equal(bottomLeft.step, 0);
  assert.equal(bottomLeft.note, 48, "the bottom-left cell is step 0 at the base note");
});

check("a click on an OCCUPIED step MOVES the note — one pitch per step, enforced", () => {
  // The engine's sequencer has one pitch output. A grid that let you draw a chord
  // and sounded its top note would be a picture that lies about the sound.
  assert.deepEqual(toggleNote({ notes: [[0, 60]] }, { step: 0, note: 67 }), [[0, 67]]);
  assert.deepEqual(toggleNote({ notes: [[0, 60]] }, { step: 0, note: 60 }), [], "the same pitch clears it");
  assert.equal(Object.keys(patternNotes({ notes: [[0, 60], [0, 67]] })).length, 1);
});

check("THE PATTERN REACHES THE ENGINE — the whole point of the widget", () => {
  // This is the assertion the Sequencer never had, and its absence is why that node
  // emitted sixteen rests on every deck ever built. It walks the REAL path: an item
  // map through readAudioScene, exactly as web/audioMirror does per frame.
  const items = { pr: { ...roll.defaults, notes: [[0, 60], [4, 64], [8, 67]] } };
  const scene = readAudioScene(items, registry);
  assert.equal(scene.modules.pr.module, "sequencer");
  const steps = scene.modules.pr.knobs.steps;
  assert.equal(steps.length, 16, "the engine gets one entry per step");
  assert.deepEqual(steps.filter((x) => x.on).map((x) => x.note), [60, 64, 67],
    "…and THREE DISTINCT PITCHES, not a bar of rests");
  assert.deepEqual([0, 4, 8].map((i) => steps[i].on), [true, true, true]);
  assert.equal(steps.filter((x) => x.on).length, 3, "every other step is a rest");
});

check("the pattern arrives at addModule TOO, so a rebuild does not lose it", () => {
  const items = { pr: { ...roll.defaults, notes: [[2, 62]] } };
  const [add] = diffAudioScene({ modules: {}, connections: [] }, readAudioScene(items, registry));
  assert.equal(add.op, "addModule");
  assert.equal(add.params.stepCount, 16);
  assert.deepEqual(add.params.steps[2], { on: true, note: 62 });
});

check("THE SHARED TRANSPORT takes its pattern length from the roll", () => {
  const scene = readAudioScene({ pr: { ...roll.defaults, audioStepCount: 12 } }, registry);
  assert.equal(transportOf(scene).stepCount, 12);
});

check("AN UNCHANGED PATTERN DIFFS TO ZERO OPS — the mirror's cheapness survives arrays", () => {
  // `===` on a freshly folded array is always false, so without a structural compare
  // the PRESENTER would issue a setParam every rAF tick, each dragging an applyOps
  // round trip behind it. Measured as the reason sameKnobValue exists.
  const items = { pr: { ...roll.defaults, notes: [[0, 60], [4, 64]] } };
  const a = readAudioScene(items, registry);
  const b = readAudioScene(structuredClone(items), registry);
  assert.notEqual(a.modules.pr.knobs.steps, b.modules.pr.knobs.steps, "two folds, two arrays");
  assert.deepEqual(diffAudioScene(a, b), [], "…and the same pattern, so nothing to send");
  // …and a REAL change still sends exactly one.
  const c = readAudioScene({ pr: { ...roll.defaults, notes: [[0, 67], [4, 64]] } }, registry);
  const ops = diffAudioScene(a, c);
  assert.deepEqual(ops.map((o) => o.op), ["setParam"]);
  assert.equal(ops[0].key, "steps");
});

check("the pattern FOLDS AND TWEENS — a phrase can differ between slides", () => {
  const doc = {
    meta: {}, slides: [
      { id: "s0", name: "1", delta: { items: { pr: { ...roll.defaults, notes: [[0, 60]] } } } },
      { id: "s1", name: "2", delta: setPath({}, ["items", "pr", "notes"], [[4, 72]]) },
    ],
  };
  assert.deepEqual(patternNotes(foldState(doc, 0).items.pr), { 0: 60 });
  assert.deepEqual(patternNotes(foldState(doc, 1).items.pr), { 4: 72 });
  // MID-TRANSITION the note walks the grid cell by cell — an all-numeric tuple takes
  // core/interpolators' pure-numeric-array branch, whose INT RULE rounds, and both
  // axes are integers by nature (there is no half-step and no quarter-tone).
  const mid = patternNotes(foldState(doc, 1, 0.5).items.pr);
  assert.deepEqual(mid, { 2: 66 });
});

check("a note PAST the last step is kept, not sounded, and not lost", () => {
  const s = { ...roll.defaults, audioStepCount: 4, notes: [[9, 72]] };
  assert.equal(sequencerSteps(s).filter((x) => x.on).length, 0);
  assert.equal(patternLength(s), 4);
  assert.deepEqual(sequencerSteps({ ...s, audioStepCount: 16 }).filter((x) => x.on).map((x) => x.note), [72],
    "…and lengthening the pattern brings it back");
});

console.log("R7-14: the spec is honest about the engine");

check("EVERY declared PIANO ROLL port and param is one the engine really has", () => {
  // tests/audio_nodes_test.js's cross-check, applied to the one spec it cannot see.
  // A description that flatters its module is how an editor invites a connection
  // that then does nothing.
  const context = fakeContext();
  const instance = MODULE_FACTORIES[PIANO_ROLL_SPEC.module](context, { stepCount: 4, steps: sequencerSteps({ audioStepCount: 4, notes: [[0, 60]] }) });
  for (const p of PIANO_ROLL_SPEC.outputs)
    assert.ok(p.key in instance.outputs, `the engine's ${PIANO_ROLL_SPEC.module} has no output ${p.key}`);
  for (const k of PIANO_ROLL_SPEC.knobs) {
    if (k.construct) continue; // built with the module, no setter by definition
    assert.ok(k.key in instance.params, `the engine's ${PIANO_ROLL_SPEC.module} has no param ${k.key}`);
  }
});

check("THE ENGINE MODULE SOUNDS THE DISTINCT PITCHES the pattern names", () => {
  // The last link, exercised rather than assumed: playStep writes the step's pitch
  // onto the module's own control value, which is the number every discrete
  // consumer reads (synth/modules.js records why the AudioParam alone was not it).
  const context = fakeContext();
  const steps = sequencerSteps({ audioStepCount: 4, notes: [[0, 60], [1, 64], [2, 67]] });
  const instance = MODULE_FACTORIES[PIANO_ROLL_SPEC.module](context, { stepCount: 4, steps });
  const heard = [];
  for (let i = 0; i < 4; i++) {
    instance.outputs.pitch.controlValue = null;
    instance.playStep(i, 0);
    heard.push(instance.outputs.pitch.controlValue);
  }
  const hz = heard.slice(0, 3).map((f) => Math.round(f));
  assert.deepEqual(hz, [262, 330, 392], "C4, E4, G4 — three DISTINCT pitches, not one");
  assert.equal(heard[3], null, "…and the rest sounds nothing at all");
});

/**
 * Query. A minimal stand-in for an AudioContext, enough for the sequencer module.
 *
 * The engine constructs real AudioNodes and bare node has no Web Audio, so the
 * one module under test here is built against the smallest surface it touches:
 * a constant source with an `offset` AudioParam-alike and a gain. This is not a
 * general fake and is deliberately not exported — tests/audio_nodes_test.js has
 * its own, sized for the modules IT sweeps.
 */
function fakeContext() {
  const param = () => ({ value: 0, setValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ connect() {}, disconnect() {}, start() {}, stop() {} });
  return {
    currentTime: 0,
    sampleRate: 48000,
    createConstantSource: () => ({ ...node(), offset: param() }),
    createGain: () => ({ ...node(), gain: param() }),
  };
}

console.log(`\nnote_latch_test: ${passed} checks passed`);
