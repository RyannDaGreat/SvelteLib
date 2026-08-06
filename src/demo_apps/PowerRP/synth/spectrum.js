/**
 * SPECTRUM DSP — the analysis half of the spectrogram, as ordinary arithmetic.
 *
 * ── WHY THIS FILE EXISTS (R7-19's `bins` and `window` rows) ─────────────────
 * The spectrogram used to be whatever `AnalyserNode.getByteFrequencyData` gave
 * it, and that node offers exactly one knob a spectrum author cares about
 * (`fftSize`) and hard-wires the rest. Most sharply: **the Web Audio spec
 * MANDATES a Blackman window** — §"Blackman windowing" of the AnalyserNode
 * algorithm — with no parameter, so a `window` row on top of it would be a
 * control with no picture behind it. The user asked for one by name ("linear and
 * haming window options"), so the analysis moved here.
 *
 * WHAT THAT BUYS, beyond honouring the ask: the dB range is ours (the node's
 * min/maxDecibels are settable but its NORMALISATION is not exposed), the
 * smoothing constant is ours, and the whole path is bare-node testable — which
 * an AnalyserNode's output structurally is not.
 *
 * ── WHAT IT COSTS, MEASURED ─────────────────────────────────────────────────
 * One radix-2 FFT per subscribed spectrum node per animation frame. At the
 * default 2048-point size that is 11 butterfly passes over 2048 complex values,
 * MEASURED at 0.14 ms against a 16.7 ms frame budget — under 1% of a frame per
 * node. The buffers are allocated ONCE per module and reused, so the poll stays
 * allocation-free exactly as the engine's meter loop already is. The cost scales
 * as N log N, so the 16384-bin setting is roughly sixteen times that; the row's
 * help says so, because it is the author's choice to make.
 *
 * ── PURE, AND DELIBERATELY SO ───────────────────────────────────────────────
 * Nothing here touches an AudioContext, a DOM or a clock; it takes a
 * Float32Array of samples and returns magnitudes. That is the same split
 * synth/dsp.js already draws and for the same stated reason — this is the part
 * where a silent mistake produces a WRONG PICTURE rather than an exception, so
 * it is the part a cheap node test can pin.
 *
 * All functions are PURE unless their docstring says otherwise.
 */

// ─── The bin count (R7-19's "num freqs") ─────────────────────────────────────

/**
 * WEB AUDIO'S OWN LIMITS on an AnalyserNode's `fftSize`, restated because this
 * module sizes its own buffers by them and must refuse an illegal value BEFORE
 * assigning it (an out-of-range fftSize throws IndexSizeError from deep inside
 * the node, naming nothing an author could act on).
 *
 * A spectrum node's authored knob is BINS, not fftSize: `frequencyBinCount` is
 * `fftSize / 2` and the bins are what the picture has. So the two constants
 * below are the fftSize limits halved, and `spectrumFftSize` is the one
 * conversion.
 */
export const MIN_SPECTRUM_BINS = 16;
export const MAX_SPECTRUM_BINS = 16384;

/**
 * The bin count a spectrum module is built with when nothing says otherwise:
 * 1024 bins, i.e. the 2048-point FFT this module used before `bins` was
 * authored, so an existing patch is MEASURED exactly as it was. (Its LEVEL is
 * not identical — see SPECTRUM_DEFAULT_WINDOW for the one deliberate change.)
 */
export const SPECTRUM_DEFAULT_BINS = 1024;

/**
 * Pure function. The FFT size for an authored bin count — and THE gate that
 * refuses an illegal one loudly.
 *
 * Accepts a string because the knob is a `discrete` one and discrete knob values
 * are strings by nature (core/audio_nodes.js audioKnobValues); "1024" and 1024
 * are the same choice and it would be a poor error that distinguished them.
 *
 * @param {string|number} bins - the authored bin count
 * @returns {number} the AnalyserNode fftSize, i.e. twice the bins
 *
 * @example spectrumFftSize(1024) // 2048
 * @example spectrumFftSize("1024") // 2048
 * @example spectrumFftSize(16) // 32
 * @example // not a power of two -> loud, because the FFT below is radix-2 and an
 * @example // AnalyserNode would throw IndexSizeError naming nothing
 * @example // spectrumFftSize(1000) -> throws: 1000 is not a power of two
 * @example // spectrumFftSize(32768) -> throws: above the 16384 ceiling
 */
