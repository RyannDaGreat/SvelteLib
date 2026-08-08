/**
 * THE MONITORING BRIDGE'S `io` FACADE, PINNED IN BARE NODE.
 * Run: node src/demo_apps/PowerRP/tests/signal_bridge_test.js
 *
 * ── WHAT THIS IS DEFENDING ──────────────────────────────────────────────────
 * WebSurge integrated `signal` before us with an `io` of
 * `{noteOn, noteOff, allNotesOff, setModeStatus}`, and their own manifest calls
 * what that costs "the biggest gap": signal has full pitch-bend and CC automation
 * lanes, their worklet implements both message types, and every one of those events
 * died at that boundary because the facade had no method to receive it. This suite
 * exists so that gap cannot be reintroduced here by deletion — remove `pitchBend`
 * or `cc` from the facade and a named check goes red.
 *
 * ── AND THE SECOND FAILURE, WHICH IS THE SUBTLER ONE ───────────────────────
 * The bridge reports what it could NOT deliver, because the engine facade a route
 * resolves to has `noteOn`/`noteOff`/`allNotesOff` and does not yet have
 * `pitchBend`/`cc`. A warning like that is only worth having if it is right, and
 * the first draft of `deliver` decided delivery by `t.noteOn?.(…) !== undefined` —
 * but these facade methods are COMMANDS and return `undefined` on success, so every
 * successful note reported as undelivered. The audio was perfect and the warning
 * was a lie, which is the kind that gets believed. The "…reports DELIVERED"
 * checks below are that bug, pinned.
 *
 * ── WHY IT RUNS IN BARE NODE AT ALL ────────────────────────────────────────
 * `attachSignalBridge` takes its engine lookup as a PARAMETER rather than importing
 * `web/audioMirror.moduleControlFor`. That one decision is what keeps a
 * module-level `$state` rune out of the import graph and this file runnable — see
 * the bridge's header. A fake control here is therefore the real code path, not a
 * mock of it.
 */

import assert from "node:assert";
import { attachSignalBridge, signalMonitorNote, SIGNAL_OUTPUT_MESSAGE } from "../web/signalBridge.js";

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

// ── THE HARNESS ──────────────────────────────────────────────────────────────
// `attachSignalBridge` adds a window listener, so bare node needs one. A stub
// rather than jsdom: the listener is not what is under test here (the browser probe
// covers the real message path end to end), the TRANSLATION is.
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

/** A Signal node wired to one engine module, as the folded item map. `midiRoutes`
 *  resolves the route by PORT TYPE, so the fake plugin must declare a real
 *  `audioSpec` midi input and an `audioModule` — asking the document the same
 *  question the deterministic scheduler asks. */
function wiredScene() {
  const items = {
    clip1: { type: "node_midi_clip" },
    synth1: { type: "surge", inputs: { notes: { item: "clip1", port: "midi" } } },
  };
  const registry = {
    get(type) {
      if (type === "surge") return { audioModule: true, audioSpec: { inputs: [{ key: "notes", type: "midi" }] } };
      return {};
    },
  };
  return { items, registry };
}

/**
 * An engine facade recording every call. `methods` selects which members exist —
 * which is the whole question for pitchBend/cc.
 *
 * EVERY METHOD RETURNS `undefined`, EXPLICITLY, and the braces are load-bearing.
 * The real facade methods (`synth/modules_surge.js`'s `surgeControl`) are commands
 * and return nothing, and the delivery bug this suite pins is precisely a
 * `!== undefined` test on that return. Written as the one-liner
 * `(...args) => calls.push(...)` this fake returns the array's new LENGTH — a
 * truthy number — so reintroducing the bug still measured as "delivered" and the
 * check that names it stayed green. MEASURED: with the arrow-return fake, breaking
 * `deliver` back to its first draft cost zero failures.
 */
function fakeControl(methods) {
  const calls = [];
  const control = { calls };
  for (const m of methods) control[m] = (...args) => { calls.push([m, ...args]); };
  return control;
}

/** A bridge over `wiredScene`, with `control` as the one routed instrument. */
function bridgeTo(control) {
  const { items, registry } = wiredScene();
  return attachSignalBridge({
    frame: { contentWindow: null }, items: () => items, registry,
    itemId: "clip1", controlFor: () => control,
  });
}

console.log("the signal monitoring bridge");

check("the message type is signal's own, spelled once", () => {
  assert.equal(SIGNAL_OUTPUT_MESSAGE, "signal:synth-output");
});

// ── NOTES ────────────────────────────────────────────────────────────────────

check("a note-on reaches the wired instrument, velocity intact", () => {
  const control = fakeControl(["noteOn", "noteOff", "allNotesOff"]);
  bridgeTo(control).play({ subtype: "noteOn", noteNumber: 60, velocity: 92 });
  assert.deepEqual(control.calls, [["noteOn", 60, 92]]);
});

check("A NOTE-ON AT VELOCITY 0 IS A RELEASE, on the live path too", () => {
  // Real MIDI, and signal emits them. A bridge that took it as an attack would
  // leave notes sounding forever — the worst failure a soft synth has.
  const control = fakeControl(["noteOn", "noteOff", "allNotesOff"]);
  bridgeTo(control).play({ subtype: "noteOn", noteNumber: 60, velocity: 0 });
  assert.deepEqual(control.calls, [["noteOff", 60]]);
});

