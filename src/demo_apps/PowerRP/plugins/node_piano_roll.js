/**
 * PIANO ROLL node — the pattern-editing surface for the step sequencer (R7-14).
 *
 * ── THE ASK ─────────────────────────────────────────────────────────────────
 * The user's MIDI list (manifest, "From Midi? Can we have midi files? Piano
 * roll?"), promoted to R7-14. `core/audio_specs.SEQUENCER_SPEC` already said where
 * this belongs, in its own help string: "The piano-roll editing surface the user
 * asked for is wave 3; this is the module underneath it."
 *
 * ── WHAT IT UNBLOCKS, AND WHY THE SEQUENCER ALONE WAS A DEAD END ────────────
 * MEASURED: an `audio_sequencer` in a document has no way to carry NOTES. Its spec
 * declares one knob (`stepCount`), so `readAudioScene` hands the engine nothing
 * else, and `synth/modules.js normalizeSteps` fills the whole pattern with rests —
 * `{on: false, note: 60}` sixteen times. The module emitted steps and every one of
 * them was silent, on every deck, always. This widget is the missing half: the same
 * engine module, with a pattern the document actually states.
 *
 * ── THE STATE QUESTION, WHICH IS THE POINT OF THE WIDGET ────────────────────
 * A pattern is PROPERTY STATE — the first of CLAUDE.md's three kinds, and the one
 * to default to. `notes` is an ordinary LIST property (core/lists.js): folded from
 * the document, keyframable per slide, per-element equations for free, hide-vs-purge
 * for free, and an Inspector control for free. Nothing here is live and nothing here
 * reads a clock. What the pattern PRODUCES is recordable state — the sequencer's
 * playhead is driven by synth/scheduler.js off the audio clock — which is the same
 * boundary every audio module sits on and is why an exported video of a deck with a
 * Piano Roll in it contains the phrase.
 *
 * So this widget is the exact complement of the Keyboard: a keyboard is a live
 * surface whose presses vanish, a piano roll is an authored surface whose notes are
 * the deck. Between them the R7-13 LATCH is the bridge, and this file shares its
 * declaration verbatim (`noteLatch`) — a click here is an EDIT, one property write,
 * one undo unit, which is what a latched keyboard press became.
 *
 * ── ONE NOTE PER STEP, SAID OUT LOUD ────────────────────────────────────────
 * The engine's sequencer has ONE pitch output driven by ONE constant source
 * (`synth/modules.js sequencerModule`), so it sounds a single pitch per step. A
 * grid that let you draw a chord and then played its top note would be a picture
 * that lies about the sound — the failure this project forbids — so the GESTURE
 * enforces the limit instead: dropping a note on an occupied step MOVES that step's
 * note rather than adding a second. What you see is what sounds, at every step.
 * Polyphony would need a poly sequencer module, which is a piece of work of its own.
 *
 * ── WHY IT IS BUILT BY controlNodePlugin AND STILL BINDS AN ENGINE MODULE ───
 * `core/audio_nodes.audioNodePlugin` deliberately offers no way to replace `emit`,
 * and it is right not to: 24 modules that could each draw their own card is the
 * 24-way drift that factory exists to prevent. A piano roll's whole face is a grid,
 * which no knob band can express. `core/control_nodes.controlNodePlugin` is the
 * factory whose contract IS "declare a face, receive the rect, paint inside it", so
 * that is the one used — and the engine binding (`audioModule` + `audioSpec`) is
 * added as a plain declaration, which is exactly how web/audioMirror finds any
 * module. The `controlNode: true` flag rides along and stays true in the sense that
 * matters: this is a hand-authored input surface, not a computation.
 */

import { controlDefaults, controlNodeHeight, controlNodePlugin, CONTROL_CAT, CONTROL_FAMILY } from "../core/control_nodes.js";
import { audioDisplayTitle } from "../core/audio_nodes.js";
import { BLACK_SEMITONES, SEMITONES_PER_OCTAVE } from "../core/keyboard_layout.js";
import { elementActive } from "../core/lists.js";
import { familyCard, familyRim, portBeads, nodeFamily } from "../core/node_chrome.js";
import { props } from "../core/properties.js";
import { rect } from "../render_gpu/ir.js";

/** Sixteen steps is one bar of sixteenths — the length every step sequencer since
 *  the TR-808 opens at, and the length synth/scheduler.js already defaults to. */
