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
  MIN_POLY_VOICES,
} from "../synth/voices.js";
import { AUDIO_SPECS, POLY_PAD_SPEC } from "../core/audio_specs.js";
import { MODULE_FACTORIES } from "../synth/modules.js";
import { PORT_TYPES } from "../core/nodeflow.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── A RECORDING STUB CONTEXT ────────────────────────────────────────────────
// The params RECORD their scheduled ramps, which is the whole trick for the
// envelope assertions at the bottom of this file: an AudioParam's `.value` does
// not reflect a linearRampToValueAtTime, so asserting on `.value` would pass no
// matter what the module scheduled.

const param = (value = 0) => ({
  value, defaultValue: value, events: [],
  setValueAtTime(v, t) { this.events.push(["set", v, t]); this.value = v; return this; },
  setTargetAtTime(v, t) { this.events.push(["target", v, t]); return this; },
  linearRampToValueAtTime(v, t) { this.events.push(["linear", v, t]); return this; },
  exponentialRampToValueAtTime(v, t) { this.events.push(["exp", v, t]); return this; },
  cancelScheduledValues(t) { this.events.push(["cancel", t]); return this; },
});
const node = (extra = {}) => ({ connect() { return this; }, disconnect() {}, ...extra });
const stubAudioContext = () => ({
  currentTime: 0, sampleRate: 48000, destination: node(),
  createGain: () => node({ gain: param(1) }),
  createOscillator: () => node({ frequency: param(440), detune: param(0), type: "sine", start() {}, stop() {} }),
  createBiquadFilter: () => node({ frequency: param(350), Q: param(1), gain: param(0), type: "lowpass" }),
  createConstantSource: () => node({ offset: param(1), start() {}, stop() {} }),
});

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

test("a spec claiming POLY names a module that really declares noteOn", () => {
  // core/live_control.noteRoutes routes a keyboard's gate by this flag alone. A
  // spec claiming polyphony the module cannot deliver would be a chord that
  // plays one note, with nothing to explain it — and the engine would throw at
  // noteOn, mid-performance.
  for (const spec of AUDIO_SPECS) {
    if (!spec.poly) continue;
    const instance = MODULE_FACTORIES[spec.module](stubAudioContext(), {}, {});
    assert.equal(typeof instance.noteOn, "function", `${spec.type} claims poly but ${spec.module} has no noteOn`);
    assert.equal(typeof instance.noteOff, "function", `${spec.type} claims poly but ${spec.module} has no noteOff`);
  }
});

test("THE VOICE-COUNT RANGE RESTATED IN core/ AGREES WITH synth/voices.js", () => {
  // core/audio_specs.js may not import synth/** (it is data, and core must run in
  // bare node), so it restates the range. This is what makes the duplication
  // checkable rather than a second opinion waiting to drift.
  const voices = POLY_PAD_SPEC.knobs.find((k) => k.key === "voices");
  assert.equal(voices.default, DEFAULT_POLY_VOICES);
  assert.equal(voices.min, MIN_POLY_VOICES);
  assert.equal(voices.max, MAX_POLY_VOICES);
});

test("the poly pad takes pitch and gate, which is what a keyboard drives", () => {
  const keys = POLY_PAD_SPEC.inputs.map((p) => p.key);
  assert.ok(keys.includes("pitch"), "a poly voice needs a note to play");
  assert.ok(keys.includes("gate"), "and an edge to play it on");
  const gate = POLY_PAD_SPEC.inputs.find((p) => p.key === "gate");
  assert.equal(gate.method, true, "a gate is engine.noteOn/noteOff, not an AudioNode connect");
});

console.log("polyphony: the module actually sounds the notes");

// Everything above is the DECISION (which slot, who is stolen). This section
// checks the other half: that the module turns a slot into an actual envelope.
// Both halves are needed, because a perfect allocator driving a module that
// never opens a gain is a silent synth with every test green.

