/**
 * ANALYSIS DISPLAY (R7-5) — the canvas-space live picture of an audio analysis
 * node, and the ring buffer that is the actual fix.
 * Run: node src/demo_apps/PowerRP/tests/analysis_display_test.js
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 * The user reported four symptoms of the old DOM-overlay spectrogram, and the
 * SECOND one is the diagnostic: *"restart when I zoom or pan my camera"*. The
 * history lived in the pixels of a <canvas>, and a zoom resizes the element, which
 * resets its backing store. So the tests that matter here are not "does it draw" —
 * they are:
 *   §1 the ring is a correct FIFO of columns (the data the fix is made of)
 *   §2 a ZOOM DOES NOT TOUCH IT: same columns, new size, same picture rescaled
 *   §3 the picture RIDES THE NODE'S WORLD TRANSFORM (rotation included)
 *   §4 a headless surface draws NONE of it, and is byte-identical to before
 * A suite that proved only §3 and §4 would be green on a rewrite that still lost
 * its history on zoom, which is the failure mode this file exists to catch.
 *
 * Doctests in core/analysis_display.js cover the pure arithmetic (log axis, run
 * merge, unit conversions, colour thresholds); this file covers the seams between
 * modules, which a doctest cannot reach.
 */

import assert from "node:assert/strict";

import {
  ANALYSIS_HISTORY_COLUMNS, SPECTRUM_DISPLAY_ROWS, analysisDisplayDefaults, analysisDisplayOps,
  analysisDisplayRect, analysisDisplayRows, analysisHistoryColumns, createColumnRing,
  linearBinForRow, logBinForRow, meterColumnValues, pushColumn, ringColumns, runLengthCells,
  SPECTRUM_DEFAULT_RAMP_ID, SPECTRUM_PUSH_DB_CEIL, SPECTRUM_PUSH_DB_FLOOR, spectrogramOps,
  spectrumColumnValues, spectrumDisplayFraction, spectrumDrawnColumns, spectrumStyle,
} from "../core/analysis_display.js";
import { SPECTRUM_SPEC } from "../core/audio_specs.js";
import {
  SPECTRUM_DB_CEIL, SPECTRUM_DB_FLOOR, SPECTRUM_WINDOWS, spectrumColumn, spectrumFftSize,
  windowTable,
} from "../synth/spectrum.js";
import { BUNDLES, RAMP_STOP_ELEMENT } from "../core/properties.js";
import { COLOR_RAMP_LIBRARY, SEQUENTIAL_RAMPS } from "../core/ramps.js";
import {
  analysisColumnCount, analysisFlowing, dropAnalysis, onAnalysisFrame, prepareLiveAnalysis,
  pushAnalysisFrame, resetLiveAnalysis,
} from "../render_gpu/gpu/live_analysis_registry.js";
import { audioSpectrumPlugin } from "../plugins/audio_spectrum.js";
import { audioMeterPlugin } from "../plugins/audio_meter.js";
import { sceneIR } from "../render_gpu/ports.js";

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

/** Query. A spectrum column of `bins` values whose magnitudes identify it, so a
 *  test can tell WHICH frame a drawn rect came from. */
function markedColumn(bins, mark) {
  return Float32Array.from({ length: bins }, (_, i) => (i === 0 ? mark : 0));
}

/** Query. A render node the shape deriveRenderTree produces, for the one seam
 *  (sceneIR) that needs a whole node rather than a state. */
function analysisNode(itemId, plugin, state, world) {
  return { itemId, type: state.type, plugin, state, world };
}

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };

console.log("\n§1 THE RING IS THE FIX — a FIFO of magnitude columns, not pixels");

test("a partly-filled ring reports only the columns it has, oldest first", () => {
  const ring = [0.1, 0.2, 0.3].reduce((r, v) => pushColumn(r, [v]), createColumnRing(1, 8));
  assert.deepEqual(ringColumns(ring).map((c) => c[0]).map((v) => Number(v.toFixed(1))), [0.1, 0.2, 0.3]);
});

