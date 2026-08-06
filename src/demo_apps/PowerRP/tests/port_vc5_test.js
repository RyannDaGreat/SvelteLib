/**
 * VC-5 PORT PROOF — nine ported VCV Rack modules, measured.
 * Run: node src/demo_apps/PowerRP/tests/port_vc5_test.js
 *
 * ── WHY THIS FILE IS SHAPED LIKE THIS ───────────────────────────────────────
 * `tests/port_ax3_test.js` is the gold standard for a FIXED-POINT port: it
 * reproduces Axoloti's `___SMMUL`/`__SSAT` in BigInt so every truncation lands
 * where theirs does. A VCV port is float-to-float, so the equivalent is different
 * and R7-11 says what it is: a numeric trace against the C++ recurrence
 * TRANSCRIBED LINE BY LINE, plus a measured figure wherever the module is a filter
 * or a reverb.
 *
 * So there are two kinds of check here:
 *
 *  1. THE TANK TRACE. `datorroTankReference` below is an INDEPENDENT, literal
 *     transcription of `Dattorro1997Tank::process` — its own ring buffers, its own
 *     statement order, written from the C++ and not from the shipped kernel. A
 *     4096-sample trace is diffed against `DattorroTank` sample by sample. That is
 *     the check that catches a self-consistent wrong transcription, which is the
 *     one interesting failure mode of a port.
 *
 *  2. MEASURED FIGURES. For a reverb, "it makes sound" is not a test. The brief
 *     names three and they are all here: RT60 at named Size and Decay settings
 *     (Schroeder backward integration, T30 extrapolated), no runaway at maximum
 *     feedback, and the ECHO DENSITY GROWTH CURVE of the impulse response — which
 *     is the thing that distinguishes a plate from a delay line and which no
 *     amplitude check can see. For the filters, measured gain at named frequencies
 *     against the closed-form response of the topology being ported.
 *
 * WHAT THIS FILE DOES NOT PROVE: that any of it sounds like the original modules.
 * It proves the arithmetic matches the C++ to the tolerances quoted per check, and
 * that the measured behaviour is the behaviour the module is supposed to have. For
 * the two BEHAVIOUR-DERIVED nodes (Chronoblob2, XFX F-35) there is no C++ to diff
 * against at all, and the checks are correspondingly weaker — they verify the
 * documented behaviour (tape mode pitch-shifts, sync locks to the clock, every
 * shipped filter mode has the slope its name claims) and nothing more. That
 * asymmetry is real and is stated rather than papered over.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BLOCK_SPECS } from "../core/audio_specs_vc5.js";
import { audioKnobDefaults, audioKnobRows, audioNodePlugin } from "../core/audio_nodes.js";
import { NODE_FAMILY_NAMES } from "../core/node_chrome.js";
import { PORT_TYPE_NAMES } from "../core/nodeflow.js";
import { AUDIO_SPECS } from "../core/audio_specs.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES } from "../synth/modules_vc5.js";
import { VC5_PROCESSORS, vc5OptionSetter } from "../synth/worklets/processors_vc5.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_vc5.js";
import {
  Chronoblob2Kernel, DattorroTank, FelineKernel, JustAPhaserKernel, PlateauKernel,
  ReburstKernel, RewinKernel, SHAPERS, SHAPE_NAMES, SpfKernel, TF_BANKS, TerrorformKernel,
  Xfxf35Kernel, XFXF35_MODES, circleWrap, clampTo, linterp, tanhDriveSignal, wrapUnit,
  chronoblobDivisionNames, vcvSemitonesToHz, xfxf35ShippedModes,
} from "../synth/vc5_kernels.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/** The rate every measurement below is taken at. 48 kHz because that is what a
 *  browser AudioContext gives us and therefore what a rendered document uses —
 *  and, for Plateau, the rate at which D-TANKRATE's 44100 clamp actually bites. */
const FS = 48000;

// ════════════════════════════════════════════════════════════════════════════
// 1. THE TANK TRACE — an independent transcription of the C++, diffed
// ════════════════════════════════════════════════════════════════════════════

/**
 * Query. `Dattorro1997Tank::process` transcribed AGAIN, from the C++, with its own
 * ring buffers and its own statement order — NOT by calling the shipped classes.
 *
 * This is the whole point of the file: two independent transcriptions of the same
 * C++ agreeing sample-for-sample is evidence the transcription is right, where one
 * transcription checked against itself is evidence of nothing. Written flat and
 * deliberately un-refactored so it reads next to the C++ line by line.
 *
 * Configuration is FIXED (no freeze, no modulation, one Size, one Decay, one
 * Diffusion) because the trace's job is the recurrence and the taps, not the
 * setters — those are covered by the measured checks below. `modDepth` is 0 so the
 * four LFOs contribute nothing and the allpass delay times are constant, which is
 * what makes an independent transcription tractable at all.
 *
 * @param {number[]} input - the mono signal fed to both halves
 * @param {number} timeScale - Size, in Dattorro time units
 * @param {number} decayParam - tank loop gain
 * @param {number} diffusion - 0..10
 * @returns {{left: number[], right: number[]}}
 */
function dattorroTankReference(input, timeScale, decayParam, diffusion) {
  const DATTORRO_RATE = 29761;
  // D-TANKRATE: the tank clamps ITSELF to 44100 whatever it is told.
  const sampleRate = Math.min(FS, 44100);
  const S = sampleRate / DATTORRO_RATE;
  const T = { la1: 672, ld1: 4453, la2: 1800, ld2: 3720, ra1: 908, rd1: 4217, ra2: 2656, rd2: 3163 };
  const OUT_TAPS = [266, 2974, 1913, 1996, 1990, 187, 1066];
  const taps = OUT_TAPS.map((t) => Math.trunc(t * S));
  const maxTap = Math.max(...taps);
  const maxTimeScale = 4;
  const padding = 16;
  const size = (t) => Math.trunc(S * (t * maxTimeScale + maxTap + padding));

  // A delay line, transcribed from InterpDelay: write at w, read at w - t, THEN
  // increment w; `tap(i)` reads buffer[w - i] AFTER that increment.
  const line = (len, delay) => {
    const b = new Float64Array(len);
    const o = { b, w: 0, l: len, t: 0, f: 0, input: 0, output: 0 };
    o.set = (d) => {
      const c = d >= len ? len - 1 : d < 0 ? 0 : d;
      o.t = Math.trunc(c);
      o.f = c - o.t;
    };
    o.step = () => {
      o.b[o.w] = o.input;
      let r = o.w - o.t;
      if (r < 0) r += o.l;
      o.w += 1;
      if (o.w === o.l) o.w = 0;
      let u = r - 1;
      if (u < 0) u += o.l;
      o.output = o.b[r] + o.f * (o.b[u] - o.b[r]);
    };
    o.tap = (i) => {
      let j = o.w - i;
      if (j < 0) j += o.l;
      return o.b[j];
    };
    o.set(delay);
    return o;
  };

  const factor = timeScale * S;
  const apf = (len, delay, gain) => {
    const d = line(len, delay);
    return {
      d,
      gain,
      input: 0,
      output: 0,
      step() {
        const inSum = this.input + d.output * this.gain;
        this.output = d.output - inSum * this.gain;
        d.input = inSum;
        d.step();
        return this.output;
      },
    };
  };

  const d1 = diffusion / 10 * 0.7;
  const d2 = diffusion / 10 * 0.7;
  const la1 = apf(size(T.la1), T.la1 * factor, -d1);
  const ld1 = line(size(T.ld1), T.ld1 * factor);
  const la2 = apf(size(T.la2), T.la2 * factor, d2);
  const ld2 = line(size(T.ld2), T.ld2 * factor);
  const ra1 = apf(size(T.ra1), T.ra1 * factor, -d1);
  const rd1 = line(size(T.rd1), T.rd1 * factor);
  const ra2 = apf(size(T.ra2), T.ra2 * factor, d2);
  const rd2 = line(size(T.rd2), T.rd2 * factor);

  // OnePoleLPFilter at the DEFAULT 44100 (D-TANKFILTERRATE) and its default
  // 22049 Hz cutoff, and OnePoleHPFilter at 44100 with the default 10 Hz — those
  // are the constructor values the tank never overrides for the damping pair here,
  // because this reference sets no damping. Their coefficients, verbatim.
  const lp = () => {
    const fc = Math.min(22049, 44100 / 2 - 1);
    const b = Math.exp((-2 * Math.PI * fc) / 44100);
    return { a: 1 - b, b, z: 0, run(x) { this.z = this.a * x + this.z * this.b; return this.z; } };
  };
  const hp = (fc, rate) => {
    const b1 = Math.exp((-2 * Math.PI * fc) / rate);
    const a0 = (1 + b1) / 2;
    return { a0, a1: -a0, b1, x1: 0, y1: 0, run(x) { const y = this.a0 * x + this.a1 * this.x1 + this.b1 * this.y1; this.x1 = x; this.y1 = y; return y; } };
  };
  const lHigh = lp();
  const rHigh = lp();
  const lLow = hp(10, 44100);
  const rLow = hp(10, 44100);
  const lDc = hp(20, sampleRate);
  const rDc = hp(20, sampleRate);

  let leftSum = 0;
  let rightSum = 0;
  const fade = 1;
  const left = [];
  const right = [];
  for (const x of input) {
    const decay = decayParam;
    leftSum += x;
    rightSum += x;

    la1.input = leftSum;
    ld1.input = la1.step();
    ld1.step();
    la2.input = (ld1.output * (1 - fade) + lLow.run(lHigh.run(ld1.output)) * fade) * decay;
    ld2.input = la2.step();
    ld2.step();

    ra1.input = rightSum;
    rd1.input = ra1.step();
    rd1.step();
    ra2.input = (rd1.output * (1 - fade) + rLow.run(rHigh.run(rd1.output)) * fade) * decay;
    rd2.input = ra2.step();
    rd2.step();

    rightSum = ld2.output * decay;
    leftSum = rd2.output * decay;

    let l = la1.output;
    l += ld1.tap(taps[0]);
    l += ld1.tap(taps[1]);
    l -= la2.d.tap(taps[2]);
    l += ld2.tap(taps[3]);
    l -= rd1.tap(taps[4]);
    l -= ra2.d.tap(taps[5]);
    l -= rd2.tap(taps[6]);

    let r = ra1.output;
    r += rd1.tap(taps[0]);
    r += rd1.tap(taps[1]);
    r -= ra2.d.tap(taps[2]);
    r += rd2.tap(taps[3]);
    r -= ld1.tap(taps[4]);
    r -= la2.d.tap(taps[5]);
    r -= ld2.tap(taps[6]);

    left.push(lDc.run(l) * 0.5);
    right.push(rDc.run(r) * 0.5);
  }
  return { left, right };
}

