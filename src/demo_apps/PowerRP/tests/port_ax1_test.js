/**
 * AX-1 PORT FIDELITY — the float recurrences measured against Axoloti's integer ones.
 * Run: node src/demo_apps/PowerRP/tests/port_ax1_test.js
 *
 * ── WHY THIS SUITE EXISTS AND WHAT IT IS FOR ────────────────────────────────
 * "Mathematically near identical so that they sound the same" (manifest § R7-11) is
 * a NUMERIC claim, and the failure mode of getting it wrong is not an exception — it
 * is a patch that plays and sounds subtly wrong, which nothing else here can catch.
 * A missing `<<4` makes a gain 16× off; hoisting k-rate work makes an envelope 8×
 * slow; `bool32 → frac32` as +1/64 instead of +1.0 makes a comparator inaudible.
 * Every one of those still renders, still exits 0, and still sounds broken.
 *
 * So each node is swept through BOTH arithmetics and the MAX ABSOLUTE ERROR is
 * printed. The numbers are the deliverable, not the pass/fail: a bound that suddenly
 * grows is the signal, and the printout is what a later "this sounds wrong" session
 * diffs against.
 *
 * ── WHAT AN ERROR BOUND HERE MEANS ──────────────────────────────────────────
 * frac32's least significant bit is 2^−27 ≈ 7.45e-9. An error at that scale is the
 * fixed-point grid itself and is not a port defect — it is what porting TO float
 * fixes. An error at 1e-3 is a wrong shift. The two are four orders apart, which is
 * why a single printed number separates them so cleanly.
 *
 * Bare node, no DOM, no AudioContext: synth/ax1_dsp.js is deliberately free of both.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AX_DECODE_WIDTH, AX_DIAL_FULL_SCALE, AX_KRATE_BLOCK, AX_LOGIC_OPS, AX_LOGIC_OP_NAMES,
  AX_MATH_OPS, AX_MATH_OP_NAMES, AX_STEP_COUNT, AX_WINDOW_SIZE, FRAC32_ONE,
  axBipolarToUnipolar, axBoolToFrac, axCounterTick, axDecode8, axDivRem, axFracToInt,
  axHannWindow, axIntSmoothTick, axInterpRamp, axLatchTick, axParamGain, axParamGain16,
  axParamUnsigned, axShaper4, axSmmul, axSmoothCoefficient, axSsat, axStep4Level,
  axStepBool, axStepValue, axStereoOutSample, axUnipolarToBipolar, axUsat, axWindowTable,
} from "../synth/ax1_dsp.js";
import { BLOCK_SPECS, AX1_MATH_OP_OPTIONS, AX1_LOGIC_OP_OPTIONS } from "../core/audio_specs_ax1.js";
import { BLOCK_MODULE_FACTORIES } from "../synth/modules_ax1.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_ax1.js";
import { audioKnobRows, audioPorts } from "../core/audio_nodes.js";
import { NODE_FAMILY_NAMES } from "../core/node_chrome.js";
import { PORT_TYPE_NAMES } from "../core/nodeflow.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/** The measured bounds, printed at the end as one table. */
const measured = [];
const record = (node, what, error, bound) => {
  measured.push({ node, what, error, bound });
  assert.ok(error <= bound, `${node} / ${what}: max abs error ${error.toExponential(3)} exceeds ${bound.toExponential(3)}`);
};

/** frac32's least significant bit — the floor any faithful port sits on. */
const FRAC32_LSB = 1 / FRAC32_ONE;

/** A deterministic sweep of frac32 values covering both polarities, both ends of the
 *  nominal range and a slice of the headroom above it. Raw int32, so the integer side
 *  is exercised on the grid it really lives on. */
function frac32Sweep(count) {
  const values = [];
  for (let i = 0; i < count; i++) {
    // -2.0 … +2.0 of frac32 scale: enough to exercise every saturation in the table.
    values.push(Math.round((-2 + (4 * i) / (count - 1)) * FRAC32_ONE));
  }
  return values;
}

// ── math/op — every arithmetic operation, both arithmetics ──────────────────
//
// The two paramIsDial ops (`attenuate`, `gain16`) take a DIAL on the integer side and
// the already-mapped float on ours, because that is exactly the layer § R7-11 warns
// about: their `b` passes through a pfunction and ours does not. The conversion in
// this sweep IS the claim being tested.

const DIAL_TO_ATTENUATION = (dial) => dial / AX_DIAL_FULL_SCALE;
const DIAL_TO_GAIN16 = (dial) => (16 * dial) / AX_DIAL_FULL_SCALE;

check("math/op: every operation agrees with its integer source to within one frac32 LSB", () => {
  const inputs = frac32Sweep(401);
  const dials = [0, 1, 4, 8, 16, 32, 48, 64];
  for (const name of AX_MATH_OP_NAMES) {
    const op = AX_MATH_OPS[name];
    if (op.int === null) continue; // ringModAntialiased: float in the source too
    let worst = 0;
    for (const ai of inputs) {
      const af = ai / FRAC32_ONE;
      if (op.paramIsDial) {
        for (const dial of dials) {
          const bf = name === "gain16" ? DIAL_TO_GAIN16(dial) : DIAL_TO_ATTENUATION(dial);
          worst = Math.max(worst, Math.abs(op.int(ai, dial) / FRAC32_ONE - op.float(af, bf)));
        }
      } else if (op.unary) {
        worst = Math.max(worst, Math.abs(op.int(ai) / FRAC32_ONE - op.float(af)));
      } else {
        // Ops whose integer form pre-shifts have a DOMAIN — past it their int32 wraps
        // rather than saturating. Sweeping outside it measures their overflow, not our
        // port; the wrap itself is pinned by its own check below.
        if (op.intValidAbsA !== undefined && Math.abs(af) >= op.intValidAbsA) continue;
        for (const bi of inputs) {
          const bf = bi / FRAC32_ONE;
          if (op.intValidAbsB !== undefined && Math.abs(bf) >= op.intValidAbsB) continue;
          const expected = name === "greaterThan"
            ? axBoolToFrac(op.int(ai, bi))
            : op.int(ai, bi) / FRAC32_ONE;
          worst = Math.max(worst, Math.abs(expected - op.float(af, bf)));
        }
      }
    }
    // A FEW LSB, not zero. Three sources of small disagreement, all benign and all
    // inherent to leaving fixed point:
    //   - `>>` is an ARITHMETIC shift, so the divide ops FLOOR while we divide exactly;
    //     a negative odd input lands 2^-27 low.
    //   - the pfunctions clamp one LSB short of full scale (`__USAT(v,27)` tops out at
    //     2^27 − 1), so a dial of 64 is 0.99999999 of a gain rather than 1.0.
    //   - the `muls N` family's `__SSAT` tops out one INPUT LSB short and then shifts
    //     left by log2(N), which multiplies that shortfall by N. Hence the bound is
    //     DERIVED from the op's own factor rather than hand-set per op — a bound
    //     someone has to tune per entry is a bound that stops meaning anything.
    // A wrong SHIFT would show up here as 0.5, 2, or 16 — seven orders larger.
    record("math/op", name, worst, (op.ceilingSlackLsb ?? 2) * FRAC32_LSB);
  }
});