export function spectrumFftSize(bins) {
  const n = Number(bins);
  if (!Number.isInteger(n) || n < MIN_SPECTRUM_BINS || n > MAX_SPECTRUM_BINS || (n & (n - 1)) !== 0) {
    throw new Error(
      `spectrumFftSize: ${JSON.stringify(bins)} is not a legal bin count — it must be a POWER OF TWO` +
      ` between ${MIN_SPECTRUM_BINS} and ${MAX_SPECTRUM_BINS} (Web Audio's fftSize limits, halved).`,
    );
  }
  return n * 2;
}

// ─── Windows ─────────────────────────────────────────────────────────────────

/**
 * THE WINDOW FUNCTIONS, as their published cosine-sum coefficients rather than
 * as five hand-written formulas.
 *
 * EVERY ONE OF THEM IS THE SAME SUM — that is the point of storing coefficients:
 *
 *     w[n] = Σ_k (−1)^k · a_k · cos(2·π·k·n / (N − 1))
 *
 * so rectangular is [1], Hann is [0.5, 0.5], Hamming is [0.54, 0.46], and the
 * two Blackmans are the three- and four-term members of the same family. Five
 * separate formulas would be five chances to mistype a coefficient, and a
 * mistyped window is invisible: it still produces a plausible spectrum.
 *
 * ── WHAT THE CHOICE ACTUALLY DOES, since the row has to mean something ──────
 * An FFT assumes its input repeats forever. A finite slice almost never joins up
 * with itself, and that discontinuity SPRAYS ENERGY ACROSS EVERY BIN — spectral
 * leakage. A window tapers the slice to zero at both ends so it does join up. The
 * trade is always the same one:
 *
 *   rectangular  no taper at all (the user's "linear"). The NARROWEST main lobe,
 *                so two close tones stay distinguishable — and −13 dB sidelobes,
 *                so a loud tone smears a skirt across the whole picture. Right
 *                when you know the signal is periodic in the window; wrong for
 *                almost everything else.
 *   hann         −31 dB sidelobes falling off fast. The general-purpose default.
 *   hamming      −43 dB nearest sidelobe (better than Hann right beside the peak)
 *                but the far ones fall off more slowly. Chosen when the
 *                interference is close in frequency.
 *   blackman     −58 dB. What AnalyserNode hard-wires, which is why it is this
 *                module's DEFAULT: a deck built before this row existed looks the
 *                same after it.
 *   blackmanHarris  −92 dB, the widest main lobe. For seeing something quiet
 *                next to something very loud.
 *
 * Values: Hamming's 0.54/0.46 and Blackman's 0.42/0.5/0.08 are the classical
 * (not "exact") coefficients — the ones Web Audio itself specifies for its own
 * Blackman, so this module's default reproduces the node it replaces. The
 * Blackman–Harris four-term coefficients are Harris (1978).
 *
 * @example SPECTRUM_WINDOWS.rectangular // [1]
 * @example SPECTRUM_WINDOWS.hann // [0.5, 0.5]
 * @example SPECTRUM_WINDOWS.hamming // [0.54, 0.46]
 * @example Object.keys(SPECTRUM_WINDOWS) // ["rectangular", "hann", "hamming", "blackman", "blackmanHarris"]
 */
export const SPECTRUM_WINDOWS = {
  rectangular: [1],
  hann: [0.5, 0.5],
  hamming: [0.54, 0.46],
  blackman: [0.42, 0.5, 0.08],
  blackmanHarris: [0.35875, 0.48829, 0.14128, 0.01168],
};

/**
 * The window a spectrum module uses when nothing says otherwise: Blackman, which
 * is what `AnalyserNode` hard-wires (Web Audio spec) — so a spectrogram authored
 * before this row existed is measured through the same taper after it.
 *
 * ── ONE THING DID CHANGE, AND IT IS NOT THE SHAPE, IT IS THE LEVEL ──────────
 * Stated because a docblock claiming "identical" here would be a confident lie.
 * `getByteFrequencyData` divides by fftSize and stops: it applies NEITHER the
 * one-sided x2 nor any window-gain correction. So it reports a FULL-SCALE SINE
 * at -13.56 dBFS under Blackman, and we report it at 0 — measured, and equal to
 * 20*log10(2 / 0.4198) for that window's mean weight. An existing spectrogram
 * is therefore BRIGHTER by that amount.
 *
 * IT IS NOT COMPENSATED FOR, deliberately. The offset is PER WINDOW (6.02 dB
 * rectangular, 12.05 Hann, 11.38 Hamming, 13.56 Blackman, 14.93 Blackman-Harris),
 * so shifting the default dB window to reproduce the old brightness would
 * reproduce it for ONE window and turn the row into the brightness knob the gain
 * correction exists to prevent (spectrumColumn states that argument). 0 dBFS for
 * a full-scale sine is also simply the right answer, which is what makes the
 * Floor/Ceiling rows readable as levels rather than as arbitrary numbers.
 *
 * @example SPECTRUM_DEFAULT_WINDOW // "blackman"
 */
