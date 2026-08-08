/**
 * ABC NOTATION → A MIDI CLIP. A parser for the subset stated below, and a LOUD
 * refusal for everything else.
 *
 * ── THE ASK (user, 2026-08-08) ──────────────────────────────────────────────
 * "…and abc language output midi nodes". So: type a tune in ABC, get a `midi`
 * stream out of a node, wire it wherever a clip goes.
 *
 * ── WHAT COMES OUT IS THE SAME THING A PIANO ROLL PRODUCES ──────────────────
 * `core/midi_clip.js`'s note record — `{start, duration, pitch, velocity}` with
 * start and duration in BEATS. That is the whole point of routing ABC through this
 * file rather than giving the ABC widget its own shape: a receiver cannot tell
 * which producer it is wired to, so an arpeggiator, a synth or a future notation
 * exporter is written once.
 *
 * The result is PROPERTY STATE end to end. The source text is a stored string, the
 * parse is a pure function of it, and the notes are therefore folded, keyframable
 * (the TEXT is), and identical on every machine. Nothing here reads a clock.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ── THE SUPPORTED SUBSET, EXHAUSTIVELY ─────────────────────────────────────
 * ═══════════════════════════════════════════════════════════════════════════
 * ABC is a real grammar with a 2.1 standard running to dozens of pages, and this
 * implements a deliberate fragment of it. The fragment is chosen to be exactly
 * "what a MONOPHONIC-OR-CHORDAL TUNE NEEDS", because that is what a clip is.
 *
 * HEADER FIELDS (before `K:`, one per line, `<letter>:<value>`):
 *   X:  reference number   — ACCEPTED AND IGNORED. It indexes a tune in a tune
 *                            BOOK; a single clip has no book. Ignoring it is not a
 *                            silent drop because it carries no note information:
 *                            there is nothing that could have been lost.
 *   T:  title              — ACCEPTED AND IGNORED, same reason.
 *   C:  composer           — ACCEPTED AND IGNORED, same reason.
 *   M:  meter              — `4/4`, `6/8`, `C` (= 4/4), `C|` (= 2/2). Sets the
 *                            BAR LENGTH (used for the grid and for accidental
 *                            scoping) and, when `L:` is absent, the default unit
 *                            note length per the standard's own rule.
 *   L:  unit note length   — `1/8`, `1/16`, `1/4`… The length a bare letter means.
 *   Q:  tempo              — `Q:120` (quarter-note BPM) or `Q:1/4=120` /
 *                            `Q:3/8=60` (a note length = a per-minute count).
 *   K:  key signature      — ENDS THE HEADER. See KEYS below.
 *
 * BODY:
 *   NOTES        `A`-`G` (the octave from middle C up: C=60 … B=71) and `a`-`g`
 *                (one octave higher: c=72 … b=83).
 *   OCTAVES      `'` raises an octave, `,` lowers one; repeatable (`c''`, `C,,`).
 *   ACCIDENTALS  `^` sharp, `^^` double sharp, `_` flat, `__` double flat,
 *                `=` natural. MEASURE-SCOPED per common practice: an accidental
 *                applies to the SAME LETTER IN THE SAME OCTAVE until the next bar
 *                line, and the key signature applies to every other occurrence.
 *   LENGTHS      `A2` (twice the unit), `A/2` or `A/` (half), `A//` (quarter),
 *                `A3/2` (dotted). Any `<int>`, `/<int>`, `<int>/<int>` or a run
 *                of `/`.
 *   RESTS        `z` and `x`, with the same length syntax. A rest emits no note
 *                and advances time — which is exactly what a gap in a clip is.
 *   CHORDS       `[CEG]` — every note STARTS TOGETHER. A length suffix after the
 *                bracket multiplies the whole chord (`[CEG]2`). This is the one
 *                place a clip is genuinely polyphonic, and it is why a clip is a
 *                better target for ABC than the step sequencer was.
 *   BAR LINES    `|`, `||`, `|]`, `[|`. They RESET the measure accidentals and
 *                nothing else — this parser does not check that a bar holds the
 *                right number of beats, because a pickup bar is legal and
 *                refusing one would reject correct music.
 *   COMMENTS     `%` to end of line. Blank lines. A comment is not a directive,
 *                so skipping one drops nothing.
 *   LINE BREAKS  A body line break is whitespace. ABC uses it for engraving, and
 *                a clip has no staves to break.
 *
 * KEYS (`K:`):
 *   A tonic `A`-`G` with optional `#`/`b`, plus an optional MODE: `maj`/`ionian`,
 *   `min`/`m`/`aeolian`, `dor`, `phr`, `lyd`, `mix`, `loc` (three letters or the
 *   full word, any case). `K:none` / `K:` (empty) means NO key signature.
 *   The mode is resolved to a position on the circle of fifths (MODE_FIFTHS) and
 *   the sharps/flats follow in the standard order, so `K:Ador` really is D dorian
 *   with no accidentals rather than D major with two sharps.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ── WHAT IS REFUSED, AND WHY IT IS REFUSED RATHER THAN IGNORED ─────────────
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE LOAD-BEARING HALF OF THE FILE. A silently-ignored ABC construct is
 * the quiet wrongness this codebase forbids: the author's tune would come out
 * missing a repeat, missing a tie, or in the wrong rhythm, with a green parse and
 * nothing to look at. Every construct below therefore produces an ERROR naming
 * itself and what to write instead, and a tune with ANY error yields NO NOTES AT
 * ALL — the project-script precedent ("a broken script exports NOTHING so its
 * callers fail through the normal equation-error path"). Half a tune is worse than
 * no tune, because half a tune looks like it worked.
 *
 *   REPEATS       `|:` `:|` `::` `[1` `[2` — these MULTIPLY the music, and a clip
 *                 is a flat list of notes. Honouring them means expansion (a real
 *                 feature); treating them as plain bar lines would silently drop
 *                 every repeat in the tune. Write the repeat out.
 *   TIES / SLURS  `-` `(` `)` — a tie MERGES two notes into one longer note, so
 *                 ignoring one turns a held note into two re-articulated ones. A
 *                 slur is phrasing with no effect on a clip, but `(` and `)` are
 *                 also the tuplet and grace-note openers, so accepting them here
 *                 would make the tuplet refusal unreachable. Write the summed
 *                 length.
 *   BROKEN RHYTHM `>` `<` — dots the note before and halves the one after (or the
 *                 reverse). Ignoring it produces even eighths where the tune says
 *                 dotted, which is a rhythm error nothing would report. Write
 *                 `A3/2 B/2`.
 *   TUPLETS       `(3` `(5` — compresses N notes into the time of M. Write the
 *                 fractional lengths.
 *   GRACE NOTES   `{…}` — ornaments with no defined duration in a clip.
 *   DECORATIONS   `!trill!` `+f+` `~` `.` and the legacy letter decorations —
 *                 performance marks with no note content. REFUSED rather than
 *                 skipped so that a typo inside one is not silently eaten.
 *   INLINE FIELDS `[K:G]` `[M:3/4]` — change the key or meter MID-TUNE, which
 *                 this parser's single-pass header cannot express. Distinguished
 *                 from a chord by the `<letter>:` after the bracket.
 *   MULTI-VOICE   `V:` — a clip is one stream. Two voices need two nodes.
 *   LYRICS        `w:` `W:` — no note content, but they interleave with the body
 *                 and would otherwise parse as a line of nonsense notes.
 *   CONTINUATION  `\` at end of line.
 *   ANY OTHER CHARACTER — reported with its line, column and the character
 *                 itself. This is the backstop that makes the list above a
 *                 STATEMENT rather than a hope: a construct nobody thought about
 *                 cannot slip through as a no-op.
 *
 * DOM-free, engine-free, clock-free: core/ runs in bare node.
 */

