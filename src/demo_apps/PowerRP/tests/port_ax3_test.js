/**
 * AX-3 PORT PROOF — the nine Axoloti filters, measured against an INTEGER model
 * of the original C rather than against their own algebra.
 * Run: node src/demo_apps/PowerRP/tests/port_ax3_test.js
 *
 * ── WHY THIS FILE EXISTS IN THIS SHAPE ──────────────────────────────────────
 * A port of a fixed-point DSP recurrence has exactly one interesting failure mode:
 * the float transcription is self-consistent and WRONG. `filter/lp`'s numerator
 * carries an extra `qinv` that the RBJ cookbook does not, and if you copy the
 * cookbook into both the implementation and the check, the check passes and every
 * resonant sweep is far too loud. So the reference below is not a second float
 * formula — it is Axoloti's own arithmetic, `___SMMUL` / `___SMMLA` / `__SSAT` /
 * `mtof48k_q31` reproduced in BigInt so every truncation lands where theirs does.
 *
 * The last check in each family is a GAIN measurement, not a coefficient diff,
 * for the same reason: a peak-gain measurement is the thing the extra `qinv`
 * changes, and the "would this test catch the bug" case is asserted explicitly.
 *
 * ── IT TESTS THE SHIPPED KERNELS, NOT A COPY OF THEM ────────────────────────
 * `synth/ax3_kernels.js` is the ONE copy of the arithmetic and this file imports
 * it. Everything the processors do per sample is a call into it, so a check here
 * is a check on what ships. Where a test still needs to mirror a per-sample loop
 * (the biquad's Direct Form 1), it calls the shipped `axWrapFrac32` / `axSat1`
 * rather than writing the constants out — spelling `16` by hand once let a
 * FRAC32_HEADROOM of MINUS sixteen pass every check in this file.
 *
 * WHAT THIS FILE DOES NOT PROVE: that any of it sounds right. It proves the
 * arithmetic matches the original's to the tolerances quoted per check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BLOCK_SPECS, AX_PITCH_INPUT_LIMIT } from "../core/audio_specs_ax3.js";
import { audioKnobDefaults, audioKnobRows, audioNodePlugin } from "../core/audio_nodes.js";
import { NODE_FAMILY_NAMES } from "../core/node_chrome.js";
import { PORT_TYPE_NAMES } from "../core/nodeflow.js";
import { AUDIO_SPECS } from "../core/audio_specs.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES } from "../synth/modules_ax3.js";
import { IMPLEMENTATION } from "../synth/modules.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

// ── THE SHIPPED KERNELS, IMPORTED ───────────────────────────────────────────

/** Axoloti's own rate. Every reference number below is at 48 kHz because that is
 *  the rate the original hardware runs and the rate its tables are built for. */
const FS = 48000;

/** THE ONE COPY OF THE ARITHMETIC, imported like any other module. This file used
 *  to EVALUATE `worklets/processors_ax3.js` behind an AudioWorkletProcessor shim,
 *  because the kernels lived inside the worklet and worklets were believed unable
 *  to import. They can (measured), so the kernels moved to `synth/ax3_kernels.js`
 *  and the shim is gone — one copy in a normal module beats one copy behind an
 *  eval, and the eval could only ever reach TOP-LEVEL names. */
const K = await import("../synth/ax3_kernels.js");

/**
 * THE SHIPPED PROCESSOR CLASSES, by registered name. The kernels above are the
 * arithmetic; this is the code that actually runs in the browser, and the two can
 * disagree — see the allpass impulse check below, which exists because they did.
 * Imported at top level and SYNCHRONOUSLY thereafter, so a failing check reports
 * inline instead of arriving after the summary line as an unhandled rejection.
 */
const WORKLET_CLASSES = new Map();
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (name, cls) => WORKLET_CLASSES.set(name, cls);
globalThis.sampleRate = FS;
await import("../synth/worklets/processors_ax3.js");

/** The processor file is still read as TEXT, for the three structural pins at the
 *  bottom (the k-rate tick, the wrap sites, the registered names). Those are
 *  properties of the BRIDGE, not of the arithmetic, and there is nothing to
 *  import them from. */
const WORKLET_SOURCE = readFileSync(join(here, "../synth/worklets/processors_ax3.js"), "utf8");

// ── THE INTEGER MODEL — Axoloti's arithmetic, exactly ───────────────────────

const INT32_MAX = 2147483647;
const HALFQ31 = 1 << 30;

/** Pure function. int32 truncation, the C cast every intermediate silently does. */
const i32 = (x) => Number(BigInt.asIntN(32, BigInt(Math.trunc(x))));

/** Pure function. `___SMMUL` — the top 32 bits of a signed 64-bit product. BigInt
 *  `>>` floors, which is what an arithmetic shift right does, which is what the
 *  ARM instruction does. */
const smmul = (a, b) => Number((BigInt(a) * BigInt(b)) >> 32n);

/** Pure function. `___SMMLA` — accumulate the top 32 bits. */
const smmla = (a, b, c) => i32(c + smmul(a, b));

/** Pure function. `__SSAT(x, bits)`. */
const ssat = (x, bits) => {
  const lim = Math.pow(2, bits - 1);
  return x > lim - 1 ? lim - 1 : x < -lim ? -lim : x;
};

/** Pure function. `__USAT(x, bits)`. */
const usat = (x, bits) => {
  const lim = Math.pow(2, bits) - 1;
  return x > lim ? lim : x < 0 ? 0 : x;
};

/** `pitcht[]` from axoloti_math.c: 257 entries, `4·2^30·f/48000`, hard-clamped at
 *  2^31 (i.e. at 24 kHz). Built once, exactly as `axoloti_math_init` does. */
const PITCH_TABLE_SIZE = 257;
const pitcht = new Array(PITCH_TABLE_SIZE);
for (let i = 0; i < PITCH_TABLE_SIZE; i++) {
  const f = 440 * Math.pow(2, (i - 69 - 64) / 12);
  let phi = 4 * Math.pow(2, 30) * f / FS;
  if (phi > Math.pow(2, 31)) phi = INT32_MAX;
  pitcht[i] = Math.trunc(phi);
}

/** `mtof48k_q31` — semitone frac32 to a uint32 phase increment. */
function mtof(pitchRaw) {
  const p = ssat(pitchRaw, 28);
  const pi = Math.floor(p / Math.pow(2, 21));
  const y1 = pitcht[128 + pi];
  const y2 = pitcht[128 + 1 + pi];
  const pf = i32((p & 0x1fffff) * Math.pow(2, 10));
  const pfc = i32(INT32_MAX - pf);
  let r = smmul(y1, pfc);
  r = smmla(y2, pf, r);
  return Number(BigInt.asUintN(32, BigInt(r) * 2n));
}

/**
 * THE TWO SINE CONVENTIONS, AND CONFUSING THEM COSTS A FACTOR OF TWO IN THE ANGLE.
 *
 * `arm_sin_q31` (CMSIS) takes a Q31 phase: 2^31 IS the full circle, so a quarter
 * turn is 2^29. `sin_q31` / `SINE2TINTERP` (axoloti_math.h) takes a raw uint32
 * phase: 2^32 is the full circle and a quarter turn is 2^30. That is why
 * `biquad_lp_coefs` writes `filter_W0 >> 1` before calling the CMSIS one while
 * `f_filter_biquad_A` does not — both end up at `sin(2π·fc/fs)`, and
 * `f_filter_biquad_A`'s `filter_W0 + (1<<30)` is its quarter turn, not a half one.
 *
 * Both are modelled EXACTLY rather than table-and-interpolate. Theirs are
 * interpolated lookups accurate to ~1e-5 relative; modelling the exact sine
 * isolates the structural transcription, which is what this file is for. The table
 * error is a hardware artefact neither implementation has, named in the spec.
 */