check("…and reports DELIVERED, so a working note raises no warning", () => {
  // THE `deliver` BUG, PINNED (see the header): commands return undefined on
  // success, so testing the return value counts every good note as a failure.
  const control = fakeControl(["noteOn", "noteOff", "allNotesOff"]);
  const bridge = bridgeTo(control);
  bridge.play({ subtype: "noteOn", noteNumber: 60, velocity: 92 });
  assert.equal(bridge.status().undelivered, 0);
  assert.equal(bridge.status().unroutable, 0);
  assert.equal(signalMonitorNote(bridge.status()), null);
});

// ── THE HALF WEBSURGE DROPPED ────────────────────────────────────────────────

check("PITCH BEND IS A MEMBER OF THE FACADE and reaches an engine that takes it", () => {
  const control = fakeControl(["noteOn", "noteOff", "allNotesOff", "pitchBend", "cc"]);
  const bridge = bridgeTo(control);
  bridge.play({ subtype: "pitchBend", value: 12288 });
  assert.deepEqual(control.calls, [["pitchBend", 12288]]);
  assert.equal(bridge.status().undelivered, 0);
});

check("CC IS A MEMBER OF THE FACADE and carries its controller number", () => {
  const control = fakeControl(["noteOn", "noteOff", "allNotesOff", "pitchBend", "cc"]);
  const bridge = bridgeTo(control);
  bridge.play({ subtype: "controller", controllerType: 74, value: 20 });
  assert.deepEqual(control.calls, [["cc", 74, 20]]);
  assert.equal(bridge.status().undelivered, 0);
});

check("CC 120 and 123 are PANICS, not automation", () => {
  // signal sends these on stop. Forwarded as ordinary CC they would leave every
  // note sounding on an engine that does not map them.
  for (const controllerType of [120, 123]) {
    const control = fakeControl(["noteOn", "noteOff", "allNotesOff", "cc"]);
    bridgeTo(control).play({ subtype: "controller", controllerType, value: 0 });
    assert.deepEqual(control.calls, [["allNotesOff"]], `cc ${controllerType}`);
  }
});

// ── THE THREE OUTCOMES, WHICH HAVE THREE DIFFERENT FIXES ────────────────────

check("an engine WITHOUT pitchBend/cc is reported UNDELIVERED, never silently dropped", () => {
  // This is today's real engine facade (`surgeControl` takes notes only), so this
  // is the sentence a user actually sees. The events must be COUNTED — dropping
  // them in silence is precisely the integration we inherited.
  const control = fakeControl(["noteOn", "noteOff", "allNotesOff"]);
  const bridge = bridgeTo(control);
  bridge.play({ subtype: "pitchBend", value: 9000 });
  bridge.play({ subtype: "controller", controllerType: 74, value: 20 });
  assert.deepEqual(control.calls, []);
  assert.equal(bridge.status().undelivered, 2);
  assert.match(signalMonitorNote(bridge.status()), /could not be monitored/);
  // AND IT SAYS THE IMPORT IS UNAFFECTED, which is the part that stops this
  // reading as data loss: the bend is still stored and still plays from the deck.
  assert.match(signalMonitorNote(bridge.status()), /still IMPORTED/);
});

check("a clip wired to NOTHING is reported UNROUTABLE, with the fix named", () => {
  const { items, registry } = wiredScene();
  delete items.synth1;
  const bridge = attachSignalBridge({
    frame: { contentWindow: null }, items: () => items, registry,
    itemId: "clip1", controlFor: () => null,
  });
  bridge.play({ subtype: "noteOn", noteNumber: 60, velocity: 92 });
  assert.equal(bridge.status().unroutable, 1);
  assert.match(signalMonitorNote(bridge.status()), /not wired to an instrument/);
});

check("nothing to say is NULL, so a working setup shows no chrome", () => {
  assert.equal(signalMonitorNote({ notes: 0, controls: 0, undelivered: 0, unroutable: 0 }), null);
  assert.equal(signalMonitorNote(null), null);
});

check("an unknown event kind is IGNORED, not thrown into the frame", () => {
  const control = fakeControl(["noteOn", "noteOff", "allNotesOff"]);
  const bridge = bridgeTo(control);
  bridge.play({ subtype: "programChange", value: 5 });
  bridge.play(null);
  assert.deepEqual(control.calls, []);
});

// ── TEARDOWN IS A PANIC ──────────────────────────────────────────────────────

check("DETACHING PANICS every route — a dialog closed mid-playback leaves no note on", () => {
  const control = fakeControl(["noteOn", "noteOff", "allNotesOff"]);
  const bridge = bridgeTo(control);
  bridge.play({ subtype: "noteOn", noteNumber: 60, velocity: 92 });
  bridge();
  assert.deepEqual(control.calls, [["noteOn", 60, 92], ["allNotesOff"]]);
});

console.log(`\nsignal_bridge_test: ${passed} checks passed`);
