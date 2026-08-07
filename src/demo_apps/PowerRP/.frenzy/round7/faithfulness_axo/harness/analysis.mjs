/**
 * analysis.mjs — THE MEASUREMENTS. Pure, so they can be trusted in a report.
 *
 * Deliberately small: an FFT, a pitch estimate, a harmonic profile, and the two
 * error numbers. Nothing here knows about Axoloti or about PowerRP.
 *
 * WHY A PITCH ESTIMATE AND A SPECTRUM AND NOT JUST A CORRELATION: a port can be
 * a perfect octave out and still correlate at 0.7 against the original; a port
 * can be a sine where the original is a saw and correlate at 0.99 on the
 * fundamental alone. Correlation is reported, but it is never the finding.
 */

/**
 * Pure function. In-place iterative radix-2 FFT.
 *
 * @param {Float64Array} re - Real parts, length a power of two; MUTATED
 * @param {Float64Array} im - Imaginary parts, same length; MUTATED
 * @returns {void}
 *
 * @example
 * // >>> const re = Float64Array.from([1, 0, 0, 0]), im = new Float64Array(4);
 * // >>> fft(re, im); [...re]  // [1, 1, 1, 1] — an impulse is flat
 */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`fft length ${n} is not a power of two`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Pure function. Hann window of length n. @example hannWindow(2) // [0, 0] */
export function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

/**
 * Pure function. Magnitude spectrum of a signal's last power-of-two samples,
 * Hann-windowed and DC-removed.
 *
 * @param {Float64Array} x - Signal
 * @returns {{mag: Float64Array, size: number}} `mag[k]` for k in 0..size/2
 *
 * @example spectrum(new Float64Array(1024)).mag[0] // 0 — silence is silent
 */
export function spectrum(x) {
  let size = 1;
  while (size * 2 <= x.length) size *= 2;
  const start = x.length - size;
  let mean = 0;
  for (let i = 0; i < size; i++) mean += x[start + i];
  mean /= size;
  const w = hannWindow(size);
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = (x[start + i] - mean) * w[i];
  fft(re, im);
  const mag = new Float64Array(size / 2 + 1);
  for (let k = 0; k <= size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return { mag, size };
}

/**
 * Pure function. Fundamental frequency, by the largest spectral peak refined
 * with a parabolic fit on the log magnitudes.
 *
 * The peak is searched from bin 2 up, so DC and the window's own skirt cannot
 * win. Returns 0 when the signal has no peak above the noise floor — silence
 * must read as "no pitch", never as "bin 2".
 *
 * @param {Float64Array} x - Signal
 * @param {number} fs - Sample rate in Hz
 * @returns {number} Hz
 *
 * @example
 * // >>> const fs = 48000, n = 8192, s = new Float64Array(n);
 * // >>> for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 440 * i / fs);
 * // >>> estimateF0(s, fs).toFixed(1)  // "440.0"
 */
export function estimateF0(x, fs) {
  const { mag, size } = spectrum(x);
  let peak = 0, best = 0;
  for (let k = 2; k < mag.length - 1; k++) if (mag[k] > best) { best = mag[k]; peak = k; }
  if (peak === 0) return 0;
  let total = 0;
  for (let k = 1; k < mag.length; k++) total += mag[k] * mag[k];
  if (best * best < 1e-9 * total || total === 0) return 0;
  const a = Math.log(mag[peak - 1] + 1e-300);
  const b = Math.log(mag[peak] + 1e-300);
  const c = Math.log(mag[peak + 1] + 1e-300);
  const delta = 0.5 * (a - c) / (a - 2 * b + c || 1e-300);
  return (peak + Math.max(-1, Math.min(1, delta))) * fs / size;
}

/**
 * Pure function. Energy in the first `count` harmonics of `f0`, normalised so
 * the largest is 1. This is the "right pitch, wrong waveform" detector: a saw
 * falls off as 1/n, a square has only odd harmonics, a sine has one.
 *
 * @param {Float64Array} x - Signal
 * @param {number} fs - Sample rate
 * @param {number} f0 - Fundamental in Hz
 * @param {number} [count=8] - How many harmonics
 * @returns {Float64Array} length `count`, index 0 = fundamental
 *
 * @example
 * // A pure 100 Hz sine gives [1, ~0, ~0, …] — all energy in harmonic 1.
 */
export function harmonicProfile(x, fs, f0, count = 8) {
  const out = new Float64Array(count);
  if (!(f0 > 0)) return out;
  const { mag, size } = spectrum(x);
  for (let h = 1; h <= count; h++) {
    const centre = h * f0 * size / fs;
    if (centre >= mag.length - 2) break;
    // sum the three bins around the harmonic — the Hann window is 3 bins wide
    let e = 0;
    for (let k = Math.max(0, Math.round(centre) - 1); k <= Math.round(centre) + 1; k++) {
      if (k < mag.length) e += mag[k] * mag[k];
    }
    out[h - 1] = Math.sqrt(e);
  }
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < count; i++) out[i] /= max;
  return out;
}

