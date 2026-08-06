/**
 * THE VC-2 MODULE SPECS — sixteen ported VCV Rack Fundamental and Core nodes.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * `core/audio_specs.js`'s vocabulary applied to a third module set. Same record
 * shape, same rules, same reader (`core/audio_nodes.audioNodePlugin`): a spec is
 * the values that make one module differ from its neighbours, and NOTHING about
 * how it sounds. The DSP is `synth/vc2_kernels.js`, whose docblocks carry the
 * derivation record — which C++ file, which function, the recurrence, every named
 * deviation — and each `help` below points at it rather than repeating it.
 *
 * A SECOND (third) FILE rather than more rows in the first, for the reason
 * `core/audio_blocks.js` records: several agents land ported module sets
 * concurrently and one shared file is one merge conflict per agent per save. The
 * barrel — `AUDIO_SPECS` — stays the single roster; this array is spread into it.
 *
 * ── THE FOUR VC-2 LAWS, IN THEIR SPEC-FACING FORM ───────────────────────────
 * Stated in full in `synth/vc2_kernels.js`'s header. What a reader of THIS file
 * needs:
 *
 * L1. **FOUR UNITS, BY QUANTITY** (manifest § R7-UNITS). An `audio` wire is ±1
 *     and ±1 IS ±5 Rack volts. A GATE is 0…1 (logic is not level, so it
 *     normalises to Rack's 10 V gate, not to ±5). A V/OCT port carries
 *     SEMITONES — an octave is 12.0, a quantizer step is 1.0, and 0 is **C4**
 *     (261.6256 Hz), not Axoloti's E4. A NORMALISED DEPTH is 0…1, which is what
 *     every CV Rack writes as `input/10` becomes, and what the ADSR's envelope
 *     emits. The kernels hold the recurrences in volts and convert at the port;
 *     `synth/vc2_kernels.js`'s header names each factor and the measurement
 *     behind it.
 *     WHAT THAT BUYS, AND IT IS THE WHOLE POINT OF HAVING ONE LAW: our own
 *     `audio_clock`'s 1.0 gate drives every clock input here, our own
 *     `audio_adsr`'s 0…1 envelope drives every CV input here, and our own
 *     oscillators sit at the same full scale as these. No adapter node.
 *
 * L2. **A KNOB CARRIES ITS QUANTITY'S REAL UNIT** (R7-UNITS clause 2): hertz for
 *     a frequency, seconds for a time, bpm for a tempo, semitones for an
 *     interval, 0…1 for a depth. Rack's own `configParam` range is kept wherever
 *     it IS a real unit and INVERTED where it is a dial — the VCF's cutoff is
 *     8 Hz…22 kHz rather than a 0.0995…0.7386 dial, the Delay's time is
 *     1 ms…10 s rather than 0…1. `synth/vc2_kernels.js` records why the
 *     dial-valued reading this block first shipped was measurably wrong.
 *
 * L3. **A KNOB AND A SAME-NAMED INPUT MAY BE TWO DIFFERENT QUANTITIES**, unlike
 *     AX-2 where they sum on one AudioParam. Rack never adds a knob to a CV in
 *     the same units: it writes `param + input/10 · trim`, and `trim` is an
 *     attenuverter a patch file sets. So `vcvOctave` has a knob `octave` in whole
 *     octaves AND an input `octave` in semitones, and the kernel combines them as
 *     `Octave.cpp` does. Every `*_cv` knob below is one of those attenuverters.
 *
 * L4. **Clock dividers are ported** (the ADSR recomputes its rates every 16th
 *     sample, as theirs does).
 *
 * ── AND THE ONE THING RACK HAS THAT WE DO NOT: A SENSED JACK (D10) ──────────
 * Half of Fundamental branches on `isConnected()`. We cannot: an unwired
 * AudioParam is not absent, it reads its intrinsic value, so a literal port of
 * VCA-1 would make an unwired VCA silent. Every such jack therefore has a
 * companion knob holding the depth to ASSUME when nothing is patched (1 — unity,
 * i.e. Rack's own 10 V), and every clock jack counts as patched from its first
 * edge. Both are
 * named in the kernels' D10 and in the affected rows' `help`.
 *
 * ── UNITS: THIS FILE MAY NOT IMPORT synth/** ────────────────────────────────
 * core/ must run in bare node, so every range below is RESTATED from
 * `synth/worklets/processors_vc2.js`'s roster and pinned against it by
 * `tests/port_vc2_test.js` — the same arrangement AX-2 and AX-3 use, and the seam
 * that keeps a restatement checkable rather than a second opinion waiting to
 * drift.
 */

// ── SHARED FRAGMENTS ────────────────────────────────────────────────────────

/** `dsp::FREQ_C4` — restated (see the header on why this file cannot import it)
 *  because three `hz` helpers below are pitches relative to middle C. */
const FREQ_C4 = 261.6256;

/** A CABLE's full swing, ±10 V, in each of R7-UNITS' kinds — one fact, three
 *  spellings, and every voltage-valued knob's range comes from one of them.
 *  RESTATED from `synth/worklets/processors_vc2.js` for the reason the header
 *  gives (core/ may not import synth/), and pinned against it by the test. */
const VOLTS_PER_AUDIO_UNIT = 5;
const SEMITONES_PER_OCTAVE = 12;
const CABLE_MAX_VOLTS = 10;
const CABLE_LEVEL = CABLE_MAX_VOLTS / VOLTS_PER_AUDIO_UNIT;
const CABLE_SEMITONES = CABLE_MAX_VOLTS * SEMITONES_PER_OCTAVE;

/** How far an assumed-jack depth may be pushed: Rack's channel CV is floored at
 *  zero and NOT capped, so 2 (a +6 dB, 20 V-equivalent CV) is a real setting. */
const ASSUMED_DEPTH_MAX = 2;

/** A level-valued knob's step: 0.01 is finer than any panel and coarse enough
 *  that a drag reads as a number rather than as noise. */
const VOLT_STEP = 0.01;

/**
 * AN ATTENUVERTER — Rack's `*_CV_PARAM`, and the row that makes law L3 visible.
 *
 * DEFAULT 0 IS FAITHFUL AND IT WILL SURPRISE YOU ONCE: in Rack 2 a freshly
 * placed module has every CV trim at zero, so patching a CV does nothing until
 * you turn the trim up. (`paramsFromJson` sets 1 only when loading a pre-2.0
 * patch, where the trims did not exist.) It is not an inert control — the trim
 * IS the control — and a transcribed patch always sets it, because the patch file
 * stores it.
 */
