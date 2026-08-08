/**
 * THE PIANO ROLL'S GEOMETRY — beats and pitches to pixels, and back, plus the hit
 * test that decides whether a press MOVES a note or RESIZES it.
 *
 * ── WHY THIS IS IN core/ AND NOT IN THE SVELTE COMPONENT ───────────────────
 * A piano roll is a pile of coordinate arithmetic with a lot of off-by-one places
 * to hide in: which row a y lands on, whether a note's right edge belongs to the
 * note or to the empty cell after it, whether a drag that leaves the viewport
 * clamps or wraps. All of that is PURE, and pure code in `web/` can only be tested
 * by booting a browser — which is slow, flaky, and (measured on this host) can
 * fail for reasons that have nothing to do with the app.
 *
 * So the component owns the DOM and the gestures; this owns the arithmetic, and
 * `tests/piano_roll_test.js` pins it in bare node. The browser probe is then free
 * to ask the questions only a browser can answer — does the modal open, does a
 * drag write the document, is it one undo unit — instead of re-deriving what a
 * unit test already proved.
 *
 * ── THE VIEW ───────────────────────────────────────────────────────────────
 * One object threads through everything: `{beatWidth, rowHeight, originBeat,
 * topPitch}`. `originBeat` is the beat at x=0 and `topPitch` is the MIDI note of
 * the TOP row — pitch increases UPWARD, which is the one convention a piano roll
 * cannot negotiate, so the y mapping is a subtraction rather than an addition.
 * Scrolling is a change to `originBeat`/`topPitch`; zooming is a change to
 * `beatWidth`/`rowHeight`. Nothing else in the editor knows what scrolling is.
 *
 * DOM-free, clock-free: core/ runs in bare node.
 */

import { BLACK_SEMITONES, SEMITONES_PER_OCTAVE } from "./keyboard_layout.js";
import { MIDI_NOTE_MAX, MIDI_NOTE_MIN } from "./midi_clip.js";

/** How near a note's left or right edge a press must land to RESIZE rather than
 *  MOVE, in pixels. Six is about a pointer's own precision — smaller and the zone
 *  is unhittable, larger and a short note is nothing BUT edges (which is why
 *  `noteZoneAt` also caps it at a third of the note's own width). */
export const RESIZE_EDGE_PX = 6;

/** A note narrower than this is drawn and hit as a MINIMUM-width block. Without a
 *  floor, a 1/32 note at a wide zoom-out is a sub-pixel sliver that can be seen
 *  but not clicked — visible and unreachable, which is the worst of both. */
export const MIN_NOTE_PX = 3;

/** The view a freshly opened editor starts at: an eighth-note is ~14px wide, a
 *  row is 14px tall (a comfortable pointer target), the clip starts at beat 0 and
 *  the top row is C6 — high enough that a melody written around middle C sits in
 *  the lower-middle of the window rather than against the ceiling. */
export const DEFAULT_VIEW = Object.freeze({ beatWidth: 28, rowHeight: 14, originBeat: 0, topPitch: 84 });

/** The zoom limits. A beat narrower than 4px cannot show a note; wider than 400
 *  and a single bar fills a 1600px window. Row height likewise.
 *  @example ZOOM_LIMITS.beatWidth // [4, 400] */
export const ZOOM_LIMITS = Object.freeze({ beatWidth: Object.freeze([4, 400]), rowHeight: Object.freeze([5, 48]) });

/**
 * Pure function. A BEAT position as an x coordinate in the roll's own pixel space.
 *
 * @param {number} beat
 * @param {object} view - {beatWidth, originBeat, …}
 * @returns {number} pixels
 *
 * @example beatToX(0, DEFAULT_VIEW) // 0
 * @example beatToX(1, DEFAULT_VIEW) // 28
 * @example beatToX(2, {beatWidth: 28, rowHeight: 14, originBeat: 1, topPitch: 84}) // 28
 */
export function beatToX(beat, view) {
  return (beat - view.originBeat) * view.beatWidth;
}

/**
 * Pure function. An x coordinate as a BEAT position — `beatToX`'s inverse, and
 * therefore continuous (NOT snapped). Snapping is `core/midi_clip.snapBeat`, kept
 * separate because a drag needs the raw position to decide what it is doing and
 * the snapped one only when it writes.
 *
 * @param {number} x - pixels
 * @param {object} view
 * @returns {number} beats
 *
 * @example xToBeat(28, DEFAULT_VIEW) // 1
 * @example xToBeat(14, DEFAULT_VIEW) // 0.5
 * @example // never negative: the clip has no time before beat 0
 * @example xToBeat(-100, DEFAULT_VIEW) // 0
 */