check("THE TANK TRACE: DattorroTank matches an independent transcription of the C++, sample for sample", () => {
  const N = 4096;
  const input = Array.from({ length: N }, (_, i) => (i === 0 ? 1 : 0));
  const timeScale = 1;
  const decay = 0.9;
  const diffusion = 10;

  const tank = new DattorroTank(FS, 16, 4);
  tank.setTimeScale(timeScale);
  tank.setDecay(decay);
  tank.setDiffusion(diffusion);
  tank.setModDepth(0);
  tank.setModSpeed(1);
  // The damping filters keep their CONSTRUCTOR values, which is what the
  // reference models — setting them here would test a different thing.
  const out = new Float64Array(2);
  const mine = { left: [], right: [] };
  for (const x of input) {
    tank.process(x, x, out);
    mine.left.push(out[0]);
    mine.right.push(out[1]);
  }

  const ref = dattorroTankReference(input, timeScale, decay, diffusion);
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < N; i++) {
    const dl = Math.abs(mine.left[i] - ref.left[i]);
    const dr = Math.abs(mine.right[i] - ref.right[i]);
    const d = Math.max(dl, dr);
    if (d > worst) {
      worst = d;
      worstAt = i;
    }
  }
  // The two transcriptions do the SAME double arithmetic in the SAME order, so
  // they should agree to the last bit. A tolerance of 1e-12 is here only so a
  // future refactor that reassociates one sum does not turn this red for a reason
  // nobody can hear; anything above it means the RECURRENCE differs.
  assert.ok(worst < 1e-12, `tank trace diverges by ${worst} at sample ${worstAt} — the recurrence differs from the C++`);

  // And the trace must be NON-TRIVIAL: two silent transcriptions also agree.
  const energy = mine.left.reduce((a, v) => a + v * v, 0);
  assert.ok(energy > 1e-3, `the trace is silent (energy ${energy}) — it proves nothing`);
  const distinct = new Set(mine.left.map((v) => v.toFixed(9))).size;
  assert.ok(distinct > N / 4, `only ${distinct} distinct samples in ${N} — the trace is not a reverb`);
});

check("the seven output taps are SHARED between channels, which is theirs and is why the two halves differ only by delay length", () => {
  // Both LeftOutTaps and RightOutTaps index the same seven-entry kOutputTaps, so
  // there are 7 offsets, not Dattorro's 14. If someone "fixes" that, this reddens.
  assert.equal(DattorroTank.OUTPUT_TAPS.length, 7, "seven taps, shared");
  // The two halves must still decorrelate, from their delay lengths alone.
  const tank = new DattorroTank(FS, 16, 4);
  tank.setTimeScale(1);
  tank.setDecay(0.9);
  tank.setDiffusion(10);
  tank.setModDepth(0);
  const out = new Float64Array(2);
  const l = [];
  const r = [];
  for (let i = 0; i < 20000; i++) {
    tank.process(i === 0 ? 1 : 0, i === 0 ? 1 : 0, out);
    l.push(out[0]);
    r.push(out[1]);
  }
  const dot = l.reduce((a, v, i) => a + v * r[i], 0);
  const nl = Math.sqrt(l.reduce((a, v) => a + v * v, 0));
  const nr = Math.sqrt(r.reduce((a, v) => a + v * v, 0));
  const correlation = Math.abs(dot / (nl * nr));
  assert.ok(correlation < 0.5, `the two halves correlate at ${correlation.toFixed(3)} — a mono reverb, not a plate`);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. PLATEAU MEASURED — RT60, no runaway, echo density growth
// ════════════════════════════════════════════════════════════════════════════

/** Query. Plateau's impulse response, `seconds` long, at a named knob set. */
function plateauImpulse(overrides, seconds) {
  const kernel = new PlateauKernel(FS, {});
  const c = {
    dry: 0, wet: 1, pre_delay: 0,
    input_low_damp: 10, input_high_damp: 10,
    size: 0.5, diffusion: 10, decay: 0.54995,
    reverb_low_damp: 10, reverb_high_damp: 10,
    mod_speed: 0, mod_shape: 0.5, mod_depth: 0.5,
    freeze: 0, clear: 0,
    ...overrides,
  };
  const n = Math.round(seconds * FS);
  const input = new Float64Array(2);
  const frame = new Float64Array(2);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    input[0] = i === 0 ? 1 : 0;
    input[1] = input[0];
    kernel.sample(c, input, frame);
    y[i] = frame[0];
  }
  return y;
}

/**
 * Pure function. RT60 by SCHROEDER BACKWARD INTEGRATION, extrapolated from T30
 * (the −5 dB to −35 dB span, doubled) — the standard estimator, and the reason it
 * is not "time to fall 60 dB" is that a real tail reaches the noise floor first.
 *
 * @param {Float64Array} y - an impulse response
 * @param {number} sampleRate
 * @returns {number} seconds
 *
 * @example // rt60 of a 1 s exponential decay at 48 kHz is about 1 s
 */
function rt60(y, sampleRate) {
  let total = 0;
  for (const v of y) total += v * v;
  const edc = new Float64Array(y.length);
  let acc = 0;
  for (let i = y.length - 1; i >= 0; i--) {
    acc += y[i] * y[i];
    edc[i] = acc / total;
  }
  const timeAt = (db) => {
    const threshold = Math.pow(10, db / 10);
    for (let i = 0; i < edc.length; i++) if (edc[i] <= threshold) return i / sampleRate;
    return NaN;
  };
  return (timeAt(-35) - timeAt(-5)) * 2;
}

/**
 * Pure function. ECHO DENSITY as zero crossings per window — the measure that
 * distinguishes a PLATE from a delay line. A delay line's density is flat (the
 * same handful of echoes, quieter); a diffuse reverb's density GROWS as the
 * allpass network multiplies each echo into more.
 *
 * @param {Float64Array} y
 * @param {number} windows - how many equal windows to report
 * @param {number} windowSamples
 * @returns {number[]} zero crossings per window
 *
 * @example // echoDensity(plateauImpulse({}, 1), 4, 2048) rises monotonically-ish
 */
function echoDensity(y, windows, windowSamples) {
  const out = [];
  for (let w = 0; w < windows; w++) {
    const a = w * windowSamples;
    let z = 0;
    for (let i = a + 1; i < a + windowSamples; i++) if ((y[i] > 0) !== (y[i - 1] > 0)) z += 1;
    out.push(z);
  }
  return out;
}

check("PLATEAU RT60 rises monotonically with Decay, at named settings", () => {
  // Named settings, so a regression names a number rather than a direction.
  const measured = [0.2, 0.4, 0.55, 0.7, 0.9].map((decay) => rt60(plateauImpulse({ decay }, 12), FS));
  for (let i = 1; i < measured.length; i++) {
    assert.ok(measured[i] > measured[i - 1], `RT60 must rise with Decay: ${measured.map((v) => v.toFixed(2)).join(" ")}`);
  }
  // The taper is `1 - (1 - dial)^2`, so the dial's default 0.55 is a MEDIUM hall,
  // not a room and not infinite. Measured 5.5 s at Size 0.5; the window is wide
  // because the four LFOs and the sample rate both move it.
  const atDefault = rt60(plateauImpulse({ decay: 0.54995 }, 12), FS);
  assert.ok(atDefault > 3 && atDefault < 9, `RT60 at the default Decay should be a medium hall, got ${atDefault.toFixed(2)} s`);
});

check("PLATEAU RT60 rises with Size, and a tiny Size is a small bright room", () => {
  const small = rt60(plateauImpulse({ size: 0.05 }, 12), FS);
  const medium = rt60(plateauImpulse({ size: 0.5 }, 12), FS);
  const large = rt60(plateauImpulse({ size: 0.9 }, 12), FS);
  assert.ok(small < medium && medium < large, `RT60 must rise with Size: ${[small, medium, large].map((v) => v.toFixed(2)).join(" ")}`);
  assert.ok(small < 1, `Size 0.05 should be under a second, got ${small.toFixed(3)} s`);
});

check("PLATEAU high-cut damping SHORTENS the tail — the filters are INSIDE the loop", () => {
  // This is the check that the damping filters are in the recirculating path
  // rather than on the output. On the output they would change the timbre and
  // leave RT60 alone; inside the loop each pass loses more, so the tail is
  // measurably shorter. Dial 0 is the most damping (the dial is offset by +5).
  const open = rt60(plateauImpulse({ reverb_high_damp: 10 }, 12), FS);
  const damped = rt60(plateauImpulse({ reverb_high_damp: 0 }, 12), FS);
  assert.ok(damped < open * 0.95, `in-loop damping must shorten the tail: open ${open.toFixed(2)} s vs damped ${damped.toFixed(2)} s`);
});

check("PLATEAU echo density GROWS across the impulse response — a plate, not a delay line", () => {
  const y = plateauImpulse({ decay: 0.7 }, 2);
  const density = echoDensity(y, 8, 2048);
  // The first window contains the onset (mostly silence before the first
  // reflection), so the comparison that matters is the SECOND half against the
  // second window: a delay line's density would be flat or falling.
  const early = density[1];
  const late = density[7];
  assert.ok(late > early, `echo density must grow: ${density.join(" ")}`);
  // And it must actually be dense, not two echoes. 2048 samples at 48 kHz is
  // 43 ms; a hundred zero crossings in that is a diffuse field.
  assert.ok(late > 100, `late echo density ${late} per 2048 samples is not a diffuse field`);
});

check("PLATEAU diffusion 0 is measurably LESS dense than diffusion 10", () => {
  // The four tank allpasses are what multiply echoes. At gain 0 they are bare
  // delays, so the field should be sparser. This is the check that the allpass
  // gains reach the sections at all.
  const dense = echoDensity(plateauImpulse({ decay: 0.7, diffusion: 10 }, 1), 4, 4096);
  const sparse = echoDensity(plateauImpulse({ decay: 0.7, diffusion: 0 }, 1), 4, 4096);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(dense) > sum(sparse), `diffusion must increase density: ${sum(dense)} vs ${sum(sparse)}`);
});