export const SPECTRUM_DEFAULT_WINDOW = "blackman";

/**
 * Pure function. The `size` window weights for a named window — the cosine-sum
 * above, evaluated once per module rather than once per frame.
 *
 * DENOMINATOR N − 1, the SYMMETRIC convention: the first and last weights are
 * equal and the taper reaches its floor at both ends. (The other convention,
 * N, is for designing filters, where a periodic window is wanted; for ANALYSIS
 * the symmetric one is standard and is what Web Audio's own Blackman uses.)
 *
 * @param {string} name - a SPECTRUM_WINDOWS key
 * @param {number} size - the FFT size
 * @returns {Float32Array} `size` weights
 *
 * @example // no taper at all: every sample counts equally
 * @example [...windowTable("rectangular", 4)]
 * [ 1, 1, 1, 1 ]
 * @example // Hann reaches exactly zero at both ends, which is the taper
 * @example [...windowTable("hann", 5)].map((v) => +v.toFixed(3))
 * [ 0, 0.5, 1, 0.5, 0 ]
 * @example // Hamming's ends are 0.08, NOT zero — that is the whole difference
 * @example [...windowTable("hamming", 5)].map((v) => +v.toFixed(3))
 * [ 0.08, 0.54, 1, 0.54, 0.08 ]
 * @example // Blackman's ends are zero too, but reached by a three-term sum, so
 * @example // they land on the float's NEGATIVE zero — which is zero.
 * @example [...windowTable("blackman", 5)].map((v) => +v.toFixed(4))
 * [ -0, 0.34, 1, 0.34, -0 ]
 */
export function windowTable(name, size) {
  const coefficients = SPECTRUM_WINDOWS[name];
  if (!coefficients) {
    throw new Error(
      `windowTable: unknown window ${JSON.stringify(name)} —` +
      ` known: ${Object.keys(SPECTRUM_WINDOWS).join(", ")}`,
    );
  }
  const out = new Float32Array(size);
  const span = size > 1 ? size - 1 : 1;
  for (let n = 0; n < size; n++) {
    let w = 0;
    for (let k = 0; k < coefficients.length; k++) {
      w += (k % 2 === 0 ? 1 : -1) * coefficients[k] * Math.cos((2 * Math.PI * k * n) / span);
    }
    out[n] = w;
  }
  return out;
}

// ─── The FFT ─────────────────────────────────────────────────────────────────

/** One transform size's twiddle tables, kept for the life of the process. A
 *  spectrum module holds ONE size for its lifetime and there are five legal
 *  sizes in ordinary use, so this Map is bounded by the roster rather than by
 *  traffic and needs no eviction. Largest possible entry: 2·32768 float64 = 512 KB. */
const _twiddles = new Map();

/**
 * Query (memoized; near-pure — same size, same table, never mutated). Every
 * butterfly pass's twiddle factors for an `n`-point FFT, laid end to end so pass
 * `half` reads from index 2·half: entry k of that pass is (cos, sin) of
 * −π·k/half at 2·half + 2·k.
 *
 * WHY IT IS WORTH A TABLE, MEASURED: computing cos and sin inside the butterfly
 * loop cost 0.34 ms per 2048-point column on this machine; reading them costs
 * 0.14 ms. At 60 Hz per node that is 12 ms of every second handed back, and the
 * FFT is the only thing in the analysis path with a cost worth measuring.
 *
 * The layout is a single flat array (not an array of arrays) for the reason
 * core/analysis_display.js's ring gives: one allocation, and no pointer chase in
 * the inner loop.
 *
 * @param {number} n - the transform size, a power of two
 * @returns {Float64Array} 2·n values
 *
 * @example twiddleTable(4).length // 8
 * @example // pass half=1 has ONE twiddle, and it is 1 + 0i (angle 0)
 * @example [twiddleTable(4)[2], twiddleTable(4)[3]] // [1, 0]
 * @example // pass half=2's second twiddle is at angle -pi/2, i.e. -i
 * @example [twiddleTable(4)[6], twiddleTable(4)[7]].map((v) => +v.toFixed(6)) // [0, -1]
 * @example twiddleTable(1024) === twiddleTable(1024) // true (memoized)
 */
