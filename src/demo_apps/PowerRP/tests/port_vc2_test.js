/**
 * VC-2 PORT PROOF — sixteen VCV Rack modules, measured against a TRANSCRIPTION of
 * the C++ and against analytic predictions, not against their own algebra.
 * Run: node src/demo_apps/PowerRP/tests/port_vc2_test.js
 *
 * ── WHY THIS FILE IS SHAPED DIFFERENTLY FROM port_ax3_test.js ───────────────
 * That one reproduces Axoloti's `___SMMUL`/`__SSAT` in BigInt, because a
 * fixed-point port's interesting failure is a float transcription that is
 * self-consistent and wrong. VCV Rack is float→float, so a line-by-line
 * transcription of its C++ is IDENTICAL TEXT to the kernel — a test written that
 * way would compare a thing to itself and pass no matter what either said. So the
 * reference here is one of three things, per check, and never the kernel restated:
 *
 *   1. AN INDEPENDENT DERIVATION. The Quantizer's 24-range table is asserted
 *      against a brute-force global-minimum search over all 4096 masks, which is
 *      a different algorithm from their early-breaking upward walk.
 *   2. AN ANALYTIC PREDICTION. The ladder's −3 dB corner must land at
 *      `sqrt(2^(1/4) − 1) = 0.435` times its per-pole cutoff — a number that comes
 *      from the pole count, not from the code. The ADSR's attack time must be
 *      `−ln(1 − 1/1.2)·τ`, which comes from the target overshoot.
 *   3. A DELIBERATELY WRONG MODEL THAT MUST FAIL. Two of this block's traps are
 *      silent-and-wrong in exactly the AX-3 `qinv` sense, so each is asserted
 *      BOTH ways: the right model matches and the plausible wrong one does not.
 *      (The halfband downsampler's swapped branches; Octave's two separate
 *      roundings.) Those are the checks that would have caught the bug.
 *
 * ── IT TESTS THE SHIPPED KERNELS ────────────────────────────────────────────
 * `synth/vc2_kernels.js` is the ONE copy of the arithmetic and this file imports
 * it. The processor file is read as TEXT for the structural pins at the bottom,
 * which are properties of the BRIDGE (registered names, the quarantined URL) and
 * have nothing to import from.
 *
 * ── IT ALSO PINS R7-UNITS, WHICH THIS BLOCK LEARNED THE HARD WAY ────────────
 * VC-2 first shipped with the wire equal to one Rack volt. The lead's ruling put
 * audio at ±1 = ±5 V, logic at 0…1, pitch in semitones and a normalised depth at
 * 0…1. Four checks below exist because of that history rather than in spite of
 * it, and they are the ones a future unit change must not be able to skip:
 * the ADSR→VCA unity round trip, a HOUSE 1.0 gate driving three different clock
 * inputs, the ladder's ÷5/×5 cancellation measured as a passband gain, and the
 * semitone origin being C4 rather than Axoloti's E4.
 *
 * WHAT THIS FILE DOES NOT PROVE: that any of it sounds right, and that a browser
 * can load the worklet. It proves the arithmetic matches the original's to the
 * tolerances quoted per check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BLOCK_SPECS } from "../core/audio_specs_vc2.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_vc2.js";
import { audioKnobDefaults, audioKnobRows, audioNodePlugin } from "../core/audio_nodes.js";
import { NODE_FAMILY_NAMES } from "../core/node_chrome.js";
import { PORT_TYPE_NAMES } from "../core/nodeflow.js";
import { AUDIO_SPECS } from "../core/audio_specs.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES, VC2_INPUT_PREFIX, vc2InputParam } from "../synth/modules_vc2.js";
import { VC2_PROCESSORS, vc2OptionSetter } from "../synth/worklets/processors_vc2.js";
import * as K from "../synth/vc2_kernels.js";

const here = dirname(fileURLToPath(import.meta.url));
const KERNEL_SOURCE = readFileSync(join(here, "../synth/vc2_kernels.js"), "utf8");
const WORKLET_SOURCE = readFileSync(join(here, "../synth/worklets/processors_vc2.js"), "utf8");

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/** Rack's own rate. Every figure below is at 48 kHz. */
const FS = 48000;

/** Pure function. Run one kernel for `frames` samples and hand each output frame
 *  to `sink`. The harness every measurement below shares, so a check is a
 *  prediction and a tolerance rather than a loop.
 *
 *  @param {object} kernel - a VC-2 kernel
 *  @param {object} controls - the control object (mutated by the caller's `input`)
 *  @param {number} outs - output count
 *  @param {number} frames
 *  @param {function(number): number[]} input - sample index -> audio inputs
 *  @param {function(Float64Array, number): void} sink - (frame, index)
 *  @returns {void}
 */
function run(kernel, controls, outs, frames, input, sink) {
  const out = new Float64Array(outs);
  const ins = new Float64Array(Math.max(input(0).length, 1));
  for (let i = 0; i < frames; i++) {
    const values = input(i);
    for (let n = 0; n < ins.length; n++) ins[n] = values[n] ?? 0;
    kernel.sample(controls, ins, out);
    sink(out, i);
  }
}

/** Pure function. Every knob's default for one spec's module, as a control object
 *  with the `in_*` inputs at 0 — i.e. the module as it lands on the canvas. */
function defaultControls(module) {
  const row = VC2_PROCESSORS.find((r) => r.module === module);
  const controls = {};
  for (const p of row.params) controls[p.name] = p.defaultValue;
  return controls;
}

// ── 1. THE SHARED `dsp::` HELPERS ───────────────────────────────────────────

check("exp2_taylor5 tracks an exact 2^x to better than 0.001 cents over the whole knob span", () => {
  // The prediction is that this approximation is INAUDIBLE, which is a number and
  // not an opinion — so the number is asserted rather than the code.
  let worst = 0;
  for (let i = 0; i <= 20000; i++) {
    const x = -9 + 20 * (i / 20000);
    const cents = 1200 * Math.log2(K.exp2Taylor5(x) / 2 ** x);
    worst = Math.max(worst, Math.abs(cents));
  }
  assert.ok(worst < 1e-3, `worst error ${worst.toFixed(6)} cents`);
  // Exact at every integer octave, which is what keeps a transposed patch in tune.
  for (const x of [-8, -1, 0, 1, 5, 10]) assert.equal(K.exp2Taylor5(x), 2 ** x, `exact at ${x}`);
});

check("tan_3_4 and tanhXdX_4_6 hold their source's stated error bounds", () => {
  let tanWorst = 0;
  for (let i = 1; i < 1000; i++) {
    const x = (Math.PI / 2) * (i / 1000) * 0.999;
    tanWorst = Math.max(tanWorst, Math.abs(K.tan34(x) / Math.tan(x) - 1));
  }
  // THEIR FIGURE IS ROUNDED and this probe reaches 0.999·π/2, where the measured
  // worst case is 2.80e-5 — i.e. it agrees with their claim to every digit they
  // state it in. The bound here is one digit looser so that agreeing is not a
  // failure; the MEASUREMENT is in the message either way.
  assert.ok(tanWorst < 3e-5, `tan_3_4 relative error ${tanWorst.toExponential(2)} exceeds their stated 2.8e-5`);
  let tanhWorst = 0;
  for (let i = -400; i <= 400; i++) {
    const x = i / 100;
    const exact = x === 0 ? 1 : Math.tanh(x) / x;
    tanhWorst = Math.max(tanhWorst, Math.abs(K.tanhXdX46(x) / exact - 1));
  }
  // Same rounding: measured 4.23e-6 against their stated 4.2e-6, over their own
  // [-4, 4] range. Agreement to the stated precision, so the bound allows it.
  assert.ok(tanhWorst < 5e-6, `tanhXdX_4_6 relative error ${tanhWorst.toExponential(2)} exceeds their stated 4.2e-6`);
});

check("eucMod/eucDiv are the C++ pair, not JS %", () => {
  assert.equal(K.eucMod(-1, 12), 11);
  assert.equal(-1 % 12, -1, "the behaviour eucMod exists to avoid");
  for (const a of [-49, -25, -24, -1, 0, 23, 24, 47]) {
    assert.equal(K.eucDiv(a, 24) * 24 + K.eucMod(a, 24), a, `the identity must hold at ${a}`);
  }
});

check("the seeded RNG is deterministic, uniform on [0,1), and unit-normal", () => {
  const a = new K.Vc2Rng(7);
  const b = new K.Vc2Rng(7);
  for (let i = 0; i < 1000; i++) assert.equal(a.uniform(), b.uniform(), "same seed, same stream");
  assert.notEqual(new K.Vc2Rng(8).uniform(), new K.Vc2Rng(9).uniform(), "different seeds differ");
  const rng = new K.Vc2Rng(1);
  let mean = 0;
  let min = Infinity;
  let max = -Infinity;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const u = rng.uniform();
    mean += u / N;
    min = Math.min(min, u);
    max = Math.max(max, u);
  }
  assert.ok(Math.abs(mean - 0.5) < 0.005, `uniform mean ${mean}`);
  assert.ok(min >= 0 && max < 1, `image must be [0,1): ${min}…${max}`);
  let variance = 0;
  for (let i = 0; i < N; i++) variance += rng.normal() ** 2 / N;
  assert.ok(Math.abs(variance - 1) < 0.02, `normal variance ${variance}`);
});

// ── 2. THE EXACT-INTEGER MODULES, AND THE TRAP IN EACH ──────────────────────

