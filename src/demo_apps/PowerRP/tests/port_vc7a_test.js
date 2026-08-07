/**
 * VC-7a PORT PROOF — twelve clocking and logic modules, MEASURED.
 * Run: node src/demo_apps/PowerRP/tests/port_vc7a_test.js
 *
 * ── WHAT A CLOCKING PORT CAN GET WRONG, AND HOW THIS FILE CATCHES IT ────────
 * These modules are float→float like VC-3b's, but nothing here is a filter, so a
 * magnitude response proves nothing. The failure modes are TIMING ones and this file is
 * shaped around the three that matter:
 *
 * 1. **A DIVIDER THAT IS ONE SAMPLE LATE.** A coefficient diff cannot see it and it is
 *    a real defect — eight of these run against each other in P25, so a one-sample
 *    error is a phase error that compounds. So the divider and the clock divider are
 *    checked against a TRANSCRIBED NUMERIC TRACE: `refFrequencyDivider` and
 *    `refClockDivider` below are independent re-writes of `inc/FrequencyDivider.hpp`
 *    and `ClockDivider::process` driven line by line, and the assertion is that every
 *    EDGE TIME matches, sample for sample, not that some summary statistic agrees.
 * 2. **A DIVISION THAT IS OFF BY ONE.** Separately from the phase: the whole point of
 *    VCFrequencyDividerMkII is that its output is exactly `f/N`, so the ratio is
 *    MEASURED from a rendered square wave for every N it accepts.
 * 3. **A SPEC THAT DESCRIBES A MODULE THE ENGINE DOES NOT HAVE.** Twelve modules with
 *    198 knobs and 96 ports between them is far past what anyone checks by reading, so
 *    the roster, the specs and the plugin barrel are swept against each other
 *    exhaustively — every declared knob is a real AudioParam with the same range, every
 *    declared port is a real port, and every derivation index names a real kernel class
 *    and a deviation the kernels file really defines.
 *
 * ── IT TESTS THE SHIPPED KERNELS, NOT A COPY ────────────────────────────────
 * `synth/vc7a_kernels.js` is the ONE copy of the arithmetic and this file imports it.
 * The processors and the module factories are one call into it per sample, and
 * `runKernel` below is the processor's own loop, so a check here is a check on what
 * ships.
 *
 * WHAT THIS FILE DOES NOT PROVE: that any of it sounds right. It proves the timing
 * matches the original's to the tolerances quoted per check, and that the spec, the
 * roster and the plugin barrel agree about what exists.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as K from "../synth/vc7a_kernels.js";
import {
  gateSequencerStepKeys, numberedKeys, portInputScale, portOutputScale, VC7A_PROCESSORS,
} from "../synth/worklets/processors_vc7a.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES, vc7aConstructOptions } from "../synth/modules_vc7a.js";
import {
  BLOCK_SPECS, COUNTMODULA_SOURCE, gateSequencerSteps, IMPROMPTU_SOURCE, numbered,
} from "../core/audio_specs_vc7a.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_vc7a.js";
import { audioKnobRows, audioNodePlugin } from "../core/audio_nodes.js";
import { NODE_FAMILY_NAMES } from "../core/node_chrome.js";
import { declaredPorts, PORT_TYPE_NAMES } from "../core/nodeflow.js";

const here = dirname(fileURLToPath(import.meta.url));
const KERNEL_SOURCE = readFileSync(join(here, "../synth/vc7a_kernels.js"), "utf8");

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/** Rack's own rate, and the rate every reference number below is quoted at. */
const FS = 48000;

/** A gate on the wire, per R7-UNITS clause 4 — 0…1, which the processor turns into
 *  5 V on the way in. Every `wire` function below emits this, not volts. */
const WIRE_HIGH = 1;