import { DEFAULT_VELOCITY, sortedNotes } from "./midi_clip.js";

/** Semitone above the octave's C for each note letter. The white keys, in the
 *  order the alphabet puts them rather than the order a keyboard does.
 *  @example LETTER_SEMITONES.C // 0
 *  @example LETTER_SEMITONES.B // 11 */
export const LETTER_SEMITONES = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

/** MIDI note of ABC's uppercase octave's C — middle C, which is what `C` means.
 *  @example MIDDLE_C // 60 */
export const MIDDLE_C = 60;

/** The order sharps and flats are added to a key signature. Both are fixed by
 *  five centuries of practice, and each is the other reversed.
 *  @example SHARP_ORDER[0] // "F"
 *  @example FLAT_ORDER[0] // "B" */
export const SHARP_ORDER = Object.freeze(["F", "C", "G", "D", "A", "E", "B"]);
export const FLAT_ORDER = Object.freeze(["B", "E", "A", "D", "G", "C", "F"]);

/** Position on the circle of fifths of each MAJOR key's tonic — how many sharps
 *  (positive) or flats (negative) it carries.
 *  @example MAJOR_FIFTHS.C // 0
 *  @example MAJOR_FIFTHS.G // 1
 *  @example MAJOR_FIFTHS.F // -1 */
