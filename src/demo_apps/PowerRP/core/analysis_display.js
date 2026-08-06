/**
 * THE ANALYSIS DISPLAY — an audio analysis node's live picture, as DATA and as
 * display-list ops. Pure, DOM-free, bare-node testable.
 *
 * ── THE DEFECT THIS MODULE EXISTS TO REMOVE ─────────────────────────────────
 * The spectrogram used to be a DOM `<canvas>` composited over the scene, and the
 * user reported four symptoms at once (R7-5, verbatim): *"Why does the spectrogram
 * image always show on TOP of everything else and restart when I zoom or pan my
 * camera btw its clearly not part of the canvas which is very annoying its like
 * some overlaid dom element or some bullshit. not acceptable. not recordable and
 * not renderable :("*
 *
 * They are ONE root cause, and **the second one names it**: the waterfall's
 * history lived in THE PIXELS of that canvas. The scroll was a self-blit
 * (`drawImage(canvas, -1, 0)`), so the canvas WAS the history buffer — and a zoom
 * changes the element's width/height, which resets its backing store and erases
 * the accumulated image. Everything else followed from the same choice: a DOM
 * layer is above ALL canvas content (no z-interleaving), its rect was built from
 * two transformed corners reduced to an axis-aligned box (no rotation), and no
 * exporter or headless renderer ever consults it (not renderable).
 *
 * **SO THE LOAD-BEARING FIX IS A DATA CHANGE, NOT A DRAWING CHANGE.** History is a
 * RING BUFFER OF MAGNITUDE COLUMNS (`createColumnRing` / `pushColumn` below), held
 * in render_gpu/gpu/live_analysis_registry.js and re-rendered from scratch every
 * frame. Zoom then re-renders THE SAME COLUMNS at a new size instead of destroying
 * them; the columns become ordinary `rect` ops, so they sit in the node's own
 * z-order, ride its world transform (rotation included) and reach every backend
 * that can already draw a rect. A rewrite that moved the drawing into `emit()` but
 * left history in a pixel buffer would have fixed three symptoms and left the one
 * the user noticed first.
 *
 * ── WHAT THIS IS NOT: IT IS NOT RECORDABLE STATE ────────────────────────────
 * Read CLAUDE.md's "four kinds of state" before assuming otherwise. Live analysis
 * of a live `AudioContext` is not reproducible — it is the same class as a video
 * PLAYER's current frame, and it fails the Δt = 0 test outright (two renders at
 * the same presentation time see two different sample buffers). **The editor and
 * the presenter draw live analysis; a headless render draws NONE** — no columns
 * ever reach `cli/render.js`, the PNG/PDF/SVG exporters, or the video render job,
 * because those surfaces pass no `liveAnalysis` context (render_gpu/ports.js's
 * display-context law: the map is a plain ARGUMENT, never a global the walker
 * reaches into). What they render is the node's static form, which is the honest
 * picture of a document that has no sound in it.
 *
 * The honest future direction, named so nobody has to rediscover it:
 * `OfflineAudioContext`. A synth patch built from document state IS a pure
 * function of the document and time, so rendering the patch offline for a frame
 * range and computing the columns from THAT would move this into genuinely
 * recordable state and make an exported spectrogram exact. It is real work, it is
 * out of R7-5's scope, and the ring buffer here is a prerequisite for it either
 * way — an offline path produces exactly these columns from a different source.
 *
 * ── UNITS: THE RING IS UNIT-FREE ────────────────────────────────────────────
 * Every value in a column is a magnitude in 0..1. The engine's units (a
 * Uint8Array of 0..255 FFT bins, a dBFS level) are converted at the PUSH seam by
 * `spectrumColumnValues` / `meterColumnValues` below, so the buffer, the ring
 * arithmetic and the drawing all speak one scale. R7-19's `bins` row changes the
 * column LENGTH and nothing else.
 */

import { rect } from "../render_gpu/ir.js";
import { sampleRampHex } from "./ramps.js";
import { NODE_PAD, nodeBodyTop, nodeBox } from "./node_chrome.js";

/**
 * THE FLOOR of a level meter's scale, in dBFS. -60 is quiet-but-audible; going
 * lower would spend most of the bar on silence. Exported because the PUSH seam
 * (web/audioMirror.svelte.js) normalizes against it and the drawing reads it back
 * — one constant, not two spellings of the same number.
 */
