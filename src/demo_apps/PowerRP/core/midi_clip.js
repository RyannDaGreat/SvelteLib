/**
 * THE MIDI CLIP — the note stream's data model, and the rules for reading one.
 *
 * ── THE ASK (user, 2026-08-08, verbatim) ────────────────────────────────────
 * "can we make it a widget, that has an audio output (be compat with other nodes)
 * and a midi-in input node along with the signal midi output nodes and abc
 * language output midi nodes, all of which bring up full fledged UI's in giant
 * modals when duoble clicked (imitating the website with the giant piano for surge
 * and a fullscreen midi piano roll editor ported over)"
 *
 * ── A CLIP IS PROPERTY STATE, AND THAT IS FORCED RATHER THAN CHOSEN ─────────
 * CLAUDE.md's four-kinds-of-state law leaves exactly one place to put this. The
 * hardware reading of "MIDI" — bytes arriving from a device as a hand plays it —
 * is EPHEMERAL state ("a widget that reads a host input … inside emit() or a paint
 * path introduces it"), which this project has none of and exists to avoid: a deck
 * containing one could not be exported, re-rendered identically, or sharded. So the
 * thing that travels down a `midi` wire is the AUTHORED CLIP, which is ordinary
 * document state — folded from `[[slide, alpha]]`, keyframable per slide, tweenable
 * across a transition, saved, and byte-identical on every machine.
 *
 * PLAYBACK is then RECORDABLE state, at exactly one seam: a receiver asks
 * `clipEvents` which notes start and stop at which BEAT, and the presentation clock
 * says which beat it is. Frame 200 needs no frame 199, so a render job may still
 * shard by strided frame range. Nothing here reads a clock — the beat is always an
 * argument.
 *
 * A LIVE MIDI KEYBOARD is not refused, it is routed elsewhere: it drives a
 * PERFORMANCE through core/live_control.js exactly as a key press does, and reaches
 * no render or export path. That is the same boundary a Keyboard widget's press
 * already sits on, and it is why a press and a clip can coexist without either
 * weakening the other.
 *
 * ── THE STORAGE, AND WHY IT IS A LIST PROPERTY ──────────────────────────────
 * `clip` is an ordinary LIST property (core/lists.js), which is not a convenience
 * — it is the whole reason a clip needs no new machinery. From that one declaration
 * a clip inherits: per-element equations (`= clip.3.pitch` is a slot), insert
 * between two notes, hide-vs-purge (a HIDDEN note is a note that does not sound,
 * with its index and therefore its equations preserved), an Inspector control, a
 * keyframe per leaf, and a delta that folds. `core/properties.js PROPS.clip` is the
 * declaration; this module is what READS it.
 *
 * ── THE ELEMENT: A TUPLE `[start, duration, pitch, velocity]` ───────────────
 * TUPLE for the reason `points` and `frames` are tuples, and the reason is
 * MEASURED rather than stylistic: `core/interpolators.js interpolate()` sends an
 * all-numeric array down its "pure-numeric-array" branch, which is a PLAIN LERP.
 * A RECORD would recurse to the per-element path instead.
 *
 * **AND THE PLAIN-LERP BRANCH DOES NOT ROUND** — interpolators.js:146 says so in
 * as many words ("NO int-rounding"). This is worth stating loudly because two
 * neighbouring declarations in core/properties.js (`heldNotes`, `notes`) claim the
 * opposite — that a numeric tuple's fields are rounded by "the tweenline INT RULE".
 * They are not; the int rule is on the SCALAR path. Nothing depends on that
 * mistake today (both of those consumers round on read, as this one does), but a
 * future reader must not design against it. So: A CLIP TWEENS CONTINUOUSLY, and
 * `clipNotes` ROUNDS pitch and velocity ITSELF, here, where the rounding can be
 * seen. A clip halfway through a transition therefore lands on real notes at real
 * velocities rather than on quarter-tones — by this function, not by luck.
 *
 * START AND DURATION ARE NOT ROUNDED, deliberately: they are BEATS, and an eighth
 * note is 0.5 of one. Rounding them would delete every rhythm finer than a beat.
 *
 * ── THE UNIT IS THE BEAT, NOT THE SECOND ───────────────────────────────────
 * A clip states musical time; a TEMPO turns it into seconds (`timeAtBeat`). Two
 * consequences that are the point of the choice: re-tempoing a deck is ONE property
 * edit rather than a rewrite of every note, and a clip authored from ABC — where
 * durations are fractions of a unit note length — needs no conversion to be stored.
 *
 * ── ORDER IS "sequence", AND SORTING WOULD HAVE BEEN A TRAP ─────────────────
 * The obvious reading is "sorted by start". It is refused. A sorted list
 * CANONICALIZES ON EVERY WRITE (core/lists.js), so dragging a note left past its
 * neighbour would RENUMBER both — mid-gesture, while the pointer is holding index
 * 3 — and every equation bound to a later note would come to mean a different note.
 * The order a clip is stored in carries no information, so nothing is lost by
 * leaving it alone; every consumer that needs time order gets it from `clipNotes`,
 * which sorts a COPY on read. Authoring order in, musical order out.
 *
 * DOM-free, engine-free, clock-free: core/ runs in bare node.
 */

import { BLACK_SEMITONES, SEMITONES_PER_OCTAVE } from "./keyboard_layout.js";
import { elementActive } from "./lists.js";

/** The MIDI note range, and the velocity range. Both are the protocol's, not
 *  ours — a "note 200" is not a note, and a clip that stored one would ask an
 *  engine for a voice it cannot allocate. `clipNotes` clamps rather than drops,
 *  because a note pushed out of range by a tween or an equation should come back
 *  when the tween returns rather than vanish from the list's numbering. */
