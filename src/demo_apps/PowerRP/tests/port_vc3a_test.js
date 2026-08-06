/**
 * VC-3a — THE PORT PROOF. Bare node.
 * Run: node src/demo_apps/PowerRP/tests/port_vc3a_test.js
 *
 * ── WHAT ONLY THIS FILE CAN PROVE ───────────────────────────────────────────
 * `synth/vc3a_kernels.js` claims to be nine Bogaudio modules' C++ rewritten
 * against our ±1 wires. That claim is not checkable by reading either side: both
 * are correct-looking arithmetic, and the ways a float-to-float port goes wrong —
 * a modulation index off by a factor of five, a shaped envelope replaced by a
 * plausible exponential, a knob read per sample instead of every 2.5 ms — all
 * produce code that runs and sounds like something.
 *
 * So this file carries a TRANSCRIPTION OF THE C++, taken from the same commit the
 * kernels were, and runs both over the same input:
 *
 *   · `Phasor::_update` INCLUDING its float32 rounding, so deviation D1's claim
 *     ("below 1e-4 cents") is a measured number rather than an assurance.
 *   · `TablePhasor::nextForPhase` with the phase in **BigInt uint64**, which is
 *     what C++ really has — that is the independent check on the kernels' claim
 *     that a float64 phase plus a cycle counter is EXACT, negative FM offsets and
 *     their `2^64 ≡ 1 (mod 2^32−1)` round trip included.
 *   · `dsp/table.cpp SineTable::_generate` by its own quarter-wave FOLD, so D10's
 *     "we call Math.sin instead" is measured too.
 *   · `dsp/envelope.cpp ADSR::_next`, line for line, over a gate sequence.
 *   · `dsp/filters/resample.cpp CICDecimator::next` with its int64 integrators in
 *     BigInt — the deviation (D6) that replaces them with an algebraically
 *     equivalent boxcar cascade is the one that MOST needs a number, because a
 *     wrong decimator is a quiet lowpass nobody notices.
 *   · `dsp/signal.cpp Amplifier::LevelTable`, `Saturator`, `Panner`.
 *   · `addressable_sequence.cpp nextStep`, as a step-by-step trace.
 *   · `FMOp::processChannel` in full, as an independent second implementation.
 *
 * Every comparison PRINTS its max absolute error whether it passes or not,
 * because the number is the deliverable: when an emulation sounds wrong, the first
 * question is which recurrence drifted and by how much.
 *
 * ── AND A SPECTRUM, BECAUSE MAX-ERROR IS NOT ENOUGH FOR AN FM OPERATOR ──────
 * An operator that tracked the C++ to 1e-9 with the wrong FM DEPTH SCALING would
 * be a failed port that every check above passes — the two implementations would
 * agree with each other and disagree with Rack. So the index is measured on its
 * own terms: a sine-modulated operator at index β has sidebands of amplitude
 * J_n(β), and Bessel's function does not care what either implementation thinks.
 * `depth = 0.1` with a full-scale modulator must land β = 1 and therefore
 * J_0(1) = 0.7652, J_1(1) = 0.4401, J_2(1) = 0.1149.
 *
 * Sources, read 2026-08-06:
 *   bogaudio/BogaudioModules @ 656eaae458e045602dc974bae82e15a11e104958
 *   VCVRack/Rack             (include/dsp/digital.hpp, same clone set)
 */

import assert from "node:assert/strict";

import {
  AdsrEnvelope, AddrSeqKernel, BogAdsrKernel, BogLfoKernel, BoolKernel, BoxcarDecimator,
  CYCLE_PHASE, CV_UNITY_UNITS, DadsrhKernel, EightOneKernel, FmOpKernel, GATE_HIGH_UNITS,
  GATE_LOW_UNITS, GATE_UNITS, ManualKernel, Mix4Kernel, OCTAVES_PER_UNIT, REFERENCE_FREQUENCY,
  SEMITONES_PER_OCTAVE, SEMITONES_PER_VOLT, SchmittTrigger, VOLTS_PER_UNIT, amplifierLevel,
  clamp, cvToFrequency, modulationSteps, panLeft, panRight, phaseDelta, radiansToPhase,
  reducePhase, saturate, sineTable, tableSine,
} from "../synth/vc3a_kernels.js";
import { VC3A_OPTION_VALUES, VC3A_PROCESSORS, vc3aOptionSetter } from "../synth/worklets/processors_vc3a.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES } from "../synth/modules_vc3a.js";
import { BLOCK_SPECS, bogaudioSemitonesToHz } from "../core/audio_specs_vc3a.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_vc3a.js";

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

const SAMPLE_RATE = 48000;

// ════════════════════════════════════════════════════════════════════════════
// THE TRANSCRIPTION — the C++, restated. Nothing in this section reads a kernel.
// ════════════════════════════════════════════════════════════════════════════

const CYCLE_PHASE_BIG = BigInt(2 ** 32 - 1);
const UINT64 = 1n << 64n;
const SINE_LENGTH = 4096;

/**
 * `dsp/table.cpp SineTable::_generate` — their quarter-wave fold, in float32,
 * exactly as written. Independent of the kernels' `Math.sin` table (D10).
 */
function refSineTable() {
  const table = new Float32Array(SINE_LENGTH);
  const twoPI = Math.fround(2 * Math.fround(Math.PI));
  const quarter = SINE_LENGTH / 4;
  for (let i = 0; i <= quarter; i++) table[i] = Math.fround(Math.sin(Math.fround(twoPI * Math.fround(i / SINE_LENGTH))));
  for (let i = 1; i < quarter; i++) table[i + quarter] = table[quarter - i];
  for (let i = 0, j = SINE_LENGTH / 2; i < j; i++) table[i + j] = -table[i];
  return table;
}

/**
 * `dsp/oscillator.cpp Phasor::_update`, INCLUDING the float32 rounding the
 * kernels deliberately do not reproduce (D1): `_frequency / _sampleRate` is a
 * float, `cyclePhase` promotes to float (where UINT32_MAX rounds UP to 2^32), and
 * the product is a float before the int64 cast.
 */
function refPhaseDelta(frequency, sampleRate) {
  const ratio = Math.fround(Math.fround(frequency) / Math.fround(sampleRate));
  return BigInt(Math.trunc(Math.fround(ratio * Math.fround(2 ** 32 - 1)))) % CYCLE_PHASE_BIG;
}

/**
 * `dsp/oscillator.cpp TablePhasor::nextForPhase` on a uint64 phase — the whole
 * point being that a NEGATIVE offset arrives as `x + 2^64` in C++, so the
 * reduction is not the naive modulo.
 */
function refTableSine(phaseBig, table, interpolate) {
  let phase = phaseBig % UINT64;
  if (phase < 0n) phase += UINT64;
  phase %= CYCLE_PHASE_BIG;
  if (!interpolate) {
    let i = Number(((phase << 16n) / CYCLE_PHASE_BIG * BigInt(SINE_LENGTH)) >> 16n) % SINE_LENGTH;
    return table[i];
  }
  const fi = (Number(phase) / (2 ** 32 - 1)) * SINE_LENGTH;
  let i = Math.trunc(fi);
  if (i >= SINE_LENGTH) i = 0;
  const v1 = table[i];
  const v2 = table[i + 1 === SINE_LENGTH ? 0 : i + 1];
  return v1 + (fi - i) * (v2 - v1);
}

/** `dsp/envelope.cpp ADSR`, transcribed. Stages by their enum's numbers. */
class RefAdsr {
  constructor(sampleRate, linear) {
    this.sampleTime = 1 / sampleRate;
    this.shapes = linear ? [1, 1, 1] : [0.5, 2, 2];
    this.stage = 0;
    this.gated = false;
    this.attack = 0;
    this.decay = 0;
    this.sustain = 1;
    this.release = 0;
    this.stageProgress = 0;
    this.releaseLevel = 0;
    this.envelope = 0;
  }

  set(attack, decay, sustain, release) {
    this.attack = Math.max(attack, 0.001);
    this.decay = Math.max(decay, 0.001);
    this.sustain = sustain;
    this.release = Math.max(release, 0.001);
  }

