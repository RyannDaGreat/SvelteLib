/**
 * THE VC-1 AUDIOWORKLET PROCESSORS — the AudibleInstruments nodes on the audio thread.
 *
 * ── WHY A FOURTH WORKLET FILE ───────────────────────────────────────────────
 * Same reason `processors_ax2.js` gives: several agents port module sets concurrently, so
 * one shared worklet file is one merge conflict per agent per save. The engine loads them
 * all with `addModule`; the AudioWorklet global scope is SHARED, so `registerProcessor`
 * names must be globally unique — hence the `vc1-` prefix.
 *
 * This file imports `../vc1_kernels.js`, which is measured-safe here (see
 * `processors_ax2.js`'s header: an `addModule`'d script with a static import loaded,
 * instantiated and rendered on this repo's Chrome) and is load-bearing rather than
 * cosmetic — the alternative was duplicating a granular engine and a 64-mode resonator
 * into a file no bare-node test can import.
 *
 * ── THE BRIDGE THIS FILE IS FOR, AND HOW IT DIFFERS FROM AX-2's ─────────────
 * AX-2's Axoloti kernels are `control()` every 16 samples plus `sample()` per sample,
 * because that is Axoloti's architecture. A VCV Rack module is BLOCK-based at its OWN
 * sample rate: Clouds renders 32 frames at 32 kHz, Rings 24 at 48 kHz. So a VC-1 kernel
 * declares `internalRate` and `blockSize`, and this file owns two things around it:
 *
 *  1. **THE RESAMPLING.** A kernel with a non-null `internalRate` gets a `Resampler` on
 *     each side (kernels' deviation D2, which states what that costs). A kernel with a
 *     NULL `internalRate` runs at the context's rate with no conversion at all, and
 *     declares `blockSize = 1` if it is a per-sample module — which Branches, Blinds and
 *     Shades are, because Rack runs them per sample and a 128-sample block would put
 *     2.7 ms of jitter on a Bernoulli gate's timing.
 *  2. **PARAMETER SAMPLING.** Every a-rate AudioParam is read at each BLOCK boundary,
 *     which is what Rack does too: a Rack module reads `params[X].getValue()` once per
 *     `process()` call and `process()` is its block. For `blockSize = 1` that is
 *     per-sample, so nothing is lost where it matters.
 *
 * ── REAL-TIME SAFETY (the checklist `processors.js` sets) ───────────────────
 * `process()` runs every 128 samples. Zero allocations in it: the control object, the
 * frame buffers and the parameter-array slots are built in the constructor and mutated in
 * place. No `new`, no literals, no closures. Always `return true`.
 *
 * ── AUDIO INPUTS ARE REAL INPUTS HERE, UNLIKE AX-2 ─────────────────────────
 * AX-2's nodes are all sources, so its processors declare `numberOfInputs: 0` and every
 * wireable control is an a-rate param. Half of VC-1's nodes PROCESS audio, and several
 * take more than one audio port (Clouds' L and R, Blinds' four in/cv pairs). So a row
 * declares `audioInputs` — port names in input-INDEX order — and the module factory hands
 * `engine.connect` a `{node, index}`, which `engine.resolvePort` already supports for
 * exactly this reason (it was built for sample&hold's trigger input).
 */

import {
  BlindsKernel, BranchesKernel, CloudsKernel, MarblesKernel, Resampler, RingsKernel,
  RipplesKernel, ShadesKernel, SupercellKernel,
} from "../vc1_kernels.js";

/** Frames per `process()` call, which the spec fixes at 128 — the resamplers' ring
 *  buffers must hold more than one quantum's worth of either rate. */
const QUANTUM = 128;

/** The resampler ring's length, in frames. Generous rather than tight: a 32 kHz kernel
 *  consuming a 48 kHz quantum needs 128·(32/48) rounded up plus the Hermite kernel's
 *  three-frame tail, and a power of two keeps the modulo cheap. */
const RESAMPLE_CAPACITY = 1024;

/** A 0…1 gate param. Anything above zero is high; the bound only keeps a wired signal
 *  from driving the param somewhere meaningless (D1 clause 4). */
