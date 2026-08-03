/**
 * KEYBOARD node — a playable keyboard face. POLYPHONIC.
 *
 * ── THE ASK (user, 2026-08-03, verbatim) ────────────────────────────────────
 * "Even a keyboard node is good. Polyphonic demos are important"
 *
 * ── WHAT IT OUTPUTS, AND WHY THAT IS TWO PORTS ──────────────────────────────
 *   `pitch` (number)  — the frequency of the most recent note, as a value the
 *                       graph can read and wire anywhere a number goes.
 *   `gate`  (trigger) — the per-note events. THIS is the polyphonic one: a key
 *                       press is a noteOn and a release is a noteOff, each
 *                       carrying WHICH note, so several can be live at once.
 *
 * They are separate because they are different kinds of thing, and collapsing
 * them would break polyphony outright: `pitch` is a VALUE (one number at a time,
 * necessarily — the graph has no concept of a port carrying four numbers), while
 * `gate` is a STREAM OF EVENTS (four notes down means four live events). A
 * keyboard wired only by `pitch` drives a monophonic patch, which is a legitimate
 * and useful thing to build; a keyboard wired by `gate` into a Poly Pad plays
 * chords. Both work, and the ports say which is which.
 *
 * ── HOW A CHORD BECOMES SOUND ───────────────────────────────────────────────
 * A key press produces a live note event (core/live_control.noteRoutes), which
 * the mirror hands to `engine.noteOn(id, note, frequency)`. The ENGINE owns the
 * voice pool (synth/voices.js — pure, oldest-steal) and the poly module owns the
 * voices. So pressing five keys on an eight-voice Poly Pad sounds five notes;
 * pressing a ninth steals the oldest. NONE of that logic is in this widget: it
 * reports which keys went down, and the allocation is decided once, in one place,
 * for every poly module.
 *
 * ── LIVE PLAY IS NOT DOCUMENT STATE (see core/control_nodes.js) ─────────────
 * Which keys are held is live input — a moment, not a value — so it is never
 * written to the document and a recorded export plays no notes. The same ruling
 * and the same reasoning as the Button. A deck that must sound notes in an export
 * drives the Poly Pad from a Sequencer, which is recordable.
 *
 * ── COMPUTER-KEYBOARD MAPPING: NOT IN v1, AND THE REASON IS A CONSTRAINT ────
 * The brief allows it "if cheap via the shortcut registry WITHOUT evicting
 * anything". It is not cheap and it would evict: a tracker-style mapping wants
 * Z-M and Q-P, and those letters are already shortcuts (the shortcut registry is
 * the single source of truth for inputs, and a key that is registered twice is
 * exactly the ambiguity it exists to prevent). Taking them would silently break
 * a dozen editor commands whenever a keyboard happened to be selected, which is a
 * modal input hidden inside a document. MOUSE-ONLY v1, deliberately; a computer
 * keyboard mapping wants its own explicit "capture keys" mode, which is a
 * designed feature rather than a cheap addition.
 */

import { controlDefaults, controlNodePlugin, CONTROL_CAT, CONTROL_FAMILY } from "../core/control_nodes.js";
import { familyCard, familyRim, nodeFamily, portBeads, NODE_HEADER_H } from "../core/node_chrome.js";
import { keyAt, keyLayout, noteName } from "../core/keyboard_layout.js";
import { noteFrequency } from "../core/live_control.js";
import { rect, text } from "../render_gpu/ir.js";

/** Two octaves at a width that fits a slide beside a patch: wide enough for a
 *  two-handed chord, narrow enough not to dominate the canvas. */
const DEFAULT_OCTAVES = 2;
const DEFAULT_BASE_NOTE = 48; // C3 — low enough for a pad's root, high enough to be melodic
const DEFAULT_W = 252;
const DEFAULT_H = 104;

/** The playing area's inset from the card's edges. */
const FACE_INSET = 8;
const FACE_TOP_GAP = 8;
const FACE_BOTTOM_GAP = 8;
const KEY_RADIUS = 2;
const LABEL_SIZE = 8;