check("PLATEAU does not run away at MAXIMUM feedback, and its tail is bounded by the loop gain", () => {
  // Decay dial 0.9999 becomes 1 - 1e-8 through the taper, so the geometric sum
  // converges to 1e8 x input rather than diverging — but "converges to 1e8" is not
  // the same as "bounded", so what is asserted is: FINITE after a long drive, and
  // the OUTPUT bounded by the module's own +/-10 V clamp (2.0 in our +/-1 units).
  const kernel = new PlateauKernel(FS, {});
  const c = {
    dry: 0, wet: 1, pre_delay: 0, input_low_damp: 10, input_high_damp: 10,
    size: 1, diffusion: 10, decay: 0.9999, reverb_low_damp: 10, reverb_high_damp: 10,
    mod_speed: 0.5, mod_shape: 0.5, mod_depth: 1, freeze: 0, clear: 0,
  };
  const input = new Float64Array(2);
  const frame = new Float64Array(2);
  let phase = 0;
  let peak = 0;
  for (let i = 0; i < FS * 20; i++) {
    const v = Math.sin(phase);
    phase += (2 * Math.PI * 220) / FS;
    input[0] = v;
    input[1] = v;
    kernel.sample(c, input, frame);
    peak = Math.max(peak, Math.abs(frame[0]), Math.abs(frame[1]));
  }
  assert.ok(Number.isFinite(peak), "20 s of full-scale drive at Decay 0.9999 produced a non-finite sample");
  assert.ok(peak <= 2 + 1e-9, `the +/-10 V output clamp must hold: peak ${peak}`);
  // And the internal state must still be finite — a NaN in a delay line is
  // permanent, so this is the check that matters more than the output's.
  input[0] = 0;
  input[1] = 0;
  for (let i = 0; i < FS * 20; i++) {
    kernel.sample(c, input, frame);
    assert.ok(Number.isFinite(frame[0]) && Number.isFinite(frame[1]), `non-finite sample ${i} into the tail`);
  }
});

check("PLATEAU at a decay BELOW unity strictly decays, so the loop gain is not accidentally >= 1", () => {
  const y = plateauImpulse({ decay: 0.6, size: 1 }, 20);
  const rmsOver = (a, b) => {
    let s = 0;
    for (let i = a; i < b; i++) s += y[i] * y[i];
    return Math.sqrt(s / (b - a));
  };
  const first = rmsOver(FS * 1, FS * 2);
  const middle = rmsOver(FS * 8, FS * 9);
  const last = rmsOver(FS * 18, FS * 19);
  assert.ok(first > middle && middle > last, `energy must fall: ${[first, middle, last].map((v) => v.toExponential(2)).join(" ")}`);
  assert.ok(last < first * 0.1, `the tail must lose at least 20 dB over 17 s: ${(last / first).toExponential(2)}`);
});

check("PLATEAU Hold makes the tank hold — the freeze latch reaches the loop", () => {
  const kernel = new PlateauKernel(FS, { hold: "off" });
  const c = {
    dry: 0, wet: 1, pre_delay: 0, input_low_damp: 10, input_high_damp: 10,
    size: 0.5, diffusion: 10, decay: 0.3, reverb_low_damp: 10, reverb_high_damp: 10,
    mod_speed: 0, mod_shape: 0.5, mod_depth: 0, freeze: 0, clear: 0,
  };
  const input = new Float64Array(2);
  const frame = new Float64Array(2);
  const rms = (samples) => Math.sqrt(samples.reduce((a, v) => a + v * v, 0) / samples.length);
  const run = (n, drive, freeze) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = drive ? Math.sin((2 * Math.PI * 220 * i) / FS) : 0;
      input[0] = v;
      input[1] = v;
      c.freeze = freeze;
      kernel.sample(c, input, frame);
      out.push(frame[0]);
    }
    return out;
  };
  run(FS, true, 0);
  const held = run(FS * 3, false, 1);
  const early = rms(held.slice(0, FS / 2));
  const late = rms(held.slice(FS * 2.5, FS * 3));
  // Decay 0.3 alone would be inaudible after 2.5 s; frozen it must persist. The
  // one-second fade of the damping filters out of the loop (D-FADETIME) means the
  // level still settles, so the bound is generous — what is asserted is that the
  // tail SURVIVES rather than that it is exactly flat.
  assert.ok(late > early * 0.05, `a held tank must sustain: early ${early.toExponential(2)} late ${late.toExponential(2)}`);
  const free = new PlateauKernel(FS, {});
  const freeInput = new Float64Array(2);
  const freeFrame = new Float64Array(2);
  for (let i = 0; i < FS; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / FS);
    freeInput[0] = v;
    freeInput[1] = v;
    free.sample(c, freeInput, freeFrame);
  }
  const decaying = [];
  freeInput[0] = 0;
  freeInput[1] = 0;
  for (let i = 0; i < FS * 3; i++) {
    free.sample({ ...c, freeze: 0 }, freeInput, freeFrame);
    decaying.push(freeFrame[0]);
  }
  const freeLate = rms(decaying.slice(FS * 2.5, FS * 3));
  assert.ok(late > freeLate * 10, `Hold must sustain far longer than Decay 0.3 does: held ${late.toExponential(2)} vs free ${freeLate.toExponential(2)}`);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE FILTERS MEASURED against the closed-form response of their topology
// ════════════════════════════════════════════════════════════════════════════

/** Query. Steady-state gain of a kernel at one frequency, by driving a sine and
 *  taking the peak of the second half. Crude but topology-independent, which is
 *  what lets one helper measure four different filters. */
function sineGain(step, hz, amplitude = 0.1, seconds = 0.5) {
  const n = Math.round(seconds * FS);
  let phase = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const y = step(amplitude * Math.sin(phase));
    phase += (2 * Math.PI * hz) / FS;
    if (i > n * 0.6) peak = Math.max(peak, Math.abs(y));
  }
  return peak / amplitude;
}

check("FELINE tracks its dial exactly and has the slope its Poles switch claims", () => {
  const drive = (dial, poles, type) => {
    const kernel = new FelineKernel(FS);
    kernel.setPoles(poles);
    kernel.setType(type);
    const c = { cutoff: dial, resonance: 0, spacing: 0, spacing_target: 0, drive: 0 };
    const input = new Float64Array(2);
    const frame = new Float64Array(3);
    return (x) => {
      input[0] = x;
      input[1] = x;
      kernel.sample(c, input, frame);
      return frame[0];
    };
  };
  // The cutoff dial is `440 * 2^(dial - 5)`, so the gain AT the dial's own
  // frequency must be the same at every dial position. That is the check that the
  // dial maps to frequency and not to something dial-dependent.
  const atCutoff = [3, 5, 7].map((dial) => sineGain(drive(dial, "4", "lowpass"), 440 * Math.pow(2, dial - 5)));
  for (const g of atCutoff) {
    assert.ok(Math.abs(g - atCutoff[0]) < 0.01, `Feline's cutoff must track its dial: ${atCutoff.map((v) => v.toFixed(4)).join(" ")}`);
  }
  // FOUR POLES IS 24 dB/OCTAVE. Two octaves above cutoff a 4-pole is 1/256 of its
  // passband; a 2-pole is 1/16. The two must therefore differ by a factor of ~16.
  const fc = 440;
  const passband = sineGain(drive(5, "4", "lowpass"), fc / 8);
  const fourPole = sineGain(drive(5, "4", "lowpass"), fc * 4);
  const twoPole = sineGain(drive(5, "2", "lowpass"), fc * 4);
  const fourPoleRatio = passband / fourPole;
  const twoPoleRatio = passband / twoPole;
  assert.ok(fourPoleRatio / twoPoleRatio > 8 && fourPoleRatio / twoPoleRatio < 32,
    `4 poles must roll off ~16x faster than 2 at two octaves: ${(fourPoleRatio / twoPoleRatio).toFixed(1)}x`);
  // A 4-pole lowpass at its own cutoff is -12 dB (1/4 of passband) by construction.
  const ratioAtCutoff = passband / sineGain(drive(5, "4", "lowpass"), fc);
  assert.ok(Math.abs(ratioAtCutoff - 4) < 0.6, `a 4-pole at cutoff should be 1/4 of passband, got 1/${ratioAtCutoff.toFixed(2)}`);
  // Bandpass must PEAK at cutoff instead.
  const bpAt = sineGain(drive(5, "2", "bandpass"), fc);
  const bpBelow = sineGain(drive(5, "2", "bandpass"), fc / 8);
  assert.ok(bpAt > bpBelow * 4, `BP2 must peak at cutoff: ${bpAt.toFixed(3)} vs ${bpBelow.toFixed(3)} below`);
});

check("FELINE's resonance reaches self-oscillation at the dial's top, and k = 0.4 x dial is why", () => {
  assert.equal(FelineKernel.K_PER_RESO, 0.4, "k = 0.4 x dial, so dial 10 gives the ladder's k = 4");
  const kernel = new FelineKernel(FS);
  const c = { cutoff: 5, resonance: 10, spacing: 0, spacing_target: 0, drive: 0 };
  const input = new Float64Array(2);
  const frame = new Float64Array(3);
  // A single impulse into a self-oscillating ladder must keep ringing.
  let late = 0;
  for (let i = 0; i < FS; i++) {
    input[0] = i === 0 ? 1 : 0;
    input[1] = input[0];
    kernel.sample(c, input, frame);
    if (i > FS * 0.8) late = Math.max(late, Math.abs(frame[0]));
    assert.ok(Number.isFinite(frame[0]), `Feline went non-finite at sample ${i}`);
  }
  assert.ok(late > 1e-4, `resonance 10 must still be ringing after 0.8 s, got ${late.toExponential(2)}`);
});

