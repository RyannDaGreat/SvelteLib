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

import { controlDefaults, controlNodePlugin, CONTROL_CAT, CONTROL_FAMILY } from "../core/control_nodes.js";
import { familyCard, familyRim, nodeFamily, portBeads, NODE_HEADER_H } from "../core/node_chrome.js";
import { SEMITONES_PER_OCTAVE, keyAt, keyLayout, noteName } from "../core/keyboard_layout.js";
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
   * WHICH KEYS ARE HELD IS NOT READ HERE. Held-ness is live input, so painting it
   * would make Δt = 0 produce two different pictures — the determinism law. The
   * lit key is a screen-space overlay, the same seam the audio meters use
   * (web/CanvasView.svelte `pressedKeys`), and an export gets the resting
   * keyboard, which is the honest picture of a document nobody is playing.
   *
   * SO IS SELECTEDNESS, for the same category reason one frame down: selection is
   * editor state, not document state, so a PNG of a slide must not depend on what
   * the author had clicked. The user asked for the widget to "change color a bit
   * when selected" and it does — in the overlay, beside the pressed keys.
   *
   * WHAT IS PAINTED HERE is everything TRUE OF THE DOCUMENT: the keyboard icon
   * (this widget is playable — a permanent fact about the type) and the QWERTY key
   * names (which computer key plays which piano key — a pure function of
   * `baseNote`, and the same in an export as on screen).
   */
  paint(s) {
    const keys = keyboardKeys(s);
    const { baseNote } = keyboardRange(s);
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

/** The keys. Deliberately NOT pure white and black: a full-brightness white key
 *  on a dark slide is a glare, and the node families' palette is muted
 *  throughout (ADDENDUM 6 — never gaudy). */
const WHITE_KEY_INK = "#c8cdd8";
const BLACK_KEY_INK = "#14171f";
const KEY_EDGE_INK = "#0e1016";
const KEY_LABEL_INK = "#6b7280";
/** A label on a BLACK key needs the opposite contrast: KEY_LABEL_INK is a mid
 *  gray chosen against the pale white keys and is nearly invisible on #14171f. */
const BLACK_KEY_LABEL_INK = "#8b93a3";