export function xToBeat(x, view) {
  return Math.max(0, x / view.beatWidth + view.originBeat);
}

/**
 * Pure function. A PITCH as the y of its row's TOP edge.
 *
 * Pitch increases upward, so this SUBTRACTS: the top row (`topPitch`) is y=0 and
 * every semitone below it is one row further down.
 *
 * @param {number} pitch - a MIDI note number
 * @param {object} view - {rowHeight, topPitch, …}
 * @returns {number} pixels
 *
 * @example pitchToY(84, DEFAULT_VIEW) // 0
 * @example pitchToY(83, DEFAULT_VIEW) // 14
 * @example pitchToY(60, DEFAULT_VIEW) // 336
 */
export function pitchToY(pitch, view) {
  return (view.topPitch - pitch) * view.rowHeight;
}

/**
 * Pure function. A y coordinate as the PITCH of the row it lands in, clamped to
 * the MIDI range.
 *
 * FLOORS the row, then subtracts — so every y inside a row maps to that row's one
 * pitch, which is what makes a drag land on the note the pointer is over rather
 * than on the nearest boundary.
 *
 * @param {number} y - pixels
 * @param {object} view
 * @returns {number} a MIDI note number
 *
 * @example yToPitch(0, DEFAULT_VIEW) // 84
 * @example yToPitch(13, DEFAULT_VIEW) // 84 (still inside the top row)
 * @example yToPitch(14, DEFAULT_VIEW) // 83
 * @example yToPitch(336, DEFAULT_VIEW) // 60
 * @example // clamped: there is no note above 127 or below 0
 * @example yToPitch(-1000, DEFAULT_VIEW) // 127
 */
export function yToPitch(y, view) {
  const pitch = view.topPitch - Math.floor(y / view.rowHeight);
  return Math.max(MIDI_NOTE_MIN, Math.min(MIDI_NOTE_MAX, pitch));
}

/**
 * Pure function. A note's RECTANGLE in the roll's pixel space.
 *
 * The width is floored at `MIN_NOTE_PX` so a very short note at a wide zoom stays
 * clickable (see that constant). The height is one full row: notes butt against
 * their neighbours vertically, which is how a piano roll reads as a grid.
 *
 * @param {object} note - a note record
 * @param {object} view
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example noteRect({start: 0, duration: 1, pitch: 84}, DEFAULT_VIEW) // {x: 0, y: 0, w: 28, h: 14}
 * @example noteRect({start: 1, duration: 0.5, pitch: 83}, DEFAULT_VIEW) // {x: 28, y: 14, w: 14, h: 14}
 * @example // a sliver is floored to a hittable width
 * @example noteRect({start: 0, duration: 0.01, pitch: 84}, DEFAULT_VIEW).w // 3
 */
export function noteRect(note, view) {
  return {
    x: beatToX(note.start, view),
    y: pitchToY(note.pitch, view),
    w: Math.max(MIN_NOTE_PX, note.duration * view.beatWidth),
    h: view.rowHeight,
  };
}

/**
 * Pure function. WHICH PART of a note a point is over: its start edge, its end
 * edge, or its body — or null when the point is not on that note at all.
 *
 * ── THE EDGE ZONE IS CAPPED AT A THIRD OF THE NOTE ─────────────────────────
 * Without the cap, a note narrower than `2 * RESIZE_EDGE_PX` is ENTIRELY edges and
 * has no body, so it can be resized from either side and never moved — a note the
 * author can see and cannot drag. The cap guarantees a middle third exists at
 * every width, so every note is always movable.
 *
 * @param {object} note - a note record
 * @param {number} x - pixels
 * @param {number} y - pixels
 * @param {object} view
 * @returns {"start"|"end"|"body"|null}
 *
 * @example noteZoneAt({start: 0, duration: 4, pitch: 84}, 56, 7, DEFAULT_VIEW) // "body"
 * @example noteZoneAt({start: 0, duration: 4, pitch: 84}, 2, 7, DEFAULT_VIEW) // "start"
 * @example noteZoneAt({start: 0, duration: 4, pitch: 84}, 110, 7, DEFAULT_VIEW) // "end"
 * @example // a different row is not this note
 * @example noteZoneAt({start: 0, duration: 4, pitch: 84}, 56, 20, DEFAULT_VIEW) // null
 * @example // …and neither is past its end
 * @example noteZoneAt({start: 0, duration: 1, pitch: 84}, 200, 7, DEFAULT_VIEW) // null
 * @example // A SHORT NOTE STILL HAS A BODY: the edge zone caps at a third
 * @example noteZoneAt({start: 0, duration: 0.25, pitch: 84}, 3.5, 7, DEFAULT_VIEW) // "body"
 */