export const MIDI_NOTE_MIN = 0;
export const MIDI_NOTE_MAX = 127;
export const VELOCITY_MIN = 1;
export const VELOCITY_MAX = 127;

/** The velocity a freshly drawn note is born at. 100 rather than 127 so that
 *  "louder" remains expressible after the first note is placed — a default at the
 *  ceiling makes half the control's range unreachable by accident. */
export const DEFAULT_VELOCITY = 100;

/** The shortest note the model will store, in beats. NOT a musical limit (a
 *  128th note is 1/32 of a beat and is perfectly legal); it is the floor below
 *  which a note has no ON-to-OFF interval at all, so an engine would receive a
 *  note-off at the same instant as its note-on and sound nothing. A zero-length
 *  note is a clip's equivalent of a zero-length gradient wrap: legal to
 *  ARRIVE at, never legal to CREATE. */
export const MIN_DURATION_BEATS = 1 / 128;

/**
 * Pure function. ONE note record from a stored tuple, normalized — or null when
 * the tuple does not describe a note at all.
 *
 * WHAT MAKES A TUPLE NOT A NOTE: a non-finite start, duration or pitch. Those
 * arrive from an unresolved equation (`= nope` evaluates to a string) or a
 * malformed hand edit, and the honest answer is that there is no note there — a
 * receiver handed `{pitch: NaN}` would ask the engine for a voice at NaN Hz.
 * A non-finite VELOCITY is NOT disqualifying: velocity has a default that means
 * something ("as loud as a fresh note"), where pitch and time have none.
 *
 * NEGATIVE START is CLAMPED to 0 rather than refused. A tween or a keyframe can
 * legitimately carry a note off the front of the clip, and clamping keeps it
 * audible at the top of the bar while the tween passes; refusing would make notes
 * blink out of the picture mid-transition.
 *
 * @param {Array} tuple - a stored `[start, duration, pitch, velocity]`
 * @returns {{start: number, duration: number, pitch: number, velocity: number}|null}
 *
 * @example noteRecord([0, 1, 60, 100]) // {start: 0, duration: 1, pitch: 60, velocity: 100}
 * @example // pitch and velocity ROUND (a tween lerps them continuously — see the header)
 * @example noteRecord([0, 1, 60.6, 99.4]) // {start: 0, duration: 1, pitch: 61, velocity: 99}
 * @example // …but start and duration do NOT: an eighth note is half a beat
 * @example noteRecord([0.5, 0.25, 60, 100]).duration // 0.25
 * @example // a missing velocity is the default, not a failure
 * @example noteRecord([0, 1, 60]).velocity // 100
 * @example // out of range is CLAMPED, so a note returns when its tween does
 * @example noteRecord([0, 1, 999, 100]).pitch // 127
 * @example noteRecord([-3, 1, 60, 100]).start // 0
 * @example // a zero or negative duration is floored to the shortest storable note
 * @example noteRecord([0, 0, 60, 100]).duration // 0.0078125
 * @example // an unresolved equation is not a note
 * @example noteRecord([0, 1, "= nope", 100]) // null
 * @example noteRecord([]) // null
 */
export function noteRecord(tuple) {
  const raw = Array.isArray(tuple) ? tuple : [];
  const start = Number(raw[0]);
  const duration = Number(raw[1]);
  const pitch = Number(raw[2]);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || !Number.isFinite(pitch)) return null;
  const velocity = Number(raw[3]);
  return {
    start: Math.max(0, start),
    duration: Math.max(MIN_DURATION_BEATS, duration),
    pitch: clampInt(pitch, MIDI_NOTE_MIN, MIDI_NOTE_MAX),
    velocity: Number.isFinite(velocity) ? clampInt(velocity, VELOCITY_MIN, VELOCITY_MAX) : DEFAULT_VELOCITY,
  };
}

/** Pure function. Rounded and clamped — the one place both integral fields are
 *  brought back inside their protocol range.
 *  @example clampInt(60.6, 0, 127) // 61
 *  @example clampInt(-5, 0, 127) // 0 */
