/**
 * THE VC-5 AUDIOWORKLET PROCESSORS — nine ported VCV Rack modules on the audio
 * thread, over ONE generic processor class.
 *
 * ── WHY A GENERIC PROCESSOR AND NOT NINE CLASSES ────────────────────────────
 * `processors_ax3.js` writes one class per filter because each Axoloti filter has
 * a different per-sample body. These nine do not: every one of them is
 * "read N audio inputs, read the a-rate params, call `kernel.sample(controls,
 * inputs, frame)`, write M outputs". The bodies live in `../vc5_kernels.js`,
 * which is also where the R7-17 derivation records are and which bare node can
 * import. So this file is the roster plus one bridge — the shape AX-2 uses, with
 * audio INPUTS added (AX-2's ten are all sources and declare `numberOfInputs: 0`).
 *
 * `modules_vc5.js` DERIVES its nine factories from `VC5_PROCESSORS` rather than
 * restating any of it, so a param renamed here cannot leave a module wired to the
 * old name. `tests/port_vc5_test.js` checks the roster against
 * `core/audio_specs_vc5.js` in turn, which is the only place the two can be
 * compared (a worklet's `parameterDescriptors` cannot be read without an engine).
 *
 * ── `registerProcessor` NAMES ARE GLOBAL ────────────────────────────────────
 * The AudioWorklet scope is shared across every `addModule`, so these carry a
 * `vc5-` prefix. Four blocks now share that scope; a collision is a hard failure
 * at `addModule` time, which is the right place for it.
 *
 * ── THIS FILE IMPORTS, AND THAT IS MEASURED (see processors_ax2.js) ─────────
 * A module worklet takes static imports on this project's Chrome. That is what
 * lets `../vc5_kernels.js` be the ONE copy of 4000 lines of DSP with a bare-node
 * test over it, instead of a duplicate no test can read. THE BUILD SIDE IS THE
 * OPPOSITE and is not this file's business: `synth/worklet_urls.js` owns the
 * `?worker&url` specifier that bundles the import in, and it is the only file in
 * the repo allowed to contain Vite-only syntax. A Vite specifier here would take
 * the entire bare-node test lane down.
 *
 * ── REAL-TIME SAFETY (the checklist processors.js sets) ─────────────────────
 * `process()` runs every 128 samples. ZERO allocations in it: the control object,
 * the input frame and the output frame are built in the constructor and mutated in
 * place. No `new`, no literals, no closures. Always `return true`.
 *
 * ⚠ ONE OF THESE NINE IS EXPENSIVE AND IT IS WORTH KNOWING WHICH. `vcvPlateau`
 * allocates about 1.8 MB of Float64Array per instance (eight tank delay lines
 * sized for the largest Size, plus a 192010-sample pre-delay) and runs twelve
 * delay lines, four LFOs and eight filters per sample. `vcvXfxf35` at 4x
 * oversampling is eight filter evaluations and two 31-tap FIRs per sample. Neither
 * is a defect — they are what the modules are — but a deck with ten Plateaus is 18
 * MB of delay line.
 */

import {
  Chronoblob2Kernel, FelineKernel, JustAPhaserKernel, PlateauKernel, ReburstKernel,
  RewinKernel, SpfKernel, TerrorformKernel, Xfxf35Kernel,
} from "../vc5_kernels.js";

/** A gate/trigger param: anything above 0.5 is high, and the bound only keeps a
 *  wired signal from driving it somewhere meaningless. */
const gate = (name) => ({ name, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" });

/** A plain a-rate param. Positional because a roster of ninety of them reads
 *  better as a table than as ninety object literals. */
const p = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "a-rate" });

/** A 0..1 fraction. */
const unit = (name, defaultValue) => p(name, defaultValue, 0, 1);

/** V4: a pitch port, in SEMITONES from C4 (the lead's R7-UNITS ruling), over
 *  Rack's ±10 V cable range — which is ±120 semitones. */
const pitch = (name) => p(name, 0, -120, 120);

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name        the `registerProcessor` id, globally unique across worklet files
 *   module      the MODULE_FACTORIES key, i.e. the spec's `module` field
 *   label       `meta.label`
 *   make        `(sampleRate, options) -> kernel`
 *   audio       audio INPUT port names, in input-index order. May be empty.
 *   params      the a-rate AudioParams, which are ALSO the wireable number and
 *               trigger inputs. A param with no spec knob is an input-only
 *               modulation target (Plateau's `freeze`, JustAPhaser's `external_mod_*`).
 *   construct   knobs passed as `processorOptions` — a seed or anything whose
 *               change reallocates. The spec marks these `construct: true` and the
 *               mirror rebuilds the module.
 *   options     discrete/list knobs set by message through `vc5OptionSetter`.
 *   outputs     output port names, in output-index order.
 *
 * ⚠ A PARAM'S RANGE MUST BE AT LEAST AS WIDE AS ITS KNOB'S. Several are WIDER on
 * purpose, because the original's modulation input reaches past its dial:
 * Plateau's `pre_delay` dial stops at 0.5 s but the code clamps at 1;
 * JustAPhaser's rate dial stops at 3 but `LowFrequencyOscillator::setPitch` clamps
 * at 8. tests/port_vc5_test.js asserts the containment in that direction only — a
 * NARROWER param would silently discard a value the Inspector accepted, which is
 * the exact class of failure this project forbids.
 */
