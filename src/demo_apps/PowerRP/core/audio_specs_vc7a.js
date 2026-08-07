/**
 * THE VC-7a MODULE SPECS — the twelve ported CLOCKING AND LOGIC nodes.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary applied to a further module set. Same record shape,
 * same rules, same reader (`core/audio_nodes.audioNodePlugin`): a spec is the values
 * that make one module differ from its neighbours, and NOTHING about how it sounds.
 * The DSP is `synth/vc7a_kernels.js`, and THE DERIVATION RECORD — which module, which
 * C++ file and function, which commit, the recurrence in float, every named deviation
 * — is that file's docblocks. Each `help` below points at it rather than repeating it.
 *
 * ── WHY THIS BLOCK EXISTS ───────────────────────────────────────────────────
 * It is the PLUMBING. A missing clock divider silences everything downstream of it, so
 * a patch built on one of these placeholders is not "slightly wrong", it is silent —
 * in P25 (Moog Subharmonicon, the most-downloaded patch in the set) that is the whole
 * patch. Eleven of the twelve are CountModula; `Clkd` is ImpromptuModular's.
 *
 * ── WHY A SEPARATE FILE ─────────────────────────────────────────────────────
 * Several agents write ported module sets CONCURRENTLY (R7 Wave 3 Phase 3), one block
 * each. One shared file is one merge conflict per agent per save. The barrel —
 * `PORT_BLOCK_SPECS` in core/audio_blocks.js — stays the single roster; this array is
 * spread into it.
 *
 * ── THIS FILE MAY NOT IMPORT synth/** ───────────────────────────────────────
 * core/ must run in bare node, so every range below is RESTATED from the roster's own
 * AudioParam bounds and every port list from its own port lists.
 * `tests/port_vc7a_test.js` pins all of it against
 * `synth/worklets/processors_vc7a.js`, which is where a dependency on the engine
 * belongs.
 *
 * ── UNITS ON A WIRE: R7-UNITS, ALL FOUR CLAUSES, AS THEY LAND HERE ──────────
 * Every law in the `help` sentences below is written in VOLTS, because that is what
 * these modules are calibrated in. The conversion to a wire happens in exactly one
 * file (`synth/worklets/processors_vc7a.js`) and has only three cases:
 *
 *   INLETS       ±1 IS ±5 V, always. A 0…1 trigger arriving on one reads as 5 V,
 *                which clears CountModula's 2 V Schmitt threshold by 2.5× and
 *                Impromptu's 1 V one by 5×.
 *   `audio` OUT  ÷5, so a `boolToAudio` ±5 V square is ±1 and a `boolToGate` 0…10 V
 *                one is 0…2 — legal on a float bus, and the same headroom VC-3b
 *                documents.
 *   `trigger` OUT ÷10, because clause 4 says a trigger carries 0…1 and every gate
 *                output in both plugins emits `boolToGate`'s 10 V.
 *
 * THE ONE EXCEPTION IS DECLARED PER PORT: Clkd's `bpm_cv` inlet and `bpm` outlet carry
 * BPM (clause 2 — "a number wire carries the REAL unit of its quantity"), not volts.
 * See VCV_CLKD_SPEC's help and the kernels' D9.
 *
 * ── WHY EVERY GATE INLET IS TYPED `audio` AND EVERY GATE OUTLET `trigger` ───
 * The inlets go through `inc/GateProcessor.hpp`, which is a SCHMITT TRIGGER ON A RAW
 * VOLTAGE. Patching an LFO or an oscillator into one is ordinary — it is how a
 * Subharmonicon's dividers are clocked — and `core/nodeflow.COERCIONS` has NO
 * `audio -> trigger`, so typing them `trigger` would REFUSE exactly that cable.
 * `trigger -> audio` exists, so a real trigger output still drives them. The OUTLETS go
 * the other way for the mirror-image reason: `trigger` reaches trigger, number AND
 * audio; `audio` reaches only two. Same pair of calls VC-3b made, for the same measured
 * reason.
 *
 * VCFrequencyDividerMkII's two outputs are the ONE place that rule is not applied
 * mechanically: at audio rate they are subharmonic OSCILLATOR outputs, not logic, so
 * both stay `audio`.
 *
 * ── EVERY SWITCH IS A NUMBER, NOT A DROPDOWN ────────────────────────────────
 * AX-2 and VC-3b spell a mode knob as a `discrete` string. Not here, and the reason is
 * measurable: every switch in both source plugins is a `configSwitch` FLOAT param, and
 * the harvested demo patches carry those positions as NUMBERS. `audioKnobValues`
 * treats a discrete knob's non-string value as absent and SUBSTITUTES THE DEFAULT — so
 * a dropdown here would silently discard a patch's own `mode: 0`. A numeric switch also
 * survives an equation sweeping it, which a string cannot.
 *
 * ── UNITS ON A KNOB: REAL ONES WHERE THE SOURCE HAS THEM (D15) ──────────────
 * Fade's fade times are SECONDS in the original and stay seconds; Clkd's tempo is BPM
 * in the original and stays BPM; EventTimer's length is a count of clocks. Where the
 * source's own knob is a raw index or a raw percentage — a ratio knob, an attenuverter
 * — that is what it stays, because inventing a unit it does not have would break the
 * one thing porting buys: a harvested patch's dial numbers transcribe UNCHANGED.
 *
 * ── PORT AND KNOB NAMES CORRECTED FROM THE PLACEHOLDER ROWS ─────────────────
 * The placeholder stubs these nodes supersede were generated from patch files, so some
 * of their names were ENUM INDICES and some collided with a knob. Both are corrected
 * here and reported to the lead, who fixes the patches centrally:
 *
 *   GateSequencer8  in  `i1`→`clock`, `i2`→`reset`                (InputIds 1 and 2)
 *                   out `o8`→`trig1`, `o10`→`trig3`, `o11`→`trig4`, `o12`→`trig5`
 *                                                                  (TRIG_OUTPUTS + 0/2/3/4)
 *                   knob `p0`→`step1_1`, `p3`→`step1_4`, `p12`→`step2_5`,
 *                        `p16`→`step3_1`, `p64`→`length`           (STEP_PARAMS r*8+s)
 *   THE `_cv` RULE — an input and a knob of ONE NAME are documented to share ONE
 *   AudioParam and ADD. None of these pairs do: each inlet OVERRIDES or ATTENUATES its
 *   knob. So each inlet takes the source's own `configInput` label:
 *   SampleAndHold  in `mode`→`mode_cv`
 *   SampleAndHold2 in `mode`→`mode_cv`, `prob`→`prob_cv`, `offset`→`offset_cv`;
 *                  knob `prob_cv`→`probCvAtten`
 *   BurstGenerator knob `rate_cv`→`rateCvAtten`, `pulses_cv`→`pulsesCvAtten`
 *   Clkd           in `bpm`→`bpm_cv`; the `bpm` OUTPUT changes type `audio`→`number`
 *                  because it carries BPM (D9)
 * Every one of these is SAFE for an existing wire: `trigger -> audio`, `number -> audio`
 * and `number -> trigger` all exist, so widening a port never refuses a cable that was
 * legal before. Only the KEY changes.
 */

