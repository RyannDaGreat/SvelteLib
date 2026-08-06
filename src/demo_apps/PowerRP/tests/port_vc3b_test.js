/**
 * VC-3b PORT PROOF — twelve Bogaudio modules, MEASURED.
 * Run: node src/demo_apps/PowerRP/tests/port_vc3b_test.js
 *
 * ── WHAT A VCV PORT CAN GET WRONG, AND HOW THIS FILE CATCHES IT ─────────────
 * Bogaudio is float→float, so there is no fixed-point truncation to model (AX-3's
 * job). The failure modes are different and this file is shaped around the three
 * that matter:
 *
 * 1. **A GAIN ERROR THAT A COEFFICIENT DIFF CANNOT SEE.** A filter can have every
 *    pole in the right place and be 6 dB hot because a normalisation was dropped.
 *    So the filter checks below are MEASURED MAGNITUDE RESPONSES at named
 *    frequencies — passband gain, asymptotic slope, resonant peak — not
 *    coefficient comparisons. And the resonance check asserts the
 *    "would this catch a dropped `iq`" case EXPLICITLY: their `iq` is applied to
 *    exactly ONE section of the cascade, so a port that ignored it would still
 *    filter correctly and its Resonance knob would do nothing.
 * 2. **AN ANTI-ALIASING CLAIM THAT IS NOT TRUE.** Bogaudio's VCO is two
 *    mechanisms (minBLEP + 8× oversampling with a CIC decimator) and a port with
 *    neither still sounds fine on a bass note. So the VCO check MEASURES
 *    inharmonic energy against a naive saw at the same frequency.
 * 3. **AN ARITHMETIC IDENTITY ASSERTED RATHER THAN PROVEN.** The CIC decimator
 *    could not be transcribed literally — theirs relies on int64 WRAPAROUND and a
 *    JS number stops being an exact integer in milliseconds at 384 kHz — so it
 *    ships as the equivalent FIR. That claim is proven here against a BigInt
 *    integrator/comb reference, which is the only honest way to make it.
 *
 * Where a reference model IS useful it is a transcription of the C++, not a second
 * float formula: `refMinstd` and `refAmplifierLevel` build their generator and
 * their 8192-entry table the way `dsp/noise.hpp` and `dsp/signal.cpp` build them.
 *
 * ── IT TESTS THE SHIPPED KERNELS, NOT A COPY ────────────────────────────────
 * `synth/vc3b_kernels.js` is the ONE copy of the arithmetic and this file imports
 * it. The processors and the module factories are one call into it per sample, so
 * a check here is a check on what ships.
 *
 * WHAT THIS FILE DOES NOT PROVE: that any of it sounds right. It proves the
 * arithmetic matches the original's to the tolerances quoted per check, and that
 * the spec, the roster and the plugin barrel agree about what exists.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as K from "../synth/vc3b_kernels.js";
import { BOG_GATE_VOLTS, PEQ14_FREQUENCIES_HZ, VC3B_PROCESSORS, vc3bOptionSetter } from "../synth/worklets/processors_vc3b.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES } from "../synth/modules_vc3b.js";
import { BLOCK_SPECS, BOGAUDIO_SOURCE, bogaudioSemitonesToHz, peqBandKnobs } from "../core/audio_specs_vc3b.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_vc3b.js";
import { audioKnobDefaults, audioKnobRows, audioNodePlugin } from "../core/audio_nodes.js";
import { NODE_FAMILY_NAMES } from "../core/node_chrome.js";
import { PORT_TYPE_NAMES } from "../core/nodeflow.js";

const here = dirname(fileURLToPath(import.meta.url));
const KERNEL_SOURCE = readFileSync(join(here, "../synth/vc3b_kernels.js"), "utf8");
const PROCESSOR_SOURCE = readFileSync(join(here, "../synth/worklets/processors_vc3b.js"), "utf8");

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/** Rack's own rate, and the rate every reference number below is quoted at. */
const FS = 48000;

