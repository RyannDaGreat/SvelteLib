/**
 * MIDI CLIP node — a phrase you draw, on a wire you drag.
 *
 * ── THE ASK (user, 2026-08-08, verbatim) ────────────────────────────────────
 * "can we make it a widget, that has an audio output (be compat with other nodes)
 * and a midi-in input node along with the signal midi output nodes and abc
 * language output midi nodes, all of which bring up full fledged UI's in giant
 * modals when duoble clicked (imitating the website with the giant piano for surge
 * and a fullscreen midi piano roll editor ported over)"
 *
 * …and, when the shape was in doubt: **"literally having signal as a node is
 * important btw"**. That ruling is what this widget is FOR. The notes are document
 * state (they have to be — see below), but the way they reach an instrument is a
 * CABLE THE AUTHOR DRAGS, exactly like a number or an audio signal. There is no
 * "source" property naming another item; there is a `midi` OUTPUT PORT, and
 * `core/nodeflow.js`'s ordinary machinery draws it, colours it, refuses an
 * incompatible drop and fans it out to as many receivers as the author likes.
 *
 * ── WHAT IT IS NOT: THE STEP SEQUENCER ONE FILE OVER ────────────────────────
 * `plugins/node_piano_roll.js` already exists and is a DIFFERENT instrument. It is
 * a 16-step grid bound to the engine's `sequencer` module: ONE pitch per step, no
 * durations, no velocity, and its outputs are `audio` control signals on the audio
 * thread. It is a drum machine's pattern editor and it is good at that.
 *
 * THIS is a CLIP: notes at arbitrary fractional starts, each with its own LENGTH
 * and VELOCITY, freely polyphonic, and its output is a `midi` stream the document
 * can read. The two are not competing spellings of one idea — a step grid cannot
 * express "a dotted quarter starting an eighth after the beat, under a sustained
 * chord", and a clip cannot be a construct-time step array. They coexist, and the
 * Inspector help on each says which is which so an author is not left guessing.
 *
 * ── THE STATE QUESTION, WHICH IS FORCED ─────────────────────────────────────
 * `clip` is a LIST property (core/lists.js), so the notes are PROPERTY STATE:
 * folded, keyframable per slide, tweenable across a transition, saved, and
 * identical on every machine. That is not a preference — CLAUDE.md's taxonomy
 * forbids the alternative, since notes arriving from a host MIDI device would be
 * EPHEMERAL state and a deck containing them could not be exported or re-rendered.
 * PLAYBACK is then recordable at one seam (`core/midi_clip.clipEvents` + the
 * presentation clock), which keeps a render seekable and shardable.
 *
 * ── DOUBLE-CLICK OPENS THE FULLSCREEN PIANO ROLL ────────────────────────────
 * ONE STRING — `activate: "piano_roll_edit"` — which is the whole point of
 * web/widget_handlers.js: the editor, its gestures, its HintBar chips and its
 * Escape all live in web/pianoRollEdit.js + web/PianoRollModal.svelte, and nothing
 * here knows about the DOM. A plugin may not carry a component (core/ and plugins/
 * must import in bare node), so it carries the NAME of one.
 */

import { CLIP_ACTIVE_KEY, CLIP_KEY, clipLengthBeats, clipNotes, DEFAULT_TEMPO, VELOCITY_MAX } from "../core/midi_clip.js";
import { TRIGGER_PORT } from "../core/clip_playback.js";
import { controlDefaults, controlNodeHeight, controlNodePlugin, CONTROL_CAT, CONTROL_FAMILY } from "../core/control_nodes.js";
import { familyCard, familyRim, nodeFamily, portBeads } from "../core/node_chrome.js";
import { isBlackPitch } from "../core/piano_roll.js";
import { props } from "../core/properties.js";
import { rect, text } from "../render_gpu/ir.js";

/** The preview's pitch window. TWO octaves from C3 — the same base note the
 *  Keyboard and the step sequencer open at, so three widgets that all draw pitch
 *  rows agree about where middle C sits. */
