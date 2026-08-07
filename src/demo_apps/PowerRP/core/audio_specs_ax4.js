/**
 * THE AX-4 MODULE SPECS — the eleven ported Axoloti envelope / gain / mix /
 * distortion nodes.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary applied to a fourth module set: a spec is the
 * dozen values that make one module differ from its neighbours and NOTHING about
 * how it sounds. The DSP is `synth/ax4_kernels.js`. The R7-17 derivation record
 * — source object AND commit, WHICH `code.krate`/`code.srate` block, the
 * recurrence in float, every deviation by name — is the `derivation` field on
 * each spec below, which is AX-1's and AX-3's shape and is machine-checked by
 * `tests/port_ax4_test.js`.
 *
 * ── WHY A FOURTH FILE ───────────────────────────────────────────────────────
 * Six agents are writing ported module sets CONCURRENTLY (R7 Wave 3 Phase 3),
 * one block each; one shared file would be one merge conflict per agent per
 * save. `AUDIO_SPECS` in core/audio_specs.js stays the single roster and spreads
 * this array, so "registered" is still one list you can read.
 *
 * ── THIS FILE MAY NOT IMPORT synth/** ───────────────────────────────────────
 * core/ must run in bare node with no engine, so the two dial→seconds
 * conversions below are RESTATED from `synth/ax4_kernels.js` rather than
 * imported, exactly as AX-2 restated its LFO divisor. `tests/port_ax4_test.js`
 * pins each restatement against the kernel's own copy, so a drift is red rather
 * than silent. The one thing that is NOT restated is the pitch law: this file
 * calls the shared `semitonesToHz`, which IS Axoloti's E4 origin.
 *
 * ── THE UNIT RULING THIS BLOCK CARRIES (R7-UNITS clause 2) ──────────────────
 * **AN ENVELOPE TIME IS IN SECONDS.** Not the −64…64 dial an `.axp` stores. That
 * is the law's own worked example, and it is not a re-derivation here: Axoloti
 * declares a real unit for every one of these params through a `NativeToReal`
 * (`LinearTimeExp`, `DecayTime`), and this block inverts THAT function. A
 * `frac32.u.map` with no conversion declared — sustain, the mixer's gains, the
 * DP clippers' gains — is normalised dial/64 → 0…1, which is AX-2's precedent
 * for that parameter class.
 *
 * ⚠ **THE HARVESTED PATCHES CURRENTLY HOLD RAW DIALS ON THESE KNOBS**, and the
 * patch that harvested them said so and deferred to this block:
 * `core/audio_patches_axo_machine.js` — *"When AX-4's envelope lands and names
 * its own time units, re-derive from those four numbers."* This file is that
 * naming. The converters are `axTimeDialToSeconds` and `axDecayDialToSeconds`
 * in `synth/ax4_kernels.js`; the lead owns the patch files.
 *
 * ── THE GATE INPUTS ARE `audio`, NOT `trigger`, AND THAT IS FROM THE C ──────
 * Two patch agents declared `audio_ax_env_adsr.gate` and `audio_ax_env_ahd.gate`
 * with different types and `core/audio_stub_nodes.STUB_PORT_CONFLICTS` left the
 * choice to this block. Settled from what the objects DO with the signal:
 * `env/ahd m`'s `code.krate` is a bare `if (inlet_gate>0)` with no latch at all
 * — a pure LEVEL read — and `env/adsr`'s reads the level on BOTH edges and
 * SUSTAINS while it is high. Neither is an event. `trigger` would also be the
 * strictly worse choice under R7-UNITS clause 4's caution, because
 * `core/nodeflow.COERCIONS` has no `audio -> trigger`: an `audio` inlet accepts
 * a trigger source, a `trigger` inlet would REFUSE the LFO and comparator these
 * envelopes are legitimately driven from (`env/adsr.axh`, their own help patch,
 * drives it from `lfo/square`). The two DECAY envelopes keep `trigger`, because
 * `env/d`'s `bool32.rising` inlet really is edge-latched (`ntrig`).
 */

import { semitonesToHz } from "./audio_nodes.js";

// ── THE DIAL, RESTATED (see the header: core may not import synth) ──────────

/** A signed Axoloti dial's full-scale reading. */
const AX_DIAL_FULL = 64;

/** An unsigned dial's own quantisation in the editor (R7-11: "Unsigned dials
 *  0…64 step 0.5; signed −64…64 step 1.0"). */
const AX_DIAL_STEP = 0.5;

/** `realunits/LinearTimeExp.java`'s `32`, which is `2·BUFSIZE` — see
 *  synth/ax4_kernels.AX_TIME_PHASE_CYCLES for why it is two factors, not one. */
const AX_TIME_PHASE_CYCLES = 32;

/** `realunits/DecayTime.java`'s constants, at the hardware's own 48 kHz. */
const AX_DECAY_RATE_DIVISOR = 4096;
const AX_HARDWARE_TICK_SECONDS = 16 / 48000;

/** `__USAT(v, 27)` caps an unsigned dial one raw step below 64. */
const AX_DIAL_USAT_MAX = (2 ** 27 - 1) / 2 ** 21;

/**
 * Pure function. `LinearTimeExp` — the seconds an Axoloti dial reads on the
 * ADSR's a/d/r and on both decay envelopes' `d`. Restated from
 * `synth/ax4_kernels.axTimeDialToSeconds` and pinned against it by
 * tests/port_ax4_test.js.
 *
 * @param {number} dial - the XML dial value, −64…64
 * @returns {number} seconds
 *
 * @example Math.round(axTimeDialSeconds(0) * 1e6) / 1e6 // 0.097079
 * @example Math.round(axTimeDialSeconds(24) * 1e6) / 1e6 // 0.388317
 */
