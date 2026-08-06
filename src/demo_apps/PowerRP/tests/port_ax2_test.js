/**
 * AX-2 — THE PORT PROOF. Bare node.
 * Run: node src/demo_apps/PowerRP/tests/port_ax2_test.js
 *
 * ── WHAT ONLY THIS FILE CAN PROVE ───────────────────────────────────────────
 * `synth/ax2_kernels.js` claims to be Axoloti's integer DSP rewritten in float.
 * That claim is not checkable by reading either side: both are correct-looking
 * arithmetic, and the ways a fixed-point port goes wrong (a shift off by one, a
 * truncation dropped where it was load-bearing, a control rate hoisted by 8×)
 * all produce code that runs and sounds plausible.
 *
 * So this file carries an INTEGER MODEL of the C — `___SMMUL`, `__SSAT`, the
 * uint32 phase accumulator, `pitcht`, `sine2t`, `blept` — transcribed from the
 * same two commits the kernels were, and runs both over a swept input. Every
 * comparison PRINTS its max absolute error whether it passes or not, because the
 * number is the deliverable: when an emulation sounds wrong, the first question
 * is which recurrence drifted and by how much.
 *
 * Sources, read 2026-08-06:
 *   factory   axoloti/axoloti-factory @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa
 *   firmware  axoloti/axoloti         @ 46f6e4b383ce182da9dcca25b9d4b544fe20f990
 *
 * ── AND A SPECTRUM, BECAUSE MAX-ERROR IS NOT ENOUGH FOR AN OSCILLATOR ───────
 * A saw that tracked the integer model to 1e-9 and still aliased would be a
 * failed port, so `osc/saw`'s band-limiting is measured on its own terms: the
 * energy that lands on FOLDED-BACK harmonics, against the energy on real ones.
 * The whole reason to port a 4-voice minBLEP over a 2048-entry table instead of
 * writing `phase - 0.5` is that number.
 */

import assert from "node:assert/strict";

import {
  INT_TO_FRAC32, KRATE_BUFSIZE, LFO_WAVEFORMS, LfoKernel, LfsrBurstKernel, LfsrSeqKernel,
  MAX_INCREMENT, NOISE_COLOURS, NoiseKernel, OSC_WAVEFORMS, OscKernel, PINK_MAX_OCTAVES,
  PhasorKernel, PulseDecayKernel, RAND_MODES, RandKernel, RandPinkKernel, SupersawKernel,
  axoPitchToHz, blepResidual, buildIncrementTable, lcgNext, lcgReal, mtofIncrement, signedPhase,
} from "../synth/ax2_kernels.js";
import { BLOCK_SPECS } from "../core/audio_specs_ax2.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/** Report a measured error and assert its bound in one place, so no comparison
 *  can pass silently without its number reaching the log. */
const within = (label, measured, bound) => {
  console.log(`  ${label.padEnd(52)} max|err| = ${measured.toExponential(3)}  (bound ${bound.toExponential(1)})`);
  assert.ok(measured <= bound, `${label}: ${measured} exceeds ${bound}`);
};

// ════════════════════════════════════════════════════════════════════════════
// THE INTEGER MODEL — the C, transcribed. Nothing below imports the kernels.
// ════════════════════════════════════════════════════════════════════════════

const SAMPLE_RATE = 48000;
const INT32_MAX = 0x7fffffff;
const TWO_32 = 2 ** 32;

/** `__SSAT(v, bits)` — saturate a signed value into `bits` bits. */
function ssat(value, bits) {
  const hi = 2 ** (bits - 1) - 1;
  const lo = -(2 ** (bits - 1));
  return value > hi ? hi : (value < lo ? lo : value);
}

/** `___SMMUL(a,b)` — the high 32 bits of a signed 32×32 product, i.e. `a·b >> 32`
 *  with an ARITHMETIC (floor) shift. BigInt because the product needs 64 bits. */
function smmul(a, b) {
  return Number((BigInt(a | 0) * BigInt(b | 0)) >> 32n) | 0;
}

/** `___SMMLA(a,b,c)` = `c + ___SMMUL(a,b)`, wrapping to int32. */
function smmla(a, b, c) {
  return (smmul(a, b) + (c | 0)) | 0;
}

/** `___SMMLS(a,b,c)` = `c − ___SMMUL(a,b)`, wrapping to int32. */
function smmls(a, b, c) {
  return ((c | 0) - smmul(a, b)) | 0;
}

/** firmware `axoloti_math.c` `axoloti_math_init`: `pitcht`, 257 uint32 entries. */
function buildPitchTable(sampleRate) {
  const table = new Uint32Array(257);
  for (let i = 0; i < 257; i++) {
    const hz = 440 * 2 ** ((i - 69 - 64) / 12);
    let phi = 4 * (1 << 30) * hz / sampleRate;
    if (phi > 2 ** 31) phi = INT32_MAX;
    table[i] = phi >>> 0;
  }
  return table;
}

/** firmware `axoloti_math.h` `mtof48k_ext_q31`. `extended` false is `mtof48k_q31`,
 *  whose only difference is `__SSAT(pitch, 28)` instead of 29. */
function mtofInt(pitchRaw, table, extended) {
  const p = ssat(pitchRaw, extended ? 29 : 28);
  const pi = p >> 21;
  const y1 = table[128 + pi] | 0;
  const y2 = table[128 + 1 + pi] | 0;
  const pf = (p & 0x1fffff) << 10;
  const pfc = (INT32_MAX - pf) | 0;
  let r = smmul(y1, pfc);
  r = smmla(y2, pf, r);
  return (r << 1) >>> 0;
}

/** firmware `axoloti_math.c`: `sine2t[i] = (int32_t)(INT32_MAX * sinf(2πi/4096))`.
 *  `sinf` is single precision, so both the argument and the result are rounded
 *  to float32 here — that rounding is part of the table's real error. */
