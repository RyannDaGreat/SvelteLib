/**
 * THE MEASURING INSTRUMENT, MEASURED. Every number in the report comes out of
 * `lib/metrics.mjs`; if the f0 estimator is a semitone off, every tuning verdict
 * in the report is a semitone off and nobody would know.
 *
 * So these are not unit tests for their own sake. Each one drives a metric with
 * a signal whose answer is known ANALYTICALLY, and asserts the metric recovers
 * it to a tolerance tighter than the threshold the report uses to judge a node.
 *
 *   node harness/metrics_test.mjs
 */

import {
  estimateF0, semitonesBetween, harmonicProfile, crossCorrelation,
  maxAbsError, rms, impulseResponseDb, lowpassCorner, magnitudeSpectrum,
} from "./lib/metrics.mjs";
import { harmonicDbGap } from "./lib/runner.mjs";

const SR = 48000;
let failures = 0;

/** Command. Assert and record; never throws, so one red does not hide the rest. */
function check(label, ok, detail) {
  if (!ok) {
    failures++;
    process.stdout.write(`FAIL  ${label}${detail ? ` — ${detail}` : ""}\n`);
  } else {
    process.stdout.write(`ok    ${label}${detail ? ` (${detail})` : ""}\n`);
  }
}

/** Pure function. `n` samples of a sine at `hz`. */
function sine(hz, n = 32768, amp = 1, phase = 0) {
  return Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / SR + phase));
}

/** Pure function. `n` samples of an IDEAL band-limited saw at `hz` — harmonic k
 *  has amplitude 1/k, which is the analytic answer the harmonic table must find. */
function idealSaw(hz, n = 32768) {
  const out = new Float64Array(n);
  const maxH = Math.floor((SR / 2) / hz);
  for (let k = 1; k <= maxH; k++) {
    for (let i = 0; i < n; i++) out[i] += Math.sin(2 * Math.PI * k * hz * i / SR) / k;
  }
  return out;
}

// ── f0: the report judges tuning at 1 cent, so the estimator must beat that ──
for (const hz of [55, 110, 261.6256, 440, 1000, 2093, 5000]) {
  const f = estimateF0(sine(hz), SR);
  const cents = Math.abs(semitonesBetween(f, hz)) * 100;
  check(`estimateF0 sine ${hz} Hz`, cents < 0.05, `${f.toFixed(4)} Hz, ${cents.toFixed(4)} cents`);
}
// A rich waveform is where a naive argmax reports an octave up.
for (const hz of [110, 261.6256, 440]) {
  const f = estimateF0(idealSaw(hz), SR);
  const cents = Math.abs(semitonesBetween(f, hz)) * 100;
  check(`estimateF0 saw ${hz} Hz (no octave error)`, cents < 1.0, `${f.toFixed(4)} Hz, ${cents.toFixed(3)} cents`);
}
// THE SUBHARMONIC GHOST. A near-pure sine with a little distortion noise has no
// harmonics for the HPS to multiply, so its product peaks on f0/3 or f0/4 — a
// bin with no energy in it. This exact signal made the Bogaudio VCO's sine
// output read 895 Hz instead of 3594 Hz and produced a 506-cent phantom failure.
{
  const n = 32768;
  const hz = 3593.97;
  const s = Float64Array.from({ length: n }, (_, i) => {
    // A deterministic low-level dither standing in for a wavetable's
    // interpolation error, which is what fed the ghost in the real case.
    const dither = 1e-4 * Math.sin(2 * Math.PI * 7 * i / n + 0.3);
    return Math.sin(2 * Math.PI * hz * i / SR) + dither;
  });
  const f = estimateF0(s, SR, n);
  check("estimateF0 rejects a subharmonic ghost on a near-pure sine",
    Math.abs(semitonesBetween(f, hz)) * 100 < 1, `${f.toFixed(2)} Hz for a ${hz} Hz tone`);
}

// THE THING THE REPORT MUST NEVER MISS: a detuned pair must READ as detuned.
{
  const semis = 1;
  const f = estimateF0(sine(440 * Math.pow(2, semis / 12)), SR);
  const measured = semitonesBetween(f, 440);
  check("a 1-semitone detune reads as 1 semitone", Math.abs(measured - semis) < 0.01, `${measured.toFixed(4)} semitones`);
}

// ── harmonic profile: an ideal saw's harmonic k is 1/k in amplitude, 1/k² in energy ──
{
  const h = harmonicProfile(idealSaw(261.6256), SR, 261.6256, 8);
  let worst = 0;
  for (let k = 1; k <= 8; k++) {
    const expectedDb = 10 * Math.log10(1 / (k * k));
    const gotDb = 10 * Math.log10(h[k - 1]);
    worst = Math.max(worst, Math.abs(gotDb - expectedDb));
  }
  // The report calls a 1 dB harmonic gap a failure, so the instrument's own
  // error must be well inside that.
  check("harmonicProfile recovers an ideal saw's 1/k law", worst < 0.2, `worst ${worst.toFixed(3)} dB`);
}
{
  const h = harmonicProfile(sine(500), SR, 500, 4);
  check("harmonicProfile: a pure sine has no harmonics", h[0] === 1 && h[1] < 1e-6 && h[2] < 1e-6, `h2=${h[1].toExponential(2)}`);
}
// The gap metric must SEE a wrong harmonic. A saw missing its 2nd harmonic is a
// different waveform, and this is the check that the report would catch that.
{
  const good = harmonicProfile(idealSaw(261.6256), SR, 261.6256, 8);
  const bad = good.slice();
  bad[1] /= 4; // 6 dB down on the 2nd harmonic
  check("harmonicDbGap sees a 6 dB harmonic error", Math.abs(harmonicDbGap(bad, good) - 6) < 0.1, `${harmonicDbGap(bad, good).toFixed(3)} dB`);
  check("harmonicDbGap is 0 for identical profiles", harmonicDbGap(good, good) === 0);
}