/**
 * Pure function. Max absolute difference between two equal-length signals.
 *
 * @example maxAbsError(Float64Array.from([1, 2]), Float64Array.from([1, 3])) // 1
 */
export function maxAbsError(a, b) {
  if (a.length !== b.length) throw new Error(`length mismatch ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/**
 * Pure function. Normalised cross-correlation at zero lag, mean-removed.
 * 1 = identical shape, 0 = unrelated, -1 = inverted.
 *
 * @example
 * // >>> const a = Float64Array.from([1, -1, 1, -1]);
 * // >>> ncc(a, a).toFixed(3)   // "1.000"
 * // >>> ncc(a, a.map(v => -v)).toFixed(3)  // "-1.000"
 */
export function ncc(a, b) {
  if (a.length !== b.length) throw new Error(`length mismatch ${a.length} vs ${b.length}`);
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return da === db ? 1 : 0;
  return num / Math.sqrt(da * db);
}

/** Pure function. RMS. @example rms(Float64Array.from([3, 4])) // 3.5355… */
export function rms(x) {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

/**
 * Pure function. Time in SECONDS for a signal to first reach `fraction` of its
 * own peak (attack), measured from index 0.
 *
 * @example
 * // A ramp reaching 1.0 at sample 4800 of 48 kHz reports 0.1 s at fraction 1.
 */
export function riseTimeSeconds(x, fs, fraction) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return NaN;
  const target = peak * fraction;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= target) return i / fs;
  return NaN;
}

/**
 * Pure function. Time in seconds from the END OF THE PEAK PLATEAU until the
 * signal falls to `fraction` of that peak. Used for envelope decay/release.
 *
 * "END OF THE PLATEAU", not "the peak sample", and the difference is not
 * cosmetic — it produced a false failure. `env/ahd m` holds at full scale for
 * two thirds of a second; its integer side settles at 0.999999 and our float
 * side at 1.000000, so a strict argmax picked the FIRST sample of a long
 * plateau on one side and a later one on the other, and the two "decay times"
 * differed by 24% while the two envelopes agreed to 6e-7 everywhere. Anchoring
 * on the last sample within `PLATEAU_TOLERANCE` of the peak removes the
 * ambiguity without weakening the measurement: a genuinely slower decay still
 * takes longer to leave the plateau behind.
 *
 * @param {Float64Array} x
 * @param {number} fs - sample rate
 * @param {number} fraction - of the peak, e.g. 1/e for a time constant
 * @returns {number} seconds, or NaN if the signal never falls that far
 *
 * @example
 * // An exponential decay measured at fraction 1/e reports its time constant.
 */
export function fallTimeSeconds(x, fs, fraction) {
  /** Within this of the peak still counts as "at the peak". */
  const PLATEAU_TOLERANCE = 1e-4;
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return NaN;
  let plateauEnd = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= peak * (1 - PLATEAU_TOLERANCE)) plateauEnd = i;
  const target = peak * fraction;
  for (let i = plateauEnd; i < x.length; i++) if (Math.abs(x[i]) <= target) return (i - plateauEnd) / fs;
  return NaN;
}

/**
 * Pure function. Magnitude response of a black-box filter run, in dB, at the
 * requested probe frequencies, from a single sine-sweep-free measurement: the
 * caller supplies input and output of the SAME white-noise burst.
 *
 * @param {Float64Array} input
 * @param {Float64Array} output
 * @param {number} fs
 * @param {Float64Array|number[]} freqs - Probe frequencies in Hz
 * @returns {Float64Array} dB gain at each probe frequency
 *
 * @example
 * // A unity passthrough reports ~0 dB at every probe frequency.
 */
export function transferDb(input, output, fs, freqs) {
  const si = spectrum(input), so = spectrum(output);
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const centre = freqs[i] * si.size / fs;
    let ei = 0, eo = 0;
    for (let k = Math.max(0, Math.round(centre) - 2); k <= Math.round(centre) + 2; k++) {
      if (k < si.mag.length) { ei += si.mag[k] * si.mag[k]; eo += so.mag[k] * so.mag[k]; }
    }
    out[i] = 10 * Math.log10((eo + 1e-300) / (ei + 1e-300));
  }
  return out;
}

/**
 * Pure function. Corner frequency: the probe frequency where `transferDb`
 * first crosses `dropDb` below its own maximum, linearly interpolated in log f.
 *
 * @example
 * // A one-pole at 1 kHz measured with a dense probe grid reports ~1000.
 */
export function cornerFrequency(db, freqs, dropDb = -3) {
  let max = -Infinity;
  for (const v of db) max = Math.max(max, v);
  const target = max + dropDb;
  for (let i = 1; i < db.length; i++) {
    if (db[i - 1] > target && db[i] <= target) {
      const t = (db[i - 1] - target) / (db[i - 1] - db[i]);
      return Math.exp(Math.log(freqs[i - 1]) + t * (Math.log(freqs[i]) - Math.log(freqs[i - 1])));
    }
  }
  return NaN;
}
