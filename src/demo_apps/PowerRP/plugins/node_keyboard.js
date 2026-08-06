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
 * Which keys are under a finger is live input — a moment, not a value — so it is
 * never written to the document and a recorded export plays no presses. The same
 * ruling and the same reasoning as the Button.
 *
 * ── …AND THE LOCK IS THE OTHER THING ENTIRELY (R7-13) ───────────────────────
 * USER, verbatim: "I also want a keyboard whose keys I can lock in place. Well,
 * maybe actually that can be an option for a regular keyboard, which is a button I
 * click to turn on lock or not. When it's locked on, the keys will stay turned on
 * at all times. In the UI, in other words, to let me play different chords and
 * different slides."
 *
 * THE LAST CLAUSE IS THE SPECIFICATION AND IT SETTLES THE STATE QUESTION. "Different
 * chords on different slides" is only expressible if the held chord FOLDS — if it is
 * an ordinary keyframable property that slide 2 can state differently from slide 1.
 * And "at all times" is the opposite of a moment. So:
 *
 *   A PRESS is LIVE  — a moment. Module scratch, an overlay, gone at pointer-up.
 *   A LATCH is STATE — a value. `heldNotes`, folded, keyframed, saved, EXPORTED.
 *
 * Both reach the engine through the same `noteRoutes`, so a latched note and a
 * pressed one sound identical; what differs is who is holding the key. Two
 * consequences that are features rather than quirks: a rendered video of a deck
 * whose keyboard holds a chord CONTAINS that chord (a press still records nothing,
 * which core/control_nodes.js calls correct), and a slide change no longer silences
 * it — web/audioMirror.releaseAllLiveNotes re-asserts the latch it just cleared,
 * because the release exists to catch a pointer-up the new slide never saw and a
 * latch had no pointer-up to miss.
 *
 * THE LOCK GOVERNS THE GESTURE, NOT THE SOUND. `heldNotes` sounds and paints
 * whenever it is non-empty, `keyLock` on or off. Gating the chord on the switch
 * would make the Held Notes rows list notes that produce nothing — an Inspector
 * showing state the patch does not have, which is the exact complaint
 * (core/live_control.js's "clearly state that's not visible in properties") that
 * this widget has already been repaired for once.
 *
 * IN THE PRESENTER A PRESS ALWAYS PLAYS, lock or no lock, and that is a boundary
 * rather than an omission: latching is an EDIT (one property write, one undo unit),
 * and web/PresentMode.svelte does not write the document. So an author latches a
 * chord in the editor and plays OVER it during the show, which is what a sustain
 * pedal is for.
 *
 * ── COMPUTER-KEYBOARD MAPPING: SHIPPED, AND THE v1 REFUSAL WAS OVERRULED ────
 * v1's docblock refused this outright. Its ARGUMENT was right and its CONCLUSION
 * was wrong, which is worth stating because the argument survives verbatim as the
 * design: "a tracker-style mapping wants Z-M and Q-P, and those letters are
 * already shortcuts … a key that is registered twice is exactly the ambiguity
 * [the registry] exists to prevent … a computer keyboard mapping wants its own
 * explicit 'capture keys' mode, which is a designed feature rather than a cheap
 * addition."
 *
 * THE USER ASKED FOR EXACTLY THAT DESIGNED FEATURE (2026-08-03, verbatim):
 * "WHen I double click a keyboard, my mouse keyboard shoulld be able to use it
 * (see VoiceThing … use those keys as reference. Make it clear that this is
 * happening — the widget should show a keyboard icon on it and change color a bit
 * when selected, and show all the key regular keyboard names qwerty etc names on
 * the piano keyboard)". ("my mouse keyboard" = my computer keyboard.)
 *
 * So the letters ARE taken — but only inside an explicit MODE the user entered by
 * double-clicking this widget, and the eviction is expressed IN the registry
 * rather than around it: web/keyboardPlay.js declares one registry entry per
 * playable key, all scoped `when: inCanvasMode("keyboard_play")`, so Q means "play
 * a note" only while the mode is live and means whatever it always meant the rest
 * of the time. Nothing is registered twice in one context, the HintBar narrates
 * the mode, and Escape leaves. A SELECTED keyboard does NOT swallow typing —
 * selection is not the mode.
 *
 * ── WHICH KEYS: VoiceThing's, NOT OURS ──────────────────────────────────────
 * The user named a reference app and told us to use its keys, so QWERTY_KEY_NOTES
 * below is `PianoWidget.KEYBOARD_MAP` from
 * /opt/homebrew/lib/python3.10/site-packages/rp/git/voicething/piano.py:45-94,
 * transposed into this widget's frame (see that constant's own note).
 */

import { controlDefaults, controlNodeHeight, controlNodePlugin, CONTROL_CAT, CONTROL_FAMILY } from "../core/control_nodes.js";
import { familyCard, familyRim, nodeFamily, portBeads, NODE_HEADER_H } from "../core/node_chrome.js";
import { SEMITONES_PER_OCTAVE, keyAt, keyLayout, noteName } from "../core/keyboard_layout.js";
import { visibleElements, visibleIndices, withElementPurged } from "../core/lists.js";
import { noteFrequency } from "../core/live_control.js";
import { props } from "../core/properties.js";
import { path, rect, text } from "../render_gpu/ir.js";

/** Two octaves at a width that fits a slide beside a patch: wide enough for a
 *  two-handed chord, narrow enough not to dominate the canvas. */