test("a full ring drops the OLDEST column and keeps the newest, across the wrap seam", () => {
  const cap = 4;
  let ring = createColumnRing(1, cap);
  for (let i = 1; i <= 10; i++) ring = pushColumn(ring, [i]);
  assert.equal(ring.count, cap);
  assert.deepEqual(ringColumns(ring).map((c) => c[0]), [7, 8, 9, 10]);
});

test("pushColumn REFUSES a mismatched width rather than reshaping a lying axis", () => {
  const ring = createColumnRing(4, 2);
  assert.throws(() => pushColumn(ring, [1, 2]), /expected 4 values, got 2/);
});

test("a new overlay kind fails LOUDLY instead of defaulting to some depth", () => {
  assert.throws(() => analysisHistoryColumns("waveform"), /no history depth declared/);
  assert.equal(analysisHistoryColumns("spectrum"), ANALYSIS_HISTORY_COLUMNS.spectrum);
});

test("the registry resets a ring when the bin count changes, and keeps it when it does not", () => {
  resetLiveAnalysis();
  pushAnalysisFrame("n1", "spectrum", markedColumn(16, 1));
  pushAnalysisFrame("n1", "spectrum", markedColumn(16, 1));
  assert.equal(analysisColumnCount("n1"), 2, "same shape accumulates");
  pushAnalysisFrame("n1", "spectrum", markedColumn(32, 1));
  assert.equal(analysisColumnCount("n1"), 1, "a changed bin count restarts, honestly");
  dropAnalysis("n1");
  assert.equal(analysisColumnCount("n1"), 0);
});

console.log("\n§2 A ZOOM DOES NOT RESTART THE HISTORY — the symptom the user named first");

test("re-emitting at a DIFFERENT node size draws the SAME columns, rescaled", () => {
  resetLiveAnalysis();
  const id = "spec1";
  // Fill the ring completely, so both renders use the full history and any loss
  // would show up as a column count, not as a partial-fill difference.
  const bins = 32;
  for (let i = 0; i < ANALYSIS_HISTORY_COLUMNS.spectrum; i++) {
    pushAnalysisFrame(id, "spectrum", markedColumn(bins, (i % 8) / 8));
  }
  const before = analysisColumnCount(id);

  const small = { type: "audio_spectrum", w: 200, h: 140 };
  const large = { type: "audio_spectrum", w: 800, h: 560 }; // the same card at 4x zoom-to-fit
  const node = analysisNode(id, audioSpectrumPlugin, small, IDENTITY);
  const ctx = { liveAnalysis: prepareLiveAnalysis([node]) };

  const opsSmall = analysisDisplayOps(ctx.liveAnalysis.get(id), audioSpectrumPlugin, small);
  const opsLarge = analysisDisplayOps(ctx.liveAnalysis.get(id), audioSpectrumPlugin, large);

  assert.equal(analysisColumnCount(id), before, "rendering must not consume or reset history");
  assert.ok(opsSmall.length > 0, "there is a picture to compare");
  assert.equal(opsSmall.length, opsLarge.length,
    `the SAME columns produce the same run structure at any size (${opsSmall.length} vs ${opsLarge.length}) — a differing count means history changed, not scale`);

  // THE PICTURE IS THE SAME PICTURE, SCALED. Every rect's box, expressed as a
  // fraction of its display band, must be identical in both renders. This is the
  // assertion the old implementation could not pass at all: its history was the
  // canvas, so the large render would have started from an empty buffer.
  const boxSmall = analysisDisplayRect(audioSpectrumPlugin, small);
  const boxLarge = analysisDisplayRect(audioSpectrumPlugin, large);
  const norm = (op, box) => [
    (op.x - box.x) / box.w, (op.y - box.y) / box.h, op.w / box.w, op.h / box.h,
  ].map((v) => Number(v.toFixed(6)));
  for (let i = 0; i < opsSmall.length; i++) {
    assert.deepEqual(norm(opsSmall[i], boxSmall), norm(opsLarge[i], boxLarge), `rect ${i} is the same cell of the same data`);
    assert.deepEqual(opsSmall[i].fill, opsLarge[i].fill, `rect ${i} is the same magnitude`);
  }
});