export function noteZoneAt(note, x, y, view) {
  const r = noteRect(note, view);
  if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) return null;
  const edge = Math.min(RESIZE_EDGE_PX, r.w / 3);
  if (x < r.x + edge) return "start";
  if (x >= r.x + r.w - edge) return "end";
  return "body";
}

/**
 * Pure function. THE HIT TEST: which note a point is on, and where on it.
 *
 * SEARCHES BACKWARDS, so the note drawn LAST (topmost, when two overlap on the
 * same row) is the one the pointer gets. A piano roll routinely holds overlapping
 * notes — that is what a sustained chord under a melody is — and picking the first
 * match would make the buried one unreachable while the visible one ignored
 * clicks.
 *
 * @param {Array<object>} notes - note records, in DRAW order
 * @param {number} x - pixels
 * @param {number} y - pixels
 * @param {object} view
 * @returns {{index: number, zone: string}|null}
 *
 * @example noteHitAt([{start: 0, duration: 1, pitch: 84}], 14, 7, DEFAULT_VIEW) // {index: 0, zone: "body"}
 * @example noteHitAt([{start: 0, duration: 1, pitch: 84}], 300, 7, DEFAULT_VIEW) // null
 * @example noteHitAt([], 0, 0, DEFAULT_VIEW) // null
 * @example // the LAST-drawn of two overlapping notes wins the pointer
 * @example noteHitAt([{start: 0, duration: 2, pitch: 84}, {start: 0, duration: 2, pitch: 84}], 28, 7, DEFAULT_VIEW).index // 1
 */
export function noteHitAt(notes, x, y, view) {
  for (let i = notes.length - 1; i >= 0; i--) {
    const zone = noteZoneAt(notes[i], x, y, view);
    if (zone) return { index: i, zone };
  }
  return null;
}

/**
 * Pure function. Is this pitch a BLACK key — i.e. does its row get the darker
 * lane stripe?
 *
 * The one cue that makes a bare grid readable as pitch: without it, counting
 * twelve identical rows to find a C is the only way to know where you are.
 * Reads `core/keyboard_layout.BLACK_SEMITONES` rather than restating the pattern,
 * so the modal's lanes and the widget's own painted preview cannot disagree about
 * which rows are black.
 *
 * @param {number} pitch - a MIDI note number
 * @returns {boolean}
 *
 * @example isBlackPitch(61) // true
 * @example isBlackPitch(60) // false
 * @example isBlackPitch(-1) // false
 */