const DEFAULT_OCTAVES = 2;
const DEFAULT_BASE_NOTE = 48; // C3 — low enough for a pad's root, high enough to be melodic
const DEFAULT_W = 252;

/** The playing area's inset from the card's edges. */
const FACE_INSET = 8;
const FACE_BOTTOM_GAP = 8;
const KEY_RADIUS = 2;
const LABEL_SIZE = 8;

/** The keys' NATURAL height — two rows of white key plus the black keys' overhang
 *  read comfortably at this size, and it is what the card was born with before the
 *  face was derived. Unchanged by R7-13: what changed is where it is PUT. */
const KEYS_NATURAL_H = 64;

/**
 * THE FACE DECLARATION — WHAT the keys need, never WHERE they go (R7-10).
 *
 * ── THIS WIDGET WAS THE LAST ONE OUTSIDE THE SINGLE LAYOUT PATH ─────────────
 * It hand-placed its face at `NODE_HEADER_H + 8` and took no `Math.abs`, and the
 * manifest recorded both. MEASURED before the fix, at the DEFAULT size: the card's
 * `nodeBodyTop` is **70** (two output ports, `pitch` and `gate`) and the hand-placed
 * face started at **32** — so the keys were painted straight THROUGH both port rows
 * and their labels, at every size, on a widget nobody had resized. It passed
 * `tests/node_chrome_layout_test.js` only because `Math.max(0, …)` floored its
 * height at 0, which is the "containment by flooring" the sweep was written to
 * catch and could not see.
 *
 * ELASTIC (`grow: true`): a keyboard on a tall card should BE tall, exactly like a
 * fader's track — its height is a range, not a proportion, so the band takes the
 * room it is given rather than shrinking to keep a shape.
 */
const KEYBOARD_FACE = {
  height: KEYS_NATURAL_H, grow: true, inset: FACE_INSET, bottomPad: FACE_BOTTOM_GAP,
};
/** How far above a white key's bottom edge a label's BASELINE sits — enough
 *  that its descenders stay inside the key rather than under the card's rim. */
const LABEL_BOTTOM_GAP = 7;

/** The keyboard badge in the header. `ICON_RIGHT_INSET` clears the family glyph,
 *  which `familyCard` right-aligns within `w - NODE_PAD`; `ICON_MIN_LEFT` is the
 *  x the title text starts at, so the badge is dropped rather than drawn over the
 *  word "Keyboard" on a card too narrow for both. */
const ICON_W = 18;
const ICON_H = 12;
const ICON_PAD = 1.5;
const ICON_RIGHT_INSET = 22;
const ICON_MIN_LEFT = 62;

const PORTS = {
  inputs: [],
  outputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "gate", type: "trigger", label: "gate" },
  ],
};

/**
 * The card's NATURAL height, DERIVED from the same declaration the face is placed
 * by rather than written down beside it.
 *
 * IT GREW FROM 104 TO 142 AND THAT IS THE FIX, NOT A COST. 104 was the height at
 * which a 64-tall face starting at y=32 ended one gap above the rim — and y=32 was
 * the hand-placed top that overlapped the ports. Sized from `nodeBodyTop` (70), the
 * same 64 units of keys need 70 + 64 + 8. A keyboard born at 104 today would draw
 * its keys correctly and simply have less of them visible, which is the reflow
 * ladder working; being born at its natural size is what stops it starting there.
 */
const DEFAULT_H = controlNodeHeight(KEYBOARD_FACE, PORTS);

/**
 * COMPUTER KEY → SEMITONE ABOVE THE KEYBOARD'S BASE NOTE.
 *
 * ── THIS IS VoiceThing's TABLE, TRANSPOSED, NOT A NEW ONE ───────────────────
 * Source: `PianoWidget.KEYBOARD_MAP`, /opt/homebrew/lib/python3.10/site-packages/
 * rp/git/voicething/piano.py:45-94. The user named that app as the reference and
 * said "use those keys", so the KEY→KEY RELATIONSHIPS here are copied rather than
 * designed, and the layout comment is theirs:
 *
 *     2 3   5 6 7   9 0   =        <- black keys (number row)
 *    Q W E R T Y U I O P [ ] \     <- white keys (QWERTY row)
 *     S D   G H J   L ;            <- black keys (home row)
 *    Z X C V B N M , . /           <- white keys (bottom row)
 *
 * THE ONE TRANSFORMATION, and why it is not a change of mapping. VoiceThing counts
 * semitones from A4 (its `Key_Z: -9` is C4); this widget's keys are MIDI notes
 * counted from `baseNote`, whose leftmost key is a C. Adding 9 to every VoiceThing
 * value rebases the identical table onto that C: Z (their lowest, C4) becomes 0,
 * so the BOTTOM ROW plays the keyboard's own first octave and the QWERTY ROW plays
 * the one above it — exactly the two-octave, two-handed relationship VoiceThing
 * draws, on a widget whose default `octaves` is 2. Every interval is preserved
 * because one constant was added to every entry.
 *
 * VoiceThing's `Key_Tab: -9` is DROPPED. It duplicates Z, and Tab is the app's
 * focus-traversal key — binding it would take a key the user needs to leave a
 * mode from a mode that also binds Escape, for a note already reachable.
 *
 * ── THE TABLE IS NOT INJECTIVE, AND THAT IS THE REFERENCE'S OWN SHAPE ───────
 * MEASURED, not assumed: five semitones have TWO keys, because VoiceThing's two
 * rows overlap by more than an octave — `,` and `Q` are both C5 (12), `.`/`W`
 * both D5, `/`/`E` both E5, `L`/`2` both C#5, `;`/`3` both D#5. Kept, because it
 * is what the user pointed at and because it is genuinely useful: the overlap is
 * what lets two hands meet in the middle without either leaving its row.
 *
 * The consequence is that the INVERSE needs a rule, and `qwertyKeyForSemitone`
 * states it: the LOWER-ROW key wins the label. A piano key can only carry one
 * label, and labelling the overlap with the lower row keeps each printed row
 * unbroken — the whites read Z X C V B N M , . / straight across instead of
 * breaking mid-row into QWERTY letters, and the blacks read S D G H J then the
 * number row. Both keys still SOUND; only the label picks one.
 *
 * MEASURED, because the obvious implementation gets it right for a reason that is
 * NOT obvious. `Object.entries` yields INTEGER-LIKE keys first, in numeric order,
 * regardless of where they are written — so a plain first-wins scan sees the
 * DIGITS before any letter. That happens to be correct here rather than by luck
 * being wrong: the only semitones a digit shares are 13 and 15, which are BLACK
 * keys, and the number row is exactly where the black labels belong (L/; lose to
 * 2/3, which is the row the layout comment above draws them on). Every remaining
 * collision is between two non-integer keys, where insertion order holds and the
 * bottom row is written first. `qwertyKeyForSemitone`'s doctests pin all five.
 *
 * Keys are registry tokens (core/shortcuts.js): letters and digits UPPERCASE,
 * punctuation as its unshifted character.
 */