// ═══════════════════════════════════════════════════════════════════════════
// THE HARNESS — a bare-node stand-in for worklets/processors_vc7a.js
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Command. Run one roster row's kernel for `samples` samples, exactly as the processor
 * does: knobs from AudioParam defaults (overridable), inputs scaled by the row's own
 * `portInputScale`, `control()` every `row.controlSteps` samples, outputs scaled by
 * `portOutputScale`.
 *
 * A stand-in and NOT a copy of behaviour: everything it does is the processor's loop,
 * and the whole point is that the loop is the only thing the processor adds. It reads
 * BOTH scale functions from the shipped file rather than restating them, so a port that
 * changed kind changes this file's arithmetic with it.
 *
 * @param {object} row - a VC7A_PROCESSORS entry
 * @param {object} [opts] - `{samples, wire, knobs, construct}`. `wire` maps a port key
 *   to `(i) => wireValue`; a port absent from it is UNWIRED, which is the distinction
 *   ten of these twelve branch on (kernels' D3).
 * @returns {Float64Array[]} one array per output, on the wire scale
 */
function runKernel(row, opts = {}) {
  const { samples = 4096, wire = {}, knobs: overrides = {}, construct = {} } = opts;
  const kernel = row.make(FS, vc7aConstructOptions(row.construct, construct));
  const knobs = {};
  for (const p of row.params) knobs[p.name] = overrides[p.name] !== undefined ? overrides[p.name] : p.defaultValue;
  const signals = {};
  const wired = {};
  for (const key of row.audioInputs) {
    signals[key] = 0;
    wired[key] = wire[key] !== undefined;
  }
  const frame = new Float64Array(row.outputs.length);
  const out = row.outputs.map(() => new Float64Array(samples));
  let tick = 0;
  for (let i = 0; i < samples; i++) {
    for (const key of row.audioInputs) {
      signals[key] = wired[key] ? wire[key](i) * portInputScale(row, key) : 0;
    }
    if (tick === 0) kernel.control(knobs, signals, wired);
    kernel.sample(knobs, signals, wired, frame);
    for (let o = 0; o < row.outputs.length; o++) out[o][i] = frame[o] * portOutputScale(row, row.outputs[o]);
    tick = tick + 1 >= row.controlSteps ? 0 : tick + 1;
  }
  return out;
}

/** Query. One roster row by module name — LOUD if the name is not there, because a
 *  silently absent row would make every check on it vacuously pass. */
function rowOf(module) {
  const row = VC7A_PROCESSORS.find((r) => r.module === module);
  if (!row) throw new Error(`no VC7A_PROCESSORS row for ${JSON.stringify(module)}`);
  return row;
}

/** Query. The index of an output port on a row. */
function outputIndex(row, port) {
  const index = row.outputs.indexOf(port);
  if (index < 0) throw new Error(`${row.module} has no output ${JSON.stringify(port)}`);
  return index;
}

/**
 * Pure function. A square wave on the WIRE scale, 0…1, with period `period` samples
 * and a 50% duty cycle — the clock every timing check below is driven with.
 *
 * @param {number} period - samples per cycle
 * @returns {function(number): number}
 *
 * @example squareWire(4)(0) // 1
 * @example squareWire(4)(2) // 0
 * @example squareWire(4)(4) // 1
 */
function squareWire(period) {
  return (i) => (i % period < period / 2 ? WIRE_HIGH : 0);
}

/**
 * Pure function. The sample indices at which a signal crosses from low to high —
 * "edge times", which is the quantity a divider is right or wrong about.
 *
 * @param {Float64Array} signal
 * @param {number} [threshold]
 * @returns {number[]}
 *
 * @example risingEdges(Float64Array.from([0, 1, 1, 0, 1])) // [1, 4]
 * @example risingEdges(Float64Array.from([1, 1, 0])) // []
 */
function risingEdges(signal, threshold = 0.5) {
  const edges = [];
  for (let i = 1; i < signal.length; i++) {
    if (signal[i] > threshold && signal[i - 1] <= threshold) edges.push(i);
  }
  return edges;
}

/**
 * Pure function. The lengths of the INTERIOR high runs of a signal — the first and
 * last are dropped because a run's boundary truncates them, and an average that
 * includes a truncated pulse is how a correct 50-sample trigger measures as 51.6.
 *
 * @param {Float64Array} signal
 * @param {number} [threshold]
 * @returns {number[]}
 *
 * @example pulseWidths(Float64Array.from([0, 1, 0, 1, 1, 0, 1, 0])) // [1, 2, 1]
 * @example // a run that starts high drops that opening partial pulse
 * @example pulseWidths(Float64Array.from([1, 1, 0, 1, 0, 1, 1, 0])) // [1, 2]
 */
function pulseWidths(signal, threshold = 0.5) {
  const widths = [];
  let run = 0;
  let started = signal[0] > threshold;
  for (let i = 0; i < signal.length; i++) {
    if (signal[i] > threshold) run++;
    else {
      if (run > 0 && !started) widths.push(run);
      started = false;
      run = 0;
    }
  }
  return widths;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRANSCRIPTIONS OF THE C++ — the references every timing check diffs against
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure function. `Rack include/dsp/digital.hpp TSchmittTrigger<float>` and
 * `inc/GateProcessor.hpp GateProcessor::set`, transcribed as a STATE FUNCTION rather
 * than reused from the kernels — the point is to have a second, independently written
 * copy of the thresholds, so a drifted threshold is caught rather than shared.
 *
 * @param {{s: string, prev: boolean, cur: boolean}} state
 * @param {number} volts
 * @returns {{s: string, prev: boolean, cur: boolean}} the next state
 *
 * @example refGate({s: "U", prev: false, cur: false}, 10).cur // true
 * @example // 1.9 V is BELOW their 2 V high threshold and does not fire
 * @example refGate({s: "LOW", prev: false, cur: false}, 1.9).cur // false
 * @example // …and once high, 0.2 V is above the 0.1 V low threshold, so it stays high
 * @example refGate({s: "HIGH", prev: true, cur: true}, 0.2).cur // true
 */
function refGate(state, volts) {
  const x = 0 + ((volts - 0.1) / (2 - 0.1)) * (1 - 0);
  let s = state.s;
  if (s === "LOW" && x >= 1) s = "HIGH";
  else if (s === "HIGH" && x <= 0) s = "LOW";
  else if (s === "U" && x >= 1) s = "HIGH";
  else if (s === "U" && x <= 0) s = "LOW";
  return { s, prev: state.cur, cur: s === "HIGH" };
}

/**
 * Pure function. `inc/FrequencyDivider.hpp FrequencyDivider::process` transcribed —
 * the reference the ported divider's every edge is diffed against.
 *
 * @param {number[]} clockVolts - one voltage per sample
 * @param {number} n - the division
 * @returns {boolean[]} the phase at every sample
 *
 * @example refFrequencyDivider([0, 10, 0, 10], 1).join(",") // "false,true,false,true"
 * @example // N = 2 flips once per input CYCLE, i.e. every second edge
 * @example refFrequencyDivider([0, 10, 0, 10, 0, 10], 2).join(",") // "false,false,true,true,false,false"
 */
function refFrequencyDivider(clockVolts, n) {
  let gate = { s: "U", prev: false, cur: false };
  let count = 0;
  let phase = false;
  const out = [];
  for (const volts of clockVolts) {
    gate = refGate(gate, volts);
    if (gate.prev !== gate.cur) {
      count++;
      // COUNT_DN is the only mode either divider in this block uses.
      if (count >= n) count = 0;
      if (count === 0) phase = !phase;
    }
    out.push(phase);
  }
  return out;
}

/**
 * Pure function. `ClockDivider::process` transcribed for ONE output tap, in GATE mode
 * with the count running DOWN — the configuration every demo patch uses.
 *
 * @param {number[]} clockVolts
 * @param {number} mode - 0 Binary 1, 1 Binary 2, 2 Decimal, 3 Prime
 * @param {number} tap - 0…7
 * @returns {boolean[]} the tap's level at every sample
 *
 * @example // Binary 1 tap 0 is bit 1 of a down-counter, so it toggles every clock
 * @example refClockDivider([0, 10, 0, 10], 0, 0).join(",") // "true,true,true,false"
 */
function refClockDivider(clockVolts, mode, tap) {
  const maxCount = [512, 512, 362880, 9699690][mode];
  const mask = [
    [1, 2, 4, 8, 16, 32, 64, 128],
    [2, 4, 8, 16, 32, 64, 128, 256],
    [2, 3, 4, 5, 6, 7, 8, 9],
    [2, 3, 5, 7, 11, 13, 17, 19],
  ][mode][tap];
  let gate = { s: "U", prev: false, cur: false };
  let count = 512;
  let bit = false;
  const isReset = false;
  const out = [];
  for (const volts of clockVolts) {
    gate = refGate(gate, volts);
    if (gate.cur && !gate.prev) {
      if (--count < 1) count = maxCount;
    }
    if (isReset) bit = false;
    else if (mode === 0) bit = (count & mask) > 0;
    else bit = count % mask === 0;
    out.push(bit);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE SHARED MACHINERY — inc/*.hpp, which ten modules depend on
// ═══════════════════════════════════════════════════════════════════════════

check("GateProcessor matches the transcribed Schmitt at every sample", () => {
  const gp = new K.GateProcessor();
  let ref = { s: "U", prev: false, cur: false };
  // A ramp up through both thresholds, a hold, and a ramp back down through them —
  // so the hysteresis band is crossed in both directions.
  const volts = [];
  for (let v = 0; v <= 3; v += 0.05) volts.push(v);
  for (let v = 3; v >= -1; v -= 0.05) volts.push(v);
  volts.forEach((v, i) => {
    gp.set(v);
    ref = refGate(ref, v);
    assert.equal(gp.high(), ref.cur, `level at sample ${i}, ${v.toFixed(2)} V`);
    assert.equal(gp.leadingEdge(), ref.cur && !ref.prev, `leading edge at sample ${i}`);
    assert.equal(gp.trailingEdge(), ref.prev && !ref.cur, `trailing edge at sample ${i}`);
    assert.equal(gp.anyEdge(), ref.prev !== ref.cur, `any edge at sample ${i}`);
  });
});

check("GateProcessor fires between their two thresholds and nowhere else", () => {
  const rising = new K.GateProcessor();
  rising.set(0);
  assert.equal(rising.set(1.99), false, "1.99 V is below their 2 V high threshold");
  assert.equal(rising.set(2), true, "2 V is exactly the high threshold and fires");
  assert.equal(rising.set(0.11), true, "0.11 V is above the 0.1 V low threshold — still high");
  assert.equal(rising.set(0.1), false, "0.1 V is exactly the low threshold and releases");
});

check("UNINITIALIZED is not LOW — a clock parked high does not fire at t=0", () => {
  const gp = new K.GateProcessor();
  assert.equal(gp.set(10), true, "the level goes high");
  assert.equal(gp.leadingEdge(), true, "GateProcessor's own prev/cur DOES report the first edge");
  // The Rack trigger underneath is the one with the three-state guard, and it is what
  // Clkd and the Inverter depend on.
  const st = new K.SchmittTrigger();
  assert.equal(st.process(10), false, "an already-high first sample sets the state without firing");
  assert.equal(st.isHigh(), true);
  assert.equal(st.process(0), false);
  assert.equal(st.process(10), true, "the SECOND rise is a real trigger");
});

check("Inverter starts HIGH and uses Rack's default thresholds, not the gate's", () => {
  const inv = new K.Inverter();
  assert.equal(inv.isHigh, true, "their `bool isHigh = true`");
  // 1.5 V is BELOW GateProcessor's 2 V threshold but ABOVE Rack's default 1 V, so an
  // inverter reacts to a signal a gate inlet beside it would ignore.
  assert.equal(inv.process(1.5), 0, "1.5 V reads as high, so the inverter outputs 0 V");
  assert.equal(inv.process(0), K.GATE_HIGH_VOLTS, "0 V reads as low, so it outputs 10 V");
});

check("ClockOscillator's frequency is 2^pitch and its phase ceiling is theirs", () => {
  const osc = new K.ClockOscillator();
  osc.setPitch(3);
  // The oscillator STARTS at phase 0, i.e. already high, so a one-second run contains
  // eight cycles but only seven RISES — the eighth lands exactly on the boundary.
  // Measuring the period rather than the count is what makes that irrelevant.
  const rises = [];
  let previous = osc.high();
  for (let i = 0; i < FS * 2; i++) {
    osc.step(1 / FS);
    if (osc.high() && !previous) rises.push(i);
    previous = osc.high();
  }
  assert.equal(rises.length, 15, "pitch 3 is 2^3 = 8 Hz: sixteen cycles in two seconds, fifteen of them starting with a rise");
  assert.ok(Math.abs(rises[1] - rises[0] - FS / 8) <= 1, `the period is ${rises[1] - rises[0]} samples, expected ${FS / 8}`);
  const fast = new K.ClockOscillator();
  fast.setPitch(99);
  assert.equal(fast.freq, Math.pow(2, 10), "setPitch clamps the pitch at 10, not the frequency");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE DIVIDERS — edge times sample for sample, and measured ratios
// ═══════════════════════════════════════════════════════════════════════════

check("FrequencyDivider reproduces the transcribed C++ edge for edge, N = 1…21", () => {
  const period = 64;
  const samples = 4096;
  const clockVolts = [];
  for (let i = 0; i < samples; i++) clockVolts.push(squareWire(period)(i) * K.RACK_VOLTS_PER_UNIT);
  for (let n = 1; n <= 21; n++) {
    const reference = refFrequencyDivider(clockVolts, n);
    const divider = new K.FrequencyDivider();
    divider.setMaxN(21);
    divider.setCountMode(K.COUNT_DN);
    for (let i = 0; i < samples; i++) {
      divider.setN(n);
      const phase = divider.process(clockVolts[i]);
      assert.equal(phase, reference[i], `N=${n} disagrees at sample ${i}`);
    }
  }
});

check("VCFrequencyDividerMkII divides the input frequency by exactly N", () => {
  const row = rowOf("vcvVcFrequencyDividerMkII");
  const period = 96;
  const samples = 96 * 21 * 8;
  const inputCycles = samples / period;
  for (const n of [1, 2, 3, 5, 8, 13, 21]) {
    const [divb] = runKernel(row, { samples, knobs: { divide: n }, wire: { div: squareWire(period) } });
    const edges = risingEdges(divb, 0);
    // Each output CYCLE is N input cycles, so the count is inputCycles/N to within the
    // one edge the run's boundary can cut off.
    const expected = inputCycles / n;
    assert.ok(Math.abs(edges.length - expected) <= 1, `N=${n}: ${edges.length} output cycles, expected about ${expected}`);
    // And the spacing is EXACT, which is the phase-lock claim P25 rests on.
    for (let i = 1; i < edges.length; i++) {
      assert.equal(edges[i] - edges[i - 1], period * n, `N=${n}: edge ${i} is not exactly N input periods after the last`);
    }
  }
});

check("VCFrequencyDividerMkII's two outputs are bipolar and unipolar on our wire", () => {
  const row = rowOf("vcvVcFrequencyDividerMkII");
  const [divb, divu] = runKernel(row, { samples: 512, knobs: { divide: 2 }, wire: { div: squareWire(64) } });
  const bi = new Set(Array.from(divb));
  const uni = new Set(Array.from(divu));
  assert.deepEqual([...bi].sort((a, b) => a - b), [-1, 1], "divb is boolToAudio's ±5 V, i.e. ±1 here");
  assert.deepEqual([...uni].sort((a, b) => a - b), [0, 2], "divu is boolToGate's 0…10 V, i.e. 0…2 here");
});

check("VCFrequencyDividerMkII's CV adds to the knob and truncates toward zero", () => {
  const row = rowOf("vcvVcFrequencyDividerMkII");
  const period = 64;
  const samples = period * 64;
  // divide 1 + cvAmount 2 × 1.9 V = 4.8, truncated to 4.
  const [divb] = runKernel(row, {
    samples,
    knobs: { divide: 1, cvAmount: 2 },
    wire: { div: squareWire(period), cv: () => 1.9 / K.RACK_VOLTS_PER_UNIT },
  });
  const edges = risingEdges(divb, 0);
  assert.ok(edges.length >= 2, "the divider produced no cycles at all");
  assert.equal(edges[1] - edges[0], period * 4, "1 + trunc(2 × 1.9) = 4, so the period is 4× the input's");
});

check("legacy mode counts leading edges only, so it divides by twice as much", () => {
  const row = rowOf("vcvVcFrequencyDividerMkII");
  const period = 64;
  const samples = period * 96;
  // Legacy knob 3 indexes LEGACY_CV_MAP[2] = 1.25 V, which setN scales by maxN/10 = 2
  // and truncates: N = trunc(1.25 × 2) = 2. Counting leading edges only makes that a
  // division by 4 of the input frequency.
  const [divb] = runKernel(row, { samples, knobs: { divide: 3, legacy: 1 }, wire: { div: squareWire(period) } });
  const edges = risingEdges(divb, 0);
  assert.ok(edges.length >= 2, "legacy mode produced no cycles");
  assert.equal(edges[1] - edges[0], period * 4, "legacy N=2 on leading edges only is a division by 4");
});

check("ClockDivider reproduces the transcribed C++ tap for tap, all four modes", () => {
  const row = rowOf("vcvClockDivider");
  const period = 32;
  const samples = 32 * 64;
  const clockVolts = [];
  for (let i = 0; i < samples; i++) clockVolts.push(squareWire(period)(i) * K.RACK_VOLTS_PER_UNIT);
  for (let mode = 0; mode < 4; mode++) {
    const outs = runKernel(row, { samples, knobs: { mode }, wire: { clock: squareWire(period) } });
    for (let tap = 0; tap < 8; tap++) {
      const reference = refClockDivider(clockVolts, mode, tap);
      for (let i = 0; i < samples; i++) {
        assert.equal(outs[tap][i] > 0.5, reference[i], `mode ${mode} tap ${tap} disagrees at sample ${i}`);
      }
    }
  }
});

check("ClockDivider's trigger mode keeps the divisions and shortens the pulses", () => {
  const row = rowOf("vcvClockDivider");
  const period = 64;
  const samples = period * 64;
  const gates = runKernel(row, { samples, knobs: { trig: 0 }, wire: { clock: squareWire(period) } });
  const trigs = runKernel(row, { samples, knobs: { trig: 1 }, wire: { clock: squareWire(period) } });
  const gateEdges = risingEdges(gates[0]);
  const trigEdges = risingEdges(trigs[0]);
  assert.deepEqual(trigEdges, gateEdges, "the DIVISIONS are identical — only the shape changes");
  const gateHigh = Array.from(gates[0]).filter((v) => v > 0.5).length;
  const trigHigh = Array.from(trigs[0]).filter((v) => v > 0.5).length;
  assert.ok(trigHigh < gateHigh, `a 1 ms trigger (${trigHigh} samples high) is shorter than a gate (${gateHigh})`);
  // 50 samples, MEASURED: the sample the bit rises is driven high directly and the
  // PulseGenerator then returns true for a further 49 — 1 ms at 48 kHz is 48 samples,
  // plus the one on which `remaining` reaches zero. So 1.04 ms, and EVERY pulse is
  // that width, not merely the average of them.
  const widths = pulseWidths(trigs[0]);
  assert.ok(widths.length > 4, "not enough triggers to measure");
  for (const width of widths) assert.equal(width, K.PULSE_SECONDS * FS + 2, "a trigger of the wrong width");
});

check("ClockDivider's reset holds every tap low and re-seeds the counter", () => {
  const row = rowOf("vcvClockDivider");
  const period = 64;
  const samples = period * 64;
  const resetAt = period * 20;
  const outs = runKernel(row, {
    samples,
    wire: { clock: squareWire(period), reset: (i) => (i >= resetAt && i < resetAt + 16 ? WIRE_HIGH : 0) },
  });
  for (let tap = 0; tap < 8; tap++) {
    assert.equal(outs[tap][resetAt], 0, `tap ${tap} must be held low on the reset's own sample`);
  }
  // …and the counter is re-seeded, so the pattern from the reset repeats the pattern
  // from the start. THE OFFSET IS ONE SAMPLE and that is theirs: `gpClock` is only
  // stepped in the `else` branch, so a clock edge coincident with a reset is seen one
  // sample later rather than being lost.
  for (let i = 0; i < period * 8; i++) {
    assert.equal(outs[0][resetAt + 1 + i], outs[0][1 + i], `tap 0 diverges from its own start ${i} samples after the reset`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Clkd — the master/sub phase lock, which is the reason this module exists
// ═══════════════════════════════════════════════════════════════════════════

check("clkdRatioDoubled indexes their 35-entry table, doubled and signed", () => {
  assert.equal(K.clkdRatioDoubled(0), 2, "index 0 is ×1");
  assert.equal(K.clkdRatioDoubled(1), 3, "index 1 is ×1.5, doubled to 3 — the parity carries the half");
  assert.equal(K.clkdRatioDoubled(5), 8, "index 5 is ×4");
  assert.equal(K.clkdRatioDoubled(-9), -16, "index −9 is ÷8");
  assert.equal(K.clkdRatioDoubled(-5), -8, "index −5 is ÷4");
  assert.equal(K.clkdRatioDoubled(34), 192, "the last entry is 96");
  assert.equal(K.clkdRatioDoubled(1000), 192, "past the end it saturates rather than reading off the array");
});

check("Clkd's master clock runs at the BPM knob", () => {
  const row = rowOf("vcvClkd");
  const seconds = 4;
  const bpm = 120;
  const [master] = runKernel(row, { samples: FS * seconds, knobs: { bpm } });
  const edges = risingEdges(master);
  // 120 BPM is two beats a second; the first edge is at t=0 and is not a RISE.
  assert.ok(Math.abs(edges.length - (bpm / 60) * seconds) <= 1, `${edges.length} beats in ${seconds}s at ${bpm} BPM`);
  const period = edges[1] - edges[0];
  assert.ok(Math.abs(period - FS * (60 / bpm)) <= 1, `the master period is ${period} samples, expected ${FS * (60 / bpm)}`);
});

check("Clkd's sub-clocks are exact ratios of the master and stay phase-locked", () => {
  const row = rowOf("vcvClkd");
  const seconds = 8;
  const bpm = 120;
  // Their own stub values: ×4, ÷8, ÷4.
  const outs = runKernel(row, { samples: FS * seconds, knobs: { bpm, ratio_1: 5, ratio_2: -9, ratio_3: -5 } });
  const master = risingEdges(outs[outputIndex(row, "clk_1")]);
  const beats = (bpm / 60) * seconds;
  const cases = [["clk_2", 4], ["clk_3", 1 / 8], ["clk_4", 1 / 4]];
  for (const [port, ratio] of cases) {
    const edges = risingEdges(outs[outputIndex(row, port)]);
    const expected = beats * ratio;
    assert.ok(Math.abs(edges.length - expected) <= 1, `${port} produced ${edges.length} edges, expected about ${expected}`);
  }
  // THE PHASE LOCK: every ÷4 edge lands on a master edge (within one sample), which is
  // the claim a free-running divider cannot make.
  const quarter = risingEdges(outs[outputIndex(row, "clk_4")]);
  for (const edge of quarter) {
    const nearest = master.reduce((best, m) => (Math.abs(m - edge) < Math.abs(best - edge) ? m : best), master[0]);
    assert.ok(Math.abs(nearest - edge) <= 1, `a ÷4 edge at ${edge} is ${Math.abs(nearest - edge)} samples off the master`);
  }
});

check("Clkd's trigger mode shortens an output to 1 ms without moving it", () => {
  const row = rowOf("vcvClkd");
  const samples = FS * 4;
  const gates = runKernel(row, { samples, knobs: { bpm: 120 } });
  const trigs = runKernel(row, { samples, knobs: { bpm: 120, trigOut1: 1 } });
  const index = outputIndex(row, "clk_1");
  assert.deepEqual(risingEdges(trigs[index]), risingEdges(gates[index]), "the beat times are unchanged");
  // 48 samples, MEASURED. `isHigh()` is high while `step <= 0.001` and `stepClock()`
  // advances `step` by `sampleTime` afterwards, so the naive count is 49 — but `step`
  // ACCUMULATES `1/48000`, which is not exact in binary, and by the 49th sample the sum
  // has drifted microscopically past 0.001. Their `double step` accumulates identically,
  // so 48 is the original's own answer rather than a rounding we introduced. Measured
  // per pulse, not averaged — a truncated pulse at either end would skew a mean.
  const widths = pulseWidths(trigs[index]);
  assert.ok(widths.length >= 4, "not enough beats to measure");
  for (const width of widths) assert.equal(width, 0.001 * FS, "a Clkd trigger of the wrong width");
});

check("Clkd's BPM inlet carries BPM and its outlet answers in the same unit (D9)", () => {
  const row = rowOf("vcvClkd");
  assert.ok(row.rawPorts.includes("bpm_cv") && row.rawPorts.includes("bpm"), "both are raw ports, so neither is scaled by five");
  const seconds = 4;
  const wanted = 90;
  const outs = runKernel(row, { samples: FS * seconds, wire: { bpm_cv: () => wanted } });
  const edges = risingEdges(outs[outputIndex(row, "clk_1")]);
  assert.ok(Math.abs(edges.length - (wanted / 60) * seconds) <= 1, `the inlet's ${wanted} was read as BPM`);
  const bpmOut = outs[outputIndex(row, "bpm")];
  assert.ok(Math.abs(bpmOut[bpmOut.length - 1] - wanted) < 1e-9, "with `forceCvOnBpmOut` off the inlet passes straight through");
  const own = runKernel(row, { samples: 256, knobs: { bpm: 96 } });
  const ownOut = own[outputIndex(row, "bpm")];
  assert.ok(Math.abs(ownOut[ownOut.length - 1] - 96) < 1e-9, "unpatched, the outlet reports this module's own tempo IN BPM");
});

check("Clkd's run knob acts on its CHANGE, as their momentary button does (D5)", () => {
  const row = rowOf("vcvClkd");
  const running = runKernel(row, { samples: FS, knobs: { bpm: 120 } });
  assert.ok(risingEdges(running[0]).length >= 1, "it runs by default, which is their `onReset`");
  const kernel = row.make(FS, {});
  const knobs = {};
  for (const p of row.params) knobs[p.name] = p.defaultValue;
  const signals = { reset: 0, run: 0, bpm_cv: 0 };
  const wired = { reset: false, run: false, bpm_cv: false };
  const frame = new Float64Array(row.outputs.length);
  kernel.control(knobs, signals, wired);
  kernel.sample(knobs, signals, wired, frame);
  assert.equal(kernel.running, true);
  knobs.running = 0;
  kernel.sample(knobs, signals, wired, frame);
  assert.equal(kernel.running, false, "moving the knob toggled the transport");
  kernel.sample(knobs, signals, wired, frame);
  assert.equal(kernel.running, false, "holding it there does not toggle again — it is an edge, not a level");
});

check("clkdSnapPpqn only ever produces a value their menu can reach", () => {
  for (let v = -5; v <= 30; v += 0.5) {
    assert.ok(K.CLKD_PPQN_VALUES.includes(K.clkdSnapPpqn(v)), `${v} snapped off the menu`);
  }
  assert.equal(K.clkdSnapPpqn(5), 4);
  assert.equal(K.clkdSnapPpqn(7), 8);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE LOGIC AND SEQUENCING MODULES
// ═══════════════════════════════════════════════════════════════════════════

check("BooleanAND normals B→A, C→B, D→C, and is silent without A", () => {
  const row = rowOf("vcvBooleanAnd");
  const high = () => WIRE_HIGH;
  const low = () => 0;
  const andIndex = outputIndex(row, "and");
  const invIndex = outputIndex(row, "inv");
  const last = (out) => out[andIndex][out[andIndex].length - 1];
  const lastInv = (out) => out[invIndex][out[invIndex].length - 1];

  assert.equal(last(runKernel(row, { samples: 64, wire: { a: high } })), 1, "A alone is a BUFFER — B, C and D follow it");
  assert.equal(last(runKernel(row, { samples: 64, wire: { a: high, b: low } })), 0, "a patched LOW B breaks the chain");
  assert.equal(last(runKernel(row, { samples: 64, wire: { a: high, b: high, d: low } })), 0, "D is patched low even though C follows B");
  assert.equal(last(runKernel(row, { samples: 64, wire: { b: high, c: high } })), 0, "with A unpatched the AND is 0 V whatever else is");
  assert.equal(lastInv(runKernel(row, { samples: 64 })), 1, "with A and I unpatched the inverter output is their bare 10 V");
  assert.equal(lastInv(runKernel(row, { samples: 64, wire: { a: high } })), 0, "the inverter is normalled to the AND, so this is NAND");
  assert.equal(lastInv(runKernel(row, { samples: 64, wire: { a: high, i: low } })), 1, "a patched I overrides that normal");
});

check("BooleanXOR is odd-parity by default and one-hot on the switch", () => {
  const row = rowOf("vcvBooleanXor");
  const high = () => WIRE_HIGH;
  const xor = outputIndex(row, "xor");
  const last = (opts) => {
    const out = runKernel(row, { samples: 64, ...opts });
    return out[xor][out[xor].length - 1];
  };
  assert.equal(last({ wire: { a: high } }), 1, "one input high: odd, so high");
  assert.equal(last({ wire: { a: high, b: high } }), 0, "two high: even, so low");
  assert.equal(last({ wire: { a: high, b: high, c: high } }), 1, "three high: odd again");
  assert.equal(last({ wire: { a: high, b: high, c: high, d: high } }), 0, "four high: even");
  assert.equal(last({ knobs: { mode: 1 }, wire: { a: high } }), 1, "one-hot: exactly one is high");
  assert.equal(last({ knobs: { mode: 1 }, wire: { a: high, b: high, c: high } }), 0, "one-hot: three is not one");
  assert.equal(last({ wire: { b: high, c: high, d: high } }), 0, "A unpatched silences it entirely");
});

check("BooleanXOR does NOT normal its inputs, unlike the AND", () => {
  const row = rowOf("vcvBooleanXor");
  const xor = outputIndex(row, "xor");
  const out = runKernel(row, { samples: 64, wire: { a: () => WIRE_HIGH } });
  assert.equal(out[xor][out[xor].length - 1], 1, "an unpatched B reads 0 V rather than following A — otherwise this would be even and low");
});

check("BusRoute2 ORs its enabled channels onto two independent buses", () => {
  const row = rowOf("vcvBusRoute2");
  const high = () => WIRE_HIGH;
  const a = outputIndex(row, "a");
  const b = outputIndex(row, "b");
  const last = (opts) => {
    const out = runKernel(row, { samples: 64, ...opts });
    return [out[a][out[a].length - 1], out[b][out[b].length - 1]];
  };
  assert.deepEqual(last({ knobs: { busA1: 1 }, wire: { gate1: high } }), [1, 0], "channel 1 routed to A only");
  assert.deepEqual(last({ knobs: { busA1: 1, busB2: 1 }, wire: { gate1: high, gate2: high } }), [1, 1], "two channels, two buses");
  assert.deepEqual(last({ knobs: { busA1: 1, busA3: 1 }, wire: { gate3: high } }), [1, 0], "a WIRED OR — channel 3 alone raises A");
  assert.deepEqual(last({ knobs: { busA1: 1, busB1: 1 }, wire: { gate1: high } }), [1, 1], "one channel may feed both");
  assert.deepEqual(last({ knobs: { busA1: 1 } }), [0, 0], "an unpatched channel never contributes");
});

check("SampleAndHold's three modes, and the mode CV that overrides the knob", () => {
  const row = rowOf("vcvSampleAndHold");
  const period = 64;
  const samples = period * 8;
  const sampleIndex = outputIndex(row, "sample");
  const invIndex = outputIndex(row, "inv");
  // A RAMP, not a staircase: a staircase is constant across a clock period, so it
  // cannot tell SAMPLE (which freezes at the edge) from TRACK (which follows).
  const ramp = (i) => i / samples;
  const clock = squareWire(period);
  const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, `${why} — got ${a}, expected ${b}`);

  // Sample 200 is inside the HIGH half of period 3, whose rising edge was at 192.
  const high = period * 3 + 8;
  // Sample 240 is inside the LOW half of that same period, which began at 224.
  const low = period * 3 + 48;

  const held = runKernel(row, { samples, knobs: { mode: K.SH_SAMPLE }, wire: { sample: ramp, trig: clock } });
  near(held[sampleIndex][high], ramp(period * 3), "SAMPLE froze at the rising edge and does not follow");
  near(held[sampleIndex][low], ramp(period * 3), "…and still holds it through the low half");
  near(held[invIndex][high], -ramp(period * 3), "the inv outlet is the negation");

  const tracked = runKernel(row, { samples, knobs: { mode: K.SH_TRACK }, wire: { sample: ramp, trig: clock } });
  near(tracked[sampleIndex][high], ramp(high), "TRACK follows while the gate is HIGH");
  near(tracked[sampleIndex][low], ramp(period * 3 + period / 2 - 1), "…and holds the last high-half value once it falls");

  const passing = runKernel(row, { samples, knobs: { mode: K.SH_PASS }, wire: { sample: ramp, trig: clock } });
  near(passing[sampleIndex][low], ramp(low), "PASS follows while the gate is LOW — the mirror of TRACK");
  near(passing[sampleIndex][high], ramp(period * 3 - 1), "…and holds through the high half");

  // The CV overrides the knob: 4 V picks PASS even with the knob on SAMPLE.
  const overridden = runKernel(row, {
    samples,
    knobs: { mode: K.SH_SAMPLE },
    wire: { sample: ramp, trig: clock, mode_cv: () => 4 / K.RACK_VOLTS_PER_UNIT },
  });
  near(overridden[sampleIndex][low], ramp(low), "4 V selected PASS, overriding the knob's SAMPLE");
});

check("sampleHoldModeFromCv cuts 0…5 V into their three two-volt bands", () => {
  assert.equal(K.sampleHoldModeFromCv(0), K.SH_SAMPLE);
  assert.equal(K.sampleHoldModeFromCv(1.99), K.SH_SAMPLE);
  assert.equal(K.sampleHoldModeFromCv(2), K.SH_TRACK);
  assert.equal(K.sampleHoldModeFromCv(3.99), K.SH_TRACK);
  assert.equal(K.sampleHoldModeFromCv(4), K.SH_PASS);
  assert.equal(K.sampleHoldModeFromCv(99), K.SH_PASS, "clamped, not wrapped");
});

check("SampleAndHold2 does nothing without a trigger, and is a random source without a signal", () => {
  const row = rowOf("vcvSampleAndHold2");
  const out = outputIndex(row, "sample");
  const idle = runKernel(row, { samples: 512, wire: { sample: () => 0.5 } });
  assert.ok(Array.from(idle[out]).every((v) => v === 0), "no trigger patched: the whole body is skipped");

  const random = runKernel(row, { samples: 64 * 16, wire: { trig: squareWire(64) } });
  const values = new Set(Array.from(random[out]));
  assert.ok(values.size > 4, `an unpatched signal inlet gives a NEW random value per trigger, saw ${values.size} distinct`);
  for (const v of values) assert.ok(Math.abs(v) <= 1.001, `a random sample of ${v} is outside their ±5 V`);
});

check("SampleAndHold2 is deterministic under its seed, and different across seeds", () => {
  const row = rowOf("vcvSampleAndHold2");
  const opts = { samples: 64 * 32, wire: { trig: squareWire(64) } };
  const a = runKernel(row, { ...opts, construct: { seed: 7 } })[0];
  const b = runKernel(row, { ...opts, construct: { seed: 7 } })[0];
  const c = runKernel(row, { ...opts, construct: { seed: 8 } })[0];
  assert.deepEqual(Array.from(a), Array.from(b), "same seed, byte-identical — the determinism law");
  assert.notDeepEqual(Array.from(a), Array.from(c), "a different seed is a different sequence");
});

check("SampleAndHold2's probability holds the previous value instead of skipping a beat", () => {
  const row = rowOf("vcvSampleAndHold2");
  const out = outputIndex(row, "sample");
  const period = 64;
  const samples = period * 64;
  const staircase = (i) => Math.floor(i / period) / 100;
  const opts = { samples, wire: { sample: staircase, trig: squareWire(period) } };
  const always = runKernel(row, { ...opts, knobs: { prob: 1 } })[out];
  const never = runKernel(row, { ...opts, knobs: { prob: 0 } })[out];
  const sometimes = runKernel(row, { ...opts, knobs: { prob: 0.5 }, construct: { seed: 3 } })[out];
  const distinct = (a) => new Set(Array.from(a)).size;
  assert.ok(distinct(always) > 20, "probability 1 takes every sample");
  assert.equal(distinct(never), 1, "probability 0 never samples at all, so the output never moves");
  assert.ok(distinct(sometimes) > 1 && distinct(sometimes) < distinct(always), "probability 0.5 lands between the two");
});

check("SampleAndHold2's offset inlet is normalled to 10 V, so the knob alone shifts ±10 V", () => {
  const row = rowOf("vcvSampleAndHold2");
  const out = outputIndex(row, "sample");
  const period = 64;
  const held = runKernel(row, {
    samples: period * 8,
    knobs: { offset: 0.5, level: 0 },
    wire: { sample: () => 0, trig: squareWire(period) },
  })[out];
  // level 0 kills the signal, so the output is the offset alone: 0.5 × 10 V = 5 V = 1.0.
  assert.ok(Math.abs(held[period * 4] - 1) < 1e-9, `the unpatched offset normal gave ${held[period * 4]}, expected 1`);
});

check("BurstGenerator emits exactly N pulses per trigger", () => {
  const row = rowOf("vcvBurstGenerator");
  const pulsesIndex = outputIndex(row, "pulses");
  const durationIndex = outputIndex(row, "duration");
  const clockPeriod = 128;
  const samples = clockPeriod * 64;
  for (const n of [1, 3, 8, 16]) {
    const outs = runKernel(row, {
      samples,
      knobs: { pulses: n },
      // ONE trigger at sample 64, and an external clock so the count is countable.
      wire: { trigger: (i) => (i >= 64 && i < 96 ? WIRE_HIGH : 0), clock: squareWire(clockPeriod) },
    });
    assert.equal(risingEdges(outs[pulsesIndex]).length, n, `pulses=${n} produced the wrong count`);
    assert.equal(risingEdges(outs[durationIndex]).length, 1, "the duration gate rises exactly once per burst");
  }
});

check("BurstGenerator marks the burst's two boundaries with 1 ms pulses", () => {
  const row = rowOf("vcvBurstGenerator");
  const clockPeriod = 128;
  const outs = runKernel(row, {
    samples: clockPeriod * 64,
    knobs: { pulses: 4 },
    wire: { trigger: (i) => (i >= 64 && i < 96 ? WIRE_HIGH : 0), clock: squareWire(clockPeriod) },
  });
  const start = risingEdges(outs[outputIndex(row, "start")]);
  const end = risingEdges(outs[outputIndex(row, "end")]);
  assert.equal(start.length, 1, "one start marker");
  assert.equal(end.length, 1, "one end marker");
  assert.ok(end[0] > start[0], "the end follows the start");
  const duration = outs[outputIndex(row, "duration")];
  const high = Array.from(duration).filter((v) => v > 0.5).length;
  assert.ok(Math.abs(end[0] - start[0] - high) <= 2, "the two markers bracket the duration gate");
});

check("BurstGenerator's internal clock runs at 2^rate and the inlet disconnects it", () => {
  const row = rowOf("vcvBurstGenerator");
  const seconds = 4;
  const rate = 3;
  const outs = runKernel(row, {
    samples: FS * seconds,
    knobs: { pulses: 16, rate },
    wire: { trigger: (i) => (i >= 64 && i < 96 ? WIRE_HIGH : 0) },
  });
  const pulses = risingEdges(outs[outputIndex(row, "pulses")]);
  assert.equal(pulses.length, 16, "sixteen pulses off the internal clock");
  const gap = pulses[1] - pulses[0];
  assert.ok(Math.abs(gap - FS / Math.pow(2, rate)) <= 2, `the internal clock's period is ${gap}, expected ${FS / 2 ** rate}`);
  assert.ok(pulses[0] <= 96, "THE FIRST PULSE LANDS ON THE TRIGGER — the clock's phase is reset by it");
});

check("EventTimer fires after exactly N clocks and then LATCHES", () => {
  const row = rowOf("vcvEventTimer");
  const period = 64;
  const samples = period * 64;
  const endIndex = outputIndex(row, "end");
  const endtIndex = outputIndex(row, "endt");
  for (const n of [1, 3, 12]) {
    const outs = runKernel(row, {
      samples,
      knobs: { length: n },
      wire: {
        trigger: (i) => (i >= 16 && i < 32 ? WIRE_HIGH : 0),
        clock: (i) => (i >= 64 ? squareWire(period)(i) : 0),
      },
    });
    const clockEdges = [];
    for (let i = 64; i < samples; i += period) clockEdges.push(i);
    const fired = risingEdges(outs[endtIndex]);
    assert.equal(fired.length, 1, `length=${n}: the end trigger fires exactly once, and never again — it latches`);
    assert.equal(fired[0], clockEdges[n - 1], `length=${n}: it fired on clock ${n}, not one early or late`);
    assert.equal(outs[endIndex][samples - 1], 1, "the end GATE stays high until a reset");
  }
});

check("EventTimer's reset unlatches it and rearms the count", () => {
  const row = rowOf("vcvEventTimer");
  const period = 64;
  const samples = period * 64;
  const outs = runKernel(row, {
    samples,
    knobs: { length: 3 },
    wire: {
      trigger: (i) => ((i >= 16 && i < 32) || (i >= period * 24 && i < period * 24 + 16) ? WIRE_HIGH : 0),
      reset: (i) => (i >= period * 20 && i < period * 20 + 16 ? WIRE_HIGH : 0),
      clock: (i) => (i >= 64 ? squareWire(period)(i) : 0),
    },
  });
  assert.equal(risingEdges(outs[outputIndex(row, "endt")]).length, 2, "it fired once, was reset, and fired again");
});

check("GateSequencer8 walks its grid, and its trig row is the gate ANDed with the clock", () => {
  const row = rowOf("vcvGateSequencer8");
  const period = 64;
  const samples = period * 40;
  // Track 1 on at steps 1 and 4 — the stub's own p0 and p3.
  const outs = runKernel(row, {
    samples,
    knobs: { step1_1: 1, step1_4: 1, length: 8 },
    wire: { clock: squareWire(period) },
  });
  const gate = outs[outputIndex(row, "gate1")];
  const trig = outs[outputIndex(row, "trig1")];
  const gateEdges = risingEdges(gate);
  assert.ok(gateEdges.length >= 4, "the sequencer is running with nothing patched to `run` — it is normalled to 10 V");
  // Steps 1 and 4 of eight: the gaps alternate 3 and 5 clock periods.
  const gaps = [];
  for (let i = 1; i < gateEdges.length; i++) gaps.push((gateEdges[i] - gateEdges[i - 1]) / period);
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i] === 3 || gaps[i] === 5, `an unexpected gap of ${gaps[i]} steps between active steps`);
  }
  const gateHigh = Array.from(gate).filter((v) => v > 0.5).length;
  const trigHigh = Array.from(trig).filter((v) => v > 0.5).length;
  assert.ok(trigHigh > 0 && trigHigh < gateHigh, "the trig row is shorter than the gate row — it is ANDed with the clock");
});

check("GateSequencer8's length knob shortens the walk", () => {
  const row = rowOf("vcvGateSequencer8");
  const period = 64;
  const samples = period * 48;
  const count = (length) => {
    const outs = runKernel(row, { samples, knobs: { step1_1: 1, length }, wire: { clock: squareWire(period) } });
    return risingEdges(outs[outputIndex(row, "gate1")]).length;
  };
  assert.ok(count(4) > count(8), "a four-step loop hits step 1 twice as often as an eight-step one");
});

check("GateSequencer8's mute silences a track without clearing it", () => {
  const row = rowOf("vcvGateSequencer8");
  const period = 64;
  const outs = runKernel(row, {
    samples: period * 24,
    knobs: { step1_1: 1, mute1: 1 },
    wire: { clock: squareWire(period) },
  });
  assert.equal(risingEdges(outs[outputIndex(row, "gate1")]).length, 0, "the muted track emits nothing");
});

check("Fade ramps up over the fade-in time and back down over the fade-out", () => {
  const row = rowOf("vcvFade");
  const fadeIn = 0.05;
  const fadeOut = 0.1;
  const samples = Math.round(FS * 0.4);
  // THE GATE STARTS AT SAMPLE 100, NOT 0: a run that is already going on the first
  // sample has no rising edge for `risingEdges` to find, and its start marker would be
  // silently uncounted.
  const gateStarts = 100;
  const gateEnds = Math.round(FS * 0.15);
  const outs = runKernel(row, {
    samples,
    knobs: { in: fadeIn, out: fadeOut },
    wire: { l: () => 1, ctrl: (i) => (i >= gateStarts && i < gateEnds ? WIRE_HIGH : 0) },
  });
  const left = outs[outputIndex(row, "l")];
  assert.ok(left[0] < 0.05, "it starts silent");
  const halfway = gateStarts + Math.round(FS * fadeIn * 0.5);
  assert.ok(Math.abs(left[halfway] - 0.5) < 0.05, `the ramp is LINEAR — halfway through the fade-in it is at ${left[halfway]}`);
  assert.ok(Math.abs(left[gateStarts + Math.round(FS * fadeIn) + 100] - 1) < 1e-6, "it reaches unity at the end of the fade-in and holds");
  const midDecay = gateEnds + Math.round(FS * fadeOut * 0.5);
  assert.ok(Math.abs(left[midDecay] - 0.5) < 0.05, `halfway down it is at ${left[midDecay]}`);
  assert.ok(left[samples - 1] < 1e-6, "it ends silent");
  const gate = outs[outputIndex(row, "gate")];
  assert.equal(gate[Math.round(FS * 0.1)], 1, "the run gate is high for the whole run");
  assert.equal(gate[samples - 1], 0, "and low once the fade-out has finished");
  assert.equal(risingEdges(outs[outputIndex(row, "trig")]).length, 2, "a 1 ms marker at each end of the run");
});

check("Fade does not click when a fade is interrupted", () => {
  const row = rowOf("vcvFade");
  const fade = 0.1;
  const samples = Math.round(FS * 0.5);
  const off = Math.round(FS * 0.15);
  const on = Math.round(FS * 0.2);
  const outs = runKernel(row, {
    samples,
    knobs: { in: fade, out: fade },
    wire: { l: () => 1, ctrl: (i) => ((i >= 100 && i < off) || i >= on ? WIRE_HIGH : 0) },
  });
  const left = outs[outputIndex(row, "l")];
  let worst = 0;
  for (let i = 1; i < samples; i++) worst = Math.max(worst, Math.abs(left[i] - left[i - 1]));
  // A jump back to zero on the re-gate would be a step of the whole current gain.
  assert.ok(worst < 0.01, `the largest single-sample step is ${worst} — `
    + "`lastMute` restarts the ramp from the CURRENT gain, so there is no discontinuity");
});

check("Fade's unpatched channel outputs silence rather than the gain", () => {
  const row = rowOf("vcvFade");
  const outs = runKernel(row, { samples: 1024, knobs: { fade: 1 }, wire: { l: () => 1 } });
  assert.ok(Array.from(outs[outputIndex(row, "r")]).every((v) => v === 0), "R is unpatched, so it is 0 V");
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE UNIT BOUNDARY — R7-UNITS, measured rather than asserted
// ═══════════════════════════════════════════════════════════════════════════

check("every `trigger` output lands in 0…1 and every `audio` one within ±2", () => {
  for (const row of VC7A_PROCESSORS) {
    for (const port of row.outputs) {
      if (row.rawPorts.includes(port)) continue;
      const scale = portOutputScale(row, port);
      const expected = row.triggerPorts.includes(port) ? 1 / K.RACK_GATE_VOLTS : 1 / K.RACK_VOLTS_PER_UNIT;
      assert.equal(scale, expected, `${row.module}.${port} has the wrong output scale`);
      assert.equal(K.GATE_HIGH_VOLTS * scale <= (row.triggerPorts.includes(port) ? 1 : 2), true,
        `${row.module}.${port}: a 10 V gate would land outside its type's range`);
    }
    for (const port of row.audioInputs) {
      const expected = row.rawPorts.includes(port) ? 1 : K.RACK_VOLTS_PER_UNIT;
      assert.equal(portInputScale(row, port), expected, `${row.module}.${port} has the wrong input scale`);
    }
  }
});

check("a 0…1 trigger on an inlet clears CountModula's 2 V Schmitt threshold", () => {
  // The reason no inlet in this block is `gate`-scaled: the LEVEL scale already puts a
  // full trigger a factor of 2.5 above the threshold.
  assert.ok(WIRE_HIGH * K.RACK_VOLTS_PER_UNIT >= K.COUNTMODULA_GATE_HIGH_VOLTS * 2,
    "a 1.0 trigger arrives as 5 V, which is 2.5× their 2 V threshold");
  const row = rowOf("vcvClockDivider");
  const outs = runKernel(row, { samples: 1024, wire: { clock: squareWire(64) } });
  assert.ok(risingEdges(outs[0]).length > 0, "and it really does clock the divider");
});

check("no inlet in this block is trigger-typed, and every gate outlet is (D4)", () => {
  for (const spec of BLOCK_SPECS) {
    for (const port of spec.inputs) {
      assert.notEqual(port.type, "trigger",
        `${spec.type}.${port.key} is trigger-typed, which refuses an LFO as a clock — core/nodeflow has no audio->trigger`);
    }
  }
  const gateOutputs = BLOCK_SPECS.flatMap((spec) => spec.outputs.filter((p) => p.type === "trigger"));
  assert.ok(gateOutputs.length >= 30, `only ${gateOutputs.length} trigger outputs — the gate outlets should be typed that way`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE SWEEPS — spec ↔ roster ↔ plugin barrel, exhaustively
// ═══════════════════════════════════════════════════════════════════════════

check("every spec has a roster row, a factory and a plugin, and nothing is orphaned", () => {
  assert.equal(BLOCK_SPECS.length, VC7A_PROCESSORS.length, "spec count vs roster count");
  assert.equal(BLOCK_SPECS.length, BLOCK_PLUGINS.length, "spec count vs plugin count");
  assert.deepEqual(BLOCK_SPECS.map((s) => s.type), BLOCK_PLUGINS.map((p) => p.type), "the barrel is in spec order");
  assert.ok(Array.isArray(BLOCK_WORKLET_MODULES), "BLOCK_WORKLET_MODULES is an ARRAY, per the PORT-BLOCK CONTRACT");
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    assert.equal(BLOCK_MODULE_FACTORIES[spec.module] !== undefined, true, `${spec.module} has no factory`);
    assert.ok(BLOCK_WORKLET_MODULES.includes(spec.module), `${spec.module} is missing from BLOCK_WORKLET_MODULES`);
    assert.ok(row.name.startsWith("vc7a-"), `${row.name} must carry the block's processor-name prefix`);
  }
  const names = VC7A_PROCESSORS.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, "processor names must be unique");
});

check("every declared knob is a real AudioParam with the same default and range", () => {
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    const params = new Map(row.params.map((p) => [p.name, p]));
    for (const knob of spec.knobs) {
      if (knob.construct) {
        assert.ok(row.construct.includes(knob.key), `${spec.type}.${knob.key} is construct: true but not in the roster's construct list`);
        continue;
      }
      const param = params.get(knob.key);
      assert.ok(param, `${spec.type} declares knob ${JSON.stringify(knob.key)}, which is not an AudioParam`);
      assert.equal(knob.default, param.defaultValue, `${spec.type}.${knob.key} default`);
      assert.equal(knob.min, param.minValue, `${spec.type}.${knob.key} min`);
      assert.equal(knob.max, param.maxValue, `${spec.type}.${knob.key} max`);
    }
    const declared = new Set(spec.knobs.map((k) => k.key));
    for (const param of row.params) {
      assert.ok(declared.has(param.name), `${spec.type} has an AudioParam ${JSON.stringify(param.name)} with no Inspector row`);
    }
    for (const name of row.construct) {
      assert.ok(declared.has(name), `${spec.type} has a construct option ${JSON.stringify(name)} with no knob`);
    }
  }
});

check("every declared port is a real engine port, in the roster's own order", () => {
  for (const spec of BLOCK_SPECS) {
    const row = rowOf(spec.module);
    assert.deepEqual(spec.inputs.map((p) => p.key), row.audioInputs, `${spec.type} input ports`);
    assert.deepEqual(spec.outputs.map((p) => p.key), row.outputs, `${spec.type} output ports`);
    for (const port of [...spec.inputs, ...spec.outputs]) {
      assert.ok(PORT_TYPE_NAMES.includes(port.type), `${spec.type}.${port.key} declares unknown type ${port.type}`);
    }
    for (const port of row.triggerPorts) {
      const declared = spec.outputs.find((p) => p.key === port);
      assert.ok(declared, `${spec.type}: triggerPorts names ${JSON.stringify(port)}, which is not an output`);
      assert.equal(declared.type, "trigger", `${spec.type}.${port} is in triggerPorts but is typed ${declared.type}`);
    }
    for (const port of spec.outputs) {
      if (port.type === "trigger") assert.ok(row.triggerPorts.includes(port.key), `${spec.type}.${port.key} is typed trigger but is not scaled as one`);
    }
  }
});

check("the two numbered-key helpers agree across the core/synth boundary", () => {
  // core/ may not import synth/, so both sides own a copy — this is the gate that
  // keeps the copies identical.
  assert.deepEqual(numbered("gate", 7), numberedKeys("gate", 7));
  assert.deepEqual(numbered("clk_", 4), numberedKeys("clk_", 4));
  assert.deepEqual(gateSequencerSteps(), gateSequencerStepKeys());
  assert.equal(gateSequencerSteps().length, 64);
});

check("the block's constants are not restated wrongly in core/", () => {
  const spec = BLOCK_SPECS.find((s) => s.type === "audio_vcv_clkd");
  const bpm = spec.knobs.find((k) => k.key === "bpm");
  assert.equal(bpm.min, K.CLKD_BPM_MIN, "the spec's BPM floor is the kernels' own");
  assert.equal(bpm.max, K.CLKD_BPM_MAX, "the spec's BPM ceiling is the kernels' own");
  const ratio = spec.knobs.find((k) => k.key === "ratio_1");
  assert.equal(ratio.max, K.CLKD_RATIO_VALUES.length - 1, "a ratio knob spans their table exactly");
  // The two Schmitt thresholds the AND's help sentence quotes.
  const and = BLOCK_SPECS.find((s) => s.type === "audio_vcv_booleanand");
  assert.ok(and.help.includes(`${K.COUNTMODULA_GATE_LOW_VOLTS} V / ${K.COUNTMODULA_GATE_HIGH_VOLTS} V`),
    "the AND's help must quote the kernels' own thresholds");
});

check("every derivation index names a real kernel class and a defined deviation", () => {
  for (const spec of BLOCK_SPECS) {
    const d = spec.derivation;
    assert.ok(d, `${spec.type} has no derivation index`);
    assert.ok(d.source === COUNTMODULA_SOURCE || d.source === IMPROMPTU_SOURCE, `${spec.type} cites an unknown source`);
    assert.ok(/@ [0-9a-f]{40}$/.test(d.source), `${spec.type}'s source must pin a full commit`);
    assert.equal(typeof K[d.kernel], "function", `${spec.type} names kernel ${d.kernel}, which is not exported`);
    assert.ok(d.files.length > 0, `${spec.type} names no C++ file`);
    for (const file of d.files) {
      assert.ok(KERNEL_SOURCE.includes(file), `${spec.type} cites ${file}, which the derivation record never mentions`);
    }
    for (const id of d.deviations) {
      assert.ok(new RegExp(`── ${id}\\.|${id}:|${id} \\(|kernels' ${id}|\\(${id}\\)`).test(KERNEL_SOURCE),
        `${spec.type} claims deviation ${id}, which synth/vc7a_kernels.js never defines`);
    }
  }
});

check("every spec renders as a plugin with a real family and Inspector rows", () => {
  for (const spec of BLOCK_SPECS) {
    const plugin = audioNodePlugin(spec);
    assert.ok(NODE_FAMILY_NAMES.includes(spec.family), `${spec.type} declares unknown family ${spec.family}`);
    const ports = declaredPorts(plugin, plugin.defaults);
    assert.equal(ports.inputs.length, spec.inputs.length, `${spec.type} port count through the plugin`);
    assert.equal(ports.outputs.length, spec.outputs.length, `${spec.type} output count through the plugin`);
    const rows = audioKnobRows(spec);
    assert.equal(rows.length, spec.knobs.length, `${spec.type} must have one Inspector row per knob`);
    for (const row of rows) assert.ok(row.help && row.help.length > 40, `${spec.type}.${row.key} needs a real help sentence`);
    if (spec.readout) {
      assert.ok(spec.knobs.some((k) => k.key === spec.readout), `${spec.type}'s readout names no knob of its own`);
    }
  }
});

check("no knob in this block is `discrete`, which would discard a patch's numeric value", () => {
  for (const spec of BLOCK_SPECS) {
    for (const knob of spec.knobs) {
      assert.notEqual(knob.discrete, true,
        `${spec.type}.${knob.key} is discrete — audioKnobValues would replace a harvested numeric switch position with the default`);
    }
  }
});

console.log(`port_vc7a_test: ${passed} checks passed`);
