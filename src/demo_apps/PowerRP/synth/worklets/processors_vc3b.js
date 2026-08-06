/**
 * THE VC-3b AUDIOWORKLET PROCESSORS — twelve Bogaudio modules on the audio thread.
 *
 * ── WHY A SEPARATE WORKLET FILE ─────────────────────────────────────────────
 * One per port block (R7 Wave 3 Phase 3): several agents land module sets
 * concurrently, so one shared worklet file is one merge conflict per agent per
 * save. The engine loads them all with `addModule`; the AudioWorklet global scope
 * is SHARED, so `registerProcessor` names must be globally unique — hence the
 * `vc3b-` prefix on every one below.
 *
 * ── THIS FILE IMPORTS, AND THAT IS MEASURED, NOT ASSUMED ────────────────────
 * `processors.js`'s header says the worklet scope "must not import anything";
 * AX-2 measured otherwise on this repo's own Chrome (see its header) and AX-3
 * measured the CONDITION: a worklet MAY statically import, but only if its URL
 * goes through Vite's `?worker&url` pipeline — which is why that specifier lives
 * in `synth/worklet_urls.js` and NOT here. Without the pipeline the import 404s
 * in production off a build that exits 0 with no audio at all.
 *
 * The alternative was duplicating a 4096-entry BLEP table, a Butterworth pole
 * solver and twelve recurrences into a file no bare-node test can import. This
 * way `../vc3b_kernels.js` is the ONE copy of the arithmetic,
 * `tests/port_vc3b_test.js` proves it against a transcription of the C++, and
 * this file is only the bridge.
 *
 * ── REAL-TIME SAFETY (the checklist `processors.js` sets) ───────────────────
 * `process()` runs every 128 samples. ZERO allocations in it: the `signals`
 * object, the `wired` object, the frame buffer and every parameter-array slot are
 * built in the constructor and mutated in place. No `new`, no object literals, no
 * closures. Always `return true`.
 *
 * ── THE TWO THINGS THIS FILE IS FOR ─────────────────────────────────────────
 * 1. **THE UNIT BOUNDARY (R7-UNITS, kernels' D0).** Bogaudio computes in Rack
 *    VOLTS and SEMITONES; PowerRP wires carry ±1 levels, semitone pitches and
 *    0…1 gates. The conversion happens HERE and nowhere else, in exactly two
 *    places — one read, one write — through the per-port scale table
 *    `BOG_GATE_VOLTS` documents. Every line in the kernels is therefore directly
 *    diffable against the C++.
 * 2. **THE MODULATE DIVIDER (D1).** Bogaudio re-reads knobs and recomputes
 *    coefficients once every ~2.5 ms (`src/module.cpp:22`), NOT per sample. The
 *    loop below calls `kernel.control()` every `bogModulateSteps(sampleRate)`
 *    samples — 120 at 48 kHz, so roughly once per quantum but NOT aligned to
 *    one. Running it per sample would change every filter sweep and every
 *    compressor attack, because their slew limiters are tuned against this rate.
 *
 * ── AND THE THING IT UNIQUELY CAN DO: `isConnected()` (D3) ──────────────────
 * Bogaudio's CV laws branch on whether a cable is present — `level *= clamp(cv/10,
 * 0, 1)` ONLY when wired, so a connected cable at 0 V means silence while no
 * cable means unity. No AudioParam can express that, so every CV inlet is an
 * `audio` input at its own input INDEX and connectedness is `inputs[i].length > 0`.
 * That is the only mechanism the API offers; the kernels take `wired` as an
 * explicit map so the bare-node test drives both branches directly.
 */

import {
  bogModulateSteps, OffsetKernel, PeqKernel, PressorKernel, RACK_VOLTS_PER_UNIT, SampleHoldKernel,
  StackKernel, SwitchKernel, VcaKernel, VcfKernel, VcmKernel, VcoKernel, WalkKernel, XFadeKernel,
} from "../vc3b_kernels.js";