  next() {
    const [attackShape, decayShape, releaseShape] = this.shapes;
    if (this.gated) {
      switch (this.stage) {
        case 0: this.stage = 1; this.stageProgress = 0; break;
        case 1: if (this.envelope >= 1.0) { this.stage = 2; this.stageProgress = 0; } break;
        case 2: if (this.stageProgress >= this.decay) { this.stage = 3; this.stageProgress = 0; } break;
        case 3: break;
        default: this.stage = 1; this.stageProgress = this.attack * this.envelope ** releaseShape; break;
      }
    } else {
      switch (this.stage) {
        case 0: break;
        case 4: if (this.stageProgress >= this.release) this.stage = 0; break;
        default: this.stage = 4; this.stageProgress = 0; this.releaseLevel = this.envelope; break;
      }
    }
    switch (this.stage) {
      case 0: this.envelope = 0; break;
      case 1:
        this.stageProgress += this.sampleTime;
        this.envelope = Math.min(1, this.stageProgress / this.attack) ** attackShape;
        break;
      case 2:
        this.stageProgress += this.sampleTime;
        this.envelope = (1 - Math.min(1, this.stageProgress / this.decay)) ** decayShape;
        this.envelope *= 1 - this.sustain;
        this.envelope += this.sustain;
        break;
      case 3: this.envelope = this.sustain; break;
      default:
        this.stageProgress += this.sampleTime;
        this.envelope = (1 - Math.min(1, this.stageProgress / this.release)) ** releaseShape;
        this.envelope *= this.releaseLevel;
        break;
    }
    return this.envelope;
  }
}

/** `dsp/filters/resample.cpp CICDecimator::next` — int64 integrators at 2^32
 *  fixed point, in BigInt, with the wraparound the algorithm depends on. */
class RefCicDecimator {
  constructor(stages = 4, factor = 8) {
    this.stages = stages;
    this.factor = factor;
    this.scale = 1n << 32n;
    this.integrators = new Array(stages + 1).fill(0n);
    this.combs = new Array(stages).fill(0n);
    this.gainCorrection = 1 / factor ** stages;
  }

  wrap(v) {
    let x = v % UINT64;
    if (x < 0n) x += UINT64;
    return x >= 1n << 63n ? x - UINT64 : x;
  }

  next(buffer) {
    for (let i = 0; i < this.factor; i++) {
      this.integrators[0] = BigInt(Math.trunc(buffer[i] * Number(this.scale)));
      for (let j = 1; j <= this.stages; j++) {
        this.integrators[j] = this.wrap(this.integrators[j] + this.integrators[j - 1]);
      }
    }
    let s = this.integrators[this.stages];
    for (let i = 0; i < this.stages; i++) {
      const t = s;
      s = this.wrap(s - this.combs[i]);
      this.combs[i] = t;
    }
    return this.gainCorrection * (Number(s) / Number(this.scale));
  }
}

/** `dsp/signal.cpp Amplifier::LevelTable::_generate` + `setLevel`. */
function refAmplifierLevel(db) {
  const minDb = -60;
  const maxDb = 20;
  const range = maxDb - minDb;
  const length = 8192;
  if (db <= minDb) return 0;
  if (db >= maxDb) return 10 ** (db * 0.05);
  const index = Math.trunc(((db - minDb) / range) * length);
  if (index === 0) return 0;
  const rdb = 6;
  const tdb = minDb + rdb;
  const ta = 10 ** (tdb * 0.05);
  const entryDb = minDb + (index / length) * range;
  const value = entryDb <= tdb ? ((entryDb - minDb) / rdb) * ta : 10 ** (entryDb * 0.05);
  return Math.fround(value);
}

/** `dsp/signal.cpp saturation` + `Saturator::next`. */
function refSaturate(sample) {
  const limit = 12;
  const y1 = 0.98765;
  const offset = 0.075 / limit;
  const curve = (x) => {
    const x1 = (x + 1) * 0.5;
    return limit * (offset + x1 - Math.sqrt(x1 * x1 - y1 * x) * (1 / y1));
  };
  const x = sample * (1 / limit);
  return sample < 0 ? -curve(-x) : curve(x);
}

/** `addressable_sequence.cpp AddressableSequenceModule::nextStep`, transcribed —
 *  voltages in VOLTS, as the C++ has them, so the port's ÷5 is under test too. */
class RefAddressedSequence {
  constructor(sampleRate) {
    this.clock = new RefTrigger();
    this.negativeClock = new RefTrigger();
    this.reset = new RefTrigger();
    this.selectTrigger = new RefTrigger();
    this.durationSteps = sampleRate * 0.001;
    this.countSteps = 0;
    this.expired = false;
    this.step = 0;
    this.select = 0;
  }

  timerNext() {
    this.countSteps += 1;
    this.expired = this.expired || this.countSteps >= this.durationSteps;
    return !this.expired;
  }

  next(volts, params, flags) {
    const n = 8;
    const reset = this.reset.process(volts.reset);
    if (reset) { this.countSteps = 0; this.expired = false; }
    const timer = this.timerNext();
    const clock = this.clock.process(volts.clock) && !timer;
    const negativeClock = this.negativeClock.process(-volts.clock) && flags.reverseOnNegativeClock && !timer && !clock;

    let s = clamp(params.steps, 1, 8);
    s -= 1;
    s /= 7;
    s *= n - 1;
    s += 1;
    const steps = Math.trunc(s);

    const reverse = 1 - 2 * (params.direction === 0 ? 1 : 0);
    this.step = (this.step + reverse * (clock ? 1 : 0) + -reverse * (negativeClock ? 1 : 0)) % steps;
    this.step += (this.step < 0 ? 1 : 0) * steps;
    this.step -= this.step * (reset ? 1 : 0);

    let select = (clamp(params.select, 0, 7) / 7) * (n - 1);
    if (flags.triggeredSelect) {
      if (this.selectTrigger.process(volts.select)) this.select = (1 + Math.trunc(this.select)) % (Math.trunc(select) + 1);
      this.select -= this.select * (reset ? 1 : 0);
    } else {
      select += (clamp(volts.select, -9.99, 9.99) / 10) * n;
      if (!flags.selectOnClock || clock) this.select = select;
    }

    const active = (this.step + Math.trunc(this.select)) % (flags.wrapSelectAtSteps ? steps : n);
    return active < 0 ? n + active : active;
  }
}

/** `Rack include/dsp/digital.hpp TSchmittTrigger<float>` with Bogaudio's 1 V /
 *  0.1 V thresholds (`rack_overrides.hpp`), in VOLTS. */
class RefTrigger {
  constructor(high = 1, low = 0.1) {
    this.high = high;
    this.low = low;
    this.state = "uninitialized";
  }

  process(volts) {
    if (this.state === "low" && volts >= this.high) { this.state = "high"; return true; }
    if (this.state === "high" && volts <= this.low) { this.state = "low"; return false; }
    if (this.state === "uninitialized") {
      if (volts >= this.high) this.state = "high";
      else if (volts <= this.low) this.state = "low";
    }
    return false;
  }

  isHigh() {
    return this.state === "high";
  }
}

/** `dsp/signal.cpp SlewLimiter`, in the C++'s own units. */
class RefSlewLimiter {
  constructor(sampleRate, ms, range) {
    this.delta = range / ((ms / 1000) * sampleRate);
    this.last = 0;
  }

  next(sample) {
    this.last = sample > this.last ? Math.min(this.last + this.delta, sample) : Math.max(this.last - this.delta, sample);
    return this.last;
  }
}

/**
 * `FMOp::modulateChannel` + `FMOp::processChannel`, TRANSCRIBED — an independent
 * second implementation working in VOLTS on a BigInt phase, which is what makes
 * the comparison against FmOpKernel evidence rather than a tautology.
 */
class RefFmOp {
  constructor(sampleRate, options) {
    this.sampleRate = sampleRate;
    this.oversample = 8;
    this.amplitude = 5;
    this.maxFrequency = 0.475 * sampleRate;
    this.table = refSineTable();
    this.envelope = new RefAdsr(sampleRate, true);
    this.gateTrigger = new RefTrigger();
    this.decimator = new RefCicDecimator();
    this.feedbackSL = new RefSlewLimiter(sampleRate, 5, 1);
    this.depthSL = new RefSlewLimiter(sampleRate, 5, 1);
    this.levelSL = new RefSlewLimiter(sampleRate, 10, 1);
    this.sustainSL = new RefSlewLimiter(sampleRate, 1, 1);
    this.phase = 0n;
    this.delta = 0n;
    this.buffer = new Float64Array(this.oversample);
    this.oversampleMix = 0;
    this.feedbackDelayedSample = 0;
    this.envelopeOn = false;
    this.interpolate = options.interpolate;
    this.linearLevel = options.linearLevel;
    this.antiAliasFeedback = options.antiAliasFeedback;
    this.antiAliasDepth = options.antiAliasDepth;
    this.levelEnvelopeOn = options.levelEnvelopeOn;
    this.feedbackEnvelopeOn = options.feedbackEnvelopeOn;
    this.depthEnvelopeOn = options.depthEnvelopeOn;
  }