export function clampInt(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Pure function. THE CLIP a widget's state holds: its VISIBLE notes, normalized,
 * IN TIME ORDER.
 *
 * This is the value that travels down a `midi` wire — the array of
 * `{pitch, start, duration, velocity}` records `core/nodeflow.PORT_TYPES.midi`
 * declares. Every producer in the app answers this shape (the clip widget reads
 * its list, the ABC widget parses its text), so a receiver never asks where the
 * notes came from.
 *
 * HIDDEN ELEMENTS ARE SILENT, AND THAT IS THE PER-FLAVOUR READING core/lists.js
 * asks each consumer to state. A note carries its own start, so removing one from
 * the picture leaves every other note exactly where it was — the gap it leaves is
 * a rest. (Contrast a POLYGON, where hiding a vertex closes the chain over it.)
 * Its index survives, so `= clip.3.pitch` still names the same note.
 *
 * SORTED BY START, THEN BY PITCH — on a COPY, never in the document (see the
 * header on why the stored order is left alone). The pitch tie-break is what makes
 * the output DETERMINISTIC for a chord: three notes at beat 0 come out low-to-high
 * every time, on every machine, so two renders of one deck cannot disagree about
 * the order they were sent to a voice pool.
 *
 * @param {object} s - the folded item state
 * @param {string} [key] - which list leaf holds the clip (default "clip")
 * @returns {Array<{start: number, duration: number, pitch: number, velocity: number}>}
 *
 * @example clipNotes({clip: [[0, 1, 60, 100]]}) // [{start: 0, duration: 1, pitch: 60, velocity: 100}]
 * @example // an unauthored widget holds the EMPTY stream, which is the type's zero
 * @example clipNotes({}) // []
 * @example // TIME ORDER out, whatever order the list was authored in
 * @example clipNotes({clip: [[2, 1, 67, 100], [0, 1, 60, 100]]}).map((n) => n.start) // [0, 2]
 * @example // a chord ties on start and breaks LOW TO HIGH, deterministically
 * @example clipNotes({clip: [[0, 1, 67, 100], [0, 1, 60, 100]]}).map((n) => n.pitch) // [60, 67]
 * @example // a HIDDEN note is a rest: silent, still stored, still numbered
 * @example clipNotes({clip: [[0, 1, 60, 100], [1, 1, 64, 100]], clipActive: [true, false]}).length // 1
 * @example // a malformed element is not a note and does not become one
 * @example clipNotes({clip: [[0, 1, "= nope", 100], [0, 1, 60, 100]]}).length // 1
 */
export function clipNotes(s, key = "clip") {
  const list = Array.isArray(s?.[key]) ? s[key] : [];
  const active = s?.[`${key}Active`];
  const notes = [];
  for (let i = 0; i < list.length; i++) {
    if (!elementActive(active, i)) continue;
    const note = noteRecord(list[i]);
    if (note) notes.push(note);
  }
  return sortedNotes(notes);
}

/**
 * Pure function. Note records in TIME ORDER — start ascending, pitch ascending on
 * a tie. Exported so a producer that never had a list (the ABC widget) sorts by
 * the SAME rule the list-backed one does, rather than by a second copy of it.
 *
 * Sorts a COPY; the input is untouched.
 *
 * @param {Array<object>} notes - note records
 * @returns {Array<object>} a new array
 *
 * @example sortedNotes([{start: 1, pitch: 60}, {start: 0, pitch: 64}]).map((n) => n.start) // [0, 1]
 * @example sortedNotes([{start: 0, pitch: 67}, {start: 0, pitch: 60}]).map((n) => n.pitch) // [60, 67]
 */
export function sortedNotes(notes) {
  return [...notes].sort((a, b) => (a.start === b.start ? a.pitch - b.pitch : a.start - b.start));
}

/**
 * Pure function. THE CLIP'S LENGTH in beats — where its last note ENDS.
 *
 * The END, not the last note's start: a whole note on beat 3 makes the clip four
 * beats long, and a loop that restarted at 3 would cut it. An EMPTY clip is 0
 * beats, which is the honest answer and is what stops a receiver dividing by it.
 *
 * @param {Array<object>} notes - note records (any order)
 * @returns {number} beats
 *
 * @example clipLengthBeats([{start: 0, duration: 1}, {start: 2, duration: 1}]) // 3
 * @example // the LONGEST note decides, not the LAST one to start
 * @example clipLengthBeats([{start: 0, duration: 8}, {start: 2, duration: 1}]) // 8
 * @example clipLengthBeats([]) // 0
 */
export function clipLengthBeats(notes) {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.start + n.duration);
  return end;
}

/**
 * THE EVENT VOCABULARY a `midi` wire's playback seam speaks, and the RANK that
 * orders two events landing on the same beat.
 *
 * ── IT IS WIDER THAN WHAT WE PRODUCE TODAY, DELIBERATELY ───────────────────
 * `clipEvents` emits only `noteOn` and `noteOff`. The other two are declared
 * anyway, because the CONSUMING end is already richer than a note-only stream: the
 * Surge worklet's message handler implements `pitchBend {channel, value}` and
 * `cc {channel, cc, value}` in full, and nothing upstream has ever sent them. A
 * vocabulary that structurally excluded them would have to be widened later, and
 * widening a signal TYPE is the migration this declaration exists to avoid.
 *
 * SO THE BOUNDARY IS EXPLICIT, NOT A HOLE: the vocabulary has room, the ordering
 * rule below already covers all four, and what is missing is the PRODUCER — a
 * bend/CC lane, which writes a second list property beside `clip` and hands it to
 * this same function. **THAT LANE NOW EXISTS** — see the control-lane section
 * below; the producer is the `signal` importer (core/signal_song.js), because
 * signal has full automation lanes and dropping them would discard authored work.
 * Nothing about the wire, the port type or the clip's storage changed when it
 * landed, exactly as this paragraph predicted.
 *
 * ── THE RANK, AND WHY EACH POSITION IS FORCED ──────────────────────────────
 *   noteOff (0)   before everything, and this is the rule
 *                 `core/live_control.latchedChordDelta` already states for the
 *                 identical reason: a voice pool is FINITE and steals the OLDEST
 *                 voice when it runs out. Every legato line ever written ends one
 *                 note exactly as the next begins. Send the on first and the pool
 *                 briefly holds one more note than the clip asks for, so on a full
 *                 pool it steals a voice that was about to be released — cutting a
 *                 note that should still be sounding.
 *   cc (1),
 *   pitchBend (2) before the note they shape. A bend or a filter sweep written at
 *                 the same beat as a note-on is describing THAT note's attack;
 *                 arriving after it would bend the note audibly late, by one
 *                 event, every time.
 *   noteOn (3)    last, so it is heard under the controller state the author
 *                 wrote for it.
 *
 * @example MIDI_EVENT_TYPES.includes("pitchBend") // true
 * @example MIDI_EVENT_RANK.noteOff // 0
 * @example MIDI_EVENT_RANK.noteOn // 3
 */
export const MIDI_EVENT_RANK = Object.freeze({ noteOff: 0, cc: 1, pitchBend: 2, noteOn: 3 });
export const MIDI_EVENT_TYPES = Object.freeze(Object.keys(MIDI_EVENT_RANK));