// ── THE DERIVATION INDEX ────────────────────────────────────────────────────

/**
 * THE TWO SOURCES THIS BLOCK IS PORTED FROM, and the commits they were read at.
 * R7-17: the record exists FOR DEBUGGING ("it's so we can debug shit and find flaws in
 * the emulation"), so it pins a commit rather than naming a project.
 */
export const COUNTMODULA_SOURCE = "github.com/countmodula/VCVRackPlugins @ 30b3c6c46fc0589f5e0ece7ad79abbe0293e70fd";
export const IMPROMPTU_SOURCE = "github.com/MarcBoule/ImpromptuModular @ cf87c918875e502043cabe3deaa2e52adda7cecd";

/**
 * Pure function. One node's derivation INDEX — deliberately an index and NOT a copy of
 * the record, which lives beside the arithmetic in `synth/vc7a_kernels.js`.
 *
 * This is the machine-checkable half: the source commit, the C++ files, the kernel
 * class that holds the prose, and the deviation IDs that prose must define.
 * `tests/port_vc7a_test.js` asserts every `kernel` names a real exported class and
 * every deviation id really appears in the kernels file — so the index and the record
 * cannot drift apart, which a second prose copy could not promise.
 *
 * @param {string} source - COUNTMODULA_SOURCE or IMPROMPTU_SOURCE
 * @param {string[]} files - the C++ files the port was read from
 * @param {string} kernel - the exported kernel class holding the full record
 * @param {string[]} deviations - the deviation ids that record must name
 * @returns {{source: string, files: string[], kernel: string, deviations: string[]}}
 *
 * @example derivedFrom(COUNTMODULA_SOURCE, ["src/modules/Fade.cpp"], "FadeKernel", ["D0"]).kernel // "FadeKernel"
 * @example derivedFrom(COUNTMODULA_SOURCE, [], "FadeKernel", []).source.includes("30b3c6c") // true
 */
export function derivedFrom(source, files, kernel, deviations) {
  return { source, files, kernel, deviations };
}

/** The deviations that bind EVERY node in this block — the voltage law, the two
 *  control-rate dividers, the seeded randomness, the `audio`-typed inlets, the
 *  `audio`-vs-`trigger` typing rule, the dropped panel buttons, the dropped lights and
 *  expanders, the mono wire, and the real-unit knobs. Named once so twelve rows cannot
 *  list eight of the nine. */
const BLOCK_DEVIATIONS = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D15"];

/** `inc/GateProcessor.hpp`'s two thresholds, quoted in the help sentences that need
 *  them. Restated from `synth/vc7a_kernels.js` because core/ may not import synth/;
 *  pinned against it by tests/port_vc7a_test.js. */
const GATE_LOW_V = 0.1;
const GATE_HIGH_V = 2;

/** `ClockedCommon.hpp bpmMin` / `bpmMax`. */
const BPM_MIN = 30;
const BPM_MAX = 300;

/** `ClockedCommon.hpp numRatios` — 35 entries, so a ratio knob spans ±34. */
const RATIO_INDEX_MAX = 34;

/** `GateSequencerSrc.hpp GATESEQ_NUM_ROWS` / `GATESEQ_NUM_STEPS`. */
const GATESEQ_ROWS = 8;
const GATESEQ_STEPS = 8;

/** `BusRoute2.cpp`: seven channels, seven switch pairs. */
const BUS_CHANNELS = 7;

/** `ClockDivider.cpp NUM_DIVS`. */
const DIVIDER_OUTPUTS = 8;

/** `EventTimer.cpp NUM_DIGITS 3`. */
const EVENT_TIMER_MAX = 999;

/** A two-position panel switch, as the numeric knob this block spells it (see the
 *  header). Restated from the roster's `toggle()`. */
const SWITCH = { min: 0, max: 1, step: 1 };

/**
 * Pure function. `n` numbered keys — the spec side of the roster's `numberedKeys`, and
 * the reason these two lists cannot silently differ is that
 * `tests/port_vc7a_test.js` compares them element for element.
 *
 * @param {string} stem
 * @param {number} count
 * @returns {string[]}
 *
 * @example numbered("gate", 3) // ["gate1", "gate2", "gate3"]
 * @example numbered("clk_", 2) // ["clk_1", "clk_2"]
 */
export function numbered(stem, count) {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(`${stem}${i}`);
  return keys;
}

/**
 * Pure function. GateSequencer8's 64 step-switch keys, `step<row>_<step>`, row-major.
 *
 * @returns {string[]}
 *
 * @example gateSequencerSteps().length // 64
 * @example gateSequencerSteps()[3] // "step1_4"
 * @example gateSequencerSteps()[16] // "step3_1"
 */
