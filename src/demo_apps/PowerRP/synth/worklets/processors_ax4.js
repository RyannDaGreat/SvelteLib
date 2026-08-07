/**
 * THE AX-4 AUDIOWORKLET PROCESSORS — eleven Axoloti nodes on the audio thread.
 *
 * ── WHY A FOURTH WORKLET FILE ───────────────────────────────────────────────
 * `processors.js` is the v1 module set; `processors_ax2.js` and
 * `processors_ax3.js` are the first two port blocks. Six agents are porting
 * module sets concurrently (R7 Wave 3 Phase 3), so one shared worklet file is
 * one merge conflict per agent per save. The AudioWorklet global scope is
 * SHARED across `addModule` calls, so `registerProcessor` names must be globally
 * unique — hence the `ax4-` prefix on every one below.
 *
 * ── THIS FILE IMPORTS, AND THAT IS MEASURED, NOT ASSUMED ────────────────────
 * A module worklet takes static imports on this Chrome (measured by AX-2). So
 * `../ax4_kernels.js` is the ONE copy of the arithmetic, `tests/port_ax4_test.js`
 * proves it in bare node against a BigInt model of the C, and this file is only
 * the bridge. ⚠ THE BUILD HALF IS THE OPPOSITE: an importing worklet is only
 * safe if its URL goes through Vite's WORKER pipeline, which is why
 * `synth/worklet_urls.js` exists and why THIS BLOCK MUST NOT DECLARE ITS OWN URL
 * — see that file's header for the measured 404.
 *
 * ── THE ONE THING THIS FILE IS FOR: THE K-RATE BRIDGE ───────────────────────
 * Axoloti's control rate is sampleRate/16 — 3000 Hz, EIGHT ticks per 128-frame
 * quantum, not one. The loop below calls `kernel.control()` every AX_BUFSIZE
 * samples and `kernel.sample()` for every sample between. THIS BLOCK IS ALMOST
 * ENTIRELY ENVELOPES, so hoisting the first call out of the loop is the single
 * likeliest way to get it wrong: every attack, decay and release would run 8×
 * slow, and it would still sound like music. `tests/port_ax4_test.js` measures
 * an envelope's DURATION against the integer model to keep that honest.
 *
 * ── WHAT DIFFERS FROM AX-2's ROSTER, AND WHY ────────────────────────────────
 * AX-2's rows carry `construct` and `options` because its nodes have seeds and
 * waveform menus. NOT ONE AX-4 NODE HAS EITHER: every control here is a
 * continuous number, so both fields would be permanently empty and the
 * `port.onmessage` seam behind them would be dead code on the audio thread.
 * They are omitted rather than carried at zero.
 *
 * WHAT THIS BLOCK ADDS INSTEAD IS `audioInputs`. AX-2's nodes are all sources
 * with `numberOfInputs: 0`; AX-3's each have exactly one, mapped to the node
 * itself. AX-4 has a stereo VCA, a crossfade and a SEVEN-input mixer, so a row
 * declares its audio inputs by name in input-INDEX order and
 * `modules_ax4.js` puts a one-gain tap in front of each — which is what turns
 * "input index 3" into a port a wire can land on. Exactly the mirror of AX-2's
 * output taps, and for the same reason.
 *
 * ── REAL-TIME SAFETY (the checklist processors.js sets) ─────────────────────
 * `process()` runs every 128 samples. Zero allocations in it: the control
 * object, the input frame and the output frame are built in the constructor and
 * mutated in place. No `new`, no literals, no closures. Always `return true`.
 */

import {
  AX_BUFSIZE,
  AX_DECAY_PARAM_MAX,
  AX_DECAY_PARAM_MIN,
  AX_FRAC32_HEADROOM,
  AX_TIME_PARAM_MAX,
  AX_TIME_PARAM_MIN,
  AdsrKernel,
  AhdKernel,
  DistInfKernel,
  DistSoftKernel,
  DpHardClipKernel,
  DpSoftClipKernel,
  EnvDecayKernel,
  EnvDecayLinearKernel,
  MixKernel,
  VcaStereoKernel,
  XfadeKernel,
  axDecayDialToSeconds,
  axTimeDialToSeconds,
} from "../ax4_kernels.js";