check("math/op: the multiply's shift law really is a·b (a wrong shift is 16× or 1/16×)", () => {
  // Pinned as its own case because `___SMMUL(a<<3, b<<2)` with a plain `<<1` instead
  // is the single commonest fixed-point porting error and it is silent.
  const half = FRAC32_ONE / 2;
  assert.equal(AX_MATH_OPS.multiply.int(half, half) / FRAC32_ONE, 0.25);
  assert.equal(AX_MATH_OPS.multiply.int(FRAC32_ONE, FRAC32_ONE) / FRAC32_ONE, 1);
  assert.equal(AX_MATH_OPS.multiply.float(0.5, 0.5), 0.25);
});

check("math/op: their multiply WRAPS above ±2.0, and we deliberately do not", () => {
  // `___SMMUL(a<<3, b<<2)` shifts an int32 before multiplying, so `a<<3` overflows at
  // |a| = 2^28 — an input of 2.0, well inside frac32's nominal ±16.0 of headroom.
  // Their result INVERTS rather than saturating. This is the boundary the sweep above
  // stops at, stated as a measurement so the exclusion is not an unexplained hole.
  const two = 2 * FRAC32_ONE;
  const half = FRAC32_ONE / 2;
  assert.equal(AX_MATH_OPS.multiply.int(two - FRAC32_ONE, half) / FRAC32_ONE, 0.5); // 1.0 × 0.5, fine
  const wrapped = AX_MATH_OPS.multiply.int(two, half) / FRAC32_ONE;
  assert.ok(wrapped < 0, `their multiply should invert at +2.0, got ${wrapped}`);
  assert.equal(AX_MATH_OPS.multiply.float(2, 0.5), 1); // ours keeps multiplying
  assert.equal(AX_MATH_OPS.multiply.intValidAbsA, 2);
  assert.equal(AX_MATH_OPS.multiply.intValidAbsB, 4);
});

check("math/op: bool32 → frac32 is +1.0, not +1/64", () => {
  // The coercion that looks like a typo. A comparator whose true is 1/64 is inaudible.
  assert.equal(axBoolToFrac(AX_MATH_OPS.greaterThan.int(1, 0)), 1);
  assert.equal(AX_MATH_OPS.greaterThan.float(0.1, 0), 1);
  assert.notEqual(AX_MATH_OPS.greaterThan.float(0.1, 0), 1 / AX_DIAL_FULL_SCALE);
});

check("math/op: `+1` adds ONE DIAL UNIT (1/64), which is not 1.0", () => {
  assert.equal(AX_MATH_OPS.addDialUnit.int(0), 1 << 21);
  assert.equal(AX_MATH_OPS.addDialUnit.float(0), 1 / AX_DIAL_FULL_SCALE);
});

check("math/op: the saturating multipliers clamp BEFORE the shift, not after", () => {
  // `__SSAT(in,27)<<1` pins at ±1.0 from an input of ±0.5. If the clamp were applied
  // after the doubling the ceiling would be the same but the KNEE would be at ±1.0,
  // so everything between 0.5 and 1.0 would differ — which is the audible part.
  const threeQuarters = Math.round(0.75 * FRAC32_ONE);
  assert.equal(AX_MATH_OPS.satMultiply2.int(threeQuarters) / FRAC32_ONE, 1 - FRAC32_LSB * 2);
  assert.equal(AX_MATH_OPS.satMultiply2.float(0.75), 1);
});

// ── math/smooth ─────────────────────────────────────────────────────────────

check("math/smooth: the one-pole tracks its integer source over a long run", () => {
  // Run both to convergence at several dials. Error ACCUMULATES in a recurrence, so
  // a single tick proves nothing — this is the shape of test the envelope work needs.
  for (const dial of [0, 8, 32, 56, 63]) {
    const coefficient = axSmoothCoefficient(dial);
    let intState = 0;
    let floatState = 0;
    let worst = 0;
    for (let tick = 0; tick < 20000; tick++) {
      // A square wave at the input, so the pole is driven in both directions.
      const target = tick % 4000 < 2000 ? 1 : -0.5;
      const targetInt = Math.round(target * FRAC32_ONE);
      intState = axIntSmoothTick(intState, targetInt, dial);
      floatState += (target - floatState) * coefficient;
      worst = Math.max(worst, Math.abs(intState / FRAC32_ONE - floatState));
    }
    // Looser than one LSB because the integer form TRUNCATES every tick, and 20000
    // truncations of the same sign accumulate into a standing offset — the classic
    // fixed-point one-pole "sticks short of target" behaviour. It is bounded by the
    // step size, not by the run length, which is why the bound does not grow with
    // more ticks. Measured maxima are printed below.
    record("math/smooth", `dial ${dial}, 20000 ticks`, worst, 1e-3);
  }
});