check("Octave rounds the knob and the CV SEPARATELY — and a single rounding of the sum FAILS", () => {
  const k = new K.OctaveKernel();
  const out = new Float64Array(1);
  const shift = (octave, cv, pitch) => {
    k.sample({ octave, in_octave: cv, in_pitch: pitch }, [], out);
    return out[0];
  };
  // R7-UNITS: the ports are SEMITONES, so an octave is 12 and the CV is divided
  // by 12 before rounding. Rack: round(1) + round(6/12) = 2 octaves = 24 st.
  assert.equal(shift(1, 6, 0), 24, "the ported model: two roundings, then x12");
  // THE CASE WHERE THE PLAUSIBLE WRONG MODEL DIFFERS. Round the SUM instead and
  // 0.5 + 0.5 is one octave, not two.
  assert.equal(shift(0.5, 6, 0), 24, "two roundings give two octaves");
  assert.equal(Math.round(0.5 + 0.5) * 12, 12, "the WRONG model's answer, on the record");
  // std::round is half-AWAY-from-zero, where Math.round is half-toward-+inf.
  assert.equal(K.roundHalfAwayFromZero(-0.5), -1);
  assert.equal(shift(-0.5, 0, 0), -12, "a negative half must round down, as std::round does");
  // And it is a pure transposition otherwise.
  assert.equal(shift(0, 0, 7), 7, "a fifth passes through untouched");
  assert.equal(shift(-2, 0, 12), -12);
});

check("the Quantizer's range table matches an INDEPENDENT global-minimum search, for all 4096 masks", () => {
  // Their search walks note upward from -12 and BREAKS at the first increase in
  // distance. This reference takes the global minimum over the same window, which
  // is a different algorithm; the kernel docblock claims the two agree, and this
  // is that claim measured rather than asserted.
  const reference = (mask) => {
    const any = (mask & 0xfff) !== 0;
    const ranges = [];
    for (let i = 0; i < 24; i++) {
      const target = Math.trunc((i + 1) / 2);
      let best = 0;
      let bestDist = Infinity;
      for (let note = -12; note <= 24; note++) {
        if (any && !(mask & (1 << K.eucMod(note, 12)))) continue;
        const dist = Math.abs(target - note);
        if (dist < bestDist) {
          best = note;
          bestDist = dist;
        }
      }
      ranges[i] = best;
    }
    return ranges;
  };
  const k = new K.QuantizerKernel();
  for (let mask = 0; mask < 4096; mask++) {
    k.updateRanges(mask);
    assert.deepEqual(Array.from(k.ranges), reference(mask), `mask ${mask}`);
  }
});

check("the Quantizer's (i+1)/2 is an INTEGER divide — a float divide shifts every boundary", () => {
  const k = new K.QuantizerKernel();
  const out = new Float64Array(1);
  // The port is in SEMITONES (R7-UNITS), so a step is 1.0 and the output IS the
  // note number — no /12 anywhere, which is the whole benefit of the unit.
  const snap = (v, mask = 0xfff) => {
    k.sample({ mask, offset: 0, in_pitch: v }, [], out);
    return out[0];
  };
  // Chromatic: the boundary sits at the half-semitone, so 1.4 semitones -> 1 and
  // 1.6 -> 2. Under a float `(i+1)/2` the targets are 0.5, 1.0, 1.5 … and range 2
  // would target 1.5, snapping 1.2 semitones UP to 2 instead of down to 1.
  assert.equal(snap(1.2), 1, "1.2 semitones must snap to 1");
  assert.equal(snap(1.6), 2);
  assert.equal(snap(-1.2), -1, "and symmetrically below zero");
  // C major pentatonic (C D E G A): 1.2 semitones is nearer C than D, and their
  // first-wins tie-break sends an exact 1.0 to C too.
  const PENT = (1 << 0) | (1 << 2) | (1 << 4) | (1 << 7) | (1 << 9);
  assert.equal(snap(1, PENT), 0, "a tie goes to the lower note, as their upward walk does");
  assert.equal(snap(3, PENT), 2);
  assert.equal(snap(6, PENT), 7);
  assert.equal(snap(-13, PENT), -12, "an octave below still lands on a scale degree");
  // An empty mask is not an error: the mask is ignored and every semitone passes.
  assert.equal(snap(5, 0), 5);
  // The pre-offset is in semitones too, so half a semitone flips the boundary.
  k.sample({ mask: 0xfff, offset: 0.6, in_pitch: 1 }, [], out);
  assert.equal(out[0], 2, "a +0.6 st offset pushes 1 st over the boundary to 2");
});

check("Compare's eight outputs, including the asymmetry between |B| and signed B", () => {
  const k = new K.CompareKernel();
  const out = new Float64Array(8);
  const at = (a, b) => {
    k.sample({ b, in_b: 0 }, [a], out);
    return Array.from(out);
  };
  const [max, min, clip, lim, clipgate, limgate, greater, less] = at(3, 2);
  assert.deepEqual([max, min, clip, lim], [3, 2, 2, 1], "clip limits A to |B| and lim is the remainder");
  // R7-UNITS clause 4: a gate is 0…1, not their 10 V and not 10/5.
  assert.deepEqual([clipgate, limgate, greater, less], [1, 0, 1, 0], "gates are 0…1");
  assert.equal(K.GATE_HIGH, 1, "and the constant says so");
  // B NEGATIVE: the clipper uses |B| (so it still limits at 2) while max/min and
  // the comparisons use B signed (so 3 > -2 and min is -2). Copying one convention
  // to both is the plausible wrong model.
  const negative = at(3, -2);
  assert.equal(negative[2], 2, "clip uses |B|");
  assert.equal(negative[1], -2, "min uses B signed");
  assert.equal(negative[6], K.GATE_HIGH, "A > B");
  // Inside the window nothing is clipped and `lim` is zero.
  assert.deepEqual(at(1, 2).slice(2, 6), [1, 0, 0, 1]);
  // The knob and the input SUM, which is the one place in the block where they do.
  k.sample({ b: 1, in_b: 1 }, [3], out);
  assert.equal(out[0], 3);
  assert.equal(out[2], 2, "B = knob + input = 2");
});

check("the VCA's three response laws, and an unwired CV passing the fader (D10)", () => {
  const k = new K.VcaKernel();
  const out = new Float64Array(1);
  const gain = (level, cvKnob, cvWire) => {
    k.sample({ level, cv: cvKnob, in_cv: cvWire }, [1], out);
    return out[0];
  };
  // Unwired: the assumed depth of 1 is unity, so the module passes `level`. A
  // literal port of `isConnected()` would read 0 here and be SILENT.
  assert.equal(gain(1, 1, 0), 1, "unwired VCA must pass its fader");
  assert.equal(gain(0.5, 1, 0), 0.5);
  // Wired with the knob zeroed: the wire IS the normalised depth (R7-UNITS
  // clause 2), so Rack's own `/10` is not applied twice.
  assert.equal(gain(1, 0, 0.5), 0.5);
  assert.equal(gain(1, 0, 2), 1, "a hot CV clamps at unity");
  assert.equal(gain(1, 0, -0.5), 0, "a negative CV closes rather than inverting");
  k.setResponse("exp4");
  assert.equal(gain(1, 0, 0.5), 0.5 ** 4, "VCA-1's exponential is the FOURTH power");
  k.setResponse("exp50");
  const exp50 = gain(1, 0, 0.5);
  assert.ok(Math.abs(exp50 - (50 ** 0.5 - 1) / 49) < 1e-12, `old VCA's law: got ${exp50}`);
  assert.ok(exp50 < 0.15, "and it is far more aggressive than exp4 at half CV");
  assert.throws(() => k.setResponse("nope"), /response must be one of/, "an unknown law must be LOUD");
});

check("Sum adds sixteen inputs and scales; Rescale shifts, clamps and FOLDS", () => {
  const sum = new K.SumKernel();
  const out = new Float64Array(1);
  const ins = new Float64Array(16).fill(1);
  sum.sample({ level: 1 }, ins, out);
  assert.equal(out[0], 16, "sixteen unrolled poly channels");
  sum.sample({ level: 0.5 }, ins, out);
  assert.equal(out[0], 8);

  const rescale = new K.RescaleKernel();
  const base = { gain: 1, multiplier: 1, offset: 0, min: -2, max: 2, reflectMin: 0, reflectMax: 0 };
  const at = (input, over = {}) => {
    rescale.sample({ ...base, ...over }, [input], out);
    return out[0];
  };
  assert.equal(at(1, { gain: 0.5, offset: 0.5 }), 1, "bipolar to unipolar: a +1 peak becomes 1");
  assert.equal(at(-1, { gain: 0.5, offset: 0.5 }), 0, "and a -1 trough becomes 0");
  assert.equal(at(0.5, { multiplier: 10 }), 2, "x10 then clamped at the +-2 cable limit");
  assert.equal(at(50), 2, "clamped at the ceiling by default");
  // FOLDING, not clamping: `max - |max - x|`, so an overshoot of 1 comes back to
  // 1 below the ceiling, and a big enough overshoot passes right through zero and
  // is then caught by the floor.
  assert.equal(at(3, { reflectMax: 1 }), 1, "an overshoot of 1 folds back to 1");
  assert.equal(at(5, { reflectMax: 1 }), -1, "an overshoot of 3 folds past zero");
  assert.equal(at(9, { reflectMax: 1 }), -2, "and a huge one is caught by the floor");
  assert.equal(at(-3, { reflectMin: 1 }), -1, "reflect at the floor, symmetrically");
  assert.equal(at(0.3, { min: 0.5, max: 0.5 }), 0.5, "max <= min collapses to a constant");
});

