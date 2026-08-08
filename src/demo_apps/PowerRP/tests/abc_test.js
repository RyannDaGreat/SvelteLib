/**
 * THE ABC PARSER — its supported subset, and (mostly) its REFUSALS.
 * Run: node src/demo_apps/PowerRP/tests/abc_test.js
 *
 * ── THE REFUSALS ARE THE POINT OF THIS FILE ─────────────────────────────────
 * A parser that accepts a tune and returns the right notes is easy to check by
 * eye. What is NOT visible by eye is a construct being SILENTLY IGNORED: a tune
 * with a dropped repeat, a dropped tie or a flattened broken rhythm parses green,
 * produces notes, plays — and is the wrong music. Nothing about it looks wrong.
 *
 * So the bulk of this file asserts that each refused construct produces an ERROR
 * and NO NOTES, and — the check that makes the list a statement rather than a hope
 * — that the parser has no silent no-ops at all: the backstop sweep at the bottom
 * feeds it every printable ASCII character in a note position and asserts each one
 * either MEANS something or is REFUSED. There is no third outcome.
 */

import assert from "node:assert/strict";
import { abcParse, barBeats, defaultUnitLength, keySignature, meterOf, readLength, readNote, stripComment, tempoOf } from "../core/abc.js";

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };

/** The notes a source parses to, asserting it parsed CLEANLY first — so a check
 *  about pitches can never accidentally pass on an empty list from an error. */
const notesOf = (src) => {
  const { notes, errors } = abcParse(src);
  assert.deepEqual(errors, [], `expected a clean parse of ${JSON.stringify(src)}`);
  return notes;
};

/** Assert a source is REFUSED: at least one error, NO notes, and a message that
 *  actually says something. */
const refused = (src, expectWord) => {
  const { notes, errors } = abcParse(src);
  assert.ok(errors.length > 0, `expected ${JSON.stringify(src)} to be refused`);
  assert.deepEqual(notes, [], `a refused tune must yield NO notes, not a fragment: ${JSON.stringify(src)}`);
  assert.ok(errors[0].message.length > 20, `refusal needs a sentence, got ${JSON.stringify(errors[0].message)}`);
  assert.ok(Number.isInteger(errors[0].line) && errors[0].line >= 1, "a refusal must name its line");
  assert.ok(Number.isInteger(errors[0].column) && errors[0].column >= 1, "a refusal must name its column");
  if (expectWord)
    assert.ok(errors.some((e) => e.message.toLowerCase().includes(expectWord)),
      `refusal should mention ${JSON.stringify(expectWord)}; got ${errors.map((e) => e.message).join(" | ")}`);
};

// ── PITCH ────────────────────────────────────────────────────────────────────

check("uppercase is the octave from middle C; lowercase is the one above", () => {
  assert.deepEqual(notesOf("K:C\nCDEFGAB").map((n) => n.pitch), [60, 62, 64, 65, 67, 69, 71]);
  assert.deepEqual(notesOf("K:C\ncdefgab").map((n) => n.pitch), [72, 74, 76, 77, 79, 81, 83]);
});

check("octave marks stack in both directions", () => {
  assert.equal(notesOf("K:C\nC,")[0].pitch, 48);
  assert.equal(notesOf("K:C\nC,,")[0].pitch, 36);
  assert.equal(notesOf("K:C\nc'")[0].pitch, 84);
  assert.equal(notesOf("K:C\nc''")[0].pitch, 96);
});

check("accidentals: sharp, flat, double, natural", () => {
  assert.equal(notesOf("K:C\n^C")[0].pitch, 61);
  assert.equal(notesOf("K:C\n_D")[0].pitch, 61);
  assert.equal(notesOf("K:C\n^^C")[0].pitch, 62);
  assert.equal(notesOf("K:C\n__E")[0].pitch, 62);
  assert.equal(notesOf("K:C\n=C")[0].pitch, 60);
});

// ── KEY SIGNATURES ───────────────────────────────────────────────────────────