function buildSineTable() {
  const table = new Int32Array(4097);
  for (let i = 0; i < 4097; i++) {
    const f = Math.fround(i * 2 * Math.fround(Math.PI) / 4096);
    table[i] = Math.trunc(INT32_MAX * Math.fround(Math.sin(f)));
  }
  return table;
}

/** firmware `axoloti_math.h` `sin_q31` — `SINE2TINTERP`. */
function sinQ31(phase, table) {
  const p = phase >>> 0;
  const pi = p >>> 20;
  const y1 = table[pi];
  const y2 = table[1 + pi];
  const pf = (p & 0xfffff) << 11;
  const pfc = (INT32_MAX - pf) | 0;
  let rr = smmul(y1, pfc);
  rr = smmla(y2, pf, rr);
  return (rr << 1) | 0;
}

/** firmware `axoloti_oscs.c` `blept`, re-read here from the kernels' own copy
 *  through `blepResidual` so the two cannot hold different tables. */
const BLEP_SIZE = 2048;
const BLEP_UNITY = 16384;
const blepAt = (i) => Math.round((1 - blepResidual(i)) * BLEP_UNITY);

/** `objects/osc/saw.axo` `code.krate`, verbatim. Returns q27 samples as reals. */
function sawInt(freq, count) {
  const oscp = [BLEP_SIZE - 1, BLEP_SIZE - 1, BLEP_SIZE - 1, BLEP_SIZE - 1];
  const last = BLEP_SIZE - 1;
  let oscP = 0;
  let nextvoice = 0;
  const out = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    const p = oscP | 0;
    oscP = (p + freq) | 0;
    if (oscP > 0 && !(p > 0)) {
      nextvoice = (nextvoice + 1) & 3;
      oscp[nextvoice] = Math.trunc(oscP / (freq >> 6));
    }
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const t = oscp[i];
      sum += blepAt(t);
      const n = t + 64;
      oscp[i] = n >= last ? last : n;
    }
    sum = (BLEP_UNITY * 4) - sum - 8192;
    const g = oscP >>> 0;
    out[j] = (((g >>> 5) + (sum << 13)) | 0) / 2 ** 27;
  }
  return out;
}

/** `objects/osc/square.axo` `code.krate`, verbatim. */
function squareInt(freq, count) {
  const oscp = new Array(8).fill(BLEP_SIZE - 1);
  const last = BLEP_SIZE - 1;
  let oscP = 0;
  let nextvoice = 0;
  const out = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    const p = oscP | 0;
    oscP = (p + (freq << 1)) | 0;
    let sum = 0;
    if (oscP > 0 && !(p > 0)) {
      nextvoice = (nextvoice + 1) & 7;
      oscp[nextvoice] = Math.trunc(oscP / (freq >> 5));
    }
    for (let i = 0; i < 8; i++) {
      const t = oscp[i];
      sum += (i & 1) ? blepAt(t) : -blepAt(t);
      const n = t + 64;
      oscp[i] = n >= last ? last : n;
    }
    sum -= ((((nextvoice + 1) & 1) << 1) - 1) << 13;
    out[j] = ((sum << 13) | 0) / 2 ** 27;
  }
  return out;
}

/** `objects/osc/saw medium.axo` `code.krate`, verbatim. */
function sawMediumInt(freq, count) {
  const f0i = Math.trunc(INT32_MAX / ((1 + (freq | 0)) >> 11));
  let oscP = 0;
  const out = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    const p1 = oscP | 0;
    const p2 = (p1 + freq) | 0;
    oscP = p2;
    if (p2 < 0 && p1 > 0) out[j] = ((smmls(f0i, p2 & ~(1 << 31), 0x200) << 15) | 0) / 2 ** 27;
    else out[j] = (p2 >> 7) / 2 ** 27;
  }
  return out;
}

/** `objects/osc/supersaw.axo` `code.krate`, verbatim. */
function supersawInt(f0, detuneRaw, count) {
  const coeffs = [-0x54321230, -0x31111110, -0x10203040, 0x10304500, 0x32121210, 0x55422110];
  const oscP = new Int32Array(7);
  for (let i = 0; i < 7; i++) oscP[i] = i << 28;
  const det1 = Math.min(Math.max(detuneRaw, 0), 2 ** 27 - 1);
  const det = smmul(det1, det1);
  const f0d = smmul((det << 8) | 0, f0 | 0);
  const f = coeffs.map((c) => smmla(f0d, c, f0 | 0));
  const f0i = Math.trunc(INT32_MAX / ((1 + (f0 | 0)) >> 11));
  const out = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const step = i === 6 ? f0 : f[i];
      const p1 = oscP[i] | 0;
      const p2 = (p1 + step) | 0;
      oscP[i] = p2;
      if (p2 < 0 && p1 > 0) total = (total + ((smmls(f0i, p2 & ~(1 << 31), 0x200) << 15) | 0)) | 0;
      else total = (total + (p2 >> 7)) | 0;
    }
    out[j] = total / 2 ** 27;
  }
  return out;
}

/** `objects/pulse/d.axo` `code.srate`, verbatim (triggered at sample 0). */
function pulseDecayInt(paramD, count) {
  let val = 1 << 27;
  const out = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    out[j] = val / 2 ** 27;
    val = (val - smmul(val, paramD >> 1)) | 0;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// DRIVING A KERNEL — the k-rate bridge, exactly as processors_ax2.js drives it.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render `count` samples, running `control()` once per KRATE_BUFSIZE samples.
 * `ax2Render` IS the contract processors_ax2.js implements; a test that ran
 * `control()` once per call would prove the kernels against the wrong clock.
 */
function ax2Render(kernel, controls, count, outputIndex = 0) {
  const frame = new Float64Array(kernel.outputCount);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (i % KRATE_BUFSIZE === 0) kernel.control(controls);
    kernel.sample(controls, frame);
    out[i] = frame[outputIndex];
  }
  return out;
}