// ── correlation ──
check("crossCorrelation identical = 1", Math.abs(crossCorrelation(sine(440), sine(440)) - 1) < 1e-12);
check("crossCorrelation inverted = -1", Math.abs(crossCorrelation(sine(440), sine(440, 32768, -1)) + 1) < 1e-12);
check("crossCorrelation ignores a DC offset",
  Math.abs(crossCorrelation(sine(440), sine(440).map((v) => v + 5)) - 1) < 1e-12);
// A quarter-cycle shift must NOT read as agreement.
check("crossCorrelation sees a 90-degree shift",
  Math.abs(crossCorrelation(sine(440), sine(440, 32768, 1, Math.PI / 2))) < 0.02,
  crossCorrelation(sine(440), sine(440, 32768, 1, Math.PI / 2)).toFixed(4));

// ── error metrics ──
check("maxAbsError", maxAbsError([1, 2, 3], [1, 2.5, 2]) === 1);
check("rms", Math.abs(rms(sine(440)) - Math.SQRT1_2) < 1e-3, rms(sine(440)).toFixed(6));

// ── filter analysis ──────────────────────────────────────────────────────────
// THE EXPECTATION HERE WAS WRONG THE FIRST TIME AND IT IS WORTH RECORDING WHY.
// I asserted that the impulse-invariant one-pole `y = (1-a)x + a·y` with
// `a = exp(-2π·fc/SR)` has its −3 dB point AT fc. It does not: that is the
// analog pole's frequency, and the discrete filter's true corner drifts above
// it as fc/SR grows (4094 Hz for a design fc of 4000 at 48 kHz — 2.4% out). The
// metric was right and the test was wrong, which is exactly the failure mode
// that makes a measuring instrument dangerous. So the expectation is now solved
// from the transfer function instead of assumed.
/**
 * Pure function. The exact −3 dB frequency of `H(z) = (1-a)/(1 - a·z⁻¹)`.
 *
 * |H(e^jw)|² = (1-a)² / (1 - 2a·cos w + a²), so −3 dB (half power relative to
 * DC, where |H| = 1) is where `1 - 2a·cos w + a² = 2(1-a)²`.
 *
 * @param {number} a - the pole
 * @param {number} sampleRate
 * @returns {number} hertz
 *
 * @example
 * >>> // at 48 kHz a design fc of 4000 really corners at ~4094 Hz, not 4000
 * >>> Math.round(onePoleMinus3dBHz(Math.exp(-2*Math.PI*4000/48000), 48000)) // 4094
 */
function onePoleMinus3dBHz(a, sampleRate) {
  const cosW = (1 + a * a - 2 * (1 - a) * (1 - a)) / (2 * a);
  return (Math.acos(cosW) * sampleRate) / (2 * Math.PI);
}

for (const fc of [200, 1000, 4000]) {
  const a = Math.exp(-2 * Math.PI * fc / SR);
  const expected = onePoleMinus3dBHz(a, SR);
  const ir = new Float64Array(16384);
  let y = 0;
  for (let i = 0; i < ir.length; i++) {
    y = (1 - a) * (i === 0 ? 1 : 0) + a * y;
    ir[i] = y;
  }
  const { cornerHz } = lowpassCorner(impulseResponseDb(ir, SR, 16384));
  const err = Math.abs(cornerHz - expected) / expected;
  // The report calls a 2% corner difference a failure, so the instrument must
  // be an order of magnitude better than that.
  check(`lowpassCorner on a one-pole at design fc ${fc} Hz`, err < 0.002,
    `${cornerHz.toFixed(2)} Hz vs ${expected.toFixed(2)} Hz analytic, ${(100 * err).toFixed(3)}% off`);
}
// And it must SEE a resonant peak, since that is the other half of a filter verdict.
{
  // A biquad lowpass at 1 kHz, Q = 4: peak is roughly 20·log10(Q) dB over DC.
  const fc = 1000;
  const Q = 4;
  const w = 2 * Math.PI * fc / SR;
  const alpha = Math.sin(w) / (2 * Q);
  const cw = Math.cos(w);
  const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  const ir = new Float64Array(16384);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < ir.length; i++) {
    const x = i === 0 ? 1 : 0;
    const y = (b0 / a0) * x + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    ir[i] = y;
  }
  const r = lowpassCorner(impulseResponseDb(ir, SR, 16384));
  // NOT 20·log10(Q) — that is the textbook approximation. A 2-pole lowpass's
  // true peak gain is Q/sqrt(1 - 1/(4Q²)), and using the approximation here
  // would have let a 0.07 dB instrument error hide inside a 0.5 dB tolerance.
  const expectedPeak = 20 * Math.log10(Q / Math.sqrt(1 - 1 / (4 * Q * Q)));
  check("lowpassCorner finds a Q=4 resonant peak", Math.abs(r.peakDb - expectedPeak) < 0.05,
    `${r.peakDb.toFixed(3)} dB vs ${expectedPeak.toFixed(3)} dB analytic, peak at ${r.peakHz.toFixed(0)} Hz`);
}

// ── the FFT itself ──
{
  const m = magnitudeSpectrum(sine(SR * 64 / 4096), 4096);
  let best = 1;
  for (let k = 2; k < 2048; k++) if (m[k] > m[best]) best = k;
  check("magnitudeSpectrum peaks at the right bin", best === 64, `bin ${best}`);
}

process.stdout.write(failures ? `\n${failures} metric self-test(s) FAILED — no number in the report can be trusted\n` : "\nall metric self-tests passed\n");
process.exit(failures ? 1 : 0);