/**
 * THE THREE PORT SCALES — R7-UNITS, and the reason this is a table rather than one
 * constant. Every port on every module below is exactly one of these kinds, and the
 * kind decides what number the kernel sees:
 *
 *   LEVEL (clause 1)  `volts = wire · 5`. An audio signal or a bipolar CV. Our ±1
 *                     IS Rack's ±5 V, which makes every AudibleInstruments
 *                     wrapper's own ÷5 the identity at our boundary.
 *   PITCH (clause 3)  `semitones = wire`. A V/oct port carries SEMITONES, so the
 *                     wire value is already what the arithmetic wants and nothing
 *                     is scaled. Origin C4, NOT the Axoloti blocks' E4.
 *   GATE  (clause 4)  `volts = wire · 10`. LOGIC IS NOT LEVEL: our gates are 0…1
 *                     and a Rack gate is 10 V, so this is the mapping between the
 *                     two conventions. It also matters numerically — Bogaudio's
 *                     Schmitt trigger fires at 1 V, so a ×5 gate of 1.0 would land
 *                     EXACTLY on the threshold and a gate of 0.99 would not fire
 *                     at all. ×10 puts a full gate an order of magnitude clear of
 *                     it, which is what a Rack patch's 10 V gate really does.
 *
 * A port absent from a row's `pitchPorts` and `gatePorts` is a LEVEL port. That
 * default is deliberate: level is the common case, and a NEW port that forgot to
 * declare itself gets the scale that is right for a signal rather than one that is
 * right for nothing.
 */
export const BOG_GATE_VOLTS = 10;

/** A CV inlet's AudioParam-free bound is its PORT, not a param — but the knobs
 *  below still need ranges, and these are the recurring ones. `db`, `hz` and `ms`
 *  exist so a range is stated once per KIND rather than once per knob. */
const unit = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "a-rate" });

/** PEQ's band frequency defaults, in HERTZ — `PEQ14.hpp`'s fourteen
 *  `configParam` positions squared and scaled (`p² · 20000`). See
 *  `core/audio_specs_vc3b.js` for the 3- and 6-band lists a narrower patch sets. */
export const PEQ14_FREQUENCIES_HZ = Object.freeze([95, 125, 175, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000, 5600, 6900]);

/** `PEQChannel`'s level default: `|minDecibels| / (max − min)` of the way up the
 *  0…1 knob, which lands on EXACTLY 0 dB. Stated as the dB it is (D13). */
export const PEQ_LEVEL_DEFAULT_DB = 0;

/** The widest PEQ Bogaudio ships, and therefore the port count this node
 *  declares. See the PEQ spec on why the ports are sized for 14 and the ACTIVE
 *  band count is a construct knob. */
const PEQ_MAX_BANDS = 14;

/**
 * Pure function. PEQ's per-band knob descriptors — fourteen levels and fourteen
 * frequencies, generated rather than written out, so a renamed band cannot exist
 * in one of the two lists only.
 *
 * @returns {object[]} AudioParam descriptors
 *
 * @example peqBandParams().length // 28
 * @example peqBandParams()[0].name // "level1"
 * @example peqBandParams()[14].defaultValue // 95
 */
export function peqBandParams() {
  const levels = [];
  const frequencies = [];
  for (let i = 1; i <= PEQ_MAX_BANDS; i++) {
    levels.push(unit(`level${i}`, PEQ_LEVEL_DEFAULT_DB, -60, 6));
    frequencies.push(unit(`frequency${i}`, PEQ14_FREQUENCIES_HZ[i - 1], 3, 20000));
  }
  return [...levels, ...frequencies];
}

/**
 * Pure function. `n` numbered port keys — `peqPorts("level", 14, "_cv")` is
 * `["level1_cv", … "level14_cv"]`. One helper because four of the rosters below
 * are numbered families and a hand-typed list of fourteen is a list with a typo.
 *
 * @param {string} stem
 * @param {number} count
 * @param {string} [suffix]
 * @returns {string[]}
 *
 * @example numberedPorts("band", 3) // ["band1", "band2", "band3"]
 * @example numberedPorts("level", 2, "_cv") // ["level1_cv", "level2_cv"]
 */
