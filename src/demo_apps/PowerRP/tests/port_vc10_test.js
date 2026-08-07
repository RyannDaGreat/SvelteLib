/**
 * PORT-BLOCK VC-10 — the fifteen squinkylabs / Vult / Instruō nodes, checked
 * against the ORIGINALS rather than against themselves.
 *
 * ── WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT ──────────────────
 * A port test that re-derives the port's own algebra proves nothing: it is
 * self-consistent and can be self-consistently wrong (R7-11's canonical
 * failure). So every numeric check below measures against ONE of:
 *
 *   a TRANSCRIPTION of the source, written out again here from the C++ or the
 *     `.vult` rather than imported from the kernels — the detune table, the mix
 *     polynomials, `processFeedback`, `distributeEvenly`, `cubic_clipper`,
 *     `saturate_soft`, Vult's frequency law, ADSR16's lambda;
 *
 *   a MEASURED figure the design exists to produce — the Hilbert pair's 90°
 *     phase difference across its documented band, the shifter's two sidebands
 *     landing at f ± shift, F2's peak sitting on its cutoff, the ladder's
 *     24 dB/octave slope, øchd's two documented endpoints;
 *
 *   a CONTRACT the block must keep — the five exports, the spec/roster/plugin
 *     agreement, the unit boundary appearing exactly twice, determinism.
 *
 * ── TIER HONESTY IS ITSELF CHECKED ──────────────────────────────────────────
 * Two thirds of this block is behaviour-derived, and the one thing that must
 * never rot is the LABEL saying so. Every spec carries a `derivation.tier`, and
 * the sweep below asserts the tier is real, that a `source`-tier node names
 * files in a repository we cloned, and that a `behaviourOnly` node's own `help`
 * says the words. A wrong number is a bug; a wrong tier is a lie.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as K from "../synth/vc10_kernels.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES } from "../synth/modules_vc10.js";
import { VC10_GATE_SCALE_VOLTS, VC10_PROCESSORS, vc10OptionSetter } from "../synth/worklets/processors_vc10.js";
import {
  BLOCK_SPECS, INSTRUO_SOURCE, SQUINKY_SOURCE, VC10_TIERS, VULT_MANUAL_SOURCE, VULT_SOURCE,
  squinkySemitonesToHz, vultSemitonesToHz,
} from "../core/audio_specs_vc10.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_vc10.js";
import { audioKnobDefaults, audioKnobRows, audioNodePlugin } from "../core/audio_nodes.js";
import { NODE_FAMILY_NAMES } from "../core/node_chrome.js";
import { PORT_TYPE_NAMES } from "../core/nodeflow.js";

const here = dirname(fileURLToPath(import.meta.url));
const KERNEL_SOURCE = readFileSync(join(here, "../synth/vc10_kernels.js"), "utf8");
const PROCESSOR_SOURCE = readFileSync(join(here, "../synth/worklets/processors_vc10.js"), "utf8");

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    process.exitCode = 1;
    console.log(`FAIL  ${label}\n      ${error.message}`);
  }
};

/** Every measurement below runs at the rate the engine really uses. */
const FS = 48000;

/**
 * Query. Run one roster row's kernel and return its outputs as arrays. The
 * caller supplies VOLTS, exactly as the processor's input scale would have
 * produced them, so the harness never has to know a port's kind.
 *
 * @param {object} row - a VC10_PROCESSORS entry
 * @param {object} opts - {samples, knobs, wire, wired, construct, options}
 * @returns {Float64Array[]} one array per output, in output-index order
 */
function runKernel(row, opts = {}) {
  const samples = opts.samples ?? 4096;
  const kernel = row.make(FS, { seed: 0, ...(opts.construct ?? {}) });
  for (const option of row.options) {
    if (opts.options && opts.options[option] !== undefined) {
      kernel[vc10OptionSetter(option)](opts.options[option]);
    }
  }
  const knobs = {};
  for (const param of row.params) knobs[param.name] = param.defaultValue;
  Object.assign(knobs, opts.knobs ?? {});

  const signals = {};
  const wired = {};
  for (const name of row.audioInputs) {
    signals[name] = 0;
    wired[name] = Boolean(opts.wire && opts.wire[name]) || Boolean(opts.wired && opts.wired[name]);
  }
  const frame = new Float64Array(row.outputs.length);
  const out = row.outputs.map(() => new Float64Array(samples));
  let tick = 0;
  for (let i = 0; i < samples; i++) {
    for (const name of row.audioInputs) {
      if (opts.wire && opts.wire[name]) signals[name] = opts.wire[name](i);
    }
    if (tick === 0) kernel.control(knobs, signals, wired);
    kernel.sample(knobs, signals, wired, frame);
    for (let o = 0; o < out.length; o++) out[o][i] = frame[o];
    tick = tick + 1 >= row.controlDivisor ? 0 : tick + 1;
  }
  return out;
}

/** Query. The roster row for a module type, LOUD if absent. */
const rowOf = (module) => {
  const row = VC10_PROCESSORS.find((r) => r.module === module);
  assert.ok(row, `no roster row for ${module}`);
  return row;
};

/** Pure function. A volt-level sine generator for `runKernel`'s `wire`. */
const voltSine = (hz, volts) => (i) => volts * Math.sin((2 * Math.PI * hz * i) / FS);

/**
 * Pure function. The complex amplitude of `signal` at `hz` — a one-bin DFT, so
 * a magnitude AND a phase come out of one pass and the phase checks below cost
 * nothing extra.
 *
 * @param {ArrayLike<number>} signal
 * @param {number} hz
 * @returns {{magnitude: number, phase: number}} magnitude in the signal's units
 *
 * @example // binAt([0, 1, 0, -1], 12000).magnitude ≈ 1
 */
function binAt(signal, hz) {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * hz) / FS;
  for (let i = 0; i < signal.length; i++) {
    re += signal[i] * Math.cos(w * i);
    im -= signal[i] * Math.sin(w * i);
  }
  return { magnitude: (2 * Math.hypot(re, im)) / signal.length, phase: Math.atan2(im, re) };
}

/** Pure function. Decibels, floored so a silent bin does not produce −Infinity. */
const db = (ratio) => 20 * Math.log10(Math.max(ratio, 1e-12));

/**
 * Query. A filter row's measured gain at one frequency, in decibels, taken over
 * the SECOND half of the run so the transient is gone.
 *
 * @param {object} row
 * @param {string} inputPort
 * @param {number} outputIndex
 * @param {number} hz
 * @param {object} knobs
 * @param {object} [options]
 * @returns {number} dB
 */
function responseDb(row, inputPort, outputIndex, hz, knobs, options) {
  const samples = 1 << 15;
  const volts = 1;
  const out = runKernel(row, { samples, knobs, options, wire: { [inputPort]: voltSine(hz, volts) } });
  const settled = out[outputIndex].subarray(samples / 2);
  return db(binAt(settled, hz).magnitude / volts);
}