/**
 * ── WHY NO `channel` FIELD, STATED RATHER THAN OMITTED ─────────────────────
 * The receiving facade hardcodes channel 0, so a channel emitted here would be a
 * field nobody reads — and the wire ALREADY answers the question a channel exists
 * to answer. One wire is one instrument; sending two parts to two synths is two
 * wires, which the graph expresses natively and visibly. A channel would be a
 * SECOND routing mechanism running underneath the first, invisible on the canvas,
 * and the two could disagree.
 *
 * IF MULTI-TIMBRAL ROUTING IS EVER WANTED the answer is already shaped and costs
 * no migration: `channel` becomes a fifth field on the note element (core/lists.js
 * appends it at index 4, and every stored 4-tuple reads `undefined` there, which
 * `noteRecord` already defaults) plus a receiver that reads it. That is the same
 * growth path pitch bend and CC have, and `tests/midi_clip_test.js` pins it by
 * round-tripping a grown element.
 */

/**
 * Pure function. THE EVENT STREAM — the seam that turns a clip (property state)
 * into playback (recordable state).
 *
 * NOTHING HERE READS A CLOCK. The beat is the caller's, which is what keeps this
 * pure, keeps a still render correct with no changes, and keeps a strided shard
 * able to compute its own frame.
 *
 * CONTROLS ARE THE SECOND ARGUMENT AND ARE OPTIONAL, so every existing caller is
 * byte-identical: a clip with no lane produces exactly the note stream it always
 * did. When a lane IS present its events are MERGED into the same sorted stream
 * rather than returned separately, which is the point — `MIDI_EVENT_RANK` exists
 * to decide what happens when a bend and a note land on the same beat, and a
 * caller handed two lists would have to re-implement that decision to interleave
 * them, which is exactly how two producers come to disagree.
 *
 * @param {Array<object>} notes - note records
 * @param {Array<object>} [controls] - control records (`clipControls`)
 * @returns {Array<object>} `{beat, type, …}` in SEND ORDER
 *
 * @example clipEvents([{start: 0, duration: 1, pitch: 60, velocity: 100}]).map((e) => e.type) // ["noteOn", "noteOff"]
 * @example clipEvents([{start: 0, duration: 1, pitch: 60, velocity: 100}])[1].beat // 1
 * @example // TWO LEGATO NOTES: the off at beat 1 precedes the on at beat 1
 * @example clipEvents([{start: 0, duration: 1, pitch: 60, velocity: 100}, {start: 1, duration: 1, pitch: 64, velocity: 100}]).map((e) => e.type) // ["noteOn", "noteOff", "noteOn", "noteOff"]
 * @example clipEvents([]) // []
 * @example // A BEND AT A NOTE'S OWN BEAT IS HEARD UNDER IT, by MIDI_EVENT_RANK
 * @example clipEvents([{start: 0, duration: 1, pitch: 60, velocity: 100}], [{start: 0, controller: -1, value: 9000}]).map((e) => e.type) // ["pitchBend", "noteOn", "noteOff"]
 * @example // a CC becomes a cc event carrying its controller NUMBER, not the sentinel
 * @example clipEvents([], [{start: 0, controller: 74, value: 20}])[0] // {beat: 0, type: "cc", cc: 74, value: 20}
 * @example clipEvents([], [{start: 1, controller: -1, value: 0}])[0] // {beat: 1, type: "pitchBend", value: 0}
 */
export function clipEvents(notes, controls = []) {
  const events = [];
  for (const n of notes) {
    events.push({ beat: n.start, type: "noteOn", pitch: n.pitch, velocity: n.velocity });
    events.push({ beat: n.start + n.duration, type: "noteOff", pitch: n.pitch, velocity: n.velocity });
  }
  for (const c of controls) {
    events.push(c.controller === BEND_CONTROLLER
      ? { beat: c.start, type: "pitchBend", value: c.value }
      : { beat: c.start, type: "cc", cc: c.controller, value: c.value });
  }
  return sortedEvents(events);
}

/**
 * Pure function. Events in SEND ORDER — by beat, then by `MIDI_EVENT_RANK`.
 *
 * Exported and separate from `clipEvents` because it is the rule a FUTURE
 * producer (a bend lane, a live facade merging two wires) must also obey, and a
 * second copy of the rank comparison is exactly how two producers would come to
 * disagree about whether a bend precedes its note.
 *
 * Sorts a COPY. An unknown `type` sorts LAST rather than throwing — a stream
 * merged from a newer producer must degrade to "in beat order" rather than take
 * out the frame that is playing it.
 *
 * @param {Array<object>} events - midi events
 * @returns {Array<object>} a new array
 *
 * @example sortedEvents([{beat: 0, type: "noteOn"}, {beat: 0, type: "noteOff"}]).map((e) => e.type) // ["noteOff", "noteOn"]
 * @example // a bend at the same beat is heard UNDER the note it shapes
 * @example sortedEvents([{beat: 1, type: "noteOn"}, {beat: 1, type: "pitchBend"}]).map((e) => e.type) // ["pitchBend", "noteOn"]
 * @example sortedEvents([{beat: 2, type: "noteOn"}, {beat: 1, type: "noteOff"}]).map((e) => e.beat) // [1, 2]
 */
export function sortedEvents(events) {
  const rank = (e) => MIDI_EVENT_RANK[e.type] ?? Number.MAX_SAFE_INTEGER;
  return [...events].sort((a, b) => (a.beat === b.beat ? rank(a) - rank(b) : a.beat - b.beat));
}