test("the history SURVIVES a render and keeps growing — the next frame extends it", () => {
  resetLiveAnalysis();
  const id = "spec2";
  const state = { type: "audio_spectrum", w: 200, h: 140 };
  for (let i = 0; i < 5; i++) pushAnalysisFrame(id, "spectrum", markedColumn(16, 0.9));
  const node = analysisNode(id, audioSpectrumPlugin, state, IDENTITY);
  assert.equal(prepareLiveAnalysis([node]).get(id).columns.length, 5);
  pushAnalysisFrame(id, "spectrum", markedColumn(16, 0.9));
  assert.equal(prepareLiveAnalysis([node]).get(id).columns.length, 6, "a frame later there is one more column, not a fresh buffer");
});

// THE REFERENCE WIDTH IS THE DRAWN COLUMN COUNT, NOT THE RING'S CAPACITY. Those
// were the same number until R7-19's `speed` row: the ring now holds the SLOWEST
// speed's worth of history (256 columns) and the default speed draws half of it,
// so a column's width is box.w / spectrumDrawnColumns(speed). The assertion below
// is unchanged in substance — a partial history keeps the full width's column
// pitch — only in which constant states that pitch.
test("a partial history is pinned RIGHT, so it fills in at a constant speed", () => {
  const box = { x: 0, y: 0, w: 128, h: 40 };
  const colW = box.w / spectrumDrawnColumns(spectrumStyle({}).speed);
  const two = analysisDisplayOps(
    { kind: "spectrum", columns: [markedColumn(8, 1), markedColumn(8, 1)] },
    audioSpectrumPlugin, { type: "audio_spectrum", w: box.w + 20, h: 200 },
  );
  const widths = new Set(two.map((op) => Number(op.w.toFixed(6))));
  assert.deepEqual([...widths], [Number((2 * colW).toFixed(6))],
    "two columns occupy two column-widths, not the whole band stretched");
});

console.log("\n§3 THE PICTURE IS PART OF THE NODE — z-order and rotation come free");

test("the display ops are emitted BETWEEN the card and the port beads, not on top", () => {
  resetLiveAnalysis();
  const id = "spec3";
  for (let i = 0; i < 12; i++) pushAnalysisFrame(id, "spectrum", markedColumn(16, 0.6));
  const state = { type: "audio_spectrum", w: 200, h: 140, inputs: {} };
  const node = analysisNode(id, audioSpectrumPlugin, state, IDENTITY);
  const ir = sceneIR([node], { liveAnalysis: prepareLiveAnalysis([node]) });
  const kinds = ir.map((op) => op.op);
  const firstText = kinds.indexOf("text"); // the card title
  const lastRect = kinds.lastIndexOf("rect"); // the family rim, emitted last
  assert.ok(firstText >= 0 && lastRect > firstText, "the card's own ops bracket the display");
  const withAnalysis = ir.length;
  const without = sceneIR([node]).length;
  assert.ok(withAnalysis > without, `supplying liveAnalysis adds ops (${withAnalysis} vs ${without})`);
});

test("a ROTATED node's display rotates with it — one pushTransform wraps everything", () => {
  resetLiveAnalysis();
  const id = "spec4";
  for (let i = 0; i < 12; i++) pushAnalysisFrame(id, "spectrum", markedColumn(16, 0.6));
  const state = { type: "audio_spectrum", w: 200, h: 140, inputs: {} };
  const world = { x: 40, y: 60, rotation: 30, scale: 1 };
  const node = analysisNode(id, audioSpectrumPlugin, state, world);
  const ir = sceneIR([node], { liveAnalysis: prepareLiveAnalysis([node]) });

  // THE WHOLE NODE, DISPLAY INCLUDED, IS INSIDE ONE pushTransform CARRYING THE
  // ROTATION. That single fact is the entire "doesn't rotate" fix: the old overlay
  // transformed two corners and reduced them to an axis-aligned screen box, which
  // structurally cannot rotate. Here the ops are LOCAL and the transform is the
  // node's own, so rotation is not a feature that had to be added.
  assert.equal(ir[0].op, "pushTransform");
  assert.equal(ir[0].rotation, 30, "the node's rotation is on the frame its display lives in");
  assert.equal(ir[ir.length - 1].op, "popTransform");
  const inner = ir.slice(1, -1);
  assert.equal(inner.filter((op) => op.op === "pushTransform").length, 0,
    "the display does not open a frame of its own, so it cannot escape the node's");
});

