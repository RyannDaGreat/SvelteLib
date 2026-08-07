/**
 * THE VC-10 AUDIOWORKLET PROCESSORS — fifteen VCV Rack modules on the audio
 * thread.
 *
 * ── WHY A SEPARATE WORKLET FILE ─────────────────────────────────────────────
 * One per port block (R7 Wave 3 Phase 3): several agents land module sets
 * concurrently, so one shared worklet file is one merge conflict per agent per
 * save. The engine loads them all with `addModule`; the AudioWorklet global
 * scope is SHARED, so `registerProcessor` names must be globally unique — hence
 * the `vc10-` prefix on every one below.
 *
 * ⚠ THE WORKLET URL IS NOT HERE. `synth/worklet_urls.js` holds every block's
 * `?worker&url` specifier and is the only file allowed to contain Vite-only
 * syntax; a specifier anywhere in this import graph takes the entire bare-node
 * test lane down. This file MAY statically import `../vc10_kernels.js`, and
 * that is measured, not assumed — see AX-2's and AX-3's headers for the two
 * halves of the rule.
 *
 * ── REAL-TIME SAFETY (the checklist `processors.js` sets) ───────────────────
 * `process()` runs every 128 samples. ZERO allocations in it: the `signals`
 * object, the `wired` object, the frame buffer and every parameter-array slot
 * are built in the constructor and mutated in place. No `new`, no object
 * literals, no closures. Always `return true`.
 *
 * ── THE THREE THINGS THIS FILE IS FOR ───────────────────────────────────────
 * 1. **THE UNIT BOUNDARY (R7-UNITS, kernels' D0/D1/D2).** These modules compute
 *    in Rack VOLTS and SEMITONES; PowerRP wires carry ±1 levels, semitone
 *    pitches and 0…1 gates. The conversion happens HERE and nowhere else, in
 *    exactly two places — one read, one write — through a per-port scale table
 *    resolved once at construction. Every line in the kernels is therefore
 *    directly diffable against the original C++ (or, for the behaviour-derived
 *    nodes, against the manual's own volts).
 * 2. **THE CONTROL DIVIDERS (kernels' D4).** Squinky's modules re-read their
 *    knobs inside a `dsp::ClockDivider`: Super every 4 samples, F2 every 4 with
 *    a second pass every 16, Filt every 4, WVCO every 4 and every 16. Each row
 *    declares its own `controlDivisor` and the loop below honours it. Running
 *    those per sample changes every sweep, which is R7-11's whole point. The
 *    Vult and Instruō nodes run their control code per sample, as their sources
 *    and manuals describe, so their divisor is 1.
 * 3. **`isConnected()` (kernels' D3).** Super's stereo decision, Filt's routing
 *    modes, WVCO's four `…Connected_m` flags and saïch's V/oct NORMALLING all
 *    branch on whether a cable is present, and a connected cable at 0 V is a
 *    different sound from no cable. No AudioParam can express that, so every CV
 *    inlet is an `audio` input at its own input INDEX and connectedness is
 *    `inputs[i].length > 0`. The kernels take `wired` as an explicit map so
 *    `tests/port_vc10_test.js` drives both branches directly.
 */

import {
  AthruKernel, BasalKernel, BleakKernel, CaudalKernel, F2Kernel, FiltKernel, FreqShifterKernel,
  LateralusKernel, OchdKernel, RACK_VOLTS_PER_UNIT, SaichKernel, SuperKernel, TangentsKernel,
  UnstabileKernel, VC10_GATE_VOLTS, VessekKernel, WvcoKernel, squinkySemitonesToHz,
  vultCvToHz, vultSemitonesToHz,
} from "../vc10_kernels.js";