export const METER_FLOOR_DB = -60;

/**
 * How many columns of history each display kind keeps.
 *
 * A SPECTROGRAM'S depth is its time axis: 128 columns at the engine's ~60 Hz poll
 * is a little over two seconds of history, which is long enough to see a note's
 * decay and short enough that the picture still moves. A METER has no time axis —
 * it draws one bar from the newest reading — so its ring is depth 1. Depth 1 is a
 * legitimate instance of the ring contract ("the last N frames"), not a hack to
 * make one mechanism cover two widgets.
 *
 * NOT a per-node property yet. R7-19's `speed` row is exactly this number becoming
 * authored property state, and it is ordered after R7-5 deliberately.
 */
export const ANALYSIS_HISTORY_COLUMNS = Object.freeze({ meter: 1, spectrum: 128 });

/**
 * Query (throws on an unknown kind). The history depth for an `overlay` kind.
 *
 * LOUD ON A NEW KIND, deliberately. `ANALYSIS_HISTORY_COLUMNS` mirrors the
 * `overlay` values declared in core/audio_specs.js, and a hand-maintained mirror
 * that silently defaults is the drift this codebase names as its worst recurring
 * defect. A third analysis widget must state its own depth or fail here, where the
 * message says what to do.
 *
 * @param {string} kind - an `overlay` value from an audio spec
 * @returns {number} the ring's capacity in columns
 *
 * @example analysisHistoryColumns("meter")
 * 1
 * @example analysisHistoryColumns("spectrum")
 * 128
 */
export function analysisHistoryColumns(kind) {
  const depth = ANALYSIS_HISTORY_COLUMNS[kind];
  if (depth === undefined) {
    throw new Error(
      `analysisHistoryColumns: no history depth declared for overlay kind ${JSON.stringify(kind)}` +
      ` — add it to ANALYSIS_HISTORY_COLUMNS in core/analysis_display.js (known: ${Object.keys(ANALYSIS_HISTORY_COLUMNS).join(", ")})`,
    );
  }
  return depth;
}

// ── THE RING ─────────────────────────────────────────────────────────────────

/**
 * Pure function. A fresh, empty column ring: `capacity` columns of `bins` values
 * each, in ONE flat Float32Array.
 *
 * FLAT, NOT AN ARRAY OF ARRAYS. The buffer is written ~60 times a second per node
 * for the life of a session; a per-frame allocation is exactly the GC pressure the
 * engine's own reused-buffer contract exists to avoid. One allocation at birth,
 * none afterwards.
 *
 * @param {number} bins - values per column (an FFT bin count, or 1 for a meter)
 * @param {number} capacity - how many columns of history to keep
 * @returns {{bins: number, capacity: number, head: number, count: number, data: Float32Array}}
 *
 * @example createColumnRing(4, 3).data.length
 * 12
 * @example createColumnRing(4, 3).count
 * 0
 * @example // a fresh ring reports no history, so a display draws nothing yet
 * @example ringColumns(createColumnRing(8, 16))
 * []
 */
export function createColumnRing(bins, capacity) {
  if (!Number.isInteger(bins) || bins < 1) throw new Error(`createColumnRing: bins must be a positive integer, got ${bins}`);
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`createColumnRing: capacity must be a positive integer, got ${capacity}`);
  return { bins, capacity, head: 0, count: 0, data: new Float32Array(bins * capacity) };
}

/**
 * Command (mutates `ring`). Append one column of magnitudes, overwriting the
 * oldest when the ring is full.
 *
 * REFUSES A MISMATCHED LENGTH rather than padding or truncating: a column of the
 * wrong width means the analyser's bin count changed, and silently reshaping it
 * would draw a frequency axis that lies. The caller resets the ring instead (see
 * live_analysis_registry.pushAnalysisFrame), which is an honest restart of a
 * display whose meaning changed.
 *
 * @param {object} ring - a createColumnRing result
 * @param {ArrayLike<number>} values - `ring.bins` magnitudes in 0..1
 * @returns {object} the same ring
 *
 * @example // the newest column is last, and a partly-filled ring reports only what it has
 * @example const r = pushColumn(createColumnRing(2, 3), [0.5, 1]);
 * @example ringColumns(r).length
 * 1
 * @example [...ringColumns(r)[0]]
 * [ 0.5, 1 ]
 * @example // ...and the oldest falls off once capacity is reached, never the newest
 * @example const full = [[1, 1], [2, 2], [3, 3], [4, 4]].reduce(pushColumn, createColumnRing(2, 3));
 * @example ringColumns(full).map((c) => c[0])
 * [ 2, 3, 4 ]
 */