const attenuverter = (key, label, of) => ({
  key, label, default: 0, min: -1, max: 1, step: VOLT_STEP,
  help: `How much of the \`${of}\` input reaches ${of}, from −100% through 0 to +100%. RACK'S OWN DEFAULT IS 0, so this input does nothing until you raise this — that is not a bug in the port, it is what a fresh module does on the hardware's panel, and a transcribed patch sets it explicitly.`,
});

/**
 * THE ASSUMED-JACK-DEPTH ROW (deviation D10). 1 is unity, which is Rack's own
 * 10 V in the normalised unit R7-UNITS gives these ports.
 */
const assumedCv = (key, label, what, max = 1) => ({
  key, label, default: 1, min: 0, max, step: VOLT_STEP,
  help: `The depth to ASSUME on the \`${key}\` input when nothing is patched there — 1 is "wide open" (Rack's own 10 V), which is what ${what} does on the hardware with an empty jack. Our engine cannot tell a patched jack from an unpatched one (an unwired input reads its own value, it is not absent), so this row is what stands in for that. WIRE A CV IN AND SET THIS TO 0, or the two will add.`,
});

/** A 0/1 switch — Rack's `configSwitch` and its `dataToJson` booleans, which
 *  R7-11 makes knobs rather than hidden state. */
const toggle = (key, label, def, help) => ({ key, label, default: def, min: 0, max: 1, step: 1, help });

// ── RACK'S OWN PARAM BOUNDS, AND THE ROWS GENERATED FROM THEM ───────────────
// Declared BEFORE the specs because a spec record is evaluated at module load:
// a `min:` reading a const declared further down is a temporal-dead-zone throw
// at import time, which in this repo means a boot that dies in the import graph
// (see <app>/CLAUDE.md on why that is the one crash the splash must survive).

/** The real-unit knob bounds law L2 puts in place of Rack's dials, each one
 *  RESTATED from `synth/worklets/processors_vc2.js` (core/ may not import synth/)
 *  and pinned against it by tests/port_vc2_test.js. Every number is theirs: a
 *  `configParam` range, or the span a dial mapping covers. */
const VCF_FREQ_MIN_HZ = 8;
const VCF_FREQ_MAX_HZ = 22000;
const DELAY_TIME_MIN_SECONDS = 0.001;
const DELAY_TIME_MAX_SECONDS = 10;
const LFO_FREQ_MIN_HZ = 2 ** -8;
const LFO_FREQ_MAX_HZ = 2 ** 10;
const RANDOM_RATE_MIN_HZ = 0.002;
const RANDOM_RATE_MAX_HZ = 2000;
const SEQ3_TEMPO_MIN_BPM = 15;
const SEQ3_TEMPO_MAX_BPM = 960;
const SEQ3_TEMPO_DEFAULT_BPM = 120;

/** `VCMixer.cpp`: the channel faders are `0 … M_SQRT2` under a square law. */
const VCMIXER_CH_MAX = Math.SQRT2;

/** `SEQ3.cpp`: `ENUMS(CV_PARAMS, 3 * 8)` and `ENUMS(GATE_PARAMS, 8)`. */
const SEQ3_ROWS = 3;
const SEQ3_STEPS = 8;

/** Rack's polyphony maximum, `engine::PORT_MAX_CHANNELS`. */
const MAX_CHANNELS = 16;

/**
 * Pure function. SEQ3's eight per-step gate OUTPUTS — generated, because eight
 * near-identical records is eight chances to mistype an index, and the kernel
 * writes them from the same loop.
 *
 * @returns {object[]} port records `step1 … step8`
 *
 * @example seq3StepOutputs().length // 8
 * @example seq3StepOutputs()[0] // {key: "step1", type: "trigger", label: "st1"}
 */
export function seq3StepOutputs() {
  const ports = [];
  for (let step = 1; step <= SEQ3_STEPS; step++) {
    ports.push({ key: `step${step}`, type: "trigger", label: `st${step}` });
  }
  return ports;
}

/**
 * Pure function. SEQ3's 24 CV knobs, three rows of eight, in semitones.
 *
 * @returns {object[]} knob records `cv1_1 … cv3_8`
 *
 * @example seq3CvKnobs().length // 24
 * @example seq3CvKnobs()[0].key // "cv1_1"
 * @example seq3CvKnobs()[8].key // "cv2_1"
 */
export function seq3CvKnobs() {
  const knobs = [];
  for (let row = 1; row <= SEQ3_ROWS; row++) {
    for (let step = 1; step <= SEQ3_STEPS; step++) {
      knobs.push({
        key: `cv${row}_${step}`, label: `CV ${row}·${step}`,
        default: 0, min: -CABLE_SEMITONES, max: CABLE_SEMITONES, step: 0.01, unit: " st",
        help: `Row ${row}, step ${step}, in SEMITONES — ±120, which is their own ±10 V knob in this block's pitch unit. So 7 is a perfect fifth, 12 is an octave, and a scale is the integers. (Their knob is a raw voltage; semitones is the unit that makes this row drive a pitch input with no arithmetic, which is what a CV sequencer is for.) Any of these may be an equation, which is how a 24-knob panel becomes something an author can generate.`,
      });
    }
  }
  return knobs;
}

/**
 * Pure function. SEQ3's eight per-step gate toggles — `gates[]` in their JSON,
 * which R7-11 makes knobs rather than hidden state.
 *
 * @returns {object[]} knob records `gate1 … gate8`
 *
 * @example seq3GateKnobs().length // 8
 * @example seq3GateKnobs()[0].default // 1
 */
export function seq3GateKnobs() {
  const knobs = [];
  for (let step = 1; step <= SEQ3_STEPS; step++) {
    knobs.push(toggle(
      `gate${step}`, `Gate ${step}`, 1,
      `Whether step ${step} fires the trig output. IT DOES NOT GATE THE CV ROWS — a step with its gate off still outputs its three voltages, which is what makes SEQ3 three modulation sequencers plus one rhythm rather than four things switched together.`,
    ));
  }
  return knobs;
}

/**
 * Pure function. Sum's sixteen unrolled poly input ports (deviation D3).
 *
 * @returns {object[]} port records `poly1 … poly16`
 *
 * @example sumInputPorts().length // 16
 * @example sumInputPorts()[0] // {key: "poly1", type: "audio", label: "1"}
 */
export function sumInputPorts() {
  const ports = [];
  for (let i = 1; i <= MAX_CHANNELS; i++) ports.push({ key: `poly${i}`, type: "audio", label: `${i}` });
  return ports;
}

