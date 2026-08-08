/**
 * THE AUTHORING SEAM — ryohey's `signal` song, as a PowerRP clip.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * The editor is `signal` (https://github.com/ryohey/signal, MIT), vendored at
 * web/public/signal/ and framed. Standing user ruling, stated three times: "the
 * piano roll open source thing should NOT be vibecoded" / "Hopefully your agent is
 * LITERALLY USING the midi code I gave? Not just trying to reimplement it" /
 * "Again, USE IT dont imitate it". signal owns the EDITOR. This module is the one
 * place its output becomes DOCUMENT STATE.
 *
 * WebSurge integrated signal before us and did NOT solve this half: their bridge is
 * one-way and note-only, because they only ever PLAYED THROUGH signal. Nothing
 * downstream of them stores a song. This is the part that had no precedent.
 *
 * ── THE SEAM THAT WAS CHOSEN, AND THE THREE THAT WERE NOT ───────────────────
 * signal's built bundle is fully minified and exposes NO store handle: the
 * RootStore is a module-scoped `const` handed to a React context, there is no
 * window global, no command bus, and the only `globalThis` write is Jotai's dev
 * singleton. So the parent cannot read the live song object. Four candidates were
 * measured against the shipped bundle:
 *
 *   1. THE NOTE STREAM the embed patch already posts (`signal:synth-output`).
 *      REFUSED ON PRINCIPLE, not on difficulty. That is the LIVE path: each message
 *      carries `delayMs` RELATIVE TO POST TIME and lands on a `setTimeout`, so it
 *      is a reading of a wall clock. Reconstructing a song from it would make the
 *      document's contents depend on when the editor happened to be open —
 *      EPHEMERAL state, which CLAUDE.md's taxonomy forbids from reaching a render
 *      tree. It is also lossy by construction (no ticks, no timebase, no tempo).
 *   2. `export-midi`. A DEAD END, measured: on Chrome it calls
 *      `window.showSaveFilePicker`, which needs transient user activation and pops
 *      a native OS dialog; the fallback path builds a blob URL, clicks a hidden
 *      anchor and REVOKES the URL a second later, so the parent can never see the
 *      bytes. Worse, `exportSong` calls `onUserExplicitAction`, which DELETES the
 *      autosave — the fallback would destroy the primary.
 *   3. IndexedDB. Not a song store: the IDB present is Firebase auth/installations
 *      plus a soundfont cache.
 *   4. **`localStorage["signal_autosave"]` — CHOSEN.**
 *
 * ── WHY 4 IS THE RIGHT ONE, AND THE PROPERTY THAT MAKES IT SO ───────────────
 * The stored value is `{"midiData": "<base64>", "timestamp": <ms>}`, and `midiData`
 * is **NOT signal's internal object model — it is a complete format-1 STANDARD MIDI
 * FILE**. signal writes it with its own `songToMidi`, the same function its Export
 * MIDI menu item uses, so the bytes we parse are byte-for-byte the bytes a user
 * would have exported by hand.
 *
 * THAT IS THE WHOLE ARGUMENT. We are not coupled to signal's minified internals,
 * its class shapes, its MobX layout or its version; we are coupled to SMF, a frozen
 * 1996 specification with an unambiguous binary grammar. A signal upgrade that
 * renames every symbol in the bundle cannot break this module. That is a
 * fundamentally different kind of dependency from "reach into their store", and it
 * is why this beat patching the bundle to post its song on request (which would
 * ALSO have worked, and remains the upgrade path if the caveats below ever bite).
 *
 * Same origin does the rest: `edit.html` is served from the app's own origin out of
 * `public/`, so the frame's `localStorage` IS the parent's. The reader needs no
 * iframe handle at all.
 *
 * ── THE THREE CAVEATS, MEASURED, AND WHOSE JOB EACH ONE IS ──────────────────
 * These are properties of signal's autosave, not of this parser. Each is stated
 * because a silent version of it would be exactly the quiet wrongness this codebase
 * forbids:
 *
 *   A. IT IS AN INTERVAL, NOT AN EDIT HOOK. `setInterval(…, 10000)`, and only when
 *      the song is dirty. So a snapshot is up to 10 SECONDS STALE, and a song
 *      edited for the first two seconds of a session has NO snapshot at all.
 *      **web/SignalModal.svelte's job**: it watches the timestamp and will not
 *      import a snapshot older than the session without saying so.
 *   B. IT IS DELETED BY New / Open / Import / **Export MIDI**
 *      (`onUserExplicitAction` → `clearAutoSave`). **The modal's job**: keep the
 *      last snapshot it saw in memory rather than re-reading at import time, so a
 *      user who exports does not also lose the import.
 *   C. A VERY LARGE SONG SILENTLY FAILS TO AUTOSAVE. signal encodes with
 *      `btoa(String.fromCharCode(...bytes))`, and spreading a ~100 KB+ byte array
 *      blows the argument stack; the throw is caught and only `console.warn`ed
 *      inside the frame. There is nothing this side can do about it, so it is
 *      WRITTEN DOWN rather than defended against — the symptom is a timestamp that
 *      stops advancing while the author keeps editing.
 *
 * ── WHAT THIS MODULE REFUSES TO DO QUIETLY ──────────────────────────────────
 * The ABC parser's rule, applied: a construct that is neither understood nor
 * refused is the worst outcome, because it parses green and plays the wrong music.
 * So every event kind SMF can carry is either CONVERTED or COUNTED, and the counts
 * come back in the report for the modal to show. A file that will not parse yields
 * NO NOTES AT ALL rather than the prefix that parsed — half a song looks like it
 * worked.
 *
 * DOM-free, engine-free, clock-free: core/ runs in bare node.
 */

