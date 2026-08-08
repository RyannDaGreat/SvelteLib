/**
 * THE AUTHORING SEAM, PINNED IN BARE NODE.
 * Run: node src/demo_apps/PowerRP/tests/signal_song_test.js
 *
 * `core/signal_song.js` is the ONE place another program's output becomes PowerRP
 * document state, which makes it the one place a silent conversion error would be
 * permanent: a dropped bend, a misread varint or an off-by-a-timebase would be
 * SAVED, and every later render would faithfully reproduce the wrong music.
 *
 * ── WHY THE FIXTURES ARE HAND-BUILT BYTES ───────────────────────────────────
 * Every SMF here is assembled byte by byte by `smf()` below, so each test states
 * the exact bytes it is asserting about. A checked-in .mid blob would test the same
 * parser against an opaque input — when it failed, the next reader would have no
 * way to tell a parser bug from a bad fixture. The bytes ARE the specification
 * being tested against.
 *
 * The browser probe (tests/signal_embed_probe.js) is the other half: it asks
 * whether REAL signal really writes the key this module reads. Neither test is
 * sufficient alone — this one would pass against a format signal does not produce,
 * and that one cannot check arithmetic.
 */

import assert from "node:assert";
import {
  base64Bytes, count, importSummary, parseMidiFile, SIGNAL_AUTOSAVE_INTERVAL_MS,
  SIGNAL_AUTOSAVE_KEY, songFromAutosave, songFromMidiBytes,
} from "../core/signal_song.js";
import { BEND_CONTROLLER, clipControls, clipEvents, clipNotes } from "../core/midi_clip.js";

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

// ── THE FIXTURE BUILDER: a real SMF, assembled here ──────────────────────────

/** A MIDI variable-length quantity. */
function varint(n) {
  const out = [n & 0x7f];
  let v = n >> 7;
  while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>= 7; }
  return out;
}
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** `[deltaTicks, ...bytes]` pairs into one MTrk chunk (endOfTrack appended). */
function track(events) {
  const body = [];
  for (const [delta, ...bytes] of events) body.push(...varint(delta), ...bytes);
  body.push(...varint(0), 0xff, 0x2f, 0x00);
  return [...ascii("MTrk"), ...u32(body.length), ...body];
}

/** A complete format-1 file at `timebase` ticks per beat. */
function smf(timebase, tracks) {
  return new Uint8Array([
    ...ascii("MThd"), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(timebase),
    ...tracks.flatMap((t) => track(t)),
  ]);
}

/** signal's own envelope around those bytes: base64 in a JSON `midiData`. */
function autosave(bytes, timestamp = 1_700_000_000_000) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return JSON.stringify({ midiData: Buffer.from(bin, "binary").toString("base64"), timestamp });
}

const TEMPO_120 = [0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]; // 500000 us/beat

console.log("signal → clip: the authoring seam");

// ── BASE64 ───────────────────────────────────────────────────────────────────

check("base64Bytes decodes without atob, so core/ stays bare-node pure", () => {
  assert.deepEqual([...base64Bytes("TVRoZA==")], [77, 84, 104, 100]); // "MThd"
  assert.equal(base64Bytes("").length, 0);
  // TEETH: an unpadded string is still decoded, and a bad character is REFUSED by
  // name rather than silently producing garbage bytes that then "parse".
  assert.deepEqual([...base64Bytes("TVRoZA")], [77, 84, 104, 100]);
  assert.throws(() => base64Bytes("TV*oZA"), /invalid character/);
});

// ── THE FILE GRAMMAR ─────────────────────────────────────────────────────────

check("a hand-built SMF parses to its declared timebase and track count", () => {
  const file = parseMidiFile(smf(480, [[TEMPO_120]]));
  assert.equal(file.timebase, 480);
  assert.equal(file.format, 1);
  assert.equal(file.tracks.length, 1);
});

check("a non-MIDI blob is REFUSED by name, not parsed into an empty song", () => {
  assert.throws(() => parseMidiFile(new Uint8Array(20)), /Not a MIDI file/);
  assert.throws(() => parseMidiFile(new Uint8Array(3)), /fewer than 14 bytes/);
});

check("SMPTE timing is refused, because a clip is measured in BEATS", () => {
  const bytes = smf(480, [[TEMPO_120]]);
  bytes[12] = 0xe7; // bit 15 set → frames/second
  assert.throws(() => parseMidiFile(bytes), /SMPTE/);
});

check("a variable-length delta longer than one byte is read correctly", () => {
  // 0x81 0x00 is 128, not 1 and not 256. A parser that read only the low seven bits
  // of the first byte would put this note on beat 0 instead of beat 0.266…
  const file = parseMidiFile(smf(480, [[[0, 0x90, 60, 100], [128, 0x80, 60, 0]]]));
  assert.equal(file.tracks[0][1].tick, 128);
});