export const QWERTY_KEY_NOTES = Object.freeze({
  // BOTTOM ROW — whites, the keyboard's first octave (C D E F G A B C D E).
  Z: 0, X: 2, C: 4, V: 5, B: 7, N: 9, M: 11, ",": 12, ".": 14, "/": 16,
  // HOME ROW — the blacks between them (C# D# F# G# A# C# D#). No F and no K:
  // there is no black key between E-F or B-C, which is the whole reason the
  // pattern looks irregular (core/keyboard_layout.js states it once).
  S: 1, D: 3, G: 6, H: 8, J: 10, L: 13, ";": 15,
  // QWERTY ROW — whites, one octave up (C D E F G A B C D E F G A).
  Q: 12, W: 14, E: 16, R: 17, T: 19, Y: 21, U: 23, I: 24, O: 26, P: 28,
  "[": 29, "]": 31, "\\": 33,
  // NUMBER ROW — the blacks above those (C# D# F# G# A# C# D# F#).
  2: 13, 3: 15, 5: 18, 6: 20, 7: 22, 9: 25, 0: 27, "=": 30,
});

/**
 * Pure function. SEMITONE ABOVE BASE → the computer key LABELLED on that piano
 * key, or null past the mapping.
 *
 * The INVERSE of QWERTY_KEY_NOTES, built once so the painter and the key router
 * cannot disagree about which computer key a piano key advertises. The table is
 * NOT injective (see its docblock), so this is FIRST-WINS over `Object.entries`,
 * and the doctests below pin every one of the five collisions — a label that
 * silently flipped rows would make the printed keyboard unreadable without any
 * test noticing.
 *
 * @param {number} semitone - semitones above the keyboard's base note
 * @returns {string|null} the computer key's label, or null past the mapping
 *
 * @example qwertyKeyForSemitone(0) // "Z"
 * @example qwertyKeyForSemitone(1) // "S"
 * @example // THE FIVE COLLISIONS. The whites keep the bottom row unbroken…
 * @example qwertyKeyForSemitone(12) // ","
 * @example qwertyKeyForSemitone(14) // "."
 * @example qwertyKeyForSemitone(16) // "/"
 * @example // …and the blacks keep the number row, which is where they are drawn
 * @example qwertyKeyForSemitone(13) // "2"
 * @example qwertyKeyForSemitone(15) // "3"
 * @example // above the overlap the QWERTY row labels alone
 * @example qwertyKeyForSemitone(17) // "R"
 * @example // the mapping runs out well before a wide keyboard does
 * @example qwertyKeyForSemitone(40) // null
 */
export function qwertyKeyForSemitone(semitone) {
  return SEMITONE_KEYS.get(semitone) ?? null;
}

const SEMITONE_KEYS = new Map();
for (const [key, semitone] of Object.entries(QWERTY_KEY_NOTES))
  if (!SEMITONE_KEYS.has(semitone)) SEMITONE_KEYS.set(semitone, key);

/**
 * Pure function. WHICH NOTE a computer key plays on THIS keyboard, or null.
 *
 * The seam web/keyboardPlay.js calls per keydown. It returns the same
 * `{note, frequency}` shape `keyboardNoteAt` returns for a pointer, deliberately:
 * the two entrances to a note must produce identical events, or a wired synth
 * would sound different depending on how it was played.
 *
 * @param {object} s - the folded item state
 * @param {string} key - a registry key token ("Q", "2", ";")
 * @returns {{note: number, frequency: number}|null}
 *
 * @example keyboardNoteForKey({baseNote: 48}, "Z").note // 48
 * @example keyboardNoteForKey({baseNote: 48}, "Q").note // 60
 * @example // a key outside the mapping plays nothing
 * @example keyboardNoteForKey({baseNote: 48}, "F") // null
 * @example Math.round(keyboardNoteForKey({baseNote: 48}, "Z").frequency) // 131
 */