export function gateSequencerSteps() {
  const keys = [];
  for (let r = 1; r <= GATESEQ_ROWS; r++) {
    for (let s = 1; s <= GATESEQ_STEPS; s++) keys.push(`step${r}_${s}`);
  }
  return keys;
}

/** The SEED knob, restated per module that draws random numbers. Their generator is
 *  seeded from the system clock and is not reproducible even on the same machine
 *  (kernels' D2); ours is, because a document that renders differently every time is
 *  not a document. */
const SEED = {
  key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
  help: "CONSTRUCT-TIME: the generator's state is initialised once, so changing this rebuilds the module. THE REASON THIS KNOB EXISTS: Rack's `random::uniform()` is seeded from the system clock, so the original is not reproducible even on the same box. Same seed, same sequence, forever.",
};

// ── MODULATION ──────────────────────────────────────────────────────────────

export const VCV_CLKD_SPEC = {
  type: "audio_vcv_clkd", module: "vcvClkd", title: "VCV Clkd", family: "modulation",
  icon: "mdi:metronome", readout: "bpm", w: 175,
  derivation: derivedFrom(IMPROMPTU_SOURCE, ["src/Clkd.cpp", "src/ClockedCommon.hpp", "src/ImpromptuModular.hpp"], "ClkdKernel", [...BLOCK_DEVIATIONS, "D9", "D10"]),
  help: "ImpromptuModular's master clock: one tempo and THREE RATIO-LOCKED SUB-CLOCKS that cannot drift. Each sub-clock runs a whole number of periods inside one master frame and then WAITS for the master to come round, so a ×3 against a ÷5 is still exactly in phase an hour later — which is what a polyrhythm needs and what a free-running divider cannot give you. It is the tempo source for a whole rack, and everything downstream of a missing one is silent.",
  inputs: [
    { key: "reset", type: "audio", label: "reset" },
    { key: "run", type: "audio", label: "run" },
    { key: "bpm_cv", type: "number", label: "bpm" },
  ],
  outputs: [
    ...numbered("clk_", 4).map((key, i) => ({ key, type: "trigger", label: i === 0 ? "clk" : `clk ${i}` })),
    { key: "reset", type: "trigger", label: "reset" },
    { key: "run", type: "trigger", label: "run" },
    { key: "bpm", type: "number", label: "bpm" },
  ],
  knobs: [
    { key: "bpm", label: "Tempo", default: 120, min: BPM_MIN, max: BPM_MAX, step: 1, unit: " BPM", help: `The master tempo, ${BPM_MIN}…${BPM_MAX} BPM. Theirs is a SNAP knob, so a whole number is what the original can express; the master period is 60/BPM seconds and every sub-clock is a ratio of it. THE bpm INLET OVERRIDES THIS ENTIRELY when patched — it does not sum with it.` },
    { key: "ratio_1", label: "Clk 1 ratio", default: 0, min: -RATIO_INDEX_MAX, max: RATIO_INDEX_MAX, step: 1, help: "AN INDEX, NOT A RATIO (kernels' D10). Their 35-entry table is 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 23, 24, 29, 31, 32, 37, 41, 43, 47, 48, 53, 59, 61, 64, 96 — so 0 is ×1, 5 is ×4 and −9 is ÷8. A negative index DIVIDES. Changing it does not take effect until the master's next frame, which is why a ratio sweep stays musical." },
    { key: "ratio_2", label: "Clk 2 ratio", default: 0, min: -RATIO_INDEX_MAX, max: RATIO_INDEX_MAX, step: 1, help: "The second sub-clock's index into the same table. See Clk 1 ratio." },
    { key: "ratio_3", label: "Clk 3 ratio", default: 0, min: -RATIO_INDEX_MAX, max: RATIO_INDEX_MAX, step: 1, help: "The third sub-clock's index into the same table. See Clk 1 ratio." },
    { key: "ppqn", label: "PPQN", default: 4, min: 2, max: 24, step: 1, help: "Pulses per quarter note the DETECTION mode counts before it believes it knows the tempo. Only 2, 4, 8, 12, 16 and 24 exist in their menu, and anything else SNAPS to the nearest of those — a number rather than a dropdown so an equation can sweep it. Does nothing while BPM mode is 0." },
    { key: "bpmMode", label: "BPM mode", default: 0, ...SWITCH, help: "0 reads the `bpm` inlet AS A TEMPO. 1 reads it as an EXTERNAL CLOCK and measures the tempo from it, counting PPQN pulses and predicting the rest of the beat. In mode 1 the clock STOPS on a timeout rather than freewheeling, and it can be stopped by hand but not started — a manual start could not know which pulse begins a set." },
    { key: "running", label: "Run", default: 1, ...SWITCH, help: "The run state. THIS KNOB IS THEIR MOMENTARY RUN BUTTON, so it acts on its CHANGE: moving it toggles the transport, exactly as a press does, and the `run` inlet keeps toggling independently (kernels' D5)." },
    { key: "resetHigh", label: "Reset outputs high", default: 1, ...SWITCH, help: "What a STOPPED clock output sits at — 1 is high (their default), 0 is low. It matters to whatever is downstream: a sequencer normalled to a high clock will not advance, but an envelope gated by one stays open." },
    { key: "momentaryRun", label: "Momentary run input", default: 1, ...SWITCH, help: "1 treats the `run` inlet as a TRIGGER, toggling on each rising edge. 0 treats it as a LEVEL, running while it is high — which is what a transport gate from another module wants." },
    { key: "forceCvOnBpmOut", label: "Force CV on BPM out", default: 0, ...SWITCH, help: "0 passes the `bpm` inlet straight through to the `bpm` outlet when one is patched, so a chain of clocks shares one tempo source. 1 always emits THIS module's own tempo instead." },
    ...numbered("trigOut", 4).map((key, i) => ({
      key, label: `Clk ${i + 1} triggers`, default: 0, ...SWITCH,
      help: `Output ${i + 1}'s shape: 0 is a 50% square (a GATE), 1 is a 1 ms blip (a TRIGGER). Same division either way — this changes what a downstream envelope or gate-length-sensitive module does with it, not the timing.`,
    })),
    { key: "resetOnStartInt", label: "Reset self on start", default: 0, ...SWITCH, help: "Restart this clock's own counters when the transport starts. Their `resetOnStartStop` menu, one bit each." },
    { key: "resetOnStartExt", label: "Pulse reset out on start", default: 0, ...SWITCH, help: "Emit a reset pulse on the `reset` OUTLET when the transport starts, so the rest of the rack restarts with it." },
    { key: "resetOnStopInt", label: "Reset self on stop", default: 0, ...SWITCH, help: "Restart this clock's own counters when the transport stops." },
    { key: "resetOnStopExt", label: "Pulse reset out on stop", default: 0, ...SWITCH, help: "Emit a reset pulse on the `reset` OUTLET when the transport stops." },
  ],
};