export const MAJOR_FIFTHS = Object.freeze({ C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1 });

/**
 * How far a MODE sits from the major key on the same tonic, in fifths.
 *
 * DERIVED FROM THE MODE'S OWN DEFINITION, not memorized: D dorian has no
 * accidentals and D major has two sharps, so dorian is -2. Every entry checks the
 * same way, which is why they are worth stating as a table rather than as a
 * rotation — a rotation would need the reader to trust the direction.
 *
 * @example MODE_FIFTHS.dor // -2
 * @example MODE_FIFTHS.min // -3
 * @example MODE_FIFTHS.maj // 0
 * @example MODE_FIFTHS.mix // -1
 */
export const MODE_FIFTHS = Object.freeze({
  maj: 0, ion: 0,
  dor: -2,
  phr: -4,
  lyd: 1,
  mix: -1,
  min: -3, aeo: -3,
  loc: -5,
});

/**
 * Pure function. The KEY SIGNATURE a `K:` value describes: `{letter: offset}` in
 * semitones, for every letter the key alters.
 *
 * Returns `{signature, error}` — the error is a SENTENCE when the key cannot be
 * read, and the signature is then empty. Never throws: a half-typed key is an
 * ordinary state of a text field being edited, not an exception.
 *
 * @param {string} value - the text after `K:`
 * @returns {{signature: object, error: string|null}}
 *
 * @example keySignature("C") // {signature: {}, error: null}
 * @example keySignature("G").signature // {F: 1}
 * @example keySignature("F").signature // {B: -1}
 * @example keySignature("D").signature // {F: 1, C: 1}
 * @example // A MINOR is the relative minor of C: no accidentals at all
 * @example keySignature("Am").signature // {}
 * @example // …and D DORIAN likewise, which is the whole reason modes are supported
 * @example keySignature("Ddor").signature // {}
 * @example keySignature("none").signature // {}
 * @example keySignature("Bb").signature // {B: -1, E: -1}
 * @example // an unreadable key is a sentence, never a silent default
 * @example typeof keySignature("H7").error // "string"
 */
