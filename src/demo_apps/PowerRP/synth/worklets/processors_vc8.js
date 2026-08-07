/**
 * THE VC-8 AUDIOWORKLET PROCESSORS — eleven NYSTHI modules on the audio thread.
 *
 * ── WHY A SEPARATE WORKLET FILE ─────────────────────────────────────────────
 * One per port block (R7 Wave 3 Phase 3): several agents land module sets
 * concurrently, so one shared worklet file is one merge conflict per agent per
 * save. The engine loads them all with `addModule`; the AudioWorklet global scope
 * is SHARED, so `registerProcessor` names must be globally unique — hence the
 * `vc8-` prefix on every one below.
 *
 * ── THIS FILE IMPORTS, AND THE CONDITION IS MEASURED ────────────────────────
 * AX-2 measured that a module worklet takes static imports on this repo's Chrome;
 * AX-3 measured the CONDITION — only if its URL goes through Vite's
 * `?worker&url` pipeline, which is why that specifier lives in
 * `synth/worklet_urls.js` and NOT here. Without the pipeline the import 404s in
 * production off a build that exits 0 with no audio at all.
 *
 * ── REAL-TIME SAFETY (the checklist `processors.js` sets) ───────────────────
 * `process()` runs every 128 samples. ZERO allocations in it: the `signals`
 * object, the `wired` object, the frame buffer and every parameter-array slot are
 * built in the constructor and mutated in place. No `new`, no object literals, no
 * closures. Always `return true`.
 *
 * ── THE ONE THING THIS FILE IS FOR: THE UNIT BOUNDARY (R7-UNITS, kernels' D1) ─
 * NYSTHI computes in Rack VOLTS; PowerRP wires carry ±1 levels, 0…1 gates and
 * `number` ports in REAL UNITS. The conversion happens HERE and nowhere else, in
 * exactly two places — one read, one write — off a per-port scale table with
 * THREE kinds:
 *
 *   LEVEL (clause 1)  `volts = wire · 5`. THE DEFAULT. An audio signal or a
 *                     generic bipolar CV. Our ±1 IS Rack's ±5 V.
 *   GATE  (clause 4)  `volts = wire · 10`. Logic is not level: our gates are 0…1
 *                     and a Rack gate is 10 V. It also matters numerically —
 *                     `TRIGGER_HIGH_VOLTS` is 1 V, so a ×5 gate of 1.0 would land
 *                     exactly on the threshold and a gate of 0.99 would never
 *                     fire. Declared in a row's `gatePorts`.
 *   UNIT  (clause 2)  `volts = wire`, i.e. NO SCALE, because the port does not
 *                     carry volts at all — it carries seconds (the delay's
 *                     `time`), a 0…1 fraction (its `feedback`, its `feed_in`) or
 *                     an envelope stage time. Declared in a row's `unitPorts`.
 *
 * **VC-3b's third kind is PITCH and VC-8 has none**, which is worth stating
 * rather than leaving to inference: clause 3 governs V/oct ports and this block
 * contains no oscillator and no pitch inlet. The `unitPorts` column is that
 * column's slot, carrying seconds and fractions instead of semitones. The moment
 * a V/oct port lands here the roster gains a `pitchPorts` column exactly as
 * VC-3b's has, and it is NOT faked in advance.
 *
 * A port absent from both lists is a LEVEL port. That default is deliberate:
 * level is the common case, and a NEW port that forgot to declare itself gets the
 * scale that is right for a signal rather than one that is right for nothing.
 *
 * ── AND THE THING ONLY THIS FILE CAN DO: `isConnected()` (kernels' D3) ──────
 * A NYSTHI CV law can branch on whether a cable is present — the QuadPanner's
 * documented mode is literally *"uses 10V if no input"*, and the delay's four
 * send/return points are BREAKS that only engage when the return is patched. No
 * AudioParam can express that, so every wireable inlet is an `audio` input at its
 * own input INDEX and connectedness is `inputs[i].length > 0`. The kernels take
 * `wired` as an explicit map so `tests/port_vc8_test.js` drives both branches.
 *
 * ── NO CONTROL DIVIDER (kernels' D2) ────────────────────────────────────────
 * VC-3b's loop calls `control()` every ~2.5 ms because `src/module.cpp:22` states
 * that rate. NYSTHI states no divisor — there is no source to state it in — so
 * inventing one would be R7-11's error in the other direction. The loop below
 * calls `sample()` once per sample and there is no `control()` at all.
 */