export function twiddleTable(n) {
  const hit = _twiddles.get(n);
  if (hit) return hit;
  const table = new Float64Array(n * 2);
  for (let half = 1; half < n; half <<= 1) {
    const step = -Math.PI / half; // negative: the FORWARD transform's sign convention
    for (let k = 0; k < half; k++) {
      table[(half << 1) + k * 2] = Math.cos(step * k);
      table[(half << 1) + k * 2 + 1] = Math.sin(step * k);
    }
  }
  _twiddles.set(n, table);
  return table;
}

/**
 * Command (mutates both arrays). An in-place radix-2 decimation-in-time FFT —
 * the iterative Cooley–Tukey, so there is no recursion and no allocation.
 *
 * IN PLACE AND ALLOCATION-FREE because this runs per node per animation frame,
 * and the engine's whole analysis loop is built on reused buffers (synth/engine
 * .js poll) so that a meter never triggers a GC that could stall the audio
 * thread. A textbook recursive FFT would allocate two arrays per level per frame.
 *
 * The two stages are the standard ones: a BIT-REVERSAL permutation, then log2(N)
 * passes of butterflies over doubling half-widths.
 *
 * @param {Float32Array} re - real parts, length a power of two (overwritten)
 * @param {Float32Array} im - imaginary parts, same length (overwritten)
 * @returns {undefined}
 *
 * @example // A CONSTANT is all DC: bin 0 carries everything, every other bin is 0.
 * @example // (re = [1,1,1,1] -> [4,0,0,0])
 * @example const re = Float32Array.of(1, 1, 1, 1), im = new Float32Array(4);
 * @example fftInPlace(re, im);
 * @example [...re]
 * [ 4, 0, 0, 0 ]
 * @example // ...and a sine at exactly bin 1 puts its whole magnitude in bin 1.
 * @example const s = Float32Array.from({length: 8}, (_, n) => Math.sin(2 * Math.PI * n / 8));
 * @example const si = new Float32Array(8);
 * @example fftInPlace(s, si);
 * @example Math.hypot(s[1], si[1]).toFixed(3)
 * '4.000'
 * @example Math.hypot(s[3], si[3]) < 1e-6
 * true
 */
