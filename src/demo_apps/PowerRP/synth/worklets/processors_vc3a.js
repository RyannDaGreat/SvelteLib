/**
 * THE VC-3a AUDIOWORKLET PROCESSORS — nine Bogaudio modules on the audio thread.
 *
 * ── WHY A BLOCK-LOCAL WORKLET FILE ──────────────────────────────────────────
 * `processors.js` is the v1 module set's five processors and is owned by that
 * work; several agents are porting module sets CONCURRENTLY (R7 Wave 3 Phase 3),
 * so one shared worklet file is one merge conflict per agent per save. The engine
 * loads each with `addModule`; the AudioWorklet global scope is shared, so
 * `registerProcessor` names must be globally unique — hence the `vc3a-` prefix.
 *
 * ── THIS FILE IMPORTS ITS KERNELS, WHICH IS ALLOWED AND MEASURED ────────────
 * AX-2 measured it on this repo's own Chrome: an `addModule`'d script with a
 * static import loads, instantiates and renders. The alternative was duplicating
 * an 8192-entry level table, a 4096-entry sine table and nine recurrences into a
 * file no bare-node test can import — the "hand-maintained mirror of another
 * module's shape" the brief names as this project's commonest failure. So
 * `../vc3a_kernels.js` is the ONE copy of the arithmetic and this file is a
 * bridge. THE URL IS NOT OURS: `synth/worklet_urls.js` holds every block's
 * `?worker&url` specifier, because the worker pipeline is what makes an imported
 * kernel survive into a production build. Read that file's header.
 *
 * ── REAL-TIME SAFETY (the checklist `processors.js` sets) ───────────────────
 * `process()` runs every 128 samples. Zero allocations in it: the control object,
 * the frame buffer and the parameter-array slots are built in the constructor and
 * mutated in place. No `new`, no literals, no closures. Always `return true`.
 *
 * ── THE ONE THING THIS FILE IS FOR: BOGAUDIO'S CLOCK DIVIDER ────────────────
 * `module.cpp BGModule::process` reads its knobs in `modulate()` every
 * `sampleRate · 2.5 ms` samples — 120 at 48 kHz — and runs `processChannel()`
 * every sample. So the loop below calls `kernel.control()` once per
 * `modulationSteps(sampleRate)` samples and `kernel.sample()` for every sample in
 * between. Running `control()` per sample "for accuracy" is the mistake the brief
 * names: it changes how a swept knob sounds, because the SlewLimiters downstream
 * of it are tuned against that 2.5 ms staircase. Six of the nine modules have no
 * `modulate()` override at all and read their params per sample — their kernels
 * have an empty `control()`, so the same loop is faithful to both kinds.
 *
 * Every input is an a-rate AudioParam and `numberOfInputs` is 0: a "gate" here is
 * a param the kernel edge-detects with a Schmitt trigger, exactly as the C++ does
 * with a cable's voltage.
 */

import {
  AddrSeqKernel, BogAdsrKernel, BogLfoKernel, BoolKernel, CV_UNITY_UNITS, DadsrhKernel,
  DADSRH_ATTACK_SHAPES, DADSRH_FALL_SHAPES, DADSRH_LOOPS, DADSRH_MODES, DADSRH_RETRIGGERS,
  EightOneKernel, FmOpKernel, FM_LEVEL_RESPONSES, LFO_OFFSET_CV_TARGETS, LFO_OFFSET_RANGES,
  LFO_PITCH_OFFSET_NORMAL, LFO_PITCH_OFFSET_SLOW, ManualKernel,
  Mix4Kernel, MIXER_CV_RESPONSES, MIXER_DIM_DECIBELS, MIXER_MUTE_STATES, ADSR_POLARITIES,
  ADSR_SHAPE_MODES, OFF_ON, OUTPUT_RANGE_NAMES, SEMITONES_PER_OCTAVE, SEQUENCE_DIRECTIONS,
  SINE_INTERPOLATIONS, cvToFrequency, modulationSteps, numberedKeys,
} from "../vc3a_kernels.js";

