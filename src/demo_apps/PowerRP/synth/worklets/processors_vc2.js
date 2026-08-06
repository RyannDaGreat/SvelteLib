/**
 * THE VC-2 AUDIOWORKLET PROCESSORS — sixteen VCV Rack modules on the audio thread.
 *
 * ── WHY A BLOCK-LOCAL WORKLET FILE ──────────────────────────────────────────
 * The same reason AX-2's and AX-3's exist: several porting agents land module
 * sets concurrently, and one shared worklet file is one merge conflict per agent
 * per save. The engine `addModule`s each block's file; the AudioWorklet global
 * scope is SHARED, so `registerProcessor` names must be globally unique — hence
 * the `vc2-` prefix on every one.
 *
 * ── THIS FILE STATICALLY IMPORTS ITS KERNELS, AND THAT IS MEASURED ──────────
 * `processors.js` (the v1 set) states that a worklet "must not import anything".
 * AX-2 measured otherwise on this repo's own Chrome: an `addModule`'d script with
 * a static import loaded, instantiated and rendered. So `../vc2_kernels.js` is
 * the ONE copy of this block's arithmetic and this file is only the bridge —
 * which is what lets `tests/port_vc2_test.js` measure the ladder in bare node.
 *
 * THE PRICE, AND IT IS NOT OPTIONAL: the URL that loads this module MUST go
 * through Vite's `?worker&url` pipeline, and that specifier lives in
 * `synth/worklet_urls.js` and nowhere else. Read that file's header: a plain
 * `new URL(...)` copies this file verbatim into `dist`, its import of
 * `../vc2_kernels.js` 404s, `addModule` rejects, and there is NO AUDIO AT ALL off
 * a build that exited 0. This block does not export its own URL.
 *
 * ── REAL-TIME SAFETY ───────────────────────────────────────────────────────
 * `process()` runs every 128 samples. ZERO allocations in it: the controls
 * object, the input frame, the output frame and the parameter-array slots are
 * built in the constructor and mutated in place. No `new`, no template literals
 * (the kernels that index controls by name build their key arrays at construction
 * for exactly this reason), no closures. Always `return true`.
 *
 * ── THERE IS NO K-RATE BRIDGE HERE, AND THAT IS THE DIFFERENCE FROM AX-2 ────
 * Axoloti has a 3000 Hz control rate, so AX-2's processor calls `control()` eight
 * times per quantum and `sample()` per sample. Rack's `process(const
 * ProcessArgs&)` runs at the SAMPLE rate throughout — the only sub-rate work is
 * inside a `dsp::ClockDivider`, and each kernel owns its own divider (VC-2 law
 * L4). So this loop is one call per sample and nothing else, and a kernel that
 * needs a divider has one where Rack has one.
 *
 * ── TWO KINDS OF INPUT, AND WHY BOTH EXIST ─────────────────────────────────
 *   AUDIO inputs   real AudioWorkletNode inputs, addressed BY INDEX. A signal
 *                  path (a VCF's `in`, a mixer's four channels). `modules_vc2.js`
 *                  gives each one a tap gain so a port NAME can reach an index.
 *   PARAM inputs   a-rate AudioParams named `in_<port>`. Every CV/gate/pitch
 *                  input. a-rate, not k-rate: a k-rate param delivers ONE value
 *                  per quantum, which would sample a gate at 375 Hz and lose
 *                  short triggers outright.
 * VC-2 law L3: a spec input `k` is the param `in_k`, a spec knob `k` is the param
 * `k`, they are NEVER the same param, and the kernel combines them with the
 * module's own C++ line. See `vc2_kernels.js`'s header for why Rack's structure
 * forces that.
 */

import {
  AdsrKernel, AudioInterfaceKernel, CompareKernel, DelayKernel, LfoKernel, NoiseKernel,
  OctaveKernel, QuantizerKernel, RandomKernel, RescaleKernel, SequentialSwitch2Kernel,
  Seq3Kernel, SumKernel, VcaKernel, VcfKernel, VcMixerKernel, MAX_CHANNELS,
  QUANTIZER_ALL_NOTES,
} from "../vc2_kernels.js";

