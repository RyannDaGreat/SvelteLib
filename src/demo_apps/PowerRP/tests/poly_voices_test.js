/**
 * POLYPHONY — bare-node tests for the voice allocator and the poly specs.
 * Run: node src/demo_apps/PowerRP/tests/poly_voices_test.js
 *
 * ── WHAT THIS PINS, AND WHY IT IS WORTH PINNING ─────────────────────────────
 * "Polyphonic demos are important" (user, 2026-08-03). Every failure mode of a
 * voice allocator is SILENT — a chord that plays three of its four notes, a
 * note-off that stops the wrong voice, a held key that goes dead because a later
 * note reused its slot. None of them throw; all of them are a wrong sound. Since
 * the decision is a pure function over a plain table (synth/voices.js), all of
 * them are ordinary assertions here with no AudioContext in sight.
 *
 * It also pins the CONTROL NODE ROSTER's honesty the same way
 * tests/audio_nodes_test.js pins the audio roster: a control node's declared
 * ports must be types the port table knows, and the poly module's declared knobs
 * must be params the engine really exposes.
 */

import assert from "node:assert/strict";

import {
  createVoicePool,
  nextSlot,
  slotOfNote,
  noteOn,
  noteOff,
  soundingNotes,
  allNotesOff,
  DEFAULT_POLY_VOICES,
  MAX_POLY_VOICES,
} from "../synth/voices.js";
import { POLY_PAD_SPEC } from "../core/audio_specs.js";
import { MODULE_FACTORIES } from "../synth/modules.js";
import { PORT_TYPES } from "../core/nodeflow.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("polyphony: the pool");

test("a fresh pool is N free slots", () => {
  const pool = createVoicePool(4);
  assert.equal(pool.slots.length, 4);
  assert.deepEqual(soundingNotes(pool), []);
  assert.equal(nextSlot(pool), 0);
});

test("a pool of fewer than one voice is refused loudly", () => {
  assert.throws(() => createVoicePool(0), /at least 1/);
  assert.throws(() => createVoicePool(NaN), /at least 1/);
});

console.log("polyphony: allocation");

test("N simultaneous notes allocate N DISTINCT voices", () => {
  // THE HEADLINE ASSERTION of the whole workstream: a four-note chord on a
  // four-voice pool is four voices, none stolen.
  let pool = createVoicePool(4);
  const slots = [];
  for (const note of [60, 64, 67, 71]) {
    const r = noteOn(pool, note);
    assert.equal(r.stolen, null, `note ${note} should not have had to steal`);
    slots.push(r.slot);
    pool = r.pool;
  }
  assert.deepEqual(slots, [0, 1, 2, 3]);
  assert.deepEqual(soundingNotes(pool), [60, 64, 67, 71]);
});

test("the N+1th note STEALS THE OLDEST and reports which note it stopped", () => {
  let pool = createVoicePool(3);
  for (const note of [60, 64, 67]) pool = noteOn(pool, note).pool;
  const r = noteOn(pool, 72);
  assert.equal(r.stolen, 60, "the oldest sounding note is the one displaced");
  assert.equal(r.slot, 0, "and the new note takes its slot");
  assert.deepEqual(soundingNotes(r.pool), [72, 64, 67]);
});

test("stealing walks FORWARD: successive over-allocations take successive oldest", () => {
  let pool = createVoicePool(2);
  pool = noteOn(pool, 60).pool;
  pool = noteOn(pool, 64).pool;
  const a = noteOn(pool, 67);
  assert.equal(a.stolen, 60);
  const b = noteOn(a.pool, 71);
  assert.equal(b.stolen, 64, "64 is now the oldest, not 67 which was just played");
  assert.deepEqual(soundingNotes(b.pool), [67, 71]);
});

test("re-pressing a sounding note reuses ITS OWN slot and steals nothing", () => {
  // Two voices on one pitch is a 6 dB doubling that leaves an orphan on the
  // first note-off, and it burns a slot the rest of the chord needs.
  let pool = createVoicePool(4);
  pool = noteOn(pool, 60).pool;
  pool = noteOn(pool, 64).pool;
  const r = noteOn(pool, 60);
  assert.equal(r.retrigger, true);
  assert.equal(r.slot, 0);
  assert.equal(r.stolen, null);
  assert.deepEqual(soundingNotes(r.pool), [60, 64]);
});

