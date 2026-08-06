/**
 * THE AX-2 AUDIOWORKLET PROCESSORS — ten Axoloti nodes on the audio thread.
 *
 * ── WHY A SECOND WORKLET FILE ───────────────────────────────────────────────
 * `processors.js` is the v1 module set's five processors and is owned by that
 * work. Five agents are porting module sets concurrently (R7 Wave 3 Phase 3), so
 * one shared worklet file is one merge conflict per agent per save. The engine
 * loads both with `addModule`; the AudioWorklet global scope is shared, so
 * `registerProcessor` names must be globally unique — hence the `ax2-` prefix.
 *
 * ── THIS FILE IMPORTS, AND THAT IS A MEASURED DEPARTURE ─────────────────────
 * `processors.js`'s header states the worklet scope "must not import anything",
 * and restates two constants from dsp.js under a pinning test on that basis.
 * MEASURED 2026-08-06 on this repo's own Chrome, through
 * `tests/puppeteerLaunch.js`: an `addModule`'d script with a static
 * `import { MAGIC } from "./kern.js"` loaded, instantiated and rendered its
 * value. Worklet module scripts take static imports here.
 *
 * That matters because the alternative was DUPLICATING a 2048-entry minBLEP
 * table and ten recurrences into a file no bare-node test can import — and then
 * pinning the copy, which is the "hand-maintained mirror of another module's
 * shape" the brief names as this project's commonest failure. Instead
 * `../ax2_kernels.js` is the ONE copy of the arithmetic, `tests/port_ax2_test.js`
 * proves it against an integer model of the C, and this file is only the bridge.
 *
 * IF A TARGET BROWSER LACKS IT, IT FAILS LOUDLY: `addModule` rejects and
 * `engine.init()`'s rejection is already surfaced (web/audioMirror.svelte.js
 * treats a worklet load failure as a boot error). Nothing here degrades quietly.
 *
 * ── REAL-TIME SAFETY (the checklist `processors.js` sets) ───────────────────
 * `process()` runs every 128 samples. Zero allocations in it: the control
 * object, the frame buffer and the parameter-array slots are built in the
 * constructor and mutated in place. No `new`, no literals, no closures. Always
 * `return true`.
 *
 * ── THE ONE THING THIS FILE IS FOR: THE K-RATE BRIDGE ───────────────────────
 * Axoloti's control rate is sampleRate/16 — 3000 Hz, not once per quantum. So
 * the loop below calls `kernel.control()` every KRATE_BUFSIZE samples, EIGHT
 * times in a 128-frame quantum, and `kernel.sample()` for every sample in
 * between. Hoisting the first call out of the loop is the obvious optimisation
 * and it runs every LFO, envelope and coefficient 8× slow. `tests/port_ax2_test`
 * counts an LFO's cycles per second to keep that honest.
 *
 * Every input is an a-rate AudioParam and `numberOfInputs` is 0: Axoloti's
 * `bool32.rising` inlets are ordinary values with an edge latch behind them, so
 * a "trigger" here is a param the kernel edge-detects, exactly as the C does.
 */

import {
  KRATE_BUFSIZE, LfoKernel, LfsrBurstKernel, LfsrSeqKernel, NoiseKernel, OscKernel,
  PhasorKernel, PulseDecayKernel, RandKernel, RandPinkKernel, SupersawKernel,
} from "../ax2_kernels.js";

/** Widest useful FM excursion, in hertz — an AudioParam needs a bound and this
 *  one is a sample rate's worth in either direction, which is past through-zero
 *  and into territory where the phase runs backwards. */
const FM_LIMIT = 48000;

/** Axoloti's pitch clamp, `__SSAT(p, 29)` = ±2^28 raw = ±128 semitones. A
 *  narrower AudioParam bound would silently discard pitch the kernel accepts. */
const PITCH_LIMIT = 128;

/** `rand/uniform i`'s `param_max` ceiling, from its `<MaxValue i="65536"/>`. */
const RAND_STEPS_MAX = 65536;