/**
 * AN INPUT PORT AS AN AudioParam — the `in_<port>` half of law L3, in one of the
 * FOUR unit kinds R7-UNITS defines. There is a helper per kind rather than one
 * `cv()` for all of them, because the kind IS the bound: a bound copied from the
 * wrong kind is a wire that silently saturates.
 *
 * Every bound below is what Rack's ±10 V CABLE MAXIMUM becomes in that kind's
 * unit, never what the module's own clamp is — the module clamps; the wire does
 * not, and a narrower bound here would discard signal the recurrence is written
 * to handle.
 *
 * @param {string} port - the spec's input key
 * @returns {object} an AudioWorkletNode parameter descriptor
 */
const input = (port, minValue, maxValue) => ({
  name: `in_${port}`, defaultValue: 0, minValue, maxValue, automationRate: "a-rate",
});

/** LEVEL: audio and generic bipolar CV. ±10 V over law L1's 5. */
const levelIn = (port) => input(port, -CABLE_LEVEL, CABLE_LEVEL);

/** LOGIC: a gate or trigger, 0…1 (clause 4). Unipolar — a negative gate is not a
 *  thing Rack can send, and allowing one here would invite a wire that reads as
 *  "less than off". */
const gateIn = (port) => input(port, 0, GATE_HIGH);

/** V/OCT: semitones, so the cable's ±10 V is ±120 semitones — ten octaves either
 *  way, which is more than any oscillator in the library can track and is
 *  deliberately the CABLE's limit rather than a musical one. */
const pitchIn = (port) => input(port, -CABLE_SEMITONES, CABLE_SEMITONES);

/** NORMALISED DEPTH: the wire carries the modulation itself, so the cable's
 *  ±10 V is ±1. */
const depthIn = (port) => input(port, -1, 1);

/** A knob as an AudioParam: Rack's own range and default (law L2). */
const knob = (name, defaultValue, minValue, maxValue) => ({
  name, defaultValue, minValue, maxValue, automationRate: "a-rate",
});

/** A 0/1 switch knob — Rack's `configSwitch` and its `dataToJson` booleans. */
const toggle = (name, defaultValue) => knob(name, defaultValue, 0, 1);

/** Rack's cable maximum, ±10 V (`engine::Port`'s documented range), and what it
 *  becomes in each of R7-UNITS' kinds. THE THREE NUMBERS ARE ONE FACT: a cable
 *  cannot carry more than 10 V, whatever the wire's unit calls it. */
const CABLE_MAX_VOLTS = 10;
const VOLTS_PER_AUDIO_UNIT = 5;
const SEMITONES_PER_OCTAVE = 12;
const CABLE_LEVEL = CABLE_MAX_VOLTS / VOLTS_PER_AUDIO_UNIT;
const CABLE_SEMITONES = CABLE_MAX_VOLTS * SEMITONES_PER_OCTAVE;

/** A gate's HIGH value, 0…1 (R7-UNITS clause 4 — logic is not level). */
const GATE_HIGH = 1;

/** A CV jack's ASSUMED depth when nothing is patched — deviation D10's knob. 1 is
 *  unity, i.e. Rack's own 10 V, which is what reproduces its
 *  `isConnected() == false` branch exactly. */
const ASSUMED_DEPTH = 1;

/** How far a CV jack's assumed depth may be pushed. Rack's channel CV is floored
 *  at zero and NOT capped, so 2 is a real setting (a 20 V equivalent, +6 dB) and
 *  the range says so rather than quietly capping at unity. */
const ASSUMED_DEPTH_MAX = 2;

/** `VCF.cpp` computes its dial bounds from an 8 Hz…22 kHz span, so law L2's knob
 *  IS that span, and its default dial of 0.5 is `C4·2^0` — middle C exactly. */