// ── SOURCES ─────────────────────────────────────────────────────────────────

export const VCV_NOISE_SPEC = {
  type: "audio_vcv_noise", module: "vcvNoise", title: "VCV Noise", family: "source",
  icon: "mdi:grain", readout: null, w: 130,
  help: "SIX colours at once, each on its own jack and every one calibrated to the same loudness (1/√2 RMS — which is the RMS of a full-scale sine, and is Rack's own 5/√2 V over R7-UNITS' factor of five). White here is GAUSSIAN, not uniform, and red/violet/blue are all derived from it, so they are the same noise heard through three different slopes. Black is the odd one out: uniform, full-scale ±1, and not level-matched — their own comment says they made the definition up.",
  inputs: [],
  outputs: [
    { key: "white", type: "audio", label: "white" },
    { key: "pink", type: "audio", label: "pink" },
    { key: "red", type: "audio", label: "red" },
    { key: "violet", type: "audio", label: "violet" },
    { key: "blue", type: "audio", label: "blue" },
    { key: "black", type: "audio", label: "black" },
  ],
  knobs: [
    {
      key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
      help: "CONSTRUCT-TIME: the generator's state is initialised once, so changing this rebuilds the module. THE REASON THIS KNOB EXISTS AT ALL: Rack seeds its noise from the operating system at startup, so THEIR noise is not reproducible between two runs of the same patch, and a document that renders differently every time is not a document. Same seed, same noise, forever.",
    },
  ],
};

// ── FILTERS ─────────────────────────────────────────────────────────────────

export const VCV_VCF_SPEC = {
  type: "audio_vcv_vcf", module: "vcvVcf", title: "VCV Ladder Filter", family: "filter",
  icon: "mdi:filter-variant", readout: "freq", w: 165,
  help: "A FOUR-POLE TRANSISTOR LADDER, not a biquad — and that is the whole point of the row. Each pole integrates tanh(in) − tanh(out) and the fourth pole's output is fed back through the input's saturator, which buys three things our own Filter cannot do: it SELF-OSCILLATES at high resonance (measured: a pure tone from a silent input above about Resonance 0.63), its resonance SQUASHES the passband instead of only peaking it, and Drive is a real overdrive of up to 32× into that saturator. Runs at 2× oversampling through a polyphase halfband, so the distortion does not alias.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "freq", type: "number", label: "freq" },
    { key: "res", type: "number", label: "res" },
    { key: "drive", type: "number", label: "drive" },
  ],
  outputs: [
    { key: "lpf", type: "audio", label: "lp" },
    { key: "hpf", type: "audio", label: "hp" },
  ],
  knobs: [
    {
      key: "freq", label: "Cutoff", default: FREQ_C4, min: VCF_FREQ_MIN_HZ, max: VCF_FREQ_MAX_HZ, step: 0.01, unit: " Hz",
      help: "In HERTZ (law L2), over their own 8 Hz…22 kHz span, defaulting to middle C. IT IS THE PER-POLE CORNER, not the audible knee: four poles together are −3 dB at 0.435× it, so the default sounds like 114 Hz and measures 113.6 against 113.8 predicted. A hot input lowers it further — see Drive.",
    },
    {
      key: "res", label: "Resonance", default: 0, min: 0, max: 1, step: 0.01,
      help: "Feedback around the ladder, SQUARED and scaled to 10 — so nothing much happens in the bottom half and self-oscillation starts around 0.63. At the top the filter is an oscillator: patch nothing into `in` and it still sings, at the cutoff pitch.",
    },
    {
      key: "drive", label: "Drive", default: 0, min: -1, max: 1, step: 0.01,
      help: "Input gain into the saturator, as `(1 + drive)^5`: silence at −1, unity at 0, 32× at +1. Driving it hard does not only distort — the per-stage tanh slopes fall, which DROPS the cutoff (measured: 114 Hz becomes 71 Hz at a full-scale input). That is the ladder's real behaviour, not a modelling error.",
    },
    attenuverter("freqCv", "Cutoff CV", "freq"),
    attenuverter("resCv", "Resonance CV", "res"),
    attenuverter("driveCv", "Drive CV", "drive"),
    {
      key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
      help: "CONSTRUCT-TIME. The filter adds −120 dB of noise to its input to bootstrap self-oscillation (without it, a silent input never starts ringing), and that noise must be reproducible here. Rack's is not.",
    },
  ],
};


export const VCV_QUANTIZER_SPEC = {
  type: "audio_vcv_quantizer", module: "vcvQuantizer", title: "VCV Quantizer", family: "filter",
  icon: "mdi:stairs", readout: "mask",
  help: "Snaps a V/oct pitch to a chosen set of the twelve semitones — the module that turns a random voltage into a melody that cannot play a wrong note. Unlike our own Quantize node this is EXACT-INTEGER and octave-aware: it splits the incoming voltage into an octave and one of 24 half-semitone ranges, snaps the range to the nearest ENABLED note, and reassembles. Round the wrong way and every generative patch drifts a semitone.",
  // ONE INPUT. `Quantizer.cpp`'s `enum InputIds` is PITCH_INPUT and nothing else —
  // its pre-offset is a param with no jack — and both placeholder sets read it that
  // way and asked VC-2 to drop the phantom port when it landed.
  inputs: [{ key: "pitch", type: "number", label: "pitch" }],
  outputs: [{ key: "pitch", type: "audio", label: "pitch" }],
  knobs: [
    {
      key: "mask", label: "Notes", default: 4095, min: 0, max: 4095, step: 1,
      help: "WHICH SEMITONES ARE LEGAL, as a 12-bit number: bit 0 is C, bit 1 is C♯, … bit 11 is B. 4095 is all twelve (chromatic — their own reset state), 2741 is a major scale, 661 is C major pentatonic. A number rather than their twelve piano keys so an EQUATION can sweep it — a modulated scale mask is a thing their panel cannot do at all. ALL-ZERO IS NOT AN ERROR: with no note enabled the mask is ignored and every semitone passes, which is theirs.",
    },
    {
      key: "offset", label: "Pre-offset", default: 0, min: -SEMITONES_PER_OCTAVE, max: SEMITONES_PER_OCTAVE, step: 0.01, unit: " st",
      // `interval: true` is the library's declaration for a semitone knob that is a
      // TRANSPOSITION rather than an absolute tuning (tests/audio_nodes_test.js's
      // readout sweep reads it). A hertz number beside a pre-offset would be a
      // confident lie: the pitch arrives on the wire, and this only shifts it.
      interval: true,
      help: "Added to the pitch BEFORE quantising, in SEMITONES — so ±12 is ±one octave and 0.5 is a quarter tone, which is the setting that flips which of two neighbouring notes a voltage snaps to. Transposing here changes WHICH note the input lands on; transposing AFTER the Quantizer (with an Octave node) does not. NO HERTZ IS SHOWN because this is a transposition, not a tuning: a frequency here would be a confident lie.",
    },
  ],
};