export function keySignature(value) {
  const text = String(value ?? "").trim();
  if (text === "" || /^none$/i.test(text)) return { signature: {}, error: null };
  const m = /^([A-Ga-g])([#b]?)\s*([A-Za-z]*)$/.exec(text);
  if (!m)
    return { signature: {}, error: `key "${text}" is not a tonic with an optional mode — write e.g. K:C, K:Bb, K:Am, K:Ddor, or K:none` };
  const [, rawTonic, accidental, rawMode] = m;
  const tonic = rawTonic.toUpperCase();
  // A `#`/`b` on the tonic moves it seven fifths (a sharp key is seven steps
  // clockwise on the circle) — the same arithmetic the table encodes for naturals.
  let fifths = MAJOR_FIFTHS[tonic] + (accidental === "#" ? 7 : accidental === "b" ? -7 : 0);
  if (rawMode !== "") {
    const mode = MODE_FIFTHS[rawMode.slice(0, 3).toLowerCase()];
    if (mode === undefined)
      return { signature: {}, error: `key "${text}" names mode "${rawMode}", which is not one of ${Object.keys(MODE_FIFTHS).join(", ")} (or their full spellings)` };
    fifths += mode;
  }
  if (fifths > 7 || fifths < -7)
    return { signature: {}, error: `key "${text}" needs ${Math.abs(fifths)} ${fifths > 0 ? "sharps" : "flats"}, beyond the seven a key signature can carry — write its enharmonic equivalent` };
  const signature = {};
  const order = fifths > 0 ? SHARP_ORDER : FLAT_ORDER;
  for (let i = 0; i < Math.abs(fifths); i++) signature[order[i]] = fifths > 0 ? 1 : -1;
  return { signature, error: null };
}

/**
 * Pure function. A METER as `{beats, unit}` — `4/4` is four quarter-notes.
 *
 * `C` and `C|` are the two symbols the standard defines (common and cut time), and
 * they are the reason this is a function rather than a regex at the call site.
 *
 * @param {string} value - the text after `M:`
 * @returns {{meter: {beats: number, unit: number}|null, error: string|null}}
 *
 * @example meterOf("4/4").meter // {beats: 4, unit: 4}
 * @example meterOf("6/8").meter // {beats: 6, unit: 8}
 * @example meterOf("C").meter // {beats: 4, unit: 4}
 * @example meterOf("C|").meter // {beats: 2, unit: 2}
 * @example typeof meterOf("nonsense").error // "string"
 */
export function meterOf(value) {
  const text = String(value ?? "").trim();
  if (text === "C") return { meter: { beats: 4, unit: 4 }, error: null };
  if (text === "C|") return { meter: { beats: 2, unit: 2 }, error: null };
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (!m || Number(m[2]) === 0)
    return { meter: null, error: `meter "${text}" is not a fraction — write e.g. M:4/4, M:6/8, M:C or M:C|` };
  return { meter: { beats: Number(m[1]), unit: Number(m[2]) }, error: null };
}

/**
 * Pure function. The BAR LENGTH in beats (quarter notes) for a meter.
 *
 * @param {{beats: number, unit: number}} meter
 * @returns {number}
 *
 * @example barBeats({beats: 4, unit: 4}) // 4
 * @example barBeats({beats: 6, unit: 8}) // 3
 * @example barBeats({beats: 2, unit: 2}) // 4
 */
export function barBeats(meter) {
  return (meter.beats * 4) / meter.unit;
}

/**
 * Pure function. THE UNIT NOTE LENGTH the standard picks when `L:` is absent, as
 * a fraction of a whole note: 1/8 when the meter is at least 0.75, else 1/16.
 *
 * This is the ABC 2.1 rule verbatim, restated rather than invented, because
 * choosing our own default would make a tune that renders correctly elsewhere
 * render at the wrong rhythm here — with nothing to look at.
 *
 * @param {{beats: number, unit: number}} meter
 * @returns {number} the unit as a fraction of a whole note
 *
 * @example defaultUnitLength({beats: 4, unit: 4}) // 0.125
 * @example defaultUnitLength({beats: 2, unit: 4}) // 0.0625
 * @example defaultUnitLength({beats: 6, unit: 8}) // 0.125
 */
export function defaultUnitLength(meter) {
  return meter.beats / meter.unit >= 0.75 ? 1 / 8 : 1 / 16;
}

/**
 * Pure function. A TEMPO in quarter-note BPM from a `Q:` value.
 *
 * TWO FORMS, both numeric. `Q:120` is quarter-notes per minute. `Q:1/8=90` is
 * ninety EIGHTH notes per minute, i.e. 45 quarter BPM — the conversion is the
 * whole reason the second form has to be understood rather than skipped, since
 * treating it as 90 would run the tune at double speed.
 *
 * THE QUOTED FORM (`Q:"Allegro" 1/4=120`) IS REFUSED, not partially read. It is
 * the one place the standard mixes prose with data, and a parser that took the
 * numbers and dropped the word would be fine — but one that saw only the word
 * would silently leave the tempo unset, which is a rhythm error. Refusing both
 * shapes is the honest single rule.
 *
 * @param {string} value - the text after `Q:`
 * @returns {{tempo: number|null, error: string|null}}
 *
 * @example tempoOf("120").tempo // 120
 * @example tempoOf("1/4=120").tempo // 120
 * @example // ninety EIGHTHS a minute is forty-five quarters a minute
 * @example tempoOf("1/8=90").tempo // 45
 * @example tempoOf("3/8=60").tempo // 90
 * @example typeof tempoOf("\"Allegro\"").error // "string"
 */
export function tempoOf(value) {
  const text = String(value ?? "").trim();
  const plain = /^(\d+(?:\.\d+)?)$/.exec(text);
  if (plain) return { tempo: Number(plain[1]), error: null };
  const beat = /^(\d+)\s*\/\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)$/.exec(text);
  if (beat && Number(beat[2]) !== 0) {
    // The named note is `n/d` of a whole; a quarter is 1/4. So each named note is
    // (n/d)/(1/4) = 4n/d quarters, and `count` of them per minute is that many
    // quarters per minute.
    return { tempo: (Number(beat[3]) * 4 * Number(beat[1])) / Number(beat[2]), error: null };
  }
  return { tempo: null, error: `tempo "${text}" is not a number or a note=count — write e.g. Q:120 or Q:1/4=120 (the quoted form Q:"Allegro" is not supported)` };
}

/** Every construct this parser refuses, as `[matcher, sentence]`. ONE table, so
 *  the header's list and the behaviour cannot drift: a refusal added here is
 *  announced by the same code that enforces it. Matched against the body text at
 *  the current position; `re` is anchored by construction (`y` flag at use). */
const REFUSALS = Object.freeze([
  [/^(?:\|:|:\|+|::|\[[12]|\|[12])/, "repeat marks multiply the music and a clip is a flat list of notes — write the repeated bars out in full"],
  [/^\{/, "grace notes have no defined duration in a clip — write them as ordinary short notes, or remove them"],
  [/^!/, "decorations (!trill!, !fermata!, …) are performance marks with no note content — remove them"],
  [/^\+/, "the +…+ decoration form has no note content — remove it"],
  [/^\(\d/, "tuplets compress N notes into the time of M — write the fractional note lengths instead (e.g. three in the time of two: A/3 B/3 c/3 becomes A2/3 B2/3 c2/3)"],
  [/^\(/, "slurs are phrasing with no effect on a clip, and ( also opens a tuplet — remove them"],
  [/^\)/, "slurs are phrasing with no effect on a clip — remove them"],
  [/^-/, "a tie MERGES two notes into one longer note; ignoring it would re-articulate the note — write the summed length as a single note"],
  [/^[><]/, "broken rhythm (> and <) dots one note and halves its neighbour — write the lengths explicitly, e.g. A3/2 B/2"],
  [/^\\/, "a line continuation is an engraving instruction with no note content — remove it"],
  [/^[.~]/, "decorations (staccato dots, rolls) are performance marks with no note content — remove them"],
]);

/**
 * Pure function. PARSE ABC into a clip.
 *
 * Returns `{notes, errors, meta}`:
 *   `notes`  — `core/midi_clip.js` note records in time order, or `[]` when there
 *              is ANY error (see the header on why a partial tune is refused).
 *   `errors` — `[{line, column, message}]`, 1-based, in source order.
 *   `meta`   — `{tempo, meter, unitLength, barBeats, key}` — what the header said,
 *              so the widget can show it and a receiver can use the tempo.
 *
 * NEVER THROWS. A text field mid-edit is routinely not a valid tune, and an
 * exception there would take out the frame that is drawing the widget.
 *
 * @param {string} source - ABC text
 * @returns {{notes: Array, errors: Array, meta: object}}
 *
 * @example abcParse("K:C\nC").notes.length // 1
 * @example abcParse("K:C\nC").notes[0].pitch // 60
 * @example // the default unit at 4/4 is an eighth: half a beat
 * @example abcParse("M:4/4\nK:C\nC").notes[0].duration // 0.5
 * @example // L: sets it explicitly — a quarter is one beat
 * @example abcParse("L:1/4\nK:C\nC").notes[0].duration // 1
 * @example // lowercase is the octave above
 * @example abcParse("K:C\nc").notes[0].pitch // 72
 * @example abcParse("K:C\nC,").notes[0].pitch // 48
 * @example abcParse("K:C\nc'").notes[0].pitch // 84
 * @example // the KEY applies to every unaltered occurrence of the letter
 * @example abcParse("K:G\nF").notes[0].pitch // 66
 * @example // …and an explicit natural overrides it for the rest of the BAR
 * @example abcParse("K:G\n=FF").notes.map((n) => n.pitch) // [65, 65]
 * @example // …but the next bar starts clean again
 * @example abcParse("K:G\n=F|F").notes.map((n) => n.pitch) // [65, 66]
 * @example // a REST advances time and emits nothing
 * @example abcParse("L:1/4\nK:C\nCzD").notes.map((n) => n.start) // [0, 2]
 * @example // a CHORD starts every note together
 * @example abcParse("L:1/4\nK:C\n[CEG]").notes.map((n) => n.pitch) // [60, 64, 67]
 * @example abcParse("L:1/4\nK:C\n[CEG]").notes.every((n) => n.start === 0) // true
 * @example // lengths: a number multiplies, a slash divides
 * @example abcParse("L:1/4\nK:C\nC2").notes[0].duration // 2
 * @example abcParse("L:1/4\nK:C\nC/2").notes[0].duration // 0.5
 * @example abcParse("L:1/4\nK:C\nC3/2").notes[0].duration // 1.5
 * @example // a comment drops nothing, because it says nothing
 * @example abcParse("K:C\nC % this is a comment").notes.length // 1
 * @example // A REFUSAL IS LOUD, AND IT YIELDS NO NOTES AT ALL
 * @example abcParse("K:C\nC-D").errors.length // 1
 * @example abcParse("K:C\nC-D").notes // []
 * @example // …and a repeat is refused at BOTH marks, so it reports twice
 * @example abcParse("K:C\n|:CD:|").errors.length // 2
 * @example // …and an unknown character is reported with its position
 * @example abcParse("K:C\nC#").errors[0].line // 2
 * @example // a tune with no K: header has not started
 * @example abcParse("CDE").errors.length // 1
 */
export function abcParse(source) {
  const text = String(source ?? "");
  const errors = [];
  const lines = text.split(/\r\n|\r|\n/);

  // ── THE HEADER ─────────────────────────────────────────────────────────────
  let meter = { beats: 4, unit: 4 };
  let unitLength = null; // null = "not stated", resolved from the meter after K:
  let tempo = null;
  let key = "C";
  let signature = {};
  let sawKey = false;
  let bodyStart = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);
    if (raw.trim() === "") continue;
    const field = /^([A-Za-z]):(.*)$/.exec(raw);
    if (!field) {
      // A non-field line before K: is body text with no key — the tune has not
      // started. Reported once, below, rather than per line.
      break;
    }
    const [, letter, value] = field;
    if (letter === "K") {
      const k = keySignature(value);
      if (k.error) errors.push({ line: i + 1, column: 1, message: k.error });
      signature = k.signature;
      key = value.trim();
      sawKey = true;
      bodyStart = i + 1;
      break;
    }
    applyHeaderField(letter, value, i + 1, errors, {
      setMeter: (m) => { meter = m; },
      setUnit: (u) => { unitLength = u; },
      setTempo: (t) => { tempo = t; },
    });
  }
  if (!sawKey) {
    errors.push({ line: 1, column: 1, message: "no K: field — an ABC tune's header ends with its key, and the body starts after it (write K:C for no key signature)" });
    return { notes: [], errors, meta: { tempo, meter, unitLength: unitLength ?? defaultUnitLength(meter), barBeats: barBeats(meter), key } };
  }
  if (unitLength === null) unitLength = defaultUnitLength(meter);
  const meta = { tempo, meter, unitLength, barBeats: barBeats(meter), key };

  // ── THE BODY ───────────────────────────────────────────────────────────────
  // ONE unit note length is `unitLength` whole-notes = `unitLength * 4` beats.
  const unitBeats = unitLength * 4;
  const notes = [];
  let beat = 0;
  let measure = {}; // "<letter><octave>" → semitone offset, cleared at every bar line

  for (let ln = bodyStart; ln < lines.length; ln++) {
    const line = stripComment(lines[ln]);
    // A lyric or voice line is refused as a WHOLE line: its content is not notes,
    // and letting it fall into the note scanner would produce a cascade of
    // unrelated errors that buries the real one.
    const field = /^([A-Za-z]):/.exec(line);
    if (field) {
      errors.push({ line: ln + 1, column: 1, message: fieldRefusal(field[1]) });
      continue;
    }
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (/\s/.test(ch)) { i++; continue; }
      // BAR LINES first, because `|]` and `[|` overlap the chord and refusal
      // openers and the longest match must win.
      const bar = /^(?:\|\]|\[\||\|\||\|)/.exec(line.slice(i));
      const refusal = matchRefusal(line.slice(i));
      // A REFUSAL OUTRANKS A BAR LINE when both match, which is what makes `|:`
      // and `:|` reachable at all — `|` alone would otherwise swallow the first
      // character of every repeat mark and report the `:` as an unknown character,
      // pointing the author at the wrong thing.
      if (refusal) {
        errors.push({ line: ln + 1, column: i + 1, message: refusal.message });
        i += refusal.length;
        continue;
      }
      if (bar) { measure = {}; i += bar[0].length; continue; }
      // AN INLINE FIELD is `[X:` — distinguished from a chord by the colon.
      const inline = /^\[([A-Za-z]):/.exec(line.slice(i));
      if (inline) {
        errors.push({ line: ln + 1, column: i + 1, message: `an inline field [${inline[1]}:…] changes the tune mid-body, which this parser's single header cannot express — put it in the header, or split the tune into two nodes` });
        i += line.slice(i).indexOf("]") < 0 ? line.length - i : line.slice(i).indexOf("]") + 1;
        continue;
      }
      if (ch === "[") {
        const chord = readChord(line, i, ln + 1, unitBeats, signature, measure, errors);
        if (!chord) { i = line.length; continue; }
        for (const pitch of chord.pitches)
          notes.push({ start: beat, duration: chord.duration, pitch, velocity: DEFAULT_VELOCITY });
        beat += chord.duration;
        i = chord.next;
        continue;
      }
      const note = readNote(line, i, unitBeats, signature, measure);
      if (note) {
        if (note.pitch !== null)
          notes.push({ start: beat, duration: note.duration, pitch: note.pitch, velocity: DEFAULT_VELOCITY });
        beat += note.duration;
        i = note.next;
        continue;
      }
      errors.push({ line: ln + 1, column: i + 1, message: `unexpected character ${JSON.stringify(ch)} — this parser supports notes A-G/a-g, rests z/x, accidentals ^_=, octaves ',, lengths like 2 or /2, chords [CEG], bar lines | and % comments` });
      i++;
    }
  }

  // ANY error yields NO notes — the project-script rule, stated in the header.
  return { notes: errors.length ? [] : sortedNotes(notes), errors, meta };
}

/** Pure function. A line with its `%` comment removed. A `%` is never inside a
 *  token this parser understands, so no escaping is needed.
 *  @example stripComment("C % hi") // "C "
 *  @example stripComment("CDE") // "CDE" */
export function stripComment(line) {
  const at = String(line ?? "").indexOf("%");
  return at < 0 ? String(line ?? "") : String(line).slice(0, at);
}

/** Query. The refusal a body-line FIELD gets. Split out so `V:` and `w:` say what
 *  they are rather than sharing one vague sentence.
 *  @example fieldRefusal("V").includes("voice") // true
 *  @example fieldRefusal("w").includes("Lyrics") // true */
export function fieldRefusal(letter) {
  if (letter === "V") return "a V: voice line makes the tune polyphonic across staves, and a clip is one stream — use one ABC node per voice";
  if (letter === "w" || letter === "W") return "Lyrics (w:) have no note content, and interleaving them with the body would parse as notes — remove them";
  return `a "${letter}:" field in the BODY changes the tune mid-way, which this parser's single header cannot express — move it into the header before K:`;
}

/** Query. The first REFUSALS entry matching the text, or null.
 *  @example matchRefusal("-D").length // 1
 *  @example matchRefusal("CD") // null */
export function matchRefusal(text) {
  for (const [re, message] of REFUSALS) {
    const m = re.exec(text);
    if (m) return { length: m[0].length, message };
  }
  return null;
}

/** Command (pushes into `errors`). Applies one header field. Split out so the
 *  header loop reads as a list of fields rather than as a switch. */
function applyHeaderField(letter, value, line, errors, set) {
  if (letter === "X" || letter === "T" || letter === "C") return; // metadata, no note content
  if (letter === "M") {
    const { meter, error } = meterOf(value);
    if (error) errors.push({ line, column: 1, message: error });
    else set.setMeter(meter);
    return;
  }
  if (letter === "L") {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value);
    if (!m || Number(m[2]) === 0) {
      errors.push({ line, column: 1, message: `unit note length "${String(value).trim()}" is not a fraction — write e.g. L:1/8` });
      return;
    }
    set.setUnit(Number(m[1]) / Number(m[2]));
    return;
  }
  if (letter === "Q") {
    const { tempo, error } = tempoOf(value);
    if (error) errors.push({ line, column: 1, message: error });
    else set.setTempo(tempo);
    return;
  }
  errors.push({ line, column: 1, message: fieldRefusal(letter) });
}

/**
 * Pure function. ONE note (or rest) at `i`, or null when there is none there.
 *
 * Returns `{pitch, duration, next}` — `pitch` is null for a REST, which is what
 * lets the caller advance time without emitting anything from one branch.
 * MUTATES `measure`, which is this parser's one piece of carried state and is
 * deliberately scoped to a bar by its caller.
 *
 * @param {string} line - the body line
 * @param {number} i - where to start
 * @param {number} unitBeats - one unit note length, in beats
 * @param {object} signature - the key signature
 * @param {object} measure - the bar's accidental memory (mutated)
 * @returns {{pitch: number|null, duration: number, next: number}|null}
 *
 * @example readNote("C", 0, 1, {}, {}) // {pitch: 60, duration: 1, next: 1}
 * @example readNote("z2", 0, 1, {}, {}) // {pitch: null, duration: 2, next: 2}
 * @example readNote("^C", 0, 1, {}, {}).pitch // 61
 * @example readNote("Q", 0, 1, {}, {}) // null
 */
export function readNote(line, i, unitBeats, signature, measure) {
  let at = i;
  // ACCIDENTAL
  let accidental = null;
  const acc = /^(\^\^|__|\^|_|=)/.exec(line.slice(at));
  if (acc) {
    accidental = { "^": 1, "^^": 2, _: -1, __: -2, "=": 0 }[acc[1]];
    at += acc[1].length;
  }
  const ch = line[at];
  if (ch === undefined) return null;
  // REST
  if (ch === "z" || ch === "x") {
    const len = readLength(line, at + 1);
    return { pitch: null, duration: unitBeats * len.factor, next: len.next };
  }
  if (!/^[A-Ga-g]$/.test(ch)) return null;
  const letter = ch.toUpperCase();
  let octave = /[a-g]/.test(ch) ? 1 : 0;
  at += 1;
  // OCTAVE MARKS
  while (line[at] === "'" || line[at] === ",") {
    octave += line[at] === "'" ? 1 : -1;
    at += 1;
  }
  // THE ACCIDENTAL RULE, stated once: an explicit mark applies to this letter IN
  // THIS OCTAVE for the rest of the bar; otherwise the bar's memory wins if it
  // has one, and the key signature if it does not.
  const slot = `${letter}${octave}`;
  if (accidental !== null) measure[slot] = accidental;
  const offset = slot in measure ? measure[slot] : (signature[letter] ?? 0);
  const len = readLength(line, at);
  return {
    pitch: MIDDLE_C + LETTER_SEMITONES[letter] + octave * 12 + offset,
    duration: unitBeats * len.factor,
    next: len.next,
  };
}

/**
 * Pure function. A LENGTH modifier at `i` as a multiplier of the unit note
 * length, and where it ends. An absent modifier is 1.
 *
 * @param {string} line - the body line
 * @param {number} i - where to start
 * @returns {{factor: number, next: number}}
 *
 * @example readLength("C", 1) // {factor: 1, next: 1}
 * @example readLength("2", 0) // {factor: 2, next: 1}
 * @example readLength("/2", 0) // {factor: 0.5, next: 2}
 * @example // a bare slash halves, and each extra slash halves again
 * @example readLength("/", 0) // {factor: 0.5, next: 1}
 * @example readLength("//", 0) // {factor: 0.25, next: 2}
 * @example readLength("3/2", 0) // {factor: 1.5, next: 3}
 */
export function readLength(line, i) {
  const m = /^(\d*)(\/+)(\d*)|^(\d+)/.exec(line.slice(i));
  if (!m) return { factor: 1, next: i };
  if (m[4] !== undefined) return { factor: Number(m[4]), next: i + m[4].length };
  const numerator = m[1] === "" ? 1 : Number(m[1]);
  // A RUN OF SLASHES halves per slash (`//` = a quarter), which is the standard's
  // shorthand; an explicit denominator after them wins.
  const denominator = m[3] === "" ? Math.pow(2, m[2].length) : Number(m[3]);
  return { factor: denominator === 0 ? 1 : numerator / denominator, next: i + m[0].length };
}

/**
 * Pure function. A CHORD `[CEG]` at `i`, with an optional length suffix.
 *
 * PER-NOTE LENGTHS INSIDE A CHORD ARE REFUSED, and this is the one place the
 * subset is narrower than the standard on purpose: ABC allows `[C2E2G]`, whose
 * meaning (the chord's duration is the FIRST note's, and the others ring on) needs
 * per-note note-offs the clip model would express as three different durations —
 * expressible, but a rule the author cannot see in the picture. ONE length for the
 * chord, written after the bracket, is unambiguous.
 *
 * @returns {{pitches: number[], duration: number, next: number}|null} null on a
 *     refusal (which it has already pushed into `errors`)
 */
function readChord(line, i, lineNo, unitBeats, signature, measure, errors) {
  const close = line.indexOf("]", i);
  if (close < 0) {
    errors.push({ line: lineNo, column: i + 1, message: "a chord opened with [ is never closed with ] on this line" });
    return null;
  }
  const inner = line.slice(i + 1, close);
  const pitches = [];
  let at = 0;
  while (at < inner.length) {
    if (/\s/.test(inner[at])) { at++; continue; }
    // THE NOTE HEAD — accidental, letter, octave marks, and nothing else. Matched
    // separately from `readNote` so the per-note LENGTH is detectable as "there is
    // still text before `readNote` finished", which is the refusal below.
    const head = /^(?:\^\^|__|\^|_|=)?[A-Ga-g][',]*/.exec(inner.slice(at));
    if (!head) {
      errors.push({ line: lineNo, column: i + 2 + at, message: `a chord holds only notes; ${JSON.stringify(inner[at])} is not one` });
      return null;
    }
    if (/^[\d/]/.test(inner.slice(at + head[0].length))) {
      errors.push({ line: lineNo, column: i + 2 + at, message: "a note INSIDE a chord may not carry its own length — write one length after the closing bracket, e.g. [CEG]2" });
      return null;
    }
    const note = readNote(inner, at, unitBeats, signature, measure);
    pitches.push(note.pitch);
    at = at + head[0].length;
  }
  if (pitches.length === 0) {
    errors.push({ line: lineNo, column: i + 1, message: "an empty chord [] has no notes — remove it" });
    return null;
  }
  const len = readLength(line, close + 1);
  return { pitches, duration: unitBeats * len.factor, next: len.next };
}
