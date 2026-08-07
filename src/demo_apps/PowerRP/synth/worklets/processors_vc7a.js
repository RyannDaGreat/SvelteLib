/**
 * THE VC-7a AUDIOWORKLET PROCESSORS — twelve clocking and logic modules on the audio
 * thread.
 *
 * ── WHY A SEPARATE WORKLET FILE ─────────────────────────────────────────────
 * One per port block (R7 Wave 3 Phase 3): several agents land module sets
 * concurrently, so one shared worklet file is one merge conflict per agent per save.
 * The engine loads them all with `addModule`; the AudioWorklet global scope is SHARED,
 * so `registerProcessor` names must be globally unique — hence the `vc7a-` prefix on
 * every one below.
 *
 * ── THIS FILE IMPORTS, AND THAT IS MEASURED, NOT ASSUMED ────────────────────
 * `processors.js`'s header says the worklet scope "must not import anything"; AX-2
 * measured otherwise on this repo's own Chrome and AX-3 measured the CONDITION: a
 * worklet MAY statically import, but only if its URL goes through Vite's
 * `?worker&url` pipeline — which is why that specifier lives in
 * `synth/worklet_urls.js` and NOT here.
 *
 * ── REAL-TIME SAFETY (the checklist `processors.js` sets) ───────────────────
 * `process()` runs every 128 samples. ZERO allocations in it: the `signals` object,
 * the `wired` object, the frame buffer and every parameter-array slot are built in
 * the constructor and mutated in place. No `new`, no object literals, no closures.
 * Always `return true`.
 *
 * ── THE THREE THINGS THIS FILE IS FOR ───────────────────────────────────────
 * 1. **THE UNIT BOUNDARY (R7-UNITS, kernels' D0).** Both source plugins compute in
 *    Rack VOLTS; PowerRP wires carry ±1 levels and 0…1 triggers. The conversion
 *    happens HERE and nowhere else, in exactly two places — one read, one write —
 *    through the per-port scale rules `portInputScale` / `portOutputScale` state.
 *    Every line in the kernels is therefore directly diffable against the C++.
 * 2. **THE CONTROL-RATE DIVIDERS (D1).** Four CountModula modules read their panel
 *    every NINTH sample and Clkd every SIXTEENTH. The loop below calls
 *    `kernel.control()` every `row.controlSteps` samples. Running those per sample is
 *    a different sound, not a more accurate one — SampleAndHold2's `forceSample`
 *    fires on a mode change detected AT THAT RATE.
 * 3. **`isConnected()` (D3).** CountModula's laws branch on whether a cable is
 *    present far more than Bogaudio's do: BooleanAND emits nothing without A,
 *    SampleAndHold2 does nothing without a trigger and samples NOISE without a
 *    signal, GateSequencer8's run inlet is normalled to 10 V so unpatched means
 *    RUNNING. No AudioParam can express that, so every inlet is an `audio` input at
 *    its own input INDEX and connectedness is `inputs[i].length > 0`. The kernels
 *    take `wired` as an explicit map so the bare-node test drives both branches.
 *
 * ── AND THE THING THIS BLOCK DOES NOT HAVE: DISCRETE OPTIONS ────────────────
 * AX-2 and VC-3b post string-valued knobs to the audio thread by message. There are
 * NONE here, deliberately: every switch in both source plugins is a `configSwitch`
 * FLOAT param, and the harvested demo patches carry those switch positions as
 * NUMBERS. A discrete string knob would make `audioKnobValues` discard a patch's `0`
 * as "not a string" and silently substitute the default. So every knob in VC-7a is an
 * a-rate AudioParam, and this file needs no `port.onmessage`, no setter convention and
 * no construction-race workaround at all. `seed` is still a construct option, because
 * a generator's initial state cannot be a param.
 */

import {
  BooleanAndKernel, BooleanXorKernel, BurstGeneratorKernel, BusRoute2Kernel, BUS_ROUTE_CHANNELS,
  CLKD_BPM_MAX, CLKD_BPM_MIN, CLKD_RATIO_VALUES, ClkdKernel, ClockDividerKernel,
  CLOCK_DIVIDER_MASKS, CLOCK_DIVIDER_OUTPUTS, EVENT_TIMER_MAX_COUNT, EventTimerKernel,
  FadeKernel, GATESEQ_ROWS, GATESEQ_STEPS, GateSequencer8Kernel, RACK_GATE_VOLTS,
  RACK_VOLTS_PER_UNIT, SampleAndHold2Kernel, SampleAndHoldKernel, SH_PASS,
  VcFrequencyDividerMkIIKernel,
} from "../vc7a_kernels.js";