console.log("\n§4 A HEADLESS SURFACE DRAWS NONE OF IT — determinism is untouched");

test("with NO liveAnalysis context the node emits its static form, twice identically", () => {
  resetLiveAnalysis();
  const id = "spec5";
  const state = { type: "audio_spectrum", w: 200, h: 140, inputs: {} };
  const node = analysisNode(id, audioSpectrumPlugin, state, IDENTITY);
  const before = JSON.stringify(sceneIR([node]));
  // Live samples arrive between the two renders — the Δt = 0 test. An export,
  // a thumbnail and cli/render.js all take this path.
  for (let i = 0; i < 40; i++) pushAnalysisFrame(id, "spectrum", markedColumn(16, Math.random()));
  const after = JSON.stringify(sceneIR([node]));
  assert.equal(after, before, "a surface that passes no liveAnalysis is byte-identical across a live audio frame");
});

test("prepareLiveAnalysis returns null when nothing is live — the common case costs one walk", () => {
  resetLiveAnalysis();
  const node = analysisNode("q", audioSpectrumPlugin, { type: "audio_spectrum", w: 200, h: 140 }, IDENTITY);
  assert.equal(prepareLiveAnalysis([node]), null);
});

test("a retyped item does not draw the PREVIOUS widget's columns", () => {
  resetLiveAnalysis();
  const id = "morph";
  for (let i = 0; i < 6; i++) pushAnalysisFrame(id, "spectrum", markedColumn(16, 0.5));
  // The item keeps its id and becomes a meter. The ring still holds spectrum
  // columns; the node must not be handed them.
  const asMeter = analysisNode(id, audioMeterPlugin, { type: "audio_meter", w: 120, h: 140 }, IDENTITY);
  assert.equal(prepareLiveAnalysis([asMeter]), null, "the kind must agree with the NODE, not with the buffer");
});

console.log("\n§4b THE REPAINT WAKE — a live display must ask for frames nobody else will");

// THE USER'S BUG: "The spectrogram doesnt update unless i move it btw its like its
// not trying to update." Moving the node changed DOCUMENT state, which invalidated
// the frame; a pushed column invalidates nothing, by design. So the picture only
// advanced when something ELSE asked for a repaint. These pin both halves of the
// fix — that a column wakes a listener, and that a quiet deck wakes nobody.

test("a pushed column notifies listeners WITH the item id, so the wake can be gated on-screen", () => {
  resetLiveAnalysis();
  const seen = [];
  const off = onAnalysisFrame((id) => seen.push(id));
  pushAnalysisFrame("visible", "spectrum", markedColumn(16, 0.5));
  pushAnalysisFrame("offscreen", "spectrum", markedColumn(16, 0.5));
  off();
  pushAnalysisFrame("visible", "spectrum", markedColumn(16, 0.5));
  assert.deepEqual(seen, ["visible", "offscreen"], "every push fires once, named; unsubscribing stops it");
});

test("CONSECUTIVE FRAMES DIFFER with the document untouched — the picture is moving", () => {
  resetLiveAnalysis();
  const id = "moving";
  const state = { type: "audio_spectrum", w: 200, h: 140, inputs: {} };
  const node = analysisNode(id, audioSpectrumPlugin, state, IDENTITY);
  // A GLIDING tone, so successive frames are genuinely different pictures rather
  // than the same one redrawn — a static signal would make this test pass on an
  // implementation that never advanced at all.
  const glide = (f) => Float32Array.from({ length: 32 }, (_, b) => Math.exp(-((b - (3 + f)) ** 2) / 2));
  for (let f = 0; f < 20; f++) pushAnalysisFrame(id, "spectrum", glide(f));
  const first = JSON.stringify(sceneIR([node], { liveAnalysis: prepareLiveAnalysis([node]) }));
  // NOTHING is touched but the ring: same document, same node, same world, no
  // pointer, no view change. This is exactly the situation the user was in.
  for (let f = 20; f < 40; f++) pushAnalysisFrame(id, "spectrum", glide(f));
  const second = JSON.stringify(sceneIR([node], { liveAnalysis: prepareLiveAnalysis([node]) }));
  assert.notEqual(second, first, "a later frame draws a later picture with no document change whatsoever");
});