// ── EFFECTS ─────────────────────────────────────────────────────────────────

export const VCV_DELAY_SPEC = {
  type: "audio_vcv_delay", module: "vcvDelay", title: "VCV Delay", family: "effect",
  icon: "mdi:altimeter", readout: "time", w: 165,
  help: "1 ms to 10 s of echo, and the module whose TIME KNOB IS AN INSTRUMENT: it does not jump when you move it, it resamples its own history until the length matches, which pitch-bends the repeats by up to two octaves on the way. One Tone knob drives a lowpass and a highpass in opposite directions, so turning it down darkens the repeats and turning it up thins them.",
  inputs: [
    // NOT `feedbackSafe`. Our own DELAY_SPEC settles that question: the recursion
    // here is INSIDE the module, against a buffer the processor owns, so nothing
    // travels a wire and there is no graph cycle to be exempt from —
    // tests/audio_nodes_test.js pins that flag to exactly one port in the repo.
    { key: "in", type: "audio", label: "in" },
    { key: "time", type: "number", label: "time" },
    { key: "feedback", type: "number", label: "fb" },
    { key: "tone", type: "number", label: "tone" },
    { key: "mix", type: "number", label: "mix" },
    { key: "clock", type: "trigger", label: "clock" },
  ],
  outputs: [
    { key: "mix", type: "audio", label: "mix" },
    { key: "wet", type: "audio", label: "wet" },
  ],
  knobs: [
    {
      key: "time", label: "Time", default: 0.5, min: DELAY_TIME_MIN_SECONDS, max: DELAY_TIME_MAX_SECONDS, step: 0.001, unit: " s",
      help: "In SECONDS (law L2), 1 ms…10 s, and measured at the default: 0.4996 s. WITH A CLOCK PATCHED IT STOPS BEING SECONDS — the delay becomes a division of that clock and this reads as a ratio, which is theirs and which their own panel is equally quiet about. Moving it does not jump; see the module help.",
    },
    {
      key: "feedback", label: "Feedback", default: 0.5, min: 0, max: 1, step: 0.01,
      help: "How much of the wet output returns to the input. UNLIKE our own Delay this reaches 1.0, where the echo never decays; the wet path is bounded at ±20 (their ±100 V) rather than allowed to run away, which is theirs, and the Audio node's limiter is what saves your ears.",
    },
    {
      key: "tone", label: "Tone", default: 0.5, min: 0, max: 1, step: 0.01,
      help: "ONE knob, TWO filters, moving opposite ways: `100^(2·tone − 1)` scales a 20 kHz lowpass and a 20 Hz highpass together. At 0 the lowpass is at 200 Hz (dark repeats); at 0.5 both are out of the way; at 1 the highpass is at 2 kHz (thin, telephone repeats).",
    },
    { key: "mix", label: "Mix", default: 0.5, min: 0, max: 1, step: 0.01, help: "Crossfade between the dry input and the wet delay on the `mix` output. The `wet` output ignores it." },
    attenuverter("timeCv", "Time CV", "time"),
    attenuverter("feedbackCv", "Feedback CV", "feedback"),
    attenuverter("toneCv", "Tone CV", "tone"),
    attenuverter("mixCv", "Mix CV", "mix"),
  ],
};


export const VCV_SEQUENTIAL_SWITCH2_SPEC = {
  type: "audio_vcv_sequentialswitch2", module: "vcvSequentialSwitch2",
  title: "VCV Sequential Switch 2", family: "effect",
  icon: "mdi:call-merge", readout: "steps",
  help: "Four inputs, one output, and a clock that walks between them — the cheapest way to make one voice play four different things in turn. A THRESHOLD DETAIL THAT IS LOAD-BEARING: the clock fires at 0.2 and releases at 0.01 — Rack's 2 V and 0.1 V as fractions of a gate — so a half-height 0.1 pulse does NOT advance it. Our own Clock and Trigger nodes emit a full 1.0, which clears it five times over.",
  inputs: [
    { key: "in1", type: "audio", label: "1" },
    { key: "in2", type: "audio", label: "2" },
    { key: "in3", type: "audio", label: "3" },
    { key: "in4", type: "audio", label: "4" },
    { key: "clock", type: "trigger", label: "clock" },
    { key: "reset", type: "trigger", label: "reset" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "steps", label: "Steps", default: 2, min: 0, max: 2, step: 1,
      help: "THEIR SWITCH POSITION, not a count (law L2): 0 cycles two inputs, 1 cycles three, 2 cycles all four. The wrap is checked AFTER the clock increments, so shortening this while running takes effect on the next clock and can skip a step once — that is theirs and it is audible.",
    },
    toggle("declick", "De-click", 0, "Crossfade between inputs over 2.5 ms instead of switching instantly (a linear 400 units/second slew). OFF is Rack's default since 2.5.0 and gives you the click; ON is what older patches had, and is what you want when the inputs are audio rather than CV."),
  ],
};