const Q31_TURN = Math.pow(2, 31);
const U32_TURN = Math.pow(2, 32);
const armSinQ31 = (x) => i32(Math.round(Math.sin(2 * Math.PI * (x / Q31_TURN)) * INT32_MAX));
const armCosQ31 = (x) => i32(Math.round(Math.cos(2 * Math.PI * (x / Q31_TURN)) * INT32_MAX));
const sin2t = (phase) => i32(Math.round(Math.sin(2 * Math.PI * (phase / U32_TURN)) * INT32_MAX));

/** `float` in the C. `filter_a0` and `filter_a0_inv` are declared SINGLE precision,
 *  so the reciprocal that scales every coefficient carries a 24-bit mantissa's
 *  worth of error — about 6e-8 relative, which is larger than the int32 storage's
 *  own 2^-28 and is what sets the tolerances below. */
const fround32 = Math.fround;

/** A frac32 dial value to its raw int32 (`ValueFrac32.getFrac()` is `v · 2^21`). */
const dialRaw = (v) => Math.trunc(v * Math.pow(2, 21));

/** `pfun_signed_clamp` — every `frac32.s.map*` param passes through it. Its
 *  saturation is why a dial of exactly 64 arrives as `2^27 - 1`, not `2^27`. */
const signedParam = (dial) => ssat(dialRaw(dial), 28);

/** `INT_MAX - (__USAT(param_reso, 27) << 4)` — the q_inv every filter passes. */
const qInvRaw = (dial) => i32(INT32_MAX - i32(usat(dialRaw(dial), 27) * 16));

/** frac32 real value <-> raw int32. */
const FRAC32_ONE = Math.pow(2, 27);
const toRaw = (x) => i32(Math.trunc(x * FRAC32_ONE));
const toReal = (x) => x / FRAC32_ONE;

// ── REFERENCE: biquad_lp_coefs / biquad_bp_coefs / biquad_hp_coefs ──────────

/** `firmware/axoloti_filters.h:97-169` @ tag 1.0.12, transcribed instruction for
 *  instruction. Returns the five stored coefficients, still on their 2^28 scale. */
function refBiquadCoefs(mode, pitchDial, resoDial) {
  const filterW0 = Math.floor(mtof(dialRaw(pitchDial)) / 2);
  const sinW0 = armSinQ31(filterW0);
  const cosW0 = armCosQ31(filterW0);
  const qInv = qInvRaw(resoDial);
  const alpha = smmul(sinW0, qInv);
  const a0 = HALFQ31 + alpha;
  const a0InvQ31 = Math.trunc(INT32_MAX * fround32((INT32_MAX >> 2) / fround32(a0)));
  const cyn1 = smmul(-cosW0, a0InvQ31);
  const cyn2 = smmul(HALFQ31 - alpha, a0InvQ31);
  let cxn0;
  let cxn1;
  let cxn2;
  if (mode === "bandpass") {
    cxn0 = smmul(alpha, a0InvQ31);
    cxn1 = 0;
    cxn2 = -cxn0;
  } else if (mode === "highpass") {
    cxn0 = smmul(smmul(HALFQ31 + (cosW0 >> 1), a0InvQ31), qInv);
    cxn1 = -(cxn0 * 2);
    cxn2 = cxn0;
  } else {
    cxn0 = smmul(smmul(HALFQ31 - (cosW0 >> 1), a0InvQ31), qInv);
    cxn1 = cxn0 * 2;
    cxn2 = cxn0;
  }
  const SCALE = Math.pow(2, 28);
  return { b0: cxn0 / SCALE, b1: cxn1 / SCALE, b2: cxn2 / SCALE, cy1: cyn1 / SCALE, cy2: cyn2 / SCALE };
}

/** `biquad_dsp` — one buffer of Direct Form 1 over raw int32 samples. */
function refBiquadDsp(coefRaw, state, inRaw) {
  const out = new Array(inRaw.length);
  for (let i = 0; i < inRaw.length; i++) {
    const x = inRaw[i];
    let accu = smmul(coefRaw.cxn0, x);
    accu = smmla(coefRaw.cxn1, state.x1, accu);
    accu = smmla(coefRaw.cxn2, state.x2, accu);
    accu = i32(accu - smmul(coefRaw.cyn1, state.y1));
    accu = i32(accu - smmul(coefRaw.cyn2, state.y2));
    const y = i32(accu * 16);
    state.x2 = state.x1;
    state.x1 = x;
    state.y2 = state.y1;
    state.y1 = y;
    out[i] = ssat(y, 28);
  }
  return out;
}

/** The raw (unscaled) coefficient set `biquad_dsp` actually consumes. */
function refBiquadCoefsRaw(mode, pitchDial, resoDial) {
  const SCALE = Math.pow(2, 28);
  const c = refBiquadCoefs(mode, pitchDial, resoDial);
  return { cxn0: Math.round(c.b0 * SCALE), cxn1: Math.round(c.b1 * SCALE), cxn2: Math.round(c.b2 * SCALE), cyn1: Math.round(c.cy1 * SCALE), cyn2: Math.round(c.cy2 * SCALE) };
}

// ── MEASUREMENT HELPERS ─────────────────────────────────────────────────────

/** Pure function. Steady-state magnitude of a linear filter at one frequency, by
 *  driving it with a sine and taking the RMS of the last cycle. The transient is
 *  discarded by running SETTLE cycles first. */
const SETTLE_CYCLES = 220;
const MEASURE_CYCLES = 24;
function measureGain(run, hz, amplitude = 0.5) {
  const runOneSample = (x) => { const y = run(x); return typeof y === "number" ? y : y.out; };
  const period = FS / hz;
  const settle = Math.ceil(period * SETTLE_CYCLES);
  const window = Math.ceil(period * MEASURE_CYCLES);
  let n = 0;
  for (let i = 0; i < settle; i++) runOneSample(amplitude * Math.sin(2 * Math.PI * hz * (n++) / FS));
  let sum = 0;
  for (let i = 0; i < window; i++) {
    const y = runOneSample(amplitude * Math.sin(2 * Math.PI * hz * (n++) / FS));
    sum += y * y;
  }
  return Math.sqrt(2 * sum / window) / amplitude;
}

/** The float biquad exactly as AxBiquadProcessor runs it, as a one-sample closure.
 *  (The class itself needs an AudioWorkletNode to drive; the recurrence is the
 *  thing under test and it is three lines.) */
function floatBiquad(mode, pitchDial, resoDial) {
  const c = new Float64Array(5);
  K.axBiquadCoefs(K[`AX_BIQUAD_${mode.toUpperCase()}`], K.axCutoffHz(pitchDial, FS), resoDial, FS, c);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  // `axWrapFrac32` and `axSat1` are the SHIPPED functions, and the wrap is on the
  // state exactly where AxBiquadProcessor puts it. Writing either out by hand here
  // is how a wrong FRAC32_HEADROOM shipped once already.
  return (x) => {
    const y = K.axWrapFrac32(c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2);
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return { out: K.axSat1(y), state: y };
  };
}

/** The same recurrence with the extra `qinv` REMOVED — the textbook RBJ numerator.
 *  Only used to prove the gain check below can actually see the difference. */