check("math/smooth: dial 64 FREEZES the value — the knob is backwards from its name", () => {
  assert.equal(axSmoothCoefficient(AX_DIAL_FULL_SCALE), 0);
  assert.equal(axIntSmoothTick(0, FRAC32_ONE, AX_DIAL_FULL_SCALE), 0);
});

// ── math/window ─────────────────────────────────────────────────────────────

check("math/window: the exact cosine matches their interpolated 1024-point table", () => {
  const table = axWindowTable();
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const phase = i / 20000;
    // Their hann_q31: pi = phase>>22 over a uint32 phase, linear between table entries.
    const scaled = phase * AX_WINDOW_SIZE;
    const index = Math.floor(scaled);
    const fraction = scaled - index;
    const tabled = (table[index] * (1 - fraction) + table[index + 1] * fraction) / 32767;
    worst = Math.max(worst, Math.abs(tabled - axHannWindow(phase)));
  }
  // THE BOUND IS SET BY THEIR int16 TRUNCATION, NOT BY THE INTERPOLATION, and that
  // was measured rather than assumed. Linear interpolation of a cosine at 1024 points
  // errs by at most |w''|·h²/8 = 2π²/(8·1024²) ≈ 2.4e-6 — but axoloti_math.c:51 writes
  // `(int16_t)(32767.0f · w)`, a C cast that TRUNCATES toward zero, so every entry can
  // sit a full 1/32767 ≈ 3.05e-5 low. The measured 3.0e-5 is that truncation almost
  // exactly, and it dominates the interpolation term by an order of magnitude.
  record("math/window", "exact cos vs their 1024-pt table", worst, 4e-5);
});

// ── math/divrem — including the bug we deliberately kept ────────────────────

check("math/divrem: agrees with floor division everywhere EXCEPT exact negative multiples", () => {
  let divergences = 0;
  for (let denominator = 1; denominator <= 128; denominator++) {
    for (let a = -500; a <= 500; a++) {
      const got = axDivRem(a, denominator);
      assert.equal(got.div * denominator + got.rem, a, `divrem(${a},${denominator}) does not reconstruct`);
      const floorDiv = Math.floor(a / denominator);
      if (got.div !== floorDiv) {
        divergences++;
        // The ONLY shape of divergence their formula produces. If a future edit
        // introduces a second shape this assertion is what says so.
        assert.ok(a < 0 && a % denominator === 0, `unexpected divergence at divrem(${a},${denominator})`);
        assert.equal(got.div, floorDiv - 1);
        assert.equal(got.rem, denominator);
      }
    }
  }
  assert.ok(divergences > 0, "the ported off-by-one has vanished — either fixed silently or the sweep missed it");
});

// ── math/shaper-k ───────────────────────────────────────────────────────────

check("math/shaper-k: matches the u4u segment arithmetic, quantisation aside", () => {
  const points = [0.1, 0.8, 0.3, 0.95, 0.4];
  let worst = 0;
  for (let i = 0; i <= 4000; i++) {
    const input = i / 4000;
    const inputInt = Math.round(input * FRAC32_ONE);
    // Their <code.krate>, verbatim.
    let expected;
    if (inputInt >= FRAC32_ONE) expected = axParamUnsigned(points[4] * AX_DIAL_FULL_SCALE);
    else if (inputInt <= 0) expected = axParamUnsigned(points[0] * AX_DIAL_FULL_SCALE);
    else {
      const segment = inputInt >> 25;
      const a = inputInt & ((1 << 25) - 1);
      const lo = axParamUnsigned(points[segment] * AX_DIAL_FULL_SCALE);
      const hi = axParamUnsigned(points[segment + 1] * AX_DIAL_FULL_SCALE);
      expected = (axSmmul((hi - lo) | 0, a) + (lo >> 7)) << 7;
    }
    worst = Math.max(worst, Math.abs(expected / FRAC32_ONE - axShaper4(input, points)));
  }
  // Their `>>7 … <<7` accumulator round trip throws away 7 bits of the segment base:
  // 2^7 / 2^27 ≈ 9.5e-7. That is arithmetic overhead, not shape, and we do not copy it.
  record("math/shaper-k", "u4u, 5 breakpoints", worst, 2e-6);
});

// ── conv/convert ────────────────────────────────────────────────────────────

check("conv/convert: the two range maps are exact inverses and match their shifts", () => {
  let worst = 0;
  for (const raw of frac32Sweep(801)) {
    const value = raw / FRAC32_ONE;
    worst = Math.max(worst, Math.abs(((raw >> 1) + (1 << 26)) / FRAC32_ONE - axBipolarToUnipolar(value)));
    worst = Math.max(worst, Math.abs((((raw - (1 << 26)) << 1) | 0) / FRAC32_ONE - axUnipolarToBipolar(value)));
  }
  record("conv/convert", "bipolar ⇄ unipolar", worst, 2 * FRAC32_LSB);
  // A round trip, to within binary64's own rounding — the two maps are exact inverses
  // in real arithmetic, and 0.3 is simply not representable.
  assert.ok(Math.abs(axUnipolarToBipolar(axBipolarToUnipolar(0.3)) - 0.3) < 1e-15);
});

check("conv/convert: the k→s ramp is ONE BUFFER LATE, exactly as gain/vca's is", () => {
  // The measured trace from the research report: prev=0, v=1.0 gives 0, 0.0625, …,
  // 0.9375 — it does NOT reach 1.0 inside the block it arrived in. That lateness is
  // the behaviour a ported patch is tuned against; removing it is not an improvement.
  const { start, step } = axInterpRamp(0, 1);
  const trace = [];
  let g = start;
  for (let i = 0; i < AX_KRATE_BLOCK; i++) { trace.push(g); g += step; }
  assert.equal(trace[0], 0);
  assert.equal(trace[1], 0.0625);
  assert.equal(trace[15], 0.9375);
  assert.notEqual(trace[15], 1);
});