export const VCV_RESCALE_SPEC = {
  type: "audio_vcv_rescale", module: "vcvRescale", title: "VCV Rescale", family: "effect",
  icon: "mdi:arrow-expand-vertical", readout: "gain", w: 165,
  help: "Gain, offset and a two-sided limiter that can CLAMP or REFLECT — and with both reflects on it is a WAVEFOLDER, because a signal that overshoots comes back rather than flattening. Its everyday use is turning a bipolar signal unipolar: gain 0.5, offset 0.5, and a ±1 LFO becomes a 0…1 depth.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "gain", label: "Gain", default: 0, min: -1, max: 1, step: 0.01, help: "Multiplies the input, and is multiplied BY Multiplier. Negative inverts. Their default is 0 — a fresh Rescale outputs only its offset." },
    {
      key: "multiplier", label: "Multiplier", default: 1, min: 1, max: 1000, step: 1,
      help: "Scales what Gain means: 1, 10, 100 or 1000 (their context menu). Gain is only ±1, so this is how a Rescale amplifies at all — ×1000 with gain 0.001 is also how it becomes a fine trim.",
    },
    { key: "offset", label: "Offset", default: 0, min: -CABLE_LEVEL, max: CABLE_LEVEL, step: VOLT_STEP, help: "Added after the gain, in the LEVEL unit (1.0 is full scale). Gain 0.5 with Offset 0.5 turns a ±1 signal into 0…1, which is how you feed a unipolar depth input from a bipolar LFO." },
    { key: "min", label: "Minimum", default: -CABLE_LEVEL, min: -CABLE_LEVEL, max: CABLE_LEVEL, step: VOLT_STEP, help: "The floor. IF MAXIMUM IS AT OR BELOW THIS, the output is this value and nothing else — theirs, and a fast way to make a constant." },
    { key: "max", label: "Maximum", default: CABLE_LEVEL, min: -CABLE_LEVEL, max: CABLE_LEVEL, step: VOLT_STEP, help: "The ceiling. With Reflect max on, a signal that overshoots this comes back down instead of flattening against it — which is the difference between a limiter and a wavefolder." },
    toggle("reflectMin", "Reflect min", 0, "FOLD at the floor instead of clamping to it: a signal going below Minimum comes back up. With both reflects on, the signal bounces cyclically between the two limits, which is a wavefolder."),
    toggle("reflectMax", "Reflect max", 0, "Fold at the ceiling instead of clamping to it."),
  ],
};

// ── MODULATION ──────────────────────────────────────────────────────────────

export const VCV_VCA_SPEC = {
  type: "audio_vcv_vca", module: "vcvVca", title: "VCV VCA", family: "modulation",
  icon: "mdi:volume-medium", readout: "level",
  help: "Signal in, CV in, product out — with a CHOICE OF LAW, which is what our own VCA lacks. Linear is a plain multiply; the two exponential curves are the ones that make a plucked envelope sound plucked rather than merely quiet. The CV is clamped to 0…1, so a negative CV closes the VCA rather than inverting the signal — and 1.0 is unity, which is exactly what our own Envelope node emits.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "cv", type: "number", label: "cv" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "level", label: "Level", default: 1, min: 0, max: 1, step: 0.01, help: "The fader, multiplied with the CV. At 0 the module is closed however hot the CV." },
    {
      key: "response", label: "Response", default: "linear", discrete: true,
      options: ["linear", "exp4", "exp50"],
      help: "`linear` is `cv/10` — Rack's own default. `exp4` is `(cv/10)⁴`, VCA-1's context-menu exponential: gentle near the top, steep at the bottom. `exp50` is old VCA's dedicated exponential jack, `(50^x − 1)/49`, a 34 dB taper that is much more aggressive. The registry row covers both modules, so both laws are here rather than one being dropped.",
    },
    assumedCv("cv", "CV (unpatched)", "an empty CV jack"),
  ],
};

export const VCV_ADSR_SPEC = {
  type: "audio_vcv_adsr", module: "vcvAdsr", title: "VCV ADSR", family: "modulation",
  icon: "mdi:chart-bell-curve", readout: "attack", w: 165,
  help: "THEIR envelope curve, which is not ours. Every stage is the same first-order approach to a target, and the ATTACK AIMS AT 1.2 AND GIVES UP AT 1.0 — so it is the first 83% of an exponential rise, nearly straight, with no lazy approach at the top (measured: 179 ms to full at the default, from a 100 ms time constant). Our own Envelope schedules ramps in seconds; this integrates a rate, and the difference is audible on every pluck.",
  inputs: [
    { key: "gate", type: "trigger", label: "gate" },
    { key: "retrig", type: "trigger", label: "retrig" },
    { key: "attack", type: "number", label: "A" },
    { key: "decay", type: "number", label: "D" },
    { key: "sustain", type: "number", label: "S" },
    { key: "release", type: "number", label: "R" },
  ],
  outputs: [{ key: "envelope", type: "audio", label: "env" }],
  knobs: [
    { key: "attack", label: "Attack", default: 0.1, min: 0.001, max: 10, step: 0.001, unit: " s", help: "In SECONDS (law L2), 1 ms…10 s. NOTE THE CURVE THIS TIME BELONGS TO: the attack aims past full scale and gives up on the way, so the stage takes about 1.8× this — 179 ms at the 100 ms default, measured. The `A` input modulates it LOGARITHMICALLY (a CV of 0.1 multiplies the time by 2.5 wherever the knob is parked), which is their modulation and not a linear one." },
    { key: "decay", label: "Decay", default: 0.1, min: 0.001, max: 10, step: 0.001, unit: " s", help: "In seconds. The fall from full toward the sustain level, as a first-order approach — so this is its time CONSTANT rather than the time it takes to arrive." },
    { key: "sustain", label: "Sustain", default: 0.5, min: 0, max: 1, step: 0.01, help: "The LEVEL held while the gate is high, and the envelope output IS this number: 0…1, the house unit for a depth, so it drives any CV input here (and our own VCA) at unity. The one stage that is not a time." },
    { key: "release", label: "Release", default: 0.1, min: 0.001, max: 10, step: 0.001, unit: " s", help: "In seconds. The fall to silence after the gate drops, again a first-order approach rather than a ramp." },
    attenuverter("attackCv", "Attack CV", "attack"),
    attenuverter("decayCv", "Decay CV", "decay"),
    attenuverter("sustainCv", "Sustain CV", "sustain"),
    attenuverter("releaseCv", "Release CV", "release"),
    toggle("push", "Push", 0, "A MANUAL GATE — their panel's Push button, held while this is 1. It overrides the `gate` input entirely, which is what makes it useful for auditioning a patch with nothing clocked."),
  ],
};