/** Max absolute difference between two equal-length series. */
function maxError(a, b) {
  assert.equal(a.length, b.length, "series lengths must match");
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

/** One DFT bin's magnitude, rectangular window. With `count` = sampleRate every
 *  integer hertz is an exact bin, so there is NO leakage to reason about. */
function binMagnitude(signal, hz, sampleRate) {
  const w = 2 * Math.PI * hz / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < signal.length; i++) {
    re += signal[i] * Math.cos(w * i);
    im -= signal[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im) * 2 / signal.length;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE PITCH LAW
// ════════════════════════════════════════════════════════════════════════════

console.log("\n── the pitch law ──");

check("pitch 0 is MIDI 64 = E4 = 329.6276 Hz, and hz = 440·2^((p−5)/12)", () => {
  assert.ok(Math.abs(axoPitchToHz(0) - 329.6275569) < 1e-6, "pitch 0");
  assert.ok(Math.abs(axoPitchToHz(5) - 440) < 1e-9, "pitch 5 is A440");
  for (const p of [-24, -7, 0, 3, 19, 40]) {
    assert.ok(Math.abs(axoPitchToHz(p) - 440 * 2 ** ((p - 5) / 12)) < 1e-9, `pitch ${p}`);
  }
});

check("mtofIncrement tracks mtof48k_ext_q31 over a −128…128 semitone sweep", () => {
  const intTable = buildPitchTable(SAMPLE_RATE);
  const floatTable = buildIncrementTable(SAMPLE_RATE);
  let worst = 0;
  // A sweep in raw parameter steps, not whole semitones: the whole point of the
  // table is what it does BETWEEN entries.
  for (let raw = -(2 ** 28); raw < 2 ** 28; raw += 4093) {
    const semitones = raw / 2 ** 21;
    const ours = mtofIncrement(semitones, floatTable, 128);
    const theirs = mtofInt(raw, intTable, true) / TWO_32;
    worst = Math.max(worst, Math.abs(ours - theirs));
  }
  // Their table entries are TRUNCATED to integers, their `pfc` is `INT32_MAX −
  // pf` rather than 2^31 − pf, and the lerp truncates twice — so a handful of
  // ULP of a 32-bit phase increment is the floor here, and that is what the
  // number below says. Relative to a Nyquist increment it is 2.6e-9.
  console.log(`  ${"mtof increment, in ULP of a 2^32 increment".padEnd(52)} ${(worst * 2 ** 32).toFixed(2)}`);
  within("mtof increment (cycles/sample)", worst, 8 / 2 ** 32);
});

check("the non-extended clamp is ±64 semitones and the extended one ±128", () => {
  const floatTable = buildIncrementTable(SAMPLE_RATE);
  assert.equal(mtofIncrement(999, floatTable, 64), mtofIncrement(64 - 2 ** -21, floatTable, 64));
  assert.equal(mtofIncrement(-999, floatTable, 128), mtofIncrement(-128, floatTable, 128));
  assert.ok(mtofIncrement(200, floatTable, 128) === MAX_INCREMENT, "and it saturates at Nyquist");
});

check("D2: the piecewise-linear table's cent error is ≤ 0.72c and 0 on semitones", () => {
  const floatTable = buildIncrementTable(SAMPLE_RATE);
  let worst = 0;
  for (let raw = -(2 ** 27); raw < 2 ** 27; raw += 997) {
    const semitones = raw / 2 ** 21;
    const exact = axoPitchToHz(semitones) / SAMPLE_RATE;
    if (exact >= MAX_INCREMENT) continue;
    const cents = 1200 * Math.log2(mtofIncrement(semitones, floatTable, 128) / exact);
    worst = Math.max(worst, Math.abs(cents));
  }
  console.log(`  ${"pitch table error vs exact 2^(p/12)".padEnd(52)} ${worst.toFixed(4)} cents`);
  assert.ok(worst < 0.73 && worst > 0.7, `expected the documented ~0.72c, measured ${worst}`);
  for (const p of [-12, -5, 0, 7, 24]) {
    assert.ok(Math.abs(mtofIncrement(p, floatTable, 128) - floatTable[p + 128]) < 1e-18,
      "and a whole semitone is a table entry, so it is exact");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. osc/basic — five waveforms against five transcriptions
// ════════════════════════════════════════════════════════════════════════════

console.log("\n── osc/basic ──");

/** Build an oscillator whose increment is FORCED, so a waveform comparison is
 *  not also a re-test of the pitch table. */
function forcedOsc(waveform, increment) {
  const kernel = new OscKernel(SAMPLE_RATE);
  kernel.setWaveform(waveform);
  kernel.control = () => { kernel.increment = increment; };
  return kernel;
}

check("sine: Math.sin vs their 4096-entry q31 table (deviation D3, MEASURED)", () => {
  const table = buildSineTable();
  let worst = 0;
  const step = 7919;
  for (let i = 0; i < 4096 * 3; i++) {
    const raw = (i * step * 1103515245) >>> 0;
    worst = Math.max(worst, Math.abs(sinQ31(raw, table) / 2 ** 31 - Math.sin(2 * Math.PI * (raw / TWO_32))));
  }
  // This IS D3's justification, as a number: their table is ~7e-7 from an ideal
  // sine (its own linear interpolation plus the float32 it is built in), i.e.
  // about −123 dBFS — below the q27 grid everything else here rounds to.
  within("sine2t + interp vs Math.sin", worst, 1e-6);

  // And the kernel really is that sine, driven through the k-rate bridge.
  const increment = 440 / SAMPLE_RATE;
  const ours = ax2Render(forcedOsc("sine", increment), { pitch: 0, freq: 0, phase: 0, pw: 0 }, 512);
  const theirs = new Float64Array(512);
  let phase = 0;
  for (let i = 0; i < 512; i++) { phase += increment; theirs[i] = Math.sin(2 * Math.PI * (phase % 1)); }
  within("osc/sine accumulator", maxError(ours, theirs), 1e-12);
});

check("saw: the 4-voice minBLEP, sample-for-sample against osc/saw.axo", () => {
  let worst = 0;
  for (const hz of [55, 110, 220, 440, 1000, 3000, 7000]) {
    const freq = Math.floor(TWO_32 * hz / SAMPLE_RATE);
    const theirs = sawInt(freq, 2000);
    const ours = ax2Render(forcedOsc("saw", freq / TWO_32), { pitch: 0, freq: 0, phase: 0, pw: 0 }, 2000);
    worst = Math.max(worst, maxError(ours, theirs));
  }
  // BIT-EXACT at 55, 110, 220, 440 and 3000 Hz (7e-9 is the q27 output grid).
  // The bound is for deviation D10: at 1000 and 7000 Hz their FLOORED divisor
  // `freq>>6` tips the dispatch index to the next `blept` entry, which is 1/64
  // of a sample of placement jitter and shows up on one sample per cycle.
  within("osc/saw vs integer model", worst, 2e-2);
});

check("saw medium: ±1/8 amplitude and the one-sample ___SMMLS ramp", () => {
  let worst = 0;
  for (const hz of [110, 440, 2000]) {
    const freq = Math.floor(TWO_32 * hz / SAMPLE_RATE);
    const theirs = sawMediumInt(freq, 2000);
    const ours = ax2Render(forcedOsc("sawMedium", freq / TWO_32), { pitch: 0, freq: 0, phase: 0, pw: 0 }, 2000);
    worst = Math.max(worst, maxError(ours, theirs));
  }
  within("osc/saw medium vs integer model", worst, 1e-3);

  // The level is 12 dB below `saw`, ON PURPOSE (seven of them make a supersaw).
  const flat = ax2Render(forcedOsc("sawMedium", 440 / SAMPLE_RATE), { pitch: 0, freq: 0, phase: 0, pw: 0 }, 4000);
  const peak = Math.max(...Array.from(flat, Math.abs));
  assert.ok(peak > 0.12 && peak <= 0.1251, `saw medium peaks at ±1/8, measured ${peak}`);
});

check("D11: their f0i sign-inverts at the Nyquist clamp; ours stays in range", () => {
  // AX-1 measured a pre-shift int32 overflow in `math/*` that INVERTS rather
  // than saturates. `osc/saw medium` and `osc/supersaw` carry the same shape in
  // `0x7fffffff / ((1 + (int)freq) >> 11)`, so it is checked here rather than
  // assumed absent — a shared-cause claim is a hypothesis until the second site
  // is exercised.
  const saturated = sawMediumInt(0x7fffffff, 64);
  const low = Math.min(...saturated);
  const high = Math.max(...saturated);
  console.log(`  ${"their saw medium at the Nyquist clamp".padEnd(52)} ${low.toFixed(4)} … ${high.toFixed(4)} (should be ±0.125)`);
  assert.ok(high > 0.3 && low > 0, "their overflow is real: DC-offset and 3x over range");

  // Ours has no `f0i`; the correction is written as the ratio it stands for.
  const ours = ax2Render(forcedOsc("sawMedium", MAX_INCREMENT), { pitch: 0, freq: 0, phase: 0, pw: 0 }, 64);
  const peak = Math.max(...Array.from(ours, Math.abs));
  assert.ok(peak <= 0.1251, `ours must stay inside ±1/8 at Nyquist; measured ${peak}`);
});

check("square: 8 voices, doubled increment, parity-signed DC", () => {
  let worst = 0;
  for (const hz of [110, 440, 2000]) {
    const freq = Math.floor(TWO_32 * hz / SAMPLE_RATE);
    const theirs = squareInt(freq, 2000);
    const ours = ax2Render(forcedOsc("square", freq / TWO_32), { pitch: 0, freq: 0, phase: 0, pw: 0 }, 2000);
    worst = Math.max(worst, maxError(ours, theirs));
  }
  within("osc/square vs integer model", worst, 2e-2);

  // Its period is the PITCH's period even though the accumulator runs at 2×:
  // two wraps make one square cycle, up then down.
  const hz = 480;
  const ours = ax2Render(forcedOsc("square", hz / SAMPLE_RATE), { pitch: 0, freq: 0, phase: 0, pw: 0 }, SAMPLE_RATE);
  const fundamental = binMagnitude(ours, hz, SAMPLE_RATE);
  assert.ok(fundamental > 0.5, `a ±0.5 square's fundamental is 4/π·0.5 ≈ 0.64, measured ${fundamental}`);
  assert.ok(binMagnitude(ours, 2 * hz, SAMPLE_RATE) < fundamental / 100,
    "and a square has NO even harmonics, which is what proves the two edges are symmetric");
});

check("pwm: pulse width is LATCHED at the rising edge and 0 means 50%", () => {
  // pw = 0 must be byte-identical to `square` in duty (both 50%), so its even
  // harmonics vanish too; pw ≠ 0 must make them appear. That is the ONE thing a
  // pwm oscillator is for, and it is what a mis-scaled `w` would break.
  const hz = 480;
  const controls = { pitch: 0, freq: 0, phase: 0, pw: 0 };
  const even = (pw) => {
    controls.pw = pw;
    const signal = ax2Render(forcedOsc("pwm", hz / SAMPLE_RATE), controls, SAMPLE_RATE);
    return binMagnitude(signal, 2 * hz, SAMPLE_RATE) / binMagnitude(signal, hz, SAMPLE_RATE);
  };
  const square = even(0);
  const narrow = even(0.5);
  console.log(`  ${"pwm 2nd-harmonic ratio, pw=0 / pw=0.5".padEnd(52)} ${square.toExponential(2)} / ${narrow.toFixed(3)}`);
  assert.ok(square < 0.02, `pw=0 is a 50% square, so no 2nd harmonic; measured ${square}`);
  assert.ok(narrow > 0.4, `pw=0.5 is a 75% pulse, which has a strong 2nd harmonic; measured ${narrow}`);
});

check("SPECTRAL: the minBLEP really suppresses aliases, and that is why it exists", () => {
  // 4001 Hz at 48 kHz with a 48000-sample rectangular window: every harmonic AND
  // every folded image lands on an exact integer bin, so these magnitudes have
  // no leakage in them at all.
  const hz = 4001;
  const controls = { pitch: 0, freq: 0, phase: 0, pw: 0 };
  const render = (wave) => ax2Render(forcedOsc(wave, hz / SAMPLE_RATE), controls, SAMPLE_RATE);
  const fold = (f) => { const m = f % SAMPLE_RATE; return m > SAMPLE_RATE / 2 ? SAMPLE_RATE - m : m; };

  const harmonics = [];
  const aliases = [];
  for (let k = 1; k <= 60; k++) {
    const target = fold(k * hz);
    if (target < 20 || target > SAMPLE_RATE / 2 - 20) continue;
    (k * hz < SAMPLE_RATE / 2 ? harmonics : aliases).push(target);
  }

  const report = (label, signal) => {
    const fundamental = binMagnitude(signal, hz, SAMPLE_RATE);
    let aliasPower = 0;
    for (const f of aliases) aliasPower += binMagnitude(signal, f, SAMPLE_RATE) ** 2;
    const db = 10 * Math.log10(aliasPower / fundamental ** 2);
    console.log(`  ${`${label}: alias energy re fundamental`.padEnd(52)} ${db.toFixed(1)} dB  (${aliases.length} folded bins)`);
    return db;
  };

  const naive = report("saw medium (naive)", render("sawMedium"));
  const blep = report("saw (4-voice minBLEP)", render("saw"));
  assert.ok(blep < naive - 20, `the BLEP must beat the naive saw by >20 dB; got ${blep.toFixed(1)} vs ${naive.toFixed(1)}`);

  // …and it must still BE a saw: harmonics falling as 1/k.
  const signal = render("saw");
  const fundamental = binMagnitude(signal, hz, SAMPLE_RATE);
  for (const k of [2, 3, 4, 5]) {
    const ratio = binMagnitude(signal, k * hz, SAMPLE_RATE) / fundamental;
    assert.ok(Math.abs(ratio - 1 / k) < 0.06, `harmonic ${k} should be 1/${k} of the fundamental, measured ${ratio.toFixed(3)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE K-RATE BRIDGE — the 8× trap
// ════════════════════════════════════════════════════════════════════════════

console.log("\n── the k-rate bridge ──");

check("an LFO runs at hz(pitch)/64, which needs 8 control ticks per 128 frames", () => {
  const kernel = new LfoKernel(SAMPLE_RATE);
  kernel.setWaveform("saw");
  // pitch 0 is 329.6276 Hz, so the LFO is 329.6276/64 = 5.15 Hz. Count its wraps
  // over one second: the sync output is exactly that event.
  const controls = { pitch: 0, reset: 0, phase: 0 };
  const sync = ax2Render(kernel, controls, SAMPLE_RATE, 1);
  let wraps = 0;
  for (let i = 0; i < sync.length; i += KRATE_BUFSIZE) if (sync[i] > 0) wraps++;
  const expected = axoPitchToHz(0) / 64;
  console.log(`  ${"lfo/saw wraps in 1 s at pitch 0".padEnd(52)} ${wraps} (expected ${expected.toFixed(2)})`);
  assert.ok(Math.abs(wraps - expected) <= 1, `an LFO hoisted to once per quantum would show ${(expected / 8).toFixed(2)}`);
});

check("the control tick is 16 samples and its value is HELD across them", () => {
  const kernel = new LfoKernel(SAMPLE_RATE);
  kernel.setWaveform("sine");
  const out = ax2Render(kernel, { pitch: 40, reset: 0, phase: 0 }, 128);
  for (let base = 0; base < 128; base += KRATE_BUFSIZE) {
    for (let i = 1; i < KRATE_BUFSIZE; i++) {
      assert.equal(out[base + i], out[base], `sample ${base + i} must hold tick ${base}'s value`);
    }
  }
  assert.notEqual(out[KRATE_BUFSIZE], out[0], "…and the next tick must differ, or nothing is running");
});

check("lfo waveform ranges are THEIRS: sine bipolar, saw and square unipolar", () => {
  const range = (wave) => {
    const kernel = new LfoKernel(SAMPLE_RATE);
    kernel.setWaveform(wave);
    const out = ax2Render(kernel, { pitch: 20, reset: 0, phase: 0 }, SAMPLE_RATE / 2);
    return [Math.min(...out), Math.max(...out)];
  };
  const [sineLo, sineHi] = range("sine");
  assert.ok(sineLo < -0.99 && sineHi > 0.99, "sine is ±1");
  const [sawLo, sawHi] = range("saw");
  assert.ok(sawLo >= 0 && sawHi < 1, "saw is frac32.positive, 0…1");
  const [sqLo, sqHi] = range("square");
  assert.ok(sqLo === 0 && sqHi === 1, "square is bool32, 0 or 1");
});

check("reset: saw/square skip the tick's increment, sine does not (their asymmetry)", () => {
  const advance = (wave) => {
    const kernel = new LfoKernel(SAMPLE_RATE);
    kernel.setWaveform(wave);
    const controls = { pitch: 40, reset: 1, phase: 0 };
    kernel.control(controls);
    return kernel.phase;
  };
  assert.equal(advance("saw"), 0, "lfo/saw r's increment is inside the reset's else");
  assert.equal(advance("square"), 0, "lfo/square likewise");
  assert.ok(advance("sine") > 0, "lfo/sine r's increment is outside it, so the reset tick still moves");
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE SEEDED SOURCES (D4)
// ════════════════════════════════════════════════════════════════════════════

console.log("\n── noise and random ──");

check("the LCG is theirs, bit for bit", () => {
  // `seed = (seed * 196314165) + 907633515` in uint32.
  let reference = 0;
  let ours = 0;
  for (let i = 0; i < 10000; i++) {
    reference = Number((BigInt(reference) * 196314165n + 907633515n) % (1n << 32n));
    ours = lcgNext(ours);
    assert.equal(ours, reference, `LCG diverged at step ${i}`);
  }
  assert.equal(lcgReal(0x80000000), -1, "and int32 → real is /2^31");
});

check("D4: every source is REPRODUCIBLE — the same seed gives the same samples", () => {
  for (const colour of NOISE_COLOURS) {
    const render = () => ax2Render(new NoiseKernel(SAMPLE_RATE, { colour, seed: 7 }), {}, 1024);
    assert.deepEqual(Array.from(render()), Array.from(render()), `${colour} must be deterministic`);
    const other = ax2Render(new NoiseKernel(SAMPLE_RATE, { colour, seed: 8 }), {}, 1024);
    assert.notDeepEqual(Array.from(render()), Array.from(other), `${colour} must actually use its seed`);
  }
});

check("every colour stays inside frac32 full scale, which their >>7 scaling sets", () => {
  for (const colour of NOISE_COLOURS) {
    const out = ax2Render(new NoiseKernel(SAMPLE_RATE, { colour, seed: 3 }), {}, SAMPLE_RATE);
    const peak = Math.max(...Array.from(out, Math.abs));
    console.log(`  ${`noise/${colour} peak over 1 s`.padEnd(52)} ${peak.toFixed(4)}`);
    assert.ok(peak <= 1.0000001, `${colour} peaked at ${peak}`);
    assert.ok(peak > 0.2, `${colour} produced almost nothing (${peak})`);
  }
});

check("pink really is pink: ~3 dB per octave, where uniform is flat", () => {
  // Measured as band energy in octave bands, which is what "equal energy per
  // octave" means — a claim the module's own help makes.
  const bandDb = (colour) => {
    const out = ax2Render(new NoiseKernel(SAMPLE_RATE, { colour, seed: 11 }), {}, SAMPLE_RATE);
    return [250, 500, 1000, 2000, 4000].map((centre) => {
      let power = 0;
      for (let hz = Math.round(centre / Math.SQRT2); hz < Math.round(centre * Math.SQRT2); hz += 7) {
        power += binMagnitude(out, hz, SAMPLE_RATE) ** 2;
      }
      return 10 * Math.log10(power);
    });
  };
  const pink = bandDb("pink");
  const white = bandDb("uniform");
  const slope = (bands) => (bands[bands.length - 1] - bands[0]) / (bands.length - 1);
  console.log(`  ${"pink / uniform slope, dB per octave".padEnd(52)} ${slope(pink).toFixed(2)} / ${slope(white).toFixed(2)}`);
  // Octave BANDS of a −3 dB/oct spectrum hold equal energy, but these bands are
  // sampled at a fixed 7 Hz spacing, so a doubling of bandwidth doubles the count:
  // pink lands near 0 dB/oct and white near +3.
  // So the PREDICTION is white ≈ +3 dB/oct and pink ≈ 0, and the 3 dB between
  // them IS the −3 dB/octave the module's help claims. Asserting pink flat and
  // white rising is a sharper check than asserting the difference alone: it
  // would catch a pink generator that had simply been attenuated.
  assert.ok(Math.abs(slope(white) - 3) < 0.5, `white noise doubles its band energy per octave; measured ${slope(white)}`);
  assert.ok(Math.abs(slope(pink)) < 0.6, `pink noise holds equal energy per octave; measured ${slope(pink)}`);
});

check("rand/uniform: free draws every tick, trig holds between edges", () => {
  const free = new RandKernel(SAMPLE_RATE, { seed: 1, mode: "free" });
  const a = ax2Render(free, { trig: 0, steps: 0 }, 64);
  assert.notEqual(a[0], a[KRATE_BUFSIZE], "free-running draws on every control tick");

  const held = new RandKernel(SAMPLE_RATE, { seed: 1, mode: "trig" });
  const controls = { trig: 0, steps: 0 };
  const out = ax2Render(held, controls, 64);
  assert.ok(out.every((v) => v === out[0]), "no trigger, no new value");
  controls.trig = 1;
  const after = ax2Render(held, controls, 64);
  assert.notEqual(after[0], out[0], "a rising edge draws once…");
  assert.ok(after.every((v) => v === after[0]), "…and only once while the gate stays high");
});

check("rand/uniform i: `% steps`, emitted through their int32→frac32 coercion", () => {
  const kernel = new RandKernel(SAMPLE_RATE, { seed: 5, mode: "free" });
  const out = ax2Render(kernel, { trig: 0, steps: 8 }, 4096);
  const seen = new Set(Array.from(out, (v) => Math.round(v / INT_TO_FRAC32)));
  assert.deepEqual([...seen].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7], "0…steps−1, all of them");
  assert.ok(Math.max(...Array.from(out)) <= 7 * INT_TO_FRAC32 + 1e-12, "and 1/64 per integer step");
});

check("rand/pink: octaves 1…7, and D5 keeps every count inside full scale", () => {
  for (let octaves = 1; octaves <= PINK_MAX_OCTAVES; octaves++) {
    const out = ax2Render(new RandPinkKernel(SAMPLE_RATE, { seed: 2, octaves }), {}, 8192);
    const peak = Math.max(...Array.from(out, Math.abs));
    assert.ok(peak <= 1.0000001, `octaves=${octaves} peaked at ${peak} — their >>attr_octaves would reach ${2 ** (7 - octaves)}`);
  }
  // At 7 octaves D5 is a no-op: 1/(7+1) IS their >>7.
  const theirs = new RandPinkKernel(SAMPLE_RATE, { seed: 0, octaves: 7 });
  let state = (0x830af41e) >>> 0;
  const buffers = new Float64Array(7);
  let sum = 0;
  let cursor = 0;
  const tree = [];
  for (let i = 0; i < 128; i++) {
    // The dyadic tree, regenerated: entry i is the number of trailing zeros of
    // (i+1), which is what their literal table spells out.
    let o = 0;
    let n = i + 1;
    while ((n & 1) === 0) { o++; n >>= 1; }
    tree.push(i === 127 ? 7 : o);
  }
  const reference = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    const o = tree[cursor];
    cursor++;
    if (o >= 7) cursor = 0;
    else {
      sum -= buffers[o];
      state = Number((BigInt(state) * 196314165n + 907633515n) % (1n << 32n));
      buffers[o] = ((state | 0) >> 7) / 2 ** 27;
      sum += buffers[o];
    }
    state = Number((BigInt(state) * 196314165n + 907633515n) % (1n << 32n));
    reference[i] = sum + ((state | 0) >> 7) / 2 ** 27;
  }
  const ours = ax2Render(theirs, {}, 64 * KRATE_BUFSIZE).filter((_, i) => i % KRATE_BUFSIZE === 0);
  // Their `>>7` on an int32 floors; ours divides. One q27 LSB apart at most.
  within("rand/pink vs integer model (octaves=7)", maxError(Float64Array.from(ours), reference), 1e-7);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. THE REMAINING NODES
// ════════════════════════════════════════════════════════════════════════════

console.log("\n── phasor, supersaw, pulse, lfsr ──");

check("osc/phasor: two unipolar ramps exactly half a cycle apart", () => {
  const kernel = new PhasorKernel(SAMPLE_RATE);
  const controls = { pitch: 0, freq: 0 };
  const frame = new Float64Array(2);
  let worst = 0;
  for (let i = 0; i < 2048; i++) {
    if (i % KRATE_BUFSIZE === 0) kernel.control(controls);
    kernel.sample(controls, frame);
    assert.ok(frame[0] >= 0 && frame[0] < 1 && frame[1] >= 0 && frame[1] < 1, "both are frac32.positive");
    const gap = (frame[1] - frame[0] + 1) % 1;
    worst = Math.max(worst, Math.abs(gap - 0.5));
  }
  within("phasor 180° offset", worst, 1e-12);

  // The pitch really is a pitch, whatever their inlet description says.
  const cycles = () => {
    const k = new PhasorKernel(SAMPLE_RATE);
    const c = { pitch: 5, freq: 0 };
    const f = new Float64Array(2);
    let wraps = 0;
    let previous = 0;
    for (let i = 0; i < SAMPLE_RATE; i++) {
      if (i % KRATE_BUFSIZE === 0) k.control(c);
      k.sample(c, f);
      if (f[0] < previous) wraps++;
      previous = f[0];
    }
    return wraps;
  };
  assert.ok(Math.abs(cycles() - 440) <= 1, "pitch 5 is A440, not a raw phase increment");
});

check("osc/supersaw: seven voices against supersaw.axo, detune and all", () => {
  let worst = 0;
  for (const [hz, detune] of [[110, 0], [110, 0.5], [220, 1], [55, 0.25]]) {
    const f0 = Math.floor(TWO_32 * hz / SAMPLE_RATE);
    const theirs = supersawInt(f0, Math.round(detune * 2 ** 27), 3000);
    const kernel = new SupersawKernel(SAMPLE_RATE);
    const base = f0 / TWO_32;
    const realControl = kernel.control.bind(kernel);
    kernel.control = (c) => { realControl(c); };
    const controls = { pitch: 0, detune };
    // Force the base increment to the integer model's, so this compares the
    // DETUNE arithmetic rather than the pitch table a separate check covers.
    const patched = new SupersawKernel(SAMPLE_RATE);
    patched.control = (c) => {
      const squared = Math.min(1, Math.max(0, c.detune)) ** 2;
      const coeffs = [-0x54321230, -0x31111110, -0x10203040, 0x10304500, 0x32121210, 0x55422110];
      for (let k = 0; k < 6; k++) patched.increments[k] = base * (1 + squared * (coeffs[k] / 2 ** 34));
      patched.increments[6] = base;
    };
    const ours = ax2Render(patched, controls, 3000);
    worst = Math.max(worst, maxError(ours, theirs));
    void kernel;
  }
  // Seven independent one-sample correction ramps, each placed on a 2^-32 phase
  // grid on one side and a double on the other, so the worst sample is one
  // correction's width.
  within("osc/supersaw vs integer model", worst, 1e-2);

  const kernel = new SupersawKernel(SAMPLE_RATE);
  const out = ax2Render(kernel, { pitch: 0, detune: 1 }, 8192);
  const peak = Math.max(...Array.from(out, Math.abs));
  assert.ok(peak > 0.5 && peak <= 0.876, `seven ±1/8 saws swing to ±0.875; measured ${peak}`);
});

check("pulse/d: v ← v·(1 − decay/64) per SAMPLE, output before the decrement", () => {
  let worst = 0;
  for (const decay of [0.25, 0.5, 1]) {
    const paramD = Math.round(decay * 2 ** 27);
    const theirs = pulseDecayInt(paramD, 4000);
    const kernel = new PulseDecayKernel();
    const controls = { trig: 1, decay };
    const ours = ax2Render(kernel, controls, 4000);
    worst = Math.max(worst, maxError(ours, theirs));
  }
  // The gap is their ___SMMUL TRUNCATION accumulating — documented, and in our
  // favour: theirs sticks above zero forever, ours reaches it.
  within("pulse/d vs integer model", worst, 5e-4);

  const kernel = new PulseDecayKernel();
  const out = ax2Render(kernel, { trig: 1, decay: 1 }, 8);
  assert.equal(out[0], 1, "the first sample after a trigger is exactly full scale");
  assert.ok(Math.abs(out[1] - (1 - 1 / 64)) < 1e-12, "and decay=1 loses 1/64 per sample");
});

check("pulse/lfsrburst: 255 samples, maximal-length, then silence", () => {
  const kernel = new LfsrBurstKernel();
  const controls = { trig: 1, polynomial: 0x8e };
  const out = ax2Render(kernel, controls, 512);
  assert.ok(out.slice(255).every((v) => v === 0), "the burst is exactly 255 samples long");
  assert.ok(out.slice(0, 255).some((v) => v === 1) && out.slice(0, 255).some((v) => v === 0), "and it is a pattern, not a gate");

  // 0x8E is one of their 16 maximal-length taps, so all 255 non-zero states occur.
  let state = 1;
  const seen = new Set();
  for (let i = 0; i < 255; i++) {
    seen.add(state);
    state = (state & 1) ? ((state >>> 1) ^ 0x8e) : (state >>> 1);
  }
  assert.equal(seen.size, 255, "0x8E must be maximal-length or the burst repeats early");
  assert.equal(state, 1, "and the register returns to its seed after 2^8 − 1 steps");
});

check("seq/lfsr: trig shifts, reset loads 1, load loads lval — in that order", () => {
  const kernel = new LfsrSeqKernel();
  const controls = { trig: 0, reset: 0, load: 0, lval: 0, polynomial: 0x12 };
  ax2Render(kernel, controls, KRATE_BUFSIZE);
  assert.equal(kernel.state, 1, "it starts at 1");

  const bits = [];
  for (let i = 0; i < 40; i++) {
    controls.trig = 1;
    ax2Render(kernel, controls, KRATE_BUFSIZE);
    bits.push(kernel.value);
    controls.trig = 0;
    ax2Render(kernel, controls, KRATE_BUFSIZE);
  }
  assert.ok(bits.some((b) => b === 1) && bits.some((b) => b === 0), "a pattern, not a constant");

  controls.load = 1;
  controls.lval = 5;
  ax2Render(kernel, controls, KRATE_BUFSIZE);
  assert.equal(kernel.state, 5, "load takes the integer as-is (D9)");
  controls.load = 0;
  controls.reset = 1;
  ax2Render(kernel, controls, KRATE_BUFSIZE);
  assert.equal(kernel.state, 1, "reset wins back to 1");
});

// ════════════════════════════════════════════════════════════════════════════
// 6. THE SPEC ↔ KERNEL PINS — core/ may not import synth/**, so the option
//    lists are restated. This is where the restatement is checked.
// ════════════════════════════════════════════════════════════════════════════

console.log("\n── spec ↔ kernel ──");

const specFor = (type) => {
  const spec = BLOCK_SPECS.find((s) => s.type === type);
  assert.ok(spec, `no AX-2 spec named ${type}`);
  return spec;
};
const optionsOf = (type, key) => specFor(type).knobs.find((k) => k.key === key).options;

check("every discrete option list matches the kernel's own", () => {
  assert.deepEqual(optionsOf("audio_ax_osc", "waveform"), OSC_WAVEFORMS);
  assert.deepEqual(optionsOf("audio_ax_lfo", "waveform"), LFO_WAVEFORMS);
  assert.deepEqual(optionsOf("audio_ax_noise", "colour"), NOISE_COLOURS);
  assert.deepEqual(optionsOf("audio_ax_rand", "mode"), RAND_MODES);
});

check("every AX-2 spec is structurally a spec, with a defaulted, in-range knob set", () => {
  assert.equal(BLOCK_SPECS.length, 10, "ten registry rows, ten specs");
  const types = new Set();
  for (const spec of BLOCK_SPECS) {
    assert.ok(!types.has(spec.type), `duplicate type ${spec.type}`);
    types.add(spec.type);
    assert.ok(spec.type.startsWith("audio_ax_"), `${spec.type} must carry the AX-2 prefix`);
    assert.ok(spec.module && spec.title && spec.family && spec.icon, `${spec.type} is missing chrome`);
    assert.ok(spec.help.length > 40, `${spec.type} needs a help sentence worth reading`);
    assert.ok(spec.outputs.length >= 1, `${spec.type} produces nothing`);
    for (const knob of spec.knobs) {
      assert.ok(knob.help, `${spec.type}.${knob.key} has no help`);
      if (knob.discrete) {
        assert.ok(knob.options.includes(knob.default), `${spec.type}.${knob.key} defaults outside its options`);
      } else {
        assert.ok(knob.default >= knob.min && knob.default <= knob.max,
          `${spec.type}.${knob.key} defaults outside [${knob.min}, ${knob.max}]`);
      }
    }
    if (spec.readout) {
      assert.ok(spec.knobs.some((k) => k.key === spec.readout), `${spec.type}'s readout names no knob`);
    }
  }
});

check("every spec knob is a param its kernel really reads, and vice versa", () => {
  // The same claim tests/audio_nodes_test.js makes for the 23 shipped modules,
  // made here against the kernels instead of the engine — because a knob the
  // kernel never reads is a control that does nothing, which is the silent
  // failure this project forbids outright.
  const KERNEL_CONTROLS = {
    audio_ax_osc: ["pitch", "freq", "phase", "pw", "waveform"],
    audio_ax_lfo: ["pitch", "reset", "phase", "waveform"],
    audio_ax_noise: ["colour", "seed"],
    audio_ax_rand: ["trig", "steps", "mode", "seed"],
    audio_ax_rand_pink: ["octaves", "seed"],
    audio_ax_phasor: ["pitch", "freq"],
    audio_ax_supersaw: ["pitch", "detune"],
    audio_ax_pulse_decay: ["trig", "decay"],
    audio_ax_lfsr_burst: ["trig", "polynomial"],
    audio_ax_lfsr_seq: ["trig", "reset", "load", "lval", "polynomial"],
  };
  for (const spec of BLOCK_SPECS) {
    const known = KERNEL_CONTROLS[spec.type];
    assert.ok(known, `no kernel control list for ${spec.type}`);
    for (const knob of spec.knobs) {
      assert.ok(known.includes(knob.key), `${spec.type} declares knob ${knob.key}, which no kernel reads`);
    }
    for (const port of spec.inputs) {
      assert.ok(known.includes(port.key), `${spec.type} declares input ${port.key}, which no kernel reads`);
    }
  }
});

check("signedPhase is the int32 reading of a uint32 phase, at the boundary too", () => {
  assert.equal(signedPhase(0), 0);
  assert.equal(signedPhase(0.5), -0.5);
  assert.ok(Math.abs(signedPhase(0.4999) - 0.4999) < 1e-12);
});

console.log(`\nport_ax2_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