export const VCV_GATE_SEQUENCER_8_SPEC = {
  type: "audio_vcv_gatesequencer8", module: "vcvGateSequencer8", title: "VCV Gate Sequencer 8", family: "modulation",
  icon: "mdi:grid", readout: "length", w: 195,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/GateSequencer8.cpp", "src/modules/GateSequencerSrc.hpp"], "GateSequencer8Kernel", [...BLOCK_DEVIATIONS, "D13"]),
  help: "EIGHT TRACKS OF EIGHT STEPS SHARING ONE POSITION — so every track is locked to the same clock and the pattern is a grid rather than eight independent sequencers. Nine ways to walk it: forward, reverse, pendulum and random, each with a ONE-SHOT twin that stops at the end and raises `end`, plus a voltage-ADDRESSED mode where a CV picks the step outright. Each track has both a GATE outlet (high for the whole step) and a TRIG outlet (the gate ANDed with the raw clock, so it is as short as the clock's own pulse).",
  inputs: [
    { key: "run", type: "audio", label: "run" },
    { key: "clock", type: "audio", label: "clock" },
    { key: "reset", type: "audio", label: "reset" },
    { key: "length_cv", type: "number", label: "len cv" },
    { key: "direction_cv", type: "number", label: "dir cv" },
    { key: "address_cv", type: "number", label: "addr cv" },
  ],
  outputs: [
    ...numbered("gate", GATESEQ_ROWS).map((key, i) => ({ key, type: "trigger", label: `g${i + 1}` })),
    ...numbered("trig", GATESEQ_ROWS).map((key, i) => ({ key, type: "trigger", label: `t${i + 1}` })),
    { key: "end", type: "trigger", label: "end" },
  ],
  knobs: [
    ...gateSequencerSteps().map((key) => {
      const [row, step] = key.slice("step".length).split("_");
      return {
        key, label: `Track ${row} step ${step}`, default: 0, ...SWITCH,
        help: `Is track ${row} on at step ${step}? The 8×8 grid IS the pattern — there is no other state. A numeric switch rather than a dropdown so an equation can drive it (see this file's header).`,
      };
    }),
    ...numbered("mute", GATESEQ_ROWS).map((key, i) => ({
      key, label: `Track ${i + 1} mute`, default: 0, ...SWITCH,
      help: `Silence track ${i + 1} without clearing its steps. Their randomiser deliberately skips the mutes, so a re-randomised pattern keeps whatever you had muted.`,
    })),
    { key: "length", label: "Length", default: GATESEQ_STEPS, min: 1, max: GATESEQ_STEPS, step: 1, help: "How many steps the walk covers before wrapping. Truncated to a whole number. THE len cv INLET OVERRIDES THIS when patched, scaling 0…10 V onto steps 1…8." },
    { key: "direction", label: "Direction", default: 0, min: 0, max: 8, step: 1, help: "0 forward, 1 pendulum, 2 reverse, 3 random, 4…7 the one-shot twins of those four, 8 voltage-addressed. A ONE-SHOT stops at the end of its first pass and raises `end` until a reset arrives. THE dir cv INLET OVERRIDES THIS when patched, one volt per mode." },
    { key: "addr", label: "Address", default: 0, min: 0, max: 10, step: 0.01, help: "ADDRESSED MODE ONLY (direction 8): the step is `1 + length · V · addr / 100`, where V is the addr cv inlet NORMALLED TO 10 V. So with nothing patched this knob alone sweeps the whole pattern, and with a CV patched it is that CV's attenuator." },
    { ...SEED, help: `${SEED.help} Used by the RANDOM directions only.` },
  ],
};