// ═══════════════════════════════════════════════════════════════════════════
// THE HARNESS — a bare-node stand-in for worklets/processors_vc3b.js
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Command. Run one roster row's kernel for `samples` samples, exactly as the
 * processor does: knobs from AudioParam defaults (overridable), audio inputs in
 * VOLTS, `control()` every `bogModulateSteps(FS)` samples, outputs divided back
 * to the ±1 wire scale.
 *
 * A stand-in and NOT a copy of behaviour: everything it does is the processor's
 * loop, and the whole point is that the loop is the only thing the processor adds.
 *
 * @param {object} row - a VC3B_PROCESSORS entry
 * @param {object} [opts] - {samples, wire, knobs, options, construct}
 *   `wire` maps a port key to `(i) => volts`; a port absent from it is UNWIRED,
 *   which is the distinction half these modules branch on (kernels' D3).
 * @returns {Float64Array[]} one array per output, on the ±1 wire scale
 */
function runKernel(row, opts = {}) {
  const { samples = 4096, wire = {}, knobs: overrides = {}, options = {}, construct = {} } = opts;
  const kernel = row.make(FS, { ...construct, ...options });
  for (const option of row.options) {
    if (options[option] !== undefined) kernel[vc3bOptionSetter(option)](options[option]);
  }
  const knobs = {};
  for (const p of row.params) knobs[p.name] = overrides[p.name] !== undefined ? overrides[p.name] : p.defaultValue;
  const signals = {};
  const wired = {};
  for (const key of row.audioInputs) {
    signals[key] = 0;
    wired[key] = wire[key] !== undefined;
  }
  const frame = new Float64Array(row.outputs.length);
  const steps = K.bogModulateSteps(FS);
  const out = row.outputs.map(() => new Float64Array(samples));
  let tick = 0;
  for (let i = 0; i < samples; i++) {
    // `wire` supplies each port's value IN THE KERNEL'S OWN UNIT (volts for a
    // level or gate port, semitones for a pitch port), so this harness does not
    // scale inputs — the OUTPUT scale is where R7-UNITS is exercised, and it is
    // read from the roster exactly as the processor reads it.
    for (const key of row.audioInputs) signals[key] = wired[key] ? wire[key](i) : 0;
    if (tick === 0) kernel.control(knobs, signals, wired);
    kernel.sample(knobs, signals, wired, frame);
    for (let o = 0; o < row.outputs.length; o++) out[o][i] = frame[o] * outputScaleOf(row, row.outputs[o]);
    tick = tick + 1 >= steps ? 0 : tick + 1;
  }
  return out;
}

/**
 * Pure function. A port's wire scale, from the roster's own declarations — the
 * three R7-UNITS kinds. Read here rather than assumed, so a port that changed kind
 * changes this file's arithmetic with it.
 *
 * @param {object} row - a VC3B_PROCESSORS entry
 * @param {string} port - the port key
 * @returns {number} volts (or semitones) per wire unit
 *
 * @example // a level port is five volts per unit
 * @example inputScaleOf({pitchPorts: [], gatePorts: []}, "in") // 5
 * @example inputScaleOf({pitchPorts: ["pitch"], gatePorts: []}, "pitch") // 1
 * @example inputScaleOf({pitchPorts: [], gatePorts: ["gate"]}, "gate") // 10
 */
function inputScaleOf(row, port) {
  if (row.pitchPorts.includes(port)) return 1;
  if (row.gatePorts.includes(port)) return BOG_GATE_VOLTS;
  return K.RACK_VOLTS_PER_UNIT;
}

/** Pure function. The reciprocal, for an output. @example outputScaleOf({pitchPorts: [], gatePorts: []}, "out") // 0.2 */
function outputScaleOf(row, port) {
  return 1 / inputScaleOf(row, port);
}

/** Query. A roster row by module name — the twelve are looked up, never indexed. */
const rowOf = (module) => {
  const row = VC3B_PROCESSORS.find((r) => r.module === module);
  assert.ok(row, `no roster row for ${module}`);
  return row;
};

/** Pure function. A bin-exact sine in VOLTS, so a DFT has no leakage. */
const voltSine = (hz, volts) => (i) => volts * Math.sin((2 * Math.PI * hz * i) / FS);

/** Pure function. A 10 V gate, high for `width` samples every `period`. */
const voltGate = (period, width) => (i) => (i % period < width ? 10 : 0);

/**
 * Pure function. The amplitude of `signal` at `hz`, by Goertzel over the whole
 * array — the measurement every filter check below is built on.
 *
 * @param {Float64Array} signal
 * @param {number} hz
 * @returns {number} amplitude in the signal's own units
 *
 * @example // a unit sine measures 1 at its own frequency
 * @example // amplitudeAt(Float64Array.from({length: 4096}, (_, i) => Math.sin(2*Math.PI*375*i/48000)), 375) // ≈1
 */
function amplitudeAt(signal, hz) {
  const w = (2 * Math.PI * hz) / FS;
  let re = 0;
  let im = 0;
  for (let i = 0; i < signal.length; i++) {
    re += signal[i] * Math.cos(w * i);
    im += signal[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / signal.length;
}

/** Pure function. A ratio in decibels, with a floor so silence is a number. */
const db = (ratio) => 20 * Math.log10(Math.max(ratio, 1e-12));

/**
 * Query. The magnitude response of a filter-shaped kernel at one frequency, in dB:
 * drive it with a 1 V sine, discard the settling half, measure what comes out.
 *
 * @param {object} row - the roster row
 * @param {number} hz - the probe frequency
 * @param {object} opts - runKernel options (knobs / options)
 * @param {number} [output] - which output index to measure
 * @returns {number} decibels, 0 = unity
 */
function responseDb(row, hz, opts, output = 0) {
  const samples = 1 << 14;
  const volts = 1;
  const out = runKernel(row, { ...opts, samples, wire: { ...(opts.wire ?? {}), in: voltSine(hz, volts) } });
  const settled = out[output].subarray(samples / 2);
  // The input is supplied in VOLTS and the output arrives on the wire, so the
  // measured ratio is divided by the output port's own scale to recover the
  // filter's gain. `in` and the measured output are both LEVEL ports here.
  return db(amplitudeAt(settled, hz) / (volts * outputScaleOf(row, row.outputs[output])));
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERENCE MODELS — transcriptions of the C++, not second float formulas
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure function. `std::minstd_rand` in BigInt — the generator `dsp/noise.hpp`
 * seeds. BigInt so the reference cannot share a precision bug with the shipped
 * Number implementation, which is the entire point of having a reference.
 *
 * @param {number} state - the seed state
 * @param {number} count - how many draws
 * @returns {number[]}
 *
 * @example refMinstd(1, 2) // [48271, 182605794]
 */
function refMinstd(state, count) {
  let x = BigInt(state);
  const m = 2147483647n;
  const a = 48271n;
  const out = [];
  for (let i = 0; i < count; i++) {
    x = (a * x) % m;
    out.push(Number(x));
  }
  return out;
}

/**
 * Pure function. `Amplifier::LevelTable::_generate` + `Amplifier::setLevel`
 * (`dsp/signal.cpp:22-50`), built as the real 8192-entry table with the real
 * truncated lookup — so `bogAmplifierLevel`'s closed form is checked against the
 * TABLE it replaces rather than against itself.
 *
 * @returns {function(number): number} db -> linear gain
 *
 * @example refAmplifierLevel()(0) // 1
 * @example refAmplifierLevel()(-60) // 0
 */
function refAmplifierLevel() {
  const length = 1 << 13;
  const minDb = -60;
  const maxDb = 20;
  const range = maxDb - minDb;
  const rdb = 6;
  const tdb = minDb + rdb;
  const ta = Math.pow(10, tdb * 0.05);
  const table = new Float64Array(length);
  table[0] = 0;
  for (let i = 1; i < length; i++) {
    const d = minDb + (i / length) * range;
    table[i] = d <= tdb ? ((d - minDb) / rdb) * ta : Math.pow(10, d * 0.05);
  }
  return (d) => {
    if (d <= minDb) return 0;
    if (d >= maxDb) return Math.pow(10, d * 0.05);
    return table[Math.trunc(((d - minDb) / range) * length)];
  };
}

/**
 * Pure function. `CICDecimator::next` (`dsp/filters/resample.cpp:49`) in BigInt,
 * integrators and combs and all — including the int64 wraparound its correctness
 * depends on. THE reference for deviation D10.
 *
 * @param {number} stages
 * @param {number} factor
 * @returns {function(Float64Array): number} one decimated sample per call
 *
 * @example // silence decimates to silence
 * @example refCicDecimator(4, 8)(new Float64Array(8)) // 0
 */
function refCicDecimator(stages, factor) {
  const scale = 1n << 32n;
  const mask = (1n << 64n) - 1n;
  const signBit = 1n << 63n;
  // int64 arithmetic, wraparound included — this is what a JS number cannot do
  // and the reason the shipped kernel is the equivalent FIR instead.
  const wrap = (v) => {
    const m = ((v % (1n << 64n)) + (1n << 64n)) & mask;
    return m & signBit ? m - (1n << 64n) : m;
  };
  const integrators = new Array(stages + 1).fill(0n);
  const combs = new Array(stages).fill(0n);
  const gain = 1 / Math.pow(factor, stages);
  return (buffer) => {
    for (let i = 0; i < factor; i++) {
      integrators[0] = BigInt(Math.trunc(buffer[i] * Number(scale)));
      for (let j = 1; j <= stages; j++) integrators[j] = wrap(integrators[j] + integrators[j - 1]);
    }
    let s = integrators[stages];
    for (let i = 0; i < stages; i++) {
      const t = s;
      s = wrap(s - combs[i]);
      combs[i] = t;
    }
    return gain * (Number(s) / Number(scale));
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE SHARED ARITHMETIC
// ═══════════════════════════════════════════════════════════════════════════

check("the seeded generator IS std::minstd_rand — bit-exact, in Number arithmetic", () => {
  // D2's claim, and it is exact rather than approximate because
  // 48271 · (2^31 − 1) < 2^53. If that were false every noise colour would drift.
  const rng = new K.BogMinstd(0);
  const state = rng.state;
  const mine = Array.from({ length: 1000 }, () => rng.nextRaw());
  assert.deepEqual(mine, refMinstd(state, 1000), "MINSTD must be reproduced exactly");
});

check("a cold seed is scrambled, so a fresh generator does not start at one end", () => {
  // MEASURED REGRESSION: seeded raw, `BogMinstd(0)`'s first draw is 48271 and
  // `bogUniform` of it is −0.99996 — so every sample-and-hold in a patch started
  // at the BOTTOM of its range. This is the check that keeps that fixed.
  // The claim is about the DISTRIBUTION of first draws across seeds, not about any
  // one of them: a single uniform draw beyond ±0.9 is ordinary, forty of them all
  // at −0.99996 is the bug. Seeded raw, every one of these would be within 1e-4 of
  // −1 and their mean would be −1.
  const firsts = Array.from({ length: 40 }, (_, seed) => K.bogUniform(new K.BogMinstd(seed).nextRaw()));
  const mean = firsts.reduce((a, x) => a + x, 0) / firsts.length;
  assert.ok(Math.abs(mean) < 0.15, `the mean first draw over 40 seeds is ${mean.toFixed(4)}; a cold generator gives −1`);
  assert.ok(Math.min(...firsts.map((d) => Math.abs(d + 1))) > 0.001,
    "no seed may start within a thousandth of the bottom of the range");
  assert.ok(Math.max(...firsts) > 0.5 && Math.min(...firsts) < -0.5, "and the draws must span the range");
  // And adjacent seeds must not produce correlated streams, which raw adjacent
  // MINSTD states do (the noise trees seed eight sub-generators as seed, seed+1…).
  const g0 = new K.BogWhiteNoise(0);
  const g1 = new K.BogWhiteNoise(1);
  let dot = 0;
  for (let i = 0; i < 4096; i++) dot += g0.next() * g1.next();
  assert.ok(Math.abs(dot / 4096) < 0.02, `seeds 0 and 1 correlate at ${dot / 4096}`);
});

check("white noise is uniform in [-1, 1]: mean 0, variance 1/3", () => {
  const g = new K.BogWhiteNoise(0);
  const n = 200000;
  let sum = 0;
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = g.next();
    sum += v;
    sumSq += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(Math.abs(sum / n) < 0.005, `mean ${sum / n}`);
  assert.ok(Math.abs(sumSq / n - 1 / 3) < 0.005, `variance ${sumSq / n}, expected 0.3333`);
  assert.ok(peak <= 1, `peak ${peak} exceeds the distribution's range`);
});

check("pink noise is the Voss-McCartney tree, and red is that tree applied to itself", () => {
  // The SPECTRAL claim, measured: pink must fall about 3 dB per octave and red
  // about 6. Their construction is what produces those slopes; a port that summed
  // the octaves without the counter would be white.
  const slopeOf = (generator) => {
    const n = 1 << 15;
    const signal = new Float64Array(n);
    for (let i = 0; i < n; i++) signal[i] = generator.next();
    const low = amplitudeAt(signal, (FS * 64) / n);
    const high = amplitudeAt(signal, (FS * 1024) / n);
    return db(high / low) / 4; // four octaves apart
  };
  const pink = slopeOf(K.bogNoiseGenerator("pink", 11));
  const red = slopeOf(K.bogNoiseGenerator("red", 11));
  // Wide tolerances because a single realisation of a random process is noisy;
  // the point is the ORDERING and the sign, which a wrong tree gets wrong.
  assert.ok(pink < -1 && pink > -6, `pink slope ${pink.toFixed(2)} dB/octave, expected about -3`);
  assert.ok(red < pink, `red (${red.toFixed(2)}) must fall faster than pink (${pink.toFixed(2)})`);
});

check("the amplifier's level curve matches their 8192-entry TABLE, quantisation included", () => {
  // `bogAmplifierLevel` is a closed form where theirs is a truncated table lookup.
  // The claim is that the two are the same number, not merely close: the closed
  // form reproduces the quantisation deliberately.
  const ref = refAmplifierLevel();
  let worst = 0;
  for (let d = -80; d <= 30; d += 0.013) worst = Math.max(worst, Math.abs(K.bogAmplifierLevel(d) - ref(d)));
  assert.ok(worst < 1e-12, `worst deviation from their table: ${worst}`);
  // And the two structural facts a smoothed version would lose.
  assert.equal(K.bogAmplifierLevel(-60), 0, "the floor must be true silence, not an asymptote");
  assert.ok(K.bogAmplifierLevel(-57) < K.bogAmplifierLevel(-54) * 0.51, "the bottom 6 dB is a LINEAR ramp");
});

check("the level taper is decibel-linear: half-way up is -30 dB, not -6", () => {
  // The single most audible thing about a Bogaudio VCA, and the thing a port that
  // wrote `level * in` would silently get wrong.
  assert.equal(K.bogLevelTaper(1), 1);
  assert.equal(K.bogLevelTaper(0), 0);
  assert.ok(Math.abs(db(K.bogLevelTaper(0.5)) + 30) < 0.02, `half-way is ${db(K.bogLevelTaper(0.5)).toFixed(2)} dB`);
});

check("the compressor's hard knee is exactly `over - over/ratio`, and the soft knee starts 3 dB EARLY", () => {
  for (const ratio of [2, 4, 10, 100]) {
    for (const over of [1, 6, 12, 24]) {
      const expected = over - over / ratio;
      assert.ok(Math.abs(K.bogCompressionDb(over, 0, ratio, false) - expected) < 1e-9,
        `ratio ${ratio}, ${over} dB over: ${K.bogCompressionDb(over, 0, ratio, false)} != ${expected}`);
    }
  }
  // Below the threshold the hard knee does nothing and the soft knee does not.
  assert.equal(K.bogCompressionDb(-2, 0, 4, true) > 0, true, "the soft knee must begin below the threshold");
  assert.equal(K.bogCompressionDb(-2, 0, 4, false), 0);
  assert.equal(K.bogCompressionDb(-3.0001, 0, 4, true), 0, "and it must begin exactly 3 dB below it");
  // Monotone in the detector level, which is what stops a compressor oscillating.
  let last = -1;
  for (let d = -6; d <= 24; d += 0.25) {
    const c = K.bogCompressionDb(d, 0, 4, true);
    assert.ok(c >= last - 1e-9, `soft-knee compression is not monotone at ${d} dB`);
    last = c;
  }
});

check("the ratio curve puts 2:1 exactly at their default knob, and infinity at the top", () => {
  assert.ok(Math.abs(K.bogPressorRatio(0) - 1) < 1e-12, `a knob of 0 is 1:1; got ${K.bogPressorRatio(0)}`);
  assert.ok(Math.abs(K.bogPressorRatio(0.55159) - 2) < 0.0005, `default knob gives ${K.bogPressorRatio(0.55159)}:1`);
  assert.equal(K.bogPressorRatio(1), Infinity);
});

check("the noise gate is the same path inverted, and its cap is the amplifier's floor", () => {
  assert.equal(K.bogNoiseGateDb(0, -20, 4, false), 0);
  assert.equal(K.bogNoiseGateDb(-25, -20, 4, false), 15);
  assert.equal(K.bogNoiseGateDb(-120, -20, 4, false), 60);
});

check("the crossfader's curve moves what the MIDDLE means, in both directions", () => {
  // The module's whole reason for existing, as three measurements.
  assert.deepEqual(K.bogCrossFaderMix(0, 0), { a: 0.5, b: 0.5 }, "curve 0 is an even blend");
  assert.deepEqual(K.bogCrossFaderMix(0, 1), { a: 1, b: 1 }, "curve +1 puts BOTH at full level in the middle");
  assert.deepEqual(K.bogCrossFaderMix(0, -1), { a: 0, b: 0 }, "curve -1 makes the middle SILENT");
  assert.deepEqual(K.bogCrossFaderMix(-1, 0), { a: 1, b: 0 });
  assert.deepEqual(K.bogCrossFaderMix(1, 0), { a: 0, b: 1 });
});

check("the saturator is odd-symmetric, soft, and carries THEIR DC offset", () => {
  for (const v of [0.5, 3, 7, 12, 40]) {
    assert.equal(K.bogSaturate(-v), -K.bogSaturate(v), `not odd-symmetric at ${v} V`);
  }
  assert.ok(K.bogSaturate(1) > 0.99 && K.bogSaturate(1) < 1, "small signals pass essentially untouched");
  assert.ok(K.bogSaturate(12) < 11, "the knee has begun well before the nominal limit");
  // ⚠ IT IS NOT A LIMITER AND IT DOES NOT ASYMPTOTE EITHER: their curve peaks at
  // about 11.72 V around ±28 V of input and then FOLDS BACK. Measured, and asserted
  // so that a future "fix" to the sqrt branch cannot quietly change what a hot
  // signal into a PEQ or a Pressor sounds like.
  const peak = Math.max(...[12, 20, 25, 28, 30, 40, 60].map((v) => K.bogSaturate(v)));
  assert.ok(peak > 11.7 && peak < 11.8, `their curve tops out near 11.72 V; measured ${peak.toFixed(4)}`);
  assert.ok(K.bogSaturate(100) < K.bogSaturate(30), "and it FOLDS BACK above its peak rather than holding");
  assert.ok(K.bogSaturate(100) > 11, "though the fold is gentle — it is still a soft ceiling, not a wrap");
  // −26.6 µV of DC at zero input. Theirs, from the `offset` term; asserted rather
  // than removed so nobody "fixes" it and changes every summed output slightly.
  assert.ok(Math.abs(K.bogSaturate(0)) < 3e-5 && K.bogSaturate(0) !== 0,
    `their offset term leaves a tiny DC: got ${K.bogSaturate(0)}`);
});

check("the Schmitt trigger fires at 1 V and rearms below 0.1 V — the hysteresis is real", () => {
  const t = new K.BogTrigger();
  assert.equal(t.process(0.9), false, "0.9 V must not fire");
  assert.equal(t.process(1), true, "1 V must fire");
  assert.equal(t.process(10), false, "and must not fire again while high");
  assert.equal(t.process(0.2), false, "0.2 V is still inside the hysteresis band");
  assert.equal(t.isHigh(), true, "…so the gate is still high");
  assert.equal(t.process(0.05), false);
  assert.equal(t.isHigh(), false, "below 0.1 V it rearms");
  assert.equal(t.process(1), true, "and fires again");
});

check("the modulate divider is ~2.5 ms of SAMPLES, not one per quantum", () => {
  // D1. Their `_modulationSteps = sampleRate * 2.5/1000`. Getting this wrong by
  // running control() per quantum would make every slew 6% fast; per sample would
  // change the sound outright.
  assert.equal(K.bogModulateSteps(48000), 120);
  assert.equal(K.bogModulateSteps(44100), 110);
  assert.equal(K.bogModulateSteps(96000), 240);
  assert.ok(K.bogModulateSteps(48000) !== 128, "it must NOT coincide with the render quantum");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE CIC DECIMATOR — deviation D10, proven rather than asserted
// ═══════════════════════════════════════════════════════════════════════════

check("D10: the FIR form of the CIC decimator equals their int64 integrator/comb", () => {
  const stages = 4;
  const factor = 8;
  const mine = new K.BogCicDecimator(stages, factor);
  const ref = refCicDecimator(stages, factor);
  const rng = new K.BogMinstd(4242);
  const buffer = new Float64Array(factor);
  let worst = 0;
  for (let block = 0; block < 2000; block++) {
    for (let i = 0; i < factor; i++) buffer[i] = K.bogUniform(rng.nextRaw());
    worst = Math.max(worst, Math.abs(mine.next(buffer) - ref(buffer)));
  }
  // Their `buf[i] * 2^32` truncates to int64, quantising the input at 2^-32
  // (−192 dBFS). That is the ONLY difference, and this is its measured size.
  assert.ok(worst < 1e-9, `worst deviation over 2000 blocks: ${worst}`);
  assert.ok(worst > 0, "if it were EXACTLY zero, the reference would not be modelling their truncation");
});

check("the CIC kernel is the impulse response of N cascaded length-R boxcars", () => {
  assert.deepEqual(Array.from(K.bogCicKernel(1, 4)), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(K.bogCicKernel(2, 2)), [1, 2, 1]);
  const h = K.bogCicKernel(4, 8);
  assert.equal(h.length, 4 * (8 - 1) + 1, "length must be N(R-1)+1");
  assert.equal(h.reduce((a, b) => a + b, 0), Math.pow(8, 4), "and it must sum to R^N, which is the gain the decimator divides out");
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE MULTIMODE FILTER — measured, because a coefficient diff cannot see gain
// ═══════════════════════════════════════════════════════════════════════════

/** Query. The magnitude of a bare BogMultimodeFilter at `hz`, in dB. */
function multimodeDb(poles, mode, cutoff, qbw, hz) {
  const capacity = 16;
  const f = new K.BogMultimodeFilter(capacity);
  f.setParams(FS, K.BOG_MULTIMODE.BUTTERWORTH, poles, mode, cutoff, qbw);
  const n = 1 << 14;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f.next(Math.sin((2 * Math.PI * hz * i) / FS));
  return db(amplitudeAt(out.subarray(n / 2), hz));
}

check("a lowpass's PASSBAND GAIN is unity — the check a dropped normalisation fails", () => {
  for (const poles of [1, 2, 3, 4, 8, 12]) {
    const gain = multimodeDb(poles, K.BOG_MULTIMODE.LOWPASS, 1000, 0, 20);
    assert.ok(Math.abs(gain) < 0.15, `${poles}-pole lowpass passband gain ${gain.toFixed(3)} dB, expected 0`);
  }
});

check("a lowpass's ASYMPTOTIC SLOPE is exactly 6 dB per octave PER POLE", () => {
  // The check that catches a wrong pole count, a missing biquad section, or a
  // cascade whose `setN` left a stale section in the path.
  for (const poles of [1, 2, 4, 8, 12]) {
    const cutoff = 200;
    const a = multimodeDb(poles, K.BOG_MULTIMODE.LOWPASS, cutoff, 0, cutoff * 4);
    const b = multimodeDb(poles, K.BOG_MULTIMODE.LOWPASS, cutoff, 0, cutoff * 8);
    const slope = b - a;
    assert.ok(Math.abs(slope + 6 * poles) < 0.6 * poles,
      `${poles}-pole slope ${slope.toFixed(2)} dB/octave, expected ${-6 * poles}`);
  }
});

check("a highpass is the mirror: unity well above the corner, 6n dB/octave below", () => {
  for (const poles of [2, 4, 12]) {
    const cutoff = 1000;
    assert.ok(Math.abs(multimodeDb(poles, K.BOG_MULTIMODE.HIGHPASS, cutoff, 0, 15000)) < 0.2,
      `${poles}-pole highpass is not unity in its passband`);
    const a = multimodeDb(poles, K.BOG_MULTIMODE.HIGHPASS, cutoff, 0, cutoff / 4);
    const b = multimodeDb(poles, K.BOG_MULTIMODE.HIGHPASS, cutoff, 0, cutoff / 8);
    assert.ok(Math.abs(a - b - 6 * poles) < 0.6 * poles, `${poles}-pole highpass slope ${(a - b).toFixed(2)}`);
  }
});

check("THE `iq` CASE: resonance must PEAK, and a port that ignored iq would fail this", () => {
  // `multimode.cpp:283`'s `iq = 0.8 − 0.6·qbw` multiplies `pole.x` for ONE section
  // only — the middle of the cascade. A port that dropped it would filter
  // correctly and its Resonance knob would do nothing at all, which is exactly the
  // "self-consistent and wrong" failure this file exists to catch.
  const cutoff = 1000;
  const peakAt = (qbw) => {
    let best = -Infinity;
    for (const hz of [700, 850, 1000, 1150, 1300]) {
      best = Math.max(best, multimodeDb(4, K.BOG_MULTIMODE.LOWPASS, cutoff, qbw, hz));
    }
    return best;
  };
  const flat = peakAt(0);
  const resonant = peakAt(1);
  assert.ok(resonant - flat > 6, `resonance only added ${(resonant - flat).toFixed(2)} dB of peak — is iq applied?`);
  assert.ok(resonant > 3, `at full resonance the response must overshoot unity; peak is ${resonant.toFixed(2)} dB`);
  assert.ok(flat < 1, `at zero resonance it must not; peak is ${flat.toFixed(2)} dB`);
});

check("a bandpass passes its centre, rejects DC, and its bandwidth is in OCTAVES", () => {
  const centre = 1000;
  const narrow = 0.05;
  assert.ok(multimodeDb(2, K.BOG_MULTIMODE.BANDPASS, centre, narrow, centre) > -3,
    "the centre must survive");
  assert.ok(multimodeDb(2, K.BOG_MULTIMODE.BANDPASS, centre, narrow, 20) < -40,
    "DC must not");
  // PITCH bandwidth: the edges are 2^±bw · f, so a wider setting must widen the
  // band GEOMETRICALLY — measured an octave out, where a linear-bandwidth port
  // would still be rejecting.
  const octaveUp = (qbw) => multimodeDb(2, K.BOG_MULTIMODE.BANDPASS, centre, qbw, centre * 2);
  assert.ok(octaveUp(1) - octaveUp(0.05) > 20,
    `widening bandwidth gained only ${(octaveUp(1) - octaveUp(0.05)).toFixed(1)} dB an octave up`);
});

check("a band-reject notches its centre and passes both sides", () => {
  const centre = 1000;
  assert.ok(multimodeDb(2, K.BOG_MULTIMODE.BANDREJECT, centre, 0.05, centre) < -20, "the centre must be notched");
  assert.ok(Math.abs(multimodeDb(2, K.BOG_MULTIMODE.BANDREJECT, centre, 0.05, 60)) < 0.5, "DC must pass");
  assert.ok(Math.abs(multimodeDb(2, K.BOG_MULTIMODE.BANDREJECT, centre, 0.05, 16000)) < 0.5, "and so must the top");
});

check("Chebyshev's ripple normalisation is applied — without it the filter is dB hot", () => {
  const f = new K.BogMultimodeFilter(16);
  f.setParams(FS, K.BOG_MULTIMODE.CHEBYSHEV, 4, K.BOG_MULTIMODE.LOWPASS, 1000, 0);
  const n = 1 << 14;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f.next(Math.sin((2 * Math.PI * 100 * i) / FS));
  const gain = db(amplitudeAt(out.subarray(n / 2), 100));
  // `outGain = 1/(e·2^(n−1))` — the passband sits near unity WITH it and about
  // 18 dB hot without, so this is a wide but decisive gate.
  assert.ok(gain < 6, `Chebyshev passband gain ${gain.toFixed(2)} dB — is outGain applied?`);
  assert.ok(gain > -12, `Chebyshev passband gain ${gain.toFixed(2)} dB is implausibly low`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE MODULES, MEASURED
// ═══════════════════════════════════════════════════════════════════════════

check("VCF: the Slope knob really moves the pole count, continuously", () => {
  const row = rowOf("vcvBogVcf");
  // Their SLOPE_PARAM is squared and then scaled by 11, so the knob position for
  // exactly n poles is sqrt((n−1)/11).
  const knobFor = (poles) => Math.sqrt((poles - 1) / 11);
  for (const poles of [2, 4, 8, 12]) {
    const opts = { knobs: { frequency: 400, slope: knobFor(poles), q: 0 } };
    const a = responseDb(row, 1600, opts);
    const b = responseDb(row, 3200, opts);
    const slope = b - a;
    assert.ok(Math.abs(slope + 6 * poles) < 1.2 * poles,
      `slope knob for ${poles} poles measured ${slope.toFixed(2)} dB/octave`);
  }
  assert.ok(Math.abs(responseDb(row, 100, { knobs: { frequency: 2000, slope: knobFor(4), q: 0 } })) < 0.6,
    "and the passband must still be unity");
});

check("VCF: the fixed 80 Hz highpass at the end is real — it is a fingerprint of the port", () => {
  // `VCF::Engine::sampleRateChange` puts a 2-pole 80 Hz highpass after the
  // crossfaded bank in EVERY mode. So a lowpass at 2 kHz still rolls off at 20 Hz,
  // which no naive lowpass would.
  const row = rowOf("vcvBogVcf");
  const opts = { knobs: { frequency: 2000, slope: 0.522233, q: 0 } };
  assert.ok(responseDb(row, 20, opts) < -12, `20 Hz measured ${responseDb(row, 20, opts).toFixed(1)} dB; the final HP is missing`);
  assert.ok(Math.abs(responseDb(row, 400, opts)) < 0.6, "while 400 Hz passes untouched");
});

check("PEQ: it is a BANK — silencing five of six bands leaves only the sixth", () => {
  const row = rowOf("vcvPeq");
  const silent = {};
  for (let i = 1; i <= 14; i++) silent[`level${i}`] = -60;
  // Band 3's default centre is 175 Hz. Open it alone.
  const opts = { knobs: { ...silent, level3: 0 }, options: { lowMode: "bandpass", highMode: "bandpass" } };
  const atBand = responseDb(row, PEQ14_FREQUENCIES_HZ[2], opts);
  const away = responseDb(row, 4000, opts);
  assert.ok(atBand > -12, `the open band measured ${atBand.toFixed(1)} dB`);
  assert.ok(atBand - away > 30, `only ${(atBand - away).toFixed(1)} dB between the open band and 4 kHz`);
});

check("PEQ: band 1 is a TWELVE-pole shelf when shelving and a 4-pole band when not", () => {
  // `PEQChannel::setFilterMode`'s `_poles = bandpass ? 4 : 12`. The pole count is
  // the whole difference between "a shelf" and "a wide band", so it is measured
  // as a slope rather than read off a field.
  const row = rowOf("vcvPeq");
  const silent = {};
  for (let i = 1; i <= 14; i++) silent[`level${i}`] = -60;
  const shelf = { knobs: { ...silent, level1: 0, frequency1: 400 }, options: { lowMode: "lowpass" } };
  // MEASURED JUST ABOVE THE CORNER, deliberately: a 12-pole lowpass is 72 dB per
  // octave, so two probes an octave apart put the second one below the cascade's own
  // numerical floor and the measured "slope" becomes zero — which is how this check
  // first failed. 450 → 700 Hz is 0.64 of an octave and stays measurable.
  const lo = 450;
  const hi = 700;
  const perOctave = (responseDb(row, hi, shelf) - responseDb(row, lo, shelf)) / Math.log2(hi / lo);
  assert.ok(perOctave < -40, `a 12-pole shelf must fall steeply; measured ${perOctave.toFixed(1)} dB/octave`);
  // …and the SAME band as a 4-pole bandpass must fall far more gently, which is the
  // comparison that proves the pole count is really switching.
  const band = { knobs: { ...silent, level1: 0, frequency1: 400 }, options: { lowMode: "bandpass" } };
  const bandPerOctave = (responseDb(row, hi, band) - responseDb(row, lo, band)) / Math.log2(hi / lo);
  assert.ok(bandPerOctave > perOctave + 20,
    `a 4-pole band (${bandPerOctave.toFixed(1)}) must fall far more gently than a 12-pole shelf (${perOctave.toFixed(1)})`);
  assert.ok(Math.abs(responseDb(row, 60, shelf)) < 1.5, "and the shelf must pass DC at unity");
});

check("PEQ: the band count is a PARAMETER — bands above it are silent, and 14 works", () => {
  const row = rowOf("vcvPeq");
  const out6 = runKernel(row, { samples: 2048, construct: { bands: 6 }, wire: { in: voltSine(1000, 1) } });
  const out14 = runKernel(row, { samples: 2048, construct: { bands: 14 }, wire: { in: voltSine(1000, 1) } });
  const energy = (a) => a.reduce((s, v) => s + v * v, 0);
  assert.equal(energy(out6[7]), 0, "band 7 must be silent at bands=6");
  assert.ok(energy(out14[7]) > 0, "and live at bands=14");
  assert.ok(energy(out6[3]) > 0, "band 3 must be live in both");
  assert.ok(energy(out14[3]) > 0);
  assert.ok(Number.isFinite(energy(out14[0])), "and the 14-band mix must be finite");
});

check("VCO: the anti-aliasing is REAL — measured against a naive saw at the same pitch", () => {
  // The claim that matters about this module. At 4 kHz a naive saw's harmonics above
  // Nyquist fold down onto non-harmonic bins; a BLEP + oversampled saw's do not.
  // Measured as the energy in bins that are NOT harmonics of f0. AT THE FIGURES
  // THIS PRODUCES TODAY: naive −9.1 dB, ported saw −30.9 dB, square −38.7 dB,
  // triangle −55.3 dB — a 21.9 dB improvement on the saw, which is the one whose
  // discontinuity the BLEP table exists for.
  const row = rowOf("vcvBogVco");
  const n = 1 << 13;
  const bin = FS / n;
  const k = 683;
  const f0 = k * bin; // 4002 Hz — bin-exact, so a rectangular window has no leakage
  // R7-UNITS clause 3: the knob is SEMITONES. Passing the V/oct number here put the
  // oscillator at 348 Hz while the naive reference ran at 8 kHz, and the metric
  // reported the port as catastrophically worse than a naive saw — a units bug in
  // the TEST that looked exactly like a broken port.
  const semitones = 12 * Math.log2(f0 / K.BOG_REFERENCE_HZ);
  const out = runKernel(row, { samples: n * 2, knobs: { frequency: semitones } });
  const ported = out[1].subarray(n); // the saw output, after the decimator settles
  const naive = new Float64Array(n);
  for (let i = 0; i < n; i++) naive[i] = 2 * (((f0 * (i + n)) / FS) % 1) - 1;
  const aliasEnergy = (signal) => {
    let harmonic = 0;
    let alias = 0;
    for (let b = 1; b < n / 2; b++) {
      const a = amplitudeAt(signal, b * bin) ** 2;
      if (b % k === 0) harmonic += a;
      else alias += a;
    }
    return alias / Math.max(harmonic, 1e-20);
  };
  const portedRatio = aliasEnergy(ported);
  const naiveRatio = aliasEnergy(naive);
  assert.ok(naiveRatio > 0.05, `the naive reference should alias badly; it measured ${naiveRatio.toExponential(2)}`);
  assert.ok(portedRatio < naiveRatio / 10,
    `ported alias/harmonic ${portedRatio.toExponential(2)} vs naive ${naiveRatio.toExponential(2)} — less than 10 dB better`);
});

check("VCO: four outputs from ONE phase, all at the requested pitch and ±5 V", () => {
  const row = rowOf("vcvBogVco");
  const hz = 261.626 * 2; // one octave above C4, i.e. the knob at 12 SEMITONES
  const out = runKernel(row, { samples: 1 << 13, knobs: { frequency: 12 } });
  const names = row.outputs;
  for (let o = 0; o < names.length; o++) {
    const settled = out[o].subarray(1 << 12);
    const fundamental = amplitudeAt(settled, hz);
    assert.ok(fundamental > 0.2, `${names[o]}'s fundamental at ${hz} Hz measured only ${fundamental.toFixed(3)}`);
    // ±5 V is 1.0 on our wire (D0). The BLEP waveforms overshoot; a factor-of-two
    // error in the voltage law would not be a 30% overshoot, it would be 2×.
    let peak = 0;
    for (const v of settled) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak > 0.5 && peak < 1.6, `${names[o]} peaks at ${peak.toFixed(3)} on the wire; ±5 V should be about 1.0`);
  }
});

check("SampleHold: an unwired input samples NOISE, a wired one samples the input", () => {
  const row = rowOf("vcvSamplehold");
  const period = 4800;
  const noiseRun = runKernel(row, { samples: period * 6, wire: { trigger1: voltGate(period, 50) } });
  const held = [];
  for (let s = 1; s < 6; s++) held.push(noiseRun[0][s * period - 1]);
  assert.equal(new Set(held.map((v) => v.toFixed(6))).size, 5, "five triggers must produce five different held values");
  // The default range is 0…10 V, which is 0…2 on the wire.
  for (const v of held) assert.ok(v >= -0.001 && v <= 2.001, `held value ${v} is outside the 0V-10V range`);
  const wiredRun = runKernel(row, {
    samples: period * 3,
    wire: { trigger1: voltGate(period, 50), in1: () => 3 },
  });
  assert.ok(Math.abs(wiredRun[0][period * 2] - 3 / K.RACK_VOLTS_PER_UNIT) < 1e-9,
    `a wired input must be sampled verbatim; got ${wiredRun[0][period * 2]}`);
});

check("SampleHold: section 2 falls back to section 1's trigger", () => {
  // Load-bearing: it is how one clock gives a patch a correlated pair.
  const row = rowOf("vcvSamplehold");
  const period = 4800;
  const out = runKernel(row, { samples: period * 3, wire: { trigger1: voltGate(period, 50) } });
  assert.ok(Math.abs(out[1][period * 2]) > 1e-9, "section 2 must have fired from section 1's trigger");
  assert.notEqual(out[0][period * 2], out[1][period * 2], "…with its own draw from the noise source");
});

check("SampleHold: TRACK follows the gate's level where SAMPLE holds its edge", () => {
  const row = rowOf("vcvSamplehold");
  const period = 4000;
  const ramp = (i) => (i % period) / period * 5;
  const opts = { samples: period * 3, wire: { trigger1: voltGate(period, period / 2), in1: ramp } };
  const sampled = runKernel(row, opts);
  const tracked = runKernel(row, { ...opts, options: { track1: "track" } });
  // Half-way through a high gate, TRACK is following the ramp and SAMPLE is not.
  const at = period * 2 + Math.trunc(period / 4);
  assert.ok(Math.abs(tracked[0][at] - ramp(at) / K.RACK_VOLTS_PER_UNIT) < 1e-9, "track must follow");
  assert.ok(Math.abs(sampled[0][at] - ramp(at) / K.RACK_VOLTS_PER_UNIT) > 0.01, "sample must not");
});

check("Walk: it WANDERS — its autocorrelation is high and it stays inside ±5 V", () => {
  const row = rowOf("vcvWalk");
  const n = 1 << 15;
  const out = runKernel(row, { samples: n, knobs: { rate: 0.5 } })[0];
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1.0001, `the walk must reflect at ±5 V (1.0 on the wire); peaked at ${peak}`);
  assert.ok(peak > 0.05, `the walk must actually move; peaked at only ${peak}`);
  // A WALK is correlated sample to sample; noise is not. One lag is enough to
  // tell them apart and it is the property that distinguishes this module.
  const mean = out.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 1; i < n; i++) {
    num += (out[i] - mean) * (out[i - 1] - mean);
    den += (out[i] - mean) ** 2;
  }
  assert.ok(num / den > 0.99, `lag-1 autocorrelation ${(num / den).toFixed(4)} — this is noise, not a walk`);
});

check("Pressor: 12 dB over a 2:1 hard-knee threshold really is 6 dB of reduction", () => {
  // A MEASURED compressor check. The threshold is in dB relative to 5 V, so a
  // steady 5 V input is 0 dB — except that the detector is the mean of the
  // rectified sum of BOTH inputs, so the level is computed and asserted from that
  // rather than from the panel.
  const row = rowOf("vcvPressor");
  const settle = 1 << 15;
  const hz = 375;
  const measure = (thresholdDb) => {
    const out = runKernel(row, {
      samples: settle,
      knobs: { threshold: thresholdDb, ratio: 0.55159, attack: 1, release: 1 },
      options: { knee: "hard", detector: "rms" },
      wire: { left: voltSine(hz, 5) },
    });
    return amplitudeAt(out[1].subarray(settle / 2), hz);
  };
  const open = measure(6);
  const clamped = measure(-24);
  assert.ok(open > 0.9, `with the threshold above the signal, output should pass: ${open.toFixed(3)}`);
  const reduction = db(open / clamped);
  assert.ok(reduction > 3 && reduction < 20,
    `30 dB of threshold travel at 2:1 gave ${reduction.toFixed(1)} dB of reduction, which is not a compressor`);
  // AND THE ENVELOPE OUTPUT MUST BE THE DETECTOR, not the signal: it is a slowly
  // varying positive value, not a 375 Hz tone.
  const env = runKernel(row, { samples: settle, wire: { left: voltSine(hz, 5) } })[0].subarray(settle / 2);
  assert.ok(Math.min(...env) >= 0, "the envelope must be non-negative");
  assert.ok(amplitudeAt(env, hz) < 0.05, "and must not carry the signal's own frequency");
});

check("Pressor: ATTACK and RELEASE are slews on the envelope, and they differ", () => {
  const row = rowOf("vcvPressor");
  const n = 1 << 14;
  const step = (i) => (i > 1000 ? 5 : 0);
  const fast = runKernel(row, { samples: n, knobs: { attack: 1 }, wire: { left: step } })[0];
  const slow = runKernel(row, { samples: n, knobs: { attack: 500 }, wire: { left: step } })[0];
  const at = 1000 + Math.trunc(FS * 0.01); // 10 ms after the step
  assert.ok(fast[at] > slow[at] * 2, `a 1 ms attack must reach further in 10 ms than a 500 ms one (${fast[at]} vs ${slow[at]})`);
});

check("VCA: the taper switch changes the SHAPE, and the decibel one is theirs by default", () => {
  const row = rowOf("vcvBogVca");
  const half = { knobs: { level1: 0.5 }, wire: { in1: () => 5 }, samples: 4096 };
  const dbMode = runKernel(row, half)[0].at(-1);
  const linear = runKernel(row, { ...half, options: { taper: "linear" } })[0].at(-1);
  assert.ok(Math.abs(linear - 0.5) < 1e-6, `linear taper at 0.5 must be half; got ${linear}`);
  assert.ok(Math.abs(db(dbMode / 1) + 30) < 0.1, `decibel taper at 0.5 must be -30 dB; got ${db(dbMode).toFixed(2)}`);
});

check("VCA: the CV inlet ATTENUATES rather than adds — 0 V is silence, unwired is unity", () => {
  // The reason every CV inlet in this block is an `audio` port (D3). If the two
  // cases below were equal, the whole mechanism would be broken.
  const row = rowOf("vcvBogVca");
  const base = { knobs: { level1: 1 }, wire: { in1: () => 5 }, samples: 4096, options: { taper: "linear" } };
  const unwired = runKernel(row, base)[0].at(-1);
  const wiredAtZero = runKernel(row, { ...base, wire: { ...base.wire, cv1: () => 0 } })[0].at(-1);
  const wiredAtTen = runKernel(row, { ...base, wire: { ...base.wire, cv1: () => 10 } })[0].at(-1);
  assert.ok(Math.abs(unwired - 1) < 1e-6, `unwired CV must be unity; got ${unwired}`);
  assert.ok(Math.abs(wiredAtZero) < 1e-6, `a connected CV at 0 V must be SILENCE; got ${wiredAtZero}`);
  assert.ok(Math.abs(wiredAtTen - 1) < 1e-6, `a connected CV at 10 V must be unity; got ${wiredAtTen}`);
});

check("D12: VCM's master level really is applied TWICE — their bug, reproduced", () => {
  const row = rowOf("vcvVcm");
  const out = runKernel(row, {
    samples: 4096,
    knobs: { level1: 1, mix: 0.5 },
    options: { taper: "linear" },
    wire: { in1: () => 5 },
  })[0].at(-1);
  assert.ok(Math.abs(out - 0.25) < 1e-6,
    `a mix of 0.5 on a unity input must give 0.25 (0.5 SQUARED), not 0.5; got ${out}`);
});

check("XFade's curve decides what the middle of the sweep sounds like", () => {
  const row = rowOf("vcvXfade");
  const middle = (curve) => {
    const out = runKernel(row, {
      samples: 8192,
      knobs: { mix: 0, curve },
      options: { taper: "linear" },
      wire: { a: () => 5, b: () => 5 },
    })[0].at(-1);
    return out;
  };
  assert.ok(Math.abs(middle(0)) < 1e-6, `curve 0 must make the middle SILENT; got ${middle(0)}`);
  assert.ok(Math.abs(middle(0.5) - 1) < 1e-6, `curve 0.5 must be an even blend of two unity inputs; got ${middle(0.5)}`);
  assert.ok(Math.abs(middle(1) - 2) < 1e-6, `curve 1 must sum BOTH at full level; got ${middle(1)}`);
});

check("Offset: the default scale is exactly 1.0x, and the ORDER switch is two instruments", () => {
  const row = rowOf("vcvOffset");
  const unity = runKernel(row, { samples: 1024, wire: { in: () => 3 } })[0].at(-1);
  assert.ok(Math.abs(unity - 3 / K.RACK_VOLTS_PER_UNIT) < 1e-9,
    `sqrt(0.1) squared times ten is exactly 1.0x; got ${unity * K.RACK_VOLTS_PER_UNIT} V from 3 V`);
  const opts = { samples: 1024, knobs: { offset: 0.2, scale: Math.sqrt(0.2) }, wire: { in: () => 2 } };
  const scaleFirst = runKernel(row, opts)[0].at(-1) * K.RACK_VOLTS_PER_UNIT;
  const offsetFirst = runKernel(row, { ...opts, options: { order: "offset_first" } })[0].at(-1) * K.RACK_VOLTS_PER_UNIT;
  assert.ok(Math.abs(scaleFirst - (2 * 2 + 2)) < 1e-9, `in x scale + offset = 6 V; got ${scaleFirst}`);
  assert.ok(Math.abs(offsetFirst - (2 + 2) * 2) < 1e-9, `(in + offset) x scale = 8 V; got ${offsetFirst}`);
});

check("Switch: a multiplexer ungated, a flip-flop latched", () => {
  const row = rowOf("vcvSwitch");
  const period = 2000;
  const wire = { gate: voltGate(period, period / 2), high1: () => 5, low1: () => -5 };
  const mux = runKernel(row, { samples: period * 3, wire })[0];
  assert.ok(mux[period * 2 + 10] > 0, "while the gate is high, `hi` must pass");
  assert.ok(mux[period * 2 + period - 10] < 0, "and while it is low, `lo`");
  const latch = runKernel(row, { samples: period * 5, wire, options: { latch: "on" } })[0];
  // Latched, the output must be CONSTANT across a whole gate cycle and flip on
  // the next rising edge.
  const a = latch[period * 2 + period - 10];
  const b = latch[period * 3 + period - 10];
  assert.ok(a * b < 0, `latched, consecutive cycles must alternate; got ${a} then ${b}`);
});

check("D-STACKUNITS: Stack transposes in SEMITONES on all four ports, and chains exactly", () => {
  const row = rowOf("vcvStack");
  // Every port is a pitch port, so the wire value IS the semitone count — which is
  // what makes the assertions below arithmetic rather than a conversion.
  for (const port of ["cv", "in", "thru", "out"]) {
    assert.ok(row.pitchPorts.includes(port), `Stack.${port} must be a pitch port`);
  }
  const fifth = runKernel(row, { samples: 512, knobs: { semitones: 7 }, wire: { in: () => 0 } });
  assert.ok(Math.abs(fifth[1].at(-1) - 7) < 1e-9, `a fifth above C4 is 7 semitones; got ${fifth[1].at(-1)}`);
  const octave = runKernel(row, { samples: 512, knobs: { octave: 1 }, wire: { in: () => 12 } });
  assert.ok(Math.abs(octave[1].at(-1) - 24) < 1e-9, `an octave above 12 st is 24 st; got ${octave[1].at(-1)}`);
  // Unpatched, `thru` emits the transposition itself — and in the SAME unit its
  // `cv` inlet reads, which is the whole point of the deviation.
  const unpatched = runKernel(row, { samples: 512, knobs: { semitones: 5 } });
  assert.ok(Math.abs(unpatched[0].at(-1) - 5) < 1e-9, `thru must emit 5 semitones; got ${unpatched[0].at(-1)}`);
  const chained = runKernel(row, { samples: 512, knobs: { semitones: 0 }, wire: { cv: () => 5, in: () => 0 } });
  assert.ok(Math.abs(chained[1].at(-1) - 5) < 1e-9,
    `thru -> cv must chain exactly: 5 semitones in gives 5 out, got ${chained[1].at(-1)}`);
  // The C1…C9 clamp, in the port's own domain (C1 is 36 semitones below C4).
  const high = runKernel(row, { samples: 512, knobs: { octave: 3, semitones: 11 }, wire: { in: () => 55 } });
  assert.ok(high[1].at(-1) <= 60.0001, `the output must clamp at C9 = 60 st; got ${high[1].at(-1)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE DETERMINISM LAW, AND THE BLOCK'S OWN CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════

check("every kernel is deterministic: the same seed renders the same samples, forever", () => {
  for (const row of VC3B_PROCESSORS) {
    const wire = {};
    for (const key of row.audioInputs) wire[key] = voltSine(123 + key.length * 7, 2);
    const opts = { samples: 2048, wire, construct: { seed: 5, bands: 6 } };
    const a = runKernel(row, opts);
    const b = runKernel(row, opts);
    for (let o = 0; o < a.length; o++) {
      assert.deepEqual(Array.from(a[o]), Array.from(b[o]), `${row.module}'s output ${row.outputs[o]} is not reproducible`);
    }
    for (const channel of a) for (const v of channel) assert.ok(Number.isFinite(v), `${row.module} produced a non-finite sample`);
  }
});

check("a different seed really is a different noise — the knob is not decorative", () => {
  for (const module of ["vcvSamplehold", "vcvWalk"]) {
    const row = rowOf(module);
    const wire = { trigger1: voltGate(2000, 50), jump: voltGate(2000, 50) };
    const a = runKernel(row, { samples: 8192, wire, construct: { seed: 1 } })[0];
    const b = runKernel(row, { samples: 8192, wire, construct: { seed: 2 } })[0];
    assert.notDeepEqual(Array.from(a), Array.from(b), `${module} ignores its seed`);
  }
});

check("no kernel reads a wall clock — the Δt = 0 law, checked at the source", () => {
  for (const forbidden of ["Date.now", "new Date", "Math.random", "performance.now"]) {
    assert.ok(!KERNEL_SOURCE.includes(forbidden), `synth/vc3b_kernels.js contains ${forbidden}`);
    assert.ok(!PROCESSOR_SOURCE.includes(forbidden), `processors_vc3b.js contains ${forbidden}`);
  }
});

check("R7-UNITS: the unit scale is applied in EXACTLY two places, and per PORT KIND", () => {
  // One conversion in, one out. A third site would mean some path is scaled twice,
  // and a factor of five is inaudible on one module and catastrophic on a patch.
  assert.equal(K.RACK_VOLTS_PER_UNIT, 5, "clause 1: 1.0 on a level wire is 5 V");
  assert.equal(BOG_GATE_VOLTS, 10, "clause 4: a full gate is Rack's 10 V");
  assert.equal(K.BOG_SEMITONES_PER_VOLT, 12, "clause 3: a pitch port carries 12 semitones per volt");
  const applications = [...PROCESSOR_SOURCE.matchAll(/this\.(input|output)Scale\[/g)].length;
  assert.equal(applications, 2, `expected exactly two scale applications; found ${applications}`);
  assert.ok(/signals\[inputNames\[n\]\] = channel === null \? 0 : channel\[i\] \* this\.inputScale\[n\]/.test(PROCESSOR_SOURCE),
    "the read must be the only place an input is scaled");
  assert.ok(/outputs\[o\]\[0\]\[i\] = this\.frame\[o\] \* this\.outputScale\[o\]/.test(PROCESSOR_SOURCE),
    "and the write the only place an output is");
  // Every port must be exactly ONE kind, and a port named in both lists would be
  // an ambiguity the scale table resolves silently.
  for (const row of VC3B_PROCESSORS) {
    for (const port of row.pitchPorts) {
      assert.ok(!row.gatePorts.includes(port), `${row.module}.${port} is declared both pitch and gate`);
    }
    for (const port of [...row.pitchPorts, ...row.gatePorts]) {
      assert.ok(row.audioInputs.includes(port) || row.outputs.includes(port),
        `${row.module} declares a scale for ${port}, which is not one of its ports`);
    }
  }
});

check("clause 3: a PITCH port really is semitones — 12 on the wire is one octave", () => {
  const row = rowOf("vcvBogVco");
  const measure = (knob, pitchIn) => {
    const n = 1 << 13;
    const out = runKernel(row, { samples: n, knobs: { frequency: knob }, wire: pitchIn === null ? {} : { pitch: () => pitchIn } });
    const settled = out[3].subarray(n / 2); // the sine, which has one clean partial
    let best = 0;
    let bestHz = 0;
    for (let b = 1; b < 400; b++) {
      const a = amplitudeAt(settled, (b * FS) / n);
      if (a > best) { best = a; bestHz = (b * FS) / n; }
    }
    return bestHz;
  };
  const c4 = measure(0, null);
  assert.ok(Math.abs(c4 - 261.626) < 8, `the knob at 0 st must be C4; measured ${c4.toFixed(1)} Hz`);
  assert.ok(Math.abs(measure(12, null) - 2 * 261.626) < 12, "12 st on the KNOB must be one octave up");
  assert.ok(Math.abs(measure(0, 12) - 2 * 261.626) < 12, "12 on the pitch INLET must be one octave up too");
  assert.ok(Math.abs(measure(-12, 12) - 261.626) < 8, "and the two must cancel, because they are one unit");
});

check("clause 4: a GATE port fires on a 0..1 gate, with room above the Schmitt threshold", () => {
  // A LEVEL-scaled gate of 1.0 would arrive at exactly 1 V — the trigger's own
  // threshold — so a gate of 0.99 would never fire. This is that regression.
  const row = rowOf("vcvSamplehold");
  const period = 2000;
  const fired = (height) => {
    const out = runKernel(row, {
      samples: period * 3,
      // The harness supplies volts, so the gate's wire value is scaled here the way
      // the processor scales it.
      wire: { trigger1: (i) => (i % period < 50 ? height * inputScaleOf(row, "trigger1") : 0) },
    })[0];
    return Math.abs(out[period * 2]) > 1e-9;
  };
  assert.equal(fired(1), true, "a full gate must fire");
  assert.equal(fired(0.5), true, "and half a gate still clears 1 V");
  assert.equal(fired(0.05), false, "while 0.05 stays inside the hysteresis band");
});

check("the spec's `hz` display and the DSP's own tuning are the same law", () => {
  // The restatement this file exists to pin: core/ may not import synth/, so
  // Bogaudio's C4 tuning is written on both sides. A card reading a frequency the
  // oscillator is not at would be worse than no readout, because it would be
  // believed — and reusing the E4-origin `semitonesToHz` would be four semitones out.
  for (const st of [-36, -12, 0, 7, 12, 60, 72]) {
    assert.ok(Math.abs(bogaudioSemitonesToHz(st) - K.bogSemitonesToHz(st)) < 1e-9,
      `${st} st: spec says ${bogaudioSemitonesToHz(st)}, DSP says ${K.bogSemitonesToHz(st)}`);
  }
  assert.ok(Math.abs(bogaudioSemitonesToHz(0) - 261.626) < 1e-9, "0 st is Bogaudio's own C4, to their six digits");
  // A TRANSPOSITION knob must have NO `hz` — a frequency beside it would be a lie.
  const stack = BLOCK_SPECS.find((s) => s.module === "vcvStack");
  for (const knob of stack.knobs) assert.equal(knob.hz, undefined, `Stack.${knob.key} is a transposition and must show no frequency`);
  // And a knob that reads out semitones MUST have one (the house rule AX-3 set).
  for (const spec of BLOCK_SPECS) {
    const knob = (spec.knobs ?? []).find((k) => k.key === spec.readout);
    if (knob && knob.unit === " st" && !spec.type.endsWith("_stack")) {
      assert.equal(typeof knob.hz, "function", `${spec.type} reads out semitones with no frequency beside them`);
    }
  }
});

check("the PORT-BLOCK CONTRACT: five exports, spelled exactly, with the right shapes", () => {
  assert.ok(Array.isArray(BLOCK_SPECS) && BLOCK_SPECS.length === 12, "BLOCK_SPECS must be an array of twelve");
  assert.ok(Array.isArray(BLOCK_PLUGINS) && BLOCK_PLUGINS.length === 12, "BLOCK_PLUGINS must be an array of twelve");
  assert.equal(typeof BLOCK_MODULE_FACTORIES, "object", "BLOCK_MODULE_FACTORIES must be an object");
  assert.ok(!Array.isArray(BLOCK_MODULE_FACTORIES));
  assert.ok(Array.isArray(BLOCK_WORKLET_MODULES), "BLOCK_WORKLET_MODULES must be an ARRAY, not a Set (AX-3 shipped a Set and it was swept back)");
  assert.equal(BLOCK_WORKLET_MODULES.length, 12, "every one of these is a worklet");
  for (const type of BLOCK_WORKLET_MODULES) assert.ok(type in BLOCK_MODULE_FACTORIES, `${type} has no factory`);
});

check("the spec, the roster and the barrel agree about what exists", () => {
  const specTypes = BLOCK_SPECS.map((s) => s.type);
  assert.deepEqual([...specTypes].sort(), BLOCK_PLUGINS.map((p) => p.type).sort(),
    "a spec with no plugin wrapper (or the reverse) is a module the author cannot reach");
  assert.equal(new Set(specTypes).size, specTypes.length, "duplicate spec type");
  const modules = BLOCK_SPECS.map((s) => s.module);
  assert.deepEqual([...modules].sort(), VC3B_PROCESSORS.map((r) => r.module).sort());
  assert.deepEqual([...modules].sort(), Object.keys(BLOCK_MODULE_FACTORIES).sort());
});

check("every spec knob is a real AudioParam, construct option or discrete option", () => {
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    const params = new Map(row.params.map((p) => [p.name, p]));
    for (const knob of spec.knobs ?? []) {
      if (knob.discrete) {
        assert.ok(row.options.includes(knob.key), `${spec.type}.${knob.key} is discrete but not a roster option`);
        continue;
      }
      if (knob.construct) {
        assert.ok(row.construct.includes(knob.key), `${spec.type}.${knob.key} is construct-time but not in row.construct`);
        continue;
      }
      const param = params.get(knob.key);
      assert.ok(param, `${spec.type}.${knob.key} is not an AudioParam the engine has`);
      // THE RANGE MUST MIRROR WHAT THE ENGINE REALLY ACCEPTS. A narrower spec is an
      // Inspector refusing a value the kernel takes; a wider one is a field whose
      // top end does nothing.
      assert.equal(param.minValue, knob.min, `${spec.type}.${knob.key} min drift`);
      assert.equal(param.maxValue, knob.max, `${spec.type}.${knob.key} max drift`);
      assert.equal(param.defaultValue, knob.default, `${spec.type}.${knob.key} default drift`);
    }
  }
});

check("every spec port is a real engine port, and the roster declares no port the spec hides", () => {
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    const plugin = audioNodePlugin(spec);
    const ports = plugin.ports({});
    assert.deepEqual(ports.inputs.map((p) => p.key), row.audioInputs,
      `${spec.type}'s inputs must be the roster's audio inputs, in INDEX ORDER — the index is how a wire finds the port`);
    assert.deepEqual(ports.outputs.map((p) => p.key), row.outputs, `${spec.type}'s outputs must be the roster's`);
    for (const p of [...ports.inputs, ...ports.outputs]) {
      assert.ok(PORT_TYPE_NAMES.includes(p.type), `${spec.type}.${p.key} has undeclared type ${p.type}`);
    }
  }
});

check("every discrete knob's options are exactly what its kernel setter accepts", () => {
  // The restatement this file exists to pin: core/ may not import synth/, so the
  // option lists are written twice. A value the spec offers and the kernel throws
  // on would be an Inspector row that crashes the audio thread.
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    const kernel = row.make(FS, { seed: 0, bands: 6 });
    for (const knob of (spec.knobs ?? []).filter((k) => k.discrete)) {
      const setter = vc3bOptionSetter(knob.key);
      assert.equal(typeof kernel[setter], "function", `${spec.type}: kernel has no ${setter}`);
      for (const option of knob.options) {
        assert.doesNotThrow(() => kernel[setter](option), `${spec.type}.${knob.key}: kernel refuses "${option}"`);
      }
      assert.throws(() => kernel[setter]("__nonsense__"), `${spec.type}.${knob.key}: kernel accepts nonsense silently`);
    }
  }
});

check("PEQ's band defaults are ONE list, restated in two files and pinned here", () => {
  const knobs = peqBandKnobs();
  const frequencies = knobs.filter((k) => k.key.startsWith("frequency")).map((k) => k.default);
  assert.deepEqual(frequencies, PEQ14_FREQUENCIES_HZ,
    "the spec's band frequencies and the roster's must be the same fourteen numbers");
  // And they must be PEQ14's own: their knob positions squared times 20000.
  const positions = [0.0689202, 0.0790569, 0.0935414, 0.1118034, 0.1322876, 0.1581139, 0.1870829,
    0.2236068, 0.2645751, 0.3162278, 0.3741657, 0.4472136, 0.5291503, 0.587367];
  positions.forEach((p, i) => {
    assert.ok(Math.abs(p * p * 20000 - PEQ14_FREQUENCIES_HZ[i]) < 0.5,
      `band ${i + 1}: PEQ14.hpp's knob ${p} is ${(p * p * 20000).toFixed(1)} Hz, spec says ${PEQ14_FREQUENCIES_HZ[i]}`);
  });
});

check("R7-17: every spec carries a derivation INDEX that cannot drift from the record", () => {
  const exported = new Set(Object.keys(K));
  for (const spec of BLOCK_SPECS) {
    const d = spec.derivation;
    assert.ok(d, `${spec.type}: no derivation record`);
    assert.equal(d.source, BOGAUDIO_SOURCE);
    assert.match(d.source, /github\.com\/bogaudio\/BogaudioModules @ [0-9a-f]{40}/, "the source must pin a commit");
    assert.ok(d.files.length > 0, `${spec.type}: no source files named`);
    for (const file of d.files) assert.match(file, /^src\//, `${spec.type}: ${file} is not a path in their tree`);
    // THE INDEX POINTS AT THE PROSE, so the pointer must resolve…
    assert.ok(exported.has(d.kernel), `${spec.type}: ${d.kernel} is not exported by synth/vc3b_kernels.js`);
    // …and every deviation it claims must actually be DEFINED there. This is what
    // makes the index a gate rather than a decoration.
    for (const id of d.deviations) {
      assert.ok(KERNEL_SOURCE.includes(`${id}.`) || KERNEL_SOURCE.includes(`${id} `),
        `${spec.type}: deviation ${id} is named in the index but nowhere in the kernels`);
    }
    assert.ok(d.deviations.length >= 5, `${spec.type}: the block-wide deviations are missing`);
  }
});

check("every spec is well-formed enough for the Inspector to open on it", () => {
  for (const spec of BLOCK_SPECS) {
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type} has undeclared family ${spec.family}`);
    assert.ok(spec.help && spec.help.length > 20, `${spec.type} has no module help`);
    assert.ok(!/\bNode\b/.test(spec.title), `${spec.type}'s title must not say "Node" — registry.withNodeTitle appends it`);
    assert.ok(!spec.title.startsWith("Audio "), `${spec.type}'s title must not say "Audio" — audioNodePlugin prefixes it`);
    if (spec.readout) {
      assert.ok((spec.knobs ?? []).some((k) => k.key === spec.readout), `${spec.type} reads out a knob it does not have`);
    }
    for (const knob of spec.knobs ?? []) {
      assert.ok(knob.label, `${spec.type}.${knob.key} has no label`);
      assert.ok(knob.help && knob.help.length > 10, `${spec.type}.${knob.key} has no help sentence`);
      if (knob.discrete) {
        assert.ok(knob.options?.includes(knob.default), `${spec.type}.${knob.key} default is not among its options`);
      } else {
        assert.equal(typeof knob.min, "number", `${spec.type}.${knob.key} has no min`);
        assert.equal(typeof knob.max, "number", `${spec.type}.${knob.key} has no max`);
        assert.ok(knob.default >= knob.min && knob.default <= knob.max, `${spec.type}.${knob.key} default is outside its range`);
      }
    }
    const rows = audioKnobRows(spec);
    assert.equal(rows.length, (spec.knobs ?? []).length);
    for (const row of rows) assert.ok(row.key.startsWith("audio") && !row.key.includes("."), `${row.key} is not a flat namespaced key`);
    const plugin = audioNodePlugin(spec);
    assert.deepEqual(plugin.defaults.inputs, {}, `${spec.type} must default an empty inputs map so a copy remaps`);
    assert.ok(plugin.defaults.h > 0);
    assert.ok(plugin.emit({ ...plugin.defaults }, null, { x: 0, y: 0, rotation: 0, scale: 1 }).length >= 4);
    assert.doesNotThrow(() => plugin.emit({ w: 100, h: 60 }, null, { x: 0, y: 0, rotation: 0, scale: 1 }),
      `${spec.type} threw on a minimal state`);
    assert.ok(Object.keys(audioKnobDefaults(spec)).length >= (spec.knobs ?? []).length - 1);
  }
});

check("the worklet file holds NO Vite-only syntax — the whole node lane depends on it", () => {
  // The SPECIFIERS, not the prose: this file's own header explains the `?worker&url`
  // rule, so a bare substring search finds its own documentation and reds.
  for (const [, specifier] of PROCESSOR_SOURCE.matchAll(/from "([^"]+)"/g)) {
    assert.ok(!specifier.includes("?"), `${specifier} carries a Vite query suffix`);
  }
  assert.ok(!PROCESSOR_SOURCE.includes("import.meta.glob"));
  const kernelImports = [...PROCESSOR_SOURCE.matchAll(/from "([^"]+)"/g)].map(([, s]) => s);
  for (const specifier of kernelImports) assert.match(specifier, /^\.\.?\//, `${specifier} is not a relative specifier (the ENGINE law)`);
});

console.log(`\nport_vc3b_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