export function pushColumn(ring, values) {
  if (values.length !== ring.bins) {
    throw new Error(`pushColumn: expected ${ring.bins} values, got ${values.length} — the analyser's bin count changed; reset the ring instead`);
  }
  ring.data.set(values, ring.head * ring.bins);
  ring.head = (ring.head + 1) % ring.capacity;
  ring.count = Math.min(ring.count + 1, ring.capacity);
  return ring;
}

/**
 * Query. The ring's columns OLDEST FIRST, as views into its buffer (no copy).
 *
 * Views rather than copies because the consumer is a per-frame emit(): it reads
 * each column once and never retains it, exactly the contract the engine's own
 * reused FFT buffer asks for. `subarray` allocates a small view object per column
 * per frame and no bytes.
 *
 * @param {object} ring - a createColumnRing result
 * @returns {Float32Array[]} `ring.count` views, oldest to newest
 *
 * @example // three pushes into a capacity-4 ring: three columns, in push order
 * @example const r = [[1], [2], [3]].reduce(pushColumn, createColumnRing(1, 4));
 * @example ringColumns(r).map((c) => c[0])
 * [ 1, 2, 3 ]
 * @example // and it WRAPS: a fourth and fifth push keep the order right across the seam
 * @example const w = [[4], [5]].reduce(pushColumn, r);
 * @example ringColumns(w).map((c) => c[0])
 * [ 2, 3, 4, 5 ]
 */
export function ringColumns(ring) {
  const out = [];
  const first = (ring.head - ring.count + ring.capacity) % ring.capacity;
  for (let i = 0; i < ring.count; i++) {
    const slot = (first + i) % ring.capacity;
    out.push(ring.data.subarray(slot * ring.bins, (slot + 1) * ring.bins));
  }
  return out;
}

// ── THE PUSH SEAM'S UNIT CONVERSIONS ─────────────────────────────────────────

/** The byte range `AnalyserNode.getByteFrequencyData` fills. */
const FFT_BYTE_MAX = 255;

/**
 * Pure function. One spectrum column from the engine's FFT bytes: 0..255 → 0..1.
 *
 * @param {ArrayLike<number>} bins - `getByteFrequencyData` output (0..255)
 * @returns {Float32Array} the same length, in 0..1
 *
 * @example [...spectrumColumnValues([0, 255])]
 * [ 0, 1 ]
 * @example // a mid-scale bin lands mid-scale — no dB curve is applied here,
 * @example // because getByteFrequencyData is already logarithmic
 * @example Number([...spectrumColumnValues([51])][0].toFixed(1))
 * 0.2
 */
export function spectrumColumnValues(bins) {
  const out = new Float32Array(bins.length);
  for (let i = 0; i < bins.length; i++) out[i] = bins[i] / FFT_BYTE_MAX;
  return out;
}

/**
 * Pure function. One meter column from a dBFS level: `METER_FLOOR_DB`..0 → 0..1.
 *
 * dB, NOT LINEAR AMPLITUDE. A linear meter spends 90% of its travel in the top
 * 20 dB and shows nothing at all for quiet material, which is why every real meter
 * is logarithmic. A non-finite reading (silence gives -Infinity) reads as the
 * floor rather than propagating NaN into a rect's height.
 *
 * @param {number} db - the level in dBFS
 * @returns {Float32Array} one value in 0..1
 *
 * @example [...meterColumnValues(0)]
 * [ 1 ]
 * @example [...meterColumnValues(-60)]
 * [ 0 ]
 * @example // half the scale is -30 dBFS, and a level over 0 dBFS clamps rather than overflowing
 * @example [...meterColumnValues(-30)]
 * [ 0.5 ]
 * @example [...meterColumnValues(6)]
 * [ 1 ]
 * @example // digital silence reads -Infinity and must not become NaN
 * @example [...meterColumnValues(-Infinity)]
 * [ 0 ]
 */
