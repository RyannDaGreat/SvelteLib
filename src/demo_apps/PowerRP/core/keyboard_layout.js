/**
 * PIANO KEYBOARD GEOMETRY — where the keys are, and which one a point lands on.
 *
 * ── WHY THIS IS PURE, IN CORE, AND SEPARATE FROM THE WIDGET ─────────────────
 * A keyboard's layout is genuine arithmetic with a genuine wrong answer: the
 * black keys are NOT centred between their white neighbours on a real piano, the
 * pattern is irregular (two, then three), and a hit test that gets it slightly
 * wrong produces a keyboard that plays the note next to the one you clicked. That
 * is a silent failure — the sound is a note, just not yours — so it belongs where
 * a bare-node test can pin it, exactly as core/node_knobs.js does for the dials.
 *
 * ── THE OCTAVE PATTERN, STATED ONCE ─────────────────────────────────────────
 * Twelve semitones per octave; seven are white and five are black. In semitone
 * offsets from C: white = {0, 2, 4, 5, 7, 9, 11} (C D E F G A B), black =
 * {1, 3, 6, 8, 10} (C# D# F# G# A#). There is NO black key between E-F or B-C,
 * which is why the pattern looks irregular and why a naive "black key every other
 * position" layout is wrong.
 *
 * ── BLACK KEYS ARE OFFSET, NOT CENTRED ──────────────────────────────────────
 * On a real keyboard the three-key group and the two-key group are spaced so that
 * each black key sits over the gap between two whites but NOT at its midpoint —
 * C# sits right of the C|D boundary, D# left of the D|E boundary. Reproducing
 * that faithfully at the size of a slide widget would be invisible and would
 * complicate the hit test for no gain, so this layout centres each black key on
 * its white boundary. That IS a simplification and it is written down here rather
 * than discovered: it makes the keyboard read correctly and every key hittable,
 * which is what the widget is for.
 *
 * DOM-free and painter-free: this computes NUMBERS. The widget turns them into
 * display-list ops.
 */

/** Semitone offsets of the white keys within an octave (C D E F G A B). */
export const WHITE_SEMITONES = Object.freeze([0, 2, 4, 5, 7, 9, 11]);
/** Semitone offsets of the black keys within an octave (C# D# F# G# A#). */
export const BLACK_SEMITONES = Object.freeze([1, 3, 6, 8, 10]);
/** Semitones in an octave. */
export const SEMITONES_PER_OCTAVE = 12;

/** A black key's width and height, as fractions of a white key's. The near
 *  universal proportions on real instruments; they matter because a black key
 *  too wide leaves no white key reachable between two of them. */
export const BLACK_W_FRACTION = 0.62;
export const BLACK_H_FRACTION = 0.62;

/**
 * Pure function. How many WHITE keys an octave-spanning range contains.
 *
 * @param {number} octaves - how many octaves the keyboard spans (>= 1)
 * @returns {number}
 *
 * @example whiteKeyCount(1) // 7
 * @example whiteKeyCount(2) // 14
 */
export function whiteKeyCount(octaves) {
  return Math.max(1, Math.floor(octaves)) * WHITE_SEMITONES.length;
}

/**
 * Pure function. EVERY key of a keyboard, in PAINT ORDER (whites first, then
 * blacks on top), as local rects carrying their MIDI note.
 *
 * Paint order is part of the contract, not an implementation detail: a black key
 * overlaps its white neighbours, so painting whites first is what makes the
 * picture right — and the HIT TEST must walk the same list BACKWARD, so the key
 * drawn on top is the key you hit. `keyAt` does exactly that, which is why both
 * read this one function.
 *
 * @param {object} box - {w, h} of the keyboard's playing area in LOCAL units
 * @param {number} baseNote - the MIDI note of the leftmost white key
 * @param {number} octaves - how many octaves to draw
 * @returns {Array<{note: number, black: boolean, x: number, y: number, w: number, h: number}>}
 *
 * @example keyLayout({w: 140, h: 40}, 60, 1).length // 12
 * @example // the whites come first, and there are seven of them per octave
 * @example keyLayout({w: 140, h: 40}, 60, 1).filter((k) => !k.black).length // 7
 * @example keyLayout({w: 140, h: 40}, 60, 1).filter((k) => k.black).length // 5
 * @example // the leftmost white key IS the base note, at x = 0
 * @example keyLayout({w: 140, h: 40}, 60, 1)[0].note // 60
 * @example keyLayout({w: 140, h: 40}, 60, 1)[0].x // 0
 * @example // a black key is narrower and shorter than a white one
 * @example keyLayout({w: 140, h: 40}, 60, 1).find((k) => k.black).h < 40 // true
 * @example // two octaves span twice the notes
 * @example keyLayout({w: 280, h: 40}, 48, 2).length // 24
 */