/** Rack's MAXIMUM cable voltage, in our units — see the kernels' header for the
 *  one unit law. Every signal param's bound, because a wire may legally carry it
 *  and an AudioParam narrower than the platform would discard it silently. */
const SIGNAL_LIMIT = 2;

/** A V/oct input's bound, in SEMITONES (`claude_instructions.md` § R7-UNITS): Rack's
 *  ±10 V maximum on a pitch cable is ±10 octaves, which is ±120 semitones — the
 *  whole of hearing, twice over. A narrower bound would silently discard pitch the
 *  platform can send. */
const PITCH_LIMIT = 10 * SEMITONES_PER_OCTAVE;

/** FMOp's `RatioParamQuantity::getDisplayValue` range: `max(1+v, 0.01)` below
 *  zero, `1+9v` above, so the displayed ratio spans 0.01 to 10. */
const FM_RATIO_MIN = 0.01;
const FM_RATIO_MAX = 10;

/** `EnvelopeSegmentParamQuantity`'s span: `v²·10` seconds with v in 0…1. */
const ENVELOPE_MAX_SECONDS = 10;

/** DADSRH's span once D4 folds its `speed` switch into the knob: `v²·100`. */
const DADSRH_MAX_SECONDS = 100;

/** FMOp's fine tune is `±1 → ±1/12 V`, which is ±100 cents. */
const FINE_CENTS_LIMIT = 100;

/** `LFOBase::setFrequency`'s cap, and the bottom of the SLOW range D4 folded in:
 *  `cvToFrequency(-5 - 11)`. Built from the kernels' own reference frequency
 *  rather than from a copy of 261.626 — `core/audio_specs_vc3a.js` restates these
 *  three because core may not import synth, and the port test pins the two. */
const LFO_MIN_HZ = cvToFrequency(-5 + LFO_PITCH_OFFSET_SLOW);
const LFO_MAX_HZ = 2000;

/** The LFO's frequency knob at its Rack default: CV 0 in the normal range. */
const LFO_DEFAULT_HZ = cvToFrequency(LFO_PITCH_OFFSET_NORMAL);

/** `Mix4`'s fader default: the position at which the channel is at 0 dB, which is
 *  `|minDecibels| / (maxDecibels − minDecibels)` = 60/66. */
const MIXER_UNITY_LEVEL = 60 / 66;

/** How many channels a Mix4 has, and how many steps an addressed sequence has. */
const MIXER_CHANNELS = 4;
const SEQUENCE_STEPS = 8;

/** A gate or clock input: 0 to Rack's maximum. Anything at or above 1 V (0.2
 *  units) is high, with the Schmitt hysteresis the kernels carry. */
const gate = (name) => ({ name, defaultValue: 0, minValue: 0, maxValue: SIGNAL_LIMIT, automationRate: "a-rate" });

/** A bipolar signal input (audio, a CV that may go negative, a step value). */
const signal = (name, defaultValue = 0) => ({ name, defaultValue, minValue: -SIGNAL_LIMIT, maxValue: SIGNAL_LIMIT, automationRate: "a-rate" });

/** A CV SCALER input. Its default is 10 V, NOT 0 — see the kernels' D2: Bogaudio
 *  applies these only when a cable is present, and a default of 0 would mute
 *  every module the instant it was built. */
const cv = (name) => ({ name, defaultValue: CV_UNITY_UNITS, minValue: -SIGNAL_LIMIT, maxValue: SIGNAL_LIMIT, automationRate: "a-rate" });

/** A plain knob-only param: a range with no wire semantics attached. */
const knob = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "a-rate" });

/** An envelope segment, in seconds. */
const seconds = (name, defaultValue, maxValue = ENVELOPE_MAX_SECONDS) => knob(name, defaultValue, 0, maxValue);

/** Pure function. `param(prefix, n)` repeated — the four-channel and eight-step
 *  families, so no roster row lists `in1, in2, in3, in4` by hand.
 *
 *  @param {function(string): object} make - one of the builders above
 *  @param {string} prefix - the family name
 *  @param {number} count - how many
 *  @returns {object[]} descriptors, one-based
 *
 *  @example family(gate, "in", 2).map((p) => p.name) // ["in1", "in2"]
 */
