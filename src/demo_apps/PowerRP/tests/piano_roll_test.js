/**
 * THE PIANO ROLL'S GEOMETRY, and the EDIT PATH the modal's gestures drive.
 * Run: node src/demo_apps/PowerRP/tests/piano_roll_test.js
 *
 * ── WHY THIS IS A NODE TEST AND NOT A BROWSER ONE ───────────────────────────
 * `core/piano_roll.js`'s header states it: a piano roll is mostly coordinate
 * arithmetic with a lot of off-by-one places to hide in, and arithmetic living in
 * a `.svelte` file can only be tested by booting a browser — slow, flaky, and (on
 * this host, per CLAUDE.md's preflight note) capable of failing for reasons that
 * have nothing to do with the app. So the mapping is proven here, and
 * tests/piano_roll_probe.js is left free to ask only what a browser can answer.
 *
 * The gesture MATH is exercised here too — this file reconstructs what a move and
 * an edge-resize compute, against the same helpers web/PianoRollModal.svelte calls
 * — so that a regression in the drag arithmetic (a note jumping under the cursor,
 * a resize inverting a note) is caught without a pointer.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_VIEW, MIN_NOTE_PX, RESIZE_EDGE_PX, ZOOM_LIMITS,
  beatToX, isBlackPitch, noteHitAt, noteRect, noteZoneAt, pitchName, pitchToY,
  scrolledView, xToBeat, yToPitch, zoomedView,
} from "../core/piano_roll.js";
import { MIN_DURATION_BEATS, snapBeat, withNoteAt } from "../core/midi_clip.js";

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed += 1; };
const V = DEFAULT_VIEW;

// ── THE MAPPING ──────────────────────────────────────────────────────────────

check("beat↔x round-trips exactly, at any scroll and zoom", () => {
  for (const view of [V, { ...V, originBeat: 3.25 }, { ...V, beatWidth: 7.5 }, { ...V, beatWidth: 200, originBeat: 11 }])
    for (const beat of [0, 0.25, 1, 3.5, 17])
      assert.ok(Math.abs(xToBeat(beatToX(beat, view), view) - beat) < 1e-9, `beat ${beat} at ${JSON.stringify(view)}`);
});

check("pitch↔y round-trips, and every y INSIDE a row maps to that row", () => {
  for (const pitch of [0, 60, 84, 127]) {
    const y = pitchToY(pitch, { ...V, topPitch: 127 });
    assert.equal(yToPitch(y, { ...V, topPitch: 127 }), pitch);
    // The whole row, not just its top edge — this is what makes a drag land on
    // the note the pointer is visually over.
    assert.equal(yToPitch(y + V.rowHeight - 0.001, { ...V, topPitch: 127 }), pitch);
  }
});

check("the pitch axis runs UPWARD — the one convention a piano roll cannot negotiate", () => {
  assert.ok(pitchToY(72, V) < pitchToY(60, V), "a higher note must be higher on screen");
  assert.equal(yToPitch(0, V), V.topPitch);
  assert.equal(yToPitch(V.rowHeight, V), V.topPitch - 1);
});

check("neither axis can be dragged out of its domain", () => {
  assert.equal(xToBeat(-10000, V), 0);                       // no time before beat 0
  assert.equal(yToPitch(-10000, V), 127);                    // no note above 127
  assert.equal(yToPitch(1e7, V), 0);                         // …or below 0
  assert.equal(scrolledView(V, -1e6, 0).originBeat, 0);
  assert.equal(scrolledView(V, 0, -1e6).topPitch, 127);
  assert.equal(scrolledView(V, 0, 1e6).topPitch, 0);
});

check("zoom is clamped in both directions rather than unbounded", () => {
  assert.equal(zoomedView(V, "beatWidth", 1e6).beatWidth, ZOOM_LIMITS.beatWidth[1]);
  assert.equal(zoomedView(V, "beatWidth", 1e-6).beatWidth, ZOOM_LIMITS.beatWidth[0]);
  assert.equal(zoomedView(V, "rowHeight", 1e6).rowHeight, ZOOM_LIMITS.rowHeight[1]);
  assert.equal(zoomedView(V, "rowHeight", 1e-6).rowHeight, ZOOM_LIMITS.rowHeight[0]);
  // Zooming one axis must not disturb the other, or a beat zoom would resize rows.
  assert.equal(zoomedView(V, "beatWidth", 2).rowHeight, V.rowHeight);
  assert.equal(zoomedView(V, "rowHeight", 2).beatWidth, V.beatWidth);
});

// ── HIT TESTING ──────────────────────────────────────────────────────────────

check("a note's body MOVES and its edges RESIZE", () => {
  const note = { start: 0, duration: 4, pitch: 84 };
  assert.equal(noteZoneAt(note, 56, 7, V), "body");
  assert.equal(noteZoneAt(note, 1, 7, V), "start");
  assert.equal(noteZoneAt(note, 4 * V.beatWidth - 1, 7, V), "end");
});

check("A SHORT NOTE ALWAYS HAS A BODY — else it could be resized but never moved", () => {
  // Without the third-of-the-width cap, any note narrower than 2*RESIZE_EDGE_PX is
  // ENTIRELY edges: visible, resizable, and impossible to drag.
  for (const duration of [0.05, 0.1, 0.25, 0.5, 1]) {
    const note = { start: 0, duration, pitch: 84 };
    const r = noteRect(note, V);
    const zones = [];
    for (let x = r.x; x < r.x + r.w; x += 0.25) zones.push(noteZoneAt(note, x, 7, V));
    assert.ok(zones.includes("body"), `a ${duration}-beat note has no body (w=${r.w}px, edge=${RESIZE_EDGE_PX})`);
  }
});

check("a sliver is drawn at a HITTABLE minimum width", () => {
  // A sub-pixel note that can be seen and not clicked is worse than one drawn
  // slightly too wide.
  assert.equal(noteRect({ start: 0, duration: 0.0001, pitch: 84 }, V).w, MIN_NOTE_PX);
  assert.ok(noteZoneAt({ start: 0, duration: 0.0001, pitch: 84 }, 1, 7, V) !== null);
});

check("a point on a different row, or past a note's end, hits nothing", () => {
  const note = { start: 0, duration: 1, pitch: 84 };
  assert.equal(noteZoneAt(note, 14, V.rowHeight + 2, V), null);
  assert.equal(noteZoneAt(note, 500, 7, V), null);
  assert.equal(noteZoneAt(note, -5, 7, V), null);
});

check("overlapping notes: the LAST DRAWN wins the pointer", () => {
  // A sustained chord under a melody is routine. First-match would make the
  // buried note unreachable while the visible one ignored clicks.
  const notes = [{ start: 0, duration: 2, pitch: 84 }, { start: 0, duration: 2, pitch: 84 }];
  assert.equal(noteHitAt(notes, 28, 7, V).index, 1);
  assert.equal(noteHitAt([], 0, 0, V), null);
});

// ── LANES AND LABELS ─────────────────────────────────────────────────────────

check("the black-key lanes are the real pattern, at every octave and below zero", () => {
  assert.deepEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].map(isBlackPitch),
    [false, true, false, true, false, false, true, false, true, false, true, false]);
  assert.equal(isBlackPitch(1), true);
  assert.equal(isBlackPitch(-1), false); // the modulo must not go negative
});

check("pitch names use the convention where middle C is C4", () => {
  assert.equal(pitchName(60), "C4");
  assert.equal(pitchName(69), "A4");
  assert.equal(pitchName(61), "C#4");
  assert.equal(pitchName(0), "C-1");
  assert.equal(pitchName(127), "G9");
});

// ── THE GESTURE MATH (what the modal computes) ──────────────────────────────

check("a MOVE keeps the grab offset — the note does not jump under the cursor", () => {
  // Grab a 4-beat note near its END and nudge it one beat right. Without the
  // offset the note's START would snap under the pointer — a jump of most of a bar.
  const origin = { start: 0, duration: 4, pitch: 84, velocity: 100 };
  const grabBeat = 3.5;
  const grabOffset = grabBeat - origin.start;
  const moved = { ...origin, start: snapBeat(4.5 - grabOffset, 0.25) };
  assert.equal(moved.start, 1);
  assert.equal(moved.duration, 4, "a move must not change the length");
});

check("an END-edge resize moves the end and leaves the start", () => {
  const o = { start: 1, duration: 2, pitch: 84, velocity: 100 };
  const resized = { ...o, duration: Math.max(MIN_DURATION_BEATS, snapBeat(4, 0.25) - o.start) };
  assert.equal(resized.start, 1);
  assert.equal(resized.duration, 3);
});

check("a START-edge resize moves the start and PINS the end", () => {
  const o = { start: 1, duration: 2, pitch: 84, velocity: 100 };
  const end = o.start + o.duration;              // 3
  const start = Math.min(snapBeat(2, 0.25), end - MIN_DURATION_BEATS);
  assert.equal(start, 2);
  assert.equal(start + (end - start), end, "the end must not have moved");
});

check("neither resize can INVERT a note, however far the pointer goes", () => {
  const o = { start: 2, duration: 2, pitch: 84, velocity: 100 };
  const end = o.start + o.duration;
  // Drag the START edge far past the end.
  const start = Math.min(snapBeat(99, 0.25), end - MIN_DURATION_BEATS);
  assert.ok(start < end, "the start must stay before the end");
  assert.ok(end - start >= MIN_DURATION_BEATS);
  // Drag the END edge far before the start.
  const duration = Math.max(MIN_DURATION_BEATS, snapBeat(0, 0.25) - o.start);
  assert.equal(duration, MIN_DURATION_BEATS);
  // …and the model clamps whatever the editor hands it, as a second line of defence.
  assert.equal(withNoteAt({ list: [[2, 2, 84, 100]] }, 0, { ...o, duration: -10 }).list[0][1], MIN_DURATION_BEATS);
});

check("with snapping OFF a drag lands exactly where the pointer is", () => {
  assert.equal(snapBeat(xToBeat(37, V), 0), 37 / V.beatWidth);
});

console.log(`\npiano_roll_test: ${passed} checks passed`);