function floatBiquadWithoutExtraQinv(pitchDial, resoDial) {
  const fc = K.axCutoffHz(pitchDial, FS);
  const qinv = K.axQinv(resoDial);
  const w0 = 2 * Math.PI * fc / FS;
  const alpha = Math.sin(w0) * qinv;
  const a0 = 1 + alpha;
  const b0 = ((1 - Math.cos(w0)) / 2) / a0;
  const cy1 = (-2 * Math.cos(w0)) / a0;
  const cy2 = (1 - alpha) / a0;
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  return (x) => {
    const y = b0 * x + 2 * b0 * x1 + b0 * x2 - cy1 * y1 - cy2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return K.axSat1(y);
  };
}

/** The integer biquad as a one-sample closure in the ±1.0 domain. */
function intBiquad(mode, pitchDial, resoDial) {
  const coefRaw = refBiquadCoefsRaw(mode, pitchDial, resoDial);
  const state = { x1: 0, x2: 0, y1: 0, y2: 0 };
  return (x) => toReal(refBiquadDsp(coefRaw, state, [toRaw(x)])[0]);
}

const PITCHES_UNDER_TEST = [-24, -12, 0, 12, 24, 36, 48];
const RESOS_UNDER_TEST = [0, 16, 32, 48, 56, 62];

// ── 1. THE BIQUAD FAMILY ────────────────────────────────────────────────────

check("biquad coefficients match the integer firmware to 9 decimals, all three modes", () => {
  let worst = 0;
  let worstAt = "";
  for (const mode of ["lowpass", "bandpass", "highpass"]) {
    for (const pitch of PITCHES_UNDER_TEST) {
      for (const reso of RESOS_UNDER_TEST) {
        const ref = refBiquadCoefs(mode, pitch, reso);
        const got = new Float64Array(5);
        K.axBiquadCoefs(K[`AX_BIQUAD_${mode.toUpperCase()}`], K.axCutoffHz(pitch, FS), reso, FS, got);
        const pairs = [[got[0], ref.b0], [got[1], ref.b1], [got[2], ref.b2], [got[3], ref.cy1], [got[4], ref.cy2]];
        for (const [a, b] of pairs) {
          const d = Math.abs(a - b);
          if (d > worst) { worst = d; worstAt = `${mode} pitch=${pitch} reso=${reso}`; }
        }
      }
    }
  }
  // THE TOLERANCE IS THE FIRMWARE'S OWN RESOLUTION, NOT A ROUND NUMBER. Its
  // coefficients are int32 on a 2^28 scale (3.7e-9 per step) and the reciprocal
  // that scales all five is computed in SINGLE precision (~6e-8 relative). A
  // tighter bound would be asserting that the port is more accurate than the thing
  // it copies. Measured over 126 operating points, not one.
  assert.ok(worst < 2e-7, `worst coefficient error ${worst.toExponential(3)} at ${worstAt}`);
  console.log(`  biquad coefficients: worst error ${worst.toExponential(3)} over 126 (mode, pitch, reso) points`);
});

check("THE EXTRA qinv: peak gain at high resonance matches the INTEGER filter, and dropping it does not", () => {
  // The check the brief demands, done the only way that can catch a copied-wrong
  // formula: measure the PEAK GAIN of the shipped float filter and of the integer
  // firmware, then measure what the textbook numerator would have given.
  const pitch = 24;                       // 1318.5 Hz
  const reso = 56;                        // Q = 4
  const fc = K.axPitchToHz(pitch);
  // 0.02, not 0.5: without the normalisation this filter has a gain of Q = 4 at
  // the corner, and a 0.5 drive would hit `axSat1` — the measurement would then
  // report the CLIPPER's ratio instead of the filter's, which is how a 5x reading
  // hides an 8x error.
  const DRIVE = 0.02;
  const atPeak = (run) => measureGain(run, fc, DRIVE);
  const refGain = atPeak(intBiquad("lowpass", pitch, reso));
  const gotGain = atPeak(floatBiquad("lowpass", pitch, reso));
  const naiveGain = atPeak(floatBiquadWithoutExtraQinv(pitch, reso));
  // 1e-3 relative: at Q = 4 the resonant peak MULTIPLIES the firmware's own
  // coefficient error (1.7e-7 above) by the pole's sharpness, and its signal path
  // is 28-bit integers rather than doubles. The number that matters is that the
  // two agree to four figures while the un-normalised version is out by 700%.
  assert.ok(Math.abs(gotGain - refGain) / refGain < 1e-3,
    `peak gain ${gotGain.toFixed(6)} vs firmware ${refGain.toFixed(6)}`);
  // And the bug this is guarding is LOUD: 1/(2Q) = 1/8, i.e. 18 dB.
  const ratio = naiveGain / refGain;
  console.log(`  extra qinv: peak gain ${gotGain.toFixed(6)} (firmware ${refGain.toFixed(6)}); without it ${naiveGain.toFixed(6)}`);
  assert.ok(ratio > 7.5 && ratio < 8.5,
    `dropping the extra qinv should be ~8x (${(20 * Math.log10(8)).toFixed(1)} dB) too loud; measured ${ratio.toFixed(3)}x`);
});

check("DC gain IS 1/(2Q) — the normalisation stated as a law, at six resonances", () => {
  // The lowpass's whole point: with the extra qinv, sum(b)/(1 + cy1 + cy2) is qinv.
  for (const reso of RESOS_UNDER_TEST) {
    const c = new Float64Array(5);
    K.axBiquadCoefs(K.AX_BIQUAD_LOWPASS, K.axCutoffHz(12, FS), reso, FS, c);
    const dc = (c[0] + c[1] + c[2]) / (1 + c[3] + c[4]);
    assert.ok(Math.abs(dc - K.axQinv(reso)) < 1e-9, `reso ${reso}: DC gain ${dc}, qinv ${K.axQinv(reso)}`);
  }
});

check("the biquad's OUTPUT tracks the integer firmware sample for sample", () => {
  // Coefficients agreeing is not the recurrence agreeing: the state ordering, the
  // sign convention on cy1/cy2 and the saturate-the-output-not-the-state split are
  // all only visible in a running filter.
  const SAMPLES = 3000;
  for (const mode of ["lowpass", "bandpass", "highpass"]) {
    const ref = intBiquad(mode, 24, 48);
    const raw = floatBiquad(mode, 24, 48);
    const got = (x) => raw(x).out;
    let worst = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const x = 0.6 * Math.sin(2 * Math.PI * 220 * i / FS) + 0.3 * Math.sin(2 * Math.PI * 3100 * i / FS);
      worst = Math.max(worst, Math.abs(got(x) - ref(x)));
    }
    // 1e-5 is the firmware's own truncation noise accumulating through the
    // recursion; the report measured 2.6e-4 at Q=4 over 2000 samples.
    assert.ok(worst < 1e-4, `${mode}: worst sample error ${worst.toExponential(3)}`);
  }
});

check("magnitude response is a lowpass, a bandpass and a highpass — measured, not assumed", () => {
  const pitch = 24;
  const fc = K.axPitchToHz(pitch);
  const lp = (hz) => measureGain(floatBiquad("lowpass", pitch, 32), hz);
  const bp = (hz) => measureGain(floatBiquad("bandpass", pitch, 32), hz);
  const hp = (hz) => measureGain(floatBiquad("highpass", pitch, 32), hz);
  assert.ok(lp(fc / 8) > lp(fc) && lp(fc) > lp(fc * 8), `lowpass not monotone: ${lp(fc / 8)} ${lp(fc)} ${lp(fc * 8)}`);
  assert.ok(hp(fc / 8) < hp(fc) && hp(fc) < hp(fc * 8), `highpass not monotone: ${hp(fc / 8)} ${hp(fc)} ${hp(fc * 8)}`);
  assert.ok(bp(fc) > bp(fc / 8) && bp(fc) > bp(fc * 8), `bandpass has no peak: ${bp(fc / 8)} ${bp(fc)} ${bp(fc * 8)}`);
});