check("the Audio module is Rack's 6 dB of headroom, and its DC filter is 10 Hz", () => {
  const k = new K.AudioInterfaceKernel(FS);
  const out = new Float64Array(1);
  // Under R7-UNITS a +-1 wire IS Rack's nominal +-5 V, and Rack sends that to the
  // sound card as +-0.5 — so this module HALVES. (Under the volt-valued scheme
  // this block first shipped it was the whole /10; the number changed, the
  // module's job did not.)
  k.sample({ level: 1, dcFilter: 0 }, [1], out);
  assert.equal(out[0], 0.5, "a full-scale wire keeps Rack's 6 dB of headroom");
  k.sample({ level: 2, dcFilter: 0 }, [1], out);
  assert.equal(out[0], 2, "the knob is SQUARED: 2^2 x 0.5");
  // A DC input must decay away through the highpass; a 100 Hz tone must survive it.
  const dc = new K.AudioInterfaceKernel(FS);
  let last = 0;
  run(dc, { level: 1, dcFilter: 1 }, 1, FS, () => [1], (frame) => { last = frame[0]; });
  assert.ok(Math.abs(last) < 1e-3, `DC must be removed; got ${last}`);
  const tone = new K.AudioInterfaceKernel(FS);
  let peak = 0;
  run(tone, { level: 1, dcFilter: 1 }, 1, FS, (i) => [Math.sin(2 * Math.PI * 100 * i / FS)],
    (frame, i) => { if (i > FS / 2) peak = Math.max(peak, Math.abs(frame[0])); });
  assert.ok(peak > 0.49, `100 Hz must pass the 10 Hz highpass; peak ${peak}`);
});

// ── 3. THE LADDER — ANALYTIC PREDICTIONS, AND THE SWAPPED-BRANCH TRAP ───────

/** Pure function. The VCF's small-signal gain at one frequency, measured. Small
 *  signal deliberately: the module's soft clip and its per-stage tanh slopes are
 *  REAL nonlinearities, so a linear prediction may only be checked where the
 *  nonlinearity is inactive. */
function vcfGain(hz, over = {}, amplitude = 0.004, output = 0) {
  const k = new K.VcfKernel(FS, { seed: 3 });
  const controls = { ...defaultControls("vcvVcf"), ...over };
  const frames = Math.round(FS * 0.5);
  let peak = 0;
  run(k, controls, 2, frames, (i) => [amplitude * Math.sin(2 * Math.PI * hz * i / FS)],
    (frame, i) => { if (i > frames * 0.6) peak = Math.max(peak, Math.abs(frame[output])); });
  return peak / amplitude;
}

check("the ladder's -3 dB corner lands where FOUR poles predict: 0.435 x cutoff", () => {
  // The prediction comes from the pole count, not from the code: |H| = (1+x^2)^-2,
  // so -3 dB is at x = sqrt(2^(1/4) - 1) = 0.4350.
  const perPole = 261.6256; // the cutoff knob is HERTZ and defaults to middle C
  const predicted = perPole * Math.sqrt(2 ** 0.25 - 1);
  let lo = 20;
  let hi = 2000;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (20 * Math.log10(vcfGain(mid)) > -3) lo = mid;
    else hi = mid;
  }
  const measured = (lo + hi) / 2;
  assert.ok(Math.abs(measured / predicted - 1) < 0.01,
    `measured ${measured.toFixed(1)} Hz vs predicted ${predicted.toFixed(1)} Hz`);
  // Unity in the passband, and a 24 dB/octave asymptote.
  assert.ok(Math.abs(20 * Math.log10(vcfGain(5))) < 0.1, "unity passband gain");
  // MEASURED OVER 1→2 kHz AT A LARGER PROBE, and both choices are forced by the
  // module itself: it injects −120 dB of noise to bootstrap self-oscillation, so
  // an octave far enough down the skirt (2→4 kHz is −97 dB) measures THAT NOISE
  // rather than the filter. Raising the probe to 0.05 keeps the signal 20 dB clear
  // of it while staying small enough that the tanh slopes are inactive.
  const slope = 20 * Math.log10(vcfGain(2000, {}, 0.05)) - 20 * Math.log10(vcfGain(1000, {}, 0.05));
  assert.ok(slope < -21 && slope > -26, `four poles must approach 24 dB/oct; got ${slope.toFixed(1)}`);
});

check("THE SWAPPED-BRANCH TRAP: an unswapped downsampler is 3 dB down, and this catches it", () => {
  // Their `Downsampler2x` feeds input[1] to branch A and input[0] to branch B.
  // Copying the UPSAMPLER's assignment gives a filter that works and is quietly
  // wrong in the passband — the AX-3 `qinv` failure in VCV form. Both models are
  // computed here from the shipped `allpassCascade`, so the check is on the
  // primitive the kernel uses.
  const A = [0.062822416060049985, 0.4243808557204406, 0.7818614603969013];
  const B = [0.22380733034648345, 0.61653443504951111, 0.92747359487482584];
  const roundTrip = (swapped, hz) => {
    const upA = new Float64Array(3);
    const upB = new Float64Array(3);
    const downA = new Float64Array(3);
    const downB = new Float64Array(3);
    let peak = 0;
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin(2 * Math.PI * hz * i / FS);
      const o0 = K.allpassCascade(x, upA, A);
      const o1 = K.allpassCascade(x, upB, B);
      const a = K.allpassCascade(swapped ? o1 : o0, downA, A);
      const b = K.allpassCascade(swapped ? o0 : o1, downB, B);
      const y = 0.5 * (a + b);
      if (i > 2000) peak = Math.max(peak, Math.abs(y));
    }
    return peak;
  };
  // AT 1 kHz THE TWO ARE INDISTINGUISHABLE, and that is the point of the check
  // rather than a weakness in it: `½(A² + B²)` is unity wherever both allpasses
  // are near zero phase, so the bug is invisible exactly where a casual listen
  // would look for it.
  assert.ok(Math.abs(roundTrip(true, 1000) - 1) < 0.01, "swapped is unity at 1 kHz");
  assert.ok(Math.abs(roundTrip(false, 1000) - 1) < 0.01, "and so is the WRONG one — hence 10 kHz below");
  // AT 10 kHz IT IS 2 dB DOWN, and at 20 kHz nearly 12 dB. Measured figures, so a
  // regression in either direction moves a number rather than an opinion.
  const right = roundTrip(true, 10000);
  const wrong = roundTrip(false, 10000);
  assert.ok(right > 0.99, `the swapped round trip must still be unity at 10 kHz; got ${right.toFixed(4)}`);
  assert.ok(wrong < 0.85, `the UNSWAPPED one must be measurably down, or this check proves nothing; got ${wrong.toFixed(4)}`);
  assert.ok(roundTrip(false, 20000) < 0.35, "and it loses the top octave almost entirely");
});

check("resonance squares to 10 and self-oscillates above ~0.63, and not below", () => {
  const ring = (res) => {
    const k = new K.VcfKernel(FS, { seed: 5 });
    const controls = { ...defaultControls("vcvVcf"), res };
    let peak = 0;
    let crossings = 0;
    let previous = 0;
    run(k, controls, 2, FS * 2, () => [0], (frame, i) => {
      if (i > FS) {
        peak = Math.max(peak, Math.abs(frame[0]));
        if (previous < 0 && frame[0] >= 0) crossings++;
      }
      previous = frame[0];
    });
    return { peak, hz: crossings };
  };
  const quiet = ring(0.5);
  assert.ok(quiet.peak < 1e-3, `resonance 2.5 must not oscillate; peak ${quiet.peak.toExponential(2)} V`);
  const loud = ring(1);
  assert.ok(loud.peak > 0.2, `resonance 10 must self-oscillate from silence; peak ${loud.peak.toFixed(3)}`);
  // It rings near the cutoff — a little under, because the resonance feedback is
  // one oversampled sample old (their choice, and it sets this pitch).
  assert.ok(loud.hz > 200 && loud.hz < 262, `self-oscillation at ${loud.hz} Hz for a 261.6 Hz cutoff`);
});