const DEFAULT_BASE_NOTE = 48;
const DEFAULT_OCTAVES = 2;

/** The SHORTEST span the card's preview draws, in beats. A clip shorter than a bar
 *  still gets a bar's worth of grid, so a one-note clip does not render as a single
 *  note filling the entire card — which would say nothing about where in the bar it
 *  falls, the one thing the preview exists to show. */
const MIN_PREVIEW_BEATS = 4;

/** Steps per beat marker. A brighter rule every beat and a brightest one every
 *  BAR — the same reasoning plugins/node_piano_roll.js records for its beat marks:
 *  "the snare is on 5 and 13" has to be something the eye can check. */
const BEATS_PER_BAR = 4;

const FACE_INSET = 8;
const FACE_BOTTOM_GAP = 8;

/** One pitch row's natural height in the PREVIEW. Deliberately thinner than the
 *  fullscreen editor's rows: this is a thumbnail nobody clicks — the gesture is
 *  double-click-to-open, not draw-on-the-card — so it is sized to be READ rather
 *  than to be hit. */
const PREVIEW_ROW_H = 5;
const GRID_NATURAL_H = DEFAULT_OCTAVES * 12 * PREVIEW_ROW_H;

const PREVIEW_FACE = {
  height: GRID_NATURAL_H, grow: true, inset: FACE_INSET, bottomPad: FACE_BOTTOM_GAP,
};

/**
 * THE PORTS.
 *
 * The `midi` OUTPUT is the user's "literally having signal as a node" ruling in
 * force: `core/nodeflow.js` needs nothing else to make this a draggable,
 * colourable, fan-out-able cable, because `midi` is a declared PORT_TYPES entry
 * like `number` and `audio`.
 *
 * ── THE `trigger` INPUT (user, 2026-08-08) ─────────────────────────────────
 * "one thing to decide: WHEN does the signal editor start to play its song? what
 * triggers it? a button node? … the signal editor therefore needs an input node
 * too". So: an ordinary `trigger` input, CONSUMING the existing port type
 * plugins/node_button.js and the Clock already speak rather than inventing one.
 *
 * **WHAT IS PLUGGED INTO IT DECIDES WHAT KIND OF STATE THE PLAYHEAD IS**, and that
 * is not a detail — it decides whether the deck exports. `core/clip_playback.js`
 * owns the whole argument and the loud warning; the short version:
 *
 *   NOTHING WIRED  the clip starts at its own `startTime` leaf. A pure function of
 *                  `[[slide, alpha]]` and `t` — RECORDABLE, seekable, shardable,
 *                  and it exports correctly. **THIS IS THE DEFAULT, on purpose.**
 *   A CLOCK        pulses are a pure function of elapsed time, so "which pulse am
 *                  I in" needs no history — still RECORDABLE.
 *   A BUTTON       the press is a live human moment with no document
 *                  representation, so the playhead is HISTORY — EPHEMERAL, and the
 *                  clip RENDERS SILENT however well it plays live. Legal (live
 *                  performance is the user's own suggestion) and WARNED ABOUT
 *                  loudly, never silently different.
 */
const PORTS = {
  inputs: [{ key: TRIGGER_PORT, type: "trigger", label: "trigger" }],
  outputs: [{ key: "midi", type: "midi", label: "midi" }],
};

const DEFAULT_W = 220;
const DEFAULT_H = controlNodeHeight(PREVIEW_FACE, PORTS);

/**
 * Pure function. The preview's pitch rows, HIGHEST FIRST — the order they are
 * drawn in, because a piano roll reads with low notes at the bottom.
 *
 * @param {object} s - the folded item state
 * @returns {number[]} MIDI note numbers, DESCENDING
 *
 * @example previewRows({baseNote: 60, octaves: 1}).length // 12
 * @example previewRows({baseNote: 60, octaves: 1})[0] // 71
 * @example previewRows({baseNote: 60, octaves: 1})[11] // 60
 * @example previewRows({}).length // 24
 */