// ── logic/* ─────────────────────────────────────────────────────────────────

check("logic/op: every mode reproduces its source's edge behaviour", () => {
  // `and` uses C truthiness on the raw word; `invert` uses `> 0`. They disagree on a
  // negative input, and that disagreement is Axoloti's, not ours.
  assert.equal(AX_LOGIC_OPS.and.run(-1, -1), 1);
  assert.equal(AX_LOGIC_OPS.invert.run(-1), 1);

  // `change` fires only every THIRD tick when the input alternates every tick. This
  // trace is the measurement that corrected the docblock, which had reasoned "every
  // other tick" from the interlock alone: after firing, `ptrig` must fall on a
  // non-firing tick, and the value just latched blocks the tick after that.
  const changeState = { pval: 0, ptrig: false };
  const changeFired = [];
  for (let i = 0; i < 9; i++) changeFired.push(AX_LOGIC_OPS.change.run(i % 2, changeState));
  assert.deepEqual(changeFired, [0, 1, 0, 0, 1, 0, 0, 1, 0]);

  // `rising` is one tick per rising edge, with no hysteresis at all.
  const risingState = { previous: false };
  const risingFired = [0, 1, 1, 1, 0, 0, 1].map((v) => AX_LOGIC_OPS.rising.run(v, risingState));
  assert.deepEqual(risingFired, [0, 1, 0, 0, 0, 0, 1]);
});

check("logic/counter: counts on rising edges, wraps with a carry, resets independently", () => {
  const s = { count: 0, ntrig: false, rtrig: false };
  const pulse = () => { axCounterTick(1, 0, 3, s); return axCounterTick(0, 0, 3, s); };
  assert.equal(pulse().count, 1);
  assert.equal(pulse().count, 2);
  // The wrap tick is the one that carries.
  const wrapped = axCounterTick(1, 0, 3, s);
  assert.equal(wrapped.count, 0);
  assert.equal(wrapped.carry, 1);
  axCounterTick(0, 0, 3, s);
  pulse();
  assert.equal(s.count, 1);
  axCounterTick(0, 1, 3, s);
  assert.equal(s.count, 0);
});

check("logic/latch: holds between rising edges, and has NO Schmitt hysteresis", () => {
  const s = { latch: 0, ntrig: false };
  assert.equal(axLatchTick(0.7, 1, s), 0.7);
  assert.equal(axLatchTick(0.2, 1, s), 0.7); // still high: no new edge
  axLatchTick(0.2, 0, s);
  assert.equal(axLatchTick(0.2, 1, s), 0.2);
  // The difference from PowerRP's own Sample & Hold, stated as a test: a trigger of
  // 0.2 is BELOW that node's 0.5 arming threshold and would not fire there.
  const wobble = { latch: 0, ntrig: false };
  assert.equal(axLatchTick(0.9, 0.2, wobble), 0.9);
});

check("logic/decode: one-hot, with the chain outlet that makes decoders cascade", () => {
  for (let v = 0; v < AX_DECODE_WIDTH; v++) {
    const { bits, chain } = axDecode8(v);
    assert.equal(bits.reduce((a, b) => a + b, 0), 1);
    assert.equal(bits[v], 1);
    assert.equal(chain, v - AX_DECODE_WIDTH);
  }
  assert.equal(axDecode8(99).bits.reduce((a, b) => a + b, 0), 0);
});

// ── sel/* ───────────────────────────────────────────────────────────────────

check("sel/steps-bool: the mask indexes by bit, and `pulse` fires only on an index CHANGE", () => {
  const mask = 0b1010101010101010;
  for (let i = 0; i < AX_STEP_COUNT; i++) {
    assert.equal(axStepBool(i, mask, false, -1, 0), i % 2 === 1 ? 1 : 0);
  }
  assert.equal(axStepBool(1, mask, true, 0, 0), 1);
  assert.equal(axStepBool(1, mask, true, 1, 0), 0);
  // Out of range falls through to `def`, which is what makes them chainable.
  assert.equal(axStepBool(16, mask, false, -1, 0.42), 0.42);
});

check("sel/steps-value and steps-multi: the switch, the 2-bit packing, and both chains", () => {
  assert.equal(axStepValue(2, [0.1, 0.2, 0.3], 0), 0.3);
  assert.equal(axStepValue(9, [0.1, 0.2, 0.3], -1), -1);
  // int2x16: two bits per step, low step in the low bits.
  const word = 0b11_10_01_00; // steps 0..3 = 0,1,2,3
  const words = [word, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 4; i++) assert.equal(axStep4Level(i, 0, words, -1).level, i);
  assert.equal(axStep4Level(3, 0, words, -1).chain, 3 - AX_STEP_COUNT);
  assert.equal(axStep4Level(3, 7, words, -1).chainRow, -1);
});

// ── audio/out ───────────────────────────────────────────────────────────────

check("audio/out: StOutVol is a HARD clip at ±1.0, applied after the volume", () => {
  assert.equal(axStereoOutSample(0.8, 0.5), 0.4);
  assert.equal(axStereoOutSample(4, 1), 1);
  assert.equal(axStereoOutSample(-4, 1), -1);
  // Volume first, THEN the clip — so a loud source turned down does not clip.
  assert.equal(axStereoOutSample(4, 0.1), 0.4);
});

// ── The coercion table, restated as tests because it is the trap ────────────