/** `seq/lfsrseq`'s widest tap (0x3FC) is 10 bits, so its state and load value are. */
const LFSR_SEQ_STATE_MAX = 1023;

/** A gate's range. Anything above zero is high; the bound only keeps a wired
 *  signal from driving the param somewhere meaningless. */
const gate = (name) => ({ name, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" });
const pitch = (name) => ({ name, defaultValue: 0, minValue: -PITCH_LIMIT, maxValue: PITCH_LIMIT, automationRate: "a-rate" });

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name       the `registerProcessor` id, globally unique across worklet files
 *   module     the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label      `meta.label`
 *   make       the kernel constructor
 *   params     the a-rate AudioParams, which are ALSO the wireable inputs
 *   construct  knobs passed as `processorOptions` (a seed cannot be a param)
 *   options    discrete/derived knobs set by message through `ax2OptionSetter`
 *   outputs    output port names, in output-index order
 *
 * `modules_ax2.js` builds its ten factories FROM THIS ARRAY rather than
 * restating any of it, so a param renamed here cannot leave a module wired to
 * the old name — the hand-kept mirror is the failure mode this avoids.
 * tests/port_ax2_test.js checks it against core/audio_specs_ax2.js in turn.
 */
export const AX2_PROCESSORS = [
  {
    name: "ax2-osc-processor", module: "axOsc", label: "AX Oscillator",
    construct: [], options: ["waveform"],
    make: (rate, options) => new OscKernel(rate, options),
    params: [
      pitch("pitch"),
      { name: "freq", defaultValue: 0, minValue: -FM_LIMIT, maxValue: FM_LIMIT, automationRate: "a-rate" },
      { name: "phase", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" },
      { name: "pw", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "a-rate" },
    ],
    outputs: ["out"],
  },
  {
    name: "ax2-supersaw-processor", module: "axSupersaw", label: "AX Supersaw",
    construct: [], options: [],
    make: (rate) => new SupersawKernel(rate),
    params: [pitch("pitch"), { name: "detune", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "a-rate" }],
    outputs: ["out"],
  },
  {
    name: "ax2-noise-processor", module: "axNoise", label: "AX Noise",
    construct: ["seed"], options: ["colour"],
    make: (rate, options) => new NoiseKernel(rate, options),
    params: [],
    outputs: ["out"],
  },
  {
    name: "ax2-phasor-processor", module: "axPhasor", label: "AX Phasor",
    construct: [], options: [],
    make: (rate) => new PhasorKernel(rate),
    params: [
      pitch("pitch"),
      { name: "freq", defaultValue: 0, minValue: -FM_LIMIT, maxValue: FM_LIMIT, automationRate: "a-rate" },
    ],
    outputs: ["phasor0", "phasor180"],
  },
  {
    name: "ax2-lfsr-burst-processor", module: "axLfsrBurst", label: "AX LFSR Burst",
    construct: [], options: [],
    make: () => new LfsrBurstKernel(),
    params: [gate("trig"), { name: "polynomial", defaultValue: 142, minValue: 1, maxValue: 255, automationRate: "a-rate" }],
    outputs: ["out"],
  },
  {
    name: "ax2-lfo-processor", module: "axLfo", label: "AX LFO",
    construct: [], options: ["waveform"],
    make: (rate, options) => new LfoKernel(rate, options),
    params: [pitch("pitch"), gate("reset"), { name: "phase", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" }],
    outputs: ["out", "sync"],
  },
  {
    name: "ax2-rand-processor", module: "axRand", label: "AX Random",
    construct: ["seed"], options: ["mode"],
    make: (rate, options) => new RandKernel(rate, options),
    params: [gate("trig"), { name: "steps", defaultValue: 0, minValue: 0, maxValue: RAND_STEPS_MAX, automationRate: "a-rate" }],
    outputs: ["out"],
  },
  {
    name: "ax2-rand-pink-processor", module: "axRandPink", label: "AX Random Pink",
    construct: ["seed"], options: ["octaves"],
    make: (rate, options) => new RandPinkKernel(rate, options),
    params: [],
    outputs: ["out"],
  },
  {
    name: "ax2-pulse-decay-processor", module: "axPulseDecay", label: "AX Decay",
    construct: [], options: [],
    make: () => new PulseDecayKernel(),
    params: [gate("trig"), { name: "decay", defaultValue: 0.05, minValue: 0, maxValue: 1, automationRate: "a-rate" }],
    outputs: ["out"],
  },
  {
    name: "ax2-lfsr-seq-processor", module: "axLfsrSeq", label: "AX LFSR Sequencer",
    construct: [], options: [],
    make: () => new LfsrSeqKernel(),
    params: [
      gate("trig"), gate("reset"), gate("load"),
      { name: "lval", defaultValue: 0, minValue: 0, maxValue: LFSR_SEQ_STATE_MAX, automationRate: "a-rate" },
      { name: "polynomial", defaultValue: 265, minValue: 1, maxValue: LFSR_SEQ_STATE_MAX, automationRate: "a-rate" },
    ],
    outputs: ["out"],
  },
];

/**
 * Pure function. The setter method name a discrete option maps to, by
 * CONVENTION rather than by a hand-kept table: option `waveform` is
 * `setWaveform`. A table would be a second list to forget a row in.
 *
 * @param {string} option - the discrete knob's key
 * @returns {string} the kernel method name
 *
 * @example ax2OptionSetter("waveform") // "setWaveform"
 * @example ax2OptionSetter("colour") // "setColour"
 */
export function ax2OptionSetter(option) {
  return `set${option.charAt(0).toUpperCase()}${option.slice(1)}`;
}

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The
// guard is what lets modules_ax2.js and the tests import the roster above from
// the main thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of AX2_PROCESSORS) {
    registerProcessor(entry.name, class extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return entry.params;
      }

      constructor(options) {
        super();
        const built = options.processorOptions ?? {};
        this.kernel = entry.make(sampleRate, built);
        // OPTIONS ARE APPLIED HERE, NOT ONLY BY MESSAGE. A `port.postMessage`
        // sent the instant the node is built does not necessarily arrive before
        // the first `process()`: an OfflineAudioContext renders faster than the
        // message hop, and a browser probe caught exactly that — an oscillator
        // built as `saw` rendered SINE for its opening frames (peak 1.0 instead
        // of 0.5, 1.26 of error against the kernel). Anything a caller knows at
        // construction is therefore applied at construction.
        // Idempotent: a kernel whose constructor already consumed the option
        // through its own setter simply sets it again to the same value.
        for (const option of entry.options) {
          if (built[option] !== undefined) this.setOption(option, built[option]);
        }
        this.names = entry.params.map((p) => p.name);
        this.arrays = new Array(this.names.length).fill(null);
        this.controls = {};
        for (const name of this.names) this.controls[name] = 0;
        this.frame = new Float64Array(entry.outputs.length);
        this.tick = 0;
        this.port.onmessage = (event) => this.setOption(event.data.option, event.data.value);
      }

      /** Command. Apply one discrete/list option to the kernel, by the naming
       *  convention `ax2OptionSetter` states. LOUD if the kernel lacks it. */
      setOption(option, value) {
        const setter = ax2OptionSetter(option);
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
        for (let n = 0; n < names.length; n++) arrays[n] = parameters[names[n]];
        for (let i = 0; i < frames; i++) {
          for (let n = 0; n < names.length; n++) {
            const values = arrays[n];
            controls[names[n]] = values.length === 1 ? values[0] : values[i];
          }
          // THE 3000 Hz CONTROL RATE. See the header: once per 16 samples, which
          // is eight times per quantum, not once.
          if (this.tick === 0) this.kernel.control(controls);
          this.kernel.sample(controls, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o];
          this.tick = (this.tick + 1) & (KRATE_BUFSIZE - 1);
        }
        return true;
      }
    });
  }
}