check("drive is (1+d)^5 and DROPS the cutoff, and the highpass cancels at DC", () => {
  // The nonlinearity is the point of the module, so it is measured rather than
  // avoided: a 5 V input moves the corner down by a third.
  const corner = (amplitude) => {
    let lo = 20;
    let hi = 2000;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      const reference = 20 * Math.log10(vcfGain(5, {}, amplitude));
      if (20 * Math.log10(vcfGain(mid, {}, amplitude)) > reference - 3) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const small = corner(0.004);
  const large = corner(1);
  assert.ok(large < small * 0.8, `a hot input must lower the corner (${small.toFixed(0)} -> ${large.toFixed(0)} Hz)`);
  // Drive at +1 is 32x, which saturates: the output cannot grow 30 dB.
  const clean = vcfGain(50, {}, 0.01);
  const driven = vcfGain(50, { drive: 1 }, 0.01);
  assert.ok(driven > clean * 4, "drive must actually amplify");
  assert.ok(driven < clean * 32, "and the saturator must keep it under the raw 32x");
  // The highpass is the binomial combination, which cancels at DC by construction.
  const hp = new K.VcfKernel(FS, { seed: 5 });
  let last = 0;
  run(hp, defaultControls("vcvVcf"), 2, FS, () => [1], (frame) => { last = frame[1]; });
  assert.ok(Math.abs(last) < 1e-4, `the highpass must cancel DC; got ${last.toExponential(2)}`);
});

// ── 4. THE TIME-DOMAIN MODULES ──────────────────────────────────────────────

check("the ADSR's attack time is the analytic one for a target of 1.2", () => {
  // tau = MIN_TIME * LAMBDA_BASE^param = 0.1 s at the 0.5 default, and the attack
  // stops when env crosses 1 while aiming at 1.2 — so the time to full is
  // -ln(1 - 1/1.2)*tau, which is a prediction from the overshoot, not from the code.
  const k = new K.AdsrKernel(FS);
  // A HOUSE 1.0 GATE, deliberately: R7-UNITS clause 4 puts a gate at 0…1, so our
  // own Clock and Trigger nodes drive this directly. Under the volt-valued scheme
  // this same wire was 1 V and fired nothing.
  const controls = { ...defaultControls("vcvAdsr"), in_gate: 1 };
  // The knob IS the time constant now (law L2): 0.1 s by default, and the stage
  // ends when the envelope crosses 1 on its way to 1.2.
  const tau = controls.attack;
  assert.equal(tau, 0.1, "the attack knob is in seconds");
  const predicted = -Math.log(1 - 1 / 1.2) * tau;
  let reached = -1;
  run(k, controls, 1, FS, () => [], (frame, i) => {
    if (reached < 0 && frame[0] >= 0.9999) reached = i / FS;
  });
  assert.ok(Math.abs(reached - predicted) < 2e-3, `attack reached full at ${reached.toFixed(4)} s vs predicted ${predicted.toFixed(4)}`);
  // Then it decays to the sustain LEVEL, emitted as 0…10 V.
  let level = 0;
  run(k, controls, 1, FS * 2, () => [], (frame) => { level = frame[0]; });
  assert.ok(Math.abs(level - 0.5) < 0.001, `sustain 0.5 must hold 0.5 — the envelope IS the normalised quantity; got ${level}`);
  // And releases when the gate drops.
  run(k, { ...controls, in_gate: 0 }, 1, FS * 3, () => [], (frame) => { level = frame[0]; });
  assert.ok(level < 1e-4, `release must reach silence; got ${level}`);
  // THE KNOB IS SECONDS AT EVERY SETTING, not only at the default — the check that
  // would have caught the log2-dial reading this block first shipped.
  for (const seconds of [0.01, 1]) {
    const timed = new K.AdsrKernel(FS);
    let full = -1;
    run(timed, { ...controls, attack: seconds }, 1, FS * 8, () => [], (frame, i) => {
      if (full < 0 && frame[0] >= 0.9999) full = i / FS;
    });
    const want = -Math.log(1 - 1 / 1.2) * seconds;
    assert.ok(Math.abs(full - want) < want * 0.02, `attack ${seconds} s reached full at ${full.toFixed(4)} s, wanted ${want.toFixed(4)}`);
  }
  // A 0.5 V gate is BELOW their 1 V threshold and must not start anything.
  const idle = new K.AdsrKernel(FS);
  let peak = 0;
  run(idle, { ...controls, in_gate: 0.05 }, 1, FS, () => [], (frame) => { peak = Math.max(peak, frame[0]); });
  assert.equal(peak, 0, "the gate threshold is a tenth of a gate (their 1 V), with no hysteresis");
});

check("the ADSR's /16 CV divider is real: a faster-than-3 kHz CV is SAMPLED, not followed", () => {
  // Law L4. If the lambdas were recomputed every sample, an audio-rate CV on
  // `attack` would be tracked continuously; on a divider of 16 it is sampled at
  // 3 kHz. The observable difference: the divider's own phase makes the sampled
  // sequence differ from the continuous one, so the two envelopes diverge.
  const source = KERNEL_SOURCE.slice(KERNEL_SOURCE.indexOf("class AdsrKernel"));
  assert.match(source.slice(0, 2000), /cvDivider\.process\(\)/, "the divider must gate the lambda block");
  assert.match(KERNEL_SOURCE, /ADSR_CV_DIVISION = 16/, "and its divisor must be theirs");
  // Measured: hold the gate, wobble `attack` at 8 kHz, and compare against the
  // same run with the CV held at its mean. A divider that had been hoisted to one
  // call per quantum (128) would sample 8x more coarsely still.
  const envelopeAt = (wobble) => {
    const k = new K.AdsrKernel(FS);
    const controls = { ...defaultControls("vcvAdsr"), in_gate: 1, attackCv: 1 };
    let value = 0;
    run(k, controls, 1, 600, (i) => {
      controls.in_attack = wobble ? 0.5 * Math.sin(2 * Math.PI * 8000 * i / FS) : 0;
      return [];
    }, (frame) => { value = frame[0]; });
    return value;
  };
  assert.notEqual(envelopeAt(true), envelopeAt(false), "an audio-rate CV must reach the divider at all");
});

/** The LFO's declared floor, `2^-8` Hz — one cycle every four minutes, and the
 *  slowest value its AudioParam will pass. */
const LFO_MIN_HZ = 2 ** -8;

check("the LFO runs at its knob's hertz, and its unipolar wave starts at 0 V", () => {
  const cycles = (over) => {
    const k = new K.LfoKernel(FS);
    const controls = { ...defaultControls("vcvLfo"), offset: 0, ...over };
    let crossings = 0;
    let previous = 0;
    run(k, controls, 4, FS * 4, () => [], (frame) => {
      if (previous < 0 && frame[0] >= 0) crossings++;
      previous = frame[0];
    });
    return crossings;
  };
  // WITHIN ONE CROSSING over the window, because the phase starts AT zero: there is
  // no negative sample before the first rising crossing, so a counter cannot see
  // it. Asserting an exact count made a correct 8 Hz read as 7.75.
  const SECONDS = 4;
  const cyclesNear = (over, hz) => {
    const counted = cycles(over);
    assert.ok(Math.abs(counted - hz * SECONDS) <= 1, `expected ${hz} Hz (${hz * SECONDS} crossings); counted ${counted}`);
  };
  // THE KNOB IS HERTZ (law L2), so the expected rate IS the knob. Under the
  // log2-dial reading this block first shipped, `freq: 8` ran at 256 Hz.
  cyclesNear({}, 2);
  cyclesNear({ freq: 0.5 }, 0.5);
  cyclesNear({ freq: 8 }, 8);
  // The unipolar switch moves the PHASE as well as the offset, so the wave starts
  // at zero and rises. Dropping the quarter cycle is a silent quarter-turn error.
  const k = new K.LfoKernel(FS);
  const out = new Float64Array(4);
  // THE SLOWEST RATE THE KNOB DECLARES, not 0: the rate is hertz now, and `log2(0)`
  // is −∞. An AudioParam clamps automation to its own minValue, so the engine
  // cannot deliver a 0 here — but a test can, and a NaN sample would poison an
  // output permanently, so the range is respected rather than probed past.
  k.sample({ ...defaultControls("vcvLfo"), freq: LFO_MIN_HZ }, [], out);
  assert.ok(Math.abs(out[0]) < 0.01, `a unipolar sine must start at 0 V; got ${out[0]}`);
  assert.ok(out[0] >= 0, "and rise, not fall");
  // Bipolar amplitudes are +-5 V and unipolar are 0…10 V, on every waveform.
  const span = (over) => {
    const kernel = new K.LfoKernel(FS);
    const controls = { ...defaultControls("vcvLfo"), freq: 4, ...over };
    let lo = Infinity;
    let hi = -Infinity;
    run(kernel, controls, 4, FS, () => [], (frame) => {
      for (let o = 0; o < 4; o++) {
        lo = Math.min(lo, frame[o]);
        hi = Math.max(hi, frame[o]);
      }
    });
    return [lo, hi];
  };
  const bipolar = span({ offset: 0 });
  assert.ok(bipolar[0] < -0.99 && bipolar[1] > 0.99, `bipolar must be +-1 (their +-5 V): ${bipolar}`);
  const unipolar = span({ offset: 1 });
  assert.ok(unipolar[0] > -0.01 && unipolar[1] > 1.99, `unipolar must be 0…2 (their 0…10 V): ${unipolar}`);
});

check("the LFO's clock input takes over, driven by a HOUSE 1.0 gate", () => {
  const measured = (clockHz, amplitude) => {
    const k = new K.LfoKernel(FS);
    // freq 1 means "one times the clock's half rate" — their `clockFreq/2 · 2^pitch`
    // with pitch = log2(1) = 0. So an 8 Hz clock gives 4 Hz.
    const controls = { ...defaultControls("vcvLfo"), freq: 1, offset: 0 };
    const period = Math.round(FS / clockHz);
    let crossings = 0;
    let previous = 0;
    run(k, controls, 4, FS * 4, (i) => {
      controls.in_clock = (i % period) < 50 ? amplitude : 0;
      return [];
    }, (frame, i) => {
      if (i > FS && previous < 0 && frame[0] >= 0) crossings++;
      previous = frame[0];
    });
    return crossings / 3;
  };
  // A FULL 1.0 GATE at 8 Hz — what our own audio_clock emits — must set the rate:
  // freq dial 0 means clockFreq/2, so 4 Hz. THIS IS THE CHECK R7-UNITS EARNED:
  // under one-volt-per-unit the same wire was below the 2 V threshold and the
  // module silently stayed on its internal rate.
  assert.ok(Math.abs(measured(8, 1) - 4) <= 0.4, `a house 1.0 clock must set the rate; got ${measured(8, 1)}`);
  // A tenth of a gate is below the 0.2 threshold and must be ignored.
  assert.ok(Math.abs(measured(8, 0.1) - 1) <= 0.34, `a 0.1 pulse must be ignored; got ${measured(8, 0.1)}`);
});

check("the Delay settles to its target index, and the default dial is 0.5 s", () => {
  const k = new K.DelayKernel(FS);
  const controls = { ...defaultControls("vcvDelay"), feedback: 0, mix: 1 };
  run(k, controls, 2, FS * 6, () => [0], () => {});
  // The target is theirs: sampleRate/freq - 20, where freq = clockFreq/2 * 2^pitch.
  // The knob is SECONDS (law L2), so the target is the knob minus their own
  // 20-sample fudge — no dial inversion in the middle of the assertion.
  const target = FS * controls.time - 20;
  assert.ok(Math.abs(k.buffered - target) < 2, `buffered ${k.buffered.toFixed(1)} vs target ${target.toFixed(1)}`);
  assert.ok(Math.abs(k.buffered / FS - 0.5) < 0.005, `the 0.5 s default must buffer 0.5 s; got ${(k.buffered / FS).toFixed(4)}`);
  // An impulse comes back one delay later.
  let bestIndex = -1;
  let bestValue = 0;
  run(k, controls, 2, FS * 2, (i) => [i === 0 ? 1 : 0], (frame, i) => {
    if (Math.abs(frame[1]) > bestValue) {
      bestValue = Math.abs(frame[1]);
      bestIndex = i;
    }
  });
  assert.ok(Math.abs(bestIndex / FS - 0.5) < 0.01, `the echo must land at 0.5 s; got ${(bestIndex / FS).toFixed(4)}`);
  assert.ok(bestValue > 0.2, `and be audible; got ${bestValue.toFixed(3)}`);
});

/** A short delay for the tone measurement: long enough to be a delay, short enough
 *  that the chase settles inside the probe window. */
const DELAY_SHORT_SECONDS = 0.01;

check("the Delay's tone knob drives a lowpass DOWN and a highpass UP from one control", () => {
  const band = (tone, hz) => {
    const k = new K.DelayKernel(FS);
    const controls = { ...defaultControls("vcvDelay"), tone, feedback: 0, mix: 1, time: DELAY_SHORT_SECONDS };
    let peak = 0;
    const frames = Math.round(FS * 0.4);
    run(k, controls, 2, frames, (i) => [Math.sin(2 * Math.PI * hz * i / FS)],
      (frame, i) => { if (i > frames * 0.7) peak = Math.max(peak, Math.abs(frame[1])); });
    return peak;
  };
  // tone 0: lowpass at 200 Hz -> 4 kHz is far down. tone 1: highpass at 2 kHz ->
  // 100 Hz is far down. tone 0.5: both out of the way.
  assert.ok(band(0, 4000) < 0.2, `tone 0 must darken; got ${band(0, 4000).toFixed(3)}`);
  assert.ok(band(0, 100) > 0.5, "and keep the lows");
  assert.ok(band(1, 100) < 0.2, `tone 1 must thin; got ${band(1, 100).toFixed(3)}`);
  assert.ok(band(0.5, 1000) > 0.5, "mid tone passes the middle");
});

check("Random's internal clock, its skipping probability, and its crossfade knob", () => {
  const steps = (over) => {
    const k = new K.RandomKernel(FS, { seed: 4 });
    const controls = { ...defaultControls("vcvRandom"), ...over };
    let pulses = 0;
    let was = false;
    const values = [];
    run(k, controls, 5, FS * 4, () => [0], (frame) => {
      const high = frame[4] > 0.5;
      if (high && !was) {
        pulses++;
        values.push(frame[0]);
      }
      was = high;
    });
    return { pulses, values };
  };
  // THE KNOB IS HERTZ, and 2 is the number five nodes in
  // core/audio_patches_vcv_ambient.js already set — they meant 2 Hz.
  assert.equal(steps({}).pulses, 8, "the 2 Hz default gives 8 steps in 4 s");
  assert.ok(Math.abs(steps({ rate: 4 }).pulses - 16) <= 1, "and 4 Hz gives 16");
  const skipped = steps({ prob: 0 }).pulses;
  assert.equal(skipped, 0, "probability 0 emits no triggers at all — the step is SKIPPED, not silenced");
  // rand = 0 freezes the sequence: every step crossfades 0% toward a new value.
  const frozen = steps({ rand: 0 }).values;
  assert.ok(frozen.every((v) => v === frozen[0]), `rand 0 must repeat one value; got ${frozen.slice(0, 4)}`);
  // rand = 1 jumps, and the bipolar default spans +-5 V.
  const jumping = steps({}).values;
  assert.ok(new Set(jumping).size === jumping.length, "rand 1 must draw a fresh value each step");
  assert.ok(Math.min(...jumping) < 0 && Math.max(...jumping) > 0, "bipolar by default");
  assert.ok(Math.max(...jumping) <= 1 && Math.min(...jumping) >= -1, "and +-1, their +-5 V");
  const uni = steps({ offset: 1 }).values;
  assert.ok(Math.min(...uni) >= 0 && Math.max(...uni) <= 2, "the unipolar switch is 0…2, their 0…10 V");
});

check("Random's four shapes are four views of ONE step, and shape steepens all of them", () => {
  const k = new K.RandomKernel(FS, { seed: 11 });
  const controls = { ...defaultControls("vcvRandom"), rate: 1, shape: 1 };
  const frames = [];
  run(k, controls, 5, Math.round(FS * 0.6), () => [0], (frame, i) => {
    if (i % 2000 === 0) frames.push(Array.from(frame).slice(0, 4));
  });
  // Every shape starts and ends at the same two voltages (they all interpolate
  // `last -> next`), so at a step's end the four agree.
  const last = frames[frames.length - 1];
  for (const v of last) assert.ok(Math.abs(v - last[0]) < 0.2, `the shapes must converge at a step's end: ${last}`);
  // With shape 0 every output jumps immediately, so all four are equal always.
  const instant = new K.RandomKernel(FS, { seed: 11 });
  let spread = 0;
  run(instant, { ...controls, shape: 0 }, 5, FS, () => [0], (frame) => {
    spread = Math.max(spread, Math.max(...Array.from(frame).slice(0, 4)) - Math.min(...Array.from(frame).slice(0, 4)));
  });
  assert.ok(spread < 1e-9, `shape 0 must make all four outputs identical; spread ${spread}`);
});

check("SequentialSwitch2 walks its inputs on a HOUSE gate, drops a half-height one, and de-clicks over 2.5 ms", () => {
  const k = new K.SequentialSwitch2Kernel(FS);
  const controls = { ...defaultControls("vcvSequentialSwitch2"), in_clock: 0, in_reset: 0 };
  const out = new Float64Array(1);
  const clock = (amplitude) => {
    controls.in_clock = amplitude;
    k.sample(controls, [1, 2, 3, 4], out);
    controls.in_clock = 0;
    k.sample(controls, [1, 2, 3, 4], out);
    return out[0];
  };
  // PRIMED WITH A LOW SAMPLE FIRST, and that is not test hygiene — it is the
  // module's behaviour. `dsp::SchmittTrigger` has THREE states, and a first sample
  // that arrives already high moves UNINITIALIZED → HIGH withOUT firing. So a
  // patch whose clock is high at the instant the module is built misses that edge,
  // exactly as it does in Rack. A real patch's clock is low at t = 0.
  k.sample(controls, [1, 2, 3, 4], out);
  assert.equal(out[0], 1, "at rest the switch passes input 1");
  assert.deepEqual([clock(1), clock(1), clock(1), clock(1)], [2, 3, 4, 1], "four house 1.0 clocks, then a wrap");
  const fresh = new K.SequentialSwitch2Kernel(FS);
  const freshControls = { ...controls, in_clock: 0 };
  const step = (amplitude) => {
    freshControls.in_clock = amplitude;
    fresh.sample(freshControls, [1, 2, 3, 4], out);
    freshControls.in_clock = 0;
    fresh.sample(freshControls, [1, 2, 3, 4], out);
    return out[0];
  };
  assert.equal(step(0.1), 1, "a tenth of a gate must NOT advance it — the threshold is 0.2");
  assert.equal(step(0.19), 1, "nor must 0.19");
  assert.equal(step(0.2), 2, "0.2 fires — Rack's 2 V as a fraction of a gate");
  // Steps: the dial is 0/1/2 for a length of 2/3/4.
  const two = new K.SequentialSwitch2Kernel(FS);
  const twoControls = { ...controls, steps: 0, in_clock: 0 };
  two.sample(twoControls, [1, 2, 3, 4], out); // prime the Schmitt, as above
  const walk = [];
  for (let i = 0; i < 4; i++) {
    twoControls.in_clock = 1;
    two.sample(twoControls, [1, 2, 3, 4], out);
    twoControls.in_clock = 0;
    two.sample(twoControls, [1, 2, 3, 4], out);
    walk.push(out[0]);
  }
  assert.deepEqual(walk, [2, 1, 2, 1], "dial 0 cycles two inputs");
  // De-click: a linear 400/s slew, so a full crossfade takes 2.5 ms.
  const declick = new K.SequentialSwitch2Kernel(FS);
  const declickControls = { ...controls, declick: 1 };
  let reached = -1;
  run(declick, declickControls, 1, FS, () => [1, 2, 3, 4], (frame, i) => {
    if (reached < 0 && frame[0] >= 0.999) reached = i / FS;
  });
  assert.ok(Math.abs(reached - 1 / 400) < 2e-4, `a de-clicked switch must fade in over 2.5 ms; got ${(reached * 1000).toFixed(2)} ms`);
});

check("SEQ3's clock, its reset window, and what clockPassthrough changes", () => {
  const controls = () => ({ ...defaultControls("vcvSeq3") });
  // Internal tempo: dial 1 is 2 Hz, so 8 steps in 4 s.
  const k = new K.Seq3Kernel(FS);
  const c = controls();
  assert.equal(c.tempo, 120, "the tempo knob is in BPM (law L2), defaulting to 120");
  for (let row = 1; row <= 3; row++) for (let s = 1; s <= 8; s++) c[`cv${row}_${s}`] = row * s;
  let changes = 0;
  let previous = null;
  run(k, c, 16, FS * 4, () => [], (frame) => {
    if (previous !== null && frame[0] !== previous) changes++;
    previous = frame[0];
  });
  assert.equal(changes, 8, "120 BPM is 2 steps a second, so 8 in 4 s");
  // The CV rows are independent: row 2 is twice row 1, row 3 three times.
  const out = new Float64Array(16);
  k.sample(c, [], out);
  assert.ok(Math.abs(out[1] / out[0] - 2) < 1e-9 && Math.abs(out[2] / out[0] - 3) < 1e-9, "three independent rows");
  // A CLOCK ARRIVING INSIDE THE 1 ms RESET PULSE IS DROPPED. Reset and clock on
  // the same sample must leave the sequencer on step 1.
  const r = new K.Seq3Kernel(FS);
  const rc = controls();
  rc.in_reset = 1;
  rc.in_clock = 1;
  r.sample(rc, [], out);
  assert.equal(out[8], 1, "step1 must be the active step (its own output is high)");
  assert.equal(out[9], 0, "and step2 must not be");
  // clockPassthrough: off gives a 1 ms pulse per step change; on gives the
  // incoming clock's own gate, which for a 50% square is 50% of the period.
  const duty = (passthrough) => {
    const kernel = new K.Seq3Kernel(FS);
    const pc = controls();
    pc.clockPassthrough = passthrough;
    const period = Math.round(FS / 4);
    let high = 0;
    run(kernel, pc, 16, FS, (i) => {
      pc.in_clock = (i % period) < period / 2 ? 1 : 0;
      return [];
    }, (frame) => { if (frame[5] > 0.5) high++; });
    return high / FS;
  };
  assert.ok(duty(0) < 0.02, `a pulse train must be a few ms per step; got ${duty(0)}`);
  assert.ok(duty(1) > 0.45, `passthrough must carry the clock's 50% gate; got ${duty(1)}`);
  // `steps` shortens the pattern, summed in volts with its trim OPEN by default.
  const s = new K.Seq3Kernel(FS);
  const sc = controls();
  sc.in_steps = -6; // steps, not volts: R7-UNITS clause 2
  let seen = new Set();
  run(s, sc, 16, FS * 4, () => [], (frame) => { seen.add(Math.round(frame[4])); });
  assert.deepEqual([...seen], [1], "steps 8 with a -6 V CV must report a length of 2 (numSteps - 1 = 1)");
});

check("the noise colours are all calibrated to 5/sqrt(2) V RMS, and black deliberately is not", () => {
  const k = new K.NoiseKernel(FS, { seed: 1 });
  const sums = new Float64Array(6);
  const N = FS * 4;
  run(k, {}, 6, N, () => [], (frame) => {
    for (let o = 0; o < 6; o++) sums[o] += frame[o] * frame[o];
  });
  const rms = Array.from(sums).map((s) => Math.sqrt(s / N));
  // 1/sqrt(2) — their 5/sqrt(2) V over R7-UNITS' factor of five, which is also
  // exactly the RMS of a full-scale sine. The two statements are one calibration.
  const target = 1 / Math.SQRT2;
  for (let o = 0; o < 5; o++) {
    assert.ok(Math.abs(rms[o] / target - 1) < 0.02, `colour ${o} RMS ${rms[o].toFixed(3)} vs ${target.toFixed(3)}`);
  }
  // Black is uniform on +-5 V, whose RMS is 5/sqrt(3) — a different number, and
  // their source says so ("Note: I made this definition up").
  assert.ok(Math.abs(rms[5] / (1 / Math.sqrt(3)) - 1) < 0.02, `black RMS ${rms[5].toFixed(3)}`);
  // WHITE IS GAUSSIAN, NOT UNIFORM: a uniform stream cannot exceed its bound, a
  // normal one does. At this RMS a uniform white would be capped at 1.22.
  let peak = 0;
  const g = new K.NoiseKernel(FS, { seed: 2 });
  run(g, {}, 6, FS * 4, () => [], (frame) => { peak = Math.max(peak, Math.abs(frame[0])); });
  assert.ok(peak > target * 3, `a Gaussian white must produce rare large excursions; peak ${peak.toFixed(3)}`);
});

check("the noise spectrum slopes are the colours they claim: pink -3 dB, red -6, violet +6, blue +3", () => {
  // Measured as the ratio of band energy in two octaves an octave apart, through
  // a naive DFT at two probe frequencies with a wide window. Coarse on purpose:
  // the claim under test is the SLOPE's sign and rough magnitude, which is what
  // distinguishes one colour from another.
  const N = 1 << 15;
  const buffers = [];
  for (let o = 0; o < 6; o++) buffers.push(new Float64Array(N));
  const k = new K.NoiseKernel(FS, { seed: 3 });
  run(k, {}, 6, N, () => [], (frame, i) => {
    for (let o = 0; o < 6; o++) buffers[o][i] = frame[o];
  });
  const power = (buffer, hz) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      const phase = 2 * Math.PI * hz * i / FS;
      re += buffer[i] * Math.cos(phase);
      im += buffer[i] * Math.sin(phase);
    }
    return (re * re + im * im) / (N * N);
  };
  // Average several neighbouring bins so one bin's variance does not decide it.
  const band = (buffer, hz) => {
    let total = 0;
    for (let n = 0; n < 24; n++) total += power(buffer, hz * (1 + n * 0.01));
    return total / 24;
  };
  // AVERAGED OVER FIVE OCTAVE PAIRS, because a slope is a property of the whole
  // spectrum and ONE pair is not one: a single noise realisation's narrow-band
  // energy varies by ±2 dB, which is as large as the difference between pink and
  // blue. Measured per-octave the five colours read (125→4 k): white +0.1,
  // pink −3.2, red −5.8, violet +6.1, blue +2.8 — so ±1.5 dB on the AVERAGE is a
  // tight bound, where ±2 dB on a single pair was a loose one that still failed.
  const OCTAVES = [125, 250, 500, 1000, 2000];
  const slope = (buffer) => {
    let total = 0;
    for (const low of OCTAVES) total += 10 * Math.log10(band(buffer, low * 2) / band(buffer, low));
    return total / OCTAVES.length;
  };
  assert.ok(Math.abs(slope(buffers[0])) < 1.5, `white must be flat; got ${slope(buffers[0]).toFixed(1)} dB/oct`);
  assert.ok(Math.abs(slope(buffers[1]) + 3) < 1.5, `pink must be -3; got ${slope(buffers[1]).toFixed(1)}`);
  assert.ok(Math.abs(slope(buffers[2]) + 6) < 1.5, `red must be -6; got ${slope(buffers[2]).toFixed(1)}`);
  assert.ok(Math.abs(slope(buffers[3]) - 6) < 1.5, `violet must be +6; got ${slope(buffers[3]).toFixed(1)}`);
  assert.ok(Math.abs(slope(buffers[4]) - 3) < 1.5, `blue must be +3; got ${slope(buffers[4]).toFixed(1)}`);
});