/**
 * THE THREE PORT SCALES — R7-UNITS, and the reason this is a table rather than
 * one constant. Every port on every module below is exactly one of these kinds,
 * and the kind decides what number the kernel sees:
 *
 *   LEVEL (clause 1)  `volts = wire · 5`. An audio signal or a bipolar CV. Our
 *                     ±1 IS Rack's ±5 V.
 *   PITCH (clause 3)  `semitones = wire`. A V/oct port carries SEMITONES, so
 *                     the wire value is already what the arithmetic wants and
 *                     nothing is scaled. THREE ORIGINS live in this block —
 *                     C4 for squinkylabs, C1 for Vult, C3 for Basal and Bleak
 *                     — and the origin is the KERNEL's business, not the
 *                     boundary's. See the kernels' D1.
 *   GATE  (clause 4)  `volts = wire · 10`. LOGIC IS NOT LEVEL: our gates are
 *                     0…1 and a Rack gate is 10 V. It also matters numerically
 *                     — Squinky's Schmitt trigger is at 0.8/1.6 V, so a ×5 gate
 *                     of 0.2 would look like a gate and never fire.
 *
 * A port absent from a row's `pitchPorts` and `gatePorts` is a LEVEL port. That
 * default is deliberate: level is the common case, and a NEW port that forgot
 * to declare itself gets the scale that is right for a signal.
 */
export const VC10_GATE_SCALE_VOLTS = VC10_GATE_VOLTS;

/** One a-rate AudioParam descriptor. Every knob in this block is a-rate, so a
 *  wired equation can sweep it inside a quantum rather than in steps of 128. */
const unit = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "a-rate" });

/** An attenuverter. D6: they default to UNITY, not to Rack's zero — a 0 default
 *  makes a patched cable do nothing, and this block exists to make the demo
 *  patches' cables live. */
const trim = (name, defaultValue = 1) => unit(name, defaultValue, -1, 1);

/** F2's cutoff knob is in HERTZ (R7-UNITS clause 2) and its span is exactly
 *  what their 0…10 V control reaches: `FREQ_C4 · 2^(v − 4)`. */
export const F2_FC_MIN_HZ = 261.6256 / 16;
export const F2_FC_MAX_HZ = 261.6256 * 64;
export const F2_FC_DEFAULT_HZ = 261.6256 * 2;

/** Every Vult filter's cutoff knob is in HERTZ over the span their own 0…1
 *  control covers, clipped at `tune`'s own 20 kHz ceiling. */
export const VULT_FC_MIN_HZ = vultSemitonesToHz(0);
export const VULT_FC_MAX_HZ = 20000;
export const VULT_FC_DEFAULT_HZ = 1000;

/** saïch's Coarse knob span, in semitones — three octaves either way, which is
 *  what a "Global Coarse Frequency" control on a quad oscillator reaches. */
const SAICH_COARSE_SEMITONES = 36;

/**
 * Pure function. Caudal's twelve output port keys — `x_1, y_1, a_1, … a_4`, in
 * the order the kernel writes its frame. Generated rather than typed out: the
 * only thing that differs between them is one integer, and a hand-typed list of
 * twelve is a list with a typo.
 *
 * @returns {string[]}
 *
 * @example caudalOutputs().length // 12
 * @example caudalOutputs()[0] // "x_1"
 * @example caudalOutputs()[11] // "a_4"
 */
export function caudalOutputs() {
  const keys = [];
  for (let segment = 1; segment <= 4; segment++) keys.push(`x_${segment}`, `y_${segment}`, `a_${segment}`);
  return keys;
}

/**
 * Pure function. øchd's eight output keys, for the same reason.
 *
 * @returns {string[]}
 *
 * @example ochdOutputs().length // 8
 * @example ochdOutputs()[7] // "out8"
 */
export function ochdOutputs() {
  const keys = [];
  for (let i = 1; i <= 8; i++) keys.push(`out${i}`);
  return keys;
}

/**
 * Pure function. saïch's four V/oct input keys.
 *
 * @returns {string[]}
 *
 * @example saichVoctInputs() // ["voct1", "voct2", "voct3", "voct4"]
 */
