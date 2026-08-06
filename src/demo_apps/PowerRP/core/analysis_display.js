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
 * ── UNITS: THE RING IS 0..1, AND FOR A SPECTRUM THAT 0..1 IS A dB SCALE ─────
 * Every value in a column is a magnitude in 0..1, so the buffer, the ring
 * arithmetic and the drawing all speak one scale. What that 0..1 MEANS differs
 * by kind and is stated at each push seam: a meter's is
 * `METER_FLOOR_DB`..0 dBFS (`meterColumnValues`), a spectrum's is
 * `SPECTRUM_PUSH_DB_FLOOR`..`SPECTRUM_PUSH_DB_CEIL` (synth/spectrum.js does the
 * conversion; `spectrumColumnValues` only copies out of the engine's reused
 * buffer).
 *
 * THE SPECTRUM'S PUSHED RANGE IS DELIBERATELY WIDER THAN WHAT IS DRAWN. The
 * author's floor and ceiling rows are a DISPLAY window onto it
 * (`spectrumDisplayFraction`), which is what lets them scrub live and tween
 * across slides instead of rebuilding the analyser — and which is why the push
 * must not clip at the ceiling the display happens to be showing.
 *
 * R7-19's `bins` row changes the column LENGTH and nothing else.
 */

import { rect } from "../render_gpu/ir.js";
import { rampFromState, sampleRampHex, sequentialRamp } from "./ramps.js";
import { bundle, bundleDefaults } from "./properties.js";
import { NODE_PAD, nodeBodyTop, nodeBox } from "./node_chrome.js";

/**
 * THE FLOOR of a level meter's scale, in dBFS. -60 is quiet-but-audible; going
 * lower would spend most of the bar on silence. Exported because the PUSH seam
 * (web/audioMirror.svelte.js) normalizes against it and the drawing reads it back
 * — one constant, not two spellings of the same number.
 */
export const METER_FLOOR_DB = -60;

/**
 * THE WATERFALL'S REFERENCE WIDTH: how many columns speed 1 spreads across the
 * band. 128 columns at the engine's ~60 Hz poll is a little over two seconds of
 * history — long enough to see a note's decay, short enough that the picture
 * still moves — and it is what the display drew before `speed` existed, which is
 * why the default speed is exactly 1 and the default picture is unchanged.
 */
export const SPECTRUM_BASE_COLUMNS = 128;

/**
 * THE SPEED ROW'S BOUNDS (R7-19's "movement speed").
 *
 * SPEED IS A DIVISOR OF THE COLUMN COUNT, and that is forced rather than chosen:
 * columns arrive at the poll's rate, so the only way a waterfall crosses its band
 * faster is for fewer of them to fit across it. Speed 4 draws 32 columns, each
 * four times as wide, and each leaves the band four times sooner.
 *
 * THE SLOW END IS WHAT COSTS MEMORY, which is why it has a floor: showing MORE
 * history means STORING more, so the ring's capacity is exactly
 * SPECTRUM_BASE_COLUMNS / SPECTRUM_MIN_SPEED. At 0.5 that is 256 columns, about
 * 4.3 seconds, and one megabyte per node at the default bin count. The fast end
 * costs nothing and is bounded only by legibility.
 */
export const SPECTRUM_MIN_SPEED = 0.5;
export const SPECTRUM_MAX_SPEED = 16;

/**
 * THE dB RANGE A PUSHED SPECTRUM COLUMN'S 0..1 SPANS — synth/spectrum.js's
 * SPECTRUM_DB_FLOOR / SPECTRUM_DB_CEIL, RESTATED.
 *
 * WHY RESTATED AND NOT IMPORTED: core/ may not import synth/** (core/audio_nodes
 * .js states the law — the engine constructs an AudioContext, which does not
 * exist in bare node, and every core suite and cli/render.js would break). This
 * is the same restatement every audio knob's min/max already is, and it is kept
 * honest the same way: tests/analysis_display_test.js imports BOTH and asserts
 * they agree, which is where a dependency on the engine belongs.
 *
 * WHY THE DEFAULT WINDOW IS -100..-30: it is exactly what
 * `AnalyserNode.getByteFrequencyData` mapped onto 0..255 before the FFT moved
 * into synth/spectrum.js, so the SHAPE of the mapping is the one that was tuned
 * against real material.
 *
 * IT IS NOT THE SAME BRIGHTNESS, and pretending otherwise would be the lie this
 * paragraph exists to avoid: the pushed values are now TRUE dBFS (a full-scale
 * sine reads 0), where the browser's node applied neither the one-sided x2 nor
 * any window-gain correction and read it at -13.56 under Blackman. So an
 * existing spectrogram is brighter by that measured amount. synth/spectrum.js
 * SPECTRUM_DEFAULT_WINDOW states why that is not compensated for here — the
 * offset differs per window, so compensating would make the window row a
 * brightness knob.
 */