/** Query. A fresh poly pad plus the voice gains it built, in slot order. */
function buildPolyPad(params = {}) {
  const gains = [];
  const ctx = stubAudioContext();
  const createGain = ctx.createGain;
  ctx.createGain = () => { const g = createGain(); gains.push(g); return g; };
  const instance = MODULE_FACTORIES.polyPad(ctx, params, {});
  // The voice gains are the ones whose gain STARTS AT ZERO (a silent voice); the
  // module's output gain starts at its level. Asked structurally rather than by
  // construction order, so a refactor that builds them in a different sequence
  // does not silently make this test measure the wrong node.
  return { instance, voiceGains: gains.filter((g) => g.gain.defaultValue === 1 && g.gain.value === 0) };
}

test("a poly pad builds exactly `voices` silent voices", () => {
  const { voiceGains } = buildPolyPad({ voices: 4 });
  assert.equal(voiceGains.length, 4);
  for (const g of voiceGains) assert.equal(g.gain.value, 0, "a voice must be silent until it is played");
});

test("noteOn OPENS a voice's envelope and sets its oscillators' pitch", () => {
  const { instance, voiceGains } = buildPolyPad({ voices: 2 });
  instance.noteOn(0, 440, 0);
  const ramps = voiceGains[0].gain.events.filter((e) => e[0] === "linear");
  assert.equal(ramps.length, 1, "exactly one attack ramp");
  assert.ok(ramps[0][1] > 0, `the attack must ramp UP, got ${ramps[0][1]}`);
  // …and the OTHER voice was not touched.
  assert.deepEqual(voiceGains[1].gain.events, [], "playing slot 0 must not disturb slot 1");
});

test("noteOff CLOSES that voice's envelope, ramping to zero", () => {
  const { instance, voiceGains } = buildPolyPad({ voices: 2 });
  instance.noteOn(0, 440, 0);
  instance.noteOff(0, 1);
  const last = voiceGains[0].gain.events.filter((e) => e[0] === "linear").at(-1);
  assert.equal(last[1], 0, "the release must ramp to silence");
});

test("A STOLEN VOICE IS RELEASED BEFORE THE NEW NOTE STARTS ON IT", () => {
  // The ordering the engine owns (engine.noteOn), asserted on the MODULE's own
  // events: the displaced note's release must be scheduled before the new note's
  // attack on that same voice, or the new note writes onto a voice still being
  // told to hold.
  const { instance, voiceGains } = buildPolyPad({ voices: 1 });
  instance.noteOn(0, 440, 0);
  instance.noteOff(0, 1); // what the engine does for the stolen note
  instance.noteOn(0, 660, 1); // …immediately before starting the new one
  const linears = voiceGains[0].gain.events.filter((e) => e[0] === "linear");
  assert.equal(linears.length, 3, "attack, release, attack");
  assert.equal(linears[1][1], 0, "the middle event releases the stolen note");
  assert.ok(linears[2][1] > 0, "and the new note attacks after it");
});

test("a note out of the voice range is refused LOUDLY, not silently dropped", () => {
  const { instance } = buildPolyPad({ voices: 2 });
  assert.throws(() => instance.noteOn(5, 440, 0), /no slot 5/);
  assert.throws(() => instance.noteOff(5, 0), /no slot 5/);
});

test("the pitch PORT names the note when the caller does not", () => {
  // The seam that lets a wire drive pitch (the ding's ruling, applied here).
  const { instance } = buildPolyPad({ voices: 1, pitch: 330 });
  assert.ok("pitch" in instance.inputs, "pitch must be a wireable AudioParam input");
  assert.ok("pitch" in instance.params);
  instance.noteOn(0, undefined, 0); // no caller-named frequency
  // It did not throw, and it used the port rather than a NaN — which a clamp of
  // `undefined` would have produced and then poisoned the param with forever.
  assert.equal(instance.inputs.pitch.value, 330);
});

console.log(`\n${passed} polyphony assertions passed.`);