const VCF_FREQ_MIN_HZ = 8;
const VCF_FREQ_MAX_HZ = 22000;
const VCF_FREQ_DEFAULT_HZ = 261.6256;

/** `Delay.cpp`'s dial is `time = 0.001·10000^p`, so law L2's knob is 1 ms…10 s and
 *  its `timeDefault` of `log10(500)/4` is half a second. */
const DELAY_TIME_MIN_SECONDS = 0.001;
const DELAY_TIME_MAX_SECONDS = 10;
const DELAY_TIME_DEFAULT_SECONDS = 0.5;

/** `Random.cpp`: `configParam(RATE_PARAM, log2(0.002f), log2(2000.f), log2(2.f))`,
 *  i.e. 0.002…2000 Hz with a 2 Hz default — which is the number five nodes in
 *  `core/audio_patches_vcv_ambient.js` already set. */
const RANDOM_RATE_MIN_HZ = 0.002;
const RANDOM_RATE_MAX_HZ = 2000;
const RANDOM_RATE_DEFAULT_HZ = 2;

/** `ADSR.cpp`'s `MIN_TIME`/`MAX_TIME`, and its 0.5 dial default in seconds. */
const ADSR_TIME_MIN_SECONDS = 1e-3;
const ADSR_TIME_MAX_SECONDS = 10;
const ADSR_TIME_DEFAULT_SECONDS = 0.1;

/** `VCMixer.cpp`: the channel faders are `0 … M_SQRT2` (square law, +6 dB at the
 *  top) and the mix fader is `0 … 2` (linear, +6 dB at the top). */
const VCMIXER_CH_MAX = Math.SQRT2;
const VCMIXER_MIX_MAX = 2;

/** `Compare.cpp`, `Rescale.cpp`: a voltage-valued knob spans the cable — ±10 V,
 *  which is ±2 in the LEVEL unit those knobs are compared against. */
const VOLTAGE_KNOB_MAX = CABLE_LEVEL;

/** `Octave.cpp`: `configParam(OCTAVE_PARAM, -4.f, 4.f, 0.f, "Shift", " oct")`. */
const OCTAVE_SHIFT_RANGE = 4;

/** `SEQ3.cpp`: `configParam(TEMPO_PARAM, -2.f, 4.f, 1.f, …, 2.f, 60.f)` — a
 *  log2-Hz dial DISPLAYED in bpm, which is the unit law L2 keeps: 0.25…16 Hz is
 *  15…960 bpm, and the 1.0 default is 120. */
const SEQ3_TEMPO_MIN_BPM = 15;
const SEQ3_TEMPO_MAX_BPM = 960;
const SEQ3_TEMPO_DEFAULT_BPM = 120;

/** `LFO.cpp`: `configParam(FREQ_PARAM, -8.f, 10.f, 1.f, …)`, log2 Hz against a
 *  `clockFreq/2` base of 1 — so the span is 2^-8…2^10 Hz and the default is 2. */
const LFO_FREQ_MIN_HZ = 2 ** -8;
const LFO_FREQ_MAX_HZ = 2 ** 10;
const LFO_FREQ_DEFAULT_HZ = 2;

/** An attenuverter (`*_CV_PARAM`): ±1, and DEFAULT 0 in Rack 2 — see the
 *  kernels' law L3 note on why a fresh module ignores its CV inputs. */
const attenuverter = (name) => knob(name, 0, -1, 1);

/** `SEQ3.cpp` is the exception: `configParam(TEMPO_CV_PARAM, 0.f, 1.f, 1.f)` and
 *  the same for STEPS — unipolar, and defaulting to FULLY OPEN. */
const unipolarTrim = (name) => knob(name, 1, 0, 1);

/** A LEVEL-valued knob (`Compare`'s B offset, `Rescale`'s offset and limits). */
const voltageKnob = (name, defaultValue) => knob(name, defaultValue, -VOLTAGE_KNOB_MAX, VOLTAGE_KNOB_MAX);