export const SPECTRUM_PUSH_DB_FLOOR = -100;
export const SPECTRUM_PUSH_DB_CEIL = 0;
const SPECTRUM_DEFAULT_FLOOR_DB = -100;
const SPECTRUM_DEFAULT_CEIL_DB = -30;

/**
 * How many columns of history each display kind keeps.
 *
 * A SPECTROGRAM'S depth is its time axis, sized for the SLOWEST speed the row
 * offers (above) — a faster setting draws a suffix of the same ring, so changing
 * speed rescales the picture instead of restarting it, which is the same property
 * that made zoom safe. A METER has no time axis — it draws one bar from the newest
 * reading — so its ring is depth 1. Depth 1 is a legitimate instance of the ring
 * contract ("the last N frames"), not a hack to make one mechanism cover two
 * widgets.
 */
export const ANALYSIS_HISTORY_COLUMNS = Object.freeze({
  meter: 1,
  spectrum: SPECTRUM_BASE_COLUMNS / SPECTRUM_MIN_SPEED,
});

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
 * @example // the ring holds the SLOWEST speed's worth; speed 1 draws half of it
 * @example analysisHistoryColumns("spectrum")
 * 256
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

/**
 * Pure function. One spectrum column from the engine's magnitudes — A COPY, and
 * that is the whole job.
 *
 * ── WHY IT IS ONLY A COPY NOW, AND WAS ARITHMETIC BEFORE ────────────────────
 * It used to divide `getByteFrequencyData`'s 0..255 bytes by 255. R7-19's
 * `window` row made that method unusable (it hard-wires a Blackman window that
 * the Web Audio spec gives no parameter for), so synth/spectrum.js runs the
 * transform and hands over values that are ALREADY the ring's unit — a dBFS
 * reading normalised over SPECTRUM_DB_FLOOR..SPECTRUM_DB_CEIL. The unit
 * CONVERSION moved to where the units are made; what stays here is the unit
 * SEAM, which still has to exist for the one reason it always did:
 *
 * THE ENGINE'S BUFFER IS REUSED. synth/engine.js's poll writes the same
 * Float32Array every frame, deliberately, so the analysis loop never triggers a
 * GC that could stall the audio thread. The ring must therefore hold a copy;
 * storing the buffer itself would make every column of history change together
 * on the next poll. Deleting this function and pushing the buffer straight in
 * would look like a simplification and would silently flatten the waterfall.
 *
 * @param {ArrayLike<number>} bins - the engine's normalised magnitudes, 0..1
 * @returns {Float32Array} the same values, in memory the ring may keep
 *
 * @example [...spectrumColumnValues([0, 1])]
 * [ 0, 1 ]
 * @example [...spectrumColumnValues(Float32Array.of(0.25, 0.5))]
 * [ 0.25, 0.5 ]
 * @example // THE COPY IS THE POINT: the engine overwrites its buffer next frame
 * @example // and the column the ring kept must not change with it.
 * @example const shared = Float32Array.of(0.5);
 * @example const kept = spectrumColumnValues(shared);
 * @example shared[0] = 1;
 * @example kept[0]
 * 0.5
 */