export const VCV_LFO_SPEC = {
  type: "audio_vcv_lfo", module: "vcvLfo", title: "VCV LFO", family: "modulation",
  icon: "mdi:wave", readout: "freq", w: 165,
  help: "FOUR waveforms from one phase, over an eighteen-octave range — 0.004 Hz to a kilohertz, so it is a modulator and an audio-rate FM source in one node. It is NOT band-limited: the modern Fundamental LFO is naive (their choice, not a shortcut here — MinBLEP lives in their VCO), so its square and saw alias if you run them as tones. Feed the `clock` input and every rate becomes a ratio of that clock instead.",
  inputs: [
    { key: "fm", type: "number", label: "fm" },
    { key: "pw", type: "number", label: "pw" },
    { key: "clock", type: "trigger", label: "clock" },
    { key: "reset", type: "trigger", label: "reset" },
  ],
  outputs: [
    { key: "sin", type: "audio", label: "sin" },
    { key: "tri", type: "audio", label: "tri" },
    { key: "saw", type: "audio", label: "saw" },
    { key: "sqr", type: "audio", label: "sqr" },
  ],
  knobs: [
    {
      key: "freq", label: "Frequency", default: 2, min: LFO_FREQ_MIN_HZ, max: LFO_FREQ_MAX_HZ, step: 0.001, unit: " Hz",
      help: "In HERTZ (law L2), over their own eighteen octaves: 0.0039 is one cycle every four minutes, 1024 is well into audio. WITH A CLOCK PATCHED this becomes a MULTIPLE of that clock rather than an absolute rate (their `clockFreq/2 · 2^pitch`), which is what makes the LFO a tempo divider.",
    },
    attenuverter("fm", "FM", "fm"),
    { key: "pw", label: "Pulse width", default: 0.5, min: 0.01, max: 0.99, step: 0.01, help: "Duty cycle of the SQUARE output only, clamped to 1%…99% exactly as theirs is. The other three outputs ignore it." },
    attenuverter("pwm", "PWM", "pw"),
    toggle("offset", "Unipolar", 1, "0…2 instead of ±1 — their 0…10 V against their ±5 V, so it DOUBLES the peak-to-peak swing rather than only shifting it. IT ALSO MOVES THE PHASE, by design: the sine is shifted a quarter cycle and the saw a half, so a unipolar wave STARTS AT ZERO and rises. Dropping that shift would put every unipolar LFO a quarter cycle out against the same patch in Rack."),
    toggle("invert", "Invert", 0, "Flips every output before the unipolar offset is added, so an inverted unipolar wave still spans 0…2 — it starts at the top."),
  ],
};


export const VCV_OCTAVE_SPEC = {
  type: "audio_vcv_octave", module: "vcvOctave", title: "VCV Octave", family: "modulation",
  icon: "mdi:arrow-up-down", readout: "octave",
  help: "Transposes a V/oct pitch by whole octaves, and it is EXACT-INTEGER. THE ONE THING TO KNOW: the knob and the CV are rounded SEPARATELY, so a knob at +1 with a 6-semitone CV gives +2 octaves, not +1. That is theirs, and getting it wrong is a whole octave with nothing to explain it.",
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "octave", type: "number", label: "oct cv" },
  ],
  outputs: [{ key: "pitch", type: "audio", label: "pitch" }],
  knobs: [
    {
      key: "octave", label: "Shift", default: 0, min: -4, max: 4, step: 1, unit: " oct",
      help: "Whole octaves, −4…+4, which is Rack's own `Shift` param. IT IS A DIFFERENT QUANTITY FROM THE `oct cv` INPUT BESIDE IT (law L3): this is octaves and that is SEMITONES (12 per octave), each is rounded on its own — the CV after dividing by 12 — and the two are then added.",
    },
  ],
};

export const VCV_VCMIXER_SPEC = {
  type: "audio_vcv_vcmixer", module: "vcvVcMixer", title: "VCV VC Mixer", family: "modulation",
  icon: "mdi:tune", readout: "mixLvl", w: 165,
  help: "Four channel strips, each with a CV, plus a VCA on the mix — and every channel has its OWN output, which is where a send/return topology hangs off. Two laws that our Mixer does not have: the channel faders are SQUARE (a 0…√2 knob reaching +6 dB) while the mix fader is LINEAR, and the CVs are floored at zero but NOT capped, so a CV of 2 really does give 2× gain (their 20 V).",
  inputs: [
    { key: "ch1", type: "audio", label: "1" }, { key: "cv1", type: "number", label: "cv1" },
    { key: "ch2", type: "audio", label: "2" }, { key: "cv2", type: "number", label: "cv2" },
    { key: "ch3", type: "audio", label: "3" }, { key: "cv3", type: "number", label: "cv3" },
    { key: "ch4", type: "audio", label: "4" }, { key: "cv4", type: "number", label: "cv4" },
    { key: "mixCv", type: "number", label: "mix cv" },
  ],
  outputs: [
    { key: "mix", type: "audio", label: "mix" },
    { key: "ch1", type: "audio", label: "out1" },
    { key: "ch2", type: "audio", label: "out2" },
    { key: "ch3", type: "audio", label: "out3" },
    { key: "ch4", type: "audio", label: "out4" },
  ],
  knobs: [
    { key: "lvl1", label: "Level 1", default: 1, min: 0, max: VCMIXER_CH_MAX, step: 0.01, help: "Channel 1 fader, SQUARED before it is applied — so unity is at 1 and the top of the range (√2) is +6 dB." },
    { key: "lvl2", label: "Level 2", default: 1, min: 0, max: VCMIXER_CH_MAX, step: 0.01, help: "Channel 2 fader, square law." },
    { key: "lvl3", label: "Level 3", default: 1, min: 0, max: VCMIXER_CH_MAX, step: 0.01, help: "Channel 3 fader, square law." },
    { key: "lvl4", label: "Level 4", default: 1, min: 0, max: VCMIXER_CH_MAX, step: 0.01, help: "Channel 4 fader, square law." },
    { key: "mixLvl", label: "Mix", default: 1, min: 0, max: 2, step: 0.01, help: "The master fader, LINEAR (0…2, also +6 dB at the top) — a different taper from the channel faders, which is what makes a VCMixer feel the way it does." },
    toggle("chExp", "Exp channel CV", 0, "Raise each channel's CV to the fourth power, their context-menu option. A linear CV opens a channel evenly; an exponential one keeps it quiet until the CV is well up, which is what an envelope usually wants."),
    toggle("mixExp", "Exp mix CV", 0, "The same fourth-power law on the mix CV."),
    assumedCv("cv1", "CV 1 (unpatched)", "an empty channel CV jack", ASSUMED_DEPTH_MAX),
    assumedCv("cv2", "CV 2 (unpatched)", "an empty channel CV jack", ASSUMED_DEPTH_MAX),
    assumedCv("cv3", "CV 3 (unpatched)", "an empty channel CV jack", ASSUMED_DEPTH_MAX),
    assumedCv("cv4", "CV 4 (unpatched)", "an empty channel CV jack", ASSUMED_DEPTH_MAX),
    assumedCv("mixCv", "Mix CV (unpatched)", "an empty mix CV jack", ASSUMED_DEPTH_MAX),
  ],
};