test("a deck with NO analysis display is NOT flowing — the loop must not start", () => {
  resetLiveAnalysis();
  const plain = { itemId: "rect1", type: "rect", plugin: {}, state: { type: "rect", w: 10, h: 10 }, world: IDENTITY };
  assert.equal(analysisFlowing([plain]), false, "no analysis node, nothing flowing");
  // An analysis node that has never received a column is also not flowing: a deck
  // whose audio never started must not hold a repaint loop open.
  const silent = analysisNode("s", audioSpectrumPlugin, { type: "audio_spectrum", w: 200, h: 140 }, IDENTITY);
  assert.equal(analysisFlowing([silent]), false, "a display with no history yet is not animated");
  pushAnalysisFrame("s", "spectrum", markedColumn(16, 0.5));
  assert.equal(analysisFlowing([silent]), true, "and it becomes animated the moment a column lands");
});

test("THE LOOP SHUTS ITSELF OFF once columns stop arriving", () => {
  resetLiveAnalysis();
  const node = analysisNode("stops", audioSpectrumPlugin, { type: "audio_spectrum", w: 200, h: 140 }, IDENTITY);
  pushAnalysisFrame("stops", "spectrum", markedColumn(16, 0.5));
  const at = performance.now();
  assert.equal(analysisFlowing([node], at + 100), true, "still flowing a moment later");
  // A ring KEEPS its history after audio stops, so a "does it have columns" test
  // would stay true forever and hold the presenter's rAF loop open for the session.
  assert.ok(analysisColumnCount("stops") > 0, "the history is still there...");
  assert.equal(analysisFlowing([node], at + 5000), false, "...but five seconds of silence is not an animation");
});

console.log("\n§5 THE OP COUNT IS BOUNDED — the run merge is load-bearing, not decoration");

test("a worst-case frame stays far below the unmerged cell count", () => {
  const cols = ANALYSIS_HISTORY_COLUMNS.spectrum;
  const cells = cols * SPECTRUM_DISPLAY_ROWS;
  // Silence: one rect per row, which is the case that dominates a real session.
  const silent = analysisDisplayOps(
    { kind: "spectrum", columns: Array.from({ length: cols }, () => new Float32Array(64)) },
    audioSpectrumPlugin, { type: "audio_spectrum", w: 200, h: 140 },
  );
  assert.equal(silent.length, SPECTRUM_DISPLAY_ROWS, `silence merges to one rect per row (${silent.length})`);
  // Pure noise is the adversarial case and must still be finite and bounded by the
  // grid, never larger than it.
  let seed = 1;
  const noise = Array.from({ length: cols }, () => Float32Array.from({ length: 64 }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }));
  const noisy = analysisDisplayOps({ kind: "spectrum", columns: noise }, audioSpectrumPlugin, { type: "audio_spectrum", w: 200, h: 140 });
  assert.ok(noisy.length <= cells, `bounded by the grid (${noisy.length} <= ${cells})`);

  // THE CASE THAT ACTUALLY HAPPENS, measured beside the two extremes so the number
  // in the report is the one a user experiences. A held note: a few harmonics over
  // a decaying floor, temporally smooth — which is what makes the time-axis merge
  // pay. White noise above is the adversarial end (the `noise` module reaches it),
  // and it is bounded by the grid rather than by luck.
  const tone = Array.from({ length: cols }, (_, c) => Float32Array.from({ length: 64 }, (_, b) => {
    const harmonic = [4, 8, 12, 16].reduce((a, h) => a + Math.exp(-((b - h) ** 2) / 2), 0);
    return Math.min(1, harmonic * (0.8 + 0.2 * Math.sin(c / 9)) + 0.04);
  }));
  const musical = analysisDisplayOps({ kind: "spectrum", columns: tone }, audioSpectrumPlugin, { type: "audio_spectrum", w: 200, h: 140 });
  assert.ok(musical.length < noisy.length / 4, `a held tone merges hard (${musical.length} vs ${noisy.length} for noise)`);
  console.log(`      measured ops/frame: silence ${silent.length}, held tone ${musical.length}, white noise ${noisy.length}; unmerged grid ${cells}, PARTICLE_HARD_CAP 4000`);
});

