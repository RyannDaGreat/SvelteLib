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
  ANALYSIS_HISTORY_COLUMNS, SPECTRUM_DISPLAY_ROWS, analysisDisplayOps, analysisDisplayRect,
  analysisHistoryColumns, createColumnRing, meterColumnValues, pushColumn, ringColumns,
  runLengthCells, spectrumColumnValues,
} from "../core/analysis_display.js";
import {
  analysisColumnCount, dropAnalysis, prepareLiveAnalysis, pushAnalysisFrame, resetLiveAnalysis,
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

test("a partial history is pinned RIGHT, so it fills in at a constant speed", () => {
  const box = { x: 0, y: 0, w: 128, h: 40 };
  const colW = box.w / ANALYSIS_HISTORY_COLUMNS.spectrum;
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

test("both column producers land in 0..1 and are the right length", () => {
  const spec = spectrumColumnValues(Uint8Array.of(0, 128, 255));
  assert.equal(spec.length, 3);
  assert.ok([...spec].every((v) => v >= 0 && v <= 1));
  assert.equal(meterColumnValues(-12).length, 1);
  assert.ok(meterColumnValues(-12)[0] > meterColumnValues(-40)[0], "louder reads higher");
});

test("the analysis specs are born tall enough to hold a display", () => {
  for (const plugin of [audioSpectrumPlugin, audioMeterPlugin]) {
    const box = analysisDisplayRect(plugin, plugin.defaults);
    assert.ok(box !== null, `${plugin.defaults.type} has a display band at its default size`);
    assert.ok(box.h >= 12, `${plugin.defaults.type} band is ${box.h}`);
  }
});

console.log(failures === 0 ? "\nAll analysis-display tests passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
