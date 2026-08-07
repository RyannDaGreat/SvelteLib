/**
 * THE MEASUREMENT LIBRARY for the upstream-C++ A/B harness.
 *
 * Every function here is PURE. They take two same-length Float64Array signals
 * (ours and upstream's) and answer the four questions the brief asks:
 * error, correlation, tuning, spectrum — plus a filter's corner and resonance.
 *
 * WHY THESE FOUR AND NOT JUST CORRELATION: two saws an octave apart correlate
 * poorly (an obvious failure), but two saws with a WRONG PolyBLEP correlate at
 * 0.99 and sound audibly different. Correlation alone would call that a pass.
 * The harmonic table is what catches "right pitch, wrong waveform"; the f0
 * estimate is what catches a semitone of detune that correlation reads as
 * near-total decorrelation without saying WHY.
 */

/** Real-signal FFT sizes are powers of two; a non-power-of-two input is a bug in the caller. */
function assertPowerOfTwo(n, who) {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`${who}: length ${n} is not a power of two`);
}

/**
 * Pure function. In-place iterative radix-2 complex FFT.
 *
 * @param {Float64Array} re - real parts, length N (power of two); MUTATED
 * @param {Float64Array} im - imaginary parts, length N; MUTATED
 * @returns {void}
 *
 * @example
 * >>> // a length-4 DC signal transforms to [4,0,0,0]
 * >>> const re = Float64Array.from([1,1,1,1]), im = new Float64Array(4);
 * >>> fftInPlace(re, im); re[0] // 4
 */