const DEFAULT_STEP_COUNT = 16;
/** ONE octave of rows, from C3. Two octaves is 24 rows, and 24 rows in a face a
 *  card's height can hold are too thin to click; the author raises it when the
 *  phrase needs the range, and the card grows with it. */
const DEFAULT_OCTAVES = 1;
const DEFAULT_BASE_NOTE = 48; // C3 — the Keyboard's own default, so the two agree

/** How tall one pitch row wants to be. Below about this the row is smaller than the
 *  pointer that has to hit it, which is what sets the card's natural height. */
const ROW_NATURAL_H = 12;
/** …and how wide one step wants to be. Sixteen of these is the card's width. */
const STEP_NATURAL_W = 18;

const FACE_INSET = 8;
const FACE_BOTTOM_GAP = 8;

/** The grid's natural size, which is what the card is born at. */
const GRID_NATURAL_H = DEFAULT_OCTAVES * SEMITONES_PER_OCTAVE * ROW_NATURAL_H;
const DEFAULT_W = DEFAULT_STEP_COUNT * STEP_NATURAL_W + FACE_INSET * 2;

/**
 * THE FACE DECLARATION — WHAT the grid needs, never WHERE it goes (R7-10).
 *
 * ELASTIC, like the Keyboard's keys and a slider's track: a grid on a tall card
 * should BE tall, because its height is a range (more room per row) rather than a
 * proportion that carries meaning. The ROW height is then the face's height divided
 * by the pitch count, so raising `octaves` thins the rows rather than overflowing —
 * the same trade the Keyboard makes across its width.
 */
const PIANO_ROLL_FACE = {
  height: GRID_NATURAL_H, grow: true, inset: FACE_INSET, bottomPad: FACE_BOTTOM_GAP,
};

const PORTS = {
  inputs: [],
  outputs: [
    // AUDIO, not `number`, and this is core/audio_specs.js's own rule rather than a
    // choice made here: "Every module output is audio, including the sequencer's
    // `pitch` and `gate`: they are control SIGNALS on AudioNodes, not numbers the
    // document can read."
    { key: "pitch", type: "audio", label: "pitch" },
    { key: "gate", type: "audio", label: "gate" },
  ],
};

const DEFAULT_H = controlNodeHeight(PIANO_ROLL_FACE, PORTS);

/** THE `notes` LIST DECLARATION, read back off core/properties.js rather than
 *  restated — plugins/polygon.js POINTS_LIST is the precedent, and the reason is
 *  that the shape this file reads and the shape the Inspector edits must be one
 *  declaration or they will drift. */
const NOTES_LIST = props("notes")[0];

/**
 * Pure function. The pattern's LENGTH — how many steps the grid draws and the
 * sequencer's array is built at.
 *
 * @param {object} s - the folded item state
 * @returns {number} at least 1
 *
 * @example patternLength({}) // 16
 * @example patternLength({audioStepCount: 8}) // 8
 * @example // a pattern of no steps is not a pattern; it floors rather than throwing
 * @example patternLength({audioStepCount: 0}) // 1
 * @example patternLength({audioStepCount: "= nope"}) // 16
 */
export function patternLength(s) {
  const n = Number(s?.audioStepCount);
  return Number.isFinite(n) ? Math.max(1, Math.round(n)) : DEFAULT_STEP_COUNT;
}

/**
 * Pure function. The grid's PITCH ROWS, highest first — the order they are drawn
 * and hit-tested in, because a piano roll reads with low notes at the bottom.
 *
 * @param {object} s - the folded item state
 * @returns {number[]} MIDI note numbers, DESCENDING
 *
 * @example pitchRows({baseNote: 60, octaves: 1}).length // 12
 * @example pitchRows({baseNote: 60, octaves: 1})[0] // 71 (the top row is the highest note)
 * @example pitchRows({baseNote: 60, octaves: 1})[11] // 60
 * @example pitchRows({}).length // 12
 * @example pitchRows({octaves: 2}).length // 24
 */
export function pitchRows(s) {
  const base = Number.isFinite(Number(s?.baseNote)) ? Math.round(Number(s.baseNote)) : DEFAULT_BASE_NOTE;
  const octaves = Number.isFinite(Number(s?.octaves)) ? Math.max(1, Math.round(Number(s.octaves))) : DEFAULT_OCTAVES;
  const count = octaves * SEMITONES_PER_OCTAVE;
  return Array.from({ length: count }, (_, i) => base + count - 1 - i);
}