const PORTS = {
  inputs: [],
  outputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "gate", type: "trigger", label: "gate" },
  ],
};

/**
 * Pure function. The PLAYING AREA's rect in LOCAL coordinates — the box the keys
 * are laid out inside.
 *
 * @param {object} s - the folded item state
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example keyboardFace({w: 252, h: 104}) // {x: 8, y: 32, w: 236, h: 64}
 * @example keyboardFace({w: 252, h: 30}).h // 0
 */
export function keyboardFace(s) {
  const w = s?.w ?? DEFAULT_W;
  const h = s?.h ?? DEFAULT_H;
  const y = NODE_HEADER_H + FACE_TOP_GAP;
  return { x: FACE_INSET, y, w: Math.max(0, w - FACE_INSET * 2), h: Math.max(0, h - y - FACE_BOTTOM_GAP) };
}

/** Pure function. This keyboard's range, defaulted and floored.
 *
 *  @example keyboardRange({}) // {baseNote: 48, octaves: 2}
 *  @example keyboardRange({baseNote: 60, octaves: 1}) // {baseNote: 60, octaves: 1}
 *  @example // fewer than one octave is not a keyboard; it floors rather than throws
 *  @example keyboardRange({octaves: 0}).octaves // 1
 */
export function keyboardRange(s) {
  const baseNote = Number.isFinite(Number(s?.baseNote)) ? Math.round(Number(s.baseNote)) : DEFAULT_BASE_NOTE;
  const octaves = Number.isFinite(Number(s?.octaves)) ? Math.max(1, Math.round(Number(s.octaves))) : DEFAULT_OCTAVES;
  return { baseNote, octaves };
}

/**
 * Pure function. This keyboard's keys, in LOCAL card coordinates (the layout is
 * computed in face space and translated onto the card).
 *
 * THE ONE geometry the painter and the hit test both read, which is what stops a
 * key from being drawn where it cannot be played.
 *
 * @param {object} s - the folded item state
 * @returns {Array<object>} key records with card-local x/y
 *
 * @example nodeKeyboardPlugin.keyboardKeys({w: 252, h: 104}).length // 24
 * @example nodeKeyboardPlugin.keyboardKeys({w: 252, h: 104})[0].note // 48
 */
function keyboardKeys(s) {
  const face = keyboardFace(s);
  const { baseNote, octaves } = keyboardRange(s);
  return keyLayout(face, baseNote, octaves).map((k) => ({ ...k, x: k.x + face.x, y: k.y + face.y }));
}

/**
 * Pure function. Which NOTE a LOCAL point plays, or null.
 *
 * The seam the canvas gesture and the presenter both call. Returns the note
 * NUMBER and its frequency together, because the caller needs both — the note is
 * the voice pool's identity and the frequency is what the module sounds.
 *
 * @param {object} s - the folded item state
 * @param {number} lx - LOCAL x
 * @param {number} ly - LOCAL y
 * @returns {{note: number, frequency: number}|null}
 *
 * @example keyboardNoteAt({w: 252, h: 104}, 12, 80).note // 48
 * @example // the header is not the keyboard: a press there drags the node
 * @example keyboardNoteAt({w: 252, h: 104}, 120, 6) // null
 * @example Math.round(keyboardNoteAt({w: 252, h: 104}, 12, 80).frequency) // 131
 */
export function keyboardNoteAt(s, lx, ly) {
  const hit = keyAt(keyboardKeys(s), lx, ly);
  return hit ? { note: hit.note, frequency: noteFrequency(hit.note) } : null;
}