// ── THE CONTROL LANE: pitch bend and CC (the half that had no producer) ──────
//
// `MIDI_EVENT_RANK` above has declared `cc` and `pitchBend` since the vocabulary
// was written, and the receiving end has implemented both since before that
// (`synth/modules_surge.js` posts `{type:"pitchBend", channel, value}` and
// `{type:"cc", channel, cc, value}` to the worklet). What was missing was a
// PRODUCER, and CLAUDE.md named its shape exactly: "a second list property beside
// `clip`", handed to the same `clipEvents`. This is it.
//
// ── WHY IT ARRIVED NOW, AND NOT AS A DRAWN LANE ────────────────────────────
// The editor is ryohey's `signal`, which HAS full automation lanes. So the notes
// are no longer the only thing an author can draw, and a converter that read the
// song's notes and dropped its bends would silently discard authored work. That
// is the exact gap WebSurge's own manifest calls "the biggest" in their
// integration (§14.1, "Dropped: pitch bend, CC lanes …"), and importing their
// note-only boundary would have been shipping a known hole forward.
//
// ── THE UNITS ARE MIDI'S OWN, AND THAT IS THE WHOLE ARGUMENT ───────────────
// `value` is RAW: 0..127 for a CC, 0..16383 for a bend with 8192 as centre. Not a
// normalized 0..1 fraction, which was considered and refused. Both ENDS of this
// pipe already speak raw MIDI — signal stores a bend as 0..16383 and a controller
// as 0..127, and the worklet's message handler takes exactly those — so a
// normalized middle would be a unit conversion on the way IN and its inverse on
// the way OUT, i.e. two roundings and two places to be wrong, in exchange for
// nothing a reader of the list can see. A stored 8192 IS a centred bend, in the
// document, in the Inspector and on the wire.
//
// (`synth/modules_surge.js`'s `bend14bit`/`cc7bit` convert from a -1..1 / 0..1
// KNOB, which is a different question — a knob is a human control with its own
// natural range. A stored MIDI event is not a knob.)

/** The `controller` field's value for a PITCH BEND, as opposed to a CC number.
 *
 *  A SENTINEL RATHER THAN A SECOND LIST, and it is available for a structural
 *  reason rather than a convenient one: CC numbers are 0..127 BY THE PROTOCOL, so
 *  no negative can ever collide with one. Keeping both in one list keeps the
 *  element an ALL-NUMERIC TUPLE (the plain-lerp branch — see the header) and keeps
 *  "the controller automation at beat 3" one thing an author can find, rather than
 *  two lists that must be read together to know what happens there.
 *  @example BEND_CONTROLLER // -1 */
export const BEND_CONTROLLER = -1;

/** The inclusive range of a CC number, and of each event kind's `value`. MIDI's,
 *  not ours.
 *  @example CC_MAX // 127
 *  @example BEND_MAX // 16383
 *  @example BEND_CENTER // 8192 */
export const CC_MIN = 0;
export const CC_MAX = 127;
export const BEND_MIN = 0;
export const BEND_MAX = 16383;
export const BEND_CENTER = 8192;

/**
 * Pure function. ONE control-event record from a stored tuple, normalized — or
 * null when the tuple does not describe a control event at all.
 *
 * `[start, controller, value]`. `controller` is `BEND_CONTROLLER` (-1) for a pitch
 * bend or a CC number 0..127; `value` is in that controller's OWN raw MIDI range
 * (see the section header on why it is not normalized).
 *
 * ROUNDS `controller` AND `value`, and does NOT round `start` — the same split
 * `noteRecord` makes and for the same reasons: a controller number and a MIDI data
 * byte are integers, a beat is not. A CONSEQUENCE WORTH STATING because a tween
 * can reach it: `controller` lerping across -0.5 rounds to 0 and the event becomes
 * CC 0 (Bank Select) for one frame. That is the identical hazard `pitch` already
 * carries when a tween drags it across a semitone, it is inherent to lerping a
 * discriminator, and the answer is the same — keyframe the lane, do not tween
 * BETWEEN a bend and a CC.
 *
 * @param {Array} tuple - a stored `[start, controller, value]`
 * @returns {{start: number, controller: number, value: number}|null}
 *
 * @example ctrlRecord([0, 1, 64]) // {start: 0, controller: 1, value: 64}
 * @example // a BEND is the -1 sentinel, and its value spans 14 bits
 * @example ctrlRecord([2, -1, 16383]) // {start: 2, controller: -1, value: 16383}
 * @example // each kind is clamped to ITS OWN range, not to a shared one
 * @example ctrlRecord([0, 1, 9999]).value // 127
 * @example ctrlRecord([0, -1, 99999]).value // 16383
 * @example // an unresolved equation is not an event
 * @example ctrlRecord([0, 1, "= nope"]) // null
 * @example ctrlRecord([]) // null
 * @example // a controller below the bend sentinel is not a controller
 * @example ctrlRecord([0, -7, 64]) // null
 */
export function ctrlRecord(tuple) {
  const raw = Array.isArray(tuple) ? tuple : [];
  const start = Number(raw[0]);
  const controller = Number(raw[1]);
  const value = Number(raw[2]);
  if (!Number.isFinite(start) || !Number.isFinite(controller) || !Number.isFinite(value)) return null;
  const ctl = Math.round(controller);
  if (ctl < BEND_CONTROLLER || ctl > CC_MAX) return null;
  const bend = ctl === BEND_CONTROLLER;
  return {
    start: Math.max(0, start),
    controller: ctl,
    value: clampInt(value, bend ? BEND_MIN : CC_MIN, bend ? BEND_MAX : CC_MAX),
  };
}