/**
 * Pure function. THE PATTERN as `{step: note}` — the visible notes, one per step,
 * with a later entry winning an occupied step.
 *
 * ── LATER WINS, AND IT IS NOT AN ARBITRARY TIE-BREAK ────────────────────────
 * The gesture never authors two notes on one step (see `toggleNote`), so a
 * collision can only arrive from a keyframe, an equation or a hand-edited list.
 * "Later wins" is the rule the Inspector makes visible: the last row is the one
 * that sounds, and moving a row changes which. Averaging or refusing would each
 * need the author to reason about a rule they cannot see.
 *
 * @param {object} s - the folded item state
 * @returns {Object<number, number>} step → MIDI note
 *
 * @example patternNotes({notes: [[0, 60], [4, 64]]}) // {0: 60, 4: 64}
 * @example patternNotes({}) // {}
 * @example // a HIDDEN entry is a rest — the step is simply absent
 * @example patternNotes({notes: [[0, 60], [4, 64]], notesActive: [true, false]}) // {0: 60}
 * @example // two notes on one step: the later row is the one that sounds
 * @example patternNotes({notes: [[0, 60], [0, 67]]}) // {0: 67}
 * @example // a tweened pattern lands between cells; a grid has no half-steps
 * @example patternNotes({notes: [[1.4, 60.6]]}) // {1: 61}
 */
export function patternNotes(s) {
  const list = Array.isArray(s?.notes) ? s.notes : [];
  const active = s?.notesActive;
  const pattern = {};
  for (let i = 0; i < list.length; i++) {
    if (!elementActive(active, i)) continue;
    const step = Math.round(Number(list[i]?.[0]));
    const note = Math.round(Number(list[i]?.[1]));
    if (!Number.isFinite(step) || !Number.isFinite(note) || step < 0) continue;
    pattern[step] = note;
  }
  return pattern;
}

/**
 * Pure function. THE ENGINE'S `steps` VALUE — a dense array of `{on, note}`, one
 * per step, exactly as `synth/modules.js normalizeSteps` expects it.
 *
 * ── THIS IS THE WHOLE BRIDGE FROM DOCUMENT TO SOUND ─────────────────────────
 * Declared as the spec's `steps` knob through the `derived` word
 * (core/audio_nodes.audioKnobValues), so `readAudioScene` picks it up like any
 * other knob and `diffAudioScene` sends it as an ordinary `setParam`. Nothing in
 * the mirror knows what a piano roll is.
 *
 * A NOTE PAST THE LAST STEP IS KEPT AND NOT SOUNDED. Shortening the pattern must
 * not delete the phrase's tail — the author lengthens it again and the notes are
 * still there. That is the same "hiding keeps the numbering" bargain core/lists.js
 * makes one level down.
 *
 * @param {object} s - the folded item state
 * @returns {Array<{on: boolean, note: number}>} length = patternLength(s)
 *
 * @example sequencerSteps({audioStepCount: 2, notes: [[0, 60]]}) // [{on: true, note: 60}, {on: false, note: 60}]
 * @example // an empty roll is a bar of rests, which is what an unauthored one is
 * @example sequencerSteps({audioStepCount: 1}) // [{on: false, note: 60}]
 * @example // a note past the end is stored, not sounded, and not lost
 * @example sequencerSteps({audioStepCount: 1, notes: [[5, 72]]}) // [{on: false, note: 60}]
 * @example sequencerSteps({audioStepCount: 4, notes: [[0, 60], [2, 67]]}).filter((x) => x.on).map((x) => x.note) // [60, 67]
 */
export function sequencerSteps(s) {
  const pattern = patternNotes(s);
  return Array.from({ length: patternLength(s) }, (_, i) => (i in pattern
    ? { on: true, note: pattern[i] }
    // A REST STILL CARRIES A NOTE, and it is the engine's own resting pitch rather
    // than 0: `normalizeSteps` writes `{on: false, note: 60}` for an unauthored
    // step, and a rest whose note differed from that would make an authored empty
    // pattern differ from a defaulted one for no audible reason.
    : { on: false, note: REST_NOTE }));
}

/** The pitch a RESTING step carries — `synth/modules.js normalizeSteps`'s own, so
 *  an authored rest and a defaulted one are the same record. */
const REST_NOTE = 60;