test("runLengthCells covers every cell exactly once", () => {
  const grid = [[1, 1, 2], [3, 3, 3]];
  const covered = runLengthCells(grid).reduce((n, c) => n + c.span, 0);
  assert.equal(covered, 6);
});

console.log("\n§6 THE UNIT SEAM — the ring is unit-free, both producers agree on 0..1");

// THE SPECTRUM PRODUCER NO LONGER DIVIDES BY 255, and that is the R7-19 rewrite
// rather than a loosened assertion: `getByteFrequencyData` hard-wires a Blackman
// window (Web Audio spec, no parameter), so honouring the `window` row meant
// running our own FFT. synth/spectrum.js now normalises to 0..1 itself and
// spectrumColumnValues only COPIES out of the engine's reused buffer. What the
// test must pin therefore changed with it: the range check moves to the producer
// (below), and what is checked here is the copy.
test("both column producers land in 0..1 and are the right length", () => {
  const spec = spectrumColumnValues(Float32Array.of(0, 0.5, 1));
  assert.equal(spec.length, 3);
  assert.deepEqual([...spec], [0, 0.5, 1]);
  assert.equal(meterColumnValues(-12).length, 1);
  assert.ok(meterColumnValues(-12)[0] > meterColumnValues(-40)[0], "louder reads higher");
});

test("the push seam COPIES — the engine's buffer is reused and must not be aliased", () => {
  const shared = Float32Array.of(0.25, 0.75);
  const kept = spectrumColumnValues(shared);
  shared[0] = 1; // what the very next poll does
  assert.equal(kept[0], 0.25, "a stored column must not change when the engine writes its next frame");
});

test("core's restated dB range AGREES with the engine that produces it", () => {
  // core/ may not import synth/** (an AudioContext does not exist in bare node),
  // so the range is restated there. This is the cross-check that keeps the
  // restatement honest — the same seam tests/audio_nodes_test.js uses for knobs.
  assert.equal(SPECTRUM_PUSH_DB_FLOOR, SPECTRUM_DB_FLOOR);
  assert.equal(SPECTRUM_PUSH_DB_CEIL, SPECTRUM_DB_CEIL);
});

test("THE dB WINDOW: the default reproduces what the browser analyser showed", () => {
  // getByteFrequencyData mapped -100..-30 dBFS onto 0..255. The engine now pushes
  // over -100..0, so the DEFAULT display window must be -100..-30 or every
  // existing spectrogram would dim.
  const style = spectrumStyle({});
  assert.deepEqual([style.floorDb, style.ceilDb], [-100, -30]);
  assert.equal(spectrumDisplayFraction(0.7, style.floorDb, style.ceilDb), 1, "-30 dBFS is the top of the ramp");
  assert.equal(spectrumDisplayFraction(0, style.floorDb, style.ceilDb), 0);
  // AND IT IS A WINDOW, NOT A CLIP: raising the ceiling recovers detail that a
  // clipped push would have destroyed.
  const loud = 0.85; // -15 dBFS
  assert.equal(spectrumDisplayFraction(loud, -100, -30), 1, "above the default ceiling, indistinguishable");
  assert.ok(spectrumDisplayFraction(loud, -100, 0) < 1, "...but still distinguishable when the ceiling is raised");
});