export const VCV_RANDOM_SPEC = {
  type: "audio_vcv_random", module: "vcvRandom", title: "VCV Random", family: "modulation",
  icon: "mdi:dice-5-outline", readout: "rate", w: 165,
  help: "A random voltage with FOUR interpolations of the same step — stepped, linear, cosine-smooth and exponential — so one module is a sample-and-hold, a slew and a curve generator at once. THE KNOB THAT MAKES IT MUSICAL IS `Random`: at 1 each step jumps to a fresh value, at 0.5 it moves halfway there, so it random-WALKS instead of jittering, and at 0 the sequence repeats forever.",
  inputs: [
    { key: "trig", type: "trigger", label: "trig" },
    { key: "external", type: "audio", label: "ext" },
    { key: "rate", type: "number", label: "rate" },
    { key: "shape", type: "number", label: "shape" },
    { key: "prob", type: "number", label: "prob" },
    { key: "rand", type: "number", label: "rand" },
  ],
  outputs: [
    { key: "stepped", type: "audio", label: "step" },
    { key: "linear", type: "audio", label: "lin" },
    { key: "smooth", type: "audio", label: "smooth" },
    { key: "exponential", type: "audio", label: "exp" },
    { key: "trig", type: "trigger", label: "trig" },
  ],
  knobs: [
    {
      key: "rate", label: "Rate", default: 2, min: RANDOM_RATE_MIN_HZ, max: RANDOM_RATE_MAX_HZ, step: 0.001, unit: " Hz",
      help: "The internal clock in HERTZ (law L2), over their own 0.002…2000 Hz — so the default is two steps a second. Ignored once a `trig` clock arrives: the module follows that instead, and this becomes the rate it started from.",
    },
    { key: "shape", label: "Shape", default: 1, min: 0, max: 1, step: 0.01, help: "Steepens ALL FOUR outputs at once: at 1 each one takes the whole step to travel, at 0 they jump instantly. It also sets the stepped output's tread count (1…16 stairs)." },
    { key: "prob", label: "Probability", default: 1, min: 0, max: 1, step: 0.01, help: "Chance that a clock actually produces a new step. Below 1 the pattern SKIPS — the voltage holds and no trigger is emitted, which is how a generative patch gets rests it did not have to program." },
    { key: "rand", label: "Random", default: 1, min: 0, max: 1, step: 0.01, help: "How far each step moves toward its new random value — a crossfade from the PREVIOUS value. 1 is a fresh jump every time; 0 freezes the sequence; the middle is a random walk. This is the module's character knob." },
    toggle("offset", "Unipolar", 0, "0…2 instead of ±1, their 0…10 V against their ±5 V. Applied when a value is DRAWN, so it changes the next step rather than shifting the one being held."),
    {
      key: "source", label: "Source", default: "internal", discrete: true,
      options: ["internal", "external"],
      help: "`internal` draws a random value on each step. `external` SAMPLES the `ext` input instead, which turns the module into a sample-and-hold with four interpolations. Rack senses whether that jack is patched; we cannot, so it is an explicit row (deviation D10) rather than a mode nobody can see.",
    },
    attenuverter("rateCv", "Rate CV", "rate"),
    attenuverter("shapeCv", "Shape CV", "shape"),
    attenuverter("probCv", "Probability CV", "prob"),
    attenuverter("randCv", "Random CV", "rand"),
    {
      key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
      help: "CONSTRUCT-TIME. Same reason as the Noise node's: Rack's randomness is not reproducible between runs and a document must be. Same seed, same sequence, forever — which also means this knob is how you audition a different one.",
    },
  ],
};

export const VCV_SEQ3_SPEC = {
  type: "audio_vcv_seq3", module: "vcvSeq3", title: "VCV SEQ3", family: "modulation",
  icon: "mdi:view-grid-outline", readout: "tempo", w: 200,
  help: "THREE eight-step CV rows and one gate row, sharing a clock — the classic analogue sequencer, and three independent modulation sequencers with one rhythm. Every step also has its own output, so a step can trigger something without going through the trig row. It has its own tempo, or follows an external clock.",
  inputs: [
    { key: "clock", type: "trigger", label: "clock" },
    { key: "reset", type: "trigger", label: "reset" },
    { key: "run", type: "trigger", label: "run" },
    { key: "tempo", type: "number", label: "tempo" },
    { key: "steps", type: "number", label: "steps" },
  ],
  outputs: [
    { key: "cv1", type: "audio", label: "cv1" },
    { key: "cv2", type: "audio", label: "cv2" },
    { key: "cv3", type: "audio", label: "cv3" },
    // THE GATES ARE `trigger` AND THE TWO CV-ISH ONES ARE NOT: `steps` is a COUNT a
    // downstream module reads as a number, the three CV rows are signals, and the
    // other five are logic. See VCV_COMPARE_SPEC on why the type matters.
    { key: "trig", type: "trigger", label: "trig" },
    { key: "steps", type: "audio", label: "steps" },
    { key: "clock", type: "trigger", label: "clk out" },
    { key: "run", type: "trigger", label: "run out" },
    { key: "reset", type: "trigger", label: "rst out" },
    ...seq3StepOutputs(),
  ],
  knobs: [
    {
      key: "tempo", label: "Tempo", default: SEQ3_TEMPO_DEFAULT_BPM, min: SEQ3_TEMPO_MIN_BPM, max: SEQ3_TEMPO_MAX_BPM, step: 1, unit: " BPM",
      help: "The internal clock in BEATS PER MINUTE (law L2, and our own Clock node's unit), over their own 15…960. One beat is one step. Ignored once an external clock arrives.",
    },
    {
      key: "tempoCv", label: "Tempo CV", default: 1, min: 0, max: 1, step: 0.01,
      help: "How much of the `tempo` input reaches the tempo, 0…1. THE TWO TRIMS ON THIS MODULE DEFAULT TO FULLY OPEN, unlike every attenuverter elsewhere in the block — that is Rack's own `configParam`, not an inconsistency here.",
    },
    {
      key: "steps", label: "Steps", default: 8, min: 1, max: 8, step: 1,
      help: "Pattern length. Summed with the `steps` input IN STEPS and rounded (their volts, where 1 V is one step — and their own `steps` OUTPUT emits `length − 1` for exactly this port), so with the trim open a CV of −1 shortens the pattern by one step. Lengths that do not divide the bar are how a sequence stops sounding like a loop.",
    },
    { key: "stepsCv", label: "Steps CV", default: 1, min: 0, max: 1, step: 0.01, help: "How much of the `steps` input reaches the length. Fully open by default, as the tempo trim is." },
    toggle("running", "Run", 1, "Whether the sequencer advances. A rising edge on the `run` input TOGGLES it, so this row is the state it starts in and the wire takes over afterwards."),
    toggle("clockPassthrough", "Clock passthrough", 0, "CHANGES WHAT `clk out` AND `trig` MEAN. Off (their default) both are 1 ms pulses emitted when the step CHANGES; on, both carry the incoming clock's own gate — a pulse in one mode, a 50% square in the other, and a downstream envelope hears the difference."),
    ...seq3CvKnobs(),
    ...seq3GateKnobs(),
  ],
};


