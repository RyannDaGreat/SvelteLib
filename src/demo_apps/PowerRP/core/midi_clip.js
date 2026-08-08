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
 *  note is the piano roll's equivalent of a zero-length gradient wrap: legal to
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
 * bend/CC lane in the piano roll, which would write a second list property beside
 * `clip` and hand it to this same function. Nothing about the wire, the port type,
 * the clip's storage or a receiver changes when that lands.
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
 * @param {Array<object>} notes - note records
 * @returns {Array<{beat: number, type: string, pitch: number, velocity: number}>}
 *
 * @example clipEvents([{start: 0, duration: 1, pitch: 60, velocity: 100}]).map((e) => e.type) // ["noteOn", "noteOff"]
 * @example clipEvents([{start: 0, duration: 1, pitch: 60, velocity: 100}])[1].beat // 1
 * @example // TWO LEGATO NOTES: the off at beat 1 precedes the on at beat 1
 * @example clipEvents([{start: 0, duration: 1, pitch: 60, velocity: 100}, {start: 1, duration: 1, pitch: 64, velocity: 100}]).map((e) => e.type) // ["noteOn", "noteOff", "noteOn", "noteOff"]
 * @example clipEvents([]) // []
 */
export function clipEvents(notes) {
  const events = [];
  for (const n of notes) {
    events.push({ beat: n.start, type: "noteOn", pitch: n.pitch, velocity: n.velocity });
    events.push({ beat: n.start + n.duration, type: "noteOff", pitch: n.pitch, velocity: n.velocity });
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
 * The snap divisions the piano roll offers, as BEATS PER CELL. Named here rather
 * than in the editor because the widget's own grid is drawn from the same list,
 * and a picture whose lines did not coincide with the positions a drag can land on
 * is a grid that lies about what it is for.
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

// ── THE EDITS (what the piano roll writes) ───────────────────────────────────
//
// Every function below takes and returns a core/lists.js LIST VALUE — the pair
// `{list, active}` — so the element array and its visibility companion can never
// be spliced out of step. The caller writes BOTH leaves in one `setPreview`, which
// is what makes a piano-roll gesture exactly one undo unit.

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
 *  the handler all name the same two leaves — the "grep the constant, not the
 *  string it holds" rule core/nodeflow.EXEC_TYPE states.
 *  @example CLIP_KEY // "clip"
 *  @example CLIP_ACTIVE_KEY // "clipActive" */
export const CLIP_KEY = "clip";
export const CLIP_ACTIVE_KEY = "clipActive";