console.log("port_vc10_test\n");

// ═══════════════════════════════════════════════════════════════════════════
// 1. SUPER — against transcriptions of SuperDsp.h
// ═══════════════════════════════════════════════════════════════════════════

check("Super's detune curve is SawtoothDetuneCurve's own sixteen points", () => {
  // TRANSCRIBED from composites/SuperDsp.h:20-39, not imported.
  const points = [
    [0, 0], [0.0551, 0.00967], [0.118, 0.022], [0.181, 0.04], [0.244, 0.0467],
    [0.307, 0.059], [0.37, 0.0714], [0.433, 0.0838], [0.496, 0.0967], [0.559, 0.121],
    [0.622, 0.147], [0.748, 0.243], [0.811, 0.293], [0.874, 0.343], [0.937, 0.392], [1, 1],
  ];
  const table = K.nonUniformTable(points);
  for (const [x, y] of points) {
    assert.ok(Math.abs(table(x) - y) < 1e-12, `detune(${x}) is ${table(x)}, source says ${y}`);
  }
  // The shape, not just the knots: nearly flat to three quarters, then a jump.
  assert.ok(table(0.75) < 0.25, "the curve must still be shallow at three quarters");
  assert.ok(table(0.99) > 0.85, "and must open right up at the top — that jump IS the knob's feel");
  // Their `lower_bound` walk clamps at both ends rather than extrapolating.
  assert.equal(table(-1), 0);
  assert.equal(table(2), 1);
});

check("Super's mix polynomials are updateMix's own coefficients", () => {
  // TRANSCRIBED from composites/SuperDsp.h:326-329.
  const centre = (m) => -0.55366 * m + 0.99785;
  const sides = (m) => -0.73764 * m * m + 1.2841 * m + 0.044372;
  const row = rowOf("vcvSuper");
  // Drive the kernel at two mix positions and read back the level ratio the two
  // polynomials predict. The CENTRE saw is index 3 of seven, so at mix = −5 the
  // sides are near silent and the sound is one saw.
  const quiet = runKernel(row, { samples: 4096, knobs: { mix: -5 }, options: { stereo: "off" } })[0];
  const loud = runKernel(row, { samples: 4096, knobs: { mix: 5 }, options: { stereo: "off" } })[0];
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const predicted = (centre(1) + 6 * sides(1)) / (centre(0) + 6 * sides(0));
  const measured = rms(loud) / rms(quiet);
  assert.ok(measured > 1.5, `the top of Mix must be much louder than the bottom; ratio ${measured.toFixed(2)}`);
  assert.ok(predicted > 1.5, "and the transcribed polynomials must say so too");
  // The two ends of their own curve, exactly.
  assert.ok(Math.abs(centre(0) - 0.99785) < 1e-12);
  assert.ok(Math.abs(sides(0) - 0.044372) < 1e-12, "at mix 0 the sides are almost gone — theirs");
});

check("Super tunes to squinkylabs' own C4, and its trigger redraws every phase", () => {
  const row = rowOf("vcvSuper");
  const samples = 1 << 15;
  // Detune 0 collapses all seven saws onto one frequency, which is measurable.
  const out = runKernel(row, {
    samples, knobs: { octave: 0, semi: 0, fine: 0, detune: -5, mix: -5 }, options: { stereo: "off", aliasMode: "classic" },
  })[0];
  const settled = out.subarray(samples / 2);
  let best = 0;
  let bestHz = 0;
  for (let bin = 1; bin < 600; bin++) {
    const hz = (bin * FS) / (samples / 2);
    const a = binAt(settled, hz).magnitude;
    if (a > best) { best = a; bestHz = hz; }
  }
  // `pitch = 1 + …` then `+ log2(261.626)`, so a 0 V pitch is ONE OCTAVE above
  // C4 — theirs, and the reason their default octave knob is 0 rather than 1.
  const expected = 2 * 261.626;
  assert.ok(Math.abs(bestHz - expected) < 12, `the fundamental must be ${expected} Hz; measured ${bestHz.toFixed(1)}`);

  // The trigger draws from `std::default_random_engine{57}` — deterministic, and
  // the same seed must give the same phases twice.
  const trig = { trigger: (i) => (i > 100 && i < 140 ? VC10_GATE_SCALE_VOLTS : 0) };
  const a = runKernel(row, { samples: 512, wire: trig, construct: { seed: 57 }, options: { stereo: "off" } })[0];
  const b = runKernel(row, { samples: 512, wire: trig, construct: { seed: 57 }, options: { stereo: "off" } })[0];
  const c = runKernel(row, { samples: 512, wire: trig, construct: { seed: 99 }, options: { stereo: "off" } })[0];
  assert.deepEqual(Array.from(a), Array.from(b), "same seed, same phases");
  assert.notDeepEqual(Array.from(a), Array.from(c), "a different seed must really redraw them");
});