import {
  AttackDecayKernel, B208DualLpgKernel, B208EnvelopeKernel, CDELAY_CEILING_SECONDS,
  ClockableDelayKernel, MIX4_CHANNELS, Mix4Kernel, NYSTHI_GATE_VOLTS, PROGRAMMER_CHANNELS, PROGRAMMER_MODE_RUN,
  PROGRAMMER_STAGES, ProgrammerKernel, PolyLpgKernel, QUAD_CORNERS, QuadPannerKernel,
  RACK_VOLTS_PER_UNIT, SQUONK_CHANNELS, SQUONK_MODE_CV_AND_TRIG, SQUONK_STAGES, SQUONK_MAX_REPEATS,
  SoyModelSouKernel, SurveillanceKernel, SquonkKernel, SURVEILLANCE_OUTPUTS,
} from "../vc8_kernels.js";

/** An a-rate AudioParam descriptor. Every knob in this block is one; the CV
 *  INLETS are audio inputs instead (D3), so this is only ever a panel control. */
const unit = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "a-rate" });

/** The longest stage either envelope's sliders reach, in seconds — the 208's own
 *  *"from 2 msecs to 10 secs"* and the AD's *"from 0 to 10 secs"*, which are the
 *  same ceiling. Restated here because an AudioParam needs a bound and the
 *  kernels' clamp is the authority; `tests/port_vc8_test.js` pins the pair. */
const ENV_MAX_SECONDS = 10;

/** A `0` or `1` panel switch that is LATCHING and therefore property state (the
 *  kernels' D5 boundary). VC-2's SEQ3 `toggle` is the precedent for expressing
 *  one as a stepped a-rate param rather than a discrete option: it lives inside
 *  the DSP loop, and 12 or 16 of them per module would be 12 or 16 message
 *  setters otherwise. */
const toggle = (name, defaultValue) => ({ name, defaultValue, minValue: 0, maxValue: 1, automationRate: "a-rate" });

/**
 * Pure function. `n` numbered port or param keys — `numberedKeys("in", 4)` is
 * `["in1", …, "in4"]`. VC-3b's helper, same reason: four of the rosters below are
 * numbered families and a hand-typed list of sixteen is a list with a typo.
 *
 * @param {string} stem
 * @param {number} count
 * @param {string} [suffix]
 * @returns {string[]}
 *
 * @example numberedKeys("in", 3) // ["in1", "in2", "in3"]
 * @example numberedKeys("cv", 2, "_x") // ["cv1_x", "cv2_x"]
 */
export function numberedKeys(stem, count, suffix = "") {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(`${stem}${i}${suffix}`);
  return keys;
}

/**
 * Pure function. `n` keys numbered with a SEPARATOR before the index —
 * `underscoredKeys("in", 4)` is `["in_1", …, "in_4"]`. A second helper rather
 * than a flag on the first because the two spellings are both real contracts
 * (`in_1` on the dual LPG, `in1` on the mixer) and a boolean argument at every
 * call site reads worse than two named functions.
 *
 * @param {string} stem
 * @param {number} count
 * @returns {string[]}
 *
 * @example underscoredKeys("out", 3) // ["out_1", "out_2", "out_3"]
 */
export function underscoredKeys(stem, count) {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(`${stem}_${i}`);
  return keys;
}

/**
 * Pure function. `i0 … i(n-1)`, the index-keyed port spelling three modules in
 * this block keep on purpose.
 *
 * THE REASON THE KEYS ARE INDICES: the b208 envelope, the Serge Programmer and
 * the Source of Uncertainty have jack layouts that are DERIVED (from cable types,
 * strides and release chronology) rather than published. A plausible name in the
 * KEY would make a derivation look resolved; the key carries the fact and the
 * spec's `label` carries the inference. `core/audio_patches_vcv_fx.js`'s own
 * deviation list states this rule and these three are its subjects.
 *
 * @param {string} prefix - "i" or "o"
 * @param {number} count
 * @returns {string[]}
 *
 * @example indexKeys("i", 3) // ["i0", "i1", "i2"]
 * @example indexKeys("o", 2) // ["o0", "o1"]
 */