export function isBlackPitch(pitch) {
  return BLACK_SEMITONES.includes(((pitch % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE);
}

/**
 * Pure function. The NAME of a MIDI note, in scientific pitch notation.
 *
 * SHARPS ONLY, and that is a limitation rather than a decision to defend: the
 * label is a landmark for scrolling, not notation, and a clip has no key signature
 * to decide between F# and Gb. (An ABC node's tune does — but its notes arrive
 * here as pitches, having already resolved that.) Octave numbering is the one
 * where middle C (60) is C4.
 *
 * @param {number} pitch - a MIDI note number
 * @returns {string}
 *
 * @example pitchName(60) // "C4"
 * @example pitchName(61) // "C#4"
 * @example pitchName(69) // "A4"
 * @example pitchName(0) // "C-1"
 */
export function pitchName(pitch) {
  const n = Math.round(pitch);
  const octave = Math.floor(n / SEMITONES_PER_OCTAVE) - 1;
  return `${PITCH_LETTERS[((n % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE]}${octave}`;
}

const PITCH_LETTERS = Object.freeze(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]);

/**
 * Pure function. THE NAME OF A GRID DIVISION, as a musician reads it.
 *
 * The snap menu's values are in BEATS (`core/midi_clip.SNAP_DIVISIONS`), because
 * that is the unit the clip stores — but "0.16666666666666666" is not a thing
 * anyone has ever asked a sequencer for. A beat is a QUARTER note, so a division
 * of `d` beats is a `1/(4/d)` note, and the three triplet divisions are named as
 * triplets rather than as the repeating decimals they are.
 *
 * NAMED, NOT COMPUTED, and the triplets are why: 1/3 of a beat is an eighth-note
 * triplet, which no round-number formatting rule produces. A computed label would
 * read "1/12" — arithmetically true, and not what the division is called.
 *
 * @param {number} beats - a division in beats
 * @returns {string}
 *
 * @example snapLabel(0) // "Off"
 * @example snapLabel(1) // "1/4"
 * @example snapLabel(0.5) // "1/8"
 * @example snapLabel(0.25) // "1/16"
 * @example snapLabel(0.125) // "1/32"
 * @example snapLabel(2) // "1/2"
 * @example snapLabel(4) // "1 bar"
 * @example // the triplets, which are the reason this is a table
 * @example snapLabel(1 / 3) // "1/8 triplet"
 * @example snapLabel(1 / 6) // "1/16 triplet"
 * @example // an undeclared division still gets a truthful label rather than "undefined"
 * @example snapLabel(0.7) // "0.7 beats"
 */
export function snapLabel(beats) {
  for (const [value, label] of SNAP_LABELS) if (Math.abs(beats - value) < 1e-9) return label;
  return `${beats} beats`;
}

/** Division (in beats) → its musical name. An ARRAY of pairs rather than an
 *  object, because two of the keys are repeating decimals and an object would
 *  compare them by string — where `1/3` stringifies to seventeen digits that a
 *  caller's own `1/3` may or may not match exactly. `snapLabel` compares with a
 *  tolerance instead. */
const SNAP_LABELS = Object.freeze([
  [0, "Off"],
  [1 / 8, "1/32"],
  [1 / 6, "1/16 triplet"],
  [1 / 4, "1/16"],
  [1 / 3, "1/8 triplet"],
  [1 / 2, "1/8"],
  [1, "1/4"],
  [2, "1/2"],
  [4, "1 bar"],
]);

/**
 * Pure function. A view SCROLLED by a pixel delta — the wheel's whole vocabulary,
 * in one place so the component holds no arithmetic.
 *
 * The pitch axis clamps so the roll cannot be scrolled off the top or bottom of
 * the MIDI range; the beat axis clamps at 0 for the same reason `xToBeat` does.
 *
 * @param {object} view
 * @param {number} dx - pixels right
 * @param {number} dy - pixels down
 * @returns {object} a new view
 *
 * @example scrolledView(DEFAULT_VIEW, 28, 0).originBeat // 1
 * @example scrolledView(DEFAULT_VIEW, 0, 14).topPitch // 83
 * @example // never before beat 0
 * @example scrolledView(DEFAULT_VIEW, -1000, 0).originBeat // 0
 * @example // never above the top of the MIDI range
 * @example scrolledView(DEFAULT_VIEW, 0, -10000).topPitch // 127
 */
export function scrolledView(view, dx, dy) {
  return {
    ...view,
    originBeat: Math.max(0, view.originBeat + dx / view.beatWidth),
    topPitch: Math.max(MIDI_NOTE_MIN, Math.min(MIDI_NOTE_MAX, view.topPitch - Math.round(dy / view.rowHeight))),
  };
}

/**
 * Pure function. A view ZOOMED by a multiplier on one axis, clamped to
 * `ZOOM_LIMITS`.
 *
 * @param {object} view
 * @param {"beatWidth"|"rowHeight"} axis
 * @param {number} factor - a multiplier (>1 zooms in)
 * @returns {object} a new view
 *
 * @example zoomedView(DEFAULT_VIEW, "beatWidth", 2).beatWidth // 56
 * @example zoomedView(DEFAULT_VIEW, "rowHeight", 0.5).rowHeight // 7
 * @example // clamped rather than unbounded, in both directions
 * @example zoomedView(DEFAULT_VIEW, "beatWidth", 1000).beatWidth // 400
 * @example zoomedView(DEFAULT_VIEW, "beatWidth", 0.001).beatWidth // 4
 */
export function zoomedView(view, axis, factor) {
  const [lo, hi] = ZOOM_LIMITS[axis];
  return { ...view, [axis]: Math.max(lo, Math.min(hi, view[axis] * factor)) };
}