test("every legal bin option is one the ENGINE accepts, and the spec's default is real", () => {
  const knob = SPECTRUM_SPEC.knobs.find((k) => k.key === "bins");
  for (const option of knob.options) {
    assert.equal(spectrumFftSize(option), Number(option) * 2, `bins ${option} must convert`);
  }
  assert.ok(knob.options.includes(knob.default));
  assert.throws(() => spectrumFftSize(1000), /POWER OF TWO/);
  const win = SPECTRUM_SPEC.knobs.find((k) => k.key === "window");
  assert.deepEqual(win.options, Object.keys(SPECTRUM_WINDOWS),
    "the spec's window list is a RESTATEMENT of synth/spectrum.js's — they must agree exactly");
  assert.ok(win.options.includes(win.default));
});

test("THE WINDOW ROW HAS A PICTURE BEHIND IT: two windows, measurably different spectra", () => {
  // THE CLASSIC CASE, and the one a bin-centred tone would hide: a sine sitting
  // BETWEEN two bins does not fit a whole number of periods in the window, so the
  // slice does not join up with itself and the rectangular window sprays energy
  // across the whole spectrum. A taper is exactly what removes that.
  const N = 256;
  const offBin = 20.5; // half a bin off centre — the worst case for leakage
  const samples = Float32Array.from({ length: N }, (_, n) => Math.sin(2 * Math.PI * offBin * n / N));
  const column = (name) => spectrumColumn(
    samples, windowTable(name, N), new Float32Array(N), new Float32Array(N), null, 0, new Float32Array(N / 2),
  );
  // Leakage measured where the tone is NOT: everything more than 4 bins away.
  const skirt = (col) => [...col].filter((_, k) => Math.abs(k - offBin) > 4).reduce((a, v) => Math.max(a, v), 0);
  const rect = skirt(column("rectangular"));
  const hann = skirt(column("hann"));
  const bh = skirt(column("blackmanHarris"));
  console.log(`      measured far-skirt (0..1 of a -100..0 dB scale): rectangular ${rect.toFixed(3)}, hann ${hann.toFixed(3)}, blackman-harris ${bh.toFixed(3)}`);
  assert.ok(rect > hann, `a rectangular window must leak MORE than Hann (${rect.toFixed(3)} vs ${hann.toFixed(3)})`);
  assert.ok(hann > bh, `and Hann more than Blackman-Harris (${hann.toFixed(3)} vs ${bh.toFixed(3)})`);
});

test("the analysis specs are born tall enough to hold a display", () => {
  for (const plugin of [audioSpectrumPlugin, audioMeterPlugin]) {
    const box = analysisDisplayRect(plugin, plugin.defaults);
    assert.ok(box !== null, `${plugin.defaults.type} has a display band at its default size`);
    assert.ok(box.h >= 12, `${plugin.defaults.type} band is ${box.h}`);
  }
});

console.log("\n§7 R7-19 THE DISPLAY IS AUTHORED — every option has an Inspector row");

test("NO JSON-ONLY PROPERTIES: every display default has a row, and every row a default", () => {
  for (const kind of ["meter", "spectrum"]) {
    const rows = analysisDisplayRows(kind, "audio").map((r) => r.key);
    const defaults = Object.keys(analysisDisplayDefaults(kind));
    // rampStopsActive is the list's companion and has no row of its own, by the
    // core/lists.js contract; every OTHER default must be reachable.
    for (const key of defaults) assert.ok(rows.includes(key), `${kind}: default "${key}" has no Inspector row`);
    for (const key of rows) assert.ok(defaults.includes(key), `${kind}: row "${key}" has no default`);
  }
});

test("the colour map is the SHARED ramp bundle, not a second colormap type", () => {
  const rows = analysisDisplayRows("spectrum", "audio");
  assert.deepEqual(rows.slice(0, 4).map((r) => r.key), BUNDLES.ramp,
    "the spectrogram's colours must BE bundle(\"ramp\") — the keys a Mandelbrot palette and a gradient preset already speak");
  assert.equal(rows[0].presets, COLOR_RAMP_LIBRARY, "so it gets the shared preset library from the DECLARATION");
  assert.equal(rows[0].element, RAMP_STOP_ELEMENT, "and the one stop element");
  assert.equal(new Set(rows.map((r) => r.category)).size, 1, "one collapsible group, not two");
});