check("the cross-type coercions are the ones § R7-11 names, not the plausible ones", () => {
  assert.equal(axBoolToFrac(true), 1);
  assert.notEqual(axBoolToFrac(true), 1 / AX_DIAL_FULL_SCALE);
  assert.equal(axFracToInt(1), AX_DIAL_FULL_SCALE); // frac32 1.0 arrives as 64
  assert.equal(axParamUnsigned(AX_DIAL_FULL_SCALE), (1 << 27) - 1);
  assert.equal(axParamGain(AX_DIAL_FULL_SCALE), ((1 << 27) - 1) << 4);
  assert.equal(axSsat(1 << 29, 28), (1 << 27) - 1);
  assert.equal(axUsat(-1, 27), 0);
  assert.equal(axParamGain16(4), 1 << 27); // dial 4 of 64 is ×1 in math/gain's law
});

// ── The specs, checked against the DSP they describe ────────────────────────
//
// core/audio_specs_ax1.js may not import synth/** (core must run in bare node with no
// AudioContext in its import graph), so its option lists are RESTATED — the same
// arrangement core/audio_specs.js uses for SPECTRUM_BIN_OPTIONS, and pinned the same
// way: here, where importing both is legitimate.

check("the spec's operation lists are the DSP's, not a second hand-maintained copy", () => {
  assert.deepEqual(AX1_MATH_OP_OPTIONS, [...AX_MATH_OP_NAMES]);
  assert.deepEqual(AX1_LOGIC_OP_OPTIONS, [...AX_LOGIC_OP_NAMES]);
});

check("every AX-1 spec is structurally a spec: family, ports, knob ranges, derivation", () => {
  const seen = new Set();
  for (const spec of BLOCK_SPECS) {
    assert.ok(!seen.has(spec.type), `duplicate type ${spec.type} — the R7-17 DRY guard`);
    seen.add(spec.type);
    assert.ok(spec.type.startsWith("audio_ax_"), `${spec.type} does not carry the AX-1 prefix`);
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type}: unknown family ${spec.family}`);
    assert.ok(spec.help && spec.help.length > 20, `${spec.type}: no help`);
    for (const port of [...spec.inputs, ...spec.outputs]) {
      assert.ok(PORT_TYPE_NAMES.includes(port.type), `${spec.type}.${port.key}: unknown port type ${port.type}`);
    }
    for (const knob of spec.knobs) {
      if (knob.discrete) {
        assert.ok(knob.options.includes(knob.default), `${spec.type}.${knob.key}: default is not an option`);
      } else {
        assert.ok(knob.default >= knob.min && knob.default <= knob.max,
          `${spec.type}.${knob.key}: default ${knob.default} outside [${knob.min}, ${knob.max}]`);
      }
      assert.ok(knob.help, `${spec.type}.${knob.key}: no help`);
    }
    // THE DERIVATION RECORD IS PART OF THE DELIVERABLE (§ R7-17: "it's so we can
    // debug shit and find flaws in the emulation"). A row with a blank code block is
    // not done, so the blank is what fails here rather than being noticed later.
    const d = spec.derivation;
    assert.ok(d, `${spec.type}: no derivation record`);
    assert.ok(d.project && d.commit && d.objects.length > 0, `${spec.type}: incomplete derivation`);
    assert.ok(d.codeBlock && d.codeBlock.length > 0, `${spec.type}: the code block is BLANK`);
    assert.ok(d.recurrence && d.recurrence.length > 0, `${spec.type}: no float recurrence recorded`);
    assert.ok(Array.isArray(d.deviations), `${spec.type}: deviations must be a list, even an empty one`);
  }
  // The registry assigns AX-1 twenty-two nodes to write; this is what actually landed.
  assert.ok(BLOCK_SPECS.length >= 14, `only ${BLOCK_SPECS.length} AX-1 specs`);
});

check("the AX-1 plugin barrel covers BLOCK_SPECS exactly, in the same order", () => {
  // The barrel's own docblock promises this. Forgetting a line there is otherwise
  // silent: the node simply never appears in the palette, with nothing to say why.
  assert.equal(BLOCK_PLUGINS.length, BLOCK_SPECS.length);
  assert.deepEqual(BLOCK_PLUGINS.map((p) => p.type), BLOCK_SPECS.map((s) => s.type));
});

check("every AX-1 spec survives the shared audio-node shape", () => {
  // audioPorts/audioKnobRows are what core/audio_nodes.js builds every card from. A
  // spec that reads fine but cannot be turned into a node is the failure this catches.
  for (const spec of BLOCK_SPECS) {
    const ports = audioPorts(spec);
    assert.equal(ports.inputs.length, spec.inputs.length);
    assert.equal(ports.outputs.length, spec.outputs.length);
    assert.equal(audioKnobRows(spec).length, spec.knobs.length);
  }
});

// ── THE SPEC ⇄ ENGINE SEAM ──────────────────────────────────────────────────
//
// THE ENGINE LAW FORBIDS AN IMPORT BETWEEN THEM, SO A TEST HAS TO BE THE JOIN.
// synth/modules_ax1.js may not read core/audio_specs_ax1.js ("PowerRP controls the
// synth, the synth never reaches back") — the first draft of that file did, to derive
// each factory's parameter list, and it slipped through because
// tests/synth_engine_test.js's ENGINE-law check iterates a HARD-CODED list of five
// files. So each factory now STATES its ports and params, and this is where the two
// statements are compared.
//
// It is the same arrangement core/audio_specs.js and synth/modules.js already have
// through tests/audio_nodes_test.js, and it catches the same failure: a knob added to
// a spec and forgotten in the factory is an Inspector row whose value the engine
// silently discards.

check("every AX-1 spec has a factory, and every factory has a spec", () => {
  const byModule = new Map(BLOCK_SPECS.map((s) => [s.module, s]));
  for (const spec of BLOCK_SPECS) {
    assert.ok(BLOCK_MODULE_FACTORIES[spec.module], `spec ${spec.type} names missing module ${spec.module}`);
  }
  for (const name of Object.keys(BLOCK_MODULE_FACTORIES)) {
    assert.ok(byModule.has(name), `factory ${name} is named by no spec — an unreachable module`);
  }
});

check("each factory's ports and params are exactly what its spec declares", () => {
  for (const spec of BLOCK_SPECS) {
    const declaration = BLOCK_MODULE_FACTORIES[spec.module].ax1Declaration;
    // axStereoOut wraps its builder, so it carries no declaration of its own; its
    // inner one is checked through the worklet run below instead.
    if (!declaration) continue;
    assert.equal(declaration.type, spec.type, `${spec.module}'s declaration names the wrong spec`);

    // KNOBS ⇄ PARAMS. Every knob is either an AudioParam or a discrete message, and
    // nothing else is exposed — an engine param with no knob is unreachable, and a
    // knob with no param is a control that does nothing.
    const engineKnobs = new Set([...declaration.params, ...declaration.discrete]);
    const specKnobs = new Set(spec.knobs.map((k) => k.key));
    assert.deepEqual([...engineKnobs].sort(), [...specKnobs].sort(),
      `${spec.type}: the engine's knobs and the spec's disagree`);

    // PORTS ⇄ PORTS. A spec input is either an audio inlet the processor really has,
    // or a param the factory chose to expose as an inlet (§ R7-11's duality rule).
    const engineInlets = new Set([...declaration.inputs, ...declaration.paramInlets]);
    assert.deepEqual([...engineInlets].sort(), spec.inputs.map((p) => p.key).sort(),
      `${spec.type}: the engine's inlets and the spec's disagree`);
    assert.deepEqual([...declaration.outputs].sort(), spec.outputs.map((p) => p.key).sort(),
      `${spec.type}: the engine's outlets and the spec's disagree`);

    // A param that is NOT an inlet must not be claimed as one, which is the shaper's
    // deliberate case: five breakpoints, no beads.
    for (const inlet of declaration.paramInlets) {
      assert.ok(declaration.params.includes(inlet), `${spec.type}: ${inlet} is an inlet but not a param`);
    }
  }
});