import {
  BEND_CONTROLLER, ctrlTuple, DEFAULT_TEMPO, MIDI_NOTE_MAX, MIDI_NOTE_MIN, noteTuple,
} from "./midi_clip.js";

/** The localStorage key signal autosaves into, and the flag beside it. Spelled
 *  here — in the module that knows what the value MEANS — rather than in the modal
 *  that reads it, so the reader and the parser cannot come to name different keys.
 *  These are SIGNAL'S names, not ours; they are what its bundle writes.
 *  @example SIGNAL_AUTOSAVE_KEY // "signal_autosave" */
export const SIGNAL_AUTOSAVE_KEY = "signal_autosave";
export const SIGNAL_AUTOSAVE_FLAG_KEY = "signal_autosave_flag";

/** How often signal writes a snapshot, in milliseconds — its `setInterval` period,
 *  restated here so the modal can say "up to 10 seconds" without hardcoding a
 *  number whose origin is invisible. Caveat A in the header.
 *  @example SIGNAL_AUTOSAVE_INTERVAL_MS // 10000 */
export const SIGNAL_AUTOSAVE_INTERVAL_MS = 10000;

/**
 * Pure function. THE TOP-LEVEL CONVERSION: signal's stored autosave string in,
 * document-ready list values out.
 *
 * Returns a REPORT rather than throwing, and never a partial song. The caller is a
 * modal with a footer to put sentences in, and the honest outcomes are "here is
 * what I imported" and "here is why I imported nothing" — an exception would give
 * it neither.
 *
 * @param {string|null} raw - the raw `localStorage["signal_autosave"]` value
 * @returns {{ok: boolean, error: string|null, notes: Array, controls: Array, tempo: number, timestamp: number|null, report: object}}
 *
 * @example songFromAutosave(null).error // "signal has not autosaved a song yet."
 * @example songFromAutosave(null).notes // []
 * @example songFromAutosave("{not json").ok // false
 * @example // a well-formed envelope with no midiData is refused by name
 * @example songFromAutosave(JSON.stringify({timestamp: 1})).error // "signal's autosave holds no MIDI data."
 */