export function fftInPlace(re, im) {
  const n = re.length;
  assertPowerOfTwo(n, "fftInPlace");
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Pure function. Magnitude spectrum of a Hann-windowed slice, length N/2+1.
 *
 * @param {Float64Array|number[]} x - the signal; only the first N samples are used
 * @param {number} n - FFT size, a power of two, n <= x.length
 * @returns {Float64Array} magnitudes for bins 0..n/2
 *
 * @example
 * >>> // a pure 4-cycles-per-window sine peaks at bin 4
 * >>> const s = Float64Array.from({length:1024}, (_,i)=>Math.sin(2*Math.PI*4*i/1024));
 * >>> let m = magnitudeSpectrum(s, 1024), best = 0;
 * >>> for (let k=1;k<512;k++) if (m[k] > m[best]) best = k;
 * >>> best // 4
 */
export function magnitudeSpectrum(x, n) {
  assertPowerOfTwo(n, "magnitudeSpectrum");
  if (x.length < n) throw new Error(`magnitudeSpectrum: need ${n} samples, got ${x.length}`);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Hann. Leakage from a rectangular window would smear a saw's harmonics
    // into each other and make the harmonic table meaningless.
    re[i] = x[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  fftInPlace(re, im);
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = Math.hypot(re[k], im[k]);
  return out;
}

/**
 * Pure function. Mean of a signal.
 *
 * @param {Float64Array|number[]} x
 * @returns {number}
 *
 * @example mean([1, 2, 3]) // 2
 */
export function mean(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / x.length;
}

/**
 * Pure function. Root mean square of a signal.
 *
 * @param {Float64Array|number[]} x
 * @returns {number}
 *
 * @example rms([3, 4]) // 3.5355339059327378
 */
export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/**
 * Pure function. Zero-lag normalized cross-correlation of two signals, on
 * MEAN-REMOVED copies. 1 = identical shape, 0 = unrelated, -1 = inverted.
 *
 * Mean removal matters: two DC-offset-differing copies of the same wave would
 * otherwise score near 1 purely on their shared offset.
 *
 * @param {Float64Array|number[]} a
 * @param {Float64Array|number[]} b - same length as a
 * @returns {number} in [-1, 1]; 0 when either signal is constant
 *
 * @example crossCorrelation([1, -1, 1, -1], [2, -2, 2, -2]) // 1
 * @example crossCorrelation([1, -1, 1, -1], [-1, 1, -1, 1]) // -1
 */
export function crossCorrelation(a, b) {
  if (a.length !== b.length) throw new Error(`crossCorrelation: ${a.length} vs ${b.length}`);
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const u = a[i] - ma;
    const v = b[i] - mb;
    num += u * v;
    da += u * u;
    db += v * v;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * Pure function. Largest |a[i] - b[i]|.
 *
 * @param {Float64Array|number[]} a
 * @param {Float64Array|number[]} b
 * @returns {number}
 *
 * @example maxAbsError([1, 2, 3], [1, 2.5, 3]) // 0.5
 */
export function maxAbsError(a, b) {
  if (a.length !== b.length) throw new Error(`maxAbsError: ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

/**
 * Pure function. Parabolic peak refinement over three log-magnitude samples.
 * Returns the fractional bin offset in [-0.5, 0.5] of the true peak.
 *
 * @param {number} ym - magnitude at bin k-1
 * @param {number} y0 - magnitude at bin k
 * @param {number} yp - magnitude at bin k+1
 * @returns {number}
 *
 * @example parabolicOffset(1, 2, 1) // 0
 * @example Math.round(parabolicOffset(1, 2, 1.9) * 1000) / 1000 // 0.309
 */
export function parabolicOffset(ym, y0, yp) {
  const a = Math.log(Math.max(ym, 1e-300));
  const b = Math.log(Math.max(y0, 1e-300));
  const c = Math.log(Math.max(yp, 1e-300));
  const denom = a - 2 * b + c;
  if (denom === 0) return 0;
  return (0.5 * (a - c)) / denom;
}

/**
 * Pure function. |DTFT| of a Hann-windowed slice at an ARBITRARY frequency.
 *
 * The FFT only samples the spectrum on a bin grid. This evaluates the same
 * transform anywhere between the bins, which is what lets `estimateF0` refine a
 * peak to a precision the grid does not have.
 *
 * @param {Float64Array|number[]} x - the signal; the first n samples are used
 * @param {number} n - window length
 * @param {number} hz - the frequency to evaluate at
 * @param {number} sampleRate
 * @returns {number} magnitude
 *
 * @example
 * >>> // at the tone's own frequency it is far larger than a bin away
 * >>> const s = Float64Array.from({length:4096}, (_,i)=>Math.sin(2*Math.PI*440*i/48000));
 * >>> dtftMagnitude(s, 4096, 440, 48000) > 10 * dtftMagnitude(s, 4096, 480, 48000) // true
 */
export function dtftMagnitude(x, n, hz, sampleRate) {
  const w = (-2 * Math.PI * hz) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
    const v = x[i] * win;
    const a = w * i;
    re += v * Math.cos(a);
    im += v * Math.sin(a);
  }
  return Math.hypot(re, im);
}

/**
 * Pure function. Frequency of the spectral maximum in `[lo, hi]`, by golden-section
 * search on the true DTFT magnitude.
 *
 * WHY NOT PARABOLIC INTERPOLATION, which is what this used to do: fitting a
 * parabola to three log-magnitude bins is BIASED, and the bias grows as the peak
 * falls further from a bin centre. Measured on pure sines at 8192 points and
 * 48 kHz it reached 2.4 cents at 55 Hz — and the report calls 1 cent a failure,
 * so the instrument was coarser than the thing it was judging. Searching the
 * DTFT directly has no such bias: it finds the actual maximum of the actual
 * windowed transform.
 *
 * @param {Float64Array|number[]} x
 * @param {number} n - window length
 * @param {number} lo - hertz, lower bracket
 * @param {number} hi - hertz, upper bracket
 * @param {number} sampleRate
 * @returns {number} hertz
 *
 * @example
 * >>> const s = Float64Array.from({length:8192}, (_,i)=>Math.sin(2*Math.PI*440*i/48000));
 * >>> Math.abs(refinePeakHz(s, 8192, 430, 450, 48000) - 440) < 0.01 // true
 */
export function refinePeakHz(x, n, lo, hi, sampleRate) {
  const PHI = (Math.sqrt(5) - 1) / 2;
  // 1e-6 Hz is ~7e-6 cents at C4 — far below anything the report distinguishes,
  // and reached in about 40 evaluations over a 2-bin bracket.
  const TOLERANCE_HZ = 1e-6;
  let a = lo;
  let b = hi;
  let c = b - PHI * (b - a);
  let d = a + PHI * (b - a);
  let fc = dtftMagnitude(x, n, c, sampleRate);
  let fd = dtftMagnitude(x, n, d, sampleRate);
  while (b - a > TOLERANCE_HZ) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - PHI * (b - a);
      fc = dtftMagnitude(x, n, c, sampleRate);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + PHI * (b - a);
      fd = dtftMagnitude(x, n, d, sampleRate);
    }
  }
  return (a + b) / 2;
}

/**
 * Pure function. Fundamental frequency estimate, in hertz.
 *
 * Two stages, because either alone gets a rich waveform wrong. A HARMONIC
 * PRODUCT SPECTRUM (4 harmonics) picks the fundamental's BIN without being
 * fooled by a saw whose 2nd harmonic is nearly as loud — a raw argmax reports an
 * octave up on some waveforms. Then a golden-section search on the true DTFT
 * locates the peak WITHIN that bin, because the bin grid at 8192 points and
 * 48 kHz is 5.86 Hz, which is 38 cents at C4.
 *
 * @param {Float64Array|number[]} x - the signal
 * @param {number} sampleRate
 * @param {number} n - FFT size (power of two), default 8192
 * @returns {number} hertz; 0 when the signal has no usable peak (silence)
 *
 * @example
 * >>> const s = Float64Array.from({length:16384}, (_,i)=>Math.sin(2*Math.PI*440*i/48000));
 * >>> Math.abs(estimateF0(s, 48000) - 440) < 0.01 // true
 */
export function estimateF0(x, sampleRate, n = 8192) {
  const mag = magnitudeSpectrum(x, n);
  const half = n / 2;
  const HPS_HARMONICS = 4;
  // Ignore DC and the first couple of bins: window leakage from an offset
  // makes bin 0-1 the loudest thing in the spectrum of any non-centred signal.
  const LOW_BIN = 2;
  let bestBin = 0;
  let bestScore = 0;
  for (let k = LOW_BIN; k < Math.floor(half / HPS_HARMONICS); k++) {
    let p = 1;
    for (let h = 1; h <= HPS_HARMONICS; h++) p *= mag[k * h];
    if (p > bestScore) {
      bestScore = p;
      bestBin = k;
    }
  }
  if (bestBin === 0) return 0;

  // ── THE SUBHARMONIC GHOST, AND WHY THIS GUARD IS NOT OPTIONAL ─────────────
  // HPS multiplies mag[k]·mag[2k]·mag[3k]·mag[4k]. For a NEAR-PURE SINE there
  // are no harmonics to multiply, so the product is dominated by noise and the
  // winner is often f0/3 or f0/4 — a bin with essentially no energy in it. That
  // is not hypothetical: the Bogaudio VCO's sine at 3594 Hz was reported as
  // 895 Hz on one side and 1199 Hz on the other, a 506-cent "failure", while
  // the two signals correlated at 1.000000 and differed by 5.6 mV.
  // The test is energy, not structure: a candidate that carries less than
  // −40 dB of the spectrum's strongest bin is not a fundamental anyone can
  // hear, so the strongest bin is taken instead. A real waveform's fundamental
  // is its loudest partial by a wide margin, so this never fires on one.
  const GHOST_FLOOR = 0.01; // −40 dB in amplitude
  let peakBin = LOW_BIN;
  for (let j = LOW_BIN; j < half; j++) if (mag[j] > mag[peakBin]) peakBin = j;
  if (mag[bestBin] < GHOST_FLOOR * mag[peakBin]) bestBin = peakBin;

  // The HPS bin can sit one bin off the true local maximum; snap to it first.
  let k = bestBin;
  while (k > LOW_BIN && mag[k - 1] > mag[k]) k--;
  while (k < half - 1 && mag[k + 1] > mag[k]) k++;
  const binHz = sampleRate / n;
  return refinePeakHz(x, n, (k - 1) * binHz, (k + 1) * binHz, sampleRate);
}

/**
 * Pure function. Interval between two frequencies, in semitones (signed).
 *
 * @param {number} f - measured
 * @param {number} ref - reference
 * @returns {number} 0 when either is non-positive (nothing to compare)
 *
 * @example Math.round(semitonesBetween(880, 440)) // 12
 * @example Math.round(semitonesBetween(440, 466.16)) // -1
 */
export function semitonesBetween(f, ref) {
  if (!(f > 0) || !(ref > 0)) return 0;
  return 12 * Math.log2(f / ref);
}

/**
 * Pure function. Energy in the first `count` harmonics of `f0`, normalized so
 * the fundamental is 1.
 *
 * Each harmonic's energy is summed over a small bin window, because a Hann
 * window spreads a sinusoid over three bins and a frequency that is not an
 * exact bin centre splits between neighbours.
 *
 * @param {Float64Array|number[]} x
 * @param {number} sampleRate
 * @param {number} f0 - hertz
 * @param {number} count - how many harmonics, default 8
 * @param {number} n - FFT size, default 8192
 * @returns {number[]} length `count`; all zeros when the fundamental has no energy
 *
 * @example
 * >>> // a pure sine has a fundamental and nothing above it
 * >>> const s = Float64Array.from({length:16384}, (_,i)=>Math.sin(2*Math.PI*500*i/48000));
 * >>> const h = harmonicProfile(s, 48000, 500, 3);
 * >>> [h[0], h[1] < 1e-3, h[2] < 1e-3] // [1, true, true]
 */
export function harmonicProfile(x, sampleRate, f0, count = 8, n = 8192) {
  const mag = magnitudeSpectrum(x, n);
  const half = n / 2;
  const binHz = sampleRate / n;
  // A Hann main lobe is 4 bins wide; ±2 captures it without reaching a
  // neighbouring harmonic unless f0 is below ~4 bins, which we refuse below.
  const WINDOW_BINS = 2;
  if (f0 <= 0 || f0 / binHz < 2 * WINDOW_BINS) return new Array(count).fill(0);
  const energyAt = (hz) => {
    const centre = Math.round(hz / binHz);
    if (centre + WINDOW_BINS >= half) return 0;
    let e = 0;
    for (let k = centre - WINDOW_BINS; k <= centre + WINDOW_BINS; k++) e += mag[k] * mag[k];
    return e;
  };
  const fundamental = energyAt(f0);
  if (fundamental <= 0) return new Array(count).fill(0);
  const out = [];
  for (let h = 1; h <= count; h++) out.push(energyAt(h * f0) / fundamental);
  return out;
}

/**
 * Pure function. Magnitude response, in dB, of an IMPULSE RESPONSE.
 *
 * Only meaningful for a filter driven with fixed parameters — an LTI system.
 * A time-varying or nonlinear stage must not be measured this way, and the
 * cases that use it say so.
 *
 * @param {Float64Array|number[]} ir - the impulse response
 * @param {number} sampleRate
 * @param {number} n - FFT size, default 8192
 * @returns {{hz: Float64Array, db: Float64Array}} bins 0..n/2
 *
 * @example
 * >>> // a pure delay is all-pass: 0 dB everywhere
 * >>> const ir = new Float64Array(1024); ir[3] = 1;
 * >>> const r = impulseResponseDb(ir, 48000, 1024);
 * >>> Math.round(r.db[100]) // 0
 */
export function impulseResponseDb(ir, sampleRate, n = 8192) {
  assertPowerOfTwo(n, "impulseResponseDb");
  const re = new Float64Array(n);
  // NO WINDOW: an impulse response is already finite and starts at t=0, so a
  // window would multiply the response by the window's own transfer function.
  for (let i = 0; i < Math.min(n, ir.length); i++) re[i] = ir[i];
  const im = new Float64Array(n);
  fftInPlace(re, im);
  const half = n / 2;
  const hz = new Float64Array(half + 1);
  const db = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    hz[k] = (k * sampleRate) / n;
    db[k] = 20 * Math.log10(Math.max(Math.hypot(re[k], im[k]), 1e-300));
  }
  return { hz, db };
}

/**
 * Pure function. A lowpass response's −3 dB corner and its resonant peak.
 *
 * The reference level is the response at DC, not the peak — a resonant filter's
 * peak is above unity and measuring −3 dB from it would report a corner well
 * inside the passband.
 *
 * @param {{hz: Float64Array, db: Float64Array}} response - from impulseResponseDb
 * @returns {{cornerHz: number, peakDb: number, peakHz: number, dcDb: number}}
 *          cornerHz is 0 when the response never falls 3 dB below DC
 *
 * @example
 * >>> // a one-pole RC at fc = 1000 Hz, 48 kHz: corner lands within a few Hz
 * >>> const a = Math.exp(-2*Math.PI*1000/48000); const ir = new Float64Array(8192);
 * >>> let y = 0; for (let i=0;i<8192;i++){ y = (1-a)*(i===0?1:0) + a*y; ir[i]=y; }
 * >>> Math.abs(lowpassCorner(impulseResponseDb(ir, 48000)).cornerHz - 1000) < 20 // true
 */
export function lowpassCorner(response) {
  const { hz, db } = response;
  const dcDb = db[0];
  // HALF POWER IS 3.0103 dB, NOT 3, and the difference is not pedantry: the
  // self-test caught a uniform 0.24% low bias in every corner this function
  // reported, and 0.0103 dB divided by a one-pole's 3.01 dB/octave slope is
  // 0.0034 octaves, which IS 0.24%. A literal 3 was the whole of the error.
  const HALF_POWER_DB = 10 * Math.log10(2);
  let peakDb = -Infinity;
  let peakHz = 0;
  for (let k = 0; k < db.length; k++) {
    if (db[k] > peakDb) {
      peakDb = db[k];
      peakHz = hz[k];
    }
  }
  const target = dcDb - HALF_POWER_DB;
  let cornerHz = 0;
  // Walk up from DC to the FIRST crossing below the target, past any resonant
  // rise. Linear interpolation in dB against a log frequency axis is close
  // enough at this bin spacing to be sub-percent.
  for (let k = 1; k < db.length; k++) {
    if (db[k] <= target && db[k - 1] > target) {
      const t = (db[k - 1] - target) / (db[k - 1] - db[k]);
      cornerHz = hz[k - 1] + t * (hz[k] - hz[k - 1]);
      break;
    }
  }
  return { cornerHz, peakDb, peakHz, dcDb };
}

/**
 * Pure function. Format a harmonic profile as a compact dB string for a table
 * cell — "0, -14.1, -19.8, …" relative to the fundamental.
 *
 * @param {number[]} profile - from harmonicProfile (energy ratios)
 * @returns {string}
 *
 * @example harmonicsDbString([1, 0.25, 0]) // "0.0 -6.0 -inf"
 */
export function harmonicsDbString(profile) {
  return profile
    .map((e) => (e <= 0 ? "-inf" : (10 * Math.log10(e)).toFixed(1)))
    .join(" ");
}