export const VCV_COMPARE_SPEC = {
  type: "audio_vcv_compare", module: "vcvCompare", title: "VCV Compare", family: "modulation",
  icon: "mdi:code-less-than-or-equal", readout: "b", w: 165,
  help: "Two signals, EIGHT answers: max, min, a clip, the clipped-off remainder, gates for clipping and not-clipping, and A>B / A<B. The remainder output is what makes this a wavefolder's front end rather than only a comparator. Note the asymmetry, which is theirs: the clip uses |B| (so its sign is discarded) while max/min/greater/less use B signed.",
  inputs: [
    { key: "a", type: "audio", label: "a" },
    // `audio`, matching the placeholder the patches were validated against. Either
    // declaration wires (audio→number and number→audio are both coercions), so the
    // tie goes to the shape already in use.
    { key: "b", type: "audio", label: "b" },
  ],
  outputs: [
    { key: "max", type: "audio", label: "max" },
    { key: "min", type: "audio", label: "min" },
    { key: "clip", type: "audio", label: "clip" },
    { key: "lim", type: "audio", label: "lim" },
    // FOUR GATE OUTPUTS, TYPED `trigger` — not `audio`, and the difference is
    // load-bearing rather than cosmetic: `typesCompatible("audio", "trigger")` is
    // FALSE (core/nodeflow.js's COERCIONS has no such entry), so an `audio` gate
    // output could not be wired into any gate input in the library. The three
    // placeholder sets that declared these ports all read them as `trigger`, and
    // the patches are already wired against that.
    { key: "clipgate", type: "trigger", label: "clip↑" },
    { key: "limgate", type: "trigger", label: "lim↑" },
    { key: "greater", type: "trigger", label: "a>b" },
    { key: "less", type: "trigger", label: "a<b" },
  ],
  knobs: [
    {
      key: "b", label: "B offset", default: 0, min: -CABLE_LEVEL, max: CABLE_LEVEL, step: VOLT_STEP,
      help: "Added to the `b` input, in the same LEVEL unit as `a` (±1 is full scale, ±2 is a cable's ±10 V) — so with nothing patched this IS B, and it is the threshold every output compares against. This is the one place in the block where a knob and its input really are the same quantity, because Rack writes exactly `b = input + offset`.",
    },
  ],
};

export const VCV_SUM_SPEC = {
  type: "audio_vcv_sum", module: "vcvSum", title: "VCV Sum", family: "modulation",
  icon: "mdi:sigma", readout: "level", w: 130,
  help: "Adds up to sixteen inputs and scales the result. In Rack this is ONE polyphonic jack whose channels are summed; our wires are mono, so a poly cable unrolls into these sixteen ports and the sum is over them — which is exactly what the unrolled patch means. Nothing is attenuated per input: this is a summing bus, not a mixer.",
  inputs: sumInputPorts(),
  outputs: [{ key: "mono", type: "audio", label: "mono" }],
  knobs: [
    { key: "level", label: "Level", default: 1, min: 0, max: 1, step: 0.01, help: "Applied to the sum, 0…1. Sixteen full-scale inputs sum to 16, so this is the knob that keeps a wide sum inside a cable's ±2." },
  ],
};


// ── OUTPUT ──────────────────────────────────────────────────────────────────

export const VCV_AUDIO_INTERFACE_SPEC = {
  type: "audio_vcv_audiointerface", module: "vcvAudioInterface", title: "VCV Audio", family: "output",
  icon: "mdi:speaker", readout: "level",
  help: "THE END OF EVERY VCV PATCH: Rack's own 6 dB of headroom and its DC blocker, in front of our Output node. It HALVES — Rack sends a nominal ±5 V to the sound card as ±0.5, and a ±1 wire here IS that ±5 V — so a patch that ends in one sits where a Rack patch sits, with room above it. Leave it out and you get the full ±1 instead, which is louder and equally legitimate; what you cannot get anywhere else in the block is the DC filter.",
  inputs: [{ key: "audio1", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "level", label: "Level", default: 1, min: 0, max: 2, step: 0.01, help: "SQUARED before it is applied, as Audio-2's knob is: unity at 1 (which is still a halving — see the node's own help), +6 dB at 2." },
    toggle("dcFilter", "DC filter", 1, "A 10 Hz one-pole highpass, ON by default exactly as Audio-2's is. It removes the DC a wavefolder or an offset CV leaves behind — DC costs headroom and moves speaker cones without being heard. Their 8- and 16-channel variants default it off; this is the 2-channel one."),
  ],
};

/**
 * EVERY VC-2 SPEC, in `core/audio_specs.AUDIO_SPECS`'s own order — sources,
 * filters, effects, modulation, output — so the palette reads as one library
 * rather than as blocks that happen to be adjacent.
 *
 * THE BARREL LINES THIS NEEDS (the lead applies them; this block may not):
 *   core/audio_blocks.js    spread `BLOCK_SPECS` into `PORT_BLOCK_SPECS`
 *   plugins/audio_index.js  spread this block's `BLOCK_PLUGINS`
 *   synth/modules.js        spread `BLOCK_MODULE_FACTORIES` and
 *                           `BLOCK_WORKLET_MODULES`
 *   synth/worklet_urls.js   `VC2_WORKLET_URL`
 * Without them these sixteen exist in the engine and nowhere an author can reach.
 */
export const BLOCK_SPECS = [
  VCV_NOISE_SPEC,
  VCV_VCF_SPEC, VCV_QUANTIZER_SPEC,
  VCV_DELAY_SPEC, VCV_SEQUENTIAL_SWITCH2_SPEC, VCV_RESCALE_SPEC,
  VCV_VCA_SPEC, VCV_ADSR_SPEC, VCV_LFO_SPEC, VCV_OCTAVE_SPEC, VCV_VCMIXER_SPEC,
  VCV_RANDOM_SPEC, VCV_SEQ3_SPEC, VCV_COMPARE_SPEC, VCV_SUM_SPEC,
  VCV_AUDIO_INTERFACE_SPEC,
];