export function meterColumnValues(db) {
  const level = Number.isFinite(db) ? db : METER_FLOOR_DB;
  const frac = (level - METER_FLOOR_DB) / -METER_FLOOR_DB;
  return Float32Array.of(Math.max(0, Math.min(1, frac)));
}

// ── COLOUR ───────────────────────────────────────────────────────────────────

/**
 * The spectrogram's colour ramp: near-black blue → teal → warm white.
 *
 * MONOTONIC IN LIGHTNESS as well as in hue, so it reads correctly in greyscale and
 * for a colour-blind viewer. A rainbow ramp — the default choice everywhere — is
 * neither, and its bright middle band invents a feature in the data that is not
 * there (the same reason a chart's sequential scale is perceptually uniform).
 *
 * A `stops` ARRAY, in core/ramps.js's canonical shape, rather than a hand-written
 * interpolation function. R7-19 asks for authored colour maps — *"we have a
 * gradient picker so why not go ham with the presets??"* — and a colour map IS a
 * ramp, so that item becomes a swap of this value for a paint's stops rather than
 * a rewrite of the drawing.
 */
export const SPECTRUM_RAMP_STOPS = Object.freeze([
  { offset: 0, color: "#12182a" },
  { offset: 0.5, color: "#3a7a8c" },
  { offset: 1, color: "#ffe6b0" },
]);

/**
 * How many discrete colours the spectrogram's ramp is quantized to.
 *
 * IT IS THE RUN-MERGE KEY, which is why it is not simply "as many as possible".
 * `runLengthCells` merges neighbouring cells that resolve to the SAME level, so
 * the level count directly sets how many rects a frame costs: with continuous
 * colour every cell is its own rect. 24 steps is finer than the eye resolves in a
 * 60-unit-tall waterfall and collapses the large flat regions (silence, noise
 * floor, a sustained tone) that dominate real spectra.
 */
export const SPECTRUM_RAMP_LEVELS = 24;

/**
 * The quantized ramp, baked once at module load: `SPECTRUM_RAMP_LEVELS` hex
 * colours, level `i` sampled at the middle of its band.
 *
 * Baked because `sampleRampHex` does an OKLab blend per call and the drawing asks
 * for one colour per cell, ~60 times a second, per node.
 */
const SPECTRUM_LEVEL_COLORS = Object.freeze(
  Array.from({ length: SPECTRUM_RAMP_LEVELS }, (_, i) => sampleRampHex(SPECTRUM_RAMP_STOPS, (i + 0.5) / SPECTRUM_RAMP_LEVELS, {})),
);

/**
 * Pure function. A magnitude's quantization level — the index the run-merge
 * compares and the colour table indexes.
 *
 * @param {number} v - a magnitude in 0..1
 * @returns {number} an integer in 0..SPECTRUM_RAMP_LEVELS-1
 *
 * @example spectrumLevel(0)
 * 0
 * @example spectrumLevel(1)
 * 23
 * @example // the top of the scale must not fall off the end of the table
 * @example spectrumLevel(1) < SPECTRUM_RAMP_LEVELS
 * true
 * @example spectrumLevel(0.5)
 * 12
 */
export function spectrumLevel(v) {
  const clamped = Math.max(0, Math.min(1, v));
  return Math.min(SPECTRUM_RAMP_LEVELS - 1, Math.floor(clamped * SPECTRUM_RAMP_LEVELS));
}

/**
 * Pure function. The meter bar's colour at a given level, with the thresholds
 * where a mixing engineer expects them rather than spread evenly — amber from
 * -12 dBFS, red from -3, because the top 3 dB is the part that actually clips.
 *
 * @param {number} frac - the meter's 0..1 fill (meterColumnValues output)
 * @returns {string} a hex colour
 *
 * @example // -60..-12 dBFS is the safe green band
 * @example meterColor(0.5)
 * '#6ac48a'
 * @example // -12 dBFS upward is amber
 * @example meterColor(0.9)
 * '#e0af68'
 * @example // and the last 3 dB, the part that clips, is red
 * @example meterColor(1)
 * '#e05a6a'
 */