export function previewRows(s) {
  const base = Number.isFinite(Number(s?.baseNote)) ? Math.round(Number(s.baseNote)) : DEFAULT_BASE_NOTE;
  const octaves = Number.isFinite(Number(s?.octaves)) ? Math.max(1, Math.round(Number(s.octaves))) : DEFAULT_OCTAVES;
  const count = octaves * 12;
  return Array.from({ length: count }, (_, i) => base + count - 1 - i);
}

/**
 * Pure function. How many BEATS the card's preview spans — the clip's own length,
 * floored at one bar and rounded UP to a whole bar.
 *
 * ROUNDED UP TO A BAR so the brightest rules always land on the card's own edges
 * and the preview reads as a whole number of bars. A clip of 4.5 beats drawn in a
 * 4.5-beat window would put its final bar line half a bar from the right edge,
 * which reads as a rendering bug rather than as a half-empty bar.
 *
 * @param {object} s - the folded item state
 * @returns {number} beats
 *
 * @example previewBeats({}) // 4
 * @example previewBeats({clip: [[0, 1, 60, 100]]}) // 4
 * @example previewBeats({clip: [[0, 8, 60, 100]]}) // 8
 * @example // rounded UP to a whole bar, so the bar rules meet the card's edge
 * @example previewBeats({clip: [[4, 1, 60, 100]]}) // 8
 */
export function previewBeats(s) {
  const length = clipLengthBeats(clipNotes(s));
  return Math.max(MIN_PREVIEW_BEATS, Math.ceil(length / BEATS_PER_BAR) * BEATS_PER_BAR);
}