export function keyboardNoteForKey(s, key) {
  const semitone = QWERTY_KEY_NOTES[key];
  if (semitone === undefined) return null;
  const note = keyboardRange(s).baseNote + semitone;
  return { note, frequency: noteFrequency(note) };
}

/**
 * Pure function. Every computer key that plays a note ON A KEYBOARD THIS WIDE —
 * the entries web/keyboardPlay.js registers, and nothing beyond the last key.
 *
 * SCOPED TO THE WIDGET'S OWN RANGE because a key bound to a note the keyboard does
 * not draw is a shortcut with no picture: it would sound, silently, from a key the
 * user cannot see pressed. The label on the piano and the registry entry therefore
 * come from ONE list.
 *
 * TWO ENTRIES MAY CARRY THE SAME NOTE — the reference table's overlap (`,` and `Q`
 * are both C5). Both are registered and both sound, which is what the reference
 * does; only the printed LABEL picks one (qwertyKeyForSemitone).
 *
 * @param {object} s - the folded item state
 * @returns {Array<{key: string, note: number, frequency: number}>}
 *
 * @example // one octave reaches the 12 keys of the bottom two rows
 * @example playableKeys({baseNote: 48, octaves: 1}).length // 12
 * @example playableKeys({baseNote: 48, octaves: 1}).find((k) => k.key === "Z").note // 48
 * @example // two octaves add the QWERTY and number rows: 29 keys for 24 notes
 * @example playableKeys({baseNote: 48, octaves: 2}).length // 29
 * @example // …because the rows overlap, so one note has two keys
 * @example playableKeys({baseNote: 48, octaves: 2}).filter((k) => k.note === 60).map((k) => k.key).sort() // [",", "Q"]
 * @example playableKeys({}).every((k) => k.note >= 48) // true
 */
export function playableKeys(s) {
  const { baseNote, octaves } = keyboardRange(s);
  const span = octaves * SEMITONES_PER_OCTAVE;
  return Object.entries(QWERTY_KEY_NOTES)
    .filter(([, semitone]) => semitone < span)
    .map(([key, semitone]) => ({ key, note: baseNote + semitone, frequency: noteFrequency(baseNote + semitone) }));
}

/**
 * Query (reads the plugin's own face declaration). The PLAYING AREA's rect in
 * LOCAL coordinates — the box the keys are laid out inside.
 *
 * ── IT NO LONGER COMPUTES ANYTHING; IT ASKS (R7-10) ─────────────────────────
 * One line, delegating to `plugin.controlFace`, which is `core/control_nodes.
 * controlFace` over KEYBOARD_FACE. That is the whole of the "last node outside the
 * single layout path" repair: the sign resolution (a FLIPPED keyboard used to place
 * its face at a negative width — `nodeBox` owns that now), the port clearance and
 * the reflow ladder all arrive from the one place every other node reads them.
 *
 * Kept as a named export rather than inlined because `keyboardKeys`, the hit test
 * and web/keyboardPlay.js all want the rect and none of them should have to know
 * which factory built this plugin.
 *
 * @param {object} s - the folded item state
 * @returns {{x: number, y: number, w: number, h: number, scale: number}}
 *
 * @example // the card's natural size: below both port rows, inset, clear of the rim
 * @example keyboardFace({w: 252, h: 142}) // {x: 8, y: 70, w: 236, h: 64, scale: 1}
 * @example // an ELASTIC face takes a tall card's room instead of leaving it
 * @example keyboardFace({w: 252, h: 242}).h // 164
 * @example // a FLIPPED card is a reflection, not a negative face
 * @example keyboardFace({w: -252, h: -142}).w // 236
 */
export function keyboardFace(s) {
  return nodeKeyboardPlugin.controlFace(s ?? nodeKeyboardPlugin.defaults);
}

/**
 * Pure function. THE LATCHED CHORD — the MIDI notes this keyboard is holding down,
 * ascending and deduplicated.
 *
 * ── THIS IS DOCUMENT STATE, AND THE PRESS SET IS NOT ────────────────────────
 * The distinction is R7-13's whole design, so it is stated here rather than left to
 * be inferred. `core/live_control.pressedNotes` answers "which keys are under a
 * finger RIGHT NOW" — a moment, module scratch, never saved, and an export plays
 * none of them, which that module's own ruling calls correct. THIS answers "which
 * keys is this keyboard HOLDING" — a value the author set, folded from the
 * document, keyframable per slide, and it renders in an export because the deck
 * genuinely contains a held chord. Same widget, two different kinds of state, and
 * `emit()` may read exactly one of them (this one).
 *
 * HIDDEN ENTRIES ARE NOT HELD. `heldNotesActive` is the list's ordinary visibility
 * companion (core/lists.js), so hiding an entry silences that note while keeping its
 * index — which is what lets `heldNotes.2.note` stay bound to the same voice.
 *
 * ROUNDED AND DEDUPLICATED because the consumer is a SET: a voice pool keys a note
 * by its number, so two entries for 60 are one sounding note, and a tweened 60.4 is
 * not a pitch any key on this keyboard draws.
 *
 * @param {object} s - the folded item state
 * @returns {number[]} MIDI note numbers, ascending
 *
 * @example latchedNotes({heldNotes: [[60], [64], [67]]}) // [60, 64, 67]
 * @example // unlatched keyboards hold nothing, which is the resting state
 * @example latchedNotes({}) // []
 * @example // a HIDDEN entry keeps its index and stops sounding
 * @example latchedNotes({heldNotes: [[60], [64], [67]], heldNotesActive: [true, false, true]}) // [60, 67]
 * @example // a set, in pitch order, whatever order they were latched in
 * @example latchedNotes({heldNotes: [[67], [60], [67]]}) // [60, 67]
 * @example // a tween lands between two notes; a keyboard has no quarter-tones
 * @example latchedNotes({heldNotes: [[60.4]]}) // [60]
 */