/**
 * Pure function. THE CONTROL LANE a widget's state holds: its VISIBLE control
 * events, normalized, IN TIME ORDER.
 *
 * The `clipNotes` counterpart, obeying the same three rules for the same reasons —
 * a hidden element is silent but keeps its index, a malformed element is not an
 * event, and the sort is on a COPY so the stored order (and therefore every
 * `= ctrl.3.value` binding) is untouched.
 *
 * THE TIE-BREAK IS BY CONTROLLER, where `clipNotes` breaks by pitch, and it is
 * there for the identical reason: two bends written at the same beat must be sent
 * in the same order on every machine, or two renders of one deck disagree about
 * which one won.
 *
 * @param {object} s - the folded item state
 * @param {string} [key] - which list leaf holds the lane (default "ctrl")
 * @returns {Array<{start: number, controller: number, value: number}>}
 *
 * @example clipControls({ctrl: [[0, 1, 64]]}) // [{start: 0, controller: 1, value: 64}]
 * @example // an unauthored widget holds the EMPTY lane, which is the type's zero
 * @example clipControls({}) // []
 * @example clipControls({ctrl: [[2, 1, 64], [0, -1, 8192]]}).map((c) => c.start) // [0, 2]
 * @example // a HIDDEN event is silent, still stored, still numbered
 * @example clipControls({ctrl: [[0, 1, 64], [1, 1, 70]], ctrlActive: [true, false]}).length // 1
 */
export function clipControls(s, key = CTRL_KEY) {
  const list = Array.isArray(s?.[key]) ? s[key] : [];
  const active = s?.[`${key}Active`];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (!elementActive(active, i)) continue;
    const ev = ctrlRecord(list[i]);
    if (ev) out.push(ev);
  }
  return [...out].sort((a, b) => (a.start === b.start ? a.controller - b.controller : a.start - b.start));
}

/**
 * Pure function. A control record as its stored TUPLE, in the declared field
 * order. The `noteTuple` counterpart, exported for the same reason: the converter
 * (`core/signal_song.js`) builds a lane's worth of these without touching a list
 * value, and a second copy of the field order is how storage and reader drift.
 *
 * @param {object} ev - a control record
 * @returns {Array} `[start, controller, value]`
 *
 * @example ctrlTuple({start: 0, controller: 1, value: 64}) // [0, 1, 64]
 * @example // absent fields default to "a centred bend at the top of the clip"
 * @example ctrlTuple({}) // [0, -1, 8192]
 */
export function ctrlTuple(ev) {
  const controller = Number.isFinite(Number(ev?.controller)) ? Math.round(Number(ev.controller)) : BEND_CONTROLLER;
  const fallback = controller === BEND_CONTROLLER ? BEND_CENTER : 0;
  return [
    Number(ev?.start) || 0,
    controller,
    Number.isFinite(Number(ev?.value)) ? Number(ev.value) : fallback,
  ];
}

/**
 * Pure function. Which notes are SOUNDING at a beat — what a playhead readout, a
 * live highlight or a still render of a mid-clip moment asks for.
 *
 * HALF-OPEN `[start, start + duration)`: a note that ends exactly at this beat is
 * NOT sounding. That is the same convention `clipEvents` encodes by putting the
 * off first, and having the two disagree would let a legato pair count as two
 * voices for one instant.
 *
 * @param {Array<object>} notes - note records
 * @param {number} beat - the position to sample
 * @returns {Array<object>} the sounding notes, in the input's order
 *
 * @example soundingNotes([{start: 0, duration: 1, pitch: 60}], 0.5).length // 1
 * @example // half-open: the note that ends here is already off
 * @example soundingNotes([{start: 0, duration: 1, pitch: 60}], 1) // []
 * @example soundingNotes([{start: 0, duration: 1, pitch: 60}], -1) // []
 */
export function soundingNotes(notes, beat) {
  return notes.filter((n) => beat >= n.start && beat < n.start + n.duration);
}

/**
 * Pure function. A beat position as SECONDS at a tempo, and its inverse.
 *
 * The ONE place beats become seconds, so the widget's picture, a receiver's
 * scheduling and any test cannot each hold their own arithmetic. A non-positive or
 * unresolved tempo falls back to `DEFAULT_TEMPO` rather than dividing by zero: a
 * clip whose tempo row holds a broken equation should still play at a defensible
 * speed while the Inspector shows the error, not produce Infinity.
 *
 * @param {number} beat - beats
 * @param {number} tempo - beats per minute
 * @returns {number} seconds
 *
 * @example timeAtBeat(1, 120) // 0.5
 * @example timeAtBeat(4, 60) // 4
 * @example // a broken or absurd tempo falls back rather than dividing by zero
 * @example timeAtBeat(1, 0) // 0.5
 * @example timeAtBeat(1, "= nope") // 0.5
 */
export function timeAtBeat(beat, tempo) {
  return (beat * 60) / resolvedTempo(tempo);
}

/**
 * Pure function. Seconds as a beat position at a tempo — `timeAtBeat`'s inverse.
 *
 * @param {number} seconds - elapsed seconds
 * @param {number} tempo - beats per minute
 * @returns {number} beats
 *
 * @example beatAtTime(0.5, 120) // 1
 * @example beatAtTime(4, 60) // 4
 */
export function beatAtTime(seconds, tempo) {
  return (seconds * resolvedTempo(tempo)) / 60;
}

/** The tempo a clip plays at when its own row holds nothing usable. 120 BPM is
 *  the default every sequencer opens at, and it makes one beat exactly half a
 *  second — the arithmetic an author can check in their head. */
export const DEFAULT_TEMPO = 120;