test("a retrigger refreshes age, so the OTHER note becomes the steal candidate", () => {
  let pool = createVoicePool(2);
  pool = noteOn(pool, 60).pool; // oldest
  pool = noteOn(pool, 64).pool;
  pool = noteOn(pool, 60).pool; // retrigger — 60 goes to the back of the queue
  assert.equal(noteOn(pool, 67).stolen, 64);
});

console.log("polyphony: release");

test("note-off releases that note's slot", () => {
  const on = noteOn(createVoicePool(3), 60);
  const off = noteOff(on.pool, 60);
  assert.equal(off.slot, 0);
  assert.deepEqual(soundingNotes(off.pool), []);
});

test("a note-off for a note that is not sounding is a no-op, not an error", () => {
  const r = noteOff(createVoicePool(3), 60);
  assert.equal(r.slot, null);
  assert.deepEqual(soundingNotes(r.pool), []);
});

test("A STOLEN NOTE'S LATE NOTE-OFF DOES NOT SILENCE THE THIEF", () => {
  // The classic poly bug. 60 is held, 67 steals its only voice, then the user
  // lifts the 60 key. If note-off went by SLOT rather than by identity, 67
  // would go silent while its key is still down.
  let pool = createVoicePool(1);
  pool = noteOn(pool, 60).pool;
  pool = noteOn(pool, 67).pool; // steals 60
  const late = noteOff(pool, 60);
  assert.equal(late.slot, null, "60 is not sounding anywhere — nothing to stop");
  assert.deepEqual(soundingNotes(late.pool), [67], "67 keeps playing");
});

test("a freed slot is reused before any voice is stolen", () => {
  let pool = createVoicePool(2);
  pool = noteOn(pool, 60).pool;
  pool = noteOn(pool, 64).pool;
  pool = noteOff(pool, 60).pool;
  const r = noteOn(pool, 67);
  assert.equal(r.stolen, null);
  assert.equal(r.slot, 0);
});

test("allNotesOff reports every slot it silenced", () => {
  let pool = createVoicePool(4);
  for (const note of [60, 64, 67]) pool = noteOn(pool, note).pool;
  const r = allNotesOff(pool);
  assert.deepEqual(r.slots, [0, 1, 2], "the caller needs these to stop the voices");
  assert.deepEqual(soundingNotes(r.pool), []);
});

console.log("polyphony: purity");

test("the pool is never mutated — every call returns a new one", () => {
  const pool = createVoicePool(2);
  const after = noteOn(pool, 60);
  assert.deepEqual(soundingNotes(pool), [], "the original pool is untouched");
  assert.deepEqual(soundingNotes(after.pool), [60]);
  assert.notEqual(pool.slots, after.pool.slots);
});

test("slotOfNote answers -1 for an absent note", () => {
  assert.equal(slotOfNote(createVoicePool(2), 60), -1);
  assert.equal(slotOfNote(noteOn(createVoicePool(2), 60).pool, 60), 0);
});

console.log("polyphony: the poly pad module");

test("POLY_PAD_SPEC declares a module the engine really has", () => {
  assert.ok(MODULE_FACTORIES[POLY_PAD_SPEC.module], `engine has no ${POLY_PAD_SPEC.module} factory`);
});

test("POLY_PAD_SPEC's ports are declared types with a legal `voices` range", () => {
  for (const p of [...POLY_PAD_SPEC.inputs, ...POLY_PAD_SPEC.outputs]) {
    assert.ok(PORT_TYPES[p.type], `poly pad port ${p.key} declares unknown type ${p.type}`);
  }
  const voices = POLY_PAD_SPEC.knobs.find((k) => k.key === "voices");
  assert.ok(voices, "the voice count must be a declared knob — it is the polyphony's one dial");
  assert.equal(voices.default, DEFAULT_POLY_VOICES);
  assert.equal(voices.max, MAX_POLY_VOICES);
  assert.equal(voices.construct, true, "voices are built eagerly, so changing the count rebuilds");
});

test("the poly pad takes pitch and gate, which is what a keyboard drives", () => {
  const keys = POLY_PAD_SPEC.inputs.map((p) => p.key);
  assert.ok(keys.includes("pitch"), "a poly voice needs a note to play");
  assert.ok(keys.includes("gate"), "and an edge to play it on");
  const gate = POLY_PAD_SPEC.inputs.find((p) => p.key === "gate");
  assert.equal(gate.method, true, "a gate is engine.noteOn/noteOff, not an AudioNode connect");
});

console.log(`\n${passed} polyphony assertions passed.`);