export function latchedNotes(s) {
  const visible = visibleElements(HELD_NOTES_LIST, { list: s?.heldNotes ?? [], active: s?.heldNotesActive });
  const notes = new Set();
  for (const element of visible) {
    const note = Number(Array.isArray(element) ? element[0] : element);
    if (Number.isFinite(note)) notes.add(Math.round(note));
  }
  return [...notes].sort((a, b) => a - b);
}

/**
 * Pure function. Is this keyboard's LOCK on — does a press latch instead of play?
 *
 * @param {object} s - the folded item state
 * @returns {boolean}
 *
 * @example keyboardLocked({keyLock: true}) // true
 * @example keyboardLocked({}) // false
 */
export function keyboardLocked(s) {
  return s?.keyLock === true;
}

/**
 * Pure function. THE LATCH TOGGLE — the `heldNotes` list with `note` added if it
 * was not held, or removed if it was.
 *
 * ── ONE GESTURE, ONE ANSWER, AND THE CANVAS DOES NOT KNOW THE SHAPE ─────────
 * Declared on the plugin (`noteLatch.toggle`) so web/CanvasView.svelte can turn a
 * press into a document write without knowing that a latched chord is a list of
 * one-field tuples, or that it has a visibility companion. The canvas contributes
 * the ITEM and the NOTE; this contributes what the property becomes.
 *
 * REMOVING PURGES rather than hides, and the cost is stated because core/lists.js
 * makes it a real choice: purge RENUMBERS, so an equation bound to `heldNotes.3.note`
 * comes to mean its neighbour. Hiding would preserve the index — and would then
 * make clicking the same key again APPEND a second entry for a note the list already
 * holds, so the list would grow without bound as a performer toggled a key, and the
 * Inspector would show rows for notes that are not sounding. A chord is a SET, and
 * the operation that keeps a set a set is removal.
 *
 * @param {object} s - the folded item state
 * @param {{note: number}} cell - what `noteLatch.cellAt` returned for the press
 * @returns {Array} the new `heldNotes` value
 *
 * @example toggleLatchedNote({}, {note: 60}) // [[60]]
 * @example toggleLatchedNote({heldNotes: [[60]]}, {note: 64}) // [[60], [64]]
 * @example // a second press on a latched key releases it
 * @example toggleLatchedNote({heldNotes: [[60], [64]]}, {note: 60}) // [[64]]
 * @example // a HIDDEN entry is not held, so pressing its key latches it again
 * @example toggleLatchedNote({heldNotes: [[60]], heldNotesActive: [false]}, {note: 60}) // [[60], [60]]
 */
export function toggleLatchedNote(s, cell) {
  const note = cell.note;
  const list = Array.isArray(s?.heldNotes) ? s.heldNotes : [];
  const value = { list, active: s?.heldNotesActive };
  // The FIRST VISIBLE entry for this note. There is normally at most one — this
  // function only ever appends a note that is not already held — so "first" is a
  // total answer rather than a choice among several.
  const index = visibleIndices(value)
    .find((i) => Math.round(Number(Array.isArray(list[i]) ? list[i][0] : list[i])) === note);
  if (index === undefined) return [...list, [note]];
  return withElementPurged(HELD_NOTES_LIST, value, index).list;
}

/** THE `heldNotes` LIST DECLARATION, read back off core/properties.js rather than
 *  restated — so the element shape this file reads and the shape the Inspector
 *  edits cannot drift (plugins/polygon.js POINTS_LIST is the precedent). */
const HELD_NOTES_LIST = props("heldNotes")[0];

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
 * The FACE is an argument with a default rather than always re-derived, so
 * `paint(s, face)` lays out the keys in the rect the factory HANDED it instead of
 * asking for the rect a second time. Same answer either way — that is the point —
 * but only one of the two can go stale if the declaration changes.
 *
 * @param {object} s - the folded item state
 * @param {object} [face] - the face rect, when the caller already has it
 * @returns {Array<object>} key records with card-local x/y
 *
 * @example nodeKeyboardPlugin.keyboardKeys({w: 252, h: 142}).length // 24
 * @example nodeKeyboardPlugin.keyboardKeys({w: 252, h: 142})[0].note // 48
 */