check("RUNNING STATUS is honoured — a dense track is not misread", () => {
  // Second note-on omits its 0x90 status byte, which is legal and common. A reader
  // that ignored running status would take 62 as a status byte and lose the track.
  const song = songFromMidiBytes(smf(480, [[
    TEMPO_120, [0, 0x90, 60, 100], [0, 62, 100], [480, 0x80, 60, 0], [0, 0x80, 62, 0],
  ]]));
  assert.equal(song.ok, true);
  assert.equal(song.notes.length, 2);
  assert.deepEqual(song.notes.map((n) => n[2]).sort(), [60, 62]);
});

// ── THE CONVERSION ARITHMETIC ────────────────────────────────────────────────

check("ticks become BEATS through the file's own timebase", () => {
  // One beat at 480 ppq and one beat at 96 ppq must both import as 1.0 beats.
  for (const ppq of [96, 480, 960]) {
    const song = songFromMidiBytes(smf(ppq, [[TEMPO_120, [0, 0x90, 60, 100], [ppq, 0x80, 60, 0]]]));
    assert.equal(song.notes[0][0], 0, `start at ${ppq}`);
    assert.equal(song.notes[0][1], 1, `duration at ${ppq} ppq`);
  }
  // …and a fractional position stays fractional: an eighth note is half a beat.
  const song = songFromMidiBytes(smf(480, [[TEMPO_120, [240, 0x90, 60, 100], [240, 0x80, 60, 0]]]));
  assert.equal(song.notes[0][0], 0.5);
  assert.equal(song.notes[0][1], 0.5);
});

check("tempo comes from setTempo, not from the 120 BPM default", () => {
  const at90 = [0, 0xff, 0x51, 0x03, 0x0a, 0x2c, 0x2a]; // 666666 us/beat ≈ 90 BPM
  assert.equal(Math.round(songFromMidiBytes(smf(480, [[at90]])).tempo), 90);
  // TEETH: a file with NO tempo falls back rather than dividing by nothing.
  assert.equal(songFromMidiBytes(smf(480, [[[0, 0x90, 60, 100], [480, 0x80, 60, 0]]])).tempo, 120);
});

check("a NOTE-ON AT VELOCITY 0 IS A RELEASE — signal's exporter emits them", () => {
  // The whole song is written with 0x90 and never 0x80. A reader that took the
  // velocity-0 message as an attack would produce two notes that never end.
  const song = songFromMidiBytes(smf(480, [[TEMPO_120, [0, 0x90, 60, 100], [480, 0x90, 60, 0]]]));
  assert.equal(song.notes.length, 1);
  assert.equal(song.notes[0][1], 1);
  assert.equal(song.report.unmatchedNoteOns, 0);
});

check("two note-ons at ONE pitch before either off pair FIFO, not by overwrite", () => {
  const song = songFromMidiBytes(smf(480, [[
    TEMPO_120, [0, 0x90, 60, 100], [240, 0x90, 60, 90], [240, 0x80, 60, 0], [240, 0x80, 60, 0],
  ]]));
  // Both notes survive. An implementation keying one open tick per pitch would leak
  // the first note-on and import ONE note.
  assert.equal(song.notes.length, 2);
  assert.deepEqual(song.notes.map((n) => n[0]).sort((a, b) => a - b), [0, 0.5]);
});

check("an unclosed note-on is DROPPED AND COUNTED, never left open", () => {
  const song = songFromMidiBytes(smf(480, [[TEMPO_120, [0, 0x90, 60, 100]]]));
  assert.equal(song.notes.length, 0);
  assert.equal(song.report.unmatchedNoteOns, 1);
  assert.match(importSummary(song), /had no note-off/);
});

// ── THE HALF WEBSURGE DROPPED ────────────────────────────────────────────────

check("PITCH BEND SURVIVES, as a 14-bit value with the bend sentinel", () => {
  // 0xE0 lsb msb. msb 0x40, lsb 0x00 → 8192, dead centre.
  const song = songFromMidiBytes(smf(480, [[TEMPO_120, [0, 0xe0, 0x00, 0x40], [480, 0xe0, 0x7f, 0x7f]]]));
  assert.equal(song.controls.length, 2);
  assert.deepEqual(song.controls[0], [0, BEND_CONTROLLER, 8192]);
  assert.deepEqual(song.controls[1], [1, BEND_CONTROLLER, 16383]);
});