check("a key signature alters every unmarked occurrence of its letters", () => {
  assert.equal(notesOf("K:G\nF")[0].pitch, 66);      // F#
  assert.equal(notesOf("K:D\nFC").map((n) => n.pitch).join(), "66,61"); // F# C#
  assert.equal(notesOf("K:F\nB")[0].pitch, 70);      // Bb
});

check("modes resolve on the circle of fifths, not by tonic", () => {
  // The check that catches "treat Ddor as D major": D dorian has NO accidentals.
  assert.deepEqual(keySignature("Ddor").signature, {});
  assert.equal(notesOf("K:Ddor\nF")[0].pitch, 65);   // F natural, NOT F#
  assert.equal(notesOf("K:D\nF")[0].pitch, 66);      // …whereas D major does sharpen it
  assert.deepEqual(keySignature("Am").signature, {});
  assert.deepEqual(keySignature("Emix").signature, { F: 1, C: 1, G: 1 });
});

check("K:none and an empty key mean no signature; an unreadable key is refused", () => {
  assert.deepEqual(keySignature("none").signature, {});
  assert.deepEqual(keySignature("").signature, {});
  assert.ok(keySignature("H7").error);
  assert.ok(keySignature("Cwhatever").error);
  refused("K:H7\nC");
});

check("a measure accidental applies to that letter in that OCTAVE until the bar line", () => {
  assert.deepEqual(notesOf("K:G\n=FF").map((n) => n.pitch), [65, 65]);
  assert.deepEqual(notesOf("K:G\n=F|F").map((n) => n.pitch), [65, 66]);
  // …and it is OCTAVE-scoped: the same letter an octave up is unaffected.
  assert.deepEqual(notesOf("K:G\n=Ff").map((n) => n.pitch), [65, 78]);
});

// ── RHYTHM ───────────────────────────────────────────────────────────────────

check("L: sets the unit, and the standard's default is used when it is absent", () => {
  assert.equal(notesOf("L:1/4\nK:C\nC")[0].duration, 1);
  assert.equal(notesOf("L:1/8\nK:C\nC")[0].duration, 0.5);
  assert.equal(notesOf("M:4/4\nK:C\nC")[0].duration, 0.5);    // meter >= 0.75 -> 1/8
  assert.equal(notesOf("M:2/4\nK:C\nC")[0].duration, 0.25);   // meter < 0.75 -> 1/16
  assert.equal(defaultUnitLength({ beats: 4, unit: 4 }), 1 / 8);
  assert.equal(defaultUnitLength({ beats: 2, unit: 4 }), 1 / 16);
});

check("length modifiers multiply, divide, and stack slashes", () => {
  assert.equal(notesOf("L:1/4\nK:C\nC2")[0].duration, 2);
  assert.equal(notesOf("L:1/4\nK:C\nC/2")[0].duration, 0.5);
  assert.equal(notesOf("L:1/4\nK:C\nC/")[0].duration, 0.5);
  assert.equal(notesOf("L:1/4\nK:C\nC//")[0].duration, 0.25);
  assert.equal(notesOf("L:1/4\nK:C\nC3/2")[0].duration, 1.5);
  assert.deepEqual(readLength("3/2", 0), { factor: 1.5, next: 3 });
});

check("rests advance time and emit nothing", () => {
  assert.deepEqual(notesOf("L:1/4\nK:C\nCzD").map((n) => n.start), [0, 2]);
  assert.deepEqual(notesOf("L:1/4\nK:C\nCz2D").map((n) => n.start), [0, 3]);
  assert.deepEqual(notesOf("L:1/4\nK:C\nCxD").map((n) => n.start), [0, 2]);
});

check("notes advance sequentially, and a bar line costs no time", () => {
  const notes = notesOf("L:1/4\nK:C\nCD|EF");
  assert.deepEqual(notes.map((n) => n.start), [0, 1, 2, 3]);
});

// ── CHORDS (the polyphony a step sequencer could not express) ────────────────