test("the default map is a PUBLISHED one, read in the space it was published in", () => {
  const d = analysisDisplayDefaults("spectrum");
  assert.deepEqual(d.rampStops, SEQUENTIAL_RAMPS[SPECTRUM_DEFAULT_RAMP_ID].stops);
  assert.notEqual(d.rampStops, SEQUENTIAL_RAMPS[SPECTRUM_DEFAULT_RAMP_ID].stops,
    "a FRESH copy — a document must never alias author-time data");
  assert.equal(d.rampSpace, "oklab");
  assert.equal(d.rampLoop, false);
});

test("TWO RAMPS, ONE FRAME: the same column draws different colours", () => {
  const box = { x: 0, y: 0, w: 100, h: 40 };
  const column = Float32Array.from({ length: 16 }, (_, i) => i / 15);
  const under = (extra) => spectrogramOps(box, [column], spectrumStyle(extra)).map((op) => op.fill);
  const magma = under({});
  const grey = under({ rampStops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], rampSpace: "srgb" });
  assert.equal(magma.length, grey.length, "same data, same op count — only the colours differ");
  assert.ok(magma.some((c, i) => String(c) !== String(grey[i])), "the ramp must actually reach the pixels");
  // GREYSCALE IS THE CHECKABLE ONE: r === g === b at every level, and it must span
  // the scale. (`rect` parses the stored hex, so a fill is rgba floats in 0..1.)
  for (const [r, g, b] of grey) assert.ok(r === g && g === b, `not neutral: ${[r, g, b]}`);
  const lum = grey.map((c) => c[0]);
  assert.ok(Math.max(...lum) - Math.min(...lum) > 0.9, `the greyscale ramp must span the scale, got ${Math.min(...lum)}..${Math.max(...lum)}`);
});

test("SPEED IS A SUFFIX OF THE RING, so it rescales rather than restarting", () => {
  const box = { x: 0, y: 0, w: 256, h: 40 };
  const columns = Array.from({ length: 256 }, (_, i) => Float32Array.of(i / 255));
  const at = (speed) => spectrogramOps(box, columns, spectrumStyle({ spectrumSpeed: speed }));
  const [slow, mid, fast] = [0.5, 1, 4].map(at);
  // The band is always full; what changes is how many columns share it.
  for (const ops of [slow, mid, fast]) {
    const span = Math.max(...ops.map((o) => o.x + o.w)) - Math.min(...ops.map((o) => o.x));
    assert.ok(Math.abs(span - box.w) < 1e-6, `the picture must fill the band at every speed, got ${span}`);
  }
  assert.ok(fast[0].w > mid[0].w && mid[0].w > slow[0].w, "faster = wider columns = fewer of them across the band");
  // AND THE HISTORY SURVIVES: the oldest column a fast display shows is NEWER
  // than the oldest a slow one shows, from the SAME untouched ring.
  assert.equal(spectrumDrawnColumns(0.5), columns.length, "the slowest speed uses every column stored");
});

test("the frequency axis is authored, and the two axes really differ", () => {
  const bins = 64;
  const rows = SPECTRUM_DISPLAY_ROWS;
  const logRows = Array.from({ length: rows }, (_, r) => logBinForRow(r, rows, bins));
  const linRows = Array.from({ length: rows }, (_, r) => linearBinForRow(r, rows, bins));
  assert.deepEqual([logRows[0], logRows[rows - 1]], [bins - 1, 0], "both axes are pinned at both ends");
  assert.deepEqual([linRows[0], linRows[rows - 1]], [bins - 1, 0]);
  // The LINEAR axis has a constant DIFFERENCE between rows; the log axis a
  // constant RATIO. Measure the second difference to tell them apart.
  const spread = (a) => { const d = a.slice(1).map((v, i) => a[i] - v); return Math.max(...d) - Math.min(...d); };
  assert.ok(spread(linRows) <= 1, `linear steps must be equal to within rounding, got a spread of ${spread(linRows)}`);
  assert.ok(spread(logRows) > 5, `log steps must NOT be equal, got a spread of ${spread(logRows)}`);
});

console.log(failures === 0 ? "\nAll analysis-display tests passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