export const nodeKeyboardPlugin = controlNodePlugin({
  type: "node_keyboard",
  title: "Keyboard",
  icon: "mdi:piano",
  ports: PORTS,
  defaults: controlDefaults("node_keyboard", DEFAULT_W, DEFAULT_H, {
    baseNote: DEFAULT_BASE_NOTE, octaves: DEFAULT_OCTAVES,
  }),
  rows: [
    { key: "baseNote", label: "Base Note", kind: "number", step: 1, category: CONTROL_CAT, help: "MIDI note of the leftmost key. 48 is C3, 60 is middle C. Raise it to put a melody in a brighter register without moving the patch." },
    { key: "octaves", label: "Octaves", kind: "number", min: 1, step: 1, category: CONTROL_CAT, help: "How many octaves of keys to draw. Each adds seven white keys; the card's width is divided among them, so a wide keyboard wants a wide node." },
  ],
  extra: {
    /** The live-play declaration, read by the canvas and the presenter: this
     *  widget takes press-and-hold notes, and `keyboardNoteAt` says which. */
    livePlay: { noteAt: keyboardNoteAt, port: "gate", kind: "note" },
    keyboardKeys,
  },
  /**
   * Pure function. The graph-visible outputs.
   *
   * `pitch` REPORTS THE RESTING VALUE — the frequency of the keyboard's base
   * note — rather than the last note played, because "the last note played" is
   * live state and is not in the document. A wire from `pitch` therefore reads a
   * defined, reproducible number in an export, and follows the hand only in a
   * live session (where the mirror pushes the played note straight at the target
   * param). Returning NaN or a stale note here would leak live state into the
   * value evaluator and break determinism.
   *
   * `gate` is 0 for the same reason a Button's output is: an event is not a
   * value that persists.
   *
   * @example nodeKeyboardPlugin.computeOutputs({baseNote: 69}) // {pitch: 440, gate: 0}
   * @example nodeKeyboardPlugin.computeOutputs({}).gate // 0
   */
  computeOutputs(s) {
    return { pitch: noteFrequency(keyboardRange(s).baseNote), gate: 0 };
  },
  /**
   * Pure function. The card, the keys, the C labels, the beads, the rim.
   *
   * WHICH KEYS ARE HELD IS NOT READ HERE. Held-ness is live input, so painting it
   * would make Δt = 0 produce two different pictures — the determinism law. The
   * lit key is a screen-space overlay, the same seam the audio meters use, and an
   * export gets the resting keyboard, which is the honest picture of a document
   * nobody is playing.
   */
  paint(s) {
    const keys = keyboardKeys(s);
    const accent = nodeFamily(CONTROL_FAMILY).rim;
    const ops = [...familyCard(s, "Keyboard", CONTROL_FAMILY)];
    // Whites first, then blacks — keyLayout's paint order, preserved, because a
    // black key overlaps the whites beside it.
    for (const k of keys) {
      ops.push(rect({
        x: k.x, y: k.y, w: k.w, h: k.h, cornerRadius: KEY_RADIUS,
        fill: k.black ? BLACK_KEY_INK : WHITE_KEY_INK,
        stroke: KEY_EDGE_INK, strokeWidth: 0.75,
      }));
    }
    // ONLY THE C's ARE LABELLED. A name on all 24 keys is a wall of text at the
    // zoom where a whole patch fits on a slide; a C every octave is the landmark
    // a player actually navigates by, which is what the black-key groups do on a
    // real instrument.
    for (const k of keys) {
      if (k.black || k.note % 12 !== 0) continue;
      ops.push(text({
        text: noteName(k.note), x: k.x, y: k.y + k.h - LABEL_SIZE / 2,
        size: LABEL_SIZE, color: KEY_LABEL_INK, boxW: k.w, boxStyle: { align: "center" },
      }));
    }
    ops.push(...portBeads(nodeKeyboardPlugin, s));
    ops.push(...familyRim(s, CONTROL_FAMILY));
    return ops;
  },
});

/** The keys. Deliberately NOT pure white and black: a full-brightness white key
 *  on a dark slide is a glare, and the node families' palette is muted
 *  throughout (ADDENDUM 6 — never gaudy). */
const WHITE_KEY_INK = "#c8cdd8";
const BLACK_KEY_INK = "#14171f";
const KEY_EDGE_INK = "#0e1016";
const KEY_LABEL_INK = "#6b7280";