check("the VCMixer's channel faders are SQUARE and its mix fader is not", () => {
  const k = new K.VcMixerKernel();
  const out = new Float64Array(5);
  const c = defaultControls("vcvVcMixer");
  const at = (over) => {
    k.sample({ ...c, ...over }, [1, 0, 0, 0], out);
    return out;
  };
  assert.equal(at({}).at(1), 1, "unity at the default");
  assert.ok(Math.abs(at({ lvl1: Math.SQRT2 })[1] - 2) < 1e-12, "a channel fader is SQUARED: sqrt(2)^2 = +6 dB");
  assert.equal(at({ mixLvl: 2 })[0], 2, "the mix fader is LINEAR: 2 is +6 dB");
  // The CV floors at zero and does NOT cap: 20 V gives 2x.
  assert.equal(at({ cv1: 1, in_cv1: 1 })[1], 2, "a hot channel CV really does amplify — theirs is not capped above");
  assert.equal(at({ cv1: 0, in_cv1: -0.5 })[1], 0, "and a negative one closes the channel");
  assert.equal(at({ chExp: 1, cv1: 0.5, in_cv1: 0 })[1], 0.5 ** 4, "the exponential option is the FOURTH power");
  // Channel outputs are post-CV and pre-mix-fader, which is what makes them sends.
  const sends = at({ mixLvl: 0 });
  assert.equal(sends[0], 0, "mix muted");
  assert.equal(sends[1], 1, "but the channel send is still live");
});