export function spectrumColumnValues(bins) {
  const out = new Float32Array(bins.length);
  out.set(bins);
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
 * THE SPECTROGRAM'S DEFAULT COLOUR MAP, and it is a NAMED, PUBLISHED one rather
 * than a hand-mixed ramp.
 *
 * magma is monotone in lightness by construction, which is the property that
 * matters: a map with a bright band in the middle draws a ridge into the data
 * that is not there, and on a spectrogram an invented ridge reads as an invented
 * partial. It was chosen over its four uniform siblings because it STARTS AT
 * NEAR-BLACK (#000004) — silence must disappear into a dark node card rather
 * than glow — which viridis (#440154) and cividis (#00224e) do not.
 *
 * The ramp is ordinary AUTHORED STATE from here on (`rampStops` and the three
 * aspects, the same bundle a Mandelbrot palette uses); this is only what a
 * freshly inserted node is born with. core/ramps.js SEQUENTIAL_RAMPS states how
 * the stops were measured and why the map declares OKLab.
 */
export const SPECTRUM_DEFAULT_RAMP_ID = "magma";

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

/** How many distinct ramps' baked level tables are kept. A document animating a
 *  ramp visits a new one every frame, so the cache must EVICT rather than grow;
 *  16 is the plugins/demo/mandelbrot.js PALETTE_CACHE_LIMIT, for the same reason
 *  and at the same negligible size (24 short strings per entry). */
const LEVEL_COLORS_CACHE_LIMIT = 16;
const _levelColorsCache = new Map();

/**
 * Query (memoized; near-pure — same ramp, same table, and the table is never
 * mutated). A ramp quantized to `SPECTRUM_RAMP_LEVELS` hex colours, level `i`
 * sampled at the middle of its band.
 *
 * MEMOIZED because `sampleRampHex` does a per-call blend — in OKLab for every map
 * that matters — and the drawing asks for one colour per cell, ~60 times a second,
 * per node. Baking at module load is what this replaces, and it stopped being
 * possible the moment the ramp became authored state.
 *
 * @param {{stops: object[], loop: boolean, space: string, phase: number}} ramp
 * @returns {string[]} SPECTRUM_RAMP_LEVELS hex colours, dark end first
 *
 * @example spectrumLevelColors({stops: [{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], loop: false, space: "srgb", phase: 0}).length
 * 24
 * @example // level 0 is the middle of the FIRST band, not the ramp's very start
 * @example spectrumLevelColors({stops: [{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], loop: false, space: "srgb", phase: 0})[0]
 * '#050505'
 * @example spectrumLevelColors({stops: [{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], loop: false, space: "srgb", phase: 0})[23]
 * '#fafafa'
 * @example // the SAME ramp asked twice is the same table, not a second bake
 * @example const r = {stops: [{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], loop: false, space: "srgb", phase: 0};
 * @example spectrumLevelColors(r) === spectrumLevelColors(r)
 * true
 */
export function spectrumLevelColors(ramp) {
  const key = `${ramp.loop}|${ramp.space}|${ramp.phase}|${JSON.stringify(ramp.stops)}`;
  const hit = _levelColorsCache.get(key);
  if (hit) return hit;
  const built = Array.from(
    { length: SPECTRUM_RAMP_LEVELS },
    (_, i) => sampleRampHex(ramp.stops, (i + 0.5) / SPECTRUM_RAMP_LEVELS, ramp),
  );
  if (_levelColorsCache.size >= LEVEL_COLORS_CACHE_LIMIT) _levelColorsCache.delete(_levelColorsCache.keys().next().value);
  _levelColorsCache.set(key, built);
  return built;
}

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

// ── THE AUTHORED DISPLAY PROPERTIES (R7-19) ──────────────────────────────────
//
// USER, verbatim: *"the spectrogram should have some more options and presets
// btw - like, what about linear and haming window options and num freqs and
// movement speed and color theme (i.e. the gradient! we have a gradient picker so
// why not go ham with the presets??)"*
//
// ── THE LINE THIS DRAWS, AND WHY IT IS NOT BOOKKEEPING ──────────────────────
// Two of those four are DSP and two are DISPLAY, and they live in different
// files because they behave differently:
//
//   `window` and `bins` change WHAT IS MEASURED. They are engine params, so they
//     are construct-time KNOBS in core/audio_specs.js SPECTRUM_SPEC and a change
//     rebuilds the analyser (the `construct: true` contract).
//   `speed` and the colour map change HOW THE MEASUREMENT IS DRAWN. They never
//     reach the engine, so declaring them as knobs would fail the spec/engine
//     cross-check in tests/audio_nodes_test.js — correctly, because a knob that
//     is not a param is the phantom-leaf defect. They belong HERE, beside the
//     drawing they modify.
//
// ── AND THE COLOUR MAP IS THE SHARED `ramp` BUNDLE, NOT A COLORMAP TYPE ─────
// USER, on the difference: *"gradient property vs spatial gradient property are
// different since this spectrogram does not need angles"* — and then, on what to
// do about it: *"dont duplicate gradient make one use the other for max reuse
// and DRY gradient propertiss"*. core/ramps.js already factors it exactly that
// way, and this is the second consumer of the geometry-free half:
//
//     ramp   = stops + how they are read (loop, space, phase)    ← this
//     paint  = ramp + geometry (angle, wavelength | centre, radius)
//
// So `colors` is `bundle("ramp")` — the SAME four property keys a Mandelbrot
// palette uses, the same stop editor, the same preset library. A spectrogram
// gets viridis because a fill can have viridis, and a ramp an author builds for
// a fill is available here, with nothing written twice to make that true.

/**
 * Every AUTHORED display property, per `overlay` kind: whether the kind's picture
 * is coloured by a ramp (and which ramp it is born with), plus its own scalar
 * rows.
 *
 * ONE DECLARATION, TWO READERS — `analysisDisplayRows` builds the Inspector rows
 * from it and `analysisDisplayDefaults` the defaults fragment, so a row and its
 * default cannot disagree and neither can be added without the other.
 *
 * LOUD ON AN UNKNOWN KIND, like its sibling `analysisHistoryColumns`: a third
 * analysis widget states its display properties (`{ramp: null, rows: []}` is a
 * perfectly good statement) or fails where the message says what to do.
 *
 * @example ANALYSIS_DISPLAY_PROPERTIES.meter.rows // []
 * @example ANALYSIS_DISPLAY_PROPERTIES.meter.ramp // null
 * @example ANALYSIS_DISPLAY_PROPERTIES.spectrum.rows.map((r) => r.key) // ["spectrumSpeed", "spectrumLogAxis", "spectrumFloorDb", "spectrumCeilDb"]
 */
export const ANALYSIS_DISPLAY_PROPERTIES = {
  // A METER HAS NEITHER, and that is a statement rather than an omission: its bar
  // is one reading with no time axis to scroll and its colour is a dBFS SCALE
  // (green / amber from -12 / red from -3, `meterColor`), not a palette. An
  // author-chosen ramp there would let a meter show green at 0 dBFS, which is a
  // meter that lies about the one thing it is for.
  meter: { ramp: null, rows: [] },
  spectrum: {
    ramp: SPECTRUM_DEFAULT_RAMP_ID,
    rows: [
      {
        key: "spectrumSpeed", label: "Speed (×)", kind: "number",
        default: 1, min: SPECTRUM_MIN_SPEED, max: SPECTRUM_MAX_SPEED, step: 0.25,
        help: "How fast the waterfall crosses the card. 1 shows about two seconds of history; 4 shows half a second, moving four times as quickly. Slower than 1 shows more history — down to the ring's own depth, which is why 0.5 is the floor rather than an arbitrary one.",
      },
      {
        key: "spectrumLogAxis", label: "Log frequency", kind: "boolean",
        default: true,
        help: "Spaces the frequency axis geometrically, so an octave is a constant distance and a harmonic series reads as evenly spaced. Turn it off for a LINEAR axis, which is what a plain FFT plot shows — the harmonics bunch at the bottom, but the bin spacing is honest.",
      },
      {
        key: "spectrumFloorDb", label: "Floor (dB)", kind: "number",
        default: SPECTRUM_DEFAULT_FLOOR_DB, min: SPECTRUM_PUSH_DB_FLOOR, max: SPECTRUM_PUSH_DB_CEIL, step: 1,
        help: "The level the DARK end of the colour map means. Raise it to push the noise floor into the background; lower it to see what is happening in near-silence. This is a window onto the measurement, not a change to it, so it scrubs live and tweens between slides.",
      },
      {
        key: "spectrumCeilDb", label: "Ceiling (dB)", kind: "number",
        default: SPECTRUM_DEFAULT_CEIL_DB, min: SPECTRUM_PUSH_DB_FLOOR, max: SPECTRUM_PUSH_DB_CEIL, step: 1,
        help: "The level the BRIGHT end of the colour map means. 0 dB is digital full scale; the -30 default is what the browser's own analyser used, so quiet material still reaches the top of the ramp. Set it to or below the floor and the map collapses to a hard threshold at that level, which is the limit of the window closing rather than an error.",
      },
    ],
  },
};

/**
 * Query (throws on an unknown kind). One kind's display declaration.
 *
 * @param {string} kind - an `overlay` value from an audio spec
 * @returns {{ramp: string|null, rows: object[]}}
 *
 * @example analysisDisplayProperties("spectrum").ramp // "magma"
 * @example analysisDisplayProperties("meter").rows.length // 0
 */
export function analysisDisplayProperties(kind) {
  const decl = ANALYSIS_DISPLAY_PROPERTIES[kind];
  if (!decl) {
    throw new Error(
      `analysisDisplayProperties: no display properties declared for overlay kind ${JSON.stringify(kind)}` +
      ` — add them to ANALYSIS_DISPLAY_PROPERTIES in core/analysis_display.js (known: ${Object.keys(ANALYSIS_DISPLAY_PROPERTIES).join(", ")})`,
    );
  }
  return decl;
}

/**
 * Pure function. THE INSPECTOR ROWS an analysis node's display contributes — the
 * shared ramp bundle when the kind is ramp-coloured, then the kind's own scalars,
 * all in one category so a node's picture controls are one group.
 *
 * THE CATEGORY IS AN ARGUMENT, not a constant here: it belongs to the AUDIO NODE
 * these rows are mounted on (core/audio_nodes.js AUDIO_CAT), and importing it
 * would close a cycle — that module imports this one.
 *
 * @param {string} kind - an `overlay` value from an audio spec
 * @param {string} category - the Inspector category to file every row under
 * @returns {object[]} Inspector row descriptors
 *
 * @example analysisDisplayRows("meter", "audio") // []
 * @example analysisDisplayRows("spectrum", "audio").map((r) => r.key)
 * [
 *   'rampStops',       'rampLoop',
 *   'rampSpace',       'rampPhase',
 *   'spectrumSpeed',   'spectrumLogAxis',
 *   'spectrumFloorDb', 'spectrumCeilDb'
 * ]
 * @example // every row lands in the category it was asked for, bundle rows included
 * @example new Set(analysisDisplayRows("spectrum", "audio").map((r) => r.category))
 * Set(1) { 'audio' }
 */
export function analysisDisplayRows(kind, category) {
  const decl = analysisDisplayProperties(kind);
  // `default` is stripped from the scalar rows for the same reason
  // core/properties.js row() strips it: a default belongs to defaults(), and a
  // row carrying one would be the second place it is written down.
  return [
    ...(decl.ramp ? bundle("ramp") : []),
    ...decl.rows.map(({ default: _default, ...row }) => row),
  ].map((row) => ({ ...row, category }));
}

/**
 * Pure function. An analysis node's display DEFAULTS fragment: the ramp it is
 * born with (a FRESH copy — a document must never alias author-time data) plus
 * every scalar row's declared default.
 *
 * @param {string} kind - an `overlay` value from an audio spec
 * @returns {object} a fragment to spread into a plugin's `defaults`
 *
 * @example analysisDisplayDefaults("meter") // {}
 * @example analysisDisplayDefaults("spectrum").rampSpace // "oklab"
 * @example analysisDisplayDefaults("spectrum").rampLoop // false
 * @example analysisDisplayDefaults("spectrum").rampStops.length // 13
 * @example analysisDisplayDefaults("spectrum").spectrumSpeed // 1
 * @example analysisDisplayDefaults("spectrum").spectrumLogAxis // true
 */
export function analysisDisplayDefaults(kind) {
  const decl = analysisDisplayProperties(kind);
  const ramp = decl.ramp ? sequentialRamp(decl.ramp) : null;
  return {
    ...(ramp ? { rampStops: ramp.stops, rampLoop: ramp.loop, rampSpace: ramp.space, rampPhase: bundleDefaults("ramp").rampPhase } : {}),
    ...Object.fromEntries(decl.rows.map((r) => [r.key, r.default])),
  };
}

/**
 * Pure function. The resolved DRAWING PARAMETERS for a spectrum display: the ramp
 * and the two scalars, each falling back to this widget's own declared default.
 *
 * The FALLBACKS matter for the same reason a Mandelbrot palette's do: a partial
 * delta that lost `rampSpace` must still read the map in the space it was
 * published in, or it is a different map. `spectrogramOps` takes this rather than
 * raw state so it stays a pure function of explicit parameters.
 *
 * @param {object} s - the folded item state
 * @returns {{ramp: object, speed: number, logAxis: boolean}}
 *
 * @example spectrumStyle({}).speed // 1
 * @example spectrumStyle({}).logAxis // true
 * @example spectrumStyle({}).ramp.space // "oklab"
 * @example spectrumStyle({}).floorDb // -100
 * @example spectrumStyle({}).ceilDb // -30
 * @example spectrumStyle({spectrumSpeed: 4, spectrumLogAxis: false}).speed // 4
 * @example spectrumStyle({spectrumSpeed: 4, spectrumLogAxis: false}).logAxis // false
 * @example // a broken equation leaves a STRING in the slot; the default is used
 * @example // rather than a NaN column width
 * @example spectrumStyle({spectrumSpeed: "= nope"}).speed // 1
 * @example spectrumStyle({spectrumCeilDb: "= nope"}).ceilDb // -30
 */
export function spectrumStyle(s) {
  const fallback = analysisDisplayDefaults("spectrum");
  const speed = Number(s.spectrumSpeed);
  const number = (raw, fromDefault) => (Number.isFinite(Number(raw)) ? Number(raw) : fromDefault);
  return {
    ramp: rampFromState({ ...s, rampStops: s.rampStops ?? fallback.rampStops }, fallback),
    speed: Number.isFinite(speed) && speed > 0 ? speed : fallback.spectrumSpeed,
    logAxis: typeof s.spectrumLogAxis === "boolean" ? s.spectrumLogAxis : fallback.spectrumLogAxis,
    floorDb: number(s.spectrumFloorDb, fallback.spectrumFloorDb),
    ceilDb: number(s.spectrumCeilDb, fallback.spectrumCeilDb),
  };
}

/**
 * Pure function. Where a pushed column value sits inside the AUTHORED dB window
 * — the display's re-mapping of the engine's fixed
 * SPECTRUM_PUSH_DB_FLOOR..SPECTRUM_PUSH_DB_CEIL range.
 *
 * A COLLAPSED WINDOW IS A THRESHOLD, NOT AN ERROR. When the ceiling is at or
 * below the floor there is no span to divide by, and the honest answer is the
 * LIMIT of the window closing: everything at or above that level is the bright
 * end, everything below it the dark end. That is the same reading the gradient
 * `wavelength` row already takes of 0 (CLAUDE.md: "0 is not an error: it is the
 * LIMIT of infinitely fine tiling"), rather than a NaN in a rect's fill.
 *
 * @param {number} v - a pushed column value, 0..1 over the engine's dB range
 * @param {number} floorDb - the level the dark end means
 * @param {number} ceilDb - the level the bright end means
 * @returns {number} 0..1 within the authored window
 *
 * @example // the engine's own range, passed through unchanged
 * @example spectrumDisplayFraction(0.5, -100, 0)
 * 0.5
 * @example // the DEFAULT window is -100..-30, so the engine's 0.7 (i.e. -30 dBFS)
 * @example // is the top of the ramp — which is what the browser analyser showed
 * @example spectrumDisplayFraction(0.7, -100, -30)
 * 1
 * @example spectrumDisplayFraction(0.35, -100, -30)
 * 0.5
 * @example // ...and anything below the floor clamps to the dark end
 * @example spectrumDisplayFraction(0.1, -50, -30)
 * 0
 * @example // a collapsed window is a hard threshold at that level
 * @example spectrumDisplayFraction(0.6, -40, -40)
 * 1
 * @example spectrumDisplayFraction(0.5, -40, -40)
 * 0
 */
export function spectrumDisplayFraction(v, floorDb, ceilDb) {
  const db = SPECTRUM_PUSH_DB_FLOOR + v * (SPECTRUM_PUSH_DB_CEIL - SPECTRUM_PUSH_DB_FLOOR);
  const span = ceilDb - floorDb;
  if (span <= 0) return db >= floorDb ? 1 : 0;
  return Math.max(0, Math.min(1, (db - floorDb) / span));
}

/**
 * Pure function. How many of the ring's newest columns a given speed draws across
 * the band — the ONE place speed becomes a number of columns.
 *
 * @param {number} speed - the `spectrumSpeed` value
 * @returns {number} a column count in 1..ANALYSIS_HISTORY_COLUMNS.spectrum
 *
 * @example // speed 1 is the reference: the picture the display has always drawn
 * @example spectrumDrawnColumns(1)
 * 128
 * @example // four times as fast is a quarter of the columns, four times as wide
 * @example spectrumDrawnColumns(4)
 * 32
 * @example // the slowest speed uses the whole ring, and nothing may ask for more
 * @example spectrumDrawnColumns(0.5)
 * 256
 * @example spectrumDrawnColumns(0.01)
 * 256
 * @example // ...nor for less than one column, which would be a zero-width divide
 * @example spectrumDrawnColumns(1000)
 * 1
 */
export function spectrumDrawnColumns(speed) {
  const wanted = Math.round(SPECTRUM_BASE_COLUMNS / speed);
  return Math.max(1, Math.min(ANALYSIS_HISTORY_COLUMNS.spectrum, wanted));
}

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
 * bins are remapped onto these rows, so the picture's detail is a property of the
 * picture and a `bins` change (R7-19) alters what is measured, not how tall the
 * image is. 40 rows over a ~56-unit band is about one row per 1.4 world units,
 * which is finer than a rect edge reads at ordinary zoom.
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
 * Pure function. The bin a display row samples on a LINEAR frequency axis, row 0
 * at the TOP (high) and the last row at the bottom (low) — the other half of the
 * `spectrumLogAxis` row.
 *
 * WHY OFFER IT AT ALL, given the log axis is the musically useful one: a linear
 * axis is what a plain FFT plot shows, and it is the honest picture when the
 * question is about BINS rather than about notes — inspecting aliasing, a
 * bitcrusher's fold-down, or the even spacing of a harmonic series' actual
 * frequencies. The log axis compresses the top half of the spectrum into a
 * quarter of the card, which hides exactly that.
 *
 * PINNED AT BOTH ENDS, like its logarithmic sibling and for the same reason.
 *
 * @param {number} row - the display row, 0 = top
 * @param {number} rows - how many rows the display has
 * @param {number} bins - the column's length
 * @returns {number} an index into the column
 *
 * @example // the bottom row is bin 0 and the top row is the last bin
 * @example linearBinForRow(3, 4, 64)
 * 0
 * @example linearBinForRow(0, 4, 64)
 * 63
 * @example // ...and the steps between them are EQUAL, which is what "linear" means:
 * @example // 0, 21, 42, 63 — the log axis gives 0, 3, 15, 63 over the same rows
 * @example linearBinForRow(2, 4, 64)
 * 21
 * @example linearBinForRow(1, 4, 64)
 * 42
 * @example // a one-row display is a degenerate case, not a division by zero
 * @example linearBinForRow(0, 1, 64)
 * 63
 */
export function linearBinForRow(row, rows, bins) {
  const t = rows > 1 ? (rows - 1 - row) / (rows - 1) : 1; // bottom = low
  return Math.max(0, Math.min(bins - 1, Math.round(t * (bins - 1))));
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
 * top. A PARTLY FILLED ring draws only what it has, pinned to the RIGHT edge, so
 * a freshly created node fills in from the right rather than stretching two
 * columns across the whole card.
 *
 * SPEED IS A SUFFIX, NOT A RESAMPLE: a faster style takes the newest
 * `spectrumDrawnColumns(speed)` columns and gives each a proportionally wider
 * slice. The ring is untouched, so speeding up and slowing down again shows the
 * history that was there all along — the same property that makes a zoom safe
 * (this file's header), applied to the other axis.
 *
 * @param {{x: number, y: number, w: number, h: number}} box - analysisDisplayRect output
 * @param {Float32Array[]} columns - ringColumns output, oldest first, values in 0..1
 * @param {{ramp: object, speed: number, logAxis: boolean}} style - spectrumStyle output
 * @returns {object[]} display-list commands
 *
 * @example const STYLE = spectrumStyle({});
 * @example // no history yet: nothing is drawn, and the node's static form stands
 * @example spectrogramOps({x: 0, y: 0, w: 100, h: 40}, [], STYLE)
 * []
 * @example // one silent column is one flat colour per row, merged along time
 * @example spectrogramOps({x: 0, y: 0, w: 100, h: 40}, [new Float32Array(8)], STYLE).length
 * 40
 * @example spectrogramOps({x: 0, y: 0, w: 100, h: 40}, [new Float32Array(8)], STYLE)[0].op
 * 'rect'
 * @example // SPEED IS VISIBLE IN THE GEOMETRY: at speed 1 one column of 128 is
 * @example // 100/128 wide; at speed 4 it is one of 32, so four times as wide
 * @example spectrogramOps({x: 0, y: 0, w: 128, h: 40}, [new Float32Array(8)], STYLE)[0].w
 * 1
 * @example spectrogramOps({x: 0, y: 0, w: 128, h: 40}, [new Float32Array(8)], spectrumStyle({spectrumSpeed: 4}))[0].w
 * 4
 * @example // THE RAMP IS THE COLOUR: the same silent column under two maps.
 * @example // (`rect` parses a stored hex into rgba floats, so that is what a fill is.)
 * @example spectrogramOps({x: 0, y: 0, w: 100, h: 40}, [new Float32Array(8)], STYLE)[0].fill.map((v) => +v.toFixed(4))
 * [ 0.0039, 0.0039, 0.0471, 1 ]
 * @example spectrogramOps({x: 0, y: 0, w: 100, h: 40}, [new Float32Array(8)], spectrumStyle({rampStops: [{offset: 0, color: "#000000"}, {offset: 1, color: "#ffffff"}], rampSpace: "srgb"}))[0].fill.map((v) => +v.toFixed(4))
 * [ 0.0196, 0.0196, 0.0196, 1 ]
 */
export function spectrogramOps(box, columns, style) {
  if (columns.length === 0) return [];
  const rows = SPECTRUM_DISPLAY_ROWS;
  const bins = columns[0].length;
  const drawn = Math.min(columns.length, spectrumDrawnColumns(style.speed));
  const shown = columns.slice(columns.length - drawn);
  const binForRow = style.logAxis ? logBinForRow : linearBinForRow;
  const levels = [];
  for (let row = 0; row < rows; row++) {
    const bin = binForRow(row, rows, bins);
    const line = new Array(shown.length);
    for (let col = 0; col < shown.length; col++) {
      line[col] = spectrumLevel(spectrumDisplayFraction(shown[col][bin], style.floorDb, style.ceilDb));
    }
    levels.push(line);
  }
  // PINNED RIGHT: a full band uses the whole width, a partial one keeps the same
  // column width and leaves the left empty, so history arrives at a constant speed
  // instead of the picture rescaling itself while it fills.
  const colW = box.w / spectrumDrawnColumns(style.speed);
  const x0 = box.x + box.w - shown.length * colW;
  const rowH = box.h / rows;
  const levelColors = spectrumLevelColors(style.ramp);
  return runLengthCells(levels).map((c) => rect({
    x: x0 + c.col * colW,
    y: box.y + c.row * rowH,
    w: c.span * colW,
    h: rowH,
    fill: levelColors[c.level],
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
  if (descriptor.kind === "spectrum") return spectrogramOps(box, descriptor.columns, spectrumStyle(s));
  throw new Error(
    `analysisDisplayOps: no drawing for overlay kind ${JSON.stringify(descriptor.kind)}` +
    ` — a spec declaring a new \`overlay\` must add one here (known: meter, spectrum)`,
  );
}