export function meterColor(frac) {
  const db = METER_FLOOR_DB + frac * -METER_FLOOR_DB;
  if (db > METER_RED_DB) return "#e05a6a";
  if (db > METER_AMBER_DB) return "#e0af68";
  return "#6ac48a";
}

/** Where the meter turns amber and red, in dBFS. */
const METER_AMBER_DB = -12;
const METER_RED_DB = -3;

// ── GEOMETRY ─────────────────────────────────────────────────────────────────

/**
 * The shortest display band worth drawing, in world units. Below this the
 * waterfall is a smear and the bar is a line, so the node shows its static form
 * alone — the same "does it fit" judgment `readoutFits` already makes for the
 * readout, rather than painting something illegible over the card.
 */
const MIN_DISPLAY_BAND = 12;

/**
 * The band an analysis display occupies on top of a node's own default height.
 * `readoutNodeHeight` adds it for any spec declaring `overlay`, so a freshly
 * inserted meter or spectrum is born with room for its picture instead of
 * squeezing it into the gap under the port rows.
 */
export const ANALYSIS_DISPLAY_BAND_H = 56;

/**
 * Pure function. The LOCAL rect an analysis node's display occupies, or null when
 * the card is too short to show one.
 *
 * BELOW THE PORT ROWS, inset by the card's own padding — the band
 * `readoutBaseline` centres a readout in, which an analysis node leaves empty
 * because both analysis specs declare `readout: null`. The old DOM overlay used a
 * hardcoded `top = 32` and `pad = 10` (web/CanvasView.svelte:5345-5346), which are
 * `NODE_HEADER_H + NODE_BODY_GAP` and `NODE_PAD` written out as literals — two
 * numbers that could drift from the card they were measuring.
 *
 * @param {object} plugin - the node's own plugin (to know how many port rows precede)
 * @param {object} s - the folded item state
 * @returns {{x: number, y: number, w: number, h: number}|null}
 *
 * @example // a default-height spectrum node has a band under its one port row
 * @example const p = {ports: () => ({inputs: [{key: "in"}], outputs: [{key: "out"}]})};
 * @example analysisDisplayRect(p, {w: 200, h: 120}).x
 * 10
 * @example analysisDisplayRect(p, {w: 200, h: 120}).w
 * 180
 * @example // ...and a card squashed to nothing declines to draw rather than smearing
 * @example analysisDisplayRect(p, {w: 200, h: 40})
 * null
 */
export function analysisDisplayRect(plugin, s) {
  const { w, h } = nodeBox(s);
  const top = nodeBodyTop(plugin, s);
  const band = (h ?? 0) - top - NODE_PAD;
  const width = (w ?? 0) - NODE_PAD * 2;
  if (band < MIN_DISPLAY_BAND || width <= 0) return null;
  return { x: NODE_PAD, y: top, w: width, h: band };
}

// ── DRAWING ──────────────────────────────────────────────────────────────────

/**
 * How many frequency rows the waterfall resolves.
 *
 * A DISPLAY resolution, deliberately independent of the analyser's bin count: the
 * bins are remapped onto these rows logarithmically, so the picture's detail is a
 * property of the picture and a `bins` change (R7-19) alters what is measured, not
 * how tall the image is. 40 rows over a ~56-unit band is about one row per 1.4
 * world units, which is finer than a rect edge reads at ordinary zoom.
 */
export const SPECTRUM_DISPLAY_ROWS = 40;

/**
 * Pure function. The bin a display row samples, on a LOG frequency axis with row 0
 * at the TOP (high) and the last row at the bottom (low).
 *
 * A LINEAR axis puts everything musical in the bottom eighth of the picture and
 * spends the top half on inaudible air. Mapping geometrically makes an octave a
 * constant distance, which is what makes a harmonic series read as evenly spaced.
 *
 * THE AXIS IS PINNED AT BOTH ENDS: `t` divides by `rows - 1`, not by `rows`, so
 * the bottom row IS bin 0 and the top row IS the last bin. Dividing by `rows` (the
 * spelling the DOM overlay this replaces used) leaves the bottom row at t = 1/rows
 * — on a 40-row display that silently discards the lowest bins, which is the
 * musically interesting end. Caught by this function's own doctest.
 *
 * @param {number} row - the display row, 0 = top
 * @param {number} rows - how many rows the display has
 * @param {number} bins - the column's length
 * @returns {number} an index into the column
 *
 * @example // the bottom row is the lowest bin and the top row is the highest
 * @example logBinForRow(3, 4, 64)
 * 0
 * @example logBinForRow(0, 4, 64)
 * 63
 * @example // and an octave is a constant number of rows, which a linear axis cannot do:
 * @example // bin+1 goes 1, 4, 16, 64 — a constant ratio per row
 * @example logBinForRow(2, 4, 64)
 * 3
 * @example logBinForRow(1, 4, 64)
 * 15
 * @example // a one-row display is a degenerate case, not a division by zero
 * @example logBinForRow(0, 1, 64)
 * 63
 */