export function axTimeDialSeconds(dial) {
  return AX_TIME_PHASE_CYCLES / semitonesToHz(-dial);
}

/**
 * Pure function. `DecayTime` — the half-life an Axoloti dial reads on
 * `env/ahd m`'s a and d. Restated from
 * `synth/ax4_kernels.axDecayDialToSeconds` and pinned against it.
 *
 * @param {number} dial - the XML dial value, 0…64
 * @returns {number} seconds
 *
 * @example Math.round(axDecayDialSeconds(0) * 1e6) / 1e6 // 0.014787
 * @example Math.round(axDecayDialSeconds(56) * 1e6) / 1e6 // 0.118297
 */
export function axDecayDialSeconds(dial) {
  return Math.LN2 * AX_HARDWARE_TICK_SECONDS * AX_DECAY_RATE_DIVISOR / (AX_DIAL_FULL - dial);
}

// ── SHARED KNOB FRAGMENTS ───────────────────────────────────────────────────

/**
 * THE EXPONENTIAL-TIME KNOB, in seconds, spanning exactly what the signed dial
 * spans: 2.41 ms at −64 to 3.91 s at +64.
 *
 * THE STEP IS 0.1 ms AND NOT THE LIBRARY'S USUAL 1 ms, which is the one place
 * this fragment departs from `audio_adsr`'s. The dial's whole bottom octave —
 * every drum envelope an Axoloti patch has — lives between 2.4 ms and 5 ms, and
 * a 1 ms step would quantise it to three positions. Measured from the range,
 * not chosen for feel.
 */
const AX_EXP_TIME_STEP = 0.0001;
const AX_EXP_TIME = {
  min: axTimeDialSeconds(-AX_DIAL_FULL),
  max: axTimeDialSeconds(AX_DIAL_FULL),
  step: AX_EXP_TIME_STEP,
  unit: " s",
};

/** Their dial 0, rounded onto the knob's own step grid — a default with more
 *  decimals than its step is what silently changed a drag coefficient once
 *  (BRIEF.md, "PRECISION CAN BE LOAD-BEARING"). Exactly 0.09707908 s. */
const AX_EXP_TIME_AT_DIAL_ZERO = 0.0971;

/**
 * THE HALF-LIFE KNOB (`env/ahd m` only), in seconds.
 *
 * THE TOP OF THE RANGE IS THE DIAL'S LAST HALF-STEP, not its last raw value,
 * and the difference matters: dial 63.5 is a 1.89 s half-life, while dial 64
 * saturates at `__USAT`'s `2^27 − 1` and becomes a 23-DAY half-life — a FREEZE
 * wearing a number. The knob spans the times; the AudioParam behind it (see
 * `synth/worklets/processors_ax4.js`) still reaches the freeze, so a wired
 * input can ask for it.
 */
const AX_DECAY_TIME = {
  min: axDecayDialSeconds(0),
  max: axDecayDialSeconds(AX_DIAL_FULL - AX_DIAL_STEP),
  step: AX_EXP_TIME_STEP,
  unit: " s",
};

/** Their dial 0 on the same grid. Exactly 0.01478714 s. */
const AX_DECAY_AT_DIAL_ZERO = 0.0148;

/**
 * A NORMALISED `frac32.u.map` DIAL — sustain, the six mixer gains, both DP
 * clipper gains. 0…1 for their 0…64 (kernels' deviation D9).
 *
 * THE STEP IS THE DIAL'S OWN GRID, `0.5/64`, so every draggable position is an
 * authentic Axoloti dial position and a harvested value lands on one exactly.
 * A round 0.01 would put none of them on the grid.
 */
const AX_AMOUNT = { min: 0, max: 1, step: AX_DIAL_STEP / AX_DIAL_FULL };

/** The gate every envelope in the block reads as a LEVEL. See the header. */
const AX_GATE_INPUT = { key: "gate", type: "audio", label: "gate" };

/** The edge the two decay envelopes latch on (`bool32.rising` + `ntrig`). */
const AX_TRIG_INPUT = { key: "trig", type: "trigger", label: "trig" };

// ── ENVELOPES ───────────────────────────────────────────────────────────────