/** SEQ3's per-step CV knobs. IN SEMITONES, not in the level unit, and that is a
 *  judgement worth stating: their knob is a raw ±10 V, but SEVEN of this block's
 *  CV inputs are V/oct (quantizer pitch, octave pitch, VCF cutoff, LFO fm, Random
 *  rate, Delay time, SEQ3 tempo) against two that are normalised depths — so the
 *  unit that makes `SEQ3 → pitch` work with no arithmetic is semitones, and that
 *  patch is what a CV sequencer is FOR. ±120 st is their ±10 V exactly. */
const stepCvKnob = (name) => knob(name, 0, -CABLE_SEMITONES, CABLE_SEMITONES);

/** Pure function. `SEQ3`'s 24 CV knobs and 8 gate toggles, generated rather than
 *  written out — 32 near-identical descriptors is 32 chances to mistype an index,
 *  and the spec generates its Inspector rows from the same two loops.
 *
 *  @returns {object[]} `cv1_1 … cv3_8` then `gate1 … gate8`
 *
 *  @example seq3StepParams().length // 32
 *  @example seq3StepParams()[0].name // "cv1_1"
 *  @example seq3StepParams()[24].name // "gate1"
 */
export function seq3StepParams() {
  const params = [];
  for (let row = 1; row <= SEQ3_CV_ROWS; row++) {
    for (let step = 1; step <= SEQ3_STEP_COUNT; step++) params.push(stepCvKnob(`cv${row}_${step}`));
  }
  for (let step = 1; step <= SEQ3_STEP_COUNT; step++) params.push(toggle(`gate${step}`, 1));
  return params;
}

/** `ENUMS(CV_PARAMS, 3 * 8)` — three rows of eight. Restated here because the
 *  kernel's copy is private to it and this file may not import a private. */
const SEQ3_CV_ROWS = 3;
const SEQ3_STEP_COUNT = 8;

/** `LFO.cpp`: `configParam(PW_PARAM, 0.01f, 0.99f, 0.5f, …)`. */
const LFO_PW_MIN_PARAM = 0.01;
const LFO_PW_MAX_PARAM = 0.99;

/** `SequentialSwitch.cpp`: `configSwitch(STEPS_PARAM, 0.0, 2.0, 2.0, "Steps",
 *  {"2","3","4"})` — the dial is 0/1/2 and the length is `2 + dial`. */
const SWITCH_STEPS_DEFAULT = 2;
const SWITCH_STEPS_MAX = 2;

/** `Rescale.cpp`'s context-menu gain multiplier: 1×, 10×, 100×, 1000×. */
const RESCALE_MAX_MULTIPLIER = 1000;

/** Pure function. `Sum`'s sixteen unrolled poly inputs (deviation D3).
 *
 *  @returns {string[]} `poly1 … poly16`
 *
 *  @example sumInputPorts().length // 16
 *  @example sumInputPorts()[0] // "poly1"
 */
export function sumInputPorts() {
  const ports = [];
  for (let i = 1; i <= MAX_CHANNELS; i++) ports.push(`poly${i}`);
  return ports;
}

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name         the `registerProcessor` id, globally unique across worklet files
 *   module       the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label        `meta.label`
 *   make         `(sampleRate, options) -> kernel`
 *   audioInputs  AudioWorkletNode inputs, in INDEX order; port names
 *   params       every AudioParam: knobs (law L2) and `in_*` CV inputs (law L3)
 *   inputs       which spec input ports exist, in card order — a name here is
 *                either an `audioInputs` entry or an `in_<name>` param
 *   construct    knobs passed as `processorOptions` (a seed cannot be a param)
 *   options      discrete knobs set by message, applied through `vc2OptionSetter`
 *   outputs      output port names, in output-index order
 *
 * `modules_vc2.js` builds its sixteen factories FROM THIS ARRAY and
 * `tests/port_vc2_test.js` checks it against `core/audio_specs_vc2.js`, so a
 * param renamed here cannot leave a module wired to the old name. The roster
 * lives on the WORKLET side because the worklet cannot import from the main
 * thread while the reverse is fine.
 */