function keyboardKeys(s, face = keyboardFace(s)) {
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
 * @example keyboardNoteAt({w: 252, h: 142}, 12, 120).note // 48
 * @example // the header is not the keyboard: a press there drags the node
 * @example keyboardNoteAt({w: 252, h: 142}, 120, 6) // null
 * @example // …and neither are the PORT ROWS, which the face now sits below
 * @example keyboardNoteAt({w: 252, h: 142}, 120, 50) // null
 * @example Math.round(keyboardNoteAt({w: 252, h: 142}, 12, 120).frequency) // 131
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
  face: KEYBOARD_FACE,
  defaults: controlDefaults("node_keyboard", DEFAULT_W, DEFAULT_H, {
    baseNote: DEFAULT_BASE_NOTE, octaves: DEFAULT_OCTAVES,
    // BOTH LATCH LEAVES ARE PRESENT AT BIRTH, and an empty list is not the same as
    // an absent one here: `heldNotes` is a LIST property, and core/deltas.js only
    // reaches a leaf a wildcard path can expand over — the same reason
    // `controlDefaults` ships `inputs: {}` rather than nothing.
    keyLock: false, heldNotes: [],
  }),
  rows: [
    { key: "baseNote", label: "Base Note", kind: "number", step: 1, category: CONTROL_CAT, help: "MIDI note of the leftmost key. 48 is C3, 60 is middle C. Raise it to put a melody in a brighter register without moving the patch." },
    { key: "octaves", label: "Octaves", kind: "number", min: 1, step: 1, category: CONTROL_CAT, help: "How many octaves of keys to draw. Each adds seven white keys; the card's width is divided among them, so a wide keyboard wants a wide node." },
    // ── THE LOCK (R7-13) ────────────────────────────────────────────────────
    // The user's "a button I click to turn on lock or not". A BOOLEAN row is that
    // button — core/properties.js's `boolean` kind is the square icon TOGGLE, one
    // click on, one click off — and it is keyframable like every other leaf, which
    // is what lets a deck arrive on slide 4 with the lock already on.
    { key: "keyLock", label: "Lock Keys", kind: "boolean", category: CONTROL_CAT, help: "Hold keys down instead of playing them. With the lock ON, clicking a key latches it and clicking it again releases it, so a chord keeps sounding while you move between slides and edit the patch — and because the held chord is an ordinary property, each slide can hold a different one. With the lock OFF a key sounds only while the pointer is on it." },
    ...props("heldNotes", { heldNotes: { category: CONTROL_CAT } }),
  ],
  /**
   * DOUBLE-CLICK ENTERS COMPUTER-KEYBOARD PLAY (user, 2026-08-03: "WHen I double
   * click a keyboard, my mouse keyboard shoulld be able to use it"). ONE STRING,
   * which is the whole point of web/widget_handlers.js: the behaviour, its HintBar
   * chips and its Escape all live in web/keyboardPlay.js and nothing here knows
   * about the DOM.
   */
  activate: "keyboard_play",
  extra: {
    /** The live-play declaration, read by the canvas and the presenter: this
     *  widget takes press-and-hold notes, and `keyboardNoteAt` says which. */
    livePlay: { noteAt: keyboardNoteAt, port: "gate", kind: "note" },
    /** THE COMPUTER-KEY declaration — web/keyboardPlay.js's CONTENT descriptor,
     *  the `knobLayout` of this handler. A widget that can be played by typing
     *  says which keys play what, and the handler turns that into registry
     *  entries; `claims` reads it so a widget shipping the table and forgetting
     *  `activate: "keyboard_play"` fails tests/activation_migration_test.js
     *  instead of silently losing the mode. */
    playableKeys,
    keyboardKeys,
    /** THE LATCH DECLARATION (R7-13) — how a press behaves on THIS widget and where
     *  the notes it writes live. Read by the canvas gesture (web/CanvasView.svelte
     *  startLivePlay) and by the audio mirror's latched-note seam, so neither needs
     *  the widget roster: `locked` says whether a press latches instead of playing,
     *  `cellAt` hit-tests, `toggle` says what the property becomes, `notesKey` names
     *  the leaf, and `notes` reads the sounding set back. plugins/node_piano_roll.js
     *  declares the same five and inherits both consumers with no code in either. */
    noteLatch: {
      locked: keyboardLocked, cellAt: keyboardNoteAt, toggle: toggleLatchedNote,
      notesKey: "heldNotes", notes: latchedNotes,
    },
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
   * Pure function. The card, the keys, their labels, the play-mode icon, the
   * beads, the rim.
   *
   * WHICH KEYS ARE UNDER A FINGER IS NOT READ HERE. A PRESS is live input, so
   * painting it would make Δt = 0 produce two different pictures — the determinism
   * law. The lit key is a screen-space overlay, the same seam the audio meters use
   * (web/CanvasView.svelte `pressedKeys`), and an export gets the resting keyboard,
   * which is the honest picture of a document nobody is playing.
   *
   * WHICH KEYS ARE LATCHED **IS** READ HERE, AND THAT IS NOT A LOOPHOLE (R7-13).
   * The two look identical on screen and are opposite kinds of state. A press is a
   * moment; a LATCH is a value the author set, folded from the document and
   * keyframable per slide — so it is exactly as paintable as `baseNote` is, and a
   * PNG of a slide holding a chord MUST show that chord or the picture is lying
   * about the deck. Δt = 0 still gives a byte-identical frame, because nothing here
   * reads a clock or a pointer: `latchedNotes(s)` is a pure function of `s`.
   *
   * SELECTEDNESS IS STILL NOT PAINTED, for the category reason one frame down:
   * selection is editor state, so a PNG must not depend on what the author had
   * clicked. The user asked for the widget to "change color a bit when selected"
   * and it does — in the overlay, beside the pressed keys.
   *
   * WHAT IS PAINTED HERE is everything TRUE OF THE DOCUMENT: the keyboard icon
   * (this widget is playable — a permanent fact about the type), the lock badge
   * (`keyLock`), the latched keys, and the QWERTY key names (which computer key
   * plays which piano key — a pure function of `baseNote`).
   *
   * @param {object} s - the folded item state
   * @param {object} face - the playing area, HANDED here by the factory (R7-10)
   */
  paint(s, face) {
    const keys = keyboardKeys(s, face);
    const { baseNote } = keyboardRange(s);
    const held = new Set(latchedNotes(s));
    const ops = [...familyCard(s, "Keyboard", CONTROL_FAMILY)];
    // Whites first, then blacks — keyLayout's paint order, preserved, because a
    // black key overlaps the whites beside it.
    for (const k of keys) {
      // A LATCHED KEY IS DRAWN DOWN. Two inks rather than one wash, for the reason
      // the live overlay carries two skins (web/CanvasView.svelte .nf-key-lit): a
      // tint that reads on a pale white key is invisible on a near-black one.
      const down = held.has(k.note);
      ops.push(rect({
        x: k.x, y: k.y, w: k.w, h: k.h, cornerRadius: KEY_RADIUS,
        fill: down ? (k.black ? BLACK_KEY_HELD_INK : WHITE_KEY_HELD_INK) : (k.black ? BLACK_KEY_INK : WHITE_KEY_INK),
        stroke: KEY_EDGE_INK, strokeWidth: 0.75,
      }));
    }
    // ── THE LABELS (user: "show all the key regular keyboard names qwerty etc
    //    names on the piano keyboard") ────────────────────────────────────────
    // Every PLAYABLE key wears the computer key that plays it. Keys past the
    // mapping stay BLANK rather than falling back to a note name: a label is a
    // promise that pressing that character sounds this key, and a note name in the
    // same slot, in the same ink, would read as the same promise and be false.
    //
    // This REPLACES the C-every-octave note names, and losing them is a real cost
    // paid deliberately: two labels per key is the wall of text the old comment
    // warned about, and between "which computer key is this" and "which note is
    // this" the user asked for the first. The note name survives where it is
    // unambiguous and unlimited — the Inspector's Base Note help, and the C is
    // still findable because it is the white key left of every two-black group.
    for (const k of keys) {
      const label = qwertyKeyForSemitone(k.note - baseNote);
      if (!label) continue;
      ops.push(text({
        // INSIDE the key, clear of its bottom edge. The first version used
        // `h - LABEL_SIZE/2`, which is a BASELINE that close to the edge — so
        // the glyphs' descenders fell outside the key and the card's rim cut
        // through them. Caught on a rendered still, not by a test: an op's `y`
        // is a baseline and no assertion knows how tall a glyph is.
        text: label, x: k.x, y: k.y + k.h - LABEL_BOTTOM_GAP,
        size: LABEL_SIZE, color: k.black ? BLACK_KEY_LABEL_INK : KEY_LABEL_INK,
        boxW: k.w, boxStyle: { align: "center" },
      }));
    }
    ops.push(...keyboardIconOps(s));
    ops.push(...lockBadgeOps(s));
    ops.push(...portBeads(nodeKeyboardPlugin, s));
    ops.push(...familyRim(s, CONTROL_FAMILY));
    return ops;
  },
});