check("a chord starts every note together and takes one length after the bracket", () => {
  const chord = notesOf("L:1/4\nK:C\n[CEG]");
  assert.deepEqual(chord.map((n) => n.pitch), [60, 64, 67]);
  assert.ok(chord.every((n) => n.start === 0 && n.duration === 1));
  assert.equal(notesOf("L:1/4\nK:C\n[CEG]2")[0].duration, 2);
  // A chord advances time ONCE, not once per note.
  assert.deepEqual(notesOf("L:1/4\nK:C\n[CE]G").map((n) => n.start), [0, 0, 1]);
});

check("a per-note length INSIDE a chord is refused rather than silently ignored", () => {
  refused("L:1/4\nK:C\n[C2EG]", "length");
});

check("an unclosed or empty chord is refused", () => {
  refused("K:C\n[CEG");
  refused("K:C\n[]");
});

// ── HEADER ───────────────────────────────────────────────────────────────────

check("meters, including the two symbols", () => {
  assert.deepEqual(meterOf("6/8").meter, { beats: 6, unit: 8 });
  assert.deepEqual(meterOf("C").meter, { beats: 4, unit: 4 });
  assert.deepEqual(meterOf("C|").meter, { beats: 2, unit: 2 });
  assert.equal(barBeats({ beats: 6, unit: 8 }), 3);
  assert.ok(meterOf("nonsense").error);
});

check("tempo: both numeric forms, with the note-length conversion", () => {
  assert.equal(tempoOf("120").tempo, 120);
  assert.equal(tempoOf("1/4=120").tempo, 120);
  assert.equal(tempoOf("1/8=90").tempo, 45);   // ninety EIGHTHS = forty-five quarters
  assert.equal(tempoOf("3/8=60").tempo, 90);
  assert.ok(tempoOf('"Allegro"').error);
  assert.equal(abcParse("Q:1/4=100\nK:C\nC").meta.tempo, 100);
});

check("X:, T: and C: are accepted and carry no note information", () => {
  assert.deepEqual(notesOf("X:1\nT:A Tune\nC:Trad.\nK:C\nC").map((n) => n.pitch), [60]);
});

check("a tune with no K: has not started, and says so", () => {
  refused("CDE", "k:");
  refused("X:1\nT:Nope", "k:");
});

check("comments and blank lines drop nothing", () => {
  assert.equal(stripComment("C % hi"), "C ");
  assert.deepEqual(notesOf("K:C\nC % a comment\n\nD").map((n) => n.pitch), [60, 62]);
  assert.deepEqual(notesOf("% leading comment\nK:C\nC").map((n) => n.pitch), [60]);
});

check("a body line break is whitespace — ABC uses it for engraving, a clip has no staves", () => {
  assert.deepEqual(notesOf("L:1/4\nK:C\nCD\nEF").map((n) => n.start), [0, 1, 2, 3]);
});

// ── THE REFUSALS ─────────────────────────────────────────────────────────────

check("REPEATS are refused in every spelling", () => {
  for (const src of ["K:C\n|:CD:|", "K:C\nCD::EF", "K:C\n[1 CD", "K:C\nCD:|"])
    refused(src, "repeat");
});

check("TIES and SLURS are refused", () => {
  refused("K:C\nC-D", "tie");
  refused("K:C\n(CD)", "slur");
});

check("BROKEN RHYTHM is refused — the silent version would flatten the rhythm", () => {
  refused("K:C\nC>D", "broken rhythm");
  refused("K:C\nC<D", "broken rhythm");
});

check("TUPLETS, GRACE NOTES and DECORATIONS are refused", () => {
  refused("K:C\n(3CDE", "tuplet");
  refused("K:C\n{gc}D", "grace");
  refused("K:C\n!trill!C", "decoration");
  refused("K:C\n+f+C", "decoration");
  refused("K:C\n.C", "decoration");
  refused("K:C\n~C", "decoration");
});