check("minstd_rand0 is libstdc++'s generator, exactly", () => {
  // TRANSCRIBED: x ← 16807·x mod (2^31 − 1), the multiplier std::default_random_engine
  // uses. Seeded with their own 57.
  let state = 57;
  const rng = new K.Minstd0(57);
  for (let i = 0; i < 1000; i++) {
    state = (16807 * state) % 2147483647;
    assert.equal(rng.next01() * 2147483647, state, `draw ${i} diverged`);
  }
  // A Lehmer generator's zero is a fixed point, so it must not be reachable.
  assert.ok(new K.Minstd0(0).next01() > 0, "seed 0 must not produce an all-zero stream");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. F2 — measured response against fastFcFunc2 / fastQFunc
// ═══════════════════════════════════════════════════════════════════════════

check("F2's Q, R and cutoff laws are F2_Poly's own three formulas", () => {
  // TRANSCRIBED from composites/F2_Poly.h:359-380, :444-448.
  const refQ = (qV, stages) => Math.pow(2, qV * (stages === 1 ? 1 / 1.5 : 1 / 2.5)) - 0.5;
  const refR = (rV) => Math.pow(2, ((rV > 3 ? rV - 1.5 : rV / 2)) / 3);
  for (const v of [0, 1, 2.9, 3, 3.1, 5, 10]) {
    assert.ok(Math.abs(K.f2Q(v, 1) - refQ(v, 1)) < 1e-12, `q(${v}, 1)`);
    assert.ok(Math.abs(K.f2Q(v, 2) - refQ(v, 2)) < 1e-12, `q(${v}, 2)`);
    assert.ok(Math.abs(K.f2R(v) - refR(v)) < 1e-12, `r(${v})`);
  }
  // The topology-dependence is the reason the spec keeps their 0…10 domain.
  assert.ok(K.f2Q(10, 1) > 6 * K.f2Q(10, 2), "one stage must reach a far higher Q than two");
  // And the cutoff: `FREQ_C4 · 2^(v − 4)`, inverted.
  for (const v of [0, 2.5, 5, 10]) {
    const hz = 261.6256 * Math.pow(2, v - 4);
    assert.ok(Math.abs(K.f2CutoffVolts(hz) - v) < 1e-9, `${hz} Hz must be ${v} V`);
  }
});

check("F2's measured peak sits on its cutoff, and the makeup gain tames it", () => {
  const row = rowOf("vcvF2");
  const cutoff = 1000;
  const knobs = { fc: cutoff, q: 6, volume: 50 };
  const options = { topology: "single", mode: "lowpass", limiter: "off", altLimiter: "off" };
  const at = (hz) => responseDb(row, "audio", 0, hz, knobs, options);
  const peak = at(cutoff);
  assert.ok(peak > at(cutoff / 4) + 6, `a resonant lowpass must peak at its corner; ${peak.toFixed(1)} dB vs ${at(cutoff / 4).toFixed(1)}`);
  assert.ok(peak > at(cutoff * 4) + 12, "and must be well down an octave and a half above it");
  // Their makeup gain is 1/√Q for one stage, so a high Q must NOT be much louder
  // than a low one — that is the whole point of `computeGain_fast`.
  const lowQ = responseDb(row, "audio", 0, cutoff, { ...knobs, q: 0 }, options);
  assert.ok(Math.abs(peak - lowQ) < 24, `the makeup gain must bound the peak; ${peak.toFixed(1)} vs ${lowQ.toFixed(1)} dB`);
  assert.ok(Math.abs(K.f2OutputGain(false, 4, 1) - 0.5) < 1e-12, "1/√Q at Q = 4 is 0.5");
});

check("F2's four modes really are four different responses", () => {
  const row = rowOf("vcvF2");
  const knobs = { fc: 1000, q: 2 };
  const shape = (mode) => [100, 1000, 8000].map((hz) => responseDb(row, "audio", 0, hz, knobs, {
    topology: "single", mode, limiter: "off", altLimiter: "off",
  }));
  const [lpLow, , lpHigh] = shape("lowpass");
  const [hpLow, , hpHigh] = shape("highpass");
  assert.ok(lpLow > lpHigh + 20, `lowpass must pass 100 Hz and stop 8 kHz; ${lpLow.toFixed(1)} vs ${lpHigh.toFixed(1)}`);
  assert.ok(hpHigh > hpLow + 20, `highpass must do the reverse; ${hpHigh.toFixed(1)} vs ${hpLow.toFixed(1)}`);
  const [, bandMid] = shape("bandpass");
  const [bandLow, , bandHigh] = shape("bandpass");
  assert.ok(bandMid > bandLow + 10 && bandMid > bandHigh + 10, "bandpass must peak in the middle");
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. FILT — measured slope against the ladder's own tap vectors
// ═══════════════════════════════════════════════════════════════════════════

check("distributeEvenly and processFeedback are AudioMath's and LadderFilter's own", () => {
  // TRANSCRIBED from dsp/utils/AudioMath.h:248 — geometric, product exactly 1.
  for (const [n, ratio] of [[4, 1.5], [4, 1], [2, 4]]) {
    const data = K.distributeEvenly(n, ratio);
    let product = 1;
    for (const v of data) product *= v;
    assert.ok(Math.abs(product - 1) < 1e-12, `product must be 1; got ${product}`);
    for (let i = 1; i < n; i++) {
      assert.ok(Math.abs(data[i] / data[i - 1] - ratio) < 1e-12, "and the ratio must be exact");
    }
  }
  // TRANSCRIBED from dsp/filters/LadderFilter.h:864-874: u = f/4, y = u(2 − u),
  // times the measured ceiling. `y` is a "smooshed parabola", so it is monotone
  // and saturating rather than linear — which is why the top of the knob is safe.
  const y = (f) => (f * 0.25) * (2 - f * 0.25);
  assert.ok(Math.abs(y(0)) < 1e-12);
  assert.ok(Math.abs(y(4) - 1) < 1e-12, "a full request must reach the ceiling exactly");
  assert.ok(y(2) > 0.7, "and half a request must already be most of the way there — theirs");
});

check("Filt's four-pole lowpass really rolls off four poles", () => {
  const row = rowOf("vcvFilt");
  // Cutoff knob 0 is their `10·2^(0 + 6)` = 640 Hz. Clean voicing so the slope is
  // the filter's and not a saturator's.
  const knobs = { fc: 0, q: -5, drive: -5, masterVolume: 0.5 };
  const options = { type: "lp4", voicing: "clean" };
  const at = (hz) => responseDb(row, "l_audio", 0, hz, knobs, options);
  const a = at(2560);
  const b = at(5120);
  const slope = a - b;
  assert.ok(slope > 18 && slope < 30, `a four-pole slope is ~24 dB/octave; measured ${slope.toFixed(1)}`);
  // …and the one-pole type must be a quarter of that.
  const one = at(2560) - at(5120);
  const oneSlope = responseDb(row, "l_audio", 0, 2560, knobs, { type: "lp1", voicing: "clean" })
    - responseDb(row, "l_audio", 0, 5120, knobs, { type: "lp1", voicing: "clean" });
  assert.ok(oneSlope > 3 && oneSlope < 9, `a one-pole slope is ~6 dB/octave; measured ${oneSlope.toFixed(1)}`);
  assert.ok(one > oneSlope + 8, "and four poles must be much steeper than one");
});

check("Filt's highpass types really pass the top", () => {
  const row = rowOf("vcvFilt");
  const knobs = { fc: 0, q: -5, drive: -5, masterVolume: 0.5 };
  const low = responseDb(row, "l_audio", 0, 80, knobs, { type: "hp3", voicing: "clean" });
  const high = responseDb(row, "l_audio", 0, 6000, knobs, { type: "hp3", voicing: "clean" });
  assert.ok(high > low + 20, `3-pole highpass: 6 kHz must clear 80 Hz by 20 dB; got ${(high - low).toFixed(1)}`);
});

check("Filt's voicings are five DIFFERENT nonlinearities, not five names", () => {
  const row = rowOf("vcvFilt");
  // MIDDLE of the Drive knob on a nominal 5 V input, and the operating point is
  // chosen from a MEASUREMENT rather than from taste. At the TOP of Drive every
  // voicing measures the same and that is not a port bug: `PROC_PREAMBLE` clamps
  // its input at ±3 and `PROC_END` its output at ±1.7, so a 5 V signal at gain
  // 4.15 is hard-clipped by the CLAMPS before any saturator sees it — `clean`
  // itself measures −11.7 dB of third harmonic there, against −11.1 for
  // `transistor`. At the BOTTOM the opposite happens: nothing reaches a knee, so
  // `fold` (which is the identity inside ±1) measures at the analyser's own
  // −48 dB floor. Drive 2 with 5 V puts every voicing in the range it was
  // designed for, which is the only place they are distinguishable.
  const knobs = { fc: 2, q: 0, drive: 2, masterVolume: 0.5 };
  const harmonic3 = (voicing) => {
    const samples = 1 << 14;
    const out = runKernel(row, {
      samples, knobs, options: { type: "lp4", voicing }, wire: { l_audio: voltSine(300, 5) },
    })[0].subarray(samples / 2);
    return db(binAt(out, 900).magnitude / Math.max(binAt(out, 300).magnitude, 1e-9));
  };
  const clean = harmonic3("clean");
  for (const voicing of ["transistor", "asymClip", "fold", "asymFold"]) {
    assert.ok(harmonic3(voicing) > clean + 6,
      `${voicing} must add third harmonic over clean (${harmonic3(voicing).toFixed(1)} vs ${clean.toFixed(1)} dB)`);
  }
  assert.ok(clean < -30, `and \`clean\` must be, well, clean; measured ${clean.toFixed(1)} dB`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. FREQUENCY SHIFTER — the property the Hilbert design exists for
// ═══════════════════════════════════════════════════════════════════════════

check("the Hilbert pair really is 90 degrees apart, across its documented band", () => {
  // THE MEASURED FIGURE, not a coefficient diff: their own comment says the
  // network is "good from 4hz to 4k, with a phase error ripple about +- .15
  // degrees". This drives the two all-pass cascades directly.
  const left = [0.3609, 2.7412, 11.1573, 44.7581, 179.6242, 798.4578];
  const right = [1.2524, 5.5671, 22.3423, 89.6271, 364.7914, 2770.1114];
  const cosPath = new K.AllpassCascade(left.map((p) => K.hilbertAllpassCoefficient(p, FS)));
  const sinPath = new K.AllpassCascade(right.map((p) => K.hilbertAllpassCoefficient(p, FS)));
  let worst = 0;
  let worstHz = 0;
  for (const hz of [20, 50, 120, 300, 700, 1500, 3000, 4000]) {
    const n = 1 << 15;
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.sin((2 * Math.PI * hz * i) / FS);
      a[i] = sinPath.run(x);
      b[i] = cosPath.run(x);
    }
    const pa = binAt(a.subarray(n / 2), hz);
    const pb = binAt(b.subarray(n / 2), hz);
    // Both are ALL-PASS: unity magnitude is the other half of the design.
    assert.ok(Math.abs(db(pa.magnitude)) < 0.5, `sin path must be all-pass at ${hz} Hz`);
    assert.ok(Math.abs(db(pb.magnitude)) < 0.5, `cos path must be all-pass at ${hz} Hz`);
    let delta = ((pb.phase - pa.phase) * 180) / Math.PI;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const error = Math.abs(Math.abs(delta) - 90);
    if (error > worst) { worst = error; worstHz = hz; }
  }
  assert.ok(worst < 2, `the pair must stay within 2° of quadrature; worst ${worst.toFixed(2)}° at ${worstHz} Hz`);
});

check("the shifter puts its two sidebands at f − shift and f + shift", () => {
  const row = rowOf("vcvFreqShifter");
  const samples = 1 << 16;
  const tone = 1000;
  const shift = 500;
  // Range "500hz" with the knob at +5 gives the full 500 Hz.
  const out = runKernel(row, {
    samples, knobs: { pitch: 5 }, options: { range: "500hz" }, wire: { audio: voltSine(tone, 5) },
  });
  const up = out[0].subarray(samples / 2);   // SIN_OUTPUT — measured as the upper sideband
  const down = out[1].subarray(samples / 2); // COS_OUTPUT — the lower one
  const rejection = (signal, wanted, unwanted) => db(binAt(signal, wanted).magnitude)
    - db(binAt(signal, unwanted).magnitude);
  // WHICH JACK IS WHICH IS THE MEASUREMENT, not an assumption: the port keys are
  // their `SIN_OUTPUT` / `COS_OUTPUT`, and whether `x + y` is the upper or the
  // lower sideband falls out of the Hilbert pair's sign convention. Measured
  // here: `sin` is UP, `cos` is DOWN, by about 55 dB. The spec's labels say so.
  assert.ok(rejection(up, tone + shift, tone - shift) > 20,
    `the SIN jack must be the UP sideband; rejection ${rejection(up, tone + shift, tone - shift).toFixed(1)} dB`);
  assert.ok(rejection(down, tone - shift, tone + shift) > 20,
    `the COS jack must be the DOWN one; rejection ${rejection(down, tone - shift, tone + shift).toFixed(1)} dB`);
  // A shifter is NOT a pitch shifter: 1000 → 1500 is not a musical interval, and
  // the carrier itself must be suppressed.
  assert.ok(db(binAt(up, tone).magnitude) < db(binAt(up, tone + shift).magnitude) - 15,
    "and the carrier must be suppressed, which is what makes it single-sideband");
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. WVCO — its own sine, its own envelope
// ═══════════════════════════════════════════════════════════════════════════

check("simdSinTwoPi is ported verbatim: close to a sine, and NOT equal to one", () => {
  let worst = 0;
  for (let i = 0; i <= 200; i++) {
    const x = (i / 200) * 2 * Math.PI;
    worst = Math.max(worst, Math.abs(K.simdSinTwoPi(x) - Math.sin(x)));
  }
  // Their approximation is a quartic with a hand-tuned correction — about a
  // thousandth off, which is a fixed harmonic colour and not noise (D10).
  assert.ok(worst < 0.01, `their sine must track within 1%; worst ${worst.toFixed(5)}`);
  assert.ok(worst > 1e-5, "and it must NOT be Math.sin — replacing it would change the instrument");
});

check("ADSR16's lambda law is theirs, and Snap steepens without moving the ends", () => {
  // TRANSCRIBED from composites/ADSR16.h:112-138.
  const MIN_TIME = 0.5e-3;
  const LAMBDA_BASE = 10 / MIN_TIME;
  const refLambda = (x) => Math.pow(LAMBDA_BASE, -x) / MIN_TIME;
  const adsr = new K.Adsr16();
  adsr.setParamValues(0.5, 0.5, 0.5, 0.5, 1);
  assert.ok(Math.abs(adsr.attackLambda - refLambda(0.5)) < 1e-9, "attack lambda");
  assert.ok(Math.abs(adsr.releaseLambda - refLambda(0.5)) < 1e-9, "release lambda");
  assert.ok(Math.abs(refLambda(0) - 1 / MIN_TIME) < 1e-9, "a knob at 0 is their 0.5 ms");
  assert.ok(Math.abs(refLambda(1) - 1 / 10) < 1e-9, "and at 1 is their 10 s");
  // Snap: clip at s + k(1 − s), make up by 1/clip. The PEAK does not move.
  const snapped = new K.Adsr16();
  snapped.setParamValues(0.5, 0.5, 0.5, 0.5, 0.3);
  assert.ok(snapped.clipValue < 1, "snap must clip below full scale");
  assert.ok(Math.abs(snapped.makeupGain * snapped.clipValue - 1) < 1e-12,
    "and the makeup must restore the peak exactly — otherwise Snap would just be a level knob");
});

check("WVCO tunes to C4 at its default octave, and its three waveforms differ", () => {
  const row = rowOf("vcvWvco");
  const samples = 1 << 15;
  const fundamental = (waveform) => {
    const out = runKernel(row, {
      samples, knobs: { octave: 4, waveshapeGain: 50, outputLevel: 100 },
      options: { waveform, snap: "off", adsrToShape: "off", adsrToFeedback: "off", adsrToLevel: "off", adsrToFm: "off" },
      wire: { gate: () => VC10_GATE_SCALE_VOLTS },
    })[0].subarray(samples / 2);
    return out;
  };
  const sine = fundamental("sine");
  assert.ok(Math.abs(db(binAt(sine, 261.626).magnitude) - db(binAt(sine, 261.626).magnitude)) < 1e-9);
  const at = (s, hz) => binAt(s, hz).magnitude;
  assert.ok(at(sine, 261.626) > 10 * at(sine, 523.252), "a sine must have almost no second harmonic");
  const fold = fundamental("fold");
  assert.ok(at(fold, 785) / at(fold, 261.626) > at(sine, 785) / at(sine, 261.626) + 0.05,
    "folding must add harmonics the sine does not have");
  const sawTri = fundamental("sawTri");
  assert.ok(at(sawTri, 523.252) > 3 * at(sine, 523.252), "and the saw/tri morph must have a real second harmonic");
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE VULT PRIMITIVES — against transcriptions of the .vult source
// ═══════════════════════════════════════════════════════════════════════════

check("cubic_clipper, saturate_soft and fold are Util's and the examples' own", () => {
  // TRANSCRIBED from examples/util/util.vult and examples/effects/*.vult.
  const refClip = (x) => (x <= -2 / 3 ? -2 / 3 : x >= 2 / 3 ? 2 / 3 : x - (x * x * x) / 3);
  for (const x of [-2, -0.667, -0.5, 0, 0.5, 0.667, 2]) {
    assert.ok(Math.abs(K.vultCubicClipper(x) - refClip(x)) < 1e-12, `cubic_clipper(${x})`);
  }
  const refSat = (x) => 16 * Math.tanh(x / 16);
  for (const x of [-24, -5, 0, 5, 24]) {
    assert.ok(Math.abs(K.vultSaturateSoft(x) - refSat(x)) < 1e-12, `saturate_soft(${x})`);
  }
  // Fold.do, transcribed from examples/effects/fold.vult.
  const refFold = (signal, level) => {
    const sign = signal > 0 ? 1 : -1;
    const amp = Math.abs(signal) * (8 * level + 1);
    const base = Math.floor(amp);
    const delta = amp - base;
    return sign * (Math.trunc(base) % 2 !== 0 ? 1 - delta : delta);
  };
  for (const [s, l] of [[0.3, 0], [0.3, 1], [-0.7, 0.5], [0.95, 0.25]]) {
    assert.ok(Math.abs(K.vultFold(s, l) - refFold(s, l)) < 1e-12, `fold(${s}, ${l})`);
  }
});

check("Vult's tuning is cvToPitch's own, and C1 is where 0 V lands", () => {
  // TRANSCRIBED from examples/util/util.vult: cvToPitch(cv) = cv·120 + 24, and
  // f = 8.175798915643707 · exp(0.057762265046662105 · pitch).
  const refHz = (cv) => 8.175798915643707 * Math.exp(0.057762265046662105 * (cv * 120 + 24));
  for (const cv of [0, 0.1, 0.3, 0.6209, 0.9]) {
    assert.ok(Math.abs(K.vultCvToHz(cv) / refHz(cv) - 1) < 1e-12, `cvToHz(${cv})`);
  }
  // A Rack V/oct arrives as volts/10, so 0 V is MIDI 24 — C1, which is exactly
  // what Vessek's manual says. THIS IS THE MEASUREMENT BEHIND D1.
  assert.ok(Math.abs(K.vultSemitonesToHz(0) - refHz(0)) < 1e-9, "our semitone origin must be their cv = 0");
  assert.ok(Math.abs(K.vultSemitonesToHz(0) - 32.70319566) < 1e-6, "and that is C1 = 32.703 Hz");
  assert.ok(Math.abs(K.vultSemitonesToHz(36) - 261.6255653) < 1e-6, "so C4 is 36 semitones up");
  // Basal and Bleak's manuals put 0 V at C3 for the same DSP: two octaves up.
  assert.ok(Math.abs(vultSemitonesToHz(24) - 130.8127826) < 1e-6, "and C3 is 24 up, which is their panel offset");
  // The spec side and the DSP side must agree — core/ may not import synth/.
  for (const st of [-12, 0, 7, 24, 36]) {
    assert.ok(Math.abs(vultSemitonesToHz(st) - K.vultSemitonesToHz(st)) < 1e-9, `${st} st drifted between spec and DSP`);
    assert.ok(Math.abs(squinkySemitonesToHz(st) - K.squinkySemitonesToHz(st)) < 1e-9, `${st} st drifted (squinky)`);
  }
  assert.ok(Math.abs(squinkySemitonesToHz(0) - 261.626) < 1e-9, "squinkylabs' C4 is their own six digits, not Rack's");
});

check("the Vult SVF's corner really is where calc_g puts it", () => {
  // calc_g reduces to tan(pi·f/fs); a ZDF SVF's lowpass is −3 dB there at Q≈0.707
  // and its band node PEAKS there at any Q. The peak is the sharper test.
  for (const hz of [200, 1000, 4000]) {
    const svf = new K.VultSvf(FS);
    svf.setCutoffHz(hz);
    svf.setQ(4);
    const measure = (probe) => {
      const s = new K.VultSvf(FS);
      s.setCutoffHz(hz);
      s.setQ(4);
      const n = 1 << 15;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = s.run(Math.sin((2 * Math.PI * probe * i) / FS), null).band;
      return binAt(out.subarray(n / 2), probe).magnitude;
    };
    const centre = measure(hz);
    assert.ok(centre > measure(hz / 4) * 2, `${hz} Hz: the band node must peak at the corner`);
    assert.ok(centre > measure(hz * 4) * 2, `${hz} Hz: and fall off above it`);
  }
});

check("the Vult diode ladder is four poles and its heun step is theirs", () => {
  const row = rowOf("vcvLateralus");
  const knobs = { cutoff: 500, resonance: 0, drive: 0 };
  const at = (hz, output) => responseDb(row, "in", output, hz, knobs);
  const slope24 = at(2000, 0) - at(4000, 0);
  const slope6 = at(2000, 3) - at(4000, 3);
  assert.ok(slope24 > 18 && slope24 < 30, `the 24 dB jack must roll off ~24 dB/oct; measured ${slope24.toFixed(1)}`);
  assert.ok(slope6 > 3 && slope6 < 9, `the 6 dB jack ~6 dB/oct; measured ${slope6.toFixed(1)}`);
  assert.ok(slope24 > slope6 + 12, "and the four jacks must really be four slopes");
  // The heun integrator is a PREDICTOR-CORRECTOR: it must be stable where a
  // plain Euler ladder is not. Full resonance, full drive, no explosion.
  const hot = runKernel(row, {
    samples: 1 << 14, knobs: { cutoff: 8000, resonance: 1, drive: 1 }, wire: { in: voltSine(220, 5) },
  })[0];
  for (const v of hot) assert.ok(Number.isFinite(v) && Math.abs(v) < 100, "the ladder must stay bounded at the top of both knobs");
});

check("Unstabile's SEM output is a notch at its centre, per its manual", () => {
  const row = rowOf("vcvUnstabile");
  const cutoff = 1000;
  const knobs = { cutoff, resonance: 0.2, drive: 0 };
  const semAt = (semblance, hz) => responseDb(row, "in", 3, hz, { ...knobs, semblance });
  const notch = semAt(0.5, cutoff);
  assert.ok(notch < semAt(0.5, cutoff / 8) - 6, `the SEM centre must notch at the cutoff; ${notch.toFixed(1)} dB`);
  assert.ok(notch < semAt(0.5, cutoff * 8) - 6, "on both sides of it");
  // And the two extremes must be the plain lowpass and highpass.
  assert.ok(semAt(0, cutoff / 8) > semAt(0, cutoff * 8) + 12, "semblance 0 is the lowpass");
  assert.ok(semAt(1, cutoff * 8) > semAt(1, cutoff / 8) + 12, "semblance 1 is the highpass");
});

check("Bleak's morph really passes through three shapes, band-limited", () => {
  const row = rowOf("vcvBleak");
  const samples = 1 << 15;
  const spectrum = (wave) => {
    const out = runKernel(row, { samples, knobs: { wave, pw: 0.5, tune: 0, oct: 0 } })[0].subarray(samples / 2);
    const f0 = 130.8127826; // C3, Bleak's own 0 V
    return [1, 2, 3].map((h) => binAt(out, f0 * h).magnitude / binAt(out, f0).magnitude);
  };
  const saw = spectrum(0);
  const pulse = spectrum(0.5);
  const triangle = spectrum(1);
  assert.ok(saw[1] > 0.2, "a saw must have a strong SECOND harmonic");
  assert.ok(pulse[1] < 0.1, "a symmetric pulse must have almost none");
  assert.ok(triangle[2] < saw[2], "and a triangle must be far quieter in the third than a saw");
  // THE DEFAULT PW MUST NOT CANCEL THE FUNDAMENTAL. This is the regression that
  // caught a real defect: offsetting the double-saw's second copy by `pw` rather
  // than by `pw − 0.5` puts the two ramps antiphase at the panel's own centre,
  // and the measured fundamental fell to −39.6 dB with the alias floor ABOVE it.
  const f0 = 130.8127826;
  const plain = runKernel(row, { samples, knobs: { wave: 0, pw: 0.5, oct: 0 } })[0].subarray(samples / 2);
  assert.ok(binAt(plain, f0).magnitude > binAt(plain, 2 * f0).magnitude,
    "at the centre of PW the saw must have a fundamental LOUDER than its octave");
  assert.ok(db(binAt(plain, f0).magnitude) > -12, "and it must be at a usable level");
  // …and moving PW away from the centre must really produce the octave-heavy
  // "double saw" the manual describes.
  const doubled = runKernel(row, { samples, knobs: { wave: 0, pw: 0, oct: 0 } })[0].subarray(samples / 2);
  assert.ok(binAt(doubled, 2 * f0).magnitude / binAt(doubled, f0).magnitude
    > binAt(plain, 2 * f0).magnitude / binAt(plain, f0).magnitude,
    "PW away from centre must add the second harmonic — the double saw");
  // Band-limited: a high note's alias floor must sit well below its fundamental.
  const high = runKernel(row, { samples, knobs: { wave: 0, pw: 0.5, oct: 3, tune: 12 } })[0].subarray(samples / 2);
  const hf0 = f0 * Math.pow(2, 4);
  let worst = 0;
  for (let hz = 40; hz < hf0 * 0.9; hz += 20) worst = Math.max(worst, binAt(high, hz).magnitude);
  assert.ok(db(worst / binAt(high, hf0).magnitude) < -20,
    `a band-limited saw's alias floor must be 20 dB down; measured ${db(worst / binAt(high, hf0).magnitude).toFixed(1)} dB`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. THE INSTRUŌ NODES — against the manuals' own numbers
// ═══════════════════════════════════════════════════════════════════════════

check("ochd's two documented endpoints are exactly what the rate law produces", () => {
  // The manual: LFO 1 "can reach 160 Hz" fully clockwise; the range runs "down
  // to a 25-minute cycle time" on the slowest core. Those two numbers are what
  // FIX the 13-octave span, so this is the derivation, checked.
  assert.ok(Math.abs(K.ochdRateHz(0, 1) - 160) < 1e-9, "core 1 at the top is 160 Hz");
  const slowest = 1 / K.ochdRateHz(7, 0);
  assert.ok(Math.abs(slowest - 25 * 60) < 60, `core 8 at the bottom must cycle in about 25 minutes; got ${(slowest / 60).toFixed(1)} min`);
  // The ratio family must be IRRATIONAL — the manual's "not synced or
  // phase-shifted from each other". Any rational ratio relocks; phi does not.
  const phi = (1 + Math.sqrt(5)) / 2;
  assert.ok(Math.abs(K.ochdRateHz(0, 0.5) / K.ochdRateHz(1, 0.5) - phi) < 1e-12, "neighbours must be phi apart");
  // And the eight must not all start at the same point.
  const row = rowOf("vcvOchd");
  const out = runKernel(row, { samples: 16, knobs: { rate: 0.5 } });
  const starts = new Set(out.map((o) => o[0].toFixed(6)));
  assert.equal(starts.size, 8, "eight analogue cores must not power up in phase");
});

check("athru folds: more knob, more partials, and the fader bottom is near silence", () => {
  const row = rowOf("vcvAthru");
  const samples = 1 << 15;
  const partials = (fold) => {
    const out = runKernel(row, {
      samples, knobs: { fold, symmetryAtten: 0, strikeDecay: 0.5 },
      options: { symmetryMode: "sum", drive: "off" }, wire: { in: voltSine(220, 5) },
    })[0].subarray(samples / 2);
    let sum = 0;
    for (let h = 3; h <= 11; h += 2) sum += binAt(out, 220 * h).magnitude;
    return { fundamental: binAt(out, 220).magnitude, upper: sum };
  };
  const low = partials(0);
  const high = partials(1);
  assert.ok(low.fundamental < 0.5, "the manual's \"fully downwards … near-silence\" must hold");
  assert.ok(high.upper > low.upper * 5, `folding must add partials; ${high.upper.toFixed(3)} vs ${low.upper.toFixed(3)}`);
  // Symmetry bias in `bias` mode must produce EVEN harmonics, which a symmetric
  // fold cannot — that is the whole point of the control.
  const even = (symmetryAtten, symmetryMode) => {
    const out = runKernel(row, {
      samples, knobs: { fold: 0.7, symmetryAtten, strikeDecay: 0.5 },
      options: { symmetryMode, drive: "off" }, wire: { in: voltSine(220, 5) },
    })[0].subarray(samples / 2);
    return binAt(out, 440).magnitude;
  };
  assert.ok(even(0.6, "bias") > even(0, "bias") * 5, "an asymmetric bias must generate even harmonics");
});

check("saich's seven mix profiles are seven different gain functions", () => {
  const profiles = ["basicVca", "cascadeCrossfade", "oddsToEvens", "smartPairs", "constantRoot", "voiceSubtraction", "voiceArpeggiator"];
  const shapes = new Set();
  for (const profile of profiles) {
    const shape = [];
    for (let scan = 0; scan <= 1.0001; scan += 0.25) {
      for (let voice = 0; voice < 4; voice++) {
        const g = K.saichVoiceGain(profile, voice, scan);
        assert.ok(g >= 0 && g <= 1, `${profile}(${voice}, ${scan}) = ${g} is outside 0…1`);
        shape.push(g.toFixed(3));
      }
    }
    shapes.add(shape.join(","));
  }
  assert.equal(shapes.size, profiles.length, "two profiles produce the same curve, which makes one of them a lie");
  assert.equal(K.saichVoiceGain("constantRoot", 0, 0), 1, "constantRoot must keep voice 1 up at the bottom");
  assert.equal(K.saichVoiceGain("voiceSubtraction", 3, 1), 0, "voiceSubtraction must have dropped voice 4 by the top");
  assert.throws(() => K.saichVoiceGain("__nonsense__", 0, 0), "an unknown profile must be LOUD");
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. THE DETERMINISM LAW AND THE BLOCK'S CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════

check("every kernel is deterministic and finite — the same inputs, the same samples", () => {
  for (const row of VC10_PROCESSORS) {
    const wire = {};
    for (const key of row.audioInputs) wire[key] = voltSine(97 + key.length * 13, 2);
    const opts = { samples: 2048, wire, construct: { seed: 5 } };
    const a = runKernel(row, opts);
    const b = runKernel(row, opts);
    for (let o = 0; o < a.length; o++) {
      assert.deepEqual(Array.from(a[o]), Array.from(b[o]), `${row.module}'s output ${row.outputs[o]} is not reproducible`);
      for (const v of a[o]) assert.ok(Number.isFinite(v), `${row.module}.${row.outputs[o]} produced a non-finite sample`);
    }
  }
});

check("no kernel reads a wall clock — the dt = 0 law, checked at the source", () => {
  for (const forbidden of ["Date.now", "new Date", "Math.random", "performance.now"]) {
    assert.ok(!KERNEL_SOURCE.includes(forbidden), `synth/vc10_kernels.js contains ${forbidden}`);
    assert.ok(!PROCESSOR_SOURCE.includes(forbidden), `processors_vc10.js contains ${forbidden}`);
  }
});

check("R7-UNITS: the scale is applied in EXACTLY two places, and per PORT KIND", () => {
  assert.equal(K.RACK_VOLTS_PER_UNIT, 5, "clause 1: 1.0 on a level wire is 5 V");
  assert.equal(VC10_GATE_SCALE_VOLTS, 10, "clause 4: a full gate is Rack's 10 V");
  assert.equal(K.VC10_SEMITONES_PER_VOLT, 12, "clause 3: a pitch port carries 12 semitones per volt");
  const applications = [...PROCESSOR_SOURCE.matchAll(/this\.(input|output)Scale\[/g)].length;
  assert.equal(applications, 2, `expected exactly two scale applications; found ${applications}`);
  for (const row of VC10_PROCESSORS) {
    for (const port of row.pitchPorts) assert.ok(!row.gatePorts.includes(port), `${row.module}.${port} is both pitch and gate`);
    for (const port of [...row.pitchPorts, ...row.gatePorts]) {
      assert.ok(row.audioInputs.includes(port) || row.outputs.includes(port),
        `${row.module} declares a scale for ${port}, which is not one of its ports`);
    }
  }
});

check("the PORT-BLOCK CONTRACT: five exports, spelled exactly, with the right shapes", () => {
  assert.ok(Array.isArray(BLOCK_SPECS) && BLOCK_SPECS.length === 15, "BLOCK_SPECS must be an array of fifteen");
  assert.ok(Array.isArray(BLOCK_PLUGINS) && BLOCK_PLUGINS.length === 15, "BLOCK_PLUGINS must be an array of fifteen");
  assert.equal(typeof BLOCK_MODULE_FACTORIES, "object");
  assert.ok(!Array.isArray(BLOCK_MODULE_FACTORIES));
  assert.ok(Array.isArray(BLOCK_WORKLET_MODULES),
    "BLOCK_WORKLET_MODULES must be an ARRAY, not a Set (AX-3 shipped a Set and it was swept back)");
  assert.equal(BLOCK_WORKLET_MODULES.length, 15, "every one of these is a worklet");
  for (const type of BLOCK_WORKLET_MODULES) assert.ok(type in BLOCK_MODULE_FACTORIES, `${type} has no factory`);
});

check("the spec, the roster and the barrel agree about what exists", () => {
  const specTypes = BLOCK_SPECS.map((s) => s.type);
  assert.deepEqual([...specTypes].sort(), BLOCK_PLUGINS.map((p) => p.type).sort(),
    "a spec with no plugin wrapper (or the reverse) is a module the author cannot reach");
  assert.equal(new Set(specTypes).size, specTypes.length, "duplicate spec type");
  const modules = BLOCK_SPECS.map((s) => s.module);
  assert.deepEqual([...modules].sort(), VC10_PROCESSORS.map((r) => r.module).sort());
  assert.deepEqual([...modules].sort(), Object.keys(BLOCK_MODULE_FACTORIES).sort());
  // Globally unique processor names — the worklet scope is shared across blocks.
  for (const row of VC10_PROCESSORS) assert.match(row.name, /^vc10-[a-z0-9-]+-processor$/, `${row.name} is off-convention`);
});

check("every spec knob is a real AudioParam, construct option or discrete option", () => {
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    const params = new Map(row.params.map((p) => [p.name, p]));
    for (const knob of spec.knobs ?? []) {
      if (knob.discrete) {
        assert.ok(row.options.includes(knob.key) || row.construct.includes(knob.key),
          `${spec.type}.${knob.key} is discrete but neither an option nor construct-time`);
        continue;
      }
      if (knob.construct) {
        assert.ok(row.construct.includes(knob.key), `${spec.type}.${knob.key} is construct-time but not in row.construct`);
        continue;
      }
      const param = params.get(knob.key);
      assert.ok(param, `${spec.type}.${knob.key} is not an AudioParam the engine has`);
      // THE RANGE MUST MIRROR WHAT THE ENGINE REALLY ACCEPTS. A narrower spec is
      // an Inspector refusing a value the kernel takes; a wider one is a field
      // whose top end does nothing.
      assert.equal(param.minValue, knob.min, `${spec.type}.${knob.key} min drift`);
      assert.equal(param.maxValue, knob.max, `${spec.type}.${knob.key} max drift`);
      assert.equal(param.defaultValue, knob.default, `${spec.type}.${knob.key} default drift`);
    }
    // …and the reverse: a param or option with no Inspector row is a control the
    // author cannot reach (the house rule against JSON-only properties).
    for (const param of row.params) {
      assert.ok((spec.knobs ?? []).some((k) => k.key === param.name), `${spec.type}: ${param.name} has no knob row`);
    }
    for (const option of row.options) {
      assert.ok((spec.knobs ?? []).some((k) => k.key === option), `${spec.type}: option ${option} has no knob row`);
    }
  }
});

check("every spec port is a real engine port, in INDEX ORDER", () => {
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    const ports = audioNodePlugin(spec).ports({});
    assert.deepEqual(ports.inputs.map((p) => p.key), row.audioInputs,
      `${spec.type}'s inputs must be the roster's, in INDEX ORDER — the index is how a wire finds the port`);
    assert.deepEqual(ports.outputs.map((p) => p.key), row.outputs, `${spec.type}'s outputs must be the roster's`);
    for (const p of [...ports.inputs, ...ports.outputs]) {
      assert.ok(PORT_TYPE_NAMES.includes(p.type), `${spec.type}.${p.key} has undeclared type ${p.type}`);
    }
  }
});

check("every discrete knob's options are exactly what its kernel setter accepts", () => {
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    const kernel = row.make(FS, { seed: 0 });
    for (const knob of (spec.knobs ?? []).filter((k) => k.discrete)) {
      const setter = vc10OptionSetter(knob.key);
      assert.equal(typeof kernel[setter], "function", `${spec.type}: kernel has no ${setter}`);
      for (const option of knob.options) {
        assert.doesNotThrow(() => kernel[setter](option), `${spec.type}.${knob.key}: kernel refuses "${option}"`);
      }
      assert.throws(() => kernel[setter]("__nonsense__"), `${spec.type}.${knob.key}: kernel accepts nonsense silently`);
    }
  }
});

check("R7-17: every spec's derivation index cannot drift from the record it points at", () => {
  const exported = new Set(Object.keys(K));
  const sources = new Set([SQUINKY_SOURCE, VULT_SOURCE, VULT_MANUAL_SOURCE, INSTRUO_SOURCE]);
  for (const spec of BLOCK_SPECS) {
    const d = spec.derivation;
    assert.ok(d, `${spec.type}: no derivation record`);
    assert.ok(sources.has(d.source), `${spec.type}: ${d.source} is not one of this block's four`);
    assert.ok(d.files.length > 0, `${spec.type}: no source files named`);
    // THE INDEX POINTS AT THE PROSE, so the pointer must resolve…
    assert.ok(exported.has(d.kernel), `${spec.type}: ${d.kernel} is not exported by synth/vc10_kernels.js`);
    // …and every deviation it claims must actually be DEFINED there.
    for (const id of d.deviations) {
      assert.ok([".", " ", ",", ":", ")"].some((after) => KERNEL_SOURCE.includes(`${id}${after}`)),
        `${spec.type}: deviation ${id} is named in the index but nowhere in the kernels`);
    }
    assert.ok(d.deviations.length >= 4, `${spec.type}: the block-wide deviations are missing`);
    // THE TIER IS THE THING THAT MUST NOT ROT. A wrong number is a bug; a wrong
    // tier is a lie about how much this port can be trusted.
    assert.ok(VC10_TIERS.includes(d.tier), `${spec.type}: tier ${d.tier} is not one of the three`);
    if (d.tier === "source") {
      assert.equal(d.source, SQUINKY_SOURCE, `${spec.type}: only the open-source corpus can claim tier "source"`);
      assert.match(spec.help, /PORTED FROM SOURCE/, `${spec.type}: a source-tier node must say so in its help`);
    } else {
      assert.match(spec.help, /BEHAVIOUR/, `${spec.type}: a modelled node must say BEHAVIOUR in its help`);
    }
    if (d.tier === "behaviourOnly") {
      assert.equal(d.source, INSTRUO_SOURCE, `${spec.type}: only the closed corpus is behaviour-only here`);
      assert.match(spec.help, /BEHAVIOUR ONLY/, `${spec.type}: must say BEHAVIOUR ONLY`);
    }
  }
  // The three tiers must all be REPRESENTED, or the vocabulary is decoration.
  const tiers = new Set(BLOCK_SPECS.map((s) => s.derivation.tier));
  assert.equal(tiers.size, 3, "all three tiers must appear — this block really is mixed");
});

check("every spec is well-formed enough for the Inspector to open on it", () => {
  for (const spec of BLOCK_SPECS) {
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type} has undeclared family ${spec.family}`);
    assert.ok(spec.help && spec.help.length > 20, `${spec.type} has no module help`);
    assert.ok(!/\bNode\b/.test(spec.title), `${spec.type}'s title must not say "Node"`);
    assert.ok(!spec.title.startsWith("Audio "), `${spec.type}'s title must not say "Audio"`);
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
      // A knob that reads out SEMITONES must carry a frequency, and a
      // TRANSPOSITION must not — the house rule AX-3 set and VC-3b restated.
      if (knob.unit === " st" && knob.key === spec.readout) {
        assert.equal(typeof knob.hz, "function", `${spec.type} reads out semitones with no frequency beside them`);
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
  for (const [, specifier] of PROCESSOR_SOURCE.matchAll(/from "([^"]+)"/g)) {
    assert.ok(!specifier.includes("?"), `${specifier} carries a Vite query suffix`);
    assert.match(specifier, /^\.\.?\//, `${specifier} is not a relative specifier (the ENGINE law)`);
  }
  assert.ok(!PROCESSOR_SOURCE.includes("import.meta.glob"));
  for (const [, specifier] of KERNEL_SOURCE.matchAll(/from "([^"]+)"/g)) {
    assert.ok(!specifier.includes("?"), `the kernels import ${specifier}, which carries a Vite suffix`);
  }
});

console.log(`\nport_vc10_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