/**
 * Pure function. THE KEYBOARD ICON — the badge that says this widget is played by
 * the computer keyboard (user: "the widget should show a keyboard icon on it").
 *
 * ── DRAWN AS RECTS, NOT AS AN ICON FONT OR AN `mdi:` NAME ───────────────────
 * The plugin's `icon: "mdi:piano"` is a PALETTE icon: the command list is DOM and
 * can mount `iconify-icon`. A display list cannot — there is no icon op in
 * render_gpu/ir.js, and the only way to put a symbol in one is a text op with a
 * glyph, which is the path currently producing literal "No Glyph" boxes on other
 * nodes (WORKSTREAM CA). Eight rects need no font, no atlas and no network, and
 * render identically in Skia, the PDF backend, the SVG backend and bare-node
 * cli/render.js. For a shape this simple that is strictly better than a glyph.
 *
 * It reads as a computer keyboard rather than a piano ON PURPOSE — a piano icon on
 * a piano widget says nothing, and the fact being advertised is "your COMPUTER
 * keyboard plays this".
 *
 * IN THE HEADER, LEFT OF THE FAMILY GLYPH's corner, so it cannot collide with the
 * title (which grows rightward from the pad) or with the family mark (which is
 * pinned to the right edge).
 *
 * @param {object} s - the folded item state
 * @returns {object[]} display-list commands
 *
 * @example keyboardIconOps({w: 252, h: 104}).length // 8 (the shell, six keys, a spacebar)
 * @example keyboardIconOps({w: 252, h: 104})[0].op // "rect"
 * @example // a card too narrow for the badge draws none of it rather than a smear
 * @example keyboardIconOps({w: 40, h: 104}) // []
 */