check("CC LANES SURVIVE, carrying their controller NUMBER", () => {
  const song = songFromMidiBytes(smf(480, [[TEMPO_120, [0, 0xb0, 74, 20], [240, 0xb0, 1, 127]]]));
  assert.deepEqual(song.controls, [[0, 74, 20], [0.5, 1, 127]]);
});

check("an imported bend REACHES THE EVENT STREAM, under the note it shapes", () => {
  // The end-to-end claim: bytes from signal → stored tuples → document read →
  // send-ordered events. WebSurge's integration stops one step before this.
  const song = songFromMidiBytes(smf(480, [[
    TEMPO_120, [0, 0xe0, 0x00, 0x60], [0, 0x90, 60, 100], [480, 0x80, 60, 0],
  ]]));
  const state = { clip: song.notes, ctrl: song.controls };
  const events = clipEvents(clipNotes(state), clipControls(state));
  assert.deepEqual(events.map((e) => e.type), ["pitchBend", "noteOn", "noteOff"]);
  assert.equal(events[0].value, 12288);
});

check("aftertouch and program change are DROPPED AND SAID OUT LOUD", () => {
  const song = songFromMidiBytes(smf(480, [[
    TEMPO_120, [0, 0xa0, 60, 90], [0, 0xd0, 90], [0, 0xc0, 5],
  ]]));
  assert.equal(song.report.droppedAftertouch, 2);
  assert.equal(song.report.droppedProgramChange, 1);
  const summary = importSummary(song);
  assert.match(summary, /2 aftertouch messages dropped/);
  assert.match(summary, /1 program change dropped/);
});

check("MULTIPLE CHANNELS MERGE INTO ONE CLIP, and the summary says so", () => {
  // CLAUDE.md: "One wire is one instrument". Merging is the right behaviour and a
  // SILENT merge is not — an author with drums on channel 10 must be told.
  const song = songFromMidiBytes(smf(480, [[
    TEMPO_120, [0, 0x90, 60, 100], [0, 0x99, 38, 100], [480, 0x80, 60, 0], [0, 0x89, 38, 0],
  ]]));
  assert.equal(song.notes.length, 2);
  assert.deepEqual(song.report.channels, [0, 9]);
  assert.match(importSummary(song), /2 MIDI channels were MERGED/);
});

check("a MULTI-TRACK file imports every track", () => {
  const song = songFromMidiBytes(smf(480, [
    [TEMPO_120],
    [[0, 0x90, 60, 100], [480, 0x80, 60, 0]],
    [[0, 0x90, 67, 100], [480, 0x80, 67, 0]],
  ]));
  assert.equal(song.report.tracks, 3);
  assert.equal(song.notes.length, 2);
});

// ── THE ENVELOPE, AND ITS REFUSALS ───────────────────────────────────────────

check("signal's own autosave envelope round-trips to notes", () => {
  const song = songFromAutosave(autosave(smf(480, [[TEMPO_120, [0, 0x90, 60, 100], [480, 0x80, 60, 0]]])));
  assert.equal(song.ok, true);
  assert.equal(song.notes.length, 1);
  assert.equal(song.timestamp, 1_700_000_000_000);
});

check("every way the envelope can be missing is refused BY NAME and yields NO notes", () => {
  // The ABC rule: a half-imported song looks like it worked. Each of these must be
  // a sentence a modal footer can show, and each must import nothing.
  for (const [raw, pattern] of [
    [null, /has not autosaved/],
    ["", /has not autosaved/],
    ["{not json", /not valid JSON/],
    [JSON.stringify({ timestamp: 1 }), /holds no MIDI data/],
    [JSON.stringify({ midiData: "!!!!" }), /not valid base64/],
    [JSON.stringify({ midiData: "AAAAAAAAAAAAAAAAAAAA" }), /Not a MIDI file/],
  ]) {
    const song = songFromAutosave(raw);
    assert.equal(song.ok, false, `${raw} should not be ok`);
    assert.deepEqual(song.notes, [], `${raw} must import nothing`);
    assert.match(importSummary(song), pattern);
  }
});

check("the key and the interval are signal's, spelled once", () => {
  assert.equal(SIGNAL_AUTOSAVE_KEY, "signal_autosave");
  assert.equal(SIGNAL_AUTOSAVE_INTERVAL_MS, 10000);
});

check("the summary pluralizes and states the tempo", () => {
  assert.equal(count(1, "note"), "1 note");
  assert.equal(count(2, "note"), "2 notes");
  const song = songFromMidiBytes(smf(480, [[TEMPO_120, [0, 0x90, 60, 100], [480, 0x80, 60, 0]]]));
  assert.equal(importSummary(song), "Imported 1 note at 120 BPM.");
});

console.log(`\nsignal_song_test: ${passed} checks passed`);