export const VC2_PROCESSORS = [
  {
    name: "vc2-audiointerface-processor", module: "vcvAudioInterface", label: "VCV Audio",
    make: (rate) => new AudioInterfaceKernel(rate),
    audioInputs: ["audio1"], inputs: ["audio1"], construct: [], options: [],
    params: [knob("level", 1, 0, VCMIXER_MIX_MAX), toggle("dcFilter", 1)],
    outputs: ["out"],
  },
  {
    name: "vc2-vca-processor", module: "vcvVca", label: "VCV VCA",
    make: () => new VcaKernel(),
    audioInputs: ["in"], inputs: ["in", "cv"], construct: [], options: ["response"],
    params: [knob("level", 1, 0, 1), knob("cv", ASSUMED_DEPTH, 0, 1), depthIn("cv")],
    outputs: ["out"],
  },
  {
    name: "vc2-noise-processor", module: "vcvNoise", label: "VCV Noise",
    make: (rate, options) => new NoiseKernel(rate, options),
    audioInputs: [], inputs: [], construct: ["seed"], options: [],
    params: [],
    outputs: ["white", "pink", "red", "violet", "blue", "black"],
  },
  {
    name: "vc2-octave-processor", module: "vcvOctave", label: "VCV Octave",
    make: () => new OctaveKernel(),
    audioInputs: [], inputs: ["pitch", "octave"], construct: [], options: [],
    params: [
      knob("octave", 0, -OCTAVE_SHIFT_RANGE, OCTAVE_SHIFT_RANGE),
      pitchIn("pitch"), pitchIn("octave"),
    ],
    outputs: ["pitch"],
  },
  {
    name: "vc2-quantizer-processor", module: "vcvQuantizer", label: "VCV Quantizer",
    make: () => new QuantizerKernel(),
    // NO `offset` INPUT. `Quantizer.cpp`'s `enum InputIds` is PITCH_INPUT and
    // nothing else — its Offset is a param with no jack — and both placeholder sets
    // (`core/audio_stubs_vcv_generative.js`, `_classic.js`) declare it that way and
    // asked VC-2 to drop the phantom port when it landed. This is that.
    audioInputs: [], inputs: ["pitch"], construct: [], options: [],
    params: [
      knob("mask", QUANTIZER_ALL_NOTES, 0, QUANTIZER_ALL_NOTES),
      // `configParam(OFFSET_PARAM, -1.f, 1.f, …, 12.f)` — a ±1 V knob whose own
      // DISPLAY multiplier is 12, i.e. Rack already calls it semitones on the
      // panel. R7-UNITS makes the wire agree with the panel.
      knob("offset", 0, -SEMITONES_PER_OCTAVE, SEMITONES_PER_OCTAVE),
      pitchIn("pitch"),
    ],
    outputs: ["pitch"],
  },
  {
    name: "vc2-vcf-processor", module: "vcvVcf", label: "VCV Ladder Filter",
    make: (rate, options) => new VcfKernel(rate, options),
    audioInputs: ["in"], inputs: ["in", "freq", "res", "drive"],
    construct: ["seed"], options: [],
    params: [
      knob("freq", VCF_FREQ_DEFAULT_HZ, VCF_FREQ_MIN_HZ, VCF_FREQ_MAX_HZ),
      knob("res", 0, 0, 1),
      knob("drive", 0, -1, 1),
      attenuverter("freqCv"), attenuverter("resCv"), attenuverter("driveCv"),
      pitchIn("freq"), depthIn("res"), depthIn("drive"),
    ],
    outputs: ["lpf", "hpf"],
  },
  {
    name: "vc2-adsr-processor", module: "vcvAdsr", label: "VCV ADSR",
    make: (rate) => new AdsrKernel(rate),
    audioInputs: [],
    inputs: ["gate", "retrig", "attack", "decay", "sustain", "release"],
    construct: [], options: [],
    params: [
      knob("attack", ADSR_TIME_DEFAULT_SECONDS, ADSR_TIME_MIN_SECONDS, ADSR_TIME_MAX_SECONDS),
      knob("decay", ADSR_TIME_DEFAULT_SECONDS, ADSR_TIME_MIN_SECONDS, ADSR_TIME_MAX_SECONDS),
      knob("sustain", 0.5, 0, 1),
      knob("release", ADSR_TIME_DEFAULT_SECONDS, ADSR_TIME_MIN_SECONDS, ADSR_TIME_MAX_SECONDS),
      attenuverter("attackCv"), attenuverter("decayCv"),
      attenuverter("sustainCv"), attenuverter("releaseCv"),
      toggle("push", 0),
      gateIn("gate"), gateIn("retrig"),
      depthIn("attack"), depthIn("decay"), depthIn("sustain"), depthIn("release"),
    ],
    outputs: ["envelope"],
  },
  {
    name: "vc2-lfo-processor", module: "vcvLfo", label: "VCV LFO",
    make: (rate) => new LfoKernel(rate),
    audioInputs: [], inputs: ["fm", "pw", "clock", "reset"], construct: [], options: [],
    params: [
      knob("freq", LFO_FREQ_DEFAULT_HZ, LFO_FREQ_MIN_HZ, LFO_FREQ_MAX_HZ),
      attenuverter("fm"),
      knob("pw", 0.5, LFO_PW_MIN_PARAM, LFO_PW_MAX_PARAM),
      attenuverter("pwm"),
      toggle("offset", 1), toggle("invert", 0),
      pitchIn("fm"), depthIn("pw"), gateIn("clock"), gateIn("reset"),
    ],
    outputs: ["sin", "tri", "saw", "sqr"],
  },
  {
    name: "vc2-vcmixer-processor", module: "vcvVcMixer", label: "VCV VC Mixer",
    make: () => new VcMixerKernel(),
    audioInputs: ["ch1", "ch2", "ch3", "ch4"],
    // Interleaved ch/cv, matching VCV_VCMIXER_SPEC's card order — the factory maps
    // by name so order is cosmetic here, but two lists in different orders are two
    // lists someone will one day assume agree.
    inputs: ["ch1", "cv1", "ch2", "cv2", "ch3", "cv3", "ch4", "cv4", "mixCv"],
    construct: [], options: [],
    params: [
      knob("lvl1", 1, 0, VCMIXER_CH_MAX), knob("lvl2", 1, 0, VCMIXER_CH_MAX),
      knob("lvl3", 1, 0, VCMIXER_CH_MAX), knob("lvl4", 1, 0, VCMIXER_CH_MAX),
      knob("mixLvl", 1, 0, VCMIXER_MIX_MAX),
      knob("cv1", ASSUMED_DEPTH, 0, ASSUMED_DEPTH_MAX),
      knob("cv2", ASSUMED_DEPTH, 0, ASSUMED_DEPTH_MAX),
      knob("cv3", ASSUMED_DEPTH, 0, ASSUMED_DEPTH_MAX),
      knob("cv4", ASSUMED_DEPTH, 0, ASSUMED_DEPTH_MAX),
      knob("mixCv", ASSUMED_DEPTH, 0, ASSUMED_DEPTH_MAX),
      toggle("chExp", 0), toggle("mixExp", 0),
      depthIn("cv1"), depthIn("cv2"), depthIn("cv3"), depthIn("cv4"), depthIn("mixCv"),
    ],
    outputs: ["mix", "ch1", "ch2", "ch3", "ch4"],
  },
  {
    name: "vc2-delay-processor", module: "vcvDelay", label: "VCV Delay",
    make: (rate) => new DelayKernel(rate),
    audioInputs: ["in"],
    inputs: ["in", "time", "feedback", "tone", "mix", "clock"],
    construct: [], options: [],
    params: [
      knob("time", DELAY_TIME_DEFAULT_SECONDS, DELAY_TIME_MIN_SECONDS, DELAY_TIME_MAX_SECONDS),
      knob("feedback", 0.5, 0, 1), knob("tone", 0.5, 0, 1), knob("mix", 0.5, 0, 1),
      attenuverter("timeCv"), attenuverter("feedbackCv"),
      attenuverter("toneCv"), attenuverter("mixCv"),
      pitchIn("time"), depthIn("feedback"), depthIn("tone"), depthIn("mix"), gateIn("clock"),
    ],
    outputs: ["mix", "wet"],
  },
  {
    name: "vc2-random-processor", module: "vcvRandom", label: "VCV Random",
    make: (rate, options) => new RandomKernel(rate, options),
    audioInputs: ["external"],
    inputs: ["trig", "external", "rate", "shape", "prob", "rand"],
    construct: ["seed"], options: ["source"],
    params: [
      knob("rate", RANDOM_RATE_DEFAULT_HZ, RANDOM_RATE_MIN_HZ, RANDOM_RATE_MAX_HZ),
      knob("shape", 1, 0, 1), knob("prob", 1, 0, 1), knob("rand", 1, 0, 1),
      toggle("offset", 0),
      attenuverter("rateCv"), attenuverter("shapeCv"),
      attenuverter("probCv"), attenuverter("randCv"),
      gateIn("trig"), pitchIn("rate"), depthIn("shape"), depthIn("prob"), depthIn("rand"),
    ],
    outputs: ["stepped", "linear", "smooth", "exponential", "trig"],
  },
  {
    name: "vc2-seq3-processor", module: "vcvSeq3", label: "VCV SEQ3",
    make: (rate) => new Seq3Kernel(rate),
    audioInputs: [],
    inputs: ["clock", "reset", "run", "tempo", "steps"],
    construct: [], options: [],
    params: [
      knob("tempo", SEQ3_TEMPO_DEFAULT_BPM, SEQ3_TEMPO_MIN_BPM, SEQ3_TEMPO_MAX_BPM),
      unipolarTrim("tempoCv"),
      knob("steps", SEQ3_STEP_COUNT, 1, SEQ3_STEP_COUNT),
      unipolarTrim("stepsCv"),
      toggle("running", 1), toggle("clockPassthrough", 0),
      ...seq3StepParams(),
      gateIn("clock"), gateIn("reset"), gateIn("run"), pitchIn("tempo"),
      // STEPS IS A COUNT, not a voltage and not a pitch: Rack sums it in volts
      // where 1 V is one step, and `SEQ3`'s own `steps` OUTPUT emits
      // `numSteps − 1` for exactly this port. So the wire carries steps.
      input("steps", -SEQ3_STEP_COUNT, SEQ3_STEP_COUNT),
    ],
    outputs: [
      "cv1", "cv2", "cv3", "trig", "steps", "clock", "run", "reset",
      "step1", "step2", "step3", "step4", "step5", "step6", "step7", "step8",
    ],
  },
  {
    name: "vc2-switch2-processor", module: "vcvSequentialSwitch2", label: "VCV Sequential Switch 2",
    make: (rate) => new SequentialSwitch2Kernel(rate),
    audioInputs: ["in1", "in2", "in3", "in4"],
    inputs: ["in1", "in2", "in3", "in4", "clock", "reset"],
    construct: [], options: [],
    params: [
      knob("steps", SWITCH_STEPS_DEFAULT, 0, SWITCH_STEPS_MAX), toggle("declick", 0),
      gateIn("clock"), gateIn("reset"),
    ],
    outputs: ["out"],
  },
  {
    name: "vc2-compare-processor", module: "vcvCompare", label: "VCV Compare",
    make: () => new CompareKernel(),
    audioInputs: ["a"], inputs: ["a", "b"], construct: [], options: [],
    params: [voltageKnob("b", 0), levelIn("b")],
    outputs: ["max", "min", "clip", "lim", "clipgate", "limgate", "greater", "less"],
  },
  {
    name: "vc2-sum-processor", module: "vcvSum", label: "VCV Sum",
    make: () => new SumKernel(),
    audioInputs: sumInputPorts(), inputs: sumInputPorts(), construct: [], options: [],
    params: [knob("level", 1, 0, 1)],
    outputs: ["mono"],
  },
  {
    name: "vc2-rescale-processor", module: "vcvRescale", label: "VCV Rescale",
    make: () => new RescaleKernel(),
    audioInputs: ["in"], inputs: ["in"], construct: [], options: [],
    params: [
      knob("gain", 0, -1, 1),
      knob("multiplier", 1, 1, RESCALE_MAX_MULTIPLIER),
      voltageKnob("offset", 0),
      voltageKnob("min", -VOLTAGE_KNOB_MAX), voltageKnob("max", VOLTAGE_KNOB_MAX),
      toggle("reflectMin", 0), toggle("reflectMax", 0),
    ],
    outputs: ["out"],
  },
];