export const VCV_BURST_GENERATOR_SPEC = {
  type: "audio_vcv_burstgenerator", module: "vcvBurstGenerator", title: "VCV Burst Generator", family: "modulation",
  icon: "mdi:flash-outline", readout: "pulses", w: 170,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/BurstGenerator.cpp", "src/inc/ClockOscillator.hpp", "src/inc/GateProcessor.hpp"], "BurstGeneratorKernel", BLOCK_DEVIATIONS),
  help: "ONE TRIGGER IN, A BURST OF N PULSES OUT — the module that lets P2 be a self-playing patch with no sequencer in it at all. The internal clock's PHASE IS RESET BY THE INCOMING TRIGGER, so the first pulse lands ON the trigger rather than on the next tick; that is the difference between a flam and a delayed sequence. Four outlets: the pulses themselves, a gate spanning the whole burst, and 1 ms markers at its start and end.",
  inputs: [
    { key: "clock", type: "audio", label: "clock" },
    { key: "rate_cv", type: "number", label: "rate cv" },
    { key: "trigger", type: "audio", label: "trig" },
    { key: "pulses_cv", type: "number", label: "pulses cv" },
    { key: "probability_cv", type: "number", label: "prob cv" },
  ],
  outputs: [
    { key: "pulses", type: "trigger", label: "pulses" },
    { key: "start", type: "trigger", label: "start" },
    { key: "duration", type: "trigger", label: "dur" },
    { key: "end", type: "trigger", label: "end" },
  ],
  knobs: [
    { key: "rate", label: "Rate", default: 0, min: 0, max: 5, step: 0.01, help: "The internal clock's pitch in OCTAVES — the frequency is 2^rate hertz, so 0 is 1 Hz and 5 is 32 Hz. An octave knob rather than a hertz one because that is what theirs is (`ClockOscillator::setPitch`), and a harvested patch's dial number has to transcribe unchanged. THE clock INLET DISCONNECTS this oscillator entirely." },
    { key: "rateCvAtten", label: "Rate CV amount", default: 0, min: -1, max: 1, step: 0.01, help: "How much the `rate cv` inlet moves the rate, ±100%. AN ATTENUVERTER — it MULTIPLIES the inlet rather than summing with the Rate knob, which is why it is not named `rate_cv` (see this file's RENAMES). Negative inverts the CV." },
    { key: "range", label: "Fast range", default: 0, ...SWITCH, help: "1 remaps the Rate knob to `4 + 2·rate` octaves, i.e. 16 Hz…16 kHz instead of 1…32 Hz. At the top of the fast range the burst is a single audible click rather than a rhythm." },
    { key: "retrigger", label: "Retrigger", default: 0, ...SWITCH, help: "1 lets a trigger arriving DURING a burst restart it. 0 ignores it, so a burst always completes — which is what you want when the trigger source is itself a burst." },
    { key: "pulses", label: "Pulses", default: 1, min: 1, max: 16, step: 1, help: "How many pulses one burst is, 1…16. The burst ends on the LAST PULSE's trailing edge rather than at the next clock, so the duration gate is exactly as long as the pulses it contains." },
    { key: "pulsesCvAtten", label: "Pulses CV amount", default: 0, min: -1.6, max: 1.6, step: 0.01, help: "How much the `pulses cv` inlet moves the count. THEIR RANGE IS ±1.6 AND THAT IS DELIBERATE: a ±10 V CV times 1.6 is ±16 pulses, i.e. the full range of the knob, which is why it is not the ±1 the other attenuverters use. An attenuverter, not an added CV." },
    { key: "probability", label: "Probability", default: 10, min: 0, max: 10, step: 0.01, help: "IN TENTHS, because that is their knob: 10 is every pulse and 0 is none. A pulse that loses its coin toss is SKIPPED, not delayed, so the burst keeps its rhythm and drops notes out of it — which is the whole generative use of this module." },
    { key: "probabilityCvAtten", label: "Probability CV amount", default: 0, min: -1, max: 1, step: 0.01, help: "How much the `prob cv` inlet moves the probability, ±100%. An attenuverter." },
    { ...SEED, help: `${SEED.help} Used by the pulse probability.` },
  ],
};

export const VCV_EVENT_TIMER_SPEC = {
  type: "audio_vcv_eventtimer", module: "vcvEventTimer", title: "VCV Event Timer", family: "modulation",
  icon: "mdi:timer-outline", readout: "length", w: 160,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/EventTimer.cpp", "src/modules/EventTimer.hpp"], "EventTimerKernel", [...BLOCK_DEVIATIONS, "D11"]),
  help: "A COUNTDOWN THAT FIRES ONCE. Arm it with a length, trigger it, and N clocks later it raises a latched gate and a 1 ms pulse — the \"do this after 32 bars\" of a long generative patch. The latch is the point: once it has fired the trigger inlet does NOTHING until a reset arrives, so it is a one-shot rather than a divider. With nothing patched to `clock` it counts its own internal 1 Hz clock, so the length is in seconds.",
  inputs: [
    { key: "clock", type: "audio", label: "clock" },
    { key: "reset", type: "audio", label: "reset" },
    { key: "trigger", type: "audio", label: "trig" },
  ],
  outputs: [
    { key: "end", type: "trigger", label: "end" },
    { key: "endt", type: "trigger", label: "end t" },
  ],
  knobs: [
    { key: "length", label: "Length", default: 0, min: 0, max: EVENT_TIMER_MAX, step: 1, help: "How many clocks the countdown is, 0…999 (their panel is three digits). THIS KNOB IS THEIR SIX MOMENTARY DIGIT BUTTONS, so it acts on its CHANGE: moving it sets both the length AND the live count, exactly as pressing a digit does (kernels' D11)." },
    { key: "retrigger", label: "Retrigger", default: 0, ...SWITCH, help: "1 lets a trigger arriving mid-countdown restart it from the length. 0 ignores it, so the first trigger wins and the timer runs to its end." },
  ],
};