/** Pure function. A usable tempo from a raw property value.
 *  @example resolvedTempo(90) // 90
 *  @example resolvedTempo(-4) // 120
 *  @example resolvedTempo(undefined) // 120 */
export function resolvedTempo(tempo) {
  const n = Number(tempo);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TEMPO;
}

// ── GRID SNAPPING ────────────────────────────────────────────────────────────

/**
 * MUSICALLY MEANINGFUL GRID DIVISIONS, as BEATS PER CELL — the vocabulary any
 * caller that quantizes a beat position shares, so two of them cannot offer
 * different sets of "a sixteenth".
 *
 * THE EDITOR NO LONGER READS THIS. It used to be the hand-rolled roll's snap menu;
 * that roll is deleted and `signal` owns its own quantization entirely. What is
 * left is the model's own answer to "which divisions are real", kept because
 * `snapBeat` below is the shared arithmetic and a division list nobody agrees on is
 * how two callers come to round differently.
 *
 * `0` is OFF, and it is a real entry rather than an absent one: "no snapping" is a
 * choice an author makes, and `snapBeat(x, 0)` returning x is what makes every
 * caller need no `if`.
 *
 * @example SNAP_DIVISIONS.includes(0.25) // true (a sixteenth at 4/4)
 * @example SNAP_DIVISIONS[0] // 0
 */
export const SNAP_DIVISIONS = Object.freeze([0, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 1, 2, 4]);

/**
 * Pure function. A beat position snapped to a grid division. Division 0 (or any
 * non-positive / unresolved value) is NO SNAP and returns the position untouched.
 *
 * ROUNDS rather than floors, because this is used for a DRAGGED note's start:
 * flooring biases every drag earlier by up to half a cell, so a note dragged to
 * visually sit on beat 2 would land on beat 1.75 and the picture would disagree
 * with the grid the author aimed at.
 *
 * @param {number} beat - an unsnapped position
 * @param {number} division - beats per grid cell (0 = off)
 * @returns {number}
 *
 * @example snapBeat(0.6, 0.5) // 0.5
 * @example snapBeat(0.8, 0.5) // 1
 * @example // OFF is a real setting, not an absent one
 * @example snapBeat(0.637, 0) // 0.637
 * @example // negative positions never survive a snap either
 * @example snapBeat(-0.2, 0.25) // 0
 */
export function snapBeat(beat, division) {
  const d = Number(division);
  const b = Number(beat);
  if (!Number.isFinite(b)) return 0;
  if (!Number.isFinite(d) || d <= 0) return Math.max(0, b);
  return Math.max(0, Math.round(b / d) * d);
}

// ── THE EDITS (the model's WRITE vocabulary) ─────────────────────────────────
//
// Every function below takes and returns a core/lists.js LIST VALUE — the pair
// `{list, active}` — so the element array and its visibility companion can never
// be spliced out of step. The caller writes BOTH leaves in one `setPreview`, which
// is what makes an edit exactly one undo unit.
//
// THESE ARE PER-ELEMENT EDITS AND THE IMPORTER IS NOT ONE OF THEIR CALLERS. The
// `signal` importer replaces the WHOLE clip in one write (web/app.svelte.js
// `commitSignalImport`), because that is what importing a song is. These remain the
// supported way to change ONE note without disturbing the numbering every equation
// is bound to — which is what the Inspector's per-row controls do.

/**
 * Pure function. The list value with one note APPENDED.
 *
 * APPENDS rather than inserting in time order, and that is the "sequence" decision
 * made physical (see the header): inserting would RENUMBER every later note, so an
 * equation bound to `clip.3.pitch` would come to mean its neighbour every time the
 * author drew a note earlier in the bar. Appending never renumbers anything.
 *
 * The companion is EXTENDED only when one already exists — a clip that has never
 * hidden a note does not gain an all-true companion just for being drawn on.
 *
 * @param {{list: Array, active?: Array}} value - the current list value
 * @param {{start: number, duration: number, pitch: number, velocity: number}} note
 * @returns {{list: Array, active: Array|undefined}}
 *
 * @example withNoteAdded({list: []}, {start: 0, duration: 1, pitch: 60, velocity: 100}) // {list: [[0, 1, 60, 100]], active: undefined}
 * @example withNoteAdded({list: [[0, 1, 60, 100]]}, {start: 1, duration: 1, pitch: 64, velocity: 90}).list.length // 2
 * @example // an existing companion is extended, so the new note is visible
 * @example withNoteAdded({list: [[0, 1, 60, 100]], active: [false]}, {start: 1, duration: 1, pitch: 64, velocity: 90}).active // [false, true]
 */
export function withNoteAdded(value, note) {
  const list = [...value.list, noteTuple(note)];
  return { list, active: value.active ? [...value.active, true] : undefined };
}

/**
 * Pure function. The list value with element `index` REPLACED by `note` — the
 * write behind every move, resize and velocity edit.
 *
 * ONE function for all three because they are one operation on the model: a note
 * is four numbers, and a drag changes some of them. Three named functions would be
 * three places for the clamping to drift.
 *
 * A note is normalized on the way in (`noteRecord`), so a drag cannot store a
 * pitch of 200, a negative start, or a zero-length note however far the pointer
 * went. THAT is why the editor may hand this raw pointer arithmetic.
 *
 * @param {{list: Array, active?: Array}} value - the current list value
 * @param {number} index - which element
 * @param {object} note - the replacement note record
 * @returns {{list: Array, active: Array|undefined}}
 *
 * @example withNoteAt({list: [[0, 1, 60, 100]]}, 0, {start: 2, duration: 1, pitch: 60, velocity: 100}).list // [[2, 1, 60, 100]]
 * @example // out-of-range pointer arithmetic is clamped here, not in the editor
 * @example withNoteAt({list: [[0, 1, 60, 100]]}, 0, {start: -5, duration: -5, pitch: 999, velocity: 999}).list // [[0, 0.0078125, 127, 127]]
 * @example // an index outside the list is a caller bug and changes nothing
 * @example withNoteAt({list: [[0, 1, 60, 100]]}, 9, {start: 0, duration: 1, pitch: 62, velocity: 100}).list // [[0, 1, 60, 100]]
 */