export const VC5_PROCESSORS = [
  {
    name: "vc5-plateau-processor", module: "vcvPlateau", label: "Plateau",
    make: (rate, options) => new PlateauKernel(rate, options),
    audio: ["in_l", "in_r"],
    params: [
      unit("dry", 1), unit("wet", 0.5),
      p("pre_delay", 0, 0, 1),
      p("input_low_damp", 10, 0, 10), p("input_high_damp", 10, 0, 10),
      unit("size", 0.5),
      p("diffusion", 10, 0, 10),
      p("decay", 0.54995, 0.1, 0.9999),
      p("reverb_low_damp", 10, 0, 10), p("reverb_high_damp", 10, 0, 10),
      unit("mod_speed", 0), unit("mod_shape", 0.5),
      p("mod_depth", 0.5, 0, 16),
      gate("freeze"), gate("clear"),
    ],
    construct: [],
    options: ["hold", "tuned", "diffuse", "sensitivity", "saturate"],
    outputs: ["out_l", "out_r"],
  },
  {
    name: "vc5-chronoblob2-processor", module: "vcvChronoblob2", label: "Chronoblob 2",
    make: (rate, options) => new Chronoblob2Kernel(rate, options),
    audio: ["in_l", "in_r", "fb_return"],
    params: [
      p("time", 0.25, 0.001, 10),
      p("feedback", 0.4, 0, 1.25),
      unit("mix", 0.5),
      p("damp", 20000, 20, 20000),
      gate("sync"), gate("hold"),
    ],
    construct: [],
    options: ["mode", "delay", "division", "prescaler"],
    outputs: ["out_l", "out_r", "fb_send"],
  },
  {
    name: "vc5-justaphaser-processor", module: "vcvJustaphaser", label: "Just A Phaser",
    make: (rate, options) => new JustAPhaserKernel(rate, options),
    audio: ["in_l", "in_r", "fb_in_l", "fb_in_r"],
    params: [
      // WIDER THAN THE DIAL on purpose: their LFO clamps pitch at 8, not at 3.
      p("frequency", 0, -8, 8),
      unit("depth", 0.5),
      p("feedback", 0, -1, 1),
      p("center_frequency", 8, 4, 14),
      p("frequency_span", 1, 0.01, 1),
      p("resonance", 0.707, 0.5, 5),
      p("stereo_phase", 0.25, 0, 0.99999),
      unit("mix", 0.5),
      // INPUT-ONLY: no knob, because an external modulation source with a knob
      // beside it would be an offset the original does not have.
      p("external_mod_l", 0, -2, 2), p("external_mod_r", 0, -2, 2),
    ],
    construct: [],
    options: ["stages", "filter", "wave", "span"],
    outputs: ["out_l", "out_r", "fb_out_l", "fb_out_r"],
  },
  {
    name: "vc5-feline-processor", module: "vcvFeline", label: "Feline",
    make: (rate) => new FelineKernel(rate),
    audio: ["in_l", "in_r"],
    params: [
      p("cutoff", 10, 0, 10),
      p("resonance", 0, 0, 10),
      unit("drive", 0),
      p("spacing", 0, -1, 1),
      unit("spacing_target", 0),
    ],
    construct: [],
    options: ["poles", "type"],
    outputs: ["out_l", "out_r", "sum"],
  },
  {
    name: "vc5-spf-processor", module: "vcvSpf", label: "SPF",
    make: (rate) => new SpfKernel(rate),
    audio: ["lp", "bp", "hp"],
    params: [p("freq", 10, 4, 14), p("r", 1, 0, 2)],
    construct: [],
    options: [],
    outputs: ["cv"],
  },
  {
    name: "vc5-xfxf35-processor", module: "vcvXfxf35", label: "XFX F-35",
    make: (rate, options) => new Xfxf35Kernel(rate, options),
    audio: ["in"],
    params: [p("frequency", 1000, 20, 20000), unit("resonance", 0), unit("drive", 0)],
    // `oversample` REALLOCATES the two FIR state buffers and the kernel, so it is
    // construct-time; `mode` only swaps a tap table, so it is live.
    construct: ["oversample"],
    options: ["mode"],
    outputs: ["out"],
  },
  {
    name: "vc5-terrorform-processor", module: "vcvTerrorform", label: "Terrorform",
    make: (rate, options) => new TerrorformKernel(rate, options),
    audio: [],
    params: [
      pitch("v_oct"),
      p("fm", 0, -10, 10),
      unit("wave", 0), unit("shape_depth", 0), unit("skew", 0),
      unit("lpg_attack", 0), unit("lpg_decay", 0.5),
      gate("trigger"), gate("sync"),
      p("octave", 0, -3, 3), p("coarse", 0, -12, 12), p("fine", 0, -0.5, 0.5),
      unit("fm_level", 0), unit("sub_level", 0), unit("sub_wave", 0),
    ],
    // `bank` generates 128 KB of Float32Array; `seed` IS the generator's state.
    construct: ["seed", "bank"],
    options: [
      "shape", "lpg_mode",
      "true_fm", "lfo_mode", "zero_freq", "post_pm_shape", "swap",
      "lpg_long", "lpg_velocity", "lpg_trigger",
    ],
    outputs: ["main", "raw", "sub", "env", "phasor", "eoc"],
  },
  {
    name: "vc5-rewin-processor", module: "vcvRewin", label: "rewin",
    make: () => new RewinKernel(),
    audio: [],
    params: [
      pitch("in_1"), pitch("in_2"), pitch("in_3"), pitch("in_4"),
      pitch("transpose"), pitch("semi"),
      p("scale", 2773, 0, 4095),
      p("octave_1", 0, -4, 4), p("octave_2", 0, -4, 4), p("octave_3", 0, -4, 4), p("octave_4", 0, -4, 4),
    ],
    construct: [],
    options: ["mode"],
    outputs: ["out_1", "out_2", "out_3", "out_4"],
  },
  {
    name: "vc5-reburst-processor", module: "vcvReburst", label: "reburst",
    make: (rate, options) => new ReburstKernel(rate, options),
    audio: [],
    params: [
      gate("gate"), gate("clock"),
      p("rep", 4, 0, 8),
      unit("time", 0.508),
      p("accel", 1, 1, 2),
      unit("jitter", 0),
    ],
    construct: ["seed"],
    options: ["cv_mode", "gate_mode"],
    outputs: ["gate_out", "eoc", "cv"],
  },
];