const family = (make, prefix, count) => numberedKeys(prefix, count).map((name) => make(name));

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name       the `registerProcessor` id, globally unique across worklet files
 *   module     the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label      `meta.label`
 *   make       the kernel constructor
 *   params     the a-rate AudioParams; the subset a spec declares as `inputs`
 *              are the wireable ports, the rest are knobs
 *   construct  knobs passed as `processorOptions` (a seed cannot be a param)
 *   options    discrete knobs set by message through `vc3aOptionSetter`
 *   outputs    output port names, in output-index order
 *
 * `modules_vc3a.js` builds its nine factories FROM THIS ARRAY rather than
 * restating any of it, so a param renamed here cannot leave a module wired to the
 * old name. `tests/port_vc3a_test.js` checks it against `core/audio_specs_vc3a.js`
 * in turn, which is what makes a spec that drifts from the engine turn red.
 */
export const VC3A_PROCESSORS = [
  {
    name: "vc3a-fmop-processor", module: "vcvFmop", label: "FM-OP",
    construct: [],
    options: ["oscillator", "levelResponse", "envToLevel", "envToFeedback", "envToDepth", "antialiasFeedback", "antialiasFm"],
    make: (rate, options) => new FmOpKernel(rate, options),
    params: [
      { name: "pitch", defaultValue: 0, minValue: -PITCH_LIMIT, maxValue: PITCH_LIMIT, automationRate: "a-rate" },
      signal("fm"),
      gate("gate"),
      knob("ratio", 1, FM_RATIO_MIN, FM_RATIO_MAX),
      knob("fine", 0, -FINE_CENTS_LIMIT, FINE_CENTS_LIMIT),
      seconds("attack", 0.2),
      seconds("decay", 1),
      knob("sustain", 1, 0, 1),
      seconds("release", 1),
      knob("depth", 0, 0, 1),
      knob("feedback", 0, 0, 1),
      knob("level", 1, 0, 1),
      cv("sustain_cv"),
      cv("depth_cv"),
      cv("feedback_cv"),
      cv("level_cv"),
    ],
    outputs: ["audio"],
  },
  {
    name: "vc3a-lfo-processor", module: "vcvBogLfo", label: "Bogaudio LFO",
    construct: ["seed"],
    options: ["offsetRange", "offsetCvTarget"],
    make: (rate, options) => new BogLfoKernel(rate, options),
    params: [
      knob("frequency", LFO_DEFAULT_HZ, LFO_MIN_HZ, LFO_MAX_HZ),
      { name: "pitch", defaultValue: 0, minValue: -PITCH_LIMIT, maxValue: PITCH_LIMIT, automationRate: "a-rate" },
      gate("reset"),
      knob("pw", 0, -1, 1),
      knob("sample", 0, 0, 1),
      knob("smooth", 0, 0, 1),
      knob("offset", 0, -1, 1),
      knob("scale", 1, 0, 1),
      cv("pw_cv"),
      cv("sample_cv"),
      cv("offset_cv"),
      cv("scale_cv"),
    ],
    outputs: ["ramp_up", "ramp_down", "square", "triangle", "sine", "stepped"],
  },
  {
    name: "vc3a-adsr-processor", module: "vcvBogAdsr", label: "Bogaudio ADSR",
    construct: [], options: ["shape", "polarity"],
    make: (rate, options) => new BogAdsrKernel(rate, options),
    params: [
      gate("gate"),
      seconds("attack", 0.2),
      seconds("decay", 1),
      knob("sustain", 1, 0, 1),
      seconds("release", 1),
    ],
    outputs: ["out"],
  },
  {
    name: "vc3a-dadsrh-processor", module: "vcvDadsrh", label: "DADSR(H)",
    construct: [],
    options: ["attackShape", "decayShape", "releaseShape", "mode", "loop", "retrigger"],
    make: (rate, options) => new DadsrhKernel(rate, options),
    params: [
      gate("trigger"),
      seconds("delay", 0, DADSRH_MAX_SECONDS),
      seconds("attack", 0.2, DADSRH_MAX_SECONDS),
      seconds("decay", 1, DADSRH_MAX_SECONDS),
      knob("sustain", 0.5, 0, 1),
      seconds("release", 1, DADSRH_MAX_SECONDS),
      seconds("hold", 2, DADSRH_MAX_SECONDS),
    ],
    outputs: ["env", "inv", "trigger"],
  },
  {
    name: "vc3a-addrseq-processor", module: "vcvAddrseq", label: "ADDR-SEQ",
    construct: [],
    options: ["direction", "range", "triggeredSelect", "selectOnClock", "wrapSelectAtSteps", "reverseOnNegativeClock"],
    make: (rate, options) => new AddrSeqKernel(rate, options),
    params: [
      gate("clock"),
      gate("reset"),
      signal("select_cv"),
      knob("steps", SEQUENCE_STEPS, 1, SEQUENCE_STEPS),
      knob("select", 0, 0, SEQUENCE_STEPS - 1),
      // A STEP IS A KNOB, NOT A WIRE: their `OutputRangeParamQuantity` spans ±1
      // and the Range menu is what turns that into volts, so a ±2 bound here
      // would be an Inspector offering values the Range no longer describes.
      ...numberedKeys("step", SEQUENCE_STEPS).map((name) => knob(name, 0, -1, 1)),
    ],
    outputs: ["out"],
  },
  {
    name: "vc3a-eightone-processor", module: "vcvEightone", label: "8:1",
    construct: [],
    options: ["direction", "triggeredSelect", "selectOnClock", "wrapSelectAtSteps", "reverseOnNegativeClock"],
    make: (rate, options) => new EightOneKernel(rate, options),
    params: [
      gate("clock"),
      gate("reset"),
      signal("select_cv"),
      knob("steps", SEQUENCE_STEPS, 1, SEQUENCE_STEPS),
      knob("select", 0, 0, SEQUENCE_STEPS - 1),
      ...family(signal, "in", SEQUENCE_STEPS),
    ],
    outputs: ["out"],
  },
  {
    name: "vc3a-bool-processor", module: "vcvBool", label: "BOOL",
    construct: [], options: [],
    make: () => new BoolKernel(),
    params: [signal("a"), signal("b"), signal("not")],
    outputs: ["and", "or", "xor", "not"],
  },
  {
    name: "vc3a-mix4-processor", module: "vcvMix4", label: "MIX4",
    construct: [],
    options: ["mute1", "mute2", "mute3", "mute4", "masterMute", "masterDim", "cvResponse", "dimDecibels"],
    make: (rate, options) => new Mix4Kernel(rate, options),
    params: [
      ...family(signal, "in", MIXER_CHANNELS),
      ...numberedKeys("level", MIXER_CHANNELS).map((name) => knob(name, MIXER_UNITY_LEVEL, 0, 1)),
      ...numberedKeys("pan", MIXER_CHANNELS).map((name) => knob(name, 0, -1, 1)),
      ...family(cv, "cv", MIXER_CHANNELS),
      ...numberedKeys("pan", MIXER_CHANNELS).map((name) => cv(`${name}_cv`)),
      knob("mix", MIXER_UNITY_LEVEL, 0, 1),
      cv("mix_cv"),
    ],
    outputs: ["l", "r"],
  },
  {
    name: "vc3a-manual-processor", module: "vcvManual", label: "MANUAL",
    construct: [], options: ["triggerOnLoad"],
    make: (rate, options) => new ManualKernel(rate, options),
    params: [gate("trigger")],
    outputs: numberedKeys("out", SEQUENCE_STEPS),
  },
];