export function logBinForRow(row, rows, bins) {
  const t = rows > 1 ? (rows - 1 - row) / (rows - 1) : 1; // bottom = low
  return Math.max(0, Math.min(bins - 1, Math.round(Math.pow(bins, t)) - 1));
}

/**
 * Pure function. Merge a grid of quantization levels into the fewest axis-aligned
 * cells that draw it, merging along the COLUMN (time) axis.
 *
 * ── WHY TIME AND NOT FREQUENCY ──────────────────────────────────────────────
 * Both directions are one loop; the choice is which one real data is smooth
 * along. A spectrogram's time-adjacent columns are highly correlated — silence
 * stays silent, a sustained tone holds its bin — so horizontal runs are long,
 * while frequency-adjacent bins differ constantly (that is what a spectrum IS).
 * Merging along time turns a full-history frame of silence into ONE rect per row
 * instead of `columns` of them.
 *
 * This is what keeps the op count sane: `SPECTRUM_DISPLAY_ROWS × columns` cells
 * (40 × 128 = 5120) would be 5120 rects unmerged.
 *
 * @param {number[][]} levels - `rows` arrays of `cols` level indices
 * @returns {{row: number, col: number, span: number, level: number}[]} merged runs
 *
 * @example // one row, all the same level: one run spanning the whole row
 * @example runLengthCells([[3, 3, 3, 3]])
 * [ { row: 0, col: 0, span: 4, level: 3 } ]
 * @example // a change breaks the run, and the pieces keep their own spans
 * @example runLengthCells([[0, 0, 7, 7, 7]])
 * [ { row: 0, col: 0, span: 2, level: 0 }, { row: 0, col: 2, span: 3, level: 7 } ]
 * @example // rows never merge into each other, so two identical rows stay two runs
 * @example runLengthCells([[1, 1], [1, 1]]).length
 * 2
 */
export function runLengthCells(levels) {
  const out = [];
  for (let row = 0; row < levels.length; row++) {
    const line = levels[row];
    let start = 0;
    for (let col = 1; col <= line.length; col++) {
      if (col < line.length && line[col] === line[start]) continue;
      out.push({ row, col: start, span: col - start, level: line[start] });
      start = col;
    }
  }
  return out;
}

/**
 * Pure function. THE FLOWING SPECTROGRAM, as display-list ops in LOCAL coords.
 *
 * Time runs left to right (oldest column at the left edge), frequency bottom to
 * top on a log axis. A PARTLY FILLED ring draws only what it has, pinned to the
 * RIGHT edge, so a freshly created node fills in from the right rather than
 * stretching two columns across the whole card.
 *
 * @param {{x: number, y: number, w: number, h: number}} box - analysisDisplayRect output
 * @param {Float32Array[]} columns - ringColumns output, oldest first, values in 0..1
 * @returns {object[]} display-list commands
 *
 * @example // no history yet: nothing is drawn, and the node's static form stands
 * @example spectrogramOps({x: 0, y: 0, w: 100, h: 40}, [])
 * []
 * @example // one silent column is one flat colour per row, merged along time
 * @example spectrogramOps({x: 0, y: 0, w: 100, h: 40}, [new Float32Array(8)]).length
 * 40
 * @example spectrogramOps({x: 0, y: 0, w: 100, h: 40}, [new Float32Array(8)])[0].op
 * 'rect'
 */