export function numberedPorts(stem, count, suffix = "") {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(`${stem}${i}${suffix}`);
  return keys;
}

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name         the `registerProcessor` id, globally unique across worklet files
 *   module       the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label        `meta.label`
 *   make         `(sampleRate, constructOptions) -> kernel`
 *   params       the a-rate AudioParams — THE KNOBS, in real units (D13)
 *   pitchPorts   the ports (input OR output) carrying SEMITONES rather than a
 *                scaled voltage — R7-UNITS clause 3
 *   gatePorts    the ports carrying 0…1 LOGIC rather than a scaled voltage —
 *                R7-UNITS clause 4
 *   audioInputs  the audio input port keys, IN INPUT-INDEX ORDER (D3). Every
 *                Bogaudio CV inlet is one of these, not a param, because its law
 *                branches on connectedness.
 *   construct    knobs passed as `processorOptions` (a seed or a band count
 *                cannot be a param — it sizes the object)
 *   options      discrete knobs set by message through `vc3bOptionSetter`
 *   outputs      output port names, in output-index order
 *
 * `modules_vc3b.js` builds its twelve factories FROM THIS ARRAY rather than
 * restating any of it, and `tests/port_vc3b_test.js` checks it against
 * `core/audio_specs_vc3b.js` in turn — so a port renamed here cannot leave a
 * spec declaring one the engine does not have.
 */