export const VCV_SAMPLE_AND_HOLD_2_SPEC = {
  type: "audio_vcv_sampleandhold2", module: "vcvSampleAndHold2", title: "VCV Sample & Hold 2", family: "modulation",
  icon: "mdi:stairs", readout: "prob", w: 170,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/SampleAndHold2.cpp", "src/inc/GateProcessor.hpp"], "SampleAndHold2Kernel", [...BLOCK_DEVIATIONS, "D8"]),
  help: "A SAMPLE & HOLD THAT IS ALSO A RANDOM SOURCE. With nothing patched to `sample` it holds a fresh RANDOM ±5 V on every trigger instead of silence — seven of these clocked in parallel is P2's whole modulation section. Add PROBABILITY (a sample that loses its coin toss keeps the previous value, so the sequence has holds in it) plus level and offset, and one module covers the range from a clean track-and-hold to a generative voltage source.",
  inputs: [
    { key: "sample", type: "audio", label: "in" },
    { key: "trig", type: "audio", label: "trig" },
    { key: "mode_cv", type: "number", label: "mode cv" },
    { key: "prob_cv", type: "number", label: "prob cv" },
    { key: "offset_cv", type: "number", label: "offs cv" },
  ],
  outputs: [
    { key: "sample", type: "audio", label: "out" },
    { key: "inv", type: "audio", label: "inv" },
  ],
  knobs: [
    { key: "mode", label: "Hold mode", default: 0, min: 0, max: 2, step: 1, help: "0 SAMPLES on the trigger's rising edge, 1 TRACKS while the trigger is high, 2 PASSES while it is LOW. THEIR PANEL LABELS DISAGREE WITH THEIR OWN ENUM and the code is what is ported here (kernels' D8) — the panel calls 1 \"Through\" and 2 \"Track & Hold\", which is the wrong way round. THE mode cv INLET OVERRIDES this when patched, cutting 0…5 V into three two-volt bands." },
    { key: "prob", label: "Probability", default: 1, min: 0, max: 1, step: 0.01, help: "The chance that a given trigger actually takes a sample, 0…1. A failed toss HOLDS the previous value, which is what turns a clocked S&H into a generative one." },
    { key: "probCvAtten", label: "Probability CV amount", default: 0, min: -1, max: 1, step: 0.01, help: "How much the `prob cv` inlet moves the probability: `prob + cv·amount/10`, clamped to 0…1. AN ATTENUVERTER, not an added CV, which is why it is not named `prob_cv` (see this file's RENAMES)." },
    { key: "level", label: "Input level", default: 1, min: 0, max: 1, step: 0.01, help: "Scales the sampled value before the offset is added. With no signal patched this scales the RANDOM source instead, which is how you set the width of a random-voltage sequence." },
    { key: "offset", label: "Offset", default: 0, min: -1, max: 1, step: 0.01, help: "Added after the level. The `offs cv` inlet is NORMALLED TO 10 V, so with nothing patched this knob alone is a ±10 V shift; with a CV patched it becomes that CV's attenuverter. The sum is clamped to ±12 V (their own `// todo: saturate rather than clamp`)." },
    { ...SEED, help: `${SEED.help} Used by BOTH the probability toss and the unpatched-input random source, in that order.` },
  ],
};

export const VCV_SAMPLE_AND_HOLD_SPEC = {
  type: "audio_vcv_sampleandhold", module: "vcvSampleAndHold", title: "VCV Sample & Hold", family: "modulation",
  icon: "mdi:stairs-up", readout: "mode", w: 150,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/SampleAndHold.cpp", "src/inc/GateProcessor.hpp"], "SampleAndHoldKernel", [...BLOCK_DEVIATIONS, "D8"]),
  help: "The plain three-mode hold: SAMPLE on a rising edge, TRACK while the gate is high, or PASS while it is low. An inverted copy comes out beside the sampled one, which costs nothing and saves an attenuverter whenever you want a pair of complementary modulations from one source.",
  inputs: [
    { key: "sample", type: "audio", label: "in" },
    { key: "trig", type: "audio", label: "trig" },
    { key: "mode_cv", type: "number", label: "mode cv" },
  ],
  outputs: [
    { key: "sample", type: "audio", label: "out" },
    { key: "inv", type: "audio", label: "inv" },
  ],
  knobs: [
    { key: "mode", label: "Hold mode", default: 0, min: 0, max: 2, step: 1, help: "0 SAMPLES on the trigger's rising edge, 1 TRACKS while the trigger is high, 2 PASSES while it is LOW. THEIR PANEL LABELS DISAGREE WITH THEIR OWN ENUM and the code is what is ported (kernels' D8). THE mode cv INLET OVERRIDES this when patched: 0…2 V is mode 0, 2…4 V mode 1, above 4 V mode 2." },
  ],
};

export const VCV_BOOLEAN_AND_SPEC = {
  type: "audio_vcv_booleanand", module: "vcvBooleanAnd", title: "VCV Boolean AND", family: "modulation",
  icon: "mdi:gate-and", readout: null, w: 150,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/BooleanAND.cpp", "src/inc/GateProcessor.hpp", "src/inc/Inverter.hpp"], "BooleanAndKernel", BLOCK_DEVIATIONS),
  help: `A four-input AND with a separate inverter — and the NORMALLING is what makes it usable rather than pedantic: an unpatched B follows A, C follows B, D follows C, so the same module is a 2-, 3- or 4-input gate with no mode switch, and with only A patched it is a buffer. The gate inlets are Schmitt-triggered at ${GATE_LOW_V} V / ${GATE_HIGH_V} V, so an LFO or an audio signal is a legal clock. The inverter inlet is NORMALLED TO THE AND OUTPUT, so the inv outlet is NAND unless you patch something else into it.`,
  inputs: [
    { key: "a", type: "audio", label: "a" },
    { key: "b", type: "audio", label: "b" },
    { key: "c", type: "audio", label: "c" },
    { key: "d", type: "audio", label: "d" },
    { key: "i", type: "audio", label: "inv in" },
  ],
  outputs: [
    { key: "and", type: "trigger", label: "and" },
    { key: "inv", type: "trigger", label: "inv" },
  ],
  knobs: [],
};