export function songFromAutosave(raw) {
  if (typeof raw !== "string" || raw === "")
    return failed("signal has not autosaved a song yet.");
  let envelope = null;
  try { envelope = JSON.parse(raw); } catch {
    return failed("signal's autosave is not valid JSON — it may have been written by a different version.");
  }
  if (typeof envelope?.midiData !== "string" || envelope.midiData === "")
    return failed("signal's autosave holds no MIDI data.");
  let bytes = null;
  try { bytes = base64Bytes(envelope.midiData); } catch (e) {
    return failed(`signal's autosave is not valid base64: ${e.message}`);
  }
  const song = songFromMidiBytes(bytes);
  const timestamp = Number.isFinite(Number(envelope.timestamp)) ? Number(envelope.timestamp) : null;
  return { ...song, timestamp };
}

/** The refusal shape, spelled once so every failure path answers the same keys —
 *  a caller must never have to check whether `notes` exists before reading it. */
function failed(error) {
  return { ok: false, error, notes: [], controls: [], tempo: DEFAULT_TEMPO, timestamp: null, report: emptyReport() };
}

/** The counts a conversion reports. Every one of them exists because the thing it
 *  counts would otherwise vanish silently. */
function emptyReport() {
  return {
    tracks: 0, channels: [], noteCount: 0, controlCount: 0,
    unmatchedNoteOns: 0, droppedAftertouch: 0, droppedProgramChange: 0, droppedSysex: 0, droppedMeta: 0,
    timebase: 0,
  };
}

/**
 * Pure function. A Standard MIDI File's bytes as document-ready list values.
 *
 * Separate from `songFromAutosave` because the ENVELOPE and the FILE are two
 * different things to be wrong about, and a test that wants to feed a hand-built
 * SMF should not have to base64 it inside a JSON wrapper first.
 *
 * @param {Uint8Array} bytes - a standard MIDI file
 * @returns {{ok: boolean, error: string|null, notes: Array, controls: Array, tempo: number, report: object}}
 */