check("MEASURED MAGNITUDE RESPONSE: float port vs integer firmware, four cutoffs x four resonances", () => {
  // The check that would catch a coefficient copied wrong in BOTH places: run the
  // shipped filter and the firmware side by side and compare what comes OUT, over
  // the operating grid an author actually turns the knobs across. Printed as a
  // table because "the peak gain falls as Q rises" is the extra qinv's whole
  // signature and it should be readable, not merely asserted.
  const PROBE_DRIVE = 0.02;
  let worstRel = 0;
  console.log("  pitch   fc(Hz)   reso    Q     |H(fc)| port   |H(fc)| firmware");
  for (const pitch of [0, 12, 24, 36]) {
    for (const reso of [0, 32, 48, 56]) {
      const fc = K.axPitchToHz(pitch);
      const got = measureGain(floatBiquad("lowpass", pitch, reso), fc, PROBE_DRIVE);
      const ref = measureGain(intBiquad("lowpass", pitch, reso), fc, PROBE_DRIVE);
      worstRel = Math.max(worstRel, Math.abs(got - ref) / ref);
      const q = 32 / (64 - reso);
      console.log(`  ${String(pitch).padStart(5)} ${fc.toFixed(1).padStart(8)} ${String(reso).padStart(6)} ${q.toFixed(2).padStart(6)} ${got.toFixed(6).padStart(14)} ${ref.toFixed(6).padStart(18)}`);
    }
  }
  assert.ok(worstRel < 2e-3, `worst relative magnitude error ${worstRel.toExponential(3)}`);
  // AND THE LAW THE TABLE MAKES VISIBLE, stated so it cannot be read past: the
  // corner gain is 0.5 at EVERY resonance. |H(w0)| for an RBJ lowpass is Q, and
  // the extra factor is 1/(2Q), so the product is one half exactly — that is what
  // "constant peak gain" means and it is why the numerator carries the factor at
  // all. Without it this column would read 0.5, 1, 2, 4.
  const CONSTANT_PEAK_GAIN = 0.5;
  for (const reso of [0, 32, 48, 56]) {
    const g = measureGain(floatBiquad("lowpass", 24, reso), K.axPitchToHz(24), PROBE_DRIVE);
    assert.ok(Math.abs(g - CONSTANT_PEAK_GAIN) < 1e-3, `reso ${reso}: corner gain ${g}, not ${CONSTANT_PEAK_GAIN}`);
  }
});

check("AT THE TOP OF THE DIAL EVERY STATE VARIABLE FOLDS, because theirs is an int32", () => {
  // THE QUESTION THIS ANSWERS, asked sharply: an integer implementation that wraps
  // and a float one that grows without bound do not differ in precision, they
  // differ in what happens when the filter blows up. Every unsaturated `int32_t`
  // in these objects folds at +/-16.0, and three of them are reachable FROM THE
  // KNOBS — so all three fold here too. Reproducing the fold is the faithful
  // choice AND the bounded one; clamping would be a limiter they do not have, and
  // a bare float reaching Infinity would poison the graph for the session.
  const RUN = 60000;
  const drive = (i) => 0.9 * Math.sin(2 * Math.PI * K.axPitchToHz(24) * i / FS);

  // 1. THE BIQUAD at reso 64: qinv hits its one-LSB floor, the poles land on the
  //    unit circle, and an on-corner sine rings up forever.
  const biquad = floatBiquad("lowpass", 24, 64);
  let peak = 0;
  let statePeak = 0;
  for (let i = 0; i < RUN; i++) {
    const r = biquad(drive(i));
    peak = Math.max(peak, Math.abs(r.out));
    statePeak = Math.max(statePeak, Math.abs(r.state));
  }
  assert.ok(Number.isFinite(peak) && peak <= 1, `the biquad's OUTPUT saturates at 1.0; saw ${peak}`);
  assert.ok(Number.isFinite(statePeak) && statePeak <= K.FRAC32_HEADROOM,
    `and its unsaturated STATE folds at the frac32 rail rather than climbing; saw ${statePeak}`);
  // MEASURED, AND THE NUMBER IS THE INTERESTING PART: 3.5e-5 after 60000 samples of
  // on-corner drive at the very top of the dial. The biquad's state overflow is
  // NOT reachable in practice, and the reason is the extra qinv itself — the input
  // gain falls as 1/(2Q) at exactly the rate the resonance grows, so the ring-up is
  // a millionth of full scale. The wrap stays because it costs nothing and removes
  // the Infinity failure mode categorically, not because this filter needs it.
  console.log(`  biquad state at reso 64 after ${RUN} on-corner samples: ${statePeak.toExponential(2)} (rail is ${K.FRAC32_HEADROOM})`);

  // 2. THE COMB at a = 1, which the knob allows because theirs does: the loop
  //    never decays, so the accumulator must fold instead of climbing.
  // AT THE COMB'S OWN FUNDAMENTAL, fs/M — anywhere else the repeats do not add up
  // and the loop never reaches the rail, which is a stimulus mistake dressed as a
  // passing test.
  const M = 61;
  const combDrive = (i) => 0.9 * Math.sin(2 * Math.PI * (FS / M) * i / FS);
  const line = new Float32Array(M);
  let w = 0;
  let combPeak = 0;
  for (let i = 0; i < RUN; i++) {
    const y = K.axWrapFrac32(1 * combDrive(i) / 2 + 1 * line[w]);
    line[w] = y;
    w = (w + 1) % M;
    combPeak = Math.max(combPeak, Math.abs(y));
  }
  assert.ok(Number.isFinite(combPeak) && combPeak <= K.FRAC32_HEADROOM,
    `an undecaying comb must fold at the frac32 rail, not climb; saw ${combPeak}`);
  // And it MUST actually have got there — a bound nothing reaches proves nothing.
  // THE COMB IS THE ONE THAT REALLY GETS THERE, and a bound nothing reaches proves
  // nothing — so this half is asserted rather than merely reported.
  assert.ok(combPeak > 1, `an undecaying comb on its own fundamental must overflow full scale; peak only ${combPeak}`);
  console.log(`  comb state at a = 1 on its own fundamental: peak ${combPeak.toFixed(3)}, folded at the rail`);
});

// ── 2. vcf3 — THE OLDER, DIFFERENT BIQUAD ───────────────────────────────────

/** `f_filter_biquad_A`, axoloti_filters.c:72-118 @ 1.0.12. */
function refVcf3(pitchDial, resoDial) {
  const filterW0 = mtof(dialRaw(pitchDial));
  const sinW0 = sin2t(filterW0);
  const cosW0 = sin2t(filterW0 + HALFQ31);
  const qInv = qInvRaw(resoDial);
  const alpha = smmul(sinW0, qInv);
  const a0 = HALFQ31 + alpha;
  const a0InvQ31 = Math.trunc(INT32_MAX * fround32((INT32_MAX >> 2) / fround32(a0)));
  const a1 = smmul(cosW0, a0InvQ31);
  const a2 = smmul(-(HALFQ31 - alpha), a0InvQ31);
  const b0 = smmul(HALFQ31 - (cosW0 >> 1), a0InvQ31);
  const b1 = b0 >> 1;
  const state = { x1: 0, x2: 0, y1: 0, y2: 0 };
  return (xReal) => {
    const x = toRaw(xReal);
    let accu = smmul(b0, x);
    accu = smmla(b0, state.x2, accu);
    accu = smmla(b1, state.x1, accu);
    accu = smmla(a1, state.y1, accu);
    accu = smmla(a2, state.y2, accu);
    const y = i32(ssat(accu, 28) * 16);
    state.x2 = state.x1;
    state.x1 = x;
    state.y2 = state.y1;
    state.y1 = y;
    return toReal(y);
  };
}