/**
 * Pure function. WHICH CELL a LOCAL point is over, or null.
 *
 * The seam the canvas gesture calls, declared as `noteLatch.cellAt` so
 * web/CanvasView.svelte can hit-test this widget without knowing what it is. Same
 * contract as the Keyboard's `keyboardNoteAt`: it returns the note, and whatever
 * else the toggle needs — here, the step.
 *
 * @param {object} s - the folded item state
 * @param {number} lx - LOCAL x
 * @param {number} ly - LOCAL y
 * @returns {{step: number, note: number}|null}
 *
 * @example // the BOTTOM-LEFT cell of a default roll: step 0, its lowest pitch
 * @example nodePianoRollPlugin.noteLatch.cellAt(nodePianoRollPlugin.defaults, 10, 210) // {step: 0, note: 48}
 * @example // …and one row up is one semitone up
 * @example nodePianoRollPlugin.noteLatch.cellAt(nodePianoRollPlugin.defaults, 10, 200) // {step: 0, note: 49}
 * @example // the header is not the grid: a press there drags the node
 * @example nodePianoRollPlugin.noteLatch.cellAt(nodePianoRollPlugin.defaults, 100, 6) // null
 * @example // …and neither are the PORT ROWS, which the face sits below
 * @example nodePianoRollPlugin.noteLatch.cellAt(nodePianoRollPlugin.defaults, 100, 50) // null
 */
export function cellAt(s, lx, ly) {
  const face = nodePianoRollPlugin.controlFace(s);
  if (!(lx >= face.x && lx < face.x + face.w && ly >= face.y && ly < face.y + face.h)) return null;
  const rows = pitchRows(s);
  const steps = patternLength(s);
  const step = Math.floor(((lx - face.x) / face.w) * steps);
  const row = Math.floor(((ly - face.y) / face.h) * rows.length);
  if (step < 0 || step >= steps || row < 0 || row >= rows.length) return null;
  return { step, note: rows[row] };
}

/**
 * Pure function. THE CELL TOGGLE — the `notes` list after a click on `cell`.
 *
 * Three outcomes, and the third is the monophony rule made physical:
 *   EMPTY STEP        → the note is added.
 *   THIS NOTE AGAIN   → the note is purged; the step becomes a rest.
 *   A DIFFERENT NOTE  → that step's note MOVES to the clicked pitch. One pitch per
 *     step is what the engine can sound, so the grid never shows a second.
 *
 * PURGE RATHER THAN HIDE for a cleared cell, the same call the Keyboard's latch
 * makes and for the same reason: a chord is a SET and a pattern is a MAP, and the
 * operation that keeps one a map is removal. Hiding is still available and still
 * means something different — it is the Inspector's per-row visibility toggle, and
 * it is how an author mutes a note without losing where it was.
 *
 * @param {object} s - the folded item state
 * @param {{step: number, note: number}} cell - what `cellAt` returned
 * @returns {Array} the new `notes` value
 *
 * @example toggleNote({}, {step: 0, note: 60}) // [[0, 60]]
 * @example toggleNote({notes: [[0, 60]]}, {step: 4, note: 64}) // [[0, 60], [4, 64]]
 * @example // clicking the note again clears the step
 * @example toggleNote({notes: [[0, 60], [4, 64]]}, {step: 0, note: 60}) // [[4, 64]]
 * @example // clicking a DIFFERENT pitch on an occupied step moves the note
 * @example toggleNote({notes: [[0, 60], [4, 64]]}, {step: 0, note: 67}) // [[0, 67], [4, 64]]
 * @example // a HIDDEN note does not occupy its step, so a click authors a new one
 * @example toggleNote({notes: [[0, 60]], notesActive: [false]}, {step: 0, note: 67}) // [[0, 60], [0, 67]]
 */
export function toggleNote(s, cell) {
  const list = Array.isArray(s?.notes) ? s.notes : [];
  const index = list.findIndex((el, i) => elementActive(s?.notesActive, i)
    && Math.round(Number(el?.[0])) === cell.step);
  if (index < 0) return [...list, [cell.step, cell.note]];
  if (Math.round(Number(list[index]?.[1])) === cell.note) {
    // CLEARED. The companion is filtered in step, which is core/lists.js's purge —
    // spelled here rather than called because `withElementPurged` returns the PAIR
    // and only the list half is written by the one leaf this gesture edits.
    return list.filter((_, i) => i !== index);
  }
  return list.map((el, i) => (i === index ? [cell.step, cell.note] : el));
}