/**
 * Pure function. The kernel method a discrete option maps to, BY CONVENTION
 * rather than by a table — option `response` is `setResponse`. AX-2 established
 * this spelling; a table would be a second list to forget a row in.
 *
 * @param {string} option - the discrete knob's key
 * @returns {string} the kernel method name
 *
 * @example vc2OptionSetter("response") // "setResponse"
 * @example vc2OptionSetter("source") // "setSource"
 */
export function vc2OptionSetter(option) {
  return `set${option.charAt(0).toUpperCase()}${option.slice(1)}`;
}

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The
// guard is what lets modules_vc2.js and the tests import the roster above from
// the main thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of VC2_PROCESSORS) {
    registerProcessor(entry.name, class extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return entry.params;
      }

      constructor(options) {
        super();
        const built = options.processorOptions ?? {};
        this.kernel = entry.make(sampleRate, built);
        // OPTIONS ARE APPLIED HERE, NOT ONLY BY MESSAGE, for the reason AX-2
        // MEASURED: a `postMessage` sent the instant the node is built can lose
        // the race with the first `process()` (an OfflineAudioContext renders
        // faster than the message hop), and a module built as `exp4` rendered
        // `linear` for its opening frames. Idempotent.
        for (const option of entry.options) {
          if (built[option] !== undefined) this.setOption(option, built[option]);
        }
        this.names = entry.params.map((p) => p.name);
        this.arrays = new Array(this.names.length).fill(null);
        this.controls = {};
        for (const name of this.names) this.controls[name] = 0;
        this.frame = new Float64Array(entry.outputs.length);
        this.ins = new Float64Array(entry.audioInputs.length);
        this.port.onmessage = (event) => this.setOption(event.data.option, event.data.value);
      }

      /** Command. Apply one discrete option to the kernel, by the naming
       *  convention `vc2OptionSetter` states. LOUD if the kernel lacks it. */
      setOption(option, value) {
        const setter = vc2OptionSetter(option);
        if (typeof this.kernel[setter] !== "function") {
          throw new Error(`${entry.name}: kernel has no ${setter} for option ${JSON.stringify(option)}`);
        }
        this.kernel[setter](value);
      }

      process(inputs, outputs, parameters) {
        const frames = outputs[0][0].length;
        const names = this.names;
        const arrays = this.arrays;
        const controls = this.controls;
        const ins = this.ins;
        for (let n = 0; n < names.length; n++) arrays[n] = parameters[names[n]];
        for (let i = 0; i < frames; i++) {
          for (let n = 0; n < names.length; n++) {
            const values = arrays[n];
            controls[names[n]] = values.length === 1 ? values[0] : values[i];
          }
          // AN UNCONNECTED WORKLET INPUT IS AN EMPTY ARRAY, not an array of
          // zeros — `inputs[k]` is `[]` when nothing is patched, so indexing
          // `[0][i]` would throw on every unwired signal port. Reading 0 is not
          // a silent fallback: an unpatched jack in Rack IS 0 V.
          for (let n = 0; n < ins.length; n++) {
            const channels = inputs[n];
            ins[n] = channels.length > 0 ? channels[0][i] : 0;
          }
          this.kernel.sample(controls, ins, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o];
        }
        return true;
      }
    });
  }
}