check("a GATE OUTPUT IS TYPED `trigger`, because audio->trigger is not a coercion", () => {
  // core/nodeflow.js's COERCIONS table has no `audio->trigger` entry, so a gate
  // output typed `audio` COULD NOT BE WIRED into any gate input in the library —
  // the drop would be refused. Three placeholder sets read these ports as
  // `trigger` and the patches are already wired against that, so this pins the
  // types rather than leaving them to the next reader's judgement.
  const gateOutputs = {
    audio_vcv_compare: ["clipgate", "limgate", "greater", "less"],
    audio_vcv_random: ["trig"],
    audio_vcv_seq3: ["trig", "clock", "run", "reset",
      "step1", "step2", "step3", "step4", "step5", "step6", "step7", "step8"],
  };
  for (const [type, keys] of Object.entries(gateOutputs)) {
    const spec = BLOCK_SPECS.find((s) => s.type === type);
    for (const key of keys) {
      const port = spec.outputs.find((o) => o.key === key);
      assert.ok(port, `${type}: no output ${key}`);
      assert.equal(port.type, "trigger", `${type}.${key} must be a trigger, not ${port.type}`);
    }
  }
  // And the two that are NOT gates keep their own types, or the distinction is
  // decoration: SEQ3's `steps` is a count and its CV rows are signals.
  const seq3 = BLOCK_SPECS.find((s) => s.type === "audio_vcv_seq3");
  assert.equal(seq3.outputs.find((o) => o.key === "steps").type, "audio");
  assert.equal(seq3.outputs.find((o) => o.key === "cv1").type, "audio");
});