/**
 * Pure function. An a-rate AudioParam descriptor. Every knob in this block is one, so
 * the shape is stated once rather than twenty-nine times.
 *
 * @param {string} name
 * @param {number} defaultValue
 * @param {number} minValue
 * @param {number} maxValue
 * @returns {object} an AudioParam descriptor
 *
 * @example unit("mode", 0, 0, 2).automationRate // "a-rate"
 * @example unit("mode", 0, 0, 2).defaultValue // 0
 */
export function unit(name, defaultValue, minValue, maxValue) {
  return { name, defaultValue, minValue, maxValue, automationRate: "a-rate" };
}

/**
 * Pure function. A two-position panel switch, as the numeric 0/1 param it is in both
 * source plugins. Named so that "this knob is a switch" is readable at the roster.
 *
 * @param {string} name
 * @param {number} [defaultValue] - 0 or 1
 * @returns {object} an AudioParam descriptor
 *
 * @example toggle("dir").maxValue // 1
 * @example toggle("resetHigh", 1).defaultValue // 1
 */
export function toggle(name, defaultValue = 0) {
  return unit(name, defaultValue, 0, 1);
}

/**
 * Pure function. `n` numbered port or knob keys — `numberedKeys("gate", 3)` is
 * `["gate1", "gate2", "gate3"]`. One helper because four rosters below are numbered
 * families and a hand-typed list of sixty-four is a list with a typo.
 *
 * @param {string} stem
 * @param {number} count
 * @param {string} [suffix]
 * @returns {string[]}
 *
 * @example numberedKeys("gate", 3) // ["gate1", "gate2", "gate3"]
 * @example numberedKeys("clk_", 2) // ["clk_1", "clk_2"]
 * @example numberedKeys("trigOut", 2, "x") // ["trigOut1x", "trigOut2x"]
 */
export function numberedKeys(stem, count, suffix = "") {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(`${stem}${i}${suffix}`);
  return keys;
}

/**
 * Pure function. GateSequencer8's step-switch keys, `step<row>_<step>`, row-major —
 * generated rather than written out, so a renamed row cannot exist in one of the two
 * lists only (the roster's and the spec's).
 *
 * @returns {string[]} 64 keys
 *
 * @example gateSequencerStepKeys().length // 64
 * @example gateSequencerStepKeys()[0] // "step1_1"
 * @example gateSequencerStepKeys()[12] // "step2_5"
 */