check("D-FLOAT: Feline's float64-vs-float32 divergence is MEASURED, not asserted", () => {
  // THE CHECK THE DEVIATION NAMES. `core/audio_specs_vc5.js` claims this file
  // reports the divergence, and a docblock that names a check which does not exist
  // is this project's worst-measured defect class — so here it is.
  //
  // Their VecOTAFilter is float32 SIMD; ours is float64 scalar. The ladder is a
  // FEEDBACK structure, so single-precision rounding compounds rather than
  // cancelling. The model below is our own recurrence with every intermediate
  // rounded through Math.fround, which is what float32 arithmetic does, so the
  // difference between the two IS the precision cost and nothing else.
  const f32 = Math.fround;
  const drive32 = (x) => {
    const xd = f32(x);
    if (xd < -1.25) return -1;
    if (xd < -0.75) return f32(-f32(f32(xd * f32(-2.5 - xd)) - 0.5625));
    if (xd > 1.25) return 1;
    if (xd > 0.75) return f32(f32(xd * f32(2.5 - xd)) - 0.5625);
    return xd;
  };
  const ladder32 = (dial, reso, taps, n) => {
    const g = f32(Math.tan(f32((Math.PI * (440 * Math.pow(2, dial - 5))) / FS)));
    const oneOverH = f32(1 / f32(1 + g));
    const G = f32(g * oneOverH);
    const G2 = f32(G * G);
    const G3 = f32(G2 * G);
    const gamma = f32(G2 * G2);
    const k = f32(0.4 * reso);
    const oneOverTanh = f32(1 / 0.9375);
    const z = new Float32Array(4);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = f32(i === 0 ? 1 * 5 * 0.75 * 0.5 : 0);
      let sigma = f32(G3 * z[0]);
      sigma = f32(sigma + f32(G2 * z[1]));
      sigma = f32(sigma + f32(G * z[2]));
      sigma = f32(f32(sigma + z[3]) * oneOverH);
      let u = f32(x * 0.5);
      u = f32(u - f32(f32(k * drive32(sigma)) * oneOverTanh));
      u = f32(u / f32(1 + f32(k * gamma)));
      let v = u;
      const lp = new Float32Array(4);
      for (let stage = 0; stage < 4; stage++) {
        const vv = f32(f32(drive32(v) - z[stage]) * G);
        const o = drive32(f32(vv + z[stage]));
        z[stage] = f32(o + vv);
        v = o;
        lp[stage] = o;
      }
      out[i] = taps[0] * lp[0] + taps[1] * lp[1] + taps[2] * lp[2] + taps[3] * lp[3];
    }
    return out;
  };
  const N = 4096;
  const kernel = new FelineKernel(FS);
  kernel.setPoles("4");
  kernel.setType("lowpass");
  const c = { cutoff: 5, resonance: 8, spacing: 0, spacing_target: 0, drive: 0 };
  const input = new Float64Array(2);
  const frame = new Float64Array(3);
  const mine = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    input[0] = i === 0 ? 1 : 0;
    input[1] = input[0];
    kernel.sample(c, input, frame);
    mine[i] = frame[0];
  }
  const theirs = ladder32(5, 8, [0, 0, 0, 1], N);
  let worst = 0;
  let energy = 0;
  for (let i = 0; i < N; i++) {
    worst = Math.max(worst, Math.abs(mine[i] - theirs[i]));
    energy += mine[i] * mine[i];
  }
  const rms = Math.sqrt(energy / N);
  const relative = worst / rms;
  // THE NUMBER, so a regression that changes the recurrence rather than the
  // precision shows up. At resonance 8 (k = 3.2, near self-oscillation) the two
  // must still track: single-precision rounding on a ringing 4-pole ladder is a
  // small fraction of the signal, not a different filter. A blown assertion here
  // means the two are not the same recurrence at all.
  assert.ok(Number.isFinite(relative), "the float32 model went non-finite");
  assert.ok(relative < 0.05,
    `float32 vs float64 must differ only by precision: worst |diff| ${worst.toExponential(3)} = ${(relative * 100).toFixed(2)}% of RMS ${rms.toExponential(3)}`);
  // And it must be NON-ZERO, or the "model" is secretly the same arithmetic and
  // proves nothing about precision.
  assert.ok(worst > 0, "the float32 model must actually round differently");
  console.log(`  (D-FLOAT measured: float32 vs float64 worst |diff| = ${worst.toExponential(3)}, ${(relative * 100).toFixed(3)}% of RMS, at resonance 8)`);
});

check("FELINE Spacing really splits the two channels' cutoffs", () => {
  const kernel = new FelineKernel(FS);
  const c = { cutoff: 5, resonance: 0, spacing: 1, spacing_target: 0, drive: 0 };
  const input = new Float64Array(2);
  const frame = new Float64Array(3);
  // Right is cutoff + 1 octave, left is cutoff (target 0). Drive a tone an octave
  // above the dial: the right channel should pass more of it.
  let peakL = 0;
  let peakR = 0;
  for (let i = 0; i < FS / 2; i++) {
    const v = 0.1 * Math.sin((2 * Math.PI * 880 * i) / FS);
    input[0] = v;
    input[1] = v;
    kernel.sample(c, input, frame);
    if (i > FS / 4) {
      peakL = Math.max(peakL, Math.abs(frame[0]));
      peakR = Math.max(peakR, Math.abs(frame[1]));
    }
  }
  assert.ok(peakR > peakL * 2, `Spacing must open the right channel: L ${peakL.toExponential(2)} R ${peakR.toExponential(2)}`);
});

check("SPF's R dial is INVERTED and reaches a Q of ~100 at its top, which is theirs", () => {
  const drive = (rDial, freqDial, port) => {
    const kernel = new SpfKernel(FS);
    const c = { freq: freqDial, r: rDial };
    const input = new Float64Array(3);
    const frame = new Float64Array(1);
    return (x) => {
      input[0] = 0;
      input[1] = 0;
      input[2] = 0;
      input[port] = x;
      kernel.sample(c, input, frame);
      return frame[0];
    };
  };
  const fc = Math.pow(2, 10);
  const overdamped = sineGain(drive(0, 10, 0), fc);
  const butterworth = sineGain(drive(1, 10, 0), fc);
  const resonant = sineGain(drive(1.99, 10, 0), fc);
  assert.ok(overdamped < butterworth && butterworth < resonant, `R must be inverted: ${[overdamped, butterworth, resonant].map((v) => v.toFixed(3)).join(" ")}`);
  // R = 2 - dial, so dial 1 gives R = 1 and a lowpass gain of exactly 1 at cutoff
  // (the state-space normalisation), and dial 1.99 gives R = 0.01, i.e. Q = 100.
  assert.ok(Math.abs(butterworth - 1) < 0.02, `dial 1 is R = 1 and unity at cutoff, got ${butterworth.toFixed(4)}`);
  assert.ok(resonant > 50 && resonant < 200, `dial 1.99 is R = 0.01, i.e. Q ~ 100, got ${resonant.toFixed(1)}`);
  // The three numerators must be three different responses through one pole pair.
  const lp = sineGain(drive(1, 10, 0), fc / 4);
  const hp = sineGain(drive(1, 10, 2), fc / 4);
  assert.ok(lp > hp * 5, `the LP and HP numerators must differ below cutoff: ${lp.toFixed(3)} vs ${hp.toFixed(3)}`);
});

check("JUSTAPHASER notches exactly where D-JAP-INTDIV's truncated table puts them", () => {
  // THE CHECK THE INTEGER-DIVISION BUG NEEDS. With Centre 8 (so `centre - 2` = 6)
  // and Span 1, the four-stage profile's offsets are {0.125, 1.625, 2, 4} octaves
  // — NOT the {0.125, 1.625, 2.917, 4.167} the source's expressions read as. So
  // the notches land at 2^6.125, 2^7.625, 2^8 and 2^10 hertz. If someone
  // "corrects" the integer division, the last two move to 2^8.917 and 2^10.167 and
  // this check names it.
  const drive = (filter) => {
    const kernel = new JustAPhaserKernel(FS, { filter, stages: "4" });
    const c = {
      frequency: -8, depth: 0, feedback: 0, center_frequency: 8, frequency_span: 1,
      resonance: 0.707, stereo_phase: 0.25, mix: 1,
    };
    const input = new Float64Array(6);
    const frame = new Float64Array(4);
    return (x) => {
      input[0] = x;
      input[1] = x;
      kernel.sample(c, input, frame);
      return frame[0];
    };
  };
  const notchHz = [Math.pow(2, 6.125), Math.pow(2, 7.625), Math.pow(2, 8), Math.pow(2, 10)];
  for (const hz of notchHz) {
    const g = sineGain(drive("notch"), hz);
    assert.ok(g < 0.05, `a notch is expected at ${hz.toFixed(0)} Hz, gain was ${g.toFixed(4)}`);
  }
  // The truncated positions are what matters: 2^8.917 (the UNtruncated 35/12) must
  // NOT be a notch, or the bug has been silently fixed.
  const wouldBe = sineGain(drive("notch"), Math.pow(2, 8.917));
  assert.ok(wouldBe > 0.2, `2^8.917 Hz must NOT be notched — the int-division table is the port (gain ${wouldBe.toFixed(4)})`);
  // And a frequency between the notches must pass.
  assert.ok(sineGain(drive("notch"), 5000) > 0.5, "5 kHz must pass a four-stage notch phaser");
});

check("JUSTAPHASER's allpass mode is nearly FLAT, which is D-JAP-ALLPASS's audible consequence", () => {
  const kernel = new JustAPhaserKernel(FS, { filter: "allpass", stages: "4" });
  const c = {
    frequency: -8, depth: 0, feedback: 0, center_frequency: 8, frequency_span: 1,
    resonance: 0.707, stereo_phase: 0.25, mix: 1,
  };
  const input = new Float64Array(6);
  const frame = new Float64Array(4);
  const step = (x) => {
    input[0] = x;
    input[1] = x;
    kernel.sample(c, input, frame);
    return frame[0];
  };
  // An allpass chain has unity magnitude by definition, and theirs is additionally
  // mistuned to near DC — so the mix at 0.5 does not cancel and the output is flat.
  for (const hz of [200, 1000, 5000]) {
    const g = sineGain(step, hz);
    assert.ok(Math.abs(g - 1) < 0.1, `allpass mode should be flat at ${hz} Hz, got ${g.toFixed(3)}`);
  }
});

check("XFX F-35: every SHIPPED mode has the slope its name claims, and no mode blows up", () => {
  const drive = (mode, fc, res) => {
    const kernel = new Xfxf35Kernel(FS, { mode });
    const c = { frequency: fc, resonance: res, drive: 0 };
    const input = new Float64Array(1);
    const frame = new Float64Array(1);
    return (x) => {
      input[0] = x;
      kernel.sample(c, input, frame);
      return frame[0];
    };
  };
  const fc = 1000;
  // A named-order sample of the three families, checked against the closed form.
  const cases = [
    ["sv_lp12", fc / 4, fc * 4, "down"],
    ["sv_lp24", fc / 4, fc * 4, "down"],
    ["sv_hp12", fc * 4, fc / 4, "down"],
    ["ladder_lp24", fc / 4, fc * 4, "down"],
    ["ladder_hp24", fc * 4, fc / 4, "down"],
    ["sk_hp6", fc * 4, fc / 4, "down"],
  ];
  for (const [mode, passHz, stopHz] of cases) {
    const pass = sineGain(drive(mode, fc, 0), passHz);
    const stop = sineGain(drive(mode, fc, 0), stopHz);
    assert.ok(pass > stop * 3, `${mode}: passband ${pass.toFixed(4)} must exceed stopband ${stop.toFixed(4)}`);
  }
  // The two notch/phase modes must actually notch at cutoff.
  for (const mode of ["ladder_notch", "ladder_notch_lp6"]) {
    const g = sineGain(drive(mode, fc, 0), fc);
    assert.ok(g < 0.1, `${mode} must notch at cutoff, got ${g.toFixed(4)}`);
  }
  // And every shipped mode must be finite and bounded at high resonance. A filter
  // that self-destructs on one of 26 modes is a filter nobody can trust.
  for (const mode of xfxf35ShippedModes()) {
    for (const res of [0, 0.9]) {
      const g = sineGain(drive(mode, fc, res), fc);
      assert.ok(Number.isFinite(g), `${mode} at resonance ${res} produced a non-finite sample`);
      assert.ok(g < 60, `${mode} at resonance ${res} reached ${g.toFixed(1)}x — unbounded`);
    }
  }
});