export function saichVoctInputs() {
  const keys = [];
  for (let i = 1; i <= 4; i++) keys.push(`voct${i}`);
  return keys;
}

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name            the `registerProcessor` id, globally unique across files
 *   module          the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label           `meta.label`
 *   make            `(sampleRate, constructOptions) -> kernel`
 *   params          the a-rate AudioParams — THE KNOBS, in real units
 *   pitchPorts      the ports carrying SEMITONES — R7-UNITS clause 3
 *   gatePorts       the ports carrying 0…1 LOGIC — R7-UNITS clause 4
 *   audioInputs     the audio input port keys, IN INPUT-INDEX ORDER (D3)
 *   construct       knobs passed as `processorOptions` (a seed sizes the object)
 *   options         discrete knobs set by message through `vc10OptionSetter`
 *   outputs         output port names, in output-index order
 *   controlDivisor  how many samples between `control()` calls (D4)
 *
 * `modules_vc10.js` builds its fifteen factories FROM THIS ARRAY rather than
 * restating any of it, and `tests/port_vc10_test.js` checks it against
 * `core/audio_specs_vc10.js` in turn — so a port renamed here cannot leave a
 * spec declaring one the engine does not have.
 */
export const VC10_PROCESSORS = [
  {
    name: "vc10-super-processor", module: "vcvSuper", label: "VCV Super",
    pitchPorts: ["pitch"], gatePorts: ["trigger"], controlDivisor: 4,
    construct: ["seed"], options: ["aliasMode", "hardPan", "stereo"],
    make: (rate, options) => new SuperKernel(rate, options),
    params: [
      unit("octave", 0, -5, 4),
      unit("semi", 0, -11, 11),
      unit("fine", 0, -1, 1),
      unit("detune", 0, -5, 5),
      trim("detuneTrim"),
      unit("mix", 0, -5, 5),
      trim("mixTrim"),
      unit("fm", 0, 0, 1),
    ],
    audioInputs: ["pitch", "trigger", "detune_cv", "mix_cv", "fm"],
    outputs: ["left", "right"],
  },
  {
    name: "vc10-f2-processor", module: "vcvF2", label: "VCV F2",
    pitchPorts: ["fc_cv"], gatePorts: [], controlDivisor: 4,
    construct: [], options: ["topology", "mode", "limiter", "altLimiter"],
    make: (rate) => new F2Kernel(rate),
    params: [
      unit("fc", F2_FC_DEFAULT_HZ, F2_FC_MIN_HZ, F2_FC_MAX_HZ),
      unit("q", 2, 0, 10),
      unit("r", 0, 0, 10),
      unit("volume", 50, 0, 100),
      trim("fcTrim"),
      trim("qTrim"),
      trim("rTrim"),
    ],
    audioInputs: ["audio", "fc_cv", "q_cv", "r_cv"],
    outputs: ["audio"],
  },
  {
    name: "vc10-filt-processor", module: "vcvFilt", label: "VCV Filt",
    pitchPorts: [], gatePorts: [], controlDivisor: 4,
    construct: [], options: ["type", "voicing"],
    make: (rate) => new FiltKernel(rate),
    params: [
      unit("fc", 0, -5, 5),
      unit("q", -5, -5, 5),
      unit("drive", -5, -5, 5),
      unit("edge", 0, -5, 5),
      unit("slope", 5, -5, 5),
      unit("spread", 0, 0, 1),
      unit("bassMakeup", 0, 0, 1),
      unit("masterVolume", 0.5, 0, 1),
      trim("fc1Trim"),
      trim("fc2Trim"),
      trim("qTrim"),
      trim("driveTrim"),
      trim("slopeTrim"),
      trim("edgeTrim"),
    ],
    audioInputs: ["l_audio", "r_audio", "cv1", "cv2", "q_cv", "drive_cv", "slope_cv", "edge_cv"],
    outputs: ["l_audio", "r_audio"],
  },
  {
    name: "vc10-freqshifter-processor", module: "vcvFreqShifter", label: "VCV Frequency Shifter",
    pitchPorts: [], gatePorts: [], controlDivisor: 1,
    construct: [], options: ["range"],
    make: (rate) => new FreqShifterKernel(rate),
    params: [unit("pitch", 0, -5, 5)],
    audioInputs: ["audio", "cv", "audio_r"],
    outputs: ["sin", "cos", "sin_r", "cos_r"],
  },
  {
    name: "vc10-wvco-processor", module: "vcvWvco", label: "VCV WVCO",
    pitchPorts: ["voct"], gatePorts: ["gate"], controlDivisor: 4,
    construct: [],
    options: ["waveform", "snap", "adsrToShape", "adsrToFeedback", "adsrToLevel", "adsrToFm"],
    make: (rate) => new WvcoKernel(rate),
    params: [
      unit("octave", 4, 0, 10),
      unit("frequencyMultiplier", 1, 1, 16),
      unit("fineTune", 0, -12, 12),
      unit("fmDepth", 0, 0, 100),
      unit("linearFmDepth", 0, 0, 100),
      unit("waveshapeGain", 0, 0, 100),
      unit("feedback", 0, 0, 100),
      unit("outputLevel", 100, 0, 100),
      unit("attack", 50, 0, 100),
      unit("decay", 50, 0, 100),
      unit("sustain", 50, 0, 100),
      unit("release", 50, 0, 100),
    ],
    audioInputs: ["voct", "fm", "linear_fm", "gate", "sync", "shape", "linear_fm_depth", "feedback"],
    outputs: ["main"],
  },
  {
    name: "vc10-tangents-processor", module: "vcvTangents", label: "VCV Tangents",
    pitchPorts: ["cutoff"], gatePorts: [], controlDivisor: 1,
    construct: [], options: [],
    make: (rate) => new TangentsKernel(rate),
    params: [
      unit("cutoff", VULT_FC_DEFAULT_HZ, VULT_FC_MIN_HZ, VULT_FC_MAX_HZ),
      trim("cutoffAtten"),
      unit("resonance", 0.3, 0, 1),
      unit("drive", 0, 0, 1),
    ],
    audioInputs: ["lp_in", "bp_in", "hp_in", "cutoff"],
    outputs: ["out"],
  },
  {
    name: "vc10-unstabile-processor", module: "vcvUnstabile", label: "VCV Unstabile",
    pitchPorts: ["cutoff"], gatePorts: [], controlDivisor: 1,
    construct: [], options: [],
    make: (rate) => new UnstabileKernel(rate),
    params: [
      unit("cutoff", VULT_FC_DEFAULT_HZ, VULT_FC_MIN_HZ, VULT_FC_MAX_HZ),
      trim("cutoffAtten"),
      unit("resonance", 0.44, 0, 1),
      unit("semblance", 0.5, 0, 1),
      unit("drive", 0, 0, 1),
    ],
    audioInputs: ["in", "cutoff"],
    outputs: ["lp", "bp", "hp", "sem"],
  },
  {
    name: "vc10-lateralus-processor", module: "vcvLateralus", label: "VCV Lateralus",
    pitchPorts: ["cutoff"], gatePorts: [], controlDivisor: 1,
    construct: [], options: [],
    make: (rate) => new LateralusKernel(rate),
    params: [
      unit("cutoff", VULT_FC_DEFAULT_HZ, VULT_FC_MIN_HZ, VULT_FC_MAX_HZ),
      trim("cutoffAtten"),
      unit("resonance", 0.4, 0, 1),
      unit("drive", 0, 0, 1),
    ],
    audioInputs: ["in", "cutoff"],
    outputs: ["out_24db", "out_18db", "out_12db", "out_6db"],
  },
  {
    name: "vc10-bleak-processor", module: "vcvBleak", label: "VCV Bleak",
    pitchPorts: ["v_oct"], gatePorts: [], controlDivisor: 1,
    construct: [], options: [],
    make: (rate) => new BleakKernel(rate),
    params: [
      unit("tune", 0, -12, 12),
      unit("oct", 0, -3, 3),
      unit("pw", 0.5, 0, 1),
      unit("wave", 0.514, 0, 1),
    ],
    audioInputs: ["v_oct", "pw", "wave"],
    outputs: ["out"],
  },
  {
    name: "vc10-basal-processor", module: "vcvBasal", label: "VCV Basal",
    pitchPorts: ["v_oct"], gatePorts: [], controlDivisor: 1,
    construct: [], options: [],
    make: (rate) => new BasalKernel(rate),
    params: [
      unit("tune", 0, -12, 12),
      unit("oct", 0, -3, 3),
      unit("mod1", 0, -1, 1),
      unit("mod2", 0, 0, 1),
    ],
    audioInputs: ["v_oct", "mod1", "mod2"],
    outputs: ["out"],
  },
  {
    name: "vc10-vessek-processor", module: "vcvVessek", label: "VCV Vessek",
    pitchPorts: ["v_oct"], gatePorts: ["gate"], controlDivisor: 1,
    construct: [], options: ["tuneMode", "glideMode"],
    make: (rate) => new VessekKernel(rate),
    params: [
      unit("tune", 0, -1, 1),
      unit("oct", 0, -3, 3),
      unit("detuneB", 0, -12, 12),
      unit("pwA", 0.5, 0, 1),
      unit("waveA", 0, 0, 1),
      unit("pwB", 0.5, 0, 1),
      unit("waveB", 0, 0, 1),
      unit("mix", 0.5, 0, 1),
      unit("fm", 0, 0, 1),
      unit("am", 0, 0, 1),
      unit("sync", 0, 0, 1),
      unit("shaper", 0, 0, 1),
      unit("offset", 0, -1, 1),
      unit("fade", 0.2, 0, 1),
      unit("glide", 0, 0, 1),
    ],
    audioInputs: ["v_oct", "gate", "ext", "pw_cv", "wave_cv", "fm_cv", "mix_cv"],
    outputs: ["out", "fade"],
  },
  {
    name: "vc10-caudal-processor", module: "vcvCaudal", label: "VCV Caudal",
    pitchPorts: [], gatePorts: ["hit", "rev", "store", "recall"], controlDivisor: 1,
    construct: ["seed"], options: [],
    make: (rate, options) => new CaudalKernel(rate, options),
    params: [unit("speed", 0, 0, 1), unit("energy", 0, 0, 1)],
    audioInputs: ["hit", "rev", "store", "recall", "speed", "energy"],
    outputs: caudalOutputs(),
  },
  {
    name: "vc10-ochd-processor", module: "vcvOchd", label: "Instruo ochd",
    pitchPorts: [], gatePorts: [], controlDivisor: 1,
    construct: [], options: [],
    make: (rate) => new OchdKernel(rate),
    params: [unit("rate", 0.2375, 0, 1), trim("rateAtten")],
    audioInputs: ["rate_cv"],
    outputs: ochdOutputs(),
  },
  {
    name: "vc10-athru-processor", module: "vcvAthru", label: "Instruo athru",
    pitchPorts: [], gatePorts: ["strike"], controlDivisor: 1,
    construct: [], options: ["symmetryMode", "drive"],
    make: (rate) => new AthruKernel(rate),
    params: [
      unit("fold", 0.5, 0, 1),
      trim("foldAtten"),
      // The ONE attenuverter in this block that keeps Rack's zero default, and
      // it is not an exception to D6: at the centre the Symmetry Bias jack is
      // "calibrated to 0 V" by the manual, so zero IS the module's documented
      // neutral rather than a dead cable.
      trim("symmetryAtten", 0),
      unit("strikeDecay", 0.5, 0, 1),
    ],
    audioInputs: ["in", "fold_cv", "symmetry_cv", "strike"],
    outputs: ["out", "thru"],
  },
  {
    name: "vc10-saich-processor", module: "vcvSaich", label: "Instruo saich",
    pitchPorts: saichVoctInputs(), gatePorts: [], controlDivisor: 1,
    construct: [], options: ["wave", "sub", "mixProfile"],
    make: (rate) => new SaichKernel(rate),
    params: [
      unit("coarse", 0, -SAICH_COARSE_SEMITONES, SAICH_COARSE_SEMITONES),
      unit("fine", 0, -1, 1),
      unit("detune2", 0, -1, 1),
      unit("detune3", 0, -1, 1),
      unit("detune4", 0, -1, 1),
      unit("scan", 0.5, 0, 1),
      unit("pw", 0.5, 0, 1),
      trim("cvAtten"),
    ],
    audioInputs: [...saichVoctInputs(), "pwm", "cv", "scan"],
    outputs: ["out"],
  },
];