export function indexKeys(prefix, count) {
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(`${prefix}${i}`);
  return keys;
}

/**
 * Pure function. SQUONK's generated stage band — five CV values, a mode and a
 * repeat count per stage, for twelve stages.
 *
 * GENERATED, NOT WRITTEN OUT, for the reason VC-2's SEQ3 generates its 24 CV
 * knobs and VC-3b's PEQ its 28: a hand-typed 84-entry list is a list with a typo,
 * and a renamed channel could otherwise exist in one of two places only. See the
 * kernels' D18 for why the matrix is a knob band at all.
 *
 * @returns {object[]} AudioParam descriptors
 *
 * @example squonkStageParams().length // 84
 * @example squonkStageParams()[0].name // "a1"
 * @example squonkStageParams().filter((p) => p.name.startsWith("rep")).length // 12
 */
export function squonkStageParams() {
  const params = [];
  for (const channel of SQUONK_CHANNELS) {
    for (let stage = 1; stage <= SQUONK_STAGES; stage++) params.push(unit(`${channel}${stage}`, 0, -1, 1));
  }
  for (let stage = 1; stage <= SQUONK_STAGES; stage++) {
    params.push(unit(`mode${stage}`, SQUONK_MODE_CV_AND_TRIG, 0, 2));
  }
  for (let stage = 1; stage <= SQUONK_STAGES; stage++) {
    params.push(unit(`rep${stage}`, 1, 1, SQUONK_MAX_REPEATS));
  }
  return params;
}

/** The Programmer's ratchet ceiling. `:1069` says *"repetitions (number of
 *  subdivisions pulses)"* and gives no bound, so it borrows SQUONK's documented
 *  1…8 — the same vendor, the same control, one number. Part of G19's family of
 *  unstated ranges. */
const PROGRAMMER_MAX_REPEATS = SQUONK_MAX_REPEATS;

/**
 * Pure function. The Serge Programmer's generated stage band — four CV values, a
 * RUN/STOP/SKIP mode, an active flag and a repeat count per stage, sixteen times.
 *
 * @returns {object[]} AudioParam descriptors
 *
 * @example programmerStageParams().length // 112
 * @example programmerStageParams()[0].name // "a1"
 * @example programmerStageParams().filter((p) => p.name.startsWith("active")).length // 16
 */
export function programmerStageParams() {
  const params = [];
  for (const channel of PROGRAMMER_CHANNELS) {
    for (let stage = 1; stage <= PROGRAMMER_STAGES; stage++) params.push(unit(`${channel}${stage}`, 0, -1, 1));
  }
  for (let stage = 1; stage <= PROGRAMMER_STAGES; stage++) {
    params.push(unit(`mode${stage}`, PROGRAMMER_MODE_RUN, 0, 2));
  }
  for (let stage = 1; stage <= PROGRAMMER_STAGES; stage++) params.push(toggle(`active${stage}`, 1));
  for (let stage = 1; stage <= PROGRAMMER_STAGES; stage++) {
    params.push(unit(`rep${stage}`, 1, 1, PROGRAMMER_MAX_REPEATS));
  }
  return params;
}

/**
 * Pure function. The dual LPG's per-channel band — a base level, a CV
 * attenuator, a resonance and a vactrol response, four times.
 *
 * @returns {object[]} AudioParam descriptors
 *
 * @example lpgChannelParams().length // 16
 * @example lpgChannelParams()[0].name // "level_1"
 */
export function lpgChannelParams() {
  const params = [];
  for (let n = 1; n <= 4; n++) {
    params.push(unit(`level_${n}`, 0, 0, 1));
    params.push(unit(`cv_amount_${n}`, 1, -1, 1));
    params.push(unit(`reso_${n}`, 0, 0, 1));
    params.push(unit(`response_${n}`, 1, 0, 1));
  }
  return params;
}