export const VC3B_PROCESSORS = [
  {
    name: "vc3b-peq-processor", module: "vcvPeq", label: "VCV Bogaudio PEQ",
    pitchPorts: [], gatePorts: [],
    construct: ["bands"], options: ["lowMode", "highMode", "fmodRange"],
    make: (rate, options) => new PeqKernel(rate, options),
    params: [
      unit("bandwidth", 0.33, 0, 1),
      unit("frequencyCvAtten", 0, -1, 1),
      ...peqBandParams(),
    ],
    audioInputs: ["in", "frequency_cv", "bandwidth_cv", ...numberedPorts("level", PEQ_MAX_BANDS, "_cv")],
    outputs: ["out", ...numberedPorts("band", PEQ_MAX_BANDS)],
  },
  {
    name: "vc3b-vco-processor", module: "vcvBogVco", label: "VCV Bogaudio VCO",
    pitchPorts: ["pitch"], gatePorts: [],
    construct: [], options: ["slow", "tuning", "fmMode", "dcCorrection"],
    make: (rate) => new VcoKernel(rate),
    params: [
      // R7-UNITS clause 3: SEMITONES from C4, so their -3…+6 V is -36…+72 st. The
      // knob and the `pitch` inlet are then in one unit and sum in the pitch domain.
      unit("frequency", 0, -36, 72),
      unit("fine", 0, -1, 1),
      unit("pw", 0, -1, 1),
      unit("fmDepth", 0, 0, 1),
    ],
    audioInputs: ["pitch", "sync", "pw_cv", "fm"],
    outputs: ["square", "saw", "triangle", "sine"],
  },
  {
    name: "vc3b-vcf-processor", module: "vcvBogVcf", label: "VCV Bogaudio VCF",
    pitchPorts: ["pitch"], gatePorts: [],
    construct: [], options: ["mode", "bandwidthMode"],
    make: (rate) => new VcfKernel(rate),
    params: [
      unit("frequency", 1000, 3, 20000),
      unit("frequencyCvAtten", 0, -1, 1),
      unit("fmDepth", 0, 0, 1),
      unit("q", 0, 0, 1),
      unit("slope", 0.522233, 0, 1),
    ],
    audioInputs: ["in", "frequency_cv", "fm", "pitch", "q_cv", "slope_cv"],
    outputs: ["out"],
  },
  {
    name: "vc3b-sample-hold-processor", module: "vcvSamplehold", label: "VCV Bogaudio S&H",
    pitchPorts: [], gatePorts: ["trigger1", "trigger2"],
    construct: ["seed"], options: ["track1", "invert1", "track2", "invert2", "noiseType", "range"],
    make: (rate, options) => new SampleHoldKernel(rate, options),
    params: [unit("smoothMs", 0, 0, 10000)],
    audioInputs: ["trigger1", "in1", "trigger2", "in2"],
    outputs: ["out1", "out2"],
  },
  {
    name: "vc3b-walk-processor", module: "vcvWalk", label: "VCV Bogaudio Walk",
    pitchPorts: [], gatePorts: ["jump"],
    construct: ["seed"], options: ["jumpMode"],
    make: (rate, options) => new WalkKernel(rate, options),
    params: [unit("rate", 0.1, 0, 1), unit("offset", 0, -1, 1), unit("scale", 1, 0, 1)],
    audioInputs: ["rate_cv", "offset_cv", "scale_cv", "jump"],
    outputs: ["out"],
  },
  {
    name: "vc3b-pressor-processor", module: "vcvPressor", label: "VCV Bogaudio Pressor",
    pitchPorts: [], gatePorts: [],
    construct: [], options: ["mode", "detector", "knee"],
    make: (rate) => new PressorKernel(rate),
    params: [
      unit("threshold", 0, -24, 6),
      unit("thresholdRange", 1, 0, 4),
      unit("ratio", 0.55159, 0, 1),
      unit("attack", 50, 0, 500),
      unit("release", 200, 0, 2000),
      unit("inputGain", 0, -12, 12),
      unit("outputGain", 0, 0, 24),
      unit("detectorMix", 0, -1, 1),
    ],
    audioInputs: ["left", "right", "sidechain", "threshold_cv", "ratio_cv", "attack_cv", "release_cv", "input_gain_cv", "output_gain_cv"],
    outputs: ["envelope", "left", "right"],
  },
  {
    name: "vc3b-vca-processor", module: "vcvBogVca", label: "VCV Bogaudio VCA",
    pitchPorts: [], gatePorts: [],
    construct: [], options: ["taper"],
    make: (rate) => new VcaKernel(rate),
    params: [unit("level1", 0.8, 0, 1), unit("level2", 0.8, 0, 1)],
    audioInputs: ["cv1", "in1", "cv2", "in2"],
    outputs: ["out1", "out2"],
  },
  {
    name: "vc3b-vcm-processor", module: "vcvVcm", label: "VCV Bogaudio VCM",
    pitchPorts: [], gatePorts: [],
    construct: [], options: ["taper", "outputLimit"],
    make: () => new VcmKernel(),
    params: [
      unit("level1", 0.8, 0, 1), unit("level2", 0.8, 0, 1),
      unit("level3", 0.8, 0, 1), unit("level4", 0.8, 0, 1),
      unit("mix", 0.8, 0, 1),
    ],
    audioInputs: ["in1", "cv1", "in2", "cv2", "in3", "cv3", "in4", "cv4", "mix_cv"],
    outputs: ["mix"],
  },
  {
    name: "vc3b-xfade-processor", module: "vcvXfade", label: "VCV Bogaudio XFade",
    pitchPorts: [], gatePorts: [],
    construct: [], options: ["taper"],
    make: (rate) => new XFadeKernel(rate),
    params: [unit("mix", 0, -1, 1), unit("curve", 0.5, 0, 1)],
    audioInputs: ["mix_cv", "a", "b"],
    outputs: ["out"],
  },
  {
    name: "vc3b-offset-processor", module: "vcvOffset", label: "VCV Bogaudio Offset",
    pitchPorts: [], gatePorts: [],
    construct: [], options: ["order", "outputLimit"],
    make: () => new OffsetKernel(),
    // `SQUARE_ROOT_ONE_TENTH` is their default: a signed square times ten, so
    // sqrt(0.1) is a scale of EXACTLY 1.0. Written as the root, not as 0.316, so
    // the reason the number is that number survives.
    params: [unit("offset", 0, -1, 1), unit("scale", Math.sqrt(0.1), -1, 1)],
    audioInputs: ["offset_cv", "scale_cv", "in"],
    outputs: ["out"],
  },
  {
    name: "vc3b-switch-processor", module: "vcvSwitch", label: "VCV Bogaudio Switch",
    pitchPorts: [], gatePorts: ["gate"],
    construct: [], options: ["latch"],
    make: () => new SwitchKernel(),
    params: [],
    audioInputs: ["gate", "high1", "low1", "high2", "low2"],
    outputs: ["out1", "out2"],
  },
  {
    name: "vc3b-stack-processor", module: "vcvStack", label: "VCV Bogaudio Stack",
    pitchPorts: ["cv", "in", "thru", "out"], gatePorts: [],
    construct: [], options: ["quantize"],
    make: () => new StackKernel(),
    params: [unit("semitones", 0, 0, 11), unit("octave", 0, -3, 3), unit("fine", 0, -0.99, 0.99)],
    audioInputs: ["cv", "in"],
    outputs: ["thru", "out"],
  },
];