/**
 * THE LEGAL VALUES OF EVERY DISCRETE KNOB, in one map keyed by the OPTION name.
 *
 * It is here rather than in the spec file because the kernels are the authority
 * on what they accept and this file already imports them — `core/**` may not
 * (bare node, no `synth/**` import). `core/audio_specs_vc3a.js` restates these
 * lists for its Inspector rows, and `tests/port_vc3a_test.js` pins the two
 * together so a value that is offered and refused turns red.
 */
export const VC3A_OPTION_VALUES = Object.freeze({
  oscillator: SINE_INTERPOLATIONS,
  levelResponse: FM_LEVEL_RESPONSES,
  envToLevel: OFF_ON,
  envToFeedback: OFF_ON,
  envToDepth: OFF_ON,
  antialiasFeedback: OFF_ON,
  antialiasFm: OFF_ON,
  offsetRange: LFO_OFFSET_RANGES,
  offsetCvTarget: LFO_OFFSET_CV_TARGETS,
  shape: ADSR_SHAPE_MODES,
  polarity: ADSR_POLARITIES,
  attackShape: DADSRH_ATTACK_SHAPES,
  decayShape: DADSRH_FALL_SHAPES,
  releaseShape: DADSRH_FALL_SHAPES,
  mode: DADSRH_MODES,
  loop: DADSRH_LOOPS,
  retrigger: DADSRH_RETRIGGERS,
  direction: SEQUENCE_DIRECTIONS,
  range: OUTPUT_RANGE_NAMES,
  triggeredSelect: OFF_ON,
  selectOnClock: OFF_ON,
  wrapSelectAtSteps: OFF_ON,
  reverseOnNegativeClock: OFF_ON,
  mute1: MIXER_MUTE_STATES,
  mute2: MIXER_MUTE_STATES,
  mute3: MIXER_MUTE_STATES,
  mute4: MIXER_MUTE_STATES,
  masterMute: OFF_ON,
  masterDim: OFF_ON,
  cvResponse: MIXER_CV_RESPONSES,
  dimDecibels: MIXER_DIM_DECIBELS,
  triggerOnLoad: OFF_ON,
});