check("the shaper deliberately exposes NO breakpoint inlets, and that is checked not assumed", () => {
  // Named as its own case because it is the one place this block departs from
  // § R7-11's "every param implicitly gets a same-named inlet", and a departure that
  // is only a comment is a departure that gets undone by the next person.
  const shaper = BLOCK_MODULE_FACTORIES.axShaper.ax1Declaration;
  assert.equal(shaper.params.length, 5);
  assert.deepEqual(shaper.paramInlets, []);
  const spec = BLOCK_SPECS.find((s) => s.type === "audio_ax_shaper");
  assert.deepEqual(spec.inputs.map((p) => p.key), ["in"]);
});

// ── THE WORKLET, RUN IN BARE NODE ───────────────────────────────────────────
//
// synth/worklets/processors_ax1.js RESTATES every recurrence, because the AudioWorklet
// global scope cannot import. processors.js carries the same duplication for its
// Schmitt thresholds and pins it with a test so it cannot drift; this is that pin, and
// it goes further — rather than comparing constants it RUNS the processors.
//
// Two things only this can prove, and both are silent failures otherwise:
//   1. THE K-RATE BRIDGE. A processor that hoists its control work to once per
//      128-frame quantum runs 8× slow. Nothing throws; a sequencer just plays at an
//      eighth of its tempo. The counter check below fires 8 edges into ONE quantum
//      and requires 8 counts, which is exactly the assertion that hoisting fails.
//   2. THE RESTATEMENT ITSELF. A recurrence that is right in ax1_dsp.js and wrong in
//      the worklet passes every other check in this file and still sounds wrong.
//
// The processors are evaluated against a STUB of the three ambient globals they use.
// That is legitimate for the same reason tests/audio_nodes_test.js's stub context is:
// it implements the SHAPE the code under test actually consumes, and proves the
// structural and numeric claims, not the audible ones.

const AX1_QUANTUM = 128;

/** Query. Load processors_ax1.js in bare node and return its registered processors. */
function loadWorkletProcessors() {
  const source = readFileSync(new URL("../synth/worklets/processors_ax1.js", import.meta.url), "utf8");
  const registered = new Map();
  // `AudioWorkletProcessor`'s only surface the processors use is `this.port`, and only
  // for the discrete-knob messages and the loud-error path.
  class StubProcessor {
    constructor() {
      this.port = { postMessage() {}, onmessage: null };
    }
  }
  const evaluate = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", source);
  evaluate(StubProcessor, (name, ctor) => registered.set(name, ctor), 48000);
  return registered;
}

/** Command. Run one quantum through a processor. `inputs` and `outputs` are counts. */
function runQuantum(processor, inputSignals, outputCount, parameters) {
  const inputs = inputSignals.map((signal) => [signal]);
  const outputs = Array.from({ length: outputCount }, () => [new Float32Array(AX1_QUANTUM)]);
  processor.process(inputs, outputs, parameters);
  return outputs.map((o) => o[0]);
}

/** A constant a-rate parameter, in the collapsed length-1 form Web Audio really
 *  hands a processor when the value did not change — the form that makes a naive
 *  `values[i]` read `undefined` on every sample but the first. */
const constantParam = (value) => new Float32Array([value]);

const WORKLET = loadWorkletProcessors();

check("the worklet registers every processor the factories ask for, under an ax1- prefix", () => {
  // `registerProcessor` names are global to the AudioContext and several R7 blocks are
  // adding worklet files, so the prefix is what keeps them from colliding.
  assert.equal(WORKLET.size, BLOCK_SPECS.length);
  for (const name of WORKLET.keys()) assert.ok(name.startsWith("ax1-"), `${name} is unprefixed`);
});