/**
 * THE ROSTER — ONE ROW PER NODE, AND THE ONLY DECLARATION OF ANY OF IT.
 *
 *   name         the `registerProcessor` id, globally unique across worklet files
 *   module       the MODULE_FACTORIES key, i.e. a spec's `module` field
 *   label        `meta.label`
 *   make         `(sampleRate, constructOptions) -> kernel`
 *   params       the a-rate AudioParams — THE KNOBS, in real units
 *   gatePorts    the ports carrying 0…1 LOGIC (×10 volts) — R7-UNITS clause 4
 *   unitPorts    the ports carrying a REAL UNIT and therefore NO scale — clause 2
 *   audioInputs  the audio input port keys, IN INPUT-INDEX ORDER (D3)
 *   construct    knobs passed as `processorOptions` (a seed cannot be a param)
 *   options      discrete knobs set by message through `vc8OptionSetter`
 *   outputs      output port names, in output-index order
 *
 * `modules_vc8.js` builds its eleven factories FROM THIS ARRAY rather than
 * restating any of it, and `tests/port_vc8_test.js` checks it against
 * `core/audio_specs_vc8.js` in turn — so a port renamed here cannot leave a spec
 * declaring one the engine does not have.
 */
export const VC8_PROCESSORS = [
  {
    name: "vc8-b208-dual-lpg-processor", module: "vcvB208DualLpg", label: "VCV b208 Dual LPG",
    gatePorts: [], unitPorts: [],
    construct: [], options: ["mode1", "mode2", "mode3", "mode4"],
    make: (rate) => new B208DualLpgKernel(rate),
    params: lpgChannelParams(),
    audioInputs: [...underscoredKeys("in", 4), ...underscoredKeys("cv", 4)],
    outputs: underscoredKeys("out", 4),
  },
  {
    name: "vc8-poly-lpg-processor", module: "vcvPolyLpg", label: "VCV Poly LPG",
    gatePorts: [], unitPorts: [],
    construct: [], options: ["mode"],
    make: (rate) => new PolyLpgKernel(rate),
    // `level`, `response` and `offset` are the harvested contract's own three
    // knob names and they match Julste's documented Range / Sharpness / Offset.
    // `reso` is added because the LPG has one in `lp` mode and the harvest simply
    // never saw it set.
    params: [unit("level", 1, -1, 1), unit("response", 1, 0, 1), unit("offset", 0, -1, 1), unit("reso", 0, 0, 1)],
    audioInputs: ["in", "cv"],
    outputs: ["out"],
  },
  {
    name: "vc8-b208-envelope-processor", module: "vcvB208Envelope", label: "VCV b208 Envelope",
    // i0 and i4 are the two sections' GATE/TRIG jacks; o0/o1 and o3/o4 are their
    // end-of-rise and end-of-cycle pulses. Everything else on this module is a
    // level or a time. See the kernels' G10 for how the layout was derived.
    gatePorts: ["i0", "i4", "o0", "o1", "o3", "o4"],
    unitPorts: ["i1", "i2", "i3", "i5", "i6", "i7"],
    construct: [], options: ["mode1", "mode2"],
    make: (rate) => new B208EnvelopeKernel(rate),
    params: [
      unit("attack_1", 0.01, 0, ENV_MAX_SECONDS), unit("duration_1", 0.1, 0, ENV_MAX_SECONDS),
      unit("decay_1", 0.5, 0, ENV_MAX_SECONDS), unit("curve_1", 1, 0, 1),
      unit("attack_2", 0.01, 0, ENV_MAX_SECONDS), unit("duration_2", 0.1, 0, ENV_MAX_SECONDS),
      unit("decay_2", 0.5, 0, ENV_MAX_SECONDS), unit("curve_2", 1, 0, 1),
    ],
    audioInputs: indexKeys("i", 8),
    outputs: indexKeys("o", 6),
  },
  {
    name: "vc8-attack-decay-processor", module: "vcvAttackDecay", label: "VCV Attack Decay",
    gatePorts: ["trig", "retrig", "eoc"],
    unitPorts: ["attack_cv", "decay_cv"],
    construct: [], options: [],
    make: (rate) => new AttackDecayKernel(rate),
    params: [
      unit("attack", 0.4365, 0, ENV_MAX_SECONDS), unit("decay", 0.1, 0, ENV_MAX_SECONDS),
      unit("curve", 1, 0, 1), unit("scale", 1, -2, 2), toggle("loop", 0),
    ],
    audioInputs: ["attack_cv", "decay_cv", "retrig", "trig"],
    outputs: ["out", "eoc"],
  },
  {
    name: "vc8-quad-panner-processor", module: "vcvQuadPanner", label: "VCV QuadPanner",
    gatePorts: ["gate"], unitPorts: [],
    construct: [], options: ["panLaw", "blackHole"],
    make: (rate) => new QuadPannerKernel(rate),
    params: [
      unit("azimuth", 0, -1, 1), unit("magnitude", 1, 0, 1),
      unit("swirl_rate", 0, 0, 20), unit("swirl_amount", 1, 0, 1),
    ],
    audioInputs: ["in", "x", "y", ...QUAD_CORNERS.map((c) => `chain_${c}`)],
    outputs: [...QUAD_CORNERS.map((c) => `out_${c}`), "gate"],
  },
  {
    name: "vc8-clockable-delay-processor", module: "vcvClockableDelay", label: "VCV ClockableDelay",
    gatePorts: ["tap", "trig_time", "hold", "reverse", "pulse"],
    // `time` is SECONDS, `feed_in` and `feedback` are 0…2 and 0…1.1 fractions —
    // R7-UNITS clause 2, so none of the three is scaled.
    unitPorts: ["time", "feed_in", "feedback"],
    construct: ["max_seconds"], options: [],
    make: (rate, options) => new ClockableDelayKernel(rate, options),
    params: [
      unit("time", 8.4788, 0, CDELAY_CEILING_SECONDS), unit("mult", 1, 0.001, 32),
      unit("feed_in", 1, 0, 2), unit("feedback", 0.5945, 0, 1.1), unit("dry_wet", 0.5, 0, 1),
    ],
    audioInputs: [
      "in_l", "in_r", "return_fb_l", "return_fb_r", "return_dw_l", "return_dw_r",
      "feed_in", "feedback", "time", "tap", "trig_time", "hold", "reverse",
    ],
    outputs: [
      "send_fb_l", "send_fb_r", "send_dw_l", "send_dw_r", "send_rev_l", "send_rev_r",
      "send_hold_l", "send_hold_r", "out_l", "out_r", "pulse",
    ],
  },
  {
    name: "vc8-mix4-processor", module: "vcvNysthiMix4", label: "NYSTHI Mix4",
    gatePorts: [], unitPorts: [],
    construct: [], options: [],
    make: () => new Mix4Kernel(),
    params: [
      ...numberedKeys("level", MIX4_CHANNELS).map((key) => unit(key, 0.8, 0, 1)),
      ...numberedKeys("pan", MIX4_CHANNELS).map((key) => unit(key, 0, -1, 1)),
      ...numberedKeys("cv_amount", MIX4_CHANNELS).map((key) => unit(key, 1, 0, 1)),
      unit("master", 0.8, 0, 1), unit("master_cv_amount", 1, 0, 1),
    ],
    audioInputs: [...numberedKeys("in", MIX4_CHANNELS), ...numberedKeys("cv", MIX4_CHANNELS), "master_cv"],
    outputs: ["out_l", "out_r"],
  },
  {
    name: "vc8-surveillance-processor", module: "vcvSurveillance", label: "VCV Surveillance",
    gatePorts: [], unitPorts: [],
    construct: [], options: ["range"],
    make: () => new SurveillanceKernel(),
    params: [
      unit("main", 1, -1, 1),
      ...underscoredKeys("v", SURVEILLANCE_OUTPUTS).map((key) => unit(key, 0, -1, 1)),
    ],
    audioInputs: [],
    outputs: underscoredKeys("out", SURVEILLANCE_OUTPUTS),
  },
  {
    name: "vc8-squonk-processor", module: "vcvSquonk", label: "VCV SQUONK",
    gatePorts: ["clock", "start", "stop", "reset", "rnd", "chain_trig", "trig", "last", "clock_out"],
    unitPorts: [],
    construct: ["seed"], options: [],
    make: (rate, options) => new SquonkKernel(rate, options),
    params: [unit("sel", 0, 0, SQUONK_STAGES - 1), unit("rot", 0, -5, 5), toggle("up", 0), toggle("rnd", 0), toggle("multiply", 0), ...squonkStageParams()],
    audioInputs: ["sel", "clock", "start", "stop", "reset", "rnd", "chain_trig"],
    outputs: [...SQUONK_CHANNELS, "trig", "last", "clock_out"],
  },
  {
    name: "vc8-programmer-processor", module: "vcvProgrammer", label: "VCV Programmer",
    // i0…i15 are the sixteen per-stage select triggers, i16/i17 the forward and
    // backward clocks; o0…o15 the per-stage pulses and o20/o21 the global TRIG
    // and PUSH. i18 (ADDR) is a V/oct-shaped address, so it is a UNIT port, and
    // o16…o19 are the four CV outputs, so they are LEVEL. Kernels' record item 2.
    gatePorts: [...indexKeys("i", 18), ...indexKeys("o", 16), "o20", "o21"],
    unitPorts: ["i18"],
    construct: [], options: [],
    make: (rate) => new ProgrammerKernel(rate),
    params: programmerStageParams(),
    audioInputs: indexKeys("i", 19),
    outputs: indexKeys("o", 22),
  },
  {
    name: "vc8-soy-model-sou-processor", module: "vcvSoyModelSou", label: "VCV SoyModelSOU",
    // o2/o5 are the two fluctuating sections' PULSE outs and o9…o13 the gates and
    // flip-flops; everything else is a voltage. See the kernels' G23.
    gatePorts: ["i0", "o2", "o5", "o9", "o10", "o11", "o12", "o13"],
    unitPorts: [],
    construct: ["seed"], options: [],
    make: (rate, options) => new SoyModelSouKernel(rate, options),
    params: [
      unit("rate_1", 0.2, 0, 1), unit("smooth_1", 0.2, 0, 10),
      unit("probability_1", 1, 0, 1),
      unit("rate_2", 0.05, 0, 1), unit("smooth_2", 1, 0, 10),
      unit("probability_2", 1, 0, 1),
      unit("n_power", 3, 1, 6), unit("n_plus", 3, 1, 6), unit("skew", 0, -1, 1),
    ],
    audioInputs: ["i0"],
    outputs: indexKeys("o", 14),
  },
];