/**
 * Pure function. The setter method name a discrete option maps to, by CONVENTION
 * rather than by a hand-kept table — option `lowMode` is `setLowMode`. The same
 * rule AX-2 states; a table would be a second list to forget a row in.
 *
 * @param {string} option - the discrete knob's key
 * @returns {string} the kernel method name
 *
 * @example vc3bOptionSetter("lowMode") // "setLowMode"
 * @example vc3bOptionSetter("taper") // "setTaper"
 */
export function vc3bOptionSetter(option) {
  return `set${option.charAt(0).toUpperCase()}${option.slice(1)}`;
}

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The
// guard is what lets modules_vc3b.js and the tests import the roster above from
// the main thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of VC3B_PROCESSORS) {
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
        // THE PER-PORT SCALES, resolved ONCE at construction from the roster (see
        // BOG_GATE_VOLTS above for the three kinds). A per-sample lookup would be
        // an allocation-free but pointless string compare in the inner loop.
        const pitch = new Set(entry.pitchPorts);
        const gate = new Set(entry.gatePorts);
        this.inputScale = Float64Array.from(this.inputNames, (name) => (
          pitch.has(name) ? 1 : gate.has(name) ? BOG_GATE_VOLTS : RACK_VOLTS_PER_UNIT
        ));
        this.outputScale = Float64Array.from(entry.outputs, (name) => (
          pitch.has(name) ? 1 : gate.has(name) ? 1 / BOG_GATE_VOLTS : 1 / RACK_VOLTS_PER_UNIT
        ));
        this.frame = new Float64Array(entry.outputs.length);
        // THE MODULATE DIVIDER (D1). It counts SAMPLES and is deliberately not
        // reset per quantum: 120 does not divide 128, so their control rate is
        // not quantum-aligned and pretending it is would drift by 8 samples a
        // block — 6% of the period.
        this.modulateSteps = bogModulateSteps(sampleRate);
        this.tick = 0;
      }

      /** Command. Apply one discrete option to the kernel, by the naming
       *  convention `vc3bOptionSetter` states. LOUD if the kernel lacks it. */
      setOption(option, value) {
        const setter = vc3bOptionSetter(option);
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
        // channel 0 is read — our wire is mono (D6), and a stereo source feeding
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
          // write below), and the scale is per PORT KIND rather than global — see
          // BOG_GATE_VOLTS. A third site anywhere would mean some path is scaled
          // twice, and a factor of five is inaudible on one module and
          // catastrophic across a patch.
          for (let n = 0; n < inputNames.length; n++) {
            const channel = channels[n];
            signals[inputNames[n]] = channel === null ? 0 : channel[i] * this.inputScale[n];
          }
          if (this.tick === 0) this.kernel.control(knobs, signals, wired);
          this.kernel.sample(knobs, signals, wired, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o] * this.outputScale[o];
          this.tick = this.tick + 1 >= this.modulateSteps ? 0 : this.tick + 1;
        }
        return true;
      }
    });
  }
}