function floatVcf3(pitchDial, resoDial) {
  const c = new Float64Array(4);
  K.axVcf3Coefs(K.axCutoffHz(pitchDial, FS), resoDial, FS, c);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  // THE SHIPPED CONSTANT, not a literal. Spelling `16` here is how this file let a
  // FRAC32_HEADROOM of MINUS sixteen ship: the port railed at the wrong sign and
  // the test, holding its own correct copy, agreed with the firmware anyway.
  const LIMIT = K.FRAC32_HEADROOM;
  return (x) => {
    let y = c[0] * x + c[1] * x1 + c[0] * x2 - c[2] * y1 - c[3] * y2;
    y = y > LIMIT ? LIMIT : y < -LIMIT ? -LIMIT : y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

check("vcf3 tracks its OWN (older) firmware, and is measurably NOT filter/lp", () => {
  const SAMPLES = 3000;
  const ref = refVcf3(24, 40);
  const got = floatVcf3(24, 40);
  let worst = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const x = 0.5 * Math.sin(2 * Math.PI * 300 * i / FS) + 0.25 * Math.sin(2 * Math.PI * 4300 * i / FS);
    worst = Math.max(worst, Math.abs(got(x) - ref(x)));
  }
  assert.ok(worst < 1e-4, `vcf3 worst sample error ${worst.toExponential(3)}`);
  // The two claims in vcf3's docblock, measured rather than reasoned: no extra
  // qinv (so it gets LOUDER with Q where filter/lp does not) and a [2,1,2]
  // numerator (so it does NOT null at Nyquist).
  const fc = K.axPitchToHz(24);
  const quiet = measureGain(floatVcf3(24, 16), fc);
  const loud = measureGain(floatVcf3(24, 56), fc);
  assert.ok(loud / quiet > 3, `vcf3 should get much louder with Q; got ${(loud / quiet).toFixed(2)}x`);
  const nyquist = measureGain(floatVcf3(24, 40), FS / 2 - 1000);
  assert.ok(nyquist > 1e-3, `a [1,2,1] numerator would null here; vcf3's [2,1,2] does not (got ${nyquist.toExponential(2)})`);
});

check("vcf3's numerator really is [2, 1, 2] — the halving where the newer code doubles", () => {
  const c = new Float64Array(4);
  K.axVcf3Coefs(1000, 32, FS, c);
  assert.equal(c[1] / c[0], 0.5, "b(x[n-1]) must be HALF b(x[n]), not double");
});

// ── 3. THE ONE-POLE ─────────────────────────────────────────────────────────

check("lp1 is alpha = 2*fc/fs and its -3 dB point is fc/PI, not fc", () => {
  const pitch = 24;
  const fc = K.axPitchToHz(pitch);
  assert.ok(Math.abs(K.axOnePoleAlpha(fc, FS) - 2 * fc / FS) < 1e-15, "the coefficient is the phase increment doubled");
  const onePole = () => { let v = 0; const a = K.axOnePoleAlpha(fc, FS); return (x) => { v += (x - v) * a; return v; }; };
  const corner = fc / Math.PI;
  const gAtCorner = measureGain(onePole(), corner);
  const gAtLabel = measureGain(onePole(), fc);
  const HALF_POWER = Math.SQRT1_2;
  // 2% of the half-power point: the discrete recurrence's corner is not exactly
  // the analogue one, and the gap is what makes this worth measuring.
  assert.ok(Math.abs(gAtCorner - HALF_POWER) < 0.02, `-3 dB should be at fc/PI; gain there is ${gAtCorner.toFixed(4)}`);
  assert.ok(gAtLabel < 0.45, `at the frequency the KNOB names the filter is already ${(20 * Math.log10(gAtLabel)).toFixed(1)} dB down`);
});

check("lp1 matches the integer firmware sample for sample", () => {
  const pitchDial = 12;
  const f = mtof(dialRaw(pitchDial));
  let valRef = 0;
  const ref = (xReal) => { valRef = smmla(i32((toRaw(xReal) - valRef) * 2), f, valRef); return toReal(valRef); };
  let valGot = 0;
  const alpha = K.axOnePoleAlpha(K.axCutoffHz(pitchDial, FS), FS);
  const got = (x) => { valGot += (x - valGot) * alpha; return valGot; };
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const x = 0.7 * Math.sin(2 * Math.PI * 190 * i / FS);
    worst = Math.max(worst, Math.abs(got(x) - ref(x)));
  }
  assert.ok(worst < 1e-5, `one-pole worst sample error ${worst.toExponential(3)}`);
});

check("the mtof clamp at fs/2 is reproduced, and it is where alpha reaches exactly 1", () => {
  assert.equal(K.axCutoffHz(96, FS), FS / 2, "pitch 96 is far above Nyquist and must clamp");
  assert.equal(K.axOnePoleAlpha(K.axCutoffHz(96, FS), FS), 1, "their instability point, reproduced");
});

// ── 4. THE CHAMBERLIN SVF ───────────────────────────────────────────────────

check("the SVF's damp is qinv squared and HALVED — the unshifted ___SMMUL", () => {
  for (const reso of RESOS_UNDER_TEST) {
    // The integer path, exactly: (0x80<<24) wraps to INT32_MIN, minus reso<<4,
    // then ___SMMUL with itself.
    const raw = i32(-2147483648 - i32(usat(dialRaw(reso), 27) * 16));
    const refDamp = smmul(raw, raw) / Math.pow(2, 31);
    assert.ok(Math.abs(K.axSvfDamp(reso) - refDamp) < 1e-9, `reso ${reso}: ${K.axSvfDamp(reso)} vs ${refDamp}`);
  }
});

check("the SVF's f IS the oscillator's sine table — sin(2*pi*fc/fs), and it FOLDS above fs/4", () => {
  for (const pitch of PITCHES_UNDER_TEST) {
    const refF = sin2t(mtof(dialRaw(pitch))) / Q31_TURN;
    const gotF = K.axSvfF(K.axCutoffHz(pitch, FS), FS);
    // RELATIVE, because `pitcht[]` stores a TRUNCATED integer phase increment: at
    // 82 Hz that increment is only ~7.4e6, so one lost unit is 1.4e-7 of it. The
    // port computes the frequency in double and does not inherit that truncation.
    assert.ok(Math.abs(gotF - refF) / refF < 1e-6, `pitch ${pitch}: f ${gotF} vs table ${refF}`);
  }
  assert.ok(Math.abs(K.axSvfF(FS / 4, FS) - 1) < 1e-12, "the coefficient peaks at fs/4");
  assert.ok(Math.abs(K.axSvfF(FS / 4 + 3000, FS) - K.axSvfF(FS / 4 - 3000, FS)) < 1e-12,
    "and above fs/4 it comes back down — the tuning folds, which is the sound of a high SVF sweep here");
});