export function gateSequencerStepKeys() {
  const keys = [];
  for (let r = 1; r <= GATESEQ_ROWS; r++) {
    for (let s = 1; s <= GATESEQ_STEPS; s++) keys.push(`step${r}_${s}`);
  }
  return keys;
}

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name          the `registerProcessor` id, globally unique across worklet files
 *   module        the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label         `meta.label`
 *   make          `(sampleRate, constructOptions) -> kernel`
 *   params        the a-rate AudioParams — THE KNOBS, in real units (D15)
 *   audioInputs   the input port keys, IN INPUT-INDEX ORDER (D3)
 *   outputs       output port names, in output-index order
 *   triggerPorts  the OUTPUT ports typed `trigger`, which land in 0…1 rather than
 *                 being divided by five — R7-UNITS clause 4
 *   rawPorts      the ports (input OR output) whose wire value is NOT a voltage at
 *                 all and is passed through unscaled. Clkd's `bpm_cv` / `bpm` pair
 *                 alone, which carry BPM (kernels' D9)
 *   construct     knobs passed as `processorOptions` — `seed` only
 *   controlSteps  how many samples one `kernel.control()` period is (D1)
 *
 * `modules_vc7a.js` builds its twelve factories FROM THIS ARRAY rather than restating
 * any of it, and `tests/port_vc7a_test.js` checks it against `core/audio_specs_vc7a.js`
 * in turn — so a port renamed here cannot leave a spec declaring one the engine does
 * not have.
 */
export const VC7A_PROCESSORS = [
  {
    name: "vc7a-clkd-processor", module: "vcvClkd", label: "VCV Clkd",
    make: (rate) => new ClkdKernel(rate),
    params: [
      unit("bpm", 120, CLKD_BPM_MIN, CLKD_BPM_MAX),
      unit("ratio_1", 0, -(CLKD_RATIO_VALUES.length - 1), CLKD_RATIO_VALUES.length - 1),
      unit("ratio_2", 0, -(CLKD_RATIO_VALUES.length - 1), CLKD_RATIO_VALUES.length - 1),
      unit("ratio_3", 0, -(CLKD_RATIO_VALUES.length - 1), CLKD_RATIO_VALUES.length - 1),
      unit("ppqn", 4, 2, 24),
      toggle("bpmMode"),
      toggle("running", 1),
      toggle("resetHigh", 1),
      toggle("momentaryRun", 1),
      toggle("forceCvOnBpmOut"),
      ...numberedKeys("trigOut", 4).map((name) => toggle(name)),
      toggle("resetOnStartInt"),
      toggle("resetOnStartExt"),
      toggle("resetOnStopInt"),
      toggle("resetOnStopExt"),
    ],
    audioInputs: ["reset", "run", "bpm_cv"],
    outputs: [...numberedKeys("clk_", 4), "reset", "run", "bpm"],
    triggerPorts: [...numberedKeys("clk_", 4), "reset", "run"],
    rawPorts: ["bpm_cv", "bpm"],
    construct: [],
    // `RefreshCounter::userInputsStepSkipMask = 0xF` — once every sixteen samples.
    controlSteps: 16,
  },
  {
    name: "vc7a-gate-sequencer-8-processor", module: "vcvGateSequencer8", label: "VCV Gate Sequencer 8",
    make: (rate, options) => new GateSequencer8Kernel(rate, options),
    params: [
      ...gateSequencerStepKeys().map((name) => toggle(name)),
      ...numberedKeys("mute", GATESEQ_ROWS).map((name) => toggle(name)),
      unit("length", GATESEQ_STEPS, 1, GATESEQ_STEPS),
      unit("direction", 0, 0, 8),
      unit("addr", 0, 0, 10),
    ],
    audioInputs: ["run", "clock", "reset", "length_cv", "direction_cv", "address_cv"],
    outputs: [...numberedKeys("gate", GATESEQ_ROWS), ...numberedKeys("trig", GATESEQ_ROWS), "end"],
    triggerPorts: [...numberedKeys("gate", GATESEQ_ROWS), ...numberedKeys("trig", GATESEQ_ROWS), "end"],
    rawPorts: [],
    construct: ["seed"],
    controlSteps: 1,
  },
  {
    name: "vc7a-burst-generator-processor", module: "vcvBurstGenerator", label: "VCV Burst Generator",
    make: (rate, options) => new BurstGeneratorKernel(rate, options),
    params: [
      unit("rate", 0, 0, 5),
      unit("rateCvAtten", 0, -1, 1),
      toggle("range"),
      toggle("retrigger"),
      unit("pulses", 1, 1, 16),
      unit("pulsesCvAtten", 0, -1.6, 1.6),
      unit("probability", 10, 0, 10),
      unit("probabilityCvAtten", 0, -1, 1),
    ],
    audioInputs: ["clock", "rate_cv", "trigger", "pulses_cv", "probability_cv"],
    outputs: ["pulses", "start", "duration", "end"],
    triggerPorts: ["pulses", "start", "duration", "end"],
    rawPorts: [],
    construct: ["seed"],
    controlSteps: 1,
  },
  {
    name: "vc7a-fade-processor", module: "vcvFade", label: "VCV Fade",
    make: (rate) => new FadeKernel(rate),
    params: [
      toggle("fade"),
      unit("in", 3, 0.1, 10),
      unit("out", 3, 0.1, 10),
      toggle("mon"),
      toggle("controlMode"),
    ],
    audioInputs: ["l", "r", "ctrl"],
    outputs: ["l", "r", "gate", "trig"],
    triggerPorts: ["gate", "trig"],
    rawPorts: [],
    construct: [],
    // `if (++processCount > 8)` — nine samples.
    controlSteps: 9,
  },
  {
    name: "vc7a-event-timer-processor", module: "vcvEventTimer", label: "VCV Event Timer",
    make: (rate) => new EventTimerKernel(rate),
    params: [unit("length", 0, 0, EVENT_TIMER_MAX_COUNT), toggle("retrigger")],
    audioInputs: ["clock", "reset", "trigger"],
    outputs: ["end", "endt"],
    triggerPorts: ["end", "endt"],
    rawPorts: [],
    construct: [],
    controlSteps: 9,
  },
  {
    name: "vc7a-sample-and-hold-2-processor", module: "vcvSampleAndHold2", label: "VCV Sample & Hold 2",
    make: (rate, options) => new SampleAndHold2Kernel(rate, options),
    params: [
      unit("mode", 0, 0, SH_PASS),
      unit("prob", 1, 0, 1),
      unit("probCvAtten", 0, -1, 1),
      unit("level", 1, 0, 1),
      unit("offset", 0, -1, 1),
    ],
    audioInputs: ["sample", "trig", "mode_cv", "prob_cv", "offset_cv"],
    outputs: ["sample", "inv"],
    triggerPorts: [],
    rawPorts: [],
    construct: ["seed"],
    controlSteps: 9,
  },
  {
    name: "vc7a-sample-and-hold-processor", module: "vcvSampleAndHold", label: "VCV Sample & Hold",
    make: () => new SampleAndHoldKernel(),
    params: [unit("mode", 0, 0, SH_PASS)],
    audioInputs: ["sample", "trig", "mode_cv"],
    outputs: ["sample", "inv"],
    triggerPorts: [],
    rawPorts: [],
    construct: [],
    controlSteps: 1,
  },
  {
    name: "vc7a-boolean-and-processor", module: "vcvBooleanAnd", label: "VCV Boolean AND",
    make: () => new BooleanAndKernel(),
    params: [],
    audioInputs: ["a", "b", "c", "d", "i"],
    outputs: ["and", "inv"],
    triggerPorts: ["and", "inv"],
    rawPorts: [],
    construct: [],
    controlSteps: 1,
  },
  {
    name: "vc7a-clock-divider-processor", module: "vcvClockDivider", label: "VCV Clock Divider",
    make: (rate) => new ClockDividerKernel(rate),
    params: [toggle("dir"), toggle("trig"), unit("mode", 0, 0, CLOCK_DIVIDER_MASKS.length - 1)],
    audioInputs: ["clock", "reset"],
    outputs: numberedKeys("div", CLOCK_DIVIDER_OUTPUTS),
    triggerPorts: numberedKeys("div", CLOCK_DIVIDER_OUTPUTS),
    rawPorts: [],
    construct: [],
    controlSteps: 9,
  },
  {
    name: "vc7a-vc-frequency-divider-mk2-processor", module: "vcvVcFrequencyDividerMkII", label: "VCV VC Frequency Divider MkII",
    make: () => new VcFrequencyDividerMkIIKernel(),
    params: [unit("cvAmount", 0, -2, 2), unit("divide", 1, 1, 21), toggle("legacy")],
    audioInputs: ["cv", "div"],
    // BOTH outputs stay `audio` even though `divu` is gate-shaped: at audio rate these
    // are subharmonic OSCILLATOR outputs, not logic. See the kernel's docblock.
    outputs: ["divb", "divu"],
    triggerPorts: [],
    rawPorts: [],
    construct: [],
    controlSteps: 1,
  },
  {
    name: "vc7a-bus-route-2-processor", module: "vcvBusRoute2", label: "VCV Bus Route 2",
    make: () => new BusRoute2Kernel(),
    params: [
      ...numberedKeys("busA", BUS_ROUTE_CHANNELS).map((name) => toggle(name)),
      ...numberedKeys("busB", BUS_ROUTE_CHANNELS).map((name) => toggle(name)),
    ],
    audioInputs: numberedKeys("gate", BUS_ROUTE_CHANNELS),
    outputs: ["a", "b"],
    triggerPorts: ["a", "b"],
    rawPorts: [],
    construct: [],
    controlSteps: 1,
  },
  {
    name: "vc7a-boolean-xor-processor", module: "vcvBooleanXor", label: "VCV Boolean XOR",
    make: () => new BooleanXorKernel(),
    params: [toggle("mode")],
    audioInputs: ["a", "b", "c", "d", "i"],
    outputs: ["xor", "inv"],
    triggerPorts: ["xor", "inv"],
    rawPorts: [],
    construct: [],
    controlSteps: 1,
  },
];

/**
 * Pure function. What one WIRE UNIT is worth to the kernel, on an INPUT.
 *
 * Two rules and no table, because this block has only two kinds of inlet: a raw port
 * (Clkd's BPM, which is BPM) and everything else (volts). There is deliberately no
 * gate scale — no inlet here is `trigger`-typed (kernels' D4), and a 0…1 trigger
 * arriving on a level inlet becomes 5 V, which clears CountModula's 2 V Schmitt
 * threshold by a factor of 2.5.
 *
 * @param {object} row - a VC7A_PROCESSORS entry
 * @param {string} port - the port key
 * @returns {number} kernel units per wire unit
 *
 * @example portInputScale({rawPorts: []}, "clock") // 5
 * @example portInputScale({rawPorts: ["bpm_cv"]}, "bpm_cv") // 1
 */
export function portInputScale(row, port) {
  return row.rawPorts.includes(port) ? 1 : RACK_VOLTS_PER_UNIT;
}

/**
 * Pure function. The reciprocal, on an OUTPUT — and the one place the asymmetry
 * R7-UNITS clause 4 requires is applied. A `trigger` output must land in 0…1 and the
 * source emits `boolToGate`'s 10 V, so it divides by ten; an `audio` output divides by
 * five, which puts a ±5 V square at ±1 and Rack's 10 V headroom at 2.
 *
 * @param {object} row - a VC7A_PROCESSORS entry
 * @param {string} port - the port key
 * @returns {number} wire units per kernel unit
 *
 * @example portOutputScale({rawPorts: [], triggerPorts: []}, "divb") // 0.2
 * @example portOutputScale({rawPorts: [], triggerPorts: ["end"]}, "end") // 0.1
 * @example portOutputScale({rawPorts: ["bpm"], triggerPorts: []}, "bpm") // 1
 */
export function portOutputScale(row, port) {
  if (row.rawPorts.includes(port)) return 1;
  if (row.triggerPorts.includes(port)) return 1 / RACK_GATE_VOLTS;
  return 1 / RACK_VOLTS_PER_UNIT;
}

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The guard
// is what lets modules_vc7a.js and the tests import the roster above from the main
// thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of VC7A_PROCESSORS) {
    registerProcessor(entry.name, class extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return entry.params;
      }

      constructor(options) {
        super();
        this.kernel = entry.make(sampleRate, options.processorOptions ?? {});
        this.paramNames = entry.params.map((p) => p.name);
        this.paramArrays = new Array(this.paramNames.length).fill(null);
        this.inputNames = entry.audioInputs;
        this.knobs = {};
        for (const name of this.paramNames) this.knobs[name] = 0;
        this.signals = {};
        this.wired = {};
        for (const name of this.inputNames) {
          this.signals[name] = 0;
          this.wired[name] = false;
        }
        this.channels = new Array(this.inputNames.length).fill(null);
        // THE PER-PORT SCALES, resolved ONCE at construction. A per-sample lookup
        // would be an allocation-free but pointless string compare in the inner loop.
        this.inputScale = Float64Array.from(this.inputNames, (name) => portInputScale(entry, name));
        this.outputScale = Float64Array.from(entry.outputs, (name) => portOutputScale(entry, name));
        this.frame = new Float64Array(entry.outputs.length);
        // D1. It counts SAMPLES and is deliberately not reset per quantum: neither 9
        // nor 16 divides 128 evenly for 9, so pretending the control rate is
        // quantum-aligned would drift against the original.
        this.controlSteps = entry.controlSteps;
        this.tick = 0;
      }

      process(inputs, outputs, parameters) {
        const frames = outputs[0][0].length;
        const paramNames = this.paramNames;
        const paramArrays = this.paramArrays;
        const inputNames = this.inputNames;
        const channels = this.channels;
        const knobs = this.knobs;
        const signals = this.signals;
        const wired = this.wired;
        for (let n = 0; n < paramNames.length; n++) paramArrays[n] = parameters[paramNames[n]];
        // D3: an UNCONNECTED input arrives as a zero-length channel list. Only channel
        // 0 is read — our wire is mono (D7), and a stereo source feeding one of these
        // is summed upstream by the graph, not here.
        for (let n = 0; n < inputNames.length; n++) {
          const input = inputs[n];
          const connected = input !== undefined && input.length > 0;
          wired[inputNames[n]] = connected;
          channels[n] = connected ? input[0] : null;
        }
        for (let i = 0; i < frames; i++) {
          for (let n = 0; n < paramNames.length; n++) {
            const values = paramArrays[n];
            knobs[paramNames[n]] = values.length === 1 ? values[0] : values[i];
          }
          // R7-UNITS: one of the TWO places a scale is applied (the other is the write
          // below). A third site anywhere would mean some path is scaled twice, and a
          // factor of five is inaudible on one module and catastrophic across a patch.
          for (let n = 0; n < inputNames.length; n++) {
            const channel = channels[n];
            signals[inputNames[n]] = channel === null ? 0 : channel[i] * this.inputScale[n];
          }
          if (this.tick === 0) this.kernel.control(knobs, signals, wired);
          this.kernel.sample(knobs, signals, wired, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o] * this.outputScale[o];
          this.tick = this.tick + 1 >= this.controlSteps ? 0 : this.tick + 1;
        }
        return true;
      }
    });
  }
}