/** A gate or trigger carries 0…1 (R7-UNITS clause 4). Anything above zero is
 *  high; the bound only stops a wired signal driving it somewhere meaningless. */
const gate = (name) => ({ name, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" });

/** A normalised `frac32.u.map` dial — sustain, a mixer gain, a clipper gain.
 *  `__USAT(v, 27)` really does cap these at 1.0, so the bound is theirs. */
const amount = (name, defaultValue) => ({ name, defaultValue, minValue: 0, maxValue: 1, automationRate: "a-rate" });

/** A `LinearTimeExp` stage, in seconds. The bounds are the kernel's derived
 *  ones — wider than the knob, because a modulation input reaches further than
 *  the dial does, exactly as `env/d m`'s MTOFEXTENDED does. */
const expTime = (name) => ({
  name,
  defaultValue: axTimeDialToSeconds(0),
  minValue: AX_TIME_PARAM_MIN,
  maxValue: AX_TIME_PARAM_MAX,
  automationRate: "a-rate",
});

/** A `DecayTime` half-life, in seconds, on the same principle. */
const decayTime = (name) => ({
  name,
  defaultValue: axDecayDialToSeconds(0),
  minValue: AX_DECAY_PARAM_MIN,
  maxValue: AX_DECAY_PARAM_MAX,
  automationRate: "a-rate",
});

/** `sss/gain/vcaST`'s `v` is a bare inlet with NO pfunction behind it, so its
 *  honest bound is frac32's own ±16 headroom rather than a gain of one. */
const vcaLevel = (name) => ({
  name,
  defaultValue: 0,
  minValue: -AX_FRAC32_HEADROOM,
  maxValue: AX_FRAC32_HEADROOM,
  automationRate: "a-rate",
});

/** `mix/mix N`'s `<DefaultValue v="32.0"/>`, normalised. */
const MIX_GAIN_DEFAULT = 0.5;

/** The DP clippers' unity drive and unity peak — see core/audio_specs_ax4.js's
 *  AX_DP_GAINS for why these two numbers and not the source's silent zeros. */
const DP_INGAIN_DEFAULT = 0.25;
const DP_OUTGAIN_DEFAULT = 0.5;

/** `mix/mix 6` is the widest of the family, so the union node carries six. */
const MIX_CHANNELS = 6;

/** Pure function. One mixer channel's two descriptors' worth of names, so the
 *  roster's six rows are generated rather than typed six times.
 *
 *  @param {number} channel - 1…6
 *  @returns {{input: string, gain: string}}
 *
 *  @example mixChannelNames(1) // {input: "in1", gain: "gain1"}
 *  @example mixChannelNames(6) // {input: "in6", gain: "gain6"} */
export function mixChannelNames(channel) {
  return { input: `in${channel}`, gain: `gain${channel}` };
}

const MIX_CHANNEL_NAMES = Array.from({ length: MIX_CHANNELS }, (_, i) => mixChannelNames(i + 1));

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name         the `registerProcessor` id, globally unique across worklet files
 *   module       the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label        `meta.label`
 *   make         the kernel constructor, given the running sample rate
 *   audioInputs  audio port names, in worklet input-INDEX order
 *   params       the a-rate AudioParams, which are ALSO the wireable number inputs
 *   outputs      output port names, in output-index order
 *
 * `modules_ax4.js` builds its eleven factories FROM THIS ARRAY rather than
 * restating any of it, so a param renamed here cannot leave a module wired to
 * the old name — the hand-kept mirror is the failure mode that avoids.
 * `tests/port_ax4_test.js` checks it against `core/audio_specs_ax4.js` in turn,
 * both directions, so a spec port with no processor behind it is red.
 */
export const AX4_PROCESSORS = [
  {
    name: "ax4-env-adsr-processor", module: "axEnvAdsr", label: "AX ADSR",
    make: (rate) => new AdsrKernel(rate),
    audioInputs: [],
    params: [gate("gate"), expTime("a"), expTime("d"), amount("s", 0), expTime("r")],
    outputs: ["env"],
  },
  {
    name: "ax4-env-ahd-processor", module: "axEnvAhd", label: "AX AHD Envelope",
    make: (rate) => new AhdKernel(rate),
    audioInputs: [],
    params: [decayTime("a"), decayTime("d"), gate("gate")],
    outputs: ["env"],
  },
  {
    name: "ax4-env-decay-processor", module: "axEnvDecay", label: "AX Decay Envelope",
    make: (rate) => new EnvDecayKernel(rate),
    audioInputs: [],
    params: [gate("trig"), expTime("d")],
    outputs: ["env"],
  },
  {
    name: "ax4-env-decay-linear-processor", module: "axEnvDecayLinear", label: "AX Decay Envelope (linear)",
    make: (rate) => new EnvDecayLinearKernel(rate),
    audioInputs: [],
    params: [gate("trig"), expTime("d")],
    outputs: ["env"],
  },
  {
    name: "ax4-vca-stereo-processor", module: "axVcaStereo", label: "AX Stereo VCA",
    make: () => new VcaStereoKernel(),
    audioInputs: ["a1", "a2"],
    params: [vcaLevel("v")],
    outputs: ["o1", "o2"],
  },
  {
    name: "ax4-xfade-processor", module: "axXfade", label: "AX Crossfade",
    make: () => new XfadeKernel(),
    audioInputs: ["i1", "i2"],
    params: [amount("c", 0)],
    outputs: ["o"],
  },
  {
    name: "ax4-mix-processor", module: "axMix", label: "AX Mixer",
    make: () => new MixKernel(),
    audioInputs: ["bus_in", ...MIX_CHANNEL_NAMES.map((channel) => channel.input)],
    params: MIX_CHANNEL_NAMES.map((channel) => amount(channel.gain, MIX_GAIN_DEFAULT)),
    outputs: ["out"],
  },
  {
    name: "ax4-dist-soft-processor", module: "axDistSoft", label: "AX Soft Clip",
    make: () => new DistSoftKernel(),
    audioInputs: ["in"],
    params: [],
    outputs: ["out"],
  },
  {
    name: "ax4-dist-inf-processor", module: "axDistInf", label: "AX Infinite Clip",
    make: () => new DistInfKernel(),
    audioInputs: ["in"],
    params: [],
    outputs: ["out"],
  },
  {
    name: "ax4-dp-soft-clip-processor", module: "axDpSoftClip", label: "AX DP Soft Clip",
    make: () => new DpSoftClipKernel(),
    audioInputs: ["in"],
    params: [amount("ingain", DP_INGAIN_DEFAULT), amount("outgain", DP_OUTGAIN_DEFAULT)],
    outputs: ["out"],
  },
  {
    name: "ax4-dp-hard-clip-processor", module: "axDpHardClip", label: "AX DP Hard Clip",
    make: () => new DpHardClipKernel(),
    audioInputs: ["in"],
    params: [amount("ingain", DP_INGAIN_DEFAULT), amount("outgain", DP_OUTGAIN_DEFAULT)],
    outputs: ["out"],
  },
];

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The
// guard is what lets modules_ax4.js and the tests import the roster above from
// the main thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of AX4_PROCESSORS) {
    registerProcessor(entry.name, class extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return entry.params;
      }

      constructor() {
        super();
        this.kernel = entry.make(sampleRate);
        this.names = entry.params.map((p) => p.name);
        this.arrays = new Array(this.names.length).fill(null);
        this.controls = {};
        for (const name of this.names) this.controls[name] = 0;
        this.ins = new Float64Array(entry.audioInputs.length);
        this.frame = new Float64Array(entry.outputs.length);
        this.tick = 0;
      }

      process(inputs, outputs, parameters) {
        const first = outputs[0];
        if (!first || first.length === 0) return true;
        const frames = first[0].length;
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
          // AN UNCONNECTED WORKLET INPUT IS `[]`, NOT A BUFFER OF ZEROS — that is
          // the Web Audio contract, not a failure, and silence is what an
          // unwired Axoloti inlet carries too.
          for (let a = 0; a < ins.length; a++) {
            const channels = inputs[a];
            ins[a] = channels && channels.length > 0 ? channels[0][i] : 0;
          }
          // THE 3000 Hz CONTROL RATE. See the header: once per 16 samples, which
          // is eight times per quantum, not once.
          if (this.tick === 0) this.kernel.control(controls);
          this.kernel.sample(controls, ins, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o];
          this.tick = (this.tick + 1) & (AX_BUFSIZE - 1);
        }
        return true;
      }
    });
  }
}