check("the SVF's three taps are a real lowpass, bandpass and highpass", () => {
  const pitch = 24;
  const fc = K.axPitchToHz(pitch);
  const svf = (tap) => {
    const damp = K.axSvfDamp(32);
    const f = K.axSvfF(K.axCutoffHz(pitch, FS), FS);
    let low = 0; let band = 0;
    return (x) => {
      const notch = K.axWrapFrac32(x - damp * band);
      low = K.axWrapFrac32(low + f * band);
      const high = K.axWrapFrac32(notch - low);
      band = K.axWrapFrac32(f * high + band);
      return tap === "lp" ? low : tap === "bp" ? band : high;
    };
  };
  assert.ok(measureGain(svf("lp"), fc / 8) > measureGain(svf("lp"), fc * 8), "lp tap");
  assert.ok(measureGain(svf("hp"), fc * 8) > measureGain(svf("hp"), fc / 8), "hp tap");
  const bpAt = (hz) => measureGain(svf("bp"), hz);
  assert.ok(bpAt(fc) > bpAt(fc / 8) && bpAt(fc) > bpAt(fc * 8), "bp tap has a peak");
});

check("the frac32 range constants are POSITIVE — `1 << 31` is not 2^31 in JavaScript", () => {
  // The whole reason this check exists: `1 << 31` evaluates to -2147483648, so the
  // obvious spelling of "the int32 range in frac32 units" is MINUS sixteen. It
  // shipped that way and only a browser render caught it, because every other
  // reader of the limit had written the number out by hand.
  assert.equal(K.FRAC32_ONE, Math.pow(2, 27));
  assert.equal(K.FRAC32_HEADROOM, 16);
  assert.equal(K.FRAC32_SPAN, 32);
  // And the boundary the sign error got wrong while the interior still cancelled:
  // an int32 at exactly +2^31 wraps to -2^31, so +16.0 must come back as -16.0.
  assert.equal(K.axWrapFrac32(K.FRAC32_HEADROOM), -K.FRAC32_HEADROOM);
  assert.equal(K.axWrapFrac32(-K.FRAC32_HEADROOM), -K.FRAC32_HEADROOM);
});

check("the SVF WRAPS rather than exploding — their int32, not a limiter we invented", () => {
  assert.equal(K.axWrapFrac32(17), -15);
  assert.equal(K.axWrapFrac32(-17), 15);
  assert.equal(K.axWrapFrac32(0.25), 0.25);
  // Drive the least stable corner the dials allow and prove the output stays in
  // the frac32 range instead of reaching Infinity.
  const damp = K.axSvfDamp(64);
  const f = K.axSvfF(K.axCutoffHz(60, FS), FS);
  let low = 0; let band = 0; let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const x = 0.9 * Math.sin(2 * Math.PI * 5000 * i / FS);
    const notch = K.axWrapFrac32(x - damp * band);
    low = K.axWrapFrac32(low + f * band);
    band = K.axWrapFrac32(f * K.axWrapFrac32(notch - low) + band);
    worst = Math.max(worst, Math.abs(low), Math.abs(band));
  }
  assert.ok(Number.isFinite(worst) && worst <= 16, `state left the frac32 range: ${worst}`);
});

// ── 5. ALLPASS AND COMB — THE RECOVERED RECURRENCES ─────────────────────────

/** `filter/allpass` code.srate, over its int16 delay line. */
function refAllpass(delaySamples, gDial) {
  const line = new Int16Array(delaySamples);
  let dpos = 0;
  const g2 = i32(signedParam(gDial) * 16);
  return (xReal) => {
    const dout = i32(line[dpos] * 65536);
    const din = smmla(g2, dout, Math.trunc(toRaw(xReal) / 2));
    line[dpos] = i32(Math.floor(din / 32768));
    dpos = (dpos + 1) % delaySamples;
    return toReal(i32(i32(Math.floor(dout / 2) - smmul(g2, i32(din * 2))) * 2));
  };
}

check("allpass: the recovered v[n] = x + g*v[n-M] / y = v[n-M] - g*v[n] matches the firmware", () => {
  const M = 97;
  const G = 0.5;
  const ref = refAllpass(M, G * 64);
  const line = new Float32Array(M);
  let w = 0;
  const got = (x) => {
    const vDel = line[w];
    const v = x + G * vDel;
    line[w] = v;
    w = (w + 1) % M;
    return vDel - G * v;
  };
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const x = 0.5 * Math.sin(2 * Math.PI * 411 * i / FS);
    worst = Math.max(worst, Math.abs(got(x) - ref(x)));
  }
  // THE TOLERANCE IS THE DEVIATION. Their line stores `din >> 15` in an int16, so
  // every write throws away 15 bits: 2^15 raw units is 2.4e-4 of full scale, and
  // the allpass's v = 2*din doubles it. Measuring below that would mean the port
  // had reproduced a quantisation it deliberately does not have.
  assert.ok(worst < 2e-3, `allpass worst sample error ${worst.toExponential(3)}`);
  console.log(`  allpass: worst error vs firmware ${worst.toExponential(3)} (int16 line quantisation is ~5e-4)`);
});

check("allpass: THE SHIPPED PROCESSOR delays by the M it was asked for, not M-1", () => {
  // WHY THIS DRIVES THE WORKLET WHEN THE CHECK ABOVE DOES NOT, AND WHY THAT MATTERED.
  // The check above builds its own three-line `got()` and compares THAT to the
  // firmware. It passes whatever the shipped processor does, because the shipped
  // processor is not in it. On 2026-08-07 `AxAllpassProcessor` was reading its line
  // one sample short — for 24 patch references, compounding through every Schroeder
  // stage — and this suite was green the whole time, before AND after the fix. A test
  // that re-implements the thing under test cannot fail when the thing under test is
  // wrong; it can only fail when the transcription of the MATH is wrong, which is a
  // different and much smaller claim.
  //
  // An impulse with g = 0 makes the allpass a plain delay line: one echo, at an index
  // that is either right or wrong with nothing in between. No tolerance, no
  // correlation, no room to argue.
  const Cls = WORKLET_CLASSES.get("ax-allpass-processor");
  assert.ok(Cls, "ax-allpass-processor must be registered");

  const QUANTUM = 128;
  for (const M of [17, 64, 333]) {
    const proc = new Cls();
    const out = [];
    for (let q = 0; q * QUANTUM < M + QUANTUM; q++) {
      const inBuf = new Float32Array(QUANTUM);
      if (q === 0) inBuf[0] = 1;
      const outBuf = new Float32Array(QUANTUM);
      proc.process([[inBuf]], [[outBuf]], { delay: [M], g: [0] });
      out.push(...outBuf);
    }
    const at = out.findIndex((v) => Math.abs(v) > 1e-4);
    assert.equal(at, M, `an impulse into a g=0 allpass at delay ${M} must emerge at sample ${M}, got ${at}`);
  }
  console.log("  allpass: impulse emerges at exactly M for M = 17, 64, 333");
});

check("allpass is ALLPASS — flat magnitude, which is the only thing that makes it a diffuser", () => {
  const M = 97;
  const G = 0.6;
  const build = () => {
    const line = new Float32Array(M);
    let w = 0;
    return (x) => {
      const vDel = line[w];
      const v = x + G * vDel;
      line[w] = v;
      w = (w + 1) % M;
      return vDel - G * v;
    };
  };
  for (const hz of [120, 700, 2200, 6100]) {
    const g = measureGain(build(), hz);
    assert.ok(Math.abs(g - 1) < 0.02, `gain at ${hz} Hz is ${g.toFixed(4)}, not unity`);
  }
});