export const VCV_BOOLEAN_XOR_SPEC = {
  type: "audio_vcv_booleanxor", module: "vcvBooleanXor", title: "VCV Boolean XOR", family: "modulation",
  icon: "mdi:gate-xor", readout: "mode", w: 150,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/BooleanXOR.cpp", "src/inc/GateProcessor.hpp", "src/inc/Inverter.hpp"], "BooleanXorKernel", BLOCK_DEVIATIONS),
  help: "A four-input exclusive-OR with two different meanings of \"exclusive\", and the difference is audible: ODD PARITY fires whenever an odd number of inputs is high, which is the classic XOR and makes a rhythmic mesh out of two clocks; ONE-HOT fires only when EXACTLY one is high, which makes it a solo detector. UNLIKE THE AND, ITS UNPATCHED INPUTS ARE 0 V rather than normalled — a normalled input would make every empty channel count, which for XOR is nonsense. The whole module is silent unless A is patched.",
  inputs: [
    { key: "a", type: "audio", label: "a" },
    { key: "b", type: "audio", label: "b" },
    { key: "c", type: "audio", label: "c" },
    { key: "d", type: "audio", label: "d" },
    { key: "i", type: "audio", label: "inv in" },
  ],
  outputs: [
    { key: "xor", type: "trigger", label: "xor" },
    { key: "inv", type: "trigger", label: "inv" },
  ],
  knobs: [
    { key: "mode", label: "One-hot", default: 0, ...SWITCH, help: "0 is ODD PARITY (their default since v1.2): high when an odd number of inputs is high. 1 is ONE-HOT: high only when exactly one is. With two inputs the two are identical; with three or four they are completely different rhythms." },
  ],
};

export const VCV_CLOCK_DIVIDER_SPEC = {
  type: "audio_vcv_clockdivider", module: "vcvClockDivider", title: "VCV Clock Divider", family: "modulation",
  icon: "mdi:division", readout: "mode", w: 160,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/ClockDivider.cpp", "src/inc/GateProcessor.hpp"], "ClockDividerKernel", BLOCK_DEVIATIONS),
  help: "ONE COUNTER, EIGHT TAPS, FOUR WAYS TO READ IT. Binary 1 is a true RIPPLE COUNTER — each output is a bit, so they are /2 /4 /8 … and every one of them is phase-locked to the others. Decimal and Prime are DIVISORS instead, giving /2 /3 /4 /5 … and /2 /3 /5 /7 /11 …, which a binary counter cannot: prime divisions of one clock never line up until their product, which is where a long generative phrase comes from. The output mode switch turns all eight from gates into 1 ms triggers.",
  inputs: [
    { key: "clock", type: "audio", label: "clock" },
    { key: "reset", type: "audio", label: "reset" },
  ],
  outputs: numbered("div", DIVIDER_OUTPUTS).map((key, i) => ({ key, type: "trigger", label: `d${i + 1}` })),
  knobs: [
    { key: "dir", label: "Count up", default: 0, ...SWITCH, help: "0 counts DOWN, which their own panel calls \"more musical\" and is the default; 1 counts up. The divisions are the same either way — what changes is which step of the cycle each output is high on, i.e. the phase between the taps." },
    { key: "trig", label: "Trigger outputs", default: 0, ...SWITCH, help: "0 emits GATES — each output is the raw counter bit, so Binary 1's first tap is a square wave at half the clock. 1 emits 1 ms TRIGGERS at each rise instead. Same divisions, completely different thing to patch into an envelope." },
    { key: "mode", label: "Mode", default: 0, min: 0, max: 3, step: 1, help: "0 Binary 1 (bits 1 2 4 8 16 32 64 128 — a ripple counter, and the ONLY mode that ANDs rather than taking a modulus), 1 Binary 2 (2 4 8 … 256), 2 Decimal (2 3 4 5 6 7 8 9), 3 Prime (2 3 5 7 11 13 17 19). The counter wraps at the mode's own LCM, so every pattern repeats exactly." },
  ],
};

export const VCV_VC_FREQUENCY_DIVIDER_MK2_SPEC = {
  type: "audio_vcv_vcfrequencydividermkii", module: "vcvVcFrequencyDividerMkII", title: "VC Frequency Divider MkII", family: "modulation",
  icon: "mdi:sine-wave", readout: "divide", w: 170,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/VCFrequencyDividerMkII.cpp", "src/inc/FrequencyDivider.hpp"], "VcFrequencyDividerMkIIKernel", [...BLOCK_DEVIATIONS, "D14"]),
  help: "TRUE SUBHARMONICS, AND THIS IS P25's ENTIRE SOUND — the Moog Subharmonicon patch runs eight of these off two oscillators. It counts BOTH EDGES of whatever arrives, so the output is exactly f/N and PHASE-LOCKED to its parent forever: no drift, no beating, which is why a stack of these sounds like a Subharmonicon and a stack of detuned oscillators does not. Two outlets, the same square in bipolar (±5 V, audio) and unipolar (0…10 V) form.",
  inputs: [
    { key: "cv", type: "number", label: "div cv" },
    { key: "div", type: "audio", label: "in" },
  ],
  outputs: [
    { key: "divb", type: "audio", label: "bi" },
    { key: "divu", type: "audio", label: "uni" },
  ],
  knobs: [
    { key: "cvAmount", label: "CV amount", default: 0, min: -2, max: 2, step: 0.01, help: "How much the `div cv` inlet moves the division: ±2 scales a ±10 V CV onto ±20 divisions, which is their own comment's reason for the range. The sum with the Divide knob is TRUNCATED to a whole number and then clamped to 1…21, so a smooth CV steps between subharmonics rather than sliding." },
    { key: "divide", label: "Divide by", default: 1, min: 1, max: 21, step: 1, help: "The division, 1…21. 1 passes the input's own frequency; 2 is an octave down; 3 is an octave and a fifth down, and so on down the harmonic series — which is what makes an arbitrary N musical rather than merely slow." },
    { key: "legacy", label: "Legacy mode", default: 0, ...SWITCH, help: "1 runs their PRE-MkII divider instead, which is saved in their patch JSON so a harvested patch may need it. It counts LEADING EDGES ONLY, so the same knob divides by twice as much, and it re-quantises the division through a voltage map — a genuinely different sound, not a compatibility shim." },
  ],
};