export function spectrogramOps(box, columns) {
  if (columns.length === 0) return [];
  const rows = SPECTRUM_DISPLAY_ROWS;
  const bins = columns[0].length;
  const levels = [];
  for (let row = 0; row < rows; row++) {
    const bin = logBinForRow(row, rows, bins);
    const line = new Array(columns.length);
    for (let col = 0; col < columns.length; col++) line[col] = spectrumLevel(columns[col][bin]);
    levels.push(line);
  }
  // PINNED RIGHT: a full ring uses the whole band, a partial one keeps the same
  // column width and leaves the left empty, so history arrives at a constant speed
  // instead of the picture rescaling itself while it fills.
  const colW = box.w / ANALYSIS_HISTORY_COLUMNS.spectrum;
  const x0 = box.x + box.w - columns.length * colW;
  const rowH = box.h / rows;
  return runLengthCells(levels).map((c) => rect({
    x: x0 + c.col * colW,
    y: box.y + c.row * rowH,
    w: c.span * colW,
    h: rowH,
    fill: SPECTRUM_LEVEL_COLORS[c.level],
  }));
}

/** The meter well's colour — the unlit part of the bar's travel, so the scale is
 *  visible when the signal is quiet and the bar has somewhere to be. */
const METER_WELL = "#0e1220";

/**
 * Pure function. THE BOUNCING BAR, as display-list ops in LOCAL coords: the well,
 * then the lit part growing from the bottom.
 *
 * @param {{x: number, y: number, w: number, h: number}} box - analysisDisplayRect output
 * @param {Float32Array[]} columns - ringColumns output; only the NEWEST is drawn
 * @returns {object[]} display-list commands
 *
 * @example // no reading yet: the well alone, so the node still shows its scale
 * @example meterOps({x: 0, y: 0, w: 20, h: 40}, []).length
 * 1
 * @example // with a reading, the bar grows UP from the bottom of the well
 * @example meterOps({x: 0, y: 0, w: 20, h: 40}, [Float32Array.of(0.25)])[1].y
 * 30
 * @example meterOps({x: 0, y: 0, w: 20, h: 40}, [Float32Array.of(0.25)])[1].h
 * 10
 */
export function meterOps(box, columns) {
  const well = rect({ x: box.x, y: box.y, w: box.w, h: box.h, fill: METER_WELL });
  if (columns.length === 0) return [well];
  const frac = columns[columns.length - 1][0];
  const barH = box.h * frac;
  if (barH <= 0) return [well];
  return [well, rect({ x: box.x, y: box.y + box.h - barH, w: box.w, h: barH, fill: meterColor(frac) })];
}

/**
 * Pure function (throws on an unknown kind). An analysis node's LIVE picture as
 * display-list ops — the one entry point `core/audio_nodes.emit` calls.
 *
 * Pure in the sense the render-time display context requires: same descriptor,
 * same ops. The descriptor itself is live, which is why it arrives as an ARGUMENT
 * from a surface that opted in, and why every headless surface passes none. See
 * this file's header on why that is not recordable state.
 *
 * @param {{kind: string, columns: Float32Array[]}} descriptor - one node's live analysis
 * @param {object} plugin - the node's own plugin (for the port-row layout)
 * @param {object} s - the folded item state
 * @returns {object[]} display-list commands, LOCAL coords (empty when it does not fit)
 *
 * @example // a card too short for a display draws nothing rather than a smear
 * @example const p = {ports: () => ({inputs: [{key: "in"}], outputs: [{key: "out"}]})};
 * @example analysisDisplayOps({kind: "meter", columns: []}, p, {w: 120, h: 40})
 * []
 * @example // a meter with room draws its well
 * @example analysisDisplayOps({kind: "meter", columns: []}, p, {w: 120, h: 120}).length
 * 1
 */
export function analysisDisplayOps(descriptor, plugin, s) {
  const box = analysisDisplayRect(plugin, s);
  if (!box) return [];
  if (descriptor.kind === "meter") return meterOps(box, descriptor.columns);
  if (descriptor.kind === "spectrum") return spectrogramOps(box, descriptor.columns);
  throw new Error(
    `analysisDisplayOps: no drawing for overlay kind ${JSON.stringify(descriptor.kind)}` +
    ` — a spec declaring a new \`overlay\` must add one here (known: meter, spectrum)`,
  );
}