check("XFX F-35 lists all 35 vendor modes and REFUSES the nine it does not ship", () => {
  assert.equal(XFXF35_MODES.length, 35, "the vendor's list is 35 long and all of it is on record");
  for (let i = 0; i < XFXF35_MODES.length; i++) {
    assert.equal(XFXF35_MODES[i].n, i + 1, "the `n` field must be the vendor's own numbering, in order");
  }
  assert.equal(xfxf35ShippedModes().length, 26, "26 shipped, 9 refused");
  for (const row of XFXF35_MODES.filter((m) => !m.shipped)) {
    assert.throws(
      () => new Xfxf35Kernel(FS, { mode: row.key }),
      (e) => e.message.includes(String(row.n)) && e.message.includes(row.label),
      `an unshipped mode must throw NAMING itself, not fall back: ${row.key}`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE BEHAVIOUR-DERIVED CLAIMS, and the determinism law
// ════════════════════════════════════════════════════════════════════════════

check("CHRONOBLOB2 tape mode PITCH-SHIFTS and fade mode does not — the one behaviour the manual is explicit about", () => {
  const zeroCrossings = (mode) => {
    const kernel = new Chronoblob2Kernel(FS, { mode });
    const c = { time: 0.2, feedback: 0, mix: 1, damp: 20000, sync: 0, hold: 0 };
    const input = new Float64Array(3);
    const frame = new Float64Array(3);
    const y = new Float64Array(FS * 2);
    let phase = 0;
    for (let i = 0; i < y.length; i++) {
      if (i > FS * 0.8) c.time = 0.05;
      const v = Math.sin(phase);
      phase += (2 * Math.PI * 440) / FS;
      input[0] = v;
      input[1] = v;
      kernel.sample(c, input, frame);
      y[i] = frame[0];
    }
    const count = (a, b) => {
      let z = 0;
      for (let i = a + 1; i < b; i++) if ((y[i] > 0) !== (y[i - 1] > 0)) z += 1;
      return z;
    };
    return { steady: count(FS * 0.5, FS * 0.6), moving: count(FS * 0.9, FS), after: count(FS * 1.5, FS * 1.6) };
  };
  // 440 Hz over 0.1 s is 88 zero crossings. That is the reference both modes must
  // hit when the time is not changing.
  const expected = Math.round(2 * 440 * 0.1);
  const tape = zeroCrossings("tape");
  const fade = zeroCrossings("fade");
  assert.equal(tape.steady, expected, `tape must be in tune when the time is static: ${tape.steady}`);
  assert.equal(fade.steady, expected, `fade must be in tune: ${fade.steady}`);
  assert.ok(tape.moving > tape.steady * 1.1, `TAPE must pitch UP while the time shortens: ${tape.moving} vs ${tape.steady}`);
  assert.equal(fade.moving, expected, `FADE must NOT pitch: ${fade.moving} vs ${expected}`);
  assert.equal(tape.after, expected, `tape must return to pitch once the head arrives: ${tape.after}`);
});

check("CHRONOBLOB2 sync locks the delay to the clock at the selected ratio", () => {
  const kernel = new Chronoblob2Kernel(FS, { mode: "fade", division: "1" });
  const c = { time: 0.2, feedback: 0, mix: 1, damp: 20000, sync: 0, hold: 0 };
  const input = new Float64Array(3);
  const frame = new Float64Array(3);
  const clockPeriod = FS / 2; // 2 Hz
  const impulseAt = Math.floor(FS * 2.05);
  let echoAt = -1;
  for (let i = 0; i < FS * 3; i++) {
    c.sync = i % clockPeriod < 100 ? 1 : 0;
    input[0] = i === impulseAt ? 1 : 0;
    input[1] = 0;
    kernel.sample(c, input, frame);
    if (i > impulseAt && frame[0] > 0.5) {
      echoAt = (i - impulseAt) / FS;
      break;
    }
  }
  assert.ok(Math.abs(echoAt - 0.5) < 0.005, `a 2 Hz clock at ratio 1 must give a 0.5 s delay, got ${echoAt}`);
});

check("CHRONOBLOB2 ping-pong really alternates channels", () => {
  const kernel = new Chronoblob2Kernel(FS, { mode: "fade", delay: "ping_pong" });
  const c = { time: 0.1, feedback: 0.8, mix: 1, damp: 20000, sync: 0, hold: 0 };
  const input = new Float64Array(3);
  const frame = new Float64Array(3);
  const hits = [];
  let prevQuiet = true;
  for (let i = 0; i < FS; i++) {
    input[0] = i === 0 ? 1 : 0;
    input[1] = 0;
    kernel.sample(c, input, frame);
    const loud = Math.abs(frame[0]) > 0.1 || Math.abs(frame[1]) > 0.1;
    if (loud && prevQuiet) hits.push(Math.abs(frame[0]) > Math.abs(frame[1]) ? "L" : "R");
    prevQuiet = !loud;
  }
  assert.ok(hits.length >= 4, `expected at least four repeats, got ${hits.length}`);
  assert.deepEqual(hits.slice(0, 4), ["L", "R", "L", "R"], `ping-pong must alternate: ${hits.slice(0, 6).join("")}`);
});

check("TERRORFORM tunes to V/oct exactly, and its 27 shapers all produce a finite in-range phase", () => {
  const base = {
    v_oct: 0, octave: 0, coarse: 0, fine: 0, wave: 0, shape_depth: 0, fm: 0, fm_level: 0,
    skew: 0, sub_level: 0, sub_wave: 0, trigger: 1, lpg_attack: 0, lpg_decay: 0.5, sync: 0,
  };
  const raw = (options, overrides, n) => {
    const kernel = new TerrorformKernel(FS, options);
    const c = { ...base, ...overrides };
    const input = new Float64Array(1);
    const frame = new Float64Array(6);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      kernel.sample(c, input, frame);
      y[i] = frame[1];
    }
    return y;
  };
  const zc = (y, a, b) => {
    let z = 0;
    for (let i = a + 1; i < b; i++) if ((y[i] > 0) !== (y[i - 1] > 0)) z += 1;
    return z;
  };
  // V4: the pitch port is SEMITONES from C4, so TWELVE of them must double the
  // rate and 9 must give A440. `pitch2freq` is Valley's `261.6255 * 2^volts`.
  for (const semitones of [0, 12, -12, 9]) {
    const y = raw({}, { v_oct: semitones }, FS / 4);
    const measured = zc(y, FS * 0.1, FS * 0.2);
    const expected = Math.round(2 * vcvSemitonesToHz(semitones) * 0.1);
    // +/-1: the 0.1 s window does not begin on a zero crossing, so a partial cycle
    // at either end can cost one. A TUNING error is a factor, not a count of one —
    // a semitone would be 5 crossings out at 440 Hz and an octave would be 88.
    assert.ok(Math.abs(measured - expected) <= 1,
      `pitch ${semitones} st: ${measured} crossings, expected ${expected}`);
  }
  // All 27, at three depths including the depth-1 edge where their `varStep`
  // divides by zero.
  assert.equal(SHAPE_NAMES.length, 27, "27 shapers, in PANEL order");
  for (const shape of SHAPE_NAMES) {
    for (const depth of [0, 0.5, 1]) {
      const y = raw({ shape }, { shape_depth: depth }, FS / 20);
      let peak = 0;
      for (const v of y) {
        assert.ok(Number.isFinite(v), `${shape} at depth ${depth} produced a non-finite sample`);
        peak = Math.max(peak, Math.abs(v));
      }
      assert.ok(peak <= 2, `${shape} at depth ${depth} exceeded the module's own clamp: ${peak}`);
    }
  }
});

check("TERRORFORM's shapers are real PHASE DISTORTION — depth 0 is identity, and a shaper adds named harmonics", () => {
  const F0 = 261.6255;
  const base = {
    v_oct: 0, octave: 0, coarse: 0, fine: 0, wave: 0, shape_depth: 0, fm: 0, fm_level: 0,
    skew: 0, sub_level: 0, sub_wave: 0, trigger: 1, lpg_attack: 0, lpg_decay: 0.5, sync: 0,
  };
  const raw = (shape, depth) => {
    const kernel = new TerrorformKernel(FS, { shape });
    const c = { ...base, shape_depth: depth };
    const input = new Float64Array(1);
    const frame = new Float64Array(6);
    const y = new Float64Array(FS);
    for (let i = 0; i < y.length; i++) {
      kernel.sample(c, input, frame);
      y[i] = frame[1];
    }
    return y;
  };
  const harmonic = (y, h) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < y.length; i++) {
      const w = (2 * Math.PI * h * F0 * i) / FS;
      re += y[i] * Math.cos(w);
      im += y[i] * Math.sin(w);
    }
    return (2 * Math.hypot(re, im)) / y.length;
  };
  // Bank `basic` frame 0 is a pure sine, so at depth 0 the output must be one
  // partial and nothing else. That is the identity check every shaper claims.
  const clean = raw("bend", 0);
  assert.ok(harmonic(clean, 1) > 0.9, "depth 0 must pass the table straight through");
  for (const h of [2, 3, 4, 5]) {
    assert.ok(harmonic(clean, h) < 0.01, `depth 0 must add no harmonic ${h}: ${harmonic(clean, h).toFixed(4)}`);
  }
  // `wrinkleX4` adds a 4x sine to the phase, so its sidebands land at 4+/-1 = 3 and
  // 5. Measured: H5 dominant at 0.82, H3 at 0.20. That specific pattern is the
  // evidence the shaper is the one it says it is.
  const wrinkled = raw("wrinkleX4", 0.5);
  assert.ok(harmonic(wrinkled, 5) > 0.4, `wrinkleX4 must put energy at the 5th: ${harmonic(wrinkled, 5).toFixed(3)}`);
  assert.ok(harmonic(wrinkled, 3) > 0.05, `wrinkleX4 must put energy at the 3rd: ${harmonic(wrinkled, 3).toFixed(3)}`);
  assert.ok(harmonic(wrinkled, 5) > harmonic(wrinkled, 1) * 5, "the 4x sideband must dominate the fundamental");
  // `harmonics` at 0.5 glides to the 4th, which is what its `6.4` span produces.
  const harmonics = raw("harmonics", 0.5);
  assert.ok(harmonic(harmonics, 4) > 0.4, `harmonics at 0.5 must land near the 4th: ${harmonic(harmonics, 4).toFixed(3)}`);
});

check("TERRORFORM's eight banks are all finite and non-silent, and D-TF-BANK is stated as a deviation", () => {
  const base = {
    v_oct: 0, octave: 0, coarse: 0, fine: 0, wave: 0.5, shape_depth: 0, fm: 0, fm_level: 0,
    skew: 0, sub_level: 0, sub_wave: 0, trigger: 1, lpg_attack: 0, lpg_decay: 0.5, sync: 0,
  };
  for (const bank of Object.keys(TF_BANKS)) {
    const kernel = new TerrorformKernel(FS, { bank });
    const input = new Float64Array(1);
    const frame = new Float64Array(6);
    let peak = 0;
    for (let i = 0; i < FS / 20; i++) {
      kernel.sample(base, input, frame);
      assert.ok(Number.isFinite(frame[1]), `bank ${bank} produced a non-finite sample`);
      peak = Math.max(peak, Math.abs(frame[1]));
    }
    assert.ok(peak > 0.05, `bank ${bank} is silent at wave 0.5`);
  }
  const spec = BLOCK_SPECS.find((s) => s.module === "vcvTerrorform");
  assert.ok(spec.derivation.deviations.some((d) => d.startsWith("D-TF-BANK")),
    "the 64 MB ROM omission must be a NAMED deviation, not a footnote");
});

check("REWIN quantises to its mask, and its three directions really differ", () => {
  const MAJOR = 0b101010110101;
  const PENTATONIC = 0b001010010101;
  const kernel = new RewinKernel();
  const input = new Float64Array(4);
  const frame = new Float64Array(4);
  // V4: every pitch port is SEMITONES from C4, so a semitone sweep IS 0..12 in
  // and the output is read back directly rather than scaled.
  const sweep = (mode, mask) => {
    kernel.setMode(mode);
    const out = [];
    for (let s = 0; s <= 12; s++) {
      input[0] = s;
      kernel.sample({ scale: mask, transpose: 0, semi: 0, octave_1: 0, octave_2: 0, octave_3: 0, octave_4: 0 }, input, frame);
      out.push(Math.round(frame[0]));
    }
    return out;
  };
  // Every output must be IN the mask.
  for (const mode of RewinKernel.MODES) {
    for (const value of sweep(mode, MAJOR)) {
      assert.ok(MAJOR & (1 << ((value % 12) + 12) % 12), `${mode} emitted semitone ${value}, which is not in C major`);
    }
  }
  // `up` and `down` must differ. In an EVENLY spaced scale they tie and `nearest`
  // agrees with `down` (their `stepsUp < stepsDown` breaks ties downward), so the
  // three-way distinction needs an UNEVEN scale — which is why pentatonic is here.
  assert.notDeepEqual(sweep("up", MAJOR), sweep("down", MAJOR), "up and down must differ");
  assert.deepEqual(sweep("nearest", MAJOR), sweep("down", MAJOR),
    "in an evenly spaced scale, nearest ties DOWN — their tie-break, reproduced");
  assert.notDeepEqual(sweep("nearest", PENTATONIC), sweep("up", PENTATONIC),
    "in an uneven scale, nearest and up must differ");
  // An EMPTY mask passes through, which is their `steps %= 12` guard.
  const passThrough = sweep("down", 0);
  assert.deepEqual(passThrough, Array.from({ length: 13 }, (_, i) => i),
    `an empty scale must pass through unquantised: ${passThrough.join(" ")}`);
});

check("REBURST's gaps collapse GEOMETRICALLY, which is the module", () => {
  const kernel = new ReburstKernel(FS, { seed: 1 });
  const c = { time: 1, rep: 4, accel: 2, jitter: 0, gate: 0, clock: 0 };
  const input = new Float64Array(1);
  const frame = new Float64Array(3);
  const edges = [];
  let prev = 0;
  for (let i = 0; i < FS * 4; i++) {
    c.gate = i >= 100 && i < 200 ? 1 : 0;
    kernel.sample(c, input, frame);
    if (frame[0] > 0.5 && prev <= 0.5) edges.push(i / FS);
    prev = frame[0];
  }
  assert.ok(edges.length >= 5, `expected the initial gate plus four pulses, got ${edges.length}`);
  const gaps = edges.slice(1).map((t, i) => t - edges[i]);
  // `seconds = time / accel^n`, so at accel 2 the gaps are 1/2, 1/4, 1/8, 1/16 of
  // the Time dial's second. Compounding, not linear.
  const expected = [1, 0.5, 0.25, 0.125];
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(gaps[i] - expected[i]) < 0.01,
      `gap ${i} should be ${expected[i]} s (time / 2^${i}), got ${gaps[i].toFixed(4)}`);
  }
});