export function withNoteAt(value, index, note) {
  if (!(Number.isInteger(index) && index >= 0 && index < value.list.length)) return value;
  const tuple = noteTuple(noteRecord(noteTuple(note)) ?? { start: 0, duration: MIN_DURATION_BEATS, pitch: 60, velocity: DEFAULT_VELOCITY });
  return { list: value.list.map((el, i) => (i === index ? tuple : el)), active: value.active };
}

/**
 * Pure function. The list value with element `index` PURGED.
 *
 * PURGE, not hide, for the erase gesture — the same call and the same reasoning
 * `plugins/node_piano_roll.toggleNote` records: erasing a note means it is gone,
 * and hiding is a SEPARATE affordance that still exists (the Inspector's per-row
 * visibility toggle) and still means something different. The cost is stated
 * because core/lists.js makes it a real choice: purge RENUMBERS, so an equation
 * bound to a later note comes to mean its neighbour.
 *
 * @param {{list: Array, active?: Array}} value - the current list value
 * @param {number} index - which element
 * @returns {{list: Array, active: Array|undefined}}
 *
 * @example withNoteRemoved({list: [[0, 1, 60, 100], [1, 1, 64, 100]]}, 0).list // [[1, 1, 64, 100]]
 * @example withNoteRemoved({list: [[0, 1, 60, 100], [1, 1, 64, 100]], active: [false, true]}, 0).active // [true]
 * @example withNoteRemoved({list: [[0, 1, 60, 100]]}, 9).list // [[0, 1, 60, 100]]
 */
export function withNoteRemoved(value, index) {
  if (!(Number.isInteger(index) && index >= 0 && index < value.list.length)) return value;
  return {
    list: value.list.filter((_, i) => i !== index),
    active: value.active ? value.active.filter((_, i) => i !== index) : undefined,
  };
}

/**
 * Pure function. A note record as its stored TUPLE, in the declared field order.
 *
 * Exported because the ABC widget builds a clip's worth of these without ever
 * touching a list value, and a second copy of the field order is exactly how the
 * storage and the reader would drift.
 *
 * @param {object} note - a note record
 * @returns {Array} `[start, duration, pitch, velocity]`
 *
 * @example noteTuple({start: 0, duration: 1, pitch: 60, velocity: 100}) // [0, 1, 60, 100]
 * @example // absent fields take the model's own defaults rather than undefined
 * @example noteTuple({start: 2, pitch: 67}) // [2, 1, 67, 100]
 */
export function noteTuple(note) {
  return [
    Number(note?.start) || 0,
    Number.isFinite(Number(note?.duration)) ? Number(note.duration) : 1,
    Number(note?.pitch) || 0,
    Number.isFinite(Number(note?.velocity)) ? Number(note.velocity) : DEFAULT_VELOCITY,
  ];
}

/** THE STATE KEYS a clip lives under. Spelled once so the widget, the editor and
 *  the handler all name the same leaves — the "grep the constant, not the
 *  string it holds" rule core/nodeflow.EXEC_TYPE states.
 *  @example CLIP_KEY // "clip"
 *  @example CLIP_ACTIVE_KEY // "clipActive"
 *  @example CTRL_KEY // "ctrl"
 *  @example CTRL_ACTIVE_KEY // "ctrlActive" */
export const CLIP_KEY = "clip";
export const CLIP_ACTIVE_KEY = "clipActive";
export const CTRL_KEY = "ctrl";
export const CTRL_ACTIVE_KEY = "ctrlActive";

/**
 * Pure function. Is this MIDI note a BLACK key?
 *
 * ── WHY IT LIVES HERE ──────────────────────────────────────────────────────
 * It used to live in `core/piano_roll.js`, beside the hand-rolled roll's
 * coordinate arithmetic. That editor is GONE — the roll is ryohey's `signal` now,
 * framed rather than imitated (see web/SignalModal.svelte) — and every one of that
 * module's other exports went with it, because signal owns its own geometry. This
 * one function did NOT go, because its single remaining caller is the Signal
 * node's CARD PREVIEW (plugins/node_midi_clip.js), which is a picture of the clip
 * and not an editor of it. A pitch-class fact belongs with the note model.
 *
 * READS `core/keyboard_layout.BLACK_SEMITONES` rather than restating the pattern,
 * which is the reason the original gave and it still holds: the Keyboard widget
 * draws its black keys from that list, and a second copy here would be a second
 * place for "which rows are black" to be answered differently.
 *
 * Negative and out-of-range inputs answer rather than throw — `((n % 12) + 12) % 12`
 * — because a tween can pass through one.
 *
 * @param {number} pitch - a MIDI note number
 * @returns {boolean}
 *
 * @example isBlackPitch(60) // false
 * @example isBlackPitch(61) // true
 * @example isBlackPitch(72) // false
 * @example isBlackPitch(-1) // false
 * @example // an octave below zero still answers by pitch class
 * @example isBlackPitch(-11) // true
 */
export function isBlackPitch(pitch) {
  const n = Math.round(Number(pitch)) || 0;
  return BLACK_SEMITONES.includes(((n % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE);
}