export const nodeMidiClipPlugin = controlNodePlugin({
  type: "node_midi_clip",
  title: "MIDI Clip",
  icon: "mdi:piano",
  ports: PORTS,
  face: PREVIEW_FACE,
  defaults: controlDefaults("node_midi_clip", DEFAULT_W, DEFAULT_H, {
    tempo: DEFAULT_TEMPO,
    // WHEN the clip starts when nothing is wired to `trigger` — the DEFAULT and
    // reproducible path (core/clip_playback.js). An ordinary numeric leaf, so it
    // keyframes: slide 3 can start the same clip at a different moment.
    startTime: 0,
    baseNote: DEFAULT_BASE_NOTE,
    octaves: DEFAULT_OCTAVES,
    // PRESENT AT BIRTH though empty — a LIST leaf a wildcard delta path must be
    // able to expand over, the same reason `controlDefaults` ships `inputs: {}`.
    [CLIP_KEY]: [],
  }),
  rows: [
    { key: "tempo", label: "Tempo", kind: "number", min: 1, step: 1, category: CONTROL_CAT, help: "Beats per minute. The clip states its notes in BEATS, so this is what turns them into seconds — re-timing the whole phrase is this one number rather than an edit to every note." },
    { key: "startTime", label: "Start Time", kind: "number", min: 0, category: CONTROL_CAT, help: "WHEN this clip begins, in seconds on the presentation clock — used when nothing is wired to the trigger input. This is the REPRODUCIBLE way to start a clip: it is ordinary keyframable document state, so an export renders it identically every time. Wire a Clock to the trigger to loop it instead; wire a Button and it will play live but render SILENT, because a press is not document state." },
    { key: "baseNote", label: "Base Note", kind: "number", min: 0, max: 127, step: 1, category: CONTROL_CAT, help: "MIDI note of the PREVIEW's bottom row. 48 is C3, 60 is middle C. This moves what the card shows; it does not move the notes. The fullscreen editor scrolls independently." },
    { key: "octaves", label: "Octaves", kind: "number", min: 1, step: 1, category: CONTROL_CAT, help: "How many octaves of pitch rows the card's preview shows. The face's height is divided among them, so a two-octave preview wants a taller node." },
    ...props(CLIP_KEY, { [CLIP_KEY]: { category: CONTROL_CAT } }),
  ],
  /**
   * DOUBLE-CLICK OPENS THE FULLSCREEN PIANO ROLL (the user's "full fledged UI's in
   * giant modals when duoble clicked"). One string; see the file header.
   */
  activate: "piano_roll_edit",
  extra: {
    /** THE CLIP DECLARATION — which leaves hold this widget's notes, read by
     *  web/pianoRollEdit.js and web/PianoRollModal.svelte so neither needs the
     *  widget roster and neither hardcodes a key. A future widget that also holds
     *  an editable clip declares the same two and inherits the whole editor with
     *  no code in either place (the `noteLatch` precedent, which the Keyboard and
     *  the step sequencer already share verbatim). */
    midiClip: { key: CLIP_KEY, activeKey: CLIP_ACTIVE_KEY, editable: true },
    outputProps: {
      /** THE CLIP'S LENGTH IN BEATS — what a loop, a transition or a bar counter
       *  wants, published so an equation can read it (`= clip1.beats`) without
       *  walking the note list itself. Deliberately NOT a stored property: it is a
       *  fact ABOUT the notes, and a second stored number beside them is a source
       *  of truth that goes stale the moment a note is dragged.
       *
       *  There is no matching `tempo` output because tempo IS a stored property
       *  here and is already readable as one — publishing it twice would collide
       *  (core/output_properties.checkNames refuses a name the plugin also stores,
       *  loudly, and it is right to). */
      beats: {
        label: "Beats", kind: "number",
        value: (s) => clipLengthBeats(clipNotes(s)),
        help: "How long this clip is, in beats, from 0 to the end of its last note. 0 when the clip is empty.",
      },
    },
  },
  /**
   * Pure function. THE GRAPH-VISIBLE OUTPUT: the clip itself, as the note-record
   * array `core/nodeflow.PORT_TYPES.midi` declares.
   *
   * This is a PURE FUNCTION OF THE FOLDED STATE, which is what makes a `midi`
   * wire reproducible: the same document at the same `[[slide, alpha]]` produces
   * the same stream on every machine and in bare node. Nothing here reads a clock
   * — turning these notes into note-ons is the RECEIVER's job, at the one seam
   * (`core/midi_clip.clipEvents`) that takes a beat as an argument.
   *
   * @example nodeMidiClipPlugin.computeOutputs({clip: [[0, 1, 60, 100]]}).midi.length // 1
   * @example nodeMidiClipPlugin.computeOutputs({clip: [[0, 1, 60, 100]]}).midi[0].pitch // 60
   * @example // an unauthored clip is the EMPTY STREAM, which is the type's zero
   * @example nodeMidiClipPlugin.computeOutputs({}).midi // []
   */
  computeOutputs(s) {
    return { midi: clipNotes(s) };
  },
  /**
   * Pure function. The card, the pitch lanes, the bar rules, the notes, the beads,
   * the rim.
   *
   * EVERYTHING HERE IS DOCUMENT STATE. There is no playhead: which beat is sounding
   * right now is a clock, not `[[slide, alpha]]`, so painting one would make Δt = 0
   * produce two different pictures — the determinism law, and the same line
   * plugins/node_piano_roll.js's own paint sits on.
   *
   * A NOTE OUTSIDE THE PREVIEW'S PITCH WINDOW IS NOT DRAWN, and that is deliberate
   * rather than a clipping bug: there is no row for it. It still sounds, the
   * Inspector still lists it, and the fullscreen editor scrolls to it. Drawing it
   * on the nearest row instead would be a picture that disagrees with the clip.
   * The card SAYS SO — the note count in the corner is of the whole clip, not of
   * what fits — so an author whose window is wrong can see that it is.
   *
   * @param {object} s - the folded item state
   * @param {object} face - the preview's rect, HANDED here by the factory (R7-10)
   */
  paint(s, face) {
    const rows = previewRows(s);
    const beats = previewBeats(s);
    const notes = clipNotes(s);
    const cellH = face.h / rows.length;
    const beatW = face.w / beats;
    const accent = nodeFamily(CONTROL_FAMILY).rim;
    const ops = [...familyCard(s, nodeMidiClipPlugin.title, CONTROL_FAMILY)];
    // ── THE PITCH LANES ──────────────────────────────────────────────────────
    for (let row = 0; row < rows.length; row++)
      ops.push(rect({
        x: face.x, y: face.y + row * cellH, w: face.w, h: cellH,
        fill: isBlackPitch(rows[row]) ? LANE_BLACK_INK : LANE_WHITE_INK,
      }));
    // ── THE BEAT AND BAR RULES ───────────────────────────────────────────────
    for (let beat = 1; beat < beats; beat++)
      ops.push(rect({
        x: face.x + beat * beatW, y: face.y, w: GRID_RULE_W, h: face.h,
        fill: beat % BEATS_PER_BAR === 0 ? GRID_BAR_INK : GRID_RULE_INK,
      }));
    // ── THE NOTES ────────────────────────────────────────────────────────────
    // VELOCITY IS THE NOTE'S OPACITY, which is the one extra dimension a thumbnail
    // can carry without a second colour: a quiet note reads as a fainter block. It
    // is a floor of 0.35 rather than a raw ratio so that velocity 1 is still
    // VISIBLE — a note that exists and cannot be seen is worse than one drawn flat.
    for (const note of notes) {
      const row = rows.indexOf(note.pitch);
      if (row < 0 || note.start >= beats) continue;
      const w = Math.min(note.duration * beatW, face.w - note.start * beatW);
      ops.push(rect({
        x: face.x + note.start * beatW + NOTE_INSET, y: face.y + row * cellH + NOTE_INSET,
        w: Math.max(NOTE_MIN_W, w - NOTE_INSET * 2), h: Math.max(0, cellH - NOTE_INSET * 2),
        cornerRadius: 1, fill: accent, opacity: NOTE_MIN_ALPHA + (1 - NOTE_MIN_ALPHA) * (note.velocity / VELOCITY_MAX),
      }));
    }
    // ── THE COUNT ────────────────────────────────────────────────────────────
    // Of the WHOLE clip, including notes outside the drawn window (see the
    // docblock). An EMPTY clip says so in words rather than showing a bare grid
    // that could equally mean "no notes" or "the window is wrong".
    ops.push(text({
      text: notes.length === 0 ? "empty — double-click to edit" : `${notes.length} note${notes.length === 1 ? "" : "s"}`,
      x: face.x, y: face.y - COUNT_BASELINE_GAP, size: COUNT_SIZE,
      color: notes.length === 0 ? COUNT_EMPTY_INK : COUNT_INK,
      boxW: face.w, boxStyle: { align: "right" },
    }));
    ops.push(...portBeads(nodeMidiClipPlugin, s));
    ops.push(...familyRim(s, CONTROL_FAMILY));
    return ops;
  },
});

/** The pitch lanes. Two near-identical darks: the contrast has to be readable
 *  behind a note without competing with it (ADDENDUM 6 — never gaudy). Shared
 *  values with plugins/node_piano_roll.js by COINCIDENCE OF INTENT, not by import
 *  — no plugin may import another, and these are one file's palette each. */
const LANE_WHITE_INK = "#232838";
const LANE_BLACK_INK = "#1a1e2b";
const GRID_RULE_INK = "#2e3446";
const GRID_BAR_INK = "#454d66";
const GRID_RULE_W = 1;
/** How far a note sits inside its cell, so two adjacent notes read as two, and
 *  the narrowest a note may be drawn — a sub-pixel sliver is invisible. */
const NOTE_INSET = 0.5;
const NOTE_MIN_W = 1.5;
/** The faintest a note is drawn. Velocity scales opacity from here to 1; a floor
 *  of zero would make velocity-1 notes invisible rather than quiet. */
const NOTE_MIN_ALPHA = 0.35;
/** The note count above the grid's top-right corner. */
const COUNT_SIZE = 8;
const COUNT_BASELINE_GAP = 2;
const COUNT_INK = "#6b7280";
const COUNT_EMPTY_INK = "#565e70";