/**
 * Pure function. The setter method name a discrete option maps to, by CONVENTION
 * rather than by a hand-kept table: option `oscillator` is `setOscillator`. A
 * table would be a second list to forget a row in. (AX-2 states the same rule;
 * the two spellings are deliberately identical so a reader of either file is not
 * learning a second convention.)
 *
 * @param {string} option - the discrete knob's key
 * @returns {string} the kernel method name
 *
 * @example vc3aOptionSetter("oscillator") // "setOscillator"
 * @example vc3aOptionSetter("mute1") // "setMute1"
 */
export function vc3aOptionSetter(option) {
  return `set${option.charAt(0).toUpperCase()}${option.slice(1)}`;
}

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The
// guard is what lets modules_vc3a.js and the tests import the roster above from
// the main thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of VC3A_PROCESSORS) {
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
        // the first `process()` — an OfflineAudioContext renders faster than the
        // message hop, and AX-2's browser probe caught exactly that. Anything a
        // caller knows at construction is applied at construction; idempotent,
        // because the kernel's own constructor already ran the same setter.
        for (const option of entry.options) {
          if (built[option] !== undefined) this.setOption(option, built[option]);
        }
        this.names = entry.params.map((p) => p.name);
        this.arrays = new Array(this.names.length).fill(null);
        this.controls = {};
        for (const name of this.names) this.controls[name] = 0;
        this.frame = new Float64Array(entry.outputs.length);
        this.tick = 0;
        this.controlPeriod = modulationSteps(sampleRate);
        this.port.onmessage = (event) => this.setOption(event.data.option, event.data.value);
      }

      /** Command. Apply one discrete option to the kernel, by the naming
       *  convention `vc3aOptionSetter` states. LOUD if the kernel lacks it. */
      setOption(option, value) {
        const setter = vc3aOptionSetter(option);
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
          // BOGAUDIO'S CLOCK DIVIDER. See the header: knobs are read every
          // ~2.5 ms, not every sample and not once per quantum.
          if (this.tick === 0) this.kernel.control(controls);
          this.kernel.sample(controls, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o];
          this.tick += 1;
          if (this.tick >= this.controlPeriod) this.tick = 0;
        }
        return true;
      }
    });
  }
}