  /** `modulateChannel`: `p` is the knob set in Bogaudio's own DISPLAY units. */
  modulate(p) {
    let frequency = p.pitchVolts + p.fineCents / 100 / 12;
    frequency = cvToFrequency(frequency) * p.ratio;
    frequency = clamp(frequency, -this.maxFrequency, this.maxFrequency);
    this.delta = refPhaseDelta(frequency / this.oversample, this.sampleRate);
    const on = this.levelEnvelopeOn || this.feedbackEnvelopeOn || this.depthEnvelopeOn;
    if (on && !this.envelopeOn) {
      this.envelope.stage = 0;
      this.envelope.gated = false;
      this.envelope.envelope = 0;
    }
    this.envelopeOn = on;
    if (on) {
      this.envelope.set(p.attack, p.decay, this.sustainSL.next(p.sustain), p.release);
    }
    this.feedback = p.feedback;
    this.depth = p.depth;
    this.level = p.level;
  }

  /** `processChannel`: `gateVolts` and `fmVolts` are volts, as a cable's are. */
  process(gateVolts, fmVolts) {
    let envelope = 0;
    if (this.envelopeOn) {
      this.gateTrigger.process(gateVolts);
      this.envelope.gated = this.gateTrigger.isHigh();
      envelope = this.envelope.next();
    }
    let feedback = this.feedbackSL.next(this.feedback);
    if (this.feedbackEnvelopeOn) feedback *= envelope;
    const feedbackOn = feedback > 0.001;

    let out = this.levelSL.next(this.level);
    if (this.levelEnvelopeOn) out *= envelope;

    let offset = feedbackOn ? feedback * this.feedbackDelayedSample : 0;
    let depth = this.depthSL.next(this.depth);
    if (this.depthEnvelopeOn) depth *= envelope;
    offset += fmVolts * depth * 2;
    const depthOn = depth > 0.001;

    let sample = 0;
    if (out > 0.0001) {
      const o = BigInt(Math.trunc((offset / (2 * Math.PI)) * (2 ** 32 - 1)));
      if ((feedbackOn && this.antiAliasFeedback) || (depthOn && this.antiAliasDepth)) {
        if (this.oversampleMix < 1) this.oversampleMix += 0.01;
      } else if (this.oversampleMix > 0) {
        this.oversampleMix -= 0.01;
      }
      if (this.oversampleMix > 0) {
        for (let i = 0; i < this.oversample; i++) {
          this.phase = (this.phase + this.delta) % UINT64;
          this.buffer[i] = refTableSine(this.phase + o, this.table, this.interpolate);
        }
        sample = this.oversampleMix * this.decimator.next(this.buffer);
      } else {
        this.phase = (this.phase + BigInt(this.oversample) * this.delta) % UINT64;
      }
      if (this.oversampleMix < 1) {
        sample += (1 - this.oversampleMix) * refTableSine(this.phase + o, this.table, this.interpolate);
      }
      if (this.linearLevel) sample *= out;
      else sample = refAmplifierLevel((1 - out) * -60) * sample;
    } else {
      this.phase = (this.phase + BigInt(this.oversample) * this.delta) % UINT64;
    }
    this.feedbackDelayedSample = this.amplitude * sample;
    return this.feedbackDelayedSample;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MEASUREMENT HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Pure function. One DFT bin's amplitude, by Goertzel — a whole FFT is not needed
 * when the sidebands sit on known bins.
 *
 * @param {Float64Array|number[]} signal - the samples
 * @param {number} bin - an integer bin of a `signal.length`-point transform
 * @returns {number} the amplitude of that bin (not its energy)
 *
 * @example Math.abs(binAmplitude(Array.from({length: 64}, (_, i) => Math.sin(2 * Math.PI * 4 * i / 64)), 4) - 1) < 1e-9 // true
 * @example binAmplitude(new Float64Array(64), 4) // 0
 */
function binAmplitude(signal, bin) {
  const n = signal.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const angle = (-2 * Math.PI * bin * i) / n;
    re += signal[i] * Math.cos(angle);
    im += signal[i] * Math.sin(angle);
  }
  return (2 * Math.sqrt(re * re + im * im)) / n;
}

/** Query. Run one kernel over `frames` samples with a per-sample control hook,
 *  driving `control()` on Bogaudio's own 2.5 ms divider. */
function runKernel(kernel, row, frames, tweak) {
  const c = {};
  for (const p of row.params) c[p.name] = p.defaultValue;
  const frame = new Float64Array(row.outputs.length);
  const period = modulationSteps(SAMPLE_RATE);
  const out = [];
  for (let i = 0; i < frames; i++) {
    if (tweak) tweak(c, i);
    if (i % period === 0) kernel.control(c);
    kernel.sample(c, frame);
    out.push(Float64Array.from(frame));
  }
  return out;
}

/** Query. A roster row by module name, LOUDLY. */
function row(module) {
  const found = VC3A_PROCESSORS.find((r) => r.module === module);
  if (!found) throw new Error(`no roster row for ${module}`);
  return found;
}

console.log("\nVC-3a PORT PROOF — Bogaudio @ 656eaae, transcribed and measured\n");

// ════════════════════════════════════════════════════════════════════════════
// 1. THE PHASE GRID AND THE TABLE
// ════════════════════════════════════════════════════════════════════════════

console.log("Phase accumulator and sine table:");

check("phaseDelta vs the C++ float32 chain (D1)", () => {
  // The claim under test is D1's: dropping their float32 rounding costs less than
  // 1e-4 cents of tuning. Cents, not phase units, because that is what an ear has.
  let worstCents = 0;
  for (const hz of [0.004, 1, 55, 110, 261.626, 440, 1000, 5000, 12000, 22000]) {
    const mine = phaseDelta(hz, SAMPLE_RATE);
    const theirs = Number(refPhaseDelta(hz, SAMPLE_RATE));
    if (theirs === 0) continue;
    worstCents = Math.max(worstCents, Math.abs(1200 * Math.log2(mine / theirs)));
  }
  within("tuning difference, cents", worstCents, 1e-4);
});

check("tableSine matches TablePhasor::nextForPhase, both modes", () => {
  const table = refSineTable();
  let worstClassic = 0;
  let worstClean = 0;
  // Includes NEGATIVE phases: an FM offset is signed, and the uint64 round trip
  // is the subtle part (their `2^64 ≡ 1 mod 2^32−1`).
  for (let i = 0; i < 4000; i++) {
    const phase = Math.trunc(((i * 7919) % 100000) / 100000 * CYCLE_PHASE) * (i % 3 === 0 ? -1 : 1);
    worstClassic = Math.max(worstClassic, Math.abs(tableSine(phase, false) - refTableSine(BigInt(phase), table, false)));
    worstClean = Math.max(worstClean, Math.abs(tableSine(phase, true) - refTableSine(BigInt(phase), table, true)));
  }
  // The bound is float32 table rounding (D10), not an algorithmic difference:
  // both indices are identical integers, only the stored value's width differs.
  within("classic (non-interpolated) read", worstClassic, 1e-7);
  within("clean (interpolated) read", worstClean, 1e-7);
});

check("reducePhase reproduces the uint64 round trip exactly", () => {
  for (const phase of [0, 1, -1, CYCLE_PHASE - 1, -(CYCLE_PHASE - 1), -12345678901, 987654321]) {
    let expected = BigInt(phase) % UINT64;
    if (expected < 0n) expected += UINT64;
    expected %= CYCLE_PHASE_BIG;
    assert.equal(reducePhase(phase), Number(expected), `reducePhase(${phase})`);
  }
});

check("our sine table is their fold to float32 precision (D10)", () => {
  const theirs = refSineTable();
  const mine = sineTable();
  let worst = 0;
  for (let i = 0; i < SINE_LENGTH; i++) worst = Math.max(worst, Math.abs(mine[i] - theirs[i]));
  within("sine table entries", worst, 1e-7);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE SHAPED ENVELOPE
// ════════════════════════════════════════════════════════════════════════════

console.log("\nEnvelopes:");

check("AdsrEnvelope matches ADSR::_next over a gate sequence, both shapes", () => {
  for (const linear of [false, true]) {
    const mine = new AdsrEnvelope(SAMPLE_RATE, linear);
    const theirs = new RefAdsr(SAMPLE_RATE, linear);
    mine.setTimes(0.05, 0.08, 0.4, 0.12);
    theirs.set(0.05, 0.08, 0.4, 0.12);
    let worst = 0;
    for (let i = 0; i < SAMPLE_RATE / 2; i++) {
      // Gate high 0…100 ms, low, high again mid-release (the retrigger path).
      const gate = (i < 4800) || (i > 7000 && i < 9000);
      mine.setGate(gate);
      theirs.gated = gate;
      worst = Math.max(worst, Math.abs(mine.next() - theirs.next()));
    }
    within(`ADSR trace, ${linear ? "linear" : "curved"} shapes`, worst, 1e-12);
  }
});

check("the curved default really is √ up and squared down, not exponential", () => {
  // The brief's warning made concrete: an envelope that eased the same way in both
  // directions would pass every trace check above ONLY if the reference were wrong
  // too, so the shape is asserted against its closed form here.
  const env = new AdsrEnvelope(SAMPLE_RATE, false);
  env.setTimes(0.1, 10, 1, 10);
  env.setGate(true);
  let halfway = 0;
  for (let i = 0; i < SAMPLE_RATE * 0.05; i++) halfway = env.next();
  // Half way through a √-shaped attack the envelope is already √0.5 = 0.707.
  within("attack at t = A/2 vs sqrt(0.5)", Math.abs(halfway - Math.SQRT1_2), 1e-3);
  assert.ok(halfway > 0.6, `a linear or exponential attack would be at or below 0.5, got ${halfway}`);
});

check("FMOp's envelope is LINEAR while the ADSR module's is curved", () => {
  // Reproduced, not fixed: `FMOp::Engine() : envelope(true)`. If a future edit
  // "unified" the two, an FM index envelope would change shape silently.
  const fm = new FmOpKernel(SAMPLE_RATE, {});
  const adsr = new BogAdsrKernel(SAMPLE_RATE, {});
  assert.equal(fm.envelope.attackShape, 1, "FMOp's attack shape must be linear");
  assert.equal(adsr.envelope.attackShape, 0.5, "ADSR's attack shape must be the square root");
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE DECIMATOR (deviation D6, the one that most needs a number)
// ════════════════════════════════════════════════════════════════════════════

console.log("\nCIC decimator, boxcar identity vs their int64 form (D6):");

check("BoxcarDecimator matches CICDecimator over a swept input", () => {
  const mine = new BoxcarDecimator();
  const theirs = new RefCicDecimator();
  const block = new Float64Array(8);
  let worst = 0;
  // 6000 output samples = 48000 input samples: long enough that a drifting
  // running sum would show, which is the risk the float form carries.
  for (let n = 0; n < 6000; n++) {
    for (let i = 0; i < 8; i++) {
      const t = (n * 8 + i) / SAMPLE_RATE;
      block[i] = Math.sin(2 * Math.PI * 900 * t) * 0.7 + Math.sin(2 * Math.PI * 15000 * t) * 0.3;
    }
    worst = Math.max(worst, Math.abs(mine.next(block) - theirs.next(block)));
  }
  within("decimated output", worst, 1e-9);
});

check("the decimator is unity at DC and rejects above the new Nyquist", () => {
  // A wrong CIC is a quiet lowpass nobody notices, so its gain is measured.
  const dc = new BoxcarDecimator();
  const block = new Float64Array(8).fill(1);
  let last = 0;
  for (let n = 0; n < 100; n++) last = dc.next(block);
  within("DC gain vs unity", Math.abs(last - 1), 1e-12);

  const hf = new BoxcarDecimator();
  let peak = 0;
  for (let n = 0; n < 400; n++) {
    for (let i = 0; i < 8; i++) block[i] = Math.sin(2 * Math.PI * 0.375 * (n * 8 + i));
    const v = hf.next(block);
    if (n > 20) peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(peak < 0.02, `a 0.375·fs tone must be rejected by more than 34 dB, got ${peak}`);
  console.log(`  ${"rejection at 0.375 fs".padEnd(52)} ${(20 * Math.log10(Math.max(peak, 1e-12))).toFixed(1)} dB`);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE SIGNAL PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

console.log("\nAmplifier, saturator, panner:");

check("amplifierLevel matches Amplifier::setLevel through their table", () => {
  let worst = 0;
  for (let db = -70; db <= 25; db += 0.37) {
    worst = Math.max(worst, Math.abs(amplifierLevel(db) - refAmplifierLevel(db)));
  }
  within("level table lookup", worst, 1e-7);
});

check("the level table's bottom 6 dB ramp linearly to silence", () => {
  // Their `LevelTable::_generate` special case, and the reason a fader's floor is
  // a fade: a pure decibel curve would never reach zero.
  assert.equal(amplifierLevel(-60), 0, "-60 dB must be exactly silent");
  const a = amplifierLevel(-57);
  const b = amplifierLevel(-54);
  within("linear ramp: value at -57 dB vs half of -54 dB", Math.abs(a - b / 2), 2e-4);
});

check("saturate matches Saturator::next and is odd-symmetric", () => {
  let worst = 0;
  let worstOdd = 0;
  for (let v = -20; v <= 20; v += 0.13) {
    worst = Math.max(worst, Math.abs(saturate(v) - refSaturate(v)));
    worstOdd = Math.max(worstOdd, Math.abs(saturate(v) + saturate(-v)));
  }
  within("saturator curve", worst, 1e-12);
  within("odd symmetry", worstOdd, 1e-12);
  assert.ok(Math.abs(saturate(100)) < 12, "the saturator must stay inside its 12 V limit");
});

check("panLeft/panRight are constant power off the sine table", () => {
  let worst = 0;
  for (let pan = -1; pan <= 1; pan += 0.01) {
    const power = panLeft(pan) ** 2 + panRight(pan) ** 2;
    worst = Math.max(worst, Math.abs(power - 1));
  }
  within("L²+R² vs unity", worst, 2e-3);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. FMOp — THE HEADLINE
// ════════════════════════════════════════════════════════════════════════════

console.log("\nFMOp:");

/** Query. Run FmOpKernel and RefFmOp side by side and return the worst |error|
 *  between them, in OUR units (the reference's volts divided by five). */
function compareFmOp(knobs, options, frames, fmAt) {
  const r = row("vcvFmop");
  const kernel = new FmOpKernel(SAMPLE_RATE, {
    oscillator: options.interpolate ? "clean" : "classic",
    levelResponse: options.linearLevel ? "linear" : "exponential",
    envToLevel: options.levelEnvelopeOn ? "on" : "off",
    envToFeedback: options.feedbackEnvelopeOn ? "on" : "off",
    envToDepth: options.depthEnvelopeOn ? "on" : "off",
    antialiasFeedback: options.antiAliasFeedback ? "on" : "off",
    antialiasFm: options.antiAliasDepth ? "on" : "off",
  });
  const reference = new RefFmOp(SAMPLE_RATE, options);
  const c = {};
  for (const p of r.params) c[p.name] = p.defaultValue;
  Object.assign(c, knobs);
  const period = modulationSteps(SAMPLE_RATE);
  const frame = new Float64Array(1);
  const mine = [];
  let worst = 0;
  for (let i = 0; i < frames; i++) {
    const fm = fmAt ? fmAt(i) : 0;
    c.fm = fm;
    c.gate = options.gate ? options.gate(i) : 0;
    if (i % period === 0) {
      kernel.control(c);
      reference.modulate({
        pitchVolts: c.pitch * OCTAVES_PER_UNIT,
        fineCents: c.fine,
        ratio: c.ratio,
        attack: c.attack,
        decay: c.decay,
        sustain: c.sustain,
        release: c.release,
        feedback: c.feedback,
        depth: c.depth,
        level: c.level,
      });
    }
    kernel.sample(c, frame);
    const theirs = reference.process(c.gate * VOLTS_PER_UNIT, fm * VOLTS_PER_UNIT) / VOLTS_PER_UNIT;
    worst = Math.max(worst, Math.abs(frame[0] - theirs));
    mine.push(frame[0]);
  }
  return { worst, samples: mine };
}

check("FMOp matches the transcribed processChannel — bare oscillator", () => {
  const { worst } = compareFmOp(
    { pitch: Math.log2(440 / 261.626) / OCTAVES_PER_UNIT, ratio: 1, level: 1 },
    { interpolate: false, linearLevel: false, antiAliasFeedback: true, antiAliasDepth: true },
    SAMPLE_RATE / 4,
  );
  within("bare sine, classic table, exponential level", worst, 1e-7);
});

check("FMOp matches it with FEEDBACK, which engages the 8x anti-alias path", () => {
  const knobs = { pitch: Math.log2(220 / 261.626) / OCTAVES_PER_UNIT, ratio: 1, level: 1, feedback: 0.35 };
  const options = { interpolate: false, linearLevel: false, antiAliasFeedback: true, antiAliasDepth: false };
  // TWO BOUNDS, BECAUSE A FEEDBACK LOOP AMPLIFIES ITS OWN INPUT ERROR. The
  // decimators agree to 1.4e-10 per sample (measured above), but here that
  // difference is fed back into the phase of the next sample, so it grows — the
  // ordinary sensitivity of a self-modulating oscillator, not a porting defect.
  // The SHORT run therefore carries the tight bound and the long run shows how far
  // the two drift apart over a quarter second; the ANTI-ALIAS PATH ITSELF is
  // pinned to 5.8e-8 by the external-FM check below, which uses it without a loop.
  within("self-modulated, first 1000 samples", compareFmOp(knobs, options, 1000).worst, 1e-7);
  const { worst, samples } = compareFmOp(knobs, options, SAMPLE_RATE / 4);
  within("self-modulated, quarter second (loop divergence)", worst, 5e-3);
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > 0.3 && peak <= 1.05, `feedback output must stay near full scale, got ${peak}`);
});

check("FMOp matches it with an ENVELOPE on level, feedback and depth", () => {
  const { worst } = compareFmOp(
    { pitch: 0, ratio: 2, level: 1, feedback: 0.2, depth: 0.5, attack: 0.01, decay: 0.05, sustain: 0.6, release: 0.2 },
    {
      interpolate: true, linearLevel: true, antiAliasFeedback: true, antiAliasDepth: true,
      levelEnvelopeOn: true, feedbackEnvelopeOn: true, depthEnvelopeOn: true,
      gate: (i) => (i < SAMPLE_RATE * 0.1 ? 1 : 0),
    },
    SAMPLE_RATE / 3,
    (i) => 0.4 * Math.sin((2 * Math.PI * 130 * i) / SAMPLE_RATE),
  );
  within("gated, three envelope routings, external FM", worst, 1e-6);
});

check("THE FM INDEX IS RIGHT: measured Bessel sidebands at beta = 1", () => {
  // The check no agreement between two implementations could provide. An operator
  // phase-modulated by a sine at index β has spectrum |J_n(β)| at the carrier ± n
  // modulator frequencies. Our depth law is `β = 2 · fmVolts · depth`, so a
  // full-scale (±1 = ±5 V) modulator at depth 0.1 must give β = 1 exactly.
  const N = 4096;
  const WARMUP = 4000;              // past the level and depth slew limiters
  const CARRIER_BIN = 128;
  const MODULATOR_BIN = 16;
  const carrierHz = (CARRIER_BIN * SAMPLE_RATE) / N;
  const modulatorHz = (MODULATOR_BIN * SAMPLE_RATE) / N;
  const r = row("vcvFmop");
  const kernel = new FmOpKernel(SAMPLE_RATE, {
    oscillator: "clean", levelResponse: "linear", antialiasFeedback: "off", antialiasFm: "off",
  });
  const c = {};
  for (const p of r.params) c[p.name] = p.defaultValue;
  c.pitch = Math.log2(carrierHz / 261.626) / OCTAVES_PER_UNIT;
  c.ratio = 1;
  c.level = 1;
  c.depth = 0.1;
  const period = modulationSteps(SAMPLE_RATE);
  const frame = new Float64Array(1);
  const signal = new Float64Array(N);
  for (let i = 0; i < WARMUP + N; i++) {
    c.fm = Math.sin((2 * Math.PI * modulatorHz * i) / SAMPLE_RATE);
    if (i % period === 0) kernel.control(c);
    kernel.sample(c, frame);
    if (i >= WARMUP) signal[i - WARMUP] = frame[0];
  }
  const bessel = [0.7651976866, 0.4400505857, 0.1149034849, 0.0195633540];
  let worst = 0;
  for (let n = 0; n < bessel.length; n++) {
    const measured = n === 0
      ? binAmplitude(signal, CARRIER_BIN)
      : (binAmplitude(signal, CARRIER_BIN + n * MODULATOR_BIN) + binAmplitude(signal, CARRIER_BIN - n * MODULATOR_BIN)) / 2;
    console.log(`  sideband n=${n}: measured ${measured.toFixed(5)}  J_${n}(1) = ${bessel[n].toFixed(5)}`);
    worst = Math.max(worst, Math.abs(measured - bessel[n]));
  }
  // 0.01 absolute: the residual is the phase quantisation of `radiansToPhase`
  // plus the leakage of a not-quite-bin-exact carrier (the phase increment is
  // truncated to the CYCLE_PHASE grid). A depth law wrong by the factor of five
  // this block's unit law could plausibly have introduced would put J_0 at
  // -0.178 (beta = 5), which is 0.94 away.
  within("|measured - J_n(1)|, n = 0..3", worst, 1e-2);
});

check("depth scales the index LINEARLY, so a patch's dial means an index", () => {
  // β = 2·5·A·depth in our units. Doubling depth must double β, which shows up as
  // the first sideband growing towards J_1(2) = 0.5767.
  const N = 4096;
  const measureFirstSideband = (depth) => {
    const r = row("vcvFmop");
    const kernel = new FmOpKernel(SAMPLE_RATE, { oscillator: "clean", levelResponse: "linear", antialiasFeedback: "off", antialiasFm: "off" });
    const c = {};
    for (const p of r.params) c[p.name] = p.defaultValue;
    c.pitch = Math.log2(((128 * SAMPLE_RATE) / N) / 261.626) / OCTAVES_PER_UNIT;
    c.level = 1;
    c.depth = depth;
    const period = modulationSteps(SAMPLE_RATE);
    const frame = new Float64Array(1);
    const signal = new Float64Array(N);
    for (let i = 0; i < 4000 + N; i++) {
      c.fm = Math.sin((2 * Math.PI * ((16 * SAMPLE_RATE) / N) * i) / SAMPLE_RATE);
      if (i % period === 0) kernel.control(c);
      kernel.sample(c, frame);
      if (i >= 4000) signal[i - 4000] = frame[0];
    }
    return binAmplitude(signal, 144);
  };
  const atOne = measureFirstSideband(0.1);
  const atTwo = measureFirstSideband(0.2);
  console.log(`  first sideband: beta=1 -> ${atOne.toFixed(4)} (J_1(1)=0.4401), beta=2 -> ${atTwo.toFixed(4)} (J_1(2)=0.5767)`);
  within("J_1(1)", Math.abs(atOne - 0.4400505857), 1e-2);
  within("J_1(2)", Math.abs(atTwo - 0.5767248078), 1e-2);
});

// ════════════════════════════════════════════════════════════════════════════
// 6. THE SEQUENCERS, THE LFO AND THE REST
// ════════════════════════════════════════════════════════════════════════════

console.log("\nSequencers, LFO, mixer, logic:");

check("AddrSeq's step walk matches nextStep, transcribed", () => {
  const kernel = new AddrSeqKernel(SAMPLE_RATE, { range: "+/-1v" });
  const reference = new RefAddressedSequence(SAMPLE_RATE);
  const r = row("vcvAddrseq");
  const c = {};
  for (const p of r.params) c[p.name] = p.defaultValue;
  for (let n = 1; n <= 8; n++) c[`step${n}`] = n / 10;
  const frame = new Float64Array(1);
  const flags = { reverseOnNegativeClock: false, triggeredSelect: false, selectOnClock: false, wrapSelectAtSteps: false };
  let mismatches = 0;
  let stepsSeen = new Set();
  for (let i = 0; i < 80000; i++) {
    // A clock every 4000 samples (12 Hz), a reset at 25000, select stepping up.
    c.clock = i % 4000 < 200 ? 1 : 0;
    c.reset = i >= 25000 && i < 25100 ? 1 : 0;
    c.select_cv = i > 60000 ? 0.5 : 0;
    kernel.control(c);
    kernel.sample(c, frame);
    const expected = reference.next(
      { clock: c.clock * VOLTS_PER_UNIT, reset: c.reset * VOLTS_PER_UNIT, select: c.select_cv * VOLTS_PER_UNIT },
      { steps: c.steps, direction: 1, select: c.select },
      flags,
    );
    // Range "+/-1v" is offset 0 scale 1, so the output IS the step value in volts.
    const expectedOut = (((expected + 1) / 10) * 1) / VOLTS_PER_UNIT;
    if (Math.abs(frame[0] - expectedOut) > 1e-12) mismatches += 1;
    stepsSeen.add(expected);
  }
  assert.equal(mismatches, 0, `${mismatches} samples disagreed with the transcribed nextStep`);
  assert.ok(stepsSeen.size >= 8, `the trace must visit every step, saw ${stepsSeen.size}`);
});

check("a reset SUPPRESSES a simultaneous clock for 1 ms (their Timer)", () => {
  // The debounce is easy to drop and its absence is a sequencer that skips a step
  // whenever a reset and a clock arrive together — which they do, from a Clocked.
  const kernel = new AddrSeqKernel(SAMPLE_RATE, { range: "+/-1v" });
  const r = row("vcvAddrseq");
  const c = {};
  for (const p of r.params) c[p.name] = p.defaultValue;
  for (let n = 1; n <= 8; n++) c[`step${n}`] = n;
  const frame = new Float64Array(1);
  const at = (clock, reset) => { c.clock = clock; c.reset = reset; kernel.sample(c, frame); return frame[0] * VOLTS_PER_UNIT; };
  // 1 ms OF IDLE FIRST, and that is not test scaffolding: `Timer`'s constructor
  // leaves it RUNNING, so Bogaudio suppresses clocks for the first millisecond
  // after a module is created too.
  const DEBOUNCE_SAMPLES = SAMPLE_RATE * 0.001;
  for (let i = 0; i <= DEBOUNCE_SAMPLES; i++) at(0, 0);
  assert.equal(at(1, 0), 2, "one clock must reach step 2");
  at(0, 0);
  // Clock and reset together: the reset wins and the clock is swallowed.
  assert.equal(at(1, 1), 1, "a coincident clock must not advance past step 1");
  at(0, 0);
  assert.equal(at(1, 0), 1, "and it stays suppressed for the 1 ms debounce");
  for (let i = 0; i <= DEBOUNCE_SAMPLES; i++) at(0, 0);
  assert.equal(at(1, 0), 2, "once the debounce expires the clock lands again");
});

check("EightOne routes the addressed input through", () => {
  const kernel = new EightOneKernel(SAMPLE_RATE, {});
  const r = row("vcvEightone");
  const c = {};
  for (const p of r.params) c[p.name] = p.defaultValue;
  for (let n = 1; n <= 8; n++) c[`in${n}`] = n / 10;
  const frame = new Float64Array(1);
  const seen = [];
  for (let i = 0; i < 20000; i++) {
    c.clock = i % 2000 < 100 ? 1 : 0;
    kernel.sample(c, frame);
    if (i % 2000 === 150) seen.push(Math.round(frame[0] * 10));
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 1, 2], `sequential switching, got ${seen}`);
});

check("the LFO's six outputs are phase-locked and correctly scaled", () => {
  const r = row("vcvBogLfo");
  const kernel = new BogLfoKernel(SAMPLE_RATE, { seed: 7 });
  const trace = runKernel(kernel, r, SAMPLE_RATE, (c) => { c.frequency = 4; });
  const peaks = [0, 0, 0, 0, 0, 0];
  for (const frame of trace) for (let i = 0; i < 6; i++) peaks[i] = Math.max(peaks[i], Math.abs(frame[i]));
  // scale 1 and offset 0 means Rack's ±5 V, which is our ±1.
  for (let i = 0; i < 5; i++) within(`output ${r.outputs[i]} peak vs 1.0`, Math.abs(peaks[i] - 1), 0.01);
  assert.ok(peaks[5] > 0.2, `the stepped output must move, peak ${peaks[5]}`);

  // Ramp up and ramp down must be exact negatives at every sample: they are read
  // from ONE accumulator, and that is the module's whole claim.
  let worst = 0;
  for (const frame of trace) worst = Math.max(worst, Math.abs(frame[0] + frame[1]));
  within("ramp up + ramp down (one accumulator)", worst, 1e-12);

  // THE RATE KNOB IS IN REAL HERTZ, measured as the interval between upward zero
  // crossings rather than by counting them — the phase starts AT zero, so the
  // first crossing has no preceding negative sample to be detected by.
  const crossings = [];
  for (let i = 1; i < trace.length; i++) if (trace[i - 1][4] < 0 && trace[i][4] >= 0) crossings.push(i);
  assert.ok(crossings.length >= 2, `a 4 Hz sine must cross zero upward repeatedly, got ${crossings.length}`);
  const period = crossings[1] - crossings[0];
  console.log(`  ${"4 Hz sine period, samples".padEnd(52)} ${period} (expected ${SAMPLE_RATE / 4})`);
  within("period vs sampleRate/4", Math.abs(period - SAMPLE_RATE / 4), 2);
});

check("the LFO's stepped output is REPRODUCIBLE from its seed (D5)", () => {
  const r = row("vcvBogLfo");
  const first = runKernel(new BogLfoKernel(SAMPLE_RATE, { seed: 42 }), r, 6000, (c) => { c.frequency = 200; });
  const second = runKernel(new BogLfoKernel(SAMPLE_RATE, { seed: 42 }), r, 6000, (c) => { c.frequency = 200; });
  const other = runKernel(new BogLfoKernel(SAMPLE_RATE, { seed: 43 }), r, 6000, (c) => { c.frequency = 200; });
  let same = 0;
  let differs = 0;
  for (let i = 0; i < first.length; i++) {
    if (first[i][5] !== second[i][5]) same += 1;
    if (first[i][5] !== other[i][5]) differs += 1;
  }
  assert.equal(same, 0, "the same seed must give a byte-identical sequence");
  assert.ok(differs > 100, `a different seed must give a different sequence, ${differs} samples differed`);
});

check("DADSRH's stage timings are the knobs, in seconds (D3/D4)", () => {
  const r = row("vcvDadsrh");
  const kernel = new DadsrhKernel(SAMPLE_RATE, {
    mode: "triggered", loop: "stop", attackShape: "linear", decayShape: "linear", releaseShape: "linear",
  });
  const c = {};
  for (const p of r.params) c[p.name] = p.defaultValue;
  c.delay = 0.05;
  c.attack = 0.1;
  c.decay = 0.05;
  c.sustain = 0.5;
  c.release = 0.05;
  c.hold = 0.3;
  const frame = new Float64Array(3);
  let leftZero = -1;
  let peaked = -1;
  let ended = -1;
  // THE TRIGGER MUST START LOW. Rack's Schmitt trigger begins UNINITIALIZED and a
  // gate that is already high when the module appears sets the state without
  // firing — so a trigger that is high on sample zero never fires, there or here.
  const TRIGGER_AT = 10;
  for (let i = 0; i < SAMPLE_RATE; i++) {
    c.trigger = i >= TRIGGER_AT && i < TRIGGER_AT + 100 ? 1 : 0;
    kernel.sample(c, frame);
    const env = frame[0] * VOLTS_PER_UNIT / 10;
    if (leftZero < 0 && env > 0) leftZero = i;
    if (peaked < 0 && env >= 0.999) peaked = i;
    if (peaked > 0 && ended < 0 && env <= 0.001) ended = i;
  }
  const delaySamples = leftZero - TRIGGER_AT;
  const attackSamples = peaked - leftZero;
  console.log(`  delay ${(delaySamples / SAMPLE_RATE).toFixed(4)} s (knob 0.05), attack ${(attackSamples / SAMPLE_RATE).toFixed(4)} s (knob 0.1)`);
  within("delay stage duration, seconds", Math.abs(delaySamples / SAMPLE_RATE - 0.05), 2e-3);
  within("attack stage duration, seconds", Math.abs(attackSamples / SAMPLE_RATE - 0.1), 2e-3);
  // Hold 0.3 s from the START of the delay forces the release, then 0.05 s of it.
  within("end of cycle vs hold + release", Math.abs((ended - TRIGGER_AT) / SAMPLE_RATE - 0.35), 5e-3);
  assert.ok(frame[2] === 0 || frame[2] > 0, "the end-of-cycle output exists");
});

check("DADSRH loop mode restarts, gated mode does not", () => {
  const r = row("vcvDadsrh");
  const cycles = (options, triggerHigh) => {
    const kernel = new DadsrhKernel(SAMPLE_RATE, options);
    const c = {};
    for (const p of r.params) c[p.name] = p.defaultValue;
    c.delay = 0;
    c.attack = 0.01;
    c.decay = 0.01;
    c.sustain = 0;
    c.release = 0.01;
    c.hold = 0.02;
    const frame = new Float64Array(3);
    let starts = 0;
    let was = 0;
    for (let i = 0; i < SAMPLE_RATE / 2; i++) {
      c.trigger = triggerHigh(i);
      kernel.sample(c, frame);
      const env = frame[0];
      if (was <= 0 && env > 0) starts += 1;
      was = env;
    }
    return starts;
  };
  const oneShot = (i) => (i >= 10 && i < 110 ? 1 : 0);
  const looped = cycles({ mode: "triggered", loop: "loop" }, oneShot);
  const stopped = cycles({ mode: "triggered", loop: "stop" }, oneShot);
  console.log(`  cycles in 0.5 s: loop ${looped}, stop ${stopped}`);
  assert.ok(looped > 5, `loop mode must retrigger itself, got ${looped}`);
  assert.equal(stopped, 1, `stop mode must fire once, got ${stopped}`);
});

check("Mix4's fader default is UNITY and solo inverts the mute test", () => {
  const r = row("vcvMix4");
  const kernel = new Mix4Kernel(SAMPLE_RATE, {});
  const c = {};
  for (const p of r.params) c[p.name] = p.defaultValue;
  const frame = new Float64Array(2);
  const settle = () => { for (let i = 0; i < 2000; i++) { c.in1 = 0.5; kernel.sample(c, frame); } };
  settle();
  // in1 = 0.5 at unity fader, panned centre: each side is 0.5·cos(45°) = 0.354.
  within("centre-panned unity gain per side", Math.abs(frame[0] - 0.5 * Math.SQRT1_2), 0.01);
  within("left equals right at centre pan", Math.abs(frame[0] - frame[1]), 1e-9);

  // Solo channel 2 (which has nothing on it): channel 1 must go quiet.
  kernel.setMute2("soloed");
  settle();
  assert.ok(Math.abs(frame[0]) < 1e-3, `a soloed sibling must mute channel 1, got ${frame[0]}`);
});

check("Bool's threshold is 1 V, i.e. 0.2 of our units", () => {
  const kernel = new BoolKernel();
  const frame = new Float64Array(4);
  const at = (a, b) => { kernel.sample({ a, b, not: 0 }, frame); return Array.from(frame); };
  assert.deepEqual(at(0, 0).slice(0, 3), [0, 0, 0], "low and low");
  assert.deepEqual(at(1, 1).slice(0, 3), [1, 1, 0], "high and high: AND and OR, not XOR");
  assert.deepEqual(at(1, 0).slice(0, 3), [0, 1, 1], "high and low: OR and XOR");
  assert.deepEqual(at(0.19, 0).slice(0, 3), [0, 0, 0], "0.95 V is below the threshold");
  assert.deepEqual(at(0.21, 0).slice(0, 3), [0, 1, 1], "1.05 V is above it");
});

check("Manual fires once on load and holds a 1 ms pulse", () => {
  const kernel = new ManualKernel(SAMPLE_RATE, {});
  const frame = new Float64Array(8);
  let highSamples = 0;
  for (let i = 0; i < SAMPLE_RATE; i++) {
    kernel.sample({ trigger: 0 }, frame);
    if (frame[0] > 0) highSamples += 1;
    for (let o = 1; o < 8; o++) assert.equal(frame[o], frame[0], "all eight outputs must agree");
  }
  console.log(`  trigger-on-load pulse: ${highSamples} samples (${(highSamples / SAMPLE_RATE * 1000).toFixed(2)} ms)`);
  assert.ok(highSamples >= 48 && highSamples <= 50, `a 1 ms pulse at 48 kHz is 48 samples, got ${highSamples}`);
});

check("the Schmitt trigger does not fire on a gate that is ALREADY high", () => {
  // Rack's third state. Without it every patch emits one spurious event at boot.
  const fresh = new SchmittTrigger();
  assert.equal(fresh.process(1), false, "an already-high input must not trigger");
  assert.equal(fresh.isHigh(), true, "but it must read as high");
  const armed = new SchmittTrigger();
  assert.equal(armed.process(0), false, "arming low does not trigger");
  assert.equal(armed.process(1), true, "and then a rise does");
  assert.equal(armed.process(1), false, "a level does not re-trigger");
  // 0.1 units is 0.5 V — BETWEEN the 1 V high and 0.1 V low thresholds, so the
  // gate is still high. That gap IS the hysteresis, and it is why a wobbling
  // signal does not fire dozens of times.
  assert.equal(armed.process(0.1), false, "a fall into the hysteresis band does not re-arm");
  assert.equal(armed.isHigh(), true, "and the gate is still high there");
  assert.equal(armed.process(0), false, "a fall below the low threshold re-arms it");
  assert.equal(armed.isHigh(), false, "so the gate reads low");
  assert.equal(armed.process(1), true, "and the next rise fires again");
});

// ════════════════════════════════════════════════════════════════════════════
// 7. THE CONTRACT: SPEC, ENGINE AND PLUGINS MUST AGREE
// ════════════════════════════════════════════════════════════════════════════

console.log("\nBlock contract:");

check("every spec's ports and knobs exist as engine params", () => {
  for (const spec of BLOCK_SPECS) {
    const r = row(spec.module);
    const params = new Set(r.params.map((p) => p.name));
    for (const port of spec.inputs) {
      assert.ok(params.has(port.key), `${spec.type}: input "${port.key}" is not an AudioParam`);
    }
    assert.deepEqual(spec.outputs.map((o) => o.key), r.outputs, `${spec.type}: output ports must match the roster, in order`);
    for (const k of spec.knobs) {
      if (k.discrete) continue;
      assert.ok(params.has(k.key) || r.construct.includes(k.key), `${spec.type}: knob "${k.key}" is neither a param nor construct-time`);
    }
  }
});

check("every knob's range covers the engine param's, and the defaults agree", () => {
  for (const spec of BLOCK_SPECS) {
    const r = row(spec.module);
    const byName = new Map(r.params.map((p) => [p.name, p]));
    for (const k of spec.knobs) {
      const param = byName.get(k.key);
      if (!param || k.discrete) continue;
      assert.equal(k.min, param.minValue, `${spec.type}.${k.key}: spec min must be the param's`);
      assert.equal(k.max, param.maxValue, `${spec.type}.${k.key}: spec max must be the param's`);
      assert.ok(Math.abs(k.default - param.defaultValue) < 1e-9, `${spec.type}.${k.key}: default ${k.default} vs param ${param.defaultValue}`);
    }
  }
});

check("every DISCRETE knob's options are exactly what the kernel accepts", () => {
  // The restatement core/audio_specs_vc3a.js is forced into (it may not import
  // synth/**) is pinned here, so a value offered and refused reds the suite.
  for (const spec of BLOCK_SPECS) {
    for (const k of spec.knobs) {
      if (!k.discrete) continue;
      const legal = VC3A_OPTION_VALUES[k.key];
      assert.ok(legal, `${spec.type}.${k.key}: no legal-value list`);
      assert.deepEqual(k.options, [...legal], `${spec.type}.${k.key}: options must match the kernel's list, in order`);
      assert.ok(legal.includes(k.default), `${spec.type}.${k.key}: default ${JSON.stringify(k.default)} is not a legal value`);
    }
  }
});

check("every discrete option has its setter, and a bad value is LOUD", () => {
  for (const r of VC3A_PROCESSORS) {
    const kernel = r.make(SAMPLE_RATE, {});
    for (const option of r.options) {
      const setter = vc3aOptionSetter(option);
      assert.equal(typeof kernel[setter], "function", `${r.module}: no ${setter}`);
      for (const value of VC3A_OPTION_VALUES[option]) kernel[setter](value);
      assert.throws(() => kernel[setter]("not-a-real-value"), /Unknown/, `${r.module}.${setter} must refuse an unknown value`);
    }
  }
});

check("the five contract names line up: specs, factories, worklets, plugins", () => {
  assert.equal(BLOCK_SPECS.length, VC3A_PROCESSORS.length, "one spec per processor row");
  assert.equal(BLOCK_PLUGINS.length, BLOCK_SPECS.length, "one plugin per spec");
  assert.ok(Array.isArray(BLOCK_WORKLET_MODULES), "BLOCK_WORKLET_MODULES must be an ARRAY, not a Set (AX-3 shipped a Set and it was swept back)");
  const factories = Object.keys(BLOCK_MODULE_FACTORIES).sort();
  assert.deepEqual(factories, VC3A_PROCESSORS.map((r) => r.module).sort(), "a factory per roster row");
  assert.deepEqual([...BLOCK_WORKLET_MODULES].sort(), factories, "every module is an AudioWorkletNode");
  assert.deepEqual(BLOCK_PLUGINS.map((p) => p.type), BLOCK_SPECS.map((s) => s.type), "plugins in spec order");
  const names = new Set(VC3A_PROCESSORS.map((r) => r.name));
  assert.equal(names.size, VC3A_PROCESSORS.length, "registerProcessor names must be unique");
  for (const name of names) assert.ok(name.startsWith("vc3a-"), `${name} must carry the block prefix`);
});

check("every CV SCALER param defaults to unity, not to silence (D2)", () => {
  // The trap this block's D2 exists for: a 0 default would mute every module.
  for (const r of VC3A_PROCESSORS) {
    for (const p of r.params) {
      if (!p.name.endsWith("_cv") || p.name === "select_cv") continue;
      assert.equal(p.defaultValue, CV_UNITY_UNITS, `${r.module}.${p.name} must default to 10 V (unity), got ${p.defaultValue}`);
    }
  }
});

check("R7-UNITS: a pitch port carries SEMITONES from C4, measured not assumed", () => {
  // The lead's ruling, pinned in BOTH directions. The seam is one constant, so a
  // regression would be silent and tune-shaped — the exact failure mode R7-UNITS
  // was written about.
  assert.equal(SEMITONES_PER_OCTAVE, 12, "an octave is twelve semitones");
  assert.ok(Math.abs(OCTAVES_PER_UNIT - 1 / 12) < 1e-15, `a wire unit must be one semitone, got ${OCTAVES_PER_UNIT} octaves`);
  assert.equal(SEMITONES_PER_VOLT, 12, "and a Rack V/oct volt is twelve of them");

  // FMOp: 12 on the pitch wire must DOUBLE the frequency, and 0 must be C4. Measured
  // by counting zero crossings, so it is the audible pitch under test, not the maths.
  const r = row("vcvFmop");
  const cyclesPerSecond = (semitones) => {
    const kernel = new FmOpKernel(SAMPLE_RATE, { oscillator: "clean", levelResponse: "linear" });
    const c = {};
    for (const p of r.params) c[p.name] = p.defaultValue;
    c.pitch = semitones;
    c.level = 1;
    const frame = new Float64Array(1);
    let crossings = 0;
    let previous = 0;
    const period = modulationSteps(SAMPLE_RATE);
    for (let i = 0; i < SAMPLE_RATE; i++) {
      if (i % period === 0) kernel.control(c);
      kernel.sample(c, frame);
      if (previous < 0 && frame[0] >= 0) crossings += 1;
      previous = frame[0];
    }
    return crossings;
  };
  const atC4 = cyclesPerSecond(0);
  const atC5 = cyclesPerSecond(SEMITONES_PER_OCTAVE);
  console.log(`  pitch 0 st -> ${atC4} Hz (C4 = 261.626), pitch 12 st -> ${atC5} Hz (C5 = 523.252)`);
  within("pitch 0 vs C4", Math.abs(atC4 - 261.626), 1);
  within("pitch 12 vs C5 (one octave up, not five)", Math.abs(atC5 - 523.252), 1);

  // And the LFO's pitch input is the same law: 12 doubles its rate.
  const lfoRow = row("vcvBogLfo");
  const lfoCrossings = (semitones) => {
    const trace = runKernel(new BogLfoKernel(SAMPLE_RATE, {}), lfoRow, SAMPLE_RATE, (c) => { c.frequency = 4; c.pitch = semitones; });
    const marks = [];
    for (let i = 1; i < trace.length; i++) if (trace[i - 1][4] < 0 && trace[i][4] >= 0) marks.push(i);
    return marks;
  };
  const slow = lfoCrossings(0);
  const fast = lfoCrossings(SEMITONES_PER_OCTAVE);
  within("LFO period halves at +12 st", Math.abs((slow[1] - slow[0]) / 2 - (fast[1] - fast[0])), 2);
});

check("R7-UNITS: the C4 display bridge, and it is NOT the E4 one", () => {
  // The spec file restates 261.626 because core may not import synth; this is the
  // pin that makes the restatement safe, and the E4 assertion is the trap named in
  // the ruling (an Axoloti pitch wire into a VCV port is four semitones sharp).
  within("bogaudioSemitonesToHz(0) vs the kernels' reference", Math.abs(bogaudioSemitonesToHz(0) - REFERENCE_FREQUENCY), 1e-12);
  within("an octave up doubles", Math.abs(bogaudioSemitonesToHz(12) / bogaudioSemitonesToHz(0) - 2), 1e-12);
  within("9 st is A440, within a cent", Math.abs(1200 * Math.log2(bogaudioSemitonesToHz(9) / 440)), 1);
  const AXOLOTI_E4_HZ = 329.6275569128699;
  assert.ok(Math.abs(bogaudioSemitonesToHz(0) - AXOLOTI_E4_HZ) > 60, "0 st must be C4, not Axoloti's E4");
  within("the C4/E4 gap is four semitones", Math.abs(bogaudioSemitonesToHz(4) - AXOLOTI_E4_HZ), 0.01);
});

check("R7-UNITS clause 4: every `trigger` OUTPUT stays inside 0..1", () => {
  // THE CHECK THAT WOULD HAVE CAUGHT D11. Manual's ported +10 V option put eight
  // trigger ports at 2.0 for four commits, and nothing failed — the range was
  // declared nowhere a test read. Clause 4 says logic is not level, so it is swept
  // here for EVERY module, EVERY trigger port and EVERY combination of one option
  // at a time, which is what makes a re-introduction loud instead of plausible.
  let checked = 0;
  let expected = 0;
  let modulesWithTriggers = 0;
  for (const r of VC3A_PROCESSORS) {
    const spec = BLOCK_SPECS.find((s) => s.module === r.module);
    const triggerIndices = spec.outputs.map((o, i) => [o.type, i]).filter(([type]) => type === "trigger").map(([, i]) => i);
    if (!triggerIndices.length) continue;
    modulesWithTriggers += 1;
    const optionSets = [{}];
    for (const option of r.options) {
      for (const value of VC3A_OPTION_VALUES[option]) optionSets.push({ [option]: value });
    }
    expected += optionSets.length;
    for (const options of optionSets) {
      const kernel = r.make(SAMPLE_RATE, options);
      const c = {};
      for (const p of r.params) c[p.name] = p.defaultValue;
      // Drive everything that could make a gate go high: a press, both logic
      // inputs, a clock, and a short envelope so DADSRH reaches end-of-cycle.
      c.a = 1;
      c.b = 1;
      c.not = 0;
      if ("delay" in c) { c.delay = 0; c.attack = 0.002; c.decay = 0.002; c.release = 0.002; c.hold = 0.004; }
      const frame = new Float64Array(r.outputs.length);
      let peak = 0;
      const period = modulationSteps(SAMPLE_RATE);
      for (let i = 0; i < SAMPLE_RATE / 4; i++) {
        const high = i > 20 && i % 4000 < 300 ? 1 : 0;
        c.trigger = high;
        c.clock = high;
        if (i % period === 0) kernel.control(c);
        kernel.sample(c, frame);
        for (const index of triggerIndices) peak = Math.max(peak, Math.abs(frame[index]));
      }
      assert.ok(peak <= 1, `${r.module} ${JSON.stringify(options)}: a trigger port reached ${peak}, outside 0..1`);
      checked += 1;
    }
  }
  // NOT VACUOUS, and the expectation is DERIVED rather than typed: one run per
  // module per option value plus one with no options, across every module that has a
  // trigger output at all (DADSRH, Bool, Manual). A count typed here would go stale
  // the first time an option gained a value.
  console.log(`  ${"trigger-port sweeps (module x option value)".padEnd(52)} ${checked} over ${modulesWithTriggers} modules`);
  assert.equal(checked, expected, "every module-and-option combination must have run");
  assert.equal(modulesWithTriggers, BLOCK_SPECS.filter((s) => s.outputs.some((o) => o.type === "trigger")).length, "every trigger-emitting module must be in the sweep");
  assert.ok(modulesWithTriggers >= 3, `three modules emit triggers, swept ${modulesWithTriggers}`);
});

check("R7-UNITS clause 4: a full gate is 1, and the thresholds are fractions of it", () => {
  assert.equal(GATE_UNITS, 1, "a full gate is 1, not five volts over five");
  assert.equal(GATE_HIGH_UNITS, 0.2, "Bogaudio fires at one fifth of a full gate (its 1 V on a 5 V gate)");
  assert.equal(GATE_LOW_UNITS, 0.02, "and re-arms at one fiftieth");
  // Bool's gate: it was accidentally right when written in volts, so pin the value.
  const bool = new BoolKernel();
  const frame = new Float64Array(4);
  bool.sample({ a: 1, b: 1, not: 0 }, frame);
  assert.equal(frame[0], GATE_UNITS, "Bool's AND must emit exactly one full gate");
});

check("R7-UNITS: every pitch param's bound is +/-120 semitones", () => {
  for (const r of VC3A_PROCESSORS) {
    for (const p of r.params) {
      if (p.name !== "pitch") continue;
      assert.equal(p.maxValue, 10 * SEMITONES_PER_OCTAVE, `${r.module}.pitch must reach Rack's +/-10 V, i.e. ten octaves`);
      assert.equal(p.minValue, -10 * SEMITONES_PER_OCTAVE, `${r.module}.pitch must reach it downward too`);
    }
  }
});

check("the control divider is Bogaudio's 2.5 ms, not a quantum and not a sample", () => {
  assert.equal(modulationSteps(48000), 120, "48 kHz gives 120 samples between knob reads");
  assert.equal(modulationSteps(44100), 110, "44.1 kHz gives 110");
  assert.ok(modulationSteps(48000) !== 128, "and it is deliberately NOT one render quantum");
});

check("no kernel produces a non-finite sample from its own defaults", () => {
  for (const r of VC3A_PROCESSORS) {
    const trace = runKernel(r.make(SAMPLE_RATE, {}), r, SAMPLE_RATE, null);
    for (let i = 0; i < trace.length; i++) {
      for (const v of trace[i]) assert.ok(Number.isFinite(v), `${r.module} emitted ${v} at sample ${i}`);
    }
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}\n`);