export function songFromMidiBytes(bytes) {
  let file = null;
  try { file = parseMidiFile(bytes); } catch (e) { return failed(e.message); }

  const report = emptyReport();
  report.tracks = file.tracks.length;
  report.timebase = file.timebase;

  const notes = [];
  const controls = [];
  const channels = new Set();
  let tempo = null;

  for (const events of file.tracks) {
    // OPEN NOTES ARE KEYED BY (channel, key) AND HELD AS A QUEUE, because MIDI
    // genuinely permits two note-ons at one pitch before either off, and pairing
    // them FIFO is the convention every sequencer uses. A Map of arrays rather than
    // of single ticks: overwriting would leak the first note-on and lose the note.
    const open = new Map();
    for (const ev of events) {
      const beat = ev.tick / file.timebase;
      if (ev.kind === "setTempo") {
        // THE FIRST TEMPO WINS. A clip carries ONE `tempo` leaf, so a song with a
        // tempo MAP cannot be represented; taking the first is the same choice
        // `resolvedTempo` makes for a broken value — a defensible speed rather than
        // an error — and the count in the report is what makes it visible.
        if (tempo === null && ev.microsecondsPerBeat > 0) tempo = 6e7 / ev.microsecondsPerBeat;
        continue;
      }
      if (ev.kind === "noteOn") {
        channels.add(ev.channel);
        if (!open.has(ev.key)) open.set(ev.key, []);
        open.get(ev.key).push(ev);
        continue;
      }
      if (ev.kind === "noteOff") {
        channels.add(ev.channel);
        const queue = open.get(ev.key);
        const on = queue?.shift();
        // AN OFF WITH NO ON IS NOT A NOTE and is not counted as a loss either: it
        // is what a file says when a note was already released, and nothing was
        // dropped by ignoring it. The loss worth counting is the opposite case —
        // an ON that never closes — and that is tallied after the loop.
        if (!on) continue;
        notes.push(noteTuple({
          start: on.tick / file.timebase,
          duration: Math.max(0, (ev.tick - on.tick) / file.timebase),
          pitch: on.key,
          velocity: on.velocity,
        }));
        continue;
      }
      if (ev.kind === "controller") {
        channels.add(ev.channel);
        controls.push(ctrlTuple({ start: beat, controller: ev.controller, value: ev.value }));
        continue;
      }
      if (ev.kind === "pitchBend") {
        channels.add(ev.channel);
        controls.push(ctrlTuple({ start: beat, controller: BEND_CONTROLLER, value: ev.value }));
        continue;
      }
      // ── THE COUNTED DROPS ───────────────────────────────────────────────────
      // Each of these is a real MIDI message our clip vocabulary has no slot for.
      // `MIDI_EVENT_RANK` declares four kinds; aftertouch and program change are
      // not among them, so storing one would need a fifth kind, a receiver that
      // reads it and an ordering rule for it. Until then they are DROPPED AND
      // COUNTED, and the modal says so — which is the difference between a stated
      // boundary and a hole.
      if (ev.kind === "aftertouch") report.droppedAftertouch++;
      else if (ev.kind === "programChange") report.droppedProgramChange++;
      else if (ev.kind === "sysex") report.droppedSysex++;
      else if (ev.kind === "meta") report.droppedMeta++;
    }
    for (const queue of open.values()) report.unmatchedNoteOns += queue.length;
  }

  report.channels = [...channels].sort((a, b) => a - b);
  report.noteCount = notes.length;
  report.controlCount = controls.length;
  return {
    ok: true, error: null, notes, controls,
    tempo: tempo === null ? DEFAULT_TEMPO : tempo,
    report,
  };
}

/**
 * Pure function. A Standard MIDI File's bytes as `{format, timebase, tracks}`,
 * where each track is a flat list of `{tick, kind, …}` in file order.
 *
 * A HAND-WRITTEN PARSER RATHER THAN A DEPENDENCY, and the reason is the same one
 * that made this seam attractive: SMF is a small frozen grammar (a header chunk, a
 * run of track chunks, delta-time varints, running status), and the whole of it
 * fits here in a form that runs in bare node with nothing installed. A library
 * would be a supply-chain edge on the ONE path that turns another program's output
 * into our document state.
 *
 * THROWS on a malformed file, with a sentence naming what was wrong and where. The
 * caller turns that into a refusal; nothing partial escapes.
 *
 * @param {Uint8Array} bytes
 * @returns {{format: number, timebase: number, tracks: Array<Array<object>>}}
 * @throws {Error}
 */
export function parseMidiFile(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (data.length < 14) throw new Error("Not a MIDI file: fewer than 14 bytes.");
  if (chunkName(data, 0) !== "MThd") throw new Error(`Not a MIDI file: it begins with ${JSON.stringify(chunkName(data, 0))} rather than "MThd".`);
  const headerLength = readU32(data, 4);
  if (headerLength < 6) throw new Error(`MIDI header chunk is ${headerLength} bytes; it must be at least 6.`);
  const format = readU16(data, 8);
  const trackCount = readU16(data, 10);
  const division = readU16(data, 12);
  // SMPTE TIMING IS REFUSED BY NAME. Bit 15 set means the division is frames/second
  // and ticks/frame — an ABSOLUTE time base, where a clip's whole model is BEATS.
  // signal always writes PPQ (it passes `song.timebase` straight through), so this
  // can only arrive from a file that did not come from signal; guessing a tempo for
  // it would silently retime the music.
  if (division & 0x8000)
    throw new Error("This MIDI file uses SMPTE timing (absolute frames), and a clip is measured in BEATS. Only tick-per-quarter-note files can be imported.");
  if (division === 0) throw new Error("This MIDI file declares 0 ticks per beat, so no note position can be computed from it.");

  const tracks = [];
  let pos = 8 + headerLength;
  while (pos + 8 <= data.length && tracks.length < trackCount) {
    const name = chunkName(data, pos);
    const length = readU32(data, pos + 4);
    // AN UNKNOWN CHUNK IS SKIPPED, NOT REFUSED — the SMF spec requires exactly that
    // of a reader, so that a file carrying a vendor chunk stays readable.
    if (name === "MTrk") tracks.push(parseTrack(data, pos + 8, Math.min(data.length, pos + 8 + length)));
    pos += 8 + length;
  }
  if (tracks.length === 0) throw new Error("This MIDI file contains no track chunks.");
  return { format, timebase: division, tracks };
}

