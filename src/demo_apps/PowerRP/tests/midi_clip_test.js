/**
 * THE MIDI CLIP MODEL, and the `midi` WIRE it travels on.
 * Run: node src/demo_apps/PowerRP/tests/midi_clip_test.js
 *
 * ── WHAT THIS IS WRITTEN AGAINST ────────────────────────────────────────────
 * Every check here corresponds to a way the clip could be silently wrong — i.e.
 * produce a plausible number, a plausible picture or a plausible sound while
 * meaning something else. The doctests in core/midi_clip.js already pin the
 * per-function arithmetic (tests/doctest_test.js executes them); this file pins
 * the things a doctest CANNOT reach:
 *
 *   1. THE WIRE. That a `midi` value actually survives `evaluateNodeGraph` from a
 *      real producer to a real consumer's input port, fans out, and reads the
 *      type's zero when unwired. A note-array flowing down a graph built for
 *      numbers is the single assumption everything else here rests on, and it is
 *      not visible from inside any one module.
 *   2. THE TYPE GATE. That `midi` connects only to `midi` — because a silent
 *      coercion to `number` would hand a synth a note count instead of a phrase.
 *   3. GROWTH WITHOUT MIGRATION. That a note element may gain a FIFTH field
 *      (channel, bend) and every stored 4-tuple still reads correctly. The
 *      coordinator's brief turns on this, and nothing else checks it.
 *   4. THE EVENT ORDER. That an off precedes an on at the same beat, which is
 *      inaudible in a test that only counts events and audible as a cut note in a
 *      real voice pool.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { evaluateNodeGraph, portZero, resolveNode, typesCompatible } from "../core/nodeflow.js";
import {
  DEFAULT_VELOCITY, MIDI_EVENT_RANK, MIDI_EVENT_TYPES, MIN_DURATION_BEATS, SNAP_DIVISIONS,
  beatAtTime, clipEvents, clipLengthBeats, clipNotes, noteRecord, noteTuple, snapBeat,
  sortedEvents, timeAtBeat, withNoteAdded, withNoteAt, withNoteRemoved,
} from "../core/midi_clip.js";
import { elementStorageKey, listSlotPaths, visibleElements } from "../core/lists.js";
import {
  PLAYBACK_REPRODUCIBLE, TRIGGER_PORT, clipPlaybackKind, isLiveSource,
  isTriggerableMidiSource, lastPulseSeconds, liveTriggeredClipRefusal, playheadBeats,
} from "../core/clip_playback.js";
import { PROPS } from "../core/properties.js";

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

const registry = createRegistry();
registerPlugins(registry);
const clipPlugin = registry.get("node_midi_clip");
const abcPlugin = registry.get("node_abc");

// ── THE DECLARATION ──────────────────────────────────────────────────────────

check("the clip is a LIST property with the four declared fields, in timeline order", () => {
  const decl = PROPS.clip;
  assert.equal(decl.kind, "list");
  assert.equal(decl.element.storage, "tuple");
  assert.deepEqual(decl.element.fields.map((f) => f.name), ["start", "duration", "pitch", "velocity"]);
  assert.equal(decl.activeKey, "clipActive");
});

check("it is a SEQUENCE, not sorted — a sorted list would renumber mid-drag", () => {
  // The whole reason core/midi_clip.js sorts on READ. If this ever becomes
  // "sorted", core/lists.canonicalOrder runs on every write and dragging a note
  // left past its neighbour renumbers both — silently rebinding every
  // `= clip.N.pitch` equation in the document.
  assert.equal(PROPS.clip.order, "sequence");
  assert.equal(PROPS.clip.orderKey, undefined);
});

check("the TUPLE storage is what keeps a clip on interpolate's plain-lerp branch", () => {
  // A record element would recurse to the per-element path. The tuple's field
  // ORDER is the storage contract every reader and writer shares.
  const el = PROPS.clip.element;
  assert.equal(elementStorageKey(el, "start"), 0);
  assert.equal(elementStorageKey(el, "duration"), 1);
  assert.equal(elementStorageKey(el, "pitch"), 2);
  assert.equal(elementStorageKey(el, "velocity"), 3);
});

check("every element field is an addressable equation slot (`= clip.0.pitch`)", () => {
  const slots = listSlotPaths(PROPS.clip, [[0, 1, 60, 100]], ["clip"]);
  const addresses = slots.map((s) => s.address);
  assert.ok(addresses.includes("clip.0.pitch"), addresses.join(", "));
  assert.ok(addresses.includes("clip.0.velocity"));
  // …and the per-element visibility flag lives in the COMPANION, not the element.
  assert.ok(addresses.includes("clipActive.0"));
});

// ── READING A CLIP ───────────────────────────────────────────────────────────

check("clipNotes rounds pitch and velocity but NOT start and duration", () => {
  // The header's measured point: a numeric tuple LERPS CONTINUOUSLY (no int rule),
  // so the rounding has to happen here. Rounding start/duration too would delete
  // every rhythm finer than a beat.
  const n = clipNotes({ clip: [[0.25, 0.125, 60.6, 99.4]] })[0];
  assert.equal(n.pitch, 61);
  assert.equal(n.velocity, 99);
  assert.equal(n.start, 0.25);
  assert.equal(n.duration, 0.125);
});

check("a hidden element is SILENT but keeps its index (hide ≠ purge)", () => {
  const s = { clip: [[0, 1, 60, 100], [1, 1, 64, 100], [2, 1, 67, 100]], clipActive: [true, false, true] };
  assert.deepEqual(clipNotes(s).map((n) => n.pitch), [60, 67]);
  // The STORED list is untouched, so `= clip.2.pitch` still names the same note.
  assert.equal(s.clip.length, 3);
  assert.deepEqual(visibleElements(PROPS.clip, { list: s.clip, active: s.clipActive }).length, 2);
});

check("an equation-bound element is not a note, and does not become one", () => {
  // An unresolved equation is a string. Emitting `{pitch: NaN}` would ask an
  // engine for a voice at NaN Hz; dropping it is the honest answer.
  assert.equal(clipNotes({ clip: [[0, 1, "= nope", 100]] }).length, 0);
  assert.equal(noteRecord([0, 1, "= nope", 100]), null);
});

check("output is in TIME order with a deterministic chord tie-break", () => {
  // Two renders of one deck must not disagree about the order a chord reached a
  // voice pool, or a full pool would steal different voices on different machines.
  const notes = clipNotes({ clip: [[2, 1, 60, 100], [0, 1, 67, 100], [0, 1, 62, 100]] });
  assert.deepEqual(notes.map((n) => [n.start, n.pitch]), [[0, 62], [0, 67], [2, 60]]);
});

check("clipLengthBeats is the last note's END, not its start", () => {
  assert.equal(clipLengthBeats([{ start: 0, duration: 8 }, { start: 2, duration: 1 }]), 8);
  assert.equal(clipLengthBeats([]), 0);
});

// ── THE EVENT STREAM ─────────────────────────────────────────────────────────

check("an OFF precedes an ON at the same beat — the voice-stealing rule", () => {
  // Every legato line ends one note as the next begins. Ons first means a full
  // pool briefly holds one note too many and steals one that was about to be
  // released — an audible cut with nothing to explain it.
  const events = clipEvents([
    { start: 0, duration: 1, pitch: 60, velocity: 100 },
    { start: 1, duration: 1, pitch: 64, velocity: 100 },
  ]);
  const atBeat1 = events.filter((e) => e.beat === 1).map((e) => e.type);
  assert.deepEqual(atBeat1, ["noteOff", "noteOn"]);
});

check("the event vocabulary has ROOM for pitch bend and CC (they are not produced yet)", () => {
  // The coordinator's constraint: the consuming worklet already implements
  // pitchBend and cc in full, so the signal type must not structurally exclude
  // them. Declared, ranked, and ordered — what is missing is only a PRODUCER.
  assert.ok(MIDI_EVENT_TYPES.includes("pitchBend"));
  assert.ok(MIDI_EVENT_TYPES.includes("cc"));
  // A controller at a note's own beat must be heard UNDER that note, not after it.
  assert.deepEqual(
    sortedEvents([{ beat: 1, type: "noteOn" }, { beat: 1, type: "pitchBend" }, { beat: 1, type: "cc" }, { beat: 1, type: "noteOff" }])
      .map((e) => e.type),
    ["noteOff", "cc", "pitchBend", "noteOn"],
  );
  assert.ok(MIDI_EVENT_RANK.noteOff < MIDI_EVENT_RANK.noteOn);
});

check("an UNKNOWN event type degrades to beat order instead of throwing", () => {
  // A stream merged from a newer producer must not take out the frame playing it.
  const out = sortedEvents([{ beat: 2, type: "whatever" }, { beat: 1, type: "noteOn" }]);
  assert.deepEqual(out.map((e) => e.beat), [1, 2]);
});

check("beats and seconds round-trip through the tempo, and a broken tempo does not divide by zero", () => {
  assert.equal(timeAtBeat(1, 120), 0.5);
  assert.equal(beatAtTime(timeAtBeat(3.5, 97), 97), 3.5);
  assert.equal(timeAtBeat(1, 0), 0.5);          // falls back to 120, never Infinity
  assert.equal(timeAtBeat(1, "= nope"), 0.5);
});

// ── THE EDITS ────────────────────────────────────────────────────────────────

check("adding a note APPENDS — inserting in time order would renumber equations", () => {
  const before = { list: [[4, 1, 60, 100]] };
  const after = withNoteAdded(before, { start: 0, duration: 1, pitch: 64, velocity: 90 });
  // The new note starts EARLIER and is still last in storage. That is the point.
  assert.deepEqual(after.list, [[4, 1, 60, 100], [0, 1, 64, 90]]);
});

check("a drag's raw pointer arithmetic is clamped at the MODEL, not in the editor", () => {
  const out = withNoteAt({ list: [[0, 1, 60, 100]] }, 0, { start: -5, duration: -5, pitch: 999, velocity: 999 });
  assert.deepEqual(out.list, [[0, MIN_DURATION_BEATS, 127, 127]]);
});

check("purging renumbers and drops the companion flag with its element", () => {
  const out = withNoteRemoved({ list: [[0, 1, 60, 100], [1, 1, 64, 100]], active: [false, true] }, 0);
  assert.deepEqual(out.list, [[1, 1, 64, 100]]);
  assert.deepEqual(out.active, [true]);
});

check("editing a clip that never hid a note does not mint an all-true companion", () => {
  // A companion written for no reason is a leaf in every future delta and diff.
  assert.equal(withNoteAdded({ list: [] }, { start: 0, duration: 1, pitch: 60, velocity: 100 }).active, undefined);
  assert.equal(withNoteAt({ list: [[0, 1, 60, 100]] }, 0, { start: 1, duration: 1, pitch: 60, velocity: 100 }).active, undefined);
});

check("snapping ROUNDS (never floors) and 0 means OFF", () => {
  // Flooring would bias every drag earlier by up to half a cell, so a note the
  // author dropped on beat 2 would land on 1.75 and disagree with the grid.
  assert.equal(snapBeat(0.8, 0.5), 1);
  assert.equal(snapBeat(0.637, 0), 0.637);
  assert.ok(SNAP_DIVISIONS.includes(0));
});

// ── GROWTH WITHOUT MIGRATION (the coordinator's constraint) ──────────────────

check("a note element may GAIN a fifth field and every stored 4-tuple still reads", () => {
  // The claim core/nodeflow.PORT_TYPES.midi and PROPS.clip both make: channel or
  // bend can be added at index 4 with no document migration, because a stored
  // 4-tuple reads `undefined` there and `noteRecord` already defaults.
  const grown = {
    ...PROPS.clip,
    element: { ...PROPS.clip.element, fields: [...PROPS.clip.element.fields, { name: "channel", kind: "number" }] },
  };
  assert.equal(elementStorageKey(grown.element, "channel"), 4);
  // The four existing fields keep their positions — a grown declaration must not
  // move them, or every stored clip in every saved document would be reinterpreted.
  for (const [i, name] of ["start", "duration", "pitch", "velocity"].entries())
    assert.equal(elementStorageKey(grown.element, name), i);
  // And a LEGACY 4-tuple still parses to exactly the note it always meant.
  assert.deepEqual(noteRecord([0, 1, 60, 100]), { start: 0, duration: 1, pitch: 60, velocity: DEFAULT_VELOCITY });
  assert.deepEqual(noteTuple({ start: 0, duration: 1, pitch: 60, velocity: 100 }), [0, 1, 60, 100]);
});

// ── THE WIRE (what no doctest can reach) ─────────────────────────────────────

// A stand-in RECEIVER with a `midi` INPUT — the shape a synth node has.
registry.register({
  type: "test_midi_sink",
  title: "Sink",
  ephemeral: "none",
  capabilities: { bbox: true },
  defaults: { type: "test_midi_sink", x: 0, y: 0, w: 100, h: 80, inputs: {} },
  ports: () => ({ inputs: [{ key: "midi", type: "midi", label: "midi" }], outputs: [] }),
  computeOutputs: () => ({}),
  emit: () => [],
  inspector: [],
});

check("a real note stream survives the graph from a CLIP node to a midi input", () => {
  const items = {
    clip1: { ...clipPlugin.defaults, clip: [[0, 1, 60, 100], [1, 0.5, 64, 90]] },
    sink1: { ...registry.get("test_midi_sink").defaults, inputs: { midi: { item: "clip1", port: "midi" } } },
  };
  const { values, cyclic } = evaluateNodeGraph(items, registry);
  assert.deepEqual(cyclic, []);
  const got = values.sink1.inputs.midi;
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { start: 0, duration: 1, pitch: 60, velocity: 100 });
  assert.deepEqual(got[1], { start: 1, duration: 0.5, pitch: 64, velocity: 90 });
});

check("…and from an ABC node, as the SAME shape — a receiver cannot tell them apart", () => {
  const items = {
    abc1: { ...abcPlugin.defaults, abc: "L:1/4\nK:C\nCEG" },
    sink1: { ...registry.get("test_midi_sink").defaults, inputs: { midi: { item: "abc1", port: "midi" } } },
  };
  const got = evaluateNodeGraph(items, registry).values.sink1.inputs.midi;
  assert.deepEqual(got.map((n) => n.pitch), [60, 64, 67]);
  // Identical record keys to the clip node's output. This is what lets one
  // instrument be driven by either producer.
  assert.deepEqual(Object.keys(got[0]).sort(), ["duration", "pitch", "start", "velocity"]);
});

check("one midi source FANS OUT to several receivers", () => {
  const items = {
    clip1: { ...clipPlugin.defaults, clip: [[0, 1, 60, 100]] },
    a: { ...registry.get("test_midi_sink").defaults, inputs: { midi: { item: "clip1", port: "midi" } } },
    b: { ...registry.get("test_midi_sink").defaults, inputs: { midi: { item: "clip1", port: "midi" } } },
  };
  const { values } = evaluateNodeGraph(items, registry);
  assert.equal(values.a.inputs.midi.length, 1);
  assert.equal(values.b.inputs.midi.length, 1);
});

check("an UNCONNECTED midi input reads the type's zero — the empty stream, never undefined", () => {
  const resolved = resolveNode({ s: { type: "test_midi_sink", inputs: {} } }, registry, "s", () => undefined);
  assert.deepEqual(resolved.inputs.midi, []);
  assert.deepEqual(portZero("midi"), []);
});

check("midi connects ONLY to midi — no silent coercion in either direction", () => {
  // A `midi -> number` coercion would have to collapse a phrase to one sample and
  // WHICH note it picked would be a hidden policy; `number -> midi` would have to
  // invent a pitch, a start and a duration out of one scalar.
  assert.equal(typesCompatible("midi", "midi"), true);
  assert.equal(typesCompatible("midi", "number"), false);
  assert.equal(typesCompatible("number", "midi"), false);
  assert.equal(typesCompatible("midi", "audio"), false);
  assert.equal(typesCompatible("audio", "midi"), false);
});

check("both MIDI widgets declare a real `midi` OUTPUT PORT (the user's signal-as-a-node ruling)", () => {
  for (const plugin of [clipPlugin, abcPlugin]) {
    const outputs = plugin.ports(plugin.defaults).outputs;
    assert.equal(outputs.length, 1, `${plugin.type} should publish exactly one output`);
    assert.equal(outputs[0].type, "midi", `${plugin.type}'s output must be a midi PORT, not a property reference`);
  }
});

check("a fresh clip node is an EMPTY stream; a fresh ABC node is a playable tune", () => {
  assert.deepEqual(clipPlugin.computeOutputs(clipPlugin.defaults).midi, []);
  const tune = abcPlugin.computeOutputs(abcPlugin.defaults).midi;
  assert.ok(tune.length > 0, "the shipped default tune must parse — it is the widget's worked example");
  assert.ok(tune.every((n) => Number.isFinite(n.pitch) && Number.isFinite(n.start)));
});

check("a widget whose activate is signal_edit declares an EDITABLE clip", () => {
  // The gate app.openSignalEditor refuses on. A plugin naming the handler and
  // forgetting the declaration would open an editor with nothing to edit.
  assert.equal(clipPlugin.activate, "signal_edit");
  assert.equal(clipPlugin.midiClip.editable, true);
  assert.equal(clipPlugin.midiClip.key, "clip");
  assert.equal(clipPlugin.midiClip.activeKey, "clipActive");
  // THE AUTOMATION LANE IS DECLARED TOO, and the import refuses to write one
  // without it — signal has full bend/CC lanes, so a widget that took its notes
  // and dropped its automation would silently discard authored work.
  assert.equal(clipPlugin.midiClip.ctrlKey, "ctrl");
  assert.equal(clipPlugin.midiClip.ctrlActiveKey, "ctrlActive");
  // The ABC node must NOT be claimed by signal: its notes are derived from text.
  assert.equal(abcPlugin.midiClip, undefined);
  assert.equal(abcPlugin.activate, "code_modal");
});

// ── WHEN THE CLIP PLAYS, AND WHETHER IT EXPORTS ─────────────────────────────
//
// The user's question ("WHEN does the signal editor start to play its song? what
// triggers it? a button node?") has an answer whose COST depends on what is
// plugged in. These checks pin the classification and the loud warning, because
// the failure they prevent is the worst one this codebase recognises: a deck that
// plays music live and exports silence with no explanation.

check("the clip node has a real `trigger` INPUT of the EXISTING trigger type", () => {
  const inputs = clipPlugin.ports(clipPlugin.defaults).inputs;
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].key, TRIGGER_PORT);
  assert.equal(inputs[0].type, "trigger", "must CONSUME the type the Button and Clock already speak");
  // …and a Button's trigger output really can reach it.
  assert.equal(typesCompatible("trigger", "trigger"), true);
});

check("NOTHING WIRED is the default, and it is the REPRODUCIBLE path", () => {
  // The off-the-shelf experience must export correctly; non-reproducibility has
  // to be asked for.
  const items = { c: { ...clipPlugin.defaults } };
  assert.equal(clipPlaybackKind(items, registry, "c"), "timeline");
  assert.equal(PLAYBACK_REPRODUCIBLE[clipPlaybackKind(items, registry, "c")], true);
  assert.equal(clipPlugin.defaults.startTime, 0, "the deterministic start is an ordinary keyframable leaf");
});

check("a CLOCK keeps the playhead a pure function of elapsed time", () => {
  const items = {
    k: { ...registry.get("audio_clock").defaults },
    c: { ...clipPlugin.defaults, inputs: { [TRIGGER_PORT]: { item: "k", port: "out" } } },
  };
  assert.equal(clipPlaybackKind(items, registry, "c"), "recordable");
  assert.equal(PLAYBACK_REPRODUCIBLE.recordable, true);
});

check("a BUTTON makes the playhead EPHEMERAL — and it is classified, not guessed", () => {
  const items = {
    b: { ...registry.get("node_button").defaults },
    c: { ...clipPlugin.defaults, inputs: { [TRIGGER_PORT]: { item: "b", port: "out" } } },
  };
  assert.equal(clipPlaybackKind(items, registry, "c"), "live");
  assert.equal(PLAYBACK_REPRODUCIBLE.live, false);
  // The classification is read off the SOURCE'S OWN DECLARATION, never a type
  // list — so a new live control is classified correctly the day it is written.
  assert.equal(isLiveSource(registry.get("node_button")), true);
  assert.equal(isLiveSource(registry.get("node_keyboard")), true);
  assert.equal(isLiveSource(registry.get("audio_clock")), false);
  assert.equal(isLiveSource(clipPlugin), false);
});

check("a live-triggered clip WARNS LOUDLY, naming the node and the way out", () => {
  const items = {
    b: { ...registry.get("node_button").defaults },
    c: { ...clipPlugin.defaults, inputs: { [TRIGGER_PORT]: { item: "b", port: "out" } } },
  };
  const warning = liveTriggeredClipRefusal(items, registry);
  assert.ok(warning, "a button-triggered clip must not export silently");
  assert.ok(warning.includes("c"), "the warning must NAME the offending node");
  assert.ok(/silent/i.test(warning), "it must say what actually happens");
  assert.ok(/Clock/.test(warning) && /Start Time|startTime|unwired|UNWIRED/i.test(warning),
    "it must point at BOTH deterministic alternatives");
});

check("…and a deck with no live trigger produces NO warning", () => {
  assert.equal(liveTriggeredClipRefusal({ c: { ...clipPlugin.defaults } }, registry), null);
  assert.equal(liveTriggeredClipRefusal({}, registry), null);
  // A CLOCK-triggered clip is reproducible, so it must not be warned about either
  // — a warning that fires on the correct arrangement teaches users to ignore it.
  const clocked = {
    k: { ...registry.get("audio_clock").defaults },
    c: { ...clipPlugin.defaults, inputs: { [TRIGGER_PORT]: { item: "k", port: "out" } } },
  };
  assert.equal(liveTriggeredClipRefusal(clocked, registry), null);
});

check("a DANGLING trigger wire is not a live one", () => {
  // Nothing ever pulses, so it behaves as an untriggered clip. Calling it live
  // would attach a determinism warning to a deck with no live control in it.
  const items = { c: { ...clipPlugin.defaults, inputs: { [TRIGGER_PORT]: { item: "gone", port: "out" } } } };
  assert.equal(clipPlaybackKind(items, registry, "c"), "timeline");
  assert.equal(liveTriggeredClipRefusal(items, registry), null);
});

check("THE CLOCK CASE NEEDS NO HISTORY — which is what makes a shard possible", () => {
  // The crux of the recordable claim: frame 200's pulse is computable without
  // frame 199 ever having been rendered. `core/document.stridedShardRefusal`
  // exists because simulated state cannot do this; a clocked clip can.
  assert.equal(lastPulseSeconds(0.7, 120), 0.5);
  assert.equal(lastPulseSeconds(1.2, 120), 1);
  // Sampled out of order, the answers are identical — the definition of seekable.
  const forwards = [0.1, 0.6, 1.1, 2.6].map((t) => lastPulseSeconds(t, 120));
  const shuffled = [2.6, 0.1, 1.1, 0.6].map((t) => lastPulseSeconds(t, 120));
  assert.deepEqual(forwards, [0, 0.5, 1, 2.5]);
  assert.deepEqual(shuffled, [2.5, 0, 1, 0.5]);
  assert.equal(lastPulseSeconds(9, 0), 0, "a stopped clock must not divide by zero");
});

check("the playhead is negative before the clip starts, rather than clamped", () => {
  // Clamping would make every clip hold its first chord from the start of the
  // presentation until its own start time.
  assert.equal(playheadBeats(1, 0, 120), 2);
  assert.equal(playheadBeats(1, 3, 120), -4);
  assert.deepEqual(clipNotes({ clip: [[0, 1, 60, 100]] }).filter((n) => -4 >= n.start && -4 < n.start + n.duration), []);
});

check("BOTH midi sources answer 'when does it play' the same way", () => {
  // USER, 2026-08-08: "how to trigger the abc notation to start playing?" — asked
  // because the clip node had a trigger input and the ABC node did not, which made
  // WHEN a phrase starts depend on HOW it was authored. It must not.
  for (const plugin of [clipPlugin, abcPlugin]) {
    const inputs = plugin.ports(plugin.defaults).inputs;
    assert.ok(inputs.some((p) => p.key === TRIGGER_PORT && p.type === "trigger"),
      `${plugin.type} must take a trigger`);
    assert.equal(plugin.defaults.startTime, 0, `${plugin.type} must have a deterministic default start`);
    assert.equal(isTriggerableMidiSource(plugin), true, `${plugin.type} must be classified as a midi source`);
  }
});

check("…AND BOTH ARE COVERED BY THE EXPORT WARNING (the hole the user found)", () => {
  // The classification used to key on `midiClip`, which only the CLIP node declares
  // — so a Button-triggered ABC node would have rendered SILENT with no warning,
  // which is precisely the failure the warning exists to prevent. Keyed on the
  // PORTS now, so every midi source with a trigger is covered.
  for (const plugin of [clipPlugin, abcPlugin]) {
    const items = {
      b: { ...registry.get("node_button").defaults },
      s: { ...plugin.defaults, inputs: { [TRIGGER_PORT]: { item: "b", port: "out" } } },
    };
    assert.equal(clipPlaybackKind(items, registry, "s"), "live", `${plugin.type} live-trigger not classified`);
    const warning = liveTriggeredClipRefusal(items, registry);
    assert.ok(warning, `${plugin.type} triggered by a button raised NO warning — it would export silent`);
    assert.ok(/silent/i.test(warning) && /Clock/.test(warning));
  }
  // A source with NO trigger input has no "when" to get wrong, so it is not one.
  assert.equal(isTriggerableMidiSource(registry.get("node_knob")), false);
});

console.log(`\nmidi_clip_test: ${passed} checks passed`);