check("D0 THE DETERMINISM LAW: every seeded kernel is reproducible, and a different seed differs", () => {
  const burstEdges = (seed) => {
    const kernel = new ReburstKernel(FS, { seed });
    const c = { time: 0.5, rep: 8, accel: 1, jitter: 0.9, gate: 0, clock: 0 };
    const input = new Float64Array(1);
    const frame = new Float64Array(3);
    const edges = [];
    let prev = 0;
    for (let i = 0; i < FS * 8; i++) {
      c.gate = i >= 10 && i < 50 ? 1 : 0;
      kernel.sample(c, input, frame);
      if (frame[0] > 0.5 && prev <= 0.5) edges.push(i);
      prev = frame[0];
    }
    return edges.join(",");
  };
  assert.equal(burstEdges(5), burstEdges(5), "the same seed must give the same jitter, forever");
  assert.notEqual(burstEdges(5), burstEdges(6), "a different seed must give different jitter");

  const warbleTrace = (seed) => {
    const kernel = new TerrorformKernel(FS, { shape: "warble", seed });
    const c = {
      v_oct: 0, octave: 0, coarse: 0, fine: 0, wave: 0, shape_depth: 0.5, fm: 0, fm_level: 0,
      skew: 0, sub_level: 0, sub_wave: 0, trigger: 1, lpg_attack: 0, lpg_decay: 0.5, sync: 0,
    };
    const input = new Float64Array(1);
    const frame = new Float64Array(6);
    const out = [];
    for (let i = 0; i < 2000; i++) {
      kernel.sample(c, input, frame);
      out.push(frame[1].toFixed(12));
    }
    return out.join(",");
  };
  assert.equal(warbleTrace(3), warbleTrace(3), "Shaper::warble's noise must be seeded, not from the clock");
  assert.notEqual(warbleTrace(3), warbleTrace(4), "a different seed must give different warble");
});

// ════════════════════════════════════════════════════════════════════════════
// 5. THE CONTRACT — specs, roster, factories and plugins must agree
// ════════════════════════════════════════════════════════════════════════════

check("the PORT-BLOCK CONTRACT's four exports are present and the right shapes", () => {
  assert.ok(Array.isArray(BLOCK_SPECS), "BLOCK_SPECS is an array");
  assert.equal(typeof BLOCK_MODULE_FACTORIES, "object", "BLOCK_MODULE_FACTORIES is an object");
  assert.ok(Array.isArray(BLOCK_WORKLET_MODULES), "BLOCK_WORKLET_MODULES is an ARRAY, not a Set — AX-3 shipped a Set and it was swept back");
  assert.ok(Array.isArray(BLOCK_PLUGINS), "BLOCK_PLUGINS is an array");
  assert.equal(BLOCK_SPECS.length, 9, "nine nodes");
  assert.equal(BLOCK_PLUGINS.length, 9, "nine plugin wrappers");
  assert.equal(Object.keys(BLOCK_MODULE_FACTORIES).length, 9, "nine factories");
  assert.equal(BLOCK_WORKLET_MODULES.length, 9, "all nine build an AudioWorkletNode");
  assert.deepEqual(BLOCK_PLUGINS.map((p) => p.type), BLOCK_SPECS.map((s) => s.type),
    "the plugin barrel must be in BLOCK_SPECS order — see the barrel's docblock");
});

check("every spec's module key has a factory, a processor row and a worklet entry", () => {
  const factories = new Set(Object.keys(BLOCK_MODULE_FACTORIES));
  const roster = new Map(VC5_PROCESSORS.map((row) => [row.module, row]));
  for (const spec of BLOCK_SPECS) {
    assert.ok(factories.has(spec.module), `${spec.type}: no factory for module ${spec.module}`);
    assert.ok(roster.has(spec.module), `${spec.type}: no processor row for module ${spec.module}`);
    assert.ok(BLOCK_WORKLET_MODULES.includes(spec.module), `${spec.type}: missing from BLOCK_WORKLET_MODULES`);
  }
  assert.equal(roster.size, BLOCK_SPECS.length, "no orphan processor rows");
});

check("a spec's PORTS are exactly the processor's audio inputs plus its params, with no collisions", () => {
  const roster = new Map(VC5_PROCESSORS.map((row) => [row.module, row]));
  for (const spec of BLOCK_SPECS) {
    const row = roster.get(spec.module);
    const paramNames = new Set(row.params.map((d) => d.name));
    const audioNames = new Set(row.audio);
    for (const name of audioNames) {
      assert.ok(!paramNames.has(name), `${spec.type}: port ${name} is BOTH an audio input and a param — the factory's maps would collide`);
    }
    for (const port of spec.inputs) {
      if (port.type === "audio") {
        assert.ok(audioNames.has(port.key), `${spec.type}: audio input ${port.key} has no processor input index`);
      } else {
        assert.ok(paramNames.has(port.key), `${spec.type}: ${port.type} input ${port.key} has no AudioParam`);
      }
    }
    assert.deepEqual(spec.outputs.map((o) => o.key), row.outputs,
      `${spec.type}: the spec's output order must be the processor's output-index order`);
  }
});

check("a numeric knob's range is CONTAINED IN its AudioParam's, never wider", () => {
  // The direction matters. A wider param is deliberate (Plateau's pre-delay dial
  // stops at 0.5 s but the code clamps at 1; JustAPhaser's rate dial stops at 3
  // but their LFO clamps at 8). A NARROWER param would silently discard a value
  // the Inspector accepted, which is the failure this project forbids outright.
  const roster = new Map(VC5_PROCESSORS.map((row) => [row.module, row]));
  for (const spec of BLOCK_SPECS) {
    const params = new Map(roster.get(spec.module).params.map((d) => [d.name, d]));
    for (const knob of spec.knobs) {
      if (knob.discrete) continue;
      const descriptor = params.get(knob.key);
      if (!descriptor) continue; // construct-time numeric knobs have no param
      assert.ok(descriptor.minValue <= knob.min,
        `${spec.type}.${knob.key}: param min ${descriptor.minValue} is above the knob's ${knob.min}`);
      assert.ok(descriptor.maxValue >= knob.max,
        `${spec.type}.${knob.key}: param max ${descriptor.maxValue} is below the knob's ${knob.max}`);
      assert.equal(descriptor.defaultValue, knob.default,
        `${spec.type}.${knob.key}: the param default and the knob default must be the same number`);
    }
  }
});