/**
 * THE ENGINE SPEC — declared HERE rather than in core/audio_specs.js, and that is a
 * boundary rather than an inconsistency.
 *
 * That file's header states its own contract: "Zero PowerRP-runtime and zero synth
 * imports: this is data." Two of these knobs are `derived` — FUNCTIONS of item
 * state — so putting them there would make it not-data, and it is swept as data by
 * `AUDIO_SPECS` (which builds a plugin per entry through `audioNodePlugin`, which
 * this widget deliberately does not use). The spec lives beside the functions it
 * names, and `tests/piano_roll_test.js` runs the same engine cross-check
 * `tests/audio_nodes_test.js` runs over the other 24.
 */
export const PIANO_ROLL_SPEC = {
  type: "node_piano_roll", module: "sequencer", title: "Piano Roll", family: CONTROL_FAMILY,
  inputs: [],
  outputs: PORTS.outputs,
  knobs: [
    // CONSTRUCT-TIME, exactly as SEQUENCER_SPEC declares it and for the identical
    // reason: `sequencerModule` sizes its step array at build, so a length change
    // rebuilds. It is ALSO what the shared transport reads (transportOf's
    // STEP_COUNT_KNOB), which is why the key is spelled the engine's way.
    { key: "stepCount", label: "Steps", default: DEFAULT_STEP_COUNT, min: 1, max: 64, step: 1, construct: true, help: "CONSTRUCT-TIME: the step array is sized at build, so changing the count rebuilds the sequencer. How many steps the pattern is, and how many columns the grid draws. This also sets the shared transport's pattern length. Notes past the last step are kept and simply do not sound." },
    // DERIVED (R7-14): the pattern has no leaf of its own — it is computed from the
    // `notes` LIST, which is where the author edits it. See
    // core/audio_nodes.audioKnobValues for why that word exists.
    { key: "steps", derived: sequencerSteps, help: "The pattern the engine plays, derived from Notes. Not a field: edit the grid or the Notes rows." },
  ],
};