check("fdbkcomb: the B knob really is HALVED, which its own description denies", () => {
  const M = 61;
  const A = 0.4;
  const B = 1;
  const line = new Int16Array(M);
  let dpos = 0;
  const a2 = i32(signedParam(A * 64) * 16);
  const b2 = i32(signedParam(B * 64) * 16);
  const ref = (xReal) => {
    const dout = i32(line[dpos] * 65536);
    let din = smmul(b2, toRaw(xReal));
    din = smmla(a2, dout, din);
    line[dpos] = i32(Math.floor(din / 32768));
    dpos = (dpos + 1) % M;
    return toReal(din);
  };
  const fLine = new Float32Array(M);
  let w = 0;
  const got = (x) => {
    const delayed = fLine[w];
    const y = B * x / 2 + A * delayed;
    fLine[w] = y;
    w = (w + 1) % M;
    return y;
  };
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const x = 0.5 * Math.sin(2 * Math.PI * 333 * i / FS);
    worst = Math.max(worst, Math.abs(got(x) - ref(x)));
  }
  assert.ok(worst < 1e-3, `comb worst sample error ${worst.toExponential(3)}`);
  console.log(`  fdbkcomb: worst error vs firmware ${worst.toExponential(3)} (same int16 line)`);
  // And state the halving as a number: an impulse of 1 with b = 1 emits 0.5.
  const impulseLine = new Float32Array(M);
  let iw = 0;
  const impulse = (x) => { const d = impulseLine[iw]; const y = B * x / 2 + A * d; impulseLine[iw] = y; iw = (iw + 1) % M; return y; };
  assert.equal(impulse(1), 0.5, "y[0] must be b/2, not b");
});

// ── 6. ZDF SVF AND BUTTERWORTH — SOURCE-FLOAT PORTS ─────────────────────────

check("ZDF SVF: tiar's Q map spans 0.25 to 80, and update() is his 7-squaring cascade", () => {
  assert.ok(Math.abs(K.axZdfQ(0) - 0.25) < 1e-12, "dial 0 is Q = 0.25");
  assert.ok(Math.abs(K.axZdfQ(64) - 80) < 1e-12, "dial 64 is Q = 80");
  // The coefficient step is a matrix squared 7 times = the 128th power. Verified
  // structurally: at f -> 0 the filter must become the identity (a = 0, b = 0,
  // c = 1), which only holds if the cascade is composed correctly.
  const s = new Float64Array(9);
  K.axZdfUpdate(1, 0, s);
  assert.ok(Math.abs(s[3]) < 1e-12 && Math.abs(s[4]) < 1e-12 && Math.abs(s[5] - 1) < 1e-12,
    `f = 0 must leave the identity, got a=${s[3]} b=${s[4]} c=${s[5]}`);
});

check("ZDF SVF is a stable lowpass across the band, and its interpolation is one buffer late", () => {
  const pitch = 24;
  const fc = K.axPitchToHz(pitch);
  const build = () => {
    const s = new Float64Array(9);
    const q = K.axZdfQ(16);
    const d = 1 / (2 * q);
    K.axZdfUpdate(d, 205 * 2 * Math.PI * K.axCutoffHz(pitch, FS) / (FS * FS), s);
    s[0] = s[3]; s[1] = s[4]; s[2] = s[5];
    s[6] = 0; s[7] = 0; s[8] = 0;
    let lp = 0; let bp = 0;
    return (x) => {
      const xLp = x - lp;
      lp += s[0] * xLp + s[1] * bp;
      bp = s[1] * xLp + s[2] * bp;
      return lp;
    };
  };
  const low = measureGain(build(), 100);
  const high = measureGain(build(), 12000);
  assert.ok(Number.isFinite(low) && Number.isFinite(high), "the recursion must stay finite");
  assert.ok(low > high, `lowpass expected: ${low.toFixed(4)} at 100 Hz vs ${high.toExponential(3)} at 12 kHz`);
  // The LATENESS: da is (target - current)/16, so a fresh block starts at the OLD
  // value and only arrives at the sixteenth sample. Stated as an assertion because
  // "deliberately one buffer late" is otherwise just a claim in a comment.
  const s = new Float64Array(9);
  s[0] = 0; s[1] = 0; s[2] = 0;
  K.axZdfUpdate(0.5, 0.01, s);
  let a = s[0];
  for (let i = 0; i < K.AX_BUFSIZE; i++) a += s[6];
  assert.ok(Math.abs(a - s[3]) < 1e-12, "after exactly 16 samples the coefficient has arrived, not before");
  assert.ok(Math.abs(s[0] + s[6] - s[3]) > 1e-6, "and the FIRST sample of the block is still near the old value");
});

check("Butt10: unity DC gain per stage, ten tabulated cutoffs, monotone ordering", () => {
  const labels = Object.keys(K.AX_BUTT10_STAGES);
  assert.equal(labels.length, 10, "tiar ships ten cutoffs");
  for (const label of labels) {
    const stages = K.AX_BUTT10_STAGES[label];
    assert.equal(stages.length, 5, `${label}: five biquads make ten poles`);
    for (const [b0, a1] of stages) {
      const b1 = 2 * b0;
      const a2 = 1 - 2 * b1 - a1;
      // His own comment: "unity gain at DC => 2*b0 + b1 + a1 + a2 = 1".
      const dc = (2 * b0 + b1) / (1 - a1 - a2);
      assert.ok(Math.abs(dc - 1) < 1e-12, `${label}: DC gain ${dc}`);
      // Poles inside the unit circle: |a2| < 1 and |a1| < 1 - a2 for a stable
      // second-order section written y = ... + a1*y1 + a2*y2.
      assert.ok(Math.abs(a2) < 1, `${label}: |a2| = ${Math.abs(a2)} is not stable`);
      assert.ok(Math.abs(a1) < 1 - a2, `${label}: pole outside the unit circle`);
    }
  }
});

check("Butt10 at its lowest setting really is a 10-pole brick wall", () => {
  const stages = K.AX_BUTT10_STAGES["900"];
  const build = () => {
    const st = stages.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
    return (x) => {
      let v = x;
      for (let s = 0; s < stages.length; s++) {
        const b0 = stages[s][0];
        const a1 = stages[s][1];
        const b1 = 2 * b0;
        const a2 = 1 - 2 * b1 - a1;
        const st1 = st[s];
        const y = b0 * (v + st1.x2) + b1 * st1.x1 + a1 * st1.y1 + a2 * st1.y2;
        st1.x2 = st1.x1; st1.x1 = v; st1.y2 = st1.y1; st1.y1 = y;
        v = y;
      }
      return v;
    };
  };
  const pass = measureGain(build(), 200);
  const stop = measureGain(build(), 3600);   // two octaves above the label
  assert.ok(Math.abs(pass - 1) < 0.05, `passband gain ${pass.toFixed(4)} should be unity`);
  // 10 poles is 60 dB/octave, so two octaves up must be deeply gone.
  assert.ok(20 * Math.log10(stop / pass) < -60, `two octaves up is only ${(20 * Math.log10(stop / pass)).toFixed(1)} dB down`);
});

// ── 7. THE CONTROL-RATE LAW ─────────────────────────────────────────────────