/** Pure function. One MTrk chunk's events, absolute-ticked. Running status is
 *  honoured (a status byte may be omitted when it repeats the previous one — a file
 *  that ignored this would misread every densely-written track). */
function parseTrack(data, start, end) {
  const events = [];
  let pos = start;
  let tick = 0;
  let status = 0;
  while (pos < end) {
    const delta = readVarInt(data, pos, end);
    tick += delta.value;
    pos = delta.next;
    if (pos >= end) break;
    let byte = data[pos];
    if (byte & 0x80) { status = byte; pos++; } else if (!status) break; // data before any status: unreadable
    const type = status & 0xf0;
    const channel = status & 0x0f;
    if (status === 0xff) {
      const metaType = data[pos++];
      const len = readVarInt(data, pos, end);
      const body = data.subarray(len.next, Math.min(end, len.next + len.value));
      pos = len.next + len.value;
      if (metaType === 0x51 && body.length >= 3)
        events.push({ tick, kind: "setTempo", microsecondsPerBeat: (body[0] << 16) | (body[1] << 8) | body[2] });
      else if (metaType !== 0x2f) events.push({ tick, kind: "meta", metaType }); // endOfTrack is structure, not content
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const len = readVarInt(data, pos, end);
      pos = len.next + len.value;
      events.push({ tick, kind: "sysex" });
      continue;
    }
    if (type === 0x80 || type === 0x90) {
      const key = data[pos++];
      const velocity = data[pos++];
      // A NOTE-ON AT VELOCITY 0 IS A RELEASE. Real MIDI, and signal's own exporter
      // emits them; a reader that took it as an attack would leave every note held
      // forever and produce one enormous chord.
      const isOn = type === 0x90 && velocity > 0;
      events.push({ tick, kind: isOn ? "noteOn" : "noteOff", channel, key: clamp(key, MIDI_NOTE_MIN, MIDI_NOTE_MAX), velocity });
      continue;
    }
    if (type === 0xb0) {
      const controller = data[pos++];
      const value = data[pos++];
      events.push({ tick, kind: "controller", channel, controller, value });
      continue;
    }
    if (type === 0xe0) {
      const lsb = data[pos++];
      const msb = data[pos++];
      events.push({ tick, kind: "pitchBend", channel, value: ((msb & 0x7f) << 7) | (lsb & 0x7f) });
      continue;
    }
    if (type === 0xa0) { pos += 2; events.push({ tick, kind: "aftertouch", channel }); continue; }
    if (type === 0xd0) { pos += 1; events.push({ tick, kind: "aftertouch", channel }); continue; }
    if (type === 0xc0) { pos += 1; events.push({ tick, kind: "programChange", channel }); continue; }
    break; // an unrecognized status byte: the rest of this track cannot be located
  }
  return events;
}

/** Pure function. A MIDI variable-length quantity at `pos`: seven bits per byte,
 *  high bit meaning "another follows". Bounded by `end` so a truncated file cannot
 *  spin. */