export function keyboardIconOps(s) {
  const w = s?.w ?? 0;
  const x = w - ICON_RIGHT_INSET - ICON_W;
  if (x < ICON_MIN_LEFT) return [];
  const y = (NODE_HEADER_H - ICON_H) / 2;
  const accent = nodeFamily(CONTROL_FAMILY).rim;
  const ops = [rect({ x, y, w: ICON_W, h: ICON_H, cornerRadius: 1, fill: null, stroke: accent, strokeWidth: 0.75 })];
  // Two rows of three little keys plus a spacebar: the least ink that still reads
  // as a keyboard rather than as a plain rounded box.
  const keyW = (ICON_W - ICON_PAD * 4) / 3;
  const keyH = (ICON_H - ICON_PAD * 3) / 3;
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 3; col++)
      ops.push(rect({
        x: x + ICON_PAD + col * (keyW + ICON_PAD), y: y + ICON_PAD + row * (keyH + ICON_PAD),
        w: keyW, h: keyH, fill: accent,
      }));
  ops.push(rect({
    x: x + ICON_PAD, y: y + ICON_PAD + 2 * (keyH + ICON_PAD),
    w: ICON_W - ICON_PAD * 2, h: keyH, fill: accent,
  }));
  return ops;
}

/**
 * Pure function. THE LOCK BADGE — a small padlock, drawn only while `keyLock` is on.
 *
 * ── WHY THE CARD SAYS SO AND NOT JUST THE INSPECTOR ─────────────────────────
 * With the lock on, a click LATCHES instead of playing, which is a different
 * response to the same gesture. A widget whose gesture changed with nothing on its
 * face to say so is the inert-control lie in reverse: the control works and the
 * author cannot tell which mode they are in. The Inspector row is the switch; this
 * is the state, visible from wherever the card is.
 *
 * DRAWN AS TWO PRIMITIVES for the reason `keyboardIconOps` records at length: there
 * is no icon op in a display list, and a text glyph is the path that renders literal
 * "No Glyph" boxes headlessly. A rect body and a semicircular shackle need no font,
 * no atlas and no network, and are identical in Skia, PDF, SVG and bare-node
 * cli/render.js.
 *
 * PLACED LEFT OF THE KEYBOARD BADGE, sharing its right-inset arithmetic, so the two
 * cannot overlap and neither can reach the family mark. It is dropped on a card too
 * narrow for it rather than drawn over the title — the same rule, one slot along.
 *
 * @param {object} s - the folded item state
 * @returns {object[]} display-list commands
 *
 * @example // the lock off is the default, and it draws nothing at all
 * @example lockBadgeOps({w: 252, h: 142}) // []
 * @example lockBadgeOps({w: 252, h: 142, keyLock: true}).length // 2
 * @example lockBadgeOps({w: 252, h: 142, keyLock: true})[0].op // "path" (the shackle)
 * @example lockBadgeOps({w: 252, h: 142, keyLock: true})[1].op // "rect" (the body)
 * @example // a card too narrow for both badges draws neither rather than a smear
 * @example lockBadgeOps({w: 80, h: 142, keyLock: true}) // []
 */
export function lockBadgeOps(s) {
  if (!keyboardLocked(s)) return [];
  const w = Number(s?.w);
  const x = (Number.isFinite(w) ? Math.abs(w) : 0) - ICON_RIGHT_INSET - ICON_W - LOCK_GAP - LOCK_W;
  if (x < ICON_MIN_LEFT) return [];
  const accent = nodeFamily(CONTROL_FAMILY).rim;
  const bodyY = (NODE_HEADER_H - ICON_H) / 2 + ICON_H - LOCK_BODY_H;
  const r = LOCK_W / 2 - LOCK_SHACKLE_INSET;
  const cx = x + LOCK_W / 2;
  return [
    // The shackle: a half circle standing on the body's top edge.
    path({
      d: `M ${cx - r} ${bodyY} A ${r} ${r} 0 0 1 ${cx + r} ${bodyY}`,
      fill: null, stroke: accent, strokeWidth: 1,
    }),
    rect({ x, y: bodyY, w: LOCK_W, h: LOCK_BODY_H, cornerRadius: 1, fill: accent }),
  ];
}

/** The padlock's box, and the gap that keeps it off the keyboard badge. Sized
 *  against ICON_H so the two badges read as one row of marks rather than two
 *  independently chosen shapes. */
const LOCK_W = 9;
const LOCK_BODY_H = 6;
const LOCK_GAP = 5;
/** How far inside the body's width the shackle's arc springs from — a shackle as
 *  wide as its body reads as a rectangle with a bump. */
const LOCK_SHACKLE_INSET = 1.5;

/** The keys. Deliberately NOT pure white and black: a full-brightness white key
 *  on a dark slide is a glare, and the node families' palette is muted
 *  throughout (ADDENDUM 6 — never gaudy). */
const WHITE_KEY_INK = "#c8cdd8";
const BLACK_KEY_INK = "#14171f";
/** A LATCHED key, in the family's own accent rather than in a new hue: "held" is a
 *  state of this widget, not a category of its own, and ADDENDUM 6 keeps the node
 *  palette to the six family accents. Two values because the keys are two colours —
 *  a wash that reads on a pale white key is invisible on a near-black one, which is
 *  exactly why the live overlay carries two skins for the same job. */
const WHITE_KEY_HELD_INK = "#7f8cc4";
const BLACK_KEY_HELD_INK = "#4a5488";
const KEY_EDGE_INK = "#0e1016";
const KEY_LABEL_INK = "#6b7280";
/** A label on a BLACK key needs the opposite contrast: KEY_LABEL_INK is a mid
 *  gray chosen against the pale white keys and is nearly invisible on #14171f. */
const BLACK_KEY_LABEL_INK = "#8b93a3";