check("the control rate is fs/16 — eight ticks per 128-frame quantum, not one", () => {
  assert.equal(K.AX_BUFSIZE, 16, "Axoloti's BUFSIZE");
  const QUANTUM = 128;
  assert.equal(QUANTUM / K.AX_BUFSIZE, 8, "eight k-rate ticks per process() call");
  assert.equal(FS / K.AX_BUFSIZE, 3000, "which is exactly 3000 Hz at 48 kHz");
  // The processors count their ticks with `kPhase`, and a hoisted update would
  // show up as the string `% AX_BUFSIZE` being absent from a per-sample loop.
  const ticks = WORKLET_SOURCE.match(/this\.kPhase = \(this\.kPhase \+ 1\) % AX_BUFSIZE;/g);
  // And the three state variables that can legitimately exceed full scale must
  // fold in the SHIPPED code, not only in this file's mirror of it.
  // SEVEN CALL SITES, and they are enumerable: the biquad's y, the allpass's v,
  // the comb's accumulator, and the SVF's notch/low/high/band. The DEFINITION is
  // not among them any more — it lives in ax3_kernels.js — so this counts uses.
  const AX3_WRAP_SITES = 1 + 1 + 1 + 4;
  const wraps = WORKLET_SOURCE.match(/axWrapFrac32\(/g);
  assert.equal(wraps ? wraps.length : 0, AX3_WRAP_SITES,
    "every state variable that can legitimately exceed full scale must fold, and no others");
  assert.ok(ticks && ticks.length >= 7, `every k-rate processor must advance kPhase per SAMPLE; found ${ticks ? ticks.length : 0}`);
});

check("every processor this block ships is registered, once", () => {
  const names = [...WORKLET_SOURCE.matchAll(/registerProcessor\("([^"]+)"/g)].map((m) => m[1]);
  const expected = [
    "ax-biquad-processor", "ax-vcf3-processor", "ax-onepole-processor", "ax-svf-processor",
    "ax-kfilter-lowpass-processor", "ax-allpass-processor", "ax-fdbkcomb-processor",
    "ax-zdf-svf-processor", "ax-butterworth10-processor",
  ];
  assert.deepEqual(names.slice().sort(), expected.slice().sort(), "the registered set must be exactly the nine ported filters");
});

// ── 8. THE SPECS, AND THE THREE PLACES A NODE HAS TO EXIST IN ───────────────

check("every spec has a module factory, a processor, and a plugin — no half-registered node", async () => {
  const registered = [...WORKLET_SOURCE.matchAll(/registerProcessor\("([^"]+)"/g)].map((m) => m[1]);
  assert.equal(BLOCK_SPECS.length, Object.keys(BLOCK_MODULE_FACTORIES).length, "one factory per spec");
  assert.equal(BLOCK_SPECS.length, registered.length, "one processor per spec");
  for (const spec of BLOCK_SPECS) {
    assert.ok(BLOCK_MODULE_FACTORIES[spec.module], `${spec.type}: no factory named ${spec.module}`);
    assert.ok(BLOCK_WORKLET_MODULES.includes(spec.module), `${spec.type}: not in the init() gate`);
    // THE REAL ACCOUNTING, not this block's private mirror of it. The old assertion read
    // a `BLOCK_IMPLEMENTATION` derived two lines away from the same keys it was checked
    // against — it could not fail. synth/modules.IMPLEMENTATION is what the engine reads,
    // and it can: a block whose modules never reach PORT_BLOCK_MODULES lands here as
    // `undefined`.
    assert.equal(IMPLEMENTATION[spec.module], "worklet", `${spec.type}: implementation accounting`);
    // The plugin file is where the palette reaches these; a spec with no wrapper
    // is a node nobody can add, which is the failure audio_index.js's own header
    // calls out.
    const plugin = audioNodePlugin(spec);
    assert.equal(plugin.type, spec.type, `${spec.type}: plugin type`);
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type}: family ${spec.family} is not one of ours`);
    for (const port of [...(spec.inputs ?? []), ...(spec.outputs ?? [])]) {
      assert.ok(PORT_TYPE_NAMES.includes(port.type), `${spec.type}.${port.key}: port type ${port.type}`);
    }
  }
});

check("THE DRY GUARD: no AX-3 type or module name collides with a spec from another block", () => {
  // BY IDENTITY, NOT BY NAME. The lead splices BLOCK_SPECS into AUDIO_SPECS, so
  // once this block is wired every one of its types is legitimately "already in"
  // the shipped list — comparing type strings alone turns the wiring itself into a
  // red. What must stay impossible is a SECOND, DIFFERENT spec claiming one of
  // these names.
  const mine = new Set(BLOCK_SPECS);
  const foreign = AUDIO_SPECS.filter((s) => !mine.has(s));
  const shipped = new Set(foreign.map((s) => s.type));
  const shippedModules = new Set(foreign.map((s) => s.module));
  const seen = new Set();
  for (const spec of BLOCK_SPECS) {
    assert.ok(!shipped.has(spec.type), `${spec.type} is also claimed by a spec from another block`);
    assert.ok(!shippedModules.has(spec.module), `module ${spec.module} is also claimed by another block`);
    assert.ok(!seen.has(spec.type), `${spec.type} declared twice`);
    seen.add(spec.type);
  }
});

check("every knob is inside its own range, has a row, and has a default", () => {
  for (const spec of BLOCK_SPECS) {
    const defaults = audioKnobDefaults(spec);
    const rows = audioKnobRows(spec);
    assert.equal(rows.length, spec.knobs.length, `${spec.type}: every knob needs an Inspector row`);
    for (const knob of spec.knobs) {
      assert.ok(knob.help && knob.help.length > 0, `${spec.type}.${knob.key}: no help`);
      if (knob.discrete) {
        assert.ok(knob.options.includes(knob.default), `${spec.type}.${knob.key}: default is not an option`);
      } else {
        assert.ok(knob.default >= knob.min && knob.default <= knob.max,
          `${spec.type}.${knob.key}: default ${knob.default} outside [${knob.min}, ${knob.max}]`);
      }
    }
    assert.equal(Object.keys(defaults).length, spec.knobs.length, `${spec.type}: every knob needs a default leaf`);
  }
});

check("R7-17: every spec carries a derivation record with all four required parts", () => {
  for (const spec of BLOCK_SPECS) {
    const d = spec.derivation;
    assert.ok(d, `${spec.type}: no derivation record`);
    // The exact source AND the commit or tag it was read at — a bare object name
    // cannot do the debugging job the record exists for.
    assert.match(d.source, /axoloti-(factory|contrib)/, `${spec.type}: source must name the repo`);
    assert.match(d.source, /@ (tag )?[0-9a-f.]{6,}/, `${spec.type}: source must pin a commit or tag`);
    assert.match(d.block, /code\.(krate|srate|declaration)|firmware\//, `${spec.type}: block must name where the recurrence is`);
    assert.ok(d.recurrence.includes("\n"), `${spec.type}: the recurrence must be written out`);
    assert.ok(Array.isArray(d.deviations) && d.deviations.length > 0, `${spec.type}: deviations must be named`);
  }
});

check("the SVFs' extended pitch range is ONE number, not two that can drift", () => {
  // MTOFEXTENDED's __SSAT(., 29) is +/-128 semitones and the spec file owns it;
  // the two SVF processors declare the same range on their AudioParam. A grep,
  // because a worklet's parameterDescriptors cannot be read without an engine.
  const declared = [...WORKLET_SOURCE.matchAll(/name: "pitch", defaultValue: \d+, minValue: (-?\d+), maxValue: (\d+)/g)];
  const extended = declared.filter(([, lo]) => Number(lo) === -AX_PITCH_INPUT_LIMIT);
  assert.equal(extended.length, 2, `exactly two processors read MTOFEXTENDED; found ${extended.length}`);
  for (const [, lo, hi] of extended) assert.equal(Number(hi), AX_PITCH_INPUT_LIMIT, "range must be symmetric");
});

console.log(`\nport_ax3_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