export const AX_ENV_ADSR_SPEC = {
  type: "audio_ax_env_adsr", module: "axEnvAdsr", title: "AX ADSR", family: "modulation",
  icon: "mdi:chart-bell-curve", readout: "a", w: 165,
  help: "Axoloti's `env/adsr`, the envelope their factory patches are built on — and it is NOT the textbook shape. ITS ATTACK IS A STRAIGHT LINE and its decay and release are exponential approaches, so a slow attack has a hard corner at the top where an analogue envelope would round off. The attack ends when the ramp REACHES full scale (their int32 overflow), not when a timer expires.",
  inputs: [
    { ...AX_GATE_INPUT },
    { key: "a", type: "number", label: "a" },
    { key: "d", type: "number", label: "d" },
    { key: "s", type: "number", label: "s" },
    { key: "r", type: "number", label: "r" },
  ],
  outputs: [{ key: "env", type: "audio", label: "env" }],
  knobs: [
    { key: "a", label: "Attack", default: AX_EXP_TIME_AT_DIAL_ZERO, ...AX_EXP_TIME, help: "Time from silence to full scale, in SECONDS — their dial 0 is 97.1 ms, dial −64 is 2.4 ms and dial +64 is 3.91 s. A LINEAR ramp, so this is the whole stage rather than a time constant." },
    { key: "d", label: "Decay", default: AX_EXP_TIME_AT_DIAL_ZERO, ...AX_EXP_TIME, help: "Fall from full scale toward Sustain, in seconds. EXPONENTIAL, so this is the 1/e TIME CONSTANT and the stage never quite arrives — which is why an Axoloti ADSR with a low sustain keeps creeping down under a held note." },
    { key: "s", label: "Sustain", default: 0, ...AX_AMOUNT, help: "The level held while the gate is high, 0…1 for their 0…64 dial. The one stage that is a level rather than a time, and the one modulation input that sums the way theirs does — `adsr m` adds `inlet_s` to `param_s` linearly and clamps, exactly as this does." },
    { key: "r", label: "Release", default: AX_EXP_TIME_AT_DIAL_ZERO, ...AX_EXP_TIME, help: "Fall to silence once the gate drops, in seconds, and again a 1/e time constant. It falls from WHEREVER the envelope was, so a note released during its attack releases from part-way up." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/env/{adsr, adsr m}.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate; pfunctions from axoloti/axoloti firmware/api/parameter_functions.h @ 46f6e4b383ce182da9dcca25b9d4b544fe20f990 (pf_kexpltime for a, pf_kexpdtime for d and r, pf_unsigned_clamp for s)",
    recurrence: [
      "// once per 16-sample control tick; dt = 16/sampleRate; a, d, r in SECONDS",
      "if (gate > 0 && !ntrig) { stage = ATTACK;  ntrig = 1 }",
      "if (gate <= 0 && ntrig) { stage = RELEASE; ntrig = 0 }",
      "RELEASE: val *= 1 - dt/r",
      "ATTACK:  val += dt/a ; if (val >= 1) { val = 1 ; stage = DECAY }   // their int32 overflow",
      "DECAY:   s = clamp(sustain, 0, 1) ; val = s + (val - s)*(1 - dt/d)",
      "env = val",
    ].join("\n"),
    deviations: [
      "D2 TIMES ARE SECONDS, not the -64..64 dial. Axoloti's own `LinearTimeExp` conversion is the map, and `synth/ax4_kernels.axTimeDialToSeconds` is that function; a harvested `.axp` dial must be run through it.",
      "D3 THE a/d/r MODULATION INPUTS SUM IN SECONDS. `adsr m` sums `inlet_a` with `param_a` in the PITCH domain before MTOF, which MULTIPLIES the time; ours adds seconds on one shared AudioParam, per the project's same-named-input law. SUSTAIN IS UNAFFECTED — theirs adds linearly and clamps too.",
      "D4 `mtof48k_q31`'s piecewise-linear 257-entry table is not reproduced (<=0.72 cents, so <=0.04% of an envelope time); we evaluate the exponential.",
      "D11 `env/adsr` and `env/adsr m` SHIP AS ONE NODE. The ` m` variant is the plain one with the four pfunctions inlined and four inlets added — the duplication R7-11 says our param/inlet duality exists to remove.",
      "THE STAGE FLOOR IS THEIRS: `MTOF` pins at Nyquist, so no stage can be shorter than four control ticks (1.33 ms at 48 kHz) however small the knob goes.",
      "GATE IS AN `audio` PORT, not `trigger`. Their inlet is `bool32.risingfalling` and the body reads a LEVEL on both edges; see this file's header for why the port type follows from that.",
    ],
  },
};

export const AX_ENV_AHD_SPEC = {
  type: "audio_ax_env_ahd", module: "axEnvAhd", title: "AX AHD Envelope", family: "modulation",
  icon: "mdi:chart-bell-curve-cumulative", readout: "a",
  help: "`env/ahd m`: one pole that climbs toward full scale while the gate is high and falls toward silence when it is not. NO STAGE MACHINE AT ALL — the HOLD is simply what happens when a rise has arrived — so it never clicks on a retrigger and it costs two multiplies a tick. This is the envelope an Axoloti pad patch reaches for.",
  inputs: [
    { key: "a", type: "number", label: "a" },
    { key: "d", type: "number", label: "d" },
    { ...AX_GATE_INPUT },
  ],
  outputs: [{ key: "env", type: "audio", label: "env" }],
  knobs: [
    { key: "a", label: "Attack", default: AX_DECAY_AT_DIAL_ZERO, ...AX_DECAY_TIME, help: "HALF-LIFE of the climb toward full scale, in seconds — the time to cover half the remaining distance, not the time to arrive. Their dial 0 is the FASTEST setting at 14.8 ms; dial 56 is 118 ms. ⚠ THEIR DIAL IS UNSIGNED: a negative value in a harvested patch clamps to 0, which is fast, not slow." },
    { key: "d", label: "Decay", default: AX_DECAY_AT_DIAL_ZERO, ...AX_DECAY_TIME, help: "Half-life of the fall toward silence once the gate drops, on the same scale as Attack. Because both stages are one pole, the envelope's shape is continuous through the gate's edge — that is why this one never clicks." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/env/ahd m.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate; params are frac32.u.map.kdecaytime -> pf_unsigned_clamp (axoloti/axoloti firmware/api/parameter_functions.h @ 46f6e4b383ce182da9dcca25b9d4b544fe20f990), real unit realunits/DecayTime.java",
    recurrence: [
      "// once per 16-sample control tick; dt = 16/sampleRate; a, d are HALF-LIVES in seconds",
      "rate(t) = ln2*dt/t                       // their (64 - dial)/4096, inverted",
      "gate > 0 : val += (1 - val)*rate(a)",
      "else     : val -= val*rate(d)",
      "env = val",
    ].join("\n"),
    deviations: [
      "D2 TIMES ARE SECONDS. Their `DecayTime` conversion is the map; `synth/ax4_kernels.axDecayDialToSeconds` is that function.",
      "D3 THE a/d INPUTS SUM IN SECONDS. Theirs adds `inlet>>1` straight into the coefficient (so an inlet of 1.0 is worth +64 dial); ours adds seconds on the shared AudioParam.",
      "D5 THE SECONDS ARE THEIR DISPLAY'S APPROXIMATION, ln2*dt/rate, not the exact half-life ln2*dt/(-ln(1-rate)). Inverting THEIRS is what makes a harvested dial reproduce its own sound bit for bit; the label reads up to 0.78% long at the fastest setting and under 0.1% over most of the dial. Measured in tests/port_ax4_test.js.",
      "THE KNOB STOPS AT THE DIAL'S LAST HALF-STEP (1.89 s). Their dial 64 saturates at `__USAT`'s 2^27-1 and means FREEZE, which as a number is 23 days; the AudioParam still reaches it so a wired input can.",
      "GATE IS AN `audio` PORT. Their `code.krate` is a bare `if (inlet_gate>0)` with no latch — a level, not an event.",
    ],
  },
};

export const AX_ENV_DECAY_SPEC = {
  type: "audio_ax_env_decay", module: "axEnvDecay", title: "AX Decay Envelope", family: "modulation",
  icon: "mdi:chart-line-variant", readout: "d",
  help: "`env/d` — a trigger snaps it to full scale and it falls away exponentially. The most-used object in the Axoloti factory library after the mixer, because every percussive voice in a patch is one of these driving a VCA. THE TRIGGER TICK DOES NOT ALSO DECAY, so the first control tick of a hit is exactly 1.0.",
  inputs: [
    { ...AX_TRIG_INPUT },
    { key: "d", type: "number", label: "d" },
  ],
  outputs: [{ key: "env", type: "audio", label: "env" }],
  knobs: [
    { key: "d", label: "Decay", default: AX_EXP_TIME_AT_DIAL_ZERO, ...AX_EXP_TIME, help: "The 1/e TIME CONSTANT of the fall, in seconds — their dial 0 is 97.1 ms, dial −64 is 2.4 ms and dial +64 is 3.91 s. A hi-hat wants the bottom of that range and a cymbal the top. Exponential, so the tail never formally ends; it is 1% of full scale after about 4.6 of these." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/env/{d, d m}.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate; `d`'s param is ParameterFrac32SMapKDTimeExp -> pf_kexpdtime = 0x7FFFFFFF - (MTOF(-v)>>2) (axoloti/axoloti firmware/api/parameter_functions.h @ 46f6e4b383ce182da9dcca25b9d4b544fe20f990)",
    recurrence: [
      "// once per 16-sample control tick; dt = 16/sampleRate; d in SECONDS",
      "if (trig > 0 && !ntrig) { val = 1 ; ntrig = 1 }",
      "else { if (trig <= 0) ntrig = 0 ; val *= 1 - dt/d }",
      "env = val",
    ].join("\n"),
    deviations: [
      "D2 TIME IS SECONDS (`LinearTimeExp`), not the -64..64 dial.",
      "D3 THE `d` INPUT SUMS IN SECONDS. `env/d m` sums `-inlet_d - param_d` in the pitch domain and runs MTOFEXTENDED over the sum, which multiplies the time; ours adds seconds.",
      "D4 the piecewise-linear pitch table is not reproduced.",
      "D11 `env/d` and `env/d m` SHIP AS ONE NODE, and the lead's ruling folds the two harvested spellings (`audio_ax_env_d`, `audio_ax_env_decay`) into this one type. THE PORTS AND THE DEFAULT ARE THE UNION: `trig` from `env/d`, the `d` inlet from `env/d m`, and the default is `env/d`'s own dial 0 rather than either harvested knob value, because neither object declares a `<DefaultValue>` and dial 0 is what the editor shows.",
      "THE FLOOR IS THEIRS: `MTOF` pins at Nyquist, so the shortest possible decay is four control ticks.",
    ],
  },
};

export const AX_ENV_DECAY_LINEAR_SPEC = {
  type: "audio_ax_env_d_lin_m", module: "axEnvDecayLinear", title: "AX Decay Envelope (linear)", family: "modulation",
  icon: "mdi:ramp-right", readout: "d",
  help: "`env/d lin m`: the same trigger-and-fall as the Decay envelope, but the fall is a STRAIGHT LINE that stops dead at zero. Reach for it when the envelope drives a PITCH — an exponential decay on a pitch sounds like a drop and then a long approach, while a linear one lands. Its time knob is therefore the whole ramp, not a time constant.",
  inputs: [
    { ...AX_TRIG_INPUT },
    { key: "d", type: "number", label: "d" },
  ],
  outputs: [{ key: "env", type: "audio", label: "env" }],
  knobs: [
    { key: "d", label: "Decay", default: AX_EXP_TIME_AT_DIAL_ZERO, ...AX_EXP_TIME, help: "THE WHOLE RAMP, in seconds — 1.0 to 0.0 and then silence — on the same dial scale as the exponential Decay's time constant. That the same dial number means two different things on the two objects is theirs, not a slip: `val -= MTOF(−d)>>6` against a 2^27 accumulator arrives in exactly this many seconds." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/env/d lin m.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate; `d`'s param is frac32.s.map.klineartime.exp -> pf_signed_clamp, so the OBJECT does its own MTOF(-(param+inlet))",
    recurrence: [
      "// once per 16-sample control tick; dt = 16/sampleRate; d in SECONDS, the FULL ramp",
      "if (trig > 0 && !ntrig) { val = 1 ; ntrig = 1 }",
      "else { if (trig <= 0) ntrig = 0 ; val -= dt/d ; if (val < 0) val = 0 }",
      "env = val",
    ].join("\n"),
    deviations: [
      "D2 TIME IS SECONDS (`LinearTimeExp`), and here that conversion is EXACT rather than nominal: the object really does reach zero in `LinearTimeExp(dial)` seconds.",
      "D3 THE `d` INPUT SUMS IN SECONDS; theirs sums `param_d + inlet_d` in the pitch domain.",
      "D4 the piecewise-linear pitch table is not reproduced.",
      "THE TYPE STRING KEEPS ITS ` lin m` SPELLING. By this block's own naming rule it would be `audio_ax_env_decay_lin_m`; the harvested patches point at the current name and only the lead may move them, so it is reported rather than renamed.",
    ],
  },
};

// ── GAIN AND MIX ────────────────────────────────────────────────────────────

export const AX_VCA_STEREO_SPEC = {
  type: "audio_ax_vca_stereo", module: "axVcaStereo", title: "AX Stereo VCA", family: "modulation",
  icon: "mdi:volume-high",
  help: "`sss/gain/vcaST`: ONE gain over two channels. Not two VCAs — two VCAs can drift apart and this structurally cannot, which is what keeps a stereo pair centred while its level moves. THE GAIN RAMPS ACROSS EACH 16-SAMPLE CONTROL TICK, and deliberately one tick LATE: it interpolates from the PREVIOUS tick's level to this one, which is the k→s ramp R7-11 names as the reference. It has no knobs because the object has no params; wire `v` or it is silent, exactly as the hardware is.",
  inputs: [
    { key: "a1", type: "audio", label: "L" },
    { key: "a2", type: "audio", label: "R" },
    { key: "v", type: "number", label: "v" },
  ],
  outputs: [
    { key: "o1", type: "audio", label: "L" },
    { key: "o2", type: "audio", label: "R" },
  ],
  knobs: [],
  derivation: {
    source: "axoloti/axoloti-contrib objects/sss/gain/vcaST.axo @ tag 1.0.12 (798166f0ce29f4b6a39099b3bde6ef2e7755a7c4), Remco van der Most",
    block: "code.krate (the ramp) + code.srate (the product)",
    recurrence: [
      "// once per 16-sample control tick",
      "step = (v - prev)/16 ; g = prev ; prev = v",
      "// per sample",
      "o1 = a1*g ; o2 = a2*g ; g += step",
    ].join("\n"),
    deviations: [
      "NO KNOB, because the object has no param. `v` is an input at 0 by default, so an unwired one is silent — theirs too.",
      "`v` IS 0..1 AS A LINEAR GAIN, which is what a frac32 of 1.0 means through `___SMMUL(a,v)<<5`. Values above 1 amplify and are legal, as they are on hardware inside frac32's headroom.",
      "THE ONE-TICK LAG IS REPRODUCED, not corrected. Removing it would be 333 us less latency and a crunchier sound on every modulated gain.",
    ],
  },
};

export const AX_XFADE_SPEC = {
  type: "audio_ax_xfade", module: "axXfade", title: "AX Crossfade", family: "modulation",
  icon: "mdi:call-merge",
  help: "`mix/xfade`: two inputs, one control, `o = i2·c + i1·(1−c)`. A LINEAR crossfade, not an equal-power one — so two correlated inputs hold their level across the sweep and two uncorrelated ones dip 3 dB in the middle. That is theirs, and it is the right law for a dry/wet control (where the two ARE correlated) and the wrong one for cutting between two unrelated voices.",
  inputs: [
    { key: "i1", type: "audio", label: "i1" },
    { key: "i2", type: "audio", label: "i2" },
    { key: "c", type: "number", label: "c" },
  ],
  outputs: [{ key: "o", type: "audio", label: "o" }],
  knobs: [],
  derivation: {
    source: "axoloti/axoloti-factory objects/mix/xfade.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa, third overload (frac32buffer i1/i2 + frac32 c)",
    block: "code.krate (ccompl) + code.srate (the mix)",
    recurrence: [
      "// once per 16-sample control tick",
      "ccompl = 1 - c              // their (128<<20) - inlet_c, i.e. 2^27 - c",
      "// per sample",
      "o = i2*c + i1*ccompl        // their ((int64)i2*c + (int64)i1*ccompl) >> 27",
    ].join("\n"),
    deviations: [
      "NO KNOB, because the object has no param; `c` defaults to 0, which passes i1 alone.",
      "`c` IS CLAMPED TO 0..1 BY ITS AudioParam. Their inlet is typed `frac32.positive` but nothing in the C enforces it, so a patch could drive it out of range and extrapolate. The type's own contract is what we hold to.",
      "THE OTHER TWO OVERLOADS ARE NOT PORTED. One is all-k-rate and one takes `c` at audio rate; our port types select this one, and the k-rate `c` is what an envelope or LFO actually drives.",
    ],
  },
};

export const AX_MIX_SPEC = {
  type: "audio_ax_mix", module: "axMix", title: "AX Mixer", family: "modulation",
  icon: "mdi:tune", readout: "gain1", w: 165,
  help: "`mix/mix 1` … `mix/mix 6` as one node — the object an Axoloti patch is assembled out of. ⚠ ITS OUTPUT HARD-CLIPS AT ±1.0. Their `__SSAT(…, 28)` is a real clipper, not frac32's ±16 headroom, so this is where an Axoloti patch gets loud and dirty and reproducing it is the difference between sounding like theirs and merely summing. `bus_in` is added at UNITY with no gain of its own: it is how one mixer chains into the next.",
  inputs: [
    { key: "bus_in", type: "audio", label: "bus" },
    { key: "in1", type: "audio", label: "1" }, { key: "gain1", type: "number", label: "g1" },
    { key: "in2", type: "audio", label: "2" }, { key: "gain2", type: "number", label: "g2" },
    { key: "in3", type: "audio", label: "3" }, { key: "gain3", type: "number", label: "g3" },
    { key: "in4", type: "audio", label: "4" }, { key: "gain4", type: "number", label: "g4" },
    { key: "in5", type: "audio", label: "5" }, { key: "gain5", type: "number", label: "g5" },
    { key: "in6", type: "audio", label: "6" }, { key: "gain6", type: "number", label: "g6" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "gain1", label: "Gain 1", default: 0.5, ...AX_AMOUNT, help: "Channel 1's gain as a LINEAR RATIO, 0…1 for their 0…64 dial — which is exactly what `mix N g`'s own `x0.500` readout prints. 0.5 is the object's `<DefaultValue v=\"32.0\"/>`, so a freshly dropped mixer passes a single input at half level, as theirs does." },
    { key: "gain2", label: "Gain 2", default: 0.5, ...AX_AMOUNT, help: "Channel 2's gain, on the same 0…1 scale. An UNWIRED channel contributes nothing whatever its gain reads, so the five idle rows on a one-input mix cost nothing." },
    { key: "gain3", label: "Gain 3", default: 0.5, ...AX_AMOUNT, help: "Channel 3's gain, on the same scale. Each channel's `gN` input adds to its knob, which is a modulation inlet their objects do not have." },
    { key: "gain4", label: "Gain 4", default: 0.5, ...AX_AMOUNT, help: "Channel 4's gain, on the same scale. Six gains of 1.0 with six full-scale inputs will sit on the output clip — that is the object's own character, not a defect." },
    { key: "gain5", label: "Gain 5", default: 0.5, ...AX_AMOUNT, help: "Channel 5's gain, on the same scale. Their dial steps in halves, and so does this knob: 0.5/64 per step, so every position is an authentic dial position." },
    { key: "gain6", label: "Gain 6", default: 0.5, ...AX_AMOUNT, help: "Channel 6's gain, on the same scale. A gain of exactly 0 is how an Axoloti patch MUTES a lane it wants to keep built and wired." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/mix/{mix 1 … mix 6, mix 1 g … mix 6 g}.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.srate (the buffer overload our port types select); gains are frac32.u.map -> pf_unsigned_clamp, or frac32.u.map.gain -> pf_unsigned_clamp_fullrange on the ` g` variants",
    recurrence: [
      "// gains latched once per 16-sample control tick, each 0..1 for their dial 0..64",
      "// per sample",
      "out = clamp(bus_in + SUM_k in_k*gain_k, -1, 1)      // their __SSAT(bus_in + (accum<<5), 28)",
    ].join("\n"),
    deviations: [
      "D9 GAINS ARE NORMALISED dial/64. `frac32.u.map` declares no real unit; `frac32.u.map.gain` declares `LinRatio(1.0)`, which prints the SAME number — so the ` g` variants need no second node (D11). Their pfunction and shift differ (`<<4` then `accum<<1` versus `accum<<5`) and cancel exactly.",
      "SIX CHANNELS ALWAYS, where they ship six objects. An unwired input contributes nothing, so `mix 1` is this node with five idle rows.",
      "THE SIX GAINS GET MODULATION INLETS the objects do not have. Strict generalisation, and `audio_mixer`'s own spec already interleaves `inN` with `levelN` this way.",
      "⚠ A HARVESTED GAIN ABOVE 1 CANNOT WORK HERE AND DID NOT WORK THERE. `core/audio_patches_axo_machine.js` folds a dropped `conv/to i` (x64) into three mixers as `gain1: 16`; on hardware that gain is unreachable (`__USAT(v,27)` caps the dial at 64 = ratio 1.0) AND the sum would hit the output's own +/-1.0 clip. Reported to the lead rather than accommodated: the fold needs to live somewhere that is not a saturating mixer.",
    ],
  },
};

// ── DISTORTION ──────────────────────────────────────────────────────────────

export const AX_DIST_SOFT_SPEC = {
  type: "audio_ax_dist_soft", module: "axDistSoft", title: "AX Soft Clip", family: "effect",
  icon: "mdi:vector-curve",
  help: "`dist/soft`: `y = 1.5x − 0.5x³`, flat outside ±1. The cheapest useful saturator there is — one cubic, no state, no knobs. THEIR OWN DESCRIPTION SAYS \"no oversampling or anti-aliasing\", and that is audible: drive a high sine into it and the third harmonic it creates folds back down. It is a character effect, not a limiter.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [],
  derivation: {
    source: "axoloti/axoloti-factory objects/dist/soft.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.srate (the buffer overload)",
    recurrence: [
      "x   = clamp(in, -1, 1)          // their __SSAT(inlet_in, 28)",
      "out = 1.5*x - 0.5*x^3           // their ts + (ts>>1) - SMMUL(ts<<3, SMMUL(ts<<3, ts<<3))",
    ].join("\n"),
    deviations: [
      "THE ARITHMETIC `>>1` IS A FLOOR, NOT A TRUNCATION, so their 1.5x is one raw step (2^-27, -162 dBFS) low on a negative odd sample. Not reproduced; measured in tests/port_ax4_test.js against the integer model.",
      "NO KNOBS, because the object has none — the drive is whatever you feed it, which is why an Axoloti patch always puts a gain in front.",
    ],
  },
};

export const AX_DIST_INF_SPEC = {
  type: "audio_ax_dist_inf", module: "axDistInf", title: "AX Infinite Clip", family: "effect",
  icon: "mdi:square-wave",
  help: "`dist/inf`: infinite gain, and the clever part is that it does not clip at all. It throws the waveform away, finds each zero crossing by linear interpolation, and RE-SYNTHESISES a square wave from band-limited steps out of the firmware's minBLEP table — so the squarest possible signal comes out with almost no aliasing. Eight step voices round-robin; a ninth crossing inside 32 samples steals the oldest and clicks, which is theirs.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [],
  derivation: {
    source: "axoloti/axoloti-factory objects/dist/inf.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa; the `blept` table is axoloti/axoloti firmware/axoloti_oscs.c:23 @ 46f6e4b383ce182da9dcca25b9d4b544fe20f990",
    block: "code.krate — which contains its own `for(j=0;j<BUFSIZE;j++)` loop, so every line of it is per-sample work",
    recurrence: [
      "i1 = int32(in) >> 2",
      "rising  (i1 > 0 && !(i0 > 0)): next++ ; voice[next] = 64 - trunc(64*(-i0)/(i1 - i0))",
      "falling (i1 < 0 && !(i0 < 0)): next++ ; voice[next] = 64 - trunc(64*( i0)/(i0 - i1))",
      "i0 = i1",
      "out = SUM_v (v odd ? +blept[t_v] : -blept[t_v])/16384 - (((next+1)&1)*2 - 1)/2",
      "every voice: t += 64, pinned at 2047",
    ].join("\n"),
    deviations: [
      "D8 THEIR DISPATCH INDEX CAN OVERFLOW AND OURS CANNOT. `(-i0<<6)` overflows int32 once the pre-crossing sample is past full scale, which is reachable inside frac32's headroom; JavaScript numbers do not wrap there. Same class as AX-2's D11 — we sound better at the extreme.",
      "D12 THE `blept` TABLE IS IMPORTED FROM `synth/ax2_kernels.js`, not copied. 2048 firmware constants have exactly one home; see synth/ax4_kernels.js's header.",
      "THE -0.5 DC AT STARTUP IS THEIRS. `code.init` parks all eight voices settled and the parity term is unbalanced there, so a silent input sits at -0.5 until the first crossing.",
      "THE INPUT'S `>>2` IS REPRODUCED. Only the sign and the ratio matter to the algorithm, but the shift's truncation moves the interpolated crossing by up to 1/64 of a sample.",
    ],
  },
};

/**
 * The DP clippers' shared gain knobs. THE DEFAULTS ARE NOT THE SOURCE'S AND THE
 * REASON IS ARITHMETIC, NOT TASTE (kernels' deviation D10): neither object
 * declares a `<DefaultValue>`, so on hardware a fresh one has InGain 0, OutGain
 * 0 and makes NO SOUND. Their dial 16 is the one input gain where the shaper
 * sees the signal unchanged, and their dial 32 is the one output gain where the
 * shaper's own peak of 2 lands on exactly ±1 — so 0.25 and 0.5 are the identity
 * drive and the identity ceiling, and nothing else is.
 */
const AX_DP_INGAIN_UNITY = 0.25;
const AX_DP_OUTGAIN_UNITY = 0.5;
const AX_DP_GAINS = [
  { key: "ingain", label: "In gain", default: AX_DP_INGAIN_UNITY, ...AX_AMOUNT, help: "Drive into the shaper, 0…1 for their 0…64 dial. 0.25 is unity — the signal reaches the shaper unchanged — and 1.0 drives it 4× into the flat region. This is the knob that decides how distorted it is; the other one only decides how loud." },
  { key: "outgain", label: "Out gain", default: AX_DP_OUTGAIN_UNITY, ...AX_AMOUNT, help: "Level after the shaper, 0…1 for their 0…64 dial. The shaper's own peak is 2, so 0.5 puts the ceiling at exactly ±1 and anything above that clips the node's own output further down the patch." },
];

export const AX_DP_SOFT_CLIP_SPEC = {
  type: "audio_ax_dp_soft_clip", module: "axDpSoftClip", title: "AX DP Soft Clip", family: "effect",
  icon: "mdi:arrow-collapse-vertical", readout: "ingain",
  help: "Smashed Transistors' `tiar/dist/DPSoftClip` — a cubic soft clipper with In and Out gains. ⚠ ITS ADVERTISED ANTIALIASING HAS NEVER RUN. Its guard is written `if(inlet_in & M != old_in & M)` and C binds `!=` tighter than `&`, so the condition is 0 for every input that exists; the object's own description promises \"Differentiated Polynomial Anti aliasing\" and the code delivers a plain aliasing clipper. That is what the patches using it were voiced against, so it is what this node does — and its sibling AX DP Hard Clip, which parenthesises correctly, really does antialias. At the default gains this is byte-identical to AX Soft Clip.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "ingain", type: "number", label: "in g" },
    { key: "outgain", type: "number", label: "out g" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: AX_DP_GAINS.map((knob) => ({ ...knob })),
  derivation: {
    source: "axoloti/axoloti-contrib objects/tiar/dist/DPSoftClip.axo @ tag 1.0.12 (798166f0ce29f4b6a39099b3bde6ef2e7755a7c4), Smashed Transistors",
    block: "code.krate (the two gains) + code.srate (the shaper); params are frac32.u.map -> pf_unsigned_clamp",
    recurrence: [
      "// once per 16-sample control tick, gains normalised 0..1 for their dial 0..64",
      "drive = 4*inGain ; peak = 2*outGain",
      "// per sample",
      "u   = drive*in",
      "out = peak * (|u| >= 1 ? sign(u) : u*(3 - u*u)/2)",
    ].join("\n"),
    deviations: [
      "D6 THE ANTIALIASING BRANCH IS DEAD IN THE SOURCE AND IS REPRODUCED DEAD. See this spec's help and synth/ax4_kernels.js's header for the C parse. R7-11: reproduce an audible source bug and NAME it; the help names it so the label does not lie.",
      "D9 GAINS ARE NORMALISED dial/64.",
      "D10 THE DEFAULTS ARE UNITY DRIVE AND UNITY PEAK, not the source's silent 0 and 0.",
      "THE FLOAT PATH IS DOUBLE, not the STM32's single precision. Below the frac32 quantisation everything else here already discards.",
    ],
  },
};

export const AX_DP_HARD_CLIP_SPEC = {
  type: "audio_ax_dphardclip", module: "axDpHardClip", title: "AX DP Hard Clip", family: "effect",
  icon: "mdi:content-cut", readout: "ingain",
  help: "Smashed Transistors' `tiar/dist/DPHardClip` — a hard clipper whose Differentiated Polynomial antialiasing DOES work, unlike its soft sibling's. THE TRICK IN ONE LINE: it integrates the saturator, then divides the integral's change by the input's change, which gives the saturator's AVERAGE across the sample instead of its value at the end — so the corner is smeared over the sample it actually happened in and most of the alias energy never exists. A hard clip you can drive without it turning to gravel.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "ingain", type: "number", label: "in g" },
    { key: "outgain", type: "number", label: "out g" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: AX_DP_GAINS.map((knob) => ({ ...knob })),
  derivation: {
    source: "axoloti/axoloti-contrib objects/tiar/dist/DPHardClip.axo @ tag 1.0.12 (798166f0ce29f4b6a39099b3bde6ef2e7755a7c4), Smashed Transistors",
    block: "code.krate (the two gains) + code.srate (the shaper); params are frac32.u.map -> pf_unsigned_clamp",
    recurrence: [
      "// once per 16-sample control tick",
      "drive = 4*inGain ; peak = 2*outGain",
      "// per sample",
      "x0 = drive*in ; I(x) = |x| <= 1 ? x*x/2 : |x| - 1/2",
      "bucket changed (top 20 bits of int32(in)) ? out = peak*(I(x0) - I(x1))/(x0 - x1)",
      "                                          : out = peak*clamp(x0, -1, 1)",
      "x1 = x0",
    ].join("\n"),
    deviations: [
      "D7 THEIR QUOTIENT IS 0/0 AT InGain = 0 and an int32 cast of NaN is undefined behaviour in C. The AA branch is additionally gated on `x0 != x1`, which is unreachable for any nonzero gain.",
      "D9 GAINS ARE NORMALISED dial/64.",
      "D10 THE DEFAULTS ARE UNITY DRIVE AND UNITY PEAK, not the source's silent 0 and 0.",
      "THE 12-BIT BUCKET TEST IS REPRODUCED ON THE RAW int32, not approximated with a float threshold: which branch runs is what this object sounds like.",
    ],
  },
};

/**
 * EVERY AX-4 SPEC — envelopes, then gain and mix, then distortion, which is the
 * signal-flow order a patch reads in and the order core/audio_specs.AUDIO_SPECS
 * groups by family in.
 *
 * THE BARREL LINES THIS NEEDS (the lead applies them; this block may not):
 *   core/audio_blocks.js    spread `BLOCK_SPECS` into `PORT_BLOCK_SPECS`
 *   plugins/audio_index.js  spread `plugins/audio_index_ax4.BLOCK_PLUGINS`
 *   synth/modules.js        spread `synth/modules_ax4.BLOCK_MODULE_FACTORIES`
 *   synth/worklet_urls.js   the AX4 processor URL
 */
export const BLOCK_SPECS = [
  AX_ENV_ADSR_SPEC, AX_ENV_AHD_SPEC, AX_ENV_DECAY_SPEC, AX_ENV_DECAY_LINEAR_SPEC,
  AX_VCA_STEREO_SPEC, AX_XFADE_SPEC, AX_MIX_SPEC,
  AX_DIST_SOFT_SPEC, AX_DIST_INF_SPEC, AX_DP_SOFT_CLIP_SPEC, AX_DP_HARD_CLIP_SPEC,
];