check("INLINE FIELDS, VOICES, LYRICS and CONTINUATIONS are refused", () => {
  refused("K:C\nC[K:G]D", "inline field");
  refused("K:C\nV:1\nCD", "voice");
  refused("K:C\nCD\nw:la la", "lyrics");
  refused("K:C\nCD\\", "continuation");
});

check("A REFUSED TUNE YIELDS NO NOTES AT ALL — half a tune looks like it worked", () => {
  // The project-script rule. The tune below is 90% valid; it still produces nothing.
  const { notes, errors } = abcParse("L:1/4\nK:C\nCDEF|GABc|dc-BA|");
  assert.equal(errors.length, 1);
  assert.deepEqual(notes, []);
});

check("every error names its LINE and COLUMN in the source", () => {
  const { errors } = abcParse("K:C\nCD\nEF-G");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.equal(errors[0].column, 3);
});

check("THE BACKSTOP: no printable character is a silent no-op", () => {
  // The check that makes the refusal list a STATEMENT. Every printable ASCII
  // character, in a note position: it must either PARSE to something (advancing
  // time or emitting a note) or be REFUSED. A character that did neither would be
  // silently skipped, which is the failure mode this whole file exists to prevent.
  const silent = [];
  for (let code = 0x21; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    const src = `L:1/4\nK:C\n${ch}`;
    const { notes, errors } = abcParse(src);
    const meant = notes.length > 0 || abcParse(`L:1/4\nK:C\n${ch}C`).notes.length > 1 || isStructural(ch);
    if (errors.length === 0 && !meant) silent.push(ch);
  }
  assert.deepEqual(silent, [], `these characters were neither understood nor refused: ${silent.join(" ")}`);
});

/**
 * Characters that legitimately parse to something with no note of their own — bar
 * lines (which reset the measure accidentals), rests, whitespace, and `%` (which
 * opens a comment, so everything after it is deliberately not read).
 *
 * THIS LIST IS THE SWEEP'S ONLY ESCAPE HATCH, so it is short and each entry is
 * justified. `%` was MISSING when the sweep was first run and the sweep caught it
 * — which is the demonstration that the check has teeth: it is looking for
 * exactly "the parser saw this and did nothing", and a comment opener is the one
 * character for which that is the correct behaviour.
 */
function isStructural(ch) {
  return "|[]zx %".includes(ch);
}

check("the parser NEVER throws, on any input", () => {
  // A text field mid-edit is routinely not a valid tune, and an exception there
  // would take out the frame drawing the widget.
  for (const src of ["", "K:", "K:C\n", "[", "]", "^", "/", "K:C\n^^^^C", " ", "K:C\n" + "C".repeat(5000), null, undefined, 42, {}])
    assert.doesNotThrow(() => abcParse(src), `threw on ${JSON.stringify(src)}`);
});

check("readNote reports a rest as pitch null rather than as a note", () => {
  assert.deepEqual(readNote("z2", 0, 1, {}, {}), { pitch: null, duration: 2, next: 2 });
  assert.equal(readNote("Q", 0, 1, {}, {}), null);
});

check("a realistic tune parses end to end", () => {
  const src = ["X:1", "T:Fragment", "M:4/4", "L:1/8", "Q:1/4=100", "K:D", "DEFG ABcd|d2 c2 B2 A2|"].join("\n");
  const { notes, errors, meta } = abcParse(src);
  assert.deepEqual(errors, []);
  assert.equal(notes.length, 12);
  assert.equal(meta.tempo, 100);
  assert.equal(meta.barBeats, 4);
  assert.equal(notes[0].pitch, 62);
  assert.equal(notes[2].pitch, 66, "F is sharpened by K:D");
  // The second bar's notes are quarter notes (2 x an eighth unit).
  assert.equal(notes[8].duration, 1);
  // Time advances monotonically and the tune is four beats per bar.
  assert.equal(notes[8].start, 4);
});

console.log(`\nabc_test: ${passed} checks passed`);