export const nodePianoRollPlugin = controlNodePlugin({
  type: PIANO_ROLL_SPEC.type,
  title: audioDisplayTitle(PIANO_ROLL_SPEC.title),
  icon: "mdi:music-box-multiple-outline",
  ports: PORTS,
  face: PIANO_ROLL_FACE,
  defaults: controlDefaults(PIANO_ROLL_SPEC.type, DEFAULT_W, DEFAULT_H, {
    audioStepCount: DEFAULT_STEP_COUNT,
    baseNote: DEFAULT_BASE_NOTE, octaves: DEFAULT_OCTAVES,
    // PRESENT AT BIRTH though empty — a LIST leaf a wildcard path must be able to
    // expand over, the same reason `controlDefaults` ships `inputs: {}`.
    notes: [],
  }),
  rows: [
    { key: "audioStepCount", label: "Steps", kind: "number", min: 1, max: 64, step: 1, category: CONTROL_CAT, help: PIANO_ROLL_SPEC.knobs[0].help },
    { key: "baseNote", label: "Base Note", kind: "number", step: 1, category: CONTROL_CAT, help: "MIDI note of the grid's BOTTOM row. 48 is C3, 60 is middle C. Raise it to move the whole visible range without moving the notes." },
    { key: "octaves", label: "Octaves", kind: "number", min: 1, step: 1, category: CONTROL_CAT, help: "How many octaves of pitch rows the grid shows. The face's height is divided among them, so a two-octave roll wants a taller node." },
    ...props("notes", { notes: { category: CONTROL_CAT } }),
  ],
  extra: {
    // ── THE ENGINE BINDING ───────────────────────────────────────────────────
    // web/audioMirror reads exactly these two off the plugin to decide that an item
    // is a module and which engine type to instantiate (core/audio_mirror_diff.
    // readAudioScene). Declaring them is the whole of "this widget makes sound" —
    // there is no roster anywhere that had to be edited.
    audioModule: PIANO_ROLL_SPEC.module,
    audioSpec: PIANO_ROLL_SPEC,
    // ── THE LATCH DECLARATION, SHARED VERBATIM WITH THE KEYBOARD (R7-13) ─────
    // A click on this widget is an EDIT, never a live note, so `locked` is
    // unconditionally true — there is no un-latched mode for a pattern, because a
    // pattern is the authored thing. plugins/node_keyboard.js declares the same five
    // keys with a `locked` that reads its switch, and web/CanvasView.svelte's one
    // gesture serves both.
    noteLatch: {
      locked: () => true, cellAt, toggle: toggleNote,
      notesKey: "notes", notes: () => [],
    },
  },
  /**
   * Pure function. The card, the pitch lanes, the step grid, the notes, the beads,
   * the rim.
   *
   * EVERYTHING HERE IS DOCUMENT STATE. There is no playhead: which step is sounding
   * right now is the engine's audio clock, not `[[slide, alpha]]`, so painting it
   * would make Δt = 0 produce two different pictures — the determinism law, and the
   * same line the audio meters' live columns sit on (they reach `emit` as a
   * render-time `ctx` argument only a surface with a running AudioContext supplies).
   * A playhead through that seam is a follow-up, not a hole here.
   *
   * @param {object} s - the folded item state
   * @param {object} face - the grid's rect, HANDED here by the factory (R7-10)
   */
  paint(s, face) {
    const rows = pitchRows(s);
    const steps = patternLength(s);
    const pattern = patternNotes(s);
    const cellW = face.w / steps;
    const cellH = face.h / rows.length;
    const accent = nodeFamily(CONTROL_FAMILY).rim;
    const ops = [...familyCard(s, nodePianoRollPlugin.title, CONTROL_FAMILY)];
    // ── THE PITCH LANES ──────────────────────────────────────────────────────
    // A dark stripe on every BLACK-key row, which is the one cue that makes a bare
    // grid readable as pitch: without it, counting twelve identical rows to find a
    // C is the only way to know where you are.
    for (let row = 0; row < rows.length; row++) {
      const black = BLACK_SEMITONES.includes(((rows[row] % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE);
      ops.push(rect({
        x: face.x, y: face.y + row * cellH, w: face.w, h: cellH,
        fill: black ? LANE_BLACK_INK : LANE_WHITE_INK,
      }));
    }
    // ── THE STEP COLUMNS ─────────────────────────────────────────────────────
    // One rule per step, and a BRIGHTER one every four — a bar of sixteenths reads
    // as four beats or as sixteen anonymous columns, and the beat marks are what
    // make "the snare is on 5 and 13" something the eye can check.
    for (let step = 1; step < steps; step++) {
      ops.push(rect({
        x: face.x + step * cellW, y: face.y, w: GRID_RULE_W, h: face.h,
        fill: step % BEAT_STEPS === 0 ? GRID_BEAT_INK : GRID_RULE_INK,
      }));
    }
    // ── THE NOTES ────────────────────────────────────────────────────────────
    for (const [step, note] of Object.entries(pattern)) {
      const row = rows.indexOf(note);
      // A note OUTSIDE the drawn pitch range is not painted — there is no row for
      // it. It still sounds, and the Inspector still lists it; raising `octaves`
      // brings it into view. Silently drawing it on the nearest row would be a
      // picture that disagrees with the pattern.
      if (row < 0 || Number(step) >= steps) continue;
      ops.push(rect({
        x: face.x + Number(step) * cellW + NOTE_INSET, y: face.y + row * cellH + NOTE_INSET,
        w: Math.max(0, cellW - NOTE_INSET * 2), h: Math.max(0, cellH - NOTE_INSET * 2),
        cornerRadius: 1, fill: accent,
      }));
    }
    ops.push(...portBeads(nodePianoRollPlugin, s));
    ops.push(...familyRim(s, CONTROL_FAMILY));
    return ops;
  },
});

/** Steps per beat at the sixteenth-note resolution synth/dsp.js's scheduler runs —
 *  so the brighter rule falls on a beat rather than on an arbitrary fourth column. */
const BEAT_STEPS = 4;

/** The pitch lanes. Two near-identical darks: the contrast has to be readable
 *  behind a note without competing with it (ADDENDUM 6 — never gaudy). */
const LANE_WHITE_INK = "#232838";
const LANE_BLACK_INK = "#1a1e2b";
/** The step rules, and the brighter one every beat. */
const GRID_RULE_INK = "#2e3446";
const GRID_BEAT_INK = "#454d66";
const GRID_RULE_W = 1;
/** How far a note sits inside its cell, so two adjacent notes read as two. */
const NOTE_INSET = 1;