check("R7-UNITS end to end: an envelope drives a VCA at unity, and the ladder's two scalings cancel", () => {
  // 1. NORMALISED DEPTH. The ADSR emits 0…1 and the VCA reads 0…1, so a sustain
  //    of 0.5 is a gain of 0.5 with no factor anywhere between them. This is the
  //    round trip the whole ruling is for, and it also crosses the block boundary:
  //    our own audio_adsr emits the same unit.
  const adsr = new K.AdsrKernel(FS);
  const adsrControls = { ...defaultControls("vcvAdsr"), in_gate: 1 };
  let env = 0;
  run(adsr, adsrControls, 1, FS * 3, () => [], (frame) => { env = frame[0]; });
  assert.ok(Math.abs(env - 0.5) < 0.001, `the envelope must settle at its sustain LEVEL; got ${env}`);
  const vca = new K.VcaKernel();
  const vcaOut = new Float64Array(1);
  vca.sample({ level: 1, cv: 0, in_cv: env }, [1], vcaOut);
  assert.ok(Math.abs(vcaOut[0] - 0.5) < 0.001, `a 0.5 envelope must be a 0.5 gain; got ${vcaOut[0]}`);
  // 2. AUDIO. The ladder's own `scale = 5` cancels law L1's factor of 5 exactly,
  //    so its passband gain is unity — which is the measurement that would catch
  //    the cancellation being applied once instead of twice (that error is a
  //    factor of 25, and 5 either way).
  const passband = vcfGain(5);
  assert.ok(Math.abs(20 * Math.log10(passband)) < 0.05, `passband gain ${(20 * Math.log10(passband)).toFixed(3)} dB`);
  // 3. LOGIC. Every gate output in the block is exactly 0 or 1.
  const seq = new K.Seq3Kernel(FS);
  const seqOut = new Float64Array(16);
  const seqControls = defaultControls("vcvSeq3");
  const seen = new Set();
  run(seq, seqControls, 16, FS, () => [], (frame) => {
    for (const index of [3, 5, 6, 7, 8, 9]) seen.add(frame[index]);
  });
  assert.deepEqual([...seen].sort(), [0, 1], `a gate output must only ever be 0 or 1; saw ${[...seen]}`);
  // 4. PITCH, AND ITS ORIGIN. 0 semitones is C4, not Axoloti's E4 — the one
  //    number that decides whether a transcribed patch plays in the right key.
  assert.equal(K.semitonesToHzC4(0), 261.6256);
  // NOT exactly 440: `FREQ_C4` is Rack's own ROUNDED literal (261.6256 against a
  // true 261.62556…), so their whole library is 0.00005 % sharp of A440 by
  // construction. Reproduced rather than corrected — a port that silently retuned
  // itself would beat against a real Rack patch, which is the entire class of
  // error the derivation record exists to make findable.
  assert.ok(Math.abs(K.semitonesToHzC4(9) - 440) < 1e-4, `9 semitones above C4 is A440; got ${K.semitonesToHzC4(9)}`);
  assert.notEqual(K.semitonesToHzC4(9), 440, "and it is THEIR 440, not an exact one");
  assert.ok(Math.abs(K.semitonesToHzC4(12) / K.semitonesToHzC4(0) - 2) < 1e-12, "12 semitones is an octave");
});

// ── 5. DETERMINISM — THE LAW THE WHOLE PROJECT RESTS ON ─────────────────────

check("every RNG-reading kernel is byte-identical on a second run with the same seed", () => {
  const streams = (make, controls, outs, inputs) => {
    const values = [];
    run(make(), controls, outs, 2000, inputs, (frame) => values.push(...frame));
    return values;
  };
  const noise = () => new K.NoiseKernel(FS, { seed: 42 });
  assert.deepEqual(streams(noise, {}, 6, () => []), streams(noise, {}, 6, () => []), "Noise");
  const random = () => new K.RandomKernel(FS, { seed: 42 });
  const randomControls = defaultControls("vcvRandom");
  assert.deepEqual(
    streams(random, randomControls, 5, () => [0]),
    streams(random, randomControls, 5, () => [0]), "Random",
  );
  const vcf = () => new K.VcfKernel(FS, { seed: 42 });
  const vcfControls = { ...defaultControls("vcvVcf"), res: 1 };
  assert.deepEqual(
    streams(vcf, vcfControls, 2, (i) => [Math.sin(i / 20)]),
    streams(vcf, vcfControls, 2, (i) => [Math.sin(i / 20)]), "VCF's self-oscillation bootstrap",
  );
  // And a DIFFERENT seed must actually change the stream, or the knob is a lie.
  const other = streams(() => new K.NoiseKernel(FS, { seed: 43 }), {}, 6, () => []);
  assert.notDeepEqual(streams(noise, {}, 6, () => []), other, "a different seed must differ");
});

check("no kernel reads a wall clock or an unseeded random — the determinism law, grepped", () => {
  for (const forbidden of ["Date.now", "Math.random", "performance.now", "new Date"]) {
    assert.ok(!KERNEL_SOURCE.includes(forbidden), `vc2_kernels.js must not contain ${forbidden}`);
    assert.ok(!WORKLET_SOURCE.includes(forbidden), `processors_vc2.js must not contain ${forbidden}`);
  }
});

/** The plugin file suffix per type — the ONE place the two spellings meet, since
 *  a type is `audio_vcv_<model>` and a file is `audio_vc2_<suffix>` (the block
 *  number in the path is what keeps a `git add` glob off a sibling block's work). */
const PLUGIN_FILES = {
  audio_vcv_noise: "noise",
  audio_vcv_vcf: "vcf",
  audio_vcv_quantizer: "quantizer",
  audio_vcv_delay: "delay",
  audio_vcv_sequentialswitch2: "switch2",
  audio_vcv_rescale: "rescale",
  audio_vcv_vca: "vca",
  audio_vcv_adsr: "adsr",
  audio_vcv_lfo: "lfo",
  audio_vcv_octave: "octave",
  audio_vcv_vcmixer: "vcmixer",
  audio_vcv_random: "random",
  audio_vcv_seq3: "seq3",
  audio_vcv_compare: "compare",
  audio_vcv_sum: "sum",
  audio_vcv_audiointerface: "audiointerface",
};

// ── 6. THE BRIDGE, AND THE THREE PLACES A NODE HAS TO EXIST IN ──────────────

check("every spec has a roster row, a factory, a processor and a plugin", () => {
  const registered = [...WORKLET_SOURCE.matchAll(/registerProcessor\(entry\.name/g)];
  assert.equal(registered.length, 1, "one registration loop over the roster, not sixteen calls");
  assert.equal(BLOCK_SPECS.length, VC2_PROCESSORS.length, "one roster row per spec");
  assert.equal(BLOCK_SPECS.length, Object.keys(BLOCK_MODULE_FACTORIES).length, "one factory per spec");
  assert.equal(BLOCK_SPECS.length, BLOCK_PLUGINS.length, "one plugin per spec");
  assert.ok(Array.isArray(BLOCK_WORKLET_MODULES), "BLOCK_WORKLET_MODULES must be an ARRAY (the contract; AX-3 shipped a Set and it was swept)");
  for (let i = 0; i < BLOCK_SPECS.length; i++) {
    const spec = BLOCK_SPECS[i];
    assert.equal(BLOCK_PLUGINS[i].type, spec.type, `${spec.type}: the barrel must be in spec order`);
    assert.ok(BLOCK_MODULE_FACTORIES[spec.module], `${spec.type}: no factory named ${spec.module}`);
    assert.ok(BLOCK_WORKLET_MODULES.includes(spec.module), `${spec.type}: not in the init() gate`);
    const plugin = audioNodePlugin(spec);
    assert.equal(plugin.type, spec.type);
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type}: family ${spec.family} is not one of ours`);
    for (const port of [...spec.inputs, ...spec.outputs]) {
      assert.ok(PORT_TYPE_NAMES.includes(port.type), `${spec.type}.${port.key}: port type ${port.type}`);
    }
    // The title carries neither prefix: `audioNodePlugin` adds "Audio " and
    // `core/registry.withNodeTitle` adds " Node", both idempotently. Spelling
    // either by hand is writing what the seam already does.
    assert.ok(!spec.title.startsWith("Audio "), `${spec.type}: the "Audio " prefix is the seam's job`);
    assert.ok(!/\bNode$/.test(spec.title), `${spec.type}: the " Node" suffix is the registry's job`);
  }
});

check("THE RESTATEMENT GATE: every spec range is the engine's own range", () => {
  // core/ may not import synth/, so every knob range in the spec file is a
  // RESTATEMENT of the roster's AudioParam. This is the seam that keeps the
  // restatement checkable — an Inspector that accepts a number the engine
  // discards is the silent failure the project forbids.
  for (const spec of BLOCK_SPECS) {
    const row = VC2_PROCESSORS.find((r) => r.module === spec.module);
    const params = new Map(row.params.map((p) => [p.name, p]));
    for (const knob of spec.knobs) {
      if (knob.discrete) {
        assert.ok(row.options.includes(knob.key), `${spec.type}.${knob.key}: discrete knob is not a roster option`);
        const setter = vc2OptionSetter(knob.key);
        const kernel = row.make(FS, {});
        assert.equal(typeof kernel[setter], "function", `${spec.type}.${knob.key}: kernel has no ${setter}`);
        continue;
      }
      if (knob.construct) {
        assert.ok(row.construct.includes(knob.key), `${spec.type}.${knob.key}: construct knob is not in the roster`);
        continue;
      }
      const param = params.get(knob.key);
      assert.ok(param, `${spec.type}.${knob.key}: no AudioParam`);
      assert.equal(param.minValue, knob.min, `${spec.type}.${knob.key}: min`);
      assert.equal(param.maxValue, knob.max, `${spec.type}.${knob.key}: max`);
      assert.equal(param.defaultValue, knob.default, `${spec.type}.${knob.key}: default`);
    }
    const specInputs = spec.inputs.map((p) => p.key);
    assert.deepEqual(specInputs, row.inputs, `${spec.type}: the card's inputs and the roster's must agree`);
    assert.deepEqual(spec.outputs.map((p) => p.key), row.outputs, `${spec.type}: output ORDER is the worklet's index order`);
  }
});