/**
 * Pure function. The setter method name a discrete option maps to, by
 * CONVENTION rather than by a hand-kept table — option `waveform` is
 * `setWaveform`. The same rule AX-2 states and VC-3b restates; a table would be
 * a second list to forget a row in.
 *
 * @param {string} option - the discrete knob's key
 * @returns {string} the kernel method name
 *
 * @example vc10OptionSetter("waveform") // "setWaveform"
 * @example vc10OptionSetter("mixProfile") // "setMixProfile"
 */
export function vc10OptionSetter(option) {
  return `set${option.charAt(0).toUpperCase()}${option.slice(1)}`;
}

/** Re-exported so `core/audio_specs_vc10.js` can be pinned against ONE tuning
 *  law rather than restating it — that file may not import synth/**, so the
 *  test imports both and asserts they agree. */
export { squinkySemitonesToHz, vultCvToHz };

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient.
// The guard is what lets modules_vc10.js and the tests import the roster above
// from the main thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of VC10_PROCESSORS) {
    registerProcessor(entry.name, class extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return entry.params;
      }

      constructor(options) {
        super();
        const built = options.processorOptions ?? {};
        this.kernel = entry.make(sampleRate, built);
        // OPTIONS ARE APPLIED HERE, NOT ONLY BY MESSAGE — AX-2 measured why: a
        // `port.postMessage` sent the instant the node is built does not
        // necessarily arrive before the first `process()`, and an
        // OfflineAudioContext renders faster than the message hop. Anything the
        // caller knows at construction is applied at construction. Idempotent.
        for (const option of entry.options) {
          if (built[option] !== undefined) this.setOption(option, built[option]);
        }
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
        // THE PER-PORT SCALES, resolved ONCE at construction (see the header for
        // the three kinds). A per-sample lookup would be an allocation-free but
        // pointless string compare in the inner loop.
        const pitch = new Set(entry.pitchPorts);
        const gate = new Set(entry.gatePorts);
        this.inputScale = Float64Array.from(this.inputNames, (name) => (
          pitch.has(name) ? 1 : gate.has(name) ? VC10_GATE_SCALE_VOLTS : RACK_VOLTS_PER_UNIT
        ));
        this.outputScale = Float64Array.from(entry.outputs, (name) => (
          pitch.has(name) ? 1 : gate.has(name) ? 1 / VC10_GATE_SCALE_VOLTS : 1 / RACK_VOLTS_PER_UNIT
        ));
        this.frame = new Float64Array(entry.outputs.length);
        // THE CONTROL DIVIDER (D4). It counts SAMPLES and is deliberately not
        // reset per quantum: a divisor that does not divide 128 is not
        // quantum-aligned, and pretending it is would drift a fraction of a
        // period every block.
        this.controlDivisor = entry.controlDivisor;
        this.tick = 0;
        this.port.onmessage = (event) => this.setOption(event.data.option, event.data.value);
      }

      /** Command. Apply one discrete option to the kernel, by the naming
       *  convention `vc10OptionSetter` states. LOUD if the kernel lacks it. */
      setOption(option, value) {
        const setter = vc10OptionSetter(option);
        if (typeof this.kernel[setter] !== "function") {
          throw new Error(`${entry.name}: kernel has no ${setter} for option ${JSON.stringify(option)}`);
        }
        this.kernel[setter](value);
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
        // D3: an UNCONNECTED input arrives as a zero-length channel list. Only
        // channel 0 is read — our wire is mono (D8), and a stereo source feeding
        // one of these is summed upstream by the graph, not here.
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
          // R7-UNITS: one of the TWO places a scale is applied (the other is the
          // write below), and the scale is per PORT KIND rather than global. A
          // third site anywhere would mean some path is scaled twice, and a
          // factor of five is inaudible on one module and catastrophic across a
          // patch.
          for (let n = 0; n < inputNames.length; n++) {
            const channel = channels[n];
            signals[inputNames[n]] = channel === null ? 0 : channel[i] * this.inputScale[n];
          }
          if (this.tick === 0) this.kernel.control(knobs, signals, wired);
          this.kernel.sample(knobs, signals, wired, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o] * this.outputScale[o];
          this.tick = this.tick + 1 >= this.controlDivisor ? 0 : this.tick + 1;
        }
        return true;
      }
    });
  }
}