export function fftInPlace(re, im) {
  const n = re.length;
  if (n !== im.length) throw new Error(`fftInPlace: re/im length mismatch (${n} vs ${im.length})`);
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`fftInPlace: length must be a power of two >= 2, got ${n}`);

  // BIT REVERSAL, by the incrementing-reversed-counter trick: `j` walks the
  // bit-reversed sequence alongside `i`, so no per-index reversal is computed.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  const twiddles = twiddleTable(n);
  for (let half = 1; half < n; half <<= 1) {
    // The table holds every pass's twiddles end to end: pass `half` starts at
    // index 2·half (see twiddleTable), and its k-th entry is (wr, wi) at 2·k.
    const base = half << 1;
    for (let start = 0; start < n; start += half << 1) {
      for (let k = 0; k < half; k++) {
        const wr = twiddles[base + k * 2];
        const wi = twiddles[base + k * 2 + 1];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// ─── Magnitudes ──────────────────────────────────────────────────────────────

/**
 * THE dB RANGE THE ENGINE NORMALISES ITS COLUMNS OVER, and why it is wider than
 * what the picture shows.
 *
 * A pushed column is a magnitude in 0..1 (core/analysis_display.js's unit-free
 * ring contract), so SOME dB range has to map onto it. The AnalyserNode's own
 * defaults are −100..−30 dBFS, and normalising over those would CLIP: anything
 * above −30 dBFS would arrive as exactly 1.0 and be unrecoverable, which would
 * make a display-side ceiling row a lie. Normalising over the full −100..0
 * instead keeps every reading distinguishable, and the display maps the part of
 * it the author asked for.
 */
export const SPECTRUM_DB_FLOOR = -100;
export const SPECTRUM_DB_CEIL = 0;

/**
 * Pure function. dBFS for a linear magnitude, with digital silence answering the
 * floor rather than −Infinity.
 *
 * @param {number} magnitude - a linear magnitude, 0..1 for a full-scale signal
 * @returns {number} dBFS, floored at SPECTRUM_DB_FLOOR
 *
 * @example magnitudeDb(1) // 0
 * @example magnitudeDb(0.5).toFixed(2) // '-6.02'
 * @example magnitudeDb(0) // -100
 * @example magnitudeDb(1e-30) // -100
 */
export function magnitudeDb(magnitude) {
  if (!(magnitude > 0)) return SPECTRUM_DB_FLOOR;
  return Math.max(SPECTRUM_DB_FLOOR, 20 * Math.log10(magnitude));
}

/**
 * Command (mutates `out` and the two scratch arrays). ONE SPECTRUM COLUMN:
 * window the samples, transform them, and write each bin's normalised magnitude.
 *
 * ── THE NORMALISATIONS, ALL THREE, BECAUSE EACH IS A PLACE TO BE WRONG ──────
 *   1/N          the DFT's own scale, so a full-scale sine reads the same at
 *                every FFT size. (Web Audio specifies exactly this division.)
 *   1/windowGain the window threw away energy — Hann keeps half the samples'
 *                weight, Blackman 42% — so without this a Hann spectrogram would
 *                be 6 dB darker than a rectangular one and the `window` row would
 *                look like a brightness knob. Dividing by the window's MEAN makes
 *                the choice change the SHAPE and not the level, which is what it
 *                actually does.
 *   ×2           a real signal's energy is split between the positive and
 *                negative frequency halves and we keep only the positive half.
 *
 * ── SMOOTHING IS EXPONENTIAL, IN THE MAGNITUDE DOMAIN ───────────────────────
 * `previous` (when supplied) is blended in at `smoothing` BEFORE the dB
 * conversion, which is the order the Web Audio spec smooths in — smoothing dB
 * values instead would make a decay's tail linger differently. Pass null on the
 * first frame; the array is then seeded rather than blended against zeros, so a
 * display does not fade UP from silence for its first half second.
 *
 * @param {Float32Array} samples - `size` time-domain samples, −1..1
 * @param {Float32Array} window - `size` weights (windowTable output)
 * @param {Float32Array} re - `size` scratch (overwritten)
 * @param {Float32Array} im - `size` scratch (overwritten)
 * @param {Float32Array|null} previous - `size/2` smoothed magnitudes, or null
 * @param {number} smoothing - 0 (no smoothing) .. <1
 * @param {Float32Array} out - `size/2` normalised 0..1 values (overwritten)
 * @returns {Float32Array} `out`
 *
 * @example // A FULL-SCALE SINE ON A BIN CENTRE READS 0 dBFS -> 1.0, under EVERY
 * @example // window: that is what the window-gain correction is for.
 * @example const N = 64, k = 8;
 * @example const sine = Float32Array.from({length: N}, (_, n) => Math.sin(2 * Math.PI * k * n / N));
 * @example const peak = (w) => spectrumColumn(sine, windowTable(w, N), new Float32Array(N), new Float32Array(N), null, 0, new Float32Array(N / 2))[k];
 * @example +peak("rectangular").toFixed(2)
 * 1
 * @example // ...and silence reads 0 everywhere, not NaN.
 * @example [...spectrumColumn(new Float32Array(8), windowTable("hann", 8), new Float32Array(8), new Float32Array(8), null, 0, new Float32Array(4))]
 * [ 0, 0, 0, 0 ]
 */
export function spectrumColumn(samples, window, re, im, previous, smoothing, out) {
  const size = samples.length;
  const bins = size / 2;
  let gain = 0;
  for (let n = 0; n < size; n++) {
    re[n] = samples[n] * window[n];
    im[n] = 0;
    gain += window[n];
  }
  fftInPlace(re, im);
  // The window's MEAN weight; a rectangular window's is 1, so it is the identity
  // for the case with nothing to correct.
  const scale = 2 / (gain || size);
  for (let k = 0; k < bins; k++) {
    const raw = Math.hypot(re[k], im[k]) * scale;
    const magnitude = previous ? previous[k] * smoothing + raw * (1 - smoothing) : raw;
    if (previous) previous[k] = magnitude;
    const db = magnitudeDb(magnitude);
    out[k] = (db - SPECTRUM_DB_FLOOR) / (SPECTRUM_DB_CEIL - SPECTRUM_DB_FLOOR);
  }
  return out;
}