check("every discrete knob's options are exactly what the kernel accepts — the restated lists cannot drift", () => {
  // core/audio_specs_vc5.js MAY NOT import synth/**, so its option lists are
  // RESTATED from the kernels. This is the pin. A kernel that throws on a listed
  // option, or accepts one that is not listed, reddens here.
  const shipped = xfxf35ShippedModes();
  const byType = new Map(BLOCK_SPECS.map((s) => [s.type, s]));
  const modes = (type, key) => byType.get(type).knobs.find((k) => k.key === key).options;

  assert.deepEqual(modes("audio_vcv_xfxf35", "mode"), shipped,
    "XFX F-35's mode options must be exactly the kernel's shipped list");
  assert.deepEqual(modes("audio_vcv_terrorform", "shape"), [...SHAPE_NAMES],
    "Terrorform's shape options must be SHAPE_NAMES, in PANEL order");
  assert.deepEqual(modes("audio_vcv_terrorform", "bank"), Object.keys(TF_BANKS),
    "Terrorform's bank options must be exactly TF_BANKS' keys");
  assert.deepEqual(modes("audio_vcv_rewin", "mode"), [...RewinKernel.MODES],
    "rewin's direction options must be its enum order");
  assert.deepEqual(modes("audio_vcv_reburst", "cv_mode"), [...ReburstKernel.CV_MODES],
    "reburst's CV shapes must be its enum order");
  assert.deepEqual(modes("audio_vcv_chronoblob2", "mode"), [...Chronoblob2Kernel.MOD_MODES],
    "Chronoblob2's mod modes must match the kernel");
  assert.deepEqual(modes("audio_vcv_chronoblob2", "delay"), [...Chronoblob2Kernel.DELAY_MODES],
    "Chronoblob2's topologies must match the kernel");
  assert.deepEqual(modes("audio_vcv_chronoblob2", "division"), chronoblobDivisionNames(),
    "Chronoblob2's divisions must match the kernel's ratio table, IN PANEL ORDER");
  assert.deepEqual(modes("audio_vcv_justaphaser", "stages"), [...JustAPhaserKernel.STAGE_COUNTS],
    "JustAPhaser's stage counts must match the kernel");
  assert.deepEqual(modes("audio_vcv_justaphaser", "wave"), [...JustAPhaserKernel.WAVES],
    "JustAPhaser's LFO waves must match the kernel");
  assert.deepEqual(modes("audio_vcv_justaphaser", "span"), [...JustAPhaserKernel.SPANS],
    "JustAPhaser's modulation profiles must match the kernel");
});

check("every option knob has a kernel setter, by the vc5OptionSetter convention", () => {
  const kernels = {
    vcvPlateau: new PlateauKernel(FS, {}),
    vcvChronoblob2: new Chronoblob2Kernel(FS, {}),
    vcvJustaphaser: new JustAPhaserKernel(FS, {}),
    vcvFeline: new FelineKernel(FS),
    vcvSpf: new SpfKernel(FS),
    vcvXfxf35: new Xfxf35Kernel(FS, {}),
    vcvTerrorform: new TerrorformKernel(FS, {}),
    vcvRewin: new RewinKernel(),
    vcvReburst: new ReburstKernel(FS, {}),
  };
  for (const row of VC5_PROCESSORS) {
    const kernel = kernels[row.module];
    assert.ok(kernel, `no kernel instance for ${row.module}`);
    for (const option of row.options) {
      const setter = vc5OptionSetter(option);
      assert.equal(typeof kernel[setter], "function",
        `${row.module}: option ${option} needs ${setter}() — the bridge calls exactly that name`);
    }
  }
});

check("every option/construct knob in a spec is declared in its processor row, and vice versa", () => {
  const roster = new Map(VC5_PROCESSORS.map((row) => [row.module, row]));
  for (const spec of BLOCK_SPECS) {
    const row = roster.get(spec.module);
    const declared = new Set([...row.options, ...row.construct]);
    const paramNames = new Set(row.params.map((d) => d.name));
    for (const knob of spec.knobs) {
      const isParam = paramNames.has(knob.key);
      const isDeclared = declared.has(knob.key);
      assert.ok(isParam || isDeclared,
        `${spec.type}.${knob.key}: neither an AudioParam nor an option/construct knob — the engine could not set it`);
      if (knob.discrete) {
        assert.ok(isDeclared, `${spec.type}.${knob.key}: a discrete knob must be an option or construct, not an AudioParam`);
      }
      if (knob.construct) {
        assert.ok(row.construct.includes(knob.key),
          `${spec.type}.${knob.key}: declared construct:true but is not in the processor's construct list, so the rebuild would not carry it`);
      }
    }
    for (const option of row.options) {
      assert.ok(spec.knobs.some((k) => k.key === option),
        `${spec.type}: option ${option} has no Inspector row — NO JSON-ONLY PROPERTIES`);
    }
    for (const name of row.construct) {
      assert.ok(spec.knobs.some((k) => k.key === name),
        `${spec.type}: construct knob ${name} has no Inspector row`);
    }
  }
});

check("every spec is a well-formed audio node: family, port types, unique names, and a plugin that builds", () => {
  const mine = new Set(BLOCK_SPECS);
  const foreign = AUDIO_SPECS.filter((s) => !mine.has(s));
  const shippedTypes = new Set(foreign.map((s) => s.type));
  const shippedModules = new Set(foreign.map((s) => s.module));
  const seen = new Set();
  for (const spec of BLOCK_SPECS) {
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type}: unknown family ${spec.family}`);
    assert.ok(spec.help && spec.help.length > 40, `${spec.type}: help must say what the module IS`);
    assert.ok(spec.icon && spec.icon.startsWith("mdi:"), `${spec.type}: needs an mdi icon`);
    for (const port of [...spec.inputs, ...spec.outputs]) {
      assert.ok(PORT_TYPE_NAMES.includes(port.type), `${spec.type}.${port.key}: unknown port type ${port.type}`);
    }
    for (const list of [spec.inputs, spec.outputs]) {
      const keys = list.map((p) => p.key);
      assert.equal(new Set(keys).size, keys.length, `${spec.type}: duplicate port key in ${JSON.stringify(keys)}`);
    }
    // Every output is `audio` — the spec vocabulary's own rule (core/audio_specs.js).
    for (const port of spec.outputs) {
      assert.equal(port.type, "audio", `${spec.type}.${port.key}: a module output is always audio`);
    }
    assert.ok(!shippedTypes.has(spec.type), `${spec.type} is also claimed by a spec from another block`);
    assert.ok(!shippedModules.has(spec.module), `module ${spec.module} is also claimed by another block`);
    assert.ok(!seen.has(spec.type), `${spec.type} declared twice`);
    seen.add(spec.type);
    // The type name convention the lead ruled on, 2026-08-06.
    assert.match(spec.type, /^audio_vcv_[a-z0-9]+$/, `${spec.type}: types are audio_vcv_<modelslug>`);
    assert.match(spec.module, /^vcv[A-Z]/, `${spec.module}: module keys are camelCase vcv<Model>`);
    const plugin = audioNodePlugin(spec);
    assert.equal(plugin.type, spec.type, `${spec.type}: audioNodePlugin must accept it`);
    assert.equal(plugin.audioModule, spec.module, `${spec.type}: the plugin must carry the engine binding`);
  }
});

check("every knob is inside its own range, has a row, and has a default leaf", () => {
  for (const spec of BLOCK_SPECS) {
    const defaults = audioKnobDefaults(spec);
    const rows = audioKnobRows(spec);
    assert.equal(rows.length, spec.knobs.length, `${spec.type}: every knob needs an Inspector row`);
    const seen = new Set();
    for (const knob of spec.knobs) {
      assert.ok(!seen.has(knob.key), `${spec.type}: knob ${knob.key} declared twice`);
      seen.add(knob.key);
      assert.ok(knob.help && knob.help.length > 0, `${spec.type}.${knob.key}: no help`);
      if (knob.discrete) {
        assert.ok(knob.options.includes(knob.default), `${spec.type}.${knob.key}: default is not an option`);
        assert.equal(new Set(knob.options).size, knob.options.length, `${spec.type}.${knob.key}: duplicate option`);
      } else {
        assert.ok(knob.default >= knob.min && knob.default <= knob.max,
          `${spec.type}.${knob.key}: default ${knob.default} outside [${knob.min}, ${knob.max}]`);
        assert.ok(knob.step > 0, `${spec.type}.${knob.key}: needs a step`);
      }
    }
    assert.equal(Object.keys(defaults).length, spec.knobs.length, `${spec.type}: every knob needs a default leaf`);
    // The readout must name a knob that exists, or the card shows nothing.
    if (spec.readout) {
      assert.ok(spec.knobs.some((k) => k.key === spec.readout), `${spec.type}: readout ${spec.readout} is not a knob`);
    }
  }
});

check("R7-17: every spec carries a derivation record, and the two behaviour-derived ones SAY SO", () => {
  for (const spec of BLOCK_SPECS) {
    const d = spec.derivation;
    assert.ok(d, `${spec.type}: no derivation record`);
    assert.ok(d.kind === "source" || d.kind === "behaviour", `${spec.type}: derivation.kind must be "source" or "behaviour"`);
    assert.ok(d.source && d.source.length > 40, `${spec.type}: source must name the project and the file or the documents`);
    assert.ok(d.block && d.block.length > 10, `${spec.type}: block must say WHERE the recurrence is`);
    assert.ok(d.recurrence && d.recurrence.length > 40, `${spec.type}: the recurrence must be written out or pointed at`);
    assert.ok(Array.isArray(d.deviations) && d.deviations.length > 0, `${spec.type}: deviations must be named`);
    if (d.kind === "source") {
      // A bare file name cannot do the debugging job the record exists for: it
      // must pin the commit it was read at.
      assert.match(d.source, /@ [0-9a-f]{40}/, `${spec.type}: a source-derived record must pin a full commit SHA`);
      assert.match(d.block, /::|\.cpp|\.hpp/, `${spec.type}: block must name a C++ function or file`);
    } else {
      // A behaviour-derived record must say the source is absent IN THE RECORD,
      // and it must name the documents it was built from instead.
      assert.match(d.source, /CLOSED SOURCE/, `${spec.type}: a behaviour-derived record must say the source is closed`);
      assert.match(d.source, /sourceUrl/, `${spec.type}: say HOW that was established — the manifest has no sourceUrl`);
      assert.match(d.block, /^N\/A/, `${spec.type}: a behaviour-derived record's block must be N/A, not a guessed function name`);
      // And the node's own help must warn the author without reading the kernels.
      assert.match(spec.help, /BEHAVIOUR-DERIVED/, `${spec.type}: the help must warn that this is not a source port`);
    }
  }
  const behaviour = BLOCK_SPECS.filter((s) => s.derivation.kind === "behaviour").map((s) => s.module);
  assert.deepEqual(behaviour.sort(), ["vcvChronoblob2", "vcvXfxf35"],
    "exactly two of the nine are behaviour-derived, and they are the two closed-source ones");
});