check("⚠ THE K-RATE BRIDGE: one 128-frame quantum is EIGHT control ticks, not one", () => {
  // The single most consequential thing in this whole block. A quantum holds 8 control
  // ticks, so it holds FOUR rising edges — an edge detector needs a low tick between
  // two highs, which is why the square wave below alternates per BLOCK rather than
  // pulsing every block. (The first draft of this check pulsed every block and
  // measured 1: correctly, because the sampling points were then all high and the
  // counter saw one continuous gate. The processor was right and the stimulus wrong.)
  //
  // A processor that hoisted its control work to once per quantum would count at most
  // ONE here, and everything downstream of it would run 8× slow with nothing logged.
  const Counter = WORKLET.get("ax1-counter");
  const counter = new Counter();
  const ticksPerQuantum = AX1_QUANTUM / AX_KRATE_BLOCK;
  assert.equal(ticksPerQuantum, 8);
  const trig = new Float32Array(AX1_QUANTUM);
  for (let i = 0; i < AX1_QUANTUM; i++) trig[i] = Math.floor(i / AX_KRATE_BLOCK) % 2 === 0 ? 1 : 0;
  const [count] = runQuantum(counter, [trig, new Float32Array(AX1_QUANTUM)], 2, {
    maximum: constantParam(1000),
  });
  // The count leaves on the wire in `frac32 → int32` units, so 4 arrives as 4/64.
  const finalCount = Math.round(count[AX1_QUANTUM - 1] * AX_DIAL_FULL_SCALE);
  assert.equal(finalCount, ticksPerQuantum / 2,
    `expected ${ticksPerQuantum / 2} edges from ${ticksPerQuantum} control ticks, the worklet counted ${finalCount}`);
});

check("every param a factory asks for is one its processor really declares", () => {
  // WITHOUT THIS, THE FAILURE IS BROWSER-ONLY. `applyParams` and `paramMap` throw on a
  // missing parameter, but only when a node is CONSTRUCTED — so a factory asking for
  // `v16` on a sixteen-step table reds nothing here, builds nothing in the palette,
  // and throws from a worklet constructor the first time someone places the node.
  // Reading `parameterDescriptors` off the class is free and moves that to the gate.
  for (const [moduleName, factory] of Object.entries(BLOCK_MODULE_FACTORIES)) {
    const declaration = factory.ax1Declaration;
    if (!declaration) continue;
    const Processor = WORKLET.get(declaration.processor);
    assert.ok(Processor, `${moduleName} names unregistered processor ${declaration.processor}`);
    const declared = new Set((Processor.parameterDescriptors ?? []).map((d) => d.name));
    for (const name of declaration.params) {
      assert.ok(declared.has(name), `${moduleName}: the factory asks for param ${name}, ${declaration.processor} does not declare it`);
    }
    // And the reverse: a processor param no factory exposes is unreachable from the
    // Inspector, which is a knob the author can never turn.
    for (const name of declared) {
      assert.ok(declaration.params.includes(name), `${declaration.processor} declares param ${name}, which ${moduleName} never exposes`);
    }
  }
});

check("the worklet's math matches synth/ax1_dsp.js, operation by operation", () => {
  // The restatement pin. Every non-stateful operation, over a sweep, through the real
  // processor — so a recurrence that is right in one file and wrong in the other reds
  // here instead of shipping.
  const Math_ = WORKLET.get("ax1-math");
  const bValue = 0.75;
  const signal = new Float32Array(AX1_QUANTUM);
  for (let i = 0; i < AX1_QUANTUM; i++) signal[i] = -1.5 + (3 * i) / (AX1_QUANTUM - 1);

  let worst = 0;
  for (const name of AX_MATH_OP_NAMES) {
    if (AX_MATH_OPS[name].stateful) continue; // ringModAntialiased: checked below
    const processor = new Math_();
    processor.operation = name;
    const [out] = runQuantum(processor, [signal], 1, { b: constantParam(bValue) });
    for (let i = 0; i < AX1_QUANTUM; i++) {
      const expected = AX_MATH_OPS[name].unary
        ? AX_MATH_OPS[name].float(signal[i])
        : AX_MATH_OPS[name].float(signal[i], bValue);
      worst = Math.max(worst, Math.abs(out[i] - expected));
    }
  }
  // Float32Array storage is the only difference: the reference computes in binary64
  // and the output buffer is binary32, so a value near 1.5 rounds at ~1e-7.
  record("worklet", "ax1-math vs ax1_dsp", worst, 1e-6);
});

check("the antialiased ring modulator's worklet copy matches the reference, delay and all", () => {
  // THE ONE OPERATION THE INT-vs-FLOAT SWEEP CANNOT COVER — `tiar/math/DP STAR.axo` is
  // already float in the source, so there is no fixed-point side to measure against.
  // That would leave its worklet restatement UNVERIFIED, which is exactly the state
  // this suite exists to prevent, so it is checked against ax1_dsp.js instead.
  //
  // The one-sample delay is the substance: the operation averages the product ACROSS
  // the sample interval, so it needs the previous sample of both inputs. A copy that
  // dropped the history would still look like a ring modulator and would alias.
  const Math_ = WORKLET.get("ax1-math");
  const processor = new Math_();
  processor.operation = "ringModAntialiased";
  const bValue = 0.6;
  const signal = new Float32Array(AX1_QUANTUM);
  for (let i = 0; i < AX1_QUANTUM; i++) signal[i] = Math.sin((2 * Math.PI * 7 * i) / AX1_QUANTUM);
  const [out] = runQuantum(processor, [signal], 1, { b: constantParam(bValue) });

  const state = { x1: 0, y1: 0 };
  let worst = 0;
  for (let i = 0; i < AX1_QUANTUM; i++) {
    const expected = AX_MATH_OPS.ringModAntialiased.float(signal[i], bValue, state);
    state.x1 = signal[i];
    state.y1 = bValue;
    worst = Math.max(worst, Math.abs(out[i] - expected));
  }
  // It really did carry history — a stateless copy would match at sample 0 and drift,
  // so a bound alone could be met by a buffer of zeros. This says the output moved.
  assert.ok(Math.max(...out.map(Math.abs)) > 0.1, "the ring modulator emitted nothing to compare");
  record("worklet", "ax1-math ringMod (no int side)", worst, 1e-6);
});