function readVarInt(data, pos, end) {
  let value = 0;
  let next = pos;
  for (let i = 0; i < 4 && next < end; i++) {
    const byte = data[next++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { value, next };
}

function chunkName(data, pos) {
  return String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
}
function readU16(data, pos) { return (data[pos] << 8) | data[pos + 1]; }
function readU32(data, pos) { return ((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]) >>> 0; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * Pure function. Base64 to bytes.
 *
 * Hand-decoded rather than `atob`, for ONE reason worth the twelve lines: this
 * module is `core/`, which "MUST run in bare node; tests enforce this", and a
 * global that exists in a browser and in modern node but is not part of the
 * language is exactly the kind of ambient dependency that makes a core module stop
 * being pure. The alphabet is frozen; there is nothing here to keep up to date.
 *
 * @param {string} text - base64, with or without padding
 * @returns {Uint8Array}
 * @throws {Error} on a character outside the alphabet
 *
 * @example base64Bytes("").length // 0
 * @example Array.from(base64Bytes("TVRoZA==")) // [77, 84, 104, 100]
 */
export function base64Bytes(text) {
  const clean = String(text).replace(/[\r\n\s]/g, "").replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INDEX[clean.charCodeAt(i)];
    if (v === undefined) throw new Error(`invalid character ${JSON.stringify(clean[i])} at position ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const map = Object.create(null);
  for (let i = 0; i < B64_ALPHABET.length; i++) map[B64_ALPHABET.charCodeAt(i)] = i;
  return map;
})();

/**
 * Pure function. THE IMPORT'S ONE-LINE SUMMARY — what the modal puts in its footer
 * after a conversion, and what a test asserts on.
 *
 * IT NAMES EVERY DROP. That is the whole reason it exists rather than the modal
 * writing `${n} notes`: the counts in the report are only worth collecting if
 * something says them out loud, and a summary that mentioned only what succeeded
 * would be the silent-loss failure this module is built to avoid.
 *
 * @param {object} song - the result of `songFromAutosave` / `songFromMidiBytes`
 * @returns {string}
 *
 * @example importSummary({ok: false, error: "nope"}) // "nope"
 * @example importSummary({ok: true, notes: [1], controls: [], tempo: 120, report: {channels: [0], droppedAftertouch: 0, droppedProgramChange: 0, droppedSysex: 0, unmatchedNoteOns: 0}}) // "Imported 1 note at 120 BPM."
 */
export function importSummary(song) {
  if (!song?.ok) return song?.error ?? "Nothing was imported.";
  const r = song.report ?? {};
  const parts = [`Imported ${count(song.notes?.length ?? 0, "note")}`];
  if ((song.controls?.length ?? 0) > 0) parts.push(`and ${count(song.controls.length, "automation point")}`);
  parts.push(`at ${Math.round(song.tempo)} BPM.`);
  const notes = [];
  if ((r.channels?.length ?? 0) > 1)
    notes.push(`${r.channels.length} MIDI channels were MERGED into this one clip — one wire is one instrument, so route separate parts through separate Signal nodes.`);
  if (r.unmatchedNoteOns > 0) notes.push(`${count(r.unmatchedNoteOns, "note")} had no note-off and ${r.unmatchedNoteOns === 1 ? "was" : "were"} dropped.`);
  if (r.droppedAftertouch > 0) notes.push(`${count(r.droppedAftertouch, "aftertouch message")} dropped (a clip has no aftertouch lane).`);
  if (r.droppedProgramChange > 0) notes.push(`${count(r.droppedProgramChange, "program change")} dropped (the instrument is chosen by the wire, not by the clip).`);
  if (r.droppedSysex > 0) notes.push(`${count(r.droppedSysex, "sysex message")} dropped.`);
  return [parts.join(" "), ...notes].join(" ");
}

/** Pure function. "1 note" / "2 notes" — pluralization in one place so eight call
 *  sites above cannot each get it slightly wrong.
 *  @example count(1, "note") // "1 note"
 *  @example count(2, "note") // "2 notes" */
export function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