export const VCV_BUS_ROUTE_2_SPEC = {
  type: "audio_vcv_busroute2", module: "vcvBusRoute2", title: "VCV Bus Route 2", family: "modulation",
  icon: "mdi:call-merge", readout: null, w: 165,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/BusRoute2.cpp", "src/inc/GateProcessor.hpp"], "BusRoute2Kernel", BLOCK_DEVIATIONS),
  help: "A SEVEN-CHANNEL WIRED OR ONTO TWO BUSES. Each input has two switches saying whether it feeds bus A, bus B, both or neither, and a bus is high while ANY of its enabled inputs is. It carries no level and mixes nothing — it merges TRIGGERS, which is how P25 gets two sequencer rows onto one clock line without them cancelling.",
  inputs: numbered("gate", BUS_CHANNELS).map((key, i) => ({ key, type: "audio", label: `ch ${i + 1}` })),
  outputs: [
    { key: "a", type: "trigger", label: "bus a" },
    { key: "b", type: "trigger", label: "bus b" },
  ],
  knobs: [
    ...numbered("busA", BUS_CHANNELS).map((key, i) => ({
      key, label: `Ch ${i + 1} → A`, default: 0, ...SWITCH,
      help: `Route channel ${i + 1} onto bus A. A channel may feed both buses, and an unpatched channel reads 0 V and never contributes whatever its switches say.`,
    })),
    ...numbered("busB", BUS_CHANNELS).map((key, i) => ({
      key, label: `Ch ${i + 1} → B`, default: 0, ...SWITCH,
      help: `Route channel ${i + 1} onto bus B. The two buses are independent, so the same channel switched to both is a mult and a channel switched to neither is simply unused.`,
    })),
  ],
};

// ── EFFECT ──────────────────────────────────────────────────────────────────

export const VCV_FADE_SPEC = {
  type: "audio_vcv_fade", module: "vcvFade", title: "VCV Fade", family: "effect",
  icon: "mdi:fade", readout: "in", w: 165,
  derivation: derivedFrom(COUNTMODULA_SOURCE, ["src/modules/Fade.cpp", "src/inc/SlewLimiter.hpp", "src/inc/GateProcessor.hpp"], "FadeKernel", [...BLOCK_DEVIATIONS, "D12"]),
  help: `A STEREO VCA WHOSE GAIN IS A FOUR-STAGE LINEAR FADE, built to top and tail a recording. Gate it and it ramps up over the fade-in time, holds, and on the gate's fall ramps down over the fade-out — raising a \`gate\` outlet for the whole run and a 1 ms \`trig\` at each end so the recorder can be armed from it. INTERRUPTING A FADE DOES NOT CLICK: re-gating half way down restarts the ramp from the CURRENT gain, not from zero. The separate MONITOR path passes audio through with a ~45 ms slew, so you can hear the source without arming a take.`,
  inputs: [
    { key: "l", type: "audio", label: "l" },
    { key: "r", type: "audio", label: "r" },
    { key: "ctrl", type: "audio", label: "ctrl" },
  ],
  outputs: [
    { key: "l", type: "audio", label: "l" },
    { key: "r", type: "audio", label: "r" },
    { key: "gate", type: "trigger", label: "gate" },
    { key: "trig", type: "trigger", label: "trig" },
  ],
  knobs: [
    { key: "fade", label: "Start/stop", default: 0, ...SWITCH, help: "The manual transport: 1 starts the fade-in, 0 starts the fade-out. IGNORED while the `ctrl` inlet is patched — that inlet takes over completely (their code writes this switch back from the input, which a knob here cannot do; kernels' D12)." },
    { key: "in", label: "Fade in", default: 3, min: 0.1, max: 10, step: 0.01, unit: " s", help: "How long the ramp up takes, in SECONDS — their own knob unit, so a harvested value transcribes unchanged. The ramp is LINEAR in amplitude, which for a fade this long reads as a natural swell." },
    { key: "out", label: "Fade out", default: 3, min: 0.1, max: 10, step: 0.01, unit: " s", help: "How long the ramp down takes, in seconds. Independent of the fade-in, which is what lets a quick top and a long tail be one setting." },
    { key: "mon", label: "Monitor", default: 0, ...SWITCH, help: "1 passes the input through at unity WITHOUT running the fade — for hearing the source before you commit. It is mutually exclusive with running: while a fade is in progress the monitor is forced off." },
    { key: "controlMode", label: "Start/stop triggers", default: 0, ...SWITCH, help: "How the `ctrl` inlet is read. 0 is a GATE — running while it is high. 1 is START/STOP TRIGGERS — each rising edge toggles, so one trigger source can both start and end a take. Saved in their patch JSON, hence a knob." },
  ],
};

/**
 * EVERY VC-7a SPEC, modulation first then effect — the same ordering rule
 * core/audio_specs.AUDIO_SPECS follows, so the palette reads as one library rather
 * than as two lists that happen to be adjacent.
 *
 * THE BARREL LINE THIS NEEDS: `core/audio_blocks.js`'s `PORT_BLOCK_SPECS` must spread
 * this array, and `plugins/audio_index.js`'s `audioPlugins` must spread the matching
 * plugin array, or these modules exist in the engine and nowhere the author can reach.
 * tests/port_vc7a_test.js sweeps this array either way.
 */
export const BLOCK_SPECS = [
  VCV_CLKD_SPEC,
  VCV_CLOCK_DIVIDER_SPEC,
  VCV_VC_FREQUENCY_DIVIDER_MK2_SPEC,
  VCV_GATE_SEQUENCER_8_SPEC,
  VCV_BURST_GENERATOR_SPEC,
  VCV_EVENT_TIMER_SPEC,
  VCV_SAMPLE_AND_HOLD_SPEC,
  VCV_SAMPLE_AND_HOLD_2_SPEC,
  VCV_BOOLEAN_AND_SPEC,
  VCV_BOOLEAN_XOR_SPEC,
  VCV_BUS_ROUTE_2_SPEC,
  VCV_FADE_SPEC,
];