check("the worklet's smoother matches the reference over many control ticks", () => {
  const Smooth = WORKLET.get("ax1-smooth");
  const processor = new Smooth();
  const dial = 32;
  const target = 1;
  const signal = new Float32Array(AX1_QUANTUM).fill(target);
  let reference = 0;
  let worst = 0;
  // 100 quanta = 800 control ticks = 267 ms, which is 6.25 time constants at dial 32
  // (τ ≈ 43 ms) and therefore past 0.998. Sized from the coefficient rather than
  // guessed: an earlier 40 quanta reached only 0.92 and the convergence guard below
  // caught it, which is what that guard is for.
  for (let q = 0; q < 100; q++) {
    const [out] = runQuantum(processor, [signal], 1, {
      time: constantParam(dial), enable: constantParam(1),
    });
    for (let block = 0; block < AX1_QUANTUM / AX_KRATE_BLOCK; block++) {
      reference += (target - reference) * axSmoothCoefficient(dial);
      worst = Math.max(worst, Math.abs(out[block * AX_KRATE_BLOCK] - reference));
    }
  }
  // It really did converge — a check that stayed at 0 would pass a processor that
  // emitted nothing at all.
  assert.ok(reference > 0.99, `the reference did not converge (${reference})`);
  record("worklet", "ax1-smooth, 800 ticks", worst, 1e-6);
});

check("the worklet's step tables index by bit and by 2-bit field, as the sources do", () => {
  const StepsBool = WORKLET.get("ax1-steps-bool");
  const processor = new StepsBool();
  // Walk the index 0…7 across the quantum's eight control ticks, on the wire in
  // `frac32 → int32` units.
  const index = new Float32Array(AX1_QUANTUM);
  for (let i = 0; i < AX1_QUANTUM; i++) index[i] = Math.floor(i / AX_KRATE_BLOCK) / AX_DIAL_FULL_SCALE;
  const mask = 0b10101010;
  const outs = runQuantum(processor, [index, new Float32Array(AX1_QUANTUM)], 5, {
    pulse: constantParam(0),
    p1: constantParam(mask), p2: constantParam(0), p3: constantParam(0), p4: constantParam(0),
  });
  for (let step = 0; step < 8; step++) {
    const got = outs[0][step * AX_KRATE_BLOCK];
    assert.equal(got, axStepBool(step, mask, false, -1, 0), `track 1 disagrees at step ${step}`);
  }
  // The chain outlet, which is what makes tables cascade past sixteen steps.
  assert.equal(Math.round(outs[4][0] * AX_DIAL_FULL_SCALE), -AX_STEP_COUNT);
});

check("the worklet's k→s ramp is the one-buffer-late one, inside a real quantum", () => {
  // Ported patches are tuned against this lag because gain/vca carries the identical
  // ramp. A processor that jumped straight to the new value would pass every other
  // check here and desynchronise every modulated gain.
  const Convert = WORKLET.get("ax1-convert");
  const processor = new Convert();
  processor.mode = "smoothStep";
  const [out] = runQuantum(processor, [new Float32Array(AX1_QUANTUM).fill(1)], 1, {});
  assert.equal(out[0], 0);
  assert.ok(Math.abs(out[1] - 0.0625) < 1e-6, `expected 0.0625 at sample 1, got ${out[1]}`);
  assert.ok(Math.abs(out[15] - 0.9375) < 1e-6, `expected 0.9375 at sample 15, got ${out[15]}`);
  // The SECOND control block has already arrived at 1.0 — the lag is one block, not
  // a permanent droop.
  assert.ok(Math.abs(out[16] - 1) < 1e-6, `expected 1 at sample 16, got ${out[16]}`);
});

check("the worklet's stereo out is a hard clip after the volume, on both channels", () => {
  const StereoOut = WORKLET.get("ax1-stereo-out");
  const processor = new StereoOut();
  const loud = new Float32Array(AX1_QUANTUM).fill(4);
  const quiet = new Float32Array(AX1_QUANTUM).fill(0.8);
  const outputs = [[new Float32Array(AX1_QUANTUM), new Float32Array(AX1_QUANTUM)]];
  processor.process([[loud], [quiet]], outputs, { volume: constantParam(0.5) });
  assert.equal(outputs[0][0][0], axStereoOutSample(4, 0.5));
  assert.ok(Math.abs(outputs[0][1][0] - axStereoOutSample(0.8, 0.5)) < 1e-6);
});

check("a disconnected input reads 0 rather than NaN — a NaN here poisons the graph", () => {
  // `process()` is still called on a node with nothing patched in. An unguarded read
  // of `inputs[0][0]` is `undefined`, arithmetic on it is NaN, and a NaN in a Web Audio
  // buffer silences that node permanently with nothing logged.
  const Math_ = WORKLET.get("ax1-math");
  const processor = new Math_();
  processor.operation = "add";
  const outputs = [[new Float32Array(AX1_QUANTUM)]];
  processor.process([[]], outputs, { b: constantParam(0.25) });
  assert.ok(Number.isFinite(outputs[0][0][0]), "a disconnected input produced a non-finite sample");
  assert.equal(outputs[0][0][0], 0.25);
});

// ── The report ──────────────────────────────────────────────────────────────

console.log("\n  AX-1 measured port error (max |float − integer source|)");
console.log("  " + "─".repeat(72));
for (const m of measured) {
  const lsbs = m.error / FRAC32_LSB;
  console.log(`  ${m.node.padEnd(16)} ${m.what.padEnd(30)} ${m.error.toExponential(2)}  (${lsbs.toFixed(1)} frac32 LSB)`);
}
console.log("  " + "─".repeat(72));
console.log(`  one frac32 LSB = ${FRAC32_LSB.toExponential(2)}; a wrong shift would read 1e-1 … 1e+1\n`);

console.log(`port_ax1_test: ${passed} checks passed`);