check("core/audio_specs_vc5.js does NOT import synth/** — core must run in bare node", () => {
  const source = readFileSync(join(here, "../core/audio_specs_vc5.js"), "utf8");
  assert.ok(!/from\s+["'][^"']*synth\//.test(source),
    "the spec file may not import the engine; its restated option lists are pinned by the check above instead");
  // And no Vite-only syntax anywhere in this block's bare-node lane. COMMENTS ARE
  // STRIPPED FIRST: these files DISCUSS `?worker&url` at length, and a grep that
  // counted prose would forbid explaining the rule it enforces.
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const relative of ["../core/audio_specs_vc5.js", "../synth/vc5_kernels.js", "../synth/modules_vc5.js", "../synth/worklets/processors_vc5.js"]) {
    const code = stripComments(readFileSync(join(here, relative), "utf8"));
    assert.ok(!code.includes("?worker"), `${relative}: a Vite specifier here takes the whole bare-node lane down`);
    assert.ok(!code.includes("import.meta.url"), `${relative}: the worklet URL belongs in synth/worklet_urls.js`);
  }
});

check("the shared helpers behave as their doctests claim", () => {
  // The pure helpers every kernel in the block leans on. Cheap, and they are the
  // functions a wrong sign in would be hardest to localise from a spectrum.
  assert.equal(clampTo(3, 0, 1), 1);
  assert.equal(clampTo(-3, 0, 1), 0);
  assert.equal(linterp(0, 10, 0.25), 2.5);
  assert.equal(wrapUnit(1.25), 0.25);
  assert.equal(wrapUnit(-0.25), -0.25, "wrapUnit keeps the sign — the shapers rely on it");
  assert.equal(circleWrap(2.5), 0.5);
  assert.equal(circleWrap(-2.5), -0.5);
  // `sin(PI * circleWrap(x)) === sin(PI * x)` is the identity that lets us use
  // Math.sin where they use a 9th-order Taylor series. If it fails, every shaper
  // that calls circleWrap is wrong.
  for (const x of [0.3, 1.7, -2.4, 5.9, -7.1]) {
    assert.ok(Math.abs(Math.sin(Math.PI * circleWrap(x)) - Math.sin(Math.PI * x)) < 1e-12,
      `circleWrap must preserve sin(PI x) at ${x}`);
  }
  assert.equal(tanhDriveSignal(0.5, 1), 0.5, "linear inside +/-0.75");
  assert.equal(tanhDriveSignal(1, 1), 0.9375, "0.9375 at unity, NOT tanh's 0.7616");
  assert.equal(tanhDriveSignal(-1, 1), -0.9375, "and symmetric");
  assert.equal(tanhDriveSignal(2, 1), 1, "hard clip past 1.25");
  // Depth 0 must be the identity for every pure shaper, or "shape depth 0 is a
  // plain wavetable" is a lie.
  for (const name of SHAPE_NAMES) {
    if (name === "warble" || name === "varStep") continue;
    for (const a of [0.1, 0.5, 0.9]) {
      const y = SHAPERS[name](a, 0);
      assert.ok(Math.abs(y - a) < 1e-9, `${name} at depth 0 must be the identity: ${a} -> ${y}`);
    }
  }
  // `varStep` is the exception BY CONSTRUCTION: its crossfade is `|f| * 100`
  // clamped, so it is exactly the identity at 0 and fully quantised by 0.01.
  assert.ok(Math.abs(SHAPERS.varStep(0.5, 0) - 0.5) < 1e-12, "varStep at depth 0 is still the identity");
  assert.ok(Number.isFinite(SHAPERS.varStep(0.5, 1)), "varStep at depth 1 must not be NaN — D-TF-VARSTEP");
  assert.throws(() => SHAPERS.warble(0.5, 0.5), /stateful/, "warble must refuse to be called as a pure function");
});

check("R7-UNITS clause 4: every GATE output is 0..1, not a divided voltage", () => {
  // reburst's gate and eoc, and Terrorform's eoc. A 10 V Rack gate divided by five
  // is 2.0, outside our wire's +/-1 and outside every gate param's own 0..1 bound.
  const burst = new ReburstKernel(FS, { seed: 1 });
  const c = { time: 0.1, rep: 4, accel: 1, jitter: 0, gate: 0, clock: 0 };
  const input = new Float64Array(1);
  const frame = new Float64Array(3);
  let gatePeak = 0;
  let eocPeak = 0;
  for (let i = 0; i < FS; i++) {
    c.gate = i >= 100 && i < 200 ? 1 : 0;
    burst.sample(c, input, frame);
    gatePeak = Math.max(gatePeak, frame[0]);
    eocPeak = Math.max(eocPeak, frame[1]);
  }
  assert.equal(gatePeak, 1, `reburst's gate output must peak at exactly 1, got ${gatePeak}`);
  assert.equal(eocPeak, 1, `reburst's eoc output must peak at exactly 1, got ${eocPeak}`);

  const tform = new TerrorformKernel(FS, {});
  const tc = {
    v_oct: 0, octave: 0, coarse: 0, fine: 0, wave: 0, shape_depth: 0, fm: 0, fm_level: 0,
    skew: 0, sub_level: 0, sub_wave: 0, trigger: 1, lpg_attack: 0, lpg_decay: 0.5, sync: 0,
  };
  const tf = new Float64Array(6);
  let eoc = 0;
  for (let i = 0; i < FS / 10; i++) {
    tform.sample(tc, input, tf);
    eoc = Math.max(eoc, tf[5]);
  }
  assert.equal(eoc, 1, `Terrorform's eoc must be 0 or 1, got ${eoc}`);
});

check("R7-UNITS clause 2: TERRORFORM's env and phasor are 0..1, not a divided voltage", () => {
  // The lead's worked example, 2026-08-06. These are MODULATION sources, not audio,
  // so the rule is the real unit of the quantity — and a normalised envelope and a
  // phase ramp are both 0..1. At clause 1's 0..2 an author patching `env` into a
  // 0..1 depth knob would get double what the panel shows.
  const kernel = new TerrorformKernel(FS, { lpg_mode: "vca" });
  const c = {
    v_oct: 0, octave: 0, coarse: 0, fine: 0, wave: 0, shape_depth: 0, fm: 0, fm_level: 0,
    skew: 0, sub_level: 0, sub_wave: 0, trigger: 1, lpg_attack: 0, lpg_decay: 1, sync: 0,
  };
  const input = new Float64Array(1);
  const frame = new Float64Array(6);
  let envPeak = 0;
  let phasorPeak = 0;
  for (let i = 0; i < FS / 5; i++) {
    kernel.sample(c, input, frame);
    envPeak = Math.max(envPeak, frame[3]);
    phasorPeak = Math.max(phasorPeak, frame[4]);
  }
  assert.ok(envPeak > 0.9 && envPeak <= 1, `env must reach 1 and not exceed it, got ${envPeak}`);
  assert.ok(phasorPeak > 0.99 && phasorPeak <= 1, `the phasor must be a 0..1 ramp, got ${phasorPeak}`);
});

check("a TRANSPOSITION knob carries no `hz`, because a hertz readout there would be a lie", () => {
  // The lead's R7-UNITS clarification. Terrorform's Coarse and Fine and rewin's
  // four Octave knobs are OFFSETS: they have no absolute frequency, so a converter
  // on them would print a confident wrong number.
  const transpositions = [
    ["audio_vcv_terrorform", "octave"], ["audio_vcv_terrorform", "coarse"], ["audio_vcv_terrorform", "fine"],
    ["audio_vcv_rewin", "octave_1"], ["audio_vcv_rewin", "octave_2"],
    ["audio_vcv_rewin", "octave_3"], ["audio_vcv_rewin", "octave_4"],
  ];
  const byType = new Map(BLOCK_SPECS.map((s) => [s.type, s]));
  for (const [type, key] of transpositions) {
    const knob = byType.get(type).knobs.find((k) => k.key === key);
    assert.ok(knob, `${type}.${key} must exist`);
    assert.equal(knob.hz, undefined, `${type}.${key} is a transposition — it may not carry an hz converter`);
  }
  // AND NO KNOB IN THIS BLOCK CARRIES `hz` AT ALL — pinned as an absence, because
  // it is a SEAM LIMIT rather than a choice and a future contributor will
  // reasonably want to add one. `tests/audio_nodes_test.js`'s sweep holds every
  // `hz` to `semitonesToHz` times a per-type scalar, i.e. to Axoloti's E4 SEMITONE
  // law; a VCV octave dial is a different exponent base with a different origin, so
  // no ratio satisfies it and an `hz` here reddens a suite this block does not own.
  // If that whitelist ever takes a CONVERTER instead of a ratio, delete this
  // assertion and give every dial below its hertz — the converters are one line
  // each and the frequencies are already written into the help text.
  for (const spec of BLOCK_SPECS) {
    for (const knob of spec.knobs) {
      assert.equal(knob.hz, undefined,
        `${spec.type}.${knob.key} declares hz — audio_nodes_test's sweep will reject it (see the spec header). Put the frequency in help until the seam takes a converter.`);
    }
  }
});

check("V4: the pitch converter is C4-ORIGIN, not the AX blocks' E4 one", () => {
  // THE LEAD'S R7-UNITS WARNING, pinned. `core/audio_nodes.semitonesToHz` is
  // E4-origin (Axoloti's MIDI 64 = 329.6276 Hz) and reusing it on a VCV port would
  // read FOUR SEMITONES SHARP. This block's converter must put 0 at C4.
  assert.ok(Math.abs(vcvSemitonesToHz(0) - 261.6255) < 0.01, `semitone 0 must be C4, got ${vcvSemitonesToHz(0)}`);
  assert.ok(Math.abs(vcvSemitonesToHz(9) - 440) < 0.05, `semitone 9 must be A440, got ${vcvSemitonesToHz(9)}`);
  assert.ok(Math.abs(vcvSemitonesToHz(12) / vcvSemitonesToHz(0) - 2) < 1e-9, "twelve semitones must be an octave");
  // And it must NOT be the E4 one: E4 is four semitones above C4, so a converter
  // that agreed with the AX blocks' at 0 would read 329.63.
  assert.ok(Math.abs(vcvSemitonesToHz(0) - 329.6276) > 60, "this must not be the E4-origin converter");
});

check("V4: a pitch port's AudioParam spans Rack's +/-10 V as +/-120 SEMITONES", () => {
  const pitchPorts = [
    ["vcvTerrorform", "v_oct"],
    ["vcvRewin", "in_1"], ["vcvRewin", "in_2"], ["vcvRewin", "in_3"], ["vcvRewin", "in_4"],
    ["vcvRewin", "transpose"], ["vcvRewin", "semi"],
  ];
  const roster = new Map(VC5_PROCESSORS.map((row) => [row.module, row]));
  for (const [module, name] of pitchPorts) {
    const descriptor = roster.get(module).params.find((d) => d.name === name);
    assert.ok(descriptor, `${module}.${name} must be a param`);
    assert.equal(descriptor.minValue, -120, `${module}.${name}: +/-10 V is +/-120 semitones`);
    assert.equal(descriptor.maxValue, 120, `${module}.${name}: +/-10 V is +/-120 semitones`);
  }
});

console.log(`\nport_vc5_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