/**
 * Pure function. The setter method name a discrete/list option maps to, by
 * CONVENTION rather than by a hand-kept table — snake_case to a `set` prefix and
 * PascalCase. AX-2's `ax2OptionSetter` does the same thing for single-word
 * options; this block has multi-word ones (`lpg_mode`, `true_fm`), so the split on
 * `_` is the whole difference.
 *
 * @param {string} option - the knob's key
 * @returns {string} the kernel method name
 *
 * @example vc5OptionSetter("mode") // "setMode"
 * @example vc5OptionSetter("lpg_mode") // "setLpgMode"
 * @example vc5OptionSetter("true_fm") // "setTrueFm"
 */
export function vc5OptionSetter(option) {
  return `set${option.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`;
}

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The
// guard is what lets modules_vc5.js and the tests import the roster above from the
// main thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of VC5_PROCESSORS) {
    registerProcessor(entry.name, class extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return entry.params;
      }

      constructor(options) {
        super();
        const built = options.processorOptions ?? {};
        this.kernel = entry.make(sampleRate, built);
        // OPTIONS ARE APPLIED AT CONSTRUCTION AS WELL AS BY MESSAGE, and the
        // reason is measured (processors_ax2.js): a `port.postMessage` sent the
        // instant the node is built can lose the race with the first `process()`
        // — an OfflineAudioContext renders faster than the message hop — and a
        // browser probe caught an oscillator built as `saw` rendering SINE for
        // its opening frames. Anything a caller knows at construction is applied
        // at construction. Idempotent: a kernel whose constructor already
        // consumed the option simply sets it again to the same value.
        for (const option of entry.options) {
          if (built[option] !== undefined) this.setOption(option, built[option]);
        }
        this.names = entry.params.map((descriptor) => descriptor.name);
        this.arrays = new Array(this.names.length).fill(null);
        this.controls = {};
        for (const name of this.names) this.controls[name] = 0;
        this.audio = new Float64Array(Math.max(entry.audio.length, 1));
        this.frame = new Float64Array(entry.outputs.length);
        this.port.onmessage = (event) => this.setOption(event.data.option, event.data.value);
      }

      /** Command. Apply one discrete/list option to the kernel, by the naming
       *  convention `vc5OptionSetter` states. LOUD if the kernel lacks it. */
      setOption(option, value) {
        const setter = vc5OptionSetter(option);
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
        const audio = this.audio;
        const audioCount = entry.audio.length;
        for (let n = 0; n < names.length; n++) arrays[n] = parameters[names[n]];
        for (let i = 0; i < frames; i++) {
          for (let n = 0; n < names.length; n++) {
            const values = arrays[n];
            controls[names[n]] = values.length === 1 ? values[0] : values[i];
          }
          // An UNPATCHED audio input arrives as an empty array, not as zeros, so
          // the guard is per input and per frame rather than hoisted. Three of
          // these kernels distinguish "reads exactly 0" from "patched" (a feedback
          // return, a channel normalisation), so leaving a stale value here would
          // change their topology.
          for (let a = 0; a < audioCount; a++) {
            const channel = inputs[a];
            audio[a] = channel && channel.length > 0 ? channel[0][i] : 0;
          }
          this.kernel.sample(controls, audio, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o];
        }
        return true;
      }
    });
  }
}