check("LAW L3: an `in_*` param is never a knob, and every input resolves to one or to an audio input", () => {
  for (const row of VC2_PROCESSORS) {
    const names = new Set(row.params.map((p) => p.name));
    const spec = BLOCK_SPECS.find((s) => s.module === row.module);
    const knobKeys = new Set(spec.knobs.map((k) => k.key));
    for (const name of names) {
      if (name.startsWith(VC2_INPUT_PREFIX)) {
        assert.ok(!knobKeys.has(name), `${row.module}: ${name} must not be an Inspector row — its row is the port`);
      }
    }
    for (const port of row.inputs) {
      const isAudio = row.audioInputs.includes(port);
      const isParam = names.has(vc2InputParam(port));
      assert.ok(isAudio !== isParam || isAudio, `${row.module}.${port}: must be exactly one of an audio input or an in_ param`);
      assert.ok(isAudio || isParam, `${row.module}.${port}: neither an audio input nor an in_ param`);
    }
    // A knob and a same-named input are two different params — the law's whole
    // point. `vcvOctave` is the case that proves it.
    for (const knob of spec.knobs) {
      if (row.inputs.includes(knob.key) && !row.audioInputs.includes(knob.key)) {
        assert.ok(names.has(knob.key) || knob.construct || knob.discrete,
          `${row.module}.${knob.key}: knob param missing`);
        assert.ok(names.has(vc2InputParam(knob.key)), `${row.module}.${knob.key}: input param missing`);
      }
    }
  }
});

check("every knob has a row, a help, a default inside its own range, and a defaults leaf", () => {
  for (const spec of BLOCK_SPECS) {
    const defaults = audioKnobDefaults(spec);
    const rows = audioKnobRows(spec);
    assert.equal(rows.length, spec.knobs.length, `${spec.type}: every knob needs an Inspector row`);
    assert.equal(Object.keys(defaults).length, spec.knobs.length, `${spec.type}: every knob needs a default leaf`);
    for (const knob of spec.knobs) {
      assert.ok(knob.help && knob.help.length > 20, `${spec.type}.${knob.key}: no useful help`);
      if (knob.discrete) assert.ok(knob.options.includes(knob.default), `${spec.type}.${knob.key}: default is not an option`);
      else assert.ok(knob.default >= knob.min && knob.default <= knob.max, `${spec.type}.${knob.key}: default outside its range`);
    }
    assert.ok(spec.help && spec.help.length > 40, `${spec.type}: a node needs a help paragraph`);
  }
});

check("THE DRY GUARD: no VC-2 type or module name collides with another block's", () => {
  // By IDENTITY, not by name: once the lead splices BLOCK_SPECS into AUDIO_SPECS
  // every one of these types is legitimately in the shipped list, so comparing
  // strings alone would turn the wiring itself red. What must stay impossible is a
  // SECOND, DIFFERENT spec claiming one of these names.
  const mine = new Set(BLOCK_SPECS);
  const foreign = AUDIO_SPECS.filter((s) => !mine.has(s));
  const types = new Set(foreign.map((s) => s.type));
  const modules = new Set(foreign.map((s) => s.module));
  const seen = new Set();
  for (const spec of BLOCK_SPECS) {
    assert.ok(!types.has(spec.type), `${spec.type} is also claimed by another block`);
    assert.ok(!modules.has(spec.module), `module ${spec.module} is also claimed by another block`);
    assert.ok(!seen.has(spec.type), `${spec.type} declared twice`);
    seen.add(spec.type);
  }
});

check("R7-17: the derivation record names the C++ file, the function and the commit, per kernel", () => {
  // This block follows AX-2's shape (the record is the KERNEL's docblock, and the
  // spec `help` points at it) rather than AX-3's structured `spec.derivation`
  // field — P3_BUILD_BRIEF § 2 asks for the former. So the record is checked
  // where it lives.
  const commits = KERNEL_SOURCE.match(/10dd0160c664770910e5584b7b00498cc48d9ddd|061ccf63c1758599396ac1bb10d47345d9d34076/g);
  assert.ok(commits && commits.length >= 2, "the header must pin both source commits");
  const kernels = [...KERNEL_SOURCE.matchAll(/export class (\w+Kernel)\b/g)].map((m) => m[1]);
  assert.equal(kernels.length, 16, `sixteen kernels, one per node; found ${kernels.length}`);
  for (const name of kernels) {
    const start = KERNEL_SOURCE.lastIndexOf("/**", KERNEL_SOURCE.indexOf(`export class ${name}`));
    const doc = KERNEL_SOURCE.slice(start, KERNEL_SOURCE.indexOf(`export class ${name}`));
    assert.match(doc, /DERIVATION: /, `${name}: no DERIVATION line`);
    assert.match(doc, /\.cpp`?,/, `${name}: the record must name the C++ FILE`);
    assert.match(doc, /::\w+|`\w+::/, `${name}: the record must name the FUNCTION`);
    // The docblock WRAPS, so the hash may sit on the next line behind a ` * `.
    // Matching only `read at <hash>` on one line reds on prose that is correct,
    // which is the same misread as grepping a file for its own documentation.
    assert.match(doc, /read at\s*(?:\*\s*)?(10dd016|061ccf6)/i, `${name}: the record must name the commit it was read at`);
  }
  // And every deviation the header numbers must be referenced somewhere concrete.
  for (let d = 1; d <= 11; d++) {
    assert.match(KERNEL_SOURCE, new RegExp(`D${d}\\.`), `deviation D${d} must be declared`);
  }
});

check("the worklet bridge holds its four structural properties", () => {
  // 1. Every registered name is globally unique and carries the block prefix —
  //    the AudioWorklet global scope is shared across every block's file.
  const names = VC2_PROCESSORS.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, "registered names must be unique");
  for (const name of names) assert.match(name, /^vc2-[a-z0-9-]+-processor$/, `${name}: block prefix`);
  // 2. NO VITE SPECIFIER anywhere in the bare-node import graph. One `?worker&url`
  //    here takes the whole node test lane down (worklet_urls.js owns that).
  // THE PROSE MENTIONS `?worker&url` ON PURPOSE (both files explain why it lives in
  // worklet_urls.js), so the check must look for an IMPORT, not for the string. A
  // grep for the string alone reds on its own documentation — which it did.
  const specifier = /(?:from|import)\s*\(?\s*"[^"]*\?worker/;
  assert.ok(!specifier.test(WORKLET_SOURCE), "a Vite specifier here would break bare node");
  assert.ok(!specifier.test(KERNEL_SOURCE), "and the same for the kernels");
  assert.ok(!WORKLET_SOURCE.includes("BLOCK_WORKLET_URL"), "a block must NOT export its own worklet URL");
  // 3. The processor loop is sample-rate with no k-rate bridge (VC-2 has none) and
  //    calls the kernel exactly once per sample.
  assert.match(WORKLET_SOURCE, /this\.kernel\.sample\(controls, ins, this\.frame\)/, "one kernel call per sample");
  assert.ok(!WORKLET_SOURCE.includes("kernel.control("), "VC-2 has no control-rate half — that is AX-2's shape");
  // 4. An unconnected worklet input is an EMPTY ARRAY, and the loop must handle it
  //    rather than index into it.
  assert.match(WORKLET_SOURCE, /channels\.length > 0 \? channels\[0\]\[i\] : 0/, "an unpatched signal port must read 0 V without throwing");
});

check("the specs point at the kernels, and R7-UNITS is written where a wirer will meet it", () => {
  // A reader who never opens the kernels must still be told what a port carries,
  // because a unit is the one thing a wire cannot show. So the modules whose unit
  // is surprising say it in their own help.
  const quantizer = BLOCK_SPECS.find((s) => s.type === "audio_vcv_quantizer");
  assert.match(quantizer.knobs.find((k) => k.key === "offset").help, /SEMITONES/,
    "a pitch-domain knob must name its unit");
  assert.match(quantizer.knobs.find((k) => k.key === "offset").help, /transposition, not a tuning/,
    "and a transposition must say why it shows no hertz");
  const octave = BLOCK_SPECS.find((s) => s.type === "audio_vcv_octave");
  assert.match(octave.knobs[0].help, /SEMITONES/, "Octave's two units must be distinguished");
  const switch2 = BLOCK_SPECS.find((s) => s.type === "audio_vcv_sequentialswitch2");
  assert.match(switch2.help, /0\.2/, "a gate-threshold module must state its threshold in wire units");
  const audio = BLOCK_SPECS.find((s) => s.type === "audio_vcv_audiointerface");
  assert.match(audio.help, /headroom/, "the boundary node must say what it does now, not what it used to");
  assert.ok(!audio.help.includes("divides by ten"), "and must NOT still claim the /10 the ruling removed");
  // NOTHING in the block may still advertise the adapter the unit law removed.
  for (const spec of BLOCK_SPECS) {
    assert.ok(!/THE ADAPTER/.test(spec.help), `${spec.type}: the x10 adapter was an artefact of the overruled unit scheme`);
  }
  // Every plugin file names the kernels, so "where is the sound" has one answer.
  for (const spec of BLOCK_SPECS) {
    const suffix = PLUGIN_FILES[spec.type];
    const source = readFileSync(join(here, `../plugins/audio_vc2_${suffix}.js`), "utf8");
    assert.match(source, /synth\/vc2_kernels\.js/, `${spec.type}: the wrapper must point at the derivation record`);
    assert.match(source, new RegExp(`from "\\.\\./core/audio_specs_vc2\\.js"`), `${spec.type}: spec import`);
  }
});


console.log(`\nport_vc2_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