const gate = (name) => ({ name, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" });

/** A 0…1 CV or level param, in the knob's own units. */
const unit = (name, defaultValue = 0) => ({ name, defaultValue, minValue: 0, maxValue: 1, automationRate: "a-rate" });

/** A two-position switch, as a param. Its DEFAULT is load-bearing: Shades' mode
 *  defaults to 1 (attenuverter), which is Rack's, and a param defaulting to 0 would make
 *  a fresh node sound different from what its Inspector row says. `tests/port_vc1_test.js`
 *  pins every spec default against its param default for exactly that reason. */
const switchParam = (name, defaultValue) =>
  ({ name, defaultValue, minValue: 0, maxValue: 1, automationRate: "a-rate" });

/** A 0…1 param with the source's own sub-unity ceiling. Rings clamps structure, damping
 *  and position to 0.9995 and the bound is NOT cosmetic: structure 1.0 indexes one past
 *  `lut_stiffness` and damping 1.0 puts the string's crossfade-to-infinite at exactly
 *  unity gain. A param whose max were 1 would offer a value the kernel refuses. */
const clamped = (name, defaultValue, ceiling) =>
  ({ name, defaultValue, minValue: 0, maxValue: ceiling, automationRate: "a-rate" });

/** A ±1 attenuverter trim. */
const trim = (name) => ({ name, defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" });

/** A pitch or transposition param, in semitones. `limit` is the kernel's own clamp, so a
 *  narrower bound here would silently discard pitch the kernel accepts. */
const semitones = (name, limit, defaultValue = 0) =>
  ({ name, defaultValue, minValue: -limit, maxValue: limit, automationRate: "a-rate" });

/** Clouds' pitch clamp, `Clouds.cpp:167` — ±48 semitones. */
const CLOUDS_PITCH = 48;

/** Ripples' frequency knob's log2-hertz bounds (kernels' deviation P2), and the span its
 *  two CV inputs cover — ±10 V of 1 V/oct is ±120 semitones. */
const RIPPLES_KNOB_MIN = Math.log2(20);
const RIPPLES_KNOB_MAX = Math.log2(20000);
const RIPPLES_CV_SEMITONES = 120;

/** Rings' sub-unity ceiling (`Rings.cpp:148`). */
const RINGS_SUB_UNITY = 0.9995;

/** Rings' FM clamp, `Rings.cpp:157` — ±48 semitones, and its v/oct span is the same
 *  four octaves either way. */
const RINGS_PITCH = 48;

/** Rings' v/oct DEFAULT is one semitone, not zero: `Rings.cpp:152` reads that input
 *  through `getNormalVoltage(1/12)`, so an unpatched Rings sits a semitone above its
 *  knob. Reproduced as the param's default (kernels' deviation R5) rather than silently
 *  corrected, and an author can zero it. */
const RINGS_VOCT_DEFAULT = 1;

/** Rings' FM input default is 1 V = 0.2 wire units, for the same reason
 *  (`getNormalVoltage(1.0)`), which is why a non-zero FM trim offsets the pitch of an
 *  unpatched Rings. */
const RINGS_FM_DEFAULT = 0.2;

/** Clouds' and Supercell's blend-family params. Four separate ones rather than the
 *  hardware's multiplexed single knob — kernels' deviation C3. */
const cloudsBlendParams = () => [
  unit("blend", 0.5), unit("spread"), unit("feedback"), unit("reverb"),
];

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name         the `registerProcessor` id, globally unique across worklet files
 *   module       the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label        `meta.label`
 *   kernel       the kernel class (it carries `internalRate`, `blockSize`, `channels`)
 *   params       the a-rate AudioParams, which are ALSO the wireable number/gate inputs
 *   construct    knobs passed as `processorOptions` (a seed cannot be a param)
 *   options      discrete/derived knobs set by message through `vc1OptionSetter`
 *   audioInputs  audio port names in input-INDEX order (`[]` for a pure source)
 *   outputs      output port names in output-index order
 *
 * `modules_vc1.js` builds its factories FROM THIS ARRAY rather than restating any of it,
 * so a param renamed here cannot leave a module wired to the old name — the hand-kept
 * mirror is the failure mode this avoids. `tests/port_vc1_test.js` checks it against
 * `core/audio_specs_vc1.js` in turn, both directions.
 */
export const VC1_PROCESSORS = [
  {
    name: "vc1-clouds-processor", module: "vcvClouds", label: "VCV Clouds",
    kernel: CloudsKernel, construct: ["seed", "quality"], options: ["playback"],
    params: [
      unit("position", 0.5), unit("size", 0.5), semitones("pitch", CLOUDS_PITCH),
      unit("inGain", 0.5), unit("density", 0.5), unit("texture", 0.5),
      ...cloudsBlendParams(), gate("freeze"), gate("trig"),
    ],
    audioInputs: ["in_l", "in_r"],
    outputs: ["out_l", "out_r"],
  },
  {
    name: "vc1-supercell-processor", module: "vcvSupercell", label: "VCV Supercell",
    kernel: SupercellKernel, construct: ["seed", "quality"], options: ["playback"],
    params: [
      unit("position", 0.5), unit("size", 0.5), semitones("pitch", CLOUDS_PITCH),
      semitones("v_oct", CLOUDS_PITCH), unit("density", 0.5), unit("texture", 0.5),
      unit("mix", 0.5), unit("pan"), unit("feedback"), unit("space"),
      trim("positionTrim"), trim("sizeTrim"), trim("pitchTrim"), trim("densityTrim"),
      trim("textureTrim"), trim("mixTrim"), trim("panTrim"), trim("feedbackTrim"),
      trim("spaceTrim"),
      // Supercell's CV jacks are separate params from their knobs, because each goes
      // through its own attenuverter first. There is no C++ enum to inherit a spelling
      // from -- the source is closed -- so they are named explicitly.
      unit("position_cv"), unit("size_cv"), unit("pitch_cv"), unit("density_cv"),
      unit("texture_cv"), unit("mix_cv"), unit("pan_cv"), unit("feedback_cv"),
      unit("space_cv"),
      { name: "inLevel", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "a-rate" },
      { name: "outLevel", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "a-rate" },
      unit("in_vca"), unit("out_vca"),
      switchParam("inMute", 0), switchParam("outMute", 0), switchParam("randomEnabled", 0),
      { name: "randomFreq", defaultValue: 1, minValue: 1, maxValue: 100, automationRate: "a-rate" },
      gate("hold"), gate("trig"),
    ],
    audioInputs: ["in_l", "in_r"],
    outputs: ["out_l", "out_r"],
  },
  {
    name: "vc1-rings-processor", module: "vcvRings", label: "VCV Rings",
    kernel: RingsKernel, construct: ["seed"],
    options: ["model", "polyphony", "exciter", "strumSource", "noteSource"],
    params: [
      { name: "frequency", defaultValue: 30, minValue: 0, maxValue: 60, automationRate: "a-rate" },
      clamped("structure", 0.5, RINGS_SUB_UNITY), unit("brightness", 0.5),
      clamped("damping", 0.5, RINGS_SUB_UNITY), clamped("position", 0.5, RINGS_SUB_UNITY),
      trim("frequencyTrim"), trim("structureTrim"), trim("brightnessTrim"),
      trim("dampingTrim"), trim("positionTrim"),
      semitones("pitch", RINGS_PITCH, RINGS_VOCT_DEFAULT),
      { name: "frequency_mod", defaultValue: RINGS_FM_DEFAULT, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      { name: "structure_mod", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      { name: "brightness_mod", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      { name: "damping_mod", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      { name: "position_mod", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      gate("strum"),
    ],
    audioInputs: ["in"],
    outputs: ["odd", "even"],
  },
  {
    name: "vc1-marbles-processor", module: "vcvMarbles", label: "VCV Marbles",
    kernel: MarblesKernel, construct: ["seed"],
    options: ["tMode", "tRange", "xMode", "xRange", "xScale", "yDivider", "xClockSource",
      "clockMode", "xClockMode", "registerMode"],
    params: [
      unit("dejaVu", 0.5), unit("dejaVuLength", 0),
      { name: "tRate", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      unit("tBias", 0.5), unit("tJitter", 0),
      unit("xSpread", 0.5), unit("xBias", 0.5), unit("xSteps", 0.5),
      switchParam("tDejaVu", 0), switchParam("xDejaVu", 0),
      // The CV ports keep the C++ enum's spelling; each SUMS with its knob on the kernel's
      // side rather than on one param, because Marbles scales several of them differently
      // (t_rate by 60 semitones, the rest one-for-one).
      { name: "t_rate", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
      { name: "t_bias", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
      { name: "t_jitter", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
      { name: "deja_vu", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
      { name: "x_spread", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
      { name: "x_bias", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
      { name: "x_steps", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
    ],
    audioInputs: ["t_clock", "x_clock"],
    outputs: ["t1", "t2", "t3", "y_out", "x1", "x2", "x3"],
  },
  {
    name: "vc1-ripples-processor", module: "vcvRipples", label: "VCV Ripples",
    kernel: RipplesKernel, construct: ["seed"], options: [],
    params: [
      // The frequency knob is in log2-HERTZ (deviation P2), which is why its bounds are
      // logs. A param in hertz would not accept a harvested patch's stored value.
      { name: "frequency", defaultValue: RIPPLES_KNOB_MAX, minValue: RIPPLES_KNOB_MIN, maxValue: RIPPLES_KNOB_MAX, automationRate: "a-rate" },
      unit("resonance", 0), trim("fmTrim"), switchParam("gainPatched", 0),
      { name: "res", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
      semitones("freq", RIPPLES_CV_SEMITONES), semitones("fm", RIPPLES_CV_SEMITONES),
      { name: "gain", defaultValue: 0, minValue: -2, maxValue: 2, automationRate: "a-rate" },
    ],
    audioInputs: ["in"],
    outputs: ["bp2", "lp2", "lp4", "lp4vca"],
  },
  {
    name: "vc1-branches-processor", module: "vcvBranches", label: "VCV Branches",
    kernel: BranchesKernel, construct: ["seed"], options: [],
    params: [unit("p1", 0.5), unit("p2", 0.5), switchParam("mode1", 0), switchParam("mode2", 0), gate("in1"), gate("in2")],
    audioInputs: [],
    outputs: ["out1a", "out1b", "out2a", "out2b"],
  },
  {
    name: "vc1-blinds-processor", module: "vcvBlinds", label: "VCV Blinds",
    kernel: BlindsKernel, construct: [], options: [],
    params: [1, 2, 3, 4].flatMap((n) => [trim(`gain${n}`), trim(`mod${n}`), unit(`offset${n}`, 1)]),
    audioInputs: ["in1", "cv1", "in2", "cv2", "in3", "cv3", "in4", "cv4"],
    outputs: ["out1", "out2", "out3", "out4", "mix"],
  },
  {
    name: "vc1-shades-processor", module: "vcvShades", label: "VCV Shades",
    kernel: ShadesKernel, construct: [], options: [],
    params: [1, 2, 3].flatMap((n) => [unit(`gain${n}`, 0.5), switchParam(`mode${n}`, 1), unit(`offset${n}`, 1)]),
    audioInputs: ["in1", "in2", "in3"],
    outputs: ["out1", "out2", "out3", "mix"],
  },
];

/**
 * Pure function. The setter method name a discrete option maps to, by CONVENTION rather
 * than by a hand-kept table — the same rule `ax2OptionSetter` states, restated here
 * because a worklet file may not import another block's.
 *
 * @param {string} option - the discrete knob's key
 * @returns {string} the kernel method name
 *
 * @example vc1OptionSetter("playback") // "setPlayback"
 * @example vc1OptionSetter("model") // "setModel"
 * @example vc1OptionSetter("strumSource") // "setStrumSource"
 */
export function vc1OptionSetter(option) {
  return `set${option.charAt(0).toUpperCase()}${option.slice(1)}`;
}

/**
 * Pure function. The message a discrete/list knob's setter posts. Named so the wire
 * format has one definition rather than an object literal at the call site.
 *
 * @param {string} option - the knob key
 * @param {string|number} value - the new value
 * @returns {{option: string, value: string|number}}
 *
 * @example vc1OptionMessage("model", "string") // {option: "model", value: "string"}
 */
export function vc1OptionMessage(option, value) {
  return { option, value };
}

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The guard is
// what lets `modules_vc1.js` and the tests import the roster above from the main thread
// without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of VC1_PROCESSORS) {
    registerProcessor(entry.name, class extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return entry.params;
      }

      constructor(options) {
        super();
        const built = options.processorOptions ?? {};
        this.kernel = new entry.kernel(sampleRate, built);
        // OPTIONS ARE APPLIED AT CONSTRUCTION, not only by message: a `postMessage` sent
        // the instant a node is built does not necessarily arrive before the first
        // `process()`, and an OfflineAudioContext renders faster than the message hop. See
        // `processors_ax2.js`, which measured an oscillator rendering the wrong waveform
        // for its opening frames because of exactly this.
        for (const option of entry.options) {
          if (built[option] !== undefined) this.setOption(option, built[option]);
        }
        this.names = entry.params.map((p) => p.name);
        this.arrays = new Array(this.names.length).fill(null);
        this.controls = {};
        for (const name of this.names) this.controls[name] = 0;

        const kernelClass = entry.kernel;
        this.blockSize = kernelClass.blockSize;
        this.inChannels = kernelClass.channels.in;
        this.outChannels = kernelClass.channels.out;
        this.inBlock = new Float32Array(Math.max(1, this.blockSize * Math.max(1, this.inChannels)));
        this.outBlock = new Float32Array(this.blockSize * this.outChannels);

        // The kernel's own rate, or the context's. A ratio of exactly 1 makes both
        // resamplers a straight copy, so a 48 kHz context gets Rings bit-for-bit.
        const internalRate = kernelClass.internalRate;
        this.resampling = internalRate !== null && internalRate !== sampleRate;
        if (this.resampling) {
          this.downRatio = sampleRate / internalRate;
          this.upRatio = internalRate / sampleRate;
          this.inputResampler = new Resampler(Math.max(1, this.inChannels), RESAMPLE_CAPACITY);
          this.outputResampler = new Resampler(this.outChannels, RESAMPLE_CAPACITY);
          this.frame = new Float32Array(Math.max(this.inChannels, this.outChannels, 1));
          // TWO BLOCKS OF CREDIT so the first quantum has something to pull. What actually
          // GUARANTEES the reader never overtakes the writer is `Resampler`'s primed LAG —
          // read its constructor, which carries the measurement. This credit alone was not
          // enough and the failure was invisible to anything coarse: the tone stayed in tune
          // and its RMS stayed correct while the reader crossed the writer 133 times in 1068
          // blocks, i.e. periodic clicks.
          this.pending = this.blockSize * 2;
        }
        this.port.onmessage = (event) => this.setOption(event.data.option, event.data.value);
      }

      /** Command. Apply one discrete/list option to the kernel, by the naming convention
       *  `vc1OptionSetter` states. LOUD if the kernel lacks it. */
      setOption(option, value) {
        const setter = vc1OptionSetter(option);
        if (typeof this.kernel[setter] !== "function") {
          throw new Error(`${entry.name}: kernel has no ${setter} for option ${JSON.stringify(option)}`);
        }
        this.kernel[setter](value);
      }

      /** Command. Read every a-rate param at this block's first sample. */
      sampleControls(parameters, offset) {
        const names = this.names;
        const arrays = this.arrays;
        for (let n = 0; n < names.length; n++) arrays[n] = parameters[names[n]];
        for (let n = 0; n < names.length; n++) {
          const values = arrays[n];
          this.controls[names[n]] = values.length === 1 ? values[0] : values[offset];
        }
      }

      process(inputs, outputs, parameters) {
        const frames = outputs[0][0].length;
        if (!this.resampling) {
          // The context's own rate: no conversion, one kernel call per `blockSize`.
          for (let start = 0; start < frames; start += this.blockSize) {
            this.sampleControls(parameters, start);
            for (let c = 0; c < this.inChannels; c++) {
              const source = inputs[c] && inputs[c][0];
              for (let i = 0; i < this.blockSize; i++) {
                this.inBlock[i * this.inChannels + c] = source ? source[start + i] : 0;
              }
            }
            this.kernel.render(this.controls, this.inBlock, this.outBlock);
            for (let c = 0; c < this.outChannels; c++) {
              const target = outputs[c][0];
              for (let i = 0; i < this.blockSize; i++) {
                target[start + i] = this.outBlock[i * this.outChannels + c];
              }
            }
          }
          return true;
        }

        // The kernel's own rate. Push this quantum in, render whole blocks while enough
        // source frames have accumulated, then pull the context's frames back out.
        for (let i = 0; i < frames; i++) {
          for (let c = 0; c < Math.max(1, this.inChannels); c++) {
            const source = inputs[c] && inputs[c][0];
            this.frame[c] = source ? source[i] : 0;
          }
          this.inputResampler.push(this.frame);
        }
        this.pending += frames * this.upRatio;
        while (this.pending >= this.blockSize) {
          this.sampleControls(parameters, 0);
          for (let i = 0; i < this.blockSize; i++) {
            this.inputResampler.pull(this.downRatio, this.frame);
            for (let c = 0; c < this.inChannels; c++) {
              this.inBlock[i * this.inChannels + c] = this.frame[c];
            }
          }
          this.kernel.render(this.controls, this.inBlock, this.outBlock);
          for (let i = 0; i < this.blockSize; i++) {
            for (let c = 0; c < this.outChannels; c++) this.frame[c] = this.outBlock[i * this.outChannels + c];
            this.outputResampler.push(this.frame);
          }
          this.pending -= this.blockSize;
        }
        for (let i = 0; i < frames; i++) {
          this.outputResampler.pull(this.upRatio, this.frame);
          for (let c = 0; c < this.outChannels; c++) outputs[c][0][i] = this.frame[c];
        }
        return true;
      }
    });
  }
}