export function keyLayout(box, baseNote, octaves) {
  const n = Math.max(1, Math.floor(octaves));
  const whites = whiteKeyCount(n);
  const w = box?.w ?? 0;
  const h = box?.h ?? 0;
  const whiteW = w / whites;
  const blackW = whiteW * BLACK_W_FRACTION;
  const blackH = h * BLACK_H_FRACTION;

  const keys = [];
  for (let octave = 0; octave < n; octave++) {
    for (let i = 0; i < WHITE_SEMITONES.length; i++) {
      const index = octave * WHITE_SEMITONES.length + i;
      keys.push({
        note: baseNote + octave * SEMITONES_PER_OCTAVE + WHITE_SEMITONES[i],
        black: false, x: index * whiteW, y: 0, w: whiteW, h,
      });
    }
  }
  for (let octave = 0; octave < n; octave++) {
    for (const semitone of BLACK_SEMITONES) {
      // The black key sits on the BOUNDARY between the two white keys it lies
      // between. Its lower white neighbour is the white key one semitone below,
      // so the boundary is at that white key's right edge.
      const whiteIndex = WHITE_SEMITONES.indexOf(semitone - 1);
      const index = octave * WHITE_SEMITONES.length + whiteIndex;
      keys.push({
        note: baseNote + octave * SEMITONES_PER_OCTAVE + semitone,
        black: true,
        x: (index + 1) * whiteW - blackW / 2,
        y: 0, w: blackW, h: blackH,
      });
    }
  }
  return keys;
}

/**
 * Pure function. Which key a LOCAL point lands on, or null.
 *
 * WALKS THE LAYOUT BACKWARD, and that is the whole subtlety: black keys are
 * painted last (on top of the whites they overlap), so the last match in paint
 * order is the visible one. Front-to-back would return the white key underneath
 * a black one, which is a keyboard that plays C when you click C# — audible,
 * wrong, and with nothing on screen to explain it.
 *
 * @param {Array<object>} keys - from keyLayout
 * @param {number} lx - LOCAL x within the playing area
 * @param {number} ly - LOCAL y within the playing area
 * @returns {object|null} the key record, or null
 *
 * @example // the middle of the first white key is that white key
 * @example keyAt(keyLayout({w: 140, h: 40}, 60, 1), 5, 35).note // 60
 * @example // THE OVERLAP: a point in the black key's territory gives the BLACK
 * @example // key, not the white one painted underneath it
 * @example keyAt(keyLayout({w: 140, h: 40}, 60, 1), 20, 8).note // 61
 * @example // …and the same x LOWER DOWN, below the black key's shorter body,
 * @example // is the white key again
 * @example keyAt(keyLayout({w: 140, h: 40}, 60, 1), 20, 35).note // 62
 * @example keyAt(keyLayout({w: 140, h: 40}, 60, 1), -5, 10) // null
 */
export function keyAt(keys, lx, ly) {
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i];
    if (lx >= k.x && lx <= k.x + k.w && ly >= k.y && ly <= k.y + k.h) return k;
  }
  return null;
}

/**
 * Pure function. A MIDI note's name, for a label or a readout.
 *
 * @param {number} note - a MIDI note number
 * @returns {string}
 *
 * @example noteName(60) // "C4"
 * @example noteName(61) // "C#4"
 * @example noteName(69) // "A4"
 * @example noteName(21) // "A0"
 */
export function noteName(note) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  // MIDI 60 is C4 in the convention this app uses (Yamaha/"middle C = C4"), so
  // the octave number is floor(note/12) - 1.
  return `${names[((note % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE]}${Math.floor(note / SEMITONES_PER_OCTAVE) - 1}`;
}