/**
 * Pure function. The setter method name a discrete option maps to, by CONVENTION
 * rather than by a hand-kept table — option `panLaw` is `setPanLaw`. The same
 * rule AX-2 and VC-3b state; a table would be a second list to forget a row in.
 *
 * @param {string} option - the discrete knob's key
 * @returns {string} the kernel method name
 *
 * @example vc8OptionSetter("panLaw") // "setPanLaw"
 * @example vc8OptionSetter("mode3") // "setMode3"
 */
export function vc8OptionSetter(option) {
  return `set${option.charAt(0).toUpperCase()}${option.slice(1)}`;
}

// Everything below runs ONLY in the AudioWorklet global scope, where
// `registerProcessor`, `AudioWorkletProcessor` and `sampleRate` are ambient. The
// guard is what lets modules_vc8.js and the tests import the roster above from
// the main thread without this file exploding on them.
if (typeof registerProcessor === "function") {
  for (const entry of VC8_PROCESSORS) {
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
        // the header for the three kinds). A per-sample lookup would be an
        // allocation-free but pointless string compare in the inner loop.
        const gate = new Set(entry.gatePorts);
        const real = new Set(entry.unitPorts);
        this.inputScale = Float64Array.from(this.inputNames, (name) => (
          real.has(name) ? 1 : gate.has(name) ? NYSTHI_GATE_VOLTS : RACK_VOLTS_PER_UNIT
        ));
        this.outputScale = Float64Array.from(entry.outputs, (name) => (
          real.has(name) ? 1 : gate.has(name) ? 1 / NYSTHI_GATE_VOLTS : 1 / RACK_VOLTS_PER_UNIT
        ));
        this.frame = new Float64Array(entry.outputs.length);
      }

      /** Command. Apply one discrete option to the kernel, by the naming
       *  convention `vc8OptionSetter` states. LOUD if the kernel lacks it. */
      setOption(option, value) {
        const setter = vc8OptionSetter(option);
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
          // write below), and the scale is per PORT KIND rather than global. A
          // third site anywhere would mean some path is scaled twice, and a
          // factor of five is inaudible on one module and catastrophic across a
          // patch.
          for (let n = 0; n < inputNames.length; n++) {
            const channel = channels[n];
            signals[inputNames[n]] = channel === null ? 0 : channel[i] * this.inputScale[n];
          }
          // D2: NO control divider. NYSTHI documents none, so inventing one would
          // change every envelope and sweep in the block for no stated reason.
          this.kernel.sample(knobs, signals, wired, this.frame);
          for (let o = 0; o < outputs.length; o++) outputs[o][0][i] = this.frame[o] * this.outputScale[o];
        }
        return true;
      }
    });
  }
}
